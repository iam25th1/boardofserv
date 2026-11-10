import "server-only";
import { eq } from "drizzle-orm";
import { agentInstallations, agents, type User } from "../db/schema";
import { balancesOf } from "../payments/ledger";
import type { Runtime } from "../agents/runtime/context";
import type { SpendingDTO } from "../types";
import { allowanceMax, allowanceOf, recentEntries, USDC } from "./allowance";
import { payeesOf } from "./payees";
import { receiptsOf } from "./receipts";
import { bandLine, limitWhy, paymentLimits } from "./limits";
import { paymentsPaused } from "./treasury";
import { disputeWindowDays } from "./disputes";

// An installation's spending, for its renter only (null for anyone else).
export async function spendingOf(rt: Runtime, user: User, installationId: string): Promise<SpendingDTO | null> {
  if (!/^[0-9a-f-]{36}$/i.test(installationId)) return null;
  const [row] = await rt.db
    .select({ i: agentInstallations, name: agents.name })
    .from(agentInstallations)
    .innerJoin(agents, eq(agents.id, agentInstallations.agentId))
    .where(eq(agentInstallations.id, installationId));
  if (!row || row.i.ownerUserId !== user.id) return null;
  const a = await allowanceOf(rt.db, installationId);
  const l = await paymentLimits(rt, row.i);
  const balance = await balancesOf(user.id, rt.db);
  return {
    installationId,
    agentName: row.name,
    decimals: USDC,
    allowance: { available: a.available.toString(), held: a.held.toString(), max: allowanceMax().toString() },
    balanceAvailable: balance.USDC.available.toString(),
    entries: (await recentEntries(rt.db, installationId)).map((e) => ({ kind: e.kind, amount: e.amount, at: e.createdAt.toISOString() })),
    receipts: await receiptsOf(rt, { installationId }),
    payees: (await payeesOf(rt, installationId)).map((p) => ({ id: p.id, label: p.label, address: p.address, status: p.status as "active" | "suggested", paidBefore: p.firstPaidAt !== null, createdAt: p.createdAt.toISOString() })),
    limit: { perPayment: l.perPayment.toString(), perDay: l.perDay.toString(), paidToday: l.paidToday.toString(), why: limitWhy(l), band: bandLine(l), trust: l.trust, stopped: l.stopped },
    paused: await paymentsPaused(rt.db),
    disputeDays: disputeWindowDays(),
  };
}
