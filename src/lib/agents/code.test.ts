// @vitest-environment node
import { describe, expect, it } from "vitest";
import { modelConfig, type Provider } from "@/lib/model";
import { COMPARE, FIND_LOW, RESTOCK_WIRE } from "@/test/agentFixtures";
import { servOnly } from "./build";
import { checkCode, codeRequest, extractCode, MAX_CODE_ROUNDS, writeStep, writeWithDolphin } from "./code";
import { checkDefinition, codeSpec, type AgentDefinition, type CodeStepDef } from "./definition";
import { wireToDefinition } from "./plan";

// Code writing and review with Dolphin and SERV mocked: Dolphin writes, the
// plain checks and SERV review, a rejection goes back, three rounds at most.

const d = (() => {
  const c = checkDefinition(wireToDefinition(RESTOCK_WIRE));
  if (!c.ok) throw new Error("fixture");
  return c.definition as AgentDefinition;
})();
const findLow = d.steps[0] as CodeStepDef;
const compare = d.steps[1] as CodeStepDef;
const dolphin = modelConfig({ DOLPHIN_API_KEY: "test-dolphin" }).providers[0] as Provider;
const serv = servOnly(modelConfig({ SERV_API_KEY: "test-serv", DOLPHIN_API_KEY: "test-dolphin" }));

interface Call {
  to: "dolphin" | "serv";
  body: { messages: { role: string; content: string }[]; chat_template_kwargs?: { thinking: boolean }; max_tokens: number };
}

// Dolphin answers from `code` in turn; SERV's reviews from `reviews`.
function models(code: (string | number)[], reviews: (object | number)[]) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Call["body"];
    if (url.includes("dphn.ai")) {
      calls.push({ to: "dolphin", body });
      const next = code.shift();
      if (typeof next === "number") return new Response("{}", { status: next });
      return Response.json({ choices: [{ message: { content: next } }], usage: { prompt_tokens: 300, completion_tokens: 80 } });
    }
    calls.push({ to: "serv", body });
    const next = reviews.shift();
    if (typeof next === "number") return new Response("{}", { status: next });
    return Response.json({ choices: [{ message: { content: JSON.stringify(next) } }], usage: { prompt_tokens: 500, completion_tokens: 30 } });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const fenced = (src: string) => "```js\n" + src + "\n```";
const approve = { verdict: "approve", reason: "Does what the step says." };
const reject = (reason: string) => ({ verdict: "reject", reason });

async function write(step: CodeStepDef, fetchImpl: typeof fetch) {
  const progress: string[] = [];
  const recorded: string[] = [];
  const entry = await writeStep(step, d, codeSpec(step), {
    dolphin,
    serv,
    fetchImpl,
    hooks: { progress: async (s, r) => void progress.push(`${s}${r}`), record: async (k) => void recorded.push(k) },
  });
  return { entry, progress, recorded };
}

describe("the code request", () => {
  it("tells Dolphin what the step must do, what each input holds and its tools' declarations", () => {
    const text = codeRequest(compare, d);
    expect(text).toContain("Step: Compare suppliers");
    expect(text).toContain("- low: from the step \"Find low stock\": Read the stock sheet");
    expect(text).toContain("- rules: the renter's limits: { approval_over_usdc: a number of USDC (Ask me before orders over), max_delivery_days: a number (Longest delivery) }");
    expect(text).toContain("- settings: the renter's setup: { stock_sheet: sheet");
    expect(text).toContain("This agent: Checks the stock sheet each morning");
    expect(text).toContain("Return: { order, order_rows }");
    // What feeds an action must be exactly that tool's arguments.
    expect(text).toContain('- order_rows must be exactly the arguments of tools.sheets.write({ sheet: string, rows: Array<Record<string, string | number | boolean | null>>, mode?: "append" | "replace" }), which the step "Record the order" calls with it.');
    const callable = text.slice(text.indexOf("Tools it may call:"));
    expect(callable).toContain("tools.sheets.read({ sheet: string })");
    expect(callable).not.toContain("tools.sheets.write");
  });
});

describe("the plain checks", () => {
  it("take the first fenced block, or bare code", () => {
    expect(extractCode(`Here:\n${fenced(FIND_LOW)}\nDone.`)).toBe(FIND_LOW);
    expect(extractCode(FIND_LOW)).toBe(FIND_LOW);
    expect(extractCode("I can't do that.")).toBeNull();
  });

  it("pass code that parses, defines run and calls only its step's tools", () => {
    expect(checkCode(FIND_LOW, findLow)).toBeNull();
    expect(checkCode(COMPARE, compare)).toBeNull();
    // The web.fetch tool is not the global fetch.
    expect(checkCode("async function run(i, tools) { const p = await tools.web\n  .fetch({ url: i.u }); return { low: p.text }; }", { ...findLow, tools: ["web.fetch"] })).toBeNull();
  });

  it("refuse code that won't parse, has no run, or reaches outside its step", () => {
    expect(checkCode("async function run( {", findLow)).toMatch(/^It doesn't parse/);
    expect(checkCode("function go() {}", findLow)).toBe("It doesn't define async function run(input, tools).");
    expect(checkCode("async function run(i, tools) { return tools.sheets.write({ sheet: 'x', rows: [] }); }", findLow)).toBe(
      "It calls sheets.write, which this step may not use (allowed: sheets.read).",
    );
    expect(checkCode("async function run(i, tools) { return tools['wallet']['pay']({}); }", findLow)).toMatch(/computed name/);
    for (const [src, why] of [
      ["async function run() { return require('fs'); }", "require"],
      ["async function run() { return import('fs'); }", "imports"],
      ["async function run() { return fetch('https://example.com'); }", "fetch"],
      ["async function run() { return process.env; }", "globals"],
      ["async function run() { return globalThis.x; }", "globals"],
      ["async function run() { return new Function('return 1')(); }", "code at run time"],
      ["async function run() { return eval('1'); }", "code at run time"],
      ["async function run(i) { return i.constructor; }", "prototypes"],
      ["async function run() { setTimeout(() => {}, 1); }", "timers"],
      ["async function run() { return new WebSocket('wss://x'); }", "network"],
    ]) {
      expect(checkCode(src!, findLow), src).toContain(why!);
    }
  });
});

describe("writing a step", () => {
  it("approves code SERV passes on the first round, Dolphin's reasoning off", async () => {
    const { fetchImpl, calls } = models([fenced(FIND_LOW)], [approve]);
    const { entry, progress, recorded } = await write(findLow, fetchImpl);
    expect(entry).toMatchObject({ status: "approved", source: FIND_LOW, rounds: 1, note: "Does what the step says." });
    expect(progress).toEqual(["writing1", "reviewing1"]);
    expect(recorded).toEqual(["agent_code", "agent_review"]);
    expect(calls.map((c) => c.to)).toEqual(["dolphin", "serv"]);
    expect(calls[0]!.body).toMatchObject({ max_tokens: 4000, chat_template_kwargs: { thinking: false } });
    // SERV sees the step and the code, and nothing of other steps.
    const review = calls[1]!.body.messages[1]!.content;
    expect(review).toContain("What it must do: Read the stock sheet");
    expect(review).toContain(FIND_LOW);
  });

  it("sends a rejection back to Dolphin with the reason, reasoning on, until SERV approves", async () => {
    const { fetchImpl, calls } = models([fenced("async function run(input, tools) { return { low: [] }; }"), fenced(FIND_LOW)], [reject("It never reads the stock sheet."), approve]);
    const { entry } = await write(findLow, fetchImpl);
    expect(entry).toMatchObject({ status: "approved", rounds: 2, source: FIND_LOW });
    const second = calls[2]!;
    expect(second.to).toBe("dolphin");
    expect(second.body.chat_template_kwargs).toEqual({ thinking: true });
    expect(second.body.messages.at(-1)!.content).toBe("It was rejected: It never reads the stock sheet.\nWrite the whole function again with that fixed.");
  });

  it("counts a failed plain check as a round, without asking SERV", async () => {
    const { fetchImpl, calls } = models([fenced("async function run() { return fetch('https://example.com'); }"), fenced(FIND_LOW)], [approve]);
    const { entry } = await write(findLow, fetchImpl);
    expect(entry).toMatchObject({ status: "approved", rounds: 2 });
    expect(calls.map((c) => c.to)).toEqual(["dolphin", "dolphin", "serv"]);
    expect(calls[1]!.body.messages.at(-1)!.content).toContain("It isn't allowed: it calls fetch.");
  });

  it("needs the maker's attention after three rejections, keeping the last reason and code", async () => {
    const bad = fenced("async function run(input, tools) { return { low: [] }; }");
    const { fetchImpl, calls } = models([bad, bad, bad, bad], [reject("Still ignores the sheet."), reject("Still ignores the sheet."), reject("Still ignores the sheet.")]);
    const { entry } = await write(findLow, fetchImpl);
    expect(MAX_CODE_ROUNDS).toBe(3);
    expect(entry).toMatchObject({ status: "needs_attention", rounds: 3, note: "Still ignores the sheet.", source: "async function run(input, tools) { return { low: [] }; }" });
    expect(calls.filter((c) => c.to === "dolphin")).toHaveLength(3);
  });

  it("is not approved when SERV can't review it", async () => {
    const { fetchImpl } = models([fenced(FIND_LOW)], [503]);
    const { entry } = await write(findLow, fetchImpl);
    expect(entry).toMatchObject({ status: "needs_attention", note: "SERV couldn't review it just now." });
  });

  it("asks Dolphin again without the reasoning switch if Dolphin ever refuses it", async () => {
    const { fetchImpl, calls } = models([400, fenced(FIND_LOW)], []);
    const r = await writeWithDolphin(dolphin, [{ role: "user", content: "x" }], { thinking: false, fetchImpl });
    expect(r).toMatchObject({ outcome: "ok", provider: "dolphin", promptTokens: 300, completionTokens: 80 });
    expect(calls[0]!.body.chat_template_kwargs).toEqual({ thinking: false });
    expect(calls[1]!.body.chat_template_kwargs).toBeUndefined();
  });
});
