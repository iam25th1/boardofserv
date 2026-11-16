import { checkDefinition, type AgentDefinition } from "@/lib/agents/definition";
import type { StepCode } from "@/lib/agents/types";

// The live "GitHub code quality checker", as it was planned and written:
// version 2 remembered the last commit's sha and passed it to GitHub's
// since (a date), and version 3 remembered a date but asked SERV once per
// changed file. The fixtures for the review, the code checks and the runs.

export function checkerDefinition(o: { memory?: { key: string; type: "text"; description: string }; rules?: AgentDefinition["rules"] } = {}): AgentDefinition {
  const memory = o.memory ?? { key: "last_check_date", type: "text" as const, description: "ISO format timestamp of the last analysis to fetch only commits since then" };
  const c = checkDefinition({
    format: 1,
    name: "GitHub code quality checker",
    job: { does: "Analyzes code in GitHub repositories for quality issues and generates reports on findings.", done: "It has examined the repository and reported the results." },
    triggers: [{ kind: "schedule", every: "minutes", interval: 60, at: null, description: "Every hour" }],
    settings: [{ key: "github_repo", label: "GitHub repository URL or owner/repo", type: "text", help: "The repository to analyze, like owner/repo", choices: [], given: "" }],
    rules: o.rules ?? [],
    memory: [memory],
    services: ["github"],
    steps: [
      {
        id: "fetch_commits",
        kind: "code",
        title: "Fetch recent commits",
        description: `Call github.read with op "commits" for the repository in settings.github_repo. On the first run (memory.${memory.key} is empty), fetch the latest 5 commits; after that only commits since memory.${memory.key}. Return commits with sha, message, author and date.`,
        inputs: ["settings", "memory"],
        outputs: ["commits"],
        tools: ["github.read"],
        next: "analyze_quality",
      },
      {
        id: "analyze_quality",
        kind: "code",
        title: "Analyze code quality",
        description: "For each commit, read its changed files with github.read op commit and ask serv.reason to judge their quality. Return violations (file, type, severity, line, message) and quality_summary { files_checked, violations_total }.",
        inputs: ["commits", "settings"],
        outputs: ["violations", "quality_summary"],
        tools: ["github.read", "serv.reason"],
        next: "make_send_report_action",
      },
      {
        id: "make_send_report_action",
        kind: "code",
        title: "Write the message",
        description: "Ask serv.reason to write a plain-text message summarizing the analysis for settings.github_repo: the violations by severity and the files checked. Return send_report_action_content, the text.",
        inputs: ["violations", "quality_summary", "settings"],
        outputs: ["send_report_action_content"],
        tools: ["serv.reason"],
        next: "send_report_action",
      },
      { id: "send_report_action", kind: "action", title: "Send quality report", action: "send_report", inputs: ["send_report_action_content"], outputs: ["report_sent"], next: "save_last_check" },
      {
        id: "save_last_check",
        kind: "code",
        title: "Save where it got to",
        description: `Save the newest commit's ${memory.key === "last_commit_sha" ? "sha" : "date"} in memory.${memory.key} for the next run.`,
        inputs: ["commits", "memory"],
        outputs: ["saved"],
        tools: ["memory.set"],
        next: null,
      },
    ],
    actions: [{ id: "send_report", tool: "telegram.send", description: "Send code quality report to maker" }],
    limits: { maxSteps: 200, maxRunSeconds: 300, maxSpendUsd: 0.5 },
  });
  if (!c.ok) throw new Error(c.errors.join("; "));
  return c.definition;
}

const approved = (source: string): StepCode => ({ spec: "", status: "approved", source, rounds: 1, note: null, updatedAt: "2026-11-16T19:38:00.000Z" });

// Version 2's reading step, as Dolphin wrote it: the sha it remembered went
// to GitHub's since.
export const V2_FETCH = `async function run(input, tools) {
  const settings = input.settings || {};
  const memory = input.memory || {};
  const repo = typeof settings.github_repo === "string" ? settings.github_repo : "";
  if (!repo) return { commits: [] };

  const since = typeof memory.last_commit_sha === "string" ? memory.last_commit_sha.trim() : "";

  const args = { op: "commits", repo };
  if (since) {
    args.since = since;
  } else {
    args.limit = 5;
  }

  let items = [];
  try {
    const res = await tools.github.read(args);
    items = Array.isArray(res && res.items) ? res.items : [];
  } catch (e) {
    items = [];
  }

  const commits = items.map((c) => ({
    sha: c && c.sha != null ? String(c.sha) : "",
    message: c && c.message != null ? String(c.message) : "",
    author: c && c.author != null ? String(c.author) : "",
    date: c && c.date != null ? String(c.date) : "",
  }));

  return { commits };
}`;

export const V2_SAVE = `async function run(input, tools) {
  const commits = Array.isArray(input.commits) ? input.commits : [];
  const first = commits[0];
  const sha = first && typeof first.sha === "string" && first.sha ? first.sha : "";
  if (sha) {
    await tools.memory.set({ key: "last_commit_sha", value: sha });
  }
  return { saved: sha };
}`;

// Version 3's: a date remembered, and SERV asked once per changed file of
// every commit.
export const V3_FETCH = `async function run(input, tools) {
  const settings = input.settings || {};
  const memory = input.memory || {};
  const repo = settings.github_repo;
  if (!repo) return { commits: [] };

  const since = memory.last_check_date ? String(memory.last_check_date) : "";
  const params = { op: "commits", repo };
  if (since) {
    params.since = since;
  } else {
    params.limit = 5;
  }

  let items = [];
  try {
    const res = await tools.github.read(params);
    items = (res && Array.isArray(res.items)) ? res.items : [];
  } catch (e) {
    items = [];
  }

  const commits = items.map((c) => ({
    sha: c && c.sha != null ? String(c.sha) : "",
    message: c && c.message != null ? String(c.message) : "",
    author: c && c.author != null ? String(c.author) : "",
    date: c && c.date != null ? String(c.date) : ""
  }));

  return { commits };
}`;

export const V3_ANALYZE = `async function run(input, tools) {
  const commits = Array.isArray(input.commits) ? input.commits : [];
  const settings = input.settings || {};
  const repo = settings.github_repo;
  const violations = [];
  const files = new Set();
  for (const commit of commits) {
    if (!commit || !commit.sha) continue;
    let filesRes;
    try {
      filesRes = await tools.github.read({ op: "commit", repo, sha: commit.sha });
    } catch (e) {
      continue;
    }
    const changed = Array.isArray(filesRes && filesRes.items) ? filesRes.items : [];
    for (const file of changed) {
      if (!file || !file.filename) continue;
      files.add(file.filename);
      const judged = await tools.serv.reason({
        task: "Judge the code quality of this changed file and list its violations.",
        data: { filename: file.filename, patch: file.patch },
        answer: { violations: "list" }
      });
      for (const v of Array.isArray(judged && judged.violations) ? judged.violations : []) violations.push({ file: file.filename, type: "style", severity: "info", line: 0, message: String(v) });
    }
  }
  return { violations, quality_summary: { files_checked: files.size, violations_total: violations.length } };
}`;

export const V3_MESSAGE = `async function run(input, tools) {
  const settings = input.settings || {};
  const summary = input.quality_summary || {};
  const violations = Array.isArray(input.violations) ? input.violations : [];
  const res = await tools.serv.reason({
    task: "Write a plain-text message for the owner summarizing the code quality analysis of " + (settings.github_repo || "the repository") + ".",
    data: { quality_summary: summary, violations: violations.slice(0, 50) },
    answer: { text: "text" }
  });
  return { send_report_action_content: res && typeof res.text === "string" ? res.text : "" };
}`;

export const V3_SAVE = `async function run(input, tools) {
  const commits = Array.isArray(input.commits) ? input.commits : [];
  const first = commits[0];
  const raw = first && typeof first.date === "string" ? first.date : "";
  let saved = "";
  if (raw) {
    const d = new Date(raw);
    if (!isNaN(d.getTime())) saved = d.toISOString();
  }
  await tools.memory.set({ key: "last_check_date", value: saved });
  return { saved };
}`;

export function v2Checker(): { definition: AgentDefinition; code: Record<string, StepCode> } {
  return {
    definition: checkerDefinition({ memory: { key: "last_commit_sha", type: "text", description: "SHA of the last commit analyzed to fetch only new commits on subsequent runs" } }),
    code: { fetch_commits: approved(V2_FETCH), analyze_quality: approved(V3_ANALYZE), make_send_report_action: approved(V3_MESSAGE), save_last_check: approved(V2_SAVE) },
  };
}

export function v3Checker(): { definition: AgentDefinition; code: Record<string, StepCode> } {
  return {
    definition: checkerDefinition(),
    code: { fetch_commits: approved(V3_FETCH), analyze_quality: approved(V3_ANALYZE), make_send_report_action: approved(V3_MESSAGE), save_last_check: approved(V3_SAVE) },
  };
}
