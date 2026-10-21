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
      name: text("a short name for the agent, or empty if not clear yet"),
      kind: { type: "string", enum: ["watcher", "digest", "helper", "none"] },
      watches: text("what it keeps an eye on, or empty"),
      when: text("what makes it act, or empty"),
      how: text("how often it checks, or empty"),
      tells: text("where it reaches the person, or empty"),
      asking: { type: "string", enum: ["watches", "when", "how", "tells", "none"] },
      choices: { type: "array", items: { type: "string" }, description: "up to 4 short answers to the next question" },
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

// The plan's only input, as one user message.
export function planInput({ stored: so, previous, said }: PlanInput): string {
  const sofar = { name: so?.name ?? "", kind: so?.kind ?? "none", watches: so?.watches ?? "", when: so?.when ?? "", how: so?.how ?? "", tells: so?.tells ?? "" };
  const asked = previous ? `\n\nThe last reply: ${previous}` : "";
  return `Sketch so far: ${JSON.stringify(sofar)}${asked}\n\nThe person said: ${said}`;
}

export async function planTurn(input: PlanInput, opts: { config: ModelConfig; signal: AbortSignal; fetchImpl?: typeof fetch }): Promise<Plan> {
  const messages: ChatMessage[] = [
    { role: "system", content: PLAN_PROMPT },
    { role: "user", content: planInput(input) },
  ];
  const result = await completeJson(messages, { ...opts, schema: SKETCH_SCHEMA, maxTokens: opts.config.planMaxTokens });
  return { sketch: parseSketchBlock(result.content), result };
}
