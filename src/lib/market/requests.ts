import "server-only";
import { and, count, desc, eq, inArray, ne, or, sql } from "drizzle-orm";
import { agentListings, agents, agentVersions, requestOffers, requests, requestVotes, users, type Request } from "../db/schema";
import type { OfferDTO, RequestDTO, RequestPageDTO } from "../types";
import type { Runtime } from "../agents/runtime/context";
import { USDC_DECIMALS } from "./charges";
import { connectsOf, type Connects } from "./listings";
import { rent, RentRefused } from "./rentals";
import { agentHeld, userHeld } from "../safety/freeze";
import type { Rental } from "../db/schema";

// The request board. Anyone signed in and let in asks for an agent: what
// it should do, what it should connect to, what they'd pay a week. Others
// say "me too" (once each, never on their own). Makers offer one of their
// published agents with a note and a price; the one who asked accepts an
// offer, which rents that agent at that price (the first week charged as
// any rental's), and the request is answered. They can close it instead.

export const NEED_MAX = 140;
export const DETAIL_MAX = 1200;
export const NOTE_MAX = 600;
export const OPEN_REQUESTS_MAX = 5;
const BOARD_LIMIT = 60;

export class RequestRefused extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "RequestRefused";
  }
}

const isId = (id: string) => /^[0-9a-f-]{36}$/i.test(id);

export async function postRequest(rt: Runtime, userId: string, o: { need: string; detail: string; connects: Connects[]; budget: bigint | null }): Promise<Request> {
  const need = o.need.trim();
  if (!need) throw new RequestRefused("Say what you need it to do.");
  if (need.length > NEED_MAX) throw new RequestRefused(`Keep what you need to ${NEED_MAX} characters; put the rest in the details.`);
  if (o.detail.length > DETAIL_MAX) throw new RequestRefused(`Keep the details to ${DETAIL_MAX} characters.`);
  const [open] = await rt.db.select({ n: count() }).from(requests).where(and(eq(requests.userId, userId), eq(requests.status, "open")));
  if ((open?.n ?? 0) >= OPEN_REQUESTS_MAX) throw new RequestRefused(`You have ${OPEN_REQUESTS_MAX} requests open. Close one first.`, 429);
  const now = rt.now();
  const [row] = await rt.db
    .insert(requests)
    .values({ userId, need, detail: o.detail.trim(), connects: [...new Set(o.connects)], budget: o.budget === null ? null : o.budget.toString(), createdAt: now, updatedAt: now })
    .returning();
  return row!;
}

async function requestDTOs(rt: Runtime, rows: (Request & { by: string })[], viewerId: string | null): Promise<RequestDTO[]> {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const votes = await rt.db.select({ id: requestVotes.requestId, n: count() }).from(requestVotes).where(inArray(requestVotes.requestId, ids)).groupBy(requestVotes.requestId);
  const offers = await rt.db
    .select({ id: requestOffers.requestId, n: count() })
    .from(requestOffers)
    .where(and(inArray(requestOffers.requestId, ids), ne(requestOffers.status, "withdrawn"), eq(requestOffers.screen, "ok")))
    .groupBy(requestOffers.requestId);
  const mine = viewerId ? await rt.db.select({ id: requestVotes.requestId }).from(requestVotes).where(and(inArray(requestVotes.requestId, ids), eq(requestVotes.userId, viewerId))) : [];
  return rows.map((r) => ({
    id: r.id,
    need: r.need,
    detail: r.detail,
    connects: r.connects,
    budget: r.budget,
    decimals: USDC_DECIMALS,
    by: r.by,
    status: r.status,
    meToo: votes.find((v) => v.id === r.id)?.n ?? 0,
    offers: offers.find((v) => v.id === r.id)?.n ?? 0,
    createdAt: r.createdAt.toISOString(),
    mine: viewerId === r.userId,
    votedByMe: mine.some((m) => m.id === r.id),
    held: viewerId === r.userId && r.screen !== "ok" ? (r.screenReason ?? "It is waiting for review.") : null,
  }));
}

const withHandle = (rt: Runtime) => rt.db.select({ request: requests, by: users.handle }).from(requests).innerJoin(users, eq(users.id, requests.userId));

// The open requests: most wanted first (most "me too", then newest), or
// newest first.
export async function requestBoard(rt: Runtime, o: { sort?: "wanted" | "newest"; viewerId?: string | null } = {}): Promise<RequestDTO[]> {
  const rows = await withHandle(rt).where(and(eq(requests.status, "open"), eq(requests.screen, "ok"))).orderBy(desc(requests.createdAt)).limit(BOARD_LIMIT * 2);
  const list = await requestDTOs(
    rt,
    rows.map((r) => ({ ...r.request, by: r.by })),
    o.viewerId ?? null,
  );
  if (o.sort !== "newest") list.sort((a, b) => b.meToo - a.meToo || b.createdAt.localeCompare(a.createdAt));
  return list.slice(0, BOARD_LIMIT);
}

// The viewer's own requests, open or not: newest first.
export async function requestsOf(rt: Runtime, userId: string): Promise<RequestDTO[]> {
  const rows = await withHandle(rt).where(eq(requests.userId, userId)).orderBy(desc(requests.createdAt)).limit(50);
  return requestDTOs(
    rt,
    rows.map((r) => ({ ...r.request, by: r.by })),
    userId,
  );
}

async function requestRow(rt: Runtime, id: string): Promise<Request | null> {
  if (!isId(id)) return null;
  const [r] = await rt.db.select().from(requests).where(eq(requests.id, id));
  return r ?? null;
}

// One request with its offers, for anyone. Withdrawn offers are left out.
export async function requestPage(rt: Runtime, id: string, viewerId: string | null = null): Promise<RequestPageDTO | null> {
  if (!isId(id)) return null;
  const [row] = await withHandle(rt).where(eq(requests.id, id));
  // Held or hidden by the screen: there for its poster only.
  if (!row || (row.request.screen !== "ok" && row.request.userId !== viewerId)) return null;
  const [request] = await requestDTOs(rt, [{ ...row.request, by: row.by }], viewerId);
  const offers = await rt.db
    .select({ offer: requestOffers, maker: users.handle, name: agents.name, listed: agentListings.listed })
    .from(requestOffers)
    .innerJoin(users, eq(users.id, requestOffers.makerUserId))
    .innerJoin(agents, eq(agents.id, requestOffers.agentId))
    .leftJoin(agentListings, eq(agentListings.agentId, requestOffers.agentId))
    .where(and(eq(requestOffers.requestId, id), ne(requestOffers.status, "withdrawn"), or(eq(requestOffers.screen, "ok"), viewerId ? eq(requestOffers.makerUserId, viewerId) : undefined)))
    .orderBy(desc(requestOffers.createdAt));
  const newest = await newestPublished(rt, offers.map((o) => o.offer.agentId));
  return {
    request: request!,
    offers: offers.flatMap((o): OfferDTO[] => {
      const v = newest.get(o.offer.agentId);
      if (!v?.definition) return [];
      return [
        {
          id: o.offer.id,
          agent: { id: o.offer.agentId, name: v.definition.name, does: v.definition.job.does, connects: connectsOf(v.definition), version: v.number, listed: Boolean(o.listed) },
          maker: o.maker,
          note: o.offer.note,
          weeklyPrice: o.offer.weeklyPrice,
          jobFee: o.offer.jobFee,
          decimals: USDC_DECIMALS,
          status: o.offer.status,
          createdAt: o.offer.createdAt.toISOString(),
          mine: viewerId === o.offer.makerUserId,
          held: o.offer.screen !== "ok" ? (o.offer.screenReason ?? "It is waiting for review.") : null,
        },
      ];
    }),
  };
}

async function newestPublished(rt: Runtime, agentIds: string[]) {
  const out = new Map<string, { number: number; definition: (typeof agentVersions.$inferSelect)["definition"] }>();
  if (!agentIds.length) return out;
  const rows = await rt.db
    .select({ agentId: agentVersions.agentId, number: agentVersions.number, definition: agentVersions.definition })
    .from(agentVersions)
    .where(and(inArray(agentVersions.agentId, agentIds), eq(agentVersions.state, "published")))
    .orderBy(desc(agentVersions.number));
  for (const r of rows) if (!out.has(r.agentId)) out.set(r.agentId, r);
  return out;
}

// "Me too", or taking it back.
export async function meToo(rt: Runtime, userId: string, id: string, on: boolean): Promise<void> {
  const r = await requestRow(rt, id);
  if (!r) throw new RequestRefused("Not found", 404);
  if (r.userId === userId) throw new RequestRefused("It's your own request.", 409);
  if (r.status !== "open") throw new RequestRefused("This request isn't open any more.", 409);
  if (on) await rt.db.insert(requestVotes).values({ requestId: id, userId, createdAt: rt.now() }).onConflictDoNothing();
  else await rt.db.delete(requestVotes).where(and(eq(requestVotes.requestId, id), eq(requestVotes.userId, userId)));
}

export async function closeRequest(rt: Runtime, userId: string, id: string): Promise<void> {
  const r = await requestRow(rt, id);
  if (!r || r.userId !== userId) throw new RequestRefused("Not found", 404);
  if (r.status !== "open") throw new RequestRefused("It's closed already.", 409);
  await rt.db.update(requests).set({ status: "closed", closedAt: rt.now(), updatedAt: rt.now() }).where(and(eq(requests.id, id), eq(requests.status, "open")));
}

// A maker offers one of their own published agents, once per request.
export async function makeOffer(rt: Runtime, makerUserId: string, id: string, o: { agentId: string; note: string; weeklyPrice: bigint; jobFee: bigint }) {
  const r = await requestRow(rt, id);
  if (!r) throw new RequestRefused("Not found", 404);
  if (r.status !== "open") throw new RequestRefused("This request isn't open any more.", 409);
  if (r.userId === makerUserId) throw new RequestRefused("It's your own request: build it, and run it from its builder.", 409);
  if (o.note.length > NOTE_MAX) throw new RequestRefused(`Keep the note to ${NOTE_MAX} characters.`);
  const [agent] = isId(o.agentId) ? await rt.db.select().from(agents).where(eq(agents.id, o.agentId)) : [];
  if (!agent || agent.ownerUserId !== makerUserId) throw new RequestRefused("Offer one of your own agents.", 404);
  if (!(await newestPublished(rt, [agent.id])).size) throw new RequestRefused("Publish a version of it first: renters get a published version, which never changes.", 409);
  const held = (await agentHeld(rt, agent.id)) ?? (await userHeld(rt, makerUserId, "maker"));
  if (held) throw new RequestRefused(`It can't be offered now. ${held}`, 409);
  // One an admin took down stays down.
  const [before] = await rt.db.select({ screen: requestOffers.screen }).from(requestOffers).where(and(eq(requestOffers.requestId, id), eq(requestOffers.agentId, agent.id)));
  if (before?.screen === "hidden") throw new RequestRefused("An admin took your earlier offer of it down, so it can't be offered here again.", 409);
  const now = rt.now();
  const [row] = await rt.db
    .insert(requestOffers)
    .values({ requestId: id, makerUserId, agentId: agent.id, note: o.note.trim(), weeklyPrice: o.weeklyPrice.toString(), jobFee: o.jobFee.toString(), createdAt: now, updatedAt: now })
    .onConflictDoUpdate({
      target: [requestOffers.requestId, requestOffers.agentId],
      set: { note: o.note.trim(), weeklyPrice: o.weeklyPrice.toString(), jobFee: o.jobFee.toString(), status: "open", updatedAt: now },
      setWhere: sql`${requestOffers.status} <> 'accepted'`,
    })
    .returning();
  if (!row) throw new RequestRefused("That offer was accepted already.", 409);
  return row;
}

export async function withdrawOffer(rt: Runtime, makerUserId: string, offerId: string): Promise<void> {
  const [o] = isId(offerId) ? await rt.db.select().from(requestOffers).where(eq(requestOffers.id, offerId)) : [];
  if (!o || o.makerUserId !== makerUserId) throw new RequestRefused("Not found", 404);
  if (o.status !== "open") throw new RequestRefused(o.status === "accepted" ? "It was accepted: it's rented now." : "It's withdrawn already.", 409);
  await rt.db.update(requestOffers).set({ status: "withdrawn", updatedAt: rt.now() }).where(and(eq(requestOffers.id, offerId), eq(requestOffers.status, "open")));
}

// The one who asked accepts an offer: they rent its agent at its price,
// and the request is answered.
export async function acceptOffer(rt: Runtime, userId: string, offerId: string): Promise<Rental> {
  const [o] = isId(offerId) ? await rt.db.select().from(requestOffers).where(eq(requestOffers.id, offerId)) : [];
  const r = o ? await requestRow(rt, o.requestId) : null;
  if (!o || !r || r.userId !== userId) throw new RequestRefused("Not found", 404);
  if (r.status !== "open") throw new RequestRefused("This request isn't open any more.", 409);
  if (o.status !== "open") throw new RequestRefused("That offer was withdrawn.", 409);
  if (o.screen !== "ok") throw new RequestRefused("That offer is waiting for review.", 409);
  let rental: Rental;
  try {
    rental = await rent(rt, { renterUserId: userId, agentId: o.agentId, offer: { weeklyPrice: o.weeklyPrice, jobFee: o.jobFee } });
  } catch (err) {
    if (err instanceof RentRefused) throw new RequestRefused(err.message, err.status);
    throw err;
  }
  const now = rt.now();
  await rt.db.update(requestOffers).set({ status: "accepted", rentalId: rental.id, updatedAt: now }).where(eq(requestOffers.id, o.id));
  await rt.db.update(requests).set({ status: "accepted", closedAt: now, updatedAt: now }).where(eq(requests.id, r.id));
  return rental;
}
