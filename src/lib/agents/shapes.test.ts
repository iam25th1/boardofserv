import { describe, expect, it } from "vitest";
import { checkDefinition, type AgentDefinition } from "./definition";
import { repaired, wireToDefinition } from "./plan";
import { planProblems } from "./planRules";
import { selfTest } from "./test";
import { misfit, parseShape, shapeProblems, showShape } from "./shapes";
import { emptyBench, type StepCode, type TestResult } from "./types";

// Data between steps: each step says the shape of what it makes, and what
// reads it is checked against that before anything is built, then what it
// really made is checked in its self test.

describe("a shape", () => {
  it("is read from plain words", () => {
    expect(showShape(parseShape("{ name, score: number, reasons }[]"))).toBe("{ name, score: number, reasons }[]");
    expect(parseShape("{ sheet, updates: { row: number, values: { Status } }[] }")).toMatchObject({ t: "object", fields: { updates: { t: "list", of: { t: "object" } } } });
    expect(parseShape("number")).toEqual({ t: "number" });
    expect(parseShape("{ text } or null")).toMatchObject({ t: "object" });
    expect(parseShape("whatever it finds")).toEqual({ t: "any" });
    expect(parseShape("{ a, ... }")).toMatchObject({ t: "object", open: true });
  });

  it("says why a value doesn't fit", () => {
    const s = parseShape("{ name, score: number, reasons }[]");
    expect(misfit([{ name: "Tide", score: 8, reasons: "x" }], s)).toBeNull();
    expect(misfit([{ name: "Tide", score: "high", reasons: "x" }], s, "results")).toBe("results[0].score is text, not a number");
    expect(misfit([{ name: "Tide", score: 8 }], s, "results")).toBe("results[0].reasons is missing");
    expect(misfit({ name: "Tide" }, s, "results")).toBe("results is an object, not a list");
    expect(misfit(null, s)).toBeNull();
  });
});

function agent(o: { makes: string; sendShape?: string; overShape?: string; reads?: string }): AgentDefinition {
  const c = checkDefinition({
    format: 1,
    name: "Scores",
    job: { does: "Sends the scores.", done: "Sent." },
    triggers: [{ kind: "schedule", every: "day", at: "09:00", description: "Every day" }],
    settings: [],
    rules: [],
    memory: [],
    steps: [
      { id: "find", title: "Find them", kind: "code", inputs: [], outputs: ["results"], shapes: { results: o.makes }, description: "Return results.", tools: [], next: "make" },
      { id: "make", title: "Write the message", kind: "code", inputs: ["results"], outputs: ["message"], shapes: o.sendShape ? { message: o.sendShape } : undefined, description: o.reads ?? "Return message { text } naming each result.", tools: [], next: "send" },
      { id: "send", title: "Send it", kind: "action", action: "tell", inputs: ["message"], outputs: [], next: null },
    ],
    actions: [{ id: "tell", tool: "telegram.send", description: "Tell you the scores" }],
    limits: { maxSteps: 5, maxRunSeconds: 30, maxSpendUsd: 0 },
  });
  if (!c.ok) throw new Error(c.errors.join("; "));
  return c.definition;
}

describe("before anything is built", () => {
  it("passes shapes that meet", () => {
    expect(shapeProblems(agent({ makes: "{ name, score: number }[]", sendShape: "{ text }", reads: "Name each of results with results.score." }))).toEqual([]);
  });

  it("sends back an action handed the wrong shape, naming the step that made it", () => {
    expect(shapeProblems(agent({ makes: "{ name, score: number }[]", sendShape: "{ body }" }))).toEqual([
      'step "send" takes telegram.send with "message" (made by step "make"), whose shape is { body }, but telegram.send needs { text }: it has no text',
    ]);
  });

  it("sends back a step that reads a field the value doesn't have", () => {
    const d = agent({ makes: "{ name, score: number }", sendShape: "{ text }", reads: "Return message { text } with results.name and results.grade." });
    expect(planProblems(d)).toContainEqual('step "make" reads results.grade, but "results" (from step "find") has the shape { name, score: number }: read only the fields it has, or make the step before it return them');
  });

  it("comes from the planner's answer in the outputs' order", () => {
    const w = { steps: [{ id: "find", title: "Find", kind: "code", inputs: [], outputs: ["results", "count"], shapes: ["{ name }[]", "number"], description: "x", tools: [], next: "" }] };
    expect((wireToDefinition(w) as AgentDefinition).steps[0]!.shapes).toEqual({ results: "{ name }[]", count: "number" });
  });
});

describe("the self test", () => {
  it("fails a step that makes a different shape from its plan's, so the build heals it", async () => {
    const d = agent({ makes: "{ name, score: number }[]", sendShape: "{ text }" });
    const ok = (source: string): StepCode => ({ spec: "", status: "approved", source, rounds: 1, note: null, updatedAt: "" });
    const code = { find: ok("async function run() { return { results: [{ name: 'Tide', score: 'eight' }] }; }"), make: ok("async function run(input) { return { message: { text: input.results.map((r) => r.name + ' ' + r.score).join(', ') } }; }") };
    const bench = { ...emptyBench() };
    const kept: TestResult = { status: "passed", story: "", problems: [], items: { noun: "score", plural: "scores", labels: ["Tide"] }, kind: "self", checkedAt: "2026-11-13T00:00:00.000Z", sample: bench, sampleOf: (await import("./test")).sampleKey(d) };
    const t = await selfTest({ definition: d, code, testResult: kept }, { serv: null });
    expect(t.result.status).toBe("failed");
    expect(t.result.problems).toContainEqual({ step: "find", check: "shape", text: '"Find them" made results in a different shape from the one its plan says ({ name, score: number }[]): results[0].score is text, not a number, so the step after it can\'t read it.' });
  });
});

describe("rows written back", () => {
  it("keep their numbers from the step that reads them on", () => {
    const w = {
      steps: [
        { id: "read", title: "Read the sheet", kind: "code", inputs: ["settings"], outputs: ["submissions"], shapes: ["{ name, description }[]"], description: "Read the sheet and return the rows whose Score is empty.", tools: ["sheets.read"], next: "send" },
        { id: "send", title: "Write", kind: "action", inputs: [], outputs: [], action: "write", next: "" },
      ],
      actions: [{ id: "write", tool: "sheets.update", description: "Write the scores" }],
      settings: [],
      rules: [],
    };
    const d = repaired(wireToDefinition(w)) as AgentDefinition;
    const read = d.steps.find((x) => x.id === "read")!;
    expect(read.shapes).toEqual({ submissions: "{ _row: number, name, description }[]" });
    expect(read.kind === "code" && read.description).toContain("Keep each row's _row");
  });
});

describe("a sheet it works on", () => {
  it("is always one the renter gives at setup: one is asked for when the plan has none", () => {
    const w = {
      steps: [
        { id: "read", title: "Read the sheet", kind: "code", inputs: [], outputs: ["rows"], description: 'Read the "submissions_sheet" tab and return its rows.', tools: ["sheets.read"], next: "" },
      ],
      actions: [],
      settings: [],
      rules: [],
    };
    const d = repaired(wireToDefinition(w)) as AgentDefinition;
    expect(d.settings).toEqual([{ key: "sheet", label: "Your sheet", type: "sheet", help: "The sheet and tab it works on.", choices: [] }]);
    const read = d.steps[0]!;
    expect(read.inputs).toEqual(["settings"]);
    expect(read.kind === "code" && read.description).toContain("settings.sheet");
  });

  it("is refused on the bench, as for real, when no setting names it", async () => {
    const { MockTools } = await import("./toolbox");
    const bench = { ...emptyBench(), settings: { sheet: "Submissions" }, sheets: { Submissions: [{ Name: "Tide" }], submissions_sheet: [{ Name: "Tide" }] } };
    const mock = new MockTools(bench, [], ["sheet"]);
    await expect(mock.call("sheets.read", { sheet: "Submissions" })).resolves.toMatchObject({ rows: [{ Name: "Tide" }] });
    await expect(mock.call("sheets.read", { sheet: "sheet" })).resolves.toMatchObject({ rows: [{ Name: "Tide" }] });
    await expect(mock.call("sheets.read", { sheet: "submissions_sheet" })).rejects.toThrow('This agent wasn\'t given a sheet called "submissions_sheet". It was given "Submissions".');
  });
});

