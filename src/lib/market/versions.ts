import "server-only";
import { and, eq, isNull, ne, or } from "drizzle-orm";
import { agentInstallations, agentListings, agentMessages, agents, agentTriggers, agentVersions, rentals, type AgentVersion, type Rental } from "../db/schema";
import { breakingChange } from "../agents/definition";
import { control, loadInstallation } from "../agents/runtime/installations";
import { setUpTriggers } from "../agents/runtime/triggers";
import type { Runtime } from "../agents/runtime/context";
import { RentRefused } from "./rentals";

// A new version of a rented agent. When its maker publishes one, new
// renters get it, and everyone renting an older one is told (on their
// Rented page, and in Telegram when they've linked it) and chooses: update,
// or stay on the version they have. An update that keeps the same setup
// questions and connections swaps the version in place, settings kept; a
// breaking one (a question added, removed or changed, or a connection it
// didn't need before; see breakingChange) needs setting up again.

export const offerText = (name: string, version: number) =>
  `Version ${version} of ${name} is out. Open Rented on boardofserv to update to it or stay on the version you have.`;

// After its maker publishes a version: the board's listing moves to it, a
// rental not set up yet moves with it, and each rental running an older
// version is offered it. Returns how many were offered.
export async function offerVersion(rt: Runtime, agentId: string, version: AgentVersion): Promise<number> {
  const now = rt.now();
  await rt.db.update(agentListings).set({ versionId: version.id, updatedAt: now }).where(eq(agentListings.agentId, agentId));
  const open = await rt.db
    .select()
    .from(rentals)
    .where(and(eq(rentals.agentId, agentId), ne(rentals.status, "ended"), ne(rentals.versionId, version.id), or(isNull(rentals.offeredVersionId), ne(rentals.offeredVersionId, version.id))));
  let offered = 0;
  for (const r of open) {
    const l = r.installationId ? await loadInstallation(rt, r.installationId) : null;
    if (!l || l.installation.status === "stopped") {
      await rt.db.update(rentals).set({ versionId: version.id, offeredVersionId: null, updatedAt: now }).where(eq(rentals.id, r.id));
      continue;
    }
    await rt.db.update(rentals).set({ offeredVersionId: version.id, updatedAt: now }).where(eq(rentals.id, r.id));
    await rt.db.insert(agentMessages).values({ installationId: l.installation.id, from: "agent", text: offerText(version.definition?.name ?? l.definition.name, version.number), tgState: "pending", createdAt: now });
    offered += 1;
  }
  return offered;
}

// What a renter is offered, in words: the version and whether updating
// needs setting up again.
export async function offerOf(rt: Runtime, r: Rental): Promise<{ version: number; breaking: string | null } | null> {
  if (!r.offeredVersionId) return null;
  const [from, to] = await Promise.all([versionRow(rt, r.versionId), versionRow(rt, r.offeredVersionId)]);
  if (!from?.definition || !to?.definition) return null;
  return { version: to.number, breaking: breakingChange(from.definition, to.definition) };
}

async function versionRow(rt: Runtime, id: string): Promise<AgentVersion | undefined> {
  return (await rt.db.select().from(agentVersions).where(eq(agentVersions.id, id)))[0];
}

// The renter's answer. "stay" keeps the version they run. "update" swaps
// the new one in, settings kept, or, when it's a breaking change, stops
// what runs now and asks for setting up again (setupAgain).
export async function answerOffer(rt: Runtime, r: Rental, choice: "update" | "stay"): Promise<{ setupAgain: boolean }> {
  if (!r.offeredVersionId || r.status === "ended") throw new RentRefused("There's no new version waiting for you.", 409);
  const now = rt.now();
  if (choice === "stay") {
    await rt.db.update(rentals).set({ offeredVersionId: null, updatedAt: now }).where(eq(rentals.id, r.id));
    return { setupAgain: false };
  }
  const [from, to] = await Promise.all([versionRow(rt, r.versionId), versionRow(rt, r.offeredVersionId)]);
  const [agent] = await rt.db.select().from(agents).where(eq(agents.id, r.agentId));
  if (!from?.definition || !to?.definition || to.state !== "published" || !agent) throw new RentRefused("That version isn't there any more.", 409);
  const l = r.installationId ? await loadInstallation(rt, r.installationId) : null;
  const breaking = breakingChange(from.definition, to.definition);
  if (breaking || !l || l.installation.status === "stopped") {
    if (l && l.installation.status !== "stopped") await control(rt, l, "stop");
    await rt.db.update(rentals).set({ versionId: to.id, offeredVersionId: null, installationId: null, updatedAt: now }).where(eq(rentals.id, r.id));
    return { setupAgain: true };
  }
  // In place: the same answers, on the new version's steps and triggers.
  const [row] = await rt.db.update(agentInstallations).set({ versionId: to.id, updatedAt: now }).where(eq(agentInstallations.id, l.installation.id)).returning();
  await rt.db.delete(agentTriggers).where(eq(agentTriggers.installationId, l.installation.id));
  if (row!.live && row!.status === "active") await setUpTriggers(rt, row!, to.definition);
  await rt.db.update(rentals).set({ versionId: to.id, offeredVersionId: null, updatedAt: now }).where(eq(rentals.id, r.id));
  return { setupAgain: false };
}
