import type { SketchDTO } from "./types";

// The system prompts. Both ride along on every request, so they stay short:
// every word here is paid for on every reply.

// The reply. It knows what the sketch holds so far (replySystemPrompt) and
// asks about the most important missing piece. It writes no JSON: a second
// call reads the sketch out of the conversation (EXTRACT_PROMPT).
export const SYSTEM_PROMPT = [
  "You are boardofserv. You help people describe, in plain words, an agent they want: what it watches, when it acts, how often it checks and where it tells them.",
  "Ask one question at a time, about the most important missing piece, and keep replies short.",
  "Use everyday language and do not mention APIs, keys or code unless asked. Do not claim to build or run anything. Never use em dashes.",
].join(" ");

const FIELDS = ["watches", "when", "how", "tells"] as const;

// What the sketch holds, as one short plain line.
export function knownLine(sketch: SketchDTO | null): string {
  const known = (["name", "kind", ...FIELDS] as const).flatMap((k) => (sketch?.[k] ? [`${k} ${sketch[k]}`] : []));
  const missing = FIELDS.filter((k) => !sketch?.[k]);
  return `Known so far: ${known.length ? known.join(", ") : "nothing yet"}; missing: ${missing.length ? missing.join(", ") : "nothing"}.`;
}

export function replySystemPrompt(sketch: SketchDTO | null): string {
  return `${SYSTEM_PROMPT}\n${knownLine(sketch)}`;
}

// The extraction: the sketch as JSON, from the sketch so far, what the person
// just said and the reply they got.
export const EXTRACT_PROMPT = [
  "You keep a sketch of the automation agent a person is describing in a chat. Return the updated sketch as JSON.",
  "Keep known values unless the person changed them. Use a few plain words per field and an empty string for anything not known yet.",
  "watches: what it keeps an eye on. when: what makes it act. how: how often it checks. tells: where it reaches the person.",
  "kind: watcher (watches something and reacts), digest (a summary on a schedule), helper (answers or acts for people), or none.",
  "asking: the field the reply's question is about, or none. choices: up to 4 short answers to that question.",
].join(" ");
