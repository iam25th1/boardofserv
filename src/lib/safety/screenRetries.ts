import "server-only";
import { and, eq, isNotNull, lte } from "drizzle-orm";
import { agentListings, agents, agentVersions, requestOffers, requests, screenRetries, users } from "../db/schema";
import type { Runtime } from "../agents/runtime/context";
import { screenListing, screenOffer, screenRequest } from "./moderation";

// A listing, request or offer held because screening got no answer from
// SERV (it answered empty, or not at all, after the call's own tries) is
// screened again by the worker before it lands in the admin queue: up to
// three more times, 2, 10 and 30 minutes apart. An answer either way ends
// it there (it goes public, or it is held for what SERV said); with no
// answer after the last, it waits for a person like anything else held.

export type ScreenSubject = "listing" | "request" | "offer";

export const SCREEN_RETRY_DELAYS_MS = [2 * 60_000, 10 * 60_000, 30 * 60_000];

// Puts it on the list, or schedules its next try. False when it has had
// every try already, so a person looks now.
export async function queueScreenRetry(rt: Runtime, subject: ScreenSubject, subjectId: string, userId: string): Promise<boolean> {
  const now = rt.now();
  const [row] = await rt.db.select().from(screenRetries).where(and(eq(screenRetries.subject, subject), eq(screenRetries.subjectId, subjectId)));
  const delay = SCREEN_RETRY_DELAYS_MS[row?.tries ?? 0];
  const nextAt = delay === undefined ? null : new Date(now.getTime() + delay);
  if (row) await rt.db.update(screenRetries).set({ nextAt, updatedAt: now }).where(and(eq(screenRetries.subject, subject), eq(screenRetries.subjectId, subjectId)));
  else await rt.db.insert(screenRetries).values({ subject, subjectId, userId, tries: 0, nextAt, createdAt: now, updatedAt: now }).onConflictDoNothing();
  return nextAt !== null;
}

// Screened with an answer (or by a person): off the list.
export async function clearScreenRetry(rt: Runtime, subject: ScreenSubject, subjectId: string): Promise<void> {
  await rt.db.delete(screenRetries).where(and(eq(screenRetries.subject, subject), eq(screenRetries.subjectId, subjectId)));
}

// What is still to be screened again ("listing:<agent id>" and so on), for
// the admin queue to leave out.
export async function pendingScreenRetries(rt: Runtime): Promise<Set<string>> {
  const rows = await rt.db.select({ subject: screenRetries.subject, subjectId: screenRetries.subjectId }).from(screenRetries).where(isNotNull(screenRetries.nextAt));
  return new Set(rows.map((r) => `${r.subject}:${r.subjectId}`));
}

// From the worker's cycle: the tries that are due. Each is taken off the
// schedule before it runs (so no other cycle takes it too) and counted;
// the screen puts it back on when SERV still doesn't answer. Returns how
// many were screened again.
export async function retryScreens(rt: Runtime, limit = 5): Promise<number> {
  const now = rt.now();
  const due = await rt.db.select().from(screenRetries).where(lte(screenRetries.nextAt, now)).limit(limit);
  let done = 0;
  for (const r of due) {
    const [taken] = await rt.db
      .update(screenRetries)
      .set({ tries: r.tries + 1, nextAt: null, updatedAt: now })
      .where(and(eq(screenRetries.subject, r.subject), eq(screenRetries.subjectId, r.subjectId), eq(screenRetries.tries, r.tries)))
      .returning();
    if (!taken) continue;
    const [user] = await rt.db.select().from(users).where(eq(users.id, r.userId));
    if (!user || !(await screenAgain(rt, r.subject, r.subjectId, user))) {
      // Gone, or no longer held: nothing to screen.
      await clearScreenRetry(rt, r.subject, r.subjectId);
      continue;
    }
    done += 1;
  }
  return done;
}

// False when it isn't there or isn't held any more.
async function screenAgain(rt: Runtime, subject: ScreenSubject, id: string, user: typeof users.$inferSelect): Promise<boolean> {
  if (subject === "listing") {
    const [l] = await rt.db.select({ screen: agentListings.screen }).from(agentListings).where(eq(agentListings.agentId, id));
    if (l?.screen !== "held") return false;
    await screenListing(rt, user, id, true);
    return true;
  }
  if (subject === "request") {
    const [q] = await rt.db.select().from(requests).where(eq(requests.id, id));
    if (q?.screen !== "held") return false;
    await screenRequest(rt, user, q.id, q.need, q.detail);
    return true;
  }
  const [o] = await rt.db
    .select({ offer: requestOffers, name: agents.name, definition: agentVersions.definition })
    .from(requestOffers)
    .innerJoin(agents, eq(agents.id, requestOffers.agentId))
    .leftJoin(agentListings, eq(agentListings.agentId, agents.id))
    .leftJoin(agentVersions, eq(agentVersions.id, agentListings.versionId))
    .where(eq(requestOffers.id, id));
  if (o?.offer.screen !== "held") return false;
  await screenOffer(rt, user, o.offer.id, o.offer.note, { name: o.name, does: o.definition?.job.does ?? "" });
  return true;
}
