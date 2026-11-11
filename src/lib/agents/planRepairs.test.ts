import { describe, expect, it } from "vitest";
import { checkDefinition, type AgentDefinition } from "./definition";
import { planAgent, repaired, wireToDefinition } from "./plan";
import { servOnly } from "./build";
import { modelConfig } from "@/lib/model";
import { planAnswer } from "@/test/planAnswers";
import { planProblems } from "./planRules";
import { runAgent, wayOf } from "./runner";
import { codeOf, definitionOf, PRICE_SOURCES, PRICE_WIRE, priceBench } from "@/test/suiteFixtures";

// The repairs made to SERV's plan before it is checked (planRepairs.ts),
// on the mistakes the regression suite saw: the price watcher asked SERV
// to compare a price with a target, went through "each product" of one
// product page, and sent the owner a message no step had written.

const step = <T extends Record<string, unknown>>(o: T) => ({ plain: "", inputs: [] as string[], outputs: [] as string[], next: "", description: "", tools: [] as string[], prompt: "", each: "", from: "", outcomes: [] as { id: string; label: string; next: string }[], action: "", otherwise: "", over: "", item: "", body: "", gather: [] as string[], ...o });

// The price watcher as SERV planned it in the case that went wrong.
const SLIPPED = {
  ...PRICE_WIRE,
  steps: [
    step({ id: "each_product", title: "For each product", kind: "loop", inputs: ["settings"], outputs: ["prices"], over: "product_url", item: "product", body: "read_price", gather: ["price"], next: "is_low" }),
    step({ id: "read_price", title: "Read the price", kind: "code", inputs: ["product"], outputs: ["price"], next: "", description: "Fetch product and return price, the first amount on the page.", tools: ["web.fetch"] }),
    step({ id: "is_low", title: "Below the target?", kind: "decision", inputs: ["prices", "settings"], prompt: "Is the price at or below settings.target_price?", outcomes: [{ id: "low", label: "At or below the target", next: "ask" }, { id: "not_low", label: "Above the target", next: "" }] }),
    step({ id: "ask", title: "Ask you", kind: "action", action: "ask_owner", inputs: ["prices"], outputs: ["reply"], next: "said_yes" }),
    step({ id: "said_yes", title: "Did you say yes?", kind: "decision", inputs: ["reply"], prompt: "Did the owner say yes to the reminder?", outcomes: [{ id: "yes", label: "Yes", next: "send" }, { id: "no", label: "No", next: "" }] }),
    step({ id: "send", title: "Send the reminder", kind: "action", action: "send_reminder", inputs: ["prices", "settings"], next: "" }),
  ],
};

const fix = (wire: Record<string, unknown>) => repaired(wireToDefinition(JSON.parse(JSON.stringify(wire)))) as AgentDefinition;

describe("the repairs", () => {
  it("puts the slipped price watcher right with no call to SERV", () => {
    const d = fix(SLIPPED);
    const checked = checkDefinition(d);
    expect(checked.ok ? [] : checked.errors).toEqual([]);
    expect(planProblems(d)).toEqual([]);
    const by = (id: string) => d.steps.find((s) => s.id === id)!;
    // One product page is no list: the loop is gone, and its step reads the setting.
    expect(d.steps.map((s) => s.id)).toEqual(["read_price", "is_low", "make_ask", "ask", "said_yes", "make_send", "send"]);
    expect(by("read_price")).toMatchObject({ inputs: ["settings"], next: "is_low", description: expect.stringContaining("settings.product_url") });
    // The comparison goes by the way the code before it works out.
    expect(by("read_price").outputs).toEqual(["price", "is_low_way"]);
    expect((by("read_price") as { description: string }).description).toContain('Also return is_low_way: "low" (At or below the target) or "not_low" (Above the target)');
    expect(by("is_low")).toMatchObject({ from: "is_low_way" });
    // The owner's yes goes by their answer.
    expect(by("said_yes")).toMatchObject({ from: "reply" });
    // The question and the reminder are written by code right before them.
    expect(by("make_ask")).toMatchObject({ kind: "code", inputs: ["price", "settings"], next: "ask", description: expect.stringContaining("telegram.ask's arguments") });
    expect(by("ask").inputs).toEqual(["ask_content"]);
    expect(by("said_yes")).toMatchObject({ outcomes: [{ id: "yes", next: "make_send" }, { id: "no", next: null }] });
    expect(by("make_send")).toMatchObject({ description: expect.stringContaining("telegram.send's arguments { text }") });
  });

  it("leaves a judgement to SERV", () => {
    const wire = { ...SLIPPED, steps: [step({ id: "read", title: "Read the enquiry", kind: "code", outputs: ["enquiry"], next: "urgent", description: "Return enquiry." }), step({ id: "urgent", title: "Urgent?", kind: "decision", inputs: ["enquiry"], prompt: "Is this enquiry urgent: does the customer need an answer today?", outcomes: [{ id: "urgent", label: "Urgent", next: "" }, { id: "not_urgent", label: "Not urgent", next: "" }] })] };
    const d = fix(wire);
    expect(d.steps.find((s) => s.id === "urgent")).not.toHaveProperty("from");
  });

  it("puts a check of its own before a comparison that more than one step leads to", () => {
    const wire = {
      ...SLIPPED,
      steps: [
        step({ id: "start", title: "Read", kind: "code", inputs: ["settings"], outputs: ["price"], next: "maybe", description: "Return price." }),
        step({ id: "maybe", title: "Sale?", kind: "decision", inputs: ["price"], prompt: "Is the page showing a sale banner?", outcomes: [{ id: "sale", label: "Sale", next: "is_low" }, { id: "no_sale", label: "No sale", next: "is_low" }] }),
        step({ id: "is_low", title: "Below the target?", kind: "decision", inputs: ["price", "settings"], prompt: "Is the price below settings.target_price?", outcomes: [{ id: "low", label: "Low", next: "" }, { id: "high", label: "High", next: "" }] }),
      ],
    };
    const d = fix(wire);
    expect(d.steps.map((s) => s.id)).toEqual(["start", "maybe", "is_low_check", "is_low"]);
    expect(d.steps.find((s) => s.id === "maybe")).toMatchObject({ outcomes: [{ next: "is_low_check" }, { next: "is_low_check" }] });
    expect(d.steps.find((s) => s.id === "is_low")).toMatchObject({ from: "is_low_way", inputs: ["price", "settings", "is_low_way"] });
  });

  it("tells the code that makes a message what shape it makes", () => {
    const d = fix({ ...SLIPPED, steps: [step({ id: "write", title: "Write it", kind: "code", inputs: ["settings"], outputs: ["note"], next: "send", description: "Write the note." }), step({ id: "send", title: "Send", kind: "action", action: "send_reminder", inputs: ["note"], next: "" })] });
    expect(d.steps.map((s) => s.id)).toEqual(["write", "send"]);
    expect((d.steps[0] as { description: string }).description).toBe("Write the note. Return note as telegram.send's arguments { text }, the message in plain words.");
  });
});

describe("planning with the repairs", () => {
  it("takes the slipped price watcher in one outline and its details: nothing goes back to SERV", async () => {
    const asked: string[] = [];
    const fetchImpl = (async (_: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as Parameters<typeof planAnswer>[1];
      asked.push(body.response_format?.json_schema?.name ?? "");
      return Response.json({ choices: [{ message: { content: JSON.stringify(planAnswer(SLIPPED, body)) } }], usage: { prompt_tokens: 10, completion_tokens: 10 } });
    }) as unknown as typeof fetch;
    const interview = { name: "Price watcher", kind: "agent" as const, watches: null, when: null, how: null, tells: null, takes: null, does: null, gives: null, asking: null, live: false };
    const plan = await planAgent({ interview, history: [] }, { config: servOnly(modelConfig({ SERV_API_KEY: "test-serv" })), signal: new AbortController().signal, fetchImpl });
    expect(plan.errors).toEqual([]);
    expect(asked).toEqual(["agent_outline", "agent_steps"]);
    expect(plan.definition?.steps.map((s) => s.id)).toEqual(["read_price", "is_low", "make_ask", "ask", "said_yes", "make_send", "send"]);
  });
});

describe("a decision that goes by a value", () => {
  const d = (outcomes: [string, string][]) => ({ id: "x", title: "X", kind: "decision" as const, inputs: ["v"], outputs: [], prompt: "X?", from: "v", outcomes: outcomes.map(([id, label]) => ({ id, label, next: null })) });
  it("takes the outcome the value names, an answer of yes or no, or true and false", () => {
    const low = d([["low", "At or below the target"], ["not_low", "Above the target"]]);
    expect(wayOf(low, "not_low")?.id).toBe("not_low");
    expect(wayOf(low, "At or below the target")?.id).toBe("low");
    expect(wayOf(low, true)?.id).toBe("low");
    expect(wayOf(low, false)?.id).toBe("not_low");
    expect(wayOf(low, { outcome: "low" })?.id).toBe("low");
    expect(wayOf(low, "maybe")).toBeNull();
    const yes = d([["yes", "Yes"], ["no", "No"]]);
    expect(wayOf(yes, { answer: "Yes please" })?.id).toBe("yes");
    expect(wayOf(yes, { answer: "no thanks" })?.id).toBe("no");
    expect(wayOf(yes, { answer: null })).toBeNull();
  });

  it("asks no model on a live run: the price watcher compares and takes the owner's yes in code", async () => {
    const d = definitionOf(PRICE_WIRE);
    let called = 0;
    const end = await runAgent({
      definition: d,
      code: codeOf(d, PRICE_SOURCES),
      bench: priceBench(),
      dryRun: false,
      serv: servOnly(modelConfig({ SERV_API_KEY: "test-serv" })),
      fetchImpl: (async () => {
        called += 1;
        return new Response("{}", { status: 500 });
      }) as unknown as typeof fetch,
      onEvent: () => undefined,
    });
    expect(end.status).toBe("done");
    expect(called).toBe(0);
  });
});
