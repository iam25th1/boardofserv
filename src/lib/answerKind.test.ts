// @vitest-environment node
import { describe, expect, it } from "vitest";
import { modelConfig, type ModelConfig } from "./model";
import { isReady, linksOf, nodesOf, sketchFromDTO, statusLine } from "./agentSketch";
import { mergeSketch } from "./sketchBlock";
import { planInput, planTurn, SKETCH_SCHEMA } from "./sketchPlan";
import { askLine, knownLine, replySystemPrompt } from "./systemPrompt";
import type { SketchDTO } from "./types";

// The "answer" kind: a helper you ask something once. It is described by
// takes, does and gives, planned like the other kinds and drawn in the dock as
// takes / does / gives.

const SERV = modelConfig({ SERV_API_KEY: "test-serv-key" }).providers[0]!;
const config: ModelConfig = { providers: [SERV], firstTokenTimeoutMs: 1_000, historyMessages: 12, maxTokens: 400, planMaxTokens: 200 };

const blank: SketchDTO = {
  name: null,
  kind: null,
  watches: null,
  when: null,
  how: null,
  tells: null,
  takes: null,
  does: null,
  gives: null,
  asking: null,
  live: false,
};
const blurb: SketchDTO = {
  ...blank,
  name: "Shop blurb writer",
  kind: "answer",
  takes: "a product name and a few facts",
  does: "writes a friendly two line blurb",
  asking: "gives",
};
const done: SketchDTO = { ...blurb, gives: "the blurb, ready to paste", asking: null };

const plan = (o: Record<string, unknown>) =>
  JSON.stringify({ name: "", kind: "none", watches: "", when: "", how: "", tells: "", takes: "", does: "", gives: "", asking: "none", choices: [], ...o });

describe("the plan for an answer helper", () => {
  it("offers the answer kind and its fields in the strict schema, with no banned keywords", () => {
    const { schema } = SKETCH_SCHEMA;
    expect(schema.required).toEqual(["name", "kind", "watches", "when", "how", "tells", "takes", "does", "gives", "asking", "choices"]);
    expect(schema.properties.kind.enum).toContain("answer");
    expect(schema.properties.asking.enum).toEqual(["watches", "when", "how", "tells", "takes", "does", "gives", "none"]);
    const text = JSON.stringify(SKETCH_SCHEMA);
    for (const banned of ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "minItems", "maxItems", "null"]) {
      expect(text).not.toContain(`"${banned}"`);
    }
  });

  it("reads an answer helper from the plan and merges it like the other kinds", async () => {
    const fetchImpl = (async () =>
      Response.json({
        choices: [{ message: { content: plan({ name: "Shop blurb writer", kind: "answer", takes: "a product name and a few facts", does: "writes a friendly two line blurb", asking: "gives", choices: ["The blurb", "Three options"] }) } }],
      })) as unknown as typeof fetch;
    const { sketch } = await planTurn({ stored: null, previous: null, said: "Write blurbs for my shop" }, { config, signal: new AbortController().signal, fetchImpl });
    expect(sketch).toMatchObject({ kind: "answer", takes: "a product name and a few facts", asking: "gives", choices: ["The blurb", "Three options"] });
    expect(mergeSketch(null, sketch!)).toEqual({ ...blurb, kindChosen: false });
  });

  it("sends the stored answer fields to the next plan", () => {
    expect(planInput({ stored: blurb, previous: "What should it give back?", said: "The blurb" })).toBe(
      'Sketch: {"name":"Shop blurb writer","kind":"answer","takes":"a product name and a few facts","does":"writes a friendly two line blurb"}\n' +
        "Last reply: What should it give back?\n" +
        "Person: The blurb",
    );
  });

  it("drops a question about a field the kind does not have", () => {
    const parsed = { name: null, kind: null, watches: null, when: null, how: null, tells: null, takes: null, does: null, gives: null, choices: [] };
    expect(mergeSketch(blurb, { ...parsed, asking: "how" }).asking).toBeNull();
    expect(mergeSketch(blurb, { ...parsed, asking: "gives" }).asking).toBe("gives");
    // An agent is still asked about its own fields.
    expect(mergeSketch({ ...blank, kind: "watcher" }, { ...parsed, asking: "how" }).asking).toBe("how");
    expect(mergeSketch({ ...blank, kind: "watcher" }, { ...parsed, asking: "takes" }).asking).toBeNull();
  });
});

describe("the reply for an answer helper", () => {
  it("knows the answer fields and asks about the planned one", () => {
    expect(knownLine(blurb)).toBe(
      "Known so far: name Shop blurb writer, kind answer, takes a product name and a few facts, does writes a friendly two line blurb; missing: gives.",
    );
    expect(askLine(blurb, { asking: "gives", choices: ["The blurb"] })).toBe(
      'Ask about: gives (what comes back). The user will see these buttons: "The blurb". Your question must fit them.',
    );
  });

  it("asks for rules and voice once it is described, then points at Publish", () => {
    const line = askLine(done, { asking: null, choices: [] });
    expect(line).toContain("ask what it must always or never do and how it should sound");
    expect(line).toContain("the Publish button on the sketch puts it on the board");
    expect(line).not.toContain("switching it on");
    expect(replySystemPrompt(done, null).split("\n")[1]).toBe(
      "Known so far: name Shop blurb writer, kind answer, takes a product name and a few facts, does writes a friendly two line blurb, gives the blurb, ready to paste; missing: nothing.",
    );
  });

  it("still asks for the missing piece when a field is empty", () => {
    expect(askLine(blurb, { asking: null, choices: [] })).toBe("Ask about the most important missing piece.");
  });
});

describe("the dock for an answer helper", () => {
  it("draws takes, does and gives, waiting on the asked field", () => {
    const dock = sketchFromDTO(blurb);
    expect(nodesOf(dock)).toEqual({ take: "on", do: "on", give: "ask" });
    expect(linksOf(nodesOf(dock))).toEqual([true, false]);
    expect(isReady(dock)).toBe(false);
    expect(statusLine(dock, false)).toBe("Waiting on one answer from you");
  });

  it("is ready to publish once all three are set", () => {
    const dock = sketchFromDTO(done);
    expect(nodesOf(dock)).toEqual({ take: "on", do: "on", give: "on" });
    expect(linksOf(nodesOf(dock))).toEqual([true, true]);
    expect(isReady(dock)).toBe(true);
    expect(statusLine(dock, false)).toBe("Ready to publish");
  });

  it("leaves an agent's diagram as it was", () => {
    const watcher = sketchFromDTO({ ...blank, kind: "watcher", watches: "ETH", when: "below $2,000", how: "hourly", tells: "Telegram" });
    expect(nodesOf(watcher)).toEqual({ watch: "on", decide: "on", tell: "on" });
    expect(statusLine(watcher, false)).toBe("Ready. Switching on comes in the next update.");
  });
});
