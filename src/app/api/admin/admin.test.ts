// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import { generatePrivateKey } from "viem/accounts";
import * as schema from "@/lib/db/schema";
import { addUser, testDb } from "@/test/helperDb";
import { FakeChain, addr } from "@/test/fakeChain";
import { paymentsConfig, resetPaymentsConfig } from "@/lib/payments/config";
import { setChainClient } from "@/lib/payments/chain";
import { balancesOf, post } from "@/lib/payments/ledger";
import { signerFromKey } from "@/lib/payments/signer";
import { syncWallets } from "@/lib/payments/wallets";
import { requestWithdrawal } from "@/lib/payments/withdrawals";
import { GET as admin } from "./route";
import { POST as pause } from "./pause/route";
import { POST as decide } from "./withdrawals/[id]/route";
import { GET as account } from "../account/route";

// The admin routes: only for ADMIN_USER_IDS, against a fake chain.

const state = vi.hoisted(() => ({ db: null as unknown, user: null as unknown }));
vi.mock("@/lib/db", () => ({ db: new Proxy({}, { get: (_, key) => Reflect.get(state.db as object, key) }) }));
vi.mock("@/lib/auth-route", () => ({ getUserFromRequest: async () => state.user }));

const KEY = generatePrivateKey();
const TREASURY = signerFromKey(KEY).address;
const MAYA_WALLET = addr(0xa11ce);

let client: PGlite;
let db: PgliteDatabase<typeof schema>;
let boss: schema.User;
let maya: schema.User;
let chain: FakeChain;

const req = (url: string, body?: unknown) =>
  new Request(`http://localhost${url}`, { method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

beforeAll(async () => {
  ({ client, db } = await testDb());
  state.db = db;
});
afterAll(async () => {
  vi.unstubAllEnvs();
  resetPaymentsConfig();
  setChainClient(null);
  await client.close();
});

beforeEach(async () => {
  await client.exec("delete from withdrawals; delete from payment_settings; delete from deposits; delete from ledger_entries; delete from balances; delete from linked_wallets; delete from users;");
  boss = await addUser(db, "boss");
  maya = await addUser(db, "maya.rivera", "maya_r");
  vi.stubEnv("TREASURY_ADDRESS", TREASURY);
  vi.stubEnv("ADMIN_USER_IDS", `someone-else, ${boss.privyUserId}`);
  vi.stubEnv("WITHDRAW_AUTO_MAX_USDC", "0");
  resetPaymentsConfig();
  chain = new FakeChain();
  setChainClient(chain);
  await syncWallets(maya.id, [{ address: MAYA_WALLET, embedded: false }]);
  await post(db as never, { userId: maya.id, currency: "USDC", kind: "deposit", amount: 50_000_000n, key: "fund" });
  await post(db as never, { userId: null, currency: "USDC", kind: "platform_fee", amount: 2_000_000n, key: "fee" });
  chain.setBalance(paymentsConfig().currencies.USDC.token!, TREASURY, 60_000_000n);
});

describe("the admin routes", () => {
  it("are for admins only: 401 signed out, 404 for anyone else", async () => {
    state.user = null;
    expect((await admin(req("/api/admin"))).status).toBe(401);
    state.user = maya;
    expect((await admin(req("/api/admin"))).status).toBe(404);
    expect((await pause(req("/api/admin/pause", { paused: true }))).status).toBe(404);
    expect((await (await account(req("/api/account"))).json()).admin).toBe(false);
    state.user = boss;
    expect((await admin(req("/api/admin"))).status).toBe(200);
    expect((await (await account(req("/api/account"))).json()).admin).toBe(true);
  });

  it("shows the treasury against what it owes, by handle, with no email", async () => {
    await requestWithdrawal({ userId: maya.id, currency: "USDC", amount: 10_000_000n, to: MAYA_WALLET, key: "w" });
    await db.insert(schema.deposits).values({
      chainId: 84532,
      txHash: `0x${"cd".repeat(32)}`,
      logIndex: 0,
      blockNumber: 5n,
      currency: "USDC",
      fromAddress: addr(0xbad).toLowerCase(),
      amount: "3000000",
      status: "unmatched",
    });
    state.user = boss;
    const res = await admin(req("/api/admin"));
    const text = await res.text();
    const { admin: a } = JSON.parse(text);
    // Owed: 40 left in Maya's balance plus the 10 asked for, not yet paid out.
    expect(a.currencies[0]).toMatchObject({ code: "USDC", treasury: "60000000", owed: "50000000", difference: "10000000", fees: "2000000" });
    expect(a.approvals).toHaveLength(1);
    expect(a.approvals[0]).toMatchObject({ maker: "maya_r", amount: "10000000", status: "awaiting_approval" });
    expect(a.unmatched).toHaveLength(1);
    expect(a.paused).toBe(false);
    expect(a.signer).toMatch(/TREASURY_PRIVATE_KEY is not set/);
    expect(text).not.toMatch(/maya\.rivera|mayarivera|example\.com/);
  });

  it("approves, rejects and pauses", async () => {
    const one = await requestWithdrawal({ userId: maya.id, currency: "USDC", amount: 10_000_000n, to: MAYA_WALLET, key: "a" });
    const two = await requestWithdrawal({ userId: maya.id, currency: "USDC", amount: 5_000_000n, to: MAYA_WALLET, key: "b" });
    state.user = maya;
    expect((await decide(req(`/api/admin/withdrawals/${one.id}`, { action: "approve" }), { params: { id: one.id } })).status).toBe(404);
    state.user = boss;
    const approved = await decide(req(`/api/admin/withdrawals/${one.id}`, { action: "approve" }), { params: { id: one.id } });
    expect(approved.status).toBe(200);
    expect((await decide(req(`/api/admin/withdrawals/${one.id}`, { action: "approve" }), { params: { id: one.id } })).status).toBe(409);
    expect((await decide(req(`/api/admin/withdrawals/${two.id}`, { action: "reject" }), { params: { id: two.id } })).status).toBe(200);
    expect((await decide(req(`/api/admin/withdrawals/${one.id}`, { action: "fail" }), { params: { id: one.id } })).status).toBe(409);
    expect((await decide(req("/api/admin/withdrawals/nope", { action: "approve" }), { params: { id: "nope" } })).status).toBe(400);
    const statuses = Object.fromEntries((await db.select().from(schema.withdrawals)).map((w) => [w.id, w.status]));
    expect(statuses).toEqual({ [one.id]: "queued", [two.id]: "rejected" });
    expect((await balancesOf(maya.id)).USDC.available).toBe(40_000_000n);

    const paused = await (await pause(req("/api/admin/pause", { paused: true }))).json();
    expect(paused.admin.paused).toBe(true);
    const [setting] = await db.select().from(schema.paymentSettings).where(eq(schema.paymentSettings.key, "payouts_paused"));
    expect(setting).toMatchObject({ value: "true", updatedBy: boss.id });
    expect((await (await pause(req("/api/admin/pause", { paused: false }))).json()).admin.paused).toBe(false);
  });
});
