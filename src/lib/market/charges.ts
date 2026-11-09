import "server-only";
import { and, eq, inArray, isNull, ne } from "drizzle-orm";
import { agentInstallations, agentJobs, holds, rentals, type AgentJob } from "../db/schema";
import { jobSiteCost } from "../agents/metering";
import { holdFunds, post, releaseFunds, type Exec } from "../payments/ledger";
import { formatAmount, splitCharge } from "../money";
import type { Runtime } from "../agents/runtime/context";

// Money for rented agents, through the ledger the way a helper's paid use
// goes: an amount is held from what the renter has available, then either
// captured (taken from the hold: 90% to the maker, 10% to the platform) or
// released (given back). A week's rent is captured at once; a fee per job
// is held before the job starts and settled when it ends: captured when it
// finished, released when it failed or was stopped. Test runs pay no fee.

export const USDC_DECIMALS = 6;
export const usdc = (minor: string | bigint) => `${formatAmount(BigInt(minor), USDC_DECIMALS)} USDC`;

// Holds `amount` of the renter's USDC for the maker, in the caller's
// transaction. Null when the balance doesn't cover it.
export async function holdFor(tx: Exec, o: { renterUserId: string; makerUserId: string; amount: bigint; kind: "rent" | "job_fee" | "model"; jobId?: string; at?: Date }): Promise<string | null> {
  if (!(await holdFunds(tx, o.renterUserId, "USDC", o.amount))) return null;
  const [h] = await tx
    .insert(holds)
    .values({ userId: o.renterUserId, currency: "USDC", amount: o.amount.toString(), makerUserId: o.makerUserId, kind: o.kind, jobId: o.jobId ?? null, createdAt: o.at ?? new Date() })
    .returning({ id: holds.id });
  return h!.id;
}

// A hold captured, once: the charge out of what was held, the maker's
// share and the platform's.
export async function capture(tx: Exec, holdId: string, at: Date = new Date()): Promise<boolean> {
  const [h] = await tx
    .update(holds)
    .set({ status: "captured", settledAt: at })
    .where(and(eq(holds.id, holdId), eq(holds.status, "held")))
    .returning();
  if (!h) return false;
  const amount = BigInt(h.amount);
  const { maker, platform } = splitCharge(amount);
  await post(tx, { userId: h.userId, currency: h.currency, kind: "use_charge", amount: -amount, referenceId: h.id, key: `hold:${h.id}:charge` });
  if (maker > 0n) await post(tx, { userId: h.makerUserId, currency: h.currency, kind: "maker_earning", amount: maker, referenceId: h.id, key: `hold:${h.id}:maker` });
  if (platform > 0n) await post(tx, { userId: null, currency: h.currency, kind: "platform_fee", amount: platform, referenceId: h.id, key: `hold:${h.id}:platform` });
  return true;
}

// A hold given back, once.
export async function release(tx: Exec, holdId: string, at: Date = new Date()): Promise<boolean> {
  const [h] = await tx
    .update(holds)
    .set({ status: "released", settledAt: at })
    .where(and(eq(holds.id, holdId), eq(holds.status, "held")))
    .returning();
  if (!h) return false;
  if (!(await releaseFunds(tx, h.userId, h.currency, BigInt(h.amount)))) throw new Error("A hold's funds were not held.");
  return true;
}

export const FEE_SHORT = (fee: string) => `Its fee per job (${usdc(fee)}) couldn't be set aside: your balance is too low. Top up your wallet, and it runs the next time.`;

// Before a rented agent's job first starts: its fee held from the renter.
// "none" with no fee to hold (not rented, no fee, a test run, or held
// already), "held", or "short" when the balance doesn't cover it.
export async function holdJobFee(rt: Runtime, job: AgentJob): Promise<{ how: "none" } | { how: "held" | "short"; fee: string }> {
  if ((job.trigger as { kind?: string }).kind === "test" || job.feeHoldId) return { how: "none" };
  const [r] = await rt.db
    .select()
    .from(rentals)
    .where(and(eq(rentals.installationId, job.installationId), ne(rentals.status, "ended")));
  if (!r || BigInt(r.jobFee) === 0n) return { how: "none" };
  return rt.db.transaction(async (tx) => {
    const holdId = await holdFor(tx, { renterUserId: r.renterUserId, makerUserId: r.makerUserId, amount: BigInt(r.jobFee), kind: "job_fee", jobId: job.id, at: rt.now() });
    if (!holdId) return { how: "short" as const, fee: r.jobFee };
    await tx.update(agentJobs).set({ feeHoldId: holdId }).where(eq(agentJobs.id, job.id));
    return { how: "held" as const, fee: r.jobFee };
  });
}

// From the worker's cycle: the fees of jobs that have ended, settled.
export async function settleJobFees(rt: Runtime, limit = 100): Promise<number> {
  const open = await rt.db
    .select({ holdId: holds.id, status: agentJobs.status })
    .from(holds)
    .innerJoin(agentJobs, eq(agentJobs.id, holds.jobId))
    .where(and(eq(holds.kind, "job_fee"), eq(holds.status, "held"), inArray(agentJobs.status, ["done", "failed", "cancelled"])))
    .limit(limit);
  let settled = 0;
  for (const o of open) {
    if (await rt.db.transaction((tx) => (o.status === "done" ? capture(tx, o.holdId, rt.now()) : release(tx, o.holdId, rt.now())))) settled += 1;
  }
  return settled;
}

// A hold for a job's model cost, captured for the platform alone: the
// platform paid the model, so none of it is the maker's.
export async function capturePlatform(tx: Exec, holdId: string, at: Date = new Date()): Promise<boolean> {
  const [h] = await tx
    .update(holds)
    .set({ status: "captured", settledAt: at })
    .where(and(eq(holds.id, holdId), eq(holds.status, "held")))
    .returning();
  if (!h) return false;
  const amount = BigInt(h.amount);
  await post(tx, { userId: h.userId, currency: h.currency, kind: "use_charge", amount: -amount, referenceId: h.id, key: `hold:${h.id}:charge` });
  await post(tx, { userId: null, currency: h.currency, kind: "platform_fee", amount, referenceId: h.id, key: `hold:${h.id}:platform` });
  return true;
}

export const MODEL_SHORT = (cost: bigint) => `A job's model cost of ${usdc(cost)} couldn't be paid: your balance is too low. Top up your wallet, then resume it.`;

// From the worker's cycle: for agents whose renters pay their jobs' model
// cost, each ended job's cost (what the site paid, not calls on the
// renter's own key) is charged once. A balance that can't cover it pauses
// the installation with a plain message.
export async function chargeModelShares(rt: Runtime, limit = 100): Promise<number> {
  const ended = await rt.db
    .select({ jobId: agentJobs.id, installationId: agentJobs.installationId, renterUserId: rentals.renterUserId, makerUserId: rentals.makerUserId })
    .from(agentJobs)
    .innerJoin(rentals, eq(rentals.installationId, agentJobs.installationId))
    .where(and(eq(rentals.modelShare, true), isNull(agentJobs.modelSettledAt), inArray(agentJobs.status, ["done", "failed", "cancelled"])))
    .limit(limit);
  let charged = 0;
  for (const e of ended) {
    const now = rt.now();
    const cost = await jobSiteCost(rt, e.jobId);
    if (cost > 0n) {
      const paid = await rt.db.transaction(async (tx) => {
        const holdId = await holdFor(tx, { renterUserId: e.renterUserId, makerUserId: e.makerUserId, amount: cost, kind: "model", jobId: e.jobId, at: now });
        if (!holdId) return false;
        return capturePlatform(tx, holdId, now);
      });
      if (paid) charged += 1;
      else {
        await rt.db
          .update(agentInstallations)
          .set({ status: "paused", pausedReason: MODEL_SHORT(cost), updatedAt: now })
          .where(and(eq(agentInstallations.id, e.installationId), eq(agentInstallations.status, "active")));
      }
    }
    await rt.db.update(agentJobs).set({ modelSettledAt: now }).where(eq(agentJobs.id, e.jobId));
  }
  return charged;
}
