import { loopChain, loopsOf, REASON_TOOL, type CodeStepDef } from "./definition";
import { needsReasoning } from "./planRules";

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
      if (st.kind === "code" && (st.tools ?? []).some((t) => t === "sheets.read" || t === "web.search" || t === "memory.get")) return true;
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

