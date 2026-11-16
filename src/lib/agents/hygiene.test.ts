// @vitest-environment node
import { describe, expect, it } from "vitest";
import { checkDefinition, type AgentDefinition } from "./definition";
import { repaired } from "./plan";
import { dropUnasked, mergeSameActions, type RawStep } from "./planRepairs";

// A plan does what the maker asked, once: one step for one send whichever
// way the run went, and no log sheet, memory or counter they never asked
// for, on every plan (a change or a fix too).

// The live GitHub verifier's first plan, as SERV made it: a passing and a
// failing report each sent by a step of its own, a log sheet the maker
// never mentioned, and three memory fields nothing reads.
const verifier = () => ({
  format: 1,
  name: "GitHub Code Verifier",
  job: { does: "Checks repositories' commits for quality and reports.", done: "Reported." },
  triggers: [{ kind: "schedule", every: "day", at: "08:00", description: "Every day" }],
  settings: [
    { key: "repos", label: "Repositories", type: "list", help: "owner/name", choices: [] },
    { key: "sheet", label: "Your sheet", type: "sheet", help: "The sheet and tab it works on.", choices: [] },
  ],
  rules: [{ key: "quality_threshold", label: "Lowest quality", type: "number", value: "70", help: "1 to 100" }],
  memory: [
    { key: "last_checked_commit", type: "text", description: "The last commit checked" },
    { key: "verified_prs", type: "list", description: "Pull requests checked" },
    { key: "quality_scores", type: "record", description: "Scores by repository" },
  ],
  steps: [
    { id: "fetch", kind: "code", title: "Fetch commits", description: "Read the commits of settings.repos with github.read.", inputs: ["settings"], outputs: ["commits"], tools: ["github.read"], next: "analyze" },
    { id: "analyze", kind: "code", title: "Run quality checks", description: "Ask SERV with serv.reason to score each commit; return results and check_way: pass when every score is at least rules.quality_threshold, else fail.", inputs: ["commits", "rules"], outputs: ["results", "check_way"], tools: ["serv.reason"], next: "check" },
    { id: "check", kind: "decision", title: "Quality meets threshold", prompt: "Does quality meet the threshold?", from: "check_way", inputs: ["results", "check_way"], outputs: [], outcomes: [{ id: "pass", label: "Passes", next: "make_report_pass" }, { id: "fail", label: "Fails", next: "make_report_fail" }] },
    { id: "make_report_pass", kind: "code", title: "Write passing report", description: "Return report_pass_content, the message saying it passed.", inputs: ["results"], outputs: ["report_pass_content"], tools: [], next: "report_pass" },
    { id: "report_pass", kind: "action", title: "Report passing", action: "report_verification", inputs: ["report_pass_content"], outputs: [], next: "make_update_log" },
    { id: "make_report_fail", kind: "code", title: "Write failing report", description: "Return report_fail_content, the message saying it failed and why.", inputs: ["results"], outputs: ["report_fail_content"], tools: [], next: "report_fail" },
    { id: "report_fail", kind: "action", title: "Report failing", action: "report_verification", inputs: ["report_fail_content"], outputs: [], next: "make_update_log" },
    { id: "make_update_log", kind: "code", title: "Prepare log entry", description: "Return update_log_content, sheets.write's arguments for settings.sheet with one row per result.", inputs: ["results", "settings"], outputs: ["update_log_content"], tools: [], next: "update_log" },
    { id: "update_log", kind: "action", title: "Log the results", action: "update_log", inputs: ["update_log_content"], outputs: [], next: null },
  ],
  actions: [
    { id: "report_verification", tool: "telegram.send", description: "Send the verification results to the owner" },
    { id: "update_log", tool: "sheets.write", description: "Log the results in a sheet" },
  ],
  limits: { maxSteps: 30, maxRunSeconds: 120, maxSpendUsd: 0.2 },
});

const SAID = "i would like a mini agent that checks githubs and verifies code, work, quality.";

describe("one step for one send", () => {
  it("joins two steps that send the same message to the owner, whichever way the run went", () => {
    const steps = verifier().steps as RawStep[];
    mergeSameActions(steps);
    expect(steps.filter((s) => s.kind === "action").map((s) => s.id)).toEqual(["report_pass", "update_log"]);
    expect(steps.find((s) => s.id === "make_report_fail")).toMatchObject({ outputs: ["report_pass_content"], next: "report_pass" });
  });

  it("leaves two sends that go on different ways alone", () => {
    const steps = verifier().steps as RawStep[];
    steps.find((s) => s.id === "report_fail")!.next = null;
    mergeSameActions(steps);
    expect(steps.filter((s) => s.action === "report_verification")).toHaveLength(2);
  });
});

describe("nothing the maker never asked for", () => {
  it("takes out a log sheet they never named, and memory nothing reads", () => {
    const steps = verifier().steps as RawStep[];
    const out = dropUnasked(steps, { settings: [], rules: [], actions: verifier().actions, memory: verifier().memory }, SAID);
    expect(out).toEqual({ actions: ["update_log"], memory: true });
    expect(steps.map((s) => s.id)).not.toContain("make_update_log");
    expect(steps.find((s) => s.id === "report_pass")!.next).toBeNull();
  });

  it("keeps a sheet they asked to log in, and memory they asked it to keep", () => {
    const steps = verifier().steps as RawStep[];
    expect(dropUnasked(steps, { settings: [], rules: [], actions: verifier().actions, memory: verifier().memory }, `${SAID} Log each check in my sheet, and only check new commits since the last run.`)).toEqual({ actions: [], memory: false });
    expect(steps).toHaveLength(9);
  });

  it("is a plan that checks out, on the first plan and on every re-plan", () => {
    for (const feedback of ["", "Make a simpler version that leaves out what it couldn't do."]) {
      const c = checkDefinition(repaired(verifier(), { said: `${SAID}\n${feedback}` }));
      expect(c.ok, c.ok ? "" : c.errors.join("; ")).toBe(true);
      const d = (c as { definition: AgentDefinition }).definition;
      expect(d.steps.map((s) => s.id)).toEqual(["fetch", "analyze", "check", "make_report_pass", "report_pass", "make_report_fail"]);
      expect(d.actions.map((a) => a.id)).toEqual(["report_verification"]);
      expect(d.memory).toEqual([]);
      expect(d.settings.map((s) => s.key)).toEqual(["repos"]);
    }
  });

  it("is left to the plan when the maker's words aren't known", () => {
    const c = checkDefinition(repaired(verifier(), {}));
    expect(c.ok && c.definition.actions.map((a) => a.id)).toEqual(["report_verification", "update_log"]);
  });
});
