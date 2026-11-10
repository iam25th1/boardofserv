// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import * as schema from "@/lib/db/schema";
import { addUser, testDb } from "@/test/helperDb";
import { installed, publishedAgent, testRuntime } from "@/test/runtimeFixtures";
import { post } from "@/lib/payments/ledger";
import type { SpendingDTO } from "@/lib/types";
import { GET, POST } from "./route";

// The allowance through its route: its renter only (a 404 for anyone else,
// a 401 signed out), a top up or withdrawal with an amount as typed and a
// key, and refusals said plainly.

const state = vi.hoisted(() => ({ db: null as unknown, user: null as unknown }));
vi.mock("@/lib/db", () => ({ db: new Proxy({}, { get: (_, key) => Reflect.get(state.db as object, key) }) }));
vi.mock("@/lib/auth-route", () => ({ getUserFromRequest: async () => state.user }));

let client: PGlite;
let db: PgliteDatabase<typeof schema>;
let renter: schema.User;
let other: schema.User;
let id: string;

beforeAll(async () => {
  ({ client, db } = await testDb());
  state.db = db;
  renter = await addUser(db, "allowance.route.renter");
  other = await addUser(db, "allowance.route.other");
  const rt = testRuntime(db);
  id = (await installed(rt, renter, await publishedAgent(db, renter))).id;
  await post(db as never, { userId: renter.id, currency: "USDC", kind: "deposit", amount: 10_000_000n, key: "fund:allowance-route" });
});
afterAll(async () => client.close());

const req = (body?: unknown) => new Request(`http://localhost/api/installations/${id}/allowance`, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const p = { get params() { return Promise.resolve({ id }); } };

describe("the allowance route", () => {
  it("is the renter's alone", async () => {
    state.user = null;
    expect((await GET(req(), p)).status).toBe(401);
    expect((await POST(req({ action: "topup", amount: "1", key: "abcdefgh1" }), p)).status).toBe(401);
    state.user = other;
    expect((await GET(req(), p)).status).toBe(404);
    expect((await POST(req({ action: "topup", amount: "1", key: "abcdefgh2" }), p)).status).toBe(404);
    expect((await GET(new Request("http://localhost/api/installations/x/allowance"), { params: Promise.resolve({ id: "x" }) })).status).toBe(404);
  });

  it("tops up and withdraws, once per key", async () => {
    state.user = renter;
    const up = await POST(req({ action: "topup", amount: "2.50", key: "abcdefgh3" }), p);
    expect(up.status).toBe(200);
    expect(((await up.json()) as { spending: SpendingDTO }).spending).toMatchObject({ allowance: { available: "2500000", held: "0" }, balanceAvailable: "7500000" });
    await POST(req({ action: "topup", amount: "2.50", key: "abcdefgh3" }), p);
    const back = (await (await POST(req({ action: "withdraw", amount: "all", key: "abcdefgh4" }), p)).json()) as { spending: SpendingDTO };
    expect(back.spending.allowance.available).toBe("0");
    expect(back.spending.balanceAvailable).toBe("10000000");
  });

  it("refuses what it can't read, and what the balance can't cover", async () => {
    state.user = renter;
    for (const bad of [null, {}, { action: "steal", amount: "1", key: "abcdefgh5" }, { action: "topup", amount: "1", key: "x" }, { action: "topup", amount: "1", key: "../../../etc" }]) {
      expect((await POST(req(bad), p)).status, JSON.stringify(bad)).toBe(400);
    }
    for (const amount of ["-1", "0", "abc", "1.1234567", "all", "1e3"]) {
      expect((await POST(req({ action: "topup", amount, key: "abcdefgh6" }), p)).status, amount).toBe(400);
    }
    const short = await POST(req({ action: "topup", amount: "50", key: "abcdefgh7" }), p);
    expect(short.status).toBe(409);
    expect(((await short.json()) as { error: string }).error).toMatch(/doesn't cover/);
  });
});
