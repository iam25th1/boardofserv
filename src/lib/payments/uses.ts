import "server-only";
import { and, eq, inArray, lt } from "drizzle-orm";
import { db } from "../db";
import { helperPrices, holds } from "../db/schema";
import { CURRENCIES, minor, splitCharge, type Currency } from "../money";
import { paymentsConfig, type PaymentsConfig } from "./config";
import { holdFunds, post, releaseFunds } from "./ledger";

// Paid uses. A maker sets a price per use for each currency they accept. On a
// paid helper the user picks the balance to pay from, and before the model
// is called the price is moved from available to held in one transaction
// (reserve). On a good answer the hold is captured: the user's charge, the
// maker's 90% and the platform's 10% (with any rounding remainder) are
// posted to the ledger. On a failed or blocked answer it is released. A
// sweep releases holds older than ten minutes, for a use that never ended.
// A hold leaves "held" once only, so it can't be both charged and released.

export interface Price {
  currency: Currency;
  amount: bigint;
}

// The highest price a maker may set: 1000 whole tokens.
const MAX_WHOLE_TOKENS = 1000n;

// Why a price can't be set, or null when it can.
export function priceProblem(currency: Currency, amount: bigint, config: PaymentsConfig = paymentsConfig()): string | null {
  const c = config.currencies[currency];
  if (!c.enabled) return `${currency} isn't accepted here.`;
  if (minor(amount) <= 0n) return "A price must be more than zero.";
  if (amount > MAX_WHOLE_TOKENS * 10n ** BigInt(c.decimals)) return `A price can be at most ${MAX_WHOLE_TOKENS} ${currency}.`;
  return null;
}

// Each helper's prices in the currencies that are on, in a fixed order.
export async function pricesOf(helperIds: string[], config: PaymentsConfig = paymentsConfig()): Promise<Map<string, Price[]>> {
  const out = new Map<string, Price[]>();
  if (helperIds.length === 0 || !config.enabled) return out;
  const rows = await db.select().from(helperPrices).where(inArray(helperPrices.helperId, helperIds));
  for (const id of helperIds) {
    const mine = rows.filter((r) => r.helperId === id && config.currencies[r.currency].enabled);
    mine.sort((a, b) => CURRENCIES.indexOf(a.currency) - CURRENCIES.indexOf(b.currency));
    out.set(
      id,
      mine.map((r) => ({ currency: r.currency, amount: BigInt(r.price) })),
    );
  }
  return out;
}

// Set the given currencies' prices; null (or zero) stops accepting one.
// Currencies left out keep their price.
export async function setPrices(helperId: string, prices: Partial<Record<Currency, bigint | null>>): Promise<void> {
  await db.transaction(async (tx) => {
    for (const currency of CURRENCIES) {
      if (!(currency in prices)) continue;
      const amount = prices[currency];
      if (amount === null || amount === undefined || minor(amount) === 0n) {
        await tx.delete(helperPrices).where(and(eq(helperPrices.helperId, helperId), eq(helperPrices.currency, currency)));
        continue;
      }
      await tx
        .insert(helperPrices)
        .values({ helperId, currency, price: amount.toString(), updatedAt: new Date() })
        .onConflictDoUpdate({ target: [helperPrices.helperId, helperPrices.currency], set: { price: amount.toString(), updatedAt: new Date() } });
    }
  });
}

export interface Hold {
  id: string;
  userId: string;
  currency: Currency;
  amount: bigint;
  makerUserId: string;
}

// Set the price aside from the user's available balance, in one transaction:
// the balance check and the hold. Null when there isn't enough.
export async function reserve(o: { userId: string; helperId: string; makerUserId: string; currency: Currency; amount: bigint }): Promise<Hold | null> {
  const amount = minor(o.amount);
  return db.transaction(async (tx) => {
    if (!(await holdFunds(tx, o.userId, o.currency, amount))) return null;
    const [row] = await tx
      .insert(holds)
      .values({ userId: o.userId, currency: o.currency, amount: amount.toString(), helperId: o.helperId, makerUserId: o.makerUserId })
      .returning({ id: holds.id });
    return { id: row!.id, userId: o.userId, currency: o.currency, amount, makerUserId: o.makerUserId };
  });
}

// A good answer: charge the hold, 90% to the maker, the rest to the platform.
// False when the hold was already settled (released by the sweep, say).
export async function capture(holdId: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [h] = await tx
      .update(holds)
      .set({ status: "captured", settledAt: new Date() })
      .where(and(eq(holds.id, holdId), eq(holds.status, "held")))
      .returning();
    if (!h) return false;
    const amount = BigInt(h.amount);
    const { maker, platform } = splitCharge(amount);
    await post(tx, { userId: h.userId, currency: h.currency, kind: "use_charge", amount: -amount, referenceId: h.id, key: `use:${h.id}:charge` });
    if (maker > 0n) {
      await post(tx, { userId: h.makerUserId, currency: h.currency, kind: "maker_earning", amount: maker, referenceId: h.id, key: `use:${h.id}:maker` });
    }
    await post(tx, { userId: null, currency: h.currency, kind: "platform_fee", amount: platform, referenceId: h.id, key: `use:${h.id}:platform` });
    return true;
  });
}

// A failed or blocked answer: give the hold back. False when already settled.
export async function release(holdId: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [h] = await tx
      .update(holds)
      .set({ status: "released", settledAt: new Date() })
      .where(and(eq(holds.id, holdId), eq(holds.status, "held")))
      .returning();
    if (!h) return false;
    if (!(await releaseFunds(tx, h.userId, h.currency, BigInt(h.amount)))) throw new Error("A hold's funds were not held.");
    return true;
  });
}

export const HOLD_TTL_MS = 10 * 60_000;

// Release every helper use's hold older than ten minutes. Returns how
// many. (Rent is captured at once, and a rented agent's fee per job waits
// for its job, however long: neither is swept.)
export async function sweepHolds(now: Date = new Date()): Promise<number> {
  const stale = await db
    .select({ id: holds.id })
    .from(holds)
    .where(and(eq(holds.status, "held"), eq(holds.kind, "use"), lt(holds.createdAt, new Date(now.getTime() - HOLD_TTL_MS))));
  let released = 0;
  for (const { id } of stale) if (await release(id)) released++;
  return released;
}

export async function sweepTick(): Promise<void> {
  try {
    const n = await sweepHolds();
    if (n) console.info(`payments: released ${n} stale ${n === 1 ? "hold" : "holds"}.`);
  } catch (err) {
    console.error(`payments: hold sweep failed: ${err instanceof Error ? err.name : "unknown error"}`);
  }
}
