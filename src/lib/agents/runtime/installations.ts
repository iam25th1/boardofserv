import "server-only";
import { and, desc, eq } from "drizzle-orm";
import { agentInstallations, agents, agentVersions, type Agent, type AgentInstallation, type AgentVersion } from "../../db/schema";
import type { InstallationDTO } from "../../types";
import type { AgentDefinition } from "../definition";
import { checkAnswers, type InstallAnswers } from "../settingsForm";
import { emptyBench } from "../types";
import type { Runtime } from "./context";

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
export function installationDTO(l: Loaded): InstallationDTO {
  const { installation: i, definition: d } = l;
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
  };
}
