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

const readCode = (op: string) => String.raw`async function run(input, tools) {
  const repo = ${REPO_FROM_SETTING};
  if (!repo) return { items: [] };
  const got = await tools.github.read({ op: ${literal(op)}, repo: repo });
  const list = got && Array.isArray(got.items) ? got.items : [];
  // A merge (two parents or more) brings in work its own commits showed.
  const items = list.map(function (x) {
    return { id: String(x.sha || x.number || ""), title: String(x.message || x.title || ""), author: String(x.author || ""), date: String(x.date || x.created_at || ""), url: String(x.url || ""), merge: Number(x.parents || 1) > 1 };
  });
  return { items: items };
}`;

// What SERV says about not seeing more of a change (a patch cut short, a
// file left out) is about the call, not the code: never a finding.
export const NOT_SEEN = /\b(?:cut off|cut short|truncat\w*|incomplete (?:patch|diff|data|code|content|file|context|view)|partial(?:ly)? (?:shown|visible|patch|diff|content|code|view)|not (?:fully |all )?(?:shown|visible|included|provided)|cannot (?:be )?(?:verif\w*|see|validat\w*|confirm\w*|assess\w*|determin\w*|tell)|can.?t (?:verif\w*|see|validat\w*|confirm\w*|tell)|unable to (?:verif\w*|see|validat\w*|confirm\w*|assess\w*|determin\w*)|without (?:confirming|seeing|verifying|the full)|(?:missing|full|more|surrounding|enough) context|obscure\w*|omitted|lines not shown|missing clos\w*|elsewhere in the (?:code|file|repo\w*)|rest of the (?:file|code|patch))\b/i;

// A verdict, worst first, as SERV is asked for it.
export const VERDICTS = ["critical", "problem", "minor", "pass"] as const;

// What SERV is asked about each item: the owner's bar for good work (in
// their words, from when the agent was made), and how to judge against it.
export const judgeTask = (bar: string) =>
  [
    `What the owner asked for: ${bar.trim()}`,
    "Judge only the changes shown, against that.",
    CUT_NOTE,
    "Never raise a finding about not seeing more: not about cut, partial or missing content, not about code in files you were not shown, and not about anything you cannot verify from what is here.",
    "Raise a real risk only with the file and the line it comes from, as 'path: the risk, at the line it comes from (quoted briefly)'; if you can't point at the line, don't raise it.",
    "Answer verdict with exactly one word: pass (nothing worth raising), minor (small things only), problem (a real bug or risk to fix) or critical (it would break or endanger something when it runs).",
    "findings: at most 3, the most important first, each starting with the file it is in. None for a pass.",
  ].join(" ");

// Files that say nothing of the work: lockfiles, generated and binary files.
export const SKIP_FILES = /(?:^|\/)(?:package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb|Cargo\.lock|Gemfile\.lock|composer\.lock|poetry\.lock|Pipfile\.lock|go\.sum|[\w.-]+\.lock)$|(?:^|\/)(?:dist|build|out|vendor|node_modules|coverage|__snapshots__|\.next|migrations\/meta)\/|\.(?:min\.js|min\.css|map|snap|png|jpe?g|gif|webp|ico|svg|pdf|zip|gz|tgz|woff2?|ttf|eot|otf|mp4|mov|webm|mp3|wav|wasm|bin|exe|dll|so|dylib|jar|pyc)$/i;
// Tests and test data: sent after the source they test.
export const TEST_FILES = /(?:^|\/)(?:__tests__|tests?|e2e|spec|fixtures)\/|\.(?:test|spec)\.[a-z]+$/i;
// What one item's call to SERV may carry: the platform cuts anything past
// 8,000 characters (reason.ts), so the step fits it under that itself.
export const JUDGE_ROOM = 7600;
// Said with every item's changes: what is left out is not a defect.
export const CUT_NOTE = "Some files' changes are shortened to their first and last lines around a note saying how many lines are not shown, and files in not_shown were left out to keep this call small: what is not shown is not missing from the code and is never a defect.";

const judgeCode = (detail: string, task: string) => String.raw`async function run(input, tools) {
  const repo = ${REPO_FROM_SETTING};
  const items = (Array.isArray(input.items) ? input.items : []).slice().reverse();
  const notSeen = ${NOT_SEEN.toString()};
  const verdicts = ${JSON.stringify(VERDICTS)};
  const skip = ${SKIP_FILES.toString()};
  const isTest = ${TEST_FILES.toString()};
  const room = ${JUDGE_ROOM};
  // A long patch kept to its first and last lines, with a note between.
  const shorten = function (text, n) {
    if (text.length <= n) return text;
    const lines = text.split("\n");
    const head = [];
    const tail = [];
    let used = 40;
    for (let i = 0; i < lines.length && used + lines[i].length + 1 <= (n * 2) / 3; i++) {
      head.push(lines[i]);
      used += lines[i].length + 1;
    }
    for (let j = lines.length - 1; j >= head.length && used + lines[j].length + 1 <= n; j--) {
      tail.unshift(lines[j]);
      used += lines[j].length + 1;
    }
    if (!head.length) head.push(lines[0].slice(0, Math.floor((n * 2) / 3)));
    return head.concat(["[" + (lines.length - head.length - tail.length) + " lines not shown]"], tail).join("\n");
  };
  const results = [];
  const skipped = [];
  for (const item of items) {
    // A merge is not judged again: its changes were judged as they came.
    if (item.merge) {
      skipped.push({ id: item.id, title: item.title, why: "merge" });
      continue;
    }
    let changed = [];
    try {
      const got = await tools.github.read(${detail});
      changed = got && Array.isArray(got.items) ? got.items : [];
    } catch (e) {
      changed = [];
    }
    // The source first, then its tests; nothing that says nothing of the work.
    const kept = changed
      .filter(function (f) { return f && f.filename && !skip.test(String(f.filename)); })
      .sort(function (a, b) { return (isTest.test(String(a.filename)) ? 1 : 0) - (isTest.test(String(b.filename)) ? 1 : 0); });
    const data = { item: { title: item.title, author: item.author, date: item.date }, files: [], not_shown: [] };
    const unchecked = [];
    const notWhole = function (name) { if (unchecked.indexOf(name) === -1) unchecked.push(name); };
    // Each file gets its share of the room left, a long one its first and
    // last lines; one with no room left, or none to show, is named only.
    kept.forEach(function (f, i) {
      const name = String(f.filename);
      const entry = { name: name, status: f.status, added: f.additions, removed: f.deletions, patch: typeof f.patch === "string" ? f.patch : null };
      if (entry.patch === null) {
        data.not_shown.push(name);
        notWhole(name);
        return;
      }
      if (f.cut) notWhole(name);
      const share = Math.floor((room - JSON.stringify(data).length) / (kept.length - i));
      let fitted = JSON.stringify(entry).length <= share ? entry : null;
      let n = share - name.length - 120;
      while (!fitted && n >= 300) {
        const tried = { name: name, status: f.status, added: f.additions, removed: f.deletions, patch: shorten(entry.patch, n) };
        if (JSON.stringify(tried).length <= share) fitted = tried;
        n = Math.floor(n * 0.8);
      }
      if (!fitted) {
        data.not_shown.push(name);
        notWhole(name);
        return;
      }
      if (fitted !== entry) notWhole(name);
      data.files.push(fitted);
    });
    if (!data.files.length) {
      skipped.push({ id: item.id, title: item.title, why: data.not_shown.length ? "too large to check" : "only lockfiles, generated or binary files" });
      continue;
    }
    const judged = await tools.serv.reason({
      task: ${literal(judgeTask(task))},
      data: data,
      answer: { verdict: "text", findings: "list" },
    });
    // A finding names a file it was shown, and is about the code.
    const names = data.files.map(function (f) { return f.name; });
    const tied = function (s) { return names.some(function (n) { return s.indexOf(n) !== -1 || s.indexOf(n.split("/").pop()) !== -1; }); };
    const findings = (Array.isArray(judged.findings) ? judged.findings : []).map(function (s) { return String(s).trim(); }).filter(function (s) { return s && !notSeen.test(s) && tied(s); }).slice(0, 3);
    const said = String(judged.verdict || "").trim().toLowerCase().split(/[^a-z]+/)[0];
    let verdict = verdicts.indexOf(said) !== -1 ? said : findings.length ? "minor" : "pass";
    // Worse than a pass stands on a finding; a pass raises none.
    if (verdict !== "pass" && !findings.length) verdict = "pass";
    results.push({ id: item.id, title: item.title, url: item.url, verdict: verdict, findings: verdict === "pass" ? [] : findings, unchecked: unchecked });
  }
  return { results: results, skipped: skipped };
}`;

// The message: the counts (the verdicts', worst first), then each item on
// one line, its verdict first, its findings set in under it, what was
// skipped, and how many files it couldn't see whole.
const messageCode = (one: string, many: string, pulls: boolean) => String.raw`async function run(input) {
  const results = Array.isArray(input.results) ? input.results : [];
  const skipped = Array.isArray(input.skipped) ? input.skipped : [];
  if (!results.length && !skipped.length) return { message: null };
  const where = String((input.settings || {}).github_repo || "").trim();
  const order = ${JSON.stringify(VERDICTS)};
  const word = { critical: "Critical", problem: "Problem", minor: "Minor", pass: "Passed" };
  const plural = { critical: "critical", problem: "problems", minor: "minor", pass: "passed" };
  const single = { critical: "critical", problem: "problem", minor: "minor", pass: "passed" };
  const counts = order.map(function (v) {
    const n = results.filter(function (r) { return r.verdict === v; }).length;
    return n ? n + " " + (n === 1 ? single[v] : plural[v]) : "";
  }).filter(function (c) { return c; });
  const merges = skipped.filter(function (x) { return x.why === "merge"; }).length;
  const head = where + ": " + results.length + " " + (results.length === 1 ? ${literal(one)} : ${literal(many)}) + " checked" + (counts.length ? ": " + counts.join(", ") : "") + "." + (merges ? " " + merges + (merges === 1 ? " merge" : " merges") + " skipped." : "");
  const short = function (id) { return ${pulls ? '"#" + id' : "String(id).slice(0, 7)"}; };
  const lines = results.map(function (r) {
    const findings = (r.findings || []).map(function (p) { return "\n  - " + p; }).join("");
    return (word[r.verdict] || "Passed") + " " + short(r.id) + " " + r.title + findings;
  });
  const passedBy = skipped.map(function (x) { return "Skipped " + short(x.id) + " " + x.title + " (" + (x.why === "merge" ? "a merge" : x.why) + ")"; });
  const unchecked = [];
  results.forEach(function (r) {
    (r.unchecked || []).forEach(function (f) { if (unchecked.indexOf(r.id + ":" + f) === -1) unchecked.push(r.id + ":" + f); });
  });
  const tail = unchecked.length ? ["Not fully checked: " + unchecked.length + (unchecked.length === 1 ? " file" : " files") + " (too large)"] : [];
  return { message: { text: [head].concat(lines, passedBy, tail).join("\n").slice(0, 3500) } };
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
    says: "the owner's bar for good work, in their terms (what counts as good work to them), one or two sentences",
    byDefault: (variant) => `Good work in this ${variant === "pulls" ? "pull request" : "commit"} is correct, clear and safe: a real bug, a risky or unclear change, or a missing test where it matters counts against it.`,
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
            description: `Read the new ${k.many} of the repository in settings.github_repo with github.read (op "${k.op}") and return items, each with id, title, author, date, url and merge (true for a merge: parents 2 or more). ${firstRunNote("last_item_date")}`,
            inputs: ["settings", "memory"],
            outputs: ["items"],
            shapes: { items: "{ id: text, title: text, author: text, date: text, url: text, merge: boolean }[]" },
            tools: ["github.read"],
            next: "judge_items",
          },
          {
            id: "judge_items",
            kind: "code",
            title: `Judge each ${k.one}`,
            plain: `Ask SERV to judge each ${k.one} on its changes.`,
            description: `${eachItemNote()} ${diffsNote()} It leaves out lockfiles, generated and binary files, sends the source before its tests, and fits the call under its room: a long patch as its first and last lines, a file with no room named only (unchecked). SERV gives a verdict (pass, minor, problem or critical) and at most 3 findings, each tied to a file it was shown; a verdict worse than pass stands on a finding. Return results, one per item judged, with id, title, url, verdict, findings and unchecked, and skipped: a merge (its changes were judged as they came) and an item with nothing to check, each with id, title and why.`,
            inputs: ["items", "settings"],
            outputs: ["results", "skipped"],
            shapes: { results: "{ id: text, title: text, url: text, verdict: text, findings: text[], unchecked: text[] }[]", skipped: "{ id: text, title: text, why: text }[]" },
            tools: ["github.read", "serv.reason"],
            next: "write_message",
          },
          {
            id: "write_message",
            kind: "code",
            title: "Write the message",
            plain: `Put together one message naming each ${k.one} and what was found.`,
            description: `Put the results together in one message: how many ${k.many} were checked and how many of each verdict, counted from the verdicts alone, and how many merges were skipped; then one line for each, its verdict first, then its short id and title, its findings set in under it; then each one skipped and why; then, when any file was too large to see whole, one line saying how many. Return message, telegram.send's arguments { text }.`,
            inputs: ["results", "skipped", "settings"],
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
    // Three to judge and a merge to leave alone; among their files a
    // lockfile, a source file with its test, and a patch too long to send
    // whole (cut by GitHub's read, its first and last lines kept).
    const items = [
      { id: "4f2a9c1", title: "Cache the price lookups", author: "Ada", date: day(1), parents: 1 },
      { id: "7d0c3e5", title: "Merge branch 'retry'", author: "Ada", date: day(2), parents: 2 },
      { id: "9b0e7d3", title: "Fix the retry on timeouts", author: "Lin", date: day(3), parents: 1 },
      { id: "c51d0a8", title: "Add tests for the parser", author: "Ada", date: day(6), parents: 1 },
    ];
    const cache = { filename: "src/lookup.ts", status: "modified", additions: 6, deletions: 2, patch: "@@ -10,4 +10,8 @@\n-  return fetchPrice(id);\n+  const hit = cache.get(id);\n+  if (hit) return hit;\n+  const price = await fetchPrice(id);\n+  cache.set(id, price);\n+  return price;", cut: false };
    const lock = { filename: "package-lock.json", status: "modified", additions: 40, deletions: 12, patch: '@@ -1,4 +1,4 @@\n-    "version": "1.2.0",\n+    "version": "1.2.1",', cut: false };
    const long = Array.from({ length: 120 }, (_, i) => `+  if (attempt === ${i}) await wait(backoff(${i}));`);
    const retry = { filename: "src/retry.ts", status: "modified", additions: 130, deletions: 4, patch: ["@@ -1,6 +1,132 @@", "+export async function retry(f, attempts) {", ...long.slice(0, 20), "[96 lines not shown]", ...long.slice(-4), "+}"].join("\n"), cut: true };
    const parser = { filename: "src/parser.ts", status: "modified", additions: 2, deletions: 1, patch: "@@ -3,3 +3,4 @@\n-  return text.split(',');\n+  if (!text) return [];\n+  return text.split(',');", cut: false };
    const parserTest = { filename: "src/parser.test.ts", status: "added", additions: 5, deletions: 0, patch: "@@ -0,0 +1,5 @@\n+import { parse } from './parser';\n+it('reads nothing as nothing', () => {\n+  expect(parse('')).toEqual([]);\n+});", cut: false };
    const filesOf: Record<string, unknown[]> = { "4f2a9c1": [lock, cache], "9b0e7d3": [retry], c51d0a8: [parserTest, parser] };
    const listed = pulls
      ? items.filter((x) => x.parents === 1).map((x, i) => ({ number: 40 + i, title: x.title, author: x.author, state: "open", draft: false, created_at: x.date, merged_at: null, url: `https://github.com/${repo}/pull/${40 + i}`, body: "" }))
      : items.map((x) => ({ sha: x.id, message: x.title, author: x.author, date: x.date, url: `https://github.com/${repo}/commit/${x.id}`, parents: x.parents }));
    const calls: Record<string, unknown> = { [callKey("github.read", { op: pulls ? "pulls" : "commits", repo })]: { items: listed } };
    items
      .filter((x) => x.parents === 1)
      .forEach((x, i) => {
        const args = pulls ? { op: "pull", repo, number: 40 + i } : { op: "commit", repo, sha: x.id };
        calls[callKey("github.read", args)] = { items: filesOf[x.id] };
      });
    bench.calls = calls;
    const shown = pulls ? items.filter((x) => x.parents === 1) : items;
    return { bench, items: { noun: pulls ? "pull request" : "commit", plural: pulls ? "pull requests" : "commits", labels: shown.map((x) => x.title) } };
  },
};
