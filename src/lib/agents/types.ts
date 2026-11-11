import type { ToolName } from "./definition";

// What a version stores beside its definition, shared by the server and the
// builder. No dependencies, so the database schema can name these types.

// Where one code step's code stands. "queued" waits for Dolphin, "writing"
// is with Dolphin, "reviewing" with SERV; "approved" can run;
// "needs_attention" is code SERV still rejected after the last round.
export type CodeStatus = "queued" | "writing" | "reviewing" | "approved" | "needs_attention";

export interface StepCode {
  // What the step asked for when this code was written (codeSpec): when the
  // step changes, its code is written again.
  spec: string;
  status: CodeStatus;
  // The function's source: the maker's builder only, never a renter.
  source: string | null;
  // Writing rounds used, and what the last review said.
  rounds: number;
  note: string | null;
  // Who wrote it: Dolphin unless it failed twice on this step and SERV
  // wrote it instead.
  writer?: "dolphin" | "serv";
  // The step's tools as its code really calls them, when that differs from
  // the plan's list (code.ts fitTools): the plan is changed to match.
  tools?: ToolName[];
  updatedAt: string;
}

// The last test of a version, in plain words: "Test it" on the chat's card
// or the agent's page, or the check every new plan gets once its code is
// written. The sample data it ran on is the version's bench; this says what
// those items were called and how it went.
export interface TestResult {
  status: "passed" | "failed";
  // What happened, as a short story: "3 submissions checked: 2 passed, 1
  // rejected, summary sent".
  story: string;
  // What is wrong, one plain sentence each, and the step it is about.
  problems: { step: string | null; text: string }[];
  // What the sample items are: "submission", "submissions", and the three
  // items' own names, as they appear in the sample data.
  items: { noun: string; plural: string; labels: string[] } | null;
  kind: "manual" | "self";
  checkedAt: string;
  // The sample data it ran on, and a fingerprint of the plan it was made
  // from: a new sample is made only when the plan's questions or steps
  // change.
  sample?: BenchData;
  sampleOf?: string;
}

// A search result, as the web.search tool returns it.
export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

// The test bench's sample data: what each tool's mock answers with, what a
// renter would have set up, and the recorded answers a dry run uses for
// decision steps. The maker edits all of it in the builder.
export interface BenchData {
  settings: Record<string, unknown>;
  // Rule values for the run, as text, over the maker's defaults.
  rules: Record<string, string>;
  // What woke the agent up: a message, a checked value. Null for a schedule.
  trigger: Record<string, unknown> | null;
  // Sheet name to its rows.
  sheets: Record<string, Record<string, unknown>[]>;
  // Address to page text, for web.fetch.
  pages: Record<string, string>;
  // Query to results, for web.search ("*" answers any other query).
  search: Record<string, SearchResult[]>;
  // telegram.ask's answers, in the order the questions come.
  telegram: { answers: string[] };
  memory: Record<string, unknown>;
  wallet: { balanceUsdc: number };
  // Decision step id to the outcome a dry run takes.
  decisions: Record<string, string>;
}

export function emptyBench(): BenchData {
  return { settings: {}, rules: {}, trigger: null, sheets: {}, pages: {}, search: {}, telegram: { answers: [] }, memory: {}, wallet: { balanceUsdc: 0 }, decisions: {} };
}

// Where a run is, saved so it can pick up from here.
export interface RunState {
  // The step to run next; null once the run has ended.
  at: string | null;
  bag: Record<string, unknown>;
  // Steps started, time spent running (never waiting), model spend.
  steps: number;
  ms: number;
  costUsd: number;
  // The current step's tool calls so far, in order.
  journal: JournalEntry[];
  // The current step has started already (it runs again after a pause or a
  // restart, and isn't counted twice).
  resumed: boolean;
  // Values in the bag made from anything outside the renter's own answers
  // (web pages, web searches, sheets, messages, memory): untrusted data.
  untrusted?: string[];
  // Where each untrusted value came from, in words ("a web page").
  sources?: Record<string, string[]>;
  // The renter let this job go over the weekly model budget.
  budgetOk?: boolean;
  // How many times each step has started in this job (in a loop, in this
  // pass).
  visits?: Record<string, number>;
  // The loops it is inside, outermost first: the loop step, the pass it is
  // on (from 0) and what it has gathered from the passes before.
  loops?: { step: string; index: number; gathered: Record<string, unknown[]> }[];
}

// The screen of a step's untrusted inputs takes the step's first journal
// place when it runs, so its pause and answer replay like a tool call's.
export const SCREEN = "screen" as const;
// So does the renter's answer about going over the weekly model budget.
export const BUDGET = "budget" as const;

export interface JournalEntry {
  tool: ToolName | typeof SCREEN | typeof BUDGET;
  args: unknown;
  // What it answered, or the error it gave (absent while it waits).
  result?: unknown;
  error?: string | null;
  // The error was outside the agent: a retry makes this call again.
  infra?: boolean;
  // Waiting for the owner, or their answer (null when none came in time).
  waiting?: boolean;
  approval?: { answer: string | null };
}

// What a test bench run reports, step by step, as it happens.
export type RunEvent =
  | { type: "start"; dryRun: boolean }
  | { type: "step"; stepId: string; input: unknown }
  | { type: "tool"; stepId: string; tool: string; args: unknown; result: unknown; error: string | null }
  | { type: "step_done"; stepId: string; status: "ok" | "failed"; output: unknown; outcome: string | null; note: string | null; ms: number; costUsd: number; model?: string | null }
  // A job (never the bench) waiting for its owner's answer at this step.
  | { type: "wait"; stepId: string; question: string; choices: string[] }
  | { type: "end"; status: "done" | "failed" | "stopped"; reason: string; steps: number; ms: number; costUsd: number; memory: Record<string, unknown>; sheets: BenchData["sheets"] };
