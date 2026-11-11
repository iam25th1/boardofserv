// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { asc, eq } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import { addUser, testDb } from "@/test/helperDb";
import { planAnswer } from "@/test/planAnswers";
import { PRICE_SOURCES, PRICE_WIRE, priceBench } from "@/test/suiteFixtures";
import { jobFor } from "@/lib/agents/build";
import { draftOf } from "@/lib/agents/store";
import { keep } from "@/lib/connections/vault";
import { serverRuntime } from "@/lib/agents/runtime/context";
import type { AgentSummaryDTO } from "@/lib/types";
import * as agents from "./agents/route";
import * as fix from "./agents/[id]/fix/route";
import * as build from "./agents/[id]/build/route";
import * as golive from "./agents/[id]/golive/route";
import * as journeyRoute from "./conversations/[id]/journey/route";
import * as messagesRoute from "./conversations/[id]/messages/route";

// The journey in the chat through the real routes (agents/journey.ts):
// Make it works out the steps and stops for the maker; Change something
// changes them and says what changed; Looks right builds and tries them,
// each stage a card in the conversation; a failed test is fixed from what
// the maker says, and a change to what they set stops to ask; Connect saves
// what it needs; Run it for me puts it to work. SERV and Dolphin are
// mocked by URL, answering as the price watcher's plan.

process.env.OPENSERV_KEY_ENC_KEY ||= randomBytes(32).toString("base64");

const state = vi.hoisted(() => ({ db: null as unknown, user: null as unknown }));
vi.mock("@/lib/db", () => ({ db: new Proxy({}, { get: (_, key) => Reflect.get(state.db as object, key) }) }));
vi.mock("@/lib/auth-route", () => ({ getUserFromRequest: async () => state.user }));

let client: PGlite;
let db: PgliteDatabase<typeof schema>;
let maker: schema.User;
// The plans SERV answers with, one per outline asked for.
let plans: Record<string, unknown>[] = [];
let planning: Record<string, unknown> = PRICE_WIRE;
// Code for a step, by its title: the price watcher's, or what a test sets.
let sources: Record<string, string> = {};
const seen: string[] = [];

const sourceFor = (ask: string) => {
  const title = /^Step: (.+)$/m.exec(ask)?.[1] ?? "";
  const step = (PRICE_WIRE.steps as { id: string; title: string }[]).find((s) => s.title === title);
  return sources[title] ?? (step ? PRICE_SOURCES[step.id] : undefined) ?? "async function run() { return {}; }";
};

beforeAll(async () => {
  ({ client, db } = await testDb());
  state.db = db;
  maker = await addUser(db, "maker");
  vi.stubEnv("SERV_API_KEY", "test-serv");
  vi.stubEnv("DOLPHIN_API_KEY", "test-dolphin");
  vi.stubEnv("FALLBACK_API_KEY", "");
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    if (url.includes("dphn.ai")) {
      seen.push("dolphin");
      return Response.json({ choices: [{ message: { content: "```js\n" + sourceFor(body.messages[1].content) + "\n```" } }], usage: { prompt_tokens: 300, completion_tokens: 120 } });
    }
    const name = body.response_format?.json_schema?.name as string;
    seen.push(name);
    if (name === "agent_sample") {
      const b = priceBench();
      const sample = { noun: "product", plural: "products", labels: ["Stone Kettle"], settings: Object.entries(b.settings).map(([key, value]) => ({ key, value: String(value) })), sheets: [], pages: Object.entries(b.pages).map(([url, text]) => ({ url, text })), searches: [], answers: ["Yes"], steps: [] };
      return Response.json({ choices: [{ message: { content: JSON.stringify(sample) } }], usage: { prompt_tokens: 900, completion_tokens: 200 } });
    }
    if (name === "agent_outline") planning = plans.shift() ?? PRICE_WIRE;
    const planned = planAnswer(planning, body);
    if (planned) return Response.json({ choices: [{ message: { content: JSON.stringify(planned) } }], usage: { prompt_tokens: 1500, completion_tokens: 900 } });
    if (name === "code_review") return Response.json({ choices: [{ message: { content: JSON.stringify({ verdict: "approve", reason: "Does what the step says." }) } }], usage: { prompt_tokens: 500, completion_tokens: 20 } });
    if (name === "version_review") return Response.json({ choices: [{ message: { content: JSON.stringify({ findings: [] }) } }], usage: { prompt_tokens: 2000, completion_tokens: 20 } });
    return Response.json({ choices: [{ message: { content: "{}" } }] });
  });
});

beforeEach(() => {
  state.user = maker;
  plans = [];
  sources = {};
  seen.length = 0;
});

afterAll(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await client.close();
});

const json = (url: string, method = "GET", body?: unknown) => new Request(`http://localhost${url}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
const at = (id: string) => ({ params: Promise.resolve({ id }) });

// A conversation where the maker described the price watcher.
async function described(): Promise<string> {
  const [convo] = await db.insert(schema.conversations).values({ userId: maker.id, title: "Price watcher" }).returning();
  await db.insert(schema.messages).values([
    { conversationId: convo!.id, role: "user", content: "Every day, check a product page I give you and read its price. If the price is below a target I set, ask me on Telegram whether I want a reminder to buy it, and only send the reminder if I say yes." },
    { conversationId: convo!.id, role: "assistant", content: "Every day it reads the price on your page and, when it is below your target, asks you on Telegram before sending a reminder." },
  ]);
  await db.insert(schema.agentSketches).values({ conversationId: convo!.id, name: "Price watcher", kind: "agent", wakes: "every day", looks: "a product page I give it", handles: "below my target, asks me on Telegram whether to send a reminder" });
  return convo!.id;
}

async function conversation(id: string) {
  return (await (await messagesRoute.GET(json(`/api/conversations/${id}/messages`), at(id))).json()) as { messages: { role: string; content: string; card?: { stage: string; snapshot?: Record<string, unknown>; answers?: unknown; live?: Record<string, unknown> } | null }[]; agent: AgentSummaryDTO | null };
}
const stages = (c: Awaited<ReturnType<typeof conversation>>) => c.messages.flatMap((m) => (m.card ? [m.card.stage] : []));

async function madeIt(conversationId: string): Promise<string> {
  const res = await agents.POST(json("/api/agents", "POST", { conversationId, review: true }));
  expect(res.status).toBe(202);
  const id = ((await res.json()) as { agent: AgentSummaryDTO }).agent.id;
  await jobFor((await draftOf(id))!.id);
  return id;
}

describe("the journey in the chat", () => {
  it("works out the steps and stops for the maker, changes them on their word, then builds and tries them, a card a stage", async () => {
    const cid = await described();
    const id = await madeIt(cid);
    // Make it planned and stopped: nothing written, nothing tried.
    let c = await conversation(cid);
    expect(stages(c)).toEqual(["steps"]);
    expect(seen).toEqual(["agent_outline", "agent_steps", "agent_steps"]);
    expect(c.agent).toMatchObject({ buildState: "idle", test: null });
    expect(c.agent!.plain!.map((l) => l.text)).toEqual(["Read the price", "At or below your target? If above the target, it stops there.", "Write the question", "Ask you whether to send a reminder to buy it", "Did you say yes? If no, it stops there.", "Write the reminder", "Send you the reminder to buy it"]);
    expect(c.messages.at(-1)!.content).toMatch(/^The steps:\n1\. Read the price\n/);

    // Change something: the steps change and the chat says what changed.
    plans = [{ ...PRICE_WIRE, steps: PRICE_WIRE.steps.map((s) => (s.id === "make_reminder" ? { ...s, title: "Write the reminder, with the price" } : s)) }];
    seen.length = 0;
    expect((await fix.POST(json(`/api/agents/${id}/fix`, "POST", { message: "Put the price in the reminder", journey: "change" }), at(id))).status).toBe(202);
    await jobFor((await draftOf(id))!.id);
    c = await conversation(cid);
    expect(stages(c)).toEqual(["steps"]);
    expect(c.messages.slice(-2).map((m) => [m.role, m.content])).toEqual([
      ["user", "Put the price in the reminder"],
      ["assistant", 'I changed the steps. New or changed: "Write the reminder, with the price". Gone: "Write the reminder".'],
    ]);
    expect(seen).not.toContain("dolphin");

    // Looks right: built step by step, tried, and on to Connect.
    sources = { "Write the reminder, with the price": PRICE_SOURCES.make_reminder! };
    seen.length = 0;
    expect((await build.POST(json(`/api/agents/${id}/build`, "POST"), at(id))).status).toBe(202);
    await jobFor((await draftOf(id))!.id);
    c = await conversation(cid);
    expect(stages(c)).toEqual(["steps", "build", "try", "connect"]);
    expect(seen.filter((x) => x === "dolphin")).toHaveLength(3);
    expect(c.agent!.test).toMatchObject({ status: "passed" });
    expect(c.agent!.test!.story).toMatch(/^Passed\. It read the page, asked you on Telegram ".+" \(you answered "Yes"\) and sent you "Reminder: buy it now at 42\. .+" on Telegram\.$/);
    // Each card past keeps what it showed.
    const card = (stage: string) => c.messages.find((m) => m.card?.stage === stage)!.card!;
    expect(card("steps").snapshot!.lines).toHaveLength(7);
    expect(card("build").snapshot).toMatchObject({ note: "Built and checked" });
    expect(card("try").snapshot).toMatchObject({ status: "passed" });

    // Connect: the answers, the maker's own given ones among them; then Go live.
    const telegram = await keep(serverRuntime(), maker.id, "telegram", "@maker", { chatId: 42, userId: 42 });
    void telegram;
    const bad = await journeyRoute.POST(json(`/api/conversations/${cid}/journey`, "POST", { action: "connect", answers: { settings: { product_url: "", target_price: "fifty" }, rules: {}, timezone: "UTC" } }), at(cid));
    expect(bad.status).toBe(400);
    expect(Object.keys(((await bad.json()) as { errors: Record<string, string> }).errors).sort()).toEqual(["product_url", "target_price"]);
    const ok = await journeyRoute.POST(json(`/api/conversations/${cid}/journey`, "POST", { action: "connect", answers: { settings: { product_url: "https://shop.example/kettle", target_price: "50" }, rules: {}, timezone: "Europe/London" } }), at(cid));
    expect(ok.status).toBe(200);
    c = await conversation(cid);
    expect(stages(c)).toEqual(["steps", "build", "try", "connect", "live"]);
    expect(card("connect")).toBeTruthy();

    // Run it for me: published with its review, and running for the maker.
    const ran = await golive.POST(json(`/api/agents/${id}/golive`, "POST", { how: "run" }), at(id));
    const body = (await ran.json()) as { installation?: { status: string; runs: string[]; nextRunAt: string | null }; error?: string };
    expect(ran.status, body.error).toBe(200);
    expect(body.installation).toMatchObject({ status: "active" });
    expect(body.installation!.nextRunAt).not.toBeNull();
    c = await conversation(cid);
    expect(c.messages.at(-1)!.card!.live).toMatchObject({ installationId: expect.any(String) });
    expect((await golive.POST(json(`/api/agents/${id}/golive`, "POST", { how: "run" }), at(id))).status).toBe(409);
  });

  it("puts a failed test right from what the maker says, building and trying again on its own", async () => {
    const cid = await described();
    // The reminder's code breaks on the sample: the test fails there.
    sources = { "Write the reminder": "async function run() { throw new Error('no price'); }" };
    const id = await madeIt(cid);
    await build.POST(json(`/api/agents/${id}/build`, "POST"), at(id));
    await jobFor((await draftOf(id))!.id);
    let c = await conversation(cid);
    expect(stages(c)).toEqual(["steps", "build", "try"]);
    expect(c.agent!.test).toMatchObject({ status: "failed" });
    expect(c.agent!.problem!.text).toBe('"Write the reminder" didn\'t work on the sample product.');

    // The maker says what's wrong; the step is planned again, written again
    // (the others keep their code) and tried again.
    sources = {};
    plans = [{ ...PRICE_WIRE, steps: PRICE_WIRE.steps.map((s) => (s.id === "make_reminder" ? { ...s, description: `${s.description} Use the price read from the page.` } : s)) }];
    seen.length = 0;
    expect((await fix.POST(json(`/api/agents/${id}/fix`, "POST", { message: "The reminder should use the price it read", journey: "fix" }), at(id))).status).toBe(202);
    await jobFor((await draftOf(id))!.id);
    c = await conversation(cid);
    expect(stages(c)).toEqual(["steps", "build", "try", "steps", "build", "try", "connect"]);
    expect(seen.filter((x) => x === "dolphin")).toHaveLength(1);
    expect(c.agent!.test).toMatchObject({ status: "passed" });
    // The failed test stays in the story as it was.
    expect(c.messages.filter((m) => m.card?.stage === "try")[0]!.card!.snapshot).toMatchObject({ status: "failed" });
  });

  it("stops at the steps to ask when a change touches what the maker set", async () => {
    const cid = await described();
    sources = { "Write the reminder": "async function run() { throw new Error('no price'); }" };
    const id = await madeIt(cid);
    await build.POST(json(`/api/agents/${id}/build`, "POST"), at(id));
    await jobFor((await draftOf(id))!.id);
    // SERV's fix moves the time it runs: that is the maker's to say.
    plans = [{ ...PRICE_WIRE, triggers: [{ ...PRICE_WIRE.triggers[0]!, at: "07:00", description: "Every day at 7:00" }] }];
    seen.length = 0;
    await fix.POST(json(`/api/agents/${id}/fix`, "POST", { message: "Fix the reminder", journey: "fix" }), at(id));
    await jobFor((await draftOf(id))!.id);
    const c = await conversation(cid);
    expect(stages(c)).toEqual(["steps", "build", "try", "steps"]);
    expect(seen).not.toContain("dolphin");
    expect(c.messages.at(-1)!.content).toContain("It now runs every day at 7:00, not every day at 9:00.");
    expect(c.messages.at(-1)!.content).toContain("That changes something you set: if it's right, press Looks right; if not, say what it should be.");
  });

  it("never makes it before the job is clear, or for anyone else", async () => {
    const [convo] = await db.insert(schema.conversations).values({ userId: maker.id, title: "Half" }).returning();
    await db.insert(schema.agentSketches).values({ conversationId: convo!.id, name: "Half", kind: "agent", wakes: "every day" });
    expect((await agents.POST(json("/api/agents", "POST", { conversationId: convo!.id, review: true }))).status).toBe(400);
    const cid = await described();
    state.user = await addUser(db, "someone");
    expect((await agents.POST(json("/api/agents", "POST", { conversationId: cid, review: true }))).status).toBe(404);
    const rows = await db.select().from(schema.messages).where(eq(schema.messages.conversationId, cid)).orderBy(asc(schema.messages.createdAt));
    expect(rows.some((m) => m.card)).toBe(false);
  });
});
