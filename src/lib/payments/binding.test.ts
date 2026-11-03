// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import * as schema from "@/lib/db/schema";
import { testDb } from "@/test/helperDb";
import { addr } from "@/test/fakeChain";
import { checkBinding } from "./binding";
import { paymentsConfig, readPaymentsConfig, resetPaymentsConfig, setPaymentsLock } from "./config";

// A database's balances belong to one network and one token per currency.

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/db", () => ({ db: new Proxy({}, { get: (_, key) => Reflect.get(state.db as object, key) }) }));

const TREASURY = addr(0x7ea5);
let client: PGlite;
let db: PgliteDatabase<typeof schema>;

beforeAll(async () => {
  ({ client, db } = await testDb());
  state.db = db;
});
afterAll(async () => {
  setPaymentsLock(null);
  vi.unstubAllEnvs();
  resetPaymentsConfig();
  await client.close();
});
beforeEach(async () => {
  await client.exec("delete from payment_settings;");
});

describe("the database's network", () => {
  it("is written down the first time, and the same config passes after", async () => {
    const sepolia = readPaymentsConfig({ TREASURY_ADDRESS: TREASURY });
    expect(await checkBinding(sepolia)).toEqual({ off: false, currencies: [], problems: [] });
    expect(await checkBinding(sepolia)).toEqual({ off: false, currencies: [], problems: [] });
    const rows = Object.fromEntries((await db.select().from(schema.paymentSettings)).map((r) => [r.key, r.value]));
    expect(rows).toEqual({ bound_chain_id: "84532", bound_token_USDC: sepolia.currencies.USDC.token!.toLowerCase() });
  });

  it("turns payments off when testnet balances would meet mainnet", async () => {
    await checkBinding(readPaymentsConfig({ TREASURY_ADDRESS: TREASURY }));
    const mainnet = readPaymentsConfig({ TREASURY_ADDRESS: TREASURY, BOS_NETWORK: "base", BOS_MAINNET: "1" });
    const lock = await checkBinding(mainnet);
    expect(lock).toMatchObject({ off: true });
    expect(lock!.problems[0]).toMatch(/holds balances on chain 84532, not 8453/);

    // Applied to the whole process.
    vi.stubEnv("TREASURY_ADDRESS", TREASURY);
    vi.stubEnv("BOS_NETWORK", "base");
    vi.stubEnv("BOS_MAINNET", "1");
    resetPaymentsConfig();
    expect(paymentsConfig().enabled).toBe(true);
    setPaymentsLock(lock);
    expect(paymentsConfig().enabled).toBe(false);
    expect(paymentsConfig().currencies.USDC.enabled).toBe(false);
    setPaymentsLock(null);
    expect(paymentsConfig().enabled).toBe(true);
  });

  it("turns a currency off when its token changed, and binds one switched on later", async () => {
    await checkBinding(readPaymentsConfig({ TREASURY_ADDRESS: TREASURY }));
    const moved = readPaymentsConfig({ TREASURY_ADDRESS: TREASURY, USDC_TOKEN_ADDRESS: addr(0x9999), SERV_TOKEN_ADDRESS: addr(0x5e7), SERV_TOKEN_DECIMALS: "18" });
    const lock = await checkBinding(moved);
    expect(lock).toMatchObject({ off: false, currencies: ["USDC"] });
    expect(lock!.problems[0]).toMatch(/USDC balances are for token 0x036cbd/);
    const rows = Object.fromEntries((await db.select().from(schema.paymentSettings)).map((r) => [r.key, r.value]));
    expect(rows.bound_token_SERV).toBe(addr(0x5e7).toLowerCase());
  });
});
