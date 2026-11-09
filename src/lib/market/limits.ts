import "server-only";
import { and, count, eq, gte } from "drizzle-orm";
import { rentals, requestOffers, requests, requestVotes, type User } from "../db/schema";
import { notLetIn } from "../access";
import { servKeyOf } from "../servKey";
import { chatDailyLimit, dayStart, nextReset } from "../spend";
import type { Runtime } from "../agents/runtime/context";

// The site's limits on the market, as on the chat: accounts not let in yet
// are turned away (invite-only); each person's market actions a day
// (renting, asking, offering, "me too") are capped at the chat's daily
// limit (CHAT_DAILY_LIMIT), counted on their own; and once the site has
// spent its day's model budget (DAILY_SPEND_LIMIT_USD), renting, setting
// up, resuming, asking and offering pause for everyone but those using
// their own SERV key, the same as chat and publishing.

export const MARKET_CAP_TEXT = (limit: number, resetsAt: Date) =>
  `That's ${limit} things on the market today, the daily limit. It resets at midnight UTC (${resetsAt.toISOString().slice(11, 16)} UTC).`;

// Market actions today: rentals started, requests asked, offers made or
// changed, and "me too".
export async function marketActionsToday(rt: Runtime, userId: string): Promise<number> {
  const since = dayStart(rt.now());
  const [a, b, c, d] = await Promise.all([
    rt.db.select({ n: count() }).from(rentals).where(and(eq(rentals.renterUserId, userId), gte(rentals.createdAt, since))),
    rt.db.select({ n: count() }).from(requests).where(and(eq(requests.userId, userId), gte(requests.createdAt, since))),
    rt.db.select({ n: count() }).from(requestOffers).where(and(eq(requestOffers.makerUserId, userId), gte(requestOffers.updatedAt, since))),
    rt.db.select({ n: count() }).from(requestVotes).where(and(eq(requestVotes.userId, userId), gte(requestVotes.createdAt, since))),
  ]);
  return [a, b, c, d].reduce((t, r) => t + (r[0]?.n ?? 0), 0);
}

// The response that turns a market action away, or null when it may go.
// counted: it is one of the day's capped actions. spends: it starts model
// spend, or (asking, offering) pauses with the rest of the site.
export async function marketRefusal(rt: Runtime, user: User, o: { counted?: boolean; spends?: boolean } = {}): Promise<Response | null> {
  const shut = notLetIn(user);
  if (shut) return shut;
  if (o.spends) {
    const site = await rt.siteRefusal(user, Boolean(servKeyOf(user)));
    if (site) return Response.json({ error: site, limit: "site" }, { status: 429 });
  }
  if (o.counted) {
    const limit = chatDailyLimit();
    if ((await marketActionsToday(rt, user.id)) >= limit) return Response.json({ error: MARKET_CAP_TEXT(limit, nextReset(rt.now())), limit: "market" }, { status: 429 });
  }
  return null;
}
