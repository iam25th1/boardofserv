import { describe, expect, it } from "vitest";
import { checkDefinition, type AgentDefinition } from "./definition";
import { fitSample } from "./sample";
import { sampleKey, selfTest } from "./test";
import { codeOf } from "@/test/suiteFixtures";
import { emptyBench, type TestResult } from "./types";

// An agent that reads a Typeform form, tried on its sample: the tab SERV
// made up for the form becomes the form's responses (in the shape
// typeform.read answers with), and the self test runs on them, each
// response once.

const LINK = "https://form.typeform.com/to/Sample01";

function scorer(): AgentDefinition {
  const c = checkDefinition({
    format: 1,
    name: "Hackathon Submission Scorer",
    job: { does: "Scores each new submission to your Typeform form from 1 to 10 with reasons and sends you the scores.", done: "Every new submission is scored." },
    triggers: [{ kind: "schedule", every: "hours", interval: 1, at: null, description: "Every hour" }],
    settings: [{ key: "form_link", label: "Your Typeform form's link", type: "url", help: "The form people submit to.", choices: [] }],
    rules: [],
    memory: [],
    steps: [
      { id: "read", title: "Read new submissions", kind: "code", inputs: ["settings"], outputs: ["submissions"], description: "Read the form's new responses with typeform.read and return them.", tools: ["typeform.read"], next: "each" },
      { id: "each", title: "Each submission", kind: "loop", inputs: ["submissions"], outputs: ["results"], over: "submissions", item: "submission", body: "score", gather: [{ from: "result", into: "results" }], next: "summary" },
      { id: "score", title: "Score the submission", kind: "code", inputs: ["submission"], outputs: ["result"], description: "Ask SERV with serv.reason to score the submission from 1 to 10 for quality, with answer { score: number, reasons: text }.", tools: ["serv.reason"], next: null },
      { id: "summary", title: "Write the summary", kind: "code", inputs: ["results"], outputs: ["message"], description: "One message naming every submission with its score and reasons.", tools: [], next: "send" },
      { id: "send", title: "Send the scores", kind: "action", action: "send_scores", inputs: ["message"], outputs: [], next: null },
    ],
    actions: [{ id: "send_scores", tool: "telegram.send", description: "Send you the scores" }],
    limits: { maxSteps: 60, maxRunSeconds: 120, maxSpendUsd: 0.2 },
  });
  if (!c.ok) throw new Error(c.errors.join("; "));
  return c.definition;
}

const SOURCES = {
  read: "async function run(input, tools) { const r = await tools.typeform.read({ form: input.settings.form_link }); return { submissions: r.responses.map((x) => ({ id: x.id, answers: x.answers })) }; }",
  score:
    "async function run(input, tools) { const a = input.submission.answers; const r = await tools.serv.reason({ task: 'Score this hackathon submission from 1 to 10 for quality.', data: a, answer: { score: 'number', reasons: 'text' } }); return { result: { name: a['Project name'], score: r.score, reasons: r.reasons } }; }",
  summary: "async function run(input) { return { message: { text: input.results.map((r) => r.name + ': ' + r.score + '/10. ' + r.reasons).join('\\n') } }; }",
};

const sample = {
  bench: {
    ...emptyBench(),
    settings: { form_link: LINK },
    sheets: {
      [LINK]: [
        { "Project name": "Tidewatch", "Team name": "Low Tide Labs", Description: "Plans safe tide-pool visits from the tide table. Demo and tests.", "Demo link": "https://example.com/tidewatch" },
        { "Project name": "Commute Buddy", "Team name": "Two Coders", Description: "Compares bus and bike times for one city. No tests yet.", "Demo link": "" },
        { "Project name": "Something with AI", "Team name": "TBD", Description: "We want to use AI to make life easier.", "Demo link": "" },
      ],
    },
  },
  items: { noun: "submission", plural: "submissions", labels: ["Tidewatch", "Commute Buddy", "Something with AI"] },
};

describe("a Typeform form's sample", () => {
  it("is the form's responses, each with its id and answers by question, the tab gone", () => {
    const { bench } = fitSample(scorer(), sample);
    expect(bench.sheets[LINK]).toBeUndefined();
    expect(bench.forms?.[LINK]?.map((r) => r.id)).toEqual(["sample-1", "sample-2", "sample-3"]);
    expect(bench.forms?.[LINK]?.[1]?.answers).toEqual({ "Project name": "Commute Buddy", "Team name": "Two Coders", Description: "Compares bus and bike times for one city. No tests yet.", "Demo link": null });
  });

  it("passes the self test, asking SERV to score each response", async () => {
    const d = scorer();
    const bench = fitSample(d, sample).bench;
    const kept: TestResult = { status: "passed", story: "", problems: [], items: sample.items, kind: "self", checkedAt: "2026-11-13T00:00:00.000Z", sample: bench, sampleOf: sampleKey(d) };
    const t = await selfTest({ definition: d, code: codeOf(d, SOURCES), testResult: kept }, { serv: null });
    expect(t.result.problems).toEqual([]);
    expect(t.result.status).toBe("passed");
    const asked = t.events.filter((e) => e.type === "tool" && e.tool === "serv.reason");
    expect(asked).toHaveLength(3);
  });
});
