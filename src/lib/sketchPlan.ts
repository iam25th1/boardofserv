import "server-only";
import { completeJson, type ChatMessage, type JsonResult, type ModelConfig } from "./model";
import { parseSketchBlock, type ParsedSketch } from "./sketchBlock";
import { PLAN_KINDS, SKETCH_FIELDS } from "./sketchFields";
import { PLAN_PROMPT } from "./systemPrompt";
import type { SketchDTO } from "./types";

// The first call of a turn: before the reply, read what the person just said
// into the agent sketch, and decide what the reply asks next and which answers
// the person will see as buttons. The reply only phrases that question, so the
// question and the buttons match. The plan sees the stored sketch, the reply
// the person is answering (if any) and their new message, nothing else.
//
// An agent's interview fields ride in the same schema, so the turn that
// first says "every morning, check my stock sheet" keeps what it said.
//
// The schema sticks to what SERV is known to accept: strings, a string enum
// and an array of strings, every property required, nothing extra. Unknown is
// an empty string, and "none" for kind and asking, rather than a nullable type
// SERV has not been seen to accept. parseSketchBlock turns both into null and
// does the trimming the schema cannot (no minItems or maxItems, no numeric
// ranges): at most 4 choices, and every field cut to a short length.

const text = (description: string) => ({ type: "string", description });

export const SKETCH_SCHEMA = {
  name: "agent_sketch",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["name", "kind", "watches", "when", "how", "tells", "takes", "does", "gives", "wakes", "looks", "handles", "finish", "asks", "setup", "remembers", "asking", "choices"],
    properties: {
      name: text("short agent name"),
      kind: {
        type: "string",
        enum: [...PLAN_KINDS, "none"],
        description:
          "answer (the default) replies once to what it is given; agent runs on its own: on a schedule, watching data or acting over time. Use only answer or agent",
      },
      watches: text("what it monitors"),
      when: text("what triggers it"),
      how: text("how often it checks"),
      tells: text("where it notifies"),
      takes: text("answer: what the user gives it"),
      does: text("answer: what it does, one line"),
      gives: text("answer: what comes back"),
      wakes: text("agent: what wakes it up (a schedule, a value it checks, a message)"),
      looks: text("agent: where it looks (sheets, sites, messages)"),
      handles: text("agent: what it does with what it finds"),
      finish: text("agent: what counts as done"),
      asks: text("agent: what it must never do without asking the owner"),
      setup: text("agent: what the owner sets up for it (accounts, sheets, limits)"),
      remembers: text("agent: what it remembers between jobs"),
      asking: {
        type: "string",
        enum: [...SKETCH_FIELDS, "none"],
        description:
          "most important empty field to ask next: takes, does, gives for answer; wakes, looks, handles, finish, asks, setup, remembers for agent; none if all set",
      },
      choices: { type: "array", items: { type: "string" }, description: "up to 4 short answers to that question" },
    },
  },
};

export interface Plan {
  // The sketch read from the turn, with the next question and its buttons, or
  // null when no provider answered or the answer did not validate. Either way
  // the reply still runs.
  sketch: ParsedSketch | null;
  result: JsonResult;
}

export interface PlanInput {
  stored: SketchDTO | null;
  // The reply the person is answering, or null on a conversation's first turn.
  previous: string | null;
  said: string;
}

// The plan's only input, as one user message: the known fields as compact
// JSON ({} on a first turn), the reply being answered and the new message.
export function planInput({ stored, previous, said }: PlanInput): string {
  const known = Object.fromEntries((["name", "kind", ...SKETCH_FIELDS] as const).flatMap((k) => (stored?.[k] ? [[k, stored[k]]] : [])));
  const asked = previous ? `\nLast reply: ${previous}` : "";
  return `Sketch: ${JSON.stringify(known)}${asked}\nPerson: ${said}`;
}

export async function planTurn(input: PlanInput, opts: { config: ModelConfig; signal: AbortSignal; fetchImpl?: typeof fetch }): Promise<Plan> {
  const messages: ChatMessage[] = [
    { role: "system", content: PLAN_PROMPT },
    { role: "user", content: planInput(input) },
  ];
  const result = await completeJson(messages, { ...opts, purpose: "sketch", schema: SKETCH_SCHEMA, maxTokens: opts.config.planMaxTokens });
  return { sketch: parseSketchBlock(result.content), result };
}
