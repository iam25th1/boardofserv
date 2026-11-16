// @vitest-environment node
import { describe, expect, it } from "vitest";
import { V2_FETCH, V2_SAVE, V3_ANALYZE, V3_FETCH, v2Checker, v3Checker } from "@/test/githubChecker";
import { modelConfig } from "../model";
import { argMismatches, isDateText, mismatchFinding, mismatchProblem } from "./argKinds";
import { servOnly } from "./build";
import { checkCode } from "./code";
import type { CodeStepDef } from "./definition";
import { argsVerdict } from "./heal";
import { MockTools, TOOL_ARGS } from "./toolbox";
import { emptyBench } from "./types";
import { plainFindings, reviewVersion } from "./vetting";

// Real bugs fail: each tool call's arguments are read against what the
// tool's arguments hold, so an id where a date goes (version 2 of the live
// GitHub checker passed the last commit's sha to GitHub's since) is a
// problem with the code, before it ever runs: the build writes it again,
// the review before publishing holds it, and healing it is a code fix.

const fn = (body: string) => `async function run(input, tools) {\n${body}\n}`;
const SHA_MEMORY = [{ key: "last_commit_sha", description: "SHA of the last commit analyzed to fetch only new commits on subsequent runs" }];

describe("what a call passes", () => {
  it("finds the sha the live checker passed as GitHub's since, through its own variables and its memory", () => {
    const found = argMismatches(V2_FETCH, { memory: SHA_MEMORY, sources: [V2_FETCH, V2_SAVE] });
    expect(found).toEqual([{ tool: "github.read", arg: "since", wants: "date", got: "id", value: "since" }]);
    expect(mismatchProblem(found[0]!)).toContain("which takes a date (ISO 8601, like 2026-11-16T09:00:00Z)");
    expect(mismatchFinding(found[0]!)).toBe('It passes an id where GitHub takes a date (the "since" of its read), so every read after the first fails and later runs find nothing.');
  });

  it("passes a remembered date, a computed one, and a sha where a sha goes", () => {
    expect(argMismatches(V3_FETCH, { memory: [{ key: "last_check_date", description: "ISO format timestamp of the last analysis" }] })).toEqual([]);
    expect(argMismatches(V3_ANALYZE)).toEqual([]);
    expect(argMismatches(fn('return tools.github.read({ op: "commits", repo: "a/b", since: new Date(Date.now() - 86400000).toISOString() });'))).toEqual([]);
    expect(argMismatches(fn('const c = input.commits[0]; return tools.github.read({ op: "commits", repo: "a/b", since: c.date });'))).toEqual([]);
  });

  it("tells a memory key with a plain name by what the agent says it holds, or by what its code writes there", () => {
    const read = fn('return tools.github.read({ op: "commits", repo: input.settings.repo, since: input.memory.cursor });');
    expect(argMismatches(read, { memory: [{ key: "cursor", description: "The sha of the newest commit checked" }] }).map((m) => m.got)).toEqual(["id"]);
    expect(argMismatches(read, { memory: [{ key: "cursor", description: "When the newest commit checked was made" }] })).toEqual([]);
    const save = fn('const first = input.commits[0]; await tools.memory.set({ key: "cursor", value: first.sha }); return {};');
    expect(argMismatches(read, { memory: [{ key: "cursor", description: "where it got to" }], sources: [read, save] }).map((m) => m.got)).toEqual(["id"]);
  });

  it("finds a date where an id goes, and an id passed straight in", () => {
    expect(argMismatches(fn('for (const c of input.commits) await tools.github.read({ op: "commit", repo: "a/b", sha: c.date });'))).toMatchObject([{ arg: "sha", wants: "id", got: "date" }]);
    expect(argMismatches(fn('return tools.github.read({ op: "commits", repo: "a/b", since: input.commits[0].sha });'))).toMatchObject([{ arg: "since", wants: "date", got: "id" }]);
    expect(argMismatches(fn('const since = input.memory.lastSha; return tools.github.read({ op: "commits", repo: "a/b", since });'))).toMatchObject([{ arg: "since", got: "id" }]);
  });

  it("is checked by the tool itself too, whatever the code sends", async () => {
    expect(isDateText("2026-11-16T18:54:58Z")).toBe(true);
    expect(isDateText("2026-11-16")).toBe(true);
    expect(isDateText("0a1b2c3d4e5f")).toBe(false);
    expect(TOOL_ARGS["github.read"].safeParse({ op: "commits", repo: "a/b", since: "0a1b2c3d4e5f" }).success).toBe(false);
    const tools = new MockTools(emptyBench());
    await expect(tools.call("github.read", { op: "commits", repo: "a/b", since: "0a1b2c3d4e5f" })).rejects.toThrow("github.read was called wrongly: since takes a date (ISO 8601, like 2026-11-16T09:00:00Z), not an id or a sha");
    await expect(tools.call("github.read", { op: "commit", repo: "a/b", sha: "2026-11-16" })).rejects.toThrow("sha is a commit's id (7 to 40 hex characters), not a date");
  });
});

describe("a step that passes the wrong kind of value", () => {
  it("is sent back to be written again when it is built", () => {
    const { definition } = v2Checker();
    const step = definition.steps.find((s): s is CodeStepDef => s.id === "fetch_commits")!;
    expect(checkCode(V2_FETCH, step, definition)).toBe(mismatchProblem({ tool: "github.read", arg: "since", wants: "date", got: "id", value: "since" }));
    expect(checkCode(V3_FETCH, v3Checker().definition.steps.find((s): s is CodeStepDef => s.id === "fetch_commits")!, v3Checker().definition)).toBeNull();
  });

  it("holds the version at the review before publishing, whatever SERV thought of it", async () => {
    const { definition, code } = v2Checker();
    const step = definition.steps.find((s): s is CodeStepDef => s.id === "fetch_commits")!;
    expect(plainFindings(step, V2_FETCH, { memory: definition.memory, sources: [V2_FETCH, V2_SAVE] })).toEqual([{ step: "Fetch recent commits", severity: "blocking", finding: mismatchFinding({ tool: "github.read", arg: "since", wants: "date", got: "id", value: "since" }) }]);
    // Live, SERV called it a warning: "a semantic mismatch".
    const warning = { step: "Fetch recent commits", severity: "warning", finding: "The step uses memory as a date string for the since parameter, but stores commit SHA values." };
    const answering = (async () => Response.json({ choices: [{ message: { content: JSON.stringify({ findings: [warning] }) } }], usage: { prompt_tokens: 2000, completion_tokens: 50 } })) as unknown as typeof fetch;
    const review = await reviewVersion(definition, code, servOnly(modelConfig({ SERV_API_KEY: "test-serv" })), { now: new Date("2026-11-16T19:38:00Z"), fetchImpl: answering });
    expect(review.status).toBe("blocked");
    expect(review.findings.filter((f) => f.severity === "blocking").map((f) => f.step)).toEqual(["Fetch recent commits"]);
    // Version 3 (a remembered date) has nothing of the kind.
    const v3 = v3Checker();
    expect(v3.definition.steps.flatMap((s) => (s.kind === "code" ? plainFindings(s, v3.code[s.id]!.source!, { memory: v3.definition.memory, sources: Object.values(v3.code).map((c) => c.source!) }) : []))).toEqual([]);
  });

  it("heals as a code fix, told what it passed, with no fixer to ask", () => {
    const { definition, code } = v2Checker();
    const v = argsVerdict(definition, code, "make_send_report_action");
    expect(v).toMatchObject({ verdict: "code_wrong", step: "fetch_commits", kind: "wrong_value" });
    expect(v!.why).toBe(mismatchProblem({ tool: "github.read", arg: "since", wants: "date", got: "id", value: "since" }));
    expect(v!.spec).toMatch(/a date where it takes a date \(ISO 8601\), never a commit's sha or an item's id\.$/);
    expect(argsVerdict(v3Checker().definition, v3Checker().code, null)).toBeNull();
  });
});
