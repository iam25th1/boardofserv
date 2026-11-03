// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import { generatePrivateKey } from "viem/accounts";
import { keccak256, parseTransaction, type Address } from "viem";
import * as schema from "@/lib/db/schema";
import { addUser, testDb } from "@/test/helperDb";
import { FakeChain, addr } from "@/test/fakeChain";
import { readPaymentsConfig, type PaymentsConfig } from "./config";
import { balancesOf, ledgerTotal, post } from "./ledger";
import { signerFromKey, treasurySigner, type PayoutSigner } from "./signer";
import { syncWallets } from "./wallets";
import {
  approveWithdrawal,
  failStuckWithdrawal,
  reconcilePayouts,
  rejectWithdrawal,
  requestWithdrawal,
  RESEND_MS,
  sendNextPayout,
  setPayoutsPaused,
  STUCK_MS,
} from "./withdrawals";

// Withdrawals against a fake chain that decodes really signed transactions.
// No RPC call is made.

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/db", () => ({ db: new Proxy({}, { get: (_, key) => Reflect.get(state.db as object, key) }) }));

const KEY = generatePrivateKey();
const signer: PayoutSigner = signerFromKey(KEY);
const TREASURY = signer.address;
const MAYA_WALLET = addr(0xa11ce);
const USDC = (n: number) => BigInt(Math.round(n * 100)) * 10_000n;

let client: PGlite;
let db: PgliteDatabase<typeof schema>;
let maya: schema.User;
let chain: FakeChain;
let config: PaymentsConfig;
let token: Address;
let keys = 0;

beforeAll(async () => {
  ({ client, db } = await testDb());
  state.db = db;
});
afterAll(async () => client.close());

beforeEach(async () => {
  await client.exec("delete from withdrawals; delete from payment_settings; delete from ledger_entries; delete from balances; delete from linked_wallets; delete from users;");
  maya = await addUser(db, "maya");
  await syncWallets(maya.id, [{ address: MAYA_WALLET, embedded: false }]);
  await post(db as never, { userId: maya.id, currency: "USDC", kind: "deposit", amount: USDC(100), key: "fund" });
  config = readPaymentsConfig({
    TREASURY_ADDRESS: TREASURY,
    DEPOSIT_CONFIRMATIONS: "5",
    WITHDRAW_MIN_USDC: "5",
    WITHDRAW_AUTO_MAX_USDC: "20",
    WITHDRAW_DAILY_CAP_USDC: "30",
  });
  token = config.currencies.USDC.token!;
  chain = new FakeChain(config.chainId);
  chain.setBalance(token, TREASURY, USDC(1000));
});

const ask = (amount: bigint, o: { to?: string; key?: string } = {}) =>
  requestWithdrawal({ userId: maya.id, currency: "USDC", amount, to: o.to ?? MAYA_WALLET, key: o.key ?? `k${++keys}` }, {}, config);
const row = async (id: string) => (await db.select().from(schema.withdrawals).where(eq(schema.withdrawals.id, id)))[0]!;
const available = async () => (await balancesOf(maya.id)).USDC.available;
async function balanced() {
  const b = (await balancesOf(maya.id)).USDC;
  expect(await ledgerTotal(maya.id, "USDC")).toBe(b.available + b.held);
}

describe("asking for a withdrawal", () => {
  it("refuses less than the minimum, an unlinked wallet and more than the balance, and debits nothing", async () => {
    await expect(ask(USDC(4.99))).rejects.toThrow("The smallest withdrawal is 5.00 USDC.");
    await expect(ask(USDC(10), { to: addr(0xbad) })).rejects.toThrow("Withdraw to one of your linked wallets.");
    await expect(ask(USDC(100.01))).rejects.toThrow("Not enough balance for that withdrawal.");
    await expect(ask(USDC(5))).resolves.toBeTruthy();
    expect(await available()).toBe(USDC(95));
    expect(await db.select().from(schema.withdrawals)).toHaveLength(1);
    await balanced();
  });

  it("keeps SERV withdrawals closed until the owner sets a minimum", async () => {
    const serv = readPaymentsConfig({ TREASURY_ADDRESS: TREASURY, SERV_TOKEN_ADDRESS: addr(0x5e7), SERV_TOKEN_DECIMALS: "18" });
    expect(serv.currencies.SERV.enabled).toBe(true);
    await expect(requestWithdrawal({ userId: maya.id, currency: "SERV", amount: 1n, to: MAYA_WALLET, key: "s" }, {}, serv)).rejects.toThrow(
      "SERV withdrawals aren't open yet.",
    );
  });

  it("debits on request with a pending row, once per key", async () => {
    const a = await ask(USDC(10), { key: "same" });
    const b = await ask(USDC(10), { key: "same" });
    expect(b.id).toBe(a.id);
    expect(await available()).toBe(USDC(90));
    const ledger = await db.select().from(schema.ledgerEntries).where(eq(schema.ledgerEntries.kind, "withdrawal"));
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ amount: "-10000000", idempotencyKey: `withdrawal:${a.id}`, referenceId: a.id });
  });

  it("pays below the automatic limit without approval, until the day's cap is reached", async () => {
    expect(await ask(USDC(15))).toMatchObject({ status: "queued", auto: true });
    expect(await ask(USDC(15))).toMatchObject({ status: "queued", auto: true });
    // 30 is the cap: the next waits for an admin.
    const third = await ask(USDC(5));
    expect(third).toMatchObject({ status: "awaiting_approval", auto: false });
    expect(third.reason).toMatch(/automatic payouts are used up/);
    // At or over the automatic limit, always.
    expect(await ask(USDC(20))).toMatchObject({ status: "awaiting_approval", reason: expect.stringMatching(/Over the automatic limit/) });
  });
});

describe("payouts", () => {
  it("records the hash and nonce before sending, sends once, and reconciles on confirmation", async () => {
    const w = await ask(USDC(12));
    chain.sendFails = true;
    expect(await sendNextPayout(chain, signer, config)).toBe(w.id);
    const sent = await row(w.id);
    expect(sent.status).toBe("broadcast");
    expect(sent.nonce).toBe(0);
    // The hash is the signed bytes' own, recorded though the send failed.
    expect(sent.txHash).toBe(keccak256(sent.rawTx as `0x${string}`));
    expect(chain.sent).toHaveLength(0);

    // The resend is the same transaction: same bytes, same nonce.
    chain.sendFails = false;
    await reconcilePayouts(chain, config, new Date(Date.now() + RESEND_MS + 1000));
    expect(chain.sent).toEqual([sent.rawTx]);
    // viem leaves out a nonce of 0 when it parses.
    expect(parseTransaction(chain.sent[0]!).nonce ?? 0).toBe(0);

    chain.mine(1);
    await reconcilePayouts(chain, config);
    expect((await row(w.id)).status).toBe("broadcast"); // one confirmation of five
    chain.mine(4);
    await reconcilePayouts(chain, config);
    expect((await row(w.id)).status).toBe("paid");
    expect(await chain.tokenBalance(token, MAYA_WALLET)).toBe(USDC(12));
    expect(await available()).toBe(USDC(88));
    await balanced();
  });

  it("never sends a second payout while one is in flight", async () => {
    const a = await ask(USDC(6));
    const b = await ask(USDC(7));
    expect(await sendNextPayout(chain, signer, config)).toBe(a.id);
    expect(await sendNextPayout(chain, signer, config)).toBeNull();
    expect(await sendNextPayout(chain, signer, config)).toBeNull();
    expect(chain.sent).toHaveLength(1);
    expect((await row(b.id)).status).toBe("queued");
    // The database refuses a second payout in flight, whatever the code does.
    await expect(
      db.update(schema.withdrawals).set({ status: "broadcast", nonce: 9, txHash: "0x1" }).where(eq(schema.withdrawals.id, b.id)),
    ).rejects.toThrow(/withdrawals_one_in_flight/);

    chain.mine(5);
    await reconcilePayouts(chain, config);
    expect(await sendNextPayout(chain, signer, config)).toBe(b.id);
    expect((await row(b.id)).nonce).toBe(1);
    chain.mine(5);
    await reconcilePayouts(chain, config);
    expect([(await row(a.id)).status, (await row(b.id)).status]).toEqual(["paid", "paid"]);
    expect(await chain.tokenBalance(token, MAYA_WALLET)).toBe(USDC(13));
  });

  it("gives the amount back once when the transfer reverts", async () => {
    const w = await ask(USDC(10));
    await sendNextPayout(chain, signer, config);
    chain.revertNext = true;
    chain.mine(5);
    await reconcilePayouts(chain, config);
    await reconcilePayouts(chain, config);
    expect((await row(w.id)).status).toBe("reverted");
    expect(await available()).toBe(USDC(100));
    const back = await db.select().from(schema.ledgerEntries).where(eq(schema.ledgerEntries.kind, "withdrawal_reversal"));
    expect(back).toHaveLength(1);
    expect(back[0]).toMatchObject({ amount: "10000000", idempotencyKey: `withdrawal:${w.id}:reversal` });
    expect(await chain.tokenBalance(token, MAYA_WALLET)).toBe(0n);
    await balanced();
  });

  it("waits for an admin above the limit: approved is paid, rejected is given back", async () => {
    const big = await ask(USDC(25));
    const other = await ask(USDC(40));
    expect(await sendNextPayout(chain, signer, config)).toBeNull();
    const admin = await addUser(db, "admin");
    expect(await approveWithdrawal(big.id, admin.id)).toBe(true);
    expect(await approveWithdrawal(big.id, admin.id)).toBe(false);
    expect(await rejectWithdrawal(other.id, admin.id)).toBe(true);
    expect(await rejectWithdrawal(other.id, admin.id)).toBe(false);
    expect((await row(other.id)).status).toBe("rejected");
    expect(await available()).toBe(USDC(75));

    expect(await sendNextPayout(chain, signer, config)).toBe(big.id);
    chain.mine(5);
    await reconcilePayouts(chain, config);
    expect((await row(big.id)).status).toBe("paid");
    expect(await chain.tokenBalance(token, MAYA_WALLET)).toBe(USDC(25));
    await balanced();
  });

  it("sends nothing while payouts are paused, not even a resend", async () => {
    const admin = await addUser(db, "admin");
    const w = await ask(USDC(8));
    await setPayoutsPaused(true, admin.id);
    expect(await sendNextPayout(chain, signer, config)).toBeNull();
    await setPayoutsPaused(false, admin.id);
    chain.sendFails = true;
    expect(await sendNextPayout(chain, signer, config)).toBe(w.id);
    chain.sendFails = false;
    await setPayoutsPaused(true, admin.id);
    await reconcilePayouts(chain, config, new Date(Date.now() + RESEND_MS + 1000));
    expect(chain.sent).toHaveLength(0);
  });

  it("waits while the treasury can't cover the payout", async () => {
    chain.setBalance(token, TREASURY, USDC(1));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await ask(USDC(9));
    expect(await sendNextPayout(chain, signer, config)).toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("lets an admin mark a payout failed only once its nonce went to another transaction", async () => {
    const admin = await addUser(db, "admin");
    const w = await ask(USDC(10));
    chain.sendFails = true;
    await sendNextPayout(chain, signer, config);
    // Too soon, and the nonce is still free: not stuck.
    expect(await failStuckWithdrawal(w.id, admin.id, chain, config)).toBe(false);
    await db.update(schema.withdrawals).set({ broadcastAt: new Date(Date.now() - STUCK_MS - 1000) }).where(eq(schema.withdrawals.id, w.id));
    expect(await failStuckWithdrawal(w.id, admin.id, chain, config)).toBe(false);
    chain.useNonce(TREASURY);
    expect(await failStuckWithdrawal(w.id, admin.id, chain, config)).toBe(true);
    expect((await row(w.id)).status).toBe("failed");
    expect(await available()).toBe(USDC(100));
    await balanced();
  });
});

describe("the treasury key", () => {
  it("signs only for TREASURY_ADDRESS, and no problem message carries the key", () => {
    expect("address" in treasurySigner(config, { TREASURY_PRIVATE_KEY: KEY })).toBe(true);
    const other = generatePrivateKey();
    for (const env of [{}, { TREASURY_PRIVATE_KEY: "nope" }, { TREASURY_PRIVATE_KEY: other }]) {
      const s = treasurySigner(config, env);
      expect("problem" in s).toBe(true);
      const text = JSON.stringify(s);
      expect(text).not.toContain(other.slice(2));
      expect(text).not.toContain(KEY.slice(2));
    }
  });
});
