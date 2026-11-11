// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import * as schema from "@/lib/db/schema";
import { addUser, testDb } from "./helperDb";
import { Ledger } from "./suite/live";
import { SUITE } from "./suite/requests";
import { runJourney, type JourneyResult } from "./suite/journey";

// The regression suite, offline: the six requests taken through the same
// journey as the live run (suite-live.test.ts), every model call answered
// from what SERV and Dolphin answered in that run (suite/recorded.json), so
// CI checks the same plans, code and self tests with no key. Each request
// ends where it ends on those answers with this code (suite/expected.json),
// the price watcher passing. A call the live run had no budget for has no
// answer here either, and is refused the same way. The clock reads the day
// of the live run (code that picks a line by the day picks the same one).
// SUITE_UPDATE=1 writes what it got as the new expectations.

const RECORDED = join(__dirname, "suite/recorded.json");
const EXPECTED = join(__dirname, "suite/expected.json");

const state = vi.hoisted(() => ({ db: null as unknown, user: null as unknown }));
vi.mock("@/lib/db", () => ({ db: new Proxy({}, { get: (_, key) => Reflect.get(state.db as object, key) }) }));
vi.mock("@/lib/auth-route", () => ({ getUserFromRequest: async () => state.user }));

const ledger = new Ledger({ serv: 0, dolphin: 0 }, globalThis.fetch, existsSync(RECORDED) ? RECORDED : undefined);
let client: PGlite;
let db: PgliteDatabase<typeof schema>;

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-11T20:00:00.000Z") });
  ({ client, db } = await testDb());
  state.db = db;
  vi.stubEnv("SERV_API_KEY", "replayed");
  vi.stubEnv("DOLPHIN_API_KEY", "replayed");
  vi.stubEnv("FALLBACK_API_KEY", "");
  vi.stubGlobal("fetch", ledger.fetch);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterAll(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await client?.close();
});

type Expected = Pick<JourneyResult, "id" | "stage" | "passed" | "plan"> & { story: string | null };

describe("the regression suite, on its recorded answers", () => {
  it("takes each request where it goes on its recorded answers, the price watcher passing", { timeout: 120_000 }, async () => {
    const expected = JSON.parse(readFileSync(EXPECTED, "utf8")) as Expected[];
    const results: JourneyResult[] = [];
    for (const want of expected) {
      const r = SUITE.find((x) => x.id === want.id)!;
      ledger.agent = r.id;
      state.user = await addUser(db, `suite.${r.id}`);
      results.push(await runJourney(r, { db, user: state.user as schema.User, ledger }));
    }
    if (process.env.SUITE_UPDATE === "1") writeFileSync(EXPECTED, `${JSON.stringify(results.map((r) => ({ id: r.id, stage: r.stage, passed: r.passed, plan: r.plan, story: r.test?.story ?? null })), null, 2)}\n`);
    for (const [i, want] of expected.entries()) {
      const got = results[i]!;
      expect({ id: got.id, stage: got.stage, passed: got.passed, plan: got.plan, story: got.test?.story ?? null }, got.failure ?? undefined).toEqual(want);
    }
    expect(results.find((r) => r.id === "price")?.passed).toBe(true);
    // Nothing reached a model: every answer was the recorded one, or none.
    expect(ledger.calls.every((c) => c.status === "replayed" || c.status === "refused")).toBe(true);
  });
});
