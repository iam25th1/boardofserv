import "server-only";
import { desc, eq, gte, inArray, isNotNull, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { agentInstallations, agentModelUsage, agents, agentVersions, freezes, users } from "../db/schema";
import { targetWords } from "./freeze";
import { moderationQueue } from "./moderation";
import { weekStart } from "../agents/metering";
import type { Runtime } from "../agents/runtime/context";
import type { AdminSafetyDTO } from "../types";

// The admin's safety page: every version's code review (plain words, never
// code), and in later sections what costs the most, what is frozen and the
// moderation queue.

export async function adminSafety(rt: Runtime): Promise<AdminSafetyDTO> {
  const rows = await rt.db
    .select({ versionId: agentVersions.id, number: agentVersions.number, state: agentVersions.state, review: agentVersions.review, agentId: agents.id, name: agents.name, maker: users.handle })
    .from(agentVersions)
    .innerJoin(agents, eq(agents.id, agentVersions.agentId))
    .innerJoin(users, eq(users.id, agents.ownerUserId))
    .where(isNotNull(agentVersions.review))
    .orderBy(desc(agentVersions.updatedAt))
    .limit(100);
  // The installations whose model calls cost the most this week.
  const owner = alias(users, "owner");
  const week = weekStart(rt.now());
  const top = await rt.db
    .select({
      installationId: agentModelUsage.installationId,
      name: agents.name,
      owner: owner.handle,
      maker: users.handle,
      week: sql<string>`sum(${agentModelUsage.cost})::text`,
      site: sql<string>`sum(case when ${agentModelUsage.ownKey} then 0 else ${agentModelUsage.cost} end)::text`,
      calls: sql<number>`count(*)::int`,
    })
    .from(agentModelUsage)
    .innerJoin(agentInstallations, eq(agentInstallations.id, agentModelUsage.installationId))
    .innerJoin(agents, eq(agents.id, agentInstallations.agentId))
    .innerJoin(users, eq(users.id, agents.ownerUserId))
    .innerJoin(owner, eq(owner.id, agentInstallations.ownerUserId))
    .where(gte(agentModelUsage.createdAt, week))
    .groupBy(agentModelUsage.installationId, agents.name, owner.handle, users.handle)
    .orderBy(desc(sql`sum(${agentModelUsage.cost})`))
    .limit(10);
  // The admin log: every freeze and lift.
  const log = await rt.db.select().from(freezes).orderBy(desc(freezes.createdAt)).limit(100);
  const handles = new Map((await rt.db.select({ id: users.id, handle: users.handle }).from(users).where(inArray(users.id, [...new Set(log.flatMap((f) => [f.byUserId, ...(f.liftedBy ? [f.liftedBy] : [])]))].concat(["00000000-0000-0000-0000-000000000000"])))).map((u) => [u.id, u.handle]));
  const freezeList = await Promise.all(
    log.map(async (f) => ({
      id: f.id,
      kind: f.kind,
      target: await targetWords(rt, f),
      targetId: f.targetId,
      reason: f.reason,
      by: `@${handles.get(f.byUserId) ?? "admin"}`,
      createdAt: f.createdAt.toISOString(),
      lifted: f.liftedAt ? { at: f.liftedAt.toISOString(), by: `@${handles.get(f.liftedBy ?? "") ?? "admin"}`, reason: f.liftReason ?? "" } : null,
    })),
  );
  return {
    queue: await moderationQueue(rt),
    freezes: freezeList,
    costs: top.map((t) => ({ installationId: t.installationId, name: t.name, owner: t.owner, maker: t.maker, week: t.week, sitePaid: t.site, calls: t.calls, decimals: 6 })),
    reviews: rows.map((r) => ({
      versionId: r.versionId,
      agentId: r.agentId,
      name: r.name,
      maker: r.maker,
      version: r.number,
      state: r.state,
      review: { status: r.review!.status, findings: r.review!.findings, by: r.review!.by, reviewedAt: r.review!.reviewedAt },
    })),
  };
}
