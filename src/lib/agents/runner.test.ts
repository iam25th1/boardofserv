// @vitest-environment node
import { describe, expect, it } from "vitest";
import { modelConfig } from "@/lib/model";
import { COMPARE, FIND_LOW, RESTOCK_WIRE, restockBench } from "@/test/agentFixtures";
import { servOnly } from "./build";
import { checkDefinition, type AgentDefinition } from "./definition";
import { wireToDefinition } from "./plan";
import { ruleValue, runAgent } from "./runner";
import type { BenchData, RunEvent, StepCode } from "./types";

// Test bench runs with every tool mocked from the bench's data, and SERV's
// decisions mocked or, on a dry run, recorded.

const d = (() => {
  const c = checkDefinition(wireToDefinition(RESTOCK_WIRE));
  if (!c.ok) throw new Error("fixture");
  return c.definition;
})();
const ok = (source: string): StepCode => ({ spec: "", status: "approved", source, rounds: 1, note: null, updatedAt: "" });
const CODE = { find_low: ok(FIND_LOW), compare: ok(COMPARE) };

async function run(o: { bench?: BenchData; dryRun?: boolean; code?: Record<string, StepCode>; definition?: AgentDefinition; fetchImpl?: typeof fetch }) {
  const events: RunEvent[] = [];
  const recorded: unknown[] = [];
  const end = await runAgent({
    definition: o.definition ?? d,
    code: o.code ?? CODE,
    bench: o.bench ?? restockBench(),
    dryRun: o.dryRun ?? true,
    serv: servOnly(modelConfig({ SERV_API_KEY: "test-serv" })),
    fetchImpl: o.fetchImpl,
    record: async (c) => void recorded.push(c),
    onEvent: (e) => events.push(e),
  });
  const path = events.flatMap((e) => (e.type === "step_done" ? [`${e.stepId}:${e.status}${e.outcome ? `=${e.outcome}` : ""}`] : []));
  return { end, events, path, recorded };
}

describe("a dry run", () => {
  it("follows the recorded decisions through the steps, with every tool a mock", async () => {
    const within = await run({});
    expect(within.path).toEqual(["find_low:ok", "compare:ok", "check_total:ok=within", "record:ok"]);
    expect(within.end).toMatchObject({ status: "done", reason: "It reached the end of its steps.", steps: 4, costUsd: 0 });
    expect(within.end.sheets.Orders).toEqual([
      { fabric: "Linen, natural", supplier: "Weftworks", metres: 36, cost_usdc: 219.6 },
      { fabric: "Wool felt", supplier: "Weftworks", metres: 14, cost_usdc: 147 },
    ]);
    expect(within.recorded).toEqual([]);

    const refused = await run({ bench: { ...restockBench(), decisions: { check_total: "over", approved: "no" }, telegram: { answers: ["no"] } } });
    expect(refused.path).toEqual(["find_low:ok", "compare:ok", "check_total:ok=over", "ask_owner:ok", "approved:ok=no"]);
    expect(refused.end.sheets.Orders).toEqual([]);
    const ask = refused.events.find((e) => e.type === "tool" && e.tool === "telegram.ask");
    expect(ask).toMatchObject({ stepId: "ask_owner", result: { answer: "no" } });
  });

  it("reports each step's input and output, its tool calls and its time, as it happens", async () => {
    const { events } = await run({});
    expect(events[0]).toEqual({ type: "start", dryRun: true });
    expect(events[1]).toEqual({ type: "step", stepId: "find_low", input: { settings: { stock_sheet: "Stock", orders_sheet: "Orders" } } });
    expect(events[2]).toMatchObject({ type: "tool", stepId: "find_low", tool: "sheets.read", args: { sheet: "Stock" }, error: null });
    const done = events[3] as Extract<RunEvent, { type: "step_done" }>;
    expect(done).toMatchObject({ type: "step_done", stepId: "find_low", status: "ok", output: { low: [{ fabric: "Linen, natural", metres: 4, minimum: 20 }, { fabric: "Wool felt", metres: 6, minimum: 10 }] } });
    expect(done.ms).toBeGreaterThanOrEqual(0);
    // Rules reach code typed: the maker's defaults, or the bench's values.
    const compare = events.find((e) => e.type === "step" && e.stepId === "compare") as Extract<RunEvent, { type: "step" }>;
    expect((compare.input as { rules: unknown }).rules).toEqual({ approval_over_usdc: 250, max_delivery_days: 7 });
    expect(ruleValue("boolean", "Yes")).toBe(true);
    expect(ruleValue("list", "Linen, Felt ,")).toEqual(["Linen", "Felt"]);
  });

  it("takes the first outcome when no answer is recorded, and says so", async () => {
    const { events } = await run({ bench: { ...restockBench(), decisions: {} } });
    expect(events.find((e) => e.type === "step_done" && e.stepId === "check_total")).toMatchObject({ outcome: "over", note: "Dry run: no answer recorded, so the first outcome." });
  });
});

describe("a live run", () => {
  it("asks SERV at each decision, with the step's prompt and values, within the spend limit", async () => {
    const asked: string[] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { messages: { content: string }[]; response_format: { json_schema: { schema: { properties: { outcome: { enum: string[] } } } } } };
      asked.push(body.messages[1]!.content);
      const ids = body.response_format.json_schema.schema.properties.outcome.enum;
      const outcome = ids.includes("over") ? "over" : "yes";
      return Response.json({ choices: [{ message: { content: JSON.stringify({ outcome, reason: "The total is 366.6 USDC, over 250." }) } }], usage: { prompt_tokens: 600, completion_tokens: 20 } });
    }) as typeof fetch;
    const { path, end, recorded, events } = await run({ dryRun: false, fetchImpl });
    expect(path).toEqual(["find_low:ok", "compare:ok", "check_total:ok=over", "ask_owner:ok", "approved:ok=yes", "record:ok"]);
    expect(asked[0]).toContain("Is order.total_usdc over rules.approval_over_usdc?");
    expect(asked[0]).toContain('"total_usdc":366.6');
    expect(recorded).toHaveLength(2);
    // 600 in and 20 out at SERV's 1.25 and 6.50 a million, twice.
    expect(end.costUsd).toBeCloseTo((2 * (600 * 1.25 + 20 * 6.5)) / 1e6, 10);
    expect(events.find((e) => e.type === "step_done" && e.stepId === "check_total")).toMatchObject({ note: "The total is 366.6 USDC, over 250." });
  });

  it("stops at the agent's spend limit", async () => {
    const fetchImpl = (async () => Response.json({ choices: [{ message: { content: JSON.stringify({ outcome: "over", reason: "x" }) } }], usage: { prompt_tokens: 50_000, completion_tokens: 0 } })) as typeof fetch;
    const { end } = await run({ dryRun: false, fetchImpl, definition: { ...d, limits: { ...d.limits, maxSpendUsd: 0.01 } } });
    expect(end).toMatchObject({ status: "stopped", reason: "It reached its spend limit of $0.01." });
  });
});

describe("a run that goes wrong", () => {
  it("stops at a step whose code isn't approved", async () => {
    const { end, path } = await run({ code: { find_low: ok(FIND_LOW), compare: { ...ok(COMPARE), status: "needs_attention" } } });
    expect(path).toEqual(["find_low:ok", "compare:failed"]);
    expect(end).toMatchObject({ status: "failed", reason: '"Compare suppliers" has no approved code yet.' });
  });

  it("stops at code that fails, or doesn't return what the step promised", async () => {
    const broken = await run({ code: { ...CODE, find_low: ok("async function run() { throw new Error('the sheet was empty'); }") } });
    expect(broken.end).toMatchObject({ status: "failed", reason: '"Find low stock" failed: Error: the sheet was empty' });
    const missing = await run({ code: { ...CODE, find_low: ok("async function run() { return { found: [] }; }") } });
    expect(missing.end).toMatchObject({ status: "failed", reason: '"Find low stock" didn\'t return low.' });
    const wrongSheet = await run({ bench: { ...restockBench(), settings: { stock_sheet: "Missing", orders_sheet: "Orders" } } });
    expect(wrongSheet.end.reason).toBe('"Find low stock" failed: Error: There is no sheet called "Missing".');
    expect(wrongSheet.events.find((e) => e.type === "tool")).toMatchObject({ tool: "sheets.read", error: 'There is no sheet called "Missing".' });
  });

  it("stops a loop at the agent's step limit", async () => {
    const loop: AgentDefinition = {
      ...d,
      steps: [{ kind: "code", id: "again", title: "Again", inputs: [], outputs: ["n"], description: "Count.", tools: [], next: "again" }],
      limits: { ...d.limits, maxSteps: 5 },
    };
    const { end } = await run({ definition: loop, code: { again: ok("async function run() { return { n: 1 }; }") } });
    expect(end).toMatchObject({ status: "stopped", reason: "It reached its limit of 5 steps.", steps: 5 });
  });

  it("refuses an action whose input isn't the tool's arguments, unless it's a message to the owner", async () => {
    const def: AgentDefinition = { ...d, steps: d.steps.map((s) => (s.id === "record" ? { ...s, inputs: ["order"] } : s)) };
    const { end } = await run({ definition: def });
    expect(end.reason).toMatch(/^"Record the order" failed: This action needs its first input to be sheets.write's arguments/);
  });
});
