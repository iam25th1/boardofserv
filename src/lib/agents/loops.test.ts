// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { HACKATHON_LABELS, HACKATHON_WIRE, NESTED_HACKATHON_WIRE, NESTED_SOURCES, hackathonBench, hackathonCode, hackathonDefinition } from "@/test/hackathonFixture";
import { modelConfig } from "../model";
import { checkDefinition, loopsOf, type AgentDefinition, type LoopStepDef } from "./definition";
import { codeRequest } from "./code";
import { wireToDefinition } from "./plan";
import { planProblems } from "./planRules";
import { planFailure } from "./plainWords";
import { stepDepths, stepLine, stepsInOrder } from "./plainView";
import { Paused, runAgent, runSteps, startState, type RunEvent } from "./runner";
import { selfTest, sampleKey } from "./test";
import type { RunState, TestResult } from "./types";

vi.mock("server-only", () => ({}));

// Loops inside loops: for each submission, for each requirement, one
// decision; what each pass makes is gathered for what comes after, at
// every level; and plans from before loops run as they did.

const d = hackathonDefinition(NESTED_HACKATHON_WIRE);
const code = hackathonCode(d, NESTED_SOURCES);
const sampled = (def: AgentDefinition = d): TestResult => ({ status: "passed", story: "", problems: [], items: { noun: "submission", plural: "submissions", labels: HACKATHON_LABELS }, kind: "self", checkedAt: "", sample: hackathonBench(), sampleOf: sampleKey(def) });
const inputOf = (e: { input: unknown }) => e.input as Record<string, unknown>;
const stepDone = (events: RunEvent[], id: string) => events.filter((e): e is Extract<RunEvent, { type: "step_done" }> => e.type === "step_done" && e.stepId === id);
const without = (wire: typeof NESTED_HACKATHON_WIRE, change: (s: Record<string, unknown>) => Record<string, unknown>) => ({ ...wire, steps: wire.steps.map((s) => change(s as Record<string, unknown>)) });

describe("the format", () => {
  it("takes a loop inside a loop, and knows which steps are inside which", () => {
    const loops = loopsOf(d);
    expect(Object.fromEntries(loops.inside)).toEqual({
      find_new: null,
      each_submission: null,
      each_requirement: "each_submission",
      judge: "each_requirement",
      count_met: "each_submission",
      make_updates: null,
      write_status: null,
      send: null,
    });
    expect(loops.clashes).toEqual([]);
    expect((d.steps[1] as LoopStepDef).gather).toEqual([{ from: "result", into: "results" }]);
  });

  it("refuses a step after a loop reading one pass's value, and says to read what the loop gathered", () => {
    const c = checkDefinition(wireToDefinition(without(NESTED_HACKATHON_WIRE, (s) => (s.id === "each_submission" ? { ...s, outputs: [], gather: [] } : s.id === "make_updates" ? { ...s, inputs: ["settings", "result"] } : s))));
    expect(c.ok).toBe(false);
    const errors = (c as { errors: string[] }).errors;
    expect(errors).toContain('step "make_updates" reads "result", which is made inside the loop "each_submission" and is gone once its passes end: gather it in that loop (its outputs and gather) and read the gathered list');
    expect(planFailure(errors)).toBe("I couldn't work out the steps: a step after going through the items looked at only the last one, not all of them. Say what it should do with the results of every item, for example a summary naming each one.");
  });

  it("refuses a loop that gathers what nothing inside it makes, or whose outputs aren't what it gathers", () => {
    const wrong = checkDefinition(wireToDefinition(without(NESTED_HACKATHON_WIRE, (s) => (s.id === "each_requirement" ? { ...s, gather: ["judgement"] } : s))));
    expect((wrong as { errors: string[] }).errors).toContain('loop "each_requirement" gathers "judgement", which no step inside it makes');
    const loop = d.steps[2] as LoopStepDef;
    const mismatched = checkDefinition({ ...d, steps: d.steps.map((s) => (s.id === loop.id ? { ...loop, outputs: ["other"] } : s)) });
    expect((mismatched as { errors: string[] }).errors.join(" ")).toContain('loop "each_requirement" outputs the lists it gathers, so its outputs must be "verdicts" in that order');
  });

  it("refuses a step inside a loop that leads out of it", () => {
    const out = checkDefinition({ ...d, steps: d.steps.map((s) => (s.id === "count_met" ? { ...s, next: "make_updates" } : s)) });
    expect((out as { errors: string[] }).errors.join(" ")).toContain('step "make_updates" is reached both inside and outside a loop');
  });

  it("leaves a decision outside a loop as it was: its outcome picks the way, and puts nothing in the bag", async () => {
    const wire = { ...HACKATHON_WIRE, steps: HACKATHON_WIRE.steps.map((s) => (s.id === "judge" ? { ...s, each: "" } : s)) };
    const old = hackathonDefinition(wire);
    const events: RunEvent[] = [];
    await runAgent({ definition: old, code: hackathonCode(old), bench: hackathonBench(), dryRun: true, onEvent: (e) => events.push(e) });
    expect(stepDone(events, "judge")).toMatchObject([{ outcome: "met" }]);
    const tally = events.find((e): e is Extract<RunEvent, { type: "step" }> => e.type === "step" && e.stepId === "tally")!;
    expect(inputOf(tally).verdicts).toBeNull();
  });

  it("takes plans from before loops exactly as they were", () => {
    for (const wire of [HACKATHON_WIRE]) {
      const before = hackathonDefinition(wire);
      expect(checkDefinition(before)).toEqual({ ok: true, definition: before });
      expect(planProblems(before)).toEqual([]);
    }
  });
});

describe("a run", () => {
  it("makes one decision per requirement per submission, and gathers at each level", async () => {
    const events: RunEvent[] = [];
    const end = await runAgent({ definition: d, code, bench: hackathonBench(), dryRun: true, onEvent: (e) => events.push(e) });
    expect(end.status).toBe("done");
    // 3 submissions, 3 requirements each.
    expect(stepDone(events, "judge")).toHaveLength(9);
    // Each submission's count sees its own three verdicts, not the run's.
    const counts = events.filter((e): e is Extract<RunEvent, { type: "step" }> => e.type === "step" && e.stepId === "count_met");
    expect(counts.map((e) => (inputOf(e).verdicts as unknown[]).length)).toEqual([3, 3, 3]);
    expect(counts.map((e) => (inputOf(e).submission as { project: string }).project)).toEqual(HACKATHON_LABELS);
    // After the outer loop: every submission's result, in order.
    const make = events.find((e): e is Extract<RunEvent, { type: "step" }> => e.type === "step" && e.stepId === "make_updates")!;
    expect((inputOf(make).results as { project: string; status: string }[]).map((r) => [r.project, r.status])).toEqual([
      ["Tide Tracker", "Passed"],
      ["Lunch Vote", "Rejected"],
      ["Plant Pal", "Passed"],
    ]);
    // What a pass made is gone after its loop: nothing after reads one pass.
    expect(inputOf(make)).not.toHaveProperty("result");
    const rows = end.sheets.Submissions!;
    expect(rows.map((r) => r.Status)).toEqual(["Passed", "Rejected", "Passed"]);
    // Reasons name each requirement, met or not.
    expect(rows[1]!.Reasons).toBe("A working demo: not met; A public repository: met; A short write-up: not met");
  });

  it("asks SERV once per requirement per submission on a live run, each about one requirement of one submission", async () => {
    const asked: string[] = [];
    const fetchImpl = (async (_: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { messages: { content: string }[] };
      const text = body.messages[1]!.content;
      asked.push(text);
      // A demo is met only where there is one.
      const met = !(text.includes("A working demo") && text.includes('"demo":""'));
      return Response.json({ choices: [{ message: { content: JSON.stringify({ outcome: met ? "met" : "not_met", reason: met ? "It has it." : "No demo link." }) } }], usage: { prompt_tokens: 300, completion_tokens: 12 } });
    }) as unknown as typeof fetch;
    const events: RunEvent[] = [];
    const end = await runAgent({ definition: d, code, bench: hackathonBench(), dryRun: false, serv: modelConfig({ SERV_API_KEY: "k" }), fetchImpl, onEvent: (e) => events.push(e) });
    expect(end.status).toBe("done");
    expect(asked).toHaveLength(9);
    for (const a of asked) expect(a).toContain("Does this submission meet this requirement");
    expect(asked.filter((a) => a.includes('"requirement":"A working demo"'))).toHaveLength(3);
    expect(asked.filter((a) => a.includes("Lunch Vote"))).toHaveLength(3);
  });

  it("picks up inside a loop where it waited, and still gathers every pass", async () => {
    // Each submission's result is sent to the owner, who has to say yes.
    const wire = without(NESTED_HACKATHON_WIRE, (s) => (s.id === "count_met" ? { ...s, next: "ask" } : s));
    wire.actions = [...wire.actions, { id: "ask_owner", tool: "telegram.ask", description: "Ask the owner about each result", askOver: "", askOverDay: "", amountColumn: "" }];
    wire.steps = [...wire.steps.slice(0, 5), { ...wire.steps[6]!, id: "ask", title: "Ask about it", kind: "action", inputs: ["result"], outputs: ["answer"], next: "", action: "ask_owner" }, ...wire.steps.slice(5)] as typeof wire.steps;
    const c = checkDefinition(wireToDefinition(wire));
    if (!c.ok) throw new Error(c.errors.join("; "));
    const def = c.definition;
    const bench = hackathonBench();
    const sheets = { Submissions: bench.sheets.Submissions!.map((r, i) => ({ ...r, _row: i + 2 })) };
    const state: RunState = startState(def, { settings: bench.settings, rules: {}, memory: {}, trigger: null });
    let answered = 0;
    const tools = {
      call: async (_step: unknown, tool: string, args: unknown, approval?: { answer: string | null }) => {
        if (tool === "sheets.read") return { rows: sheets.Submissions };
        if (tool === "telegram.ask") {
          if (!approval) throw new Paused({ kind: "ask", question: "Ok?", choices: ["Yes", "No"] });
          answered += 1;
          return { answer: approval.answer };
        }
        return { ok: true, args };
      },
    };
    const decide = async () => ({ ok: true as const, outcome: "met", note: "Fine.", costUsd: 0, model: null });
    const run = (s: RunState) => runSteps({ definition: def, code: hackathonCode(def, NESTED_SOURCES), state: s, tools: tools as never, decide, onEvent: () => {} });
    let r = await run(state);
    let waits = 0;
    while (r.kind === "wait") {
      waits += 1;
      expect(state.loops?.map((f) => [f.step, f.index])).toEqual([["each_submission", waits - 1]]);
      // Saved and loaded again, as a job is.
      const saved = JSON.parse(JSON.stringify(state)) as RunState;
      saved.journal[r.index] = { ...saved.journal[r.index]!, waiting: false, approval: { answer: "Yes" } };
      Object.assign(state, saved);
      r = await run(state);
    }
    expect(r).toMatchObject({ kind: "end", status: "done" });
    expect(waits).toBe(3);
    expect(answered).toBe(3);
    expect((state.bag.results as unknown[]).length).toBe(3);
  });
});

describe("the self test", () => {
  it("passes the nested plan: a summary covering all 3, and a second run with nothing new", async () => {
    const t = await selfTest({ definition: d, code, testResult: sampled() }, { serv: null });
    expect(t.result.problems).toEqual([]);
    expect(t.result.status).toBe("passed");
    expect(t.result.story).toBe("Passed. 3 submissions checked: 2 passed, 1 rejected, summary sent.");
  });

  it("fails a summary that covers only the last pass", async () => {
    const lastOnly = NESTED_SOURCES.make_updates.replace('lines.join("\\n")', "lines[lines.length - 1]").replace('"Checked " + results.length + " submissions: "', '"Latest: "');
    expect(lastOnly).not.toBe(NESTED_SOURCES.make_updates);
    const t = await selfTest({ definition: d, code: hackathonCode(d, { ...NESTED_SOURCES, make_updates: lastOnly }), testResult: sampled() }, { serv: null });
    expect(t.result.status).toBe("failed");
    expect(t.result.problems.map((p) => p.text)).toContain("Its summary covers only some of the submissions, not all 3.");
  });

  it("fails a second run that judges the same submissions again", async () => {
    const again = NESTED_SOURCES.find_new.replace("rows.filter((r) => !r.Status)", "rows");
    const t = await selfTest({ definition: d, code: hackathonCode(d, { ...NESTED_SOURCES, find_new: again }), testResult: sampled() }, { serv: null });
    expect(t.result.problems.map((p) => p.text)).toContain("Run again, it would go through the same submissions a second time: it should only take new ones.");
  });
});

describe("the planner and the maker's view", () => {
  it("reads a pass that leads back to its loop, or on past it, as ending there, and a read of one pass after the loop as its gathered list", () => {
    const wire = without(NESTED_HACKATHON_WIRE, (s) =>
      s.id === "judge"
        ? { ...s, outcomes: [{ id: "met", label: "Met", next: "each_requirement" }, { id: "not_met", label: "Not met", next: "count_met" }] }
        : s.id === "count_met"
          ? { ...s, next: "each_submission" }
          : s.id === "make_updates"
            ? { ...s, inputs: ["settings", "result"] }
            : s.id === "each_submission"
              ? { ...s, inputs: [] }
              : s,
    );
    const c = checkDefinition(wireToDefinition(wire));
    if (!c.ok) throw new Error(c.errors.join("; "));
    const steps = new Map(c.definition.steps.map((s) => [s.id, s]));
    expect(steps.get("judge")).toMatchObject({ outcomes: [{ next: null }, { next: null }] });
    expect(steps.get("count_met")).toMatchObject({ next: null });
    expect(steps.get("make_updates")!.inputs).toEqual(["settings", "results"]);
    expect(steps.get("each_submission")!.inputs).toEqual(["submissions"]);
  });

  it("reads a loop that gathers its own output's name from the value or the silent decision inside it, and drops an item made again", () => {
    // As SERV sent it live: gather names the output, the decision names no
    // verdict, and the counting step passes the item on as an output.
    const wire = without(NESTED_HACKATHON_WIRE, (s) =>
      s.id === "each_requirement"
        ? { ...s, outputs: ["requirement_verdicts"], gather: ["requirement_verdicts"] }
        : s.id === "judge"
          ? { ...s, outputs: [] }
          : s.id === "count_met"
            ? { ...s, inputs: ["submission", "requirements", "requirement_verdicts"], outputs: ["submission", "result"] }
            : s.id === "each_submission"
              ? { ...s, gather: ["results"] }
              : s,
    );
    const c = checkDefinition(wireToDefinition(wire));
    if (!c.ok) throw new Error(c.errors.join("; "));
    const steps = new Map(c.definition.steps.map((s) => [s.id, s]));
    expect(steps.get("judge")!.outputs).toEqual(["requirement_verdicts"]);
    expect((steps.get("each_requirement") as LoopStepDef).gather).toEqual([{ from: "requirement_verdicts", into: "requirement_verdicts" }]);
    expect((steps.get("each_submission") as LoopStepDef).gather).toEqual([{ from: "result", into: "results" }]);
    expect(steps.get("count_met")!.outputs).toEqual(["result"]);
    // A list gathered under its own name is told as what one pass made.
    expect(codeRequest(steps.get("count_met") as never, c.definition)).toContain('- requirement_verdicts: a list with one entry per item of requirements, in order (gathered by the step "For each requirement" from every pass): each entry is what requirement_verdicts was in that pass, the verdict of the step "Judge the requirement"');
  });

  it("sends back a plan that reads its place from memory but never saves it, as SERV planned it live", () => {
    const reading = { ...d, memory: [{ key: "last_row", description: "The last row checked", type: "number" as const }], steps: d.steps.map((s) => (s.id === "find_new" ? { ...s, inputs: ["settings", "memory"] } : s)) };
    const said = planProblems(reading);
    expect(said.join(" ")).toContain('step "find_new" reads its place from memory, but no step saves it');
    expect(planFailure(said)).toContain("it looked up where it got to last time, but never saved where it got to");
    expect(planProblems(d)).toEqual([]);
  });

  it("doesn't take code that counts verdicts for code that judges", () => {
    const counting = { ...d, steps: d.steps.map((s) => (s.id === "count_met" ? { ...s, description: "Count how many verdicts are met. Determine if met_count is less than total_requirements divided by 2: if true, status is rejected." } : s)) };
    expect(planProblems(counting)).toEqual([]);
    const judging = { ...d, steps: d.steps.map((s) => (s.id === "count_met" ? { ...s, description: "For the current submission, judge each requirement as met or not met." } : s)) };
    expect(planProblems(judging).join(" ")).toContain('code step "count_met" judges');
  });

  it("goes through a setting's list itself, as SERV planned it live", async () => {
    // The inner loop names the requirements setting, reading settings.
    const wire = without(NESTED_HACKATHON_WIRE, (s) => (s.id === "each_requirement" ? { ...s, inputs: ["requirements"], over: "requirements" } : s.id === "find_new" ? { ...s, outputs: ["submissions"] } : s.id === "count_met" ? { ...s, inputs: ["settings", "submission", "verdicts"], description: `${s.description} The requirements are settings.requirements.` } : s));
    const c = checkDefinition(wireToDefinition(wire));
    if (!c.ok) throw new Error(c.errors.join("; "));
    const loop = c.definition.steps.find((s) => s.id === "each_requirement") as LoopStepDef;
    expect(loop.inputs).toEqual(["settings"]);
    expect(codeRequest(c.definition.steps.find((s) => s.id === "count_met") as never, c.definition)).toContain("- verdicts: a list with one entry per item of requirements");
    const events: RunEvent[] = [];
    const countMet = NESTED_SOURCES.count_met.replaceAll("input.requirements", "input.settings.requirements");
    const end = await runAgent({ definition: c.definition, code: hackathonCode(c.definition, { ...NESTED_SOURCES, count_met: countMet, find_new: NESTED_SOURCES.find_new.replace(", requirements: (input.settings.requirements || []).filter(Boolean)", "") }), bench: hackathonBench(), dryRun: true, onEvent: (e) => events.push(e) });
    expect(end.status).toBe("done");
    expect(stepDone(events, "judge")).toHaveLength(9);
    expect(end.sheets.Submissions!.map((r) => r.Status)).toEqual(["Passed", "Rejected", "Passed"]);
  });

  it("sends back a decision that judges many things at once", () => {
    const flat = { ...d, steps: d.steps.map((s) => (s.id === "judge" ? { ...s, prompt: "Does this submission meet each requirement?" } : s)) };
    expect(planProblems(flat).join(" ")).toContain('decision "judge" judges many things at once');
    expect(planFailure(planProblems(flat))).toContain("it judged many things in one go instead of one at a time");
    expect(planProblems(d)).toEqual([]);
  });

  it("tells Dolphin what an item, a verdict and a gathered list are", () => {
    const count = codeRequest(d.steps.find((s) => s.id === "count_met") as never, d);
    expect(count).toContain('- submission: one item of submissions (the step "For each submission" goes through them one at a time)');
    expect(count).toContain('- verdicts: a list with one entry per item of requirements, in order (gathered by the step "For each requirement" from every pass): each entry is what verdict was in that pass, the verdict of the step "Judge the requirement"');
    expect(count).toContain('outcome: "met" | "not_met", label: string, reason: string');
    const make = codeRequest(d.steps.find((s) => s.id === "make_updates") as never, d);
    expect(make).toContain('- results: a list with one entry per item of submissions');
  });

  it("shows a loop's steps in under it, in plain words", () => {
    const order = stepsInOrder(d).map((s) => s.id);
    expect(order).toEqual(["find_new", "each_submission", "each_requirement", "judge", "count_met", "make_updates", "write_status", "send"]);
    const depths = stepDepths(d);
    expect(order.map((id) => depths.get(id))).toEqual([0, 0, 1, 2, 1, 0, 0, 0]);
    expect(stepLine(d.steps[1]!, d)).toBe("For each submission");
  });
});
