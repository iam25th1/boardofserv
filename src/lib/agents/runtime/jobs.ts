import "server-only";
import { and, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { agentInstallations, agentJobs, agentJobSteps, agentVersions, users, type AgentInstallation, type AgentJob } from "../../db/schema";
import type { AgentDefinition, DecisionStepDef } from "../definition";
import { askServ, readDecision, runSteps, startState, typedRules, type Decided, type EngineResult, type RunEvent, type RunState } from "../runner";
import { pauseForOwner } from "./approvals";
import type { Runtime } from "./context";
import { JobTools } from "./tools";
import { spendToday } from "./views";

// Jobs: one run each of an installation, started by a trigger. A job is a
// row, so it survives a restart: a worker claims a due one (atomically, so
// no two workers ever take the same job), runs it on the version it was
// started on, saves where it is after every step and tool call, and marks
// it done, failed or cancelled at the end. A failure outside the agent
// (SERV not answering, the sandbox faulting) sends it back to the queue to
// try again after a longer wait each time; the agent's own logic failing
// ends it. A job whose worker stopped beating (the server died mid-job) goes
// back to the queue and picks up from its last saved step, its tool calls
// replayed rather than repeated.

export const MAX_ATTEMPTS = 3;
// How long to wait before each try after a failure outside the agent.
export const BACKOFF_MS = [30_000, 120_000, 600_000];
// A running job's worker beats this often; one silent for STALE_MS is gone.
export const HEARTBEAT_MS = 20_000;
export const STALE_MS = 120_000;

export type JobTrigger = { kind: "schedule" | "check" | "message" | "manual"; [k: string]: unknown };

// Another worker owns the job now: stop at once, write nothing more.
export class Fenced extends Error {
  constructor() {
    super("The job belongs to another worker now.");
    this.name = "Fenced";
  }
}

const ts = (d: Date) => sql`${d.toISOString()}::timestamptz`;

export async function enqueue(rt: Runtime, installation: AgentInstallation, trigger: JobTrigger, runAfter?: Date): Promise<AgentJob> {
  const now = rt.now();
  const [job] = await rt.db
    .insert(agentJobs)
    .values({ installationId: installation.id, versionId: installation.versionId, ownerUserId: installation.ownerUserId, trigger, runAfter: runAfter ?? now, createdAt: now, updatedAt: now })
    .returning();
  return job!;
}

// The next due job for this worker, claimed, or null. Due: queued, its time
// come, its installation active, nothing else of that installation running,
// and (for a job not yet started) the installation's minimum gap passed
// since its last job started. One at a time, so two due jobs of one
// installation never both start.
export async function claimJob(rt: Runtime, worker: string): Promise<AgentJob | null> {
  const now = rt.now();
  const pick = sql`(
    select j.id from agent_jobs j
    join agent_installations i on i.id = j.installation_id
    where j.status = 'queued' and j.run_after <= ${ts(now)} and i.status = 'active'
      and not exists (select 1 from agent_jobs r where r.installation_id = j.installation_id and r.status = 'running')
      and (j.started_at is not null or not exists (
        select 1 from agent_jobs p where p.installation_id = j.installation_id and p.id <> j.id and p.started_at is not null
          and p.started_at > ${ts(now)} - (i.min_gap_minutes * interval '1 minute')))
    order by j.run_after, j.created_at
    limit 1
    for update of j skip locked)`;
  const [job] = await rt.db
    .update(agentJobs)
    .set({ status: "running", claimedBy: worker, heartbeatAt: now, startedAt: sql`coalesce(${agentJobs.startedAt}, ${ts(now)})`, updatedAt: now })
    .where(and(eq(agentJobs.status, "queued"), sql`${agentJobs.id} = ${pick}`))
    .returning();
  return job ?? null;
}

// Jobs left running by a worker that stopped beating: back to the queue,
// to pick up from where they were saved. Returns how many.
export async function requeueStale(rt: Runtime): Promise<number> {
  const now = rt.now();
  const rows = await rt.db
    .update(agentJobs)
    .set({ status: "queued", claimedBy: null, runAfter: now, updatedAt: now })
    .where(and(eq(agentJobs.status, "running"), or(isNull(agentJobs.heartbeatAt), lt(agentJobs.heartbeatAt, new Date(now.getTime() - STALE_MS)))))
    .returning({ id: agentJobs.id });
  return rows.length;
}

// This worker's running jobs are still alive.
export async function beat(rt: Runtime, worker: string, ids: string[]): Promise<void> {
  if (!ids.length) return;
  await rt.db
    .update(agentJobs)
    .set({ heartbeatAt: rt.now() })
    .where(and(inArray(agentJobs.id, ids), eq(agentJobs.claimedBy, worker), eq(agentJobs.status, "running")));
}

// The bag a job starts with: the owner's settings, their rules typed over
// the maker's defaults, what the agent remembers for them, and what started it.
function startingBag(d: AgentDefinition, i: AgentInstallation, trigger: JobTrigger): Record<string, unknown> {
  return { settings: { ...i.settings }, rules: typedRules(d, i.rules), memory: { ...i.memory }, trigger };
}

// Runs a claimed job until it ends, waits or must be tried again later.
export async function runJob(rt: Runtime, job: AgentJob, worker: string): Promise<void> {
  const [row] = await rt.db
    .select({ installation: agentInstallations, version: agentVersions, owner: users })
    .from(agentInstallations)
    .innerJoin(agentVersions, eq(agentVersions.id, job.versionId))
    .innerJoin(users, eq(users.id, agentInstallations.ownerUserId))
    .where(eq(agentInstallations.id, job.installationId));
  const definition = row?.version.definition;
  if (!row || !definition) return finish(rt, job, worker, null, { status: "failed", reason: "Its agent version isn't there any more." });
  const { installation, version, owner } = row;

  const state: RunState = job.state ?? startState(definition, startingBag(definition, installation, job.trigger as JobTrigger));
  const save = async (s: RunState) => {
    const rows = await rt.db
      .update(agentJobs)
      .set({ state: s, costUsd: s.costUsd.toFixed(6), heartbeatAt: rt.now(), updatedAt: rt.now() })
      .where(and(eq(agentJobs.id, job.id), eq(agentJobs.claimedBy, worker), eq(agentJobs.status, "running")))
      .returning({ id: agentJobs.id });
    if (!rows.length) throw new Fenced();
  };
  const log = stepLog(rt, job, state);
  const serv = rt.serv(owner);
  const decide = async (step: DecisionStepDef, input: Record<string, unknown>, untrusted: string[]): Promise<Decided> => {
    if (rt.decide) return rt.decide(step, input);
    if (!serv) return { ok: false, note: "SERV isn't set up here.", reason: "SERV isn't set up, so its decisions can't be made.", costUsd: 0, infra: true };
    const call = await askServ(step, input, serv.config, { fetchImpl: rt.fetchImpl, untrusted });
    await rt.record(owner, call, serv.ownKey);
    return readDecision(step, call);
  };

  let result: EngineResult;
  try {
    result = await runSteps({
      definition,
      code: version.code,
      state,
      tools: new JobTools(rt, installation, definition, job),
      decide,
      onEvent: log.on,
      save,
      shouldStop: async () => {
        const [j] = await rt.db.select({ stop: agentJobs.stopAsked }).from(agentJobs).where(eq(agentJobs.id, job.id));
        return j?.stop ? "Stopped by its owner." : null;
      },
      // Before each model call: the installation's daily cap, then the
      // site's (this spend counts towards it like any other).
      canSpend: async () => {
        if (rt.decide) return null;
        await log.flush();
        const cap = Number(installation.dailySpendUsd);
        if ((await spendToday(rt, installation.id)) >= cap) return `It reached its daily spend limit of $${cap >= 0.01 ? cap.toFixed(2) : Number(cap.toFixed(6))} for today.`;
        return serv ? rt.siteRefusal(owner, serv.ownKey) : null;
      },
      retryInfra: true,
    });
  } catch (err) {
    await log.flush();
    if (err instanceof Fenced) return;
    // Something broke outside the agent (the database, most likely): try again.
    rt.log(`jobs: job ${job.id} broke off: ${err instanceof Error ? err.name : "unknown error"}`);
    result = { kind: "retry", reason: "The server had a problem running it." };
  }
  await log.flush();
  if (result.kind === "wait") return pauseForOwner(rt, job, worker, definition, state, result);
  await finish(rt, job, worker, state, result.kind === "end" ? endOf(result) : { retry: result.reason });
}

function endOf(r: Extract<EngineResult, { kind: "end" }>): { status: "done" | "failed" | "cancelled"; reason: string } {
  if (r.cause === "end") return { status: "done", reason: r.reason };
  if (r.cause === "stop" || r.cause === "declined") return { status: "cancelled", reason: r.reason };
  return { status: "failed", reason: r.reason };
}

type Finish = { status: "done" | "failed" | "cancelled"; reason: string } | { retry: string };

async function finish(rt: Runtime, job: AgentJob, worker: string, state: RunState | null, how: Finish): Promise<void> {
  const now = rt.now();
  const mine = and(eq(agentJobs.id, job.id), eq(agentJobs.claimedBy, worker), eq(agentJobs.status, "running"));
  if ("retry" in how) {
    const attempts = job.attempts + 1;
    if (attempts >= MAX_ATTEMPTS) {
      await rt.db
        .update(agentJobs)
        .set({ status: "failed", reason: `${how.retry} It was tried ${MAX_ATTEMPTS} times.`, attempts, state, claimedBy: null, finishedAt: now, updatedAt: now })
        .where(mine);
      return;
    }
    // The step runs again; calls that failed outside the agent are made again.
    if (state) {
      const cut = state.journal.findIndex((e) => e.infra);
      if (cut >= 0) state.journal = state.journal.slice(0, cut);
    }
    await rt.db
      .update(agentJobs)
      .set({ status: "queued", reason: how.retry, attempts, state, claimedBy: null, runAfter: new Date(now.getTime() + BACKOFF_MS[attempts - 1]!), updatedAt: now })
      .where(mine);
    return;
  }
  await rt.db
    .update(agentJobs)
    .set({ status: how.status, reason: how.reason, state, claimedBy: null, finishedAt: now, updatedAt: now, ...(state ? { costUsd: state.costUsd.toFixed(6) } : {}) })
    .where(mine);
}

// The job's step log, written as the run's events come: a row per step
// started (by its place in the job), filled in when it finishes or pauses.
// A step that runs again (after a pause or a restart) fills in the same row.
function stepLog(rt: Runtime, job: AgentJob, state: RunState) {
  let chain: Promise<void> = Promise.resolve();
  let current: { seq: number; tools: { tool: string; args: unknown; result: unknown; error: string | null }[] } | null = null;
  const write = (fn: () => Promise<unknown>) => {
    chain = chain.then(fn).then(
      () => undefined,
      (err: unknown) => rt.log(`jobs: a step log line wasn't written: ${err instanceof Error ? err.name : "unknown error"}`),
    );
  };
  const on = (e: RunEvent) => {
    if (e.type === "step") {
      const seq = state.steps;
      current = { seq, tools: [] };
      const now = rt.now();
      write(() =>
        rt.db
          .insert(agentJobSteps)
          .values({ jobId: job.id, seq, stepId: e.stepId, status: "running", input: e.input, startedAt: now })
          .onConflictDoUpdate({ target: [agentJobSteps.jobId, agentJobSteps.seq], set: { status: "running", input: e.input } }),
      );
    } else if (e.type === "tool" && current) {
      current.tools.push({ tool: e.tool, args: e.args, result: e.result, error: e.error });
    } else if ((e.type === "step_done" || e.type === "wait") && current) {
      const { seq, tools } = current;
      const now = rt.now();
      const set =
        e.type === "wait"
          ? { status: "waiting" as const, tools: [...tools], note: e.question }
          : {
              status: e.status,
              output: e.output,
              tools: [...tools],
              outcome: e.outcome,
              note: e.note,
              model: e.model ?? null,
              costUsd: sql`${agentJobSteps.costUsd} + ${e.costUsd.toFixed(6)}::numeric`,
              ms: sql`${agentJobSteps.ms} + ${e.ms}`,
              finishedAt: now,
            };
      write(() => rt.db.update(agentJobSteps).set(set).where(and(eq(agentJobSteps.jobId, job.id), eq(agentJobSteps.seq, seq))));
      if (e.type === "step_done") current = null;
    }
  };
  return { on, flush: () => chain };
}
