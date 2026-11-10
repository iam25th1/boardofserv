// @vitest-environment node
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import { addUser, testDb } from "@/test/helperDb";
import { installed, publishedAgent, readyToPay, restockDefinition, testRuntime, trusted, withPayments, type TestRuntime } from "@/test/runtimeFixtures";
import { enqueue } from "./runtime/jobs";
import { JobTools } from "./runtime/tools";
import { screenText } from "./screen";
import { vetVersion } from "./publish";
import { writeStep } from "./code";
import { platformBudget, platformRoom, platformSpentToday } from "./metering";
import { screenContent, SCREEN_DOWN } from "@/lib/safety/moderation";
import { adminSafety } from "@/lib/safety/admin";
import { servOnly } from "./build";
import { modelConfig } from "@/lib/model";

// Every SERV call is metered: the guard's checks, decisions and screening
// in runs against their installation's budget; boardofserv's own calls
// (code reviews, publish reviews, screening posts and outside runs) against
// the platform's daily budget, where past it they wait as when SERV can't
// answer. All of them are recorded for the site's daily limit, and the
// admin's model cost view shows them by what they were for.

let client: PGlite;
let db: PgliteDatabase<typeof schema>;
let rt: TestRuntime;
let maker: schema.User;
let recorded: string[];

const paying = () => {
  const d = restockDefinition();
  return {
    ...d,
    actions: [...d.actions, { id: "pay", tool: "wallet.pay" as const, description: "Pay the supplier" }],
    steps: [...d.steps, { id: "pay", kind: "action" as const, title: "Pay the supplier", inputs: [], outputs: [], action: "pay", next: null }],
  } as ReturnType<typeof restockDefinition>;
};

beforeAll(async () => {
  ({ client, db } = await testDb());
  maker = await addUser(db, "meter.maker", "meter_maker");
});
afterAll(async () => client.close());
beforeEach(async () => {
  rt = testRuntime(db);
  recorded = [];
  rt.record = async (_owner, _call, _ownKey, kind = "agent_decision") => void recorded.push(kind);
  await client.exec("delete from platform_model_usage; delete from agent_model_usage;");
});
afterEach(() => vi.unstubAllEnvs());

const platformRows = () => db.select().from(schema.platformModelUsage);

describe("calls in a run", () => {
  it("meter the guard's check against the installation, in tokens and cost, and record it for the site's limit", async () => {
    withPayments(rt);
    const inst = await installed(rt, maker, await publishedAgent(db, maker, { definition: paying() }));
    await readyToPay(rt, inst, { payees: ["Weftworks"], allowanceUsdc: 10 });
    await trusted(rt, inst.versionId, 800);
    const job = await enqueue(rt, inst, { kind: "manual" });
    const step = paying().steps.find((s) => s.id === "pay")!;
    await new JobTools(rt, inst, paying(), job).call(step, "wallet.pay", { to: "Weftworks", amountUsdc: 1 }, undefined, { inputs: {}, untrusted: [], callKey: "m1" });
    const [row] = await db.select().from(schema.agentModelUsage).where(eq(schema.agentModelUsage.installationId, inst.id));
    expect(row).toMatchObject({ purpose: "guard", promptTokens: 600, completionTokens: 25, jobId: job.id });
    expect(BigInt(row!.cost)).toBeGreaterThan(0n);
    expect(recorded).toContain("agent_guard");
    expect(await platformRows()).toEqual([]);
  });

  it("meter screening in a run against the installation, and outside one against the platform", async () => {
    const inst = await installed(rt, maker, await publishedAgent(db, maker));
    const scope = { installationId: inst.id, jobId: null, agentId: inst.agentId, ownerUserId: maker.id };
    await screenText(rt, maker, "Linen, 40 m in stock.", "a sheet", { scope, installation: inst });
    expect((await db.select().from(schema.agentModelUsage).where(eq(schema.agentModelUsage.installationId, inst.id))).map((r) => r.purpose)).toEqual(["screen"]);
    await screenText(rt, maker, "Cotton, 12 m in stock.", "a message");
    expect((await platformRows()).map((r) => [r.purpose, r.promptTokens, r.completionTokens, r.userId])).toEqual([["screen", 650, 40, maker.id]]);
    expect(recorded.filter((k) => k === "agent_screen")).toHaveLength(2);
  });
});

describe("boardofserv's own calls", () => {
  it("meter post screening and publish reviews against the platform's budget", async () => {
    await screenContent(rt, maker, "A restock helper for a fabric shop.", "a listing");
    const p = await publishedAgent(db, maker);
    await vetVersion(rt, maker, p.version);
    const rows = await platformRows();
    expect(rows.map((r) => r.purpose).sort()).toEqual(["post_screen", "publish_review"]);
    expect(rows.find((r) => r.purpose === "publish_review")).toMatchObject({ agentId: p.agent.id, userId: maker.id, promptTokens: 1500 });
    expect(recorded).toEqual(expect.arrayContaining(["agent_screen", "agent_vetting"]));
    expect(await platformSpentToday(rt.db, rt.now())).toBe(rows.reduce((t, r) => t + BigInt(r.cost), 0n));
  });

  it("ask SERV once more when a screen's answer comes back empty, and meter both tries", async () => {
    const real = rt.fetchImpl;
    let n = 0;
    rt.fetchImpl = (async (url: string, init: RequestInit) => {
      if (JSON.parse(String(init.body)).response_format.json_schema.name === "content_screen" && n++ === 0) return Response.json({ choices: [{ message: { content: "" } }] });
      return real!(url, init);
    }) as typeof fetch;
    expect(await screenContent(rt, maker, "A restock helper.", "a listing")).toEqual({ ok: true, reason: "" });
    // One call, tried twice inside the client: metered once, both tries' tokens.
    const screens = (await platformRows()).filter((r) => r.purpose === "post_screen");
    expect(screens).toHaveLength(1);
    expect(screens[0]).toMatchObject({ promptTokens: 500, completionTokens: 20 });
  });

  it("past the platform's daily budget, wait as when SERV can't answer, and make no call", async () => {
    vi.stubEnv("PLATFORM_MODEL_BUDGET_USDC", "0");
    expect(platformBudget()).toBe(0n);
    expect(await platformRoom(rt.db, false, rt.now())).toBe(false);
    // On a person's own key, the platform pays nothing: there is room.
    expect(await platformRoom(rt.db, true, rt.now())).toBe(true);
    rt.posts.length = 0;
    expect(await screenContent(rt, maker, "Another helper.", "a listing")).toEqual({ ok: false, reason: SCREEN_DOWN });
    expect(rt.posts).toEqual([]);
    const p = await publishedAgent(db, maker);
    const review = await vetVersion(rt, maker, p.version);
    expect(review).toMatchObject({ status: "unreviewed", by: "local" });
    const screened = await screenText(rt, maker, "Wool, 3 m in stock.", "a message");
    expect(screened.by).toBe("local");
    expect(await platformRows()).toEqual([]);
  });

  it("let a code review wait when the platform's budget has no room", async () => {
    const d = restockDefinition();
    const step = d.steps.find((s) => s.kind === "code")!;
    const recordedKinds: string[] = [];
    const entry = await writeStep(step as never, d, "spec", {
      dolphin: { id: "dolphin", label: "Dolphin", baseUrl: "https://dolphin.test", apiKey: "k", model: "m" } as never,
      serv: servOnly(modelConfig({ SERV_API_KEY: "test-serv" })),
      fetchImpl: (async () => Response.json({ choices: [{ message: { content: "```js\nasync function run(input) { return {}; }\n```" } }], usage: { prompt_tokens: 10, completion_tokens: 10 } })) as typeof fetch,
      hooks: { progress: async () => undefined, record: async (kind) => void recordedKinds.push(kind), reviewRoom: async () => false },
    });
    expect(entry.status).toBe("needs_attention");
    expect(entry.note).toBe("SERV couldn't review it just now.");
    expect(recordedKinds).not.toContain("agent_review");
  });
});

describe("the admin's model cost view", () => {
  it("shows every call by what it was for, and the platform's own spend today against its budget", async () => {
    await screenContent(rt, maker, "A helper for invoices.", "a listing");
    const inst = await installed(rt, maker, await publishedAgent(db, maker));
    await screenText(rt, maker, "Linen.", "a sheet", { scope: { installationId: inst.id, jobId: null, agentId: inst.agentId, ownerUserId: maker.id }, installation: inst });
    const a = await adminSafety(rt);
    expect(a.calls.map((c) => [c.by, c.purpose, c.calls])).toEqual(expect.arrayContaining([["agents", "screen", 1], ["boardofserv", "post_screen", 1]]));
    expect(a.calls.every((c) => BigInt(c.cost) > 0n && c.tokens > 0)).toBe(true);
    expect(BigInt(a.platform.today)).toBeGreaterThan(0n);
    expect(a.platform.budget).toBe("2000000");
  });
});
