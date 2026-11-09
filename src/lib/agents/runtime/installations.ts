import "server-only";
import { and, desc, eq, inArray } from "drizzle-orm";
import { agentApprovals, agentInstallations, agentJobs, agents, agentTriggers, agentVersions, type Agent, type AgentInstallation, type AgentVersion } from "../../db/schema";
import type { InstallationDTO } from "../../types";
import type { AgentDefinition } from "../definition";
import { describeTriggers } from "../schedule";
import { checkAnswers, type InstallAnswers } from "../settingsForm";
import { emptyBench } from "../types";
import type { Runtime } from "./context";
import { approvalsOf } from "./approvals";
import { enqueue } from "./jobs";
import { setUpTriggers } from "./triggers";
import { jobsOfInstallation, spendToday } from "./views";

// Installations: one owner's running copy of a published agent version.
// Anyone can be an owner: for now a maker installs their own agent from the
// test bench, and renting (a later phase) installs for someone else through
// the same install().

export class InstallRefused extends Error {
  constructor(
    message: string,
    readonly errors: Record<string, string> = {},
  ) {
    super(message);
    this.name = "InstallRefused";
  }
}

// Why this version can't run yet, or null.
export function notRunnable(version: AgentVersion): string | null {
  if (version.state !== "published") return "Publish a version first: an installation runs a published version, which never changes.";
  const d = version.definition;
  if (!d) return "Plan it first.";
  const unwritten = d.steps.filter((s) => s.kind === "code" && version.code[s.id]?.status !== "approved");
  if (unwritten.length) return `Every code step needs approved code first ("${unwritten[0]!.title}" doesn't have it).`;
  return null;
}

export async function install(rt: Runtime, o: { ownerUserId: string; agent: Agent; version: AgentVersion; answers: InstallAnswers }): Promise<AgentInstallation> {
  const why = notRunnable(o.version);
  if (why) throw new InstallRefused(why);
  const d = o.version.definition!;
  const checked = checkAnswers(d, o.answers);
  if (!checked.ok) throw new InstallRefused("Some answers need another look.", checked.errors);
  const bench = o.version.bench ?? emptyBench();
  const now = rt.now();
  const [row] = await rt.db
    .insert(agentInstallations)
    .values({
      agentId: o.agent.id,
      versionId: o.version.id,
      ownerUserId: o.ownerUserId,
      settings: checked.settings,
      rules: checked.rules,
      mocks: { sheets: bench.sheets, search: bench.search, wallet: bench.wallet },
      timezone: checked.timezone,
      schedule: checked.schedule,
      minGapMinutes: checked.minGapMinutes,
      dailySpendUsd: String(checked.dailySpendUsd),
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  await setUpTriggers(rt, row!, d);
  return row!;
}

// An installation with its agent and version, for its owner only: null for
// anyone else, as if it weren't there.
export async function ownedInstallation(rt: Runtime, ownerUserId: string, id: string): Promise<Loaded | null> {
  const loaded = await loadInstallation(rt, id);
  return loaded && loaded.installation.ownerUserId === ownerUserId ? loaded : null;
}

export interface Loaded {
  installation: AgentInstallation;
  agent: Agent;
  version: AgentVersion;
  definition: AgentDefinition;
}

export async function loadInstallation(rt: Runtime, id: string): Promise<Loaded | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const [row] = await rt.db
    .select({ installation: agentInstallations, agent: agents, version: agentVersions })
    .from(agentInstallations)
    .innerJoin(agents, eq(agents.id, agentInstallations.agentId))
    .innerJoin(agentVersions, eq(agentVersions.id, agentInstallations.versionId))
    .where(eq(agentInstallations.id, id))
    .limit(1);
  if (!row?.version.definition) return null;
  return { ...row, definition: row.version.definition };
}

export async function installationsOf(rt: Runtime, ownerUserId: string): Promise<Loaded[]> {
  const rows = await rt.db
    .select({ installation: agentInstallations, agent: agents, version: agentVersions })
    .from(agentInstallations)
    .innerJoin(agents, eq(agents.id, agentInstallations.agentId))
    .innerJoin(agentVersions, eq(agentVersions.id, agentInstallations.versionId))
    .where(and(eq(agentInstallations.ownerUserId, ownerUserId)))
    .orderBy(desc(agentInstallations.createdAt))
    .limit(100);
  return rows.flatMap((r) => (r.version.definition ? [{ ...r, definition: r.version.definition }] : []));
}

// What its owner sees of an installation.
export async function installationDTO(rt: Runtime, l: Loaded): Promise<InstallationDTO> {
  const { installation: i, definition: d } = l;
  const triggers = await rt.db.select().from(agentTriggers).where(eq(agentTriggers.installationId, i.id));
  const next = triggers.filter((t) => t.kind === "schedule" || t.kind === "check").map((t) => t.nextAt.getTime());
  const failing = triggers.find((t) => t.note);
  return {
    id: i.id,
    agentId: l.agent.id,
    name: d.name,
    version: l.version.number,
    status: i.status,
    timezone: i.timezone,
    settings: d.settings.map((s) => ({ key: s.key, label: s.label, value: i.settings[s.key] ?? null })),
    rules: d.rules.map((r) => ({ key: r.key, label: r.label, type: r.type, value: i.rules[r.key] ?? r.value })),
    minGapMinutes: i.minGapMinutes,
    dailySpendUsd: Number(i.dailySpendUsd),
    createdAt: i.createdAt.toISOString(),
    runs: describeTriggers(d, i.schedule),
    nextRunAt: i.status === "active" && next.length ? new Date(Math.min(...next)).toISOString() : null,
    takesMessages: d.triggers.some((t) => t.kind === "message"),
    checkNote: failing?.note ?? null,
    memory: d.memory.map((m) => ({ key: m.key, description: m.description, value: i.memory[m.key] ?? null })),
    spendTodayUsd: await spendToday(rt, i.id),
    recentJobs: await jobsOfInstallation(rt, i.id, 5),
    approvals: await approvalsOf(rt, i.ownerUserId, { installationId: i.id, pendingOnly: true }),
  };
}

export type Control = "pause" | "resume" | "stop" | "run";

export class ControlRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ControlRefused";
  }
}

// The owner's controls.
// - pause: nothing new starts (no trigger fires, queued jobs wait); a job
//   running now finishes.
// - resume: schedules pick up from now, value checks check again.
// - stop, for good: queued jobs are cancelled, a job waiting for an answer
//   is cancelled with its question, and a running job finishes the step
//   it is on and stops there.
// - run: one job now, by hand (it still keeps the minimum gap).
export async function control(rt: Runtime, l: Loaded, action: Control): Promise<void> {
  const { installation: i, definition: d } = l;
  const now = rt.now();
  const here = eq(agentInstallations.id, i.id);
  if (i.status === "stopped") throw new ControlRefused("It's stopped for good. Start it again from its agent's page.");
  if (action === "pause") {
    if (i.status !== "active") throw new ControlRefused("It's paused already.");
    await rt.db.update(agentInstallations).set({ status: "paused", updatedAt: now }).where(here);
    return;
  }
  if (action === "resume") {
    if (i.status !== "paused") throw new ControlRefused("It isn't paused.");
    const [row] = await rt.db.update(agentInstallations).set({ status: "active", updatedAt: now }).where(here).returning();
    await setUpTriggers(rt, row!, d);
    return;
  }
  if (action === "run") {
    if (i.status !== "active") throw new ControlRefused("Resume it first.");
    await enqueue(rt, i, { kind: "manual" });
    return;
  }
  await rt.db.transaction(async (tx) => {
    await tx.update(agentInstallations).set({ status: "stopped", stoppedAt: now, updatedAt: now }).where(here);
    await tx
      .update(agentJobs)
      .set({ status: "cancelled", reason: "Stopped by its owner before it finished.", claimedBy: null, finishedAt: now, updatedAt: now })
      .where(and(eq(agentJobs.installationId, i.id), inArray(agentJobs.status, ["queued", "waiting_for_owner"])));
    await tx.update(agentJobs).set({ stopAsked: true, updatedAt: now }).where(and(eq(agentJobs.installationId, i.id), eq(agentJobs.status, "running")));
    await tx.update(agentApprovals).set({ status: "cancelled" }).where(and(eq(agentApprovals.installationId, i.id), eq(agentApprovals.status, "pending")));
    await tx.delete(agentTriggers).where(eq(agentTriggers.installationId, i.id));
  });
}
