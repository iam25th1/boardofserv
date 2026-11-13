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
  // What happened, as a short story: "Passed. 3 submissions checked: 2
  // passed, 1 rejected, summary sent", or for an agent that handles one
  // thing, what it did in order.
  story: string;
  // What is wrong, one plain sentence each, the step it is about and the
  // check that found it.
  problems: { step: string | null; text: string; check?: CheckId }[];
  // What the sample items are: "submission", "submissions", and the
  // items' own names (one, or three for an agent that goes through a
  // list), as they appear in the sample data.
  items: { noun: string; plural: string; labels: string[] } | null;
  kind: "manual" | "self";
  checkedAt: string;
  // The sample data it ran on, and a fingerprint of the plan it was made
  // from: a new sample is made only when the plan's questions or steps
  // change.
  sample?: BenchData;
  sampleOf?: string;
  // A self test after Fix this ran on its own: the problem the test before
  // it found, in its plain sentence.
  fixed?: string;
}

// The self test's checks (test.ts), by name: the run got through; no tool
// error was passed over; it did its job on a sample made for it; the
// summary covers every item; it doesn't add its results to the tab it
// reads; run again, it skips what it did; told no, it does nothing.
export type CheckId = "ran" | "tool_error" | "did_job" | "summary" | "write_back" | "second_run" | "said_no";

// What went wrong, as the build found it, with everything there is to act
// on: where (the stage and the step), what happened, what was expected, and
// the evidence. Every failure of a build makes one (diagnosis.ts), and the
// fixer (fixer.ts) reads it.
export interface Diagnosis {
  stage: "plan" | "code" | "test" | "connect" | "live";
  // The step it is about, when there is one.
  step: { id: string; title: string } | null;
  // What happened, in the system's own words (a review's reason, a check's
  // sentence, the plan checker's reasons).
  failure: string;
  // What should have happened instead.
  expected: string;
  evidence: {
    // The plan as it was, when there was one.
    plan: unknown;
    // What the step had to do: its brief, what it reads and makes, its tools.
    spec: string | null;
    code: string | null;
    // The code review's reason, and the check that failed.
    review: string | null;
    check: CheckId | null;
    // The test run, one line per step and tool call.
    trace: string[];
    // The sample data the test ran on.
    sample: BenchData | null;
    // The plan checker's reasons, or the setup's.
    errors: string[];
  };
  at: string;
}

// One repair round: what was wrong, what the fixer made of it, what it did
// and how that went.
export interface HealRound {
  diagnosis: Diagnosis;
  // code: the step's code was wrong; plan: the steps were; test: the
  // sample or the choice of checks; unclear: only the maker can say.
  verdict: "code" | "plan" | "test" | "unclear" | null;
  // The fixer's reason, and what it changed, in words.
  why: string;
  repair: string;
  // pending: still being made; rejected: the safety check turned it down.
  outcome: "pending" | "fixed" | "failed" | "rejected" | "asked";
  rejected?: string | null;
  // What it learned, once it fixed it (lessons.ts).
  lesson?: { kind: string; text: string } | null;
  at: string;
}

// How a build healed itself, kept on the version for the details view:
// every round, the plain lines the Build and Try it cards show, a question
// waiting for the maker, and where it gave up.
export interface HealLog {
  rounds: HealRound[];
  // Where this build's rounds start: the ones before are earlier builds'.
  since?: number;
  lines: { text: string; tone: "working" | "fixed" | "asked" | "stopped"; at: string }[];
  // A question waiting for the maker, and the chat message that asks it.
  question?: { text: string; choices: string[]; messageId?: string | null } | null;
  gaveUp?: string | null;
  // What this build's model calls have cost so far, in US dollars.
  costUsd?: number;
}

export function emptyHeal(): HealLog {
  return { rounds: [], since: 0, lines: [], question: null, gaveUp: null, costUsd: 0 };
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
  // The payees it may pay, by name or address, as a renter saves them;
  // unset, it may pay anyone (an older sample).
  payees?: string[];
  // How the owner answers a payment's own approval: yes unless "no" (the
  // self test's run where the owner says no).
  approve?: "yes" | "no";
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
  // Side steps that didn't go through (runner.ts isSideStep), one plain
  // sentence each: the job is done with a note.
  notes?: string[];
  // It sent, wrote or paid something in this run.
  acted?: boolean;
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
  // outcome: done, but skipped for empty input, or with a note.
  | { type: "end"; status: "done" | "failed" | "stopped"; reason: string; steps: number; ms: number; costUsd: number; memory: Record<string, unknown>; sheets: BenchData["sheets"]; outcome?: "skipped" | "noted" };
