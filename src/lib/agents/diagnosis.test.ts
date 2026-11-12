import { describe, expect, it } from "vitest";
import { codeOf, definitionOf, PRICE_SOURCES, PRICE_WIRE, priceBench } from "@/test/suiteFixtures";
import { codeDiagnosis, connectDiagnosis, liveDiagnosis, planDiagnosis, specOf, testDiagnosis, traceOf, withDiagnosis } from "./diagnosis";
import { sampleKey, selfTest } from "./test";
import type { TestResult } from "./types";

// Every failure of a build is one record with all there is to act on:
// where, what happened, what was expected, and the evidence.

const d = definitionOf(PRICE_WIRE);

describe("a diagnosis", () => {
  it("of a self test that failed names the check, its step, the run and the sample it used", async () => {
    // A target the price never meets: on a sample made for it to work on,
    // it never sends the reminder.
    const bench = { ...priceBench(), settings: { ...priceBench().settings, target_price: 30 } };
    const kept: TestResult = { status: "passed", story: "", problems: [], items: { noun: "product", plural: "products", labels: ["Stone Kettle"] }, kind: "self", checkedAt: "2026-11-11T00:00:00.000Z", sample: bench, sampleOf: sampleKey(d) };
    const t = await selfTest({ definition: d, code: codeOf(d, PRICE_SOURCES), testResult: kept }, { serv: null });
    expect(t.result.status).toBe("failed");
    const dx = testDiagnosis(d, t.result, t.events, codeOf(d, PRICE_SOURCES));
    expect(dx).toMatchObject({ stage: "test", step: { id: "send", title: expect.any(String) }, failure: t.result.problems[0]!.text, expected: "On a sample made for it to work on, it does its job at least once." });
    expect(dx.evidence.check).toBe("did_job");
    expect(dx.evidence.sample?.settings).toMatchObject({ target_price: 30 });
    expect(dx.evidence.plan).toBe(d);
    // The run, step by step: the page it read and the way it went.
    expect(dx.evidence.trace.some((l) => l.includes("web.fetch("))).toBe(true);
    expect(dx.evidence.trace.at(-1)).toMatch(/^end: done/);
  });

  it("of a step's code that didn't pass carries its spec, its code and the review's reason", () => {
    const step = d.steps.find((s) => s.kind === "code")!;
    const dx = codeDiagnosis(d, step.id, { spec: "x", status: "needs_attention", source: "async function run() { return {}; }", rounds: 3, note: "It checks input.skip, which the step never mentions.", updatedAt: "2026-11-11T00:00:00.000Z" });
    expect(dx).toMatchObject({ stage: "code", step: { id: step.id, title: step.title }, failure: "It checks input.skip, which the step never mentions." });
    expect(dx.evidence).toMatchObject({ code: "async function run() { return {}; }", review: "It checks input.skip, which the step never mentions." });
    expect(dx.evidence.spec).toBe(specOf(step, d));
    expect(dx.evidence.spec).toContain(`Tools: ${step.kind === "code" ? step.tools.join(", ") : ""}`);
  });

  it("of a plan, a review before going live and a setup keeps their reasons", () => {
    expect(planDiagnosis(["step \"x\" goes to \"y\", which is not a step"], null)).toMatchObject({ stage: "plan", step: null, evidence: { errors: ['step "x" goes to "y", which is not a step'] } });
    const step = d.steps.find((s) => s.kind === "code")!;
    expect(liveDiagnosis(d, [{ step: step.title, severity: "blocking", finding: "It sends data somewhere it doesn't need." }], {})).toMatchObject({ stage: "live", step: { id: step.id }, failure: "It sends data somewhere it doesn't need." });
    expect(connectDiagnosis(d, { payee: "That isn't a Base address." })).toMatchObject({ stage: "connect", evidence: { errors: ["payee: That isn't a Base address."] } });
  });

  it("goes on the heal log as a round not acted on yet", () => {
    const dx = planDiagnosis(["no"], null);
    const log = withDiagnosis(withDiagnosis(null, dx), dx);
    expect(log.rounds).toHaveLength(2);
    expect(log.rounds[1]).toMatchObject({ diagnosis: dx, verdict: null, outcome: "pending" });
  });

  it("keeps a long run short", () => {
    const events = Array.from({ length: 200 }, (_, i) => ({ type: "step" as const, stepId: `s${i}`, input: {} }));
    const lines = traceOf(events, 10);
    expect(lines).toHaveLength(10);
    expect(lines.at(-1)).toBe("(191 more lines)");
  });
});
