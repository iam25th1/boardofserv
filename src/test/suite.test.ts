// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import * as schema from "@/lib/db/schema";
import { testDb } from "./helperDb";
import { Ledger } from "./suite/live";
import { SUITE } from "./suite/requests";
import { runJourney, type JourneyResult } from "./suite/journey";
import { suiteMaker } from "./suite/setup";

// The regression suite, offline: the eight requests taken through the same
// journey as the live run (suite-live.test.ts), every model call answered
// from what SERV and Dolphin answered in that run (suite/recorded.json), so
// CI checks the same chats, plans, repairs, code, tests and going live
// with no key. Each request ends where it ends on those answers with this
// code (suite/expected.json). A call the live run never made has no answer
// here, and is refused. The clock starts on the day of the live run (code
// that picks a line by the day picks the same one). SUITE_UPDATE=1 writes
// what it got as the new expectations.

const RECORDED = join(__dirname, "suite/recorded.json");
const EXPECTED = join(__dirname, "suite/expected.json");
const DAY = process.env.SUITE_DAY ?? "2026-11-13T17:30:00.000Z";

const state = vi.hoisted(() => ({ db: null as unknown, user: null as unknown }));
vi.mock("@/lib/db", () => ({ db: new Proxy({}, { get: (_, key) => Reflect.get(state.db as object, key) }) }));
vi.mock("@/lib/auth-route", () => ({ getUserFromRequest: async () => state.user }));
vi.mock("@/lib/google/sheets", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/google/sheets")>()), sheetInfo: (await import("./suite/setup")).sheetInfo }));

const ledger = new Ledger({ serv: 0, dolphin: 0 }, globalThis.fetch, existsSync(RECORDED) ? RECORDED : undefined);
let client: PGlite;
let db: PgliteDatabase<typeof schema>;

beforeAll(async () => {
  // The day of the live run, its clock ticking a millisecond each time it
  // is read, so every card and row has a time of its own and the chat's
  // cards keep their order (a frozen clock gave them all the same time),
  // the same on every run.
  vi.stubGlobal("Date", tickingDate(DAY));
  ({ client, db } = await testDb());
  state.db = db;
  vi.stubEnv("SERV_API_KEY", "replayed");
  vi.stubEnv("DOLPHIN_API_KEY", "replayed");
  vi.stubEnv("FALLBACK_API_KEY", "");
  vi.stubGlobal("fetch", ledger.fetch);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterAll(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await client?.close();
});

// A Date whose now starts at a given moment and moves on a millisecond
// each time it is read.
function tickingDate(start: string): DateConstructor {
  const Real = Date;
  let tick = new Real(start).getTime();
  class Ticking extends Real {
    constructor(...a: unknown[]) {
      if (a.length) super(...(a as [string]));
      else super((tick += 1));
    }
    static now() {
      return (tick += 1);
    }
  }
  return Ticking as unknown as DateConstructor;
}

type Expected = Pick<JourneyResult, "id" | "stage" | "passed" | "rounds" | "plan"> & { story: string | null; questions: number };
// The story with what it quoted left out: code may pick its line at
// random (the morning line), and the sandbox's randomness isn't the test's.
const summary = (r: JourneyResult): Expected => ({ id: r.id, stage: r.stage, passed: r.passed, rounds: r.rounds, plan: r.plan, story: r.test?.story.replace(/"[^"]*"/g, '"..."') ?? null, questions: r.questions.length });

describe("the regression suite, on its recorded answers", () => {
  it("takes each request where it goes on its recorded answers, and nothing reaches a model", { timeout: 300_000 }, async () => {
    const expected = JSON.parse(readFileSync(EXPECTED, "utf8")) as Expected[];
    const results: JourneyResult[] = [];
    for (const want of expected) {
      const r = SUITE.find((x) => x.id === want.id)!;
      ledger.agent = r.id;
      state.user = await suiteMaker(db, r.id);
      results.push(await runJourney(r, { db, user: state.user as schema.User, ledger }));
    }
    if (process.env.SUITE_UPDATE === "1") writeFileSync(EXPECTED, `${JSON.stringify(results.map(summary), null, 2)}\n`);
    for (const [i, want] of expected.entries()) expect(summary(results[i]!), results[i]!.failure ?? undefined).toEqual(want);
    // What went live in the live runs goes live here too.
    for (const id of ["designer", "motivation", "sales", "enquiries", "supplies"]) expect(results.find((r) => r.id === id)?.stage, id).toBe(6);
    // Nothing typed to fix any of them.
    expect(results.every((r) => r.typedFixes === 0)).toBe(true);
    // Nothing reached a model: every answer was the recorded one, or none.
    expect(ledger.calls.every((c) => c.status === "replayed" || c.status === "refused")).toBe(true);
  });
});
