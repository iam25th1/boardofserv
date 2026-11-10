import "server-only";
import { and, eq, gte, inArray, ne, sql } from "drizzle-orm";
import { agentInstallations, agentListings, agentMessages, agentPayments, type AgentInstallation } from "../db/schema";
import type { Runtime } from "../agents/runtime/context";
import type { TrustDTO } from "../types";
import { readPolicy } from "../agents/risk";
import { holdOn } from "../safety/freeze";
import { parseAmount } from "../money";
import { versionTrust } from "../trust/trust";
import { usdcWords } from "./allowance";

// What an agent may pay without asking, and whether it may pay at all.
// Its trust score's band sets the most, per payment and per day; the
// renter's own auto limit (the phase 5 floor: nothing unless they raised
// it) can never go above it; the site's day of agent payments has a cap of
// its own; and the phase 0 site limit makes SERV's check ask (tools.ts).
// The strictest wins. A frozen agent, maker or renter, an agent stopped
// everywhere or a listing on hold for review can't pay anything.

type Env = Record<string, string | undefined>;
const USDC = (whole: number) => BigInt(Math.round(whole * 1_000_000));

// The whole site's agent payments a day (AGENT_PAYMENTS_SITE_DAILY_USDC),
// 1000 USDC unless set.
export function siteDailyCap(env: Env = process.env): bigint {
  const raw = env.AGENT_PAYMENTS_SITE_DAILY_USDC?.trim();
  const n = raw && /^\d{1,9}(\.\d{1,6})?$/.test(raw) ? parseAmount(raw, 6) : null;
  return n ?? 1_000_000_000n;
}

const dayStart = (t: Date) => new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate()));

// Agent payments since a time that are going or gone (a failed one isn't).
async function paidSince(rt: Runtime, since: Date, installationId?: string): Promise<bigint> {
  const [row] = await rt.db
    .select({ total: sql<string>`coalesce(sum(${agentPayments.amount}), 0)::text` })
    .from(agentPayments)
    .where(and(inArray(agentPayments.status, ["held", "broadcast", "confirmed"]), gte(agentPayments.createdAt, since), installationId ? eq(agentPayments.installationId, installationId) : undefined));
  return BigInt(row?.total ?? "0");
}

export interface PaymentLimits {
  trust: TrustDTO;
  // All in USDC minor units.
  renterAuto: bigint;
  bandPayment: bigint;
  // What it may pay without asking: the stricter of the two, and the band's day.
  perPayment: bigint;
  perDay: bigint;
  paidToday: bigint;
  siteCap: bigint;
  sitePaidToday: bigint;
  // Why it can't pay at all now, or null.
  stopped: string | null;
}

export async function paymentLimits(rt: Runtime, i: AgentInstallation, env: Env = process.env): Promise<PaymentLimits> {
  const trust = (await versionTrust(rt, [i.versionId])).get(i.versionId)!;
  const renterAuto = USDC(readPolicy(i.policy).autoSpendUsdc);
  const bandPayment = USDC(trust.band.perPayment);
  const today = dayStart(rt.now());
  const stopped = await payStopped(rt, i);
  return {
    trust,
    renterAuto,
    bandPayment,
    perPayment: renterAuto < bandPayment ? renterAuto : bandPayment,
    perDay: USDC(trust.band.perDay),
    paidToday: await paidSince(rt, today, i.id),
    siteCap: siteDailyCap(env),
    sitePaidToday: await paidSince(rt, today),
    stopped,
  };
}

// Why it can't pay anything now: its agent stopped everywhere, a freeze on
// its agent, version, maker or renter, or its listing held for review.
export async function payStopped(rt: Runtime, i: Pick<AgentInstallation, "agentId" | "versionId" | "ownerUserId">): Promise<string | null> {
  const held = await holdOn(rt, i);
  if (held) return held;
  const [l] = await rt.db.select({ screen: agentListings.screen }).from(agentListings).where(eq(agentListings.agentId, i.agentId));
  return l?.screen === "held" ? "Its listing is on hold for review." : null;
}

const scoreWords = (t: TrustDTO) => `its trust score of ${t.score} (${t.label})`;

// What the band allows, in a line.
export function bandLine(l: Pick<PaymentLimits, "trust" | "bandPayment" | "perDay">): string {
  const s = scoreWords(l.trust);
  return l.bandPayment === 0n ? `With ${s} it can't pay anything without asking.` : `With ${s} it may pay up to ${usdcWords(l.bandPayment)} a payment and ${usdcWords(l.perDay)} a day without asking.`;
}

// Its effective auto limit, and which limit sets it.
export function limitWhy(l: Pick<PaymentLimits, "trust" | "renterAuto" | "bandPayment" | "perDay">): string {
  if (l.renterAuto === 0n) return "You approve every payment it makes.";
  if (l.bandPayment === 0n) return `You allow ${usdcWords(l.renterAuto)} a payment, but with ${scoreWords(l.trust)} it can't pay anything without asking.`;
  if (l.renterAuto <= l.bandPayment) return `Your auto limit: ${usdcWords(l.renterAuto)} a payment, and up to ${usdcWords(l.perDay)} a day.`;
  return `You allow ${usdcWords(l.renterAuto)} a payment, but with ${scoreWords(l.trust)} it may pay at most ${usdcWords(l.bandPayment)} a payment and ${usdcWords(l.perDay)} a day without asking.`;
}

// For one payment: why it can't go at all (refuse), and why it must ask.
export function judgePayment(l: PaymentLimits, amount: bigint): { refuse: string | null; asks: string[] } {
  if (l.stopped) return { refuse: `${l.stopped} It can't pay anything now.`, asks: [] };
  if (l.sitePaidToday + amount > l.siteCap) return { refuse: "boardofserv's agent payments for today are used up, so nothing was paid. It can pay again tomorrow (UTC).", asks: [] };
  const asks: string[] = [];
  if (amount > l.perPayment) {
    if (l.renterAuto === 0n) asks.push("It spends money, and you approve every payment it makes.");
    else if (l.renterAuto <= l.bandPayment) asks.push(`It's over your auto limit of ${usdcWords(l.renterAuto)}.`);
    else if (l.bandPayment === 0n) asks.push(`With ${scoreWords(l.trust)} it can't pay anything without asking.`);
    else asks.push(`It's over the ${usdcWords(l.bandPayment)} a payment that ${scoreWords(l.trust)} allows without asking (your own auto limit is ${usdcWords(l.renterAuto)}).`);
  }
  if (l.perPayment > 0n && l.paidToday + amount > l.perDay) asks.push(`With it, today's payments come to ${usdcWords(l.paidToday + amount)}, over the ${usdcWords(l.perDay)} a day that ${scoreWords(l.trust)} allows without asking.`);
  return { refuse: null, asks };
}

// After a version's score changes: renters whose auto limit it now cuts
// are told, once per change, in their message box (and Telegram).
export async function tellBandDrop(rt: Runtime, versionId: string, before: TrustDTO, after: TrustDTO, agentName: string): Promise<number> {
  const was = USDC(before.band.perPayment);
  const now = USDC(after.band.perPayment);
  if (now >= was && after.band.perDay >= before.band.perDay) return 0;
  const installs = await rt.db
    .select()
    .from(agentInstallations)
    .where(and(eq(agentInstallations.versionId, versionId), ne(agentInstallations.status, "stopped")));
  let told = 0;
  for (const i of installs) {
    const auto = USDC(readPolicy(i.policy).autoSpendUsdc);
    if (auto === 0n) continue;
    const old = auto < was ? auto : was;
    const cut = auto < now ? auto : now;
    if (cut >= old && after.band.perDay >= before.band.perDay) continue;
    const text =
      now === 0n
        ? `${agentName}'s trust score fell to ${after.score} (${after.label}), so it now asks you before every payment, whatever your auto limit.`
        : `${agentName}'s trust score fell to ${after.score} (${after.label}), so it may now pay up to ${usdcWords(cut)} a payment and ${usdcWords(USDC(after.band.perDay))} a day without asking${auto > now ? `, less than your auto limit of ${usdcWords(auto)}` : ""}. Anything over that asks you first.`;
    await rt.db.insert(agentMessages).values({ installationId: i.id, from: "agent", text, tgState: "pending", createdAt: rt.now() });
    told++;
  }
  return told;
}
