// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { getAddress, type Address } from "viem";
import * as schema from "@/lib/db/schema";
import { addUser, testDb } from "@/test/helperDb";
import { FakeChain, addr } from "@/test/fakeChain";
import { paymentsConfig, resetPaymentsConfig } from "@/lib/payments/config";
import { setChainClient } from "@/lib/payments/chain";
import { syncWallets } from "@/lib/payments/wallets";
import { post } from "@/lib/payments/ledger";
import { GET as wallet } from "./route";
import { GET as payments } from "../payments/route";
import { POST as check } from "../deposits/check/route";
import { POST as withdraw } from "../withdrawals/route";

// The wallet, deposit check and withdrawal routes, on a fake chain.

const state = vi.hoisted(() => ({ db: null as unknown, user: null as unknown, opts: [] as unknown[] }));
vi.mock("@/lib/db", () => ({ db: new Proxy({}, { get: (_, key) => Reflect.get(state.db as object, key) }) }));
vi.mock("@/lib/auth-route", () => ({
  getUserFromRequest: async (_req: Request, opts?: unknown) => {
    state.opts.push(opts);
    return state.user;
  },
}));

const TREASURY = addr(0x7ea5);
const MAYA_WALLET = addr(0xa11ce);

let client: PGlite;
let db: PgliteDatabase<typeof schema>;
let maya: schema.User;
let chain: FakeChain;
let usdc: Address;
let n = 0;

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
  await client.exec("delete from withdrawals; delete from deposits; delete from chain_cursors; delete from ledger_entries; delete from balances; delete from linked_wallets; delete from users;");
  vi.stubEnv("TREASURY_ADDRESS", TREASURY);
  vi.stubEnv("DEPOSIT_CONFIRMATIONS", "5");
  resetPaymentsConfig();
  usdc = paymentsConfig().currencies.USDC.token!;
  chain = new FakeChain();
  setChainClient(chain);
  // A fresh user each time, so the check's cooldown starts over.
  maya = await addUser(db, `maya${++n}`);
  await syncWallets(maya.id, [{ address: MAYA_WALLET, embedded: true }]);
  state.user = maya;
  state.opts = [];
});

describe("the wallet routes", () => {
  it("say what payments take, in public", async () => {
    const body = await (await payments()).json();
    expect(body.payments).toMatchObject({ enabled: true, networkLabel: "Base Sepolia", chainId: 84532, treasury: getAddress(TREASURY), confirmations: 5 });
    expect(body.payments.currencies).toEqual([{ code: "USDC", decimals: 6, token: usdc, withdrawMin: "5000000" }]);
  });

  it("show the user's own wallet, synced with Privy, and nothing to anyone signed out", async () => {
    const body = await (await wallet(req("/api/wallet"))).json();
    expect(state.opts).toEqual([{ wallets: true }]);
    expect(body.wallet).toEqual({
      balances: [{ currency: "USDC", available: "0", held: "0" }],
      earned: [{ currency: "USDC", amount: "0" }],
      wallets: [{ address: MAYA_WALLET.toLowerCase(), embedded: true }],
      deposits: [],
      withdrawals: [],
    });
    state.user = null;
    expect((await wallet(req("/api/wallet"))).status).toBe(401);
    expect((await check(req("/api/deposits/check", {}))).status).toBe(401);
    expect((await withdraw(req("/api/withdrawals", {}))).status).toBe(401);
  });

  it("check for my deposit: runs the watcher at once and credits the user", async () => {
    await check(req("/api/deposits/check", {})); // the first scan sets the starting block
    const log = chain.transfer(usdc, MAYA_WALLET, TREASURY, 7_500_000n);
    chain.mine(2);
    const seen = await (await check(req("/api/deposits/check", {}))).json();
    // Within the cooldown nothing ran.
    expect(seen.wallet.deposits).toEqual([]);

    maya = await addUser(db, `maya${++n}`);
    await syncWallets(maya.id, [{ address: MAYA_WALLET, embedded: true }]);
    state.user = maya;
    const confirming = await (await check(req("/api/deposits/check", {}))).json();
    expect(confirming.wallet.deposits).toMatchObject([{ status: "confirming", amount: "7500000", txHash: log.txHash }]);
    chain.mine(2);
    maya = await addUser(db, `maya${++n}`);
    await syncWallets(maya.id, [{ address: MAYA_WALLET, embedded: true }]);
    state.user = maya;
    const credited = await (await check(req("/api/deposits/check", {}))).json();
    expect(credited.wallet.deposits).toMatchObject([{ status: "credited", amount: "7500000" }]);
    expect(credited.wallet.balances).toEqual([{ currency: "USDC", available: "7500000", held: "0" }]);
  });

  it("withdraw: refuses what the rules refuse, and debits a good request once", async () => {
    const ask = (body: Record<string, unknown>) => withdraw(req("/api/withdrawals", { currency: "USDC", amount: "6000000", to: MAYA_WALLET, key: "key-00001", ...body }));
    expect((await ask({ amount: "1.5" })).status).toBe(400);
    expect(await (await ask({})).json()).toEqual({ error: "Not enough balance for that withdrawal." });

    await post(db as never, { userId: maya.id, currency: "USDC", kind: "deposit", amount: 10_000_000n, key: "fund" });
    expect(await (await ask({ amount: "4999999" })).json()).toEqual({ error: "The smallest withdrawal is 5.00 USDC." });
    expect(await (await ask({ to: addr(0xbad) })).json()).toEqual({ error: "Withdraw to one of your linked wallets." });
    const first = await (await ask({})).json();
    const again = await (await ask({})).json();
    expect(first.withdrawal).toMatchObject({ status: "awaiting_approval", amount: "6000000", to: MAYA_WALLET.toLowerCase() });
    expect(again.withdrawal.id).toBe(first.withdrawal.id);
    expect(again.wallet.balances).toEqual([{ currency: "USDC", available: "4000000", held: "0" }]);
    expect(again.wallet.withdrawals).toHaveLength(1);
  });

  it("are closed while payments are off", async () => {
    vi.stubEnv("TREASURY_ADDRESS", "");
    resetPaymentsConfig();
    expect((await check(req("/api/deposits/check", {}))).status).toBe(503);
    expect((await withdraw(req("/api/withdrawals", { currency: "USDC", amount: "6000000", to: MAYA_WALLET, key: "key-00002" }))).status).toBe(503);
    expect((await (await payments()).json()).payments).toMatchObject({ enabled: false, treasury: null, currencies: [] });
  });
});
