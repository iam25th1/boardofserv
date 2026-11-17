import { DATE_CURSOR, diffsNote, eachItemNote, firstRunNote } from "../planRepairs";
import type { AgentDefinition } from "../definition";
import { emptyBench } from "../types";
import { callKey } from "../../connections/reads";
import { literal, REPO_FROM_SETTING, type Recipe, type RecipeFill } from "./types";

// Watch a repository and judge each new item with SERV: the GitHub code
// checker that went live (PR #9's live run on iam25th1/boardofserv: five
// commits, each judged once with its changes, the message sent, its place
// kept as a date). Its new commits or pull requests are read five at a
// time, each judged once by SERV with its changes, and one message names
// what was found, or that nothing was wrong.

const KINDS: Record<string, { op: string; one: string; many: string; detail: string }> = {
  commits: { op: "commits", one: "commit", many: "commits", detail: '{ op: "commit", repo: repo, sha: item.id }' },
  pulls: { op: "pulls", one: "pull request", many: "pull requests", detail: '{ op: "pull", repo: repo, number: Number(item.id) }' },
};

const readCode = (op: string) =>
  [
    "async function run(input, tools) {",
    `  const repo = ${REPO_FROM_SETTING};`,
    "  if (!repo) return { items: [] };",
    `  const got = await tools.github.read({ op: ${literal(op)}, repo: repo });`,
    "  const list = got && Array.isArray(got.items) ? got.items : [];",
    "  const items = list.map(function (x) {",
    '    return { id: String(x.sha || x.number || ""), title: String(x.message || x.title || ""), author: String(x.author || ""), date: String(x.date || x.created_at || ""), url: String(x.url || "") };',
    "  });",
    "  return { items: items };",
    "}",
  ].join("\n");

// What SERV says about not seeing more of a change (a patch cut short, a
// file left out) is about the call, not the code: never a finding.
export const NOT_SEEN = /\b(?:cut off|cut short|truncat\w*|incomplete (?:patch|diff|data|code|content|file|context|view)|partial(?:ly)? (?:shown|visible|patch|diff|content|code|view)|not (?:fully |all )?(?:shown|visible|included|provided)|cannot (?:be )?(?:verif\w*|see|validat\w*|confirm\w*|assess\w*|determin\w*|tell)|can.?t (?:verif\w*|see|validat\w*|confirm\w*|tell)|unable to (?:verif\w*|see|validat\w*|confirm\w*|assess\w*|determin\w*)|without (?:confirming|seeing|verifying|the full)|(?:missing|full|more|surrounding|enough) context|obscure\w*|omitted|lines not shown|missing clos\w*|elsewhere in the (?:code|file|repo\w*)|rest of the (?:file|code|patch))\b/i;

// A verdict, worst first, as SERV is asked for it.
export const VERDICTS = ["critical", "problem", "minor", "pass"] as const;

// What SERV is asked about each item: the owner's bar, and how to answer.
export const judgeTask = (bar: string) =>
  [
    bar.trim(),
    "Answer verdict with exactly one word: pass (nothing worth raising), minor (small things only), problem (a real bug or risk to fix) or critical (it would break or endanger something when it runs).",
    "findings: at most 3, the most important first, each starting with the file it is in, as 'path: what is wrong'. None for a pass.",
  ].join(" ");

const judgeCode = (detail: string, task: string) => String.raw`async function run(input, tools) {
  const repo = ${REPO_FROM_SETTING};
  const items = (Array.isArray(input.items) ? input.items : []).slice().reverse();
  const notSeen = ${NOT_SEEN.toString()};
  const verdicts = ${JSON.stringify(VERDICTS)};
  const results = [];
  for (const item of items) {
    let changed = [];
    try {
      const got = await tools.github.read(${detail});
      changed = got && Array.isArray(got.items) ? got.items : [];
    } catch (e) {
      changed = [];
    }
    const files = changed.map(function (f) { return { name: String(f.filename || ""), status: f.status, added: f.additions, removed: f.deletions, patch: f.patch }; });
    const judged = await tools.serv.reason({
      task: ${literal(judgeTask(task))},
      data: { item: { title: item.title, author: item.author, date: item.date }, files: files },
      answer: { verdict: "text", findings: "list" },
    });
    // A finding names a file it was shown, and is about the code.
    const names = files.map(function (f) { return f.name; }).filter(function (n) { return n; });
    const tied = function (s) { return names.some(function (n) { return s.indexOf(n) !== -1 || s.indexOf(n.split("/").pop()) !== -1; }); };
    const findings = (Array.isArray(judged.findings) ? judged.findings : []).map(function (s) { return String(s).trim(); }).filter(function (s) { return s && !notSeen.test(s) && tied(s); }).slice(0, 3);
    const said = String(judged.verdict || "").trim().toLowerCase().split(/[^a-z]+/)[0];
    let verdict = verdicts.indexOf(said) !== -1 ? said : findings.length ? "minor" : "pass";
    // Worse than a pass stands on a finding; a pass raises none.
    if (verdict !== "pass" && !findings.length) verdict = "pass";
    results.push({ id: item.id, title: item.title, url: item.url, verdict: verdict, findings: verdict === "pass" ? [] : findings });
  }
  return { results: results };
}`;

const messageCode = (one: string, many: string, pulls: boolean) => String.raw`async function run(input) {
  const results = Array.isArray(input.results) ? input.results : [];
  if (!results.length) return { message: null };
  const where = String((input.settings || {}).github_repo || "").trim();
  // The counts are the verdicts', worst first.
  const plural = { critical: "critical", problem: "problems", minor: "minor", pass: "passed" };
  const single = { critical: "critical", problem: "problem", minor: "minor", pass: "passed" };
  const counts = ${JSON.stringify(VERDICTS)}.map(function (v) {
    const n = results.filter(function (r) { return r.verdict === v; }).length;
    return n ? n + " " + (n === 1 ? single[v] : plural[v]) : "";
  }).filter(function (c) { return c; });
  const head = where + ": " + results.length + " " + (results.length === 1 ? ${literal(one)} : ${literal(many)}) + " checked: " + counts.join(", ") + ".";
  const lines = results.map(function (r) {
    const name = ${pulls ? '"#" + r.id' : "String(r.id).slice(0, 7)"};
    const findings = (r.findings || []).map(function (p) { return "\n  - " + p; }).join("");
    return name + " " + r.title + ": " + r.verdict + findings;
  });
  return { message: { text: [head].concat(lines).join("\n").slice(0, 3500) } };
}`;

export const watch: Recipe = {
  id: "watch",
  fits: "watch a GitHub repository and judge each new commit or pull request (its code quality, risks, what changed), then send the owner one message",
  asks: { github_repo: "the repository, owner/name" },
  uses: ["github"],
  variants: [
    { id: "commits", says: "new commits (the default)" },
    { id: "pulls", says: "new pull requests" },
  ],
  task: {
    says: "how SERV judges each item, in the maker's terms (what counts as good work to them)",
    byDefault: (variant) => `Judge the quality of this ${variant === "pulls" ? "pull request" : "commit"}'s changes: name each real problem (a bug, a risky or unclear change, a missing test where it matters) in a few words, or none, and give a one-line verdict.`,
  },
  build(f: RecipeFill) {
    const k = KINDS[f.variant] ?? KINDS.commits!;
    const given = f.given.github_repo;
    return {
      definition: {
        format: 1,
        name: f.name,
        job: { does: f.does, done: f.done },
        triggers: [f.trigger],
        settings: [{ key: "github_repo", label: "Which GitHub repository", type: "text", help: "The repository it checks: owner/name, or its link.", choices: [], ...(given ? { given } : {}) }],
        rules: [],
        memory: [{ key: "last_item_date", type: "text", description: DATE_CURSOR }],
        services: ["github"],
        steps: [
          {
            id: "read_items",
            kind: "code",
            title: `Read new ${k.many}`,
            plain: `Read the repository's new ${k.many}, at most 5 at a time.`,
            description: `Read the new ${k.many} of the repository in settings.github_repo with github.read (op "${k.op}") and return items, each with id, title, author, date and url. ${firstRunNote("last_item_date")}`,
            inputs: ["settings", "memory"],
            outputs: ["items"],
            shapes: { items: "{ id: text, title: text, author: text, date: text, url: text }[]" },
            tools: ["github.read"],
            next: "judge_items",
          },
          {
            id: "judge_items",
            kind: "code",
            title: `Judge each ${k.one}`,
            plain: `Ask SERV to judge each ${k.one} on its changes.`,
            description: `${eachItemNote()} ${diffsNote()} SERV gives a verdict (pass, minor, problem or critical) and at most 3 findings, each tied to a file it was shown; a verdict worse than pass stands on a finding. Return results, one per item, with id, title, url, verdict and findings.`,
            inputs: ["items", "settings"],
            outputs: ["results"],
            shapes: { results: "{ id: text, title: text, url: text, verdict: text, findings: text[] }[]" },
            tools: ["github.read", "serv.reason"],
            next: "write_message",
          },
          {
            id: "write_message",
            kind: "code",
            title: "Write the message",
            plain: `Put together one message naming each ${k.one} and what was found.`,
            description: `Put the results together in one message: how many ${k.many} were checked and how many of each verdict, counted from the verdicts alone, then each one's short id, title, verdict and findings. Return message, telegram.send's arguments { text }.`,
            inputs: ["results", "settings"],
            outputs: ["message"],
            shapes: { message: "{ text: text }" },
            tools: [],
            next: "send",
          },
          { id: "send", kind: "action", title: "Send it to you", plain: "Send it to you on Telegram.", action: "tell", inputs: ["message"], outputs: [], next: null },
        ],
        actions: [{ id: "tell", tool: "telegram.send", description: "Send you what it found" }],
        limits: { maxSteps: 40, maxRunSeconds: 300, maxSpendUsd: 0.1 },
      },
      code: { read_items: readCode(k.op), judge_items: judgeCode(k.detail, f.task), write_message: messageCode(k.one, k.many, k.op === "pulls") },
    };
  },
  sample(d: AgentDefinition) {
    const bench = emptyBench();
    const repo = (d.settings.find((s) => s.key === "github_repo")?.given ?? "").replace(/^https?:\/\/(?:www\.)?github\.com\//i, "").replace(/\/+$/, "").split("/").slice(0, 2).join("/") || "acme/widgets";
    bench.settings.github_repo = repo;
    const pulls = /pull request/i.test(d.steps[0]?.title ?? "");
    const day = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
    const items = [
      { id: "4f2a9c1", title: "Cache the price lookups", author: "Ada", date: day(1) },
      { id: "9b0e7d3", title: "Fix the retry on timeouts", author: "Lin", date: day(3) },
      { id: "c51d0a8", title: "Add tests for the parser", author: "Ada", date: day(6) },
    ];
    const listed = pulls
      ? items.map((x, i) => ({ number: 40 + i, title: x.title, author: x.author, state: "open", draft: false, created_at: x.date, merged_at: null, url: `https://github.com/${repo}/pull/${40 + i}`, body: "" }))
      : items.map((x) => ({ sha: x.id, message: x.title, author: x.author, date: x.date, url: `https://github.com/${repo}/commit/${x.id}` }));
    const calls: Record<string, unknown> = { [callKey("github.read", { op: pulls ? "pulls" : "commits", repo })]: { items: listed } };
    items.forEach((x, i) => {
      const args = pulls ? { op: "pull", repo, number: 40 + i } : { op: "commit", repo, sha: x.id };
      calls[callKey("github.read", args)] = { items: [{ filename: "src/lookup.ts", status: "modified", additions: 6, deletions: 2, patch: `@@ -10,4 +10,8 @@\n-  return fetchPrice(id);\n+  const hit = cache.get(id);\n+  if (hit) return hit;\n+  const price = await fetchPrice(id);\n+  cache.set(id, price);\n+  return price;` }] };
    });
    bench.calls = calls;
    return { bench, items: { noun: pulls ? "pull request" : "commit", plural: pulls ? "pull requests" : "commits", labels: items.map((x) => x.title) } };
  },
};
