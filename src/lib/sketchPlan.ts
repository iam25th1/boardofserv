import "server-only";
import { completeJson, type ChatMessage, type JsonResult, type ModelConfig } from "./model";
import { parseSketchBlock, type ParsedSketch } from "./sketchBlock";
import { PLAN_PROMPT } from "./systemPrompt";
import type { SketchDTO } from "./types";

// The first call of a turn: before the reply, read what the person just said
// into the agent sketch, and decide what the reply asks next and which answers
// the person will see as buttons. The reply only phrases that question, so the
// question and the buttons match. The plan sees the stored sketch, the reply
// the person is answering (if any) and their new message, nothing else.
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
    required: ["name", "kind", "watches", "when", "how", "tells", "asking", "choices"],
    properties: {
      name: text("short agent name"),
      kind: { type: "string", enum: ["watcher", "digest", "helper", "none"], description: "watcher reacts, digest summarizes, helper answers" },
      watches: text("what it monitors"),
      when: text("what triggers it"),
      how: text("how often it checks"),
      tells: text("where it notifies"),
      asking: { type: "string", enum: ["watches", "when", "how", "tells", "none"], description: "most important empty field to ask next; none if all set" },
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
  const known = Object.fromEntries((["name", "kind", "watches", "when", "how", "tells"] as const).flatMap((k) => (stored?.[k] ? [[k, stored[k]]] : [])));
  const asked = previous ? `\nLast reply: ${previous}` : "";
  return `Sketch: ${JSON.stringify(known)}${asked}\nPerson: ${said}`;
}

export async function planTurn(input: PlanInput, opts: { config: ModelConfig; signal: AbortSignal; fetchImpl?: typeof fetch }): Promise<Plan> {
  const messages: ChatMessage[] = [
    { role: "system", content: PLAN_PROMPT },
    { role: "user", content: planInput(input) },
  ];
  const result = await completeJson(messages, { ...opts, schema: SKETCH_SCHEMA, maxTokens: opts.config.planMaxTokens });
  return { sketch: parseSketchBlock(result.content), result };
}
