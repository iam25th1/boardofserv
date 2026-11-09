// @vitest-environment node
import { describe, expect, it } from "vitest";
import restock from "./examples/restock.json";
import { checkDefinition, type AgentDefinition, type DecisionStepDef } from "./definition";
import { runAgent } from "./runner";
import type { BenchData, RunEvent, StepCode } from "./types";

// The example agent as the seed script saved it: a plan that checks out,
// every code step approved, and dry runs that follow each branch with no
// model call.

const definition = restock.definition as AgentDefinition;
const code = Object.fromEntries(Object.entries(restock.code).map(([k, c]) => [k, { ...c, spec: "", updatedAt: "" } as StepCode]));
const bench = restock.bench as BenchData;

async function dry(decisions: Record<string, string>) {
  const events: RunEvent[] = [];
  const end = await runAgent({ definition, code, bench: { ...bench, decisions }, dryRun: true, onEvent: (e) => events.push(e) });
  return { end, path: events.flatMap((e) => (e.type === "step_done" ? [e.stepId] : [])) };
}

describe("the example agent", () => {
  it("is a plan that checks out, with every code step's code approved by SERV", () => {
    expect(checkDefinition(restock.definition)).toMatchObject({ ok: true });
    const codeSteps = definition.steps.filter((s) => s.kind === "code").map((s) => s.id);
    expect(codeSteps.length).toBeGreaterThan(0);
    for (const id of codeSteps) expect(restock.code[id as keyof typeof restock.code], id).toMatchObject({ status: "approved" });
    expect(definition.actions.map((a) => a.tool).sort()).toEqual(["memory.set", "sheets.write", "telegram.send"]);
    // Writing the orders is spending: the runtime's guard asks over the
    // owner's limit, on the order's total, so the plan has no approval
    // steps of its own.
    expect(definition.actions.find((a) => a.tool === "sheets.write")).toMatchObject({ amountColumn: "total_cost_usdc", askOver: "approval_limit" });
    expect(definition.settings.filter((s) => s.type === "sheet").map((s) => s.key)).toEqual(["stock_sheet", "orders_sheet"]);
  });

  it("records the order when it is within the limit, using the recorded decision and no model", async () => {
    const { end } = await dry(bench.decisions);
    expect(end.status).toBe("done");
    expect(end.costUsd).toBe(0);
    const orders = end.sheets.Orders as Record<string, unknown>[];
    expect(orders.length).toBeGreaterThan(0);
    expect(orders.map((o) => o.fabric)).toContain("Linen, natural");
    // Harbor Cloth's cheaper linen takes 9 days, past the 7 allowed.
    expect(orders.find((o) => o.fabric === "Linen, natural")?.supplier).toBe("Weftworks");
  });

  it("tells the owner stock is fine when there is nothing to order", async () => {
    const check = definition.steps.find((s): s is DecisionStepDef => s.kind === "decision")!;
    const nothing = check.outcomes.find((o) => definition.steps.find((s) => s.id === o.next)?.kind === "action")!;
    const { end, path } = await dry({ [check.id]: nothing.id });
    expect(end.status).toBe("done");
    expect(path.at(-1)).toBe(nothing.next);
    expect(end.sheets.Orders).toEqual([]);
  });
});
