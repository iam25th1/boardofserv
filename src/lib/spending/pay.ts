import "server-only";
import { and, eq, lt, sql } from "drizzle-orm";
import type { Address, Hex } from "viem";
import { agentJobs, agentPayments, type AgentInstallation, type AgentPayment, type Payee } from "../db/schema";
import type { Runtime } from "../agents/runtime/context";
import { chainError } from "../payments/chain";
import { payStopped } from "./limits";
import { allowanceOf, holdForPayment, releasePayment, spendPayment, usdcWords } from "./allowance";
import { markPaid } from "./payees";
import { lockTreasury, nextNonce, paymentsNetworkProblem, paymentsPaused, raiseAlert, setPaymentsPaused, treasuryBusy, treasuryFloor } from "./treasury";

// An agent's payment, on chain. After the guard and any approval: the
// allowance holds the amount, the treasury signs a USDC transfer to the
// saved payee (its nonce, hash and bytes recorded before it is sent),
// sends it, waits for it to be mined and confirmed, and only then is the
// allowance spent and the renter's ledger charged. A reverted, stuck or
// refused send releases the hold; nothing is spent.
//
// One action is one row, by its key (the job and the call): the same
// action never sends twice, after a crash or a restart included. A row
// found already broadcast is waited on (its same bytes sent again if they
// were lost), never signed again. Only one send leaves the treasury at a
// time; a payment that finds another in flight waits its turn.

export const RESEND_MS = 30_000;
export const POLL_MS = 2_000;

export type PaymentProblem = "paused" | "network" | "allowance" | "held" | "treasury" | "reverted" | "stuck" | "signer";

// A payment that won't go (or didn't): the job's step fails with this, in
// plain words. Nothing was spent.
export class PaymentRefused extends Error {
  constructor(
    message: string,
    readonly problem: PaymentProblem,
  ) {
    super(message);
    this.name = "PaymentRefused";
  }
}

// Not settled yet: its job tries the step again later, and finds it.
export class PaymentPending extends Error {
  constructor(message = "The payment was sent and is waiting to be confirmed on Base.") {
    super(message);
    this.name = "PaymentPending";
  }
}

export interface PayRequest {
  installation: AgentInstallation;
  jobId: string;
  versionId: string;
  // The call's place in its job: the same call gets the same key.
  callKey: string;
  payee: Payee;
  amount: bigint;
  memo: string | null;
  guard: { verdict: string; reason: string } | null;
  approval: { id: string | null; by: "renter" | "rules" };
}

const short = (a: string) => `${a.slice(0, 6)}...${a.slice(-4)}`;

class ShortAllowance extends Error {}

async function load(rt: Runtime, key: string): Promise<AgentPayment | null> {
  const [row] = await rt.db.select().from(agentPayments).where(eq(agentPayments.key, key));
  return row ?? null;
}

async function fail(rt: Runtime, p: AgentPayment, error: string): Promise<void> {
  const now = rt.now();
  await rt.db.transaction(async (tx) => {
    const [row] = await tx
      .update(agentPayments)
      .set({ status: "failed", error, settledAt: now, updatedAt: now })
      .where(and(eq(agentPayments.id, p.id), sql`${agentPayments.status} in ('held', 'broadcast')`))
      .returning();
    if (row) await releasePayment(tx, { installationId: row.installationId, ownerUserId: row.ownerUserId, amount: BigInt(row.amount), paymentId: row.id, at: now });
  });
}

// The first step: the row, and the allowance's hold, together. Refused
// (nothing held) when payments are paused, off or not on Base Sepolia, the
// agent or renter is held or its listing on hold, or the allowance doesn't cover it.
async function start(rt: Runtime, r: PayRequest, key: string): Promise<AgentPayment> {
  const pay = rt.payments;
  if (!pay) throw new PaymentRefused("Payments aren't set up on this site, so nothing was paid.", "network");
  const network = paymentsNetworkProblem(pay.config);
  if (network) throw new PaymentRefused(`${network} Nothing was paid.`, "network");
  const paused = await paymentsPaused(rt.db);
  if (paused) throw new PaymentRefused(`Agent payments are paused on boardofserv for now: ${paused} Nothing was paid.`, "paused");
  const held = await payStopped(rt, r.installation);
  if (held) throw new PaymentRefused(`${held} It can't pay anything now.`, "held");
  const now = rt.now();
  let row: AgentPayment | null;
  try {
    row = await rt.db.transaction(async (tx) => {
      const [p] = await tx
        .insert(agentPayments)
        .values({
          key,
          installationId: r.installation.id,
          agentId: r.installation.agentId,
          versionId: r.versionId,
          jobId: r.jobId,
          ownerUserId: r.installation.ownerUserId,
          payeeId: r.payee.id,
          payeeLabel: r.payee.label,
          toAddress: r.payee.address,
          amount: r.amount.toString(),
          chainId: pay.config.chainId,
          memo: r.memo,
          guard: r.guard?.verdict ?? null,
          guardReason: r.guard?.reason ?? null,
          approvalId: r.approval.id,
          approvedBy: r.approval.by,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing()
        .returning();
      if (!p) return null;
      if (!(await holdForPayment(tx, { installationId: r.installation.id, ownerUserId: r.installation.ownerUserId, amount: r.amount, paymentId: p.id, at: now }))) throw new ShortAllowance();
      return p;
    });
  } catch (err) {
    if (!(err instanceof ShortAllowance)) throw err;
    const a = await allowanceOf(rt.db, r.installation.id);
    throw new PaymentRefused(`Its allowance has ${usdcWords(a.available)}, not the ${usdcWords(r.amount)} this payment needs, so nothing was paid. Top it up on its page.`, "allowance");
  }
  return row ?? (await load(rt, key))!;
}

// Signs and sends a held payment, when the treasury has nothing else in
// flight. "busy" when it has: try again shortly.
async function send(rt: Runtime, p: AgentPayment): Promise<AgentPayment | "busy"> {
  const pay = rt.payments!;
  const signer = pay.signer();
  if ("problem" in signer) {
    await fail(rt, p, "The treasury can't sign payments on this server.");
    throw new PaymentRefused("The treasury can't sign payments on this server, so nothing was paid.", "signer");
  }
  const token = pay.config.currencies.USDC.token as Address;
  const treasury = pay.config.treasury!;
  const amount = BigInt(p.amount);
  // Enough USDC to pay it and keep the floor, and ETH for gas: else payments pause site wide.
  const balance = await pay.chain.tokenBalance(token, treasury);
  if (balance - amount < treasuryFloor()) {
    const now = rt.now();
    const reason = "The treasury's USDC is too low to pay agents.";
    await setPaymentsPaused(rt.db, reason, null);
    await raiseAlert(rt.db, { kind: "low_treasury", key: `low_treasury:${now.toISOString().slice(0, 13)}`, message: `${reason} It has ${usdcWords(balance)}; a payment of ${usdcWords(amount)} would leave less than the ${usdcWords(treasuryFloor())} it keeps.`, details: { balance: balance.toString(), amount: amount.toString() }, at: now });
    await fail(rt, p, reason);
    throw new PaymentRefused(`Agent payments are paused on boardofserv for now: ${reason} Nothing was paid.`, "treasury");
  }
  const fees = await pay.chain.transferFees({ token, from: treasury, to: p.toAddress as Address, amount });
  if ((await pay.chain.nativeBalance(treasury)) < fees.gas * fees.maxFeePerGas) {
    const now = rt.now();
    const reason = "The treasury has too little ETH for gas to pay agents.";
    await setPaymentsPaused(rt.db, reason, null);
    await raiseAlert(rt.db, { kind: "low_treasury", key: `low_gas:${now.toISOString().slice(0, 13)}`, message: reason, at: now });
    await fail(rt, p, reason);
    throw new PaymentRefused(`Agent payments are paused on boardofserv for now: ${reason} Nothing was paid.`, "treasury");
  }
  // Decided under the treasury's lock: nothing else in flight, the next nonce.
  const now = rt.now();
  const recorded = await rt.db.transaction(async (tx) => {
    await lockTreasury(tx);
    if (await treasuryBusy(tx, pay.config.chainId)) return null;
    const nonce = await nextNonce(tx, pay.chain, signer, pay.config.chainId);
    const signed = await signer.signTransfer({ chainId: pay.config.chainId, token, to: p.toAddress as Address, amount, nonce, ...fees });
    const [row] = await tx
      .update(agentPayments)
      .set({ status: "broadcast", fromAddress: signer.address.toLowerCase(), nonce, txHash: signed.hash, rawTx: signed.raw, broadcastAt: now, lastSentAt: now, sends: 1, updatedAt: now })
      .where(and(eq(agentPayments.id, p.id), eq(agentPayments.status, "held")))
      .returning();
    return row ?? null;
  });
  if (!recorded) return "busy";
  try {
    await pay.chain.sendRaw(recorded.rawTx as Hex);
  } catch (err) {
    // Recorded already: waiting sends the same bytes again.
    rt.log(`payments: an agent payment wasn't sent yet, will retry: ${chainError(err)}`);
  }
  return recorded;
}

// Looks once at a broadcast payment: confirmed (spent), reverted or stuck
// (released), or still waiting (its bytes sent again after a while).
export async function settleOnce(rt: Runtime, p: AgentPayment): Promise<AgentPayment> {
  const pay = rt.payments!;
  const now = rt.now();
  const r = await pay.chain.receipt(p.txHash as Hex);
  if (r) {
    const head = await pay.chain.blockNumber();
    if (head - r.blockNumber + 1n < BigInt(pay.config.confirmations)) return p;
    if (r.status === "success") {
      await rt.db.transaction(async (tx) => {
        const [row] = await tx
          .update(agentPayments)
          .set({ status: "confirmed", blockNumber: r.blockNumber.toString(), settledAt: now, updatedAt: now })
          .where(and(eq(agentPayments.id, p.id), eq(agentPayments.status, "broadcast")))
          .returning();
        if (!row) return;
        await spendPayment(tx, { installationId: row.installationId, ownerUserId: row.ownerUserId, amount: BigInt(row.amount), paymentId: row.id, at: now });
        await markPaid(tx, row.payeeId, now);
      });
    } else {
      await fail(rt, p, "The transfer reverted on Base.");
    }
    return (await load(rt, p.key))!;
  }
  // Never mined and its nonce taken by another transaction: it never can be.
  const taken = p.nonce !== null && (await pay.chain.nonce(p.fromAddress as Address, "latest")) > p.nonce;
  if (taken && !(await pay.chain.receipt(p.txHash as Hex))) {
    await fail(rt, p, "The transfer was never mined, and its place was taken.");
    return (await load(rt, p.key))!;
  }
  if (!p.lastSentAt || now.getTime() - p.lastSentAt.getTime() >= RESEND_MS) {
    try {
      await pay.chain.sendRaw(p.rawTx as Hex);
    } catch (err) {
      rt.log(`payments: an agent payment resend failed, will retry: ${chainError(err)}`);
    }
    await rt.db.update(agentPayments).set({ sends: sql`${agentPayments.sends} + 1`, lastSentAt: now, updatedAt: now }).where(eq(agentPayments.id, p.id));
  }
  return p;
}

// The whole payment, from the job's step: start (or find) it, send it when
// the treasury is free, and wait for it to settle, within the confirm
// window. Returns the confirmed payment; refused, reverted or stuck throws
// PaymentRefused (nothing spent); not settled in time throws PaymentPending
// (the job tries again later and finds it).
export async function payFromAllowance(rt: Runtime, r: PayRequest): Promise<AgentPayment> {
  const pay = rt.payments;
  const key = `job:${r.jobId}:${r.callKey}`;
  let p = (await load(rt, key)) ?? (await start(rt, r, key));
  const deadline = Date.now() + (pay?.confirmWithinMs ?? 90_000);
  for (;;) {
    if (p.status === "confirmed") return p;
    if (p.status === "failed") throw new PaymentRefused(`${p.error ?? "The payment didn't go through."} Nothing was spent from its allowance.`, p.error?.includes("reverted") ? "reverted" : "stuck");
    if (p.status === "held") {
      const sent = await send(rt, p);
      if (sent !== "busy") p = sent;
    } else {
      p = await settleOnce(rt, p);
    }
    if (p.status === "confirmed" || p.status === "failed") continue;
    if (Date.now() > deadline) throw new PaymentPending();
    await pay!.wait(POLL_MS);
    p = (await load(rt, key))!;
  }
}

// From the worker's cycle: payments whose job stopped waiting on them. A
// broadcast one is settled (confirmed or released) whatever its job does;
// a held one whose job has ended without sending it is released.
export async function settlePayments(rt: Runtime, limit = 20): Promise<number> {
  if (!rt.payments) return 0;
  const now = rt.now();
  let settled = 0;
  const flying = await rt.db.select().from(agentPayments).where(eq(agentPayments.status, "broadcast")).limit(limit);
  for (const p of flying) {
    const after = await settleOnce(rt, p);
    if (after.status !== "broadcast") settled += 1;
  }
  const stale = await rt.db
    .select({ p: agentPayments, job: agentJobs.status })
    .from(agentPayments)
    .leftJoin(agentJobs, eq(agentJobs.id, agentPayments.jobId))
    .where(and(eq(agentPayments.status, "held"), lt(agentPayments.updatedAt, new Date(now.getTime() - 10 * 60_000))))
    .limit(limit);
  for (const s of stale) {
    if (s.job === "running" || s.job === "queued" || s.job === "waiting_for_owner") continue;
    await fail(rt, s.p, "Its job ended before the payment was sent.");
    settled += 1;
  }
  return settled;
}

export const payeeWords = (p: Pick<Payee, "label" | "address">) => `${p.label} (${short(p.address)})`;
