// @vitest-environment node
import { describe, expect, it } from "vitest";
import { modelConfig } from "@/lib/model";
import type { SketchDTO } from "@/lib/types";
import { RESTOCK_WIRE } from "@/test/agentFixtures";
import { servOnly } from "./build";
import { MAX_PLAN_CALLS, planAgent, planRequest, wireToDefinition } from "./plan";
import { DETAIL_SCHEMA, OUTLINE_SCHEMA } from "./planStages";
import { askedSteps, detailsOf, planAnswer } from "@/test/planAnswers";

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

  it("gives up when its calls are used up, with the last reasons", async () => {
    const { fetchImpl } = serv(Array.from({ length: 20 }, () => ({ ...RESTOCK_WIRE, triggers: [] })));
    const r = await plan(fetchImpl);
    expect(MAX_PLAN_CALLS).toBe(10);
    expect(r).toMatchObject({ definition: null });
    expect(r.calls).toHaveLength(MAX_PLAN_CALLS);
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
