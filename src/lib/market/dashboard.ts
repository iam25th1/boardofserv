import "server-only";
import { qualityOf, scoredJobs } from "../reppo/quality";
import { openBlocks } from "../reppo/blocks";
import { makerTrust, trustTrend, versionTrust } from "../trust/trust";
import { and, eq, gte, inArray, ne, sql } from "drizzle-orm";
import { agentInstallations, agentJobs, agentJobSteps, agentVersions, holds, ledgerEntries, rentalCharges, rentals, users, type Agent } from "../db/schema";
import type { MakerDashboardDTO } from "../types";
import type { Runtime } from "../agents/runtime/context";
import { USDC_DECIMALS } from "./charges";
import { makerListing } from "./listings";
import { rentalDTOs } from "./rentals";
import { activeFreeze } from "../safety/freeze";

// The maker's dashboard for one of their agents on the board. Renters'
// jobs are counted and their failures grouped by the step that failed,
// never by what the job saw: a renter's data stays theirs.

const WEEKS = 8;
const DAY_MS = 86_400_000;

// Monday 00:00 UTC of the week `t` falls in.
export function weekStart(t: Date): Date {
  const d = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate()));
  return new Date(d.getTime() - ((d.getUTCDay() + 6) % 7) * DAY_MS);
}

export async function makerDashboard(rt: Runtime, agent: Agent): Promise<MakerDashboardDTO> {
  const now = rt.now();
  const rows = await rt.db.select().from(rentals).where(eq(rentals.agentId, agent.id)).limit(200);
  const dtos = await rentalDTOs(rt, rows);
  const handles = rows.length ? await rt.db.select({ id: users.id, handle: users.handle }).from(users).where(inArray(users.id, [...new Set(rows.map((r) => r.renterUserId))])) : [];
  const renters = rows
    .map((r, i) => ({ handle: handles.find((h) => h.id === r.renterUserId)?.handle ?? "", since: r.createdAt.toISOString(), status: dtos[i]!.status, version: dtos[i]!.version, weeksPaid: r.weeksPaid }))
    .sort((a, b) => Number(a.status === "ended") - Number(b.status === "ended") || b.since.localeCompare(a.since));

  // What it earned the maker: their share of each week's rent and each
  // fee per job, by the week it was taken.
  const rentHolds = rt.db.select({ id: rentalCharges.holdId }).from(rentalCharges).innerJoin(rentals, eq(rentals.id, rentalCharges.rentalId)).where(eq(rentals.agentId, agent.id));
  const feeJobs = rt.db.select({ id: agentJobs.id }).from(agentJobs).innerJoin(agentInstallations, eq(agentInstallations.id, agentJobs.installationId)).where(eq(agentInstallations.agentId, agent.id));
  const earned = await rt.db
    .select({ amount: ledgerEntries.amount, at: holds.settledAt })
    .from(ledgerEntries)
    .innerJoin(holds, sql`${holds.id}::text = ${ledgerEntries.referenceId}`)
    .where(
      and(
        eq(ledgerEntries.kind, "maker_earning"),
        eq(ledgerEntries.userId, agent.ownerUserId),
        eq(holds.status, "captured"),
        sql`(${holds.id} in (${rentHolds}) or ${holds.jobId} in (${feeJobs}))`,
      ),
    );
  const thisWeek = weekStart(now).getTime();
  const earnings = Array.from({ length: WEEKS }, (_, i) => {
    const start = thisWeek - (WEEKS - 1 - i) * 7 * DAY_MS;
    const amount = earned.filter((e) => e.at && e.at.getTime() >= start && e.at.getTime() < start + 7 * DAY_MS).reduce((t, e) => t + BigInt(e.amount), 0n);
    return { week: new Date(start).toISOString(), amount: amount.toString() };
  });

  // Renters' jobs in the last 30 days (not the maker's own copy).
  const since = new Date(now.getTime() - 30 * DAY_MS);
  const ended = await rt.db
    .select({ id: agentJobs.id, status: agentJobs.status, versionId: agentJobs.versionId })
    .from(agentJobs)
    .innerJoin(agentInstallations, eq(agentInstallations.id, agentJobs.installationId))
    .where(and(eq(agentInstallations.agentId, agent.id), ne(agentJobs.ownerUserId, agent.ownerUserId), inArray(agentJobs.status, ["done", "failed"]), gte(agentJobs.finishedAt, since)));
  const failedIds = ended.filter((j) => j.status === "failed").map((j) => j.id);
  const failedSteps = failedIds.length
    ? await rt.db.select({ jobId: agentJobSteps.jobId, stepId: agentJobSteps.stepId }).from(agentJobSteps).where(and(inArray(agentJobSteps.jobId, failedIds), eq(agentJobSteps.status, "failed")))
    : [];
  const versions = await rt.db.select().from(agentVersions).where(and(eq(agentVersions.agentId, agent.id), eq(agentVersions.state, "published")));
  const titleOf = (versionId: string, stepId: string) => versions.find((v) => v.id === versionId)?.definition?.steps.find((s) => s.id === stepId)?.title ?? stepId;
  const counts = new Map<string, number>();
  for (const j of ended.filter((x) => x.status === "failed")) {
    const step = failedSteps.find((s) => s.jobId === j.id);
    const label = step ? titleOf(j.versionId, step.stepId) : "Before its first step";
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }

  const frozen = await activeFreeze(rt, { agentId: agent.id, makerId: agent.ownerUserId });
  // Quality: the listed version's, or the newest published one's.
  const listing = await makerListing(rt, agent.id);
  const shown = versions.find((v) => v.number === listing?.version) ?? [...versions].sort((a, b) => b.number - a.number)[0];
  const quality = shown ? ((await qualityOf(rt, [{ agentId: agent.id, versionId: shown.id, version: shown.number }])).get(shown.id) ?? null) : null;
  return {
    stopped: agent.stoppedAt ? { at: agent.stoppedAt.toISOString(), note: agent.stopNote } : null,
    frozen: frozen?.reason ?? null,
    agentId: agent.id,
    name: agent.name,
    listing,
    quality,
    scored: await scoredJobs(rt, agent.id),
    flagged: await openBlocks(rt, agent.id),
    trust: {
      version: shown ? ((await versionTrust(rt, [shown.id])).get(shown.id) ?? null) : null,
      maker: await makerTrust(rt, agent.ownerUserId),
      versionTrend: shown ? await trustTrend(rt, "version", shown.id) : [],
      makerTrend: await trustTrend(rt, "maker", agent.ownerUserId),
    },
    decimals: USDC_DECIMALS,
    renters,
    earnings,
    earnedTotal: earned.reduce((t, e) => t + BigInt(e.amount), 0n).toString(),
    jobs: { done: ended.filter((j) => j.status === "done").length, failed: failedIds.length },
    failures: [...counts].map(([step, count]) => ({ step, count })).sort((a, b) => b.count - a.count).slice(0, 5),
    versions: versions
      .sort((a, b) => b.number - a.number)
      .map((v) => ({
        number: v.number,
        publishedAt: v.publishedAt?.toISOString() ?? null,
        renters: rows.filter((r) => r.status !== "ended" && r.versionId === v.id).length,
        offered: rows.filter((r) => r.status !== "ended" && r.offeredVersionId === v.id).length,
      })),
  };
}
