// @vitest-environment node
import { describe, expect, it } from "vitest";
import { modelConfig } from "@/lib/model";
import type { SketchDTO } from "@/lib/types";
import { RESTOCK_WIRE } from "@/test/agentFixtures";
import { servOnly } from "./build";
import { AGENT_PLAN_SCHEMA, MAX_PLAN_TRIES, planAgent, planRequest, wireToDefinition } from "./plan";

// Planning against a mocked SERV: the answer is checked against the format,
// and a plan that fails goes back with the reasons, up to three tries.

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

function serv(answers: (object | string | number)[]) {
  const bodies: { messages: { role: string; content: string }[]; response_format: { json_schema: { name: string; strict: boolean } } }[] = [];
  const urls: string[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    urls.push(url);
    bodies.push(JSON.parse(String(init.body)));
    const next = answers.shift();
    if (typeof next === "number") return new Response("{}", { status: next });
    return Response.json({ choices: [{ message: { content: typeof next === "string" ? next : JSON.stringify(next) } }], usage: { prompt_tokens: 1200, completion_tokens: 900 } });
  }) as typeof fetch;
  return { fetchImpl, bodies, urls };
}

const config = servOnly(modelConfig({ SERV_API_KEY: "test-serv", DOLPHIN_API_KEY: "test-dolphin" }));
const plan = (fetchImpl: typeof fetch) => planAgent({ interview, history: [{ role: "user", content: "Restock my fabric shop" }] }, { config, signal: new AbortController().signal, fetchImpl });

describe("planning", () => {
  it("asks SERV alone, with the interview and the conversation, and keeps a plan that checks out", async () => {
    const { fetchImpl, bodies, urls } = serv([RESTOCK_WIRE]);
    const r = await plan(fetchImpl);
    expect(r.definition?.name).toBe("Fabric restock");
    expect(r.calls).toHaveLength(1);
    expect(urls).toEqual(["https://inference-api.openserv.ai/v1/chat/completions"]);
    expect(config.providers.map((p) => p.id)).toEqual(["serv"]);
    expect(bodies[0]!.response_format.json_schema).toMatchObject({ name: "agent_plan", strict: true });
    expect(bodies[0]!.messages[1]!.content).toContain("Asks you before: orders over 250 USDC");
    expect(bodies[0]!.messages[1]!.content).toContain("Maker: Restock my fabric shop");
  });

  it("sends a plan that doesn't check out back with the reasons, and keeps the corrected one", async () => {
    const broken = { ...RESTOCK_WIRE, steps: RESTOCK_WIRE.steps.map((s) => (s.id === "record" ? { ...s, action: "pay_supplier" } : s)) };
    const { fetchImpl, bodies } = serv([broken, "not json", RESTOCK_WIRE]);
    const r = await plan(fetchImpl);
    expect(r.definition).not.toBeNull();
    // An answer that isn't JSON is tried again inside the call (model.ts),
    // with the same messages, before the plan sees it.
    expect(r.calls).toHaveLength(2);
    expect(r.calls[1]!.attempts.map((a) => a.outcome)).toEqual(["unusable", "ok"]);
    expect(bodies[1]!.messages.at(-1)!.content).toBe('That plan has problems:\n- step "record" takes "pay_supplier", which is not a declared action\nSend the whole corrected plan.');
    expect(bodies[2]!.messages).toEqual(bodies[1]!.messages);
  });

  it("gives up after three tries with the last reasons", async () => {
    const broken = { ...RESTOCK_WIRE, triggers: [] };
    const { fetchImpl } = serv([broken, broken, broken, RESTOCK_WIRE]);
    const r = await plan(fetchImpl);
    expect(MAX_PLAN_TRIES).toBe(3);
    expect(r).toMatchObject({ definition: null });
    expect(r.calls).toHaveLength(3);
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

  it("uses a schema SERV accepts: strict, every field required, no numeric range keywords or nulls", () => {
    const text = JSON.stringify(AGENT_PLAN_SCHEMA);
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
    walk(AGENT_PLAN_SCHEMA.schema);
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
