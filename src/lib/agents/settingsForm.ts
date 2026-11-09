import type { AgentDefinition, Rule, Setting } from "./definition";
import { isSheetAnswer, parseSheetLink } from "../google/sheetLink";
import { z } from "zod";

// The form an owner fills in to run an agent: one field per settings
// question, typed by the question, then the rules with the maker's defaults
// filled in, then when and how often it may run. The same checks run in the
// browser (to say what's wrong before sending) and on the server (which
// decides).

type SettingDef = z.infer<typeof Setting>;
type RuleDef = z.infer<typeof Rule>;

export const MAX_DAILY_SPEND_USD = 5;
export const DEFAULT_DAILY_SPEND_USD = 0.5;
export const DEFAULT_MIN_GAP_MINUTES = 5;

export interface InstallAnswers {
  settings: Record<string, unknown>;
  // Rule values as text, as the form holds them; empty keeps the default.
  rules: Record<string, string>;
  timezone: string;
  // The time of day ("HH:MM") and weekday (0 is Sunday) for a scheduled agent.
  schedule?: { at: string | null; day: number | null } | null;
  minGapMinutes?: number;
  dailySpendUsd?: number;
  // How much it may spend per call without asking (USDC); none is 0.
  autoSpendUsdc?: number;
}

export type CheckedAnswers =
  | { ok: true; settings: Record<string, unknown>; rules: Record<string, string>; timezone: string; schedule: { at: string | null; day: number | null } | null; minGapMinutes: number; dailySpendUsd: number }
  | { ok: false; errors: Record<string, string> };

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

export function validTimezone(tz: string): boolean {
  if (!tz || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function isHttpUrl(v: string): boolean {
  try {
    const u = new URL(v);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

// One settings answer, as code will read it, or why it won't do.
export function settingValue(s: SettingDef, raw: unknown): { value: unknown } | { error: string } {
  const text = typeof raw === "string" ? raw.trim() : raw === undefined || raw === null ? "" : null;
  switch (s.type) {
    case "boolean":
      if (typeof raw === "boolean") return { value: raw };
      if (text === "" || text === "false") return { value: false };
      if (text === "true") return { value: true };
      return { error: "Answer yes or no." };
    case "number": {
      const n = typeof raw === "number" ? raw : text ? Number(text) : NaN;
      return Number.isFinite(n) ? { value: n } : { error: "Answer with a number." };
    }
    case "list": {
      const items = Array.isArray(raw) ? raw.map((x) => String(x).trim()) : (text ?? "").split(",").map((x) => x.trim());
      const list = items.filter(Boolean);
      if (!list.length) return { error: "Give at least one, separated by commas." };
      if (list.length > 50 || list.some((x) => x.length > 200)) return { error: "That list is too long." };
      return { value: list };
    }
    case "choice":
      if (text && s.choices.includes(text)) return { value: text };
      return { error: `Pick one of: ${s.choices.join(", ")}.` };
    case "url":
      if (text && text.length <= 2000 && isHttpUrl(text)) return { value: text };
      return { error: "Give a web address starting with http:// or https://." };
    case "sheet":
      // For real: a Google Sheet's link and the tab picked from it. On the
      // test bench, a sample sheet's name.
      if (isSheetAnswer(raw)) {
        if (!parseSheetLink(raw.url)) return { error: "Paste the link of a Google Sheet (docs.google.com/spreadsheets/...)." };
        if (!raw.tab.trim() || raw.tab.length > 100) return { error: "Pick one of its tabs." };
        return { value: { url: raw.url.trim(), tab: raw.tab.trim() } };
      }
      if (text && text.length <= 80) return { value: text };
      return { error: "Paste the link of a Google Sheet, then pick its tab." };
    default:
      if (text && text.length <= 500) return { value: text };
      return { error: text ? "That's too long." : "This one needs an answer." };
  }
}

// One rule value, as text, or why it won't do. Empty keeps the maker's default.
export function ruleText(r: RuleDef, raw: unknown): { value: string } | { error: string } {
  const text = typeof raw === "string" ? raw.trim() : typeof raw === "number" || typeof raw === "boolean" ? String(raw) : "";
  if (!text) return { value: r.value };
  if (text.length > 200) return { error: "That's too long." };
  if (r.type === "number" || r.type === "usdc") {
    const n = Number(text);
    return Number.isFinite(n) && n >= 0 ? { value: String(n) } : { error: r.type === "usdc" ? "Give an amount in USDC." : "Give a number." };
  }
  if (r.type === "boolean") return ["true", "false"].includes(text) ? { value: text } : { error: "Answer yes or no." };
  return { value: text };
}

// Every answer checked against the agent's questions. Errors are keyed by
// the field they belong to: a setting or rule key, or timezone, schedule,
// minGapMinutes, dailySpendUsd.
export function checkAnswers(d: Pick<AgentDefinition, "settings" | "rules" | "triggers">, a: InstallAnswers): CheckedAnswers {
  const errors: Record<string, string> = {};
  const settings: Record<string, unknown> = {};
  for (const s of d.settings) {
    const r = settingValue(s, a.settings?.[s.key]);
    if ("error" in r) errors[s.key] = r.error;
    else settings[s.key] = r.value;
  }
  const rules: Record<string, string> = {};
  for (const r of d.rules) {
    const v = ruleText(r, a.rules?.[r.key]);
    if ("error" in v) errors[`rule:${r.key}`] = v.error;
    else rules[r.key] = v.value;
  }
  if (!validTimezone(a.timezone)) errors.timezone = "Pick a time zone.";
  const scheduled = d.triggers.find((t) => t.kind === "schedule");
  let schedule: { at: string | null; day: number | null } | null = null;
  if (scheduled && a.schedule) {
    const at = a.schedule.at?.trim() || null;
    const day = a.schedule.day ?? null;
    if (at !== null && !TIME.test(at)) errors.schedule = "Give a time like 07:30.";
    else if (day !== null && !(Number.isInteger(day) && day >= 0 && day <= 6)) errors.schedule = "Pick a day of the week.";
    else schedule = { at, day };
  }
  const gap = a.minGapMinutes ?? DEFAULT_MIN_GAP_MINUTES;
  if (!Number.isInteger(gap) || gap < 0 || gap > 1440) errors.minGapMinutes = "Give whole minutes, up to a day (1440).";
  const spend = a.dailySpendUsd ?? DEFAULT_DAILY_SPEND_USD;
  if (!Number.isFinite(spend) || spend < 0 || spend > MAX_DAILY_SPEND_USD) errors.dailySpendUsd = `Give an amount from 0 to ${MAX_DAILY_SPEND_USD} US dollars.`;
  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, settings, rules, timezone: a.timezone, schedule, minGapMinutes: gap, dailySpendUsd: spend };
}
