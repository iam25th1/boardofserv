import "server-only";
import { and, desc, eq, gte, ilike, inArray, lte, ne, or, sql } from "drizzle-orm";
import { agentInstallations, agentListings, agents, agentVersions, users, type AgentListing } from "../db/schema";
import type { AgentListingDTO, AgentPageDTO } from "../types";
import { connectionsNeeded, spends, type AgentDefinition, type ToolName } from "../agents/definition";
import { describeTriggers } from "../agents/schedule";
import { typedRules } from "../agents/runner";
import type { Runtime } from "../agents/runtime/context";

// Agents on the board. Each listed agent shows what it does, what it
// connects to, its weekly price (and fee per job), how many people rent
// it and who made it; its own page adds the plan in plain words (step
// titles and a decision's outcomes), what it asks at setup, what it never
// does without asking, and all it may ever do. Never its code, its
// prompts, its test bench or anyone's data.

export const USDC_DECIMALS = 6;
const BOARD_LIMIT = 60;

export type Connects = AgentListingDTO["connects"][number];

export function connectsOf(d: AgentDefinition): Connects[] {
  const needs = connectionsNeeded(d);
  const tools = new Set<ToolName>([...d.actions.map((a) => a.tool), ...d.steps.flatMap((s) => (s.kind === "code" ? s.tools : []))]);
  return [...(needs.telegram ? (["telegram"] as const) : []), ...(needs.google ? (["sheets"] as const) : []), ...(tools.has("web.fetch") || tools.has("web.search") ? (["web"] as const) : [])];
}

export interface BoardFilters {
  q?: string;
  connects?: Connects[];
  // Weekly price bounds, USDC minor units.
  min?: bigint | null;
  max?: bigint | null;
}

interface Row {
  listing: AgentListing;
  name: string;
  definition: AgentDefinition | null;
  version: number;
  maker: string;
  makerId: string;
}

// How many people other than its maker run a copy of it now.
async function renterCounts(rt: Runtime, rows: Row[]): Promise<Map<string, number>> {
  if (!rows.length) return new Map();
  const counted = await rt.db
    .select({ agentId: agentInstallations.agentId, n: sql<number>`count(distinct ${agentInstallations.ownerUserId})::int` })
    .from(agentInstallations)
    .innerJoin(agents, eq(agents.id, agentInstallations.agentId))
    .where(and(inArray(agentInstallations.agentId, rows.map((r) => r.listing.agentId)), ne(agentInstallations.status, "stopped"), ne(agentInstallations.ownerUserId, agents.ownerUserId)))
    .groupBy(agentInstallations.agentId);
  return new Map(counted.map((c) => [c.agentId, c.n]));
}

function listingDTO(r: Row, renters: number): AgentListingDTO {
  const d = r.definition!;
  return {
    id: r.listing.agentId,
    name: d.name,
    does: d.job.does,
    connects: connectsOf(d),
    weeklyPrice: r.listing.weeklyPrice,
    jobFee: r.listing.jobFee,
    decimals: USDC_DECIMALS,
    renters,
    maker: r.maker,
    version: r.version,
    quality: null,
    trust: null,
    createdAt: r.listing.createdAt.toISOString(),
  };
}

const select = (rt: Runtime) =>
  rt.db
    .select({ listing: agentListings, name: agents.name, definition: agentVersions.definition, version: agentVersions.number, maker: users.handle, makerId: users.id })
    .from(agentListings)
    .innerJoin(agents, eq(agents.id, agentListings.agentId))
    .innerJoin(agentVersions, eq(agentVersions.id, agentListings.versionId))
    .innerJoin(users, eq(users.id, agents.ownerUserId));

// The board's agents, most rented first, then newest.
export async function boardAgents(rt: Runtime, f: BoardFilters = {}): Promise<AgentListingDTO[]> {
  const q = (f.q ?? "").trim().slice(0, 80).replace(/[\\%_]/g, "\\$&");
  const rows = (await select(rt)
    .where(
      and(
        eq(agentListings.listed, true),
        eq(agentVersions.state, "published"),
        q ? or(ilike(agents.name, `%${q}%`), sql`${agentVersions.definition} -> 'job' ->> 'does' ilike ${`%${q}%`}`) : undefined,
        f.min !== undefined && f.min !== null ? gte(agentListings.weeklyPrice, f.min.toString()) : undefined,
        f.max !== undefined && f.max !== null ? lte(agentListings.weeklyPrice, f.max.toString()) : undefined,
      ),
    )
    .orderBy(desc(agentListings.createdAt))
    .limit(BOARD_LIMIT * 2)) as Row[];
  const wanted = f.connects ?? [];
  const fit = rows.filter((r) => r.definition && wanted.every((c) => connectsOf(r.definition!).includes(c)));
  const renters = await renterCounts(rt, fit);
  return fit
    .map((r) => listingDTO(r, renters.get(r.listing.agentId) ?? 0))
    .sort((a, b) => b.renters - a.renters || b.createdAt.localeCompare(a.createdAt))
    .slice(0, BOARD_LIMIT);
}

// An agent's own page, for anyone, or null when it isn't on the board.
export async function agentPage(rt: Runtime, agentId: string, viewerId: string | null = null): Promise<AgentPageDTO | null> {
  if (!/^[0-9a-f-]{36}$/i.test(agentId)) return null;
  const [row] = (await select(rt).where(and(eq(agentListings.agentId, agentId), eq(agentListings.listed, true), eq(agentVersions.state, "published")))) as Row[];
  if (!row?.definition) return null;
  const d = row.definition;
  const renters = (await renterCounts(rt, [row])).get(agentId) ?? 0;
  const rules = typedRules(d, {});
  const ruleWords = (key: string) => {
    const r = d.rules.find((x) => x.key === key);
    const v = rules[key];
    return r ? `"${r.label}" (${r.type === "usdc" && typeof v === "number" ? `${v} USDC` : String(v)} unless you change it)` : key;
  };
  const neverWithoutAsking = [
    ...[...new Set(d.actions.filter((a) => spends(a) && a.askOver).map((a) => a.askOver!))].map((k) => `Spend more in one job than your limit ${ruleWords(k)}.`),
    ...[...new Set(d.actions.filter((a) => spends(a) && a.askOverDay).map((a) => a.askOverDay!))].map((k) => `Spend more in a day than your limit ${ruleWords(k)}.`),
    ...d.actions.filter((a) => a.tool === "telegram.ask").map((a) => `${a.description}: it asks you, and waits for your answer.`),
  ];
  return {
    ...listingDTO(row, renters),
    done: d.job.done,
    runs: describeTriggers(d, null),
    steps: d.steps
      // A value check's own step runs outside the job.
      .filter((s) => !d.triggers.some((t) => t.kind === "check" && t.step === s.id))
      .map((s) => ({ kind: s.kind === "code" ? "works" : s.kind === "decision" ? "decides" : "acts", title: s.title, outcomes: s.kind === "decision" ? s.outcomes.map((o) => o.label) : [] })),
    asks: d.settings.map((s) => ({ label: s.label, help: s.help, kind: s.type })),
    needs: connectionsNeeded(d),
    neverWithoutAsking,
    canOnly: d.actions.map((a) => a.description),
    mine: viewerId !== null && viewerId === row.makerId,
  };
}

// The listing of an agent, for its maker.
export async function listingOf(rt: Runtime, agentId: string): Promise<AgentListing | null> {
  const [row] = await rt.db.select().from(agentListings).where(eq(agentListings.agentId, agentId));
  return row ?? null;
}
