import { ANSWER_FIELDS, AGENT_FIELDS } from "./sketchFields";
import type { SketchDTO } from "./types";

// The agent being sketched in a conversation, as the sketch dock shows it.
// An agent: what it watches, when it acts, how often it checks, where it
// reaches you. An answer helper: what it takes, what it does, what it gives
// back. It comes from the stored sketch (sketchFromDTO). In development,
// ?sketch=demo and ?sketch=ready show fixtures instead.

export type FieldStatus = "empty" | "set" | "waiting";

export interface SketchField {
  value: string;
  status: FieldStatus;
}

export interface AgentSketch {
  name: string;
  // "answer" draws takes / does / gives; anything else watch / decide / tell.
  kind: SketchDTO["kind"];
  watches: SketchField;
  when: SketchField;
  how: SketchField;
  tells: SketchField;
  takes: SketchField;
  does: SketchField;
  gives: SketchField;
  // Plain text; **double asterisks** mark the figure to emphasise.
  cost: string | null;
  live: boolean;
}

// The three-node dock's fields: an agent's interview has a dock of its own
// (AgentDock).
export type FieldKey = (typeof AGENT_FIELDS)[number] | (typeof ANSWER_FIELDS)[number];
export const FIELD_KEYS: FieldKey[] = [...AGENT_FIELDS];
export const ANSWER_FIELD_KEYS: FieldKey[] = [...ANSWER_FIELDS];

export const FIELD_LABELS: Record<FieldKey, string> = {
  watches: "Keeps an eye on",
  when: "Acts when",
  how: "Checks",
  tells: "Reaches you on",
  takes: "Takes",
  does: "Does",
  gives: "Gives back",
};

// The fields the dock lists for this sketch.
export function fieldKeysOf(s: AgentSketch): FieldKey[] {
  return s.kind === "answer" ? ANSWER_FIELD_KEYS : FIELD_KEYS;
}

// The three-node diagram: watch, decide, tell you for an agent; takes, does,
// gives for an answer helper. "ask" is a node waiting on an answer from the
// user (drawn dashed and turning).
export type NodeState = "off" | "on" | "ask";
export type NodeKey = "watch" | "decide" | "tell" | "take" | "do" | "give";
export const NODE_KEYS: NodeKey[] = ["watch", "decide", "tell"];
export const ANSWER_NODE_KEYS: NodeKey[] = ["take", "do", "give"];

export function nodeKeysOf(s: AgentSketch): NodeKey[] {
  return s.kind === "answer" ? ANSWER_NODE_KEYS : NODE_KEYS;
}

function nodeOf(...fields: SketchField[]): NodeState {
  if (fields.every((f) => f.status === "set")) return "on";
  if (fields.some((f) => f.status === "waiting")) return "ask";
  return "off";
}

// Each node's state, in drawing order.
export function nodesOf(s: AgentSketch): Partial<Record<NodeKey, NodeState>> {
  if (s.kind === "answer") return { take: nodeOf(s.takes), do: nodeOf(s.does), give: nodeOf(s.gives) };
  return { watch: nodeOf(s.watches), decide: nodeOf(s.when, s.how), tell: nodeOf(s.tells) };
}

// A link is drawn once both of its ends are filled.
export function linksOf(nodes: Partial<Record<NodeKey, NodeState>>): [boolean, boolean] {
  const [a, b, c] = Object.values(nodes);
  return [a === "on" && b === "on", b === "on" && c === "on"];
}

export function isReady(s: AgentSketch): boolean {
  return Object.values(nodesOf(s)).every((n) => n === "on");
}

// The dock's view of a stored sketch. The field the latest reply asks about
// is waiting on the person; a field with a value is set. There is no cost
// until agents can run.
export function sketchFromDTO(d: SketchDTO): AgentSketch {
  const field = (k: FieldKey): SketchField => ({
    value: d[k] ?? "",
    status: d.asking === k ? "waiting" : d[k] ? "set" : "empty",
  });
  return {
    name: d.name ?? "",
    kind: d.kind,
    watches: field("watches"),
    when: field("when"),
    how: field("how"),
    tells: field("tells"),
    takes: field("takes"),
    does: field("does"),
    gives: field("gives"),
    cost: null,
    live: d.live,
  };
}

// canSwitch is false until agents can run, so a ready sketch says so rather
// than offering a switch that would only pretend. A ready answer helper is
// published instead of switched on.
export function statusLine(s: AgentSketch, paused: boolean, canSwitch = false, published = false): string {
  if (s.live) return "Running on your credit";
  if (paused) return "Paused";
  if (s.kind === "answer" && published) return "On the board";
  if (isReady(s) && s.kind === "answer") return "Ready to publish";
  if (isReady(s)) return canSwitch ? "Ready. Flip the switch to start it" : "Ready. Switching on comes in the next update.";
  if (fieldKeysOf(s).some((k) => s[k].status === "waiting")) return "Waiting on one answer from you";
  return "Sketching";
}
