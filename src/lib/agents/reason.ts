import "server-only";
import { completeJson, modelPrices, type ChatMessage, type JsonResult, type ModelConfig } from "../model";
import { fixDashes } from "../dashes";
import { TOOL_ARGS, type ReasonType } from "./toolbox";
import { DATA_RULE, wrapData } from "./untrusted";

// SERV Reasoning inside a code step (the serv.reason tool): the step's code
// says what to judge or write and hands over the values; SERV answers with
// the fields the code named, each of its type. A judgement with no fixed
// outcomes (a score from 1 to 10 with its reasons) or words for people (a
// reply, feedback, a line for the day) is made here, by the model, at run
// time, never worked out by a rule of thumb in the code.
//
// What the code hands over can hold anything the run read (a submission,
// a page, a message), so it always goes in as fenced data, never as
// instructions. The rules sit in the user turn under a one-line system
// message: SERV's gateway cuts answers that restate a system message.

export type ReasonArgs = { task: string; data?: unknown; answer?: Record<string, ReasonType> };

export type Reasoned = { ok: true; result: Record<string, unknown>; costUsd: number; model: string | null } | { ok: false; error: string; costUsd: number; infra: boolean };

export const REASON_SYSTEM = "You do one piece of reasoning for one step of an automated agent. Answer with JSON in the given schema.";

const RULES = [
  "Do the task below, from the values given and nothing else.",
  "A score or verdict comes with reasons that point at what is actually in the values (what is there, what is missing), never at their length or word counts.",
  "Words for people are plain, short and specific to the values.",
  DATA_RULE,
  "Never use em dashes.",
].join(" ");

const FIELD: Record<ReasonType, Record<string, unknown>> = {
  text: { type: "string" },
  number: { type: "number" },
  boolean: { type: "boolean" },
  list: { type: "array", items: { type: "string" } },
};

// The arguments as the code sent them, checked: what to do, or why not.
export function readReasonArgs(raw: unknown): { ok: true; args: ReasonArgs } | { ok: false; error: string } {
  const parsed = TOOL_ARGS["serv.reason"].safeParse(raw);
  if (!parsed.success) return { ok: false, error: "serv.reason was called wrongly: it takes { task, data?, answer? }, answer naming up to 8 fields as text, number, boolean or list." };
  return { ok: true, args: parsed.data as ReasonArgs };
}

export function reasonFields(args: ReasonArgs): Record<string, ReasonType> {
  return args.answer && Object.keys(args.answer).length ? args.answer : { text: "text" };
}

export function reasonRequest(args: ReasonArgs): string {
  const fields = reasonFields(args);
  return [
    RULES,
    "",
    `Task: ${args.task}`,
    "",
    `Answer with: ${Object.entries(fields)
      .map(([k, t]) => `${k} (${t === "list" ? "a list of short texts" : t})`)
      .join(", ")}.`,
    "",
    wrapData("the values the step works from", args.data ?? null, 16000),
  ].join("\n");
}

export async function askReason(args: ReasonArgs, serv: ModelConfig, opts: { signal?: AbortSignal; fetchImpl?: typeof fetch } = {}): Promise<JsonResult> {
  const fields = reasonFields(args);
  const messages: ChatMessage[] = [
    { role: "system", content: REASON_SYSTEM },
    { role: "user", content: reasonRequest(args) },
  ];
  const schema = {
    name: "reasoning",
    schema: { type: "object", additionalProperties: false, required: Object.keys(fields), properties: Object.fromEntries(Object.entries(fields).map(([k, t]) => [k, FIELD[t]])) },
  };
  // Not streamed: a minute, not a reply's first-token wait.
  const config = { ...serv, firstTokenTimeoutMs: Math.max(serv.firstTokenTimeoutMs, 60_000) };
  return completeJson(messages, { config, purpose: "reason", schema, signal: opts.signal ?? new AbortController().signal, fetchImpl: opts.fetchImpl });
}

// SERV's answer, with every field asked for and of its type, or why not
// (an answer that didn't come is worth another try).
export function readReason(args: ReasonArgs, call: JsonResult): Reasoned {
  const price = modelPrices().serv;
  const costUsd = ((call.promptTokens ?? 0) * price.input + (call.completionTokens ?? 0) * price.output) / 1_000_000;
  let parsed: Record<string, unknown> | null = null;
  try {
    const v = call.content ? (JSON.parse(call.content) as unknown) : null;
    parsed = v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    parsed = null;
  }
  if (!parsed) return { ok: false, error: "SERV didn't answer just now.", costUsd, infra: true };
  const out: Record<string, unknown> = {};
  for (const [k, t] of Object.entries(reasonFields(args))) {
    const v = parsed[k];
    const fits = t === "text" ? typeof v === "string" : t === "number" ? typeof v === "number" && Number.isFinite(v) : t === "boolean" ? typeof v === "boolean" : Array.isArray(v) && v.every((x) => typeof x === "string");
    if (!fits) return { ok: false, error: `SERV's answer had no ${k} just now.`, costUsd, infra: true };
    out[k] = typeof v === "string" ? fixDashes(v).slice(0, 4000) : Array.isArray(v) ? (v as string[]).map((x) => fixDashes(x).slice(0, 1000)) : v;
  }
  return { ok: true, result: out, costUsd, model: call.model };
}
