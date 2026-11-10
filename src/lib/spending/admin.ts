import "server-only";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { agentPayments, agents, paymentAlerts, paymentSettings, users } from "../db/schema";
import type { Exec } from "../payments/ledger";
import type { AgentPaymentsAdminDTO } from "../types";
import { siteDailyCap } from "./limits";
import { paymentsPaused, treasuryFloor } from "./treasury";

// Agents' payments for the admin page: the site wide switch and why it is
// off, the floor the treasury keeps, today's payments (UTC) with their
// transfers, and how far reconciliation with the chain has got, with its
// open alerts. Renters and makers appear by handle only.

export async function agentPaymentsAdmin(exec: Exec, now: Date = new Date()): Promise<AgentPaymentsAdminDTO> {
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const [sums] = await exec
    .select({
      count: sql<number>`count(*) filter (where ${agentPayments.status} = 'confirmed')::int`,
      total: sql<string>`coalesce(sum(${agentPayments.amount}) filter (where ${agentPayments.status} = 'confirmed'), 0)::text`,
      failed: sql<number>`count(*) filter (where ${agentPayments.status} = 'failed')::int`,
      inFlight: sql<number>`count(*) filter (where ${agentPayments.status} in ('held', 'broadcast'))::int`,
    })
    .from(agentPayments)
    .where(gte(agentPayments.createdAt, today));
  const rows = await exec
    .select({ p: agentPayments, agent: agents.name, renter: users.handle })
    .from(agentPayments)
    .innerJoin(agents, eq(agents.id, agentPayments.agentId))
    .innerJoin(users, eq(users.id, agentPayments.ownerUserId))
    .where(gte(agentPayments.createdAt, today))
    .orderBy(desc(agentPayments.createdAt))
    .limit(30);
  const [mark] = await exec.select().from(paymentSettings).where(eq(paymentSettings.key, "agent_reconcile_block"));
  const open = await exec.select().from(paymentAlerts).where(and(eq(paymentAlerts.status, "open"))).orderBy(desc(paymentAlerts.createdAt)).limit(20);
  return {
    paused: await paymentsPaused(exec),
    floor: treasuryFloor().toString(),
    siteCap: siteDailyCap().toString(),
    today: { count: sums?.count ?? 0, total: sums?.total ?? "0", failed: sums?.failed ?? 0, inFlight: sums?.inFlight ?? 0 },
    reconcile: {
      block: mark?.value && /^\d+$/.test(mark.value) ? mark.value : null,
      at: mark?.updatedAt?.toISOString() ?? null,
      open: open.map((a) => ({ id: a.id, kind: a.kind, message: a.message, at: a.createdAt.toISOString() })),
    },
    recent: rows.map(({ p, agent, renter }) => ({ id: p.id, agent, renter: `@${renter}`, payee: p.payeeLabel, amount: p.amount, status: p.status, txHash: p.txHash, at: p.createdAt.toISOString() })),
  };
}
