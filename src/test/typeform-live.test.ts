// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { writeFileSync } from "node:fs";
import type { PGlite } from "@electric-sql/pglite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { asc, eq } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import { modelConfig } from "@/lib/model";
import { servOnly } from "@/lib/agents/build";
import { REASON_TOOL, setupShapeOf } from "@/lib/agents/definition";
import { versionsOf } from "@/lib/agents/store";
import { claimJob, enqueue, runJob } from "@/lib/agents/runtime/jobs";
import { answer, approvalsOf } from "@/lib/agents/runtime/approvals";
import { thin } from "@/lib/agents/runner";
import { sourceAsk, sourceProblem } from "@/lib/agents/sources";
import { formIdOf, formResponses } from "@/lib/typeform/api";
import { deliverTelegram, resetTelegramHolds } from "@/lib/telegram/deliver";
import { keep } from "@/lib/connections/vault";
import { serverRuntime } from "@/lib/agents/runtime/context";
import { addUser, testDb } from "./helperDb";
import { installed, testRuntime } from "./runtimeFixtures";
import { Ledger } from "./suite/live";
import { runJourney } from "./suite/journey";
import type { SuiteRequest } from "./suite/requests";

// A Hackathon Submission Scorer on a real Typeform form, live: one chat
// sentence with the form's link (the chat asks to connect Typeform, with
// a link that comes back to the same chat), the owner's personal token
// connected through the real route, the scorer built from there, then run
// for real on the form's responses with SERV live for every judgement and
// safety check, and Telegram stood in for (its payload is checked, never
// sent). What this checks:
//
// - every response with something in it is scored by SERV, each with its
//   own score and reasons, and the one with only a name is passed by;
// - a message carrying links the owner never gave (a submission's demo)
//   asks first, as it always does: the owner here says yes to each;
// - a second run finds nothing new: nothing is judged or sent twice;
// - Telegram gets clean HTML naming each scored project.
//
// Typeform is only ever read (GET), never written to: the form's monthly
// response limit is untouched. Off unless RUN_TYPEFORM_LIVE=1 with
// SERV_API_KEY, DOLPHIN_API_KEY, TYPEFORM_TOKEN and TYPEFORM_FORM_LINK.
// TYPEFORM_REPORT keeps what happened (never the token or the form's id).
//
//   RUN_TYPEFORM_LIVE=1 TYPEFORM_REPORT=typeform.json npx vitest run src/test/typeform-live.test.ts

const LINK = process.env.TYPEFORM_FORM_LINK ?? "";
const TOKEN = process.env.TYPEFORM_TOKEN ?? "";
const enabled = process.env.RUN_TYPEFORM_LIVE === "1" && Boolean(process.env.SERV_API_KEY) && Boolean(process.env.DOLPHIN_API_KEY) && Boolean(TOKEN) && Boolean(formIdOf(LINK));
const BUDGET = { serv: Number(process.env.LIVE_SERV_BUDGET ?? 70), dolphin: Number(process.env.LIVE_DOLPHIN_BUDGET ?? 16) };

const state = vi.hoisted(() => ({ db: null as unknown, user: null as unknown }));
vi.mock("@/lib/db", () => ({ db: new Proxy({}, { get: (_, key) => Reflect.get(state.db as object, key) }) }));
vi.mock("@/lib/auth-route", () => ({ getUserFromRequest: async () => state.user }));

const NEVER_ASKS: [RegExp, string] = [/\bask\b|approv|permission|confirm|before/i, "It never needs to ask me anything first."];

const SCORER: SuiteRequest = {
  id: "typeform-scorer",
  name: "Hackathon Submission Scorer",
  says: "Done, I connected my Typeform.",
  knows: [
    [/quality|1 to 10|how|judge|good|score/i, "Quality means a clear problem, a working demo to try, and a repo with tests."],
    [/new|already|twice|again/i, "Each submission once: only the ones not scored before."],
    NEVER_ASKS,
  ],
  otherwise: "That's everything.",
  setup: [[/form|typeform|link|submission/i, LINK]],
};

const realFetch = globalThis.fetch;
const ledger = new Ledger(BUDGET, realFetch);
// Typeform, read for real and only read; the form's id is left out of
// what is kept.
const typeformCalls: { path: string; status: number }[] = [];
async function typeform(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  if ((init?.method ?? "GET").toUpperCase() !== "GET") throw new Error("typeform live: Typeform is only read");
  const url = new URL(String(input instanceof Request ? input.url : input));
  const res = await realFetch(input, init);
  typeformCalls.push({ path: url.pathname.replace(formIdOf(LINK) ?? "-", "FORM"), status: res.status });
  return res;
}
const live = (input: RequestInfo | URL, init?: RequestInit) => (new URL(String(input instanceof Request ? input.url : input)).host === "api.typeform.com" ? typeform(input, init) : ledger.fetch(input, init));

let client: PGlite;
let db: PgliteDatabase<typeof schema>;

beforeAll(async () => {
  if (!enabled) return;
  ({ client, db } = await testDb());
  state.db = db;
  vi.stubEnv("FALLBACK_API_KEY", "");
  vi.stubGlobal("fetch", live);
});
afterAll(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await client?.close();
});

const json = (url: string, body: unknown) => new Request(`http://localhost${url}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

async function chatTurn(content: string, conversationId?: string): Promise<{ conversationId: string; reply: string }> {
  const chat = await import("@/app/api/chat/route");
  const events = (await (await chat.POST(json("/api/chat", { content, conversationId }))).text())
    .split("\n\n")
    .filter(Boolean)
    .map((b) => ({ type: /^event: (.+)$/m.exec(b)?.[1] ?? "", data: JSON.parse(/^data: (.+)$/m.exec(b)?.[1] ?? "{}") as Record<string, unknown> }));
  const [latest] = await db.select().from(schema.conversations).where(eq(schema.conversations.userId, (state.user as schema.User).id));
  return {
    conversationId: String(events.map((e) => e.data.conversationId).find(Boolean) ?? conversationId ?? latest?.id ?? ""),
    reply: events.filter((e) => e.type === "delta").map((e) => String(e.data.text ?? "")).join(""),
  };
}

type Asked = { tool: string; args: { data?: unknown; answer?: Record<string, string> }; result: Record<string, unknown> | null };

describe.skipIf(!enabled)("a scorer on a real Typeform form, live", () => {
  it("asks to connect, is built from one sentence, scores each response once with SERV, and sends clean HTML", { timeout: 3_600_000 }, async () => {
    const report: Record<string, unknown> = {};
    const save = () => process.env.TYPEFORM_REPORT && writeFileSync(process.env.TYPEFORM_REPORT, JSON.stringify({ ...report, typeform: typeformCalls, calls: ledger.calls }, null, 2));
    ledger.agent = SCORER.id;

    // What is on the form now: one response with only its name filled in,
    // the rest with something to judge.
    const formId = formIdOf(LINK)!;
    const { responses } = await formResponses(realFetch, TOKEN, formId);
    const nameOf = (r: { answers: Record<string, unknown> }) => String(r.answers["Project name"] ?? "");
    const empty = responses.filter((r) => thin(r.answers));
    const judged = responses.filter((r) => !thin(r.answers));
    report.form = { responses: responses.length, empty: empty.map(nameOf), judged: judged.map(nameOf) };
    expect(empty).toHaveLength(1);
    expect(judged).toHaveLength(5);

    // A maker with Telegram linked (a stand-in chat) and no Typeform yet.
    const user = await addUser(db, "live.typeform");
    state.user = user;
    await keep(serverRuntime(), user.id, "telegram", "@live_typeform", { chatId: 5101, userId: 5101 });

    // One sentence with the form's link: the plain-words ask, with a link
    // to connect Typeform that comes back to this chat.
    const first = await chatTurn(`Make me a Hackathon Submission Scorer: every hour, take each new submission to my Typeform ${LINK}, have each one scored for quality from 1 to 10 with the reasons, and send me the scores on Telegram.`);
    report.ask = first.reply.replace(formId, "FORM");
    expect(first.reply).toBe(sourceAsk(sourceProblem(LINK)!, `/app/chat?c=${first.conversationId}`));
    expect(first.reply).toContain(`[Connect Typeform](/app/connections?connect=typeform&back=${encodeURIComponent(`/app/chat?c=${first.conversationId}`)})`);

    // The owner pastes their token on Connections: checked with Typeform,
    // kept in the vault, never shown again.
    const connect = await import("@/app/api/connections/typeform/route");
    const connected = await connect.POST(json("/api/connections/typeform", { token: TOKEN }));
    const said = await connected.text();
    expect(connected.status).toBe(200);
    expect(said).not.toContain(TOKEN);
    const [row] = await db.select().from(schema.connections).where(eq(schema.connections.ownerUserId, user.id));
    expect(JSON.stringify(row)).not.toContain(TOKEN);

    // Back in the same chat: the build goes on from there.
    const journey = await runJourney(SCORER, { db, user, ledger, conversationId: first.conversationId });
    await ledger.settled();
    report.journey = { ...journey, turns: journey.turns.map((t) => ({ said: t.said.replace(LINK, "LINK"), reply: t.reply.replace(formId, "FORM") })) };
    const [agent] = await db.select().from(schema.agents).where(eq(schema.agents.ownerUserId, user.id));
    const versions = agent ? await versionsOf(agent.id) : [];
    const version = versions.find((v) => v.state === "published");
    const last = version ?? versions[0];
    report.definition = last?.definition ?? null;
    report.code = last?.code ?? null;
    report.bench = last?.bench ?? null;
    save();
    expect(journey.failure).toBeNull();
    const d = version!.definition!;
    expect(d.steps.some((s) => s.kind === "code" && s.tools.includes("typeform.read"))).toBe(true);

    // A real run on the real form, Telegram stood in for.
    const rt = testRuntime(db, new Date());
    rt.fetchImpl = ledger.fetch;
    rt.serv = () => ({ config: servOnly(modelConfig(process.env)), ownKey: false });
    rt.net.on("https://api.typeform.com/", (req) => typeform(req.url.href, { headers: req.headers }));
    const shape = setupShapeOf(d);
    const settings = Object.fromEntries(shape.settings.map((s) => [s.key, s.type === "url" || /form|typeform/i.test(`${s.key} ${s.label}`) ? LINK : (d.settings.find((x) => x.key === s.key)?.given ?? (s.type === "boolean" ? false : s.type === "choice" ? s.choices[0] : "Yes"))]));
    const inst = await installed(rt, user, { agent: agent!, version: version! }, { settings, timezone: "Europe/London" });

    // One run, the owner saying yes to whatever it asks first.
    const runOnce = async () => {
      const job = await enqueue(rt, inst, { kind: "manual" });
      const asks: { kind: string; reason: string | null }[] = [];
      await runJob(rt, (await claimJob(rt, "live"))!, "live");
      for (let i = 0; i < 12; i++) {
        await ledger.settled();
        const [a] = await approvalsOf(rt, user.id, { jobId: job.id, pendingOnly: true });
        if (!a) break;
        asks.push({ kind: a.kind, reason: a.reason });
        rt.clock.move(1000);
        await answer(rt, user.id, a.id, a.options.find((o) => /^yes/i.test(o.label))?.label ?? a.options[0]!.label);
        await runJob(rt, (await claimJob(rt, "live"))!, "live");
      }
      await ledger.settled();
      resetTelegramHolds();
      await deliverTelegram(rt);
      rt.clock.move(60_000);
      const [j] = await db.select().from(schema.agentJobs).where(eq(schema.agentJobs.id, job.id));
      const steps = await db.select().from(schema.agentJobSteps).where(eq(schema.agentJobSteps.jobId, job.id)).orderBy(asc(schema.agentJobSteps.seq));
      const audits = await db.select().from(schema.agentAudit).where(eq(schema.agentAudit.jobId, job.id));
      const asked = steps.flatMap((s) => (s.tools as Asked[]).filter((t) => t.tool === REASON_TOOL));
      return { job: j!, steps, audits, asked, asks };
    };
    // What went to Telegram: the agent's own messages, and the questions
    // the platform asked (they come with buttons).
    const telegram = () => rt.net.telegram("sendMessage");
    const own = () => telegram().filter((m) => !m.reply_markup);

    const one = await runOnce();
    const sentFirst = own();
    const scoring = one.asked.filter((a) => Object.values(a.args.answer ?? {}).includes("number"));
    const scores = scoring.map((a) => ({ data: a.args.data, result: a.result }));
    Object.assign(report, {
      first: { status: one.job.status, outcome: one.job.outcome, reason: one.job.reason, costUsd: one.job.costUsd },
      steps: one.steps.map((s) => ({ step: s.stepId, status: s.status, ms: s.ms, tools: (s.tools as { tool: string }[]).map((t) => t.tool), note: s.note })),
      audits: one.audits.map((a) => ({ step: a.step, tool: a.tool, outcome: a.outcome, guard: a.guard, guardReason: a.guardReason })),
      scores,
      asks: one.asks,
      telegram: telegram(),
    });
    save();

    expect(one.job.status).toBe("done");
    expect(one.audits.filter((a) => a.outcome === "blocked")).toEqual([]);
    // It asked first only for what it always asks about: links nobody gave it.
    for (const a of one.asks) expect(a.reason).toContain("you didn't give it");
    // SERV scored the five with something in them, and never the one with
    // only a name.
    expect(scoring).toHaveLength(5);
    for (const r of judged) expect(scoring.filter((a) => JSON.stringify(a.args.data).includes(nameOf(r)))).toHaveLength(1);
    expect(scoring.some((a) => JSON.stringify(a.args.data).includes(nameOf(empty[0]!)))).toBe(false);
    // Different scores, each from 1 to 10, with reasons of their own.
    const numbers = scoring.map((a) => Object.values(a.result ?? {}).find((v) => typeof v === "number") as number);
    expect(numbers.every((n) => n >= 1 && n <= 10)).toBe(true);
    expect(new Set(numbers).size).toBeGreaterThanOrEqual(3);
    const reasons = scoring.map((a) => Object.values(a.result ?? {}).find((v) => typeof v === "string" && v.length > 20) as string | undefined);
    expect(reasons.every(Boolean)).toBe(true);
    expect(new Set(reasons).size).toBe(5);
    // Every response this installation took is remembered as done.
    const seen = await db.select().from(schema.agentSeenItems).where(eq(schema.agentSeenItems.installationId, inst.id));
    expect(seen.map((s) => s.itemId).sort()).toEqual(responses.map((r) => r.id).sort());
    expect(seen.every((s) => s.state === "done")).toBe(true);
    // Telegram: HTML, no raw markdown, no code or JSON, each scored project
    // named and the empty one not; nothing secret in it.
    expect(sentFirst.length).toBeGreaterThan(0);
    const text = sentFirst.map((m) => String(m.text)).join("\n");
    for (const m of sentFirst) expect(m.parse_mode).toBe("HTML");
    expect(text).not.toMatch(/\*\*|(^|\s)\*\S|\S\*(\s|$)|(^|\s)_\S[^_]*_(\s|$)|\{"|\[object|undefined|NaN|\\n/);
    for (const r of judged) expect(text).toContain(nameOf(r));
    expect(text).not.toContain(nameOf(empty[0]!));
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain(formId);

    // Again: nothing new on the form, so nothing judged and nothing sent.
    const two = await runOnce();
    report.second = { status: two.job.status, outcome: two.job.outcome, reason: two.job.reason, scored: two.asked.length, asks: two.asks.length, telegram: own().length - sentFirst.length };
    save();
    expect(two.job.status).toBe("done");
    expect(two.asked).toEqual([]);
    expect(two.asks).toEqual([]);
    expect(own()).toHaveLength(sentFirst.length);
    // Typeform was only ever read.
    expect(typeformCalls.every((c) => c.status === 200)).toBe(true);
  });
});
