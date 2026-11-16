// @vitest-environment node
import { describe, expect, it } from "vitest";
import { callKey } from "../connections/reads";
import { checkDefinition, type AgentDefinition } from "./definition";
import type { FixVerdict } from "./fixer";
import { escalated } from "./heal";
import { runAgent } from "./runner";
import { keyedToCalls } from "./sample";
import { emptyBench, type HealRound, type StepCode } from "./types";

// A sample's stand-ins answer the calls the code really makes: a dry pass
// on the sample's own settings notes each call it had nothing for, and
// keys the sample's answer for the call most like it by the exact one. A
// mismatch the fixer names twice is then a code or settings fix, never a
// third sample.

const d = (() => {
  const c = checkDefinition({
    format: 1,
    name: "Feed and commits",
    job: { does: "Reads a feed and a repository's commits and tells the owner.", done: "Told." },
    triggers: [{ kind: "schedule", every: "day", at: "09:00", description: "Every day at 9" }],
    settings: [
      { key: "feed_url", label: "Feed", type: "url", help: "Its address", choices: [] },
      { key: "repos", label: "Repositories", type: "list", help: "owner/name", choices: [] },
    ],
    rules: [],
    memory: [],
    steps: [
      { id: "read", kind: "code", title: "Read the feed and commits", description: "Fetch the feed in settings.feed_url and read the commits of settings.repos.", inputs: ["settings"], outputs: ["message"], tools: ["web.fetch", "github.read"], next: "send" },
      { id: "send", kind: "action", title: "Tell the owner", action: "tell", inputs: ["message"], outputs: [], next: null },
    ],
    actions: [{ id: "tell", tool: "telegram.send", description: "Tell the owner" }],
    limits: { maxSteps: 20, maxRunSeconds: 60, maxSpendUsd: 0.1 },
  });
  if (!c.ok) throw new Error(c.errors.join("; "));
  return c.definition as AgentDefinition;
})();

const READ = `async function run(input, tools) {
  const page = await tools.web.fetch({ url: input.settings.feed_url + "?page=1" });
  const got = await tools.github.read({ op: "commits", repo: input.settings.repos[0], limit: 5 });
  return { message: { text: page.text + " " + got.items.map((c) => c.sha).join(",") } };
}`;
const code: Record<string, StepCode> = { read: { spec: "", status: "approved", source: READ, rounds: 1, note: null, updatedAt: "" } };

const sample = () => {
  const b = emptyBench();
  b.settings = { feed_url: "https://example.org/feed", repos: ["acme/api"] };
  // As the sample maker guessed the calls: no query, no limit.
  b.pages = { "https://example.org/feed": "Release 2.0 is out" };
  b.calls = { [callKey("github.read", { op: "commits", repo: "acme/api" })]: { items: [{ sha: "abc123" }] }, [callKey("github.read", { op: "issues", repo: "acme/api" })]: { items: [{ number: 1 }] } };
  return b;
};

describe("a sample keyed by the code's own calls", () => {
  it("answers the exact address and arguments the code uses, from what the sample gave for the call most like each", async () => {
    const missed: string[] = [];
    await runAgent({ definition: d, code, bench: sample(), dryRun: true, onEvent: () => {}, missed });
    expect(missed).toEqual([callKey("web.fetch", { url: "https://example.org/feed?page=1" }), callKey("github.read", { op: "commits", repo: "acme/api", limit: 5 })]);
    const { bench, rekeyed } = await keyedToCalls(d, code, sample());
    expect(rekeyed).toEqual(missed);
    expect(bench.pages["https://example.org/feed?page=1"]).toBe("Release 2.0 is out");
    expect(bench.calls![callKey("github.read", { op: "commits", repo: "acme/api", limit: 5 })]).toEqual({ items: [{ sha: "abc123" }] });
    const sent: string[] = [];
    const again: string[] = [];
    await runAgent({ definition: d, code, bench, dryRun: true, missed: again, onEvent: (e) => e.type === "tool" && e.tool === "telegram.send" && sent.push(String((e.args as { text: string }).text)) });
    expect(again).toEqual([]);
    expect(sent).toEqual(["Release 2.0 is out abc123"]);
  });

  it("invents nothing for a call the sample gave nothing like", async () => {
    const b = sample();
    b.pages = { "https://elsewhere.example/feed": "Other" };
    b.calls = {};
    const { bench, rekeyed } = await keyedToCalls(d, code, b);
    expect(rekeyed).toEqual([]);
    expect(Object.keys(bench.pages)).toEqual(["https://elsewhere.example/feed"]);
  });
});

describe("a mismatch the fixer names twice", () => {
  const verdict = (why: string, sample = ""): FixVerdict => ({ verdict: "test_wrong", step: "send", why, spec: "", change: "", sample, question: "", choices: [], lesson: "", kind: "other" });
  const round = (why: string): HealRound => ({ diagnosis: { stage: "test", step: null, failure: "", expected: "", evidence: { plan: null, spec: null, code: null, review: null, check: null, trace: [], sample: null, errors: [] }, at: "" }, verdict: "test", why, repair: `A new sample: ${why}`, outcome: "failed", at: "" });

  it("is a new sample the first time", () => {
    const v = verdict("The sample's mocks don't match the URLs the code calls.");
    expect(escalated(v, [], d, "send")).toBe(v);
  });

  it("is the reading step's code written again the second time", () => {
    const v = escalated(verdict("The pages in the sample are keyed by other URLs than the code fetches."), [round("The mocks don't match the code's URLs.")], d, "send");
    expect(v).toMatchObject({ verdict: "code_wrong", step: "read" });
    expect(v.spec).toBe("Fetch the feed in settings.feed_url and read the commits of settings.repos. Make every address and call from input.settings, exactly as given, never from a value written into the code.");
  });

  it("is a setting for the steps when the fixer says what it reads must be one", () => {
    const v = escalated(verdict("It queries a hard-coded repository.", "Add a settings field github_repos and key the mocks by its URLs."), [round("The mocks don't match the code's URLs.")], d, "send");
    expect(v.verdict).toBe("plan_wrong");
    expect(v.change).toMatch(/^Add a settings field github_repos and key the mocks by its URLs\. What it reads \(which repositories, pages, forms\) is a setting the reading step reads \("read" lists "settings" in its inputs\)/);
  });

  it("leaves any other wrong sample alone", () => {
    const v = verdict("The sample has no payee by the name it pays.");
    expect(escalated(v, [round("The mocks don't match the code's URLs.")], d, "send")).toBe(v);
    // An address in the sample that isn't one is the sample's own fault.
    const bad = verdict('The sample data provides an invalid URL ("sample") that web.fetch cannot use.');
    expect(escalated(bad, [round("The sample must include a mock response from web.fetch that returns the actual price.")], d, "send")).toBe(bad);
  });
});

describe("a sample's commits", () => {
  // Live, SERV's sample gave commits shas like a1b2c3d4e5f6g7h8i9j0..., which
  // GitHub (and its stand-in) refuses, so code that read each commit's
  // changes failed on its own sample.
  it("have ids a service takes, the same each time, so each commit's own read works on them", async () => {
    const { readSample } = await import("./sample");
    const fake = "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6";
    const commits = { items: [{ sha: fake, message: "Add authentication", date: "2026-11-16T14:30:00Z" }, { sha: "4d5e6f7", message: "Fix pooling", date: "2026-11-16T10:15:00Z" }] };
    const content = JSON.stringify({ noun: "commit", plural: "commits", labels: ["Add authentication"], settings: [{ key: "repos", value: "acme/widgets" }], sheets: [], pages: [], searches: [], answers: [], calls: [{ tool: "github.read", args: JSON.stringify({ op: "commits", repo: "acme/widgets" }), data: JSON.stringify(commits) }] });
    const sample = readSample(d, content)!;
    const got = sample.bench.calls![callKey("github.read", { op: "commits", repo: "acme/widgets" })] as typeof commits;
    expect(got.items[0]!.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(got.items[1]!.sha).toBe("4d5e6f7");
    expect((readSample(d, content)!.bench.calls![callKey("github.read", { op: "commits", repo: "acme/widgets" })] as typeof commits).items[0]!.sha).toBe(got.items[0]!.sha);
  });
});
