// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import * as schema from "@/lib/db/schema";
import { addUser, testDb } from "@/test/helperDb";
import { testRuntime } from "@/test/runtimeFixtures";
import { completeJson, modelConfig, type Attempt } from "./model";
import { answerRates, recordAttempts } from "./modelAttempts";
import { adminSafety } from "./safety/admin";
import { recordAgentCall } from "./agents/build";

// Every try of every call, kept: purpose, provider, status, time, tokens,
// which try and whether it was empty, one call's tries under one call id.
// The admin's model cost view reads the empty answer and retry rates.

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/db", () => ({ db: new Proxy({}, { get: (_, key) => Reflect.get(state.db as object, key) }) }));

let client: PGlite;
let db: PgliteDatabase<typeof schema>;
beforeAll(async () => {
  ({ client, db } = await testDb());
  state.db = db;
});
afterAll(async () => client.close());

const at = new Date("2026-11-10T09:00:00Z");
const tryOf = (purpose: Attempt["purpose"], retry: number, outcome: Attempt["outcome"], status: number | null = 200): Attempt => ({
  purpose,
  provider: "serv",
  status,
  outcome,
  ms: 900 + retry,
  promptTokens: outcome === "network" ? null : 600,
  completionTokens: outcome === "ok" ? 25 : outcome === "network" ? null : 0,
  retry,
  empty: outcome === "empty" || outcome === "unusable",
});

describe("the attempt log", () => {
  it("keeps every try of a call, together, as the client reported it", async () => {
    await recordAttempts(db as never, [tryOf("post_screen", 0, "empty"), tryOf("post_screen", 1, "ok")], { ownKey: false, at });
    const rows = await db.select().from(schema.modelAttempts);
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.callId)).size).toBe(1);
    expect(rows.map((r) => [r.purpose, r.provider, r.status, r.outcome, r.retry, r.empty, r.promptTokens, r.completionTokens])).toEqual([
      ["post_screen", "serv", 200, "empty", 0, true, 600, 0],
      ["post_screen", "serv", 200, "ok", 1, false, 600, 25],
    ]);
  });

  it("gives each purpose's calls, tries, empty answers and calls tried again", async () => {
    await recordAttempts(db as never, [tryOf("decision", 0, "ok")], { ownKey: false, at });
    await recordAttempts(db as never, [tryOf("decision", 0, "network", null), tryOf("decision", 1, "unusable"), tryOf("decision", 2, "ok")], { ownKey: false, at });
    await recordAttempts(db as never, [tryOf("guard", 0, "ok")], { ownKey: true, at });
    // Last week's don't count.
    await recordAttempts(db as never, [tryOf("guard", 0, "empty")], { ownKey: false, at: new Date("2026-11-01T09:00:00Z") });
    const rates = await answerRates(db as never, new Date("2026-11-09T00:00:00Z"));
    expect(rates).toEqual([
      { purpose: "decision", calls: 2, attempts: 4, empty: 1, retried: 1 },
      { purpose: "guard", calls: 1, attempts: 1, empty: 0, retried: 0 },
      { purpose: "post_screen", calls: 1, attempts: 2, empty: 1, retried: 1 },
    ]);
  });

  it("is written where a call's usage is, with the tries the client made", async () => {
    const user = await addUser(db, "attempts.maker", "attempts_maker");
    let n = 0;
    const fetchImpl = (async () => (n++ === 0 ? Response.json({ choices: [{ message: { content: "" } }] }) : Response.json({ choices: [{ message: { content: "{}" } }], usage: { prompt_tokens: 1500, completion_tokens: 60 } }))) as typeof fetch;
    const call = await completeJson([{ role: "user", content: "Review this." }], {
      config: modelConfig({ SERV_API_KEY: "test-serv", MODEL_RETRY_BACKOFF_MS: "0" }),
      purpose: "code_review",
      schema: { name: "code_review", schema: { type: "object" } },
      signal: new AbortController().signal,
      fetchImpl,
    });
    await recordAgentCall({ userId: user.id, conversationId: null, ownKey: false }, "agent_review", call);
    const rows = (await db.select().from(schema.modelAttempts)).filter((r) => r.purpose === "code_review");
    expect(rows.map((r) => [r.outcome, r.retry, r.empty])).toEqual([
      ["empty", 0, true],
      ["ok", 1, false],
    ]);
  });

  it("shows on the admin's model cost view, this week", async () => {
    const rt = testRuntime(db, new Date("2026-11-11T12:00:00Z"));
    const view = await adminSafety(rt);
    expect(view.answers.find((a) => a.purpose === "decision")).toEqual({ purpose: "decision", calls: 2, attempts: 4, empty: 1, retried: 1 });
    expect(view.answers.map((a) => a.purpose)).not.toContain("chat");
  });
});
