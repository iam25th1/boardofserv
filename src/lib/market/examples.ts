import "server-only";
import { and, eq, inArray, or } from "drizzle-orm";
import { agentListings, agents, agentVersions, users, type User } from "../db/schema";
import { checkDefinition, codeSpec } from "../agents/definition";
import type { BenchData, StepCode } from "../agents/types";
import { emptyBench } from "../agents/types";
import type { Runtime } from "../agents/runtime/context";

// The example agents, put on the board from their saved files (plan, code
// approved by SERV's review, test bench), owned by the site's admin and
// free to rent. No model call: each was built once through the real
// pipeline (scripts/seed-restock.ts, scripts/seed-examples.ts). Importing
// again changes nothing for an example already there.

export interface SavedExample {
  definition: unknown;
  code: Record<string, { status: string; source: string | null; rounds: number; note: string | null; writer?: "dolphin" | "serv" }>;
  bench?: BenchData;
}

export class ExampleRefused extends Error {}

// The admin the examples belong to: the first account named in
// ADMIN_USER_IDS (by boardofserv user id or Privy user id).
export async function exampleOwner(rt: Runtime, adminIds: string[]): Promise<User | null> {
  const ids = adminIds.filter(Boolean);
  if (!ids.length) return null;
  const uuids = ids.filter((id) => /^[0-9a-f-]{36}$/i.test(id));
  const rows = await rt.db
    .select()
    .from(users)
    .where(uuids.length ? or(inArray(users.id, uuids), inArray(users.privyUserId, ids)) : inArray(users.privyUserId, ids));
  for (const id of ids) {
    const u = rows.find((r) => r.id === id || r.privyUserId === id);
    if (u) return u;
  }
  return null;
}

export async function importExample(rt: Runtime, owner: User, saved: SavedExample): Promise<{ name: string; agentId: string; created: boolean }> {
  const checked = checkDefinition(saved.definition);
  if (!checked.ok) throw new ExampleRefused(`An example's plan doesn't check: ${checked.errors.join(" ")}`);
  const d = checked.definition;
  const now = rt.now();
  const code: Record<string, StepCode> = {};
  for (const step of d.steps) {
    if (step.kind !== "code") continue;
    const c = saved.code[step.id];
    if (c?.status !== "approved" || !c.source) throw new ExampleRefused(`"${d.name}" has no approved code for "${step.title}".`);
    code[step.id] = { spec: codeSpec(step), status: "approved", source: c.source, rounds: c.rounds, note: c.note, writer: c.writer ?? "dolphin", updatedAt: now.toISOString() };
  }
  const [mine] = await rt.db
    .select({ id: agents.id })
    .from(agents)
    .innerJoin(agentVersions, and(eq(agentVersions.agentId, agents.id), eq(agentVersions.state, "published")))
    .where(and(eq(agents.ownerUserId, owner.id), eq(agents.name, d.name)))
    .limit(1);
  if (mine) return { name: d.name, agentId: mine.id, created: false };
  return rt.db.transaction(async (tx) => {
    const [agent] = await tx.insert(agents).values({ ownerUserId: owner.id, name: d.name, createdAt: now, updatedAt: now }).returning();
    const [version] = await tx
      .insert(agentVersions)
      .values({ agentId: agent!.id, number: 1, state: "published", publishedAt: now, definition: d, code, bench: saved.bench ?? emptyBench(), createdAt: now, updatedAt: now })
      .returning();
    await tx.insert(agentListings).values({ agentId: agent!.id, versionId: version!.id, weeklyPrice: "0", jobFee: "0", listed: true, createdAt: now, updatedAt: now });
    return { name: d.name, agentId: agent!.id, created: true };
  });
}
