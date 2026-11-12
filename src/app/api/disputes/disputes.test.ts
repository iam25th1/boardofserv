// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import * as schema from "@/lib/db/schema";
import { addUser, testDb } from "@/test/helperDb";
import { installed, publishedAgent, testRuntime } from "@/test/runtimeFixtures";
import { savePayee } from "@/lib/spending/payees";
import type { DisputableDTO, DisputeDTO } from "@/lib/types";
import { GET, POST } from "./route";

// Disputes through their route: the signed in renter's own alone, a
// payment or a week with a reason and a note, refusals said plainly.

const state = vi.hoisted(() => ({ db: null as unknown, user: null as unknown }));
vi.mock("@/lib/db", () => ({ db: new Proxy({}, { get: (_, key) => Reflect.get(state.db as object, key) }) }));
vi.mock("@/lib/auth-route", () => ({ getUserFromRequest: async () => state.user }));

let client: PGlite;
let db: PgliteDatabase<typeof schema>;
let renter: schema.User;
let other: schema.User;
let paymentId: string;

beforeAll(async () => {
  ({ client, db } = await testDb());
  state.db = db;
  renter = await addUser(db, "disputes.route.renter");
  other = await addUser(db, "disputes.route.other");
  const rt = testRuntime(db);
  const p = await publishedAgent(db, renter);
  const inst = await installed(rt, renter, p);
  const payee = await savePayee(rt, renter, inst.id, { label: "Weftworks", address: "0xF3fA00a093b023929b8C0C3Af790E0dCaAcFE84b" });
  const now = new Date();
  const [row] = await db
    .insert(schema.agentPayments)
    .values({ key: "disputes:route", installationId: inst.id, agentId: p.agent.id, versionId: p.version.id, ownerUserId: renter.id, payeeId: payee.id, payeeLabel: "Weftworks", toAddress: payee.address, amount: "2000000", chainId: 84532, status: "confirmed", settledAt: now, createdAt: now, updatedAt: now })
    .returning();
  paymentId = row!.id;
});
afterAll(async () => client.close());

const req = (body?: unknown) => new Request("http://localhost/api/disputes", body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const NOTE = "The linen it paid for never came.";

describe("the disputes route", () => {
  it("is for the signed in, each their own", async () => {
    state.user = null;
    expect((await GET(req())).status).toBe(401);
    expect((await POST(req({ kind: "payment", id: paymentId, reason: "not_done", note: NOTE }))).status).toBe(401);
    state.user = other;
    expect(((await (await GET(req())).json()) as { disputable: DisputableDTO[] }).disputable).toEqual([]);
    expect((await POST(req({ kind: "payment", id: paymentId, reason: "not_done", note: NOTE }))).status).toBe(404);
  });

  it("opens a dispute of the renter's own payment, once", async () => {
    state.user = renter;
    const listed = (await (await GET(req())).json()) as { disputable: DisputableDTO[] };
    expect(listed.disputable.map((d) => [d.kind, d.id])).toEqual([["payment", paymentId]]);
    const made = await POST(req({ kind: "payment", id: paymentId, reason: "not_done", note: NOTE }));
    expect(made.status).toBe(201);
    expect(((await made.json()) as { disputes: DisputeDTO[] }).disputes[0]).toMatchObject({ kind: "payment", status: "open", note: NOTE, refund: "none" });
    expect((await POST(req({ kind: "payment", id: paymentId, reason: "not_done", note: NOTE }))).status).toBe(409);
  });

  it("refuses what it can't read", async () => {
    state.user = renter;
    for (const bad of [null, {}, { kind: "planet", id: paymentId, reason: "not_done", note: NOTE }, { kind: "payment", id: "x".repeat(200), reason: "not_done", note: NOTE }, { kind: "payment", id: paymentId, reason: "not_done", note: "x".repeat(1300) }]) {
      expect((await POST(req(bad))).status, JSON.stringify(bad).slice(0, 80)).toBe(400);
    }
  });
});
