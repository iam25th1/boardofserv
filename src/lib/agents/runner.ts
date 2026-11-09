import "server-only";
import { completeJson, modelPrices, type ChatMessage, type JsonResult, type ModelConfig } from "../model";
import { RUN_VALUES, type ActionStepDef, type AgentDefinition, type AgentStep, type DecisionStepDef, type ToolName } from "./definition";
import { runInSandbox, DEFAULT_TIME_MS } from "./sandbox";
import { MockTools, ToolError, TOOL_ARGS, TOOLS } from "./toolbox";
import type { BenchData, RunEvent, RunState, StepCode } from "./types";

export type { JournalEntry, RunEvent, RunState } from "./types";

// Running an agent's steps. One loop serves the test bench and real jobs:
// it starts at the first step with the bag holding settings, rules (typed),
// memory and trigger, and follows the steps:
//
// - code: the step's approved code runs in the sandbox with its inputs and
//   only its own tools.
// - decision: SERV decides, within the run's spend limit; on a dry run the
//   bench's recorded answer is taken instead, and no model is called.
// - action: the declared action's tool is called, with the step's first
//   input when that is already the tool's arguments; a message to the owner
//   can be made from any inputs.
//
// It stops at the end of the steps, at the first failure, or at the
// agent's limits on steps, time and spend, and says which. Every step, tool
// call and result is an event.
//
// On the bench every tool is a mock answering from the bench's data and the
// whole run happens at once (runAgent). A job (runtime/jobs.ts) runs the
// same loop on its own tools, and can stop part way and pick up later:
//
// - Where it is (the step, the bag, its counts) is a RunState, saved after
//   every step and every tool call.
// - A tool call that must wait for the owner (a question, an action over a
//   rule's limit) pauses the run there. When the answer comes, the step runs
//   again from its start, and every tool call it had already made is
//   answered from the step's journal instead of being made again, so
//   nothing happens twice. The same replay lets a job pick up after a
//   server restart.
// - A failure outside the agent (SERV not answering, the sandbox faulting,
//   a page that timed out) can be tried again later; the agent's own logic
//   failing can't.

// What a paused run waits for: a question to its owner, with the answers
// they can give.
export interface Ask {
  kind: "ask" | "over_limit";
  question: string;
  choices: string[];
}

// A tool call that must wait for the owner.
export class Paused extends Error {
  constructor(readonly ask: Ask) {
    super("Waiting for the owner.");
    this.name = "Paused";
  }
}

// The owner said no to an action over a limit, or didn't answer in time.
export class Declined extends Error {
  constructor(readonly answer: string | null) {
    super(answer === null ? "No answer came in time." : "The owner said no.");
    this.name = "Declined";
  }
}

// Something outside the agent failed: worth another try later.
export class InfraError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InfraError";
  }
}

// The live tool calls of a run: the bench's mocks, or a job's own tools.
// `approval` is the owner's answer when the call waited for one.
export interface ToolHost {
  call(step: AgentStep, tool: ToolName, args: unknown, approval?: { answer: string | null }): Promise<unknown>;
}

export type Decided =
  | { ok: true; outcome: string; note: string | null; costUsd: number; model: string | null }
  | { ok: false; note: string; reason: string; costUsd: number; infra: boolean };

export type EndCause = "end" | "logic" | "limit" | "stop" | "declined" | "infra";

export type EngineResult =
  | { kind: "end"; status: "done" | "failed" | "stopped"; cause: EndCause; reason: string }
  | { kind: "wait"; stepId: string; ask: Ask; index: number }
  | { kind: "retry"; reason: string };

export interface EngineOptions {
  definition: AgentDefinition;
  code: Record<string, StepCode>;
  state: RunState;
  tools: ToolHost;
  decide: (step: DecisionStepDef, input: Record<string, unknown>) => Promise<Decided>;
  onEvent: (e: RunEvent) => void;
  // Saved after every step and every tool call (jobs).
  save?: (state: RunState) => Promise<void>;
  // Checked before each step: why the run must stop now (the owner stopped it).
  shouldStop?: () => Promise<string | null>;
  // Checked before each model call: why it may not spend now (a daily cap).
  canSpend?: () => Promise<string | null>;
  // Hand failures outside the agent back to be tried again (jobs), rather
  // than ending the run (the bench).
  retryInfra?: boolean;
  // A dry run on the bench: decisions cost nothing, so no spend limit.
  dryRun?: boolean;
  signal?: AbortSignal;
}

// A rule's value as code sees it: numbers as numbers, lists as arrays.
export function ruleValue(type: string, raw: string): unknown {
  const t = raw.trim();
  if (type === "number" || type === "usdc") return t === "" ? null : Number(t);
  if (type === "boolean") return ["true", "yes", "1", "on"].includes(t.toLowerCase());
  if (type === "list") return t ? t.split(",").map((x) => x.trim()).filter(Boolean) : [];
  return t;
}

// The rules as code sees them: the given values over the maker's defaults.
export function typedRules(d: AgentDefinition, values: Record<string, string>): Record<string, unknown> {
  return Object.fromEntries(d.rules.map((r) => [r.key, ruleValue(r.type, values[r.key] ?? r.value)]));
}

// A run about to start at the first step.
export function startState(d: AgentDefinition, bag: Record<string, unknown>): RunState {
  return { at: d.steps[0]?.id ?? null, bag, steps: 0, ms: 0, costUsd: 0, journal: [], resumed: false };
}

function pick(bag: Record<string, unknown>, names: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(names.map((n) => [n, bag[n] ?? null]));
}

// Words for a message to the owner, from whatever the step reads.
function summary(input: Record<string, unknown>): string {
  return Object.entries(input)
    .map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join("\n")
    .slice(0, 3000);
}

// The tool arguments an action step is taken with.
export function actionArgs(step: ActionStepDef, tool: keyof typeof TOOL_ARGS, input: Record<string, unknown>): { ok: true; args: unknown } | { ok: false; why: string } {
  const first = step.inputs[0] ? input[step.inputs[0]] : undefined;
  if (TOOL_ARGS[tool].safeParse(first).success) return { ok: true, args: first };
  if (tool === "telegram.send") return { ok: true, args: { text: summary(input) || step.title } };
  if (tool === "telegram.ask") return { ok: true, args: { question: `${step.title}\n${summary(input)}`.trim(), choices: ["Yes", "No"] } };
  return { ok: false, why: `This action needs its first input to be ${tool}'s arguments: ${TOOLS[tool].signature}` };
}

// Arguments compared for a replay: the same call, whatever the key order.
function same(a: unknown, b: unknown): boolean {
  const norm = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(norm) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, norm((v as Record<string, unknown>)[k])])) : v;
  return JSON.stringify(norm(a)) === JSON.stringify(norm(b));
}

const DIVERGED = "It went a different way when it ran again, so it was stopped before anything could happen twice.";

type Invoked =
  | { kind: "ok"; result: unknown }
  | { kind: "error"; message: string; infra: boolean }
  | { kind: "paused"; ask: Ask }
  | { kind: "declined"; answer: string | null }
  | { kind: "diverged" };

export async function runSteps(o: EngineOptions): Promise<EngineResult> {
  const { definition: d, state } = o;
  const byId = new Map(d.steps.map((s) => [s.id, s]));
  let segment = Date.now();
  const elapsed = () => state.ms + (Date.now() - segment);
  const flush = () => {
    state.ms = elapsed();
    segment = Date.now();
  };
  const end = (status: "done" | "failed" | "stopped", cause: EndCause, reason: string): EngineResult => {
    flush();
    state.at = null;
    state.journal = [];
    state.resumed = false;
    return { kind: "end", status, cause, reason };
  };

  while (state.at) {
    const step = byId.get(state.at);
    if (!step) return end("failed", "logic", `It went to a step that isn't there ("${state.at}").`);
    const stop = o.signal?.aborted ? "Stopped." : ((await o.shouldStop?.()) ?? null);
    if (stop) return end("stopped", "stop", stop);
    if (!state.resumed && state.steps >= d.limits.maxSteps) return end("stopped", "limit", `It reached its limit of ${d.limits.maxSteps} steps.`);
    const left = d.limits.maxRunSeconds * 1000 - elapsed();
    if (left <= 0) return end("stopped", "limit", `It reached its limit of ${d.limits.maxRunSeconds} seconds.`);
    if (!state.resumed) {
      state.steps += 1;
      state.journal = [];
      state.resumed = true;
      await o.save?.(state);
    }
    const input = pick(state.bag, step.inputs);
    o.onEvent({ type: "step", stepId: step.id, input });
    const t0 = Date.now();
    const done = (status: "ok" | "failed", output: unknown, outcome: string | null, note: string | null, costUsd = 0, model: string | null = null) =>
      o.onEvent({ type: "step_done", stepId: step.id, status, output, outcome, note, ms: Date.now() - t0, costUsd, ...(model ? { model } : {}) });
    const pause = (ask: Ask, index: number): EngineResult => {
      flush();
      o.onEvent({ type: "wait", stepId: step.id, question: ask.question, choices: ask.choices });
      return { kind: "wait", stepId: step.id, ask, index };
    };

    // One tool call: answered from the journal when the step made it
    // before, else made now and written down.
    let cursor = 0;
    const invoke = async (tool: ToolName, args: unknown): Promise<Invoked> => {
      const i = cursor++;
      const prior = state.journal[i];
      if (prior && (prior.tool !== tool || !same(prior.args, args))) return { kind: "diverged" };
      const emit = (result: unknown, error: string | null) => o.onEvent({ type: "tool", stepId: step.id, tool, args, result, error });
      if (prior && !prior.waiting && (prior.result !== undefined || prior.error)) {
        emit(prior.result ?? null, prior.error ?? null);
        return prior.error ? { kind: "error", message: prior.error, infra: false } : { kind: "ok", result: prior.result };
      }
      try {
        const result = await o.tools.call(step, tool, args, prior?.approval);
        state.journal[i] = { tool, args, result: result ?? null, ...(prior?.approval ? { approval: prior.approval } : {}) };
        await o.save?.(state);
        emit(result, null);
        return { kind: "ok", result };
      } catch (err) {
        if (err instanceof Paused) {
          state.journal[i] = { tool, args, waiting: true };
          await o.save?.(state);
          return { kind: "paused", ask: err.ask };
        }
        if (err instanceof Declined) {
          state.journal[i] = { tool, args, approval: { answer: err.answer }, result: null };
          await o.save?.(state);
          emit(null, err.message);
          return { kind: "declined", answer: err.answer };
        }
        const infra = err instanceof InfraError;
        const message = err instanceof Error ? err.message : `${tool} failed.`;
        state.journal[i] = { tool, args, result: null, error: message, ...(infra ? { infra } : {}) };
        await o.save?.(state);
        emit(null, message);
        return { kind: "error", message, infra };
      }
    };

    let next: string | null = null;
    if (step.kind === "code") {
      const entry = o.code[step.id];
      if (!entry?.source || entry.status !== "approved") {
        done("failed", null, null, "Its code isn't approved yet.");
        return end("failed", "logic", `"${step.title}" has no approved code yet.`);
      }
      const halt = new AbortController();
      let paused: { ask: Ask; index: number } | null = null;
      let diverged = false;
      let infraFault = false;
      const result = await runInSandbox(entry.source, input, {
        allowed: step.tools,
        timeMs: Math.min(DEFAULT_TIME_MS, left),
        signal: halt.signal,
        call: async (tool, args) => {
          const index = cursor;
          const r = await invoke(tool, args);
          if (r.kind === "ok") return r.result;
          if (r.kind === "declined") {
            // In code, a question nobody answered in time is a null answer.
            if (tool === "telegram.ask") return { answer: null };
            throw new ToolError(tool, r.answer === null ? "The owner didn't answer in time, so it wasn't done." : "The owner said no, so it wasn't done.");
          }
          if (r.kind === "error") {
            if (r.infra) infraFault = true;
            throw new ToolError(tool, r.message);
          }
          if (r.kind === "paused") paused = { ask: r.ask, index };
          else diverged = true;
          halt.abort();
          return new Promise(() => {});
        },
      });
      if (paused) {
        const p = paused as { ask: Ask; index: number };
        return pause(p.ask, p.index);
      }
      if (diverged) {
        done("failed", null, null, DIVERGED);
        return end("failed", "logic", `"${step.title}" failed: ${DIVERGED}`);
      }
      if (!result.ok) {
        const infra = infraFault || result.error === "The sandbox stopped it.";
        done("failed", null, null, result.error);
        if (infra && o.retryInfra) return { kind: "retry", reason: `"${step.title}" failed: ${result.error}` };
        return end("failed", infra ? "infra" : "logic", `"${step.title}" failed: ${result.error}`);
      }
      const out = result.output;
      if (!out || typeof out !== "object" || Array.isArray(out)) {
        done("failed", out, null, "It didn't return an object.");
        return end("failed", "logic", `"${step.title}" didn't return an object.`);
      }
      const missing = step.outputs.filter((k) => !(k in out));
      if (missing.length) {
        done("failed", out, null, `It didn't return ${missing.join(", ")}.`);
        return end("failed", "logic", `"${step.title}" didn't return ${missing.join(", ")}.`);
      }
      for (const k of step.outputs) if (!(RUN_VALUES as readonly string[]).includes(k)) state.bag[k] = (out as Record<string, unknown>)[k];
      done("ok", pick(out as Record<string, unknown>, step.outputs), null, null);
      next = step.next;
    } else if (step.kind === "decision") {
      if (!o.dryRun && state.costUsd >= d.limits.maxSpendUsd) {
        done("failed", null, null, "The run's spend limit is reached.");
        return end("stopped", "limit", `It reached its spend limit of $${d.limits.maxSpendUsd}.`);
      }
      const no = (await o.canSpend?.()) ?? null;
      if (no) {
        done("failed", null, null, no);
        return end("stopped", "limit", no);
      }
      const r = await o.decide(step, input);
      state.costUsd += r.costUsd;
      if (!r.ok) {
        done("failed", null, null, r.note, r.costUsd);
        if (r.infra && o.retryInfra) return { kind: "retry", reason: r.reason };
        return end("failed", r.infra ? "infra" : "logic", r.reason);
      }
      const outcome = step.outcomes.find((x) => x.id === r.outcome)!;
      done("ok", { outcome: outcome.id, label: outcome.label }, outcome.id, r.note, r.costUsd, r.model);
      next = outcome.next;
    } else {
      const action = d.actions.find((a) => a.id === step.action);
      if (!action) {
        done("failed", null, null, "Its action isn't declared.");
        return end("failed", "logic", `"${step.title}" takes an action that isn't declared.`);
      }
      const args = actionArgs(step, action.tool, input);
      if (!args.ok) {
        done("failed", null, null, args.why);
        return end("failed", "logic", `"${step.title}" failed: ${args.why}`);
      }
      const r = await invoke(action.tool, args.args);
      if (r.kind === "paused") return pause(r.ask, 0);
      if (r.kind === "diverged") {
        done("failed", null, null, DIVERGED);
        return end("failed", "logic", `"${step.title}" failed: ${DIVERGED}`);
      }
      if (r.kind === "error") {
        done("failed", null, null, r.message);
        if (r.infra && o.retryInfra) return { kind: "retry", reason: `"${step.title}" failed: ${r.message}` };
        return end("failed", r.infra ? "infra" : "logic", `"${step.title}" failed: ${r.message}`);
      }
      if (r.kind === "declined") {
        const said = r.answer === null ? "No answer came in time" : "You said no";
        done("failed", null, null, `${said}.`);
        return end("stopped", "declined", `${said} at "${step.title}", so the job stopped there.`);
      } else {
        if (step.outputs[0]) state.bag[step.outputs[0]] = r.result;
        done("ok", r.result, null, null);
        next = step.next;
      }
    }
    state.at = next;
    state.journal = [];
    state.resumed = false;
    flush();
    await o.save?.(state);
  }
  return end("done", "end", "It reached the end of its steps.");
}

// The bench and the job make a decision the same way.

const DECISION_PROMPT = "You make one decision in a run of an automated agent. Pick exactly one of the outcomes, from the values given. Never use em dashes.";

export async function askServ(step: DecisionStepDef, input: Record<string, unknown>, serv: ModelConfig, opts: { signal?: AbortSignal; fetchImpl?: typeof fetch }): Promise<JsonResult> {
  const messages: ChatMessage[] = [
    { role: "system", content: DECISION_PROMPT },
    {
      role: "user",
      content: [step.prompt, "", "Outcomes:", ...step.outcomes.map((o) => `- ${o.id}: ${o.label}`), "", "Values:", JSON.stringify(input).slice(0, 12000)].join("\n"),
    },
  ];
  const schema = {
    name: "decision",
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["outcome", "reason"],
      properties: { outcome: { type: "string", enum: step.outcomes.map((o) => o.id) }, reason: { type: "string", description: "one short sentence" } },
    },
  };
  // Not streamed: half a minute, not a reply's first-token wait.
  const config = { ...serv, firstTokenTimeoutMs: Math.max(serv.firstTokenTimeoutMs, 30_000) };
  return completeJson(messages, { config, schema, maxTokens: 200, signal: opts.signal ?? new AbortController().signal, fetchImpl: opts.fetchImpl });
}

export function costOf(call: JsonResult): number {
  const price = modelPrices().serv;
  return ((call.promptTokens ?? 0) * price.input + (call.completionTokens ?? 0) * price.output) / 1_000_000;
}

// SERV's answer as a decision: the outcome it picked, or why there is none.
export function readDecision(step: DecisionStepDef, call: JsonResult): Decided {
  const costUsd = costOf(call);
  let parsed: { outcome?: string; reason?: string } | null = null;
  try {
    parsed = call.content ? (JSON.parse(call.content) as { outcome?: string; reason?: string }) : null;
  } catch {
    parsed = null;
  }
  const found = step.outcomes.find((x) => x.id === parsed?.outcome);
  if (!found) return { ok: false, note: "SERV couldn't decide just now.", reason: `"${step.title}" got no decision from SERV.`, costUsd, infra: true };
  return { ok: true, outcome: found.id, note: parsed?.reason?.slice(0, 300) ?? null, costUsd, model: call.model };
}

// One run on the test bench: every tool a mock, all at once.

export interface RunOptions {
  definition: AgentDefinition;
  code: Record<string, StepCode>;
  bench: BenchData;
  dryRun: boolean;
  // SERV, for decisions on a live run.
  serv?: ModelConfig | null;
  onEvent: (e: RunEvent) => void;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  // Each decision's model call, for the usage records.
  record?: (call: JsonResult) => Promise<void>;
}

export async function runAgent(o: RunOptions): Promise<Extract<RunEvent, { type: "end" }>> {
  const { definition: d } = o;
  const mock = new MockTools(o.bench);
  const state = startState(d, { settings: { ...o.bench.settings }, rules: typedRules(d, o.bench.rules), memory: mock.memory, trigger: o.bench.trigger });
  o.onEvent({ type: "start", dryRun: o.dryRun });
  const decide = async (step: DecisionStepDef, input: Record<string, unknown>): Promise<Decided> => {
    if (o.dryRun) {
      const recorded = o.bench.decisions[step.id];
      const outcome = recorded && step.outcomes.some((x) => x.id === recorded) ? recorded : step.outcomes[0]!.id;
      return { ok: true, outcome, note: recorded ? "Dry run: the recorded answer." : "Dry run: no answer recorded, so the first outcome.", costUsd: 0, model: null };
    }
    if (!o.serv) return { ok: false, note: "SERV isn't set up for decisions.", reason: "SERV isn't set up, so decisions can only run dry.", costUsd: 0, infra: false };
    const call = await askServ(step, input, o.serv, o);
    await o.record?.(call);
    return readDecision(step, call);
  };
  const r = await runSteps({ definition: d, code: o.code, state, tools: { call: (_step, tool, args) => mock.call(tool, args) }, decide, onEvent: o.onEvent, signal: o.signal, dryRun: o.dryRun });
  // The bench's mocks never wait and nothing is retried: every run ends.
  const ended = r.kind === "end" ? r : { status: "failed" as const, reason: r.kind === "retry" ? r.reason : "It stopped to wait, which the bench can't do." };
  const e = { type: "end" as const, status: ended.status, reason: ended.reason, steps: state.steps, ms: state.ms, costUsd: state.costUsd, memory: mock.memory, sheets: mock.sheets };
  o.onEvent(e);
  return e;
}
