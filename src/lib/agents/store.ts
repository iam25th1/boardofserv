import "server-only";
import { and, desc, eq, max, sql } from "drizzle-orm";
import { db } from "../db";
import { agents, agentVersions, type Agent, type AgentVersion } from "../db/schema";

// Agents and their versions. Every write to a version goes through
// updateDraft, which only ever touches a draft: a published version is never
// changed again. Editing an agent whose latest version is published starts a
// new draft from it (editableDraft).

export async function createAgent(o: { ownerUserId: string; conversationId: string | null; name: string }): Promise<{ agent: Agent; draft: AgentVersion }> {
  return db.transaction(async (tx) => {
    const [agent] = await tx.insert(agents).values({ ownerUserId: o.ownerUserId, sourceConversationId: o.conversationId, name: o.name }).returning();
    const [draft] = await tx.insert(agentVersions).values({ agentId: agent!.id, number: 1 }).returning();
    return { agent: agent!, draft: draft! };
  });
}

export async function agentById(id: string): Promise<Agent | null> {
  return (await db.query.agents.findFirst({ where: eq(agents.id, id) })) ?? null;
}

export async function agentForConversation(conversationId: string): Promise<Agent | null> {
  return (await db.query.agents.findFirst({ where: eq(agents.sourceConversationId, conversationId) })) ?? null;
}

export async function agentsOf(ownerUserId: string): Promise<Agent[]> {
  return db.select().from(agents).where(eq(agents.ownerUserId, ownerUserId)).orderBy(desc(agents.updatedAt));
}

// Newest first.
export async function versionsOf(agentId: string): Promise<AgentVersion[]> {
  return db.select().from(agentVersions).where(eq(agentVersions.agentId, agentId)).orderBy(desc(agentVersions.number));
}

export async function versionById(id: string): Promise<AgentVersion | null> {
  return (await db.query.agentVersions.findFirst({ where: eq(agentVersions.id, id) })) ?? null;
}

export async function draftOf(agentId: string): Promise<AgentVersion | null> {
  return (await db.query.agentVersions.findFirst({ where: and(eq(agentVersions.agentId, agentId), eq(agentVersions.state, "draft")) })) ?? null;
}

// The version the builder works on: the draft, or the newest published one
// when there is no draft.
export async function currentVersion(agentId: string): Promise<AgentVersion | null> {
  return (await draftOf(agentId)) ?? (await versionsOf(agentId))[0] ?? null;
}

// The draft to edit: the one there is, or a new one copied from the newest
// published version, numbered after it.
export async function editableDraft(agentId: string): Promise<AgentVersion> {
  const existing = await draftOf(agentId);
  if (existing) return existing;
  return db.transaction(async (tx) => {
    const [latest] = await tx.select().from(agentVersions).where(eq(agentVersions.agentId, agentId)).orderBy(desc(agentVersions.number)).limit(1);
    const [top] = await tx.select({ n: max(agentVersions.number) }).from(agentVersions).where(eq(agentVersions.agentId, agentId));
    const [draft] = await tx
      .insert(agentVersions)
      .values({ agentId, number: (top?.n ?? 0) + 1, definition: latest?.definition ?? null, code: latest?.code ?? {}, bench: latest?.bench ?? null })
      .returning();
    return draft!;
  });
}

type DraftPatch = Partial<Pick<AgentVersion, "definition" | "code" | "bench" | "buildState" | "buildNote">>;

// Change a draft. Null when the version is not a draft (published, or gone):
// a published version is never written to.
export async function updateDraft(versionId: string, patch: DraftPatch): Promise<AgentVersion | null> {
  const [row] = await db
    .update(agentVersions)
    .set({ ...patch, updatedAt: new Date() })
    .where(and(eq(agentVersions.id, versionId), eq(agentVersions.state, "draft")))
    .returning();
  if (row) await db.update(agents).set({ updatedAt: new Date(), ...(patch.definition ? { name: patch.definition.name } : {}) }).where(eq(agents.id, row.agentId));
  return row ?? null;
}

// One code step's entry, written into the draft's code without touching the
// others (the build writes steps one at a time).
export async function setStepCode(versionId: string, stepId: string, entry: AgentVersion["code"][string] | null): Promise<boolean> {
  const value = entry === null ? sql`${agentVersions.code} - ${stepId}::text` : sql`${agentVersions.code} || jsonb_build_object(${stepId}::text, ${JSON.stringify(entry)}::jsonb)`;
  const rows = await db
    .update(agentVersions)
    .set({ code: value, updatedAt: new Date() })
    .where(and(eq(agentVersions.id, versionId), eq(agentVersions.state, "draft")))
    .returning({ id: agentVersions.id });
  return rows.length > 0;
}

// Publish the draft: from now on it never changes. Null when there is no
// draft.
export async function publishDraft(agentId: string): Promise<AgentVersion | null> {
  const [row] = await db
    .update(agentVersions)
    .set({ state: "published", publishedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(agentVersions.agentId, agentId), eq(agentVersions.state, "draft")))
    .returning();
  if (row) await db.update(agents).set({ updatedAt: new Date() }).where(eq(agents.id, agentId));
  return row ?? null;
}
