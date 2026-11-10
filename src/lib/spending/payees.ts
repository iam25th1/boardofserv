import "server-only";
import { and, asc, eq, ne, sql } from "drizzle-orm";
import { getAddress, isAddress, type Address } from "viem";
import { agentInstallations, agentMessages, payees, type Payee, type User } from "../db/schema";
import { paymentsConfig } from "../payments/config";
import type { Runtime } from "../agents/runtime/context";
import type { Exec } from "../payments/ledger";

// Saved payees: who an installation's agent may pay. Its renter keeps the
// list (a label and a Base address each); an agent pays nobody else. The
// first payment to a payee always asks the renter, and a payee whose
// address changes is a new payee, so it asks again. When an agent wants to
// pay an address that isn't saved, the address waits as a suggestion until
// the renter confirms it on screen (never from a chat button).

export const MAX_PAYEES = 20;

export class PayeeRefused extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "PayeeRefused";
  }
}

// A label: plain words, short.
export function readLabel(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const label = raw.trim().replace(/\s+/g, " ");
  return /^[\p{L}\p{N}][\p{L}\p{N} .,'&()-]{0,39}$/u.test(label) ? label : null;
}

// An address on Base: valid, checksummed when it has capitals (a mixed
// case one with a wrong checksum is a typo), never the zero address, the
// treasury or the USDC contract. Returned checksummed; null when not one.
export function readAddress(raw: unknown): Address | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(v)) return null;
  if (!isAddress(v, { strict: true })) return null;
  const a = getAddress(v);
  if (/^0x0{40}$/i.test(a)) return null;
  const c = paymentsConfig();
  if (c.treasury && a.toLowerCase() === c.treasury.toLowerCase()) return null;
  const token = c.currencies.USDC.token;
  if (token && a.toLowerCase() === token.toLowerCase()) return null;
  return a;
}

async function ownInstallation(rt: Runtime, owner: User, installationId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(installationId)) throw new PayeeRefused("Not found", 404);
  const [i] = await rt.db.select().from(agentInstallations).where(eq(agentInstallations.id, installationId));
  if (!i || i.ownerUserId !== owner.id) throw new PayeeRefused("Not found", 404);
  return i;
}

export async function payeesOf(rt: Runtime, installationId: string): Promise<Payee[]> {
  return rt.db
    .select()
    .from(payees)
    .where(and(eq(payees.installationId, installationId), ne(payees.status, "removed")))
    .orderBy(asc(payees.createdAt));
}

const unique = (err: unknown) => {
  const code = (e: unknown) => (e && typeof e === "object" && "code" in e ? (e as { code?: unknown }).code : undefined);
  return code(err) === "23505" || code((err as { cause?: unknown } | null)?.cause) === "23505";
};

// Saves a payee, or changes one: the same label with another address is a
// new payee (the old one removed), so its first payment asks again.
export async function savePayee(rt: Runtime, owner: User, installationId: string, raw: { label: unknown; address: unknown }): Promise<Payee> {
  await ownInstallation(rt, owner, installationId);
  const label = readLabel(raw.label);
  if (!label) throw new PayeeRefused("Give it a short name: letters, numbers and simple punctuation, up to 40.");
  const address = readAddress(raw.address);
  if (!address) throw new PayeeRefused("That isn't a Base address to pay: check it (0x and 40 characters, with its capitals as given).");
  const list = await payeesOf(rt, installationId);
  const same = list.find((p) => p.label.toLowerCase() === label.toLowerCase());
  if (same && same.address === address && same.status === "active") return same;
  const sameAddress = list.find((p) => p.address === address && p !== same);
  if (sameAddress?.status === "active") throw new PayeeRefused(`That address is saved already, as "${sameAddress.label}".`, 409);
  if (!same && list.filter((p) => p.status === "active").length >= MAX_PAYEES) throw new PayeeRefused(`An agent can have at most ${MAX_PAYEES} payees.`, 409);
  const now = rt.now();
  try {
    return await rt.db.transaction(async (tx) => {
      if (same) await tx.update(payees).set({ status: "removed", removedAt: now }).where(eq(payees.id, same.id));
      // A suggestion for this address becomes this payee.
      if (sameAddress?.status === "suggested") await tx.update(payees).set({ status: "removed", removedAt: now }).where(eq(payees.id, sameAddress.id));
      const [row] = await tx.insert(payees).values({ installationId, ownerUserId: owner.id, label, address, status: "active", createdAt: now, confirmedAt: now }).returning();
      return row!;
    });
  } catch (err) {
    if (unique(err)) throw new PayeeRefused("A payee with that name or address is saved already.", 409);
    throw err;
  }
}

export async function removePayee(rt: Runtime, owner: User, installationId: string, payeeId: string): Promise<void> {
  await ownInstallation(rt, owner, installationId);
  if (!/^[0-9a-f-]{36}$/i.test(payeeId)) throw new PayeeRefused("Not found", 404);
  const [row] = await rt.db
    .update(payees)
    .set({ status: "removed", removedAt: rt.now() })
    .where(and(eq(payees.id, payeeId), eq(payees.installationId, installationId), ne(payees.status, "removed")))
    .returning({ id: payees.id });
  if (!row) throw new PayeeRefused("Not found", 404);
}

// The renter confirms, on screen, a payee an agent suggested: with a name
// of their own choosing.
export async function confirmSuggestion(rt: Runtime, owner: User, installationId: string, payeeId: string, rawLabel: unknown): Promise<Payee> {
  await ownInstallation(rt, owner, installationId);
  const label = readLabel(rawLabel);
  if (!label) throw new PayeeRefused("Give it a short name: letters, numbers and simple punctuation, up to 40.");
  if (!/^[0-9a-f-]{36}$/i.test(payeeId)) throw new PayeeRefused("Not found", 404);
  try {
    const [row] = await rt.db
      .update(payees)
      .set({ status: "active", label, confirmedAt: rt.now() })
      .where(and(eq(payees.id, payeeId), eq(payees.installationId, installationId), eq(payees.status, "suggested")))
      .returning();
    if (!row) throw new PayeeRefused("Not found", 404);
    return row;
  } catch (err) {
    if (unique(err)) throw new PayeeRefused("A payee with that name is saved already.", 409);
    throw err;
  }
}

// An agent wanting to pay an address that isn't saved: it waits as a
// suggestion, and the renter hears about it. Nothing is paid.
export async function suggestPayee(rt: Runtime, installationId: string, ownerUserId: string, rawAddress: string, agentName: string): Promise<Payee | null> {
  const address = readAddress(rawAddress);
  if (!address) return null;
  const list = await payeesOf(rt, installationId);
  const known = list.find((p) => p.address === address);
  if (known) return known;
  if (list.filter((p) => p.status === "suggested").length >= MAX_PAYEES) return null;
  const now = rt.now();
  const short = `${address.slice(0, 6)}...${address.slice(-4)}`;
  try {
    const [row] = await rt.db
      .insert(payees)
      .values({ installationId, ownerUserId, label: `Suggested ${short}`, address, status: "suggested", suggestedBy: "agent", createdAt: now })
      .returning();
    await rt.db.insert(agentMessages).values({
      installationId,
      from: "agent",
      text: `${agentName} wanted to pay ${short}, which isn't one of your saved payees, so nothing was paid. If you know it, add it on its page under Spending: it can't be added from here.`,
      tgState: "pending",
      createdAt: now,
    });
    return row ?? null;
  } catch (err) {
    if (unique(err)) return null;
    throw err;
  }
}

// The saved payee an agent names, by its label or its address; null when
// it isn't one (a suggestion isn't one yet).
export async function resolvePayee(rt: Runtime, installationId: string, to: string): Promise<Payee | null> {
  const want = to.trim();
  if (!want) return null;
  const byAddress = /^0x[0-9a-fA-F]{40}$/.test(want);
  const [row] = await rt.db
    .select()
    .from(payees)
    .where(and(eq(payees.installationId, installationId), eq(payees.status, "active"), byAddress ? sql`lower(${payees.address}) = ${want.toLowerCase()}` : sql`lower(${payees.label}) = ${want.toLowerCase()}`));
  return row ?? null;
}

// A payee's first payment went out: the next ones needn't ask for that.
export async function markPaid(exec: Exec, payeeId: string, at: Date): Promise<void> {
  await exec.update(payees).set({ firstPaidAt: at }).where(and(eq(payees.id, payeeId), sql`${payees.firstPaidAt} is null`));
}
