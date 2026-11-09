import "server-only";
import { and, eq, sql } from "drizzle-orm";
import { agentSpend, type AgentInstallation } from "../../db/schema";
import { spends, type AgentDefinition, type AgentStep, type ToolName } from "../definition";
import { typedRules } from "../runner";
import { TOOL_ARGS } from "../toolbox";
import type { Runtime } from "./context";

// The spending guard. Spending is a payment (wallet.pay), or rows written
// to a sheet by an action that names an amount column (orders): the sum
// of that column. Before any of it goes through, the guard adds it to the
// job's running total and to the installation's total for the day (in its
// owner's time zone), and checks them against every spending limit the
// agent declares (askOver for a job, askOverDay for a day), at the owner's
// values. Over one, it waits for the owner's yes. It counts every action
// and every line, whatever the agent's own steps decided: five payments of
// 40 against a limit of 50 ask before the second goes through.

export interface Spend {
  actionId: string | null;
  tool: ToolName;
  amount: number;
  // What it is, in words, for the question.
  what: string;
}

const round = (n: number) => Math.round(n * 1e6) / 1e6;
export const usdc = (n: number) => `${round(n)} USDC`;

// The spending a tool call would be, or null when it spends nothing. An
// action step spends by its own action; a code step by the agent's action
// for that tool.
export function spendOf(d: AgentDefinition, step: AgentStep, tool: ToolName, args: unknown): Spend | null {
  const action = step.kind === "action" ? d.actions.find((a) => a.id === step.action && a.tool === tool) : d.actions.find((a) => a.tool === tool && spends(a));
  if (tool === "wallet.pay") {
    const p = TOOL_ARGS["wallet.pay"].safeParse(args);
    if (!p.success) return null;
    return { actionId: action?.id ?? null, tool, amount: p.data.amountUsdc, what: `Pay ${usdc(p.data.amountUsdc)} to ${p.data.to}${p.data.memo ? ` (${p.data.memo})` : ""}?` };
  }
  if (tool === "sheets.write" && action?.amountColumn) {
    const p = TOOL_ARGS["sheets.write"].safeParse(args);
    if (!p.success) return null;
    const column = action.amountColumn;
    const amount = round(
      p.data.rows.reduce((t, r) => {
        const v = typeof r[column] === "boolean" ? 0 : Number(r[column]);
        return t + (Number.isFinite(v) && v > 0 ? v : 0);
      }, 0),
    );
    if (amount <= 0) return null;
    const n = p.data.rows.length;
    return { actionId: action.id, tool, amount, what: `Write ${n} ${n === 1 ? "row" : "rows"} to "${p.data.sheet}", worth ${usdc(amount)}?` };
  }
  return null;
}

// The owner's day, in their time zone.
export function dayIn(timezone: string, at: Date): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
  } catch {
    return at.toISOString().slice(0, 10);
  }
}

async function sumOf(rt: Runtime, where: ReturnType<typeof and>): Promise<number> {
  const [row] = await rt.db.select({ usdc: sql<string>`coalesce(sum(${agentSpend.amountUsdc}), 0)::text` }).from(agentSpend).where(where);
  return Number(row?.usdc ?? 0);
}

// The question to ask before this spending, or null when it is within
// every limit.
export async function overLimit(rt: Runtime, i: AgentInstallation, d: AgentDefinition, jobId: string | null, spend: Spend): Promise<string | null> {
  const rules = typedRules(d, i.rules);
  const limits = (field: "askOver" | "askOverDay") =>
    [...new Set(d.actions.flatMap((a) => (spends(a) && a[field] ? [a[field]!] : [])))]
      .map((key) => ({ key, label: d.rules.find((r) => r.key === key)?.label ?? key, value: rules[key] }))
      .filter((l): l is { key: string; label: string; value: number } => typeof l.value === "number" && Number.isFinite(l.value));
  const perJob = limits("askOver");
  const perDay = limits("askOverDay");
  if (!perJob.length && !perDay.length) return null;
  const job = round((jobId ? await sumOf(rt, and(eq(agentSpend.jobId, jobId))) : 0) + spend.amount);
  const day = round((await sumOf(rt, and(eq(agentSpend.installationId, i.id), eq(agentSpend.day, dayIn(i.timezone, rt.now()))))) + spend.amount);
  const why: string[] = [];
  const jobOver = perJob.filter((l) => job > l.value).sort((a, b) => a.value - b.value)[0];
  if (jobOver) why.push(`This job's spending would come to ${usdc(job)}, over your limit of ${usdc(jobOver.value)} ("${jobOver.label}").`);
  const dayOver = perDay.filter((l) => day > l.value).sort((a, b) => a.value - b.value)[0];
  if (dayOver) why.push(`Today's spending would come to ${usdc(day)}, over your daily limit of ${usdc(dayOver.value)} ("${dayOver.label}").`);
  return why.length ? `${spend.what} ${why.join(" ")}` : null;
}

// Spending that went through, counted towards the totals.
export async function recordSpend(rt: Runtime, i: AgentInstallation, jobId: string | null, spend: Spend): Promise<void> {
  const now = rt.now();
  await rt.db.insert(agentSpend).values({ installationId: i.id, jobId, actionId: spend.actionId, tool: spend.tool, amountUsdc: spend.amount.toFixed(6), day: dayIn(i.timezone, now), createdAt: now });
}
