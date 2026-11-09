// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import { addUser, testDb } from "@/test/helperDb";
import { RESTOCK_WIRE } from "@/test/agentFixtures";
import { checkDefinition, type AgentDefinition } from "./definition";
import { wireToDefinition } from "./plan";
import { createAgent, currentVersion, draftOf, editableDraft, publishDraft, setStepCode, updateDraft, versionsOf } from "./store";

// Drafts and published versions on the real migrations: a published version
// never changes.

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/db", () => ({ db: new Proxy({}, { get: (_, key) => Reflect.get(state.db as object, key) }) }));

let client: PGlite;
let db: PgliteDatabase<typeof schema>;
let owner: schema.User;
const def = (() => {
  const c = checkDefinition(wireToDefinition(RESTOCK_WIRE));
  if (!c.ok) throw new Error("fixture");
  return c.definition;
})();
const approved = { spec: "s", status: "approved" as const, source: "async function run() { return {}; }", rounds: 1, note: null, updatedAt: "2026-11-09T00:00:00.000Z" };

beforeAll(async () => {
  ({ client, db } = await testDb());
  state.db = db;
  owner = await addUser(db, "ana");
});
afterAll(async () => {
  await client.close();
});

describe("agent versions", () => {
  it("start as one draft, which can change while it is a draft", async () => {
    const { agent, draft } = await createAgent({ ownerUserId: owner.id, conversationId: null, name: "Restock" });
    expect(draft).toMatchObject({ number: 1, state: "draft", definition: null, code: {}, buildState: "idle" });
    const saved = await updateDraft(draft.id, { definition: def, buildState: "writing" });
    expect(saved?.definition).toEqual(def);
    // The agent takes the plan's name.
    expect((await db.query.agents.findFirst({ where: eq(schema.agents.id, agent.id) }))!.name).toBe("Fabric restock");
    expect(await setStepCode(draft.id, "find_low", approved)).toBe(true);
    expect(await setStepCode(draft.id, "compare", { ...approved, status: "needs_attention" })).toBe(true);
    expect((await draftOf(agent.id))!.code).toEqual({ find_low: approved, compare: { ...approved, status: "needs_attention" } });
    expect(await setStepCode(draft.id, "compare", null)).toBe(true);
    expect(Object.keys((await draftOf(agent.id))!.code)).toEqual(["find_low"]);
  });

  it("never change once published: every write to it is refused", async () => {
    const { agent, draft } = await createAgent({ ownerUserId: owner.id, conversationId: null, name: "Restock" });
    await updateDraft(draft.id, { definition: def, code: { find_low: approved } });
    const published = await publishDraft(agent.id);
    expect(published).toMatchObject({ id: draft.id, state: "published", number: 1 });
    expect(published!.publishedAt).toBeInstanceOf(Date);

    const before = (await db.select().from(schema.agentVersions).where(eq(schema.agentVersions.id, draft.id)))[0];
    expect(await updateDraft(draft.id, { definition: { ...def, name: "Changed" } as AgentDefinition })).toBeNull();
    expect(await updateDraft(draft.id, { buildState: "failed", buildNote: "x" })).toBeNull();
    expect(await setStepCode(draft.id, "find_low", null)).toBe(false);
    expect(await setStepCode(draft.id, "compare", approved)).toBe(false);
    expect(await publishDraft(agent.id)).toBeNull();
    const after = (await db.select().from(schema.agentVersions).where(eq(schema.agentVersions.id, draft.id)))[0];
    expect(after).toEqual(before);
  });

  it("start a new draft from the newest published version when edited after publishing", async () => {
    const { agent, draft } = await createAgent({ ownerUserId: owner.id, conversationId: null, name: "Restock" });
    await updateDraft(draft.id, { definition: def, code: { find_low: approved }, bench: { settings: { stock_sheet: "Stock" } } as never });
    await publishDraft(agent.id);
    expect((await currentVersion(agent.id))!.state).toBe("published");

    const next = await editableDraft(agent.id);
    expect(next).toMatchObject({ number: 2, state: "draft", definition: def, code: { find_low: approved }, bench: { settings: { stock_sheet: "Stock" } } });
    expect((await editableDraft(agent.id)).id).toBe(next.id);
    expect((await currentVersion(agent.id))!.id).toBe(next.id);
    expect((await versionsOf(agent.id)).map((v) => [v.number, v.state])).toEqual([
      [2, "draft"],
      [1, "published"],
    ]);
  });

  it("keep at most one draft per agent, and a published version always has its time", async () => {
    const { agent } = await createAgent({ ownerUserId: owner.id, conversationId: null, name: "Restock" });
    await expect(db.insert(schema.agentVersions).values({ agentId: agent.id, number: 2 })).rejects.toThrow();
    await expect(db.insert(schema.agentVersions).values({ agentId: agent.id, number: 3, state: "published" })).rejects.toThrow();
  });
});
