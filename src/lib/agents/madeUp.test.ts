// @vitest-environment node
import { describe, expect, it } from "vitest";
import { checkerDefinition } from "@/test/githubChecker";
import { checkDefinition, type AgentDefinition } from "./definition";
import { needNotes, type JobNeeds } from "./needs";
import { repaired } from "./plan";
import { outlinePrompt } from "./planStages";

// No made-up settings. Live, the GitHub checker came with rules its owner
// never gave: "Check cyclomatic complexity" on, "Minimum test coverage
// percentage" 80 (which a commit's changes can't measure) and a maximum of
// 5 violations. A rule's value comes from the maker's words or an answer
// they picked in the chat; one nothing it reads can measure goes whoever
// said it.

// Version 3's rules, and the sentences of its steps that used them.
const v3 = (): AgentDefinition => {
  const d = checkerDefinition({
    rules: [
      { key: "max_violations", label: "Maximum code violations before flagging", type: "number", help: "Threshold above which the analysis report is flagged for review", value: "5" },
      { key: "check_complexity", label: "Check cyclomatic complexity", type: "boolean", help: "Include function complexity analysis", value: "true" },
      { key: "check_coverage", label: "Minimum test coverage percentage", type: "number", help: "Flag files with test coverage below this percentage", value: "80" },
    ],
  });
  return {
    ...d,
    steps: d.steps.map((s) =>
      s.id === "analyze_quality" && s.kind === "code"
        ? { ...s, inputs: [...s.inputs, "rules"], description: `${s.description} Check complexity only when rules.check_complexity is true. Flag files below rules.check_coverage percent coverage. Compare violations_total against rules.max_violations.` }
        : s,
    ),
  };
};
const owner = "an ai agent that check  my github repo;  code quality\nEvery hour\nA specific repository";
const plan = (d: AgentDefinition, said: string): AgentDefinition => {
  const c = checkDefinition(repaired(structuredClone(d), { owner: said }));
  if (!c.ok) throw new Error(c.errors.join("; "));
  return c.definition;
};

describe("a rule the maker never gave", () => {
  it("goes: a check of its own with the sentences that use it, a limit the steps work by to a question at setup", () => {
    const d = plan(v3(), owner);
    expect(d.rules).toEqual([]);
    const judge = d.steps.find((s) => s.id === "analyze_quality")!;
    const said = judge.kind === "code" ? judge.description : "";
    expect(said).not.toMatch(/check_complexity|check_coverage|rules\./);
    expect(said).toContain("ask serv.reason to judge their quality");
    // The maximum is the owner's to give, with no answer made up.
    expect(said).toContain("Compare violations_total against settings.max_violations.");
    expect(d.settings.find((s) => s.key === "max_violations")).toEqual({ key: "max_violations", label: "Maximum code violations before flagging", type: "number", help: "Threshold above which the analysis report is flagged for review", choices: [] });
  });

  it("stays when the maker gave it, and a check they named stays on", () => {
    const d = plan(v3(), "Check my repo's commits for quality, check complexity too, and flag it when there are more than 5 violations.");
    expect(d.rules.map((r) => [r.key, r.value])).toEqual([
      ["max_violations", "5"],
      ["check_complexity", "true"],
    ]);
  });

  it("goes when nothing it reads can measure it, whoever said it", () => {
    const d = plan(v3(), "Flag files below 80 percent test coverage, and more than 5 violations.");
    expect(d.rules.map((r) => r.key)).toEqual(["max_violations"]);
  });

  it("is never asked for by the planner", () => {
    expect(outlinePrompt(15, "github.read")).toContain("never a threshold, a percentage or a check of your own, and never one that nothing it reads can measure (test coverage from a commit's changes)");
  });
});

describe("an answer that names no value", () => {
  it("is asked at setup, never kept as the setting's answer", () => {
    const base = checkerDefinition();
    const said = (given: string): AgentDefinition => ({ ...base, settings: base.settings.map((s) => ({ ...s, given })) });
    expect(plan(said("A specific repository"), owner).settings[0]!.given ?? "").toBe("");
    expect(plan(said("I'll give it at setup"), owner).settings[0]!.given ?? "").toBe("");
    expect(plan(said("iam25th1/boardofserv"), `${owner}\nCheck iam25th1/boardofserv`).settings[0]!.given).toBe("iam25th1/boardofserv");
    const needs: JobNeeds = { items: [{ key: "repos", kind: "input", question: "Which GitHub repositories should the agent check?", choices: ["I'll give it at setup", "All my repositories", "A specific repository"], answer: "A specific repository" }], services: [], asked: null, at: "" };
    expect(needNotes(needs)).toEqual(['The maker was asked "Which GitHub repositories should the agent check?" and will answer it at setup: it is a setting with no given answer, read by the steps, never written into a step.']);
  });
});
