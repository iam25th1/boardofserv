import "server-only";
// The model behind the chat. Replies come from SERV Reasoning with no features
// switched on (no Shadow Agent, no Prompt Guard: a plain conversation does not
// need them and they add seconds). On a 402, a timeout or any error we fall
// back to an external model named in config, and every reply records which
// model actually answered.
//
// Two SERV rules from ~/openserv-probe/FINDINGS.md and the brief are respected
// here: SERV rejects a request with no system message, and it rejects numeric
// range keywords in a json schema.

const RUNTIME = process.env.OPENSERV_RUNTIME_URL ?? "https://agents.openserv.ai";
const SERV_TIMEOUT_MS = 30_000;

export type ChatRole = "system" | "user" | "assistant";
export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export const SYSTEM_PROMPT =
  "You are boardofserv, a friendly guide that helps people build automation agents on OpenServ by describing them in plain English. " +
  "In this first version you do not build anything yet. Listen to what the person wants to automate, ask one or two clarifying questions, " +
  "and describe in plain words what their agent would do once building is switched on. Keep answers short and concrete. Never mention APIs, " +
  "keys or code unless the person asks. Write in sentence case with no em dashes.";

export interface ServReply {
  source: "serv" | "fallback";
  label: string;
  stream: AsyncIterable<string>;
}

// SERV rejects a request with no system message. Guarantee exactly one, first.
export function ensureSystemMessage(messages: ChatMessage[]): ChatMessage[] {
  const hasSystem = messages.some((m) => m.role === "system");
  return hasSystem ? messages : [{ role: "system", content: SYSTEM_PROMPT }, ...messages];
}

// SERV rejects numeric range keywords in a json schema. Strip them recursively
// so any structured request we ever send is accepted. Exported for its test.
const RANGE_KEYWORDS = new Set([
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minItems",
  "maxItems",
  "minLength",
  "maxLength",
]);

export function sanitizeJsonSchema<T>(schema: T): T {
  if (Array.isArray(schema)) return schema.map((x) => sanitizeJsonSchema(x)) as unknown as T;
  if (schema && typeof schema === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(schema)) {
      if (RANGE_KEYWORDS.has(k)) continue;
      out[k] = sanitizeJsonSchema(v);
    }
    return out as T;
  }
  return schema;
}

// SERV Reasoning: runtime-delegated generation. Non-streaming (returns text),
// which we present as a stream at the route. Throws on 402, timeout or error so
// the caller can fall back.
async function servGenerate(messages: ChatMessage[], apiKey: string, signal: AbortSignal): Promise<string> {
  const withSystem = ensureSystemMessage(messages);
  const last = [...withSystem].reverse().find((m) => m.role === "user");
  const timeout = AbortSignal.timeout(SERV_TIMEOUT_MS);
  const composite = AbortSignal.any([signal, timeout]);
  const res = await fetch(`${RUNTIME}/runtime/generate`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json", "x-openserv-key": apiKey },
    body: JSON.stringify({
      prompt: last?.content ?? "",
      messages: withSystem,
      action: { type: "chat" },
    }),
    signal: composite,
  });
  if (res.status === 402) throw new Error("serv-402");
  if (!res.ok) throw new Error(`serv-${res.status}`);
  const body = (await res.json()) as { text?: string; object?: unknown };
  if (typeof body.text !== "string" || body.text.length === 0) throw new Error("serv-empty");
  return body.text;
}

// Turn a finished string into a readable stream of small chunks, so a SERV
// reply renders progressively like the fallback. Honours the abort signal.
async function* chunkText(text: string, signal: AbortSignal): AsyncIterable<string> {
  const parts = text.match(/\S+\s*/g) ?? [text];
  for (const part of parts) {
    if (signal.aborted) return;
    yield part;
    await new Promise((r) => setTimeout(r, 12));
  }
}

// Fallback: a real streaming OpenAI-compatible chat completion.
async function* fallbackStream(messages: ChatMessage[], signal: AbortSignal): AsyncIterable<string> {
  const base = process.env.FALLBACK_BASE_URL;
  const key = process.env.FALLBACK_API_KEY;
  const model = process.env.FALLBACK_MODEL ?? "gpt-4o-mini";
  if (!base || !key) throw new Error("fallback-not-configured");
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, messages: ensureSystemMessage(messages), stream: true }),
    signal,
  });
  if (!res.ok || !res.body) throw new Error(`fallback-${res.status}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith("data:")) continue;
      const payload = t.slice(5).trim();
      if (payload === "[DONE]") return;
      try {
        const json = JSON.parse(payload) as { choices?: { delta?: { content?: string } }[] };
        const delta = json.choices?.[0]?.delta?.content;
        if (delta) yield delta;
      } catch {
        // partial json across chunks, ignore and wait for more
      }
    }
  }
}

// Try SERV, fall back on any failure, and report which model actually answered.
// A user who has not linked OpenServ has no key, so SERV is skipped and the
// fallback answers (labelled as itself, never as SERV).
export async function getReply(messages: ChatMessage[], apiKey: string | null, signal: AbortSignal): Promise<ServReply> {
  if (apiKey) {
    try {
      const text = await servGenerate(messages, apiKey, signal);
      return { source: "serv", label: "SERV", stream: chunkText(text, signal) };
    } catch (err) {
      if (signal.aborted) throw err;
    }
  }
  const label = process.env.FALLBACK_LABEL ?? process.env.FALLBACK_MODEL ?? "fallback model";
  return { source: "fallback", label, stream: fallbackStream(messages, signal) };
}