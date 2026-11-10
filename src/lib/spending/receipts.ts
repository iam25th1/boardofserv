import "server-only";
import { desc, eq, inArray } from "drizzle-orm";
import { agentApprovals, agentPayments, agents, type AgentPayment } from "../db/schema";
import type { Runtime } from "../agents/runtime/context";
import type { ReceiptDTO } from "../types";
import { explorerTx } from "./treasury";
import { USDC } from "./allowance";

// Every agent payment's receipt: the amount, the payee, the agent and job,
// the transfer on Base with an explorer link, the safety check's verdict
// and the approval (who, the question, the answer).

export async function receiptsOf(rt: Runtime, where: { installationId?: string; ids?: string[] }, limit = 50): Promise<ReceiptDTO[]> {
  const rows = await rt.db
    .select({ p: agentPayments, agent: agents.name })
    .from(agentPayments)
    .innerJoin(agents, eq(agents.id, agentPayments.agentId))
    .where(where.installationId ? eq(agentPayments.installationId, where.installationId) : inArray(agentPayments.id, where.ids?.length ? where.ids : ["00000000-0000-0000-0000-000000000000"]))
    .orderBy(desc(agentPayments.createdAt))
    .limit(limit);
  const approvalIds = rows.map((r) => r.p.approvalId).filter((x): x is string => Boolean(x));
  const approvals = approvalIds.length ? await rt.db.select().from(agentApprovals).where(inArray(agentApprovals.id, approvalIds)) : [];
  return rows.map(({ p, agent }) => receiptDTO(p, agent, approvals.find((a) => a.id === p.approvalId) ?? null));
}

export function receiptDTO(p: AgentPayment, agent: string, approval: { question: string; answer: string | null; answeredAt: Date | null } | null): ReceiptDTO {
  return {
    id: p.id,
    amount: p.amount,
    decimals: USDC,
    payee: { label: p.payeeLabel, address: p.toAddress },
    agent,
    jobId: p.jobId,
    memo: p.memo,
    status: p.status,
    txHash: p.txHash,
    explorer: p.txHash ? explorerTx(p.chainId, p.txHash) : null,
    network: p.chainId === 84532 ? "Base Sepolia" : "Base",
    guard: { verdict: p.guard, reason: p.guardReason },
    approval: { by: p.approvedBy, question: approval?.question ?? null, answer: approval?.answer ?? null, at: approval?.answeredAt?.toISOString() ?? null },
    error: p.error,
    createdAt: p.createdAt.toISOString(),
    settledAt: p.settledAt?.toISOString() ?? null,
  };
}
