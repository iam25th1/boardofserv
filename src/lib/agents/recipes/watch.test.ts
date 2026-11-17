// @vitest-environment node
import { describe, expect, it } from "vitest";
import judgeCommits from "@/test/fixtures/judgeCommits.json";
import { modelConfig } from "@/lib/model";
import { callKey, typedRead } from "@/lib/connections/reads";
import { emptyBench, type RunEvent } from "../types";
import { runAgent } from "../runner";
import { fromRecipe, recipeById } from "./index";
import { NOT_SEEN } from "./watch";

// The GitHub watch-and-judge recipe on the live repository's last five
// commits (a merge among them), with SERV answering as it did live: "5
// commits checked, 3 with problems", most "problems" about the patch being
// cut short, 67a6193 called critical only because its patch was cut off,
// a40b9f6 "No critical errors detected" yet counted, and the merge judged
// like new code.

export const REPO = "iam25th1/boardofserv";
const gh = judgeCommits as { list: { sha: string; commit: { message: string } }[]; commits: Record<string, unknown> };
const github = typedRead("github.read")!;
const sha = (short: string) => gh.list.find((c) => c.sha.startsWith(short))!.sha;

// The bench the recipe's steps run on: GitHub answering as it did, through
// the platform's own shapes.
export function fixtureBench() {
  const bench = emptyBench();
  bench.settings.github_repo = REPO;
  bench.calls = { [callKey("github.read", { op: "commits", repo: REPO })]: github.shape(gh.list, { op: "commits" } as never) };
  for (const c of gh.list) bench.calls[callKey("github.read", { op: "commit", repo: REPO, sha: c.sha })] = github.shape(gh.commits[c.sha], { op: "commit" } as never);
  return bench;
}

// What SERV answered live, by commit.
export const LIVE_ANSWERS: Record<string, { verdict: string; findings: string[] }> = {
  a40b9f6: { verdict: "No critical errors detected", findings: ["Incomplete patch data in build.ts obscures full context", "Incomplete patch data in goLive.ts obscures full context", "Incomplete patch data in lessons.test.ts obscures full context", "Incomplete patch data in lessons.ts obscures full context", "Incomplete patch data in plan.test.ts obscures full context"] },
  "65dcc3a": {
    verdict: "No critical errors detected, but code review flagged issues to address",
    findings: [
      "Import statement in route.ts removes 'install' function without confirming it is unused elsewhere",
      "New 'stopOtherCopies' and 'runOwnCopy' functions imported but implementations cut off in patch data, cannot verify correctness",
      "Test file 'oneCopy.test.ts' added but content cut off, unable to validate test coverage and assertions",
      "New component 'OtherCopies' exported and imported in multiple files but implementation details cut off in patches",
      "Type definitions modified in types.ts but changes cut off, cannot verify new fields match function signatures",
    ],
  },
  "5d2e3f0": { verdict: "The code has no errors or critical issues.", findings: [] },
  "67a6193": { verdict: "Code has critical issues", findings: ["Patch content is truncated, preventing full analysis", "Missing closing of test file structure", "Unable to verify complete function implementations", "Cannot validate all import statements and dependencies are resolved"] },
  "99bd945": { verdict: "No critical errors or issues found in the code", findings: [] },
};

// SERV, answering each item's reasoning with the answer given for its
// commit (found by its title in what the step sent), and keeping each
// request.
export function servAnswering(answers: Record<string, { verdict: string; findings: string[] }>) {
  const asked: { title: string; text: string }[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { messages: { content: string }[] };
    const text = body.messages[1]!.content;
    const c = gh.list.find((x) => text.includes(JSON.stringify(x.commit.message).slice(1, -1)))!;
    asked.push({ title: c.commit.message, text });
    const answer = answers[c.sha.slice(0, 7)] ?? { verdict: "pass", findings: [] };
    return Response.json({ choices: [{ message: { content: JSON.stringify(answer) } }], usage: { prompt_tokens: 2000, completion_tokens: 80 } });
  }) as typeof fetch;
  return { fetchImpl, asked, serv: { ...modelConfig({ SERV_API_KEY: "test-serv", MODEL_RETRY_BACKOFF_MS: "0" }), providers: modelConfig({ SERV_API_KEY: "test-serv" }).providers.filter((p) => p.id === "serv") } };
}

// The recipe built as an owner's checker, run once over the five commits.
export async function runWatch(answers = LIVE_ANSWERS) {
  const recipe = recipeById("watch")!;
  const built = fromRecipe(recipe, { name: "GitHub Code Verifier", does: "Checks each new commit's code, work and quality.", done: "Each new commit judged.", trigger: { kind: "schedule", every: "hours", interval: 1, at: null, description: "Every hour" }, variant: "commits", task: recipe.task.byDefault("commits"), given: { github_repo: REPO } })!;
  const s = servAnswering(answers);
  const events: RunEvent[] = [];
  const end = await runAgent({ definition: built.definition, code: built.code, bench: fixtureBench(), dryRun: false, serv: s.serv, fetchImpl: s.fetchImpl, onEvent: (e) => events.push(e) });
  const done = (id: string) => events.find((e): e is Extract<RunEvent, { type: "step_done" }> => e.type === "step_done" && e.stepId === id)?.output as Record<string, unknown> | undefined;
  const sent = events.filter((e): e is Extract<RunEvent, { type: "tool" }> => e.type === "tool" && e.tool === "telegram.send").map((e) => String((e.args as { text?: unknown }).text ?? ""));
  return { end, events, done, sent, asked: s.asked, built };
}

type Result = { id: string; verdict: string; findings: string[] };

describe("A: the judge's verdicts", () => {
  it("never counts the patch being cut short as a problem, or lets it make a verdict worse", async () => {
    const { end, done, sent } = await runWatch();
    expect(end.status).toBe("done");
    const results = done("judge_items")!.results as Result[];
    for (const r of results) expect(r, r.id).toMatchObject({ verdict: "pass", findings: [] });
    expect(sent[0]).toMatch(/: \d commits checked: \d passed\./);
    expect(sent[0]).not.toMatch(NOT_SEEN);
  });

  it("drops every finding SERV made of not seeing the whole change, the live ones included", () => {
    for (const a of Object.values(LIVE_ANSWERS)) for (const f of a.findings) expect(NOT_SEEN.test(f), f).toBe(true);
    // What is about the code itself stays.
    expect(NOT_SEEN.test("src/lib/agents/runtime/installations.ts: runOwnCopy keeps the old policy when only autoSpendUsdc is given")).toBe(false);
  });

  it("keeps a verdict SERV gives with a finding tied to a file it was shown, at most 3, and counts from the verdicts", async () => {
    const real = "src/lib/agents/runtime/installations.ts: runOwnCopy sets live to true on a paused copy, so Run it for real can restart a copy its owner paused";
    const answers = {
      ...LIVE_ANSWERS,
      "65dcc3a": { verdict: "problem", findings: [real, "Cannot verify the rest of the file", "A general worry with no file named", "src/lib/useApi.ts: a second", "src/lib/types.ts: a third", "src/test/secrecy.test.ts: a fourth"] },
      // A pass raises nothing, whatever it lists.
      "5d2e3f0": { verdict: "Pass", findings: ["src/components/agents/BudgetPanel.tsx: a nit"] },
      // Critical on a cut patch alone is a pass.
      "67a6193": { verdict: "critical", findings: ["Patch content is truncated, preventing full analysis"] },
      a40b9f6: { verdict: "minor", findings: ["src/lib/agents/lessons.ts: recipeRules reads up to 50 rows for every build"] },
    };
    const { done, sent } = await runWatch(answers);
    const results = done("judge_items")!.results as Result[];
    const by = (short: string) => results.find((r) => r.id.startsWith(short))!;
    expect(by("65dcc3a")).toMatchObject({ verdict: "problem", findings: [real, "src/lib/useApi.ts: a second", "src/lib/types.ts: a third"] });
    expect(by("5d2e3f0")).toMatchObject({ verdict: "pass", findings: [] });
    expect(by("67a6193")).toMatchObject({ verdict: "pass", findings: [] });
    expect(by("a40b9f6")).toMatchObject({ verdict: "minor", findings: ["src/lib/agents/lessons.ts: recipeRules reads up to 50 rows for every build"] });
    // The head line counts the verdicts, and only them.
    const counts = { problem: results.filter((r) => r.verdict === "problem").length, minor: results.filter((r) => r.verdict === "minor").length, pass: results.filter((r) => r.verdict === "pass").length };
    expect(sent[0]!.split("\n")[0]).toBe(`${REPO}: ${results.length} commits checked: ${counts.problem} problem, ${counts.minor} minor, ${counts.pass} passed.`);
  });

  it("is told to answer with one of the four verdicts and findings tied to files", async () => {
    const { asked } = await runWatch();
    expect(asked[0]!.text).toContain("Answer verdict with exactly one word: pass (nothing worth raising), minor (small things only), problem (a real bug or risk to fix) or critical");
    expect(asked[0]!.text).toContain("each starting with the file it is in");
  });
});

export { sha };
