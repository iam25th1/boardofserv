// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { writeFileSync } from "node:fs";
import type { PGlite } from "@electric-sql/pglite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import * as schema from "@/lib/db/schema";
import { testDb } from "./helperDb";
import { Ledger } from "./suite/live";
import { SUITE } from "./suite/requests";
import { runJourney, table, type JourneyResult } from "./suite/journey";
import { suiteMaker } from "./suite/setup";
import { draftOf, versionsOf } from "@/lib/agents/store";
import { eq } from "drizzle-orm";

// The regression suite, live: each of the eight requests (suite/
// requests.ts) goes through the whole journey a maker takes in the chat,
// through the real routes: the first message and answers to what the chat
// asks, Make it, Looks right, the build healing itself as it goes,
// Connect and Run it for me. An in-memory database; every model call
// counted, capped and listed with its status, tokens and time, never a key.
// Off unless RUN_SUITE_LIVE=1 with SERV_API_KEY and DOLPHIN_API_KEY in the
// environment. It prints a table; SUITE_REPORT keeps the full report (each
// agent's plan and code included), SUITE_RECORD every answer, for the
// offline suite to replay.
//
//   RUN_SUITE_LIVE=1 SUITE_REPORT=report.json SUITE_RECORD=recorded.json npx vitest run src/test/suite-live.test.ts
//
// SUITE_ONLY=price,eth runs some of them; LIVE_SERV_BUDGET and
// LIVE_DOLPHIN_BUDGET cap the run. Each request's own cap grows with the
// size of its plan (AGENT_SERV_CAP and AGENT_DOLPHIN_CAP are the start).

// SUITE_REPLAY (an earlier SUITE_RECORD) answers every call from what
// was recorded there instead, with no key and nothing spent.
const replay = process.env.SUITE_REPLAY;
const enabled = process.env.RUN_SUITE_LIVE === "1" && (Boolean(replay) || (Boolean(process.env.SERV_API_KEY) && Boolean(process.env.DOLPHIN_API_KEY)));
const BUDGET = { serv: Number(process.env.LIVE_SERV_BUDGET ?? 170), dolphin: Number(process.env.LIVE_DOLPHIN_BUDGET ?? 38) };
const CAP = { serv: Number(process.env.AGENT_SERV_CAP ?? 18), dolphin: Number(process.env.AGENT_DOLPHIN_CAP ?? 4) };

const state = vi.hoisted(() => ({ db: null as unknown, user: null as unknown }));
vi.mock("@/lib/db", () => ({ db: new Proxy({}, { get: (_, key) => Reflect.get(state.db as object, key) }) }));
vi.mock("@/lib/auth-route", () => ({ getUserFromRequest: async () => state.user }));
vi.mock("@/lib/google/sheets", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/google/sheets")>()), sheetInfo: (await import("./suite/setup")).sheetInfo }));

// SUITE_REPLAY_ONLY (purposes, comma separated): only those are answered
// from SUITE_REPLAY, the rest go live, within the budget.
const replayOnly = process.env.SUITE_REPLAY_ONLY ? new Set(process.env.SUITE_REPLAY_ONLY.split(",").map((x) => x.trim())) : undefined;
// SUITE_REPLAY_THEN_LIVE=1: a replayed purpose with no answer left goes live.
const ledger = new Ledger(BUDGET, globalThis.fetch, replay, replayOnly, process.env.SUITE_REPLAY_THEN_LIVE === "1");
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
  it("takes each request through the journey in the chat, within the budget", { timeout: 7_200_000 }, async () => {
    const only = process.env.SUITE_ONLY?.split(",").map((s) => s.trim());
    const results: JourneyResult[] = [];
    const agents: Record<string, unknown> = {};
    const chosen = only ? only.flatMap((id) => SUITE.filter((x) => x.id === id)) : SUITE;
    for (const r of chosen) {
      ledger.agent = r.id;
      ledger.cap = { ...CAP };
      state.user = await suiteMaker(db, r.id);
      const result = await runJourney(r, {
        db,
        user: state.user as schema.User,
        ledger,
        // A bigger agent gets more calls: two SERV and one Dolphin more for
        // each step past the first few.
        onPlan: (d) => {
          const code = d.steps.filter((s) => s.kind === "code").length;
          ledger.cap = { serv: CAP.serv + 2 * Math.max(0, d.steps.length - 4), dolphin: Math.max(CAP.dolphin, code + 2) };
        },
      });
      await ledger.settled();
      results.push({ ...result, logged: logged.filter((l) => l.agent === r.id).map((l) => l.line) });
      // Its plan and code, for the record (and the payment run after).
      const [agent] = await db.select().from(schema.agents).where(eq(schema.agents.ownerUserId, (state.user as schema.User).id));
      const v = agent ? ((await draftOf(agent.id)) ?? (await versionsOf(agent.id))[0]) : null;
      agents[r.id] = v ? { definition: v.definition, code: v.code, bench: v.bench, state: v.state } : null;
      console.log(table([results.at(-1)!], ledger));
    }
    await ledger.settled();
    console.log(table(results, ledger));
    const report = {
      budget: BUDGET,
      cap: CAP,
      results,
      agents,
      calls: ledger.calls,
      totals: { serv: ledger.spent("serv"), dolphin: ledger.spent("dolphin"), refused: ledger.calls.filter((c) => c.status === "refused").length },
    };
    if (process.env.SUITE_REPORT) writeFileSync(process.env.SUITE_REPORT, JSON.stringify(report, null, 2));
    if (process.env.SUITE_RECORD) writeFileSync(process.env.SUITE_RECORD, JSON.stringify(Object.fromEntries(ledger.recorded), null, 2));
    expect(results.length).toBeGreaterThan(0);
  });
});
