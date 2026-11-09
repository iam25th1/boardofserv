import "server-only";
import { completeJson, modelPrices, type ChatMessage, type JsonResult, type ModelConfig } from "../model";
import { RUN_VALUES, type ActionStepDef, type AgentDefinition, type AgentStep, type DecisionStepDef } from "./definition";
import { runInSandbox, DEFAULT_TIME_MS } from "./sandbox";
import { MockTools, TOOL_ARGS, TOOLS } from "./toolbox";
import type { BenchData, RunEvent, StepCode } from "./types";

export type { RunEvent } from "./types";

// One run of an agent on the test bench. It starts at the first step with
// the bag holding the bench's settings, the rules (the bench's values over
// the maker's defaults, typed), memory and trigger, and follows the steps:
//
// - code: the step's approved code runs in the sandbox with its inputs and
//   only its own tools, all of them mocks answering from the bench's data.
// - decision: SERV decides, within the run's spend limit; on a dry run the
//   bench's recorded answer is taken instead, and no model is called.
// - action: the declared action's tool (a mock) is called, with the step's
//   first input when that is already the tool's arguments; a message to the
//   owner can be made from any inputs.
//
// It stops at the end of the steps, at the first failure, or at the
// agent's limits on steps, time and spend, and says which. Every step, tool
// call and result is an event, for the bench to show as it happens.

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

// A rule's value as code sees it: numbers as numbers, lists as arrays.
export function ruleValue(type: string, raw: string): unknown {
  const t = raw.trim();
  if (type === "number" || type === "usdc") return t === "" ? null : Number(t);
  if (type === "boolean") return ["true", "yes", "1", "on"].includes(t.toLowerCase());
  if (type === "list") return t ? t.split(",").map((x) => x.trim()).filter(Boolean) : [];
  return t;
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

const DECISION_PROMPT = "You make one decision in a run of an automated agent. Pick exactly one of the outcomes, from the values given. Never use em dashes.";

async function decide(step: DecisionStepDef, input: Record<string, unknown>, serv: ModelConfig, opts: Pick<RunOptions, "signal" | "fetchImpl">) {
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

function costOf(call: JsonResult): number {
  const price = modelPrices().serv;
  return ((call.promptTokens ?? 0) * price.input + (call.completionTokens ?? 0) * price.output) / 1_000_000;
}

export async function runAgent(o: RunOptions): Promise<Extract<RunEvent, { type: "end" }>> {
  const { definition: d } = o;
  const started = Date.now();
  const mock = new MockTools(o.bench);
  const byId = new Map(d.steps.map((s) => [s.id, s]));
  const rules = Object.fromEntries(d.rules.map((r) => [r.key, ruleValue(r.type, o.bench.rules[r.key] ?? r.value)]));
  const bag: Record<string, unknown> = { settings: { ...o.bench.settings }, rules, memory: mock.memory, trigger: o.bench.trigger };
  let spent = 0;
  let count = 0;
  const end = (status: "done" | "failed" | "stopped", reason: string) => {
    const e = { type: "end" as const, status, reason, steps: count, ms: Date.now() - started, costUsd: spent, memory: mock.memory, sheets: mock.sheets };
    o.onEvent(e);
    return e;
  };
  o.onEvent({ type: "start", dryRun: o.dryRun });

  let current: AgentStep | undefined = d.steps[0];
  while (current) {
    const step: AgentStep = current;
    if (o.signal?.aborted) return end("stopped", "Stopped.");
    if (count >= d.limits.maxSteps) return end("stopped", `It reached its limit of ${d.limits.maxSteps} steps.`);
    const left = d.limits.maxRunSeconds * 1000 - (Date.now() - started);
    if (left <= 0) return end("stopped", `It reached its limit of ${d.limits.maxRunSeconds} seconds.`);
    count += 1;
    const input = pick(bag, step.inputs);
    o.onEvent({ type: "step", stepId: step.id, input });
    const t0 = Date.now();
    const done = (status: "ok" | "failed", output: unknown, outcome: string | null, note: string | null, costUsd = 0) =>
      o.onEvent({ type: "step_done", stepId: step.id, status, output, outcome, note, ms: Date.now() - t0, costUsd });

    let next: string | null = null;
    if (step.kind === "code") {
      const entry = o.code[step.id];
      if (!entry?.source || entry.status !== "approved") {
        done("failed", null, null, "Its code isn't approved yet.");
        return end("failed", `"${step.title}" has no approved code yet.`);
      }
      const result = await runInSandbox(entry.source, input, {
        allowed: step.tools,
        timeMs: Math.min(DEFAULT_TIME_MS, left),
        call: async (tool, args) => {
          try {
            const r = await mock.call(tool, args);
            o.onEvent({ type: "tool", stepId: step.id, tool, args, result: r, error: null });
            return r;
          } catch (err) {
            o.onEvent({ type: "tool", stepId: step.id, tool, args, result: null, error: err instanceof Error ? err.message : "failed" });
            throw err;
          }
        },
      });
      if (!result.ok) {
        done("failed", null, null, result.error);
        return end("failed", `"${step.title}" failed: ${result.error}`);
      }
      const out = result.output;
      if (!out || typeof out !== "object" || Array.isArray(out)) {
        done("failed", out, null, "It didn't return an object.");
        return end("failed", `"${step.title}" didn't return an object.`);
      }
      const missing = step.outputs.filter((k) => !(k in out));
      if (missing.length) {
        done("failed", out, null, `It didn't return ${missing.join(", ")}.`);
        return end("failed", `"${step.title}" didn't return ${missing.join(", ")}.`);
      }
      for (const k of step.outputs) if (!(RUN_VALUES as readonly string[]).includes(k)) bag[k] = (out as Record<string, unknown>)[k];
      done("ok", pick(out as Record<string, unknown>, step.outputs), null, null);
      next = step.next;
    } else if (step.kind === "decision") {
      let outcomeId: string;
      let note: string | null = null;
      let cost = 0;
      if (o.dryRun) {
        const recorded = o.bench.decisions[step.id];
        outcomeId = recorded && step.outcomes.some((x) => x.id === recorded) ? recorded : step.outcomes[0]!.id;
        note = recorded ? "Dry run: the recorded answer." : "Dry run: no answer recorded, so the first outcome.";
      } else {
        if (!o.serv) {
          done("failed", null, null, "SERV isn't set up for decisions.");
          return end("failed", "SERV isn't set up, so decisions can only run dry.");
        }
        if (spent >= d.limits.maxSpendUsd) {
          done("failed", null, null, "The run's spend limit is reached.");
          return end("stopped", `It reached its spend limit of $${d.limits.maxSpendUsd}.`);
        }
        const call = await decide(step, input, o.serv, o);
        await o.record?.(call);
        cost = costOf(call);
        spent += cost;
        let parsed: { outcome?: string; reason?: string } | null = null;
        try {
          parsed = call.content ? (JSON.parse(call.content) as { outcome?: string; reason?: string }) : null;
        } catch {
          parsed = null;
        }
        const found = step.outcomes.find((x) => x.id === parsed?.outcome);
        if (!found) {
          done("failed", null, null, "SERV couldn't decide just now.", cost);
          return end("failed", `"${step.title}" got no decision from SERV.`);
        }
        outcomeId = found.id;
        note = parsed?.reason?.slice(0, 300) ?? null;
      }
      const outcome = step.outcomes.find((x) => x.id === outcomeId)!;
      done("ok", { outcome: outcome.id, label: outcome.label }, outcome.id, note, cost);
      next = outcome.next;
    } else {
      const action = d.actions.find((a) => a.id === step.action);
      if (!action) {
        done("failed", null, null, "Its action isn't declared.");
        return end("failed", `"${step.title}" takes an action that isn't declared.`);
      }
      const args = actionArgs(step, action.tool, input);
      if (!args.ok) {
        done("failed", null, null, args.why);
        return end("failed", `"${step.title}" failed: ${args.why}`);
      }
      try {
        const r = await mock.call(action.tool, args.args);
        o.onEvent({ type: "tool", stepId: step.id, tool: action.tool, args: args.args, result: r, error: null });
        if (step.outputs[0]) bag[step.outputs[0]] = r;
        done("ok", r, null, null);
      } catch (err) {
        const why = err instanceof Error ? err.message : "It failed.";
        o.onEvent({ type: "tool", stepId: step.id, tool: action.tool, args: args.args, result: null, error: why });
        done("failed", null, null, why);
        return end("failed", `"${step.title}" failed: ${why}`);
      }
      next = step.next;
    }
    current = next ? byId.get(next) : undefined;
  }
  return end("done", "It reached the end of its steps.");
}
