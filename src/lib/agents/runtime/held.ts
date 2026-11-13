import "server-only";
import { and, asc, eq, inArray } from "drizzle-orm";
import { agentApprovals, agentInstallations, agentJobs, agentMessages, type AgentInstallation, type AgentJob, type AgentMessage } from "../../db/schema";
import { DEFAULT_APPROVAL_HOURS, type AgentDefinition } from "../definition";
import { audit } from "../audit";
import { describeCall } from "../calls";
import { unknownContacts } from "../untrusted";
import type { HeldRelease, RunState } from "../types";
import type { Runtime } from "./context";

// Messages held for one yes. A message to the owner that would ask only
// because it carries links, addresses or contact details they never gave
// the agent isn't asked about on its own: it is kept, unsent and out of the
// owner's message box, and the run goes on. When the run ends, one approval
// lists every message it kept with its links: Yes to all, No to all, or
// Pick one by one (an approval for each). Only the ones said yes to are sent;
// none, with no answer. Payments, and anything asked for any other reason,
// keep their own approval as they always did.

type Tx = Parameters<Parameters<Runtime["db"]["transaction"]>[0]>[0];
type Db = Runtime["db"] | Tx;
type End = HeldRelease["end"];

// The approvals' step ids: one for the run's messages, one for each.
export const HELD_ALL = "_messages";
const HELD_ONE = "_message:";
export const isHeldStep = (stepId: string) => stepId === HELD_ALL || stepId.startsWith(HELD_ONE);

export const YES_TO_ALL = "Yes to all";
export const NO_TO_ALL = "No to all";
export const ONE_BY_ONE = "Pick one by one";

const yes = (answer: string | null | undefined) => answer === YES_TO_ALL || answer === "Yes";

// What the renter gave it themselves: their answers, rules and, for a job
// they started with a message, that message.
export function knownTo(installation: Pick<AgentInstallation, "settings" | "rules">, job: Pick<AgentJob, "trigger"> | null): string {
  const trigger = job?.trigger as { kind?: string; text?: string } | undefined;
  return JSON.stringify([installation.settings, installation.rules, trigger?.kind === "message" ? (trigger.text ?? "") : ""]);
}

export function heldOf(db: Db, jobId: string): Promise<AgentMessage[]> {
  return db
    .select()
    .from(agentMessages)
    .where(and(eq(agentMessages.jobId, jobId), eq(agentMessages.tgState, "held")))
    .orderBy(asc(agentMessages.createdAt), asc(agentMessages.id));
}

// Nothing it held goes anywhere (a job cancelled, or failed for good).
export async function dropHeld(db: Db, jobId: string): Promise<void> {
  await db.delete(agentMessages).where(and(eq(agentMessages.jobId, jobId), eq(agentMessages.tgState, "held")));
}

const excerpt = (t: string, max: number) => {
  const one = t.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 3).trimEnd()}...` : one;
};

const hours = (d: AgentDefinition) => d.approvalHours ?? DEFAULT_APPROVAL_HOURS;

// The run ended with messages held: one approval for them all, and the job
// waits for it, keeping how it ended. False when it held none.
export async function askAboutHeld(rt: Runtime, job: AgentJob, worker: string, d: AgentDefinition, installation: AgentInstallation, state: RunState, end: End): Promise<boolean> {
  const held = await heldOf(rt.db, job.id);
  if (!held.length) return false;
  const known = knownTo(installation, job);
  const links = held.map((m) => unknownContacts(m.text, known));
  const all = [...new Set(links.flat())];
  const n = held.length;
  const shown = held.slice(0, 20);
  const question =
    n === 1
      ? `Send this message to you? "${excerpt(held[0]!.text, 400)}"`
      : [
          `Send these ${n} messages to you? Each carries links you didn't give it.`,
          "",
          ...shown.map((m, i) => `${i + 1}. "${excerpt(m.text, 160)}"${links[i]!.length ? `\n   Links: ${links[i]!.slice(0, 4).join(", ")}` : ""}`),
          ...(n > shown.length ? [`And ${n - shown.length} more.`] : []),
        ].join("\n");
  const some = all.length === 1 ? "a link, address or contact detail" : "links, addresses or contact details";
  const reason = `${n === 1 ? "It carries" : "They carry"} ${some} you didn't give it: ${all.slice(0, 3).join(", ")}${all.length > 3 ? ` and ${all.length - 3} more` : ""}. Don't follow ${all.length === 1 ? "it" : "them"} unless you trust ${all.length === 1 ? "it" : "them"}.`;
  const options =
    n === 1
      ? [
          { label: "Yes", effect: "It is sent to you." },
          { label: "No", effect: "It isn't sent." },
        ]
      : [
          { label: YES_TO_ALL, effect: `All ${n} are sent to you.` },
          { label: NO_TO_ALL, effect: "None of them is sent." },
          { label: ONE_BY_ONE, effect: "You're asked about each one on its own." },
        ];
  const h = hours(d);
  const noAnswer = `After ${h} ${h === 1 ? "hour" : "hours"} with no answer, ${n === 1 ? "it isn't sent" : "none of them is sent"}.`;
  state.release = { end };
  return wait(rt, job, worker, state, [{ stepId: HELD_ALL, question, reason, options, noAnswer }], d);
}

// The job waits for these approvals, its state kept.
async function wait(rt: Runtime, job: AgentJob, worker: string, state: RunState, asks: { stepId: string; question: string; reason: string | null; options: { label: string; effect: string }[]; noAnswer: string }[], d: AgentDefinition): Promise<boolean> {
  const now = rt.now();
  return rt.db.transaction(async (tx) => {
    const moved = await tx
      .update(agentJobs)
      .set({ status: "waiting_for_owner", state, claimedBy: null, costUsd: state.costUsd.toFixed(6), updatedAt: now })
      .where(and(eq(agentJobs.id, job.id), eq(agentJobs.claimedBy, worker), eq(agentJobs.status, "running")))
      .returning({ id: agentJobs.id });
    if (!moved.length) return true;
    await tx.insert(agentApprovals).values(
      asks.map((a) => ({
        jobId: job.id,
        installationId: job.installationId,
        ownerUserId: job.ownerUserId,
        stepId: a.stepId,
        callIndex: -1,
        kind: "safety" as const,
        question: a.question,
        reason: a.reason,
        options: a.options,
        noAnswer: a.noAnswer,
        expiresAt: new Date(now.getTime() + hours(d) * 3_600_000),
        tgState: "pending" as const,
        createdAt: now,
      })),
    );
    return true;
  });
}

// An answer to one of these approvals (null for none): kept in the job's
// state. The job goes back in the queue once nothing it asked is waiting.
export async function heldAnswered(tx: Tx, a: { id: string; jobId: string; stepId: string }, answer: string | null, now: Date): Promise<void> {
  const [job] = await tx.select().from(agentJobs).where(eq(agentJobs.id, a.jobId));
  if (!job?.state?.release || job.status !== "waiting_for_owner") return;
  const state = structuredClone(job.state);
  const release = state.release!;
  if (a.stepId === HELD_ALL) release.answer = answer;
  else (release.each ??= {})[a.stepId.slice(HELD_ONE.length)] = answer;
  const waiting = await tx
    .select({ id: agentApprovals.id })
    .from(agentApprovals)
    .where(and(eq(agentApprovals.jobId, job.id), eq(agentApprovals.status, "pending")));
  const back = waiting.length === 0;
  await tx
    .update(agentJobs)
    .set({ state, ...(back ? { status: "queued" as const, runAfter: now } : {}), updatedAt: now })
    .where(and(eq(agentJobs.id, job.id), eq(agentJobs.status, "waiting_for_owner")));
}

// The owner has answered: the messages said yes to go out, the rest are
// dropped, and the job ends as its run did. On Pick one by one, an approval
// for each message first ("waiting").
export async function releaseHeld(rt: Runtime, job: AgentJob, worker: string, d: AgentDefinition, installation: AgentInstallation, state: RunState): Promise<End | "waiting"> {
  const release = state.release!;
  const held = await heldOf(rt.db, job.id);
  if (!release.each && release.answer === ONE_BY_ONE && held.length) {
    release.each = {};
    const known = knownTo(installation, job);
    const h = hours(d);
    await wait(
      rt,
      job,
      worker,
      state,
      held.map((m) => {
        const links = unknownContacts(m.text, known);
        return {
          stepId: `${HELD_ONE}${m.id}`,
          question: `Send this message to you? "${excerpt(m.text, 400)}"`,
          reason: links.length ? `It carries ${links.length === 1 ? "a link, address or contact detail" : "links, addresses or contact details"} you didn't give it: ${links.slice(0, 3).join(", ")}.` : null,
          options: [
            { label: "Yes", effect: "It is sent to you." },
            { label: "No", effect: "It isn't sent." },
          ],
          noAnswer: `After ${h} ${h === 1 ? "hour" : "hours"} with no answer, it isn't sent.`,
        };
      }),
      d,
    );
    return "waiting";
  }
  const send = held.filter((m) => (release.each ? yes(release.each[m.id]) : yes(release.answer)));
  const drop = held.filter((m) => !send.includes(m));
  if (send.length) await rt.db.update(agentMessages).set({ tgState: "pending" }).where(inArray(agentMessages.id, send.map((m) => m.id)));
  if (drop.length) await rt.db.delete(agentMessages).where(inArray(agentMessages.id, drop.map((m) => m.id)));
  const [i] = await rt.db.select({ agentId: agentInstallations.agentId }).from(agentInstallations).where(eq(agentInstallations.id, job.installationId));
  for (const m of held) {
    const went = send.includes(m);
    await audit(rt, {
      installationId: job.installationId,
      agentId: i?.agentId ?? installation.agentId,
      ownerUserId: job.ownerUserId,
      jobId: job.id,
      step: "Its messages",
      tool: "telegram.send",
      risk: "outbound",
      what: describeCall("telegram.send", { text: m.text }),
      outcome: went ? "ran" : "declined",
      guard: null,
      guardReason: null,
      reason: went ? null : (release.each ? release.each[m.id] : release.answer) === null ? "No answer came in time." : "You said no.",
      approvedBy: went ? "renter" : null,
      cost: "0",
      spent: null,
    });
  }
  const end = release.end;
  delete state.release;
  return end;
}
