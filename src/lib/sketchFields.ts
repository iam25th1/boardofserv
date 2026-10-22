import type { SketchDTO } from "./types";

// Which fields describe which kind of sketch. Shared by the server (the plan,
// the reply's prompt) and the dock, so it carries no dependencies.
//
// Most kinds are agents that run on their own: what they watch, when they act,
// how often they check and where they tell you. An "answer" helper is asked
// something once and answers once: what it takes, what it does with it and
// what it gives back.

export const SKETCH_KINDS = ["watcher", "digest", "helper", "answer"] as const;
export const AGENT_FIELDS = ["watches", "when", "how", "tells"] as const;
export const ANSWER_FIELDS = ["takes", "does", "gives"] as const;
export const SKETCH_FIELDS = [...AGENT_FIELDS, ...ANSWER_FIELDS] as const;

export type SketchKind = (typeof SKETCH_KINDS)[number];
export type SketchFieldKey = (typeof SKETCH_FIELDS)[number];

// The fields a sketch of this kind is described by. Until the kind is known,
// it is sketched as an agent.
export function fieldsOf(kind: SketchDTO["kind"]): readonly SketchFieldKey[] {
  return kind === "answer" ? ANSWER_FIELDS : AGENT_FIELDS;
}
