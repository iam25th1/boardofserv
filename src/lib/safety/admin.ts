import "server-only";
import { desc, eq, isNotNull } from "drizzle-orm";
import { agents, agentVersions, users } from "../db/schema";
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
  return {
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
