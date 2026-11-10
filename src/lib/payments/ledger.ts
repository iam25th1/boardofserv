import "server-only";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../db";
import { balances, ledgerEntries, type LedgerKind } from "../db/schema";
import { CURRENCIES, minor, type Currency } from "../money";

// The ledger. Every change to a balance is one ledger row written in the same
// transaction as the change, keyed by an idempotency key that is unique in
// the database: posting the same key twice changes nothing the second time,
// so a credit or payout can never happen twice. Balances can't go below zero:
// the database refuses it (see the checks in schema.ts), and a posting that
// would do it fails with NotEnoughFunds and rolls back its transaction.
//
// Amounts are BigInt minor units only; minor() throws on a number.

// The database handle or a transaction on it.
export type Db = typeof db;
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type Exec = Db | Tx;

export class NotEnoughFunds extends Error {
  constructor() {
    super("Not enough balance.");
    this.name = "NotEnoughFunds";
  }
}

// A check constraint refused a row, from node-postgres or PGlite.
export function isCheckViolation(err: unknown): boolean {
  const code = (e: unknown) => (e && typeof e === "object" && "code" in e ? (e as { code?: unknown }).code : undefined);
  return code(err) === "23514" || code((err as { cause?: unknown } | null)?.cause) === "23514";
}

// Kinds that take money away from the user (or platform) they belong to.
const DEBITS: readonly LedgerKind[] = ["use_charge", "withdrawal", "earning_reversal", "platform_refund"];
// The platform's own: its fee, and a fee given back.
const PLATFORM: readonly LedgerKind[] = ["platform_fee", "platform_refund"];

export interface Entry {
  // Null only for the platform's fee (and one given back).
  userId: string | null;
  currency: Currency;
  kind: LedgerKind;
  // Signed: negative for a use's charge, a withdrawal and a reversal.
  amount: bigint;
  referenceId?: string | null;
  key: string;
}

// Write one ledger row and change the balance it belongs to, inside the
// caller's transaction. Returns false, and changes nothing, when a row with
// this key was written before.
export async function post(tx: Exec, e: Entry): Promise<boolean> {
  const amount = minor(e.amount);
  if (amount === 0n) throw new RangeError("A ledger entry can't be zero.");
  if (DEBITS.includes(e.kind) !== amount < 0n) throw new RangeError(`A ${e.kind} entry has the wrong sign.`);
  if (PLATFORM.includes(e.kind) !== (e.userId === null)) throw new RangeError("Only the platform's fee has no user.");

  const [row] = await tx
    .insert(ledgerEntries)
    .values({ userId: e.userId, currency: e.currency, kind: e.kind, amount: amount.toString(), referenceId: e.referenceId ?? null, idempotencyKey: e.key })
    .onConflictDoNothing({ target: ledgerEntries.idempotencyKey })
    .returning({ id: ledgerEntries.id });
  if (!row) return false;
  // The platform's fee stays in the treasury: it is not anyone's balance.
  if (e.userId === null) return true;
  // A use's charge comes out of the hold made for it; everything else
  // changes what is available.
  await addToBalance(tx, e.userId, e.currency, e.kind === "use_charge" ? "held" : "available", amount);
  return true;
}

async function addToBalance(tx: Exec, userId: string, currency: Currency, column: "available" | "held", delta: bigint): Promise<void> {
  const d = minor(delta).toString();
  const by = sql`${d}::numeric`;
  const set = column === "available" ? { available: sql`${balances.available} + ${by}`, updatedAt: new Date() } : { held: sql`${balances.held} + ${by}`, updatedAt: new Date() };
  try {
    if (delta > 0n) {
      await tx
        .insert(balances)
        .values({ userId, currency, available: column === "available" ? d : "0", held: column === "held" ? d : "0" })
        .onConflictDoUpdate({ target: [balances.userId, balances.currency], set });
      return;
    }
    // Taking money away needs a balance to take it from. (An upsert would be
    // refused for its negative first row even when the balance exists.)
    const rows = await tx
      .update(balances)
      .set(set)
      .where(and(eq(balances.userId, userId), eq(balances.currency, currency)))
      .returning({ userId: balances.userId });
    if (rows.length === 0) throw new NotEnoughFunds();
  } catch (err) {
    if (isCheckViolation(err)) throw new NotEnoughFunds();
    throw err;
  }
}

// Move `amount` from available to held, if that much is available. No ledger
// row: the user's total is unchanged until the hold is captured.
export async function holdFunds(tx: Exec, userId: string, currency: Currency, amount: bigint): Promise<boolean> {
  const d = minor(amount).toString();
  if (amount <= 0n) throw new RangeError("A hold must be more than zero.");
  const rows = await tx
    .update(balances)
    .set({ available: sql`${balances.available} - ${d}::numeric`, held: sql`${balances.held} + ${d}::numeric`, updatedAt: new Date() })
    .where(and(eq(balances.userId, userId), eq(balances.currency, currency), sql`${balances.available} >= ${d}::numeric`))
    .returning({ userId: balances.userId });
  return rows.length === 1;
}

// Give a hold back: held to available.
export async function releaseFunds(tx: Exec, userId: string, currency: Currency, amount: bigint): Promise<boolean> {
  const d = minor(amount).toString();
  if (amount <= 0n) throw new RangeError("A hold must be more than zero.");
  const rows = await tx
    .update(balances)
    .set({ available: sql`${balances.available} + ${d}::numeric`, held: sql`${balances.held} - ${d}::numeric`, updatedAt: new Date() })
    .where(and(eq(balances.userId, userId), eq(balances.currency, currency), sql`${balances.held} >= ${d}::numeric`))
    .returning({ userId: balances.userId });
  return rows.length === 1;
}

export interface Balance {
  available: bigint;
  held: bigint;
}

// A user's balance in every currency, zero where they have none.
export async function balancesOf(userId: string, exec: Exec = db): Promise<Record<Currency, Balance>> {
  const rows = await exec.select().from(balances).where(eq(balances.userId, userId));
  const out = Object.fromEntries(CURRENCIES.map((c) => [c, { available: 0n, held: 0n }])) as Record<Currency, Balance>;
  for (const r of rows) out[r.currency] = { available: BigInt(r.available), held: BigInt(r.held) };
  return out;
}

// The sum of a user's ledger rows in a currency (or the platform's, for
// null): always available plus held.
export async function ledgerTotal(userId: string | null, currency: Currency, exec: Exec = db): Promise<bigint> {
  const [row] = await exec
    .select({ total: sql<string>`coalesce(sum(${ledgerEntries.amount}::numeric), 0)::text` })
    .from(ledgerEntries)
    .where(and(userId === null ? sql`${ledgerEntries.userId} is null` : eq(ledgerEntries.userId, userId), eq(ledgerEntries.currency, currency)));
  return BigInt(row?.total ?? "0");
}
