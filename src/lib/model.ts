import "server-only";

// The model behind the chat: an ordered list of OpenAI-compatible providers.
// SERV Reasoning comes first, Dolphin second (with DOLPHIN_API_KEY set), the
// backup named by FALLBACK_* last. A reply streams from the first provider
// that answers.
//
// Before the first token, a network error, a timeout, a broken stream, a
// 5xx, a 429 or an empty answer (no content, or nothing usable: for a JSON
// call, an answer that isn't JSON) is tried again on the same provider, with
// a growing pause between tries (ModelConfig.retry: 3 tries, 0.5 s then 1 s,
// unless set), and then moves on to the next provider. servpit measured SERV
// answering empty now and then, and answering on the next try. A 402 (out of
// credit) is never tried again: it moves straight on. Any other refusal (a
// 400 or a 401, say) stops there: the next provider would refuse the same
// request. After the first token nothing is retried; the result says it was
// cut off and the route ends the reply with CUT_OFF_SUFFIX.
//
// Every try is an Attempt in the result (its purpose, provider, status,
// time, tokens, which try it was and whether the answer was empty), which
// modelAttempts.ts keeps. Each call says what it is for (ModelPurpose), and
// sends the answer length limit modelLimits.ts sets for that purpose.
//
// SERV rules, proven in servpit: every request carries a system message and
// a json schema carries no numeric range keywords. The chat switches no paid
// add-on on (no serv_* tools and no model suffix, so no Prompt Guard, Shadow
// Agent or Kronos). A request may declare SERV tools of its own (a published
// helper's use declares serv_prompt_guard); they go to SERV only, since to
// any other provider they would be functions the model could call. Nothing
// here turns SERV's content filter off.

import { SYSTEM_PROMPT } from "./systemPrompt";
import { ANSWER_LIMITS, type ModelPurpose } from "./modelLimits";

export type ChatRole = "system" | "user" | "assistant";
export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export const SERV_BASE_URL = "https://inference-api.openserv.ai/v1";
export const SERV_MODEL = "claude-haiku-4.5";
export const SERV_LABEL = "SERV Reasoning";
// Dolphin's OpenAI-compatible API, as https://dphn.ai/docs/dphn-api lists it.
export const DOLPHIN_BASE_URL = "https://lighthouse.dphn.ai/run/text-v/v1";
export const DOLPHIN_MODEL = "deepseek-ai/DeepSeek-V4.1-Flash";
export const DOLPHIN_LABEL = "Dolphin";
const DEFAULT_FIRST_TOKEN_TIMEOUT_MS = 20_000;
// Usage limits: the system prompt plus the last 12 messages go out (older
// history is dropped, not summarised), and a reply is capped at its answer
// limit (modelLimits.ts).
const DEFAULT_HISTORY_MESSAGES = 12;
// Tries per provider for one call, and the pause before the second (the
// third waits twice as long).
const DEFAULT_RETRY_ATTEMPTS = 3;
const DEFAULT_RETRY_BACKOFF_MS = 500;

// Appended to a reply that broke off mid-stream. Stored with the reply so it
// survives a reload, and stripped again before the history goes back to a model.
export const CUT_OFF_NOTE = "Reply cut off. Try again.";
export const CUT_OFF_SUFFIX = `\n\n_${CUT_OFF_NOTE}_`;

// SERV's Prompt Guard, declared per request as a tool with no parameters.
export const SERV_PROMPT_GUARD = [{ type: "function", function: { name: "serv_prompt_guard" } }];

export const NO_MODEL_ERROR =
  "No model is set up for this chat, so there is no reply. Add SERV_API_KEY to the server environment and restart.";

export type ProviderId = Provider["id"] | "demo";

export interface Provider {
  id: "serv" | "dolphin" | "fallback";
  label: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  // SERV reports usage in its last chunk unasked. OpenAI-style endpoints
  // only do when asked.
  askForUsage: boolean;
}

export interface RetryPolicy {
  // Tries per provider, the first included.
  attempts: number;
  // The pause before the second try; each later one waits that much longer.
  backoffMs: number;
}

export interface ModelConfig {
  providers: Provider[];
  // The providers are the person's own SERV key and nothing else.
  ownKey?: boolean;
  firstTokenTimeoutMs: number;
  historyMessages: number;
  maxTokens: number;
  planMaxTokens: number;
  // Unset: DEFAULT_RETRY_ATTEMPTS tries, DEFAULT_RETRY_BACKOFF_MS apart.
  retry?: RetryPolicy;
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

// Providers in the order they are tried. Keys come from the environment,
// except a person's own SERV key: with one, their calls go to SERV on it and
// nowhere else, so nothing of theirs ever runs on the operator's keys.
export function modelConfig(env: Record<string, string | undefined> = process.env, own: { servKey?: string | null } = {}): ModelConfig {
  const providers: Provider[] = [];
  if (own.servKey) {
    providers.push({ id: "serv", label: SERV_LABEL, baseUrl: SERV_BASE_URL, apiKey: own.servKey, model: SERV_MODEL, askForUsage: false });
  } else if (env.SERV_API_KEY) {
    providers.push({ id: "serv", label: SERV_LABEL, baseUrl: SERV_BASE_URL, apiKey: env.SERV_API_KEY, model: SERV_MODEL, askForUsage: false });
  }
  if (env.DOLPHIN_API_KEY && !own.servKey) {
    providers.push({
      id: "dolphin",
      label: DOLPHIN_LABEL,
      baseUrl: (env.DOLPHIN_BASE_URL || DOLPHIN_BASE_URL).replace(/\/+$/, ""),
      apiKey: env.DOLPHIN_API_KEY,
      model: env.DOLPHIN_MODEL || DOLPHIN_MODEL,
      askForUsage: true,
    });
  }
  if (env.FALLBACK_BASE_URL && env.FALLBACK_API_KEY && env.FALLBACK_MODEL && !own.servKey) {
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
    ownKey: Boolean(own.servKey),
    firstTokenTimeoutMs: positiveInt(env.MODEL_FIRST_TOKEN_TIMEOUT_MS, DEFAULT_FIRST_TOKEN_TIMEOUT_MS),
    historyMessages: positiveInt(env.CHAT_HISTORY_MESSAGES, DEFAULT_HISTORY_MESSAGES),
    maxTokens: positiveInt(env.CHAT_MAX_TOKENS, ANSWER_LIMITS.chat),
    planMaxTokens: positiveInt(env.SKETCH_MAX_TOKENS, ANSWER_LIMITS.sketch),
    retry: {
      attempts: positiveInt(env.MODEL_RETRY_ATTEMPTS, DEFAULT_RETRY_ATTEMPTS),
      backoffMs: nonNegativeInt(env.MODEL_RETRY_BACKOFF_MS, DEFAULT_RETRY_BACKOFF_MS),
    },
  };
}

function nonNegativeInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return raw?.trim() && Number.isInteger(n) && n >= 0 ? n : fallback;
}

export function retryPolicy(config: Pick<ModelConfig, "retry">): RetryPolicy {
  const r = config.retry;
  return { attempts: Math.max(1, Math.floor(r?.attempts ?? DEFAULT_RETRY_ATTEMPTS)), backoffMs: Math.max(0, r?.backoffMs ?? DEFAULT_RETRY_BACKOFF_MS) };
}

// What each provider's model costs, in US dollars per million tokens, for the
// spend estimate (see spend.ts). SERV's figure is the one servpit found;
// Dolphin's is from its docs. The backup's model is whatever FALLBACK_MODEL
// names, so it is priced like SERV until FALLBACK_PRICE_* says otherwise.
export interface Price {
  input: number;
  output: number;
}

const DEFAULT_PRICES: Record<Provider["id"], Price> = {
  serv: { input: 1.25, output: 6.5 },
  dolphin: { input: 0.01, output: 0.07 },
  fallback: { input: 1.25, output: 6.5 },
};

function dollars(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return raw?.trim() && Number.isFinite(n) && n >= 0 ? n : fallback;
}

export function modelPrices(env: Record<string, string | undefined> = process.env): Record<Provider["id"], Price> {
  const of = (id: Provider["id"], prefix: string): Price => ({
    input: dollars(env[`${prefix}_PRICE_INPUT_PER_M`], DEFAULT_PRICES[id].input),
    output: dollars(env[`${prefix}_PRICE_OUTPUT_PER_M`], DEFAULT_PRICES[id].output),
  });
  return { serv: of("serv", "SERV"), dolphin: of("dolphin", "DOLPHIN"), fallback: of("fallback", "FALLBACK") };
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

// empty: no content at all. unusable: something, but not what was asked
// for (a JSON call's answer that isn't JSON: words, a refusal, or JSON cut
// off). Both are tried again; both count as an empty answer in the log.
// filtered: the provider's own content filter cut the reply off part way.
export type Failure =
  | { provider: Provider["id"]; kind: "network" | "timeout" | "stream" | "empty" | "unusable" | "filtered" }
  | { provider: Provider["id"]; kind: "status"; status: number };

// One try at one provider, for the log (modelAttempts.ts).
export interface Attempt {
  purpose: ModelPurpose;
  provider: Provider["id"];
  // The HTTP status, or null when no response came.
  status: number | null;
  outcome: "ok" | Failure["kind"];
  ms: number;
  promptTokens: number | null;
  completionTokens: number | null;
  // 0 for the first try at this provider, 1 for the first retry, and so on.
  retry: number;
  // No content, or nothing usable.
  empty: boolean;
}

// Tried again on the same provider: anything that may answer next time.
// Never a 402 (out of credit) or another refusal.
export function retryable(f: Failure): boolean {
  if (f.kind !== "status") return true;
  return f.status === 429 || f.status >= 500;
}

// Waits before the next try, or less if the call is stopped.
function pause(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0 || signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done);
  });
}

// One line per try in the server's log, in production (Pier keeps it).
function logAttempt(a: Attempt): void {
  if (process.env.NODE_ENV !== "production") return;
  console.info(
    `model: ${a.purpose} ${a.provider} try ${a.retry + 1} ${a.outcome}${a.status === null ? "" : ` ${a.status}`} ${a.ms} ms, ${a.promptTokens ?? 0} in, ${a.completionTokens ?? 0} out${a.empty ? ", empty" : ""}`,
  );
}

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
  // What went wrong when no reply streamed at all, with the details, for the
  // server's log. People see userError's plain sentence instead.
  error: string | null;
  // Every try, in order.
  attempts: Attempt[];
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

export function requestBody(p: Provider, messages: ChatMessage[], maxTokens: number, servTools: unknown[] = []): Record<string, unknown> {
  const body: Record<string, unknown> = { model: p.model, messages: ensureSystemMessage(messages), max_tokens: maxTokens, stream: true };
  if (p.askForUsage) body.stream_options = { include_usage: true };
  if (p.id === "serv" && servTools.length) body.tools = servTools;
  return body;
}

interface StreamChunk {
  id?: string;
  choices?: { delta?: { content?: string | null }; finish_reason?: string | null }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
  error?: unknown;
}

// One streamed chat completion from one provider. Yields text deltas, returns
// the usage it saw, throws ProviderFailure. The timeout covers the wait for
// the first token and then any silence between chunks.
async function* attempt(
  p: Provider,
  messages: ChatMessage[],
  opts: { timeoutMs: number; maxTokens: number; signal: AbortSignal; fetchImpl: typeof fetch; servTools?: unknown[] },
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
        body: JSON.stringify(requestBody(p, messages, opts.maxTokens, opts.servTools)),
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
    // SERV's gateway can cut a reply off with its content filter: it sends
    // a chunk of its own (another id) with a canned line ("I can't share
    // that.") and finish_reason "content_filter". None of it is the reply.
    let replyId: string | null = null;
    let filtered = false;
    for (;;) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch {
        throw new ProviderFailure(timedOut ? "timeout" : "network");
      }
      if (chunk.done) {
        if (filtered) throw new ProviderFailure("filtered");
        return usage;
      }
      arm();
      buf += decoder.decode(chunk.value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        const t = line.trim();
        if (!t.startsWith("data:")) continue;
        const payload = t.slice(5).trim();
        if (payload === "[DONE]") {
          if (filtered) throw new ProviderFailure("filtered");
          return usage;
        }
        let json: StreamChunk;
        try {
          json = JSON.parse(payload) as StreamChunk;
        } catch {
          continue;
        }
        if (json.error) throw new ProviderFailure("stream");
        if (json.choices?.some((c) => c.finish_reason === "content_filter")) filtered = true;
        if (json.id && replyId === null) replyId = json.id;
        else if (json.id && json.id !== replyId) filtered = true;
        if (filtered) continue;
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
  if (id === "dolphin") return DOLPHIN_LABEL;
  return first ? "The backup model" : "the backup model";
}

const KIND_TEXT = { network: "could not be reached", stream: "sent a broken reply", empty: "sent an empty reply", unusable: "sent an answer that couldn't be used", filtered: "held part of its reply back" };

function failureText(f: Failure, timeoutMs: number): string {
  if (f.kind === "timeout") return `did not answer within ${Math.round(timeoutMs / 1000)} seconds`;
  if (f.kind !== "status") return KIND_TEXT[f.kind];
  if (f.status === 402) return "is out of credit";
  if (f.status === 429) return "is busy right now (429)";
  if (f.status >= 500) return `had a server error (${f.status})`;
  return `refused the request (${f.status})`;
}

// What happened and what to do, in one or two plain sentences. The same
// failure tried again is said once.
export function describeFailures(failures: Failure[], timeoutMs: number): string {
  if (failures.length === 0) return NO_MODEL_ERROR;
  const said = failures.map((f, i) => `${providerName(f.provider, i === 0)} ${failureText(f, timeoutMs)}`);
  const what = said.filter((t, i) => t.toLowerCase() !== said[i - 1]?.toLowerCase()).join(", and ");
  let todo = "Try again in a minute.";
  if (failures.some((f) => f.kind === "status" && !fallsBack(f))) todo = "Check the model settings on the server, then try again.";
  else if (failures.some((f) => f.kind === "status" && f.status === 402)) todo = "Top up SERV credit, then try again.";
  return `${what}, so there is no reply. ${todo}`;
}

// What a person is told when no model answered: one plain sentence, never a
// status code or a setting. The details go to the server's log. On their own
// SERV key, they are told what they can fix themselves.
export const REPLIES_UNAVAILABLE = "Replies aren't available right now. Try again in a few minutes.";

export function userError(failures: Failure[], ownKey = false, general = REPLIES_UNAVAILABLE): string {
  if (ownKey) {
    const statuses = failures.flatMap((f) => (f.kind === "status" ? [f.status] : []));
    if (statuses.includes(402)) return "Your SERV key is out of credit. Top it up, or remove it in the account menu to go back to boardofserv's own.";
    if (statuses.includes(401) || statuses.includes(403)) return "SERV didn't accept your key. Check it in the account menu.";
  }
  return general;
}

// Stream one reply through the providers in order. Never throws for a model
// failure: it always ends with an "end" event that says what happened.
export async function* streamReply(
  messages: ChatMessage[],
  opts: { config: ModelConfig; signal: AbortSignal; fetchImpl?: typeof fetch; servTools?: unknown[]; purpose?: "chat" | "helper_use" },
): AsyncGenerator<ReplyEvent> {
  const started = Date.now();
  const { config, signal } = opts;
  const purpose = opts.purpose ?? "chat";
  const fetchImpl = opts.fetchImpl ?? fetch;
  const failures: Failure[] = [];
  const attempts: Attempt[] = [];
  const policy = retryPolicy(config);
  // A reply from a later provider fell back; one from the first, on any try, didn't.
  const first = config.providers[0];
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
      attempts,
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

  providers: for (const p of config.providers) {
    for (let retry = 0; ; retry++) {
      let firstTokenMs: number | null = null;
      const tried = Date.now();
      const gen = attempt(p, messages, { timeoutMs: config.firstTokenTimeoutMs, maxTokens: config.maxTokens, signal, fetchImpl, servTools: opts.servTools });
      const log = (a: Omit<Attempt, "purpose" | "provider" | "ms" | "retry">) => {
        const entry: Attempt = { purpose, provider: p.id, ms: Date.now() - tried, retry, ...a };
        attempts.push(entry);
        logAttempt(entry);
      };
      try {
        for (;;) {
          const step = await gen.next();
          if (step.done) {
            if (firstTokenMs === null) throw new ProviderFailure("empty");
            log({ status: 200, outcome: "ok", promptTokens: step.value.promptTokens, completionTokens: step.value.completionTokens, empty: false });
            yield ended({ outcome: p !== first ? "fell_back" : "ok", provider: p.id, model: p.model, firstTokenMs, ...step.value });
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
        log({ status: failure.kind === "status" ? failure.status : null, outcome: failure.kind, promptTokens: null, completionTokens: null, empty: failure.kind === "empty" });
        if (signal.aborted) {
          // The person pressed stop. Keep what arrived, try nothing else.
          yield ended(streamed ? { outcome: p !== first ? "fell_back" : "ok", provider: p.id, model: p.model, firstTokenMs } : {});
          return;
        }
        failures.push(failure);
        if (streamed) {
          yield ended({ provider: p.id, model: p.model, firstTokenMs, cutOff: true });
          return;
        }
        if (retryable(failure) && retry + 1 < policy.attempts) {
          await pause(policy.backoffMs * (retry + 1), signal);
          continue;
        }
        if (!fallsBack(failure)) break providers;
        continue providers;
      } finally {
        await gen.return({ promptTokens: null, completionTokens: null });
      }
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
  // Every try, in order.
  attempts: Attempt[];
}

export function jsonRequestBody(
  p: Provider,
  messages: ChatMessage[],
  schema: { name: string; schema: Record<string, unknown> },
  maxTokens: number,
  servTools: unknown[] = [],
): Record<string, unknown> {
  return {
    model: p.model,
    messages: ensureSystemMessage(messages),
    max_tokens: maxTokens,
    stream: false,
    response_format: { type: "json_schema", json_schema: { name: schema.name, strict: true, schema: sanitizeJsonSchema(schema.schema) } },
    // SERV's own tools (its Prompt Guard) go to SERV only.
    ...(p.id === "serv" && servTools.length ? { tools: servTools } : {}),
  };
}

// An answer a JSON call can use is JSON. No content (or only blanks) is
// empty; anything else is unusable.
export function jsonAnswer(content: string | null | undefined): "ok" | "empty" | "unusable" {
  if (!content?.trim()) return "empty";
  try {
    JSON.parse(content);
    return "ok";
  } catch {
    return "unusable";
  }
}

// What every try used, in tokens (each try is paid for), or null when no
// try reported any.
function spent(attempts: Attempt[], key: "promptTokens" | "completionTokens"): number | null {
  const counted = attempts.filter((a) => a[key] !== null);
  return counted.length ? counted.reduce((t, a) => t + (a[key] ?? 0), 0) : null;
}

// One non-streaming call for structured JSON, through the same providers in
// the same order with the same retry and fallback rules as a reply, with the
// answer limit of its purpose unless one is given. Never throws for a model
// failure: the result says what happened.
export async function completeJson(
  messages: ChatMessage[],
  opts: {
    config: ModelConfig;
    purpose: ModelPurpose;
    schema: { name: string; schema: Record<string, unknown> };
    maxTokens?: number;
    signal: AbortSignal;
    fetchImpl?: typeof fetch;
    servTools?: unknown[];
  },
): Promise<JsonResult> {
  const started = Date.now();
  const fetchImpl = opts.fetchImpl ?? fetch;
  const maxTokens = opts.maxTokens ?? ANSWER_LIMITS[opts.purpose];
  const policy = retryPolicy(opts.config);
  const failures: Failure[] = [];
  const attempts: Attempt[] = [];
  const first = opts.config.providers[0];
  // The tokens are every try's, the failed ones' included: each was paid for.
  const done = (r: Partial<JsonResult>): JsonResult => ({
    content: null,
    outcome: "failed",
    provider: null,
    model: null,
    ...r,
    promptTokens: spent(attempts, "promptTokens"),
    completionTokens: spent(attempts, "completionTokens"),
    failures,
    attempts,
    totalMs: Date.now() - started,
  });

  providers: for (const p of opts.config.providers) {
    for (let retry = 0; ; retry++) {
      const tried = Date.now();
      const ctl = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        ctl.abort();
      }, opts.config.firstTokenTimeoutMs);
      const onAbort = () => ctl.abort();
      opts.signal.addEventListener("abort", onAbort);
      let failure: Failure;
      let status: number | null = null;
      let usage: { prompt_tokens?: number; completion_tokens?: number } | undefined;
      try {
        const res = await fetchImpl(`${p.baseUrl}/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json", authorization: `Bearer ${p.apiKey}` },
          body: JSON.stringify(jsonRequestBody(p, messages, opts.schema, maxTokens, opts.servTools)),
          signal: ctl.signal,
        });
        status = res.status;
        if (!res.ok) {
          failure = { provider: p.id, kind: "status", status: res.status };
        } else {
          const body = (await res.json()) as {
            choices?: { message?: { content?: string | null } }[];
            usage?: { prompt_tokens?: number; completion_tokens?: number };
          };
          usage = body.usage;
          const content = body.choices?.[0]?.message?.content;
          const answer = jsonAnswer(content);
          if (answer === "ok") {
            const entry: Attempt = { purpose: opts.purpose, provider: p.id, status, outcome: "ok", ms: Date.now() - tried, promptTokens: usage?.prompt_tokens ?? null, completionTokens: usage?.completion_tokens ?? null, retry, empty: false };
            attempts.push(entry);
            logAttempt(entry);
            return done({ content: content!, outcome: p !== first ? "fell_back" : "ok", provider: p.id, model: p.model });
          }
          failure = { provider: p.id, kind: answer };
        }
      } catch {
        failure = { provider: p.id, kind: timedOut ? "timeout" : "network" };
      } finally {
        clearTimeout(timer);
        opts.signal.removeEventListener("abort", onAbort);
      }
      const entry: Attempt = {
        purpose: opts.purpose,
        provider: p.id,
        status,
        outcome: failure.kind,
        ms: Date.now() - tried,
        promptTokens: usage?.prompt_tokens ?? null,
        completionTokens: usage?.completion_tokens ?? null,
        retry,
        empty: failure.kind === "empty" || failure.kind === "unusable",
      };
      attempts.push(entry);
      logAttempt(entry);
      if (opts.signal.aborted) return done({});
      failures.push(failure);
      if (retryable(failure) && retry + 1 < policy.attempts) {
        await pause(policy.backoffMs * (retry + 1), opts.signal);
        if (opts.signal.aborted) return done({});
        continue;
      }
      if (!fallsBack(failure)) break providers;
      continue providers;
    }
  }
  return done({});
}
