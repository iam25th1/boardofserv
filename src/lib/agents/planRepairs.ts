import { loopChain, loopsOf } from "./definition";

// Repairs to a plan as SERV answers it, each with only one meaning, made
// before the plan is checked (plan.ts, wireToDefinition), so a slip SERV
// makes again and again is put right here instead of going back to it:
//
// - A loop over one value (a setting that is a page link, a number, a
//   tab) goes once: its steps take its place, and its item is the setting.
// - A decision that is a plain comparison (a price against a target, a
//   quantity under its minimum, how many were met) or whether the owner
//   said yes goes by a value, not a judgement: the owner's answer to the
//   question before it, or the way the code step before it works out.
// - Every step that sends, asks, writes, pays or saves is handed exactly
//   what to send, ask, write, pay or save by a code step right before it:
//   where none is, one is put in that makes it from what the step reads.

// A step as wireToDefinition shapes it, before it is checked.
export interface RawStep {
  id: string;
  title: string;
  kind: string;
  inputs: string[];
  outputs: string[];
  next?: string | null;
  description?: string;
  tools?: string[];
  prompt?: string;
  outcomes?: { id: string; label: string; next: string | null }[];
  each?: string;
  from?: string;
  action?: string;
  otherwise?: string;
  over?: string;
  item?: string;
  body?: string;
  gather?: { from: string; into: string }[];
}

interface Setup {
  settings: { key: string; type: unknown }[];
  rules: { key: string; type: unknown }[];
  actions: { id: string; tool: unknown; description?: string }[];
}

const BAGS = ["settings", "rules", "memory", "trigger"];

// Every place a step points at another, replaced: next, each outcome,
// where an unanswered question goes, and a loop's first step.
function repoint(steps: RawStep[], from: string, to: string | null, except?: RawStep): void {
  for (const st of steps) {
    if (st === except) continue;
    if (st.next === from) st.next = to;
    if (st.otherwise === from) st.otherwise = to ?? undefined;
    if (st.body === from && to) st.body = to;
    if (st.outcomes) st.outcomes = st.outcomes.map((o) => (o.next === from ? { ...o, next: to } : o));
  }
}

// The steps that lead to this one.
function into(steps: RawStep[], id: string): RawStep[] {
  return steps.filter((st) => st.next === id || st.otherwise === id || st.body === id || st.outcomes?.some((o) => o.next === id));
}

// A name no step or value has yet.
function fresh(steps: RawStep[], base: string): string {
  const taken = new Set([...steps.map((s) => s.id), ...steps.flatMap((s) => s.outputs), ...BAGS]);
  const clean = base.replace(/[^a-z0-9_]/g, "_").replace(/^[^a-z]+/, "").slice(0, 36) || "value";
  if (!taken.has(clean)) return clean;
  for (let i = 2; ; i++) if (!taken.has(`${clean}_${i}`)) return `${clean}_${i}`;
}

// The same kind of step inside the same loops (or none).
function sameLevel(steps: RawStep[], a: string, b: string): boolean {
  try {
    const loops = loopsOf({ steps: steps as never });
    return loopChain(loops, a).join(",") === loopChain(loops, b).join(",");
  } catch {
    return false;
  }
}

// A loop over a setting or rule that isn't a list goes once: it is the
// one value itself.
export function dropSingleLoops(steps: RawStep[], setup: Setup): void {
  for (const loop of [...steps]) {
    if (loop.kind !== "loop" || !loop.over || !loop.body) continue;
    const setting = setup.settings.find((x) => x.key === loop.over);
    const rule = setup.rules.find((x) => x.key === loop.over);
    const bag = setting ? "settings" : rule ? "rules" : null;
    if (!bag || (setting ?? rule)!.type === "list") continue;
    let loops;
    try {
      loops = loopsOf({ steps: steps as never });
    } catch {
      continue;
    }
    const inside = steps.filter((st) => st !== loop && loopChain(loops, st.id).includes(loop.id));
    const own = inside.filter((st) => loops.inside.get(st.id) === loop.id);
    // Where a pass ended, the run goes on after the loop.
    const after = loop.next ?? null;
    for (const st of own) {
      if (st.kind === "decision") st.outcomes = (st.outcomes ?? []).map((o) => ({ ...o, next: o.next ?? after }));
      else if (st.kind !== "loop" || st.next !== undefined) st.next = st.next ?? after;
    }
    // Whatever led to the loop leads to its first step.
    repoint(steps, loop.id, loop.body, loop);
    // Its item is the setting; what it gathered is the one value.
    const item = loop.item ?? "";
    for (const st of inside) {
      st.inputs = [...new Set(st.inputs.map((i) => (i === item ? bag : i)))];
      const word = new RegExp(`\\b${item}\\b`, "g");
      if (item && st.description) st.description = st.description.replace(word, `${bag}.${loop.over}`);
      if (item && st.prompt) st.prompt = st.prompt.replace(word, `${bag}.${loop.over}`);
    }
    for (const g of loop.gather ?? []) for (const st of steps) st.inputs = st.inputs.map((i) => (i === g.into ? g.from : i));
    // Its first step takes its place, so a run that started with the loop
    // starts there.
    const at = steps.indexOf(loop);
    const first = steps.find((st) => st.id === loop.body);
    steps.splice(at, 1);
    if (first && at === 0) {
      steps.splice(steps.indexOf(first), 1);
      steps.unshift(first);
    }
  }
}

// A comparison of amounts: a word that compares and a word that is an
// amount ("is the price below the target?", "did it meet at least half?").
const COMPARES = /\b(?:below|above|under|over|less|more|fewer|greater|higher|lower|cheaper|dearer|exceeds?|exceeded|at (?:or )?(?:below|above|least|most)|equals?|between|reach(?:ed|es)?|how many)\b|[<>]/i;
const AMOUNT = /\b(?:price|prices|cost|costs|amount|total|quantity|stock|number|count|score|met|minimum|maximum|target|threshold|limit|budget|balance|percent|half|how many)\b|\d|[$£€%]/i;
const SAYS_YES = /\b(?:say|said|says|answer(?:ed|s)?|repl(?:y|ied|ies)|approv(?:e|ed|es|al)|agree(?:d|s)?|confirm(?:ed|s)?|accept(?:ed|s)?)\b/i;
const YES_NO = /^(?:yes|no|approved?|declined?|agreed?|rejected?|confirmed?)$/i;

// The way a decision goes, in words a code step can be told.
function waysOf(d: RawStep): string {
  const outcomes = d.outcomes ?? [];
  return `${outcomes.map((o) => `"${o.id}" (${o.label})`).join(" or ")}, answering: ${(d.prompt || d.title).trim()}`;
}

// A plain comparison, or the owner's yes, goes by a value.
export function decideByValue(steps: RawStep[], setup: Setup): void {
  const asks = new Set(setup.actions.filter((a) => a.tool === "telegram.ask").map((a) => a.id));
  for (const d of [...steps]) {
    if (d.kind !== "decision" || d.each || d.from || (d.outcomes ?? []).length < 2) continue;
    const words = `${d.title} ${d.prompt ?? ""}`;
    // The owner's answer to a question asked just before.
    const answers = d.inputs.filter((i) => steps.some((st) => st.kind === "action" && st.action && asks.has(st.action) && st.outputs[0] === i));
    const yesNo = (d.outcomes ?? []).every((o) => YES_NO.test(o.id.replace(/_/g, " ")) || YES_NO.test(o.label));
    if (answers.length === 1 && (SAYS_YES.test(words) || yesNo)) {
      d.from = answers[0]!;
      continue;
    }
    if (!COMPARES.test(words) || !AMOUNT.test(words)) continue;
    // The code step right before it works out the way too, when it is the
    // one step that leads there; else a code step of its own does.
    const way = fresh(steps, `${d.id}_way`);
    const before = into(steps, d.id);
    const only = before.length === 1 && before[0]!.kind === "code" && before[0]!.next === d.id && sameLevel(steps, before[0]!.id, d.id) ? before[0]! : null;
    if (only) {
      only.outputs = [...only.outputs, way];
      only.description = `${only.description ?? ""} Also return ${way}: ${waysOf(d)}.`.trim();
    } else {
      const check: RawStep = { id: fresh(steps, `${d.id}_check`), title: `Work out: ${d.title}`.slice(0, 80), kind: "code", inputs: [...d.inputs], outputs: [way], next: d.id, description: `Return ${way}: ${waysOf(d)}.`, tools: [] };
      repoint(steps, d.id, check.id);
      steps.splice(steps.indexOf(d), 0, check);
    }
    d.inputs = [...new Set([...d.inputs, way])];
    d.from = way;
  }
}

// What each tool that changes something is handed, as a code step makes it.
const MADE: Record<string, string> = {
  "telegram.send": "telegram.send's arguments { text }, the message in plain words",
  "telegram.ask": 'telegram.ask\'s arguments { question, choices }, the question in plain words with the choices ["Yes", "No"]',
  "sheets.write": "sheets.write's arguments { sheet, rows }",
  "sheets.update": "sheets.update's arguments { sheet, updates: [{ row, values }] }",
  "wallet.pay": "wallet.pay's arguments { to, amountUsdc, memo }",
  "memory.set": "memory.set's arguments { key, value }",
};

// Every step that sends, asks, writes, pays or saves is handed exactly
// that by a code step right before it.
export function buildArguments(steps: RawStep[], setup: Setup): void {
  const tools = new Map(setup.actions.map((a) => [a.id, a]));
  for (const st of [...steps]) {
    if (st.kind !== "action" || !st.action) continue;
    const action = tools.get(st.action);
    const tool = typeof action?.tool === "string" ? action.tool : "";
    const made = MADE[tool];
    if (!made) continue;
    const first = st.inputs[0];
    const maker = first ? steps.find((x) => x.outputs.includes(first)) : undefined;
    const shared = first ? steps.some((x) => x !== st && x.inputs.includes(first)) : false;
    // A value of its own, made by code for it alone.
    if (maker?.kind === "code" && !shared) {
      // Made by code already: the code is told the shape it makes.
      if (!(maker.description ?? "").includes(tool)) maker.description = `${maker.description ?? ""} Return ${first} as ${made}.`.trim();
      continue;
    }
    // What it reads that nothing makes is its own details' to put right
    // (the checker sends them back): nothing is built from it.
    const known = new Set([...BAGS, ...steps.flatMap((x) => x.outputs), ...steps.flatMap((x) => (x.kind === "loop" && x.item ? [x.item] : []))]);
    if (st.inputs.some((i) => !known.has(i))) continue;
    const before = into(steps, st.id);
    const reads = st.inputs.length ? st.inputs : before.length === 1 ? before[0]!.outputs : [];
    const out = fresh(steps, `${st.id}_content`);
    const what = action?.description ? `: ${action.description.replace(/\.$/, "")}` : "";
    // Saving builds on what was saved before.
    const saves = tool === "memory.set";
    const builder: RawStep = {
      id: fresh(steps, `make_${st.id}`),
      title: (tool.startsWith("telegram") ? "Write the message" : tool === "wallet.pay" ? "Work out the payment" : "Prepare what it writes").slice(0, 80),
      kind: "code",
      inputs: [...new Set([...reads, ...(setup.settings.length ? ["settings"] : []), ...(saves ? ["memory"] : [])])],
      outputs: [out],
      next: st.id,
      description: `Return ${out} as ${made}${what}. Make it from its inputs; return null when there is nothing to do.${saves ? " Build on what memory holds already: a saved position keeps the larger of the old one and the new one." : ""}`,
      tools: [],
    };
    repoint(steps, st.id, builder.id);
    steps.splice(steps.indexOf(st), 0, builder);
    st.inputs = [out];
  }
}

export function repairPlan(steps: RawStep[], setup: Setup): void {
  dropSingleLoops(steps, setup);
  decideByValue(steps, setup);
  buildArguments(steps, setup);
}
