import "server-only";
import { and, count, desc, eq, gte, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { agentJobs, agentVersions, reppoEvals, type ReppoEval } from "../db/schema";
import type { Runtime } from "../agents/runtime/context";
import { weekStart } from "../agents/metering";
import { EVAL_CREDITS } from "./client";
import { credits, PAUSE_MS } from "./evals";
import type { ReppoAdminDTO } from "../types";
import { queueJobEval } from "./redact";

// Which finished jobs Reppo scores, and how much it may spend. Sparse on
// purpose: the first few jobs of each new version, then one in N, at most
// so many a week for each agent, and never past the site's daily credit
// budget (job scores and second opinions together). Free example agents
// get the same caps as any other. When the day's budget is spent the
// sampler passes jobs by quietly until the next UTC day.

type Env = Record<string, string | undefined>;
const whole = (raw: string | undefined, fallback: number, min = 0) => {
  const n = Number(raw);
  return raw !== undefined && raw.trim() !== "" && Number.isInteger(n) && n >= min ? n : fallback;
};

export function reppoSettings(env: Env = process.env) {
  return {
    // Every finished job of a new version up to this many is scored...
    firstJobs: whole(env.REPPO_FIRST_JOBS, 3),
    // ...then one in this many.
    sampleEvery: whole(env.REPPO_SAMPLE_EVERY, 10, 1),
    // Job scores a week for each agent, at most.
    weeklyPerAgent: whole(env.REPPO_AGENT_WEEKLY_CAP, 10),
    // Credits the whole site may spend a day (440 an evaluation).
    dailyCredits: whole(env.REPPO_DAILY_CREDITS, 4400),
    // Second opinions on payments and new contacts waiting for a yes.
    actionOpinions: env.REPPO_ACTION_OPINIONS !== "0",
  };
}

// Only jobs that finished this recently are looked at: old ones, from
// before Reppo was on, are left alone.
export const LOOKBACK_MS = 24 * 60 * 60_000;

const dayStart = (t: Date) => new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate()));

// Credits spoken for today: charged, reserved by evaluations in flight, and
// queued to go.
export async function creditsToday(rt: Runtime): Promise<number> {
  const c = await credits(rt, dayStart(rt.now()));
  const [queued] = await rt.db.select({ n: count() }).from(reppoEvals).where(eq(reppoEvals.status, "queued"));
  return c.charged + c.reserved + (queued?.n ?? 0) * EVAL_CREDITS;
}

// Room in the day's budget for one more evaluation.
export async function budgetRoom(rt: Runtime, settings = reppoSettings()): Promise<boolean> {
  return (await creditsToday(rt)) + EVAL_CREDITS <= settings.dailyCredits;
}

// Before a queued evaluation is submitted: within what is charged and in
// flight today (queued ones were counted when they were queued).
export async function submitRoom(rt: Runtime, _row: ReppoEval, settings = reppoSettings()): Promise<boolean> {
  const c = await credits(rt, dayStart(rt.now()));
  return c.charged + c.reserved + EVAL_CREDITS <= settings.dailyCredits;
}

type Choice = "sampled" | "skipped" | "cap" | "budget";

// Looks at jobs that finished since it last looked, and queues the ones it
// takes. Returns how many it queued.
export async function sampleFinished(rt: Runtime, settings = reppoSettings(), limit = 50): Promise<number> {
  const now = rt.now();
  const jobs = await rt.db
    .select({ id: agentJobs.id, versionId: agentJobs.versionId, agentId: agentVersions.agentId, finishedAt: agentJobs.finishedAt })
    .from(agentJobs)
    .innerJoin(agentVersions, eq(agentVersions.id, agentJobs.versionId))
    .where(and(isNull(agentJobs.reppoSample), inArray(agentJobs.status, ["done", "failed"]), isNotNull(agentJobs.finishedAt), gte(agentJobs.finishedAt, new Date(now.getTime() - LOOKBACK_MS))))
    .orderBy(agentJobs.finishedAt)
    .limit(limit);
  let queued = 0;
  for (const j of jobs) {
    // Its place among the version's finished jobs the sampler has seen.
    const [seen] = await rt.db
      .select({ n: count() })
      .from(agentJobs)
      .where(and(eq(agentJobs.versionId, j.versionId), isNotNull(agentJobs.reppoSample)));
    const nth = (seen?.n ?? 0) + 1;
    let choice: Choice = nth <= settings.firstJobs || (nth - settings.firstJobs) % settings.sampleEvery === 0 ? "sampled" : "skipped";
    if (choice === "sampled") {
      const [week] = await rt.db
        .select({ n: count() })
        .from(reppoEvals)
        .where(and(eq(reppoEvals.agentId, j.agentId), eq(reppoEvals.kind, "job"), gte(reppoEvals.createdAt, weekStart(now))));
      if ((week?.n ?? 0) >= settings.weeklyPerAgent) choice = "cap";
      else if (!(await budgetRoom(rt, settings))) choice = "budget";
    }
    // Marked first, so a job is looked at once even if queueing fails.
    const [marked] = await rt.db
      .update(agentJobs)
      .set({ reppoSample: choice })
      .where(and(eq(agentJobs.id, j.id), isNull(agentJobs.reppoSample)))
      .returning({ id: agentJobs.id });
    if (!marked || choice !== "sampled") continue;
    if (await queueJobEval(rt, j.id)) queued += 1;
  }
  return queued;
}

// The admin's view of Reppo: credits used today and this week, what is in
// flight and waiting, why nothing is going out (when that is so), and the
// settings in force.
export async function reppoStatus(rt: Runtime, settings = reppoSettings()): Promise<ReppoAdminDTO> {
  const now = rt.now();
  const today = await credits(rt, dayStart(now));
  const week = await credits(rt, weekStart(now));
  const [queued] = await rt.db.select({ n: count() }).from(reppoEvals).where(eq(reppoEvals.status, "queued"));
  const [failed] = await rt.db.select({ n: count() }).from(reppoEvals).where(and(eq(reppoEvals.status, "failed"), gte(reppoEvals.updatedAt, dayStart(now))));
  const [refused] = await rt.db
    .select({ e: reppoEvals.lastError })
    .from(reppoEvals)
    .where(and(sql`(${reppoEvals.lastError} like 'auth:%' or ${reppoEvals.lastError} like 'credits:%')`, gte(reppoEvals.updatedAt, new Date(now.getTime() - PAUSE_MS))))
    .orderBy(desc(reppoEvals.updatedAt))
    .limit(1);
  return {
    on: Boolean(rt.services.reppo),
    today: { credits: today.charged, evals: today.evals },
    week: { credits: week.charged, evals: week.evals },
    inFlight: today.inFlight,
    queued: queued?.n ?? 0,
    failedToday: failed?.n ?? 0,
    paused: refused?.e ? (refused.e.startsWith("auth:") ? "Reppo refused the API key, so nothing goes out for an hour." : "Reppo's credits ran out, so nothing goes out for an hour. Add credits at eval.reppo.xyz/billing.") : null,
    budgetSpent: (await creditsToday(rt)) + EVAL_CREDITS > settings.dailyCredits,
    settings,
    creditsPerEval: EVAL_CREDITS,
  };
}
