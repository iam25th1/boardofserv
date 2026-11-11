// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { BAD_HACKATHON_WIRE, FIND_NEW, HACKATHON_LABELS, HACKATHON_WIRE, TALLY, hackathonBench, hackathonCode, hackathonDefinition } from "@/test/hackathonFixture";
import { modelConfig } from "../model";
import { checkDefinition, type ActionStepDef, type CodeStepDef, type DecisionStepDef } from "./definition";
import { planAgent, wireToDefinition } from "./plan";
import { planProblems } from "./planRules";
import { planFailure, problemOf, storyOf } from "./plainWords";
import { nothingToDo, readDecision, runAgent, type RunEvent } from "./runner";
import { dolphinProvider, fitTools, toolsCalled, writeStep } from "./code";
import { selfTest, sampleKey, testVersion } from "./test";
import type { TestResult } from "./types";

vi.mock("server-only", () => ({}));

// The planner's rules, on the test case from a real run (a hackathon
// submission checker): judgement planned into decisions and counting into
// code, a decision that judges every item of a list in one call, an action
// skipped when there's nothing to do, a step's tools fitted to its code,
// and the self test every plan gets, run on three sample items and then
// again.

const serv = modelConfig({ SERV_API_KEY: "k" });

describe("the test case", () => {
  it("plans into a decision for the judgement and code for the counting, and keeps every rule", () => {
    const d = hackathonDefinition();
    const kinds = Object.fromEntries(d.steps.map((s) => [s.id, s.kind]));
    expect(kinds).toEqual({ find_new: "code", judge: "decision", tally: "code", write_status: "action", send: "action" });
    expect((d.steps.find((s) => s.id === "judge") as DecisionStepDef).each).toBe("checks");
    // Results go into each submission's own row.
    expect(d.actions.find((a) => a.id === "write_results")?.tool).toBe("sheets.update");
    expect(planProblems(d)).toEqual([]);
  });

  it("finds every way the real run's plan went wrong, or puts it right", () => {
    const c = checkDefinition(wireToDefinition(BAD_HACKATHON_WIRE));
    expect(c.ok).toBe(true);
    const problems = planProblems((c as { definition: ReturnType<typeof hackathonDefinition> }).definition).join("\n");
    expect(problems).toMatch(/code step "judge_row" judges/);
    expect(problems).toMatch(/decision "any_new" decides whether items are left/);
    expect(problems).toMatch(/decision "more_rows" decides whether items are left/);
    expect(problems).toMatch(/step "more_rows" loops back to "judge_row"/);
    // A position saved without reading the last one is put right as the
    // plan is read: the step reads memory, and keeps the larger.
    const save = (c as { definition: ReturnType<typeof hackathonDefinition> }).definition.steps.find((s) => s.id === "save") as CodeStepDef;
    expect(save.inputs).toContain("memory");
    expect(save.description).toContain("a saved position keeps the larger of the old one and the new one");
    expect(problems).not.toMatch(/saves to memory/);
    // Told back to the maker in plain words, never the step ids.
    const said = planFailure(planProblems((c as { definition: ReturnType<typeof hackathonDefinition> }).definition));
    expect(said).toMatch(/^The plan didn't come together: it left a judgement to code instead of SERV, and it used a judgement step for counting or going through a list\./);
    expect(said).not.toMatch(/judge_row|any_new|more_rows/);
  });

  it("catches a code step that works out whether a requirement is met, as SERV wrote it live", () => {
    const d = hackathonDefinition();
    const judging = { ...d, steps: d.steps.map((s) => (s.id === "find_new" ? { ...s, description: "For each requirement, determine if it is met by the submission. Count met requirements." } : s)) };
    expect(planProblems(judging).join(" ")).toMatch(/code step "find_new" judges/);
    // Working out whether a row is new is code's to do.
    const fine = { ...d, steps: d.steps.map((s) => (s.id === "find_new" ? { ...s, description: "Read the tab and determine whether each row is new: its Status is empty." } : s)) };
    expect(planProblems(fine)).toEqual([]);
  });

  it("catches a decision asked to work out a fraction, as SERV wrote it live", () => {
    const d = hackathonDefinition();
    const live = { ...d, steps: d.steps.map((s) => (s.id === "judge" ? { ...s, prompt: "Check whether each submission satisfies all the listed requirements and calculate what fraction were met." } : s)) };
    expect(planProblems(live).join(" ")).toMatch(/decision "judge" decides a count or a comparison/);
  });

  it("still catches a position saved without reading the last one, if a plan gets past the reading", () => {
    const d = hackathonDefinition();
    const saving = { ...d, memory: [{ key: "last_row", description: "The last row checked", type: "number" as const }], steps: d.steps.map((s) => (s.id === "tally" ? { ...s, tools: [...(s as CodeStepDef).tools, "memory.set" as const] } : s)) };
    expect(planProblems(saving)).toContain('step "tally" saves to memory without reading what was saved before: list "memory" in its inputs and build on it (a position keeps the larger of the old and the new).');
  });

  it("sends a plan that breaks the rules back to SERV with the reasons, and takes the one that keeps them", async () => {
    const answers = [BAD_HACKATHON_WIRE, HACKATHON_WIRE];
    const asked: string[] = [];
    const fetchImpl = (async (_: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { messages: { content: string }[] };
      asked.push(body.messages.at(-1)!.content);
      return Response.json({ choices: [{ message: { content: JSON.stringify(answers.shift()) } }], usage: { prompt_tokens: 10, completion_tokens: 10 } });
    }) as unknown as typeof fetch;
    const plan = await planAgent({ interview: { name: "Hackathon Submission Checker", kind: "agent", watches: null, when: null, how: null, tells: null, takes: null, does: null, gives: null, asking: null, live: false }, history: [] }, { config: serv, signal: new AbortController().signal, fetchImpl });
    expect(plan.definition?.steps.map((s) => s.id)).toEqual(["find_new", "judge", "tally", "write_status", "send"]);
    expect(asked[1]).toContain("That plan has problems");
    expect(asked[1]).toContain('decision "any_new" decides whether items are left');
  });

  it("takes a decision whose description names one of its inputs as a decision over that list", () => {
    // SERV's plan schema has no room for one more field on a step, so the
    // list is named in the decision's description.
    const wire = { ...HACKATHON_WIRE, steps: HACKATHON_WIRE.steps.map((s) => (s.id === "judge" ? { ...s, each: "", description: "checks" } : s)) };
    const c = checkDefinition(wireToDefinition(wire));
    expect(c.ok).toBe(true);
    expect(((c as { definition: ReturnType<typeof hackathonDefinition> }).definition.steps[1] as DecisionStepDef).each).toBe("checks");
    // Words, or a name it doesn't read, are no list.
    const prose = checkDefinition(wireToDefinition({ ...wire, steps: wire.steps.map((s) => (s.id === "judge" ? { ...s, description: "judge them all" } : s)) }));
    expect(((prose as { definition: ReturnType<typeof hackathonDefinition> }).definition.steps[1] as DecisionStepDef).each).toBeUndefined();
  });

  it("names a list decision's verdicts and gives it verdicts to choose from, when SERV left them out", () => {
    // As SERV sent it live: no output, and one outcome that only says the
    // judging is done.
    const wire = {
      ...HACKATHON_WIRE,
      steps: HACKATHON_WIRE.steps.map((s) =>
        s.id === "judge" ? { ...s, each: "", description: "checks", outputs: [], outcomes: [{ id: "requirements_judged", label: "Judged", next: "tally" }] } : s,
      ),
    };
    const c = checkDefinition(wireToDefinition(wire));
    expect(c.ok).toBe(true);
    const judge = (c as { definition: ReturnType<typeof hackathonDefinition> }).definition.steps[1] as DecisionStepDef;
    expect(judge.outputs).toEqual(["verdicts"]);
    expect(judge.outcomes.map((o) => [o.id, o.next])).toEqual([
      ["yes", "tally"],
      ["no", "tally"],
    ]);
  });

  it("tells Dolphin exactly what a list decision's verdicts look like", async () => {
    const { codeRequest } = await import("./code");
    const d = hackathonDefinition();
    const ask = codeRequest(d.steps.find((s) => s.id === "tally") as CodeStepDef, d);
    expect(ask).toContain('- verdicts: the verdicts of the step "Judge each requirement", one per item of checks in the same order: Array<{ item: number (the item\'s place in checks, from 0), outcome: "met" | "not_met", label: string, reason: string }>');
  });

  it("reads a clock dressed as a value check as the schedule it meant", () => {
    const wire = {
      ...HACKATHON_WIRE,
      triggers: [{ kind: "check", every: "none", at: "", everyMinutes: 15, watch: "new rows", when: "there are new rows", step: "check_new", description: "Every 15 minutes, check for new rows" }],
      steps: [{ ...HACKATHON_WIRE.steps[0]!, id: "check_new", next: "" }, ...HACKATHON_WIRE.steps.slice(1)],
    };
    const c = checkDefinition(wireToDefinition(wire));
    expect(c.ok).toBe(true);
    const d = (c as { definition: ReturnType<typeof hackathonDefinition> }).definition;
    expect(d.triggers).toEqual([{ kind: "schedule", every: "minutes", interval: 15, at: null, description: "Every 15 minutes, check for new rows" }]);
    // Its step goes on to where the run was meant to start.
    expect((d.steps[0] as CodeStepDef).next).toBe("judge");
  });
});

describe("a decision over a list", () => {
  const d = hackathonDefinition();
  const judge = d.steps.find((s) => s.id === "judge") as DecisionStepDef;

  it("judges every item in one call, and reads a verdict for each", () => {
    const content = JSON.stringify({ verdicts: [{ item: 2, outcome: "not_met", reason: "No demo." }, { item: 1, outcome: "met", reason: "It works." }] });
    const call = { content, outcome: "ok" as const, provider: "serv" as const, model: "serv", promptTokens: 100, completionTokens: 40, totalMs: 1, failures: [], attempts: [] };
    const r = readDecision(judge, call, 2);
    expect(r).toMatchObject({ ok: true, verdicts: [{ item: 0, outcome: "met" }, { item: 1, outcome: "not_met", label: "Not met", reason: "No demo." }] });
    // One missing is no decision at all.
    expect(readDecision(judge, call, 3)).toMatchObject({ ok: false, infra: true });
  });

  it("runs dry with the outcomes in turn, makes no call for an empty list, and skips actions code left empty", async () => {
    const events: RunEvent[] = [];
    const end = await runAgent({ definition: d, code: hackathonCode(d), bench: hackathonBench(), dryRun: true, onEvent: (e) => events.push(e) });
    expect(end.status).toBe("done");
    const verdicts = (events.find((e) => e.type === "step_done" && e.stepId === "judge") as { output: { verdicts: { outcome: string }[] } }).output.verdicts;
    expect(verdicts.map((v) => v.outcome)).toEqual(["met", "not_met", "met", "not_met", "met", "not_met", "met", "not_met", "met"]);
    expect(end.sheets.Submissions!.map((r) => r.Status)).toEqual(["Passed", "Rejected", "Passed"]);
    // Again on what it left: nothing new, nothing judged, nothing written or sent.
    const again: RunEvent[] = [];
    const end2 = await runAgent({ definition: d, code: hackathonCode(d), bench: { ...hackathonBench(), sheets: end.sheets }, dryRun: false, serv: null, onEvent: (e) => again.push(e) });
    expect(end2.status).toBe("done");
    expect(again.filter((e) => e.type === "tool").map((e) => (e as { tool: string }).tool)).toEqual(["sheets.read"]);
    expect(again.filter((e) => e.type === "step_done").map((e) => (e as { note: string | null }).note)).toContain("Nothing to do, so it was skipped.");
    const write = { ...(d.steps[3] as ActionStepDef), inputs: ["x"] };
    expect(nothingToDo(write, { x: { sheet: "S", updates: [] } })).toBe(true);
    expect(nothingToDo(write, { x: null })).toBe(true);
    expect(nothingToDo(write, { x: { sheet: "S", updates: [{ row: 2, values: {} }] } })).toBe(false);
  });
});

describe("a step's tools", () => {
  const step: CodeStepDef = { id: "tally", title: "Count and mark", kind: "code", inputs: ["rows"], outputs: ["n"], next: null, description: "Count the rows it was given.", tools: ["sheets.read"] };

  it("are fitted to what its code calls: one it never calls comes off, one that only looks goes on", () => {
    expect(toolsCalled(FIND_NEW)).toEqual(["sheets.read"]);
    expect(fitTools(step, "async function run(input) { return { n: input.rows.length }; }")).toEqual([]);
    expect(fitTools({ ...step, tools: [] }, "async function run(input, tools) { const r = await tools.memory.get({ key: 'x' }); return { n: 1 }; }")).toEqual(["memory.get"]);
    // One that changes something isn't added: the code goes back instead.
    expect(fitTools({ ...step, tools: [] }, "async function run(input, tools) { await tools.telegram.send({ text: 'x' }); return { n: 1 }; }")).toEqual([]);
  });

  it("so a listed tool the code never calls no longer holds the step: SERV reviews the fitted list, and the plan is told", async () => {
    const reviewed: string[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { messages: { content: string }[]; response_format?: unknown };
      if (url.includes("dphn")) return Response.json({ choices: [{ message: { content: "```js\nasync function run(input) { return { n: (input.rows || []).length }; }\n```" } }] });
      reviewed.push(body.messages[1]!.content);
      return Response.json({ choices: [{ message: { content: JSON.stringify({ verdict: "approve", reason: "It counts the rows." }) } }] });
    }) as unknown as typeof fetch;
    const dolphin = dolphinProvider({ DOLPHIN_API_KEY: "d" })!;
    const entry = await writeStep(step, hackathonDefinition(), "spec", { dolphin, serv, fetchImpl, hooks: { progress: async () => {}, record: async () => {} } });
    expect(entry.status).toBe("approved");
    expect(entry.tools).toEqual([]);
    expect(reviewed[0]).toContain("(no tools: this step works only on its input)");
    expect(reviewed[0]).not.toContain("sheets.read");
  });
});

describe("the self test", () => {
  const d = hackathonDefinition();
  const sampled = (def = d): TestResult => ({ status: "passed", story: "", problems: [], items: { noun: "submission", plural: "submissions", labels: HACKATHON_LABELS }, kind: "self", checkedAt: "", sample: hackathonBench(), sampleOf: sampleKey(def) });

  it("passes the test case, and tells its run as a short story", async () => {
    const t = await selfTest({ definition: d, code: hackathonCode(d), testResult: sampled() }, { serv: null });
    expect(t.result.status).toBe("passed");
    expect(t.result.problems).toEqual([]);
    expect(t.result.story).toBe("3 submissions checked: 2 passed, 1 rejected, summary sent.");
  });

  it("fails a plan whose summary covers only the last submission", async () => {
    const lastOnly = TALLY.replace('const text = "Checked " + subs.length + " submissions: " + passed + " passed, " + (subs.length - passed) + " rejected.\\n" + lines.join("\\n");', 'const text = "Latest: " + lines[lines.length - 1];');
    expect(lastOnly).not.toBe(TALLY);
    const t = await selfTest({ definition: d, code: hackathonCode(d, { find_new: FIND_NEW, tally: lastOnly }), testResult: sampled() }, { serv: null });
    expect(t.result.status).toBe("failed");
    expect(t.result.problems.map((p) => p.text)).toContain("Its summary covers only some of the submissions, not all 3.");
  });

  it("fails a plan that writes its results as new rows, which the next run takes again", async () => {
    const wire = {
      ...HACKATHON_WIRE,
      actions: [{ ...HACKATHON_WIRE.actions[0]!, tool: "sheets.write", description: "Add each result as a row" }, HACKATHON_WIRE.actions[1]!],
      steps: HACKATHON_WIRE.steps.map((s) => (s.id === "tally" ? { ...s, description: `${s.description} Return status_updates as sheets.write's arguments { sheet, rows }.` } : s)),
    };
    const bad = checkDefinition(wireToDefinition(wire));
    if (!bad.ok) throw new Error(bad.errors.join("; "));
    const appending = TALLY.replace("return { status_updates: { sheet: input.settings.submissions_sheet, updates }, summary: { text } };", "return { status_updates: { sheet: input.settings.submissions_sheet, rows: updates.map((u) => ({ Project: results[updates.indexOf(u)].project, ...u.values })) }, summary: { text } };");
    const t = await selfTest({ definition: bad.definition, code: hackathonCode(bad.definition, { find_new: FIND_NEW, tally: appending }), testResult: sampled(bad.definition) }, { serv: null });
    expect(t.result.status).toBe("failed");
    const said = t.result.problems.map((p) => p.text);
    expect(said).toContain("It adds its results as new rows of the sheet it reads submissions from, so they would come back as new submissions.");
    expect(said).toContain("Run again, it would go through the same submissions a second time: it should only take new ones.");
    // That is the problem the maker sees, with Fix this handing it to SERV.
    expect(problemOf({ definition: bad.definition, code: {}, buildState: "idle", buildNote: null, testResult: t.result })).toMatchObject({ fix: "replan" });
  });

  it("makes its sample once, from the plan, and again only when the plan changes", async () => {
    const t = await testVersion({ definition: d, code: hackathonCode(d), testResult: sampled() }, { serv: null, live: false, kind: "manual" });
    expect(t.result.sampleOf).toBe(sampleKey(d));
    expect(t.bench.sheets.Submissions).toHaveLength(3);
    const changed = { ...d, settings: [...d.settings, { key: "judges", label: "Who judges", type: "text" as const, help: "Names", choices: [] }] };
    expect(sampleKey(changed)).not.toBe(sampleKey(d));
  });

  it("tells a stopped run in plain words", () => {
    const events: RunEvent[] = [{ type: "step", stepId: "find_new", input: {} }, { type: "step_done", stepId: "find_new", status: "failed", output: null, outcome: null, note: "x", ms: 1, costUsd: 0 }];
    const end = { type: "end" as const, status: "failed" as const, reason: "x", steps: 1, ms: 1, costUsd: 0, memory: {}, sheets: {} };
    expect(storyOf(d, events, end, { noun: "submission", plural: "submissions", labels: HACKATHON_LABELS })).toBe('It stopped at "Find new submissions", before doing anything with the 3 sample submissions.');
  });
});
