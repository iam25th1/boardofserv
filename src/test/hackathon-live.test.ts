// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { writeFileSync } from "node:fs";
import type { PGlite } from "@electric-sql/pglite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import * as schema from "@/lib/db/schema";
import { addUser, testDb } from "./helperDb";
import { jobFor } from "@/lib/agents/build";
import { draftOf } from "@/lib/agents/store";
import { stepLine, stepsInOrder } from "@/lib/agents/plainView";
import type { AgentBuilderDTO } from "@/lib/types";

// The test case from a real run, built live through the real pipeline: the
// planning route, SERV's plan (checked against the format and the planner's
// rules), Dolphin's code with SERV's reviews, the self test on a sample SERV
// makes, then one "Test it" with SERV judging for real. An in-memory
// database; every model call counted, capped and listed with its status,
// tokens and time, never a key. Off unless RUN_HACKATHON_LIVE=1, with
// SERV_API_KEY and DOLPHIN_API_KEY in the environment; the report goes to
// HACKATHON_REPORT.
//
//   RUN_HACKATHON_LIVE=1 HACKATHON_REPORT=report.json npx vitest run src/test/hackathon-live.test.ts

const enabled = process.env.RUN_HACKATHON_LIVE === "1" && Boolean(process.env.SERV_API_KEY) && Boolean(process.env.DOLPHIN_API_KEY);
const BUDGET = { serv: Number(process.env.LIVE_SERV_BUDGET ?? 25), dolphin: Number(process.env.LIVE_DOLPHIN_BUDGET ?? 10) };

const state = vi.hoisted(() => ({ db: null as unknown, user: null as unknown }));
vi.mock("@/lib/db", () => ({ db: new Proxy({}, { get: (_, key) => Reflect.get(state.db as object, key) }) }));
vi.mock("@/lib/auth-route", () => ({ getUserFromRequest: async () => state.user }));

interface LiveCall {
  to: "serv" | "dolphin";
  what: string;
  status: number | "refused" | "error";
  ms: number;
  promptTokens: number | null;
  completionTokens: number | null;
}
const calls: LiveCall[] = [];
// SERV's plans as it sent them, and the build's own log lines, so a plan
// that doesn't check out can be looked at afterwards with no more calls.
const plans: string[] = [];
const logged: string[] = [];
const realFetch = globalThis.fetch;

// Only SERV and Dolphin, each within its budget; anything else is refused.
async function counted(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(String(input));
  const to = url.host.includes("dphn.ai") ? "dolphin" : url.host.includes("openserv.ai") ? "serv" : null;
  if (!to) throw new Error(`live: refused a call to ${url.host}`);
  const body = JSON.parse(String(init?.body ?? "{}")) as { response_format?: { json_schema?: { name?: string } }; messages?: { content?: string }[] };
  const what = body.response_format?.json_schema?.name ?? (String(body.messages?.[0]?.content ?? "").startsWith("You write one JavaScript function") ? "code" : "text");
  if (calls.filter((c) => c.to === to).length >= BUDGET[to]) {
    calls.push({ to, what, status: "refused", ms: 0, promptTokens: null, completionTokens: null });
    throw new Error(`live: the ${to} budget of ${BUDGET[to]} calls is used up`);
  }
  const started = Date.now();
  try {
    const res = await realFetch(input, init);
    const answer = res.ok ? ((await res.clone().json().catch(() => null)) as { usage?: { prompt_tokens?: number; completion_tokens?: number }; choices?: { message?: { content?: string } }[] } | null) : null;
    const usage = answer?.usage ?? null;
    if (what === "agent_plan" && answer?.choices?.[0]?.message?.content) plans.push(answer.choices[0].message.content);
    calls.push({ to, what, status: res.status, ms: Date.now() - started, promptTokens: usage?.prompt_tokens ?? null, completionTokens: usage?.completion_tokens ?? null });
    return res;
  } catch (err) {
    calls.push({ to, what, status: "error", ms: Date.now() - started, promptTokens: null, completionTokens: null });
    throw err;
  }
}

let client: PGlite;
let db: PgliteDatabase<typeof schema>;

beforeAll(async () => {
  if (!enabled) return;
  ({ client, db } = await testDb());
  state.db = db;
  state.user = await addUser(db, "hackathon.maker");
  vi.stubEnv("FALLBACK_API_KEY", "");
  vi.stubGlobal("fetch", counted);
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => void logged.push(args.map(String).join(" ")));
});
afterAll(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await client?.close();
});

const json = (url: string, method = "GET", body?: unknown) => new Request(`http://localhost${url}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

describe.skipIf(!enabled)("the hackathon checker, live", () => {
  it("is planned, written, self tested and tested through the real pipeline, within the budget", { timeout: 1_800_000 }, async () => {
    const agents = await import("@/app/api/agents/route");
    const agentRoute = await import("@/app/api/agents/[id]/route");
    const fixRoute = await import("@/app/api/agents/[id]/fix/route");
    const testRoute = await import("@/app/api/agents/[id]/test/route");
    const maker = state.user as schema.User;
    const [convo] = await db.insert(schema.conversations).values({ userId: maker.id, title: "Hackathon Submission Checker" }).returning();
    await db.insert(schema.messages).values([
      { conversationId: convo!.id, role: "user", content: "Make me a Hackathon Submission Checker. Submissions arrive as rows in a Google Sheet. Every 15 minutes, check the new rows." },
      { conversationId: convo!.id, role: "assistant", content: "What should it do with each new submission?" },
      { conversationId: convo!.id, role: "user", content: "Judge each requirement in my list as met or not met. Reject a submission when fewer than half of the requirements are met." },
      { conversationId: convo!.id, role: "assistant", content: "Where should the result go?" },
      { conversationId: convo!.id, role: "user", content: "Write Status and Reasons into the columns of that submission's row, then send me a Telegram summary of the run." },
    ]);
    await db.insert(schema.agentSketches).values({
      conversationId: convo!.id,
      name: "Hackathon Submission Checker",
      kind: "agent",
      wakes: "every 15 minutes",
      looks: "new rows in the submissions Google Sheet",
      handles: "judges each requirement in my list as met or not met, rejects when fewer than half are met",
      finish: "Status and Reasons written into that row, and a Telegram summary of the run sent",
      asks: "nothing",
    });

    const started = await agents.POST(json("/api/agents", "POST", { conversationId: convo!.id }));
    expect(started.status).toBe(202);
    const id = ((await started.json()) as { agent: { id: string } }).agent.id;
    const draftId = (await draftOf(id))!.id;
    await jobFor(draftId);
    const load = async () => ((await (await agentRoute.GET(json(`/api/agents/${id}?view=builder`), { params: Promise.resolve({ id }) })).json()) as { builder: AgentBuilderDTO }).builder;
    let b = await load();
    const report: Record<string, unknown> = { budget: BUDGET, built: { buildState: b.agent.buildState, buildNote: b.agent.buildNote } };

    // One Fix this on a step still on hold, if there is one and room for it.
    if (b.agent.problem?.fix === "rewrite" && b.agent.problem.step && calls.filter((c) => c.to === "serv").length < BUDGET.serv - 4) {
      report.fixed = b.agent.problem;
      await fixRoute.POST(json(`/api/agents/${id}/fix`, "POST", { step: b.agent.problem.step }), { params: Promise.resolve({ id }) });
      await jobFor(draftId);
      b = await load();
    }

    const d = b.definition;
    report.plan = d
      ? {
          name: d.name,
          trigger: d.triggers.map((t) => t.kind === "schedule" ? `${t.every} ${"interval" in t ? (t.interval ?? "") : ""}`.trim() : t.kind),
          steps: stepsInOrder(d).map((s, i) => ({ n: i + 1, plain: stepLine(s, d), kind: s.kind, each: s.kind === "decision" ? (s.each ?? null) : null, tools: s.kind === "code" ? s.tools : s.kind === "action" ? [d.actions.find((a) => a.id === s.action)?.tool] : [] })),
          actions: d.actions.map((a) => `${a.tool}: ${a.description}`),
        }
      : null;
    report.code = Object.fromEntries(Object.entries(b.code).map(([k, c]) => [k, { status: c.status, rounds: c.rounds, writer: c.writer, note: c.note, source: c.source }]));
    report.definition = d;
    report.sample = b.bench;
    report.selfTest = b.agent.test;
    report.problem = b.agent.problem;

    // Test it, with SERV judging the sample for real.
    if (b.agent.buildState === "idle" && !b.agent.problem && calls.filter((c) => c.to === "serv").length < BUDGET.serv) {
      const tested = await testRoute.POST(json(`/api/agents/${id}/test`, "POST"), { params: Promise.resolve({ id }) });
      const t = (await tested.json()) as { test?: { status: string; story: string; problems: unknown[] }; error?: string };
      report.liveTest = t.test ? { status: t.test.status, story: t.test.story, problems: t.test.problems } : { error: t.error };
    }
    report.calls = calls;
    report.logged = logged;
    report.plans = plans;
    report.totals = {
      serv: calls.filter((c) => c.to === "serv" && c.status !== "refused").length,
      dolphin: calls.filter((c) => c.to === "dolphin" && c.status !== "refused").length,
      refused: calls.filter((c) => c.status === "refused").length,
    };
    if (process.env.HACKATHON_REPORT) writeFileSync(process.env.HACKATHON_REPORT, JSON.stringify(report, null, 2));
    expect(calls.filter((c) => c.status === "refused").length).toBe(0);
  });
});
