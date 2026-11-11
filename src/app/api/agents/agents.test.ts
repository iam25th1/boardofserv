// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import { addUser, testDb } from "@/test/helperDb";
import { COMPARE, FIND_LOW, RESTOCK_WIRE, restockBench } from "@/test/agentFixtures";
import { jobFor } from "@/lib/agents/build";
import { draftOf } from "@/lib/agents/store";
import type { AgentBuilderDTO, AgentSummaryDTO } from "@/lib/types";
import * as agents from "./route";
import * as agent from "./[id]/route";
import * as run from "./[id]/run/route";
import * as fix from "./[id]/fix/route";
import * as bench from "./[id]/bench/route";
import * as publish from "./[id]/publish/route";
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
    const name = body.response_format?.json_schema?.name as string;
    seen.push({ to: "serv", schema: name, body });
    if (name === "agent_plan") return Response.json({ choices: [{ message: { content: JSON.stringify(plans.shift() ?? RESTOCK_WIRE) } }], usage: { prompt_tokens: 1500, completion_tokens: 1100 } });
    if (name === "code_review") return Response.json({ choices: [{ message: { content: JSON.stringify({ verdict: "approve", reason: "Does what the step says." }) } }], usage: { prompt_tokens: 500, completion_tokens: 20 } });
    if (name === "version_review") {
      if (review === "down") return new Response("{}", { status: 503 });
      return Response.json({ choices: [{ message: { content: JSON.stringify({ findings: review }) } }], usage: { prompt_tokens: 2200, completion_tokens: 60 } });
    }
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
    handles: "orders what is low from the best supplier",
    finish: "every low fabric has an order",
    asks: "orders over 250 USDC",
    setup: "the stock and orders sheets",
    remembers: done ? "the last order" : null,
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
    expect(seen.map((s) => (s.to === "serv" ? s.schema : s.to))).toEqual(["agent_plan", "dolphin", "code_review", "dolphin", "code_review", "agent_sample"]);
    // The conversation shows the agent beside its sketch.
    const convo = await (await messagesRoute.GET(json(`/api/conversations/${conversationId}/messages`), { params: Promise.resolve({ id: conversationId }) })).json();
    expect(convo.agent).toMatchObject({ id: first.id, buildState: "idle" });
    // Every model call is in the usage records.
    const usage = await db.select({ kind: schema.replyUsage.kind, provider: schema.replyUsage.provider }).from(schema.replyUsage).where(eq(schema.replyUsage.userId, ana.id));
    expect(usage.map((u) => `${u.kind}/${u.provider}`).sort()).toEqual(["agent_code/dolphin", "agent_code/dolphin", "agent_plan/serv", "agent_plan/serv", "agent_review/serv", "agent_review/serv"]);
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

  it("calls a failed plan failed, in plain words", async () => {
    plans = [{ ...RESTOCK_WIRE, triggers: [] }, { ...RESTOCK_WIRE, triggers: [] }, { ...RESTOCK_WIRE, triggers: [] }];
    const conversationId = await interviewed(ana);
    const { agent: a } = (await (await agents.POST(json("/api/agents", "POST", { conversationId }))).json()) as { agent: AgentSummaryDTO };
    await jobFor((await draftOf(a.id))!.id);
    const after = await builderOf(a.id);
    // Why, in plain words, and what to add: never the checker's own reasons.
    expect(after.agent).toMatchObject({ buildState: "failed", buildNote: "The plan didn't come together: it didn't say what starts it. Say when it should run, for example every 15 minutes or every morning." });
    expect(after.definition).toBeNull();
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
    expect(e.filter((x) => x.type === "step_done").map((x) => `${x.stepId}:${x.status}`)).toEqual(["find_low:ok", "compare:ok", "check_total:ok", "record:ok"]);
    expect(e.at(-1)).toMatchObject({ type: "end", status: "done" });
    expect(seen).toEqual([]);
  });

  it("asks SERV for decisions on a live run, and records each call", async () => {
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
    expect(seen.map((s) => (s.to === "serv" ? s.schema : s.to))).toEqual(["agent_plan", "dolphin", "code_review", "agent_sample"]);
    expect(seen[0]!.body.messages[1]!.content).toContain("The maker says: it ignored delivery time");
    expect(seen[1]!.body.messages[1]!.content).toContain("Step: Compare suppliers");
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
