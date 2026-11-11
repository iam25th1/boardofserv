import { checkDefinition, codeSpec, type AgentDefinition, type CodeStepDef } from "@/lib/agents/definition";
import { wireToDefinition } from "@/lib/agents/plan";
import { emptyBench, type BenchData, type StepCode } from "@/lib/agents/types";

// The test case from a real run: a "Hackathon Submission Checker".
// Submissions arrive as rows in a Google Sheet; every 15 minutes it checks
// new rows, judges each requirement in a list as met or not, rejects a
// submission meeting fewer than half, writes Status and Reasons into that
// row, and sends a Telegram summary of the run.
//
// HACKATHON_WIRE is the plan as the planner's rules want it, in SERV's flat
// answer shape: judgement in one decision over a list, counting in code,
// results written into each row, nothing to do when nothing is new.
// BAD_HACKATHON_WIRE is the shape the real run got: the judgement in code,
// "Any new rows?" and "More rows to process?" as decisions, and a loop.

const wireStep = <T extends Record<string, unknown>>(o: T) => ({ plain: "", inputs: [] as string[], outputs: [] as string[], next: "", description: "", tools: [] as string[], prompt: "", each: "", outcomes: [] as { id: string; label: string; next: string }[], action: "", otherwise: "", ...o });

export const HACKATHON_WIRE = {
  name: "Hackathon Submission Checker",
  job: { does: "Checks new hackathon submissions in your sheet against your requirements, marks each Passed or Rejected with reasons, and sends you a summary.", done: "Every new submission has a Status and Reasons, and you have the summary." },
  triggers: [{ kind: "schedule", every: "minutes", at: "", everyMinutes: 15, watch: "", when: "", step: "", description: "Every 15 minutes" }],
  settings: [
    { key: "submissions_sheet", label: "Your submissions sheet", type: "sheet", help: "The tab the submissions arrive in, one per row.", choices: [] },
    { key: "requirements", label: "The requirements, one per line", type: "list", help: "What every submission must have.", choices: [] },
  ],
  rules: [],
  memory: [],
  actions: [
    { id: "write_results", tool: "sheets.update", description: "Write Status and Reasons into each submission's own row", askOver: "", askOverDay: "", amountColumn: "" },
    { id: "send_summary", tool: "telegram.send", description: "Send you a summary of the run", askOver: "", askOverDay: "", amountColumn: "" },
  ],
  steps: [
    wireStep({
      id: "find_new",
      title: "Find new submissions",
      plain: "Read the submissions sheet and pick out the ones not checked yet",
      kind: "code",
      inputs: ["settings"],
      outputs: ["submissions", "checks"],
      next: "judge",
      description:
        "Read the tab settings.submissions_sheet. New submissions are rows whose Status is empty: return submissions, each { row: its _row, project: the Project column, demo: the Demo column, notes: the Notes column }, and checks, one per submission and requirement in settings.requirements: { submission: its place in submissions, project, demo, notes, requirement }.",
      tools: ["sheets.read"],
    }),
    wireStep({
      id: "judge",
      title: "Judge each requirement",
      plain: "Judge every requirement of every new submission: met or not met",
      kind: "decision",
      inputs: ["checks"],
      outputs: ["verdicts"],
      prompt: "Does this submission meet this requirement, from its project, demo and notes?",
      each: "checks",
      outcomes: [
        { id: "met", label: "Met", next: "tally" },
        { id: "not_met", label: "Not met", next: "tally" },
      ],
    }),
    wireStep({
      id: "tally",
      title: "Count and mark",
      plain: "Count the requirements each one met, and mark it Passed, or Rejected when fewer than half are met",
      kind: "code",
      inputs: ["settings", "submissions", "checks", "verdicts"],
      outputs: ["status_updates", "summary"],
      next: "write_status",
      description:
        "For each submission count the verdicts (by item, matching checks) that are met. Rejected when fewer than half of its requirements are met, else Passed; Reasons lists the requirements not met. Return status_updates as sheets.update's arguments { sheet: settings.submissions_sheet, updates: [{ row, values: { Status, Reasons } }] } and summary { text } naming every submission and its result. With no submissions, return both as null.",
    }),
    wireStep({ id: "write_status", title: "Write the results", plain: "Write Status and Reasons into each submission's own row", kind: "action", inputs: ["status_updates"], outputs: ["written"], next: "send", action: "write_results" }),
    wireStep({ id: "send", title: "Send the summary", plain: "Send you a summary of the run on Telegram", kind: "action", inputs: ["summary"], outputs: ["sent"], next: "", action: "send_summary" }),
  ],
  limits: { maxSteps: 20, maxRunSeconds: 120, maxSpendUsd: 0.2 },
  approvalHours: 24,
};

export const BAD_HACKATHON_WIRE = {
  ...HACKATHON_WIRE,
  memory: [{ key: "last_row", description: "The last row checked", type: "number" }],
  actions: [
    { id: "write_status", tool: "sheets.write", description: "Add the status row", askOver: "", askOverDay: "", amountColumn: "" },
    { id: "send_summary", tool: "telegram.send", description: "Send you a summary of the run", askOver: "", askOverDay: "", amountColumn: "" },
  ],
  steps: [
    wireStep({ id: "read_rows", title: "Read the rows", kind: "code", inputs: [], outputs: ["rows"], next: "any_new", description: "Read every row of the Submissions tab.", tools: ["sheets.read"] }),
    wireStep({ id: "any_new", title: "Any new rows?", kind: "decision", inputs: ["rows"], prompt: "Are there any new rows to process?", outcomes: [{ id: "yes", label: "Yes", next: "judge_row" }, { id: "no", label: "No", next: "" }] }),
    wireStep({ id: "judge_row", title: "Judge the requirements", kind: "code", inputs: ["rows"], outputs: ["row_status", "status_args"], next: "write_row", description: "Judge whether the next row meets each requirement and decide its status.", tools: ["sheets.read"] }),
    wireStep({ id: "write_row", title: "Write the status", kind: "action", inputs: ["status_args"], outputs: ["written"], next: "more_rows", action: "write_status" }),
    wireStep({ id: "more_rows", title: "More rows to process?", kind: "decision", inputs: ["rows"], prompt: "Are there more rows to process?", outcomes: [{ id: "yes", label: "Yes", next: "judge_row" }, { id: "no", label: "No", next: "save" }] }),
    wireStep({ id: "save", title: "Save the position", kind: "code", inputs: ["row_status"], outputs: ["position"], next: "send", description: "Save the last row's number as the position.", tools: ["memory.set"] }),
    wireStep({ id: "send", title: "Send the summary", kind: "action", inputs: ["row_status"], outputs: ["sent"], next: "", action: "send_summary" }),
  ],
};

export function hackathonDefinition(wire: Record<string, unknown> = HACKATHON_WIRE): AgentDefinition {
  const c = checkDefinition(wireToDefinition(wire));
  if (!c.ok) throw new Error(`hackathon fixture: ${c.errors.join("; ")}`);
  return c.definition;
}

// The two code steps, written as SERV would approve them.
export const FIND_NEW = `async function run(input, tools) {
  const sheet = input.settings.submissions_sheet;
  const { rows } = await tools.sheets.read({ sheet });
  const reqs = (input.settings.requirements || []).filter(Boolean);
  const submissions = rows.filter((r) => !r.Status).map((r) => ({ row: r._row, project: String(r.Project || ""), demo: String(r.Demo || ""), notes: String(r.Notes || "") }));
  const checks = [];
  submissions.forEach((s, i) => reqs.forEach((requirement) => checks.push({ submission: i, project: s.project, demo: s.demo, notes: s.notes, requirement })));
  return { submissions, checks };
}`;

export const TALLY = `async function run(input) {
  const subs = input.submissions || [];
  if (!subs.length) return { status_updates: null, summary: null };
  const checks = input.checks || [];
  const results = subs.map((s) => ({ row: s.row, project: s.project, met: 0, total: 0, missing: [] }));
  (input.verdicts || []).forEach((v) => {
    const c = checks[v.item];
    if (!c) return;
    const r = results[c.submission];
    r.total += 1;
    if (v.outcome === "met") r.met += 1;
    else r.missing.push(c.requirement);
  });
  const updates = results.map((r) => {
    const passed = r.total > 0 && r.met * 2 >= r.total;
    return { row: r.row, values: { Status: passed ? "Passed" : "Rejected", Reasons: r.missing.length ? "Not met: " + r.missing.join("; ") : "All requirements met" } };
  });
  const passed = updates.filter((u) => u.values.Status === "Passed").length;
  const lines = results.map((r, i) => r.project + ": " + updates[i].values.Status + " (" + r.met + " of " + r.total + " met)");
  const text = "Checked " + subs.length + " submissions: " + passed + " passed, " + (subs.length - passed) + " rejected.\\n" + lines.join("\\n");
  return { status_updates: { sheet: input.settings.submissions_sheet, updates }, summary: { text } };
}`;

export function hackathonCode(d: AgentDefinition, sources: Record<string, string> = { find_new: FIND_NEW, tally: TALLY }): Record<string, StepCode> {
  return Object.fromEntries(
    d.steps
      .filter((s): s is CodeStepDef => s.kind === "code")
      .map((s) => [s.id, { spec: codeSpec(s), status: "approved" as const, source: sources[s.id] ?? null, rounds: 1, note: null, updatedAt: "2026-11-11T00:00:00.000Z" }]),
  );
}

export const HACKATHON_LABELS = ["Tide Tracker", "Lunch Vote", "Plant Pal"];

export function hackathonBench(): BenchData {
  return {
    ...emptyBench(),
    settings: { submissions_sheet: "Submissions", requirements: ["A working demo", "A public repository", "A short write-up"] },
    sheets: {
      Submissions: [
        { Project: "Tide Tracker", Demo: "https://tide.example", Notes: "Repo on GitHub, write-up in the README", Status: "", Reasons: "" },
        { Project: "Lunch Vote", Demo: "", Notes: "Slides only", Status: "", Reasons: "" },
        { Project: "Plant Pal", Demo: "https://plant.example", Notes: "Open source, two-page write-up", Status: "", Reasons: "" },
      ],
    },
  };
}
