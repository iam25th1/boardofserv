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
// What the fixer answers, one a round ("{}" when none is left), and what
// Dolphin was asked.
let fixes: object[] = [];
const asked: string[] = [];
// Code the review turns down: any whose step's brief says one of these.
let rejecting: string[] = [];

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
      const ask = body.messages[1].content as string;
      asked.push(ask);
      // Written again with what went wrong beside it: the step's own code.
      const healed = ask.includes("An earlier version of this step didn't pass") ? PRICE_SOURCES[(PRICE_WIRE.steps as { id: string; title: string }[]).find((x) => x.title === /^Step: (.+)$/m.exec(ask)?.[1])?.id ?? ""] : undefined;
      return Response.json({ choices: [{ message: { content: "```js\n" + (healed ?? sourceFor(ask)) + "\n```" } }], usage: { prompt_tokens: 300, completion_tokens: 120 } });
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
    if (name === "code_review") {
      const said = String(body.messages[1].content);
      const verdict = rejecting.some((r) => said.includes(r)) ? { verdict: "reject", reason: "It reads input.skip, which the step never gives it." } : { verdict: "approve", reason: "Does what the step says." };
      return Response.json({ choices: [{ message: { content: JSON.stringify(verdict) } }], usage: { prompt_tokens: 500, completion_tokens: 20 } });
    }
    if (name === "agent_fix") return Response.json({ choices: [{ message: { content: JSON.stringify(fixes.shift() ?? {}) } }], usage: { prompt_tokens: 3000, completion_tokens: 200 } });
    if (name === "version_review") return Response.json({ choices: [{ message: { content: JSON.stringify({ findings: [] }) } }], usage: { prompt_tokens: 2000, completion_tokens: 20 } });
    return Response.json({ choices: [{ message: { content: "{}" } }] });
  });
});

beforeEach(() => {
  state.user = maker;
  plans = [];
  sources = {};
  seen.length = 0;
  fixes = [];
  asked.length = 0;
  rejecting = [];
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

  it("keeps Run it for me and Put it on the board apart: neither does the other", async () => {
    const cid = await described();
    const id = await madeIt(cid);
    await build.POST(json(`/api/agents/${id}/build`, "POST"), at(id));
    await jobFor((await draftOf(id))!.id);
    await keep(serverRuntime(), maker.id, "telegram", "@maker", { chatId: 42, userId: 42 }).catch(() => undefined);
    const ok = await journeyRoute.POST(json(`/api/conversations/${cid}/journey`, "POST", { action: "connect", answers: { settings: { product_url: "https://shop.example/kettle", target_price: "50" }, rules: {}, timezone: "Europe/London" } }), at(cid));
    expect(ok.status).toBe(200);
    const installs = async () => (await db.select().from(schema.agentInstallations).where(eq(schema.agentInstallations.agentId, id))).length;
    const listed = async () => (await db.select().from(schema.agentListings).where(eq(schema.agentListings.agentId, id))).filter((l) => l.listed).length;
    // On the board: listed, and not running for the maker.
    const board = await golive.POST(json(`/api/agents/${id}/golive`, "POST", { how: "board", weeklyPrice: "0", description: "Watches a price for you." }), at(id));
    expect(board.status, await board.clone().text()).toBe(200);
    expect(await listed()).toBe(1);
    expect(await installs()).toBe(0);
    // Running for the maker: an installation in their time zone, and the
    // listing as it was.
    const ran = await golive.POST(json(`/api/agents/${id}/golive`, "POST", { how: "run" }), at(id));
    expect(ran.status).toBe(200);
    expect(await installs()).toBe(1);
    expect(await listed()).toBe(1);
    const [inst] = await db.select().from(schema.agentInstallations).where(eq(schema.agentInstallations.agentId, id));
    expect(inst!.timezone).toBe("Europe/London");
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

describe("a build that heals itself, in the chat", () => {
  const BROKEN = "async function run() { throw new Error('no price'); }";
  const userSaid = (c: Awaited<ReturnType<typeof conversation>>) => c.messages.filter((m) => m.role === "user").map((m) => m.content);

  it("writes a step again from the fixer's corrected brief, with the reason beside it, and goes on to Connect with nothing typed", async () => {
    const cid = await described();
    sources = { "Write the reminder": BROKEN };
    fixes = [{ verdict: "code_wrong", step: "make_reminder", why: "The reminder's code throws instead of using the price it was given.", spec: "Make the reminder from price and settings.product_url: return reminder as { text } with the price and the link.", change: "", sample: "", question: "", choices: [], lesson: "Code uses the values it is given instead of throwing.", kind: "other" }];
    const id = await madeIt(cid);
    await build.POST(json(`/api/agents/${id}/build`, "POST"), at(id));
    await jobFor((await draftOf(id))!.id);
    const c = await conversation(cid);
    // One Try it card: the test after the repair stays on it.
    expect(stages(c)).toEqual(["steps", "build", "try", "connect"]);
    expect(c.agent!.test).toMatchObject({ status: "passed" });
    expect(c.agent!.heal!.lines).toEqual([
      { text: "Found a problem in step 6 while trying it. Fixing it.", tone: "working" },
      { text: "Writing step 6 again.", tone: "working" },
      { text: "Fixed.", tone: "fixed" },
    ]);
    // Dolphin wrote it from the corrected brief, told what went wrong.
    const again = asked.find((a) => a.includes("An earlier version of this step didn't pass"))!;
    expect(again).toContain("What it must do: Make the reminder from price and settings.product_url");
    expect(again).toContain('An earlier version of this step didn\'t pass: "Write the reminder" didn\'t work on the sample product.');
    // Nothing for the maker to read or type.
    expect(userSaid(c)).toEqual([expect.stringMatching(/^Every day, check a product page/)]);
    expect(c.agent!.problem).toBeNull();
  });

  it("asks one plain question with answers to tap when only the maker can say, and goes on with the answer", async () => {
    const cid = await described();
    sources = { "Write the reminder": BROKEN };
    fixes = [{ verdict: "unclear", step: "", why: "Only the maker knows how they want to be reminded.", spec: "", change: "", sample: "", question: "Should the reminder include the link to the product?", choices: ["Yes, include the link", "No, just the price"], lesson: "", kind: "setup" }];
    const id = await madeIt(cid);
    await build.POST(json(`/api/agents/${id}/build`, "POST"), at(id));
    await jobFor((await draftOf(id))!.id);
    let c = await conversation(cid);
    expect(c.messages.at(-1)).toMatchObject({ role: "assistant", content: "Should the reminder include the link to the product?" });
    expect(c.agent!.heal!.question).toMatchObject({ text: "Should the reminder include the link to the product?", choices: ["Yes, include the link", "No, just the price"], messageId: expect.any(String) });
    expect(c.agent!.heal!.lines.at(-1)).toEqual({ text: "I need to ask you one thing.", tone: "asked" });
    expect(c.agent!.buildState).toBe("idle");

    // The maker taps an answer: the steps change with it, and the build goes on.
    sources = {};
    plans = [{ ...PRICE_WIRE, steps: PRICE_WIRE.steps.map((s) => (s.id === "make_reminder" ? { ...s, description: `${s.description} Include the link to the product.` } : s)) }];
    seen.length = 0;
    const res = await journeyRoute.POST(json(`/api/conversations/${cid}/journey`, "POST", { action: "answer", answer: "Yes, include the link" }), at(cid));
    expect(res.status).toBe(202);
    await jobFor((await draftOf(id))!.id);
    c = await conversation(cid);
    expect(userSaid(c).at(-1)).toBe("Yes, include the link");
    const outline = seen.indexOf("agent_outline");
    expect(outline).toBeGreaterThanOrEqual(0);
    expect(c.agent!.heal!.question).toBeNull();
    expect(c.agent!.test).toMatchObject({ status: "passed" });
    expect(stages(c).at(-1)).toBe("connect");
    // Asked again, with no question waiting, it says so.
    expect((await journeyRoute.POST(json(`/api/conversations/${cid}/journey`, "POST", { action: "answer", answer: "Yes" }), at(cid))).status).toBe(409);
  });

  it("gives up in one plain sentence after its rounds, and a simpler version is a choice, never a fix box", async () => {
    const cid = await described();
    sources = { "Write the reminder": BROKEN };
    const sample = { verdict: "test_wrong", step: "", why: "The sample has no price.", spec: "", change: "", sample: "A page with a price on it.", question: "", choices: [], lesson: "", kind: "sample_items" };
    fixes = [sample, sample, sample];
    const id = await madeIt(cid);
    await build.POST(json(`/api/agents/${id}/build`, "POST"), at(id));
    await jobFor((await draftOf(id))!.id);
    let c = await conversation(cid);
    expect(seen.filter((x) => x === "agent_fix")).toHaveLength(3);
    expect(seen.filter((x) => x === "agent_sample")).toHaveLength(4);
    expect(c.agent!.heal!.gaveUp).toBe('I couldn\'t get step 6, "Write the reminder", to work on its sample.');
    expect(c.agent!.buildState).toBe("idle");

    plans = [PRICE_WIRE];
    seen.length = 0;
    const res = await journeyRoute.POST(json(`/api/conversations/${cid}/journey`, "POST", { action: "simpler" }), at(cid));
    expect(res.status).toBe(202);
    await jobFor((await draftOf(id))!.id);
    c = await conversation(cid);
    expect(c.messages.some((m) => m.role === "assistant" && m.content === "Making a simpler version of it.")).toBe(true);
    expect(stages(c).at(-1)).toBe("steps");
    expect(seen[0]).toBe("agent_outline");
  });
});

describe("what a repair can never trade away", () => {
  const BROKEN = "async function run() { throw new Error('no price'); }";

  it("turns down a change to the steps that would send without the maker's yes, keeping the steps as they were", async () => {
    const cid = await described();
    sources = { "Write the reminder": BROKEN };
    // The fixer would take the question out: the reminder would go straight out.
    const noQuestion = { ...PRICE_WIRE, steps: PRICE_WIRE.steps.filter((s) => !["make_question", "ask", "said_yes"].includes(s.id)).map((s) => (s.id === "is_low" ? { ...s, outcomes: [{ id: "low", label: "At or below the target", next: "make_reminder" }, { id: "not_low", label: "Above the target", next: "" }] } : s)) };
    fixes = [{ verdict: "plan_wrong", step: "", why: "Too many steps.", spec: "", change: "Remove make_question, ask and said_yes.", sample: "", question: "", choices: [], lesson: "", kind: "extra_question" }];
    const id = await madeIt(cid);
    plans = [noQuestion];
    await build.POST(json(`/api/agents/${id}/build`, "POST"), at(id));
    await jobFor((await draftOf(id))!.id);
    const draft = (await draftOf(id))!;
    // The question is still there, and nothing of the change was kept.
    expect(draft.definition!.steps.map((s) => s.id)).toContain("ask");
    expect(draft.heal!.rounds.find((r) => r.outcome === "rejected")).toMatchObject({ verdict: "plan", rejected: "It would send you messages without your yes first, which it waited for before." });
    const c = await conversation(cid);
    expect(c.agent!.heal!.lines.map((l) => l.text)).toContain("Trying another way.");
  });

  it("never lets rewritten code skip the code review: code the review turns down never runs", async () => {
    const cid = await described();
    sources = { "Write the reminder": BROKEN };
    const spec = { verdict: "code_wrong", step: "make_reminder", why: "It throws.", spec: "Return reminder as { text } from price.", change: "", sample: "", question: "", choices: [], lesson: "", kind: "other" };
    fixes = [spec];
    // The review turns down every version written from the new brief.
    rejecting = ["Return reminder as { text } from price."];
    const id = await madeIt(cid);
    await build.POST(json(`/api/agents/${id}/build`, "POST"), at(id));
    await jobFor((await draftOf(id))!.id);
    const draft = (await draftOf(id))!;
    expect(draft.code.make_reminder!.status).toBe("needs_attention");
    // The test never ran on code that wasn't approved: the last test is
    // the one before the repair.
    expect(draft.testResult!.problems[0]!.text).toBe('"Write the reminder" didn\'t work on the sample product.');
    expect(draft.heal!.rounds.map((r) => r.diagnosis.stage)).toEqual(["test", "code"]);
  });
});
