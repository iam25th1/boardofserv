import "server-only";
import { completeJson, type ChatMessage, type JsonResult, type ModelConfig } from "./model";
import { parseSketchBlock, type ParsedSketch } from "./sketchBlock";
import { EXTRACT_PROMPT } from "./systemPrompt";
import type { SketchDTO } from "./types";

// The second call of a turn: after the reply has streamed, read the agent
// sketch out of the conversation as strict JSON. The reply itself writes no
// JSON, so it can stay a plain conversation.
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
      choices: { type: "array", items: { type: "string" }, description: "up to 4 short answers to the reply's question" },
    },
  },
};

export interface Extraction {
  // The sketch read from the turn, or null when no provider answered or the
  // answer did not validate. Either way the stored sketch stays as it was.
  sketch: ParsedSketch | null;
  result: JsonResult;
}

export async function extractSketch(
  turn: { stored: SketchDTO | null; said: string; reply: string },
  opts: { config: ModelConfig; signal: AbortSignal; fetchImpl?: typeof fetch },
): Promise<Extraction> {
  const so = turn.stored;
  const sofar = { name: so?.name ?? "", kind: so?.kind ?? "none", watches: so?.watches ?? "", when: so?.when ?? "", how: so?.how ?? "", tells: so?.tells ?? "" };
  const messages: ChatMessage[] = [
    { role: "system", content: EXTRACT_PROMPT },
    { role: "user", content: `Sketch so far: ${JSON.stringify(sofar)}\n\nThe person said: ${turn.said}\n\nThe reply: ${turn.reply}` },
  ];
  const result = await completeJson(messages, { ...opts, schema: SKETCH_SCHEMA, maxTokens: opts.config.extractMaxTokens });
  return { sketch: parseSketchBlock(result.content), result };
}
