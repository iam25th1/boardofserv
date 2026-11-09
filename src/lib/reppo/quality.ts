import "server-only";
import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { agentVersions, reppoEvals } from "../db/schema";
import type { Runtime } from "../agents/runtime/context";
import type { QualityDTO, ScoredJobDTO } from "../types";

// An agent version's quality, from Reppo's scores of its sampled jobs: the
// average of its latest scores (a rolling window), shown only once enough
// of its jobs were reviewed, with how many were and the share routed ship,
// review and block. A new version starts fresh; the last earlier version
// with a score is shown beside it as history.

type Env = Record<string, string | undefined>;
const whole = (raw: string | undefined, fallback: number, min: number) => {
  const n = Number(raw);
  return raw !== undefined && raw.trim() !== "" && Number.isInteger(n) && n >= min ? n : fallback;
};

export function qualitySettings(env: Env = process.env) {
  return {
    // Reviewed jobs before a version shows a score.
    minimum: whole(env.REPPO_MIN_SCORED, 5, 1),
    // The latest this many scores make the rolling score.
    window: whole(env.REPPO_SCORE_WINDOW, 30, 1),
  };
}

type Stats = { score: number | null; reviewed: number; ship: number; review: number; block: number };

const pct = (n: number, of: number) => (of ? Math.round((n * 100) / of) : 0);

// The rolling stats of some versions, by version.
async function statsOf(rt: Runtime, versionIds: string[], settings = qualitySettings()): Promise<Map<string, Stats>> {
  if (!versionIds.length) return new Map();
  const latest = rt.db
    .select({
      versionId: reppoEvals.versionId,
      score: reppoEvals.score,
      route: reppoEvals.route,
      n: sql<number>`row_number() over (partition by ${reppoEvals.versionId} order by ${reppoEvals.completedAt} desc)`.as("n"),
    })
    .from(reppoEvals)
    .where(and(eq(reppoEvals.kind, "job"), eq(reppoEvals.status, "completed"), isNotNull(reppoEvals.score), inArray(reppoEvals.versionId, versionIds)))
    .as("latest");
  const rows = await rt.db
    .select({
      versionId: latest.versionId,
      avg: sql<string>`avg(${latest.score})`,
      reviewed: sql<number>`count(*)::int`,
      ship: sql<number>`count(*) filter (where ${latest.route} = 'ship')::int`,
      review: sql<number>`count(*) filter (where ${latest.route} = 'review')::int`,
      block: sql<number>`count(*) filter (where ${latest.route} = 'block')::int`,
    })
    .from(latest)
    .where(sql`${latest.n} <= ${settings.window}`)
    .groupBy(latest.versionId);
  return new Map(
    rows.map((r) => [
      r.versionId,
      {
        score: r.reviewed >= settings.minimum ? Math.round(Number(r.avg)) : null,
        reviewed: r.reviewed,
        ship: pct(r.ship, r.reviewed),
        review: pct(r.review, r.reviewed),
        block: pct(r.block, r.reviewed),
      },
    ]),
  );
}

const none: Stats = { score: null, reviewed: 0, ship: 0, review: 0, block: 0 };

// The quality of some agents' listed versions, with the history of their
// earlier versions, by version id.
export async function qualityOf(rt: Runtime, listed: { agentId: string; versionId: string; version: number }[], settings = qualitySettings()): Promise<Map<string, QualityDTO>> {
  if (!listed.length) return new Map();
  const earlier = await rt.db
    .select({ id: agentVersions.id, agentId: agentVersions.agentId, number: agentVersions.number })
    .from(agentVersions)
    .where(and(inArray(agentVersions.agentId, [...new Set(listed.map((l) => l.agentId))]), eq(agentVersions.state, "published")))
    .orderBy(desc(agentVersions.number));
  const stats = await statsOf(rt, [...new Set([...listed.map((l) => l.versionId), ...earlier.map((v) => v.id)])], settings);
  return new Map(
    listed.map((l) => {
      const before = earlier.filter((v) => v.agentId === l.agentId && v.number < l.version).find((v) => stats.get(v.id)?.score != null);
      const prev = before ? stats.get(before.id)! : null;
      return [
        l.versionId,
        {
          ...(stats.get(l.versionId) ?? none),
          minimum: settings.minimum,
          previous: before && prev?.score != null ? { version: before.number, score: prev.score, reviewed: prev.reviewed } : null,
        },
      ];
    }),
  );
}

// A maker's scored jobs, newest first: the score, route, reason and rubric
// scores, with nothing of the renter's (no who, no what it read).
export async function scoredJobs(rt: Runtime, agentId: string, limit = 30): Promise<ScoredJobDTO[]> {
  const rows = await rt.db
    .select({ id: reppoEvals.id, at: reppoEvals.completedAt, version: agentVersions.number, score: reppoEvals.score, route: reppoEvals.route, confidence: reppoEvals.confidence, reason: reppoEvals.reason, rubric: reppoEvals.rubric, reviewedAt: reppoEvals.reviewedAt })
    .from(reppoEvals)
    .innerJoin(agentVersions, eq(agentVersions.id, reppoEvals.versionId))
    .where(and(eq(reppoEvals.agentId, agentId), eq(reppoEvals.kind, "job"), eq(reppoEvals.status, "completed")))
    .orderBy(desc(reppoEvals.completedAt))
    .limit(limit);
  return rows.map((r) => ({
    id: r.id,
    at: r.at!.toISOString(),
    version: r.version,
    score: r.score,
    route: r.route,
    confidence: r.confidence,
    reason: r.reason,
    rubric: r.rubric ?? {},
    flagged: r.route === "block" && r.reviewedAt === null,
  }));
}
