import "server-only";
import { lockTreasury, nextNonce, treasuryBusy } from "../spending/treasury";
import { and, asc, desc, eq, gte, inArray, sql } from "drizzle-orm";
import type { Address, Hex } from "viem";
import { db } from "../db";
import { ledgerEntries, paymentSettings, withdrawals, type WithdrawalStatus } from "../db/schema";
import { formatAmount, minor, type Currency } from "../money";
import { paymentsConfig, type PaymentsConfig } from "./config";
import { chainClient, chainError, type ChainClient } from "./chain";
import { NotEnoughFunds, post, type Exec } from "./ledger";
import { treasurySigner, type PayoutSigner } from "./signer";
import { walletsOf } from "./wallets";
import { isUniqueViolation } from "../db/errors";

// Withdrawals. A maker asks to take money out to one of their linked
// wallets, and the amount is debited at once with a pending row. Below the
// currency's automatic limit, and while the day's automatic payouts stay
// within the daily cap, it is paid without approval; otherwise it waits for
// an admin. Payouts go out one at a time: the next is signed (nonce, hash
// and signed bytes recorded before anything is sent, under the withdrawal's
// idempotency key), sent once, and reconciled when it has enough
// confirmations. A resend is the very same signed transaction, so the same
// nonce. A reverted transfer posts a withdrawal_reversal. The admin switch
// pauses every payout.

export class WithdrawalRefused extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "WithdrawalRefused";
  }
}

const PAUSED = "payouts_paused";
// Serialises withdrawal requests, so two can't both fit under the day's cap.
const REQUEST_LOCK = 0x626f7377;
// How long an unmined payout waits before it is sent again.
export const RESEND_MS = 60_000;
// How long a payout may be missing, with its nonce used, before the admin
// page offers to mark it failed.
export const STUCK_MS = 10 * 60_000;

export async function payoutsPaused(exec: Exec = db): Promise<boolean> {
  const [row] = await exec.select({ value: paymentSettings.value }).from(paymentSettings).where(eq(paymentSettings.key, PAUSED)).limit(1);
  return row?.value === "true";
}

export async function setPayoutsPaused(paused: boolean, by: string): Promise<void> {
  await db
    .insert(paymentSettings)
    .values({ key: PAUSED, value: String(paused), updatedBy: by, updatedAt: new Date() })
    .onConflictDoUpdate({ target: paymentSettings.key, set: { value: String(paused), updatedBy: by, updatedAt: new Date() } });
}

export type Withdrawal = typeof withdrawals.$inferSelect;

function startOfDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

// The day's automatic payouts in a currency, so far.
export async function autoToday(exec: Exec, chainId: number, currency: Currency, now: Date = new Date()): Promise<bigint> {
  const [row] = await exec
    .select({ total: sql<string>`coalesce(sum(${withdrawals.amount}), 0)::text` })
    .from(withdrawals)
    .where(
      and(
        eq(withdrawals.auto, true),
        eq(withdrawals.chainId, chainId),
        eq(withdrawals.currency, currency),
        gte(withdrawals.createdAt, startOfDay(now)),
        inArray(withdrawals.status, ["queued", "broadcast", "paid"]),
      ),
    );
  return BigInt(row?.total ?? "0");
}

export interface WithdrawalRequest {
  userId: string;
  currency: Currency;
  amount: bigint;
  to: string;
  // The browser's key for this request: asking twice with it gives the same
  // withdrawal.
  key: string;
}

// Ask for a withdrawal: checked, debited and queued (or held for approval)
// in one transaction. `approvedBy` queues it as approved by that admin (null:
// by the owner, from the testnet smoke script, which also skips the minimum).
export async function requestWithdrawal(
  r: WithdrawalRequest,
  opts: { approvedBy?: string | null; ignoreMinimum?: boolean } = {},
  config: PaymentsConfig = paymentsConfig(),
): Promise<Withdrawal> {
  const amount = minor(r.amount);
  if (!config.enabled) throw new WithdrawalRefused("Payments aren't set up here.", 503);
  const c = config.currencies[r.currency];
  if (!c.enabled) throw new WithdrawalRefused(`${r.currency} isn't accepted here.`);
  if (c.withdrawMin === null && !opts.ignoreMinimum) throw new WithdrawalRefused(`${r.currency} withdrawals aren't open yet.`);
  if (amount <= 0n) throw new WithdrawalRefused("Withdraw more than zero.");
  if (!opts.ignoreMinimum && c.withdrawMin !== null && amount < c.withdrawMin) {
    throw new WithdrawalRefused(`The smallest withdrawal is ${formatAmount(c.withdrawMin, c.decimals)} ${r.currency}.`);
  }
  const to = r.to.toLowerCase();
  if (!(await walletsOf(r.userId)).some((w) => w.address === to)) throw new WithdrawalRefused("Withdraw to one of your linked wallets.");
  const key = `${r.userId}:${r.key}`;

  try {
    return await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(${REQUEST_LOCK})`);
      const [same] = await tx.select().from(withdrawals).where(eq(withdrawals.idempotencyKey, key)).limit(1);
      if (same) return same;

      let status: WithdrawalStatus = "awaiting_approval";
      let auto = false;
      let reason: string | null = null;
      if (opts.approvedBy !== undefined) status = "queued";
      else if (amount < c.autoMax && (await autoToday(tx, config.chainId, r.currency)) + amount <= c.dailyCap) {
        status = "queued";
        auto = true;
      } else reason = amount >= c.autoMax ? "Over the automatic limit: an admin approves it." : "Today's automatic payouts are used up: an admin approves it.";

      const [row] = await tx
        .insert(withdrawals)
        .values({
          userId: r.userId,
          chainId: config.chainId,
          currency: r.currency,
          amount: amount.toString(),
          toAddress: to,
          status,
          auto,
          reason,
          idempotencyKey: key,
          decidedBy: opts.approvedBy ?? null,
          decidedAt: opts.approvedBy !== undefined ? new Date() : null,
        })
        .returning();
      await post(tx, { userId: r.userId, currency: r.currency, kind: "withdrawal", amount: -amount, referenceId: row!.id, key: `withdrawal:${row!.id}` });
      return row!;
    });
  } catch (err) {
    if (err instanceof NotEnoughFunds) throw new WithdrawalRefused("Not enough balance for that withdrawal.");
    throw err;
  }
}

// Give a withdrawal's amount back, once, with the status that says why.
async function reverse(tx: Exec, w: Withdrawal): Promise<void> {
  await post(tx, {
    userId: w.userId,
    currency: w.currency,
    kind: "withdrawal_reversal",
    amount: BigInt(w.amount),
    referenceId: w.id,
    key: `withdrawal:${w.id}:reversal`,
  });
}

export async function approveWithdrawal(id: string, adminId: string): Promise<boolean> {
  const rows = await db
    .update(withdrawals)
    .set({ status: "queued", decidedBy: adminId, decidedAt: new Date(), reason: null })
    .where(and(eq(withdrawals.id, id), eq(withdrawals.status, "awaiting_approval")))
    .returning({ id: withdrawals.id });
  return rows.length === 1;
}

// Reject one waiting for approval, or cancel one queued but not yet sent:
// the amount goes back to the balance.
export async function rejectWithdrawal(id: string, adminId: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [w] = await tx
      .update(withdrawals)
      .set({ status: "rejected", decidedBy: adminId, decidedAt: new Date(), settledAt: new Date() })
      .where(and(eq(withdrawals.id, id), inArray(withdrawals.status, ["awaiting_approval", "queued"])))
      .returning();
    if (!w) return false;
    await reverse(tx, w);
    return true;
  });
}

// A payout is stuck when it was never mined, the treasury's nonce has moved
// past it (another transaction took that nonce, so it can never be mined),
// and it has been so for a while. Only then can an admin mark it failed,
// which gives the amount back.
export async function isStuck(chain: ChainClient, w: Withdrawal, treasury: Address, now: Date = new Date()): Promise<boolean> {
  if (w.status !== "broadcast" || !w.txHash || w.nonce === null || !w.broadcastAt) return false;
  if (now.getTime() - w.broadcastAt.getTime() < STUCK_MS) return false;
  const from = (w.fromAddress ?? treasury) as Address;
  // The nonce first, then the receipt: if the payout itself took the nonce,
  // its receipt is there by the time it is read.
  if ((await chain.nonce(from, "latest")) <= w.nonce) return false;
  return !(await chain.receipt(w.txHash as Hex));
}

export async function failStuckWithdrawal(id: string, adminId: string, chain: ChainClient, config: PaymentsConfig = paymentsConfig()): Promise<boolean> {
  const [w] = await db.select().from(withdrawals).where(eq(withdrawals.id, id)).limit(1);
  if (!w || !config.treasury || !(await isStuck(chain, w, config.treasury))) return false;
  // Once more, just before giving the amount back.
  if (await chain.receipt(w.txHash as Hex)) return false;
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(withdrawals)
      .set({ status: "failed", decidedBy: adminId, decidedAt: new Date(), settledAt: new Date() })
      .where(and(eq(withdrawals.id, id), eq(withdrawals.status, "broadcast")))
      .returning();
    if (!row) return false;
    await reverse(tx, row);
    return true;
  });
}

// Sign and send the oldest queued payout that can go now, if none is in
// flight and payouts aren't paused. One that can't go yet (its currency is
// off, the treasury is short of it, or the node won't estimate it) is passed
// over, so it never holds up the others; an admin can cancel it. Returns the
// id sent, or null when nothing was sent.
const MAX_TRIES_PER_STEP = 10;

export async function sendNextPayout(chain: ChainClient, signer: PayoutSigner, config: PaymentsConfig = paymentsConfig()): Promise<string | null> {
  const treasury = config.treasury;
  if (!config.enabled || !treasury) return null;
  if (await payoutsPaused()) return null;
  // Nothing else in flight from the treasury: a payout, or an agent's payment.
  if (await treasuryBusy(db, config.chainId)) return null;
  const queued = await db
    .select()
    .from(withdrawals)
    .where(and(eq(withdrawals.chainId, config.chainId), eq(withdrawals.status, "queued")))
    .orderBy(asc(withdrawals.createdAt))
    .limit(MAX_TRIES_PER_STEP);
  for (const next of queued) {
    const sent = await trySend(chain, signer, config, treasury, next);
    if (sent !== "skip") return sent;
  }
  return null;
}

async function trySend(chain: ChainClient, signer: PayoutSigner, config: PaymentsConfig, treasury: Address, next: Withdrawal): Promise<string | null | "skip"> {
  const c = config.currencies[next.currency];
  if (!c.enabled || !c.token) return "skip";
  const amount = BigInt(next.amount);
  const to = next.toAddress as Address;

  if ((await chain.tokenBalance(c.token, treasury)) < amount) {
    console.warn(`payments: the treasury has less ${c.code} than a queued payout; it waits.`);
    return "skip";
  }
  let fees: Awaited<ReturnType<ChainClient["transferFees"]>>;
  try {
    fees = await chain.transferFees({ token: c.token, from: treasury, to, amount });
  } catch (err) {
    console.warn(`payments: a queued payout can't be estimated, it waits: ${chainError(err)}`);
    return "skip";
  }
  if ((await chain.nativeBalance(treasury)) < fees.gas * fees.maxFeePerGas) {
    console.warn("payments: the treasury has too little ETH for gas; payouts wait.");
    return null;
  }
  // Decided under the treasury's lock, shared with agents' payments (one
  // send in flight from it at a time, the next nonce never below one either
  // used): recorded before it is sent, the signer, the nonce, the hash and
  // the signed bytes. The database refuses this if another payout went in
  // flight meanwhile.
  let recorded: { id: string; raw: Hex } | null;
  try {
    recorded = await db.transaction(async (tx) => {
      await lockTreasury(tx);
      if (await treasuryBusy(tx, config.chainId)) return null;
      const nonce = await nextNonce(tx, chain, signer, config.chainId);
      const signed = await signer.signTransfer({ chainId: config.chainId, token: c.token!, to, amount, nonce, ...fees });
      const [row] = await tx
        .update(withdrawals)
        .set({ status: "broadcast", fromAddress: signer.address.toLowerCase(), nonce, txHash: signed.hash, rawTx: signed.raw, broadcastAt: new Date(), lastSentAt: new Date(), sends: 1 })
        .where(and(eq(withdrawals.id, next.id), eq(withdrawals.status, "queued")))
        .returning({ id: withdrawals.id });
      return row ? { id: row.id, raw: signed.raw } : null;
    });
  } catch (err) {
    if (isUniqueViolation(err)) return null;
    throw err;
  }
  if (!recorded) return null;
  try {
    await chain.sendRaw(recorded.raw);
  } catch (err) {
    // Recorded already: the reconcile step sends the same bytes again.
    console.error(`payments: payout not sent yet, will retry: ${chainError(err)}`);
  }
  return next.id;
}

// Check every payout in flight: paid once its block has enough
// confirmations, reversed if it reverted, sent again (the same signed
// transaction) if it hasn't been mined for a while.
export async function reconcilePayouts(chain: ChainClient, config: PaymentsConfig = paymentsConfig(), now: Date = new Date()): Promise<void> {
  if (!config.enabled) return;
  const flying = await db
    .select()
    .from(withdrawals)
    .where(and(eq(withdrawals.chainId, config.chainId), eq(withdrawals.status, "broadcast")));
  if (flying.length === 0) return;
  const head = await chain.blockNumber();
  const paused = await payoutsPaused();
  for (const w of flying) {
    const r = await chain.receipt(w.txHash as Hex);
    if (r) {
      if (head - r.blockNumber + 1n < BigInt(config.confirmations)) continue;
      if (r.status === "success") {
        await db
          .update(withdrawals)
          .set({ status: "paid", settledAt: new Date() })
          .where(and(eq(withdrawals.id, w.id), eq(withdrawals.status, "broadcast")));
      } else {
        await db.transaction(async (tx) => {
          const [row] = await tx
            .update(withdrawals)
            .set({ status: "reverted", settledAt: new Date() })
            .where(and(eq(withdrawals.id, w.id), eq(withdrawals.status, "broadcast")))
            .returning();
          if (row) await reverse(tx, row);
        });
      }
      continue;
    }
    if (paused || !w.rawTx || (w.lastSentAt && now.getTime() - w.lastSentAt.getTime() < RESEND_MS)) continue;
    try {
      await chain.sendRaw(w.rawTx as Hex);
    } catch (err) {
      console.error(`payments: payout resend failed, will retry: ${chainError(err)}`);
    }
    await db
      .update(withdrawals)
      .set({ sends: sql`${withdrawals.sends} + 1`, lastSentAt: now })
      .where(eq(withdrawals.id, w.id));
  }
}

// The payout part of the server's interval: reconcile, then send the next.
let signerProblem: string | null = null;

export async function payoutTick(chain: ChainClient = chainClient(), config: PaymentsConfig = paymentsConfig()): Promise<void> {
  if (!config.enabled) return;
  try {
    await reconcilePayouts(chain, config);
    const signer = treasurySigner(config);
    if ("problem" in signer) {
      if (signerProblem !== signer.problem) console.warn(`payments: ${signer.problem}`);
      signerProblem = signer.problem;
      return;
    }
    await sendNextPayout(chain, signer, config);
  } catch (err) {
    console.error(`payments: payout step failed: ${chainError(err)}`);
  }
}

// What a maker has earned in each currency, all time, less what upheld
// disputes took back.
export async function earnedOf(userId: string): Promise<Record<Currency, bigint>> {
  const rows = await db
    .select({ currency: ledgerEntries.currency, total: sql<string>`coalesce(sum(${ledgerEntries.amount}::numeric), 0)::text` })
    .from(ledgerEntries)
    .where(and(eq(ledgerEntries.userId, userId), inArray(ledgerEntries.kind, ["maker_earning", "earning_reversal"])))
    .groupBy(ledgerEntries.currency);
  const out = { USDC: 0n, SERV: 0n } as Record<Currency, bigint>;
  for (const r of rows) out[r.currency] = BigInt(r.total);
  return out;
}

export async function withdrawalsOf(userId: string, limit = 20): Promise<Withdrawal[]> {
  return db.select().from(withdrawals).where(eq(withdrawals.userId, userId)).orderBy(desc(withdrawals.createdAt)).limit(limit);
}
