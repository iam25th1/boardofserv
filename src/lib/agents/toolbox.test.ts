import { describe, expect, it } from "vitest";
import { TOOL_NAMES } from "./definition";
import { BenchSchema, gate, MockTools, ToolError, TOOLS, toolTypes } from "./toolbox";
import { restockBench } from "@/test/agentFixtures";

// The toolbox's contract and its mocks, which answer from the bench's data.

describe("the toolbox", () => {
  it("declares every tool, with a signature for Dolphin and whether it changes anything", () => {
    expect(Object.keys(TOOLS).sort()).toEqual([...TOOL_NAMES].sort());
    expect(TOOLS["telegram.ask"].signature).toBe("tools.telegram.ask({ question: string, choices?: string[] }): Promise<{ answer: string | null }>");
    expect(TOOL_NAMES.filter((t) => TOOLS[t].sideEffect)).toEqual(["sheets.write", "telegram.send", "telegram.ask", "wallet.pay"]);
    expect(toolTypes(["sheets.read", "memory.get"]).split("\n")).toHaveLength(2);
    expect(toolTypes([])).toMatch(/no tools/);
  });

  it("lets a step through to only the tools it lists", () => {
    expect(gate(["sheets.read"], "sheets.read")).toBe("sheets.read");
    expect(() => gate(["sheets.read"], "wallet.pay")).toThrow("This step may not use wallet.pay.");
    expect(() => gate(["sheets.read"], "shell.exec")).toThrow("shell.exec is not a tool.");
    expect(() => gate(["sheets.read"], { toString: () => "sheets.read" })).toThrow(ToolError);
  });
});

describe("the mocks", () => {
  it("answer from the bench's data, on a copy the run can change", async () => {
    const bench = restockBench();
    const tools = new MockTools(bench);
    expect(await tools.call("sheets.read", { sheet: "Stock" })).toEqual({ rows: bench.sheets.Stock });
    expect(await tools.call("sheets.write", { sheet: "Orders", rows: [{ fabric: "Linen, natural", metres: 36 }] })).toEqual({ written: 1 });
    expect(tools.sheets.Orders).toEqual([{ fabric: "Linen, natural", metres: 36 }]);
    expect(bench.sheets.Orders).toEqual([]);
    expect(await tools.call("telegram.ask", { question: "Order 366.6 USDC of fabric?" })).toEqual({ answer: "yes" });
    expect(await tools.call("telegram.ask", { question: "Again?" })).toEqual({ answer: null });
    expect(await tools.call("memory.set", { key: "last_order", value: { total: 366.6 } })).toEqual({ ok: true });
    expect(await tools.call("memory.get", { key: "last_order" })).toEqual({ value: { total: 366.6 } });
    expect(await tools.call("wallet.pay", { to: "Weftworks", amountUsdc: 100 })).toEqual({ paid: true, txId: "mock-1" });
    await expect(tools.call("wallet.pay", { to: "Weftworks", amountUsdc: 401 })).rejects.toThrow("Not enough USDC: 400 left, 401 asked.");
    expect(await tools.call("web.fetch", { url: "https://suppliers.example/linen" })).toEqual({ status: 404, text: "" });
    expect(tools.calls.map((c) => [c.tool, c.error === null])).toEqual([
      ["sheets.read", true],
      ["sheets.write", true],
      ["telegram.ask", true],
      ["telegram.ask", true],
      ["memory.set", true],
      ["memory.get", true],
      ["wallet.pay", true],
      ["wallet.pay", false],
      ["web.fetch", true],
    ]);
  });

  it("check the arguments whatever the code sends", async () => {
    const tools = new MockTools(restockBench());
    await expect(tools.call("sheets.read", {})).rejects.toThrow(/sheets.read was called wrongly: sheet required/);
    await expect(tools.call("sheets.read", { sheet: "Nope" })).rejects.toThrow('There is no sheet called "Nope".');
    await expect(tools.call("wallet.pay", { to: "x", amountUsdc: -5 })).rejects.toThrow(/called wrongly/);
    await expect(tools.call("web.fetch", { url: "not a url" })).rejects.toThrow(/called wrongly/);
  });

  it("read search results by query, with * for any other", async () => {
    const bench = { ...restockBench(), search: { "*": [{ title: "Any", url: "https://example.com", snippet: "x" }], linen: [] } };
    const tools = new MockTools(bench);
    expect(await tools.call("web.search", { query: "linen" })).toEqual({ results: [] });
    expect(await tools.call("web.search", { query: "felt" })).toEqual({ results: bench.search["*"] });
  });

  it("take the bench as the builder sends it, and refuse a bench that's too large", () => {
    expect(BenchSchema.safeParse(restockBench()).success).toBe(true);
    const big = { ...restockBench(), pages: { "https://example.com": "x".repeat(49_000), "https://example.org": "x".repeat(49_000), "https://example.net": "x".repeat(49_000), "https://example.io": "x".repeat(49_000), "https://e.example": "x".repeat(49_000) } };
    expect(BenchSchema.safeParse(big).success).toBe(false);
  });
});
