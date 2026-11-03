// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { sql } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import { addUser, testDb } from "@/test/helperDb";
import { formatAmount, fromDigits, minor, parseAmount, splitCharge } from "@/lib/money";
import { balancesOf, holdFunds, ledgerTotal, NotEnoughFunds, post, releaseFunds } from "./ledger";

// The ledger on a real (in-memory) Postgres with the real migrations.

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/db", () => ({ db: new Proxy({}, { get: (_, key) => Reflect.get(state.db as object, key) }) }));

let client: PGlite;
let db: PgliteDatabase<typeof schema>;
let maya: schema.User;

beforeAll(async () => {
  ({ client, db } = await testDb());
  state.db = db;
});
afterAll(async () => client.close());
beforeEach(async () => {
  await client.exec("delete from ledger_entries; delete from balances; delete from users;");
  maya = await addUser(db, "maya");
});

const tx = () => db as unknown as Parameters<typeof post>[0];

describe("money never takes a number", () => {
  it("every money function throws on a float or any number", () => {
    const float = 0.1 as unknown as bigint;
    const whole = 5 as unknown as bigint;
    expect(() => minor(float)).toThrow(TypeError);
    expect(() => minor(whole)).toThrow(TypeError);
    expect(() => splitCharge(float)).toThrow(TypeError);
    expect(() => formatAmount(float, 6)).toThrow(TypeError);
    return Promise.all([
      expect(post(tx(), { userId: maya.id, currency: "USDC", kind: "deposit", amount: float, key: "k1" })).rejects.toThrow(TypeError),
      expect(holdFunds(tx(), maya.id, "USDC", whole)).rejects.toThrow(TypeError),
      expect(releaseFunds(tx(), maya.id, "USDC", float)).rejects.toThrow(TypeError),
    ]);
  });

  it("reads and writes decimal amounts exactly", () => {
    expect(parseAmount("12.5", 6)).toBe(12_500_000n);
    expect(parseAmount("0.000001", 6)).toBe(1n);
    expect(parseAmount("0.0000001", 6)).toBeNull();
    expect(parseAmount("-1", 6)).toBeNull();
    expect(parseAmount("1e3", 6)).toBeNull();
    expect(parseAmount("", 6)).toBeNull();
    expect(formatAmount(12_500_000n, 6)).toBe("12.50");
    expect(formatAmount(1n, 6)).toBe("0.000001");
    expect(formatAmount(10n ** 18n, 18)).toBe("1.00");
    expect(fromDigits("123")).toBe(123n);
    expect(fromDigits("1.5")).toBeNull();
    expect(fromDigits(5)).toBeNull();
  });
});

describe("the ledger", () => {
  it("posts a key once: the same credit twice changes nothing", async () => {
    const e = { userId: maya.id, currency: "USDC" as const, kind: "deposit" as const, amount: 5_000_000n, key: "deposit:84532:0xabc:0" };
    expect(await post(tx(), e)).toBe(true);
    expect(await post(tx(), e)).toBe(false);
    expect((await balancesOf(maya.id)).USDC).toEqual({ available: 5_000_000n, held: 0n });
    expect(await ledgerTotal(maya.id, "USDC")).toBe(5_000_000n);
  });

  it("refuses a posting that would take a balance below zero, and rolls it back", async () => {
    await post(tx(), { userId: maya.id, currency: "USDC", kind: "deposit", amount: 1_000_000n, key: "d1" });
    await expect(
      db.transaction((t) => post(t as never, { userId: maya.id, currency: "USDC", kind: "withdrawal", amount: -2_000_000n, key: "w1" })),
    ).rejects.toBeInstanceOf(NotEnoughFunds);
    expect((await balancesOf(maya.id)).USDC.available).toBe(1_000_000n);
    expect(await ledgerTotal(maya.id, "USDC")).toBe(1_000_000n);
  });

  it("the database itself refuses a negative balance, whatever the code does", async () => {
    await post(tx(), { userId: maya.id, currency: "USDC", kind: "deposit", amount: 1n, key: "d1" });
    await expect(db.execute(sql`update balances set available = available - 2`)).rejects.toThrow(/balances_available_not_negative/);
    await expect(db.execute(sql`update balances set held = -1`)).rejects.toThrow(/balances_held_not_negative/);
    await expect(
      db.execute(sql`insert into ledger_entries (user_id, currency, amount, kind, idempotency_key) values (${maya.id}, 'USDC', '1.5', 'deposit', 'x')`),
    ).rejects.toThrow(/ledger_entries_amount_whole/);
    await expect(
      db.execute(sql`insert into ledger_entries (user_id, currency, amount, kind, idempotency_key) values (${maya.id}, 'USDC', '5', 'withdrawal', 'y')`),
    ).rejects.toThrow(/ledger_entries_sign/);
  });

  it("checks the sign and the owner of every kind before writing", async () => {
    await expect(post(tx(), { userId: maya.id, currency: "USDC", kind: "deposit", amount: -1n, key: "a" })).rejects.toThrow(RangeError);
    await expect(post(tx(), { userId: maya.id, currency: "USDC", kind: "use_charge", amount: 1n, key: "b" })).rejects.toThrow(RangeError);
    await expect(post(tx(), { userId: maya.id, currency: "USDC", kind: "platform_fee", amount: 1n, key: "c" })).rejects.toThrow(RangeError);
    await expect(post(tx(), { userId: null, currency: "USDC", kind: "deposit", amount: 1n, key: "d" })).rejects.toThrow(RangeError);
    await expect(post(tx(), { userId: maya.id, currency: "USDC", kind: "deposit", amount: 0n, key: "e" })).rejects.toThrow(RangeError);
  });

  it("holds move money between available and held without a ledger row", async () => {
    await post(tx(), { userId: maya.id, currency: "USDC", kind: "deposit", amount: 300n, key: "d1" });
    expect(await holdFunds(tx(), maya.id, "USDC", 200n)).toBe(true);
    expect(await holdFunds(tx(), maya.id, "USDC", 200n)).toBe(false);
    expect((await balancesOf(maya.id)).USDC).toEqual({ available: 100n, held: 200n });
    expect(await ledgerTotal(maya.id, "USDC")).toBe(300n);
    expect(await releaseFunds(tx(), maya.id, "USDC", 200n)).toBe(true);
    expect(await releaseFunds(tx(), maya.id, "USDC", 200n)).toBe(false);
    expect((await balancesOf(maya.id)).USDC).toEqual({ available: 300n, held: 0n });
  });
});
