import type { AgentDefinition, AgentStep } from "./definition";
import { emptyHeal, type BenchData, type CheckId, type Diagnosis, type HealLog, type RunEvent, type StepCode, type TestResult } from "./types";

// Diagnosis: every failure of a build, as one record with everything there
// is to act on. Where it failed (the stage: the plan, a step's code, the
// self test, the setup or going live, and the step), what happened in the
// system's own words (the plan checker's reasons, the code review's
// reason, the check that failed), what was expected instead, and the
// evidence: the plan, the step's spec, its code, the test run step by step
// and the sample data it ran on. The fixer (fixer.ts) reads it; the details
// view shows it. Nothing here calls a model.

const now = () => new Date().toISOString();

// A value as short text, for a trace line.
function clip(v: unknown, n = 240): string {
  const t = typeof v === "string" ? v : (JSON.stringify(v) ?? "null");
  return t.length > n ? `${t.slice(0, n - 3)}...` : t;
}

// What a step had to do, as the fixer reads it.
export function specOf(step: AgentStep, d: AgentDefinition): string {
  const io = `Reads: ${step.inputs.join(", ") || "nothing"}. Makes: ${step.outputs.join(", ") || "nothing"}.`;
  switch (step.kind) {
    case "code":
      return `Code step "${step.title}" (${step.id}): ${step.description}\n${io}\nTools: ${step.tools.join(", ") || "none"}.`;
    case "decision": {
      const by = step.from ? ` It goes by the value ${step.from}.` : step.each ? ` It judges each item of ${step.each}.` : "";
      return `Decision "${step.title}" (${step.id}): ${step.prompt}${by}\nOutcomes: ${step.outcomes.map((o) => `${o.id} (${o.label}) to ${o.next ?? "the end"}`).join("; ")}.\n${io}`;
    }
    case "action": {
      const a = d.actions.find((x) => x.id === step.action);
      return `Action "${step.title}" (${step.id}): ${a ? `${a.tool}, ${a.description}` : `the undeclared action ${step.action}`}.\n${io}`;
    }
    case "loop":
      return `Loop "${step.title}" (${step.id}): goes through ${step.over}, each item called ${step.item}, starting at ${step.body}; gathers ${step.gather.map((g) => `${g.from} into ${g.into}`).join(", ") || "nothing"}.\n${io}`;
  }
}

const stepOf = (d: AgentDefinition | null, id: string | null | undefined) => (d && id ? (d.steps.find((s) => s.id === id) ?? null) : null);
const named = (s: AgentStep | null) => (s ? { id: s.id, title: s.title } : null);

// A test run, one short line per step and tool call, in order.
export function traceOf(events: RunEvent[], max = 80): string[] {
  const lines: string[] = [];
  for (const e of events) {
    if (e.type === "step") lines.push(`step ${e.stepId} reads ${clip(e.input, 400)}`);
    else if (e.type === "tool") lines.push(`  ${e.tool}(${clip(e.args, 300)}) ${e.error ? `failed: ${e.error}` : `gave ${clip(e.result, 300)}`}`);
    else if (e.type === "step_done") lines.push(`  ${e.stepId} ${e.status}${e.outcome ? `, went ${e.outcome}` : ""}${e.note ? ` (${e.note})` : ""}${e.status === "ok" && e.output !== null ? `: ${clip(e.output, 300)}` : ""}`);
    else if (e.type === "end") lines.push(`end: ${e.status}, ${e.reason}`);
  }
  return lines.length > max ? [...lines.slice(0, max - 1), `(${lines.length - max + 1} more lines)`] : lines;
}

const empty = (): Diagnosis["evidence"] => ({ plan: null, spec: null, code: null, review: null, check: null, trace: [], sample: null, errors: [] });

// The plan didn't come together: the checker's reasons.
export function planDiagnosis(errors: string[], current: AgentDefinition | null): Diagnosis {
  return {
    stage: "plan",
    step: null,
    failure: errors.length ? errors.join(" ") : "No plan came of it.",
    expected: "Steps that check out: every step joined up, each reading what a step before it made, judgement in decisions and counting in code.",
    evidence: { ...empty(), plan: current, errors },
    at: now(),
  };
}

// A step's code didn't pass its check: the plain checks' or the review's
// reason, and the code it was given.
export function codeDiagnosis(d: AgentDefinition, stepId: string, entry: StepCode): Diagnosis {
  const step = stepOf(d, stepId);
  return {
    stage: "code",
    step: named(step),
    failure: entry.note ?? "Its code didn't pass its check.",
    expected: "Code that does exactly what the step says with only its inputs, returns exactly its outputs, calls only its tools, and passes the review.",
    evidence: { ...empty(), plan: d, spec: step ? specOf(step, d) : null, code: entry.source, review: entry.note },
    at: now(),
  };
}

// What each check expects.
const EXPECTED: Record<CheckId, string> = {
  ran: "It runs through every step on its sample without stopping.",
  tool_error: "Every call it makes works on the sample: no error is passed over.",
  did_job: "On a sample made for it to work on, it does its job at least once.",
  summary: "The summary it sends after going through the list names every item, or says how many there were.",
  write_back: "It writes each result into the row it belongs to, never as a new row of the tab it reads.",
  second_run: "Run again on what the first run left, it leaves the items it already did alone.",
  said_no: "When the owner says no, it pays nothing and sends nothing more.",
  read_nothing: "Each step that reads (a page, a sheet, a search) gets what it reads on its sample, and passes on only what it read. A form's link or a page behind a sign-in can't be read: its answers come from the sheet they go to.",
};

// The self test failed: the check, its sentence, the run and its sample.
export function testDiagnosis(d: AgentDefinition, result: TestResult, events: RunEvent[], code: Record<string, StepCode>): Diagnosis {
  const problem = result.problems[0];
  const step = stepOf(d, problem?.step);
  const check = problem?.check ?? null;
  // Where the run stopped, in the run's own words ("It didn't return an
  // object."), beside the plain sentence.
  const stopped = [...events].reverse().find((e): e is Extract<RunEvent, { type: "step_done" }> => e.type === "step_done" && e.status === "failed" && (!step || e.stepId === step.id));
  return {
    stage: "test",
    step: named(step),
    failure: `${problem?.text ?? result.story}${check === "ran" && stopped?.note ? ` ${stopped.note}` : ""}`,
    expected: check ? EXPECTED[check] : "It passes its test.",
    evidence: {
      ...empty(),
      plan: d,
      spec: step ? specOf(step, d) : null,
      code: step?.kind === "code" ? (code[step.id]?.source ?? null) : null,
      check,
      trace: traceOf(events),
      sample: (result.sample ?? null) as BenchData | null,
      errors: result.problems.slice(1).map((p) => p.text),
    },
    at: now(),
  };
}

// The review before going live held it: its blocking finding, on the step
// it names.
export function liveDiagnosis(d: AgentDefinition, findings: { step: string; severity: string; finding: string }[], code: Record<string, StepCode>): Diagnosis {
  const blocking = findings.filter((f) => f.severity === "blocking");
  const step = d.steps.find((s) => s.title === blocking[0]?.step) ?? null;
  return {
    stage: "live",
    step: named(step),
    failure: blocking.map((f) => f.finding).join(" ") || "The review before going live held it.",
    expected: "Code that does only what the agent and each step say they do, with nothing unsafe in it.",
    evidence: { ...empty(), plan: d, spec: step ? specOf(step, d) : null, code: step?.kind === "code" ? (code[step.id]?.source ?? null) : null, errors: blocking.map((f) => `${f.step}: ${f.finding}`) },
    at: now(),
  };
}

// Setting it up failed: what the setup said about each answer.
export function connectDiagnosis(d: AgentDefinition, errors: Record<string, string>): Diagnosis {
  return {
    stage: "connect",
    step: null,
    failure: Object.values(errors).join(" ") || "Its setup didn't take.",
    expected: "Answers its setup accepts, for every question it asks.",
    evidence: { ...empty(), plan: d, errors: Object.entries(errors).map(([k, v]) => `${k}: ${v}`) },
    at: now(),
  };
}

// The heal log with this diagnosis as a new round, not acted on yet.
export function withDiagnosis(heal: HealLog | null | undefined, diagnosis: Diagnosis): HealLog {
  const log = heal ?? emptyHeal();
  return { ...log, rounds: [...log.rounds, { diagnosis, verdict: null, why: "", repair: "", outcome: "pending", at: diagnosis.at }] };
}
