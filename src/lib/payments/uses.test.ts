// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import { addHelper, addUser, testDb } from "@/test/helperDb";
import { splitCharge } from "@/lib/money";
import { balancesOf, ledgerTotal, post } from "./ledger";
import { capture, HOLD_TTL_MS, release, reserve, sweepHolds } from "./uses";

// Holds, captures and releases on a real (in-memory) Postgres.

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/db", () => ({ db: new Proxy({}, { get: (_, key) => Reflect.get(state.db as object, key) }) }));

let client: PGlite;
let db: PgliteDatabase<typeof schema>;
let maya: schema.User;
let sam: schema.User;
let helper: schema.PublishedHelper;

beforeAll(async () => {
  ({ client, db } = await testDb());
  state.db = db;
});
afterAll(async () => client.close());

beforeEach(async () => {
  await client.exec("delete from helper_uses; delete from holds; delete from ledger_entries; delete from balances; delete from published_helpers; delete from users;");
  maya = await addUser(db, "maya");
  sam = await addUser(db, "sam");
  helper = await addHelper(db, maya, { slug: "shop-blurbs" });
});

const fund = (user: schema.User, amount: bigint, key = `fund:${user.id}:${amount}`) =>
  post(db as never, { userId: user.id, currency: "USDC", kind: "deposit", amount, key });
const hold = (amount: bigint) => reserve({ userId: sam.id, helperId: helper.id, makerUserId: maya.id, currency: "USDC", amount });

// For every user, the ledger adds up to what they hold.
async function balanced() {
  for (const u of [maya, sam]) {
    const b = (await balancesOf(u.id)).USDC;
    expect(await ledgerTotal(u.id, "USDC")).toBe(b.available + b.held);
  }
}

describe("the 90/10 split", () => {
  it("gives the maker 90% rounded down and the platform the rest", () => {
    expect(splitCharge(1_000_000n)).toEqual({ maker: 900_000n, platform: 100_000n });
    expect(splitCharge(11n)).toEqual({ maker: 9n, platform: 2n });
    expect(splitCharge(1n)).toEqual({ maker: 0n, platform: 1n });
    for (let p = 1n; p < 500n; p++) {
      const { maker, platform } = splitCharge(p);
      expect(maker + platform).toBe(p);
      expect(platform * 10n).toBeGreaterThanOrEqual(p);
    }
  });

  it("captures a hold: the user's charge, the maker's 90% and the platform's 10% with the remainder", async () => {
    await fund(sam, 1_000n);
    const h = (await hold(255n))!;
    expect((await balancesOf(sam.id)).USDC).toEqual({ available: 745n, held: 255n });
    expect(await capture(h.id)).toBe(true);

    expect((await balancesOf(sam.id)).USDC).toEqual({ available: 745n, held: 0n });
    // 90% of 255 is 229.5: the maker gets 229, the platform 26.
    expect((await balancesOf(maya.id)).USDC).toEqual({ available: 229n, held: 0n });
    expect(await ledgerTotal(null, "USDC")).toBe(26n);
    const rows = await db.select().from(schema.ledgerEntries).where(eq(schema.ledgerEntries.referenceId, h.id));
    expect(rows.map((r) => [r.kind, r.amount]).sort()).toEqual([
      ["maker_earning", "229"],
      ["platform_fee", "26"],
      ["use_charge", "-255"],
    ]);
    await balanced();
  });

  it("writes no maker row when the maker's share rounds to nothing", async () => {
    await fund(sam, 5n);
    const h = (await hold(1n))!;
    await capture(h.id);
    expect((await balancesOf(maya.id)).USDC.available).toBe(0n);
    expect(await ledgerTotal(null, "USDC")).toBe(1n);
    await balanced();
  });
});

describe("holds", () => {
  it("refuses a hold larger than the available balance", async () => {
    await fund(sam, 100n);
    expect(await hold(101n)).toBeNull();
    expect((await balancesOf(sam.id)).USDC).toEqual({ available: 100n, held: 0n });
  });

  it("never goes negative under parallel uses: only as many holds as the balance covers", async () => {
    await fund(sam, 300n);
    const results = await Promise.all(Array.from({ length: 12 }, () => hold(100n)));
    expect(results.filter(Boolean)).toHaveLength(3);
    expect((await balancesOf(sam.id)).USDC).toEqual({ available: 0n, held: 300n });
    await Promise.all(results.filter((h) => h !== null).map((h) => capture(h!.id)));
    expect((await balancesOf(sam.id)).USDC).toEqual({ available: 0n, held: 0n });
    await balanced();
  });

  it("releases a hold on a failed or blocked answer, and only once", async () => {
    await fund(sam, 500n);
    const h = (await hold(200n))!;
    expect(await release(h.id)).toBe(true);
    expect(await release(h.id)).toBe(false);
    expect((await balancesOf(sam.id)).USDC).toEqual({ available: 500n, held: 0n });
    // A released hold can't be charged after all.
    expect(await capture(h.id)).toBe(false);
    expect((await balancesOf(sam.id)).USDC).toEqual({ available: 500n, held: 0n });
    expect(await db.select().from(schema.ledgerEntries).where(eq(schema.ledgerEntries.referenceId, h.id))).toHaveLength(0);
    await balanced();
  });

  it("captures only once", async () => {
    await fund(sam, 500n);
    const h = (await hold(200n))!;
    expect(await capture(h.id)).toBe(true);
    expect(await capture(h.id)).toBe(false);
    expect(await release(h.id)).toBe(false);
    expect((await balancesOf(sam.id)).USDC).toEqual({ available: 300n, held: 0n });
    expect((await balancesOf(maya.id)).USDC.available).toBe(180n);
    await balanced();
  });

  it("the sweep releases holds older than ten minutes and leaves newer ones", async () => {
    await fund(sam, 500n);
    const old = (await hold(100n))!;
    const fresh = (await hold(100n))!;
    await db
      .update(schema.holds)
      .set({ createdAt: new Date(Date.now() - HOLD_TTL_MS - 1000) })
      .where(eq(schema.holds.id, old.id));
    expect(await sweepHolds()).toBe(1);
    const statuses = Object.fromEntries((await db.select().from(schema.holds)).map((h) => [h.id, h.status]));
    expect(statuses).toEqual({ [old.id]: "released", [fresh.id]: "held" });
    expect((await balancesOf(sam.id)).USDC).toEqual({ available: 400n, held: 100n });
    // The use that finally ends can't charge the swept hold.
    expect(await capture(old.id)).toBe(false);
    await balanced();
  });
});
