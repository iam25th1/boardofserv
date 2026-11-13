import { ACTION_TOOLS, RULE_TYPES, SETTING_TYPES, TOOL_NAMES } from "./definition";

// The two answers SERV plans an agent in (plan.ts). SERV refuses a
// json_schema whose compiled grammar is too large, and the single schema a
// whole plan used to be answered in sat right at that limit: one more
// string field on a step was refused. So a plan is asked for in two
// stages, each schema well under the limit (measured live, see the PR that
// brought them in and src/test/plan-schema-live.test.ts):
//
// - the outline: the agent's name, job, triggers, setup questions, rules,
//   memory and actions, and its steps as names, kinds, order, loops and
//   what each is for;
// - the details of a few steps at a time: what each reads and makes, its
//   code's brief and tools, a decision's question and outcomes, an action's
//   declared action, a loop's list and what it gathers.
//
// Both are flat for SERV's strict json_schema: every field present, "" or
// [] where it doesn't apply, no unions and no numeric range keywords.

const str = (description: string) => ({ type: "string", description });
const strings = (description: string) => ({ type: "array", items: { type: "string" }, description });
const obj = (properties: Record<string, unknown>, description?: string) => ({
  type: "object",
  additionalProperties: false,
  required: Object.keys(properties),
  properties,
  ...(description ? { description } : {}),
});
const list = (item: ReturnType<typeof obj>, description: string) => ({ type: "array", items: item, description });

export const STEP_KINDS = ["code", "decision", "action", "loop"] as const;

export const OUTLINE_SCHEMA = {
  name: "agent_outline",
  schema: obj({
    name: str("short agent name"),
    job: obj({ does: str("what the agent does, one or two sentences"), done: str("what counts as done for one job") }),
    triggers: list(
      obj({
        kind: { type: "string", enum: ["schedule", "check", "message"] },
        every: { type: "string", enum: ["minutes", "day", "week", "none"], description: "schedule only" },
        at: str('schedule: a time like "08:00", or ""'),
        everyMinutes: { type: "number", description: "check, or schedule every minutes: minutes between, else 0" },
        watch: str("check: the value it watches, else empty"),
        when: str('check: when it acts; schedule every week: the days it runs, like "monday, thursday"; else empty'),
        step: str("check: the id of its own code step that reads the value and returns { holds }, else empty"),
        description: str("in plain words"),
      }),
      "what wakes it up",
    ),
    settings: list(
      obj({ key: str("snake_case"), label: str("the question"), type: { type: "string", enum: [...SETTING_TYPES] }, help: str("help text"), choices: strings("for a choice, else []"), given: str("the maker's own answer, exactly as they said it while describing the job (a page link, a target price), else empty") }),
      "what each renter answers at setup",
    ),
    rules: list(
      obj({ key: str("snake_case"), label: str("the limit"), type: { type: "string", enum: [...RULE_TYPES] }, value: str("the maker's default, as text"), help: str("help text") }),
      "limits a renter may adjust",
    ),
    memory: list(obj({ key: str("snake_case"), description: str("what it keeps"), type: { type: "string", enum: ["text", "number", "list", "record"] } }), "what it keeps between jobs"),
    actions: list(
      obj({
        id: str("snake_case"),
        tool: { type: "string", enum: [...ACTION_TOOLS] },
        description: str("what this action does"),
        askOver: str("spending only: the usdc rule over which the job's running total of spending waits for the owner's yes, else empty"),
        askOverDay: str("spending only: the usdc rule over which the day's total of spending waits for the owner's yes, else empty"),
        amountColumn: str("sheets.write only: the column holding each row's amount in USDC, when writing those rows is spending (orders), else empty"),
      }),
      "the only actions it may ever take",
    ),
    steps: list(
      obj({
        id: str("snake_case"),
        title: str("a few words"),
        kind: { type: "string", enum: [...STEP_KINDS] },
        purpose: str("what the step is for, one sentence"),
        next: str('the step after it at the same level, "" when there is none (the run ends, or a loop\'s pass ends); "" for a decision, whose outcomes say'),
        body: str('loop: the id of the first step inside it, else ""'),
      }),
      "the steps in order; a run starts at the first; a loop's steps come right after it",
    ),
    limits: obj({ maxSteps: { type: "number" }, maxRunSeconds: { type: "number" }, maxSpendUsd: { type: "number" } }),
    approvalHours: { type: "number", description: "hours the owner has to answer a question before it counts as no answer: 24 unless the maker said otherwise" },
  }),
};

export const DETAIL_SCHEMA = {
  name: "agent_steps",
  schema: obj({
    steps: list(
      obj({
        id: str("the step's id, as in the outline"),
        inputs: strings("values it reads"),
        outputs: strings("values it makes; a loop: the lists it gathers"),
        shapes: strings('for each output, in the same order, its shape: text, number, boolean, an object like { name, score: number } (a field with no type is text), or a list of one with [] after it; a loop: []'),
        description: str("code: exactly what the code must do with its inputs and what it returns, else empty"),
        tools: { type: "array", items: { type: "string", enum: [...TOOL_NAMES] }, description: "code: the tools it may call, else []" },
        prompt: str("decision: the one question it judges, else empty"),
        from: str("decision by a value: the input holding the way to go (a plain comparison a code step worked out, or the owner's answer to a question), else empty"),
        outcomes: list(obj({ id: str("snake_case"), label: str("a few words"), next: str('the step it leads to, or "" to end the pass or the run') }), "decision: 2 to 6 outcomes, else []"),
        action: str("action: a declared action id, else empty"),
        otherwise: str('action that waits for the owner (telegram.ask, or a payment over a limit): the step to go to when no answer comes in time, or "" to stop'),
        over: str("loop: the input holding the list it goes through, else empty"),
        item: str("loop: the name each item has inside the loop, else empty"),
        gather: strings("loop: for each of its outputs, in the same order, the value made inside the loop that output gathers from every pass, else []"),
      }),
      "the steps asked for, each in full",
    ),
  }),
};

const SCHEDULES = (least: number) =>
  `A schedule runs every N minutes (every "minutes", everyMinutes N, at least ${least}; every 2 hours is 120), every day at a time (every "day", at "HH:MM") or every week on some days at a time (every "week", the days in when, at "HH:MM"), in the renter's time zone. Anything that runs on a clock is a schedule: "every 15 minutes, check for new rows" is every minutes with everyMinutes 15, never a check trigger.`;

export function outlinePrompt(least: number, tools: string): string {
  return [
    "You plan an agent for boardofserv from the maker's interview. This is its outline: the agent's setup, and its steps in order with what each is for. What each step reads, makes and does exactly is asked for afterwards, step by step. Answer with JSON in the given schema.",
    "Kinds of step. code: reading and working things out in a sandbox (read sheets, fetch pages, search, count, compare, combine, and prepare what an action writes or sends). decision: one judgement by a model about one thing, with 2 to 6 outcomes. action: takes one declared action, which only changes things (sheets.write, sheets.update, telegram.send, telegram.ask, wallet.pay, memory.set); never use an action to read. loop: goes through a list one item at a time, running the steps inside it once for each item.",
    "Judgement (does this submission meet this requirement? is this enquiry worth a reply?) is a decision. Counting, comparing numbers, thresholds (fewer than half) and whether any items are left are code, never a judgement.",
    "A judgement with no fixed outcomes (a score from 1 to 10 with its reasons, a rating of quality) and words for people (a reply, feedback, a line for the day, a summary of what a page says) are made by SERV at run time: a code step that calls serv.reason for them, one call per item. Never a rule of thumb (word counts, lengths, keyword lists) or canned lines in their place. A message or summary made from the run's own results (each item's name with its score and reasons) is code that puts them together: SERV is for what the data doesn't hold yet.",
    "A plain comparison that picks the way the run goes (is the price at or below the target? is the quantity under its minimum? did the owner say yes?) is a decision by a value: the code step right before it works out which way, or the question before it gives the owner's answer, and the decision goes by that (its from, in the details). No model judges it.",
    "To judge many items, put one decision inside a loop over them: it judges one item a pass. When each item needs several judgements (each requirement of each submission), put a loop inside the loop: for each submission, for each requirement, the decision. The code that counts one item's verdicts (how many requirements it met, and so its status) comes right after the inner loop, still inside the outer loop.",
    "A loop goes through a list a step before it makes, or a setting's list (the requirements the renter gives at setup). One thing is never a loop: one product page, one target or one sheet is not a list.",
    'For example, a price watcher for one product page: settings product_url (url) and target_price (number); read_price (code: fetches the page, finds the price, and works out whether it is at or below the target), is_low (decision by that value: low, or not_low, which ends the run), make_question (code: the question), ask (action: telegram.ask), said_yes (decision by the owner\'s answer: yes, or no, which ends the run), make_reminder (code: the reminder), send (action: telegram.send).',
    "For example, a job application screener that checks each new application against each must-have skill: find_new (code: reads the sheet, returns the new applications and the skills), each_application (loop, body each_skill, next make_rows), each_skill (loop, body has_skill, next score), has_skill (decision: does this application show this skill? next \"\"), score (code: counts this application's verdicts, sets its status and reasons; next \"\"), make_rows (code: the updates for every application's row), write_rows (action: sheets.update), make_summary (code: one message naming every application and its status), send_summary (action: telegram.send).",
    'In the steps list a loop\'s own steps come right after it. Its body is the id of its first step; the steps inside follow on with next, and the last one inside has next "", which ends the pass. The loop\'s next is the step after the whole loop. Nothing inside a loop leads out of it, and nothing ever leads back to an earlier step.',
    "After a loop the run goes on with what the loop gathered from every pass (each submission's result, every verdict), never only the last pass. So the steps after a loop cover every item: one code step prepares the writes for all the rows, another the summary naming every item.",
    'To write a result into the row it belongs to ("write Status and Reasons in that row"), use sheets.update; add rows with sheets.write only for new records, never to record a result for a row that is already there. Every action that writes, updates, pays or saves has a code step right before it that makes exactly what it writes.',
    "To take only new rows, take the rows whose result column (a Status it writes) is still empty: the next run then leaves checked rows alone.",
    "A form's public link (Typeform, Google Forms, Tally, Jotform) opens the form, not its answers, and a page behind a sign-in shows the sign-in: never plan a step that reads one. A form's answers come from the sheet the form sends them to, a setting of type sheet.",
    "A sheet it reads or writes is a setting of type sheet (the renter picks the tab at setup); never ask for a sheet id, a link or a range. Columns are read by their header names (Status, Quantity, Price), never asked for at setup and never letters. Telegram messages go to the owner's own Telegram, connected at setup; never ask for a chat id.",
    "When a run can find nothing to do (no new rows, nothing low), the code step before an action leaves that action's input empty and the action is skipped: that is how a run with nothing new ends quietly, with no decision. A job that always acts (a weekly payment, a morning message) always acts: nothing is skipped.",
    "A payment (wallet.pay) pays a saved payee by name (a setting, the payee's name as the maker said it) and already checks the agent's allowance and asks the owner on Telegram before paying, unless their own auto limit covers it. Never add a step that checks the allowance, the balance or the funds, and never a question of your own before a payment, even when the maker says to ask them first: the payment asks.",
    SCHEDULES(least),
    'Use a check trigger only to run when a watched value changes. A check trigger names its own code step (step), listed with the steps but outside the run: it reads the watched value with tools that only read and returns { holds }. Its next is "" and no step leads to it.',
    `Tools a code step can call: ${tools}.`,
    "Every side effect (sheets.write, sheets.update, telegram.send, telegram.ask, wallet.pay) must be a declared action. A message or a write that the maker said it must never do without asking goes through telegram.ask first; nothing else asks first.",
    "A question to the owner (telegram.ask) waits for their answer for approvalHours. Spending is a payment (wallet.pay), or rows written to a sheet whose amountColumn holds each row's amount in USDC (orders). A spending action can name askOver, a usdc rule: the runtime asks the owner before any spending that takes the job's running total over it, and askOverDay, the same for the day's total; never add a decision or question of your own for those limits.",
    "Settings are what each renter answers at setup; rules are limits a renter may adjust, with the maker's default as text; memory is what it keeps between jobs (a position, so the next run only takes new rows).",
    "Every value the maker gives or will give (a page link, a target price, a threshold, a list of requirements, which sheet, who to pay) is a setting the steps read, never memory and never written into a step. When the maker said the value itself while describing the job, put it in the setting's given, exactly as they said it. Keep the maker's numbers, conditions and schedule exactly as they said them.",
    "Plan only what the maker asked for: no question to the owner, check, step or setting they didn't ask for. Ask the owner (telegram.ask) only where the maker said to ask them first, never for a payment (it asks by itself), and never because a message goes to the owner's own Telegram. Every message it sends is written by a code step right before the send, saying what happened in plain words.",
    "Keys and ids are snake_case. Money is in USDC. Use as few steps as do the job. Limits: maxSteps counts every step of every pass (at most 200); maxRunSeconds at most 300; maxSpendUsd at most 0.5. A loop with a decision inside goes through at most 10 new items a run: the code step that finds them takes the first 10.",
    "Never use em dashes.",
  ].join("\n");
}

export const DETAIL_PROMPT = [
  "You detail some steps of an agent for boardofserv. Its outline is given, with the steps detailed already: for each step asked for, say what it reads, what it makes and exactly what it does. Answer with JSON in the given schema, one entry for every step asked for, with the outline's ids.",
  'Inputs name the values a step reads: settings, rules, memory, trigger, a value a step before it makes, or inside a loop its item. Use the names the steps detailed already gave their values. Outputs name what it makes. A setting is read as settings.<key>: a step that uses one lists "settings" in its inputs, never the key itself; the same for rules and memory.',
  "code: description says exactly what the code must do with its inputs and the shape of what it returns, with the exact sheets, columns and fields the maker gave; tools lists only the tools its own code calls (a step given rows by a step before it doesn't read the sheet again).",
  'A code step that scores, rates or writes for people lists serv.reason in its tools, and its description says what SERV is asked, with which values, and the fields it answers: "Ask SERV with serv.reason to score the submission from 1 to 10 for quality, with answer { score: number, reasons: text }, and return result { name, score, reasons }."',
  'decision: prompt is the one question it judges, about one item; outcomes are the verdicts it can give (for example met and not_met), each with the step it leads to, or "" where the pass (or the run) ends. Inside a loop its first output holds its verdict ({ outcome, label, reason }), for the steps after it in the pass and for the loop to gather.',
  'A decision by a value (a plain comparison, or whether the owner said yes) has from: the input holding the way to go, also in its inputs. Either the code step right before it outputs it (the outcome\'s id, which that step\'s description says how to work out: "also return price_way: low when the price is at or below settings.target_price, else not_low"), or it is the output of the question (telegram.ask) before it, with outcomes yes and no. Otherwise from is "".',
  "A code step that makes what an action writes, sends or pays returns null when there is nothing to do, and the action is skipped: only when the job can find nothing to do (no new rows, nothing low, an amount of 0). A step that always acts (a weekly payment, a morning message) always returns what it makes, never null, and its description never mentions skipping.",
  "A code step's description names only the inputs it reads and the fields they have; it never asks the code to look for flags or options the inputs don't have.",
  "action: action is a declared action's id. Its first input is exactly what it sends, asks, writes, pays or saves, made by a code step right before it for that action alone: telegram.send's { text }, telegram.ask's { question, choices }, sheets.write's { sheet, rows }, sheets.update's { sheet, updates }, wallet.pay's { to, amountUsdc, memo } or memory.set's { key, value }. Its first output holds the tool's result (a question's { answer }). sheets.update names each row by its number (_row, which every row from sheets.read has) and the columns to write. wallet.pay's to is a payee's name, from a setting.",
  'loop: over is the input holding its list (list it in inputs too), or a list setting\'s key (with "settings" in its inputs), and item the name each item has inside the loop (a new, singular name: submission, requirement). Its outputs are the lists it gathers, and gather says, in the same order, which value made inside the loop each one gathers from every pass: outputs ["verdicts"] with gather ["verdict"] makes verdicts the list of every pass\'s verdict, in order. Gather what the steps after the loop need: an inner loop gathers each requirement\'s verdict for the step that counts them; an outer loop gathers each submission\'s result for the steps that write and sum up.',
  'For example, inside a loop over applications, a loop over skills and its decision: {"id":"each_skill","inputs":["skills"],"outputs":["verdicts"],"over":"skills","item":"skill","gather":["verdict"]} and {"id":"has_skill","inputs":["application","skill"],"outputs":["verdict"],"prompt":"Does this application show this skill?","outcomes":[{"id":"shown","label":"Shown","next":""},{"id":"not_shown","label":"Not shown","next":""}]}; then {"id":"score","inputs":["application","skills","verdicts"],"outputs":["result"],"description":"Count the verdicts whose outcome is shown. Fewer than half shown is rejected, otherwise passed. Return result { row: application.row, name: application.name, status, reasons }, reasons naming each skill as shown or not shown."}; and the outer loop {"id":"each_application","inputs":["applications"],"outputs":["results"],"over":"applications","item":"application","gather":["result"]}, so the steps after it read results. gather names the value inside (verdict, result), never the loop\'s own output.',
  "Values made inside a loop are gone once it ends: a step after a loop reads what the loop gathered, never a value made inside it. A step never outputs a loop's item or a value it reads.",
  'shapes says the shape of each output, so the steps that read it can be checked against it: { text } for telegram.send\'s arguments, { sheet, updates: { row: number, values: { Status, Reasons } }[] } for sheets.update\'s, { name, score: number, reasons }[] for a list of results. A step reads only the fields the shape of what it reads has.',
  "A summary covers every item: the code that makes it reads the gathered list and names each item (by its name or title) with its result.",
  "A step that saves a position reads memory and keeps the larger of the old position and the new one.",
  "Keys are snake_case. Never use em dashes.",
].join("\n");

type Wire = Record<string, unknown>;
const s = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

// The outline's steps in groups to detail together, in order: a loop with
// the steps inside it (as far as the outline says: its first step and on
// by next, a loop inside it with its own), so what a loop gathers is
// detailed with what makes it; whole groups packed up to `size` a call.
export function detailChunks(outline: Wire, size: number): string[][] {
  const steps = arr(outline.steps) as Wire[];
  const byId = new Map(steps.map((x) => [s(x.id), x]));
  const inside = (loop: Wire, into: Set<string>) => {
    for (let at = s(loop.body); at && byId.has(at) && !into.has(at); at = s(byId.get(at)!.next)) {
      into.add(at);
      const st = byId.get(at)!;
      if (st.kind === "loop") inside(st, into);
    }
  };
  const groups: string[][] = [];
  const placed = new Set<string>();
  for (const st of steps) {
    const id = s(st.id);
    if (!id || placed.has(id)) continue;
    const group = new Set([id]);
    if (st.kind === "loop") inside(st, group);
    const ids = steps.map((x) => s(x.id)).filter((x) => group.has(x) && !placed.has(x));
    ids.forEach((x) => placed.add(x));
    groups.push(ids);
  }
  const chunks: string[][] = [];
  for (const g of groups) {
    const last = chunks.at(-1);
    if (last && last.length + g.length <= size) last.push(...g);
    else chunks.push([...g]);
  }
  return chunks;
}

// The loops a step of the outline is inside, nearest first, as far as the
// outline says.
function outlineLoops(outline: Wire, id: string): string[] {
  const steps = arr(outline.steps) as Wire[];
  const byId = new Map(steps.map((x) => [s(x.id), x]));
  const parent = new Map<string, string>();
  for (const loop of steps.filter((x) => x.kind === "loop")) {
    const seen = new Set<string>();
    for (let at = s(loop.body); at && byId.has(at) && !seen.has(at); at = s(byId.get(at)!.next)) {
      seen.add(at);
      if (!parent.has(at)) parent.set(at, s(loop.id));
    }
  }
  const out: string[] = [];
  for (let at = parent.get(id); at && !out.includes(at); at = parent.get(at)) out.push(at);
  return out;
}

// The request for some steps' details: the maker's interview (as the
// outline had it), the outline, the steps detailed already, and which to
// detail now, with where each sits, and when they were tried before, what
// was wrong.
export function detailRequest(planText: string, outline: Wire, details: Map<string, Wire>, ids: string[], problems?: Map<string, string[]>): string {
  const steps = arr(outline.steps) as Wire[];
  const done = steps.filter((x) => details.has(s(x.id)) && !ids.includes(s(x.id))).map((x) => ({ id: s(x.id), kind: x.kind, ...details.get(s(x.id)) }));
  const where = (id: string) => {
    const loops = outlineLoops(outline, id);
    if (!loops.length) return "";
    const names = loops.map((l) => {
      const d = details.get(l);
      return d && s(d.item) ? `${l} (each item called ${s(d.item)})` : l;
    });
    return ` (inside the loop ${names.join(", inside the loop ")})`;
  };
  const lines = [planText, "", "The outline:", JSON.stringify(outline), "", "Steps detailed already:", done.length ? JSON.stringify(done) : "(none)", "", "Detail these steps:"];
  for (const id of ids) {
    const st = steps.find((x) => s(x.id) === id);
    lines.push(`- ${id}: ${s(st?.kind)}, ${s(st?.purpose) || s(st?.title)}${where(id)}`);
    const was = problems?.get(id);
    if (was?.length) {
      const before = details.get(id);
      if (before) lines.push(`  Last time it was ${JSON.stringify(before)}, with these problems:`);
      for (const p of was) lines.push(`  - ${p}`);
    }
  }
  return lines.join("\n");
}

// The outline and the details as one plan in the wire shape
// (plan.ts wireToDefinition reads it): the outline says what a step is and
// where it goes, its details what it does. A decision's next is in its
// outcomes, and nothing but code has a description.
export function joinPlan(outline: Wire, details: Map<string, Wire>): Wire {
  const steps = (arr(outline.steps) as Wire[]).map((o) => {
    const d = details.get(s(o.id)) ?? {};
    const kind = s(o.kind);
    return {
      ...d,
      id: s(o.id),
      title: s(o.title),
      kind,
      next: kind === "decision" ? "" : s(o.next),
      body: kind === "loop" ? s(o.body) : "",
      description: kind === "code" ? s(d.description) : "",
    };
  });
  return { ...outline, steps };
}

// Which stage a reason a plan doesn't check out belongs to: the outline
// (what wakes it, its setup, its actions, which steps there are, of which
// kind and in which order) or a step's details (what it reads and makes,
// its code's brief, a decision's question and outcomes). Each reason goes
// back only to the stage it is about.
const OUTLINE_REASONS = [
  /can't be reached from the first step/,
  /loops back to/,
  /reached both inside and outside a loop/,
  /starts each pass at/,
  /check trigger|check step/,
  /a schedule runs at most|value check runs at most|hourly schedule|weekly schedule/,
  /two steps are called/,
  /two (?:settings|rules|memory|actions) are called/,
  /asks over|amount column|which only reads: reading happens/,
  /decides a count|decides whether items are left|judges many things at once|no step saves it/,
  /code step "[^"]+" judges/,
];

// An action whose first input must be its tool's arguments, made by a code
// step: with a code step right before it in the outline, its details (and
// that step's) are at fault; with none, the outline is.
const ARGS_REASON = /^step "([a-z][a-z0-9_]*)" takes [a-z0-9_]+ \([a-z.]+\), so its first input must be/;

export function blame(errors: string[], outline: Wire): { outline: string[]; steps: Map<string, string[]> } {
  const steps = arr(outline.steps) as Wire[];
  const ids = steps.map((x) => s(x.id));
  const out = { outline: [] as string[], steps: new Map<string, string[]>() };
  const add = (id: string, e: string) => out.steps.set(id, [...(out.steps.get(id) ?? []), e]);
  for (const e of errors) {
    // A loop gathering what nothing inside it makes: the loop, and the code
    // steps of its passes that could make it.
    const gathers = /^loop "([a-z][a-z0-9_]*)" gathers "/.exec(e);
    if (gathers) {
      add(gathers[1]!, e);
      for (const x of steps) if (x.kind === "code" && outlineLoops(outline, s(x.id))[0] === gathers[1]) add(s(x.id), e);
      continue;
    }
    const args = ARGS_REASON.exec(e);
    if (args) {
      const before = steps.find((x) => s(x.next) === args[1]);
      if (before?.kind === "code") {
        add(args[1]!, e);
        add(s(before.id), e);
      } else out.outline.push(e);
      continue;
    }
    // A zod reason starts with its path: steps.3.inputs is the fourth step's.
    const at = /^steps\.(\d+)\./.exec(e);
    // A step the repairs put in (planRepairs.ts) is about the step it serves.
    const source = (x: string) => (ids.includes(x) ? x : (/^make_(.+?)(?:_\d+)?$/.exec(x)?.[1] ?? /^(.+)_check(?:_\d+)?$/.exec(x)?.[1] ?? x));
    const named = at ? [ids[Number(at[1])]].filter((x): x is string => Boolean(x)) : [...e.matchAll(/(?:step|decision|loop) "([a-z][a-z0-9_]*)"/g)].map((m) => source(m[1]!)).filter((x) => ids.includes(x));
    // A decision's outcome going nowhere is its own detail.
    const decisionNext = /goes to "[^"]+", which is not a step/.test(e) && named.length && (arr(outline.steps) as Wire[]).find((x) => s(x.id) === named[0])?.kind === "decision";
    if ((OUTLINE_REASONS.some((r) => r.test(e)) || /goes to "[^"]+", which is not a step/.test(e)) && !decisionNext) out.outline.push(e);
    else if (!named.length || /^(?:name|job|triggers|settings|rules|memory|actions|limits|approvalHours)\b/.test(e)) out.outline.push(e);
    else for (const id of new Set(named)) add(id, e);
  }
  return out;
}
