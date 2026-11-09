import "server-only";
import { and, count, eq, gte, ne, sql, type AnyColumn } from "drizzle-orm";
import { db } from "./db";
import { helperUses, replyUsage } from "./db/schema";
import { chatLimitMessage, LIMIT_MESSAGE } from "./limits";
import { modelPrices, type Price, type Provider } from "./model";
import type { QuotaDTO } from "./types";

// Spend protection. Each person may send CHAT_DAILY_LIMIT messages a day
// (default 30), and the whole site may spend DAILY_SPEND_LIMIT_USD a day
// (default 5) on the operator's model keys. Days run midnight to midnight
// UTC. Spend is an estimate: the tokens each provider reported, recorded in
// reply_usage (chat turns, their plan calls and publishing's compile calls)
// and helper_uses, priced per model (modelPrices). Once today's estimate
// reaches the limit, chat, publishing and helper uses pause for everyone
// except people using their own SERV key, whose calls are never counted.

type Env = Record<string, string | undefined>;

export const DEFAULT_CHAT_DAILY_LIMIT = 30;
export const DEFAULT_DAILY_SPEND_LIMIT_USD = 5;

export function chatDailyLimit(env: Env = process.env): number {
  const n = Number(env.CHAT_DAILY_LIMIT);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_CHAT_DAILY_LIMIT;
}

export function dailySpendLimitUsd(env: Env = process.env): number {
  const n = Number(env.DAILY_SPEND_LIMIT_USD);
  return env.DAILY_SPEND_LIMIT_USD?.trim() && Number.isFinite(n) && n > 0 ? n : DEFAULT_DAILY_SPEND_LIMIT_USD;
}

// Midnight UTC at the start of `now`'s day, and the next one.
export function dayStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

export function nextReset(now: Date): Date {
  return new Date(dayStart(now).getTime() + 86_400_000);
}

export interface Tokens {
  // The provider that answered, "demo", or null when it is not known.
  provider: string | null;
  input: number;
  output: number;
}

// Dollars for these token counts. Rows with no provider were SERV (the only
// model before the provider was kept); the demo costs nothing.
export function costOf(rows: Tokens[], prices: Record<Provider["id"], Price> = modelPrices()): number {
  let usd = 0;
  for (const r of rows) {
    if (r.provider === "demo") continue;
    const price = prices[(r.provider ?? "serv") as Provider["id"]] ?? prices.serv;
    usd += (r.input * price.input + r.output * price.output) / 1_000_000;
  }
  return usd;
}

const total = (column: AnyColumn) => sql<string>`coalesce(sum(${column}), 0)::text`;

// Today's estimated spend on the operator's keys, in US dollars.
export async function spendToday(now: Date = new Date()): Promise<number> {
  const start = dayStart(now);
  const counted = and(gte(replyUsage.createdAt, start), eq(replyUsage.ownKey, false));
  const replies = await db
    .select({ provider: replyUsage.provider, input: total(replyUsage.promptTokens), output: total(replyUsage.completionTokens) })
    .from(replyUsage)
    .where(counted)
    .groupBy(replyUsage.provider);
  const plans = await db
    .select({ provider: replyUsage.extractProvider, input: total(replyUsage.extractPromptTokens), output: total(replyUsage.extractCompletionTokens) })
    .from(replyUsage)
    .where(counted)
    .groupBy(replyUsage.extractProvider);
  const uses = await db
    .select({ provider: helperUses.provider, input: total(helperUses.promptTokens), output: total(helperUses.completionTokens) })
    .from(helperUses)
    .where(and(gte(helperUses.createdAt, start), eq(helperUses.ownKey, false)))
    .groupBy(helperUses.provider);
  return costOf([...replies, ...plans, ...uses].map((r) => ({ provider: r.provider, input: Number(r.input), output: Number(r.output) })));
}

export async function siteLimitReached(now: Date = new Date()): Promise<boolean> {
  return (await spendToday(now)) >= dailySpendLimitUsd();
}

// A person's messages today: every chat turn on the operator's keys that
// didn't fail (a failed one gave nothing back). Turns still running count.
export async function chatQuota(userId: string, now: Date = new Date()): Promise<QuotaDTO> {
  const [row] = await db
    .select({ used: count() })
    .from(replyUsage)
    .where(
      and(
        eq(replyUsage.userId, userId),
        eq(replyUsage.kind, "reply"),
        eq(replyUsage.ownKey, false),
        gte(replyUsage.createdAt, dayStart(now)),
        ne(replyUsage.outcome, "failed"),
      ),
    );
  const limit = chatDailyLimit();
  return { limit, remaining: Math.max(0, limit - (row?.used ?? 0)), resetsAt: nextReset(now).toISOString() };
}

// Why a model call can't run now, or null when it can. Calls on the
// person's own key always can. `chat` adds the person's daily message limit.
export async function refusal(
  userId: string,
  opts: { ownKey: boolean; chat?: boolean; now?: Date },
): Promise<{ error: string; limit: "site" | "chat"; quota?: QuotaDTO } | null> {
  if (opts.ownKey) return null;
  const now = opts.now ?? new Date();
  if (await siteLimitReached(now)) return { error: LIMIT_MESSAGE, limit: "site" };
  if (opts.chat) {
    const quota = await chatQuota(userId, now);
    if (quota.remaining === 0) return { error: chatLimitMessage(quota), limit: "chat", quota };
  }
  return null;
}
