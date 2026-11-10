import "server-only";
import { minIntervalMinutes } from "./interval";
import { completeJson, contextFor, type ChatMessage, type JsonResult, type ModelConfig } from "../model";
import { ANSWER_LIMITS } from "../modelLimits";
import { INTERVIEW_FIELDS, INTERVIEW_LABELS } from "../sketchFields";
import type { SketchDTO } from "../types";
import { ACTION_TOOLS, AGENT_FORMAT, checkDefinition, SETTING_TYPES, RULE_TYPES, TOOL_NAMES, type AgentDefinition } from "./definition";
import { TOOLS } from "./toolbox";

// Planning: SERV turns the maker's interview (and the conversation behind
// it) into a whole agent definition, which is checked against the format.
// A plan that doesn't check out goes back to SERV with the reasons, up to
// three tries in all. The same call, given the current plan and what the
// maker says went wrong, changes a plan (the test bench's "fix by chatting").
//
// The schema is the format flattened for SERV's strict json_schema: every
// field present, "" or [] where it doesn't apply, no unions and no numeric
// range keywords. wireToDefinition turns the answer back into the format.

export const MAX_PLAN_TRIES = 3;
// A whole plan is one answer of a few thousand tokens, not streamed, so it
// gets far longer than a reply's wait for its first token.
const DEFAULT_PLAN_TIMEOUT_MS = 120_000;

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

export const AGENT_PLAN_SCHEMA = {
  name: "agent_plan",
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
      obj({ key: str("snake_case"), label: str("the question"), type: { type: "string", enum: [...SETTING_TYPES] }, help: str("help text"), choices: strings("for a choice, else []") }),
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
        kind: { type: "string", enum: ["code", "decision", "action"] },
        inputs: strings("values it reads"),
        outputs: strings("values it adds"),
        next: str('the next step id, "" when the run ends (not for decisions)'),
        description: str("code: exactly what the code must do with its inputs and what it returns, else empty"),
        tools: { type: "array", items: { type: "string", enum: [...TOOL_NAMES] }, description: "code: the tools it may call, else []" },
        prompt: str("decision: what to judge, else empty"),
        outcomes: list(obj({ id: str("snake_case"), label: str("a few words"), next: str('the step it leads to, or ""') }), "decision: 2 to 6 outcomes, else []"),
        action: str("action: a declared action id, else empty"),
        otherwise: str('action that waits for the owner (telegram.ask, or a payment over a limit): the step to go to when no answer comes in time, or "" to stop'),
      }),
      "the steps; a run starts at the first",
    ),
    limits: obj({ maxSteps: { type: "number" }, maxRunSeconds: { type: "number" }, maxSpendUsd: { type: "number" } }),
    approvalHours: { type: "number", description: "hours the owner has to answer a question before it counts as no answer: 24 unless the maker said otherwise" },
  }),
};

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

// SERV's flat answer, back in the format's shape. Whatever doesn't fit is
// left for checkDefinition to name.
export function wireToDefinition(w: Wire): unknown {
  const steps = arr(w.steps).map((x) => {
    const st = x as Wire;
    const base = { id: s(st.id), title: s(st.title), inputs: arr(st.inputs).map(s), outputs: arr(st.outputs).map(s) };
    if (st.kind === "decision") {
      return { ...base, kind: "decision", prompt: s(st.prompt), outcomes: arr(st.outcomes).map((o) => ({ id: s((o as Wire).id), label: s((o as Wire).label), next: nextOrNull((o as Wire).next) })) };
    }
    if (st.kind === "action") return { ...base, kind: "action", action: s(st.action), next: nextOrNull(st.next), ...(s(st.otherwise) ? { otherwise: s(st.otherwise) } : {}) };
    return { ...base, kind: "code", description: s(st.description), tools: arr(st.tools).map(s), next: nextOrNull(st.next) };
  });
  readBags(steps as { inputs: string[]; outputs: string[]; description?: string; prompt?: string }[], w);
  const triggers = arr(w.triggers).map((x) => {
    const t = x as Wire;
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
      return { key: s(t.key), label: s(t.label), type: t.type, help: s(t.help), choices: arr(t.choices).map(s).filter(Boolean) };
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

export const PLAN_AGENT_PROMPT = [
  "You plan an agent for boardofserv from the maker's interview. Answer with the whole agent as JSON in the given schema.",
  "Steps. code: reading and working things out, in a sandbox (read sheets, fetch pages, search, compare, compute); describe exactly what the code must do with its inputs and what it returns, and list only the tools it calls.",
  "decision: a judgement made by a model, with 2 to 6 outcomes, each naming the step it leads to.",
  "action: takes one declared action, which only changes things (sheets.write, telegram.send, telegram.ask, wallet.pay, memory.set); never use an action to read. For sheets.write, wallet.pay and memory.set its first input must already be that tool's arguments ({ sheet, rows }, { to, amountUsdc, memo } or { key, value }), a value of its own made by a code step before it for that action alone; telegram.send and telegram.ask make their message from any inputs. The step's first output holds the tool's result (telegram.ask gives { answer }).",
  'A run starts at the first step. next is the next step\'s id, or "" when the run ends there.',
  `A schedule runs every N minutes (every "minutes", everyMinutes N, at least ${minIntervalMinutes()}; every 2 hours is 120), every day at a time (every "day", at "HH:MM") or every week on some days at a time (every "week", the days in when, at "HH:MM"), in the renter's time zone. For anything that runs on a clock, use a schedule: "every 15 minutes" is every minutes with everyMinutes 15, "twice a week" is every week on two days.`,
  'Use a check trigger only to run when a watched value changes, not to run on a clock. A check trigger names its own code step (step), listed with the steps but outside the run: it reads the watched value with tools that only read, from settings, rules and memory, and returns { holds } (true when the condition is met, and optionally value). The run starts when holds turns true. Its next is "" and no step leads to it.',
  'Inputs name values a step reads: settings, rules, memory, trigger, or an output of an earlier step. Outputs name what it adds. A setting is read as settings.<key>: a step that uses one lists "settings" in its inputs, never the key itself; the same for rules and memory.',
  "In code step descriptions, name the exact sheets, columns and fields the maker gave, and the shape of what the step returns.",
  `Tools: ${TOOL_NAMES.map((t) => `${t} (${TOOLS[t].summary})`).join("; ")}.`,
  "Every side effect (sheets.write, telegram.send, telegram.ask, wallet.pay) must be a declared action. Anything the maker said it must never do without asking goes through telegram.ask first.",
  "A question to the owner (telegram.ask) waits for their answer for approvalHours; an action step that asks can name otherwise, the step to go to when no answer comes, or leave it empty to stop. Spending is a payment (wallet.pay), or rows written to a sheet whose amountColumn holds each row's amount in USDC (orders). A spending action can name askOver, a usdc rule: the runtime asks the owner before any spending that takes the job's running total over it, and askOverDay, the same for the day's total. The runtime keeps those totals across every action and line, so never add a decision or question of your own for those limits.",
  "Settings are what each renter answers at setup; rules are limits a renter may adjust, with the maker's default as text; memory is what it keeps between jobs.",
  "Keys and ids are snake_case. Money is in USDC. Use as few steps as do the job. Limits: maxSteps at most 50, maxRunSeconds at most 300, maxSpendUsd at most 0.5.",
  "Never use em dashes.",
].join("\n");

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
  }
  return lines.join("\n");
}

export interface PlanResult {
  definition: AgentDefinition | null;
  // SERV's answers, one per try, as it sent them.
  answers: string[];
  // The reasons the last try didn't check out, when none did.
  errors: string[];
  // Every call made, for the usage records.
  calls: JsonResult[];
}

export async function planAgent(
  input: PlanInput,
  opts: { config: ModelConfig; signal: AbortSignal; fetchImpl?: typeof fetch; maxTries?: number },
): Promise<PlanResult> {
  const max = Number(process.env.AGENT_PLAN_MAX_TOKENS);
  const maxTokens = Number.isInteger(max) && max > 0 ? max : ANSWER_LIMITS.agent_plan;
  const t = Number(process.env.AGENT_PLAN_TIMEOUT_MS);
  const config = { ...opts.config, firstTokenTimeoutMs: Number.isInteger(t) && t > 0 ? t : DEFAULT_PLAN_TIMEOUT_MS };
  const messages: ChatMessage[] = [
    { role: "system", content: PLAN_AGENT_PROMPT },
    { role: "user", content: planRequest(input) },
  ];
  const calls: JsonResult[] = [];
  const answers: string[] = [];
  let errors: string[] = [];
  for (let attempt = 0; attempt < (opts.maxTries ?? MAX_PLAN_TRIES); attempt++) {
    const result = await completeJson(messages, { config, purpose: "agent_plan", schema: AGENT_PLAN_SCHEMA, maxTokens, signal: opts.signal, fetchImpl: opts.fetchImpl });
    calls.push(result);
    if (!result.content) {
      // No answer at all (every provider failed): another try won't help.
      errors = ["No model answered."];
      break;
    }
    answers.push(result.content);
    let wire: unknown;
    try {
      wire = JSON.parse(result.content);
    } catch {
      errors = ["The answer was not JSON."];
      messages.push({ role: "assistant", content: result.content.slice(0, 8000) }, { role: "user", content: "That was not valid JSON. Send the whole plan again as JSON." });
      continue;
    }
    const checked = checkDefinition(wireToDefinition(wire as Wire));
    if (checked.ok) return { definition: checked.definition, answers, errors: [], calls };
    errors = checked.errors;
    messages.push(
      { role: "assistant", content: result.content.slice(0, 12000) },
      { role: "user", content: `That plan has problems:\n${errors.map((e) => `- ${e}`).join("\n")}\nSend the whole corrected plan.` },
    );
  }
  return { definition: null, answers, errors, calls };
}
