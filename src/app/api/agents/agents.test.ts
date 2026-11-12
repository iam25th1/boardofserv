// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import { addUser, testDb } from "@/test/helperDb";
import { COMPARE_PLANNED as COMPARE, FIND_LOW, RESTOCK_PLANNED as RESTOCK_WIRE, restockBench } from "@/test/agentFixtures";
import { planAnswer } from "@/test/planAnswers";
import { jobFor } from "@/lib/agents/build";
import { draftOf } from "@/lib/agents/store";
import type { AgentBuilderDTO, AgentSummaryDTO } from "@/lib/types";
import * as agents from "./route";
import * as agent from "./[id]/route";
import * as run from "./[id]/run/route";
import * as fix from "./[id]/fix/route";
import * as bench from "./[id]/bench/route";
import * as publish from "./[id]/publish/route";
import * as testRoute from "./[id]/test/route";
import * as messagesRoute from "../conversations/[id]/messages/route";

// Building an agent through the real routes, on the real migrations: SERV
// plans and reviews, Dolphin writes, both mocked by URL; the build runs in
// the background and the test waits for it.

const state = vi.hoisted(() => ({ db: null as unknown, user: null as unknown }));
vi.mock("@/lib/db", () => ({ db: new Proxy({}, { get: (_, key) => Reflect.get(state.db as object, key) }) }));
vi.mock("@/lib/auth-route", () => ({ getUserFromRequest: async () => state.user }));

let client: PGlite;
let db: PgliteDatabase<typeof schema>;
let ana: schema.User;
let ben: schema.User;
let plans: object[] = [];
// What the fixer answers, one a round ("{}" when none is left).
let fixes: object[] = [];
let planning: Record<string, unknown> = RESTOCK_WIRE;
// What SERV's version review finds ("down" for no answer).
let review: { step: string; severity: string; finding: string }[] | "down" = [];
const seen: { to: "serv" | "dolphin"; schema?: string; body: { messages: { role: string; content: string }[] } }[] = [];

beforeAll(async () => {
  ({ client, db } = await testDb());
  state.db = db;
  ana = await addUser(db, "ana");
  ben = await addUser(db, "ben");
  vi.stubEnv("SERV_API_KEY", "test-serv");
  vi.stubEnv("DOLPHIN_API_KEY", "test-dolphin");
  vi.stubEnv("FALLBACK_API_KEY", "");
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    if (url.includes("dphn.ai")) {
      seen.push({ to: "dolphin", body });
      const ask = body.messages[1].content as string;
      const src = ask.includes("Step: Find low stock") ? FIND_LOW : COMPARE;
      return Response.json({ choices: [{ message: { content: "```js\n" + src + "\n```" } }], usage: { prompt_tokens: 300, completion_tokens: 120 } });
    }
    // SERV writing a step's code itself ("Fix this" on a step on hold).
    if (!body.response_format && String(body.messages[0]?.content).startsWith("You write one JavaScript function")) {
      seen.push({ to: "serv", schema: "code", body });
      const src = String(body.messages[1].content).includes("Step: Find low stock") ? FIND_LOW : COMPARE;
      return Response.json({ choices: [{ message: { content: "```js\n" + src + "\n```" } }], usage: { prompt_tokens: 300, completion_tokens: 120 } });
    }
    const name = body.response_format?.json_schema?.name as string;
    seen.push({ to: "serv", schema: name, body });
    // Sample data for a test, made from the plan: the restock bench, as
    // SERV's flat lists.
    if (name === "agent_sample") {
      const b = restockBench();
      const sample = {
        noun: "fabric",
        plural: "fabrics",
        labels: b.sheets.Stock!.map((r) => String(r.fabric)),
        settings: Object.entries(b.settings).map(([key, value]) => ({ key, value: String(value) })),
        sheets: Object.entries(b.sheets).map(([sheet, rows]) => ({ sheet, columns: Object.keys(rows[0] ?? { fabric: "" }), rows: rows.map((r) => ({ cells: Object.values(r).map(String) })) })),
        pages: [],
        searches: [],
        answers: b.telegram.answers,
      };
      return Response.json({ choices: [{ message: { content: JSON.stringify(sample) } }], usage: { prompt_tokens: 900, completion_tokens: 400 } });
    }
    // A plan comes in two stages: each outline takes the next plan from
    // the list, and its steps' details come from that plan.
    if (name === "agent_outline") planning = (plans.shift() as Record<string, unknown> | undefined) ?? RESTOCK_WIRE;
    const planned = planAnswer(planning, body);
    if (planned) return Response.json({ choices: [{ message: { content: JSON.stringify(planned) } }], usage: { prompt_tokens: 1500, completion_tokens: 1100 } });
    if (name === "code_review") return Response.json({ choices: [{ message: { content: JSON.stringify({ verdict: "approve", reason: "Does what the step says." }) } }], usage: { prompt_tokens: 500, completion_tokens: 20 } });
    if (name === "version_review") {
      if (review === "down") return new Response("{}", { status: 503 });
      return Response.json({ choices: [{ message: { content: JSON.stringify({ findings: review }) } }], usage: { prompt_tokens: 2200, completion_tokens: 60 } });
    }
    if (name === "agent_fix") return Response.json({ choices: [{ message: { content: JSON.stringify(fixes.shift() ?? {}) } }], usage: { prompt_tokens: 3000, completion_tokens: 200 } });
    if (name === "decision") {
      const ids = body.response_format.json_schema.schema.properties.outcome.enum as string[];
      return Response.json({ choices: [{ message: { content: JSON.stringify({ outcome: ids.includes("within") ? "within" : ids[0], reason: "Under the limit." }) } }], usage: { prompt_tokens: 400, completion_tokens: 15 } });
    }
    return Response.json({ choices: [{ message: { content: "{}" } }] });
  });
});

beforeEach(() => {
  state.user = ana;
  seen.length = 0;
  plans = [];
  fixes = [];
  vi.stubEnv("INVITE_ONLY", "");
  vi.stubEnv("DAILY_SPEND_LIMIT_USD", "");
});

afterAll(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await client.close();
});

const json = (url: string, method = "GET", body?: unknown) =>
  new Request(`http://localhost${url}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

async function interviewed(user: schema.User, done = true): Promise<string> {
  const [convo] = await db.insert(schema.conversations).values({ userId: user.id, title: "Restock" }).returning();
  await db.insert(schema.messages).values([
    { conversationId: convo!.id, role: "user", content: "Every morning check my fabric stock and reorder what's low." },
    { conversationId: convo!.id, role: "assistant", content: "What must it never do without asking you?" },
    { conversationId: convo!.id, role: "user", content: "Place an order over 250 USDC." },
  ]);
  await db.insert(schema.agentSketches).values({
    conversationId: convo!.id,
    name: "Fabric restock",
    kind: "agent",
    wakes: "every morning at eight",
    looks: "the Stock sheet and three suppliers",
    // What it does with what it finds is the last thing the chat needs.
    handles: done ? "orders what is low from the best supplier" : null,
    finish: "every low fabric has an order",
    // What it asks first is kept when said; what it sets up and remembers
    // the chat never asks at all.
    asks: "orders over 250 USDC",
    setup: null,
    remembers: null,
  });
  return convo!.id;
}

async function built(): Promise<{ id: string; conversationId: string }> {
  const conversationId = await interviewed(ana);
  const res = await agents.POST(json("/api/agents", "POST", { conversationId }));
  expect(res.status).toBe(202);
  const { agent: a } = (await res.json()) as { agent: AgentSummaryDTO };
  const draft = await draftOf(a.id);
  await jobFor(draft!.id);
  return { id: a.id, conversationId };
}

const builderOf = async (id: string) => ((await (await agent.GET(json(`/api/agents/${id}?view=builder`), { params: Promise.resolve({ id }) })).json()) as { builder: AgentBuilderDTO }).builder;

async function events(res: Response) {
  return (await res.text())
    .split("\n\n")
    .filter(Boolean)
    .map((f) => JSON.parse(/data: (.*)/.exec(f)![1]!) as { type: string; stepId?: string; status?: string; outcome?: string | null; reason?: string });
}

describe("planning an agent from its conversation", () => {
  it("plans with SERV, writes each code step with Dolphin and has SERV review it, in the background", async () => {
    const conversationId = await interviewed(ana);
    const res = await agents.POST(json("/api/agents", "POST", { conversationId }));
    expect(res.status).toBe(202);
    const { agent: first } = (await res.json()) as { agent: AgentSummaryDTO };
    expect(first).toMatchObject({ version: 1, state: "draft", buildState: "planning", steps: [] });

    await jobFor((await draftOf(first.id))!.id);
    const after = ((await (await agent.GET(json(`/api/agents/${first.id}`), { params: Promise.resolve({ id: first.id }) })).json()) as { agent: AgentSummaryDTO }).agent;
    expect(after.buildState).toBe("idle");
    expect(after.steps.map((s) => [s.id, s.kind, s.code])).toEqual([
      ["find_low", "code", "approved"],
      ["compare", "code", "approved"],
      ["check_total", "decision", null],
      ["ask_owner", "action", null],
      ["approved", "decision", null],
      ["record", "action", null],
    ]);
    // SERV planned and reviewed; Dolphin only wrote code. Then SERV made the
    // sample data for the plan's self test, which runs dry.
    expect(seen.map((s) => (s.to === "serv" ? s.schema : s.to))).toEqual(["agent_outline", "agent_steps", "dolphin", "code_review", "dolphin", "code_review", "agent_sample"]);
    // The conversation shows the agent beside its sketch.
    const convo = await (await messagesRoute.GET(json(`/api/conversations/${conversationId}/messages`), { params: Promise.resolve({ id: conversationId }) })).json();
    expect(convo.agent).toMatchObject({ id: first.id, buildState: "idle" });
    // Every model call is in the usage records.
    const usage = await db.select({ kind: schema.replyUsage.kind, provider: schema.replyUsage.provider }).from(schema.replyUsage).where(eq(schema.replyUsage.userId, ana.id));
    expect(usage.map((u) => `${u.kind}/${u.provider}`).sort()).toEqual(["agent_code/dolphin", "agent_code/dolphin", "agent_plan/serv", "agent_plan/serv", "agent_plan/serv", "agent_review/serv", "agent_review/serv"]);
  });

  it("refuses an interview that isn't finished, someone else's conversation, and planning twice at once", async () => {
    expect((await agents.POST(json("/api/agents", "POST", { conversationId: await interviewed(ana, false) }))).status).toBe(400);
    state.user = ben;
    expect((await agents.POST(json("/api/agents", "POST", { conversationId: await interviewed(ana) }))).status).toBe(404);
    state.user = ana;
    const conversationId = await interviewed(ana);
    const one = await agents.POST(json("/api/agents", "POST", { conversationId }));
    const two = await agents.POST(json("/api/agents", "POST", { conversationId }));
    expect([one.status, two.status]).toEqual([202, 409]);
    await jobFor((await draftOf(((await one.json()) as { agent: AgentSummaryDTO }).agent.id))!.id);
  });

  it("is refused for an account not let in, and at the day's spend limit", async () => {
    const conversationId = await interviewed(ana);
    const jo = await addUser(db, "jo", "jo", "waiting");
    state.user = jo;
    expect((await agents.POST(json("/api/agents", "POST", { conversationId }))).status).toBe(403);
    state.user = ana;
    vi.stubEnv("DAILY_SPEND_LIMIT_USD", "0.000001");
    await db.insert(schema.replyUsage).values({ userId: ana.id, provider: "serv", promptTokens: 1000, totalMs: 1, outcome: "ok" });
    const refused = await agents.POST(json("/api/agents", "POST", { conversationId }));
    expect(refused.status).toBe(429);
    expect(seen).toEqual([]);
  });

  it("heals a plan that didn't come together, and says in one sentence when it can't", async () => {
    plans = Array.from({ length: 30 }, () => ({ ...RESTOCK_WIRE, triggers: [] }));
    const conversationId = await interviewed(ana);
    // The fixer says what to change; the plan still doesn't come together.
    fixes = [{ verdict: "plan_wrong", step: "", why: "It has nothing that starts it.", spec: "", change: "Add a schedule: every morning at eight.", sample: "", question: "", choices: [], lesson: "Every agent says what starts it.", kind: "missing_step" }];
    const { agent: a } = (await (await agents.POST(json("/api/agents", "POST", { conversationId }))).json()) as { agent: AgentSummaryDTO };
    await jobFor((await draftOf(a.id))!.id);
    const after = await builderOf(a.id);
    // The fixer's change went to the planner, as what the maker said.
    const outlines = seen.filter((x) => x.schema === "agent_outline");
    expect(outlines.at(-1)!.body.messages[1]!.content).toContain("Also: Add a schedule: every morning at eight.");
    // One plain sentence, never the checker's own reasons.
    expect(after.agent).toMatchObject({ buildState: "failed", buildNote: "I couldn't work out steps that fit together for this job." });
    expect(after.agent.heal).toMatchObject({ gaveUp: "I couldn't work out steps that fit together for this job." });
    expect(after.definition).toBeNull();
    // The checker's reasons are kept, as a diagnosis.
    const heal = (await draftOf(a.id))!.heal!;
    expect(heal.rounds[0]!.diagnosis).toMatchObject({ stage: "plan", step: null });
    expect(heal.rounds[0]!.diagnosis.evidence.errors.join(" ")).toMatch(/trigger/);
  });
});

describe("the builder", () => {
  it("is its maker's only: anyone else is told it isn't there", async () => {
    const { id } = await built();
    state.user = ben;
    for (const res of [
      await agent.GET(json(`/api/agents/${id}?view=builder`), { params: Promise.resolve({ id }) }),
      await run.POST(json(`/api/agents/${id}/run`, "POST", { dryRun: true }), { params: Promise.resolve({ id }) }),
      await fix.POST(json(`/api/agents/${id}/fix`, "POST", { message: "x" }), { params: Promise.resolve({ id }) }),
      await bench.PUT(json(`/api/agents/${id}/bench`, "PUT", { bench: restockBench() }), { params: Promise.resolve({ id }) }),
      await publish.POST(json(`/api/agents/${id}/publish`, "POST"), { params: Promise.resolve({ id }) }),
    ]) {
      expect(res.status).toBe(404);
    }
    expect(((await (await agents.GET(json("/api/agents"))).json()) as { agents: unknown[] }).agents).toEqual([]);
  });

  it("runs the test bench dry, step by step, with no model call", async () => {
    const { id } = await built();
    seen.length = 0;
    const res = await run.POST(json(`/api/agents/${id}/run`, "POST", { dryRun: true, bench: restockBench() }), { params: Promise.resolve({ id }) });
    expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);
    const e = await events(res);
    // The order is over the limit by the way "Compare suppliers" works it
    // out, so it asks, and the sample's yes lets it through: no judgement.
    expect(e.filter((x) => x.type === "step_done").map((x) => `${x.stepId}:${x.status}`)).toEqual(["find_low:ok", "compare:ok", "check_total:ok", "ask_owner:ok", "approved:ok", "record:ok"]);
    expect(e.at(-1)).toMatchObject({ type: "end", status: "done" });
    expect(seen).toEqual([]);
  });

  it("asks SERV for decisions on a live run, and records each call", async () => {
    // A judgement, which only SERV can make.
    plans = [{ ...RESTOCK_WIRE, steps: RESTOCK_WIRE.steps.map((s) => (s.id === "check_total" ? { ...s, from: "", inputs: ["order"], prompt: "Does this order look sensible for a small fabric shop?", outcomes: [{ id: "over", label: "Needs your look", next: "ask_owner" }, { id: "within", label: "Looks fine", next: "record" }] } : s)) }];
    const { id } = await built();
    seen.length = 0;
    const e = await events(await run.POST(json(`/api/agents/${id}/run`, "POST", { dryRun: false, bench: restockBench() }), { params: Promise.resolve({ id }) }));
    expect(e.find((x) => x.type === "step_done" && x.stepId === "check_total")).toMatchObject({ outcome: "within" });
    expect(seen.map((s) => s.schema)).toEqual(["decision"]);
    expect((await db.select().from(schema.replyUsage).where(eq(schema.replyUsage.kind, "agent_decision"))).length).toBeGreaterThan(0);
  });

  it("fixes behaviour from what the maker says, rewriting only the steps that changed", async () => {
    const { id } = await built();
    const changed = {
      ...RESTOCK_WIRE,
      steps: RESTOCK_WIRE.steps.map((s) => (s.id === "compare" ? { ...s, description: `${s.description} Prefer the faster supplier when prices are within 5 percent.` } : s)),
    };
    plans = [changed];
    seen.length = 0;
    const res = await fix.POST(json(`/api/agents/${id}/fix`, "POST", { message: "it ignored delivery time" }), { params: Promise.resolve({ id }) });
    expect(res.status).toBe(202);
    await jobFor((await draftOf(id))!.id);
    // One plan, then only the changed step was written and reviewed, and the
    // changed plan got a new sample for its self test.
    expect(seen.map((s) => (s.to === "serv" ? s.schema : s.to))).toEqual(["agent_outline", "agent_steps", "dolphin", "code_review", "agent_sample"]);
    expect(seen[0]!.body.messages[1]!.content).toContain("The maker says: it ignored delivery time");
    expect(seen[1]!.body.messages[1]!.content).toContain("The maker says: it ignored delivery time");
    expect(seen[2]!.body.messages[1]!.content).toContain("Step: Compare suppliers");
    const after = await builderOf(id);
    expect(after.code.find_low!.status).toBe("approved");
    expect(after.code.compare!.status).toBe("approved");
  });

  it("publishes nothing the code review blocks or couldn't read, and says what to fix", async () => {
    const { id } = await built();
    review = [{ step: "Find low stock", severity: "blocking", finding: "It sends the stock list to an address the purpose doesn't need." }];
    let res = await publish.POST(json(`/api/agents/${id}/publish`, "POST"), { params: Promise.resolve({ id }) });
    expect(res.status).toBe(409);
    const refused = (await res.json()) as { error: string; review: { status: string; findings: unknown[] }; builder: AgentBuilderDTO };
    expect(refused.error).toBe("The code review found problems to fix before it can be published.");
    expect(refused.review).toMatchObject({ status: "blocked", by: "serv", findings: [{ step: "Find low stock", severity: "blocking", finding: "It sends the stock list to an address the purpose doesn't need." }] });
    expect(refused.builder.review!.status).toBe("blocked");
    review = "down";
    res = await publish.POST(json(`/api/agents/${id}/publish`, "POST"), { params: Promise.resolve({ id }) });
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toBe("The code review couldn't run just now, so it isn't published yet. Try again in a minute.");
    expect((await builderOf(id)).agent.state).toBe("draft");
    // A warning alone doesn't stop it.
    review = [{ step: "Compare suppliers", severity: "warning", finding: "It reads every supplier row even when one would do." }];
    res = await publish.POST(json(`/api/agents/${id}/publish`, "POST"), { params: Promise.resolve({ id }) });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { builder: AgentBuilderDTO }).builder.review).toMatchObject({ status: "passed", findings: [{ severity: "warning" }] });
    review = [];
  });

  it("saves the draft, publishes a version that never changes, and starts a new draft after it", async () => {
    const { id } = await built();
    const sample = { ...restockBench(), wallet: { balanceUsdc: 900 } };
    const saved = await bench.PUT(json(`/api/agents/${id}/bench`, "PUT", { bench: sample }), { params: Promise.resolve({ id }) });
    expect(((await saved.json()) as { builder: AgentBuilderDTO }).builder.bench.wallet).toEqual({ balanceUsdc: 900 });

    const published = await publish.POST(json(`/api/agents/${id}/publish`, "POST"), { params: Promise.resolve({ id }) });
    expect(published.status).toBe(200);
    const b = ((await published.json()) as { builder: AgentBuilderDTO }).builder;
    expect(b.agent).toMatchObject({ state: "published", version: 1 });
    expect(b.versions).toEqual([{ number: 1, state: "published", createdAt: expect.any(String), publishedAt: expect.any(String) }]);
    expect((await publish.POST(json(`/api/agents/${id}/publish`, "POST"), { params: Promise.resolve({ id }) })).status).toBe(409);

    const list = ((await (await agents.GET(json("/api/agents"))).json()) as { agents: { id: string; testing: number | null; draft: boolean }[] }).agents;
    expect(list.find((a) => a.id === id)).toMatchObject({ testing: 1, draft: false });

    // Saving the bench now starts version 2; version 1 stays as it was.
    await bench.PUT(json(`/api/agents/${id}/bench`, "PUT", { bench: restockBench() }), { params: Promise.resolve({ id }) });
    const two = await builderOf(id);
    expect(two.agent).toMatchObject({ state: "draft", version: 2 });
    expect(two.versions.map((v) => [v.number, v.state])).toEqual([
      [2, "draft"],
      [1, "published"],
    ]);
    const v1 = await db.query.agentVersions.findFirst({ where: (v, { and, eq: is }) => and(is(v.agentId, id), is(v.number, 1)) });
    expect(v1!.bench!.wallet).toEqual({ balanceUsdc: 900 });
  });

  it("won't publish while a code step lacks approved code", async () => {
    const { id } = await built();
    const draft = (await draftOf(id))!;
    await db.update(schema.agentVersions).set({ code: { ...draft.code, compare: { ...draft.code.compare!, status: "needs_attention" } } }).where(eq(schema.agentVersions.id, draft.id));
    const res = await publish.POST(json(`/api/agents/${id}/publish`, "POST"), { params: Promise.resolve({ id }) });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: '"Compare suppliers" still needs approved code.' });
  });
});

describe("the card's actions", () => {
  it("fixes a step on hold with no typing: SERV writes it again, reviewed in a call of its own", async () => {
    const { id } = await built();
    const draft = (await draftOf(id))!;
    await db.update(schema.agentVersions).set({ code: { ...draft.code, compare: { ...draft.code.compare!, status: "needs_attention", note: "It ignores delivery time." } } }).where(eq(schema.agentVersions.id, draft.id));
    const held = await builderOf(id);
    expect(held.agent.problem).toMatchObject({ step: "compare", fix: "rewrite" });
    seen.length = 0;
    const res = await fix.POST(json(`/api/agents/${id}/fix`, "POST", { step: "compare" }), { params: Promise.resolve({ id }) });
    expect(res.status).toBe(202);
    await jobFor(draft.id);
    // SERV wrote it, SERV reviewed it, and Dolphin wasn't asked.
    expect(seen.slice(0, 2).map((x) => x.schema)).toEqual(["code", "code_review"]);
    expect(seen.some((x) => x.to === "dolphin")).toBe(false);
    const after = await builderOf(id);
    expect(after.code.compare).toMatchObject({ status: "approved", writer: "serv" });
    expect(after.agent.problem, JSON.stringify(after.agent.problem)).toBeNull();
  });

  it("tests it on sample data made from its plan, and tells the run as a story", async () => {
    const { id } = await built();
    seen.length = 0;
    const res = await testRoute.POST(json(`/api/agents/${id}/test`, "POST"), { params: Promise.resolve({ id }) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { test: { status: string; story: string; items: { labels: string[] } }; agent: AgentSummaryDTO };
    // It goes through the stock in code, not one item at a time: one
    // sample item, and the tab it reads has the rows its job needs.
    expect(body.test.items.labels).toEqual(["Linen, natural"]);
    // It wrote orders, not results into the fabrics' own rows: the story
    // says what it did, in order, never that the fabrics were checked.
    expect(body.test.story).toMatch(/^Passed\. It read 3 rows of your sheet.* added \d+ rows? to your sheet/);
    expect(body.agent.test).toMatchObject({ story: body.test.story });
    // The sample is now the draft's test bench, and made only once.
    expect((await builderOf(id)).bench.sheets.Stock).toHaveLength(3);
    seen.length = 0;
    await testRoute.POST(json(`/api/agents/${id}/test`, "POST"), { params: Promise.resolve({ id }) });
    expect(seen.map((x) => x.schema)).not.toContain("agent_sample");
  });
});


describe("a self test that fails", () => {
  // A plan whose "Compare suppliers" must return a value its code never
  // gives: the self test stops there.
  const broken = { ...RESTOCK_WIRE, steps: RESTOCK_WIRE.steps.map((s) => (s.id === "compare" ? { ...s, outputs: [...s.outputs, "notes"] } : s)) };
  const SENTENCE = '"Compare suppliers" didn\'t work on the sample fabric.';
  const CHANGE = { verdict: "plan_wrong", step: "compare", why: "Compare suppliers is asked for notes its job never makes.", spec: "", change: "Remove notes from the outputs of compare.", sample: "", question: "", choices: [], lesson: "A step only returns what its job makes.", kind: "wrong_value" };

  it("heals itself: the fixer reads the diagnosis, the steps are changed, and the plan that passes is kept", async () => {
    plans = [broken, RESTOCK_WIRE];
    fixes = [CHANGE];
    const { id } = await built();
    const after = await builderOf(id);
    expect(after.agent.buildState).toBe("idle");
    expect(after.agent.problem).toBeNull();
    expect(after.agent.test).toMatchObject({ status: "passed" });
    // The fixer read what failed, where, and the run.
    const asked = seen.find((s) => s.schema === "agent_fix")!.body.messages[1]!.content;
    expect(asked).toContain(`What happened: ${SENTENCE}`);
    expect(asked).toContain("Step: Compare suppliers (compare)");
    expect(asked).toContain("The check that failed:\nran");
    // Its change went to the planner as what to change.
    const outlines = seen.filter((s) => s.schema === "agent_outline");
    expect(outlines).toHaveLength(2);
    expect(outlines[1]!.body.messages[1]!.content).toContain("The maker says: Remove notes from the outputs of compare.");
    expect(after.definition!.steps.find((s) => s.id === "compare")!.outputs).toEqual(["order", "order_rows", "total_way", "question"]);
    expect(after.agent.heal!.lines.map((l) => l.text)).toEqual([expect.stringMatching(/^Found a problem in step \d while trying it\. Fixing it\.$/), "Changing its steps.", "Fixed."]);
    const heal = (await draftOf(id))!.heal!;
    expect(heal.rounds.map((r) => [r.diagnosis.stage, r.verdict, r.outcome])).toEqual([["test", "plan", "fixed"]]);
    expect(heal.rounds[0]!.lesson).toEqual({ kind: "wrong_value", text: "A step only returns what its job makes." });
  });

  it("goes round again when a repair doesn't fix it, and gives up with one plain sentence after its rounds", async () => {
    plans = [broken, broken, broken, broken];
    fixes = [CHANGE, CHANGE, CHANGE];
    const { id } = await built();
    const after = await builderOf(id);
    expect(after.agent.buildState).toBe("idle");
    expect(after.agent.test).toMatchObject({ status: "failed" });
    expect(seen.filter((s) => s.schema === "agent_fix")).toHaveLength(3);
    expect(after.agent.heal!.gaveUp).toMatch(/^I couldn't get step \d, "[^"]+", to work on its sample\.$/);
    expect(after.agent.heal!.lines.at(-1)).toMatchObject({ text: after.agent.heal!.gaveUp, tone: "stopped" });
    // Every round is kept, with what failed in each.
    const heal = (await draftOf(id))!.heal!;
    expect(heal.rounds.map((r) => [r.diagnosis.stage, r.verdict, r.outcome])).toEqual([
      ["test", "plan", "failed"],
      ["test", "plan", "failed"],
      ["test", "plan", "failed"],
      ["test", null, "pending"],
    ]);
    expect(heal.rounds[0]!.diagnosis).toMatchObject({ step: { id: "compare" }, failure: SENTENCE, evidence: { check: "ran" } });
    expect(heal.rounds[0]!.diagnosis.evidence.trace.join("\n")).toContain("compare failed");
  });

  it("keeps each fix as a lesson, and gives a lesson more than one maker's builds needed to the planner and Dolphin", async () => {
    // Ana's build and Ben's are each fixed the same way.
    for (const who of [ana, ben]) {
      state.user = who;
      plans = [broken, RESTOCK_WIRE];
      fixes = [CHANGE];
      const conversationId = await interviewed(who);
      const { agent: a } = (await (await agents.POST(json("/api/agents", "POST", { conversationId }))).json()) as { agent: AgentSummaryDTO };
      await jobFor((await draftOf(a.id))!.id);
    }
    const lessons = await db.select().from(schema.agentLessons);
    const lesson = lessons.find((l) => l.rule === "A step only returns what its job makes.")!;
    expect(lesson).toMatchObject({ kind: "wrong_value", wrong: SENTENCE, fix: "Remove notes from the outputs of compare." });
    expect(lesson.count).toBeGreaterThanOrEqual(2);
    expect(lesson.makers.sort()).toEqual([ana.id, ben.id].sort());
    // The next build is planned and written with it as a rule.
    state.user = ana;
    seen.length = 0;
    await built();
    const rule = "Rules learned from earlier builds, keep to them:\n- A step only returns what its job makes.";
    expect(seen.find((x) => x.schema === "agent_outline")!.body.messages[0]!.content).toContain(rule);
    expect(seen.find((x) => x.schema === "agent_steps")!.body.messages[0]!.content).toContain(rule);
    expect(seen.find((x) => x.to === "dolphin")!.body.messages[0]!.content).toContain(rule);
  });

  it("stops at the build's model budget, whatever rounds are left", async () => {
    vi.stubEnv("AGENT_BUILD_COST_USD", "0.0001");
    plans = [broken];
    fixes = [CHANGE];
    const { id } = await built();
    const after = await builderOf(id);
    expect(seen.some((s) => s.schema === "agent_fix")).toBe(false);
    expect(after.agent.heal!.gaveUp).toBeTruthy();
    vi.stubEnv("AGENT_BUILD_COST_USD", "");
  });
});
