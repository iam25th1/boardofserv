// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { writeFileSync } from "node:fs";
import type { PGlite } from "@electric-sql/pglite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import * as schema from "@/lib/db/schema";
import { addUser, testDb } from "./helperDb";
import { jobFor } from "@/lib/agents/build";
import { draftOf } from "@/lib/agents/store";
import { stepDepths, stepLine, stepsInOrder } from "@/lib/agents/plainView";
import { loopsOf } from "@/lib/agents/definition";
import { runAgent, type RunEvent } from "@/lib/agents/runner";
import type { AgentBuilderDTO } from "@/lib/types";
import { readFileSync } from "node:fs";
import { askedSteps } from "./planAnswers";

// The test case from a real run, built live through the real pipeline: the
// planning route, SERV's plan in two stages (checked against the format and
// the planner's rules), Dolphin's code with SERV's reviews, the self test on
// a sample SERV makes (and Fix this on its own if it fails), then one
// "Test it" with SERV judging for real when the budget has room for every
// decision. The self test's own run is told in full: decisions per step,
// what was written into each row, the summary, and the second run. An
// in-memory database; every model call counted, capped and listed with its
// status, tokens and time, never a key. Off unless RUN_HACKATHON_LIVE=1,
// with SERV_API_KEY and DOLPHIN_API_KEY in the environment; the report goes
// to HACKATHON_REPORT.
//
//   RUN_HACKATHON_LIVE=1 HACKATHON_REPORT=report.json npx vitest run src/test/hackathon-live.test.ts
//
// With REPLAY_PLAN (an earlier report), planning is answered from SERV's
// answers recorded there instead of new calls: the outline at REPLAY_OUTLINE
// (its place in the report's plans) and each step's latest details up to
// REPLAY_UPTO. With REPLAY_CODE (an earlier report), a code step its code
// was approved for there gets that code as Dolphin's answer and its review's
// verdict as SERV's. Replayed answers are listed, and spend none of the
// budget.

const enabled = process.env.RUN_HACKATHON_LIVE === "1" && Boolean(process.env.SERV_API_KEY) && Boolean(process.env.DOLPHIN_API_KEY);
const BUDGET = { serv: Number(process.env.LIVE_SERV_BUDGET ?? 35), dolphin: Number(process.env.LIVE_DOLPHIN_BUDGET ?? 12) };

const state = vi.hoisted(() => ({ db: null as unknown, user: null as unknown }));
vi.mock("@/lib/db", () => ({ db: new Proxy({}, { get: (_, key) => Reflect.get(state.db as object, key) }) }));
vi.mock("@/lib/auth-route", () => ({ getUserFromRequest: async () => state.user }));

interface LiveCall {
  to: "serv" | "dolphin";
  what: string;
  status: number | "refused" | "error" | "replayed";
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

const replay = process.env.REPLAY_PLAN
  ? (() => {
      const recorded = (JSON.parse(readFileSync(process.env.REPLAY_PLAN, "utf8")) as { plans: string[] }).plans.map((p) => ({ what: p.slice(0, p.indexOf(":")), body: p.slice(p.indexOf(":") + 2) }));
      const details = new Map<string, unknown>();
      recorded.slice(0, Number(process.env.REPLAY_UPTO ?? recorded.length - 1) + 1).forEach((p) => {
        if (p.what === "agent_steps") for (const st of (JSON.parse(p.body) as { steps: { id: string }[] }).steps) details.set(st.id, st);
      });
      return { outline: recorded[Number(process.env.REPLAY_OUTLINE ?? 0)]!.body, details };
    })()
  : null;
// Each step approved in REPLAY_CODE's report, by its title: its code and
// what its review said.
const replayCode = process.env.REPLAY_CODE
  ? (() => {
      const r = JSON.parse(readFileSync(process.env.REPLAY_CODE, "utf8")) as { definition: { steps: { id: string; title: string }[] }; code: Record<string, { status: string; source: string | null; note: string | null }> };
      return r.definition.steps.flatMap((s) => (r.code[s.id]?.status === "approved" && r.code[s.id]!.source ? [{ title: s.title, source: r.code[s.id]!.source!, note: r.code[s.id]!.note ?? "Approved." }] : []));
    })()
  : [];
const spent = (to: "serv" | "dolphin") => calls.filter((c) => c.to === to && c.status !== "refused" && c.status !== "replayed").length;

// Only SERV and Dolphin, each within its budget; anything else is refused.
async function counted(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(String(input));
  const to = url.host.includes("dphn.ai") ? "dolphin" : url.host.includes("openserv.ai") ? "serv" : null;
  if (!to) throw new Error(`live: refused a call to ${url.host}`);
  const body = JSON.parse(String(init?.body ?? "{}")) as { response_format?: { json_schema?: { name?: string } }; messages?: { content?: string }[] };
  const what = body.response_format?.json_schema?.name ?? (String(body.messages?.[0]?.content ?? "").startsWith("You write one JavaScript function") ? "code" : "text");
  if (replay && (what === "agent_outline" || what === "agent_steps")) {
    const content = what === "agent_outline" ? replay.outline : JSON.stringify({ steps: askedSteps(String(body.messages?.at(-1)?.content ?? "")).flatMap((id) => (replay.details.has(id) ? [replay.details.get(id)] : [])) });
    calls.push({ to, what, status: "replayed", ms: 0, promptTokens: null, completionTokens: null });
    return Response.json({ choices: [{ message: { content } }] });
  }
  const asked = String(body.messages?.at(-1)?.content ?? "");
  const kept = (what === "code" || what === "code_review") && replayCode.find((c) => asked.includes(`Step: ${c.title}\n`));
  if (kept) {
    calls.push({ to, what, status: "replayed", ms: 0, promptTokens: null, completionTokens: null });
    return Response.json({ choices: [{ message: { content: what === "code" ? "```js\n" + kept.source + "\n```" : JSON.stringify({ verdict: "approve", reason: kept.note }) } }] });
  }
  if (spent(to) >= BUDGET[to]) {
    calls.push({ to, what, status: "refused", ms: 0, promptTokens: null, completionTokens: null });
    throw new Error(`live: the ${to} budget of ${BUDGET[to]} calls is used up`);
  }
  const started = Date.now();
  try {
    const res = await realFetch(input, init);
    const answer = res.ok ? ((await res.clone().json().catch(() => null)) as { usage?: { prompt_tokens?: number; completion_tokens?: number }; choices?: { message?: { content?: string } }[] } | null) : null;
    const usage = answer?.usage ?? null;
    if ((what === "agent_outline" || what === "agent_steps") && answer?.choices?.[0]?.message?.content) plans.push(`${what}: ${answer.choices[0].message.content}`);
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
      { conversationId: convo!.id, role: "user", content: "For each submission, judge each requirement in my list as met or not met, one requirement at a time. Count the met ones: fewer than half met means rejected, otherwise passed." },
      { conversationId: convo!.id, role: "assistant", content: "Where should the result go?" },
      { conversationId: convo!.id, role: "user", content: "Write Status and Reasons into that submission's own row, with Reasons naming each requirement as met or not met. Then send me one Telegram summary covering every submission checked. The next run should leave checked rows alone." },
    ]);
    await db.insert(schema.agentSketches).values({
      conversationId: convo!.id,
      name: "Hackathon Submission Checker",
      kind: "agent",
      wakes: "every 15 minutes",
      looks: "new rows in the submissions Google Sheet",
      handles: "for each submission, judges each requirement in my list as met or not met; fewer than half met is rejected, otherwise passed",
      finish: "Status and Reasons (each requirement met or not) written into that row, and one Telegram summary covering every submission checked; checked rows are left alone next time",
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
    if (b.agent.problem?.fix === "rewrite" && b.agent.problem.step && spent("serv") < BUDGET.serv - 4) {
      report.fixed = b.agent.problem;
      await fixRoute.POST(json(`/api/agents/${id}/fix`, "POST", { step: b.agent.problem.step }), { params: Promise.resolve({ id }) });
      await jobFor(draftId);
      b = await load();
    }

    const d = b.definition;
    const depths = d ? stepDepths(d) : new Map<string, number>();
    report.plan = d
      ? {
          name: d.name,
          trigger: d.triggers.map((t) => t.kind === "schedule" ? `${t.every} ${"interval" in t ? (t.interval ?? "") : ""}`.trim() : t.kind),
          steps: stepsInOrder(d).map((s, i) => ({ n: i + 1, depth: depths.get(s.id) ?? 0, id: s.id, plain: stepLine(s, d), kind: s.kind, each: s.kind === "decision" ? (s.each ?? null) : null, tools: s.kind === "code" ? s.tools : s.kind === "action" ? [d.actions.find((a) => a.id === s.action)?.tool] : [] })),
          actions: d.actions.map((a) => `${a.tool}: ${a.description}`),
        }
      : null;
    const kept = (await draftOf(id))!;
    report.code = Object.fromEntries(Object.entries(kept.code).map(([k, c]) => [k, { status: c.status, rounds: c.rounds, writer: c.writer, note: c.note, source: c.source }]));
    report.definition = d;
    report.sample = b.bench;
    report.selfTest = b.agent.test;
    report.problem = b.agent.problem;

    // The self test's run again, dry, on the same sample (no model calls):
    // how many decisions each decision step made, what went into each row,
    // the summary, and what a second run does.
    let decisions = 0;
    if (d && b.agent.test && kept.testResult?.sample) {
      const dry = async (bench: typeof kept.testResult.sample) => {
        const events: RunEvent[] = [];
        const end = await runAgent({ definition: d, code: kept.code, bench: bench!, dryRun: true, onEvent: (e) => events.push(e) });
        return { events, end };
      };
      const first = await dry(kept.testResult.sample);
      const perStep = Object.fromEntries(d.steps.filter((s) => s.kind === "decision").map((s) => [s.id, first.events.filter((e) => e.type === "step_done" && e.stepId === s.id).length]));
      decisions = Object.values(perStep).reduce((t, n) => t + n, 0);
      const tools = (events: RunEvent[], tool: string) => events.filter((e): e is Extract<RunEvent, { type: "tool" }> => e.type === "tool" && e.tool === tool && !e.error);
      const second = await dry({ ...kept.testResult.sample, sheets: first.end.sheets, memory: first.end.memory });
      report.selfTestRun = {
        status: first.end.status,
        loops: Object.fromEntries(loopsOf(d).inside),
        decisionsPerStep: perStep,
        sample: { settings: kept.testResult.sample.settings, items: kept.testResult.items },
        updates: tools(first.events, "sheets.update").map((e) => e.args),
        summary: tools(first.events, "telegram.send").map((e) => (e.args as { text?: string }).text),
        secondRun: { status: second.end.status, decisions: second.events.filter((e) => e.type === "step_done" && d.steps.some((s) => s.id === e.stepId && s.kind === "decision")).length, updates: tools(second.events, "sheets.update").length, sends: tools(second.events, "telegram.send").map((e) => (e.args as { text?: string }).text) },
      };
    }

    // Test it, with SERV judging the sample for real, when every decision
    // it would make fits in the budget.
    const servLeft = BUDGET.serv - spent("serv");
    report.liveTestRoom = { decisions, servLeft };
    if (b.agent.buildState === "idle" && !b.agent.problem && decisions > 0 && servLeft >= decisions) {
      const tested = await testRoute.POST(json(`/api/agents/${id}/test`, "POST"), { params: Promise.resolve({ id }) });
      const t = (await tested.json()) as { test?: { status: string; story: string; problems: unknown[] }; error?: string };
      report.liveTest = t.test ? { status: t.test.status, story: t.test.story, problems: t.test.problems } : { error: t.error };
    }
    report.calls = calls;
    report.logged = logged;
    report.plans = plans;
    report.totals = {
      serv: spent("serv"),
      dolphin: spent("dolphin"),
      replayed: calls.filter((c) => c.status === "replayed").length,
      refused: calls.filter((c) => c.status === "refused").length,
    };
    if (process.env.HACKATHON_REPORT) writeFileSync(process.env.HACKATHON_REPORT, JSON.stringify(report, null, 2));
    expect(calls.filter((c) => c.status === "refused").length).toBe(0);
  });
});
