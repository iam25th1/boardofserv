import { connectionsNeeded, loopChain, loopsOf, SIDE_EFFECT_TOOLS, spends, type AgentDefinition, type AgentStep } from "./definition";

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
};

// Words written for the plan, made plain: a tool's name becomes what it
// touches, a value's name ("settings.sheet_id", "row_status") its words,
// and brackets and code marks go.
export function plain(text: string): string {
  return text
    .replace(/\b(?:sheets|web|telegram|memory|wallet)\.[a-z]+\b/g, (m) => TOOL_WORDS[m] ?? m.replace(".", " "))
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
