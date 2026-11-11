import type { SketchDTO } from "./types";

// Which fields describe which kind of sketch. Shared by the server (the plan,
// the reply's prompt) and the dock, so it carries no dependencies.
//
// An "answer" helper is asked something once and answers once: what it
// takes, what it does with it and what it gives back. An "agent" runs on its
// own, and its interview covers what wakes it up, where it looks, what it
// does with what it finds, what counts as done, what it must never do
// without asking, what the owner sets up and what it should remember; SERV
// then plans it into steps (see agents/). Watchers, digests and helpers are
// the older agent kinds, described by what they watch, when they act, how
// often they check and where they tell you; new ones are planned as agents.

export const SKETCH_KINDS = ["watcher", "digest", "helper", "answer", "agent"] as const;
export const AGENT_FIELDS = ["watches", "when", "how", "tells"] as const;
export const ANSWER_FIELDS = ["takes", "does", "gives"] as const;
export const INTERVIEW_FIELDS = ["wakes", "looks", "handles", "finish", "asks", "setup", "remembers"] as const;
// What the chat asks about an agent: only what it needs to understand the
// job, which is when it runs, where it looks and what it does with what it
// finds. What counts as done and what it must ask first are kept when the
// maker says them, never asked: a first-time maker can't answer them, and
// asking invites made-up questions to the owner. What the owner sets up
// (accounts, sheets, Telegram) is collected at Connect, never in the chat,
// and what it remembers is the planner's to work out.
export const ASKED_FIELDS = ["wakes", "looks", "handles"] as const;

// The chat has what it needs to make the agent, and Make it is offered:
// when it runs and what it does. Where it looks is asked, but an agent that
// reads nothing (a morning line sent on Telegram) has no answer to give.
export function describedEnough(sketch: Pick<SketchDTO, "kind" | "wakes" | "looks" | "handles"> | null): boolean {
  return Boolean(sketch && sketch.kind === "agent" && sketch.wakes && sketch.handles);
}
export const SKETCH_FIELDS = [...AGENT_FIELDS, ...ANSWER_FIELDS, ...INTERVIEW_FIELDS] as const;

export type SketchKind = (typeof SKETCH_KINDS)[number];
export type SketchFieldKey = (typeof SKETCH_FIELDS)[number];

// The fields a sketch of this kind is described by. Until the kind is known,
// it is sketched as an agent.
export function fieldsOf(kind: SketchDTO["kind"]): readonly SketchFieldKey[] {
  if (kind === "answer") return ANSWER_FIELDS;
  if (kind === "agent") return ASKED_FIELDS;
  return AGENT_FIELDS;
}

// An agent's interview, as the dock and the planner name its answers.
export const INTERVIEW_LABELS: Record<(typeof INTERVIEW_FIELDS)[number], string> = {
  wakes: "Wakes up",
  looks: "Looks at",
  handles: "With what it finds",
  finish: "Done when",
  asks: "Asks you before",
  setup: "You set up",
  remembers: "Remembers",
};

// The kinds the plan may choose: the older agent kinds stay for sketches
// that have them, but new ones are planned as agents.
export const PLAN_KINDS = ["answer", "agent"] as const;

// The most a published helper's one line about it may hold, on the publish
// sheet and on the server. The board and the helper page show all of it.
export const DESCRIPTION_MAX = 160;
