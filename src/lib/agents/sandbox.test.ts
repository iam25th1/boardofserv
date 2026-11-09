// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { ToolName } from "./definition";
import { runInSandbox, type SandboxResult } from "./sandbox";

// Code that tries to get out of the sandbox, and what stops it. Each run is
// a fresh QuickJS runtime with a short time limit and a small memory limit.

const calls: [string, unknown][] = [];
const call = async (tool: ToolName, args: unknown) => {
  calls.push([tool, args]);
  return { rows: [{ fabric: "Linen", metres: 4 }] };
};

const run = (source: string, allowed: ToolName[] = [], input: unknown = { n: 1 }, timeMs = 400): Promise<SandboxResult> =>
  runInSandbox(source, input, { allowed, call, timeMs, memoryBytes: 8 * 1024 * 1024 });

const failed = (r: SandboxResult) => (r.ok ? null : r.error);

describe("the sandbox", () => {
  it("runs a step's code with its input and its own tools, and returns its output", async () => {
    calls.length = 0;
    const r = await run("async function run(input, tools) { const { rows } = await tools.sheets.read({ sheet: 'Stock' }); return { n: input.n + 1, low: rows.length }; }", ["sheets.read"]);
    expect(r).toMatchObject({ ok: true, output: { n: 2, low: 1 } });
    expect(calls).toEqual([["sheets.read", { sheet: "Stock" }]]);
  });

  it("has no network", async () => {
    expect(failed(await run("async function run() { return await fetch('https://example.com'); }"))).toBe("ReferenceError: 'fetch' is not defined");
    expect(failed(await run("async function run() { return new XMLHttpRequest(); }"))).toMatch(/XMLHttpRequest' is not defined/);
    expect(failed(await run("async function run() { return new WebSocket('wss://example.com'); }"))).toMatch(/WebSocket' is not defined/);
  });

  it("has no files and no modules", async () => {
    expect(failed(await run("async function run() { return await import('fs'); }"))).toBe("ReferenceError: could not load module 'fs'");
    expect(failed(await run("async function run() { return require('fs').readFileSync('/etc/passwd', 'utf8'); }"))).toBe("ReferenceError: 'require' is not defined");
    expect(await run("async function run() { return [typeof process, typeof std, typeof os, typeof Deno, typeof Bun].join(' '); }")).toMatchObject({
      ok: true,
      output: "undefined undefined undefined undefined undefined",
    });
  });

  it("stops an endless loop, before or after a tool call", async () => {
    const r = await run("async function run() { while (true) {} }");
    expect(failed(r)).toBe("It ran out of time (0.4 seconds).");
    expect(r.ms).toBeLessThan(2000);
    expect(failed(await run("async function run(i, tools) { await tools.sheets.read({ sheet: 'S' }); for (;;) {} }", ["sheets.read"]))).toBe("It ran out of time (0.4 seconds).");
    expect(failed(await run("async function run() { await new Promise(() => {}); }"))).toBe("It ran out of time (0.4 seconds).");
  });

  it("stops code that takes huge memory or recurses without end", async () => {
    expect(failed(await run("async function run() { const a = []; for (;;) a.push(new Array(100000).fill(1)); }", [], {}, 5000))).toBe("It used too much memory.");
    expect(failed(await run("async function run() { const f = (n) => f(n + 1) + 1; return f(0); }"))).toBe("It went too deep (stack overflow).");
    // And the next step runs as if nothing happened.
    expect(await run("async function run(input) { return input.n; }")).toMatchObject({ ok: true, output: 1 });
  });

  it("can't reach the bridge, or any tool its step doesn't list", async () => {
    expect(await run("async function run() { return typeof globalThis.__bridge + ' ' + typeof __bridge; }")).toMatchObject({ ok: true, output: "undefined undefined" });
    expect(await run("async function run(i, tools) { return Object.keys(tools).join(','); }", ["sheets.read", "memory.get"])).toMatchObject({ ok: true, output: "sheets,memory" });
    expect(failed(await run("async function run(i, tools) { return await tools.wallet.pay({ to: 'x', amountUsdc: 1 }); }", ["sheets.read"]))).toMatch(/TypeError/);
    // The tools object can't be changed to add one.
    expect(await run("async function run(i, tools) { tools.wallet = { pay: () => 1 }; tools.sheets.write = () => 1; return [typeof tools.wallet, typeof tools.sheets.write].join(' '); }", ["sheets.read"])).toMatchObject({
      ok: true,
      output: "undefined undefined",
    });
  });

  it("keeps prototype tricks inside: nothing but strings crosses the bridge", async () => {
    calls.length = 0;
    // A constructor's constructor only reaches the sandbox's own empty global.
    expect(await run("async function run(i, tools) { const g = tools.sheets.read.constructor('return this')(); return Object.keys(g).filter((k) => !k.startsWith('__')).join(','); }", ["sheets.read"])).toMatchObject({ ok: true, output: "" });
    // Polluting prototypes and JSON inside changes nothing the host sees or the bridge reads.
    const polluted = await run(
      "async function run(i, tools) { Object.prototype.polluted = 'yes'; Array.prototype.push = () => 0; JSON.parse = () => ({ evil: true }); JSON.stringify = () => '{\"sheet\":\"Evil\"}'; const r = await tools.sheets.read({ sheet: 'Stock' }); return { rows: r.rows.length }; }",
      ["sheets.read"],
    );
    expect(polluted).toMatchObject({ ok: true, output: { rows: 1 } });
    expect(calls).toEqual([["sheets.read", { sheet: "Stock" }]]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    // A tool's result is a fresh copy: changing it inside changes nothing outside.
    expect(await run("async function run(i, tools) { const r = await tools.sheets.read({ sheet: 'S' }); r.rows[0].metres = 999; return (await tools.sheets.read({ sheet: 'S' })).rows[0].metres; }", ["sheets.read"])).toMatchObject({
      ok: true,
      output: 4,
    });
  });

  it("turns a tool's failure into an error the code can catch", async () => {
    const failing = async () => {
      throw new Error("There is no sheet called \"Nope\".");
    };
    const r = await runInSandbox(
      "async function run(i, tools) { try { await tools.sheets.read({ sheet: 'Nope' }); } catch (e) { return { caught: e.message }; } }",
      {},
      { allowed: ["sheets.read"], call: failing, timeMs: 400 },
    );
    expect(r).toMatchObject({ ok: true, output: { caught: 'There is no sheet called "Nope".' } });
  });

  it("says plainly when the code has no run, throws, won't parse or returns nothing usable", async () => {
    expect(failed(await run("const x = 1;"))).toBe("Error: There is no run function.");
    expect(failed(await run("async function run() { throw new Error('nope'); }"))).toBe("Error: nope");
    expect(failed(await run("async function run( {"))).toMatch(/^SyntaxError/);
    expect(await run("async function run() {}")).toMatchObject({ ok: true, output: null });
    expect(failed(await run("async function run() { return 'x'.repeat(2000000); }", [], {}, 2000))).toBe("It returned too much.");
  });
});
