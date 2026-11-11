import "server-only";
import { minIntervalMinutes } from "./interval";
import { completeJson, contextFor, type ChatMessage, type JsonResult, type ModelConfig } from "../model";
import { ANSWER_LIMITS } from "../modelLimits";
import { INTERVIEW_FIELDS, INTERVIEW_LABELS } from "../sketchFields";
import type { SketchDTO } from "../types";
import { AGENT_FORMAT, checkDefinition, loopChain, loopsOf, madeInside, TOOL_NAMES, type AgentDefinition, type AgentStep } from "./definition";
import { TOOLS } from "./toolbox";
import { planProblems } from "./planRules";
import { fixSetup, repairPlan, type RawStep } from "./planRepairs";
import { blame, DETAIL_PROMPT, DETAIL_SCHEMA, detailChunks, detailRequest, joinPlan, OUTLINE_SCHEMA, outlinePrompt } from "./planStages";

// Planning: SERV turns the maker's interview (and the conversation behind
// it) into a whole agent definition, which is checked against the format
// and the planner's rules. It is asked in two stages (planStages.ts): an
// outline, then the details of a few steps at a time, so each answer's
// schema stays well under SERV's limit. A plan that doesn't check out goes
// back only to the stage at fault, with the reasons: the outline, or the
// details of the steps named. Given the current plan and what the maker
// says went wrong, the same two stages change a plan ("Fix this").
//
// wireToDefinition turns the joined answer back into the format.

// At most this many calls to SERV for one plan: the outline, the details
// a few steps at a time, and a stage tried again when what it gave doesn't
// check out (at most MAX_REPAIRS times). A plan typically takes two to
// four: the outline and a call or more of details.
export const MAX_PLAN_CALLS = 10;
// The calls one plan may take: MAX_PLAN_CALLS for any agent, more for a
// bigger one (its steps detailed in more calls, and room to repair them).
export function planCallCap(d: { steps?: unknown } | null): number {
  const n = Array.isArray(d?.steps) ? d.steps.length : 0;
  return Math.max(MAX_PLAN_CALLS, 4 + 2 * Math.ceil(n / STEPS_PER_CALL) + 2 * MAX_REPAIRS);
}
// When a plan doesn't check out, SERV is asked to put right only the parts
// at fault this many times, then planning gives up.
export const MAX_REPAIRS = 2;
// Steps detailed in one call (a loop and the steps inside it go together).
export const STEPS_PER_CALL = 6;
// Each answer is a few thousand tokens at most, not streamed, so it gets
// far longer than a reply's wait for its first token.
const DEFAULT_PLAN_TIMEOUT_MS = 120_000;

type Wire = Record<string, unknown>;
const s = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : Number(v));
const nextOrNull = (v: unknown) => s(v) || null;

// One fix with only one meaning: a step that reads a setting, rule or memory
// key reads the bag it lives in (settings, rules, memory), and so does a step
// whose words name one. SERV often lists the key itself.
function readBags(steps: { inputs: string[]; outputs: string[]; description?: string; prompt?: string }[], w: Wire) {
  // A key can be in more than one bag: it reads every bag it is in.
  const bagsOf = new Map<string, string[]>();
  for (const [bag, list] of [
    ["settings", arr(w.settings)],
    ["rules", arr(w.rules)],
    ["memory", arr(w.memory)],
  ] as const) {
    for (const x of list) {
      const k = s((x as Wire).key);
      if (k) bagsOf.set(k, [...(bagsOf.get(k) ?? []), bag]);
    }
  }
  const produced = new Set(steps.flatMap((st) => st.outputs));
  for (const st of steps) {
    const inputs = st.inputs.flatMap((i) => (!produced.has(i) && bagsOf.has(i) ? bagsOf.get(i)! : [i]));
    const words = st.description ?? st.prompt ?? "";
    for (const [k, bags] of bagsOf) if (new RegExp(`\\b${k}\\b`).test(words)) inputs.push(...bags);
    st.inputs = [...new Set(inputs)];
  }
}

// One more fix with one meaning: a code step that saves to memory (with
// memory.set, or by making a memory.set action's arguments) reads what
// memory holds and builds on it, so a saved position never goes backwards.
function buildOnMemory(steps: { kind?: string; inputs: string[]; outputs: string[]; description?: string; tools?: string[] }[], w: Wire) {
  const sets = new Set(arr(w.actions).flatMap((a) => (s((a as Wire).tool) === "memory.set" ? [s((a as Wire).id)] : [])));
  const argsFor = new Set(arr(w.steps).flatMap((x) => (s((x as Wire).kind) === "action" && sets.has(s((x as Wire).action)) ? [s(arr((x as Wire).inputs)[0])] : [])));
  for (const st of steps) {
    if (st.kind !== "code") continue;
    const saves = (st.tools ?? []).includes("memory.set") || st.outputs.some((o) => argsFor.has(o));
    if (!saves || st.inputs.includes("memory") || (st.tools ?? []).includes("memory.get")) continue;
    st.inputs = [...st.inputs, "memory"];
    st.description = `${st.description ?? ""} Build on what memory holds already: a saved position keeps the larger of the old one and the new one.`.trim();
  }
}

// Two more for a decision over a list, which SERV is still learning: with
// no output named, its verdicts are the one value the step it leads to
// reads that no step makes; with one outcome only, or one id twice, all
// going to one step (no verdicts to choose from), its verdicts are yes and
// no, both going there.
function listVerdicts(steps: Wire[]) {
  const made = new Set(steps.flatMap((x) => arr(x.outputs).map(s)));
  for (const st of steps) {
    if (st.kind !== "decision" || !st.each) continue;
    const outcomes = arr(st.outcomes) as Wire[];
    if (!arr(st.outputs).length) {
      const after = steps.find((x) => x.id === s(outcomes[0]?.next));
      const unmade = arr(after?.inputs).map(s).filter((i) => !made.has(i) && !["settings", "rules", "memory", "trigger"].includes(i));
      if (unmade.length === 1) st.outputs = [unmade[0]!];
    }
    if (new Set(outcomes.map((o) => s(o.id))).size < 2 && new Set(outcomes.map((o) => s(o.next))).size === 1) {
      const next = outcomes[0]!.next ?? null;
      st.outcomes = [
        { id: "yes", label: "Yes", next },
        { id: "no", label: "No", next },
      ];
    }
  }
}

// Some for loops, each with one meaning. A loop reads the list it goes
// through. A step inside a loop that leads back to the loop or to its first
// step, or on to the step after the loop, means the pass ends there (the
// loop goes on to the next item by itself, and on after the last). A step
// inside a loop never makes the loop's item: it is there already. A loop
// that gathers a name nothing inside it makes gathers the one value made
// in its passes whose name that is the plural of ("verdicts" from
// "verdict"), or else the verdict of the one decision inside it that has
// none named. A step after a loop that reads a value made inside it, which
// is gone by then, means the list the loop gathers from that value, when it
// gathers one.
function loopRepairs(steps: AgentStep[], bagOf: Map<string, string>) {
  for (const st of steps) {
    if (st.kind !== "loop") continue;
    // A setting's list is read from its bag.
    const bag = bagOf.get(st.over);
    const reads = bag && !steps.some((x) => x.outputs.includes(st.over)) ? bag : st.over;
    if (reads && !st.inputs.includes(reads)) st.inputs = [...st.inputs, reads];
    st.gather = st.gather.map((g) => ({ ...g, from: g.from || g.into }));
  }
  const loops = loopsOf({ steps });
  const byId = new Map(steps.map((x) => [x.id, x]));
  const items = (id: string) => loopChain(loops, id).flatMap((l) => (byId.get(l)?.kind === "loop" ? [(byId.get(l) as { item: string }).item] : []));
  for (const st of steps) if (st.kind !== "loop") st.outputs = st.outputs.filter((o) => !items(st.id).includes(o));
  for (const loop of steps) {
    if (loop.kind !== "loop") continue;
    const own = steps.filter((x) => loops.inside.get(x.id) === loop.id);
    loop.gather = loop.gather.map((g) => {
      if (madeInside({ steps }, loops, loop.id).has(g.from)) return g;
      const plural = own.flatMap((x) => x.outputs).filter((v) => [`${v}s`, `${v}es`, `${v}_list`, `all_${v}`].includes(g.from));
      if (plural.length === 1) return { ...g, from: plural[0]! };
      const silent = own.filter((x) => x.kind === "decision" && !x.outputs.length);
      if (silent.length === 1) silent[0]!.outputs = [g.from];
      return g;
    });
  }
  for (const st of steps) {
    const loop = steps.find((l) => l.id === loops.inside.get(st.id));
    if (loop?.kind !== "loop") continue;
    const back = (n: string | null) => (n === loop.id || n === loop.body || (n !== null && n === loop.next) ? null : n);
    if (st.kind === "decision") st.outcomes = st.outcomes.map((o) => ({ ...o, next: back(o.next) }));
    else st.next = back(st.next);
  }
  const after = loopsOf({ steps });
  for (const st of steps) {
    const chain = new Set<string>();
    for (let at = after.inside.get(st.id) ?? null; at && !chain.has(at); at = after.inside.get(at) ?? null) chain.add(at);
    st.inputs = st.inputs.map((input) => {
      const loop = steps.find((l) => l.kind === "loop" && l.id !== st.id && !chain.has(l.id) && madeInside({ steps }, after, l.id).has(input));
      const gathered = loop?.kind === "loop" ? loop.gather.filter((g) => g.from === input) : [];
      return gathered.length === 1 && !st.inputs.includes(gathered[0]!.into) ? gathered[0]!.into : input;
    });
  }
}

// A decision over a list: the input holding the list, when its description
// is exactly the name of one of its inputs.
function listInput(st: Wire): string | null {
  const named = s(st.each) || s(st.description);
  return /^[a-z][a-z0-9_]*$/.test(named) && arr(st.inputs).map(s).includes(named) ? named : null;
}

// Where a step (as wireToDefinition shapes it) can go next.
function nextIds(step: unknown): string[] {
  const st = step as { next?: string | null; otherwise?: string; outcomes?: { next: string | null }[] };
  return [st.next ?? null, st.otherwise ?? null, ...(st.outcomes ?? []).map((o) => o.next)].filter((x): x is string => Boolean(x));
}

// SERV's flat answer, back in the format's shape. Whatever doesn't fit is
// left for checkDefinition to name.
export function wireToDefinition(w: Wire): unknown {
  const steps = arr(w.steps).map((x) => {
    const st = x as Wire;
    const base = { id: s(st.id), title: s(st.title), ...(s(st.plain) ? { plain: s(st.plain).slice(0, 200) } : {}), inputs: arr(st.inputs).map(s), outputs: arr(st.outputs).map(s) };
    if (st.kind === "decision") {
      return {
        ...base,
        kind: "decision",
        // One that goes by a value may come with no question: its title is.
        prompt: s(st.prompt) || (s(st.from) ? s(st.title) : ""),
        outcomes: arr(st.outcomes).map((o) => ({ id: s((o as Wire).id), label: s((o as Wire).label), next: nextOrNull((o as Wire).next) })),
        // Over a list: the input it judges item by item, named in its
        // description (or each, in a plan written by hand).
        ...(listInput(st) ? { each: listInput(st) } : {}),
        // Or by a value: the way a step before it worked out.
        ...(s(st.from) && !listInput(st) ? { from: s(st.from) } : {}),
      };
    }
    if (st.kind === "action") return { ...base, kind: "action", action: s(st.action), next: nextOrNull(st.next), ...(s(st.otherwise) ? { otherwise: s(st.otherwise) } : {}) };
    if (st.kind === "loop") {
      // Each output gathers the value named in the same place in gather.
      const from = arr(st.gather).map(s);
      return { ...base, kind: "loop", over: s(st.over), item: s(st.item), body: s(st.body), gather: base.outputs.map((into, i) => ({ from: from[i] ?? "", into })), next: nextOrNull(st.next) };
    }
    return { ...base, kind: "code", description: s(st.description), tools: arr(st.tools).map(s), next: nextOrNull(st.next) };
  });
  readBags(steps as { inputs: string[]; outputs: string[]; description?: string; prompt?: string }[], w);
  buildOnMemory(steps as { kind?: string; inputs: string[]; outputs: string[]; description?: string; tools?: string[] }[], w);
  listVerdicts(steps as Wire[]);
  loopRepairs(steps as AgentStep[], new Map((["settings", "rules", "memory"] as const).flatMap((bag) => arr(w[bag]).map((x) => [s((x as Wire).key), bag] as [string, string]))));
  const first = steps[0]?.id;
  const triggers = arr(w.triggers).map((x) => {
    const t = x as Wire;
    // A check whose own step is the run's first step is a clock in
    // disguise ("every 15 minutes, check for new rows"): its step would
    // never be part of the run, and nothing after it could be reached.
    // It is the schedule it meant.
    if (t.kind === "check" && s(t.step) && s(t.step) === first) {
      // Its step, which only checked and ended there, now goes on to the
      // first step nothing else leads to: where the run was meant to start.
      const head = steps[0] as { next?: string | null };
      if (head && "next" in head && head.next === null) {
        const led = new Set(steps.flatMap((x) => nextIds(x)));
        const start = steps.slice(1).find((x) => !led.has(x.id));
        if (start) head.next = start.id;
      }
      return { kind: "schedule", every: "minutes", interval: Math.max(minIntervalMinutes(), Math.round(n(t.everyMinutes)) || 15), at: null, description: s(t.description) || `Every ${Math.round(n(t.everyMinutes)) || 15} minutes` };
    }
    if (t.kind === "check") return { kind: "check", everyMinutes: Math.round(n(t.everyMinutes)), watch: s(t.watch), when: s(t.when), ...(s(t.step) ? { step: s(t.step) } : {}) };
    if (t.kind === "message") return { kind: "message", from: "telegram", description: s(t.description) };
    const every = t.every === "minutes" || t.every === "hours" || t.every === "week" ? t.every : t.every === "hour" ? "hours" : "day";
    // Every so many minutes comes as everyMinutes (interval reads the same).
    const interval = Math.round(n(t.interval) || n(t.everyMinutes));
    const DAY_NAMES = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
    // Days as words, comma separated, in when (days, or an array of words,
    // read the same).
    const days = (Array.isArray(t.days) ? arr(t.days).map(s) : (s(t.days) || s(t.when)).split(","))
      .map((d) => DAY_NAMES.indexOf(d.trim().toLowerCase()))
      .filter((d) => d >= 0);
    const minutesPast = /^:\d{2}$/.test(s(t.at)) ? `00${s(t.at)}` : s(t.at);
    return {
      kind: "schedule",
      every,
      ...(every === "minutes" || every === "hours" ? { interval: Math.max(1, interval || 1) } : {}),
      at: /^([01]\d|2[0-3]):[0-5]\d$/.test(minutesPast) ? minutesPast : null,
      ...(every === "week" ? { days: [...new Set(days.length ? days : [1])] } : {}),
      description: s(t.description),
    };
  });
  const job = (w.job ?? {}) as Wire;
  const limits = (w.limits ?? {}) as Wire;
  return {
    format: AGENT_FORMAT,
    name: s(w.name),
    job: { does: s(job.does), done: s(job.done) },
    triggers,
    settings: arr(w.settings).map((x) => {
      const t = x as Wire;
      return { key: s(t.key), label: s(t.label), type: t.type, help: s(t.help), choices: arr(t.choices).map(s).filter(Boolean), ...(s(t.given) ? { given: s(t.given).slice(0, 500) } : {}) };
    }),
    rules: arr(w.rules).map((x) => {
      const t = x as Wire;
      return { key: s(t.key), label: s(t.label), type: t.type, value: s(t.value), help: s(t.help) };
    }),
    memory: arr(w.memory).map((x) => ({ key: s((x as Wire).key), description: s((x as Wire).description), type: (x as Wire).type })),
    actions: arr(w.actions).map((x) => {
      const a = x as Wire;
      return {
        id: s(a.id),
        tool: a.tool,
        description: s(a.description),
        ...(s(a.askOver) ? { askOver: s(a.askOver) } : {}),
        ...(s(a.askOverDay) ? { askOverDay: s(a.askOverDay) } : {}),
        ...(s(a.amountColumn) ? { amountColumn: s(a.amountColumn) } : {}),
      };
    }),
    steps,
    limits: { maxSteps: Math.round(n(limits.maxSteps)), maxRunSeconds: Math.round(n(limits.maxRunSeconds)), maxSpendUsd: n(limits.maxSpendUsd) },
    ...(n(w.approvalHours) > 0 ? { approvalHours: Math.round(n(w.approvalHours)) } : {}),
  };
}

const PLAN_HISTORY_MESSAGES = 30;

export interface PlanInput {
  interview: SketchDTO;
  history: ChatMessage[];
  // Changing a plan: the plan as it is, and what the maker says is wrong.
  current?: AgentDefinition | null;
  feedback?: string | null;
}

export function planRequest({ interview, history, current, feedback }: PlanInput): string {
  const lines = [`Agent: ${interview.name ?? "unnamed"}`, "", "Interview:"];
  for (const k of INTERVIEW_FIELDS) if (interview[k]) lines.push(`${INTERVIEW_LABELS[k]}: ${interview[k]}`);
  const said = contextFor(history, PLAN_HISTORY_MESSAGES)
    .map((m) => `${m.role === "user" ? "Maker" : "boardofserv"}: ${m.content}`)
    .join("\n");
  if (said) lines.push("", "Conversation:", said);
  if (current) {
    lines.push("", "The plan as it is:", JSON.stringify(current));
    if (feedback) lines.push("", `The maker says: ${feedback}`, "Change only what this needs. Keep the ids of steps that stay the same.");
  } else if (feedback) lines.push("", `Also: ${feedback}`);
  return lines.join("\n");
}

export interface PlanResult {
  definition: AgentDefinition | null;
  // SERV's answers, one per call, as it sent them.
  answers: string[];
  // The reasons the last plan didn't check out, when none did.
  errors: string[];
  // Every call made, for the usage records.
  calls: JsonResult[];
}

type Stage = "outline" | "details";

export async function planAgent(
  input: PlanInput,
  opts: { config: ModelConfig; signal: AbortSignal; fetchImpl?: typeof fetch; maxCalls?: number },
): Promise<PlanResult> {
  const t = Number(process.env.AGENT_PLAN_TIMEOUT_MS);
  const config = { ...opts.config, firstTokenTimeoutMs: Number.isInteger(t) && t > 0 ? t : DEFAULT_PLAN_TIMEOUT_MS };
  const maxCalls = opts.maxCalls ?? MAX_PLAN_CALLS;
  const calls: JsonResult[] = [];
  const answers: string[] = [];
  const planText = planRequest(input);
  let errors: string[] = [];

  // One call for one stage: its answer as JSON, or null when no model
  // answered (nothing more can be done) or the calls are used up.
  let silent = false;
  const ask = async (stage: Stage, messages: ChatMessage[]): Promise<Record<string, unknown> | null> => {
    if (calls.length >= maxCalls) return null;
    const outline = stage === "outline";
    const result = await completeJson(messages, {
      config,
      purpose: outline ? "agent_outline" : "agent_steps",
      schema: outline ? OUTLINE_SCHEMA : DETAIL_SCHEMA,
      maxTokens: ANSWER_LIMITS[outline ? "agent_outline" : "agent_steps"],
      signal: opts.signal,
      fetchImpl: opts.fetchImpl,
    });
    calls.push(result);
    if (!result.content) {
      silent = true;
      return null;
    }
    answers.push(result.content);
    try {
      const parsed = JSON.parse(result.content) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  };
  const done = (definition: AgentDefinition | null): PlanResult => ({ definition, answers, errors: definition ? [] : silent ? ["No model answered."] : errors, calls });

  // Stage one: the outline.
  const outlineMessages: ChatMessage[] = [
    { role: "system", content: outlinePrompt(minIntervalMinutes(), TOOL_NAMES.map((tool) => `${tool} (${TOOLS[tool].summary})`).join("; ")) },
    { role: "user", content: planText },
  ];
  let outline = await ask("outline", outlineMessages);
  if (!outline) return done(null);

  // Stage two: the details, a few steps at a time; then, for as long as the
  // calls last, the plan is checked and each reason goes back to its stage.
  const details = new Map<string, Record<string, unknown>>();
  const detail = async (ids: string[], problems?: Map<string, string[]>): Promise<boolean> => {
    const answer = await ask("details", [
      { role: "system", content: DETAIL_PROMPT },
      { role: "user", content: detailRequest(planText, outline!, details, ids, problems) },
    ]);
    if (!answer) return false;
    for (const st of Array.isArray(answer.steps) ? (answer.steps as Record<string, unknown>[]) : []) {
      const id = typeof st.id === "string" ? st.id.trim() : "";
      if (ids.includes(id)) details.set(id, st);
    }
    return true;
  };
  const missing = () => outlineIds(outline!).filter((id) => !details.has(id));
  const retried = new Set<string>();
  let repairs = 0;
  while (calls.length < maxCalls) {
    // Every step without details gets them, its loop's steps alongside.
    const todo = missing();
    if (todo.length) {
      const chunk = detailChunks(outline, STEPS_PER_CALL).map((c) => c.filter((id) => todo.includes(id))).find((c) => c.length);
      if (!chunk || !(await detail(chunk))) break;
      continue;
    }
    const joined = repaired(wireToDefinition(joinPlan(outline, details)));
    const checked = checkDefinition(joined);
    // A plan in the format still has to keep the planner's rules
    // (planRules.ts): judgement in decisions, counting in code, no loops.
    // They are read off a plan that doesn't check out yet too, as far as it
    // goes, so a wrong kind of step goes back with everything else.
    const broken = rulesOf(checked.ok ? checked.definition : (joined as AgentDefinition));
    if (checked.ok && !broken.length) return done(checked.definition);
    errors = [...new Set([...(checked.ok ? [] : checked.errors), ...broken])];
    if (repairs >= MAX_REPAIRS) break;
    repairs += 1;
    const at = blame(errors, outline);
    // A step whose details went back once already and still don't check out
    // can't be fixed by its details alone: the outline goes back.
    for (const [id, reasons] of at.steps) {
      if (!retried.has(id)) continue;
      at.outline.push(...reasons);
      at.steps.delete(id);
      details.delete(id);
    }
    if (at.outline.length || !at.steps.size) {
      // The outline goes back with its reasons; steps it keeps as they
      // were keep their details.
      const before = outline;
      outlineMessages.push(
        { role: "assistant", content: JSON.stringify(before).slice(0, 12000) },
        { role: "user", content: `That outline has problems:\n${(at.outline.length ? at.outline : errors).map((e) => `- ${e}`).join("\n")}\nSend the whole corrected outline.` },
      );
      const next = await ask("outline", outlineMessages);
      if (!next) break;
      outline = next;
      for (const id of [...details.keys()]) if (!sameOutlineStep(before, next, id)) details.delete(id);
      retried.clear();
      continue;
    }
    // Only the steps at fault are detailed again, with what was wrong.
    for (const id of at.steps.keys()) retried.add(id);
    if (!(await detail([...at.steps.keys()], at.steps))) break;
  }
  return done(null);
}

// SERV's plan with the repairs that have one meaning made (planRepairs.ts):
// a loop over one value goes once, a plain comparison or the owner's yes
// goes by a value, and every send, write or pay is handed what it sends.
export function repaired(plan: unknown): unknown {
  const d = plan as { steps?: unknown; settings?: unknown; rules?: unknown; actions?: unknown };
  if (!Array.isArray(d?.steps)) return plan;
  const list = (v: unknown) => (Array.isArray(v) ? (v as Record<string, unknown>[]) : []);
  if (Array.isArray(d.settings)) (d as { settings: unknown }).settings = fixSetup(d.settings as { key: string; label?: string; type: unknown }[]);
  repairPlan(d.steps as RawStep[], {
    settings: list(d.settings).map((x) => ({ key: s(x.key), type: x.type })),
    rules: list(d.rules).map((x) => ({ key: s(x.key), type: x.type })),
    actions: list(d.actions).map((x) => ({ id: s(x.id), tool: x.tool, description: s(x.description) })),
  });
  return plan;
}

// The planner's rules, on a plan that may not check out yet: what can be
// read off it, or nothing.
function rulesOf(d: AgentDefinition): string[] {
  try {
    return planProblems(d);
  } catch {
    return [];
  }
}

function outlineIds(outline: Record<string, unknown>): string[] {
  return (Array.isArray(outline.steps) ? (outline.steps as Record<string, unknown>[]) : []).map((x) => (typeof x.id === "string" ? x.id.trim() : "")).filter(Boolean);
}

// A step the corrected outline left as it was: same kind, place and job.
function sameOutlineStep(a: Record<string, unknown>, b: Record<string, unknown>, id: string): boolean {
  const find = (o: Record<string, unknown>) => (Array.isArray(o.steps) ? (o.steps as Record<string, unknown>[]) : []).find((x) => x.id === id);
  const [x, y] = [find(a), find(b)];
  return Boolean(x && y) && ["kind", "purpose", "next", "body"].every((k) => x![k] === y![k]);
}
