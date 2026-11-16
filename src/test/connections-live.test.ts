// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import type { PGlite } from "@electric-sql/pglite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import { modelConfig } from "@/lib/model";
import { servOnly } from "@/lib/agents/build";
import { servicesOf, type AgentDefinition, type CodeStepDef } from "@/lib/agents/definition";
import type { StepCode, TestResult } from "@/lib/agents/types";
import { versionsOf } from "@/lib/agents/store";
import { testVersion } from "@/lib/agents/test";
import { writtenTarget } from "@/lib/agents/targets";
import { keep } from "@/lib/connections/vault";
import { serverRuntime } from "@/lib/agents/runtime/context";
import { loadNeeds } from "@/lib/sketchStore";
import { addUser, testDb } from "./helperDb";
import { Ledger } from "./suite/live";
import { runJourney } from "./suite/journey";
import type { SuiteRequest } from "./suite/requests";

// The connections and builds brief, live, with SERV and Dolphin answering
// (on the site's own keys from the environment) and every outside service
// stood in for: nothing is called with a real key, and nothing but SERV
// and Dolphin is reached.
//
// - The exact sentence of the live GitHub Code Verifier: the chat asks
//   which repositories, what quality means and where results go before it
//   is made; answered with a public repository, its plan is clean (one
//   send, no log sheet, no memory, GitHub read with github.read, the
//   repository a setting), no step writes a target into its code, and its
//   test passes, then passes again with SERV judging for real.
// - An alert on Discord asks for Discord, with one tap to connect it.
// - A service that isn't in the catalog is offered through Custom API.
//
// Off unless RUN_CONNECTIONS_LIVE=1 with SERV_API_KEY and DOLPHIN_API_KEY.
// CONNECTIONS_REPORT keeps what happened (never a key).
//
//   RUN_CONNECTIONS_LIVE=1 CONNECTIONS_REPORT=connections.json npx vitest run src/test/connections-live.test.ts

// The vault's key, for this run's own connections.
process.env.OPENSERV_KEY_ENC_KEY ||= randomBytes(32).toString("base64");

const enabled = process.env.RUN_CONNECTIONS_LIVE === "1" && Boolean(process.env.SERV_API_KEY) && Boolean(process.env.DOLPHIN_API_KEY);
const BUDGET = { serv: Number(process.env.LIVE_SERV_BUDGET ?? 80), dolphin: Number(process.env.LIVE_DOLPHIN_BUDGET ?? 20) };
const ONLY = (process.env.CONNECTIONS_ONLY ?? "verifier,discord,custom").split(",");

const state = vi.hoisted(() => ({ db: null as unknown, user: null as unknown }));
vi.mock("@/lib/db", () => ({ db: new Proxy({}, { get: (_, key) => Reflect.get(state.db as object, key) }) }));
vi.mock("@/lib/auth-route", () => ({ getUserFromRequest: async () => state.user }));
// Every outside service is stood in for: a public repository's commits and
// pull requests from a made-up GitHub, and nothing else reached at all.
vi.mock("@/lib/connections/request", async (load) => {
  const real = await load<typeof import("@/lib/connections/request")>();
  const github = (url: string) => {
    const u = new URL(url);
    if (u.host !== "api.github.com") return new Response(JSON.stringify({ message: "Not stood in for" }), { status: 404 });
    if (/\/pulls\b/.test(u.pathname)) return Response.json([{ number: 7, title: "Speed up the router", user: { login: "ada" }, state: "open", draft: false, created_at: "2026-11-15T10:00:00Z", merged_at: null, html_url: "https://github.com/x/y/pull/7", body: "Caches route lookups." }]);
    return Response.json([{ sha: "abc1234", html_url: "https://github.com/x/y/commit/abc1234", commit: { message: "Fix a race in the cache", author: { name: "Ada", date: "2026-11-15T10:00:00Z" } } }]);
  };
  return { ...real, guardedTransport: () => real.fetchTransport((async (u: string) => github(String(u))) as typeof fetch) };
});

export const VERIFIER_SAYS = "i would like a mini agent that checks githubs and verifies code, work, quality.";
const PUBLIC_REPO = "vercel/next.js";

const VERIFIER: SuiteRequest = {
  id: "verifier",
  name: "GitHub Code Verifier",
  says: VERIFIER_SAYS,
  knows: [
    [/repositor|which repo|github/i, PUBLIC_REPO],
    [/where|send|tell|results go|report/i, "Telegram"],
    [/when|how often|time|schedule/i, "Every day at 9."],
    [/\bask\b|approv|permission|confirm|before/i, "It never needs to ask me anything first."],
  ],
  otherwise: "Check new commits and pull requests, judge how good the code is, and tell me what it found.",
  setup: [[/repositor|repo/i, PUBLIC_REPO]],
};

const ledger = new Ledger(BUDGET, globalThis.fetch);
let client: PGlite;
let db: PgliteDatabase<typeof schema>;
const report: Record<string, unknown> = {};
const save = () => process.env.CONNECTIONS_REPORT && writeFileSync(process.env.CONNECTIONS_REPORT, JSON.stringify({ ...report, calls: ledger.calls }, null, 2));

beforeAll(async () => {
  if (!enabled) return;
  ({ client, db } = await testDb());
  state.db = db;
  vi.stubEnv("FALLBACK_API_KEY", "");
  vi.stubGlobal("fetch", ledger.fetch);
});
afterAll(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await client?.close();
});

const json = (url: string, body: unknown) => new Request(`http://localhost${url}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

async function chatTurn(content: string, conversationId?: string): Promise<{ conversationId: string; reply: string; choices: string[] }> {
  const chat = await import("@/app/api/chat/route");
  const events = (await (await chat.POST(json("/api/chat", { content, conversationId }))).text())
    .split("\n\n")
    .filter(Boolean)
    .map((b) => ({ type: /^event: (.+)$/m.exec(b)?.[1] ?? "", data: JSON.parse(/^data: (.+)$/m.exec(b)?.[1] ?? "{}") as Record<string, unknown> }));
  const [latest] = await db.select().from(schema.conversations).where(eq(schema.conversations.userId, (state.user as schema.User).id));
  return {
    conversationId: String(events.map((e) => e.data.conversationId).find(Boolean) ?? conversationId ?? latest?.id ?? ""),
    reply: events.filter((e) => e.type === "delta").map((e) => String(e.data.text ?? "")).join(""),
    choices: (events.find((e) => e.type === "reply_end")?.data.choices as string[] | undefined) ?? [],
  };
}

// A chat about a job, answered as the maker would, until the chat asks to
// connect something (or a few turns pass): every reply.
async function describe_(says: string, answers: [RegExp, string][], until: RegExp): Promise<string[]> {
  const replies: string[] = [];
  let turn = await chatTurn(says);
  replies.push(turn.reply);
  for (let i = 0; i < 6 && !until.test(turn.reply); i++) {
    const answer = answers.find(([q]) => q.test(turn.reply))?.[1] ?? turn.choices[0] ?? "That's all.";
    turn = await chatTurn(answer, turn.conversationId);
    replies.push(turn.reply);
  }
  return replies;
}

describe.skipIf(!enabled)("connections and builds, live", () => {
  it.runIf(ONLY.includes("verifier"))("asks the verifier's questions, plans it clean from a public repository, and passes Try it with SERV judging", { timeout: 3_600_000 }, async () => {
    ledger.agent = VERIFIER.id;
    const user = await addUser(db, "live.verifier");
    state.user = user;
    // Telegram linked (a stand-in chat), for where it sends.
    await keep(serverRuntime(), user.id, "telegram", "@live_verifier", { chatId: 5201, userId: 5201 });
    const journey = await runJourney(VERIFIER, { db, user, ledger });
    await ledger.settled();
    report.verifier = { journey };
    save();

    // Asked before it was made: which repositories, what quality means,
    // where results go.
    const asked = journey.questions.filter((q) => q.from === "needs").map((q) => q.question);
    const [convo] = await db.select().from(schema.conversations).where(eq(schema.conversations.userId, user.id));
    const needs = await loadNeeds(convo!.id);
    report.verifier = { journey, needs };
    save();
    const questions = (needs?.items ?? []).filter((i) => i.kind === "input").map((i) => i.question).join(" | ");
    expect(questions).toMatch(/repositor|repo/i);
    expect(questions).toMatch(/quality|good|standard|bar|pass/i);
    expect(questions).toMatch(/where|send|tell|notif|results/i);
    expect(asked.length).toBeGreaterThanOrEqual(1);

    // The plan.
    const [agent] = await db.select().from(schema.agents).where(eq(schema.agents.ownerUserId, user.id));
    const versions = await versionsOf(agent!.id);
    const v = versions[0]!;
    const d = v.definition!;
    report.verifier = { journey, needs, definition: d, code: v.code, bench: v.bench, test: v.testResult, heal: v.heal };
    save();
    expect(journey.stage).toBeGreaterThanOrEqual(4);
    const sends = d.steps.filter((s) => s.kind === "action");
    expect(new Set(sends.map((s) => s.kind === "action" && s.action)).size).toBe(sends.length);
    expect(d.actions.filter((a) => a.tool.startsWith("sheets."))).toEqual([]);
    // Memory only where a step reads it (a position, so a run takes only
    // new commits): nothing kept for nothing.
    for (const m of d.memory) expect(d.steps.some((x) => x.inputs.includes("memory") || (x.kind === "code" && x.tools.includes("memory.get"))), m.key).toBe(true);
    expect(servicesOf(d)).toContain("github");
    expect(d.steps.some((s) => s.kind === "code" && s.tools.includes("web.fetch"))).toBe(false);
    expect(d.settings.some((s) => (s.given ?? "").includes(PUBLIC_REPO))).toBe(true);
    // Nothing written into its code.
    for (const s of d.steps.filter((x): x is CodeStepDef => x.kind === "code")) expect(writtenTarget(v.code[s.id]?.source ?? "", s, d), s.id).toBeNull();

    // Try it passed; and again with SERV judging for real.
    expect(v.testResult?.status).toBe("passed");
    const judged = await testVersion({ definition: d, code: v.code, testResult: v.testResult }, { serv: servOnly(modelConfig(process.env)), live: true, kind: "manual", fetchImpl: ledger.fetch });
    await ledger.settled();
    report.verifier = { journey, needs, definition: d, code: v.code, bench: v.bench, test: v.testResult, heal: v.heal, judged: judged.result, judgedEvents: judged.events.filter((e) => e.type === "tool" || e.type === "step_done") };
    save();
    expect(judged.result.status).toBe("passed");
    const reasoned = judged.events.filter((e) => e.type === "tool" && e.tool === "serv.reason" && !e.error);
    expect(reasoned.length).toBeGreaterThan(0);
    expect(JSON.stringify(reasoned)).not.toMatch(/Dry run: SERV/);
  });

  // Try it with SERV judging, again, on a verifier build a run kept
  // (CONNECTIONS_FROM, its report): the same plan, code and sample.
  it.runIf(ONLY.includes("judged") && Boolean(process.env.CONNECTIONS_FROM))("passes Try it with SERV judging on the verifier's build", { timeout: 1_800_000 }, async () => {
    ledger.agent = "judged";
    const kept = JSON.parse(readFileSync(process.env.CONNECTIONS_FROM!, "utf8")) as { verifier: { definition: AgentDefinition; code: Record<string, StepCode>; test: TestResult } };
    const { definition: d, code, test } = kept.verifier;
    expect(test.status).toBe("passed");
    for (const s of d.steps.filter((x): x is CodeStepDef => x.kind === "code")) expect(writtenTarget(code[s.id]?.source ?? "", s, d), s.id).toBeNull();
    const judged = await testVersion({ definition: d, code, testResult: test }, { serv: servOnly(modelConfig(process.env)), live: true, kind: "manual", fetchImpl: ledger.fetch });
    await ledger.settled();
    report.judged = { result: judged.result, events: judged.events.filter((e) => e.type === "tool" || e.type === "step_done") };
    save();
    expect(judged.result.status).toBe("passed");
    const reasoned = judged.events.filter((e) => e.type === "tool" && e.tool === "serv.reason" && !e.error);
    expect(reasoned.length).toBeGreaterThan(0);
    expect(JSON.stringify(reasoned)).not.toMatch(/Dry run: SERV/);
  });

  it.runIf(ONLY.includes("discord"))("asks for Discord on an alert agent, with one tap to connect it and come back", { timeout: 600_000 }, async () => {
    ledger.agent = "discord";
    const user = await addUser(db, "live.discord");
    state.user = user;
    const replies = await describe_("Alert me on Discord when the ETH price drops below 2000 dollars.", [[/when|how often|check/i, "Check every 15 minutes."], [/price|below|target|threshold/i, "Below 2000 dollars."]], /connect=discord/);
    report.discord = { replies };
    save();
    expect(replies.at(-1)).toMatch(/Discord, which isn't connected yet/);
    expect(replies.at(-1)).toMatch(/\[Connect Discord\]\(\/app\/connections\?connect=discord&back=%2Fapp%2Fchat%3Fc%3D/);
  });

  it.runIf(ONLY.includes("custom"))("offers Custom API for a service that isn't in the catalog", { timeout: 600_000 }, async () => {
    ledger.agent = "custom";
    const user = await addUser(db, "live.custom");
    state.user = user;
    const replies = await describe_("Every morning at 8, post a short summary of my new followers to my Mastodon account.", [[/where|which account|server/i, "My account on mastodon.social."]], /Custom API/);
    report.custom = { replies };
    save();
    expect(replies.at(-1)).toMatch(/Mastodon isn't one of the services here/i);
    expect(replies.at(-1)).toMatch(/\[Connect Custom API\]\(\/app\/connections\?connect=custom&back=/);
  });
});
