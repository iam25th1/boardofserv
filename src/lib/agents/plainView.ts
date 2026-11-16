import { TYPED_READS } from "../connections/reads";
import { connectionsNeeded, loopChain, loopsOf, SIDE_EFFECT_TOOLS, spends, type AgentDefinition, type AgentStep } from "./definition";
import { describeTriggers } from "./schedule";

// An agent's plan as its maker reads it with details off: what it does, its
// steps as plain sentences, what it connects to and what it asks before
// doing. Never the names of values, tools or step kinds, and never JSON:
// those are for the details view.

const TOOL_WORDS: Record<string, string> = {
  "sheets.read": "your sheet",
  "sheets.write": "your sheet",
  "sheets.update": "your sheet",
  "web.fetch": "a web page",
  "web.search": "a web search",
  "telegram.send": "Telegram",
  "telegram.ask": "Telegram",
  "memory.get": "what it remembers",
  "memory.set": "what it remembers",
  "wallet.pay": "the wallet",
  "serv.reason": "SERV",
  "typeform.read": "your Typeform form",
  "service.request": "a service",
  "service.send": "a service",
  ...Object.fromEntries(TYPED_READS.map((t) => [t.tool, t.outside])),
};

// Words written for the plan, made plain: a tool's name becomes what it
// touches, a value's name ("settings.sheet_id", "row_status") its words,
// and brackets and code marks go.
export function plain(text: string): string {
  return text
    .replace(/\b(?:sheets|web|telegram|memory|wallet|serv|typeform|service|github|tally|airtable|notion|linear|shopify|stripe|etherscan|coingecko)\.[a-z]+\b/g, (m) => TOOL_WORDS[m] ?? m.replace(".", " "))
    .replace(/\b(?:settings|rules|memory|trigger|input|inputs)\.([a-z][a-z0-9_]*)/g, (_, k: string) => k.replace(/_/g, " "))
    .replace(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g, (m) => m.replace(/_/g, " "))
    .replace(/[{}[\]`<>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// One step in a sentence: its own plain words when the plan gave them, else
// its title, with a decision's outcomes or an action's job beside it.
export function stepLine(step: AgentStep, d: AgentDefinition): string {
  if (step.plain) return plain(step.plain);
  if (step.kind === "decision") {
    // A question with one way that ends the run reads as the question and
    // when it stops: "Did you say yes? If no, it stops there."
    const title = plain(step.title);
    const ends = step.outcomes.filter((o) => o.next === null);
    if (title.endsWith("?") && step.outcomes.length === 2 && ends.length === 1 && !step.each) return `${title} If ${plain(ends[0]!.label).toLowerCase()}, it stops there.`;
    return `${title.replace(/\?$/, "")}: ${step.outcomes.map((o) => plain(o.label).toLowerCase()).join(" or ")}`;
  }
  if (step.kind === "action") {
    const action = d.actions.find((a) => a.id === step.action);
    return action ? plain(action.description) : plain(step.title);
  }
  if (step.kind === "loop") return `For each ${plain(step.item)}`;
  return plain(step.title);
}

// How many loops each step is inside, for the plain view to set the steps
// of a loop in under it.
export function stepDepths(d: AgentDefinition): Map<string, number> {
  const loops = loopsOf(d);
  return new Map(d.steps.map((s) => [s.id, loopChain(loops, s.id).length]));
}

// The steps in the order a run takes them from the first, each once, a
// loop's own steps right after it; any the run never reaches (a value
// check's own step) come last.
export function stepsInOrder(d: AgentDefinition): AgentStep[] {
  const byId = new Map(d.steps.map((s) => [s.id, s]));
  const seen: AgentStep[] = [];
  const visit = (id: string | null) => {
    const s = id ? byId.get(id) : undefined;
    if (!s || seen.includes(s)) return;
    seen.push(s);
    const nexts = s.kind === "decision" ? s.outcomes.map((o) => o.next) : s.kind === "action" ? [s.next, s.otherwise ?? null] : s.kind === "loop" ? [s.body, s.next] : [s.next];
    for (const n of nexts) visit(n);
  };
  visit(d.steps[0]?.id ?? null);
  return [...seen, ...d.steps.filter((s) => !seen.includes(s))];
}

// What it reaches outside itself, in plain words.
export function connectsTo(d: AgentDefinition): string[] {
  const needs = connectionsNeeded(d);
  const tools = new Set([...d.actions.map((a) => a.tool), ...d.steps.flatMap((s) => (s.kind === "code" ? s.tools : []))]);
  const out: string[] = [];
  if (needs.google) out.push("Your Google Sheets");
  if (needs.telegram) out.push("Your Telegram");
  if (tools.has("web.fetch")) out.push("Web pages");
  if (tools.has("web.search")) out.push("Web search");
  if (tools.has("wallet.pay")) out.push("A wallet, on test money");
  return out;
}

// What it asks its owner before doing, in plain words.
export function asksBefore(d: AgentDefinition): string[] {
  const out: string[] = [];
  for (const a of d.actions) {
    if (a.tool === "telegram.ask") out.push(plain(a.description));
    if (spends(a)) {
      const over = d.rules.find((r) => r.key === a.askOver);
      const day = d.rules.find((r) => r.key === a.askOverDay);
      if (over) out.push(`Spending more than "${plain(over.label)}" in one run`);
      if (day) out.push(`Spending more than "${plain(day.label)}" in one day`);
    }
  }
  if (d.actions.some((a) => SIDE_EFFECT_TOOLS.includes(a.tool))) out.push("Anything the safety check isn't sure about, before it writes, sends or pays");
  return [...new Set(out)];
}

// What a newer version changed, in one line for its owner: when it runs
// first, then its steps, then what it asks at setup and its limits.
export function whatChanged(before: AgentDefinition, after: AgentDefinition): string {
  const sorted = (v: unknown): unknown => (Array.isArray(v) ? v.map(sorted) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted((v as Record<string, unknown>)[k])])) : v);
  const same = (a: unknown, b: unknown) => JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));
  const lower = (t: string) => t.charAt(0).toLowerCase() + t.slice(1);
  const when = (d: AgentDefinition) => lower(describeTriggers(d).map((t) => t.replace(/^Runs\s+/i, "")).join(", "));
  if (!same(before.triggers, after.triggers)) return `It now runs ${when(after)}, not ${when(before)}.`;
  const lines = (d: AgentDefinition) => stepsInOrder(d).map((s) => stepLine(s, d));
  const [was, now] = [lines(before), lines(after)];
  const quoted = (xs: string[]) => `${xs.slice(0, 2).map((x) => `"${x}"`).join(" and ")}${xs.length > 2 ? `, and ${xs.length - 2} more` : ""}`;
  const added = now.filter((l) => !was.includes(l));
  if (added.length) return `New or changed: ${quoted(added)}.`;
  const gone = was.filter((l) => !now.includes(l));
  if (gone.length) return `It no longer does ${quoted(gone)}.`;
  const asks = after.settings.filter((s) => !before.settings.some((b) => b.key === s.key));
  if (asks.length) return `It asks you for "${plain(asks[0]!.label)}" at setup.`;
  const dropped = before.settings.filter((s) => !after.settings.some((a) => a.key === s.key));
  if (dropped.length) return `It no longer asks for "${plain(dropped[0]!.label)}".`;
  if (!same(before.rules, after.rules)) return "Its limits changed.";
  return "Its steps read the same; how they do their work changed.";
}
