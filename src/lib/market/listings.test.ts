// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import { addUser, testDb } from "@/test/helperDb";
import { installed, publishedAgent, restockDefinition, testRuntime, type TestRuntime } from "@/test/runtimeFixtures";
import { agentPage, boardAgents, connectsOf } from "./listings";

// Agents on the board: listed published versions with their prices,
// filtered by what they connect to and by price, most rented first; an
// agent's page in plain words, never its code, prompts or bench.

let client: PGlite;
let db: PgliteDatabase<typeof schema>;
let rt: TestRuntime;
let maker: schema.User;

const usdc = (whole: number) => String(BigInt(Math.round(whole * 1e6)));

async function listed(name: string, weekly: number, o: { jobFee?: number; listed?: boolean; definition?: ReturnType<typeof restockDefinition> } = {}) {
  const d = { ...(o.definition ?? restockDefinition()), name };
  const p = await publishedAgent(db, maker, { definition: d });
  await db.update(schema.agents).set({ name }).where(eq(schema.agents.id, p.agent.id));
  await db.insert(schema.agentListings).values({ agentId: p.agent.id, versionId: p.version.id, weeklyPrice: usdc(weekly), jobFee: usdc(o.jobFee ?? 0), listed: o.listed ?? true });
  return p;
}

beforeAll(async () => {
  ({ client, db } = await testDb());
  rt = testRuntime(db);
  maker = await addUser(db, "lister", "maya_r");
});
afterAll(async () => client.close());

describe("agents on the board", () => {
  it("lists listed agents with their price and maker, most rented first", async () => {
    const cheap = await listed("Cheap restock", 2);
    const dear = await listed("Dear restock", 40, { jobFee: 0.5 });
    await listed("Hidden restock", 5, { listed: false });
    // Two people rent the dear one; the maker's own copy doesn't count.
    for (const who of ["renter.a", "renter.b"]) await installed(rt, await addUser(db, who), dear);
    await installed(rt, maker, cheap);
    const board = await boardAgents(rt);
    expect(board.map((a) => [a.name, a.renters])).toEqual([
      ["Dear restock", 2],
      ["Cheap restock", 0],
    ]);
    expect(board[0]).toMatchObject({ weeklyPrice: "40000000", jobFee: "500000", decimals: 6, maker: "maya_r", connects: ["telegram", "sheets"], quality: null, trust: null });
  });

  it("filters by search, what it connects to and price", async () => {
    expect((await boardAgents(rt, { q: "dear" })).map((a) => a.name)).toEqual(["Dear restock"]);
    // What it does is searched too.
    expect((await boardAgents(rt, { q: "suppliers" })).length).toBeGreaterThan(0);
    expect((await boardAgents(rt, { max: 10_000_000n })).map((a) => a.name)).toEqual(["Cheap restock"]);
    expect((await boardAgents(rt, { min: 10_000_000n })).map((a) => a.name)).toEqual(["Dear restock"]);
    expect(await boardAgents(rt, { connects: ["web"] })).toEqual([]);
    expect((await boardAgents(rt, { connects: ["telegram", "sheets"] })).length).toBe(2);
    // %, _ and \ are taken literally.
    expect(await boardAgents(rt, { q: "%" })).toEqual([]);
  });

  it("reads what an agent connects to from its plan", () => {
    const d = restockDefinition();
    expect(connectsOf(d)).toEqual(["telegram", "sheets"]);
    expect(connectsOf({ ...d, steps: d.steps.map((s) => (s.kind === "code" ? { ...s, tools: [...s.tools, "web.search"] } : s)) })).toEqual(["telegram", "sheets", "web"]);
  });
});

describe("an agent's page", () => {
  it("shows the plan in plain words, the setup, what it never does without asking, and never the code or prompts", async () => {
    const d = restockDefinition();
    const guarded = { ...d, actions: d.actions.map((a) => (a.tool === "sheets.write" ? { ...a, amountColumn: "cost_usdc", askOver: "approval_over_usdc" } : a)) };
    const p = await listed("Guarded restock", 12, { definition: guarded });
    const page = (await agentPage(rt, p.agent.id))!;
    expect(page).toMatchObject({ name: "Guarded restock", does: d.job.does, done: d.job.done, mine: false, needs: { telegram: true, google: true } });
    expect(page.steps.map((s) => [s.kind, s.title])).toEqual(d.steps.map((s) => [s.kind === "code" ? "works" : s.kind === "decision" ? "decides" : "acts", s.title]));
    expect(page.steps.find((s) => s.kind === "decides")!.outcomes).toEqual(["Over the limit", "Within the limit"]);
    expect(page.asks.map((a) => a.kind)).toEqual(["sheet", "sheet", "sheet"]);
    expect(page.neverWithoutAsking).toEqual(['Spend more in one job than your limit "Ask me before orders over" (250 USDC unless you change it).', "Ask the owner before a big order: it asks you, and waits for your answer."]);
    expect(page.canOnly).toEqual(d.actions.map((a) => a.description));
    // None of what only its maker sees.
    const shown = JSON.stringify(page);
    for (const s of d.steps) {
      if (s.kind === "code") expect(shown).not.toContain(s.description);
      if (s.kind === "decision") expect(shown).not.toContain(s.prompt);
    }
    expect(shown).not.toMatch(/async function|sheets\.read|"source"|"bench"/);
    expect((await agentPage(rt, p.agent.id, maker.id))!.mine).toBe(true);
  });

  it("is not there for an agent off the board, or a bad id", async () => {
    const off = await listed("Off restock", 3, { listed: false });
    expect(await agentPage(rt, off.agent.id)).toBeNull();
    expect(await agentPage(rt, "not-an-id")).toBeNull();
  });
});
