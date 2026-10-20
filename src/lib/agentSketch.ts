// The agent being sketched in a conversation, as the sketch dock shows it:
// what it watches, when it acts, how often it checks, where it reaches you.
// Nothing produces this from a real conversation yet; that is the next brief.
// Until then the dock only appears in development with ?sketch=demo.

export type FieldStatus = "empty" | "set" | "waiting";

export interface SketchField {
  value: string;
  status: FieldStatus;
}

export interface AgentSketch {
  name: string;
  watches: SketchField;
  when: SketchField;
  how: SketchField;
  tells: SketchField;
  // Plain text; **double asterisks** mark the figure to emphasise.
  cost: string | null;
  live: boolean;
}

export type FieldKey = "watches" | "when" | "how" | "tells";
export const FIELD_KEYS: FieldKey[] = ["watches", "when", "how", "tells"];

export const FIELD_LABELS: Record<FieldKey, string> = {
  watches: "Keeps an eye on",
  when: "Acts when",
  how: "Checks",
  tells: "Reaches you on",
};

// The three-node diagram: watch, decide, tell you. "ask" is a node waiting on
// an answer from the user (drawn dashed and turning).
export type NodeState = "off" | "on" | "ask";
export type NodeKey = "watch" | "decide" | "tell";
export const NODE_KEYS: NodeKey[] = ["watch", "decide", "tell"];

function nodeOf(...fields: SketchField[]): NodeState {
  if (fields.every((f) => f.status === "set")) return "on";
  if (fields.some((f) => f.status === "waiting")) return "ask";
  return "off";
}

export function nodesOf(s: AgentSketch): Record<NodeKey, NodeState> {
  return { watch: nodeOf(s.watches), decide: nodeOf(s.when, s.how), tell: nodeOf(s.tells) };
}

// A link is drawn once both of its ends are filled.
export function linksOf(nodes: Record<NodeKey, NodeState>): [boolean, boolean] {
  return [nodes.watch === "on" && nodes.decide === "on", nodes.decide === "on" && nodes.tell === "on"];
}

export function isReady(s: AgentSketch): boolean {
  return NODE_KEYS.every((k) => nodesOf(s)[k] === "on");
}

export function statusLine(s: AgentSketch, paused: boolean): string {
  if (s.live) return "Running on your credit";
  if (paused) return "Paused";
  if (isReady(s)) return "Ready. Flip the switch to start it";
  if (FIELD_KEYS.some((k) => s[k].status === "waiting")) return "Waiting on one answer from you";
  return "Sketching";
}
