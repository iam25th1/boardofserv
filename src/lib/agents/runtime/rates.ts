import "server-only";
import { and, count, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { agentInstallations, agentJobs, agentMessages } from "../../db/schema";
import type { Runtime } from "./context";

// Limits on each installation, so an agent that goes wrong can't run away:
// jobs an hour, messages it sends an hour, and actions in one job. Hitting
// one pauses the installation with a plain reason (never a silent
// failure); its renter resumes it. A job that keeps going round the same
// step stops, and an installation whose jobs fail at the same point three
// times in a row pauses.

type Env = Record<string, string | undefined>;
const whole = (raw: string | undefined, fallback: number) => {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 ? n : fallback;
};

export function rateLimits(env: Env = process.env) {
  return {
    jobsPerHour: whole(env.AGENT_JOBS_PER_HOUR, 12),
    outboundPerHour: whole(env.AGENT_OUTBOUND_PER_HOUR, 20),
    actionsPerJob: whole(env.AGENT_ACTIONS_PER_JOB, 40),
    // How often one job may run the same step before it is stopped.
    stepVisits: whole(env.AGENT_STEP_VISITS, 12),
    // Jobs in a row failing the same way before the installation pauses.
    sameFailures: whole(env.AGENT_SAME_FAILURES, 3),
  };
}

const hourAgo = (rt: Runtime) => new Date(rt.now().getTime() - 3_600_000);

export const JOBS_REASON = (n: number) => `It started ${n} jobs in the last hour, its limit, so it is paused. Resume it when you are ready.`;
export const OUTBOUND_REASON = (n: number) => `It sent ${n} messages in the last hour, its limit, so it is paused. Resume it when you are ready.`;
export const ACTIONS_REASON = (n: number) => `It took ${n} actions in one job, its limit, so it is paused. Resume it when you are ready.`;
export const SAME_FAILURE_REASON = (n: number, why: string) => `Its last ${n} jobs failed the same way, so it is paused: ${why} Resume it once that is fixed.`;

// Pauses an active installation with a reason.
export async function pauseFor(rt: Runtime, installationId: string, reason: string): Promise<void> {
  await rt.db
    .update(agentInstallations)
    .set({ status: "paused", pausedReason: reason, updatedAt: rt.now() })
    .where(and(eq(agentInstallations.id, installationId), eq(agentInstallations.status, "active")));
}

// Whether one more job may start this hour.
export async function jobRoom(rt: Runtime, installationId: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  const limit = rateLimits().jobsPerHour;
  const [row] = await rt.db.select({ n: count() }).from(agentJobs).where(and(eq(agentJobs.installationId, installationId), gte(agentJobs.createdAt, hourAgo(rt))));
  return (row?.n ?? 0) >= limit ? { ok: false, reason: JOBS_REASON(limit) } : { ok: true };
}

// Whether one more message to its renter may go out this hour.
export async function outboundRoom(rt: Runtime, installationId: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  const limit = rateLimits().outboundPerHour;
  const [row] = await rt.db
    .select({ n: count() })
    .from(agentMessages)
    .where(and(eq(agentMessages.installationId, installationId), eq(agentMessages.from, "agent"), gte(agentMessages.createdAt, hourAgo(rt))));
  return (row?.n ?? 0) >= limit ? { ok: false, reason: OUTBOUND_REASON(limit) } : { ok: true };
}

// One more action in a job: false (and the installation paused) past the
// limit.
export async function takeAction(rt: Runtime, jobId: string, installationId: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  const limit = rateLimits().actionsPerJob;
  const [row] = await rt.db
    .update(agentJobs)
    .set({ actions: sql`${agentJobs.actions} + 1` })
    .where(eq(agentJobs.id, jobId))
    .returning({ actions: agentJobs.actions });
  if ((row?.actions ?? 0) > limit) {
    await pauseFor(rt, installationId, ACTIONS_REASON(limit));
    return { ok: false, reason: ACTIONS_REASON(limit) };
  }
  return { ok: true };
}

// After a job fails: when its installation's last few jobs all failed the
// same way, pause it, saying why.
export async function pauseOnRepeatedFailure(rt: Runtime, installationId: string): Promise<boolean> {
  const n = rateLimits().sameFailures;
  const last = await rt.db
    .select({ status: agentJobs.status, reason: agentJobs.reason })
    .from(agentJobs)
    .where(and(eq(agentJobs.installationId, installationId), inArray(agentJobs.status, ["done", "failed", "cancelled"])))
    .orderBy(desc(agentJobs.finishedAt))
    .limit(n);
  if (last.length < n || !last.every((j) => j.status === "failed" && j.reason && j.reason === last[0]!.reason)) return false;
  await pauseFor(rt, installationId, SAME_FAILURE_REASON(n, last[0]!.reason!));
  return true;
}
