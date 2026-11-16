import { loopChain, loopsOf, REASON_TOOL, type CodeStepDef } from "./definition";
import { needsReasoning } from "./planRules";
import { parseShape, showShape } from "./shapes";
import { OUTSIDE_TOOLS } from "./toolbox";
import { CATALOG, type ServiceEntry } from "../connections/catalog";

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
// - The setup never asks for a Telegram chat id, a token, a key or a
//   password, and a sheet asked for as a link (or by its name) is picked
//   as a sheet.
// - A payment asks the owner and checks the allowance by itself (the
//   platform's approval): a question or an allowance check of the plan's
//   own in front of one is taken out. So is a question in front of a
//   message or a write to the owner's own things that the maker never
//   asked to be asked.
// - Columns are read by their header names: a setting or rule that names
//   a column (often by an invented letter) is taken out, and the steps
//   read that column by its name.

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

// What the steps before this one made, back along the one way in, as far
// as a place two ways meet: what is there on every way to it.
function madeOnTheWay(steps: RawStep[], id: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (let at = into(steps, id); at.length === 1 && !seen.has(at[0]!.id); at = into(steps, at[0]!.id)) {
    const st = at[0]!;
    seen.add(st.id);
    if (st.kind === "loop") break;
    out.push(...st.outputs.filter((o) => !out.includes(o)));
  }
  return out;
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
    if (d.kind !== "decision" || d.each || (d.outcomes ?? []).length < 2) continue;
    // A value to go by is the owner's answer, or a way a code step says it
    // works out (naming the outcomes, or true and false). Any other value
    // (the price itself) is no way to go: the decision is looked at again.
    if (d.from) {
      const maker = steps.find((st) => st.outputs.includes(d.from!));
      const answer = maker?.kind === "action" && Boolean(maker.action && asks.has(maker.action));
      const words = `${maker?.description ?? ""}`;
      const says = maker?.kind === "code" && ((d.outcomes ?? []).every((o) => words.includes(o.id)) || /\btrue\b[\s\S]*\bfalse\b/i.test(words));
      if (answer || says) continue;
      d.from = undefined;
    }
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
  "telegram.send": "the message in plain words: telegram.send's arguments { text }, or the text itself",
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
    const reads = st.inputs.length ? st.inputs : madeOnTheWay(steps, st.id);
    const out = fresh(steps, `${st.id}_content`);
    // Only what can come up empty (rows, results, a list) has nothing to
    // do: a step that always acts (a weekly payment, a morning message)
    // always makes what it hands on.
    const empty = mayBeEmpty(steps, st.id);
    const what = action?.description ? `: ${action.description.replace(/\.$/, "")}` : "";
    // Saving builds on what was saved before.
    const saves = tool === "memory.set";
    const builder: RawStep = {
      id: fresh(steps, `make_${st.id}`),
      title: tool === "telegram.ask" ? "Write the question" : tool === "telegram.send" ? "Write the message" : tool === "wallet.pay" ? "Work out the payment" : "Prepare what it writes",
      kind: "code",
      inputs: [...new Set([...reads, ...(setup.settings.length ? ["settings"] : []), ...(saves ? ["memory"] : [])])],
      outputs: [out],
      next: st.id,
      description: `Return ${out} as ${made}${what}. Make it from its inputs only${empty ? "; return null when there is nothing to do" : ", every run"}.${saves ? " Build on what memory holds already: a saved position keeps the larger of the old one and the new one." : ""}`,
      tools: [],
    };
    repoint(steps, st.id, builder.id);
    steps.splice(steps.indexOf(st), 0, builder);
    st.inputs = [out];
  }
}

// Whether what reaches this step can come up empty: on the way back to
// the start, before any decision that already picked this way, a step reads
// rows or results (a sheet, a search, its memory) or goes through a list.
export function mayBeEmpty(steps: RawStep[], id: string): boolean {
  const seen = new Set<string>();
  for (let at = into(steps, id); at.length; at = at.flatMap((x) => into(steps, x.id))) {
    for (const st of at) {
      if (seen.has(st.id)) continue;
      seen.add(st.id);
      if (st.kind === "loop" || (st.kind === "decision" && st.each)) return true;
      if (st.kind === "code" && (st.tools ?? []).some((t) => t !== "web.fetch" && (OUTSIDE_TOOLS as readonly string[]).includes(t))) return true;
    }
    at = at.filter((x) => x.kind !== "decision" || x.each);
    if (seen.size > steps.length) break;
  }
  return false;
}

// Steps taken out, and whatever led to the first of them leading on to
// where they would have gone.
function cut(steps: RawStep[], ids: string[], to: string | null): void {
  const gone = new Set(ids);
  for (const id of ids) repoint(steps, id, to);
  for (let i = steps.length - 1; i >= 0; i--) if (gone.has(steps[i]!.id)) steps.splice(i, 1);
}

// The tool of the action a step takes, if it takes one.
const toolOf = (st: RawStep | undefined, setup: Setup): string => (st?.kind === "action" ? String(setup.actions.find((a) => a.id === st.action)?.tool ?? "") : "");

// The first thing done from here on: the tool of the first action reached
// by following the steps (code steps on the way), or "" when the run ends.
function firstDone(steps: RawStep[], from: string | null | undefined, setup: Setup): string {
  const byId = new Map(steps.map((x) => [x.id, x]));
  const seen = new Set<string>();
  for (let at = from ? byId.get(from) : undefined; at && !seen.has(at.id); at = at.next ? byId.get(at.next) : undefined) {
    seen.add(at.id);
    if (at.kind === "action") return toolOf(at, setup);
    if (at.kind !== "code") return "";
  }
  return "";
}

const YES_WAY = /^(?:y|yes|ok|okay|approved?|confirm(?:ed)?|agreed?|accept(?:ed)?|go ahead)$/i;

// A question to the owner and the step that goes by their answer, with the
// code that writes it: what the yes leads to, and the steps to take out.
function questions(steps: RawStep[], setup: Setup): { ids: string[]; yes: string | null; head: string }[] {
  const out: { ids: string[]; yes: string | null; head: string }[] = [];
  for (const ask of steps) {
    if (toolOf(ask, setup) !== "telegram.ask" || !ask.outputs[0]) continue;
    const answer = ask.outputs[0];
    const decision = steps.find((x) => x.kind === "decision" && x.inputs.includes(answer) && (x.from === answer || ask.next === x.id));
    if (!decision || ask.next !== decision.id) continue;
    // Only a plain yes or no: a question whose answers lead different ways
    // is the maker's job, not an approval.
    const ways = decision.outcomes ?? [];
    const yes = ways.find((o) => YES_WAY.test(o.id.replace(/_/g, " ")) || YES_WAY.test(o.label));
    if (!yes || ways.some((o) => o !== yes && o.next !== null && o.next !== yes.next)) continue;
    // The answer is read nowhere else.
    if (steps.some((x) => x !== decision && x.inputs.includes(answer))) continue;
    const ids = [ask.id, decision.id];
    let head = ask.id;
    const writer = steps.find((x) => x.kind === "code" && x.next === ask.id && x.outputs.length > 0 && x.outputs.every((o) => ask.inputs.includes(o) && !steps.some((y) => y !== ask && y.inputs.includes(o))));
    if (writer) {
      ids.unshift(writer.id);
      head = writer.id;
    }
    out.push({ ids, yes: yes.next, head });
  }
  return out;
}

// A question of the plan's own in front of a payment goes: the payment asks
// by itself. One in front of a message to the owner or a write to their
// own sheet goes too when the maker never asked to be asked.
export function dropUnaskedQuestions(steps: RawStep[], setup: Setup, askedFirst: boolean): void {
  for (const q of questions(steps, setup)) {
    const then = firstDone(steps, q.yes, setup);
    const own = ["telegram.send", "sheets.write", "sheets.update"].includes(then);
    if (then === "wallet.pay" || (own && !askedFirst)) cut(steps, q.ids, q.yes);
  }
  // A question no way of the run waits on, right before a payment, asks
  // twice with the payment's own: it goes, with the code that writes it.
  for (const ask of [...steps]) {
    if (toolOf(ask, setup) !== "telegram.ask" || firstDone(steps, ask.next, setup) !== "wallet.pay") continue;
    const answer = ask.outputs[0];
    if (answer && steps.some((x) => x.kind === "decision" && x.inputs.includes(answer))) continue;
    const writer = steps.find((x) => x.kind === "code" && x.next === ask.id && x.outputs.length > 0 && x.outputs.every((o) => ask.inputs.includes(o) && !steps.some((y) => y !== ask && y.inputs.includes(o))));
    cut(steps, [...(writer ? [writer.id] : []), ask.id], ask.next ?? null);
    if (answer) for (const st of steps) st.inputs = st.inputs.filter((i) => i !== answer);
  }
}

// An allowance or balance check, or an approval, of the plan's own in front
// of a payment goes: the payment checks the allowance and asks the owner by
// itself. The check is a decision on the allowance or on the owner's
// approval, judged with no question asked (and the code that only feeds
// it), whose way on goes to the payment; or code that checks the
// allowance with nothing to check it with.
const ALLOWANCE = /\b(?:allowance|balance|enough (?:usdc|funds|money)|funds?)\b/i;
const APPROVAL = /\bapprov|\bpermission|\bconsent|\bconfirm|\bowner (?:says|said|agrees?|allows?)\b/i;
export function dropAllowanceChecks(steps: RawStep[], setup: Setup): void {
  const gone = new Set<string>();
  for (const d of [...steps]) {
    if (d.kind !== "decision" || d.from || d.each) continue;
    const words = `${d.title} ${d.prompt ?? ""}`;
    if (!ALLOWANCE.test(words) && !APPROVAL.test(words)) continue;
    const on = (d.outcomes ?? []).find((o) => firstDone(steps, o.next, setup) === "wallet.pay");
    if (!on || (d.outcomes ?? []).some((o) => o !== on && o.next !== null)) continue;
    const feeders = steps.filter((x) => x.kind === "code" && x.next === d.id && ALLOWANCE.test(`${x.title} ${x.description ?? ""}`) && x.outputs.every((o) => !steps.some((y) => y !== d && y.inputs.includes(o))));
    for (const x of [...feeders, d]) for (const o of x.outputs) gone.add(o);
    cut(steps, [...feeders.map((x) => x.id), d.id], on.next);
  }
  // Code that checks the allowance on its own, right before a payment.
  for (const c of [...steps]) {
    if (c.kind !== "code" || !ALLOWANCE.test(c.title) || (c.tools ?? []).some((t) => t !== "memory.get") || firstDone(steps, c.next, setup) !== "wallet.pay") continue;
    if (c.outputs.some((o) => steps.some((y) => y !== c && y.inputs.includes(o) && y.kind !== "code"))) continue;
    for (const o of c.outputs) gone.add(o);
    cut(steps, [c.id], c.next ?? null);
  }
  // What the steps taken out made is read by nothing now.
  for (const st of steps) st.inputs = st.inputs.filter((i) => !gone.has(i));
}

// A value a step reads that no step makes and no setting, rule or memory
// key holds, named like something the maker gives (a list of requirements),
// is a setting the maker answers at Connect: SERV read it but forgot to ask
// for it.
export function askForMissing(steps: RawStep[], setup: { settings: { key: string }[]; rules: { key: string }[]; memory: { key: string }[] }): { key: string; label: string; type: "list" | "text"; help: string }[] {
  const made = new Set([...BAGS, ...steps.flatMap((x) => x.outputs), ...steps.flatMap((x) => (x.kind === "loop" && x.item ? [x.item] : []))]);
  const keys = new Set([...setup.settings, ...setup.rules, ...setup.memory].map((x) => x.key));
  const added: { key: string; label: string; type: "list" | "text"; help: string }[] = [];
  // A word any value made shares is a slip in naming that value, not
  // something to ask for ("price" beside "current_price").
  const madeWords = new Set([...made].flatMap((m) => m.split("_")).filter((w) => w.length > 2));
  for (const st of steps) {
    for (const input of st.inputs) {
      if (made.has(input) || keys.has(input) || added.some((a) => a.key === input) || !/^[a-z][a-z0-9_]{2,39}$/.test(input)) continue;
      if (input.split("_").some((w) => madeWords.has(w) || madeWords.has(w.replace(/s$/, "")))) continue;
      const words = input.replace(/_/g, " ");
      added.push({ key: input, label: `Your ${words}`, type: /s$/.test(input) ? "list" : "text", help: `The ${words} it works with.` });
    }
  }
  for (const a of added) {
    for (const st of steps) {
      if (!st.inputs.includes(a.key)) continue;
      st.inputs = [...new Set(st.inputs.map((i) => (i === a.key ? "settings" : i)))];
      const word = new RegExp(`(?<![.\\w])${a.key}\\b`, "g");
      if (st.description) st.description = st.description.replace(word, `settings.${a.key}`);
      if (st.prompt) st.prompt = st.prompt.replace(word, `settings.${a.key}`);
      if (st.kind === "loop" && st.over === a.key && !st.inputs.includes("settings")) st.inputs.push("settings");
    }
  }
  return added;
}

// A column named by a setting or a rule ("Quantity column": B) is read by
// its header name instead: the setting or rule goes, and the steps that
// read it name the column.
const COLUMN = /\bcolumns?\b|_col(?:umn)?s?\b/i;
const LETTER = /^(?:column\s+)?[A-Z]{1,2}$/i;
export function columnsByName(steps: RawStep[], setup: { settings: { key: string; label?: string; given?: string }[]; rules: { key: string; label?: string; value?: string }[] }): { settings: string[]; rules: string[] } {
  const named = (x: { key: string; label?: string }) => {
    const words = (x.label ?? x.key.replace(/_/g, " ")).replace(/\b(?:which|what|the|column|columns|col|holds?|has|with|is|in|your|of)\b|[?:]/gi, " ").replace(/\s+/g, " ").trim();
    return words ? words.charAt(0).toUpperCase() + words.slice(1) : "";
  };
  const drop = { settings: [] as string[], rules: [] as string[] };
  for (const [bag, list] of [["settings", setup.settings], ["rules", setup.rules]] as const) {
    for (const x of list) {
      const value = "value" in x ? x.value : (x as { given?: string }).given;
      if (!COLUMN.test(`${x.key} ${x.label ?? ""}`) && !(value && LETTER.test(value.trim()) && COLUMN.test(x.label ?? ""))) continue;
      const name = named(x);
      if (!name) continue;
      drop[bag].push(x.key);
      const ref = new RegExp(`\\b${bag}\\.${x.key}\\b`, "g");
      for (const st of steps) {
        if (st.description) st.description = st.description.replace(ref, `the "${name}" column`);
        if (st.prompt) st.prompt = st.prompt.replace(ref, `the "${name}" column`);
      }
    }
  }
  return drop;
}

// Setup questions it never asks: a Telegram chat id, a token, a key or a
// password (Telegram is the owner's own, linked at Connect); and a sheet
// asked for as a link is a sheet, picked at Connect.
const NEVER_ASKED = /\bchat[ _-]?id\b|chat_id|telegram|\btoken\b|api[ _-]?key|password|secret/i;
const SHEETISH = /\bsheets?\b|spreadsheet|sheet_|_sheet/i;
const TAB = /\btab\b|\bworksheet\b/i;
export function fixSetup(settings: { key: string; label?: string; type: unknown }[]): { key: string; label?: string; type: unknown }[] {
  const kept = settings.filter((s) => !NEVER_ASKED.test(`${s.key} ${s.label ?? ""}`));
  // A sheet asked for by its link, its id or its name is picked.
  for (const s of kept) if ((s.type === "url" || s.type === "text") && (SHEETISH.test(`${s.key} ${s.label ?? ""}`) || TAB.test(s.label ?? "")) && !COLUMN.test(`${s.key} ${s.label ?? ""}`)) s.type = "sheet";
  return kept;
}

// askedFirst: the maker asked to be asked before it acts. Unknown counts as
// not asked: a message to the owner's own Telegram, or a write to their
// own sheet, goes without asking unless they said to ask (a payment always
// asks, by itself).
export function repairPlan(steps: RawStep[], setup: Setup, o: { askedFirst?: boolean } = {}): void {
  dropSingleLoops(steps, setup);
  decideByValue(steps, setup);
  dropUnaskedQuestions(steps, setup, o.askedFirst ?? false);
  dropAllowanceChecks(steps, setup);
  buildArguments(steps, setup);
}

// Whether the maker asked to be asked before it acts, in their own words
// ("ask me first", "only if I say yes"; "it never needs to ask me" isn't),
// or in what the interview kept they must be asked about. Without anything
// they said, it counts as not asked: asking first is off by default for
// what an agent sends its own owner.
const ASKS = /\bask(?:s|ing)? me\b|\bcheck with me\b|\bconfirm with me\b|\bmy (?:ok|okay|yes|approval|permission|go-?ahead)\b|\bif I say yes\b|\bwithout asking\b|\bbefore (?:it |you )?(?:sends?|pays?|writes?)\b/i;
const NEVER = /\b(?:never|don't|do not|doesn't|does not|no need to|without needing to|won't)\b[^.]*\bask/i;
const NOTHING = /^(?:nothing|none|no|never|n\/a|nothing at all)\b|\bnever (?:needs to )?asks?\b|\bno need\b/i;
export function askedFirst(said: string[], asks?: string | null): boolean {
  if (asks?.trim() && !NOTHING.test(asks.trim())) return true;
  return said.some((m) => m.split(/(?<=[.!?])\s+/).some((sentence) => ASKS.test(sentence) && !NEVER.test(sentence)));
}

// A step whose job is a judgement or words only a model can give (a score
// with its reasons, a reply, a line for the day: planRules.ts) asks SERV
// for them at run time with serv.reason, and the run has room to pay for
// that: a plan that says it never spends on models gets the floor.
export const REASONING_SPEND_FLOOR_USD = 0.1;
const REASON_NOTE = " It asks SERV for this with tools.serv.reason (what to judge or write, the values, the fields it answers) and uses SERV's answer, never a rule of thumb or a canned line.";
export function askServToReason(steps: RawStep[], plan: { limits?: unknown }): void {
  let reasons = false;
  for (const st of steps) {
    if (st.kind !== "code") continue;
    const tools = Array.isArray(st.tools) ? st.tools : [];
    if (tools.includes(REASON_TOOL)) {
      reasons = true;
      continue;
    }
    const description = typeof st.description === "string" ? st.description : "";
    if (!needsReasoning({ ...(st as unknown as CodeStepDef), kind: "code", description, title: st.title ?? st.id, tools: [] })) continue;
    st.tools = [...tools, REASON_TOOL];
    st.description = `${description.trim().slice(0, 800 - REASON_NOTE.length)}${REASON_NOTE}`;
    reasons = true;
  }
  const limits = plan.limits && typeof plan.limits === "object" ? (plan.limits as { maxSpendUsd?: unknown }) : null;
  if (reasons && limits && !(Number(limits.maxSpendUsd) >= REASONING_SPEND_FLOOR_USD)) limits.maxSpendUsd = REASONING_SPEND_FLOOR_USD;
}

// An agent that writes results back into the rows it read (sheets.update)
// needs each row's number on what it reads: the step that reads the sheet
// keeps _row on every item, in its brief and its shape. Without it nothing
// after can say which row to write to.
const ROW_FIELD = /^(?:_?row|row_?(?:number|id|index))$/i;
const KEEPS_ROW = " Keep each row's _row (its number in the sheet) on every item, so its results can be written back into that row.";
export function keepRowNumbers(steps: RawStep[], setup: Pick<Setup, "actions">): void {
  if (!setup.actions.some((a) => a.tool === "sheets.update")) return;
  for (const st of steps) {
    if (st.kind !== "code" || !(st.tools ?? []).includes("sheets.read")) continue;
    const shapes = (st as RawStep & { shapes?: Record<string, string> }).shapes;
    let changed = false;
    for (const [out, text] of Object.entries(shapes ?? {})) {
      const shape = parseShape(text);
      if (shape.t !== "list" || shape.of.t !== "object" || shape.of.open || Object.keys(shape.of.fields).some((f) => ROW_FIELD.test(f))) continue;
      shapes![out] = showShape({ t: "list", of: { ...shape.of, fields: { _row: { t: "number" }, ...shape.of.fields } } });
      changed = true;
    }
    const description = st.description ?? "";
    if ((changed || !/\b_?row\b/i.test(description)) && !description.includes(KEEPS_ROW.trim())) st.description = `${description.trim().slice(0, 800 - KEEPS_ROW.length)}${KEEPS_ROW}`;
  }
}

// Sheets it works on with no sheet the renter gives: a sheet setting of
// its own, and the steps that use sheets told to pass it. A tab's name
// written into the code reaches nothing when it runs for real (only the
// tabs a renter picks at setup are its own).
const SHEET_TOOLS = ["sheets.read", "sheets.write", "sheets.update"];
export function askForSheet(steps: RawStep[], settings: { key: string; type: unknown }[], actions: { id: string; tool: unknown }[]): { key: string; label: string; type: "sheet"; help: string; choices: string[] } | null {
  const sheetActions = new Set(actions.filter((a) => SHEET_TOOLS.includes(String(a.tool))).map((a) => a.id));
  const users = steps.filter((st) => (st.kind === "code" && (st.tools ?? []).some((t) => SHEET_TOOLS.includes(t))) || (st.kind === "action" && sheetActions.has(st.action ?? "")));
  if (!users.length || settings.some((x) => x.type === "sheet")) return null;
  const key = settings.some((x) => x.key === "sheet") ? "your_sheet" : "sheet";
  for (const st of users) {
    if (st.kind !== "code") continue;
    if (!st.inputs.includes("settings")) st.inputs = [...st.inputs, "settings"];
    const note = ` The sheet is settings.${key}: pass it as sheet to every sheet tool.`;
    if (!(st.description ?? "").includes(`settings.${key}`)) st.description = `${(st.description ?? "").trim().slice(0, 800 - note.length)}${note}`;
  }
  return { key, label: "Your sheet", type: "sheet", help: "The sheet and tab it works on.", choices: [] };
}

// A Typeform form it reads with no link the maker gives: a url setting of
// its own (filled in with the link the maker said, when they said one),
// and the steps that read the form told to pass it. The token reads any
// of the owner's forms: only the link says which.
export function askForForm(steps: RawStep[], settings: { key: string; label: string; type: unknown; given: string }[], link?: string | null): { key: string; label: string; type: "url"; help: string; choices: string[]; given: string } | null {
  const users = steps.filter((st) => st.kind === "code" && (st.tools ?? []).includes("typeform.read"));
  if (!users.length) return null;
  const own = settings.find((x) => (x.type === "url" || x.type === "text") && (/typeform\.com/i.test(x.given) || /\b(?:type)?form\b/i.test(`${x.key.replace(/_/g, " ")} ${x.label}`)));
  const key = own?.key ?? (settings.some((x) => x.key === "form_link") ? "typeform_link" : "form_link");
  for (const st of users) {
    if (!st.inputs.includes("settings")) st.inputs = [...st.inputs, "settings"];
    const note = ` The form is settings.${key}: pass it as typeform.read's form.`;
    if (!(st.description ?? "").includes(`settings.${key}`)) st.description = `${(st.description ?? "").trim().slice(0, 800 - note.length)}${note}`;
  }
  return own ? null : { key, label: "Your Typeform form's link", type: "url", help: "The form people fill in: its link, from Share in Typeform.", choices: [], given: link ?? "" };
}

// The same action taken in two places that go on the same way (a message
// for when the code passed and another for when it failed, each sent by a
// step of its own) is one step that takes it: each way's code makes what
// it sends under one name, and both lead to that one step. A job sends or
// writes a thing once, whichever way it went.
export function mergeSameActions(steps: RawStep[]): void {
  for (let merged = true; merged; ) {
    merged = false;
    const actions = steps.filter((s) => s.kind === "action");
    for (const [i, a] of actions.entries()) {
      const b = actions.slice(i + 1).find((x) => x.action === a.action && (x.next ?? null) === (a.next ?? null) && (x.otherwise ?? null) === (a.otherwise ?? null) && sameLevel(steps, a.id, x.id));
      const [made, other] = [a.inputs[0], b?.inputs[0]];
      if (!b || !made || !other) continue;
      const [ma, mb] = [into(steps, a.id), into(steps, b.id)];
      if (ma.length !== 1 || mb.length !== 1 || ma[0]!.kind !== "code" || mb[0]!.kind !== "code" || !ma[0]!.outputs.includes(made) || !mb[0]!.outputs.includes(other)) continue;
      // What the second sends is its own, read by nothing else.
      if (other !== made && steps.some((s) => s !== b && s.inputs.includes(other))) continue;
      const m = mb[0]! as RawStep & { shapes?: Record<string, string> };
      m.outputs = m.outputs.map((o) => (o === other ? made : o));
      if (m.description) m.description = m.description.replace(new RegExp(`\\b${other}\\b`, "g"), made);
      if (m.shapes && m.shapes[other] !== undefined) m.shapes = Object.fromEntries(Object.entries(m.shapes).map(([k, v]) => [k === other ? made : k, v]));
      repoint(steps, b.id, a.id);
      steps.splice(steps.indexOf(b), 1);
      merged = true;
      break;
    }
  }
}

// What the maker asked to be kept: a log, a record, a sheet, a table.
const KEEPS = /\b(?:sheets?|spreadsheets?|logs?|logged|logging|records?|recording|track(?:s|ing)?|tables?|rows?|columns?|airtable|notion|history|ledger|tally|tallies)\b/i;
// What the maker asked to be remembered between runs.
const REMEMBERS = /\b(?:remember|remembers|keep track|where it (?:left off|got to)|only new|new ones|since (?:the )?last|already (?:checked|seen|sent)|not (?:again|twice)|each (?:one )?once)\b/i;

// Steps the maker never asked for, taken out with what feeds them: a log
// sheet (written to, never read) when they named no sheet, log or record,
// and memory
// nothing reads (a counter, a list of what it did) when they asked it to
// remember nothing. A job does what it was asked, and that's all.
export function dropUnasked(steps: RawStep[], setup: Setup & { memory?: { key: string }[] }, said: string): { actions: string[]; memory: boolean } {
  const dropped: string[] = [];
  const toolOfAction = (id: string | undefined) => String(setup.actions.find((a) => a.id === id)?.tool ?? "");
  const take = (st: RawStep) => {
    const feeds = into(steps, st.id).filter((x) => x.kind === "code" && x.outputs.length && x.outputs.every((o) => st.inputs.includes(o) && !steps.some((s) => s !== st && s.inputs.includes(o))) && !(x.tools ?? []).some((t) => t !== "memory.get" && t !== "serv.reason"));
    cut(steps, [...feeds.map((f) => f.id), st.id], st.next ?? null);
    dropped.push(String(st.action));
  };
  // A sheet it works on (reads) is its job; one it only writes to is a log.
  const worksOnSheet = steps.some((s) => (s.tools ?? []).includes("sheets.read"));
  if (!KEEPS.test(said) && !worksOnSheet) for (const st of steps.filter((s) => s.kind === "action" && ["sheets.write", "sheets.update"].includes(toolOfAction(s.action)))) take(st);
  // Memory nothing reads is kept for nothing.
  const reads = steps.some((s) => s.inputs.includes("memory") || (s.tools ?? []).includes("memory.get"));
  const memory = !reads && !REMEMBERS.test(said) && Boolean(setup.memory?.length || steps.some((s) => (s.tools ?? []).includes("memory.set")));
  if (memory) {
    for (const st of steps.filter((s) => s.kind === "action" && toolOfAction(s.action) === "memory.set")) take(st);
    for (const st of steps) if (st.tools) st.tools = st.tools.filter((t) => t !== "memory.set");
  }
  return { actions: dropped, memory };
}

// A step that fetches a service of the catalog with web.fetch (its API's
// address, or "from CoinGecko" in its words) reads it with the service's own
// tool instead: its typed read when it has one (coingecko.read), else
// service.request through it. Returns the services it now reaches
// generically, for the plan's services.
export function toCatalogTools(steps: RawStep[]): string[] {
  const reached: string[] = [];
  for (const st of steps) {
    if (st.kind !== "code" || !(st.tools ?? []).includes("web.fetch")) continue;
    const e = catalogFetched(`${st.title} ${st.description ?? ""}`);
    if (!e) continue;
    const tool = e.tools[0] ?? "service.request";
    st.tools = [...new Set((st.tools ?? []).map((t) => (t === "web.fetch" ? tool : t)))];
    st.description = `${st.description ?? ""} Read ${e.name} with ${tool}${tool === "service.request" ? ` (connection "${e.id}")` : ""}, its tool here, never by fetching its address with web.fetch.`.trim();
    if (tool === "service.request") reached.push(e.id);
  }
  return [...new Set(reached)];
}

// The service of the catalog some words fetch, by its API's address, or
// as "<name> API" or "from <name>".
export function catalogFetched(words: string): ServiceEntry | null {
  const w = words.toLowerCase();
  return (
    CATALOG.find(
      (x) =>
        x.auth !== "chat" &&
        x.auth !== "oauth" &&
        !x.hosts.includes("*") &&
        x.id !== "webhook" &&
        (x.hosts.some((h) => !h.includes("{") && w.includes(h)) || new RegExp(`\\b(?:from|via|using|on) ${escapeRe(x.name)}\\b|\\b${escapeRe(x.name)}(?:'s)? api\\b`, "i").test(words)),
    ) ?? null
  );
}

const escapeRe = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Reading only what is new from a feed (a repository's commits, pull
// requests or issues): on its first run the latest few from the last day,
// after that what came after a date it remembers, a few a run, and that
// date saved right after each item is judged, so a run that stops part way
// (its budget, its owner) never judges an item twice. A place kept as an
// id (a commit's sha) becomes the item's date: GitHub's since takes a
// date. The runtime keeps a job's feed reads to the same few (tools.ts).
export const NEW_PER_RUN = 5;
const FEEDS = ["github.read"];
const ID_KEY = /(?:^|_)(?:sha|id|hash)$|[a-z0-9](?:Sha|Id|Hash)$/;
const DATE_SAID = /\b(?:date|time|timestamp|iso)\b/i;
export const DATE_CURSOR = "The date (ISO 8601) of the newest item it has judged, so the next run reads only what came after it.";
// The reading step takes what github.read gives: the runtime gives only
// the new items and keeps the place (runtime/tools.ts), so the code has no
// date filter, limit or save of its own to get wrong.
export const firstRunNote = (key: string) =>
  `github.read gives only the new items, ${NEW_PER_RUN} at most (with memory.${key} empty, the latest from the last 24 hours; after that what came after it), and keeps memory.${key} itself: take what it gives, with no date filter, limit or memory.set of its own.`;
export const EACH_ITEM_MARK = "one serv.reason call for each item";
export const eachItemNote = () => `It goes through the items one at a time, oldest first (GitHub lists the newest first), ${EACH_ITEM_MARK}.`;
// A repository's items are judged on their changes, not their titles.
export const DIFFS_MARK = "reads its changed files with github.read";
export const diffsNote = () => `For each item it ${DIFFS_MARK} (op "commit" with the sha, or op "pull" with the number; the repository from settings) and gives them to serv.reason.`;

// A note of the platform's added to a step's words, within a description's
// room: SERV's own words give way at a sentence's end when both won't fit.
const DESCRIPTION_MAX = 1400;
function noted(text: string | undefined, note: string): string {
  const base = (text ?? "").trim();
  if (base.length + note.length + 1 <= DESCRIPTION_MAX) return `${base} ${note}`.trim();
  const room = DESCRIPTION_MAX - note.length - 1;
  const cut = base.slice(0, room);
  const end = cut.lastIndexOf(". ");
  return `${end > room / 2 ? cut.slice(0, end + 1) : cut.trimEnd()} ${note}`;
}

export function keepPlaceByDate<M extends { key: string; type?: unknown; description?: string }>(steps: RawStep[], memory: M[]): M[] {
  const feed = steps.find((s) => s.kind === "code" && (s.tools ?? []).some((t) => FEEDS.includes(t)));
  // Items read from a feed and judged, with no place kept: one is kept, a
  // date, so the next run reads only what came after.
  const judges = (r: RawStep) => steps.some((st) => st.kind === "code" && (st.tools ?? []).includes(REASON_TOOL) && st.inputs.some((k) => r.outputs.includes(k)));
  if (feed && !memory.length && judges(feed)) {
    memory = [{ key: "last_item_date", type: "text", description: DATE_CURSOR } as unknown as M];
    feed.inputs = [...feed.inputs.filter((k) => k !== "memory"), "memory"];
  }
  // The step that reads the feed keeps the place itself, reading it from
  // memory even when the plan had a step of its own look it up first.
  const reading = steps.find((s) => s.kind === "code" && (s.tools ?? []).some((t) => FEEDS.includes(t)) && s.inputs.includes("memory")) ?? (memory.length ? feed : undefined);
  if (!reading || !memory.length) return memory;
  if (!reading.inputs.includes("memory")) reading.inputs = [...reading.inputs, "memory"];
  const lookups = steps.filter((st) => st !== reading && st.outputs.some((o) => reading.inputs.includes(o)) && ((st.tools ?? []).includes("memory.get") || st.inputs.includes("memory")));
  const said = [reading, ...lookups].map((st) => `${st.description ?? ""} ${st.title}`).join(" ");
  const field = memory.find((m) => said.includes(`memory.${m.key}`)) ?? memory.find((m) => new RegExp(`\\b${escapeRe(m.key)}\\b`).test(said)) ?? (memory.length === 1 ? memory[0] : undefined);
  if (!field) return memory;
  let key = field.key;
  // A sha or an id kept as its place: the item's date instead, everywhere.
  if (ID_KEY.test(key) || (!DATE_SAID.test(field.description ?? "") && /\b(?:sha|hash|id)\b/i.test(field.description ?? ""))) {
    const renamed = key.replace(/_?(?:sha|id|hash)$/i, "").replace(/(?:Sha|Id|Hash)$/, "");
    const next = renamed ? `${renamed}_date` : "last_item_date";
    const old = new RegExp(`\\b${escapeRe(key)}\\b`, "g");
    for (const st of steps) {
      const s = st as unknown as Record<string, unknown>;
      for (const f of ["description", "title", "prompt", "plain"]) if (typeof s[f] === "string") s[f] = (s[f] as string).replace(old, next);
      for (const f of ["inputs", "outputs"] as const) st[f] = st[f].map((x) => (x === key ? next : x));
    }
    key = next;
  }
  const out = memory.map((m) => (m === field ? { ...m, key, type: "text", description: DATE_SAID.test(m.description ?? "") && m.key === key ? m.description : DATE_CURSOR } : m));
  if (!(reading.description ?? "").includes(`and keeps memory.${key} itself`)) reading.description = noted(reading.description, firstRunNote(key));
  // What saves its place says it saves a date.
  for (const st of steps) {
    if (st === reading || st.kind !== "code" || !(st.tools ?? []).includes("memory.set")) continue;
    if (!(st.description ?? "").includes(EACH_ITEM_MARK) && !/never its sha or id/.test(st.description ?? "")) st.description = noted(st.description, `What it saves in memory.${key} is the newest item's date (ISO 8601), never its sha or id.`);
  }
  // The step that judges what was read: one item at a time, its place
  // saved after each. Only for a list of items: a reading step that sums
  // them up (a repository's metrics) has none to go through.
  const shapes = (reading as unknown as { shapes?: Record<string, unknown> }).shapes ?? {};
  const items = reading.outputs.filter((k) => typeof shapes[k] !== "string" || /\[\]\s*$/.test(String(shapes[k]).trim()));
  for (const st of steps) {
    if (st.kind !== "code" || !(st.tools ?? []).includes(REASON_TOOL) || !st.inputs.some((k) => items.includes(k))) continue;
    if (!(st.description ?? "").includes(EACH_ITEM_MARK)) st.description = noted(st.description, eachItemNote());
    // Its items' changes, read one at a time: what it judges (unless the
    // reading step reads them already).
    if ((reading.tools ?? []).includes("github.read") && !/changed files|patch|\bdiffs?\b|op\s*[:=]?\s*["']?commit["']?(?!s)|op\s*[:=]?\s*["']?pull["']?(?!s)/i.test(reading.description ?? "")) {
      if (!(st.description ?? "").includes(DIFFS_MARK)) st.description = noted(st.description, diffsNote());
      if (!(st.tools ?? []).includes("github.read")) st.tools = [...(st.tools ?? []), "github.read"];
      if (!st.inputs.includes("settings")) st.inputs = [...st.inputs, "settings"];
    }
  }
  return out;
}

// Settings no one gave. A rule's value (a limit with a default) must come
// from the maker: their words, or an answer they picked from the chat's
// questions (Describe's notes carry those). A rule they never said goes:
// a check of its own (on or off: a complexity check) with the sentences
// of the steps that use it; a limit the steps work by (a maximum of 5
// violations) becomes a question the setup asks, with no answer made up;
// one nothing uses, just goes. So does a rule or setting the agent can't
// measure from what it reads (test coverage from a diff needs the tests
// run), whoever said it. An answer given in the chat that names no value
// ("A specific repository", "I'll give it at setup") is no answer: the
// setup asks it.
const UNMEASURABLE = /\b(?:(?:test|code) coverage|coverage (?:percent(?:age)?|threshold|minimum)|minimum coverage|page (?:load|speed)|load time|latency|uptime|memory usage|cpu usage|benchmark)/i;
export const PLACEHOLDER_ANSWER = /\bat setup\b|\bwhen i set it up\b|\bi'?ll (?:give|define|provide|pick|choose|name|tell|set|add)\b|\bi will (?:give|define|provide|pick|choose|name|tell|set|add)\b|^(?:a|one|some) (?:specific|particular|certain)\b|^custom\b|^(?:all|any) (?:my|of my)\b|^not sure\b|^later\b/i;
const STOP = new Set(["check", "checks", "number", "minimum", "maximum", "before", "after", "flagging", "include", "whether", "value", "limit", "threshold", "percentage", "percent", "count", "should", "would", "which", "their", "about"]);
const words = (t: string) => (t.toLowerCase().match(/[a-z][a-z0-9]{3,}/g) ?? []).filter((w) => !STOP.has(w));
const flat = (t: string) => ` ${t.toLowerCase().replace(/https?:\/\/(?:www\.)?github\.com\//g, "").replace(/[^a-z0-9.%$/-]+/g, " ")} `;

export function dropMadeUp(plan: { settings?: unknown; rules?: unknown; steps?: unknown; actions?: unknown }, owner: string): { dropped: string[]; asked: string[] } {
  const said = flat(owner);
  const rules = Array.isArray(plan.rules) ? (plan.rules as Record<string, unknown>[]) : [];
  const settings = Array.isArray(plan.settings) ? (plan.settings as Record<string, unknown>[]) : [];
  const actions = Array.isArray(plan.actions) ? (plan.actions as Record<string, unknown>[]) : [];
  const steps = Array.isArray(plan.steps) ? (plan.steps as RawStep[]) : [];
  const text = (x: Record<string, unknown>) => `${String(x.key ?? "")} ${String(x.label ?? "")} ${String(x.help ?? "")}`.replace(/_/g, " ");
  // A spending limit the actions ask by stays: the runtime asks over it.
  const spending = new Set(actions.flatMap((a) => [a.askOver, a.askOverDay]).filter((k): k is string => typeof k === "string" && Boolean(k)));
  const given = (r: Record<string, unknown>): boolean => {
    const v = String(r.value ?? "").trim();
    const named = words(String(r.label ?? "")).some((w) => said.includes(` ${w}`));
    if (r.type === "boolean") return named;
    if (!v) return true;
    if (r.type === "number" || r.type === "usdc") return new RegExp(`(?:^|[^0-9.])${escapeRe(v.replace(/\.0+$/, ""))}(?:\\.0+)?(?![0-9])`).test(said);
    return said.includes(v.toLowerCase());
  };
  const stepText = (st: RawStep) => `${st.description ?? ""} ${st.prompt ?? ""}`;
  const named = (key: string) => steps.some((st) => new RegExp(`\\b${escapeRe(key)}\\b`).test(stepText(st)));
  const dropped: Record<string, unknown>[] = [];
  const asked: Record<string, unknown>[] = [];
  for (const r of rules) {
    if (spending.has(String(r.key))) continue;
    if (UNMEASURABLE.test(text(r)) || (!given(r) && (r.type === "boolean" || !named(String(r.key))))) dropped.push(r);
    else if (!given(r)) asked.push(r);
  }
  const unmeasured = settings.filter((st) => UNMEASURABLE.test(text(st)) && !steps.some((x) => x.kind === "loop" && x.over === st.key));
  if (dropped.length || asked.length) plan.rules = rules.filter((r) => !dropped.includes(r) && !asked.includes(r));
  // A limit the steps work by, that no one gave: asked at setup instead.
  if (asked.length || unmeasured.length) {
    plan.settings = [
      ...settings.filter((st) => !unmeasured.includes(st)),
      ...asked.map((r) => ({ key: r.key, label: r.label, type: r.type === "usdc" ? "number" : r.type, help: r.help ?? "", choices: [] })),
    ];
    for (const st of steps) {
      for (const r of asked) {
        const k = escapeRe(String(r.key));
        for (const f of ["description", "prompt"] as const) if (typeof st[f] === "string") st[f] = (st[f] as string).replace(new RegExp(`\\brules\\.${k}\\b`, "g"), `settings.${String(r.key)}`);
        if (new RegExp(`\\b${k}\\b`).test(stepText(st)) && !st.inputs.includes("settings")) st.inputs = [...st.inputs, "settings"];
      }
    }
  }
  // The steps' sentences that use what went go with it.
  const gone = [...dropped, ...unmeasured];
  if (gone.length) {
    const uses = (sentence: string) => gone.some((x) => new RegExp(`\\b${escapeRe(String(x.key))}\\b`, "i").test(sentence) || (typeof x.label === "string" && x.label.length > 6 && sentence.toLowerCase().includes(x.label.toLowerCase())));
    const strip = (t: string) => {
      const kept = t.split(/(?<=[.!?])\s+/).filter((sentence) => !uses(sentence));
      return kept.length ? kept.join(" ") : t;
    };
    for (const st of steps) {
      if (typeof st.description === "string") st.description = strip(st.description);
      if (typeof st.prompt === "string" && st.prompt) st.prompt = strip(st.prompt);
    }
  }
  // A metric nothing it reads can measure (a test coverage score from a
  // commit's changes) goes from what the steps return and judge, and from
  // the answers that name it.
  for (const st of steps) {
    for (const f of ["description", "prompt"] as const) if (typeof st[f] === "string") st[f] = withoutUnmeasured(st[f] as string);
    const shaped = st as unknown as { shapes?: Record<string, string> };
    if (shaped.shapes) shaped.shapes = Object.fromEntries(Object.entries(shaped.shapes).map(([k, v]) => [k, typeof v === "string" ? v.replace(/\s*[a-z_]*coverage[a-z_]*\s*:\s*[^,}]+,?/gi, "").replace(/,\s*}/g, " }") : v]));
  }
  for (const st of settings) {
    if (typeof st.given === "string" && st.given) st.given = withoutUnmeasured(st.given);
    if (typeof st.help === "string" && st.help) st.help = withoutUnmeasured(st.help);
  }
  // An answer that names no value is no answer.
  for (const st of settings) if (typeof st.given === "string" && st.given && PLACEHOLDER_ANSWER.test(st.given.trim())) st.given = "";
  return { dropped: [...dropped, ...unmeasured].map((x) => String(x.key)), asked: asked.map((r) => String(r.key)) };
}

// Words with a metric nothing it reads can measure taken out: "a score for
// maintainability and test coverage" reads "a score for maintainability".
const COVERAGE = "(?:(?:unit |integration )?test|code)[ _]coverage(?:[ _](?:score|percent(?:age)?|ratio|level))?[a-z_]*(?:\\s*\\([^)]*\\))?";
export function withoutUnmeasured(text: string): string {
  return text
    .replace(new RegExp(`,\\s*(?:and\\s+)?${COVERAGE}`, "gi"), "")
    .replace(new RegExp(`\\s+(?:and|or)\\s+${COVERAGE}`, "gi"), "")
    .replace(new RegExp(`${COVERAGE}\\s*(?:,\\s*|\\s+(?:and|or)\\s+)`, "gi"), "")
    .replace(/\(\s*e\.g\.,?\s*\)/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}
