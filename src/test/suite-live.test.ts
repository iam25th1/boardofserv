// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { writeFileSync } from "node:fs";
import type { PGlite } from "@electric-sql/pglite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import * as schema from "@/lib/db/schema";
import { addUser, testDb } from "./helperDb";
import { Ledger } from "./suite/live";
import { SUITE } from "./suite/requests";
import { runJourney, table, type JourneyResult } from "./suite/journey";

// The regression suite, live: each of the six requests (suite/requests.ts)
// goes through the whole journey a maker takes in the chat, through the
// real routes: the chat turns, Make it, Looks right, the build and the
// self test. An in-memory database; every model call counted, capped and
// listed with its status, tokens and time, never a key. Off unless
// RUN_SUITE_LIVE=1 with SERV_API_KEY and DOLPHIN_API_KEY in the
// environment. It prints a pass or fail table; SUITE_REPORT keeps the full
// report and SUITE_RECORD every answer, for the offline suite to replay.
//
//   RUN_SUITE_LIVE=1 SUITE_REPORT=report.json SUITE_RECORD=recorded.json npx vitest run src/test/suite-live.test.ts
//
// SUITE_ONLY=price,sales runs some of them; LIVE_SERV_BUDGET and
// LIVE_DOLPHIN_BUDGET cap the run, AGENT_SERV_CAP and AGENT_DOLPHIN_CAP
// each request.

// SUITE_REPLAY (an earlier SUITE_RECORD) answers every call from what
// was recorded there instead, with no key and nothing spent.
const replay = process.env.SUITE_REPLAY;
const enabled = process.env.RUN_SUITE_LIVE === "1" && (Boolean(replay) || (Boolean(process.env.SERV_API_KEY) && Boolean(process.env.DOLPHIN_API_KEY)));
const BUDGET = { serv: Number(process.env.LIVE_SERV_BUDGET ?? 70), dolphin: Number(process.env.LIVE_DOLPHIN_BUDGET ?? 16) };
const CAP = { serv: Number(process.env.AGENT_SERV_CAP ?? 16), dolphin: Number(process.env.AGENT_DOLPHIN_CAP ?? 4) };

const state = vi.hoisted(() => ({ db: null as unknown, user: null as unknown, agent: "", tests: [] as { agent: string; status: string; story: string; problems: { text: string }[] }[] }));
vi.mock("@/lib/db", () => ({ db: new Proxy({}, { get: (_, key) => Reflect.get(state.db as object, key) }) }));
vi.mock("@/lib/auth-route", () => ({ getUserFromRequest: async () => state.user }));
// Every test result a draft is given, in order, so a first test that a fix
// then changed is still in the report.
vi.mock("@/lib/agents/store", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/agents/store")>();
  return {
    ...real,
    updateDraft: async (...args: Parameters<typeof real.updateDraft>) => {
      const t = args[1].testResult;
      if (t) state.tests.push({ agent: state.agent, status: t.status, story: t.story, problems: t.problems });
      return real.updateDraft(...args);
    },
  };
});

// SUITE_REPLAY_ONLY (purposes, comma separated): only those are answered
// from SUITE_REPLAY, the rest go live, within the budget.
const replayOnly = process.env.SUITE_REPLAY_ONLY ? new Set(process.env.SUITE_REPLAY_ONLY.split(",").map((x) => x.trim())) : undefined;
const ledger = new Ledger(BUDGET, globalThis.fetch, replay, replayOnly);
const logged: { agent: string; line: string }[] = [];
let client: PGlite;
let db: PgliteDatabase<typeof schema>;

beforeAll(async () => {
  if (!enabled) return;
  ({ client, db } = await testDb());
  state.db = db;
  vi.stubEnv("FALLBACK_API_KEY", "");
  if (replay && !replayOnly) {
    vi.stubEnv("SERV_API_KEY", "replayed");
    vi.stubEnv("DOLPHIN_API_KEY", "replayed");
  }
  vi.stubGlobal("fetch", ledger.fetch);
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => void logged.push({ agent: ledger.agent, line: args.map(String).join(" ") }));
});
afterAll(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await client?.close();
});

describe.skipIf(!enabled)("the regression suite, live", () => {
  it("takes each request through the journey in the chat, within the budget", { timeout: 3_600_000 }, async () => {
    const only = process.env.SUITE_ONLY?.split(",").map((s) => s.trim());
    const results: JourneyResult[] = [];
    // In SUITE_ONLY's order when it is given.
    const chosen = only ? only.flatMap((id) => SUITE.filter((x) => x.id === id)) : SUITE;
    for (const r of chosen) {
      ledger.agent = r.id;
      state.agent = r.id;
      ledger.cap = CAP;
      state.user = await addUser(db, `suite.${r.id}`);
      const result = await runJourney(r, { db, user: state.user as schema.User, ledger });
      await ledger.settled();
      results.push({ ...result, tests: state.tests.filter((t) => t.agent === r.id), logged: logged.filter((l) => l.agent === r.id).map((l) => l.line) });
    }
    await ledger.settled();
    console.log(table(results, ledger));
    const report = {
      budget: BUDGET,
      cap: CAP,
      results,
      calls: ledger.calls,
      totals: { serv: ledger.spent("serv"), dolphin: ledger.spent("dolphin"), refused: ledger.calls.filter((c) => c.status === "refused").length },
    };
    if (process.env.SUITE_REPORT) writeFileSync(process.env.SUITE_REPORT, JSON.stringify(report, null, 2));
    if (process.env.SUITE_RECORD) writeFileSync(process.env.SUITE_RECORD, JSON.stringify(Object.fromEntries(ledger.recorded), null, 2));
    expect(results.length).toBeGreaterThan(0);
  });
});
