import "server-only";
import { completeJson, type ChatMessage, type JsonResult, type ModelConfig } from "../model";
import { ANSWER_LIMITS } from "../modelLimits";
import type { AgentDefinition } from "./definition";
import type { Diagnosis } from "./types";

// The fixer: SERV Reasoning reads a diagnosis (diagnosis.ts) and says what
// was wrong, as exactly one of four things, with what to do about it:
//
// - code: the step's code was wrong, or the brief it was written from. It
//   writes the step's brief again; Dolphin writes the code from it with the
//   review's reason beside it, and it is reviewed again.
// - plan: the steps were wrong. It says which steps to remove, merge or
//   add; only those are planned again, and only changed steps rebuilt.
// - test: the agent was right but its sample didn't fit it. It says what
//   the sample needs; the sample is made again by the platform's rules
//   (sample.ts), and the checks stay the platform's (test.ts).
// - unclear: only the maker can say. One plain question, with answers to
//   tap.
//
// The build (build.ts) applies the repair, never weakening what keeps the
// agent safe (guarded.ts), and goes round again until it passes, or the
// rounds or the build's model budget run out.

export const VERDICTS = ["code_wrong", "plan_wrong", "test_wrong", "unclear"] as const;
// The kinds of mistake, for lessons (lessons.ts): the same kind seen again
// and again becomes a rule for the planner and for Dolphin.
export const MISTAKES = [
  "invented_input",
  "nothing_to_do",
  "extra_question",
  "allowance_check",
  "wrong_tools",
  "missing_step",
  "extra_step",
  "wrong_value",
  "judgement_in_code",
  "summary",
  "keeps_place",
  "sheet_columns",
  "sample_payee",
  "sample_answers",
  "sample_items",
  "sample_dates",
  "setup",
  "other",
] as const;
export type Mistake = (typeof MISTAKES)[number];

const str = (description: string) => ({ type: "string", description });
// Flat, every field present, no nullable and no range keywords: SERV's
// strict json_schema.
export const FIXER_SCHEMA = {
  name: "agent_fix",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["verdict", "step", "why", "spec", "change", "sample", "question", "choices", "lesson", "kind"],
    properties: {
      verdict: { type: "string", enum: [...VERDICTS] },
      step: str('the id of the one step to fix, or ""'),
      why: str("what was wrong, in one or two plain sentences"),
      spec: str('code_wrong: the step\'s whole brief again, corrected: exactly what its code does with its inputs and what it returns; else ""'),
      change: str('plan_wrong: exactly which steps to remove, merge or add, by id, and nothing else; else ""'),
      sample: str('test_wrong: what the sample data must have that it didn\'t; else ""'),
      question: str('unclear: one plain question for the owner; else ""'),
      choices: { type: "array", items: { type: "string" }, description: "unclear: two to four short answers they can tap; else []" },
      lesson: str("one short rule, in plain words, that avoids this mistake next time"),
      kind: { type: "string", enum: [...MISTAKES] },
    },
  },
};

export const FIXER_PROMPT = [
  "You are the fixer for boardofserv, which builds automated agents from what a maker describes. A build failed. You get its diagnosis: the stage it failed at, the step, what happened, what was expected and the evidence (the plan, the step's brief, its code, the code review's reason, the check that failed, the test run line by line, and the sample data the test ran on). Answer with JSON in the given schema.",
  "Say what was wrong, as exactly one verdict:",
  "- code_wrong: the step's code didn't do what it should, or its brief told it wrong. For example a brief that says to return null when there is nothing to do for a step that always acts (a weekly payment, a morning message), or code that reads inputs or flags its brief never gave (input.skip, input.cancelled). Give in spec the corrected brief for that one step: exactly what its code does with the inputs it reads and the shape of what it returns. Name the step in step.",
  "- plan_wrong: the steps themselves were wrong: a step missing, one too many (a question the maker never asked for, an allowance or balance check), a value read that nothing makes, a comparison judged by a model. Say in change exactly which steps to remove, merge or add, by id, and nothing else.",
  "- test_wrong: the agent was right, but the sample it was tried on didn't fit it: no payee by the name it pays, too little allowance, no yes to its question, rows dated another day, columns the steps don't name, three items for an agent that handles one. Say in sample what the sample must have. Never ask to skip, change or loosen a check: the platform picks the checks.",
  "- unclear: only the maker can say: which payee, what target, which sheet, what counts as done. Ask one plain question in question, a sentence a first-time maker understands, with two to four short answers to tap in choices. Never ask them to describe a fix, read an error or look at code.",
  "What you can never do: remove or weaken a question to the owner, a payment's approval, a safety check, a code review, a budget, a limit, a rule or a check; change the maker's numbers, conditions, schedule or rules. A payment (wallet.pay) already checks the allowance and asks the owner first unless their auto limit covers it, and pays a saved payee by name: never add an allowance check or a question of your own before one.",
  "A step that failed on the sample (the run stopped there, or it returned the wrong shape) has wrong code or a wrong brief, never a wrong test. A step's code always returns an object with its outputs by name: a corrected brief says what each output holds, never that the function returns a bare value.",
  "Prefer the smallest fix: a step's brief over the steps, the steps over a question. Ask only what nobody but the maker can know.",
  "Also give lesson, one short general rule that would have avoided this (not about this agent alone), and kind, the kind of mistake.",
  "Never use em dashes.",
].join("\n");

// The diagnosis as SERV reads it: the evidence that is there, each part
// short enough to leave room for the answer.
export function fixerRequest(dx: Diagnosis, o: { lessons?: string[]; tried?: string[]; interview?: string | null } = {}): string {
  const e = dx.evidence;
  const part = (label: string, text: string | null | undefined, max = 6000) => (text ? [`${label}:`, text.length > max ? `${text.slice(0, max - 3)}...` : text, ""] : []);
  const plan = e.plan ? JSON.stringify(e.plan as AgentDefinition) : null;
  return [
    `Stage: ${dx.stage}`,
    `Step: ${dx.step ? `${dx.step.title} (${dx.step.id})` : "none"}`,
    `What happened: ${dx.failure}`,
    `What was expected: ${dx.expected}`,
    "",
    ...part("What the maker asked for", o.interview, 3000),
    ...part("The plan", plan, 12000),
    ...part("The step's brief", e.spec),
    ...part("Its code", e.code, 5000),
    ...part("The code review said", e.review),
    ...part("The check that failed", e.check),
    ...part("The test run", e.trace.join("\n"), 6000),
    ...part("The sample data it ran on", e.sample ? JSON.stringify(e.sample) : null, 5000),
    ...part("More reasons", e.errors.join("\n"), 3000),
    ...part("Already tried on this build, without success", o.tried?.join("\n"), 2000),
    ...part("Rules learned from earlier builds", o.lessons?.map((l) => `- ${l}`).join("\n"), 2000),
  ].join("\n");
}

const TECHNICAL = /\b(?:code|function|returns?|null|undefined|variable|json|array|object|boolean|string|input|output|memory\.\w+|settings\.\w+)\b|\b[a-z]+_[a-z_]+\b/;

export type FixVerdict = {
  verdict: (typeof VERDICTS)[number];
  step: string | null;
  why: string;
  spec: string;
  change: string;
  sample: string;
  question: string;
  choices: string[];
  lesson: string;
  kind: Mistake;
};

const text = (v: unknown, max = 2000) => (typeof v === "string" ? v.trim().slice(0, max) : "");

// SERV's answer, or null when it isn't one: a verdict without what it
// needs (a corrected brief, a change, a question) is no answer.
export function readVerdict(content: string | null): FixVerdict | null {
  let w: Record<string, unknown>;
  try {
    w = JSON.parse(content ?? "") as Record<string, unknown>;
  } catch {
    return null;
  }
  const verdict = VERDICTS.find((v) => v === w.verdict);
  if (!verdict) return null;
  const out: FixVerdict = {
    verdict,
    step: text(w.step, 40) || null,
    why: text(w.why, 600),
    spec: text(w.spec, 800),
    change: text(w.change, 1200),
    sample: text(w.sample, 800),
    question: text(w.question, 300),
    choices: (Array.isArray(w.choices) ? w.choices : []).map((c) => text(c, 60)).filter(Boolean).slice(0, 4),
    lesson: text(w.lesson, 300),
    kind: MISTAKES.find((k) => k === w.kind) ?? "other",
  };
  if (verdict === "code_wrong" && !out.spec) return null;
  if (verdict === "plan_wrong" && !out.change) return null;
  if (verdict === "unclear" && (!out.question || out.choices.length < 2)) return null;
  // A question a first-time maker can answer: about the job, never about
  // code (live, SERV once asked whether a step "returns last_position").
  if (verdict === "unclear" && TECHNICAL.test(`${out.question} ${out.choices.join(" ")}`)) return null;
  return out;
}

export async function askFixer(
  dx: Diagnosis,
  serv: ModelConfig,
  o: { lessons?: string[]; tried?: string[]; interview?: string | null; signal?: AbortSignal; fetchImpl?: typeof fetch } = {},
): Promise<{ verdict: FixVerdict | null; call: JsonResult }> {
  const messages: ChatMessage[] = [
    { role: "system", content: FIXER_PROMPT },
    { role: "user", content: fixerRequest(dx, o) },
  ];
  const config = { ...serv, firstTokenTimeoutMs: Math.max(serv.firstTokenTimeoutMs, 90_000) };
  const call = await completeJson(messages, { config, purpose: "agent_fix", schema: FIXER_SCHEMA, maxTokens: ANSWER_LIMITS.agent_fix, signal: o.signal ?? new AbortController().signal, fetchImpl: o.fetchImpl });
  return { verdict: readVerdict(call.content), call };
}
