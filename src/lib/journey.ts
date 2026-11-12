// The journey a maker takes in the chat, from describing a job to putting
// the agent to work, in six stages a first-time maker can follow:
//
// 1 Describe: the chat asks only what it needs, then offers Make it.
// 2 Steps: the steps in plain words, with Looks right and Change something.
// 3 Build: each step written and checked, one after another.
// 4 Try it: a test on a sample, told as a short story.
// 5 Connect: Telegram, sheets and the answers it needs, as simple cards.
// 6 Go live: run it for yourself, or put it on the board.
//
// Each stage is a card in the conversation (a message with a card), so
// scrolling up tells the whole story. The latest card of each stage shows
// the agent as it is now; an earlier one keeps what it showed when the
// journey moved past it (its snapshot). No dependencies: the server and the
// chat share it.

export const STAGES = ["describe", "steps", "build", "try", "connect", "live"] as const;
export type Stage = (typeof STAGES)[number];

export const STAGE_NAMES: Record<Stage, string> = {
  describe: "Describe",
  steps: "Steps",
  build: "Build",
  try: "Try it",
  connect: "Connect",
  live: "Go live",
};

// One step as the maker reads it, set in under the step it repeats for.
export interface PlainLine {
  id: string;
  text: string;
  depth: number;
}

// What a card showed once the journey moved past it.
export interface CardSnapshot {
  lines?: PlainLine[];
  // A test's result.
  status?: "passed" | "failed";
  story?: string;
  problem?: string | null;
  // What it said at the end, in one line ("Built and checked").
  note?: string;
  // The lines it said while it healed itself on this card.
  healed?: { text: string; tone: HealTone }[];
}

// How a line of a build healing itself reads: working on it, fixed, asking
// the maker, or stopped.
export type HealTone = "working" | "fixed" | "asked" | "stopped";

// The answers saved at Connect, as the guided setup holds them, and who it
// pays when it pays someone.
export interface ConnectAnswers {
  settings: Record<string, unknown>;
  rules: Record<string, string>;
  timezone: string;
  schedule?: { at: string | null; day: number | null; days?: number[] | null; interval?: number | null } | null;
  payee?: { label: string; address: string } | null;
}

export interface JourneyCard {
  stage: Stage;
  agentId?: string;
  // When it came in: the lines a build says while it heals belong to the
  // card that was latest when they were said.
  at?: string;
  snapshot?: CardSnapshot;
  // Connect: the answers, once saved.
  answers?: ConnectAnswers;
  // Go live: running for the maker (its installation), and on the board.
  live?: { installationId?: string; listed?: boolean };
}

// The stage the journey is at: the latest card's, or Describe before any.
export function stageOf(cards: (JourneyCard | null | undefined)[]): Stage {
  const last = [...cards].reverse().find((c): c is JourneyCard => Boolean(c));
  return last?.stage ?? "describe";
}

// Whether a stage is done, ahead or the one it is at, for the tracker.
export function stageState(stage: Stage, at: Stage, live = false): "done" | "now" | "ahead" {
  const i = STAGES.indexOf(stage);
  const j = STAGES.indexOf(at);
  if (i < j || (live && i === j)) return "done";
  return i === j ? "now" : "ahead";
}
