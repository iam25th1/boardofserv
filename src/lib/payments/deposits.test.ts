// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import type { Address } from "viem";
import * as schema from "@/lib/db/schema";
import { addUser, testDb } from "@/test/helperDb";
import { FakeChain, addr } from "@/test/fakeChain";
import { readPaymentsConfig, type PaymentsConfig } from "./config";
import { RESCAN_BLOCKS, scanOnce } from "./deposits";
import { balancesOf, ledgerTotal } from "./ledger";
import { syncWallets } from "./wallets";

// The deposit watcher against a fake chain: no RPC call is made.

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/db", () => ({ db: new Proxy({}, { get: (_, key) => Reflect.get(state.db as object, key) }) }));

const TREASURY = addr(0x7ea5);
const MAYA_WALLET = addr(0xa11ce);
const STRANGER = addr(0xbad);

let client: PGlite;
let db: PgliteDatabase<typeof schema>;
let maya: schema.User;
let chain: FakeChain;
let config: PaymentsConfig;
let usdc: Address;

beforeAll(async () => {
  ({ client, db } = await testDb());
  state.db = db;
});
afterAll(async () => client.close());

beforeEach(async () => {
  await client.exec("delete from ledger_entries; delete from balances; delete from deposits; delete from chain_cursors; delete from linked_wallets; delete from users;");
  maya = await addUser(db, "maya");
  await syncWallets(maya.id, [{ address: MAYA_WALLET, embedded: false }]);
  config = readPaymentsConfig({ TREASURY_ADDRESS: TREASURY, DEPOSIT_CONFIRMATIONS: "5", DEPOSIT_SCAN_CHUNK: "50" });
  usdc = config.currencies.USDC.token!;
  chain = new FakeChain(config.chainId);
  chain.setDecimals(usdc, 6);
  // The first scan starts at the newest confirmed block.
  await scanOnce(chain, config);
});

const rows = () => db.select().from(schema.deposits);

describe("deposits", () => {
  it("credits a transfer from a linked wallet once, however often it is scanned", async () => {
    const log = chain.transfer(usdc, MAYA_WALLET, TREASURY, 5_000_000n);
    chain.mine(4);
    await scanOnce(chain, config);
    await scanOnce(chain, config);
    // Even scanned again from the start, as after losing the cursor.
    await client.exec("delete from chain_cursors");
    await scanOnce(chain, { ...config, startBlock: log.blockNumber - 10n });

    expect((await balancesOf(maya.id)).USDC.available).toBe(5_000_000n);
    expect(await ledgerTotal(maya.id, "USDC")).toBe(5_000_000n);
    const credited = await rows();
    expect(credited).toHaveLength(1);
    expect(credited[0]).toMatchObject({ status: "credited", userId: maya.id, amount: "5000000", txHash: log.txHash });
    const ledger = await db.select().from(schema.ledgerEntries);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]!.idempotencyKey).toBe(`deposit:${config.chainId}:${log.txHash}:${log.logIndex}`);
  });

  it("records a transfer from an unlinked wallet as unmatched and credits nobody", async () => {
    chain.transfer(usdc, STRANGER, TREASURY, 7_000_000n);
    chain.mine(10);
    await scanOnce(chain, config);
    const [row] = await rows();
    expect(row).toMatchObject({ status: "unmatched", userId: null, fromAddress: STRANGER.toLowerCase() });
    expect(await db.select().from(schema.ledgerEntries)).toHaveLength(0);
    expect((await balancesOf(maya.id)).USDC.available).toBe(0n);
  });

  it("waits for the confirmation depth: confirming at four, credited at five", async () => {
    const log = chain.transfer(usdc, MAYA_WALLET, TREASURY, 1_000_000n);
    chain.mine(3); // four confirmations
    await scanOnce(chain, config);
    expect((await rows())[0]).toMatchObject({ status: "confirming", userId: maya.id });
    expect((await balancesOf(maya.id)).USDC.available).toBe(0n);

    chain.mine(1); // five
    await scanOnce(chain, config);
    expect((await rows())[0]).toMatchObject({ status: "credited", txHash: log.txHash });
    expect((await balancesOf(maya.id)).USDC.available).toBe(1_000_000n);
  });

  it("resumes where it stopped, reading only the last stretch again", async () => {
    chain.mine(30);
    await scanOnce(chain, config);
    const [cursor] = await db.select().from(schema.chainCursors);
    expect(cursor!.block).toBe(chain.head - 4n);

    // A restart: a fresh chain client and config, the same database.
    const again = new FakeChain(config.chainId);
    again.head = chain.head + 20n;
    again.logs = chain.logs;
    await scanOnce(again, readPaymentsConfig({ TREASURY_ADDRESS: TREASURY, DEPOSIT_CONFIRMATIONS: "5", DEPOSIT_SCAN_CHUNK: "50" }));
    const ranges = again.calls.filter((c) => c.method === "transferLogs").map((c) => c.args[0] as { fromBlock: bigint; toBlock: bigint });
    // Not from the start: from RESCAN_BLOCKS below where it stopped, through
    // everything new, with nothing skipped.
    expect(ranges[0]!.fromBlock).toBe(cursor!.block - RESCAN_BLOCKS + 1n);
    for (let i = 1; i < ranges.length; i++) expect(ranges[i]!.fromBlock).toBe(ranges[i - 1]!.toBlock + 1n);
    const [after] = await db.select().from(schema.chainCursors);
    expect(after!.block).toBe(again.head - 4n);
  });

  it("marks a deposit that a reorg took away as dropped, never credited", async () => {
    const log = chain.transfer(usdc, MAYA_WALLET, TREASURY, 2_000_000n);
    chain.mine(1);
    await scanOnce(chain, config);
    expect((await rows())[0]!.status).toBe("confirming");
    chain.drop(log.txHash);
    chain.mine(10);
    await scanOnce(chain, config);
    // Still inside the stretch that is read again: not given up on yet.
    expect((await rows())[0]!.status).toBe("confirming");
    chain.mine(Number(RESCAN_BLOCKS));
    await scanOnce(chain, config);
    expect((await rows())[0]!.status).toBe("dropped");
    expect((await balancesOf(maya.id)).USDC.available).toBe(0n);
  });

  it("credits nothing in a token whose decimals differ from the config", async () => {
    // Another chain id, so the check runs again in this process.
    const wrong = new FakeChain(1);
    wrong.head = chain.head;
    wrong.setDecimals(usdc, 18);
    wrong.transfer(usdc, MAYA_WALLET, TREASURY, 5n);
    wrong.mine(10);
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const config18 = { ...config, chainId: 1 } as PaymentsConfig;
    await scanOnce(wrong, config18);
    expect(errors).toHaveBeenCalled();
    errors.mockRestore();
    expect(await rows()).toHaveLength(0);
  });

  it("ignores zero transfers and the treasury sending to itself", async () => {
    chain.transfer(usdc, MAYA_WALLET, TREASURY, 0n);
    chain.transfer(usdc, TREASURY, TREASURY, 9n);
    chain.mine(10);
    await scanOnce(chain, config);
    expect(await rows()).toHaveLength(0);
  });

  it("matches only wallets Privy lists for the user, and follows a wallet that moved", async () => {
    const sam = await addUser(db, "sam");
    // Maya unlinks it in Privy and Sam links it.
    await syncWallets(maya.id, []);
    await syncWallets(sam.id, [{ address: MAYA_WALLET, embedded: false }]);
    chain.transfer(usdc, MAYA_WALLET, TREASURY, 3_000_000n);
    chain.mine(10);
    await scanOnce(chain, config);
    expect((await balancesOf(sam.id)).USDC.available).toBe(3_000_000n);
    expect((await balancesOf(maya.id)).USDC.available).toBe(0n);
    const wallets = await db.select().from(schema.linkedWallets).where(eq(schema.linkedWallets.userId, maya.id));
    expect(wallets).toHaveLength(0);
  });

  it("credits a deposit a stale node answered with no logs the first time", async () => {
    const log = chain.transfer(usdc, MAYA_WALLET, TREASURY, 4_000_000n);
    chain.mine(10);
    // A node that lags: a whole scan's answers have no logs.
    const real = chain.transferLogs.bind(chain);
    let stale = true;
    chain.transferLogs = async (q) => (stale ? [] : real(q));
    await scanOnce(chain, config);
    expect(await rows()).toHaveLength(0);
    stale = false;
    chain.mine(2);
    await scanOnce(chain, config);
    expect((await rows())[0]).toMatchObject({ status: "credited", txHash: log.txHash });
    expect((await balancesOf(maya.id)).USDC.available).toBe(4_000_000n);
  });

  it("asks who owns the sending wallet, and settles nothing when it can't be asked", async () => {
    const sam = await addUser(db, "sam");
    chain.transfer(usdc, addr(0x5a11), TREASURY, 2_000_000n);
    chain.mine(10);
    const down = async () => {
      throw new Error("privy is down");
    };
    await expect(scanOnce(chain, config, down)).rejects.toThrow("privy is down");
    expect(await rows()).toHaveLength(0);
    // Privy says the wallet is Sam's, though nothing here knew it yet.
    await scanOnce(chain, config, async (a) => (a === addr(0x5a11).toLowerCase() ? sam.id : null));
    expect((await rows())[0]).toMatchObject({ status: "credited", userId: sam.id });
    expect((await balancesOf(sam.id)).USDC.available).toBe(2_000_000n);
  });
});
