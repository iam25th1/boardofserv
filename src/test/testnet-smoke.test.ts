// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { generatePrivateKey, privateKeyToAddress } from "viem/accounts";
import * as schema from "@/lib/db/schema";
import { readPaymentsConfig } from "@/lib/payments/config";
import { syncWallets } from "@/lib/payments/wallets";
import { addUser, testDb } from "./helperDb";
import { FakeChain, addr } from "./fakeChain";
import { runSmoke } from "../../scripts/testnet-smoke";

// The owner's testnet smoke script, run start to finish against a fake Base
// Sepolia. Nothing here reaches a real chain.

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/db", () => ({ db: new Proxy({}, { get: (_, key) => Reflect.get(state.db as object, key) }) }));

const KEY = generatePrivateKey();
const TREASURY = privateKeyToAddress(KEY);
const MAYA_WALLET = addr(0xa11ce);

let client: PGlite;
let db: PgliteDatabase<typeof schema>;

beforeAll(async () => {
  ({ client, db } = await testDb());
  state.db = db;
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await client.close();
});

function env(extra: Record<string, string> = {}) {
  vi.unstubAllEnvs();
  vi.stubEnv("TREASURY_ADDRESS", TREASURY);
  vi.stubEnv("TREASURY_PRIVATE_KEY", KEY);
  vi.stubEnv("BOS_NETWORK", "");
  vi.stubEnv("BOS_MAINNET", "");
  for (const [k, v] of Object.entries(extra)) vi.stubEnv(k, v);
}

describe("the testnet smoke script", () => {
  it("refuses any network but Base Sepolia", async () => {
    const refused: Record<string, string>[] = [{ BOS_NETWORK: "base", BOS_MAINNET: "1" }, { BOS_MAINNET: "1" }];
    for (const extra of refused) {
      env(extra);
      const lines: string[] = [];
      const chain = new FakeChain();
      expect(await runSmoke({ chain, say: (l = "") => void lines.push(l) })).toBe(1);
      expect(lines[0]).toMatch(/^Refused: the smoke test runs on Base Sepolia only/);
      expect(chain.calls).toEqual([]);
    }
    env();
    const mainnetRpc = new FakeChain(8453);
    expect(await runSmoke({ chain: mainnetRpc, say: () => {} })).toBe(1);
    expect(mainnetRpc.sent).toEqual([]);
  });

  it("waits for a linked deposit, sends a tiny withdrawal back, and prints hashes but never the key", async () => {
    env({ SMOKE_WITHDRAW_USDC: "0.05" });
    const maya = await addUser(db, "maya");
    await syncWallets(maya.id, [{ address: MAYA_WALLET, embedded: false }]);
    const usdc = readPaymentsConfig().currencies.USDC.token!;
    const chain = new FakeChain();
    chain.setBalance(usdc, TREASURY, 3_000_000n);
    const lines: string[] = [];
    let waits = 0;
    let deposit = "";
    // Each wait moves the chain on: the owner's transfer lands, then blocks.
    const sleep = async () => {
      waits++;
      if (waits === 1) deposit = chain.transfer(usdc, MAYA_WALLET, TREASURY, 1_000_000n, chain.head + 1n).txHash;
      chain.mine(3);
    };

    expect(await runSmoke({ chain, say: (l = "") => void lines.push(l), sleep })).toBe(0);
    const out = lines.join("\n");
    expect(out).toContain("Network: Base Sepolia (chain 84532)");
    expect(out).toContain("  test USDC: 3.00 USDC");
    expect(out).toContain(`  ${TREASURY}`);
    expect(out).toContain(`  deposit tx: ${deposit}`);
    expect(out).toMatch(/payout tx: 0x[0-9a-f]{64} \(nonce 0\), sent/);
    expect(out).toContain("The smoke test passed.");
    expect(out.toLowerCase()).not.toContain(KEY.slice(2).toLowerCase());

    // The ledger saw it all: the credit, then the withdrawal, paid.
    const [w] = await db.select().from(schema.withdrawals);
    expect(w).toMatchObject({ status: "paid", amount: "50000", toAddress: MAYA_WALLET.toLowerCase(), idempotencyKey: expect.stringMatching(/:smoke:/) });
    expect(await chain.tokenBalance(usdc, MAYA_WALLET)).toBe(-1_000_000n + 50_000n);
    const [b] = await db.select().from(schema.balances);
    expect(b).toMatchObject({ available: "950000", held: "0" });
  });
});
