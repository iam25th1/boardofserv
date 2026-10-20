import "server-only";

// The model behind the chat: an ordered list of OpenAI-compatible providers.
// SERV Reasoning comes first, the backup named by FALLBACK_* second. A reply
// streams from the first provider that answers.
//
// Before the first token, a network error, a timeout, a 5xx, a 429, a 402 or
// an empty reply moves on to the next provider. Each provider is tried once
// per reply, so a 402 (out of credit) is never retried. Any other refusal (a
// 400 or a 401, say) stops there: the next provider would refuse the same
// request. After the first token nothing is retried; the result says it was
// cut off and the route ends the reply with CUT_OFF_SUFFIX.
//
// SERV rules, proven in servpit: every request carries a system message, a
// json schema carries no numeric range keywords, and no paid add-on is
// switched on (no serv_* tools and no model suffix, so no Prompt Guard,
// Shadow Agent or Kronos).

import { SYSTEM_PROMPT } from "./systemPrompt";

export type ChatRole = "system" | "user" | "assistant";
export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export const SERV_BASE_URL = "https://inference-api.openserv.ai/v1";
export const SERV_MODEL = "claude-haiku-4.5";
export const SERV_LABEL = "SERV Reasoning";
const DEFAULT_FIRST_TOKEN_TIMEOUT_MS = 20_000;
// Usage limits: the system prompt plus the last 12 messages go out (older
// history is dropped, not summarised), and a reply is capped at 700 tokens.
const DEFAULT_HISTORY_MESSAGES = 12;
const DEFAULT_MAX_TOKENS = 700;
// The sketch extraction answers in a small JSON object.
const DEFAULT_EXTRACT_MAX_TOKENS = 200;

// Appended to a reply that broke off mid-stream. Stored with the reply so it
// survives a reload, and stripped again before the history goes back to a model.
export const CUT_OFF_NOTE = "Reply cut off. Try again.";
export const CUT_OFF_SUFFIX = `\n\n_${CUT_OFF_NOTE}_`;

export const NO_MODEL_ERROR =
  "No model is set up for this chat, so there is no reply. Add SERV_API_KEY to the server environment and restart.";

export type ProviderId = "serv" | "fallback" | "demo";

export interface Provider {
  id: "serv" | "fallback";
  label: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  // SERV reports usage in its last chunk unasked. OpenAI-style endpoints
  // only do when asked.
  askForUsage: boolean;
}

export interface ModelConfig {
  providers: Provider[];
  firstTokenTimeoutMs: number;
  historyMessages: number;
  maxTokens: number;
  extractMaxTokens: number;
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

// Providers in the order they are tried. Keys come from the environment only.
export function modelConfig(env: Record<string, string | undefined> = process.env): ModelConfig {
  const providers: Provider[] = [];
  if (env.SERV_API_KEY) {
    providers.push({ id: "serv", label: SERV_LABEL, baseUrl: SERV_BASE_URL, apiKey: env.SERV_API_KEY, model: SERV_MODEL, askForUsage: false });
  }
  if (env.FALLBACK_BASE_URL && env.FALLBACK_API_KEY && env.FALLBACK_MODEL) {
    providers.push({
      id: "fallback",
      label: env.FALLBACK_LABEL || env.FALLBACK_MODEL,
      baseUrl: env.FALLBACK_BASE_URL.replace(/\/+$/, ""),
      apiKey: env.FALLBACK_API_KEY,
      model: env.FALLBACK_MODEL,
      askForUsage: true,
    });
  }
  return {
    providers,
    firstTokenTimeoutMs: positiveInt(env.MODEL_FIRST_TOKEN_TIMEOUT_MS, DEFAULT_FIRST_TOKEN_TIMEOUT_MS),
    historyMessages: positiveInt(env.CHAT_HISTORY_MESSAGES, DEFAULT_HISTORY_MESSAGES),
    maxTokens: positiveInt(env.CHAT_MAX_TOKENS, DEFAULT_MAX_TOKENS),
    extractMaxTokens: positiveInt(env.SKETCH_MAX_TOKENS, DEFAULT_EXTRACT_MAX_TOKENS),
  };
}

// SERV rejects a request with no system message. Guarantee exactly one, first.
export function ensureSystemMessage(messages: ChatMessage[]): ChatMessage[] {
  const hasSystem = messages.some((m) => m.role === "system");
  return hasSystem ? messages : [{ role: "system", content: SYSTEM_PROMPT }, ...messages];
}

// SERV rejects numeric range keywords in a json schema. Strip them recursively
// so any structured request we ever send is accepted.
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

// Stored history as a model should see it: only the last `limit` messages,
// starting with one of the person's, and without our own cut-off notes.
export function contextFor(history: ChatMessage[], limit: number): ChatMessage[] {
  const recent = history.slice(-limit);
  const firstUser = recent.findIndex((m) => m.role === "user");
  return recent
    .slice(Math.max(firstUser, 0))
    .map((m) =>
      m.role === "assistant" && m.content.endsWith(CUT_OFF_SUFFIX) ? { ...m, content: m.content.slice(0, -CUT_OFF_SUFFIX.length) } : m,
    );
}

export type Failure =
  | { provider: Provider["id"]; kind: "network" | "timeout" | "stream" | "empty" }
  | { provider: Provider["id"]; kind: "status"; status: number };

export interface ReplyResult {
  outcome: "ok" | "fell_back" | "failed";
  // Who streamed the reply; null when nothing did.
  provider: ProviderId | null;
  model: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  firstTokenMs: number | null;
  totalMs: number;
  cutOff: boolean;
  failures: Failure[];
  // A plain message for the thread when no reply streamed at all.
  error: string | null;
}

export type ReplyEvent =
  | { type: "start"; provider: ProviderId; label: string }
  | { type: "delta"; text: string }
  | { type: "end"; result: ReplyResult };

interface Usage {
  promptTokens: number | null;
  completionTokens: number | null;
}

class ProviderFailure extends Error {
  constructor(
    readonly kind: Failure["kind"],
    readonly status?: number,
  ) {
    super(status ? `${kind} ${status}` : kind);
  }
}

function fallsBack(f: Failure): boolean {
  if (f.kind !== "status") return true;
  return f.status === 402 || f.status === 429 || f.status >= 500;
}

export function requestBody(p: Provider, messages: ChatMessage[], maxTokens: number): Record<string, unknown> {
  const body: Record<string, unknown> = { model: p.model, messages: ensureSystemMessage(messages), max_tokens: maxTokens, stream: true };
  if (p.askForUsage) body.stream_options = { include_usage: true };
  return body;
}

interface StreamChunk {
  choices?: { delta?: { content?: string | null } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
  error?: unknown;
}

// One streamed chat completion from one provider. Yields text deltas, returns
// the usage it saw, throws ProviderFailure. The timeout covers the wait for
// the first token and then any silence between chunks.
async function* attempt(
  p: Provider,
  messages: ChatMessage[],
  opts: { timeoutMs: number; maxTokens: number; signal: AbortSignal; fetchImpl: typeof fetch },
): AsyncGenerator<string, Usage> {
  const ctl = new AbortController();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timedOut = true;
      ctl.abort();
    }, opts.timeoutMs);
  };
  const onAbort = () => ctl.abort();
  opts.signal.addEventListener("abort", onAbort);
  arm();
  const usage: Usage = { promptTokens: null, completionTokens: null };
  try {
    let res: Response;
    try {
      res = await opts.fetchImpl(`${p.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "text/event-stream", authorization: `Bearer ${p.apiKey}` },
        body: JSON.stringify(requestBody(p, messages, opts.maxTokens)),
        signal: ctl.signal,
      });
    } catch {
      throw new ProviderFailure(timedOut ? "timeout" : "network");
    }
    if (!res.ok) throw new ProviderFailure("status", res.status);
    if (!res.body) throw new ProviderFailure("stream");

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch {
        throw new ProviderFailure(timedOut ? "timeout" : "network");
      }
      if (chunk.done) return usage;
      arm();
      buf += decoder.decode(chunk.value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        const t = line.trim();
        if (!t.startsWith("data:")) continue;
        const payload = t.slice(5).trim();
        if (payload === "[DONE]") return usage;
        let json: StreamChunk;
        try {
          json = JSON.parse(payload) as StreamChunk;
        } catch {
          continue;
        }
        if (json.error) throw new ProviderFailure("stream");
        if (json.usage) {
          usage.promptTokens = json.usage.prompt_tokens ?? usage.promptTokens;
          usage.completionTokens = json.usage.completion_tokens ?? usage.completionTokens;
        }
        const delta = json.choices?.[0]?.delta?.content;
        if (delta) yield delta;
      }
    }
  } finally {
    clearTimeout(timer);
    opts.signal.removeEventListener("abort", onAbort);
    // Ends the request if the reply stopped early for any reason.
    ctl.abort();
  }
}

function providerName(id: Provider["id"], first: boolean): string {
  if (id === "serv") return SERV_LABEL;
  return first ? "The backup model" : "the backup model";
}

const KIND_TEXT = { network: "could not be reached", stream: "sent a broken reply", empty: "sent an empty reply" };

function failureText(f: Failure, timeoutMs: number): string {
  if (f.kind === "timeout") return `did not answer within ${Math.round(timeoutMs / 1000)} seconds`;
  if (f.kind !== "status") return KIND_TEXT[f.kind];
  if (f.status === 402) return "is out of credit";
  if (f.status === 429) return "is busy right now (429)";
  if (f.status >= 500) return `had a server error (${f.status})`;
  return `refused the request (${f.status})`;
}

// What happened and what to do, in one or two plain sentences.
export function describeFailures(failures: Failure[], timeoutMs: number): string {
  if (failures.length === 0) return NO_MODEL_ERROR;
  const what = failures.map((f, i) => `${providerName(f.provider, i === 0)} ${failureText(f, timeoutMs)}`).join(", and ");
  let todo = "Try again in a minute.";
  if (failures.some((f) => f.kind === "status" && !fallsBack(f))) todo = "Check the model settings on the server, then try again.";
  else if (failures.some((f) => f.kind === "status" && f.status === 402)) todo = "Top up SERV credit, then try again.";
  return `${what}, so there is no reply. ${todo}`;
}

// Stream one reply through the providers in order. Never throws for a model
// failure: it always ends with an "end" event that says what happened.
export async function* streamReply(
  messages: ChatMessage[],
  opts: { config: ModelConfig; signal: AbortSignal; fetchImpl?: typeof fetch },
): AsyncGenerator<ReplyEvent> {
  const started = Date.now();
  const { config, signal } = opts;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const failures: Failure[] = [];
  const ended = (r: Partial<ReplyResult>): ReplyEvent => ({
    type: "end",
    result: {
      outcome: "failed",
      provider: null,
      model: null,
      promptTokens: null,
      completionTokens: null,
      firstTokenMs: null,
      cutOff: false,
      error: null,
      ...r,
      failures,
      totalMs: Date.now() - started,
    },
  });

  if (config.providers.length === 0) {
    // Development only, and only with no model set up. Production builds drop
    // this branch and the demo module with it (see demo-unreachable.test.ts).
    if (process.env.NODE_ENV === "development") {
      const { DEMO_LABEL, demoStream } = await import("./demoModel");
      yield { type: "start", provider: "demo", label: DEMO_LABEL };
      const firstTokenMs = Date.now() - started;
      for await (const text of demoStream(signal)) yield { type: "delta", text };
      yield ended({ outcome: "ok", provider: "demo", model: "demo", firstTokenMs });
      return;
    }
    yield ended({ error: NO_MODEL_ERROR });
    return;
  }

  for (const p of config.providers) {
    let firstTokenMs: number | null = null;
    const gen = attempt(p, messages, { timeoutMs: config.firstTokenTimeoutMs, maxTokens: config.maxTokens, signal, fetchImpl });
    try {
      for (;;) {
        const step = await gen.next();
        if (step.done) {
          if (firstTokenMs === null) throw new ProviderFailure("empty");
          yield ended({ outcome: failures.length ? "fell_back" : "ok", provider: p.id, model: p.model, firstTokenMs, ...step.value });
          return;
        }
        if (firstTokenMs === null) {
          firstTokenMs = Date.now() - started;
          yield { type: "start", provider: p.id, label: p.label };
        }
        yield { type: "delta", text: step.value };
      }
    } catch (err) {
      const failure: Failure =
        err instanceof ProviderFailure && err.kind === "status"
          ? { provider: p.id, kind: "status", status: err.status ?? 0 }
          : { provider: p.id, kind: err instanceof ProviderFailure && err.kind !== "status" ? err.kind : "network" };
      const streamed = firstTokenMs !== null;
      if (signal.aborted) {
        // The person pressed stop. Keep what arrived, try nothing else.
        yield ended(streamed ? { outcome: failures.length ? "fell_back" : "ok", provider: p.id, model: p.model, firstTokenMs } : {});
        return;
      }
      failures.push(failure);
      if (streamed) {
        yield ended({ provider: p.id, model: p.model, firstTokenMs, cutOff: true });
        return;
      }
      if (!fallsBack(failure)) break;
    } finally {
      await gen.return({ promptTokens: null, completionTokens: null });
    }
  }
  yield ended({ error: describeFailures(failures, config.firstTokenTimeoutMs) });
}

export interface JsonResult {
  // The JSON text the model returned, or null when no provider answered.
  content: string | null;
  outcome: "ok" | "fell_back" | "failed";
  provider: Provider["id"] | null;
  model: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  totalMs: number;
  failures: Failure[];
}

export function jsonRequestBody(
  p: Provider,
  messages: ChatMessage[],
  schema: { name: string; schema: Record<string, unknown> },
  maxTokens: number,
): Record<string, unknown> {
  return {
    model: p.model,
    messages: ensureSystemMessage(messages),
    max_tokens: maxTokens,
    stream: false,
    response_format: { type: "json_schema", json_schema: { name: schema.name, strict: true, schema: sanitizeJsonSchema(schema.schema) } },
  };
}

// One non-streaming call for structured JSON, through the same providers in
// the same order with the same fallback rules as a reply. Never throws for a
// model failure: the result says what happened.
export async function completeJson(
  messages: ChatMessage[],
  opts: {
    config: ModelConfig;
    schema: { name: string; schema: Record<string, unknown> };
    maxTokens: number;
    signal: AbortSignal;
    fetchImpl?: typeof fetch;
  },
): Promise<JsonResult> {
  const started = Date.now();
  const fetchImpl = opts.fetchImpl ?? fetch;
  const failures: Failure[] = [];
  const done = (r: Partial<JsonResult>): JsonResult => ({
    content: null,
    outcome: "failed",
    provider: null,
    model: null,
    promptTokens: null,
    completionTokens: null,
    ...r,
    failures,
    totalMs: Date.now() - started,
  });

  for (const p of opts.config.providers) {
    const ctl = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ctl.abort();
    }, opts.config.firstTokenTimeoutMs);
    const onAbort = () => ctl.abort();
    opts.signal.addEventListener("abort", onAbort);
    let failure: Failure;
    try {
      const res = await fetchImpl(`${p.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json", authorization: `Bearer ${p.apiKey}` },
        body: JSON.stringify(jsonRequestBody(p, messages, opts.schema, opts.maxTokens)),
        signal: ctl.signal,
      });
      if (!res.ok) {
        failure = { provider: p.id, kind: "status", status: res.status };
      } else {
        const body = (await res.json()) as {
          choices?: { message?: { content?: string | null } }[];
          usage?: { prompt_tokens?: number; completion_tokens?: number };
        };
        const content = body.choices?.[0]?.message?.content;
        if (content) {
          return done({
            content,
            outcome: failures.length ? "fell_back" : "ok",
            provider: p.id,
            model: p.model,
            promptTokens: body.usage?.prompt_tokens ?? null,
            completionTokens: body.usage?.completion_tokens ?? null,
          });
        }
        failure = { provider: p.id, kind: "empty" };
      }
    } catch {
      failure = { provider: p.id, kind: timedOut ? "timeout" : "network" };
    } finally {
      clearTimeout(timer);
      opts.signal.removeEventListener("abort", onAbort);
    }
    if (opts.signal.aborted) return done({});
    failures.push(failure);
    if (!fallsBack(failure)) break;
  }
  return done({});
}

