// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import * as schema from "@/lib/db/schema";
import { addUser, testDb } from "@/test/helperDb";
import { installed, publishedAgent, testRuntime } from "@/test/runtimeFixtures";
import { suggestPayee } from "@/lib/spending/payees";
import type { SpendingDTO } from "@/lib/types";
import { POST } from "./route";

// Payees through their route: the renter's alone, a name and an address
// checked, a suggestion confirmed only here, with a name.

const state = vi.hoisted(() => ({ db: null as unknown, user: null as unknown }));
vi.mock("@/lib/db", () => ({ db: new Proxy({}, { get: (_, key) => Reflect.get(state.db as object, key) }) }));
vi.mock("@/lib/auth-route", () => ({ getUserFromRequest: async () => state.user }));

let client: PGlite;
let db: PgliteDatabase<typeof schema>;
let renter: schema.User;
let other: schema.User;
let id: string;
const ADDR = "0x0000000000000000000000000000000000000000";

beforeAll(async () => {
  ({ client, db } = await testDb());
  state.db = db;
  renter = await addUser(db, "payees.route.renter");
  other = await addUser(db, "payees.route.other");
  id = (await installed(testRuntime(db), renter, await publishedAgent(db, renter))).id;
});
afterAll(async () => client.close());

const call = (body: unknown) => POST(new Request(`http://localhost/api/installations/${id}/payees`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), { params: Promise.resolve({ id }) });

describe("the payees route", () => {
  it("is the renter's alone", async () => {
    state.user = null;
    expect((await call({ action: "save", label: "Mill", address: ADDR })).status).toBe(401);
    state.user = other;
    expect((await call({ action: "save", label: "Mill", address: ADDR })).status).toBe(404);
  });

  it("saves, refuses bad ones, confirms a suggestion and removes", async () => {
    state.user = renter;
    for (const bad of [null, { action: "save" }, { action: "save", label: "Mill", address: 5 }, { action: "pay", payeeId: "x" }, { action: "confirm", payeeId: "x" }]) {
      expect((await call(bad)).status, JSON.stringify(bad)).toBe(400);
    }
    expect((await call({ action: "save", label: "<b>Mill</b>", address: ADDR })).status).toBe(400);
    expect((await call({ action: "save", label: "Mill", address: ADDR.replace("dEe", "dee") })).status).toBe(400);
    const saved = (await (await call({ action: "save", label: "Mill", address: ADDR.toLowerCase() })).json()) as { spending: SpendingDTO };
    expect(saved.spending.payees).toEqual([expect.objectContaining({ label: "Mill", address: ADDR, status: "active", paidBefore: false })]);
    const s = (await suggestPayee(testRuntime(db), id, renter.id, `0x${"7".repeat(40)}`, "Fabric restock"))!;
    expect((await call({ action: "confirm", payeeId: s.id, label: "" })).status).toBe(400);
    state.user = other;
    expect((await call({ action: "confirm", payeeId: s.id, label: "Mine" })).status).toBe(404);
    state.user = renter;
    const ok = (await (await call({ action: "confirm", payeeId: s.id, label: "Dye works" })).json()) as { spending: SpendingDTO };
    expect(ok.spending.payees.map((p) => [p.label, p.status]).sort()).toEqual([
      ["Dye works", "active"],
      ["Mill", "active"],
    ]);
    expect((await call({ action: "remove", payeeId: "00000000-0000-4000-8000-000000000000" })).status).toBe(404);
    expect((await call({ action: "remove", payeeId: s.id })).status).toBe(200);
  });
});
