import { describe, expect, it } from "vitest";
import { checkDefinition, codeSpec, nextOf, stepContract, type AgentDefinition, type CodeStepDef } from "./definition";
import { wireToDefinition } from "./plan";
import { RESTOCK_WIRE } from "@/test/agentFixtures";

// The agent format: its shape and the checks beyond it.

function restock(): AgentDefinition {
  const c = checkDefinition(wireToDefinition(RESTOCK_WIRE));
  if (!c.ok) throw new Error(c.errors.join("; "));
  return c.definition;
}

const errorsOf = (change: (d: AgentDefinition) => void): string[] => {
  const d = structuredClone(restock()) as AgentDefinition;
  change(d);
  const c = checkDefinition(d);
  return c.ok ? [] : c.errors;
};

describe("the agent format", () => {
  it("holds a job, triggers, settings, rules, memory, steps, declared actions and limits", () => {
    const d = restock();
    expect(d.format).toBe(1);
    expect(d.job.done).toMatch(/order recorded/);
    expect(d.triggers).toEqual([{ kind: "schedule", every: "day", at: "08:00", description: "Every morning at eight" }]);
    expect(d.settings.map((s) => s.key)).toEqual(["stock_sheet", "orders_sheet", "suppliers_sheet"]);
    expect(d.rules[0]).toEqual({ key: "approval_over_usdc", label: "Ask me before orders over", type: "usdc", value: "250", help: "Orders over this wait for your yes." });
    expect(d.memory[0]!.key).toBe("last_order");
    expect(d.steps.map((s) => s.kind)).toEqual(["code", "code", "decision", "action", "decision", "action"]);
    expect(d.actions.map((a) => a.tool)).toEqual(["telegram.ask", "sheets.write"]);
    expect(d.limits).toEqual({ maxSteps: 20, maxRunSeconds: 60, maxSpendUsd: 0.05 });
  });

  it("knows where each step goes: one next step, or one per outcome", () => {
    const d = restock();
    expect(nextOf(d.steps[0]!)).toEqual(["compare"]);
    expect(nextOf(d.steps[2]!)).toEqual(["ask_owner", "record"]);
    expect(nextOf(d.steps[5]!)).toEqual([null]);
    expect(stepContract(d.steps[1]!)).toBe("input { low, rules, settings } -> output { order, order_rows }");
  });

  const isLow = { kind: "code" as const, id: "is_low", title: "Is anything low?", inputs: ["settings"], outputs: ["holds"], description: "Read the sheet in settings.stock_sheet and return holds: true when any row is below its minimum.", tools: ["sheets.read" as const], next: null };

  it("takes each trigger kind, and refuses a bad time or interval", () => {
    expect(
      errorsOf((d) => {
        d.triggers = [{ kind: "check", everyMinutes: 30, watch: "stock", when: "below minimum", step: "is_low" }, { kind: "message", from: "telegram", description: "a message" }];
        d.steps.push(isLow);
      }),
    ).toEqual([]);
    expect(errorsOf((d) => void ((d.triggers[0] as { at: string | null }).at = "25:00"))).not.toEqual([]);
    expect(errorsOf((d) => void (d.triggers = [{ kind: "check", everyMinutes: 1, watch: "x", when: "y" }]))).not.toEqual([]);
    expect(errorsOf((d) => void (d.triggers = []))).not.toEqual([]);
  });

  it("gives a value check its own code step, which only reads and says whether the condition holds", () => {
    const check = (step?: string) => ({ kind: "check" as const, everyMinutes: 30, watch: "stock", when: "below minimum", ...(step ? { step } : {}) });
    expect(errorsOf((d) => void (d.triggers = [check()]))).toContain("a check trigger names the code step that reads the value and returns { holds }");
    expect(errorsOf((d) => void (d.triggers = [check("ghost")]))).toContain('the check trigger\'s step "ghost" is not a step');
    expect(
      errorsOf((d) => {
        d.triggers = [check("is_low")];
        d.steps.push({ ...isLow, outputs: ["low"], tools: ["sheets.read", "sheets.write"] });
      }),
    ).toEqual(expect.arrayContaining(['the check step "is_low" must output holds (true when the condition is met)', 'the check step "is_low" only reads, so it can\'t use sheets.write']));
    // A run's own step can't be the check.
    expect(errorsOf((d) => void (d.triggers = [check("find_low")]))).toContain('the check step "find_low" can\'t also be a step of the run');
  });

  it("names every way a plan doesn't hold together", () => {
    expect(errorsOf((d) => void ((d.steps[0] as CodeStepDef).next = "nowhere"))).toContain('step "find_low" goes to "nowhere", which is not a step');
    expect(errorsOf((d) => void d.steps[1]!.inputs.push("ghost"))).toContain('step "compare" reads "ghost", which no step outputs and is not one of settings, rules, memory, trigger');
    expect(errorsOf((d) => void ((d.steps[5] as { action: string }).action = "pay_supplier"))).toContain('step "record" takes "pay_supplier", which is not a declared action');
    expect(errorsOf((d) => void (d.steps[0] as CodeStepDef).tools.push("wallet.pay"))).toContain('step "find_low" uses wallet.pay, but no declared action uses it');
    expect(errorsOf((d) => void (d.steps[1]!.id = "find_low"))).toContain('two steps are called "find_low"');
    expect(errorsOf((d) => void d.settings.push({ ...d.settings[0]! }))).toContain('two settings are called "stock_sheet"');
    expect(errorsOf((d) => void (d.steps[0] as CodeStepDef).tools.splice(0))).toEqual([]);
    expect(errorsOf((d) => void (d.actions[0]!.tool = "sheets.read"))).toContain('action "ask_owner" uses sheets.read, which only reads: reading happens in code steps, and actions only change things');
  });

  it("refuses a step that uses a setting, rule or memory value without reading it", () => {
    expect(errorsOf((d) => void (d.steps[0]!.inputs = []))).toContain('step "find_low" uses settings.stock_sheet but doesn\'t read settings: add "settings" to its inputs');
    expect(errorsOf((d) => void (d.steps[2]!.inputs = ["order"]))).toContain('step "check_total" uses rules.approval_over_usdc but doesn\'t read rules: add "rules" to its inputs');
  });

  it("refuses an action that writes, pays or remembers with arguments no code step made", () => {
    expect(errorsOf((d) => void (d.steps[5]!.inputs = ["order_rows"]))).toEqual([]);
    expect(errorsOf((d) => void (d.steps[5]!.inputs = ["answer"]))).toContain(
      'step "record" takes record_order (sheets.write), so its first input must be sheets.write\'s arguments, made by a code step before it',
    );
    // A message to the owner can be made from anything.
    expect(errorsOf((d) => void (d.steps[3]!.inputs = ["rules"]))).toEqual([]);
    // The arguments are the action's own: a value other steps read won't do.
    expect(errorsOf((d) => void d.steps[2]!.inputs.push("order_rows"))).toContain(
      'step "record" takes record_order (sheets.write) with "order_rows", which other steps read too: give it a value of its own, made by a code step as sheets.write\'s arguments',
    );
  });

  it("lets only spending ask over a limit: a payment, or rows with an amount column", () => {
    const record = (d: AgentDefinition) => d.actions.find((a) => a.id === "record_order")!;
    expect(errorsOf((d) => Object.assign(record(d), { askOver: "approval_over_usdc" }))).toEqual([
      'action "record_order" asks over a limit, which only spending can: a payment (wallet.pay), or sheets.write with an amountColumn',
    ]);
    expect(errorsOf((d) => Object.assign(record(d), { askOver: "approval_over_usdc", askOverDay: "approval_over_usdc", amountColumn: "cost_usdc" }))).toEqual([]);
    expect(errorsOf((d) => Object.assign(record(d), { amountColumn: "cost_usdc", askOverDay: "max_delivery_days" }))).toEqual([]);
    expect(errorsOf((d) => Object.assign(record(d), { amountColumn: "cost_usdc", askOver: "nope" }))).toEqual(['action "record_order" asks over "nope", which is not a rule']);
    expect(errorsOf((d) => Object.assign(d.actions[0]!, { amountColumn: "cost_usdc" }))).toEqual([
      'action "ask_owner" names an amount column, which only rows written to a sheet (sheets.write) have',
    ]);
  });

  it("refuses a step that reads a value not every way to it has made", () => {
    // order_rows is made on the way to record whichever way the decisions go.
    expect(errorsOf(() => {})).toEqual([]);
    // answer only comes from asking the owner, so the within-limit way to record lacks it.
    expect(errorsOf((d) => void d.steps[5]!.inputs.push("answer"))).toContain('step "record" reads "answer", but not every way to it makes "answer" first');
  });

  it("refuses a step no run can reach, and a decision with one outcome or two of the same", () => {
    expect(errorsOf((d) => void d.steps.push({ kind: "action", id: "orphan", title: "Orphan", inputs: [], outputs: [], action: "record_order", next: null }))).toContain(
      'step "orphan" can\'t be reached from the first step',
    );
    expect(errorsOf((d) => void (d.steps[2] as { outcomes: unknown[] }).outcomes.splice(1))).not.toEqual([]);
    expect(errorsOf((d) => void ((d.steps[2] as { outcomes: { id: string }[] }).outcomes[1]!.id = "over"))).toContain('step "check_total" has two outcomes called "over"');
  });

  it("keeps keys to lower case words and limits to sane bounds", () => {
    expect(errorsOf((d) => void (d.steps[0]!.id = "Find Low"))).not.toEqual([]);
    expect(errorsOf((d) => void (d.limits.maxSpendUsd = 50))).not.toEqual([]);
    expect(errorsOf((d) => void (d.limits.maxRunSeconds = 1))).not.toEqual([]);
    expect(errorsOf((d) => void ((d as { format: number }).format = 2))).not.toEqual([]);
  });

  it("fingerprints what a code step asks for, so unchanged steps keep their code", () => {
    const step = restock().steps[0] as CodeStepDef;
    expect(codeSpec({ ...step, title: "Renamed" })).toBe(codeSpec(step));
    expect(codeSpec({ ...step, tools: [...step.tools].reverse() })).toBe(codeSpec(step));
    expect(codeSpec({ ...step, description: `${step.description} Skip archived rows.` })).not.toBe(codeSpec(step));
    expect(codeSpec({ ...step, outputs: ["low", "count"] })).not.toBe(codeSpec(step));
  });
});
