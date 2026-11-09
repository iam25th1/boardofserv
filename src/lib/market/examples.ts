import "server-only";
import { and, desc, eq, inArray, or } from "drizzle-orm";
import { agentListings, agents, agentVersions, users, type AgentVersion, type User } from "../db/schema";
import { checkDefinition, codeSpec, type AgentDefinition } from "../agents/definition";
import type { BenchData, StepCode } from "../agents/types";
import { emptyBench } from "../agents/types";
import type { Runtime } from "../agents/runtime/context";

// The example agents, put on the board from their saved files (plan, code
// approved by SERV's review, test bench), owned by the site's admin and
// free to rent. No model call: each was built once through the real
// pipeline (scripts/seed-restock.ts, scripts/seed-examples.ts). Importing
// again changes nothing for an example already there, unless asked to
// update it (updateExample), which publishes a new version the normal way.

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

// A saved example's checked plan and approved code.
function savedVersion(saved: SavedExample, now: Date): { d: AgentDefinition; code: Record<string, StepCode> } {
  const checked = checkDefinition(saved.definition);
  if (!checked.ok) throw new ExampleRefused(`An example's plan doesn't check: ${checked.errors.join(" ")}`);
  const d = checked.definition;
  const code: Record<string, StepCode> = {};
  for (const step of d.steps) {
    if (step.kind !== "code") continue;
    const c = saved.code[step.id];
    if (c?.status !== "approved" || !c.source) throw new ExampleRefused(`"${d.name}" has no approved code for "${step.title}".`);
    code[step.id] = { spec: codeSpec(step), status: "approved", source: c.source, rounds: c.rounds, note: c.note, writer: c.writer ?? "dolphin", updatedAt: now.toISOString() };
  }
  return { d, code };
}

export async function importExample(rt: Runtime, owner: User, saved: SavedExample): Promise<{ name: string; agentId: string; created: boolean }> {
  const now = rt.now();
  const { d, code } = savedVersion(saved, now);
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

export type ExampleUpdate =
  | { name: string; agentId: string; outcome: "created" | "up to date" }
  | { name: string; agentId: string; outcome: "updated"; version: number; offered: number }
  | { name: string; agentId: string; outcome: "refused"; why: string };

// JSON with its keys in order, as the database keeps them (jsonb sorts them).
const canonical = (v: unknown): string =>
  Array.isArray(v) ? `[${v.map(canonical).join(",")}]` : v && typeof v === "object" ? `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(",")}}` : JSON.stringify(v ?? null);

const sameCode = (a: Record<string, StepCode>, b: Record<string, StepCode>) =>
  Object.keys(a).length === Object.keys(b).length && Object.entries(a).every(([k, v]) => b[k]?.source === v.source);

// The --update option: an example already on the board whose saved plan
// or code has changed gets a new version through the normal version path:
// a draft, the code review, published, the board's listing moved to it
// and its renters offered it (update or stay), and the listing screened
// again. One that isn't there is put on the board as by importExample; one
// that is up to date is left alone. Steps it can't take are refused with
// the reason, and nothing changes.
export async function updateExample(
  rt: Runtime,
  owner: User,
  saved: SavedExample,
  path: {
    vet: (rt: Runtime, maker: User, version: AgentVersion) => Promise<{ status: "passed" | "blocked" | "unreviewed"; findings: { severity: string; finding: string }[] }>;
    offer: (rt: Runtime, agentId: string, version: AgentVersion) => Promise<number>;
    screen: (rt: Runtime, maker: User, agentId: string) => Promise<unknown>;
  },
): Promise<ExampleUpdate> {
  const now = rt.now();
  const { d, code } = savedVersion(saved, now);
  const [agent] = await rt.db
    .select({ id: agents.id })
    .from(agents)
    .innerJoin(agentVersions, and(eq(agentVersions.agentId, agents.id), eq(agentVersions.state, "published")))
    .where(and(eq(agents.ownerUserId, owner.id), eq(agents.name, d.name)))
    .limit(1);
  if (!agent) {
    const made = await importExample(rt, owner, saved);
    return { name: made.name, agentId: made.agentId, outcome: "created" };
  }
  const [latest] = await rt.db
    .select()
    .from(agentVersions)
    .where(and(eq(agentVersions.agentId, agent.id), eq(agentVersions.state, "published")))
    .orderBy(desc(agentVersions.number))
    .limit(1);
  if (latest && canonical(latest.definition) === canonical(d) && sameCode(latest.code, code)) return { name: d.name, agentId: agent.id, outcome: "up to date" };
  const [draft] = await rt.db.select({ id: agentVersions.id }).from(agentVersions).where(and(eq(agentVersions.agentId, agent.id), eq(agentVersions.state, "draft")));
  if (draft) return { name: d.name, agentId: agent.id, outcome: "refused", why: "it has a draft in its builder: publish or discard that first" };
  const [created] = await rt.db
    .insert(agentVersions)
    .values({ agentId: agent.id, number: (latest?.number ?? 0) + 1, state: "draft", definition: d, code, bench: saved.bench ?? emptyBench(), createdAt: now, updatedAt: now })
    .returning();
  const review = await path.vet(rt, owner, created!);
  if (review.status !== "passed") {
    // The draft stays for its maker to see why; nothing reached the board.
    const why =
      review.status === "unreviewed"
        ? "the code review couldn't run just now (SERV), so it stays a draft; try again"
        : `the code review found problems: ${review.findings.filter((f) => f.severity === "blocking").map((f) => f.finding).join(" ")}`;
    return { name: d.name, agentId: agent.id, outcome: "refused", why };
  }
  const [published] = await rt.db
    .update(agentVersions)
    .set({ state: "published", publishedAt: now, updatedAt: now })
    .where(and(eq(agentVersions.id, created!.id), eq(agentVersions.state, "draft")))
    .returning();
  await rt.db.update(agents).set({ name: d.name, updatedAt: now }).where(eq(agents.id, agent.id));
  const offered = await path.offer(rt, agent.id, published!);
  await path.screen(rt, owner, agent.id);
  return { name: d.name, agentId: agent.id, outcome: "updated", version: published!.number, offered };
}
