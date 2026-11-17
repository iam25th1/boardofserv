import judgeCommits from "@/test/fixtures/judgeCommits.json";
import { modelConfig } from "@/lib/model";
import { callKey, typedRead } from "@/lib/connections/reads";
import { emptyBench } from "@/lib/agents/types";
import type { FakeNet } from "./fakeNet";

// The live repository's last five commits (fixtures/judgeCommits.json,
// from GitHub's public API, authors and trailers left out) and what SERV
// answered about them live, for the GitHub judge's tests.

export const REPO = "iam25th1/boardofserv";
export const gh = judgeCommits as { list: { sha: string; commit: { message: string } }[]; commits: Record<string, unknown> };
export const github = typedRead("github.read")!;
export const sha = (short: string) => gh.list.find((c) => c.sha.startsWith(short))!.sha;

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

// The answer for the commit a request is about (found by its title in it).
export function answerIn(text: string, answers = LIVE_ANSWERS): { verdict: string; findings: string[] } | null {
  const c = gh.list.find((x) => text.includes(JSON.stringify(x.commit.message).slice(1, -1)));
  return c ? (answers[c.sha.slice(0, 7)] ?? { verdict: "pass", findings: [] }) : null;
}

// GitHub's public API answering for the repository as it did, on a test
// runtime's network; each commit read is noted.
export function githubAnswering(net: FakeNet): { read: string[] } {
  const read: string[] = [];
  const at = REPO.replace("/", "\\/");
  net.on(new RegExp(`api\\.github\\.com\\/repos\\/${at}\\/commits(?:\\?|$)`), () => Response.json(gh.list));
  net.on(new RegExp(`api\\.github\\.com\\/repos\\/${at}\\/commits\\/[0-9a-f]+$`), (req) => {
    const id = req.url.pathname.split("/").pop()!;
    read.push(id);
    return Response.json(gh.commits[id]);
  });
  return { read };
}
