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
import { sourceAsk, sourceProblem } from "@/lib/agents/sources";
import { deliverTelegram, resetTelegramHolds } from "@/lib/telegram/deliver";
import { testDb } from "./helperDb";
import { installed, ownSheet, testRuntime } from "./runtimeFixtures";
import { Ledger } from "./suite/live";
import { runJourney } from "./suite/journey";
import type { SuiteRequest } from "./suite/requests";
import { keep } from "@/lib/connections/vault";
import { serverRuntime } from "@/lib/agents/runtime/context";
import { addUser } from "./helperDb";

// The Hackathon Submission Scorer, rebuilt live from one chat sentence,
// then run for real on three submissions (two different ones and an empty
// one), with SERV live for every judgement and every safety check, and
// Telegram and the sheet stood in for. What the beta's scorer got wrong is
// what this checks:
//
// - the scoring step calls SERV, and two different submissions get
//   different scores with reasons that are SERV's own;
// - the empty submission is passed by: no score, no SERV call for it;
// - a public Typeform link gets the plain-words ask, not a step that
//   pretends to read it;
// - the safety check blocks nothing it planned;
// - Telegram gets HTML, never raw markdown.
//
// Off unless RUN_SCORER_LIVE=1 with SERV_API_KEY and DOLPHIN_API_KEY.
// SCORER_REPORT keeps what happened; LIVE_SERV_BUDGET and
// LIVE_DOLPHIN_BUDGET cap it.
//
//   RUN_SCORER_LIVE=1 SCORER_REPORT=scorer.json npx vitest run src/test/scorer-live.test.ts

const enabled = process.env.RUN_SCORER_LIVE === "1" && Boolean(process.env.SERV_API_KEY) && Boolean(process.env.DOLPHIN_API_KEY);
const BUDGET = { serv: Number(process.env.LIVE_SERV_BUDGET ?? 70), dolphin: Number(process.env.LIVE_DOLPHIN_BUDGET ?? 16) };

const state = vi.hoisted(() => ({ db: null as unknown, user: null as unknown }));
vi.mock("@/lib/db", () => ({ db: new Proxy({}, { get: (_, key) => Reflect.get(state.db as object, key) }) }));
vi.mock("@/lib/auth-route", () => ({ getUserFromRequest: async () => state.user }));
vi.mock("@/lib/google/sheets", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/google/sheets")>()), sheetInfo: (await import("./suite/setup")).sheetInfo }));

const NEVER_ASKS: [RegExp, string] = [/\bask\b|approv|permission|confirm|before/i, "It never needs to ask me anything first."];

export const SCORER: SuiteRequest = {
  id: "scorer",
  name: "Hackathon Submission Scorer",
  says: "Make me a Hackathon Submission Scorer: every hour, take each new row of my Google Sheet of submissions (it has Name and Description columns), have it scored for quality from 1 to 10 with the reasons, write them into its Score and Reasons columns, and send me the scores on Telegram.",
  knows: [
    [/column|row|new|sheet|checked|status|filled/i, "Each row has Name and Description columns. A row is new until its Score is filled in."],
    [/quality|1 to 10|how|judge|good|score/i, "Quality means a clear idea, something working to try, and a README."],
    NEVER_ASKS,
  ],
  otherwise: "That's everything.",
  setup: [],
  tabs: ["Submissions"],
};

const SUBMISSIONS = [
  { Name: "Tide", Description: "Tide tracks tide pools for school field trips. Live demo at a public link, a README with setup steps, tests that pass, and SERV planning which pools to visit.", Score: "", Reasons: "" },
  { Name: "Notes", Description: "notes app idea", Score: "", Reasons: "" },
  { Name: "", Description: "", Score: "", Reasons: "" },
];

const ledger = new Ledger(BUDGET, globalThis.fetch);
let client: PGlite;
let db: PgliteDatabase<typeof schema>;

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

// A maker with Telegram linked and Google connected (stand-ins), each with
// their own chat.
async function maker(id: string, chat: number): Promise<schema.User> {
  const user = await addUser(db, `live.${id}`);
  const rt = serverRuntime();
  await keep(rt, user.id, "telegram", `@live_${id}`, { chatId: chat, userId: chat });
  await keep(rt, user.id, "google", `${id}@example.com`, { refreshToken: "stand-in", accessToken: null, expiresAt: null, scope: "https://www.googleapis.com/auth/spreadsheets" });
  return user;
}

const json = (url: string, body: unknown) => new Request(`http://localhost${url}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe.skipIf(!enabled)("the Hackathon Submission Scorer, live", () => {
  it("is built from one sentence, asks SERV for every score, skips the empty one, and sends clean HTML", { timeout: 3_600_000 }, async () => {
    const report: Record<string, unknown> = {};

    // A public Typeform link: the plain-words ask, written by no model.
    ledger.agent = "typeform";
    state.user = await maker("typeform", 5001);
    const link = "https://form.typeform.com/to/AbC123xy";
    const chat = await import("@/app/api/chat/route");
    const res = await chat.POST(json("/api/chat", { content: `Make me an agent that scores each hackathon submission from my Typeform ${link} and sends me the scores on Telegram.` }));
    const reply = (await res.text())
      .split("\n\n")
      .filter((b) => b.startsWith("event: delta"))
      .map((b) => (JSON.parse(/^data: (.+)$/m.exec(b)![1]!) as { text: string }).text)
      .join("");
    report.typeform = reply;
    expect(reply).toBe(sourceAsk(sourceProblem(link)!));

    // The scorer, from one sentence through the journey in the chat.
    ledger.agent = "scorer";
    const user = await maker("scorer", 5002);
    state.user = user;
    const journey = await runJourney(SCORER, { db, user, ledger });
    await ledger.settled();
    report.journey = journey;
    const [agent] = await db.select().from(schema.agents).where(eq(schema.agents.ownerUserId, user.id));
    const versions = agent ? await versionsOf(agent.id) : [];
    const version = versions.find((v) => v.state === "published");
    // The plan as it ended, published or not, with its code and last test.
    const last = version ?? versions[0];
    report.definition = last?.definition ?? null;
    report.code = last?.code ?? null;
    report.bench = last?.bench ?? null;
    if (process.env.SCORER_REPORT) writeFileSync(process.env.SCORER_REPORT, JSON.stringify({ ...report, calls: ledger.calls }, null, 2));
    if (process.env.SCORER_RECORD) writeFileSync(process.env.SCORER_RECORD, JSON.stringify(Object.fromEntries(ledger.recorded), null, 2));
    expect(journey.failure).toBeNull();
    expect(version?.definition).toBeTruthy();
    const d = version!.definition!;
    // The scoring is SERV's: a code step that asks it, or its decisions.
    const reasons = d.steps.filter((s) => s.kind === "code" && s.tools.includes(REASON_TOOL));
    const judges = d.steps.filter((s) => s.kind === "decision" && !s.from);
    expect(reasons.length + judges.length).toBeGreaterThan(0);

    // A real run: SERV for every judgement and safety check, the sheet and
    // Telegram stood in for.
    const rt = testRuntime(db, new Date());
    rt.fetchImpl = ledger.fetch;
    rt.serv = () => ({ config: servOnly(modelConfig(process.env)), ownKey: false });
    const sheet = ownSheet(rt, { Submissions: SUBMISSIONS });
    const shape = setupShapeOf(d);
    const settings = Object.fromEntries(shape.settings.map((s) => [s.key, s.type === "sheet" ? sheet.answer("Submissions") : (d.settings.find((x) => x.key === s.key)?.given ?? "Yes")]));
    const inst = await installed(rt, user, { agent: agent!, version: version! }, { settings, timezone: "Europe/London" });
    const job = await enqueue(rt, inst, { kind: "manual" });
    await runJob(rt, (await claimJob(rt, "live"))!, "live");
    await ledger.settled();
    resetTelegramHolds();
    await deliverTelegram(rt);
    const [row] = await db.select().from(schema.agentJobs).where(eq(schema.agentJobs.id, job.id));
    const steps = await db.select().from(schema.agentJobSteps).where(eq(schema.agentJobSteps.jobId, job.id)).orderBy(asc(schema.agentJobSteps.seq));
    const audits = await db.select().from(schema.agentAudit).where(eq(schema.agentAudit.jobId, job.id));
    const rows = rt.net.rows(sheet.id, "Submissions");
    const sent = rt.net.telegram("sendMessage");
    const asked = steps.flatMap((s) => (s.tools as { tool: string; args: unknown; result: unknown }[]).filter((t) => t.tool === REASON_TOOL));
    Object.assign(report, {
      job: { status: row!.status, outcome: row!.outcome, reason: row!.reason, costUsd: row!.costUsd },
      steps: steps.map((s) => ({ step: s.stepId, status: s.status, ms: s.ms, costUsd: s.costUsd, model: s.model, tools: (s.tools as { tool: string }[]).map((t) => t.tool), note: s.note })),
      reasoning: asked,
      audits: audits.map((a) => ({ step: a.step, tool: a.tool, outcome: a.outcome, guard: a.guard, guardReason: a.guardReason })),
      rows,
      telegram: sent,
    });
    if (process.env.SCORER_REPORT) writeFileSync(process.env.SCORER_REPORT, JSON.stringify({ ...report, calls: ledger.calls }, null, 2));

    expect(row!.status).toBe("done");
    // Nothing it planned was stopped by the safety check.
    expect(audits.filter((a) => a.outcome === "blocked")).toEqual([]);
    expect(row!.outcome).toBeNull();
    // SERV judged the two real submissions, and never the empty one.
    // (SERV may write the summary too: the scoring calls are the ones that
    // answer with a number.)
    if (reasons.length) {
      const scoring = asked.filter((a) => Object.values((a.args as { answer?: Record<string, string> }).answer ?? {}).includes("number"));
      expect(scoring).toHaveLength(2);
      const said = JSON.stringify(scoring.map((a) => a.args));
      expect(said).toContain("Tide");
      expect(said).toContain("Notes");
    }
    // Every judgement cost a model call: none was worked out for free.
    expect(Number(row!.costUsd)).toBeGreaterThan(0);
    // What it wrote into each row: the cells that were empty and aren't now.
    const wrote = rows.map((r, i) => Object.fromEntries(Object.entries(r).filter(([k, v]) => k !== "_row" && String(v ?? "").trim() !== "" && !String((SUBMISSIONS[i] as Record<string, unknown>)[k] ?? "").trim())));
    report.wrote = wrote;
    // The empty row was passed by; the two real ones scored differently,
    // each with a number from 1 to 10.
    expect(wrote[2]).toEqual({});
    const scoreOf = (w: Record<string, unknown>) => Object.values(w).map((v) => Number(String(v).trim())).find((n) => Number.isFinite(n) && n >= 1 && n <= 10);
    const scores = wrote.slice(0, 2).map(scoreOf);
    expect(scores.every((n) => n !== undefined)).toBe(true);
    expect(scores[0]).not.toBe(scores[1]);
    // The message went as HTML, with no raw markdown marks.
    expect(sent.length).toBeGreaterThan(0);
    for (const m of sent) {
      expect(m.parse_mode).toBe("HTML");
      expect(String(m.text)).not.toMatch(/\*\*|(^|\s)\*\S|\S\*(\s|$)|(^|\s)_\S[^_]*_(\s|$)/);
    }
  });
});
