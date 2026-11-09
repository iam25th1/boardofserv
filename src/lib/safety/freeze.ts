import "server-only";
import { and, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { agentInstallations, agentMessages, agents, agentVersions, freezes, rentals, users, type Agent, type AgentInstallation, type Freeze, type User } from "../db/schema";
import type { Runtime } from "../agents/runtime/context";

// Stopping things. A maker can stop their agent everywhere at once (the
// kill switch): every installation pauses with a plain message to its
// renter, renewals wait, nothing new is rented, until they start it again;
// the time it was stopped is added back to every rental's paid week. An
// admin can freeze an agent, a version, a maker or a renter, with a
// reason: a frozen thing can't run, be rented, publish or offer. Every
// freeze and lift stays on the admin log. Whatever pauses an installation,
// its current step finishes and nothing after it runs.

export type FreezeKind = Freeze["kind"];

export const STOPPED_EVERYWHERE = "Its maker stopped this agent everywhere for now. Nothing runs and you aren't charged while it is stopped.";
export const frozenText = (reason: string) => `boardofserv paused this: ${reason}`;
export const STARTED_AGAIN = (name: string) => `${name} is running again: its maker started it after stopping it everywhere. The time it was stopped was added to your paid week.`;

// Why an installation can't run now (its agent stopped everywhere, or a
// freeze on its agent, version, maker or renter), or null.
export async function holdOn(rt: Runtime, i: Pick<AgentInstallation, "agentId" | "versionId" | "ownerUserId">): Promise<string | null> {
  const [a] = await rt.db.select({ ownerUserId: agents.ownerUserId, stoppedAt: agents.stoppedAt }).from(agents).where(eq(agents.id, i.agentId));
  if (a?.stoppedAt) return STOPPED_EVERYWHERE;
  const f = await activeFreeze(rt, { agentId: i.agentId, versionId: i.versionId, makerId: a?.ownerUserId, renterId: i.ownerUserId });
  return f ? frozenText(f.reason) : null;
}

// The first active freeze that covers any of these.
export async function activeFreeze(rt: Runtime, o: { agentId?: string | null; versionId?: string | null; makerId?: string | null; renterId?: string | null }): Promise<Freeze | null> {
  const any = [
    o.agentId ? and(eq(freezes.kind, "agent"), eq(freezes.targetId, o.agentId)) : undefined,
    o.versionId ? and(eq(freezes.kind, "version"), eq(freezes.targetId, o.versionId)) : undefined,
    o.makerId ? and(eq(freezes.kind, "maker"), eq(freezes.targetId, o.makerId)) : undefined,
    o.renterId ? and(eq(freezes.kind, "renter"), eq(freezes.targetId, o.renterId)) : undefined,
  ].filter(Boolean);
  if (!any.length) return null;
  const [f] = await rt.db.select().from(freezes).where(and(isNull(freezes.liftedAt), or(...any)));
  return f ?? null;
}

// The reason an agent (with its maker) can't be rented, listed, published
// or offered now, or null.
export async function agentHeld(rt: Runtime, agentId: string, versionId?: string | null): Promise<string | null> {
  const [a] = await rt.db.select().from(agents).where(eq(agents.id, agentId));
  if (!a) return null;
  if (a.stoppedAt) return "Its maker stopped it everywhere for now.";
  const f = await activeFreeze(rt, { agentId, versionId, makerId: a.ownerUserId });
  return f ? `boardofserv froze it: ${f.reason}` : null;
}

// The reason a user can't rent or run anything now, or null.
export async function userHeld(rt: Runtime, userId: string, as: "renter" | "maker"): Promise<string | null> {
  const f = await activeFreeze(rt, as === "renter" ? { renterId: userId } : { makerId: userId });
  return f ? `boardofserv froze this account: ${f.reason}` : null;
}

async function installationsOf(rt: Runtime, kind: FreezeKind, targetId: string): Promise<AgentInstallation[]> {
  if (kind === "agent") return rt.db.select().from(agentInstallations).where(eq(agentInstallations.agentId, targetId));
  if (kind === "version") return rt.db.select().from(agentInstallations).where(eq(agentInstallations.versionId, targetId));
  if (kind === "renter") return rt.db.select().from(agentInstallations).where(eq(agentInstallations.ownerUserId, targetId));
  const made = await rt.db.select({ id: agents.id }).from(agents).where(eq(agents.ownerUserId, targetId));
  return made.length ? rt.db.select().from(agentInstallations).where(inArray(agentInstallations.agentId, made.map((a) => a.id))) : [];
}

// Pauses each active installation with a reason (a renter's own pause is
// left as it is), and tells its renter.
async function pauseAll(rt: Runtime, list: AgentInstallation[], reason: string, tell: string | null): Promise<number> {
  const now = rt.now();
  let paused = 0;
  for (const i of list) {
    const [row] = await rt.db
      .update(agentInstallations)
      .set({ status: "paused", pausedReason: reason, updatedAt: now })
      .where(and(eq(agentInstallations.id, i.id), eq(agentInstallations.status, "active")))
      .returning({ id: agentInstallations.id });
    if (!row) continue;
    paused += 1;
    if (tell) await rt.db.insert(agentMessages).values({ installationId: i.id, from: "agent", text: tell, tgState: "pending", createdAt: now });
  }
  return paused;
}

// Resumes the installations a stop or freeze paused (with exactly its
// reason), where nothing else holds them now.
async function resumeAll(rt: Runtime, list: AgentInstallation[], reason: string, tell: ((i: AgentInstallation) => string) | null): Promise<number> {
  const now = rt.now();
  let resumed = 0;
  for (const i of list) {
    if (i.status !== "paused" || i.pausedReason !== reason) continue;
    if (await holdOn(rt, i)) continue;
    const [row] = await rt.db
      .update(agentInstallations)
      .set({ status: "active", pausedReason: null, updatedAt: now })
      .where(and(eq(agentInstallations.id, i.id), eq(agentInstallations.status, "paused")))
      .returning();
    if (!row) continue;
    resumed += 1;
    // Its triggers start again from now (installations.ts sets them up).
    const { setUpTriggers } = await import("../agents/runtime/triggers");
    const { loadInstallation } = await import("../agents/runtime/installations");
    const l = await loadInstallation(rt, row.id);
    if (l && row.live) await setUpTriggers(rt, row, l.definition);
    if (tell) await rt.db.insert(agentMessages).values({ installationId: i.id, from: "agent", text: tell(i), tgState: "pending", createdAt: now });
  }
  return resumed;
}

// The maker's kill switch.
export async function stopEverywhere(rt: Runtime, agent: Agent, note: string | null): Promise<number> {
  const now = rt.now();
  const [a] = await rt.db.update(agents).set({ stoppedAt: now, stopNote: note, updatedAt: now }).where(and(eq(agents.id, agent.id), isNull(agents.stoppedAt))).returning();
  if (!a) return 0;
  const tell = note ? `${STOPPED_EVERYWHERE} Its maker says: "${note}"` : STOPPED_EVERYWHERE;
  return pauseAll(rt, await installationsOf(rt, "agent", agent.id), STOPPED_EVERYWHERE, tell);
}

export async function startEverywhere(rt: Runtime, agent: Agent): Promise<number> {
  const now = rt.now();
  const [before] = await rt.db.select({ stoppedAt: agents.stoppedAt }).from(agents).where(eq(agents.id, agent.id));
  if (!before?.stoppedAt) return 0;
  await rt.db.update(agents).set({ stoppedAt: null, stopNote: null, updatedAt: now }).where(eq(agents.id, agent.id));
  // The days it was stopped don't count against anyone's paid week.
  const gone = now.getTime() - before.stoppedAt.getTime();
  await rt.db
    .update(rentals)
    .set({ paidUntil: sql`${rentals.paidUntil} + make_interval(secs => ${gone / 1000})`, updatedAt: now })
    .where(and(eq(rentals.agentId, agent.id), ne(rentals.status, "ended")));
  return resumeAll(rt, await installationsOf(rt, "agent", agent.id), STOPPED_EVERYWHERE, () => STARTED_AGAIN(agent.name));
}

// An admin's freeze, with its reason.
export async function freeze(rt: Runtime, admin: User, kind: FreezeKind, targetId: string, reason: string): Promise<Freeze> {
  const now = rt.now();
  const [f] = await rt.db.insert(freezes).values({ kind, targetId, reason, byUserId: admin.id, createdAt: now }).returning();
  await pauseAll(rt, await installationsOf(rt, kind, targetId), frozenText(reason), frozenText(reason));
  return f!;
}

export async function lift(rt: Runtime, admin: User, id: string, why: string): Promise<Freeze | null> {
  const now = rt.now();
  const [f] = await rt.db
    .update(freezes)
    .set({ liftedAt: now, liftedBy: admin.id, liftReason: why })
    .where(and(eq(freezes.id, id), isNull(freezes.liftedAt)))
    .returning();
  if (!f) return null;
  await resumeAll(rt, await installationsOf(rt, f.kind, f.targetId), frozenText(f.reason), null);
  return f;
}

// What a freeze's target is, in words, for the log: an agent's name, a
// version's agent and number, a person's handle.
export async function targetWords(rt: Runtime, f: Pick<Freeze, "kind" | "targetId">): Promise<string> {
  if (f.kind === "maker" || f.kind === "renter") {
    const [u] = await rt.db.select({ handle: users.handle }).from(users).where(eq(users.id, f.targetId));
    return u ? `@${u.handle}` : "an account";
  }
  if (f.kind === "agent") {
    const [a] = await rt.db.select({ name: agents.name }).from(agents).where(eq(agents.id, f.targetId));
    return a?.name ?? "an agent";
  }
  const [v] = await rt.db.select({ number: agentVersions.number, name: agents.name }).from(agentVersions).innerJoin(agents, eq(agents.id, agentVersions.agentId)).where(eq(agentVersions.id, f.targetId));
  return v ? `${v.name}, version ${v.number}` : "a version";
}
