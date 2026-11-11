// @vitest-environment node
import { describe, expect, it } from "vitest";
import { modelConfig } from "@/lib/model";
import type { SketchDTO } from "@/lib/types";
import { RESTOCK_WIRE } from "@/test/agentFixtures";
import { servOnly } from "./build";
import { MAX_PLAN_CALLS, MAX_REPAIRS, planAgent, planRequest, STEPS_PER_CALL, wireToDefinition } from "./plan";
import { blame, DETAIL_SCHEMA, detailChunks, OUTLINE_SCHEMA } from "./planStages";
import { askedSteps, detailsOf, outlineOf, planAnswer } from "@/test/planAnswers";
import { NESTED_HACKATHON_WIRE } from "@/test/hackathonFixture";

// Planning against a mocked SERV, in two stages: the joined plan is checked
// against the format, and each reason goes back to the stage at fault, up
// to a bounded number of calls.

const interview: SketchDTO = {
  name: "Fabric restock",
  kind: "agent",
  watches: null,
  when: null,
  how: null,
  tells: null,
  takes: null,
  does: null,
  gives: null,
  wakes: "every morning at eight",
  looks: "the Stock sheet and three suppliers' prices",
  handles: "orders what's low from the best supplier",
  finish: "every low fabric has an order",
  asks: "orders over 250 USDC",
  setup: "the stock and orders sheets",
  remembers: "the last order",
  asking: null,
  live: false,
};

// SERV planning in two stages (planStages.ts): each outline call takes the
// next plan from the list, and its details come from that plan, unless a
// details answer is given for the call.
function serv(plans: (Record<string, unknown> | number)[], details: (Record<string, unknown> | null)[] = []) {
  const bodies: { messages: { role: string; content: string }[]; response_format: { json_schema: { name: string; strict: boolean } } }[] = [];
  const urls: string[] = [];
  let planning: Record<string, unknown> = RESTOCK_WIRE;
  const fetchImpl = (async (url: string, init: RequestInit) => {
    urls.push(url);
    const body = JSON.parse(String(init.body)) as (typeof bodies)[number];
    bodies.push(body);
    const name = body.response_format.json_schema.name;
    // A status stays: SERV is down for every try.
    if (typeof plans[0] === "number") return new Response("{}", { status: plans[0] });
    if (name === "agent_outline") planning = (plans.shift() as Record<string, unknown> | undefined) ?? planning;
    const given = name === "agent_steps" ? details.shift() : null;
    const answer = given ?? planAnswer(planning, body);
    return Response.json({ choices: [{ message: { content: JSON.stringify(answer) } }], usage: { prompt_tokens: 1200, completion_tokens: 900 } });
  }) as typeof fetch;
  return { fetchImpl, bodies, urls };
}

const config = servOnly(modelConfig({ SERV_API_KEY: "test-serv", DOLPHIN_API_KEY: "test-dolphin" }));
const plan = (fetchImpl: typeof fetch) => planAgent({ interview, history: [{ role: "user", content: "Restock my fabric shop" }] }, { config, signal: new AbortController().signal, fetchImpl });
const schemaOf = (b: { response_format: { json_schema: { name: string } } }) => b.response_format.json_schema.name;

describe("planning", () => {
  it("asks SERV alone, in two stages, with the interview and the conversation, and keeps a plan that checks out", async () => {
    const { fetchImpl, bodies, urls } = serv([RESTOCK_WIRE]);
    const r = await plan(fetchImpl);
    expect(r.definition?.name).toBe("Fabric restock");
    expect(r.calls).toHaveLength(2);
    expect(urls).toEqual(Array(2).fill("https://inference-api.openserv.ai/v1/chat/completions"));
    expect(config.providers.map((p) => p.id)).toEqual(["serv"]);
    expect(bodies.map((b) => b.response_format.json_schema)).toMatchObject([
      { name: "agent_outline", strict: true },
      { name: "agent_steps", strict: true },
    ]);
    for (const b of bodies) {
      expect(b.messages[1]!.content).toContain("Asks you before: orders over 250 USDC");
      expect(b.messages[1]!.content).toContain("Maker: Restock my fabric shop");
    }
    // The details call has the outline, and asks for every step.
    expect(bodies[1]!.messages[1]!.content).toContain("The outline:");
    expect(askedSteps(bodies[1]!.messages[1]!.content)).toEqual(["find_low", "compare", "check_total", "ask_owner", "approved", "record"]);
  });

  it("details a long plan a few steps at a time, a loop with the steps inside it", async () => {
    const long = { ...NESTED_HACKATHON_WIRE, steps: [...NESTED_HACKATHON_WIRE.steps.slice(0, 1), { ...NESTED_HACKATHON_WIRE.steps[0]!, id: "tidy", title: "Tidy the rows", next: "each_submission", outputs: ["tidied"], tools: [] }, ...NESTED_HACKATHON_WIRE.steps.slice(1)].map((s) => (s.id === "find_new" ? { ...s, next: "tidy" } : s)) };
    // A loop is never split from the steps inside it.
    expect(detailChunks(outlineOf(long), 5)).toEqual([["find_new", "tidy"], ["each_submission", "each_requirement", "judge", "count_met", "make_updates"], ["write_status", "send"]]);
    const { fetchImpl, bodies } = serv([NESTED_HACKATHON_WIRE]);
    const r = await plan(fetchImpl);
    expect(r.errors).toEqual([]);
    expect(r.definition?.steps.map((s) => s.kind)).toEqual(["code", "loop", "loop", "decision", "code", "code", "action", "action"]);
    expect(bodies.map(schemaOf)).toEqual(["agent_outline", "agent_steps", "agent_steps"]);
    expect(STEPS_PER_CALL).toBe(6);
    expect(askedSteps(bodies[1]!.messages[1]!.content)).toEqual(["find_new", "each_submission", "each_requirement", "judge", "count_met", "make_updates"]);
    expect(askedSteps(bodies[2]!.messages[1]!.content)).toEqual(["write_status", "send"]);
    // Later details see the names earlier ones gave, and where each sits.
    expect(bodies[2]!.messages[1]!.content).toContain('"outputs":["results"]');
    expect(bodies[1]!.messages[1]!.content).toContain("- judge: decision, Judge the requirement (inside the loop each_requirement, inside the loop each_submission)");
  });

  it("sends back only the steps whose details don't check out, with the reasons", async () => {
    const wrong = detailsOf({ ...RESTOCK_WIRE, steps: RESTOCK_WIRE.steps.map((s) => (s.id === "record" ? { ...s, action: "pay_supplier" } : s)) }, RESTOCK_WIRE.steps.map((s) => s.id));
    const { fetchImpl, bodies } = serv([RESTOCK_WIRE], [wrong]);
    const r = await plan(fetchImpl);
    expect(r.definition).not.toBeNull();
    expect(bodies.map(schemaOf)).toEqual(["agent_outline", "agent_steps", "agent_steps"]);
    const again = bodies[2]!.messages[1]!.content;
    expect(askedSteps(again)).toEqual(["record"]);
    expect(again).toContain('- step "record" takes "pay_supplier", which is not a declared action');
  });

  it("sends a broken outline back alone, and keeps the details of the steps it kept", async () => {
    const { fetchImpl, bodies } = serv([{ ...RESTOCK_WIRE, triggers: [] }, RESTOCK_WIRE]);
    const r = await plan(fetchImpl);
    expect(r.definition).not.toBeNull();
    expect(bodies.map(schemaOf)).toEqual(["agent_outline", "agent_steps", "agent_outline"]);
    expect(bodies[2]!.messages.at(-1)!.content).toMatch(/^That outline has problems:\n- triggers/);
    expect(bodies[2]!.messages.at(-1)!.content).toContain("Send the whole corrected outline.");
  });

  it("sends a step whose details fail twice back to the outline", async () => {
    const wrong = () => detailsOf({ ...RESTOCK_WIRE, steps: RESTOCK_WIRE.steps.map((s) => (s.id === "record" ? { ...s, action: "pay_supplier" } : s)) }, ["record"]);
    const first = detailsOf({ ...RESTOCK_WIRE, steps: RESTOCK_WIRE.steps.map((s) => (s.id === "record" ? { ...s, action: "pay_supplier" } : s)) }, RESTOCK_WIRE.steps.map((s) => s.id));
    const { fetchImpl, bodies } = serv([RESTOCK_WIRE, RESTOCK_WIRE], [first, wrong()]);
    const r = await plan(fetchImpl);
    expect(r.definition).not.toBeNull();
    expect(bodies.map(schemaOf)).toEqual(["agent_outline", "agent_steps", "agent_steps", "agent_outline", "agent_steps"]);
    expect(bodies[3]!.messages.at(-1)!.content).toContain('- step "record" takes "pay_supplier", which is not a declared action');
  });

  it("reads which stage a reason is about", () => {
    const outline = outlineOf(NESTED_HACKATHON_WIRE);
    const args = (id: string) => `step "${id}" takes write_results (sheets.update), so its first input must be sheets.update's arguments, made by a code step before it`;
    // A code step right before the action: its details, and that step's.
    const b = blame([args("write_status")], outline);
    expect(b.outline).toEqual([]);
    expect([...b.steps.keys()]).toEqual(["write_status", "make_updates"]);
    // None: the outline needs one.
    const none = blame([args("send")], outline);
    expect(none.outline).toEqual([args("send")]);
    // Judging in code, a missing trigger and an unreachable step are the outline's.
    expect(blame(['code step "count_met" judges ("Count what it met"): judgement goes to a decision step', "triggers: too small", 'step "send" can\'t be reached from the first step'], outline).outline).toHaveLength(3);
    // What a step reads is its own detail; a value gone after a loop is the reader's and the loop's.
    const gone = 'step "make_updates" reads "result", which is made inside the loop "each_submission" and is gone once its passes end: gather it in that loop (its outputs and gather) and read the gathered list';
    expect([...blame([gone], outline).steps.keys()]).toEqual(["make_updates", "each_submission"]);
  });

  it("gives up once SERV has been asked to put it right twice, with the last reasons", async () => {
    const { fetchImpl } = serv(Array.from({ length: 20 }, () => ({ ...RESTOCK_WIRE, triggers: [] })));
    const r = await plan(fetchImpl);
    expect(MAX_REPAIRS).toBe(2);
    expect(r).toMatchObject({ definition: null });
    // The outline and its details, then the outline twice more with the
    // reasons: never all of MAX_PLAN_CALLS.
    expect(r.calls.map((c) => c.attempts[0]?.purpose)).toEqual(["agent_outline", "agent_steps", "agent_outline", "agent_outline"]);
    expect(r.calls.length).toBeLessThan(MAX_PLAN_CALLS);
    expect(r.errors.join(" ")).toMatch(/triggers/);
  });

  it("stops at once when SERV doesn't answer", async () => {
    const { fetchImpl } = serv([500]);
    const r = await plan(fetchImpl);
    expect(r).toMatchObject({ definition: null, errors: ["No model answered."] });
    expect(r.calls).toHaveLength(1);
  });

  it("changes a plan from what the maker says, keeping the plan as it is in view", () => {
    const current = (() => {
      const d = wireToDefinition(RESTOCK_WIRE);
      return d as never;
    })();
    const text = planRequest({ interview, history: [], current, feedback: "it ignored delivery time" });
    expect(text).toContain("The plan as it is:");
    expect(text).toContain("The maker says: it ignored delivery time");
    expect(text).toContain("Keep the ids of steps that stay the same.");
  });

  it("uses schemas SERV accepts: strict, every field required, no numeric range keywords or nulls", () => {
    for (const schema of [OUTLINE_SCHEMA, DETAIL_SCHEMA]) {
      const text = JSON.stringify(schema);
      for (const banned of ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "minItems", "maxItems", "minLength", "maxLength", "null", "anyOf", "oneOf"]) {
        expect(text).not.toContain(`"${banned}"`);
      }
      const walk = (node: unknown) => {
        if (!node || typeof node !== "object") return;
        const n = node as { type?: string; properties?: Record<string, unknown>; required?: string[]; additionalProperties?: boolean; items?: unknown };
        if (n.type === "object") {
          expect(n.additionalProperties).toBe(false);
          expect(n.required?.sort()).toEqual(Object.keys(n.properties ?? {}).sort());
        }
        Object.values(n.properties ?? {}).forEach(walk);
        walk(n.items);
      };
      walk(schema.schema);
    }
  });
});

describe("reading SERV's answer", () => {
  it("reads the bag a setting, rule or memory key lives in when a step names the key itself", () => {
    const wire = {
      ...RESTOCK_WIRE,
      steps: RESTOCK_WIRE.steps.map((s) =>
        s.id === "find_low" ? { ...s, inputs: ["stock_sheet"] } : s.id === "check_total" ? { ...s, inputs: ["order"] } : s,
      ),
    };
    const d = wireToDefinition(wire) as { steps: { id: string; inputs: string[] }[] };
    // Named as an input: the key becomes its bag.
    expect(d.steps.find((s) => s.id === "find_low")!.inputs).toEqual(["settings"]);
    // Named in the words: the bag is added.
    expect(d.steps.find((s) => s.id === "check_total")!.inputs).toEqual(["order", "rules"]);
  });
});
