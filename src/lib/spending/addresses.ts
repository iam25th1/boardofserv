import "server-only";
import { and, count, countDistinct, eq, inArray, max, ne, sql } from "drizzle-orm";
import { agentPayments, agents, linkedWallets, payees, type AgentInstallation } from "../db/schema";
import { paymentsConfig } from "../payments/config";
import type { Runtime } from "../agents/runtime/context";
import { FLAG_WORDS, type AddressFlag } from "./addressWords";

export { FLAG_WORDS, type AddressFlag };

// What is known about an address an agent would pay, judged by the address
// alone, never the name its renter saved it under: whether it is the
// agent's maker's own wallet, boardofserv's treasury, another maker's
// wallet, or an address renters of many other agents pay too; and how
// often this installation has paid it before. Any of the first four makes
// a payment high risk: it always asks, with a plain warning, whatever the
// renter's limits or the trust band allow.

type Env = Record<string, string | undefined>;

// How many other renters paying the same address makes it "crowded"
// (PAYEE_CROWD_RENTERS, 3 unless set).
export function crowdRenters(env: Env = process.env): number {
  const n = Number(env.PAYEE_CROWD_RENTERS);
  return env.PAYEE_CROWD_RENTERS?.trim() && Number.isInteger(n) && n >= 2 && n <= 1000 ? n : 3;
}

export interface AddressFacts {
  address: string;
  flags: AddressFlag[];
  // Other renters who saved this address as a payee.
  otherRenters: number;
  // This installation's payments to it that went through, and the last one.
  paidBefore: number;
  lastPaidAt: string | null;
}

export const highRisk = (f: Pick<AddressFacts, "flags">) => f.flags.length > 0;
export const warningOf = (f: Pick<AddressFacts, "flags">) => f.flags.map((x) => FLAG_WORDS[x]).join(" ");

export async function addressFacts(rt: Runtime, address: string, i: Pick<AgentInstallation, "id" | "agentId" | "ownerUserId">, env: Env = process.env): Promise<AddressFacts> {
  return (await addressesFacts(rt, [address], i, env)).get(address.toLowerCase())!;
}

// For several addresses of one installation at once (its payee list).
export async function addressesFacts(rt: Runtime, addresses: string[], i: Pick<AgentInstallation, "id" | "agentId" | "ownerUserId">, env: Env = process.env): Promise<Map<string, AddressFacts>> {
  const lower = [...new Set(addresses.map((a) => a.toLowerCase()))];
  const out = new Map<string, AddressFacts>();
  if (!lower.length) return out;
  const [agent] = await rt.db.select({ maker: agents.ownerUserId }).from(agents).where(eq(agents.id, i.agentId));
  const maker = agent?.maker ?? null;
  // Wallets of people who make agents (anyone with an agent of their own).
  const wallets = await rt.db
    .select({ address: linkedWallets.address, userId: linkedWallets.userId, makes: sql<number>`(select count(*) from ${agents} where ${agents.ownerUserId} = ${linkedWallets.userId})::int` })
    .from(linkedWallets)
    .where(inArray(linkedWallets.address, lower));
  const crowd = await rt.db
    .select({ address: sql<string>`lower(${payees.address})`, n: countDistinct(payees.ownerUserId) })
    .from(payees)
    .where(and(inArray(sql`lower(${payees.address})`, lower), ne(payees.status, "removed"), ne(payees.ownerUserId, i.ownerUserId)))
    .groupBy(sql`lower(${payees.address})`);
  const paid = await rt.db
    .select({ address: sql<string>`lower(${agentPayments.toAddress})`, n: count(), last: max(agentPayments.settledAt) })
    .from(agentPayments)
    .where(and(eq(agentPayments.installationId, i.id), eq(agentPayments.status, "confirmed"), inArray(sql`lower(${agentPayments.toAddress})`, lower)))
    .groupBy(sql`lower(${agentPayments.toAddress})`);
  // A payee row of this installation for the address that was paid (under
  // any name, removed or not) counts as paid before too.
  const marked = await rt.db
    .select({ address: sql<string>`lower(${payees.address})`, last: max(payees.firstPaidAt) })
    .from(payees)
    .where(and(eq(payees.installationId, i.id), inArray(sql`lower(${payees.address})`, lower), sql`${payees.firstPaidAt} is not null`))
    .groupBy(sql`lower(${payees.address})`);
  const treasury = (rt.payments?.config ?? paymentsConfig()).treasury?.toLowerCase() ?? null;
  const many = crowdRenters(env);
  for (const a of lower) {
    const flags: AddressFlag[] = [];
    const owners = wallets.filter((w) => w.address === a);
    // The renter's own wallet is theirs to pay, even when they make agents too.
    if (maker && maker !== i.ownerUserId && owners.some((w) => w.userId === maker)) flags.push("maker_wallet");
    if (treasury && a === treasury) flags.push("treasury");
    if (owners.some((w) => w.userId !== maker && w.userId !== i.ownerUserId && w.makes > 0)) flags.push("other_maker");
    const others = crowd.find((c) => c.address === a)?.n ?? 0;
    if (others >= many) flags.push("crowded");
    const p = paid.find((x) => x.address === a);
    const m = marked.find((x) => x.address === a);
    const last = p?.last ?? m?.last ?? null;
    out.set(a, { address: a, flags, otherRenters: others, paidBefore: Math.max(p?.n ?? 0, m ? 1 : 0), lastPaidAt: last ? new Date(last).toISOString() : null });
  }
  return out;
}
