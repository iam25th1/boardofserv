import "server-only";
import { and, asc, count, eq, gte, lte, sql } from "drizzle-orm";
import { reppoEvals, type ReppoEval } from "../db/schema";
import { fixDashes } from "../dashes";
import type { Runtime } from "../agents/runtime/context";
import { EVAL_CREDITS, nextPollMs, readResult, ReppoError, submitEval, type CallOptions, type EvalResult, type TaskType } from "./client";

// Reppo's evaluations, worked in the background by the job worker's cycle,
// never inside a job: a job finishes (or an approval waits) the same
// whether Reppo is fast, slow, down or out of credits. An evaluation is
// queued here with its redacted input, submitted when there is room in the
// credit budget, and read back with growing gaps until it completes.
// Failures are recorded on the row and tried again later, a few times.

export const MAX_ATTEMPTS = 5;
// Reppo answering 401 or 402: nothing is submitted for this long.
export const PAUSE_MS = 60 * 60_000;
// An evaluation with no result this long after it was submitted is given up.
export const GIVE_UP_MS = 6 * 60 * 60_000;

const RETRY_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000];
const retryAfter = (attempts: number) => RETRY_MS[Math.min(attempts - 1, RETRY_MS.length - 1)] ?? 60 * 60_000;
const later = (rt: Runtime, ms: number) => new Date(rt.now().getTime() + ms);

export interface NewEval {
  kind: "job" | "action";
  key: string;
  agentId: string;
  versionId: string;
  installationId: string;
  jobId?: string | null;
  approvalId?: string | null;
  taskType: TaskType;
  input: string;
}

// Queues one evaluation; its key makes a second one for the same thing a
// no-op (null).
export async function queueEval(rt: Runtime, e: NewEval): Promise<ReppoEval | null> {
  const now = rt.now();
  const [row] = await rt.db
    .insert(reppoEvals)
    .values({ ...e, jobId: e.jobId ?? null, approvalId: e.approvalId ?? null, nextAt: now, createdAt: now, updatedAt: now })
    .onConflictDoNothing()
    .returning();
  return row ?? null;
}

// Reppo said no to the key or the credits recently: wait before trying again.
async function paused(rt: Runtime): Promise<boolean> {
  const [row] = await rt.db
    .select({ n: count() })
    .from(reppoEvals)
    .where(and(sql`(${reppoEvals.lastError} like 'auth:%' or ${reppoEvals.lastError} like 'credits:%')`, gte(reppoEvals.updatedAt, new Date(rt.now().getTime() - PAUSE_MS))));
  return (row?.n ?? 0) > 0;
}

// Before each submission: whether the budget has room for it (sampling.ts
// sets it; everything goes when none is given).
export type RoomCheck = (rt: Runtime, row: ReppoEval) => Promise<boolean>;

async function failed(rt: Runtime, row: ReppoEval, err: unknown, during: "submit" | "poll"): Promise<"stop" | "next"> {
  const now = rt.now();
  const e = err instanceof ReppoError ? err : new ReppoError("Reppo's call broke off.", "network");
  const note = `${e.kind}: ${e.message}`;
  if (e.kind === "auth" || e.kind === "credits") {
    // Not this evaluation's fault: it waits, and nothing else is sent for a while.
    await rt.db.update(reppoEvals).set({ lastError: note, nextAt: later(rt, PAUSE_MS), updatedAt: now }).where(eq(reppoEvals.id, row.id));
    rt.log(`reppo: ${e.kind === "auth" ? "the API key was refused" : "credits are used up"}; evaluations wait an hour.`);
    return "stop";
  }
  if (e.kind === "bad_request" || e.kind === "not_found") {
    await rt.db.update(reppoEvals).set({ status: "failed", lastError: note, updatedAt: now }).where(eq(reppoEvals.id, row.id));
    return "next";
  }
  // Reppo slow, down or unreachable: try again later, a few times.
  const attempts = row.attempts + (during === "submit" ? 1 : 0);
  const giveUp = during === "submit" ? attempts >= MAX_ATTEMPTS : row.submittedAt !== null && now.getTime() - row.submittedAt.getTime() > GIVE_UP_MS;
  await rt.db
    .update(reppoEvals)
    .set({ attempts, lastError: note, nextAt: later(rt, during === "submit" ? retryAfter(attempts) : 60_000), ...(giveUp ? { status: "failed" as const } : {}), updatedAt: now })
    .where(eq(reppoEvals.id, row.id));
  return "next";
}

export async function submitDue(rt: Runtime, o: { limit?: number; room?: RoomCheck; call?: CallOptions } = {}): Promise<number> {
  const cfg = rt.services.reppo;
  if (!cfg || (await paused(rt))) return 0;
  const due = await rt.db
    .select()
    .from(reppoEvals)
    .where(and(eq(reppoEvals.status, "queued"), lte(reppoEvals.nextAt, rt.now())))
    // Second opinions first: a renter is waiting on those.
    .orderBy(sql`case when ${reppoEvals.kind} = 'action' then 0 else 1 end`, asc(reppoEvals.createdAt))
    .limit(o.limit ?? 5);
  let sent = 0;
  for (const row of due) {
    if (o.room && !(await o.room(rt, row))) continue;
    try {
      const e = await submitEval(cfg, { taskType: row.taskType, input: row.input }, { fetchImpl: rt.services.fetch, timeoutMs: 20_000, ...o.call });
      const now = rt.now();
      await rt.db
        .update(reppoEvals)
        .set({ status: "submitted", reppoId: e.id, polls: 0, submittedAt: now, nextAt: later(rt, nextPollMs(0)), lastError: null, updatedAt: now })
        .where(eq(reppoEvals.id, row.id));
      sent += 1;
    } catch (err) {
      if ((await failed(rt, row, err, "submit")) === "stop") break;
    }
  }
  return sent;
}

// What happens when an evaluation has its result (blocks, second opinions):
// set by the modules that care, so this one stays small.
export type OnResult = (rt: Runtime, row: ReppoEval) => Promise<void>;

export async function pollDue(rt: Runtime, o: { limit?: number; onResult?: OnResult; call?: CallOptions } = {}): Promise<number> {
  const cfg = rt.services.reppo;
  if (!cfg) return 0;
  const due = await rt.db
    .select()
    .from(reppoEvals)
    .where(and(eq(reppoEvals.status, "submitted"), lte(reppoEvals.nextAt, rt.now())))
    .orderBy(asc(reppoEvals.nextAt))
    .limit(o.limit ?? 10);
  let done = 0;
  for (const row of due) {
    let e: EvalResult;
    try {
      e = await readResult(cfg, row.reppoId!, { fetchImpl: rt.services.fetch, timeoutMs: 15_000, ...o.call });
    } catch (err) {
      if ((await failed(rt, row, err, "poll")) === "stop") break;
      continue;
    }
    const now = rt.now();
    if (e.status === "COMPLETED") {
      const [saved] = await rt.db
        .update(reppoEvals)
        .set({
          status: "completed",
          score: e.score,
          route: e.route,
          decision: e.decision,
          confidence: e.confidence,
          // Words people read carry no em dashes.
          reason: e.reason ? fixDashes(e.reason).slice(0, 1200) : null,
          rubric: e.rubric,
          creditsCharged: e.creditsCharged,
          completedAt: now,
          lastError: null,
          updatedAt: now,
        })
        .where(and(eq(reppoEvals.id, row.id), eq(reppoEvals.status, "submitted")))
        .returning();
      done += 1;
      if (saved && o.onResult) await o.onResult(rt, saved).catch((err: unknown) => rt.log(`reppo: after a result: ${err instanceof Error ? err.name : "unknown error"}`));
    } else if (e.status === "FAILED") {
      // Not charged: submit it again, a few times.
      const attempts = row.attempts + 1;
      await rt.db
        .update(reppoEvals)
        .set({ status: attempts >= MAX_ATTEMPTS ? "failed" : "queued", reppoId: null, attempts, lastError: `failed: ${e.error ?? "Reppo couldn't score it."}`, nextAt: later(rt, retryAfter(attempts)), updatedAt: now })
        .where(eq(reppoEvals.id, row.id));
    } else {
      const old = row.submittedAt !== null && now.getTime() - row.submittedAt.getTime() > GIVE_UP_MS;
      await rt.db
        .update(reppoEvals)
        .set(old ? { status: "failed", lastError: "timeout: no result in 6 hours", updatedAt: now } : { polls: row.polls + 1, nextAt: later(rt, nextPollMs(row.polls + 1)), updatedAt: now })
        .where(eq(reppoEvals.id, row.id));
    }
  }
  return done;
}

// Credits Reppo charged since a time, and what is reserved by evaluations
// still in flight (each reserves its price until it finishes).
export async function credits(rt: Runtime, since: Date): Promise<{ charged: number; evals: number; inFlight: number; reserved: number }> {
  const [used] = await rt.db
    .select({ charged: sql<number>`coalesce(sum(${reppoEvals.creditsCharged}), 0)::int`, evals: count() })
    .from(reppoEvals)
    .where(and(eq(reppoEvals.status, "completed"), gte(reppoEvals.completedAt, since)));
  const [flying] = await rt.db.select({ n: count() }).from(reppoEvals).where(eq(reppoEvals.status, "submitted"));
  const inFlight = flying?.n ?? 0;
  return { charged: used?.charged ?? 0, evals: used?.evals ?? 0, inFlight, reserved: inFlight * EVAL_CREDITS };
}
