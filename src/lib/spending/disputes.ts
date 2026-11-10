import "server-only";
import { and, count, desc, eq, gte, inArray, isNotNull, sql } from "drizzle-orm";
import { agentMessages, agentPayments, agents, balances, disputes, ledgerEntries, rentalCharges, rentals, users, DISPUTE_REASONS, type Dispute, type User } from "../db/schema";
import type { Runtime } from "../agents/runtime/context";
import type { DisputableDTO, DisputeDTO } from "../types";
import { fixDashes } from "../dashes";
import { post, type Exec } from "../payments/ledger";
import { refreshVersion } from "../trust/trust";
import { usdcWords } from "./allowance";

// Disputes. A renter disputes an agent payment or a week's rent within the
// dispute window, with a reason and a note; it waits in the admin queue.
// An upheld rent dispute is refunded through the ledger: the renter's money
// back, the maker's share taken back (as much as they still have; the
// platform covers the rest) and the platform's share given back. A payment
// on chain can't be pulled back: an upheld payment dispute counts against
// the agent's trust score instead, and the screen says so before a renter
// approves any payment. A few open at a time, and a few a month, per renter.

type Env = Record<string, string | undefined>;
const DAY = 86_400_000;

export const MAX_OPEN_DISPUTES = 3;
export const DISPUTES_PER_30_DAYS = 6;
export const NOTE_MIN = 10;
export const NOTE_MAX = 1000;

// How long after a payment or a week's rent it can be disputed
// (DISPUTE_WINDOW_DAYS, 14 unless set, at most 90).
export function disputeWindowDays(env: Env = process.env): number {
  const n = Number(env.DISPUTE_WINDOW_DAYS);
  return env.DISPUTE_WINDOW_DAYS?.trim() && Number.isInteger(n) && n >= 1 && n <= 90 ? n : 14;
}

export type DisputeReason = (typeof DISPUTE_REASONS)[number];
export const DISPUTE_REASON_WORDS: Record<DisputeReason, string> = {
  not_done: "It paid for something that wasn't done",
  not_wanted: "I didn't want this payment made",
  wrong_amount: "It paid the wrong amount",
  wrong_payee: "It paid the wrong payee",
  not_working: "The agent didn't work that week",
  other: "Something else",
};
export const REASONS_FOR: Record<Dispute["kind"], readonly DisputeReason[]> = {
  payment: ["not_done", "not_wanted", "wrong_amount", "wrong_payee", "other"],
  rent: ["not_working", "other"],
};

export const CANT_PULL_BACK = "A payment on Base can't be pulled back once it is sent. If your dispute is upheld, it counts against the agent's trust score, but the money stays with the payee.";

export class DisputeRefused extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "DisputeRefused";
  }
}

const isId = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
const day = (d: Date) => d.toISOString().slice(0, 10);
const paymentWhat = (amount: bigint, label: string, at: Date) => `${usdcWords(amount)} to ${label} on ${day(at)}`;
const rentWhat = (week: number, at: Date) => `Rent for week ${week}, paid ${day(at)}`;

export interface DisputeRequest {
  kind: Dispute["kind"];
  // The payment's id, or "<rental id>:<week>".
  id: string;
  reason: string;
  note: string;
}

// What it is: the renter's own payment that went through, or their own
// week of rent, within the window. Null when there is nothing like that.
async function disputed(rt: Runtime, renter: User, r: DisputeRequest, since: Date) {
  if (r.kind === "payment") {
    if (!isId(r.id)) return null;
    const [p] = await rt.db
      .select({ p: agentPayments, maker: agents.ownerUserId })
      .from(agentPayments)
      .innerJoin(agents, eq(agents.id, agentPayments.agentId))
      .where(and(eq(agentPayments.id, r.id), eq(agentPayments.ownerUserId, renter.id)));
    if (!p) return null;
    if (p.p.status !== "confirmed") throw new DisputeRefused(p.p.status === "failed" ? "That payment never went out, so there is nothing to dispute." : "That payment hasn't gone through yet. Dispute it once it has.", 409);
    if ((p.p.settledAt ?? p.p.createdAt) < since) throw new DisputeRefused(`That payment is older than ${disputeWindowDays()} days, too old to dispute.`, 409);
    return { kind: "payment" as const, makerUserId: p.maker, agentId: p.p.agentId, versionId: p.p.versionId, installationId: p.p.installationId, paymentId: p.p.id, rentalId: null, week: null, holdId: null, amount: BigInt(p.p.amount) };
  }
  const [rentalId, weekText] = r.id.split(":");
  const week = Number(weekText);
  if (!rentalId || !isId(rentalId) || !Number.isInteger(week) || week < 1) return null;
  const [c] = await rt.db
    .select({ c: rentalCharges, r: rentals })
    .from(rentalCharges)
    .innerJoin(rentals, eq(rentals.id, rentalCharges.rentalId))
    .where(and(eq(rentalCharges.rentalId, rentalId), eq(rentalCharges.week, week), eq(rentals.renterUserId, renter.id)));
  if (!c) return null;
  if (BigInt(c.c.amount) === 0n || !c.c.holdId) throw new DisputeRefused("That week was free, so there is nothing to refund.", 409);
  if (c.c.createdAt < since) throw new DisputeRefused(`That week's rent is older than ${disputeWindowDays()} days, too old to dispute.`, 409);
  return { kind: "rent" as const, makerUserId: c.r.makerUserId, agentId: c.r.agentId, versionId: c.r.versionId, installationId: c.r.installationId, paymentId: null, rentalId: c.r.id, week, holdId: c.c.holdId, amount: BigInt(c.c.amount) };
}

export async function openDispute(rt: Runtime, renter: User, r: DisputeRequest): Promise<Dispute> {
  if (r.kind !== "payment" && r.kind !== "rent") throw new DisputeRefused("Dispute a payment or a week's rent.");
  const reason = r.reason as DisputeReason;
  if (!REASONS_FOR[r.kind].includes(reason)) throw new DisputeRefused("Pick one of the reasons.");
  const note = fixDashes(r.note.trim());
  if (note.length < NOTE_MIN || note.length > NOTE_MAX) throw new DisputeRefused(`Say what happened in ${NOTE_MIN} to ${NOTE_MAX} characters.`);
  const now = rt.now();
  const what = await disputed(rt, renter, r, new Date(now.getTime() - disputeWindowDays() * DAY));
  if (!what) throw new DisputeRefused("There's nothing of yours like that to dispute.", 404);
  const [open] = await rt.db.select({ n: count() }).from(disputes).where(and(eq(disputes.renterUserId, renter.id), eq(disputes.status, "open")));
  if ((open?.n ?? 0) >= MAX_OPEN_DISPUTES) throw new DisputeRefused(`You have ${MAX_OPEN_DISPUTES} disputes waiting already. Once an admin has decided one, you can open another.`, 429);
  const [recent] = await rt.db.select({ n: count() }).from(disputes).where(and(eq(disputes.renterUserId, renter.id), gte(disputes.createdAt, new Date(now.getTime() - 30 * DAY))));
  if ((recent?.n ?? 0) >= DISPUTES_PER_30_DAYS) throw new DisputeRefused(`That's ${DISPUTES_PER_30_DAYS} disputes in 30 days, the most there can be. Write to boardofserv if something else is wrong.`, 429);
  const [row] = await rt.db
    .insert(disputes)
    .values({ ...what, amount: what.amount.toString(), renterUserId: renter.id, reason, note, createdAt: now })
    .onConflictDoNothing()
    .returning();
  if (!row) throw new DisputeRefused("You disputed it already. An admin will look.", 409);
  return row;
}

// Can the ledger take refunds yet? Not until the owner has run
// scripts/sql/ledger-kinds.sql on a database a deploy only pushed to.
export async function ledgerReady(exec: Exec): Promise<boolean> {
  const rows = await exec.execute<{ def: string }>(
    sql`select pg_get_constraintdef(c.oid) as def from pg_constraint c join pg_class t on t.oid = c.conrelid where t.relname = 'ledger_entries' and c.conname in ('ledger_entries_kind', 'ledger_entries_sign', 'ledger_entries_platform')`,
  );
  const defs = ((rows as unknown as { rows?: { def: string }[] }).rows ?? (rows as unknown as { def: string }[])).map((r) => r.def);
  return defs.length === 3 && defs.some((d) => d.includes("'refund'")) && defs.some((d) => d.includes("'earning_reversal'") && d.includes("'platform_refund'") && d.includes("'-%'")) && defs.some((d) => d.includes("'platform_refund'") && d.includes("IS NULL"));
}

async function tell(rt: Runtime, d: Dispute, text: string): Promise<void> {
  if (d.installationId) await rt.db.insert(agentMessages).values({ installationId: d.installationId, from: "agent", text, tgState: "pending", createdAt: rt.now() });
}

// An upheld rent dispute's refund, once, in one transaction. False while
// the ledger can't take refunds yet (it stays waiting).
export async function refundRent(rt: Runtime, disputeId: string): Promise<boolean> {
  if (!(await ledgerReady(rt.db))) return false;
  const done = await rt.db.transaction(async (tx) => {
    const [d] = await tx
      .select()
      .from(disputes)
      .where(and(eq(disputes.id, disputeId), eq(disputes.kind, "rent"), eq(disputes.status, "upheld"), eq(disputes.refund, "waiting")))
      .for("update");
    if (!d?.holdId) return null;
    const amount = BigInt(d.amount);
    const [earned] = await tx.select({ amount: ledgerEntries.amount }).from(ledgerEntries).where(eq(ledgerEntries.idempotencyKey, `hold:${d.holdId}:maker`));
    const share = BigInt(earned?.amount ?? "0");
    const [bal] = await tx.select({ available: balances.available }).from(balances).where(and(eq(balances.userId, d.makerUserId), eq(balances.currency, "USDC"))).for("update");
    const has = BigInt(bal?.available ?? "0");
    // What the maker still has of their share comes back from them; the
    // platform covers what they have already withdrawn.
    const fromMaker = share < has ? share : has;
    const fromPlatform = amount - fromMaker;
    const now = rt.now();
    await post(tx, { userId: d.renterUserId, currency: "USDC", kind: "refund", amount, referenceId: d.id, key: `dispute:${d.id}:refund` });
    if (fromMaker > 0n) await post(tx, { userId: d.makerUserId, currency: "USDC", kind: "earning_reversal", amount: -fromMaker, referenceId: d.holdId, key: `dispute:${d.id}:maker` });
    if (fromPlatform > 0n) await post(tx, { userId: null, currency: "USDC", kind: "platform_refund", amount: -fromPlatform, referenceId: d.holdId, key: `dispute:${d.id}:platform` });
    const [after] = await tx
      .update(disputes)
      .set({ refund: "done", makerReversed: fromMaker.toString(), platformReversed: fromPlatform.toString(), refundedAt: now })
      .where(eq(disputes.id, d.id))
      .returning();
    return after!;
  });
  if (!done) return false;
  const [a] = await rt.db.select({ name: agents.name }).from(agents).where(eq(agents.id, done.agentId));
  await tell(rt, done, `Your ${usdcWords(BigInt(done.amount))} rent for ${a?.name ?? "the agent"} (week ${done.week}) is back in your balance.`);
  return true;
}

// From the worker's cycle: upheld rent disputes still waiting for a refund.
export async function refundsWaiting(rt: Runtime, limit = 20): Promise<number> {
  const waiting = await rt.db.select({ id: disputes.id }).from(disputes).where(and(eq(disputes.status, "upheld"), eq(disputes.refund, "waiting"))).limit(limit);
  if (!waiting.length || !(await ledgerReady(rt.db))) return 0;
  let n = 0;
  for (const w of waiting) if (await refundRent(rt, w.id)) n++;
  return n;
}

// An admin upholds or rejects an open dispute, with a reason. The renter is
// told; the agent's score is computed again at once.
export async function decideDispute(rt: Runtime, admin: User, id: string, decision: "uphold" | "reject", reason: string): Promise<Dispute | null> {
  if (!isId(id)) return null;
  const now = rt.now();
  const [d] = await rt.db
    .update(disputes)
    .set({
      status: decision === "uphold" ? "upheld" : "rejected",
      resolution: `${decision === "uphold" ? "Upheld" : "Not upheld"}: ${fixDashes(reason.trim()).slice(0, 300)}`,
      resolvedBy: admin.id,
      resolvedAt: now,
      refund: decision === "uphold" ? sql`case when ${disputes.kind} = 'rent' then 'waiting' else 'none' end` : "none",
    })
    .where(and(eq(disputes.id, id), eq(disputes.status, "open")))
    .returning();
  if (!d) return null;
  const [a] = await rt.db.select({ name: agents.name }).from(agents).where(eq(agents.id, d.agentId));
  const name = a?.name ?? "the agent";
  const amount = usdcWords(BigInt(d.amount));
  const why = d.resolution!.replace(/^(Upheld|Not upheld): /, "");
  if (decision === "reject") await tell(rt, d, `Your dispute of ${d.kind === "payment" ? `a ${amount} payment` : `${amount} rent`} by ${name} wasn't upheld: ${why}`);
  else if (d.kind === "payment") await tell(rt, d, `Your dispute of a ${amount} payment by ${name} was upheld: ${why} The payment can't be pulled back on Base, so it counts against ${name}'s trust score.`);
  else if (!(await refundRent(rt, d.id))) await tell(rt, d, `Your dispute of ${amount} rent for ${name} was upheld: ${why} The refund is on its way to your balance.`);
  if (d.versionId) await refreshVersion(rt, d.versionId);
  const [after] = await rt.db.select().from(disputes).where(eq(disputes.id, d.id));
  return after!;
}

export function disputeDTO(d: Dispute, agentName: string, what: string): DisputeDTO {
  return {
    id: d.id,
    kind: d.kind,
    agentName,
    what,
    amount: d.amount,
    decimals: 6,
    reason: d.reason,
    reasonWords: DISPUTE_REASON_WORDS[d.reason],
    note: d.note,
    status: d.status,
    resolution: d.resolution,
    refund: d.refund,
    createdAt: d.createdAt.toISOString(),
    resolvedAt: d.resolvedAt?.toISOString() ?? null,
  };
}

// What a dispute is about, in words.
async function whatOf(rt: Runtime, rows: Dispute[]): Promise<Map<string, { agent: string; what: string }>> {
  const agentIds = [...new Set(rows.map((d) => d.agentId))];
  const names = agentIds.length ? await rt.db.select({ id: agents.id, name: agents.name }).from(agents).where(inArray(agents.id, agentIds)) : [];
  const paymentIds = rows.map((d) => d.paymentId).filter((x): x is string => Boolean(x));
  const pays = paymentIds.length ? await rt.db.select().from(agentPayments).where(inArray(agentPayments.id, paymentIds)) : [];
  return new Map(
    rows.map((d) => {
      const p = pays.find((x) => x.id === d.paymentId);
      const what = p ? paymentWhat(BigInt(p.amount), p.payeeLabel, p.settledAt ?? p.createdAt) : rentWhat(d.week ?? 0, d.createdAt);
      return [d.id, { agent: names.find((n) => n.id === d.agentId)?.name ?? "An agent", what }];
    }),
  );
}

// A renter's disputes, newest first, and what they can still dispute.
export async function disputesOf(rt: Runtime, renterId: string): Promise<{ disputes: DisputeDTO[]; disputable: DisputableDTO[] }> {
  const rows = await rt.db.select().from(disputes).where(eq(disputes.renterUserId, renterId)).orderBy(desc(disputes.createdAt)).limit(50);
  const words = await whatOf(rt, rows);
  const days = disputeWindowDays();
  const since = new Date(rt.now().getTime() - days * DAY);
  const until = (at: Date) => new Date(at.getTime() + days * DAY).toISOString();
  const paid = await rt.db
    .select({ p: agentPayments, name: agents.name })
    .from(agentPayments)
    .innerJoin(agents, eq(agents.id, agentPayments.agentId))
    .where(and(eq(agentPayments.ownerUserId, renterId), eq(agentPayments.status, "confirmed"), gte(agentPayments.settledAt, since)))
    .orderBy(desc(agentPayments.settledAt))
    .limit(50);
  const weeks = await rt.db
    .select({ c: rentalCharges, name: agents.name })
    .from(rentalCharges)
    .innerJoin(rentals, eq(rentals.id, rentalCharges.rentalId))
    .innerJoin(agents, eq(agents.id, rentals.agentId))
    .where(and(eq(rentals.renterUserId, renterId), isNotNull(rentalCharges.holdId), gte(rentalCharges.createdAt, since)))
    .orderBy(desc(rentalCharges.createdAt))
    .limit(50);
  const taken = new Set(rows.map((d) => (d.paymentId ? d.paymentId : `${d.rentalId}:${d.week}`)));
  return {
    disputes: rows.map((d) => disputeDTO(d, words.get(d.id)!.agent, words.get(d.id)!.what)),
    disputable: [
      ...paid
        .filter(({ p }) => !taken.has(p.id))
        .map(({ p, name }) => ({ kind: "payment" as const, id: p.id, agentName: name, what: paymentWhat(BigInt(p.amount), p.payeeLabel, p.settledAt!), amount: p.amount, until: until(p.settledAt!) })),
      ...weeks
        .filter(({ c }) => !taken.has(`${c.rentalId}:${c.week}`) && BigInt(c.amount) > 0n)
        .map(({ c, name }) => ({ kind: "rent" as const, id: `${c.rentalId}:${c.week}`, agentName: name, what: rentWhat(c.week, c.createdAt), amount: c.amount, until: until(c.createdAt) })),
    ],
  };
}

// The admin's queue: open disputes, oldest first; and upheld ones whose
// refund waits for the ledger.
export async function disputeQueue(rt: Runtime): Promise<{ open: (DisputeDTO & { renter: string; maker: string })[]; waiting: number; ledgerReady: boolean }> {
  const rows = await rt.db.select().from(disputes).where(eq(disputes.status, "open")).orderBy(disputes.createdAt).limit(100);
  const words = await whatOf(rt, rows);
  const ids = [...new Set(rows.flatMap((d) => [d.renterUserId, d.makerUserId]))];
  const handles = ids.length ? await rt.db.select({ id: users.id, handle: users.handle }).from(users).where(inArray(users.id, ids)) : [];
  const handle = (id: string) => `@${handles.find((h) => h.id === id)?.handle ?? "someone"}`;
  const [waiting] = await rt.db.select({ n: count() }).from(disputes).where(and(eq(disputes.status, "upheld"), eq(disputes.refund, "waiting")));
  return {
    open: rows.map((d) => ({ ...disputeDTO(d, words.get(d.id)!.agent, words.get(d.id)!.what), renter: handle(d.renterUserId), maker: handle(d.makerUserId) })),
    waiting: waiting?.n ?? 0,
    ledgerReady: await ledgerReady(rt.db),
  };
}
