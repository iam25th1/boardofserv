import "server-only";
import { and, asc, desc, eq, lt, type SQL } from "drizzle-orm";
import { agentAudit, agentInstallations, agents, users, type NewAgentAudit } from "../db/schema";
import type { AuditEntryDTO, AuditPageDTO } from "../types";
import type { Runtime } from "./runtime/context";

// The audit log of guarded actions (schema.ts, agent_audit): append-only.
// This file is the only one that touches the table, and it only adds rows
// and reads them. Three views of it:
// - the renter sees everything about their own installation;
// - the maker sees every installation of their agent, with the renter's
//   data hidden: no call in words, no reasons (which can quote it), no
//   amounts, and renters by number, never by name;
// - an admin sees all of it, with renters and agents named.

export const AUDIT_PAGE = 50;

export async function audit(rt: Runtime, entry: Omit<NewAgentAudit, "id" | "createdAt">): Promise<void> {
  await rt.db.insert(agentAudit).values({ ...entry, what: entry.what.slice(0, 600), reason: entry.reason?.slice(0, 600) ?? null, guardReason: entry.guardReason?.slice(0, 600) ?? null, createdAt: rt.now() });
}

// A page of entries, newest first (in the order they were added), before
// a cursor: the last one's place in that order.
function cursorAt(before: string | null | undefined): SQL | undefined {
  return before && /^\d{1,18}$/.test(before) ? lt(agentAudit.seq, Number(before)) : undefined;
}

type Row = typeof agentAudit.$inferSelect & { agent: string; renter: string | null };

async function page(rt: Runtime, where: SQL | undefined, before: string | null | undefined): Promise<Row[]> {
  return rt.db
    .select({ e: agentAudit, agent: agents.name, renter: users.handle })
    .from(agentAudit)
    .leftJoin(agents, eq(agents.id, agentAudit.agentId))
    .leftJoin(users, eq(users.id, agentAudit.ownerUserId))
    .where(and(where, cursorAt(before)))
    .orderBy(desc(agentAudit.seq))
    .limit(AUDIT_PAGE + 1)
    .then((rows) => rows.map((r) => ({ ...r.e, agent: r.agent ?? "An agent", renter: r.renter })));
}

function full(r: Row, renter: string | null): AuditEntryDTO {
  return {
    id: r.id,
    at: r.createdAt.toISOString(),
    agent: r.agent,
    renter,
    step: r.step,
    tool: r.tool,
    risk: r.risk as AuditEntryDTO["risk"],
    what: r.what,
    outcome: r.outcome,
    guard: r.guard,
    guardReason: r.guardReason,
    reason: r.reason,
    approvedBy: r.approvedBy,
    cost: r.cost,
    spent: r.spent,
    decimals: 6,
  };
}

function paged(rows: Row[], dto: (r: Row) => AuditEntryDTO): AuditPageDTO {
  const shown = rows.slice(0, AUDIT_PAGE);
  const last = shown[shown.length - 1];
  return { entries: shown.map(dto), next: rows.length > AUDIT_PAGE && last ? String(last.seq) : null };
}

// The renter's own installation, all of it.
export async function auditForRenter(rt: Runtime, installationId: string, before?: string | null): Promise<AuditPageDTO> {
  return paged(await page(rt, eq(agentAudit.installationId, installationId), before), (r) => full(r, null));
}

// The maker's agent across its installations, renters' data hidden. Their
// own installation is "You"; every other is "Renter N", numbered by when
// it was set up.
export async function auditForMaker(rt: Runtime, agent: { id: string; ownerUserId: string }, before?: string | null): Promise<AuditPageDTO> {
  const installs = await rt.db
    .select({ id: agentInstallations.id, owner: agentInstallations.ownerUserId })
    .from(agentInstallations)
    .where(eq(agentInstallations.agentId, agent.id))
    .orderBy(asc(agentInstallations.createdAt), asc(agentInstallations.id));
  const label = new Map<string, string>();
  let n = 0;
  for (const i of installs) label.set(i.id, i.owner === agent.ownerUserId ? "You" : `Renter ${++n}`);
  return paged(await page(rt, eq(agentAudit.agentId, agent.id), before), (r) => ({
    ...full(r, label.get(r.installationId) ?? "A renter"),
    what: null,
    guardReason: null,
    reason: null,
    spent: null,
  }));
}

// An admin's view: all of it, renters by handle; one installation or one
// agent when asked.
export async function auditForAdmin(rt: Runtime, o: { installationId?: string | null; agentId?: string | null; before?: string | null } = {}): Promise<AuditPageDTO> {
  const isId = (id: string | null | undefined): id is string => Boolean(id && /^[0-9a-f-]{36}$/i.test(id));
  const where = and(isId(o.installationId) ? eq(agentAudit.installationId, o.installationId) : undefined, isId(o.agentId) ? eq(agentAudit.agentId, o.agentId) : undefined);
  return paged(await page(rt, where, o.before), (r) => full(r, r.renter ? `@${r.renter}` : "an account"));
}

// One job's guarded actions in the order they happened, with nothing the
// renter's data could show: which step, tool and risk, what happened, what
// SERV's check said and who let it run. For Reppo's job summary.
export async function jobActions(rt: Runtime, jobId: string): Promise<Pick<AuditEntryDTO, "step" | "tool" | "risk" | "outcome" | "guard" | "approvedBy">[]> {
  const rows = await rt.db
    .select({ step: agentAudit.step, tool: agentAudit.tool, risk: agentAudit.risk, outcome: agentAudit.outcome, guard: agentAudit.guard, approvedBy: agentAudit.approvedBy })
    .from(agentAudit)
    .where(eq(agentAudit.jobId, jobId))
    .orderBy(asc(agentAudit.seq))
    .limit(60);
  return rows.map((r) => ({ ...r, risk: r.risk as AuditEntryDTO["risk"] }));
}

// What SERV's check said when a call last waited for its renter's yes in a
// job's step (for a payment's receipt, once the yes let it run).
export async function lastAsk(rt: Runtime, jobId: string, step: string): Promise<{ guard: string | null; guardReason: string | null } | null> {
  const [row] = await rt.db
    .select({ guard: agentAudit.guard, guardReason: agentAudit.guardReason })
    .from(agentAudit)
    .where(and(eq(agentAudit.jobId, jobId), eq(agentAudit.step, step), eq(agentAudit.outcome, "asked")))
    .orderBy(desc(agentAudit.seq))
    .limit(1);
  return row ?? null;
}
