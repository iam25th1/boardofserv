import "server-only";
import { and, eq, gte, inArray, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import { agentJobs, agentListings, agentPayments, agents, agentVersions, freezes, rentals, reports, reppoEvals, trustScores, users } from "../db/schema";
import type { Runtime } from "../agents/runtime/context";
import { blockedSince } from "../agents/audit";
import { TRUST } from "./config";
import type { Signals } from "./score";

// What a trust score is computed from, read from what happened: for an
// agent version (its jobs, payments and Reppo scores, and what is about its
// agent) or for a maker (all of it, for all of their agents, and their own
// account). Disputes and refunds are counted by disputes.ts once it adds
// them (extraSignals).

const DAY = 86_400_000;

export type ExtraSignals = (rt: Runtime, scope: { versionIds: string[]; agentIds: string[]; makerId: string | null }, since: { window: Date; recent: Date }) => Promise<Partial<Signals>>;
const extras: ExtraSignals[] = [];
export function addSignals(f: ExtraSignals): void {
  if (!extras.includes(f)) extras.push(f);
}

async function collect(rt: Runtime, scope: { versionIds: string[]; agentIds: string[]; makerId: string | null; since: Date }): Promise<Signals> {
  const now = rt.now();
  const window = new Date(now.getTime() - TRUST.WINDOW_DAYS * DAY);
  const recent = new Date(now.getTime() - TRUST.RECENT_DAYS * DAY);
  const versions = scope.versionIds.length ? scope.versionIds : ["00000000-0000-0000-0000-000000000000"];
  const agentIds = scope.agentIds.length ? scope.agentIds : ["00000000-0000-0000-0000-000000000000"];

  const [jobs] = await rt.db
    .select({ done: sql<number>`count(*) filter (where ${agentJobs.status} = 'done')::int`, failed: sql<number>`count(*) filter (where ${agentJobs.status} = 'failed')::int` })
    .from(agentJobs)
    .where(and(inArray(agentJobs.versionId, versions), gte(agentJobs.finishedAt, window)));
  const blocks = await blockedSince(rt, scope.versionIds.length === 1 && !scope.makerId ? { versionId: scope.versionIds[0], since: recent } : { agentIds, since: recent });
  const [reppo] = await rt.db
    .select({
      avg: sql<string | null>`avg(${reppoEvals.score})`,
      n: sql<number>`count(${reppoEvals.score})::int`,
      blocks: sql<number>`count(*) filter (where ${reppoEvals.route} = 'block')::int`,
    })
    .from(reppoEvals)
    .where(and(eq(reppoEvals.kind, "job"), eq(reppoEvals.status, "completed"), inArray(reppoEvals.versionId, versions), gte(reppoEvals.completedAt, window)));
  const upheld = sql`(${reports.resolution} like 'Hidden:%' or ${reports.resolution} like 'Frozen:%')`;
  const [reported] = await rt.db
    .select({ n: sql<number>`count(distinct ${reports.id})::int` })
    .from(reports)
    .where(and(eq(reports.status, "resolved"), upheld, gte(reports.resolvedAt, recent), or(and(eq(reports.kind, "agent"), inArray(reports.targetId, agentIds)), scope.makerId ? and(eq(reports.kind, "maker"), eq(reports.targetId, scope.makerId)) : undefined)));
  const frozenWhere = or(
    and(eq(freezes.kind, "agent"), inArray(freezes.targetId, agentIds)),
    and(eq(freezes.kind, "version"), inArray(freezes.targetId, versions)),
    scope.makerId ? and(eq(freezes.kind, "maker"), eq(freezes.targetId, scope.makerId)) : undefined,
  );
  const [frozen] = await rt.db
    .select({ n: sql<number>`count(*) filter (where ${freezes.createdAt} >= ${window.toISOString()}::timestamptz)::int`, now: sql<number>`count(*) filter (where ${freezes.liftedAt} is null)::int` })
    .from(freezes)
    .where(frozenWhere);
  const [held] = await rt.db
    .select({ n: sql<number>`count(*)::int` })
    .from(agentListings)
    .where(and(inArray(agentListings.agentId, agentIds), eq(agentListings.screen, "held")));
  const [rented] = await rt.db
    .select({
      renewals: sql<number>`coalesce(sum(greatest(${rentals.weeksPaid} - 1, 0)) filter (where ${rentals.updatedAt} >= ${window.toISOString()}::timestamptz), 0)::int`,
      cancelled: sql<number>`count(*) filter (where ${rentals.cancelledAt} >= ${window.toISOString()}::timestamptz)::int`,
    })
    .from(rentals)
    .where(inArray(rentals.agentId, agentIds));
  const [paid] = await rt.db
    .select({
      good: sql<number>`count(*) filter (where ${agentPayments.status} = 'confirmed')::int`,
      failed: sql<number>`count(*) filter (where ${agentPayments.status} = 'failed' and ${agentPayments.txHash} is not null)::int`,
    })
    .from(agentPayments)
    .where(and(scope.makerId ? inArray(agentPayments.agentId, agentIds) : inArray(agentPayments.versionId, versions), gte(agentPayments.createdAt, window)));

  const s: Signals = {
    done: jobs?.done ?? 0,
    failed: jobs?.failed ?? 0,
    blocks,
    reppoAvg: reppo?.avg === null || reppo?.avg === undefined ? null : Number(reppo.avg),
    reppoReviewed: reppo?.n ?? 0,
    reppoBlocks: reppo?.blocks ?? 0,
    reportsUpheld: reported?.n ?? 0,
    disputesUpheld: 0,
    refunds: 0,
    freezes: frozen?.n ?? 0,
    frozenNow: (frozen?.now ?? 0) > 0,
    heldNow: (held?.n ?? 0) > 0,
    ageDays: Math.max(0, Math.floor((now.getTime() - scope.since.getTime()) / DAY)),
    renewals: rented?.renewals ?? 0,
    cancellations: rented?.cancelled ?? 0,
    paymentsGood: paid?.good ?? 0,
    paymentsFailed: paid?.failed ?? 0,
  };
  for (const more of extras) Object.assign(s, await more(rt, { versionIds: scope.versionIds, agentIds: scope.agentIds, makerId: scope.makerId }, { window, recent }));
  return s;
}

export async function versionSignals(rt: Runtime, versionId: string): Promise<Signals | null> {
  const [v] = await rt.db
    .select({ agentId: agentVersions.agentId, createdAt: agents.createdAt })
    .from(agentVersions)
    .innerJoin(agents, eq(agents.id, agentVersions.agentId))
    .where(eq(agentVersions.id, versionId));
  if (!v) return null;
  return collect(rt, { versionIds: [versionId], agentIds: [v.agentId], makerId: null, since: v.createdAt });
}

export async function makerSignals(rt: Runtime, makerId: string): Promise<Signals | null> {
  const [u] = await rt.db.select({ createdAt: users.createdAt }).from(users).where(eq(users.id, makerId));
  if (!u) return null;
  const made = await rt.db.select({ id: agents.id }).from(agents).where(eq(agents.ownerUserId, makerId));
  const versions = made.length
    ? await rt.db
        .select({ id: agentVersions.id })
        .from(agentVersions)
        .where(and(inArray(agentVersions.agentId, made.map((a) => a.id)), isNotNull(agentVersions.publishedAt)))
    : [];
  return collect(rt, { versionIds: versions.map((v) => v.id), agentIds: made.map((a) => a.id), makerId, since: u.createdAt });
}

// Versions whose jobs finished since their score was computed (or that
// have none yet), and scores a day old: what the worker refreshes.
export async function staleVersions(rt: Runtime, limit = 20): Promise<string[]> {
  const dayAgo = new Date(rt.now().getTime() - DAY);
  const rows = await rt.db
    .selectDistinct({ id: agentJobs.versionId })
    .from(agentJobs)
    .leftJoin(trustScores, and(eq(trustScores.subject, "version"), eq(trustScores.subjectId, agentJobs.versionId)))
    .where(and(isNotNull(agentJobs.finishedAt), or(isNull(trustScores.computedAt), sql`${agentJobs.finishedAt} > ${trustScores.computedAt}`, lt(trustScores.computedAt, dayAgo))))
    .limit(limit);
  return rows.map((r) => r.id);
}
