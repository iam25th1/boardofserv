import "server-only";
import { qualityOf, qualitySettings } from "../reppo/quality";
import { and, desc, eq, gte, ilike, inArray, isNull, lte, ne, or, sql } from "drizzle-orm";
import { agentListings, agents, agentVersions, freezes, rentals, users, type Agent, type AgentListing } from "../db/schema";
import type { AgentListingDTO, AgentPageDTO, MakerListingDTO, QualityDTO, TrustDTO } from "../types";
import { versionTrust } from "../trust/trust";
import { NEW_BAND, TRUST } from "../trust/config";
import { connectionsNeeded, spends, type AgentDefinition, type ToolName } from "../agents/definition";
import { describeTriggers } from "../agents/schedule";
import { typedRules } from "../agents/runner";
import type { Runtime } from "../agents/runtime/context";
import { USDC_DECIMALS } from "./charges";
import { budgetConfig, estimateWeekly } from "../agents/metering";

// Agents on the board. Each listed agent shows what it does, what it
// connects to, its weekly price (and fee per job), how many people rent
// it and who made it; its own page adds the plan in plain words (step
// titles and a decision's outcomes), what it asks at setup, what it never
// does without asking, and all it may ever do. Never its code, its
// prompts, its test bench or anyone's data.

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
  // Most rented first (the default), or highest quality first.
  sort?: "rented" | "quality";
  // Only agents with a quality score of at least this.
  minQuality?: number | null;
}

interface Row {
  listing: AgentListing;
  name: string;
  definition: AgentDefinition | null;
  version: number;
  maker: string;
  makerId: string;
}

// How many people rent it now.
async function renterCounts(rt: Runtime, rows: Row[]): Promise<Map<string, number>> {
  if (!rows.length) return new Map();
  const counted = await rt.db
    .select({ agentId: rentals.agentId, n: sql<number>`count(distinct ${rentals.renterUserId})::int` })
    .from(rentals)
    .where(and(inArray(rentals.agentId, rows.map((r) => r.listing.agentId)), ne(rentals.status, "ended")))
    .groupBy(rentals.agentId);
  return new Map(counted.map((c) => [c.agentId, c.n]));
}

const NO_QUALITY = (): QualityDTO => ({ score: null, reviewed: 0, minimum: qualitySettings().minimum, ship: 0, review: 0, block: 0, previous: null });

function listingDTO(r: Row, renters: number, quality: QualityDTO = NO_QUALITY(), trust?: TrustDTO): AgentListingDTO {
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
    quality,
    trust: trust ?? { score: TRUST.START, label: "new", isNew: true, factors: [], band: { label: NEW_BAND.label, perPayment: NEW_BAND.perPayment, perDay: NEW_BAND.perDay }, computedAt: null },
    createdAt: r.listing.createdAt.toISOString(),
    modelEstimate: estimateWeekly(d).toString(),
  };
}

// Nothing frozen shows on the board: the agent, its listed version or its
// maker.
const notFrozen = () =>
  sql`not exists (select 1 from ${freezes} f where f.lifted_at is null and ((f.kind = 'agent' and f.target_id = ${agents.id}) or (f.kind = 'version' and f.target_id = ${agentListings.versionId}) or (f.kind = 'maker' and f.target_id = ${agents.ownerUserId})))`;

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
        isNull(agents.stoppedAt),
        eq(agentListings.screen, "ok"),
        notFrozen(),
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
  const quality = await qualityOf(
    rt,
    fit.map((r) => ({ agentId: r.listing.agentId, versionId: r.listing.versionId, version: r.version })),
  );
  const trust = await versionTrust(
    rt,
    fit.map((r) => r.listing.versionId),
  );
  const min = f.minQuality ?? null;
  const byRenters = (a: AgentListingDTO, b: AgentListingDTO) => b.renters - a.renters || b.createdAt.localeCompare(a.createdAt);
  return fit
    .map((r) => listingDTO(r, renters.get(r.listing.agentId) ?? 0, quality.get(r.listing.versionId), trust.get(r.listing.versionId)))
    .filter((a) => min === null || (a.quality.score !== null && a.quality.score >= min))
    .sort(f.sort === "quality" ? (a, b) => (b.quality.score ?? -1) - (a.quality.score ?? -1) || b.quality.reviewed - a.quality.reviewed || byRenters(a, b) : byRenters)
    .slice(0, BOARD_LIMIT);
}

// An agent's own page, for anyone, or null when it isn't on the board.
export async function agentPage(rt: Runtime, agentId: string, viewerId: string | null = null): Promise<AgentPageDTO | null> {
  if (!/^[0-9a-f-]{36}$/i.test(agentId)) return null;
  const [row] = (await select(rt).where(and(eq(agentListings.agentId, agentId), eq(agentListings.listed, true), eq(agentVersions.state, "published"), isNull(agents.stoppedAt), eq(agentListings.screen, "ok"), notFrozen()))) as Row[];
  if (!row?.definition) return null;
  const d = row.definition;
  const renters = (await renterCounts(rt, [row])).get(agentId) ?? 0;
  const quality = (await qualityOf(rt, [{ agentId, versionId: row.listing.versionId, version: row.version }])).get(row.listing.versionId);
  const rules = typedRules(d, {});
  const ruleWords = (key: string) => {
    const r = d.rules.find((x) => x.key === key);
    const v = rules[key];
    return r ? `"${r.label}" (${r.type === "usdc" && typeof v === "number" ? `${v} USDC` : String(v)} unless you change it)` : key;
  };
  // An action's own words, without the full stop a maker may have given them.
  const plain = (words: string) => words.trim().replace(/[.\s]+$/, "");
  const neverWithoutAsking = [
    ...[...new Set(d.actions.filter((a) => spends(a) && a.askOver).map((a) => a.askOver!))].map((k) => `Spend more in one job than your limit ${ruleWords(k)}.`),
    ...[...new Set(d.actions.filter((a) => spends(a) && a.askOverDay).map((a) => a.askOverDay!))].map((k) => `Spend more in a day than your limit ${ruleWords(k)}.`),
    ...d.actions.filter((a) => a.tool === "telegram.ask").map((a) => `${plain(a.description)}: it asks you, and waits for your answer.`),
  ];
  return {
    ...listingDTO(row, renters, quality, (await versionTrust(rt, [row.listing.versionId])).get(row.listing.versionId)),
    done: d.job.done,
    runs: describeTriggers(d, null),
    steps: d.steps
      // A value check's own step runs outside the job.
      .filter((s) => !d.triggers.some((t) => t.kind === "check" && t.step === s.id))
      .map((s) => ({ kind: s.kind === "code" ? "works" : s.kind === "decision" ? "decides" : s.kind === "loop" ? "repeats" : "acts", title: s.title, outcomes: s.kind === "decision" ? s.outcomes.map((o) => o.label) : [] })),
    asks: d.settings.map((s) => ({ label: s.label, help: s.help, kind: s.type })),
    needs: connectionsNeeded(d),
    neverWithoutAsking,
    canOnly: d.actions.map((a) => plain(a.description)),
    mine: viewerId !== null && viewerId === row.makerId,
    rentalId: viewerId ? await rentalIdOf(rt, agentId, viewerId) : null,
  };
}

async function rentalIdOf(rt: Runtime, agentId: string, renterUserId: string): Promise<string | null> {
  const [r] = await rt.db
    .select({ id: rentals.id })
    .from(rentals)
    .where(and(eq(rentals.agentId, agentId), eq(rentals.renterUserId, renterUserId), ne(rentals.status, "ended")));
  return r?.id ?? null;
}

// The listing of an agent, for its maker.
export async function listingOf(rt: Runtime, agentId: string): Promise<AgentListing | null> {
  const [row] = await rt.db.select().from(agentListings).where(eq(agentListings.agentId, agentId));
  return row ?? null;
}

export async function makerListing(rt: Runtime, agentId: string): Promise<MakerListingDTO | null> {
  const [row] = await rt.db
    .select({ listing: agentListings, version: agentVersions.number })
    .from(agentListings)
    .innerJoin(agentVersions, eq(agentVersions.id, agentListings.versionId))
    .where(eq(agentListings.agentId, agentId));
  if (!row) return null;
  const cfg = budgetConfig();
  const budget = row.listing.modelBudget ? BigInt(row.listing.modelBudget) : cfg.byDefault;
  return {
    weeklyPrice: row.listing.weeklyPrice,
    jobFee: row.listing.jobFee,
    decimals: USDC_DECIMALS,
    listed: row.listing.listed,
    version: row.version,
    modelBudget: (budget > cfg.ceiling ? cfg.ceiling : budget).toString(),
    modelBudgetCeiling: cfg.ceiling.toString(),
    modelShare: row.listing.modelShare,
    screen: row.listing.screen,
    screenReason: row.listing.screenReason,
  };
}

// Its maker puts an agent on the board for rent (or changes its price, or
// takes it off): the newest published version, at a weekly price and an
// optional fee per job, in USDC minor units. A new price is for new
// renters; those renting now keep the price they rented at.
export async function setListing(rt: Runtime, agent: Agent, o: { weeklyPrice: bigint; jobFee: bigint; listed: boolean; modelBudget?: bigint | null; modelShare?: boolean }): Promise<MakerListingDTO | null> {
  const [version] = await rt.db
    .select({ id: agentVersions.id })
    .from(agentVersions)
    .where(and(eq(agentVersions.agentId, agent.id), eq(agentVersions.state, "published")))
    .orderBy(desc(agentVersions.number))
    .limit(1);
  if (!version) return null;
  const now = rt.now();
  const ceiling = budgetConfig().ceiling;
  const values = {
    versionId: version.id,
    weeklyPrice: o.weeklyPrice.toString(),
    jobFee: o.jobFee.toString(),
    listed: o.listed,
    updatedAt: now,
    ...(o.modelBudget !== undefined ? { modelBudget: o.modelBudget === null ? null : (o.modelBudget > ceiling ? ceiling : o.modelBudget).toString() } : {}),
    ...(o.modelShare !== undefined ? { modelShare: o.modelShare } : {}),
  };
  await rt.db
    .insert(agentListings)
    .values({ agentId: agent.id, ...values, createdAt: now })
    .onConflictDoUpdate({ target: agentListings.agentId, set: values });
  return makerListing(rt, agent.id);
}
