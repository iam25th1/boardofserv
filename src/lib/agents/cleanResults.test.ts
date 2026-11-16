// @vitest-environment node
import { describe, expect, it } from "vitest";
import { modelConfig } from "@/lib/model";
import { checkerDefinition, V3_FETCH, V3_MESSAGE, V3_SAVE } from "@/test/githubChecker";
import { callKey } from "../connections/reads";
import { servOnly } from "./build";
import { ALL_CLEAR, judgedValue, runAgent } from "./runner";
import { emptyBench, type BenchData, type RunEvent, type StepCode } from "./types";

// A clean result is a result. Live, version 3 judged five commits, found
// no violations, and then skipped "Write the message" for empty input, so
// its owner heard nothing. Skipping for empty input is for missing source
// data (nothing new was read); a judgement that ran and found nothing
// wrong still says so, with a short all-clear when nothing else is said.

const ok = (source: string): StepCode => ({ spec: "", status: "approved", source, rounds: 1, note: null, updatedAt: "" });
const serv = servOnly(modelConfig({ SERV_API_KEY: "test-serv" }));

// Judging a commit at a time, finding nothing.
const JUDGE = `async function run(input, tools) {
  const violations = [];
  let files = 0;
  for (const c of (input.commits || []).slice().reverse()) {
    const got = await tools.github.read({ op: "commit", repo: input.settings.github_repo, sha: c.sha });
    files += got.items.length;
    const r = await tools.serv.reason({ task: "Judge this commit's changes for quality.", data: { message: c.message, files: got.items }, answer: { violations: "list" } });
    for (const v of r.violations) violations.push({ file: "", type: "style", severity: "info", line: 0, message: v });
  }
  return { violations, quality_summary: { files_checked: files, violations_total: violations.length } };
}`;

const REPO = "acme/widgets";
const bench = (commits: { sha: string; date: string; message: string }[]): BenchData => ({
  ...emptyBench(),
  settings: { github_repo: REPO },
  memory: {},
  calls: {
    [callKey("github.read", { op: "commits", repo: REPO, limit: 5 })]: { items: commits },
    ...Object.fromEntries(commits.map((c) => [callKey("github.read", { op: "commit", repo: REPO, sha: c.sha }), { items: [{ filename: "src/app.ts", status: "modified", additions: 3, deletions: 1, patch: "@@ -1 +1 @@\n-a\n+b" }] }])),
  },
});
const commits = [
  { sha: "0a1b2c3", date: "2026-11-16T18:54:58Z", message: "Merge the follow-ups" },
  { sha: "4d5e6f7", date: "2026-11-16T18:40:30Z", message: "Point to each key page" },
];

// SERV, mocked: no violations, and a message when it is asked to write one.
function servFetch(said: string, calls: string[]): typeof fetch {
  return (async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { messages: { content: string }[] };
    const asked = body.messages.at(-1)!.content;
    calls.push(asked);
    const content = JSON.stringify(asked.includes("Answer with: violations") ? { violations: [] } : { text: said });
    return Response.json({ choices: [{ message: { content }, finish_reason: "stop" }], usage: { prompt_tokens: 400, completion_tokens: 40 }, model: "serv-test" });
  }) as typeof fetch;
}

const run = async (o: { commits: typeof commits; message?: string; said?: string }) => {
  const events: RunEvent[] = [];
  const calls: string[] = [];
  const end = await runAgent({
    definition: checkerDefinition(),
    code: { fetch_commits: ok(V3_FETCH), analyze_quality: ok(JUDGE), make_send_report_action: ok(o.message ?? V3_MESSAGE), save_last_check: ok(V3_SAVE) },
    bench: bench(o.commits),
    dryRun: false,
    serv,
    fetchImpl: servFetch(o.said ?? "acme/widgets: 2 commits checked, no violations found.", calls),
    onEvent: (e) => events.push(e),
  });
  const sent = events.filter((e): e is Extract<RunEvent, { type: "tool" }> => e.type === "tool" && e.tool === "telegram.send").map((e) => (e.args as { text: string }).text);
  return { end, sent, calls };
};

describe("a judgement that found nothing wrong", () => {
  it("is a result: the message is still written and sent", async () => {
    const { end, sent, calls } = await run({ commits });
    expect(end).toMatchObject({ status: "done" });
    expect(end.outcome ?? null).toBeNull();
    expect(sent).toEqual(["acme/widgets: 2 commits checked, no violations found."]);
    // One call a commit, then the message.
    expect(calls).toHaveLength(3);
  });

  it("sends a short all-clear when the message comes out empty", async () => {
    const empty = "async function run(input, tools) { return { send_report_action_content: (input.violations || []).length ? 'Found some.' : '' }; }";
    const { end, sent } = await run({ commits, message: empty });
    expect(end.status).toBe("done");
    expect(sent).toEqual([ALL_CLEAR("GitHub code quality checker")]);
    expect(ALL_CLEAR("GitHub code quality checker")).toBe("All clear: GitHub code quality checker checked and found nothing wrong.");
  });

  it("knows a judgement's result from what it was to look at", () => {
    const d = checkerDefinition();
    expect(judgedValue(d, "violations")).toBe(true);
    expect(judgedValue(d, "quality_summary")).toBe(true);
    expect(judgedValue(d, "commits")).toBe(false);
  });
});

describe("nothing new to look at", () => {
  it("still skips the run, sending nothing", async () => {
    const { end, sent, calls } = await run({ commits: [] });
    expect(end).toMatchObject({ status: "done", outcome: "skipped", reason: 'Skipped, empty input: "Analyze code quality" had nothing to work on (commits was empty), so nothing was sent.' });
    expect(sent).toEqual([]);
    expect(calls).toEqual([]);
  });
});
