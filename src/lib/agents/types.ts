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
  updatedAt: string;
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
