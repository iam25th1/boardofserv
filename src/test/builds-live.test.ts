// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { and, eq, sql } from "drizzle-orm";
import type { PGlite } from "@electric-sql/pglite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import * as schema from "@/lib/db/schema";
import { keep } from "@/lib/connections/vault";
import { serverRuntime } from "@/lib/agents/runtime/context";
import { enqueue, claimJob, runJob } from "@/lib/agents/runtime/jobs";
import { draftOf, versionsOf } from "@/lib/agents/store";
import { modelPrices } from "@/lib/model";
import type { AgentDefinition } from "@/lib/agents/definition";
import { addUser, testDb } from "./helperDb";
import { Ledger } from "./suite/live";
import { TEST_PAYEE, type SuiteRequest } from "./suite/requests";
import { runJourney, table, type JourneyResult } from "./suite/journey";

// Building from one plain sentence, live: the owner's own GitHub sentence,
// exactly as they wrote it, from a new chat each time (ten by default),
// then once each a Typeform scorer, a CoinGecko price alert, a weekly
// Sheets sales summary and a Friday payment with approval. Each goes
// through the journey a maker takes in the chat, through the real routes,
// with nothing typed to fix it (suite/journey.ts), on an in-memory
// database. SERV and Dolphin answer on the site's own keys from the
// environment; nothing else is reached but GitHub's public API, for one
// real run of the first checker that goes live. Every model call is
// counted and priced (SERV at its list price), and no request starts once
// the run has spent its SERV budget, LIVE_SERV_USD (4 by default).
//
// Off unless RUN_BUILDS_LIVE=1 with SERV_API_KEY and DOLPHIN_API_KEY.
// BUILDS_ONLY picks requests (checker,typeform,coin,sales,payment),
// BUILDS_REPEAT how many checkers; BUILDS_REPORT keeps what happened (never
// a key).
//
//   RUN_BUILDS_LIVE=1 BUILDS_REPORT=builds.json npx vitest run src/test/builds-live.test.ts

process.env.OPENSERV_KEY_ENC_KEY ||= randomBytes(32).toString("base64");

const enabled = process.env.RUN_BUILDS_LIVE === "1" && Boolean(process.env.SERV_API_KEY) && Boolean(process.env.DOLPHIN_API_KEY);
const SERV_USD = Number(process.env.LIVE_SERV_USD ?? 4);
const REPEAT = Number(process.env.BUILDS_REPEAT ?? 10);
const ONLY = (process.env.BUILDS_ONLY ?? "checker,typeform,coin,sales,payment").split(",").map((s) => s.trim());
const REPO = "iam25th1/boardofserv";
const FORM = "https://form.typeform.com/to/AbCd1234";

const state = vi.hoisted(() => ({ db: null as unknown, user: null as unknown }));
vi.mock("@/lib/db", () => ({ db: new Proxy({}, { get: (_, key) => Reflect.get(state.db as object, key) }) }));
vi.mock("@/lib/auth-route", () => ({ getUserFromRequest: async () => state.user }));
vi.mock("@/lib/google/sheets", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/google/sheets")>()), sheetInfo: (await import("./suite/setup")).sheetInfo }));

const NEVER_ASKS: [RegExp, string] = [/\bask\b|approv|permission|confirm|before/i, "It never needs to ask me anything first."];

// The owner's sentence, exactly, and their answers as they gave them.
const CHECKER: SuiteRequest = {
  id: "checker",
  name: "GitHub checker (owner's sentence)",
  says: "i would like a mini agent that checks githubs and verifies code, work, quality.",
  knows: [[/when should it run|how often/i, "Every hour"], [/repositor|which repo|github/i, REPO], [/where should|where do|send (?:it|the|them)|results go|how should it tell/i, "Telegram"], NEVER_ASKS],
  otherwise: "Judge the quality of each new commit and tell me what it found.",
  setup: [[/repositor|repo/i, REPO]],
};

const OTHERS: SuiteRequest[] = [
  {
    id: "typeform",
    name: "Typeform scorer",
    says: `Every hour, score each new response to my Typeform form ${FORM} from 1 to 10 on how clear and complete the idea is, and send me one Telegram summary of the scores.`,
    knows: [[/criteria|score|judge|how/i, "How clear and complete the idea is."], NEVER_ASKS, [/when|time|often/i, "Every hour."]],
    otherwise: "That's everything.",
    setup: [[/form|typeform|link/i, FORM], [/criteria|score/i, "How clear and complete the idea is."]],
  },
  {
    id: "coin",
    name: "CoinGecko price alert",
    says: "Every 15 minutes, check the price of ETH on CoinGecko and message me on Telegram when it drops below $2,500. Only tell me once each time it drops below.",
    knows: [[/target|how much|price/i, "$2,500."], [/again|repeat|remind|once/i, "Once each time it drops below: not again until it has gone back above."], NEVER_ASKS],
    otherwise: "That's everything.",
    setup: [[/coin/i, "ethereum"], [/target|price/i, "2500"], [/direction|when it goes/i, "below"]],
  },
  {
    id: "sales",
    name: "Weekly sales summary",
    says: "Every Friday at 5pm, read my Google Sheet of sales, one row per sale with a Date and an Amount column, add up this week's sales and how many there were, and send me the weekly total on Telegram.",
    knows: [[/column|date|row|sheet/i, "Each row has a Date column and an Amount column."], NEVER_ASKS, [/when|time|friday/i, "Every Friday at 5pm."]],
    otherwise: "It only reads the sheet and sends me the total.",
    setup: [],
    tabs: ["Sales"],
  },
  {
    id: "payment",
    name: "Friday payment with approval",
    says: "Every Friday, pay 0.5 USDC to my saved payee called Designer, and ask me on Telegram before paying.",
    knows: [[/payee|designer|who|name/i, "Designer is already saved as my payee."], [/amount|how much/i, "0.5 USDC each time."], [/when|time|friday/i, "Every Friday morning at 9."]],
    otherwise: "That's everything.",
    setup: [[/payee|who|pay to|recipient/i, "Designer"], [/amount|how much|usdc/i, "0.5"]],
    payee: { label: "Designer", address: TEST_PAYEE },
  },
];

const ledger = new Ledger({ serv: Number(process.env.LIVE_SERV_BUDGET ?? 600), dolphin: Number(process.env.LIVE_DOLPHIN_BUDGET ?? 120) }, globalThis.fetch);
const logged: { agent: string; line: string }[] = [];
let client: PGlite;
let db: PgliteDatabase<typeof schema>;

// SERV's list price, per million tokens, as the site prices it.
const price = modelPrices(process.env);
const usdOf = (agent?: string) =>
  ledger.calls
    .filter((c) => c.to === "serv" && (agent === undefined || c.agent === agent) && c.status !== "refused" && c.status !== "replayed")
    .reduce((t, c) => t + ((c.promptTokens ?? 0) * price.serv.input + (c.completionTokens ?? 0) * price.serv.output) / 1e6, 0);

beforeAll(async () => {
  if (!enabled) return;
  ({ client, db } = await testDb());
  state.db = db;
  vi.stubEnv("FALLBACK_API_KEY", "");
  vi.stubGlobal("fetch", ledger.fetch);
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => void logged.push({ agent: ledger.agent, line: args.map(String).join(" ") }));
});
afterAll(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await client?.close();
});

// A maker with Telegram linked and Google connected (stand-ins: nothing is
// sent and no sheet is opened), and Typeform for the scorer.
async function maker(id: string, n: number): Promise<schema.User> {
  const user = await addUser(db, `builds.${id}.${n}`);
  const rt = serverRuntime();
  await keep(rt, user.id, "telegram", `@builds_${id}_${n}`, { chatId: 7000 + n, userId: 7000 + n });
  await keep(rt, user.id, "google", `${id}${n}@example.com`, { refreshToken: "stand-in", accessToken: null, expiresAt: null, scope: "https://www.googleapis.com/auth/spreadsheets" });
  if (id === "typeform") await keep(rt, user.id, "typeform", "Typeform", { token: "stand-in" });
  return user;
}

describe.skipIf(!enabled)("building from one plain sentence, live", () => {
  it("builds the owner's sentence ten times from a new chat, then a scorer, an alert, a summary and a payment, within the SERV budget", { timeout: 7_200_000 }, async () => {
    const runs: { request: SuiteRequest; n: number }[] = [
      ...(ONLY.includes("checker") ? Array.from({ length: REPEAT }, (_, n) => ({ request: CHECKER, n })) : []),
      ...OTHERS.filter((r) => ONLY.includes(r.id)).map((request) => ({ request, n: 0 })),
    ];
    const results: (JourneyResult & { run: string; recipe: string | null; usd: number })[] = [];
    const plans: Record<string, unknown> = {};
    let skipped = 0;
    for (const { request, n } of runs) {
      // A request is started only with room for it left in the budget.
      if (usdOf() > SERV_USD - 0.3) {
        skipped += 1;
        continue;
      }
      const run = request.id === "checker" ? `checker${n + 1}` : request.id;
      ledger.agent = run;
      state.user = await maker(request.id, results.length);
      const r = await runJourney(request, { db, user: state.user as schema.User, ledger });
      await ledger.settled();
      const [agent] = await db.select().from(schema.agents).where(eq(schema.agents.ownerUserId, (state.user as schema.User).id));
      const v = agent ? ((await draftOf(agent.id)) ?? (await versionsOf(agent.id))[0]) : null;
      const d = (v?.definition ?? null) as AgentDefinition | null;
      plans[run] = v ? { recipe: d?.recipe ?? null, definition: d, heal: v.heal, test: v.testResult } : null;
      results.push({ ...r, run, recipe: d?.recipe ? `${d.recipe.id}${d.recipe.variant ? ` (${d.recipe.variant})` : ""}` : null, usd: Math.round(usdOf(run) * 10000) / 10000, logged: logged.filter((l) => l.agent === run).map((l) => l.line) });
      console.log(`${run}: stage ${r.stage}${r.passed ? ", live" : ""}, recipe ${results.at(-1)!.recipe ?? "none"}, SERV $${results.at(-1)!.usd}, so far $${usdOf().toFixed(4)}${r.failure ? `: ${r.failure}` : ""}`);
    }

    // One real run of the first checker that went live: GitHub read for
    // real, each new commit judged once by SERV, one message, its place
    // kept as a date.
    let real: Record<string, unknown> | null = null;
    const live = results.find((r) => r.id === "checker" && r.passed);
    if (live && usdOf() < SERV_USD - 0.1) {
      ledger.agent = `${live.run}-run`;
      const rt = serverRuntime();
      const [u] = await db.select().from(schema.users).where(eq(schema.users.handle, `builds.checker.${results.indexOf(live)}`));
      const [inst] = u ? await db.select().from(schema.agentInstallations).where(and(eq(schema.agentInstallations.ownerUserId, u.id), eq(schema.agentInstallations.status, "active"))) : [];
      if (inst) {
        const job = await enqueue(rt, inst, { kind: "manual" });
        await runJob(rt, (await claimJob(rt, "live"))!, "live");
        await ledger.settled();
        const [done] = await db.select().from(schema.agentJobs).where(eq(schema.agentJobs.id, job.id));
        const steps = await db.select().from(schema.agentJobSteps).where(eq(schema.agentJobSteps.jobId, job.id));
        const [cost] = await db.select({ micros: sql<string>`coalesce(sum(${schema.agentModelUsage.cost}), 0)::text` }).from(schema.agentModelUsage).where(eq(schema.agentModelUsage.jobId, job.id));
        const messages = await db.select().from(schema.agentMessages).where(and(eq(schema.agentMessages.installationId, inst.id), eq(schema.agentMessages.from, "agent")));
        const [after] = await db.select().from(schema.agentInstallations).where(eq(schema.agentInstallations.id, inst.id));
        const tools = steps.flatMap((s) => ((s.tools ?? []) as { tool: string; args: Record<string, unknown>; error: string | null }[]).map((t) => ({ step: s.stepId, tool: t.tool, op: t.args?.op ?? null, error: t.error })));
        real = { run: live.run, status: done!.status, reason: done!.reason, usd: Number(cost?.micros ?? "0") / 1e6, tools, messages: messages.map((m) => m.text), memory: after!.memory };
        console.log(`real run of ${live.run}: ${done!.status}, $${(Number(cost?.micros ?? "0") / 1e6).toFixed(4)}, ${tools.filter((t) => t.tool === "serv.reason").length} judged, ${messages.length} message(s)`);
      }
    }

    await ledger.settled();
    console.log(table(results, ledger));
    const checkers = results.filter((r) => r.id === "checker");
    const summary = {
      checkers: { built: checkers.length, live: checkers.filter((r) => r.passed).length, stopped: checkers.filter((r) => !r.passed).map((r) => ({ run: r.run, stage: r.stage, failure: r.failure })) },
      others: results.filter((r) => r.id !== "checker").map((r) => ({ run: r.run, stage: r.stage, live: r.passed, recipe: r.recipe, failure: r.failure })),
      servUsd: Math.round(usdOf() * 10000) / 10000,
      skipped,
    };
    console.log(JSON.stringify(summary, null, 2));
    if (process.env.BUILDS_REPORT) writeFileSync(process.env.BUILDS_REPORT, JSON.stringify({ summary, results, plans, real, calls: ledger.calls }, null, 2));
    expect(usdOf()).toBeLessThan(SERV_USD);
    expect(results.length).toBeGreaterThan(0);
  });
});
