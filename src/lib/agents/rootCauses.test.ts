import { describe, expect, it } from "vitest";
import { checkDefinition, payeeSetting, type AgentDefinition } from "./definition";
import { repaired, wireToDefinition } from "./plan";
import { askedFirst, columnsByName, fixSetup } from "./planRepairs";
import { fitSample, namedColumns, sampleRequest } from "./sample";
import { checksFor, sampleKey, selfTest } from "./test";
import { CODE_PROMPT } from "./code";
import { DETAIL_PROMPT, outlinePrompt } from "./planStages";
import { codeOf, definitionOf, MOTIVATION_WIRE, PAY_SOURCES, PAY_WIRE, PRICE_WIRE } from "@/test/suiteFixtures";
import { emptyBench, type TestResult } from "./types";

// The causes of the failures seen in live testing, put right where they
// start: in the plan's repairs, the prompts, and the sample a test runs on.

const step = <T extends Record<string, unknown>>(o: T) => ({ plain: "", inputs: [] as string[], outputs: [] as string[], next: "", description: "", tools: [] as string[], prompt: "", each: "", from: "", outcomes: [] as { id: string; label: string; next: string }[], action: "", otherwise: "", over: "", item: "", body: "", gather: [] as string[], ...o });
const action = (id: string, tool: string, description: string) => ({ id, tool, description, askOver: "", askOverDay: "", amountColumn: "" });
const fix = (wire: Record<string, unknown>, o: { askedFirst?: boolean } = {}) => repaired(wireToDefinition(JSON.parse(JSON.stringify(wire))), o) as AgentDefinition;
const ids = (d: AgentDefinition) => d.steps.map((s) => s.id);
const describedAs = (d: AgentDefinition, id: string) => (d.steps.find((s) => s.id === id) as { description?: string }).description ?? "";

// The weekly payment as SERV planned it in live testing: its own question
// and its own allowance check in front of the payment the platform asks
// about anyway, and a payment step with nothing made for it.
const DOUBLED = {
  ...PAY_WIRE,
  actions: [action("ask_owner", "telegram.ask", "Ask the owner before paying"), action("pay_designer", "wallet.pay", "Pay the designer")],
  steps: [
    step({ id: "check_allowance", title: "Check USDC allowance", kind: "code", inputs: ["settings"], outputs: ["allowance_ok"], next: "enough", description: "Check the allowance is at least settings.amount_usdc and return allowance_ok." }),
    step({ id: "enough", title: "Enough allowance?", kind: "decision", inputs: ["allowance_ok"], from: "allowance_ok", prompt: "Is the allowance enough?", outcomes: [{ id: "yes", label: "Enough", next: "make_question" }, { id: "no", label: "Not enough", next: "" }] }),
    step({ id: "make_question", title: "Write the question", kind: "code", inputs: ["settings"], outputs: ["question"], next: "ask", description: "Return question as telegram.ask's arguments asking to pay the designer." }),
    step({ id: "ask", title: "Ask the owner", kind: "action", action: "ask_owner", inputs: ["question"], outputs: ["reply"], next: "said_yes" }),
    step({ id: "said_yes", title: "Did you say yes?", kind: "decision", inputs: ["reply"], from: "reply", prompt: "Did the owner say yes?", outcomes: [{ id: "yes", label: "Yes", next: "pay" }, { id: "no", label: "No", next: "" }] }),
    step({ id: "pay", title: "Pay the designer", kind: "action", action: "pay_designer", inputs: ["settings"], next: "" }),
  ],
};

describe("a payment", () => {
  it("never gets a question or an allowance check of the plan's own: the payment does both", () => {
    const d = fix(DOUBLED, { askedFirst: true });
    expect(ids(d)).toEqual(["make_pay", "pay"]);
    expect(d.actions.map((a) => a.tool)).toEqual(["wallet.pay"]);
    const checked = checkDefinition(d);
    expect(checked.ok ? [] : checked.errors).toEqual([]);
  });

  it("is made every run by a step that always acts: no null when there is nothing to do", () => {
    const d = fix(DOUBLED, { askedFirst: true });
    expect(describedAs(d, "make_pay")).toContain("wallet.pay's arguments");
    expect(describedAs(d, "make_pay")).toContain("every run");
    expect(describedAs(d, "make_pay")).not.toMatch(/null|nothing to do/);
    // One that reads rows that can come up empty may find nothing to do.
    const sales = fix({ ...MOTIVATION_WIRE, actions: [action("send_line", "telegram.send", "Send the totals")], steps: [step({ id: "read", title: "Read", kind: "code", inputs: ["settings"], outputs: ["rows"], next: "send", description: "Read the sheet.", tools: ["sheets.read"] }), step({ id: "send", title: "Send", kind: "action", action: "send_line", inputs: [], next: "" })] });
    expect(describedAs(sales, "make_send")).toContain("return null when there is nothing to do");
  });

  it("is to a saved payee by the name the maker gave, which Connect and the sample both use", () => {
    const d = definitionOf(PAY_WIRE);
    expect(payeeSetting(d)).toMatchObject({ key: "payee_name", given: "Designer" });
    expect(payeeSetting(definitionOf(PRICE_WIRE))).toBeNull();
  });
});

describe("a question to the owner", () => {
  const PRICE_ASKS = { ...PRICE_WIRE };
  it("stays when the maker asked to be asked, and goes when they never did", () => {
    expect(ids(fix(PRICE_ASKS, { askedFirst: true }))).toContain("ask");
    const d = fix(PRICE_ASKS, { askedFirst: false });
    expect(ids(d)).toEqual(["read_price", "is_low", "make_reminder", "send"]);
    expect(checkDefinition(d).ok).toBe(true);
  });

  it("counts as asked only in the maker's own words, never in a sentence that says it needn't", () => {
    expect(askedFirst(["Every day check the page. If it's below my target, ask me on Telegram whether to send a reminder."])).toBe(true);
    expect(askedFirst(["Every Friday, pay 0.5 USDC to Designer, and ask me on Telegram before paying."])).toBe(true);
    expect(askedFirst(["Check new rows every hour.", "It never needs to ask me anything."])).toBe(false);
    expect(askedFirst(["Message me when it drops below my target."])).toBe(false);
    expect(askedFirst([], null)).toBe(true);
    expect(askedFirst(["Check my stock."], "orders over 250 USDC")).toBe(true);
    expect(askedFirst(["Check my stock."], "nothing")).toBe(false);
  });
});

describe("the setup", () => {
  it("reads columns by their header names, never by a letter the plan made up", () => {
    const steps = [{ id: "low", title: "Find low", kind: "code", inputs: ["rules"], outputs: ["low"], description: "Return the rows whose rules.quantity_column is below rules.minimum_column." }];
    const drop = columnsByName(steps, { settings: [], rules: [{ key: "quantity_column", label: "Quantity column", value: "B" }, { key: "minimum_column", label: "Which column holds the minimum?", value: "C" }, { key: "max_order", label: "Largest order", value: "250" }] });
    expect(drop).toEqual({ settings: [], rules: ["quantity_column", "minimum_column"] });
    expect(steps[0]!.description).toBe('Return the rows whose the "Quantity" column is below the "Minimum" column.');
  });

  it("picks a sheet, never asks for its link, id or name", () => {
    expect(fixSetup([{ key: "sales_tab", label: "Which tab holds your sales?", type: "text" }, { key: "sheet_link", label: "Your sheet's link", type: "url" }, { key: "status_column", label: "The sheet column for the status", type: "text" }])).toEqual([
      { key: "sales_tab", label: "Which tab holds your sales?", type: "sheet" },
      { key: "sheet_link", label: "Your sheet's link", type: "sheet" },
      { key: "status_column", label: "The sheet column for the status", type: "text" },
    ]);
  });
});

describe("the prompts", () => {
  it("tell the planner payments ask by themselves, and tell Dolphin never to invent inputs", () => {
    const outline = outlinePrompt(5, "");
    expect(outline).toContain("Never add a step that checks the allowance");
    expect(outline).toContain("never for a payment (it asks by itself)");
    expect(DETAIL_PROMPT).toContain("A step that always acts (a weekly payment, a morning message) always returns what it makes, never null");
    expect(CODE_PROMPT).toContain("never invent input fields, flags or options the step doesn't name");
  });
});

describe("the sample a payment is tried on", () => {
  const d = definitionOf(PAY_WIRE);
  const sample = { bench: { ...emptyBench(), settings: { payee_name: "the designer", amount_usdc: 0.5 } }, items: { noun: "payment", plural: "payments", labels: ["Weekly fee"] } };

  it("has the payee saved by the name the plan pays, and allowance enough", () => {
    const fitted = fitSample(d, sample);
    expect(fitted.bench.settings.payee_name).toBe("Designer");
    expect(fitted.bench.payees).toEqual(["Designer"]);
    expect(fitted.bench.wallet.balanceUsdc).toBeGreaterThanOrEqual(1000);
    expect(sampleRequest(d)).toContain('It pays the payee named in payee_name: "Designer", exactly.');
  });

  it("passes a run where the owner says yes and one where they say no, and pays nothing on the no", async () => {
    expect(checksFor(d)).toEqual(["ran", "tool_error", "did_job", "said_no"]);
    const bench = fitSample(d, sample).bench;
    const kept: TestResult = { status: "passed", story: "", problems: [], items: sample.items, kind: "self", checkedAt: "2026-11-11T00:00:00.000Z", sample: bench, sampleOf: sampleKey(d) };
    const t = await selfTest({ definition: d, code: codeOf(d, PAY_SOURCES), testResult: kept }, { serv: null });
    expect(t.result.problems).toEqual([]);
    expect(t.result.story).toBe('Passed. It paid 0.5 test USDC to "Designer".');
    expect(t.noRun!.some((e) => e.type === "tool" && e.tool === "wallet.pay" && !e.error)).toBe(false);
  });

  it("fails a payment to a name that isn't a saved payee", async () => {
    const bench = fitSample(d, sample).bench;
    const kept: TestResult = { status: "passed", story: "", problems: [], items: sample.items, kind: "self", checkedAt: "2026-11-11T00:00:00.000Z", sample: bench, sampleOf: sampleKey(d) };
    const wrong = { make_payment: PAY_SOURCES.make_payment!.replace("input.settings.payee_name", '"the design studio"') };
    const t = await selfTest({ definition: d, code: codeOf(d, wrong), testResult: kept }, { serv: null });
    expect(t.result.status).toBe("failed");
  });

  it("fails one that still acts after the owner said no", async () => {
    // When the owner says no to the payment, it goes on to tell them it paid.
    const told = definitionOf({
      ...PAY_WIRE,
      rules: [{ key: "ask_over", label: "Ask me before payments over", type: "usdc", value: "0", help: "Payments over this wait for your yes." }],
      actions: [{ ...action("pay_designer", "wallet.pay", "Pay the designer this week's amount"), askOver: "ask_over" }, action("send_note", "telegram.send", "Tell you it paid")],
      steps: [
        ...PAY_WIRE.steps.map((s) => (s.id === "pay" ? { ...s, next: "make_note", otherwise: "make_note" } : s)),
        step({ id: "make_note", title: "Write the note", kind: "code", inputs: ["settings"], outputs: ["note"], next: "send", description: "Return note as telegram.send's arguments: the payment went out." }),
        step({ id: "send", title: "Tell you", kind: "action", action: "send_note", inputs: ["note"], next: "" }),
      ],
    });
    const bench = fitSample(told, sample).bench;
    const kept: TestResult = { status: "passed", story: "", problems: [], items: sample.items, kind: "self", checkedAt: "2026-11-11T00:00:00.000Z", sample: bench, sampleOf: sampleKey(told) };
    const t = await selfTest({ definition: told, code: codeOf(told, { ...PAY_SOURCES, make_note: 'async function run() { return { note: { text: "Paid the designer." } }; }' }), testResult: kept }, { serv: null });
    expect(t.result.status).toBe("failed");
    expect(t.result.problems).toEqual([{ step: "send", text: "When you say no, it still messages you.", check: "said_no" }]);
  });

  it("names the columns its steps read for the sample to have", () => {
    const sales = definitionOf({ ...MOTIVATION_WIRE, settings: [{ key: "sheet", label: "Your sheet", type: "sheet", help: "x", choices: [] }], actions: [action("send_line", "telegram.send", "Send the totals")], steps: [step({ id: "read", title: "Read", kind: "code", inputs: ["settings"], outputs: ["totals"], next: "send", description: 'Read settings.sheet. Keep the rows whose Date column is today, add up the "Amount" column, and read the columns Item, Quantity and Minimum.', tools: ["sheets.read"] }), step({ id: "send", title: "Send", kind: "action", action: "send_line", inputs: ["totals"], next: "" })] });
    expect(namedColumns(sales).sort()).toEqual(["Amount", "Date", "Item", "Minimum", "Quantity"]);
    const fitted = fitSample(sales, { bench: { ...emptyBench(), sheets: { Sales: [{ Date: "2026-11-11", Amount: "3" }] } }, items: { noun: "sale", plural: "sales", labels: ["x"] } });
    expect(Object.keys(fitted.bench.sheets.Sales![0]!).sort()).toEqual(["Amount", "Date", "Item", "Minimum", "Quantity"]);
  });
});
