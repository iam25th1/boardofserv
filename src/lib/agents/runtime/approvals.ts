import "server-only";
import { and, desc, eq, lte } from "drizzle-orm";
import { agentApprovals, agentInstallations, agentJobs, agentVersions, type AgentApproval, type AgentJob } from "../../db/schema";
import type { ApprovalDTO } from "../../types";
import { DEFAULT_APPROVAL_HOURS, type AgentDefinition, type AgentStep } from "../definition";
import type { Ask } from "../runner";
import type { RunState } from "../types";
import type { Runtime } from "./context";

// Approvals that wait. A job that asks its owner something (telegram.ask),
// or wants to pay more than a rule allows, pauses as waiting_for_owner, and
// an approval holds the question, the answers the owner can give and what
// happens on each. It is asked in the app and, when the owner linked
// Telegram, in their chat with a button per answer: the first answer, from
// either, is the one that counts. The owner's answer goes into the paused step's journal
// as the answer to that very tool call, and the job goes back in the queue:
// the step runs again from its start, its earlier calls replayed, so it
// picks up exactly where it paused. With no answer by the time the maker
// set (24 hours unless they said otherwise), the approval expires and the
// job takes its declared "no answer" path, or stops if it has none.

type Tx = Parameters<Parameters<Runtime["db"]["transaction"]>[0]>[0];

const hours = (d: AgentDefinition) => d.approvalHours ?? DEFAULT_APPROVAL_HOURS;

// What happens on each answer, and with none.
export function effects(d: AgentDefinition, step: AgentStep, ask: Ask): { options: { label: string; effect: string }[]; noAnswer: string } {
  const title = (id: string | null | undefined) => d.steps.find((s) => s.id === id)?.title;
  const h = hours(d);
  const after = `After ${h} ${h === 1 ? "hour" : "hours"} with no answer`;
  if (step.kind === "action") {
    const next = title(step.next);
    const away = title(step.otherwise);
    const without = away ? `goes to "${away}"` : "the job stops";
    if (ask.kind === "over_limit") {
      return {
        options: [
          { label: "Yes", effect: next ? `It pays, then goes on to "${next}".` : "It pays, and the job is done." },
          { label: "No", effect: `It doesn't pay, and ${without}.` },
        ],
        noAnswer: `${after}, it doesn't pay, and ${without}.`,
      };
    }
    return {
      options: ask.choices.map((c) => ({ label: c, effect: next ? `It goes on to "${next}" with "${c}" as your answer.` : `The job ends with "${c}" as your answer.` })),
      noAnswer: `${after}, ${away ? `it goes to "${away}"` : "the job stops"}.`,
    };
  }
  if (ask.kind === "over_limit") {
    return {
      options: [
        { label: "Yes", effect: `It pays, and "${step.title}" goes on.` },
        { label: "No", effect: `It doesn't pay, and "${step.title}" is told you said no.` },
      ],
      noAnswer: `${after}, it doesn't pay, and "${step.title}" is told so.`,
    };
  }
  return {
    options: ask.choices.map((c) => ({ label: c, effect: `"${step.title}" goes on with "${c}" as your answer.` })),
    noAnswer: `${after}, "${step.title}" goes on with no answer.`,
  };
}

// The job pauses here: the approval is made and the job waits for it.
export async function pauseForOwner(rt: Runtime, job: AgentJob, worker: string, d: AgentDefinition, state: RunState, wait: { stepId: string; ask: Ask; index: number }): Promise<void> {
  const step = d.steps.find((s) => s.id === wait.stepId)!;
  const { options, noAnswer } = effects(d, step, wait.ask);
  const now = rt.now();
  await rt.db.transaction(async (tx) => {
    const moved = await tx
      .update(agentJobs)
      .set({ status: "waiting_for_owner", state, claimedBy: null, costUsd: state.costUsd.toFixed(6), updatedAt: now })
      .where(and(eq(agentJobs.id, job.id), eq(agentJobs.claimedBy, worker), eq(agentJobs.status, "running")))
      .returning({ id: agentJobs.id });
    if (!moved.length) return;
    await tx.insert(agentApprovals).values({
      jobId: job.id,
      installationId: job.installationId,
      ownerUserId: job.ownerUserId,
      stepId: step.id,
      callIndex: wait.index,
      kind: wait.ask.kind,
      question: wait.ask.question,
      options,
      noAnswer,
      expiresAt: new Date(now.getTime() + hours(d) * 3_600_000),
      // Asked in the owner's Telegram chat too (telegram/deliver.ts).
      tgState: "pending",
      createdAt: now,
    });
  });
}

// The answer (null for none) goes to the paused call, and the job back in
// the queue.
async function resume(tx: Tx, a: AgentApproval, answer: string | null, now: Date): Promise<void> {
  const [job] = await tx.select().from(agentJobs).where(eq(agentJobs.id, a.jobId));
  if (!job?.state || job.status !== "waiting_for_owner") return;
  const state = structuredClone(job.state);
  const call = state.journal[a.callIndex];
  if (call) state.journal[a.callIndex] = { tool: call.tool, args: call.args, approval: { answer } };
  await tx.update(agentJobs).set({ status: "queued", state, runAfter: now, updatedAt: now }).where(and(eq(agentJobs.id, job.id), eq(agentJobs.status, "waiting_for_owner")));
}

export class AnswerRefused extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "AnswerRefused";
  }
}

// The owner answers. Only theirs, only while it waits, only with one of its answers.
export async function answer(rt: Runtime, ownerUserId: string, id: string, given: string): Promise<AgentApproval> {
  const now = rt.now();
  return rt.db.transaction(async (tx) => {
    const [a] = await tx.select().from(agentApprovals).where(and(eq(agentApprovals.id, id), eq(agentApprovals.ownerUserId, ownerUserId)));
    if (!a) throw new AnswerRefused("Not found", 404);
    if (a.status !== "pending") throw new AnswerRefused(a.status === "answered" ? "It was answered already." : a.status === "expired" ? "It expired before an answer came." : "Its job was stopped.", 409);
    if (!a.options.some((o) => o.label === given)) throw new AnswerRefused(`Answer with one of: ${a.options.map((o) => o.label).join(", ")}.`);
    const [done] = await tx
      .update(agentApprovals)
      .set({ status: "answered", answer: given, answeredAt: now })
      .where(and(eq(agentApprovals.id, id), eq(agentApprovals.status, "pending")))
      .returning();
    if (!done) throw new AnswerRefused("It was answered already.", 409);
    await resume(tx, done, given, now);
    return done;
  });
}

// Approvals whose time is up: the job takes its "no answer" path. Returns how many.
export async function expireDue(rt: Runtime, limit = 50): Promise<number> {
  const now = rt.now();
  const due = await rt.db.select().from(agentApprovals).where(and(eq(agentApprovals.status, "pending"), lte(agentApprovals.expiresAt, now))).limit(limit);
  let expired = 0;
  for (const a of due) {
    await rt.db.transaction(async (tx) => {
      const [gone] = await tx.update(agentApprovals).set({ status: "expired" }).where(and(eq(agentApprovals.id, a.id), eq(agentApprovals.status, "pending"))).returning();
      if (!gone) return;
      await resume(tx, gone, null, now);
      expired += 1;
    });
  }
  return expired;
}

// The owner's approvals, the waiting ones first, with their agent's name
// and the step that asks.
export async function approvalsOf(rt: Runtime, ownerUserId: string, o: { installationId?: string; jobId?: string; pendingOnly?: boolean } = {}): Promise<ApprovalDTO[]> {
  const rows = await rt.db
    .select({ approval: agentApprovals, definition: agentVersions.definition })
    .from(agentApprovals)
    .innerJoin(agentJobs, eq(agentJobs.id, agentApprovals.jobId))
    .innerJoin(agentVersions, eq(agentVersions.id, agentJobs.versionId))
    .innerJoin(agentInstallations, eq(agentInstallations.id, agentApprovals.installationId))
    .where(
      and(
        eq(agentApprovals.ownerUserId, ownerUserId),
        o.installationId ? eq(agentApprovals.installationId, o.installationId) : undefined,
        o.jobId ? eq(agentApprovals.jobId, o.jobId) : undefined,
        o.pendingOnly ? eq(agentApprovals.status, "pending") : undefined,
      ),
    )
    .orderBy(desc(agentApprovals.createdAt))
    .limit(50);
  const list = rows.map(({ approval: a, definition: d }) => approvalDTO(a, d));
  return [...list.filter((a) => a.status === "pending"), ...list.filter((a) => a.status !== "pending")];
}

export function approvalDTO(a: AgentApproval, d: AgentDefinition | null): ApprovalDTO {
  return {
    id: a.id,
    jobId: a.jobId,
    installationId: a.installationId,
    agentName: d?.name ?? "An agent",
    stepTitle: d?.steps.find((s) => s.id === a.stepId)?.title ?? a.stepId,
    kind: a.kind,
    question: a.question,
    options: a.options,
    noAnswer: a.noAnswer,
    status: a.status,
    answer: a.answer,
    expiresAt: a.expiresAt.toISOString(),
    createdAt: a.createdAt.toISOString(),
  };
}
