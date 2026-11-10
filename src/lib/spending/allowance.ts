import "server-only";
import { and, desc, eq, sql } from "drizzle-orm";
import { agentInstallations, allowanceEntries, allowances, type User } from "../db/schema";
import { holdFunds, isCheckViolation, NotEnoughFunds, post, releaseFunds, type Exec } from "../payments/ledger";
import { formatAmount, parseAmount } from "../money";
import { userHeld } from "../safety/freeze";
import type { Runtime } from "../agents/runtime/context";

// Spending allowances. Each installation has its own: the renter moves
// USDC into it from their balance and takes what is unspent back at any
// time. The money stays the renter's, held in their own balance (so nothing
// else can spend it and it never shows as available); the allowance row
// says how much of that hold is this installation's. An agent only ever
// pays from its own installation's allowance: never the renter's main
// balance, never another installation's.
//
// Every change is an allowance entry, once by its key. A top up has the
// checks rent has: the renter's own installation, not stopped, not frozen,
// a real amount, a balance that covers it.

export const USDC = 6;
export const usdcWords = (minor: bigint) => `${formatAmount(minor, USDC)} USDC`;

type Env = Record<string, string | undefined>;
// The most one installation's allowance may hold (AGENT_ALLOWANCE_MAX_USDC).
export function allowanceMax(env: Env = process.env): bigint {
  const raw = env.AGENT_ALLOWANCE_MAX_USDC?.trim();
  const n = raw ? parseAmount(raw, USDC) : null;
  return n !== null && n > 0n ? n : 100_000_000n;
}

export class AllowanceRefused extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "AllowanceRefused";
  }
}

// An amount as typed ("5", "2.50"), in USDC minor units: positive, at most
// six decimals. Null when it isn't one.
export function readUsdc(text: unknown): bigint | null {
  if (typeof text !== "string" || !/^\d{1,9}(\.\d{1,6})?$/.test(text.trim())) return null;
  const n = parseAmount(text.trim(), USDC);
  return n !== null && n > 0n ? n : null;
}

export interface AllowanceState {
  available: bigint;
  held: bigint;
}

export async function allowanceOf(exec: Exec, installationId: string): Promise<AllowanceState> {
  const [row] = await exec.select().from(allowances).where(eq(allowances.installationId, installationId));
  return { available: BigInt(row?.available ?? "0"), held: BigInt(row?.held ?? "0") };
}

export async function recentEntries(exec: Exec, installationId: string, limit = 20) {
  return exec.select().from(allowanceEntries).where(eq(allowanceEntries.installationId, installationId)).orderBy(desc(allowanceEntries.createdAt)).limit(limit);
}

// The renter's own installation, or why not.
async function ownInstallation(rt: Runtime, owner: User, installationId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(installationId)) throw new AllowanceRefused("Not found", 404);
  const [i] = await rt.db.select().from(agentInstallations).where(eq(agentInstallations.id, installationId));
  if (!i || i.ownerUserId !== owner.id) throw new AllowanceRefused("Not found", 404);
  return i;
}

// An entry, once by its key. False when it was written before.
async function entry(tx: Exec, e: { installationId: string; ownerUserId: string; kind: (typeof allowanceEntries.$inferInsert)["kind"]; amount: bigint; referenceId?: string | null; key: string }, at: Date): Promise<boolean> {
  const [row] = await tx
    .insert(allowanceEntries)
    .values({ installationId: e.installationId, ownerUserId: e.ownerUserId, kind: e.kind, amount: e.amount.toString(), referenceId: e.referenceId ?? null, key: e.key, createdAt: at })
    .onConflictDoNothing()
    .returning({ id: allowanceEntries.id });
  return Boolean(row);
}

// Moves `amount` from the renter's balance into the installation's
// allowance. Asking again with the same key changes nothing.
export async function topUp(rt: Runtime, owner: User, installationId: string, amount: bigint, key: string): Promise<AllowanceState> {
  const i = await ownInstallation(rt, owner, installationId);
  if (i.status === "stopped") throw new AllowanceRefused("It's stopped for good: there's nothing to top up.", 409);
  const frozen = await userHeld(rt, owner.id, "renter");
  if (frozen) throw new AllowanceRefused(frozen, 409);
  if (amount <= 0n) throw new AllowanceRefused("Write an amount above zero.");
  const now = rt.now();
  try {
    await rt.db.transaction(async (tx) => {
      if (!(await entry(tx, { installationId, ownerUserId: owner.id, kind: "topup", amount, key: `allowance:${installationId}:topup:${key}` }, now))) return;
      const current = await allowanceOf(tx, installationId);
      if (current.available + current.held + amount > allowanceMax()) throw new AllowanceRefused(`An allowance can hold at most ${usdcWords(allowanceMax())}.`, 409);
      if (!(await holdFunds(tx, owner.id, "USDC", amount))) throw new NotEnoughFunds();
      await tx
        .insert(allowances)
        .values({ installationId, ownerUserId: owner.id, available: amount.toString(), updatedAt: now })
        .onConflictDoUpdate({ target: allowances.installationId, set: { available: sql`${allowances.available} + ${amount.toString()}::numeric`, updatedAt: now } });
    });
  } catch (err) {
    if (err instanceof NotEnoughFunds) throw new AllowanceRefused(`Your balance doesn't cover ${usdcWords(amount)}. Top up your wallet first.`, 409);
    throw err;
  }
  return allowanceOf(rt.db, installationId);
}

// Takes unspent money back to the renter's balance: an amount, or all of
// what is available (never what a payment in flight holds).
export async function withdrawAllowance(rt: Runtime, owner: User, installationId: string, amount: bigint | "all", key: string): Promise<AllowanceState> {
  await ownInstallation(rt, owner, installationId);
  const now = rt.now();
  await rt.db.transaction(async (tx) => {
    const current = await allowanceOf(tx, installationId);
    const take = amount === "all" ? current.available : amount;
    if (take <= 0n) {
      if (amount === "all") return;
      throw new AllowanceRefused("Write an amount above zero.");
    }
    if (take > current.available) throw new AllowanceRefused(`It has ${usdcWords(current.available)} you can take back now.`, 409);
    if (!(await entry(tx, { installationId, ownerUserId: owner.id, kind: "withdraw", amount: take, key: `allowance:${installationId}:withdraw:${key}` }, now))) return;
    const [row] = await tx
      .update(allowances)
      .set({ available: sql`${allowances.available} - ${take.toString()}::numeric`, updatedAt: now })
      .where(and(eq(allowances.installationId, installationId), sql`${allowances.available} >= ${take.toString()}::numeric`))
      .returning({ id: allowances.installationId });
    if (!row || !(await releaseFunds(tx, owner.id, "USDC", take))) throw new AllowanceRefused("It changed while you asked. Try again.", 409);
  });
  return allowanceOf(rt.db, installationId);
}

// For a payment: holds `amount` of the allowance (available to held), once
// by the payment's id. False when the allowance doesn't cover it.
export async function holdForPayment(tx: Exec, o: { installationId: string; ownerUserId: string; amount: bigint; paymentId: string; at: Date }): Promise<boolean> {
  const [row] = await tx
    .update(allowances)
    .set({ available: sql`${allowances.available} - ${o.amount.toString()}::numeric`, held: sql`${allowances.held} + ${o.amount.toString()}::numeric`, updatedAt: o.at })
    .where(and(eq(allowances.installationId, o.installationId), eq(allowances.ownerUserId, o.ownerUserId), sql`${allowances.available} >= ${o.amount.toString()}::numeric`))
    .returning({ id: allowances.installationId });
  if (!row) return false;
  await entry(tx, { installationId: o.installationId, ownerUserId: o.ownerUserId, kind: "hold", amount: o.amount, referenceId: o.paymentId, key: `payment:${o.paymentId}:hold` }, o.at);
  return true;
}

// A payment that didn't go out: its hold back to available, once.
export async function releasePayment(tx: Exec, o: { installationId: string; ownerUserId: string; amount: bigint; paymentId: string; at: Date }): Promise<boolean> {
  if (!(await entry(tx, { installationId: o.installationId, ownerUserId: o.ownerUserId, kind: "release", amount: o.amount, referenceId: o.paymentId, key: `payment:${o.paymentId}:release` }, o.at))) return false;
  const [row] = await tx
    .update(allowances)
    .set({ available: sql`${allowances.available} + ${o.amount.toString()}::numeric`, held: sql`${allowances.held} - ${o.amount.toString()}::numeric`, updatedAt: o.at })
    .where(and(eq(allowances.installationId, o.installationId), sql`${allowances.held} >= ${o.amount.toString()}::numeric`))
    .returning({ id: allowances.installationId });
  if (!row) throw new Error("An allowance's hold was smaller than a payment's.");
  return true;
}

// A payment that went out: its hold spent, once, and the renter's ledger
// charged (out of their held balance, where the allowance sits).
export async function spendPayment(tx: Exec, o: { installationId: string; ownerUserId: string; amount: bigint; paymentId: string; at: Date }): Promise<boolean> {
  if (!(await entry(tx, { installationId: o.installationId, ownerUserId: o.ownerUserId, kind: "spend", amount: o.amount, referenceId: o.paymentId, key: `payment:${o.paymentId}:spend` }, o.at))) return false;
  const [row] = await tx
    .update(allowances)
    .set({ held: sql`${allowances.held} - ${o.amount.toString()}::numeric`, updatedAt: o.at })
    .where(and(eq(allowances.installationId, o.installationId), sql`${allowances.held} >= ${o.amount.toString()}::numeric`))
    .returning({ id: allowances.installationId });
  if (!row) throw new Error("An allowance's hold was smaller than a payment's.");
  try {
    await post(tx, { userId: o.ownerUserId, currency: "USDC", kind: "use_charge", amount: -o.amount, referenceId: o.paymentId, key: `agentpay:${o.paymentId}` });
  } catch (err) {
    if (isCheckViolation(err)) throw new NotEnoughFunds();
    throw err;
  }
  return true;
}

// When an installation stops for good: what is left goes back to its
// renter (nothing in flight is touched).
export async function returnAllowance(rt: Runtime, installationId: string): Promise<bigint> {
  const [row] = await rt.db.select().from(allowances).where(eq(allowances.installationId, installationId));
  if (!row || BigInt(row.available) === 0n) return 0n;
  const owner = { id: row.ownerUserId } as User;
  const state = await withdrawAllowance(rt, owner, installationId, "all", `stopped:${rt.now().getTime()}`).catch(() => null);
  return state ? BigInt(row.available) - state.available : 0n;
}
