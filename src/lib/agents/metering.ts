import "server-only";
import { and, eq, gte, sql } from "drizzle-orm";
import { agentListings, agentModelUsage, platformModelUsage, rentals, type AgentInstallation } from "../db/schema";
import { modelPrices, type JsonResult } from "../model";
import { formatAmount, parseAmount } from "../money";
import type { Runtime } from "./runtime/context";
import type { AgentDefinition } from "./definition";

// Model cost inside agent runs. Every model call a run makes (a decision,
// the guard's check, the input screen) is metered per installation, per job
// and per day, in tokens and in USDC at the configured rates (the
// *_PRICE_*_PER_M settings, in USDC). Each installation has a weekly model
// budget: its maker sets a default, the platform a ceiling, the renter can
// lower or raise it within the ceiling. A run that would go over it asks
// the renter first. Free agents (free to rent, or a maker's own copy) run
// on a small weekly allowance the platform pays for, and pause with a
// plain message when it is used up, starting again the next week. Calls on
// the renter's own SERV key are metered but cost the site nothing: they
// don't count toward the allowance. Weeks start on Monday, UTC.

const DAY_MS = 86_400_000;
const USDC = 6;

type Env = Record<string, string | undefined>;
const micros = (raw: string | undefined, fallback: string) => {
  const n = raw?.trim() ? parseAmount(raw.trim(), USDC) : null;
  return n ?? parseAmount(fallback, USDC)!;
};

export function budgetConfig(env: Env = process.env) {
  const ceiling = micros(env.AGENT_MODEL_BUDGET_CEILING_USDC, "5");
  const byDefault = micros(env.AGENT_MODEL_BUDGET_USDC, "1");
  return {
    // What an installation may spend on models in a week unless its maker
    // or renter says otherwise, and the most anyone may set.
    byDefault: byDefault > ceiling ? ceiling : byDefault,
    ceiling,
    // What the platform pays each week for a free agent's model calls.
    allowance: micros(env.AGENT_FREE_MODEL_ALLOWANCE_USDC, "0.25"),
  };
}

export const usdcWords = (minor: bigint) => `${formatAmount(minor, USDC)} USDC`;

// One call's cost in USDC minor units (rates are per million tokens).
export function costMicros(call: Pick<JsonResult, "provider" | "promptTokens" | "completionTokens">): bigint {
  const price = modelPrices()[(call.provider ?? "serv") as "serv"] ?? modelPrices().serv;
  const exact = (call.promptTokens ?? 0) * price.input + (call.completionTokens ?? 0) * price.output;
  return BigInt(Math.ceil(exact));
}

// What one more call is likely to cost, for the budget's check before it.
export function callEstimate(): bigint {
  return costMicros({ provider: "serv", promptTokens: 1500, completionTokens: 120 });
}

export interface Scope {
  installationId: string;
  jobId: string | null;
  agentId: string;
  ownerUserId: string;
}

export async function meter(rt: Runtime, scope: Scope, purpose: "decision" | "guard" | "screen", call: JsonResult, ownKey: boolean): Promise<bigint> {
  const cost = costMicros(call);
  const now = rt.now();
  await rt.db.insert(agentModelUsage).values({
    installationId: scope.installationId,
    jobId: scope.jobId,
    agentId: scope.agentId,
    ownerUserId: scope.ownerUserId,
    purpose,
    provider: call.provider,
    model: call.model,
    promptTokens: call.promptTokens ?? 0,
    completionTokens: call.completionTokens ?? 0,
    cost: cost.toString(),
    ownKey,
    day: now.toISOString().slice(0, 10),
    createdAt: now,
  });
  return cost;
}

export function weekStart(t: Date): Date {
  const d = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate()));
  return new Date(d.getTime() - ((d.getUTCDay() + 6) % 7) * DAY_MS);
}

// This week's model cost of an installation: in all, and what the site paid.
export async function weekCost(rt: Runtime, installationId: string): Promise<{ all: bigint; site: bigint }> {
  const [row] = await rt.db
    .select({
      all: sql<string>`coalesce(sum(${agentModelUsage.cost}), 0)::text`,
      site: sql<string>`coalesce(sum(case when ${agentModelUsage.ownKey} then 0 else ${agentModelUsage.cost} end), 0)::text`,
    })
    .from(agentModelUsage)
    .where(and(eq(agentModelUsage.installationId, installationId), gte(agentModelUsage.createdAt, weekStart(rt.now()))));
  return { all: BigInt(row?.all ?? "0"), site: BigInt(row?.site ?? "0") };
}

// One job's model cost that the site paid.
export async function jobSiteCost(rt: Runtime, jobId: string): Promise<bigint> {
  const [row] = await rt.db
    .select({ site: sql<string>`coalesce(sum(case when ${agentModelUsage.ownKey} then 0 else ${agentModelUsage.cost} end), 0)::text` })
    .from(agentModelUsage)
    .where(eq(agentModelUsage.jobId, jobId));
  return BigInt(row?.site ?? "0");
}

export interface Budget {
  // The installation's weekly budget, the maker's default and the ceiling.
  budget: bigint;
  makerDefault: bigint;
  ceiling: bigint;
  // A free agent, on the platform's weekly allowance.
  free: boolean;
  allowance: bigint;
  // Its renter pays each job's model cost on top of the fee.
  modelShare: boolean;
}

export async function budgetOf(rt: Runtime, i: Pick<AgentInstallation, "id" | "agentId" | "modelBudget">): Promise<Budget> {
  const cfg = budgetConfig();
  const [rental] = await rt.db.select({ weeklyPrice: rentals.weeklyPrice, jobFee: rentals.jobFee, modelShare: rentals.modelShare }).from(rentals).where(eq(rentals.installationId, i.id));
  const [listing] = await rt.db.select({ modelBudget: agentListings.modelBudget }).from(agentListings).where(eq(agentListings.agentId, i.agentId));
  const clamp = (n: bigint) => (n > cfg.ceiling ? cfg.ceiling : n < 0n ? 0n : n);
  const makerDefault = clamp(listing?.modelBudget ? BigInt(listing.modelBudget) : cfg.byDefault);
  const budget = clamp(i.modelBudget !== null && i.modelBudget !== undefined ? BigInt(i.modelBudget) : makerDefault);
  const free = !rental || (BigInt(rental.weeklyPrice) === 0n && BigInt(rental.jobFee) === 0n);
  return { budget, makerDefault, ceiling: cfg.ceiling, free, allowance: cfg.allowance, modelShare: Boolean(rental?.modelShare) };
}

export const allowancePause = (allowance: bigint) =>
  `Its free model allowance of ${usdcWords(allowance)} for this week is used up, so it is paused. It starts again on Monday, or sooner on your own SERV key.`;
export const ALLOWANCE_PREFIX = "Its free model allowance of ";

export type BudgetGate = { kind: "ok" } | { kind: "ask"; question: string; reason: string } | { kind: "pause"; reason: string };

// Before a model call in a run: whether it may go ahead within the week's
// budget (and a free agent's allowance).
export async function budgetGate(rt: Runtime, i: Pick<AgentInstallation, "id" | "agentId" | "modelBudget">, ownKey: boolean): Promise<BudgetGate> {
  const b = await budgetOf(rt, i);
  const spent = await weekCost(rt, i.id);
  const next = callEstimate();
  if (b.free && !ownKey && spent.site + next > b.allowance) return { kind: "pause", reason: allowancePause(b.allowance) };
  if (spent.all + next > b.budget) {
    return {
      kind: "ask",
      question: `This agent has used ${usdcWords(spent.all)} of its ${usdcWords(b.budget)} weekly model budget. Let this job go over it?`,
      reason: "It would go over the weekly model budget for this agent.",
    };
  }
  return { kind: "ok" };
}

// Today's model cost of an installation (UTC day).
export async function dayCost(rt: Runtime, installationId: string): Promise<bigint> {
  const [row] = await rt.db
    .select({ all: sql<string>`coalesce(sum(${agentModelUsage.cost}), 0)::text` })
    .from(agentModelUsage)
    .where(and(eq(agentModelUsage.installationId, installationId), eq(agentModelUsage.day, rt.now().toISOString().slice(0, 10))));
  return BigInt(row?.all ?? "0");
}

export async function budgetDTO(rt: Runtime, i: Pick<AgentInstallation, "id" | "agentId" | "modelBudget">) {
  const b = await budgetOf(rt, i);
  const week = await weekCost(rt, i.id);
  return {
    spentThisWeek: week.all.toString(),
    spentToday: (await dayCost(rt, i.id)).toString(),
    budget: b.budget.toString(),
    makerDefault: b.makerDefault.toString(),
    ceiling: b.ceiling.toString(),
    free: b.free,
    allowance: b.allowance.toString(),
    modelShare: b.modelShare,
    decimals: USDC,
  };
}

// Runs a week, from its triggers: a schedule's own rate, a value check or a
// message trigger taken as one run a day.
export function runsPerWeek(d: Pick<AgentDefinition, "triggers">): number {
  let runs = 0;
  for (const t of d.triggers) {
    if (t.kind === "schedule") {
      const s = t as { every: string; interval?: number | null; days?: number[] | null };
      const n = Math.max(1, s.interval ?? 1);
      runs += s.every === "minutes" ? 10080 / n : s.every === "hours" || s.every === "hour" ? 168 / n : s.every === "week" ? Math.max(1, s.days?.length ?? 1) : 7;
    } else runs += 7;
  }
  return runs;
}

// A rough weekly model cost: runs a week, times its model calls a run (each
// decision and its screen, each guarded action), at a typical call's cost.
export function estimateWeekly(d: Pick<AgentDefinition, "triggers" | "steps" | "actions">): bigint {
  const decisions = d.steps.filter((s) => s.kind === "decision").length;
  const guarded = d.steps.filter((s) => s.kind === "action").length;
  const calls = decisions * 2 + guarded;
  return BigInt(Math.round(runsPerWeek(d) * calls)) * callEstimate();
}

// boardofserv's own model calls, outside any installation: code reviews
// while an agent is built, the review before publishing, screening posts
// and listings, screening outside a run. Metered in tokens and cost, and
// kept within the platform's own daily budget (PLATFORM_MODEL_BUDGET_USDC,
// 2 USDC unless set): over it, those checks act as when SERV can't answer
// (a post waits for a person, a review waits), never skipped. Calls on the
// person's own SERV key are metered but cost the site nothing.
export type PlatformPurpose = "code_review" | "publish_review" | "post_screen" | "screen";

export function platformBudget(env: Env = process.env): bigint {
  return micros(env.PLATFORM_MODEL_BUDGET_USDC, "2");
}

type Db = Runtime["db"];

export async function meterPlatform(db: Db, o: { purpose: PlatformPurpose; userId: string | null; agentId?: string | null; call: Pick<JsonResult, "provider" | "model" | "promptTokens" | "completionTokens">; ownKey: boolean; now?: Date }): Promise<bigint> {
  const cost = costMicros(o.call);
  const now = o.now ?? new Date();
  await db.insert(platformModelUsage).values({
    purpose: o.purpose,
    userId: o.userId,
    agentId: o.agentId ?? null,
    provider: o.call.provider ?? null,
    model: o.call.model ?? null,
    promptTokens: o.call.promptTokens ?? 0,
    completionTokens: o.call.completionTokens ?? 0,
    cost: cost.toString(),
    ownKey: o.ownKey,
    day: now.toISOString().slice(0, 10),
    createdAt: now,
  });
  return cost;
}

// What the site paid today for its own calls.
export async function platformSpentToday(db: Db, now: Date = new Date()): Promise<bigint> {
  const [row] = await db
    .select({ site: sql<string>`coalesce(sum(case when ${platformModelUsage.ownKey} then 0 else ${platformModelUsage.cost} end), 0)::text` })
    .from(platformModelUsage)
    .where(eq(platformModelUsage.day, now.toISOString().slice(0, 10)));
  return BigInt(row?.site ?? "0");
}

// Whether one more of its own calls fits today's budget (always, on the
// person's own key).
export async function platformRoom(db: Db, ownKey: boolean, now: Date = new Date(), env: Env = process.env): Promise<boolean> {
  if (ownKey) return true;
  return (await platformSpentToday(db, now)) + callEstimate() <= platformBudget(env);
}
