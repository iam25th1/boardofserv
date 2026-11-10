import "server-only";
import { and, desc, eq, gte, inArray } from "drizzle-orm";
import { agents, agentVersions, trustHistory, trustScores, users } from "../db/schema";
import type { Runtime } from "../agents/runtime/context";
import type { TrustDTO } from "../types";
import { bandOf, scoreOf, type Score } from "./score";
import { makerSignals, staleVersions, versionSignals } from "./signals";
import { TRUST } from "./config";

// Trust scores kept: computed (the fixed formula in score.ts over the
// signals in signals.ts), stored with their factors, one a day kept for the
// trend. The worker refreshes versions whose jobs finished since, and every
// score once a day, with their makers.

async function store(rt: Runtime, subject: "version" | "maker", subjectId: string, s: Score): Promise<void> {
  const now = rt.now();
  await rt.db
    .insert(trustScores)
    .values({ subject, subjectId, score: s.score, label: s.label, isNew: s.isNew, factors: s.factors, computedAt: now })
    .onConflictDoUpdate({ target: [trustScores.subject, trustScores.subjectId], set: { score: s.score, label: s.label, isNew: s.isNew, factors: s.factors, computedAt: now } });
  await rt.db
    .insert(trustHistory)
    .values({ subject, subjectId, day: now.toISOString().slice(0, 10), score: s.score })
    .onConflictDoUpdate({ target: [trustHistory.subject, trustHistory.subjectId, trustHistory.day], set: { score: s.score } });
}

export async function refreshVersion(rt: Runtime, versionId: string): Promise<Score | null> {
  const s = await versionSignals(rt, versionId);
  if (!s) return null;
  const score = scoreOf(s);
  await store(rt, "version", versionId, score);
  return score;
}

export async function refreshMaker(rt: Runtime, makerId: string): Promise<Score | null> {
  const s = await makerSignals(rt, makerId);
  if (!s) return null;
  const score = scoreOf(s);
  await store(rt, "maker", makerId, score);
  return score;
}

// From the worker's cycle: stale versions and their makers.
export async function refreshTrust(rt: Runtime, limit = 20): Promise<number> {
  const versions = await staleVersions(rt, limit);
  const makers = new Set<string>();
  for (const v of versions) {
    await refreshVersion(rt, v);
    const [a] = await rt.db.select({ maker: agents.ownerUserId }).from(agentVersions).innerJoin(agents, eq(agents.id, agentVersions.agentId)).where(eq(agentVersions.id, v));
    if (a) makers.add(a.maker);
  }
  for (const m of makers) await refreshMaker(rt, m);
  return versions.length;
}

const START: TrustDTO = { score: TRUST.START, label: "new", isNew: true, factors: [], band: { ...bandOf(TRUST.START, true) }, computedAt: null };

function dto(row: typeof trustScores.$inferSelect | undefined): TrustDTO {
  if (!row) return START;
  const band = bandOf(row.score, row.isNew);
  return { score: row.score, label: row.label as TrustDTO["label"], isNew: row.isNew, factors: row.factors, band: { label: band.label, perPayment: band.perPayment, perDay: band.perDay }, computedAt: row.computedAt.toISOString() };
}

// Stored scores for versions (the starting score where none is yet).
export async function versionTrust(rt: Runtime, versionIds: string[]): Promise<Map<string, TrustDTO>> {
  const rows = versionIds.length ? await rt.db.select().from(trustScores).where(and(eq(trustScores.subject, "version"), inArray(trustScores.subjectId, versionIds))) : [];
  return new Map(versionIds.map((id) => [id, dto(rows.find((r) => r.subjectId === id))]));
}

export async function makerTrust(rt: Runtime, makerId: string): Promise<TrustDTO> {
  const [row] = await rt.db.select().from(trustScores).where(and(eq(trustScores.subject, "maker"), eq(trustScores.subjectId, makerId)));
  return dto(row);
}

// A score's trend: one a day, oldest first, the last `days`.
export async function trustTrend(rt: Runtime, subject: "version" | "maker", subjectId: string, days = 30): Promise<{ day: string; score: number }[]> {
  const since = new Date(rt.now().getTime() - days * 86_400_000).toISOString().slice(0, 10);
  const rows = await rt.db
    .select({ day: trustHistory.day, score: trustHistory.score })
    .from(trustHistory)
    .where(and(eq(trustHistory.subject, subject), eq(trustHistory.subjectId, subjectId), gte(trustHistory.day, since)))
    .orderBy(desc(trustHistory.day));
  return rows.reverse();
}

// The admin's view: the lowest scores, versions and makers, each with its
// biggest factor.
export async function trustAdmin(rt: Runtime, limit = 10) {
  const versions = await rt.db
    .select({ s: trustScores, agent: agents.name, version: agentVersions.number, makerId: agents.ownerUserId })
    .from(trustScores)
    .innerJoin(agentVersions, eq(agentVersions.id, trustScores.subjectId))
    .innerJoin(agents, eq(agents.id, agentVersions.agentId))
    .where(eq(trustScores.subject, "version"))
    .orderBy(trustScores.score)
    .limit(limit);
  const makers = await rt.db
    .select({ s: trustScores, handle: users.handle })
    .from(trustScores)
    .innerJoin(users, eq(users.id, trustScores.subjectId))
    .where(eq(trustScores.subject, "maker"))
    .orderBy(trustScores.score)
    .limit(limit);
  const top = (f: { words: string }[]) => f[0]?.words ?? "Nothing has moved it yet";
  return {
    versions: versions.map((v) => ({ versionId: v.s.subjectId, agent: v.agent, version: v.version, score: v.s.score, label: v.s.label, top: top(v.s.factors) })),
    makers: makers.map((m) => ({ makerId: m.s.subjectId, maker: `@${m.handle}`, score: m.s.score, label: m.s.label, top: top(m.s.factors) })),
  };
}
