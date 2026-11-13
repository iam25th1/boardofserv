import { describe, expect, it } from "vitest";
import { definitionOf, codeOf, CANNED_MOTIVATION_SOURCE, MOTIVATION_SOURCES, MOTIVATION_WIRE, PRICE_SOURCES, PRICE_WIRE, priceBench, SALES_SOURCES, SALES_WIRE, salesBench } from "@/test/suiteFixtures";
import { NESTED_HACKATHON_WIRE } from "@/test/hackathonFixture";
import type { BenchData, TestResult } from "./types";
import { readSample, sampleCount, samplePrompt } from "./sample";
import { keepsPlace, sampleKey, selfTest } from "./test";
import type { AgentDefinition } from "./definition";
import { repaired, wireToDefinition } from "./plan";

// The self test fits the agent it tests: one sample item for an agent that
// handles one thing, three for one that goes through a list, and only the
// checks that apply to it. The price watcher that failed with "Its summary
// covers none of the products, not all 3" watches one product and sends
// no summary.

const kept = (d: AgentDefinition, bench: BenchData, items: NonNullable<TestResult["items"]>): TestResult => ({ status: "passed", story: "", problems: [], items, kind: "self", checkedAt: "2026-11-11T00:00:00.000Z", sample: bench, sampleOf: sampleKey(d) });

describe("the sample", () => {
  it("is one item for an agent that handles one thing, three for one that goes through a list", () => {
    expect(sampleCount(definitionOf(PRICE_WIRE))).toBe(1);
    expect(sampleCount(definitionOf(SALES_WIRE))).toBe(1);
    expect(sampleCount(definitionOf(NESTED_HACKATHON_WIRE))).toBe(3);
    expect(samplePrompt(1)).toContain("exactly one item");
    expect(samplePrompt(3)).toContain("exactly three items");
  });

  it("takes SERV's one product for the price watcher", () => {
    const d = definitionOf(PRICE_WIRE);
    const answer = { noun: "product", plural: "products", labels: ["Stone Kettle"], settings: [{ key: "product_url", value: "https://shop.example/kettle" }, { key: "target_price", value: "50" }], sheets: [], pages: [{ url: "https://shop.example/kettle", text: "Now $42.00" }], searches: [], answers: ["Yes"], steps: [] };
    const sample = readSample(d, JSON.stringify(answer));
    expect(sample?.items.labels).toEqual(["Stone Kettle"]);
    expect(sample?.bench.settings).toEqual({ product_url: "https://shop.example/kettle", target_price: 50 });
    expect(sample?.bench.telegram.answers).toEqual(["Yes"]);
  });
});

describe("the self test", () => {
  it("passes the price watcher on its one product, and tells what it did", async () => {
    const d = definitionOf(PRICE_WIRE);
    // The plan as the planner wants it: the repairs leave it as it is.
    expect(repaired(wireToDefinition(JSON.parse(JSON.stringify(PRICE_WIRE))), { askedFirst: true })).toEqual(wireToDefinition(PRICE_WIRE));
    const t = await selfTest({ definition: d, code: codeOf(d, PRICE_SOURCES), testResult: kept(d, priceBench(), { noun: "product", plural: "products", labels: ["Stone Kettle"] }) }, { serv: null });
    expect(t.result.problems).toEqual([]);
    expect(t.result.status).toBe("passed");
    expect(t.result.story).toBe('Passed. It read the page, asked you on Telegram "The price is now 42, at or below your target of 50. Send you a reminder to buy it? http..." (you answered "Yes") and sent you "Reminder: buy it now at 42. https://shop.example/kettle" on Telegram.');
  });

  it("tells a run that found nothing to do plainly, and doesn't call it a pass: its sample is made for it to work on", async () => {
    const d = definitionOf(PRICE_WIRE);
    const bench = { ...priceBench(), settings: { ...priceBench().settings, target_price: 30 } };
    const t = await selfTest({ definition: d, code: codeOf(d, PRICE_SOURCES), testResult: kept(d, bench, { noun: "product", plural: "products", labels: ["Stone Kettle"] }) }, { serv: null });
    expect(t.result.story).toBe('It read the page and found "above the target", so there was nothing more to do.');
    expect(t.result.status).toBe("failed");
    expect(t.result.problems.map((p) => p.text)).toEqual(["On its sample it didn't send you the reminder to buy it: it found nothing to do in data made for it to work on."]);
  });

  it("doesn't pass a step that read nothing on a sample made for it", async () => {
    const d = definitionOf(PRICE_WIRE);
    const t = await selfTest({ definition: d, code: codeOf(d, PRICE_SOURCES), testResult: kept(d, { ...priceBench(), pages: {} }, { noun: "product", plural: "products", labels: ["Stone Kettle"] }) }, { serv: null });
    expect(t.result.status).toBe("failed");
    expect(t.result.problems).toContainEqual(expect.objectContaining({ step: "read_price", check: "read_nothing" }));
  });

  it("doesn't pass a run that went on with nothing after a call went wrong", async () => {
    const d = definitionOf(PRICE_WIRE);
    // The page is asked for by an address too long to be one: the code
    // passes over the error and finds no price.
    const sources = { ...PRICE_SOURCES, read_price: "async function run(input, tools) { try { await tools.web.fetch({ url: 'x'.repeat(5000) }); } catch (e) {} return { price: null, price_way: 'not_low' }; }" };
    const t = await selfTest({ definition: d, code: codeOf(d, sources), testResult: kept(d, priceBench(), { noun: "product", plural: "products", labels: ["Stone Kettle"] }) }, { serv: null });
    expect(t.result.status).toBe("failed");
    expect(t.result.problems[0]!.text).toBe('"Read the price" couldn\'t read the page on the sample product, so it went on with nothing.');
  });

  it("passes the morning line: one message is not a summary of anything, and SERV writes it", async () => {
    const d = definitionOf(MOTIVATION_WIRE);
    const t = await selfTest({ definition: d, code: codeOf(d, MOTIVATION_SOURCES), testResult: kept(d, { ...priceBench(), settings: {}, pages: {}, telegram: { answers: [] } }, { noun: "message", plural: "messages", labels: ["Monday"] }) }, { serv: null });
    expect(t.result.status).toBe("passed");
    expect(t.result.story).toMatch(/^Passed\. It asked SERV and sent you ".+" on Telegram\.$/);
    expect(t.events.some((e) => e.type === "tool" && e.tool === "serv.reason")).toBe(true);
  });

  it("fails a line picked from a canned list: words for people come from SERV, never a stand-in", async () => {
    const d = definitionOf(MOTIVATION_WIRE);
    const t = await selfTest({ definition: d, code: codeOf(d, { pick_line: CANNED_MOTIVATION_SOURCE }), testResult: kept(d, { ...priceBench(), settings: {}, pages: {}, telegram: { answers: [] } }, { noun: "message", plural: "messages", labels: ["Monday"] }) }, { serv: null });
    expect(t.result.status).toBe("failed");
    expect(t.end.reason).toContain("without asking SERV");
    expect(t.events.some((e) => e.type === "tool" && e.tool === "telegram.send")).toBe(false);
  });

  it("passes the sales totals without a second run: totalling the day again is its job", async () => {
    const d = definitionOf(SALES_WIRE);
    expect(keepsPlace(d)).toBe(false);
    const t = await selfTest({ definition: d, code: codeOf(d, SALES_SOURCES), testResult: kept(d, salesBench(), { noun: "sale", plural: "sales", labels: ["Today"] }) }, { serv: null });
    expect(t.result.status).toBe("passed");
    expect(t.result.story).toBe('Passed. It read 3 rows of your sheet and sent you "Today: 2 sales, 42.50 in total." on Telegram.');
  });

  it("still checks the summary and the second run of an agent that goes through a list and marks its rows", () => {
    expect(keepsPlace(definitionOf(NESTED_HACKATHON_WIRE))).toBe(true);
  });
});
