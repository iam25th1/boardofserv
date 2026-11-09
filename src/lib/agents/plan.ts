import "server-only";
import { completeJson, contextFor, type ChatMessage, type JsonResult, type ModelConfig } from "../model";
import { INTERVIEW_FIELDS, INTERVIEW_LABELS } from "../sketchFields";
import type { SketchDTO } from "../types";
import { AGENT_FORMAT, checkDefinition, SETTING_TYPES, RULE_TYPES, TOOL_NAMES, type AgentDefinition } from "./definition";
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
const DEFAULT_PLAN_MAX_TOKENS = 3500;

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
        every: { type: "string", enum: ["hour", "day", "week", "none"], description: "schedule only" },
        at: str('schedule: a time like "08:00", or ""'),
        everyMinutes: { type: "number", description: "check: minutes between checks, else 0" },
        watch: str("check: the value it watches, else empty"),
        when: str("check: when it acts, else empty"),
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
    actions: list(obj({ id: str("snake_case"), tool: { type: "string", enum: [...TOOL_NAMES] }, description: str("what this action does") }), "the only actions it may ever take"),
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
      }),
      "the steps; a run starts at the first",
    ),
    limits: obj({ maxSteps: { type: "number" }, maxRunSeconds: { type: "number" }, maxSpendUsd: { type: "number" } }),
  }),
};

type Wire = Record<string, unknown>;
const s = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : Number(v));
const nextOrNull = (v: unknown) => s(v) || null;

// SERV's flat answer, back in the format's shape. Whatever doesn't fit is
// left for checkDefinition to name.
export function wireToDefinition(w: Wire): unknown {
  const steps = arr(w.steps).map((x) => {
    const st = x as Wire;
    const base = { id: s(st.id), title: s(st.title), inputs: arr(st.inputs).map(s), outputs: arr(st.outputs).map(s) };
    if (st.kind === "decision") {
      return { ...base, kind: "decision", prompt: s(st.prompt), outcomes: arr(st.outcomes).map((o) => ({ id: s((o as Wire).id), label: s((o as Wire).label), next: nextOrNull((o as Wire).next) })) };
    }
    if (st.kind === "action") return { ...base, kind: "action", action: s(st.action), next: nextOrNull(st.next) };
    return { ...base, kind: "code", description: s(st.description), tools: arr(st.tools).map(s), next: nextOrNull(st.next) };
  });
  const triggers = arr(w.triggers).map((x) => {
    const t = x as Wire;
    if (t.kind === "check") return { kind: "check", everyMinutes: Math.round(n(t.everyMinutes)), watch: s(t.watch), when: s(t.when) };
    if (t.kind === "message") return { kind: "message", from: "telegram", description: s(t.description) };
    return { kind: "schedule", every: t.every === "none" || !t.every ? "day" : t.every, at: s(t.at) || null, description: s(t.description) };
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
    actions: arr(w.actions).map((x) => ({ id: s((x as Wire).id), tool: (x as Wire).tool, description: s((x as Wire).description) })),
    steps,
    limits: { maxSteps: Math.round(n(limits.maxSteps)), maxRunSeconds: Math.round(n(limits.maxRunSeconds)), maxSpendUsd: n(limits.maxSpendUsd) },
  };
}

export const PLAN_AGENT_PROMPT = [
  "You plan an agent for boardofserv from the maker's interview. Answer with the whole agent as JSON in the given schema.",
  "Steps. code: data work in a sandbox (read sheets, fetch pages, search, compare, compute, remember); describe exactly what the code must do with its inputs and what it returns, and list only the tools it calls.",
  "decision: a judgement made by a model, with 2 to 6 outcomes, each naming the step it leads to. action: takes one declared action, using the step's inputs.",
  'A run starts at the first step. next is the next step\'s id, or "" when the run ends there.',
  "Inputs name values a step reads: settings, rules, memory, trigger, or an output of an earlier step. Outputs name what it adds.",
  `Tools: ${TOOL_NAMES.map((t) => `${t} (${TOOLS[t].summary})`).join("; ")}.`,
  "Every side effect (sheets.write, telegram.send, telegram.ask, wallet.pay) must be a declared action. Anything the maker said it must never do without asking goes through telegram.ask first.",
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
  const maxTokens = Number.isInteger(max) && max > 0 ? max : DEFAULT_PLAN_MAX_TOKENS;
  const messages: ChatMessage[] = [
    { role: "system", content: PLAN_AGENT_PROMPT },
    { role: "user", content: planRequest(input) },
  ];
  const calls: JsonResult[] = [];
  let errors: string[] = [];
  for (let attempt = 0; attempt < (opts.maxTries ?? MAX_PLAN_TRIES); attempt++) {
    const result = await completeJson(messages, { config: opts.config, schema: AGENT_PLAN_SCHEMA, maxTokens, signal: opts.signal, fetchImpl: opts.fetchImpl });
    calls.push(result);
    if (!result.content) {
      // No answer at all (every provider failed): another try won't help.
      errors = ["No model answered."];
      break;
    }
    let wire: unknown;
    try {
      wire = JSON.parse(result.content);
    } catch {
      errors = ["The answer was not JSON."];
      messages.push({ role: "assistant", content: result.content.slice(0, 8000) }, { role: "user", content: "That was not valid JSON. Send the whole plan again as JSON." });
      continue;
    }
    const checked = checkDefinition(wireToDefinition(wire as Wire));
    if (checked.ok) return { definition: checked.definition, errors: [], calls };
    errors = checked.errors;
    messages.push(
      { role: "assistant", content: result.content.slice(0, 12000) },
      { role: "user", content: `That plan has problems:\n${errors.map((e) => `- ${e}`).join("\n")}\nSend the whole corrected plan.` },
    );
  }
  return { definition: null, errors, calls };
}
