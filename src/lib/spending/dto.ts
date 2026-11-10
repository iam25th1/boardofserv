import "server-only";
import { eq } from "drizzle-orm";
import { agentInstallations, agents, type User } from "../db/schema";
import { balancesOf } from "../payments/ledger";
import type { Runtime } from "../agents/runtime/context";
import type { SpendingDTO } from "../types";
import { allowanceMax, allowanceOf, recentEntries, USDC } from "./allowance";
import { payeesOf } from "./payees";
import { addressesFacts, highRisk, warningOf } from "./addresses";
import { receiptsOf } from "./receipts";
import { bandLine, limitWhy, paymentLimits } from "./limits";
import { paymentsPaused } from "./treasury";
import { paymentsConfig } from "../payments/config";
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
  // Each payee judged by its address, never its name.
  const list = await payeesOf(rt, installationId);
  const facts = await addressesFacts(rt, list.map((p) => p.address), row.i);
  const balance = await balancesOf(user.id, rt.db);
  return {
    installationId,
    agentName: row.name,
    decimals: USDC,
    allowance: { available: a.available.toString(), held: a.held.toString(), max: allowanceMax().toString() },
    balanceAvailable: balance.USDC.available.toString(),
    entries: (await recentEntries(rt.db, installationId)).map((e) => ({ kind: e.kind, amount: e.amount, at: e.createdAt.toISOString() })),
    receipts: await receiptsOf(rt, { installationId }),
    payees: list.map((p) => {
      const f = facts.get(p.address.toLowerCase());
      return { id: p.id, label: p.label, address: p.address, status: p.status as "active" | "suggested", paidBefore: (f?.paidBefore ?? 0) > 0, createdAt: p.createdAt.toISOString(), warning: f && highRisk(f) ? warningOf(f) : null };
    }),
    limit: { perPayment: l.perPayment.toString(), perDay: l.perDay.toString(), paidToday: l.paidToday.toString(), why: limitWhy(l), band: bandLine(l), trust: l.trust, stopped: l.stopped },
    paused: await paymentsPaused(rt.db),
    money: { network: (rt.payments?.config ?? paymentsConfig()).networkLabel, test: (rt.payments?.config ?? paymentsConfig()).network !== "base" },
    disputeDays: disputeWindowDays(),
  };
}
