import { describe, expect, it } from "vitest";
import { definitionOf, PRICE_WIRE } from "@/test/suiteFixtures";
import { FIXER_PROMPT, FIXER_SCHEMA, fixerRequest, readVerdict } from "./fixer";
import { codeDiagnosis } from "./diagnosis";
import { foundLine, freshBuild, gaveUpLine, healLimits, repairLine, roundsUsed } from "./heal";
import { emptyHeal } from "./types";

// The fixer reads a diagnosis and says what was wrong as one of four
// verdicts, with what to do; the build's bookkeeping and plain lines.

const d = definitionOf(PRICE_WIRE);
const reminder = d.steps.find((s) => s.id === "make_reminder")!;
const dx = codeDiagnosis(d, reminder.id, { spec: "x", status: "needs_attention", source: "async function run(input) { if (input.skip) return { reminder: null }; }", rounds: 3, note: "It checks input.skip, which the step's inputs don't have.", updatedAt: "2026-11-11T00:00:00.000Z" });
const answer = (o: Record<string, unknown>) => JSON.stringify({ verdict: "code_wrong", step: "make_reminder", why: "", spec: "", change: "", sample: "", question: "", choices: [], lesson: "", kind: "other", ...o });

describe("the fixer", () => {
  it("asks SERV in its strict schema: every field required, no nullable and no range keywords", () => {
    const schema = FIXER_SCHEMA.schema;
    expect(schema.required).toEqual(Object.keys(schema.properties));
    const text = JSON.stringify(schema);
    expect(text).not.toMatch(/"nullable"|"minimum"|"maximum"|"minItems"|"maxItems"|"minLength"|"maxLength"|"null"/);
    expect(FIXER_PROMPT).not.toContain(String.fromCharCode(0x2014));
  });

  it("gives SERV the whole diagnosis: what failed, where, the brief, the code and the review's reason", () => {
    const asked = fixerRequest(dx, { tried: ["plan: Remove the question."], interview: "Maker: remind me when it's cheap" });
    expect(asked).toContain("Stage: code");
    expect(asked).toContain(`Step: ${reminder.title} (make_reminder)`);
    expect(asked).toContain("What happened: It checks input.skip, which the step's inputs don't have.");
    expect(asked).toContain(`The step's brief:\nCode step "${reminder.title}" (make_reminder): `);
    expect(asked).toContain("Its code:\nasync function run(input) { if (input.skip)");
    expect(asked).toContain("Already tried on this build, without success:\nplan: Remove the question.");
    expect(asked).toContain("What the maker asked for:\nMaker: remind me when it's cheap");
  });

  it("takes a verdict only with what it needs: a brief, a change, or a question with answers to tap", () => {
    expect(readVerdict(answer({ spec: "Make the reminder from the price." }))).toMatchObject({ verdict: "code_wrong", step: "make_reminder", spec: "Make the reminder from the price." });
    expect(readVerdict(answer({}))).toBeNull();
    expect(readVerdict(answer({ verdict: "plan_wrong" }))).toBeNull();
    expect(readVerdict(answer({ verdict: "plan_wrong", change: "Remove ask." }))).toMatchObject({ verdict: "plan_wrong", change: "Remove ask." });
    expect(readVerdict(answer({ verdict: "unclear", question: "Which payee?", choices: ["Designer"] }))).toBeNull();
    expect(readVerdict(answer({ verdict: "unclear", question: "Which payee?", choices: ["Designer", "Someone else"] }))).toMatchObject({ question: "Which payee?", choices: ["Designer", "Someone else"] });
    expect(readVerdict(answer({ verdict: "test_wrong", sample: "A payee called Designer.", kind: "sample_payee" }))).toMatchObject({ verdict: "test_wrong", kind: "sample_payee" });
    expect(readVerdict(answer({ verdict: "skip_the_check", spec: "x" }))).toBeNull();
    // Never a question about code: live, it once asked whether a step "returns last_position".
    expect(readVerdict(answer({ verdict: "unclear", question: "Does this step correctly read the last_row_read value from memory and return it?", choices: ["Yes", "No"] }))).toBeNull();
    expect(readVerdict(answer({ verdict: "unclear", question: "Which product page should it watch?", choices: ["The kettle", "Another page"] }))).toMatchObject({ verdict: "unclear" });
    expect(readVerdict("not json")).toBeNull();
    expect(readVerdict(answer({ spec: "x", kind: "made_up" }))!.kind).toBe("other");
  });
});

describe("healing's bookkeeping", () => {
  it("has three rounds and a model budget that grows with the agent, both settable", () => {
    expect(healLimits({ steps: new Array(7) }, {})).toEqual({ rounds: 3, costUsd: 0.51 });
    expect(healLimits({ steps: new Array(20) }, {})).toEqual({ rounds: 3, costUsd: 0.9 });
    expect(healLimits(null, { AGENT_HEAL_ROUNDS: "5", AGENT_BUILD_COST_USD: "2" })).toEqual({ rounds: 5, costUsd: 2 });
    expect(healLimits(null, { AGENT_HEAL_ROUNDS: "0" }).rounds).toBe(0);
  });

  it("counts only this build's rounds that were acted on", () => {
    const round = (verdict: "code" | null) => ({ diagnosis: dx, verdict, why: "", repair: "", outcome: "failed" as const, at: "" });
    const log = { ...emptyHeal(), rounds: [round("code"), round("code")] };
    const fresh = freshBuild(log);
    expect(roundsUsed(fresh)).toBe(0);
    expect(roundsUsed({ ...fresh, rounds: [...fresh.rounds, round("code"), round(null)] })).toBe(1);
    expect(fresh.rounds).toHaveLength(2);
    expect(fresh).toMatchObject({ lines: [], question: null, gaveUp: null, costUsd: 0 });
  });

  it("says what it is doing in calm plain lines, by the step's number, and gives up in one sentence", () => {
    expect(foundLine(dx, d)).toBe("Found a problem in step 6. Fixing it.");
    expect(repairLine("code", d, "make_reminder")).toBe("Writing step 6 again.");
    expect(repairLine("plan", d, null)).toBe("Changing its steps.");
    expect(repairLine("test", d, null)).toBe("Making a better sample to try it on.");
    expect(gaveUpLine(dx, d)).toBe('I couldn\'t get step 6, "Write the reminder", to work.');
    for (const line of [foundLine(dx, d), gaveUpLine(dx, d)]) expect(line).not.toMatch(/code|plan|review|hold|error|step "/i);
  });
});
