// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import { addUser, testDb } from "@/test/helperDb";
import { installed, publishedAgent, restockDefinition, testRuntime, type TestRuntime } from "@/test/runtimeFixtures";
import { TOOL_NAMES } from "./definition";
import { Paused } from "./runner";
import { RISKS, TOOLS } from "./toolbox";
import { policyAsks, readPolicy, riskOf, safetyOf, toolsOf } from "./risk";
import { JobTools } from "./runtime/tools";
import { loadInstallation, setPolicy } from "./runtime/installations";

// Risk levels: fixed per tool in the registry, money for whatever spends,
// the platform's floor that nobody lowers, and what a renter raises.

// The restock agent with its order rows' amounts declared (so writing
// them spends) and a message to the owner.
function guarded() {
  const d = restockDefinition();
  return {
    ...d,
    actions: [...d.actions.map((a) => (a.tool === "sheets.write" ? { ...a, amountColumn: "total_cost_usdc" } : a)), { id: "tell", tool: "telegram.send" as const, description: "Tell the owner" }],
    steps: [...d.steps, { id: "tell", kind: "action" as const, title: "Tell the owner", inputs: [], outputs: [], action: "tell", next: null }],
  } as ReturnType<typeof restockDefinition>;
}

let client: PGlite;
let db: PgliteDatabase<typeof schema>;
let rt: TestRuntime;

beforeAll(async () => {
  ({ client, db } = await testDb());
  rt = testRuntime(db);
});
afterAll(async () => client.close());

describe("the registry", () => {
  it("gives every tool a level, and the right one", () => {
    for (const t of TOOL_NAMES) expect(RISKS).toContain(TOOLS[t].risk);
    expect(Object.fromEntries(TOOL_NAMES.map((t) => [t, TOOLS[t].risk]))).toEqual({
      "sheets.read": "read",
      "sheets.write": "write",
      "sheets.update": "write",
      "web.fetch": "read",
      "web.search": "read",
      "telegram.send": "outbound",
      "telegram.ask": "outbound",
      "memory.get": "read",
      "memory.set": "write",
      "wallet.pay": "money",
      // Asking SERV changes nothing: it is metered, never guarded.
      "serv.reason": "read",
    });
  });

  it("makes a sheet write that records amounts money, wherever it is called", () => {
    const d = guarded();
    const write = d.steps.find((s) => s.id === "record")!;
    expect(riskOf(d, write, "sheets.write")).toBe("money");
    const code = d.steps.find((s) => s.kind === "code")!;
    expect(riskOf(d, code, "sheets.read")).toBe("read");
    expect(toolsOf(d)[0]).toBe("sheets.read");
    expect(safetyOf(d, readPolicy({})).tools.find((t) => t.tool === "sheets.write")).toMatchObject({ risk: "money", canRaise: false, floor: "Asks you before spending more than your auto limit, or than its trust score allows." });
  });
});

describe("the floor and the renter's settings", () => {
  it("cleans a stored policy: no reads, the auto limit kept in bounds", () => {
    expect(readPolicy({ askFor: ["sheets.read", "sheets.write", "nope", "sheets.write"], autoSpendUsdc: -5 })).toEqual({ askFor: ["sheets.write"], autoSpendUsdc: 0 });
    expect(readPolicy({ autoSpendUsdc: 1e9 }).autoSpendUsdc).toBe(1000);
    expect(readPolicy("junk")).toEqual({ askFor: [], autoSpendUsdc: 0 });
  });

  it("asks before any spend over the auto limit, any outbound to someone else, and whatever the renter raised", () => {
    const none = readPolicy({});
    expect(policyAsks(none, { tool: "wallet.pay", risk: "money", amount: 1, toOwner: false })).toEqual(["It spends money, and you approve every spend."]);
    expect(policyAsks(readPolicy({ autoSpendUsdc: 50 }), { tool: "wallet.pay", risk: "money", amount: 40, toOwner: false })).toEqual([]);
    expect(policyAsks(readPolicy({ autoSpendUsdc: 50 }), { tool: "wallet.pay", risk: "money", amount: 60, toOwner: false })[0]).toMatch(/auto limit of 50 USDC/);
    expect(policyAsks(none, { tool: "telegram.send", risk: "outbound", toOwner: true })).toEqual([]);
    expect(policyAsks(none, { tool: "telegram.send", risk: "outbound", toOwner: false })).toEqual(["It sends to someone other than you."]);
    expect(policyAsks(readPolicy({ askFor: ["sheets.write"] }), { tool: "sheets.write", risk: "write", toOwner: true })).toEqual(["You asked to approve it every time it changes your own data."]);
    expect(policyAsks(none, { tool: "sheets.read", risk: "read", toOwner: true })).toEqual([]);
  });
});

describe("in a job", () => {
  const d = guarded();
  async function tools(policy: object) {
    const owner = await addUser(db, `risk.${Math.random().toString(36).slice(2, 8)}`);
    const inst = await installed(rt, owner, await publishedAgent(db, owner, { definition: d }));
    await db.update(schema.agentInstallations).set({ policy }).where(eq(schema.agentInstallations.id, inst.id));
    const fresh = (await db.select().from(schema.agentInstallations).where(eq(schema.agentInstallations.id, inst.id)))[0]!;
    return { inst: fresh, tools: new JobTools(rt, fresh, d, null) };
  }
  const writeOrders = d.steps.find((s) => s.id === "record")!;
  const say = d.steps.find((s) => s.id === "tell")!;
  const order = { sheet: "Orders", rows: [{ fabric: "Linen", metres: 10, supplier: "North Mill", total_cost_usdc: 40 }] };

  it("waits for a yes on any spend when the renter allows none on its own, with the reason", async () => {
    const { tools: t } = await tools({ autoSpendUsdc: 0 });
    const paused = await t.call(writeOrders, "sheets.write", order).catch((e: unknown) => e);
    expect(paused).toBeInstanceOf(Paused);
    expect((paused as Paused).ask).toMatchObject({ kind: "safety", tool: "sheets.write", reason: "It spends money, and you approve every spend.", choices: ["Yes", "No"] });
    expect((paused as Paused).ask.question).toMatch(/worth 40/);
    // A yes lets it through; a no stops it.
    await expect(t.call(writeOrders, "sheets.write", order, { answer: "No" })).rejects.toThrow("The owner said no.");
  });

  it("goes ahead within the auto limit, and asks for a raised tool every time", async () => {
    const { tools: t, inst } = await tools({ autoSpendUsdc: 100 });
    await expect(t.call(writeOrders, "sheets.write", order)).resolves.toMatchObject({ written: 1 });
    await expect(t.call(say, "telegram.send", { text: "Stock is fine." })).resolves.toEqual({ sent: true });
    const l = (await loadInstallation(rt, inst.id))!;
    await setPolicy(rt, l, { askFor: ["telegram.send", "sheets.read"], autoSpendUsdc: 100 });
    const raised = new JobTools(rt, (await loadInstallation(rt, inst.id))!.installation, d, null);
    const paused = (await raised.call(say, "telegram.send", { text: "Stock is fine." }).catch((e: unknown) => e)) as Paused;
    expect(paused.ask).toMatchObject({ kind: "safety", reason: "You asked to approve it every time it sends a message." });
    expect(paused.ask.question).toBe('Send you this message? "Stock is fine."');
    // Reads can't be raised: they never ask.
    expect((await loadInstallation(rt, inst.id))!.installation.policy).toEqual({ askFor: ["telegram.send"], autoSpendUsdc: 100 });
  });
});

describe("asking first, by default", () => {
  it("is on only for payments and messages to other people, never for messages to the owner's own Telegram or their own sheets", () => {
    const p = readPolicy({});
    expect(policyAsks(p, { tool: "telegram.send", risk: "outbound", toOwner: true })).toEqual([]);
    expect(policyAsks(p, { tool: "sheets.write", risk: "write", toOwner: false })).toEqual([]);
    expect(policyAsks(p, { tool: "wallet.pay", risk: "money", amount: 0.5, toOwner: false })).toEqual(["It spends money, and you approve every spend."]);
    expect(policyAsks(p, { tool: "telegram.send", risk: "outbound", toOwner: false })).toEqual(["It sends to someone other than you."]);
  });
});
