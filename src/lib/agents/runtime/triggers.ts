import "server-only";
import { and, count, eq, isNull, lte, sql } from "drizzle-orm";
import { agentInstallations, agentJobs, agentTriggers, agentVersions, type AgentInstallation } from "../../db/schema";
import type { AgentDefinition } from "../definition";
import { typedRules } from "../runner";
import { runInSandbox } from "../sandbox";
import { checkInterval, nextRun, scheduleSpec } from "../schedule";
import { jobRoom, pauseFor } from "./rates";
import type { Runtime } from "./context";
import { enqueue } from "./jobs";
import { JobTools } from "./tools";

// Triggers: what starts an installation's jobs.
//
// - A schedule fires at its time in the owner's time zone, then moves to
//   the next. If its last job hasn't even started yet, it doesn't pile
//   another on.
// - A value check runs its check step every so many minutes. It starts a
//   job only when the condition turns true (from false, or from not known
//   yet), not on every check while it stays true.
// - A message from the owner's in-app message box starts a job at once,
//   with the message as the job's input.
//
// The installation's minimum gap between jobs is kept when jobs are
// claimed (jobs.ts), whatever started them. A trigger fires once even if
// two workers look at it together: moving its next time on is the claim.

type Trigger = AgentDefinition["triggers"][number];

const ts = (d: Date) => sql`${d.toISOString()}::timestamptz`;

function firstAt(t: Trigger, i: AgentInstallation, now: Date): Date | null {
  if (t.kind === "schedule") return nextRun(scheduleSpec(t, i.schedule), i.timezone, now);
  if (t.kind === "check") return now;
  return null;
}

// The trigger rows of a new installation (or one starting again after a
// pause): schedules from now, checks straight away.
export async function setUpTriggers(rt: Runtime, i: AgentInstallation, d: AgentDefinition): Promise<void> {
  const now = rt.now();
  for (const [index, t] of d.triggers.entries()) {
    const at = firstAt(t, i, now);
    if (!at || t.kind === "message") continue;
    await rt.db
      .insert(agentTriggers)
      .values({ installationId: i.id, index, kind: t.kind, nextAt: at })
      .onConflictDoUpdate({ target: [agentTriggers.installationId, agentTriggers.index], set: { nextAt: at } });
  }
}

export interface CheckResult {
  holds: boolean;
  value: unknown;
  error: string | null;
}

// One run of a check step: what it found, or why it couldn't say.
export async function runCheck(rt: Runtime, i: AgentInstallation, d: AgentDefinition, code: Record<string, { source: string | null; status: string }>, t: Extract<Trigger, { kind: "check" }>): Promise<CheckResult> {
  const step = d.steps.find((s) => s.id === t.step);
  const entry = step ? code[step.id] : undefined;
  if (!step || step.kind !== "code" || !entry?.source || entry.status !== "approved") return { holds: false, value: null, error: "Its check step has no approved code." };
  const bag: Record<string, unknown> = { settings: i.settings, rules: typedRules(d, i.rules), memory: i.memory };
  const input = Object.fromEntries(step.inputs.map((n) => [n, bag[n] ?? null]));
  const tools = new JobTools(rt, i, d, null);
  const r = await runInSandbox(entry.source, input, { allowed: step.tools, call: (tool, args) => tools.call(step, tool, args), timeZone: i.timezone });
  if (!r.ok) return { holds: false, value: null, error: `The check failed: ${r.error}` };
  const out = r.output as { holds?: unknown; value?: unknown } | null;
  if (!out || typeof out.holds !== "boolean") return { holds: false, value: null, error: "The check didn't say whether it holds (true or false)." };
  return { holds: out.holds, value: out.value ?? null, error: null };
}

// Fires every trigger that is due now. Returns how many jobs it started.
export async function fireDue(rt: Runtime, limit = 20): Promise<number> {
  const now = rt.now();
  const due = await rt.db
    .select({ trigger: agentTriggers, installation: agentInstallations, version: agentVersions })
    .from(agentTriggers)
    .innerJoin(agentInstallations, eq(agentInstallations.id, agentTriggers.installationId))
    .innerJoin(agentVersions, eq(agentVersions.id, agentInstallations.versionId))
    .where(and(lte(agentTriggers.nextAt, now), eq(agentInstallations.status, "active"), eq(agentInstallations.live, true)))
    .orderBy(agentTriggers.nextAt)
    .limit(limit);
  let started = 0;
  for (const { trigger: row, installation: i, version } of due) {
    const d = version.definition;
    const t = d?.triggers[row.index];
    if (!d || !t || t.kind === "message") continue;
    const next = t.kind === "schedule" ? nextRun(scheduleSpec(t, i.schedule), i.timezone, now) : new Date(now.getTime() + checkInterval(t.everyMinutes) * 60_000);
    // The claim: only one looker moves it on.
    const won = await rt.db
      .update(agentTriggers)
      .set({ nextAt: next, lastAt: now })
      .where(and(eq(agentTriggers.installationId, row.installationId), eq(agentTriggers.index, row.index), sql`${agentTriggers.nextAt} = ${ts(row.nextAt)}`))
      .returning({ index: agentTriggers.index });
    if (!won.length) continue;
    if (t.kind === "schedule") {
      const [waiting] = await rt.db
        .select({ n: count() })
        .from(agentJobs)
        .where(and(eq(agentJobs.installationId, i.id), eq(agentJobs.status, "queued"), isNull(agentJobs.startedAt), sql`${agentJobs.trigger}->>'kind' = 'schedule'`));
      if ((waiting?.n ?? 0) > 0) continue;
      const room = await jobRoom(rt, i.id);
      if (!room.ok) {
        await pauseFor(rt, i.id, room.reason);
        continue;
      }
      await enqueue(rt, i, { kind: "schedule", at: row.nextAt.toISOString() });
      started += 1;
      continue;
    }
    const found = await runCheck(rt, i, d, version.code, t);
    await rt.db
      .update(agentTriggers)
      .set({ holds: found.error ? row.holds : found.holds, note: found.error })
      .where(and(eq(agentTriggers.installationId, row.installationId), eq(agentTriggers.index, row.index)));
    if (!found.error && found.holds && row.holds !== true) {
      const room = await jobRoom(rt, i.id);
      if (!room.ok) {
        await pauseFor(rt, i.id, room.reason);
        continue;
      }
      await enqueue(rt, i, { kind: "check", watch: t.watch, value: found.value });
      started += 1;
    }
  }
  return started;
}
