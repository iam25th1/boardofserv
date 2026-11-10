// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  contextFor,
  CUT_OFF_NOTE,
  DOLPHIN_BASE_URL,
  DOLPHIN_MODEL,
  modelConfig,
  modelPrices,
  NO_MODEL_ERROR,
  REPLIES_UNAVAILABLE,
  streamReply,
  userError,
  type ChatMessage,
  type ModelConfig,
  type Provider,
  type ReplyEvent,
  type ReplyResult,
} from "./model";
import { SYSTEM_PROMPT } from "./systemPrompt";

// Every provider call here goes to a mocked fetch. Nothing leaves the machine.

const SERV = modelConfig({ SERV_API_KEY: "test-serv-key" }).providers[0]!;
const BACKUP: Provider = {
  id: "fallback",
  label: "Backup",
  baseUrl: "https://backup.test/v1",
  apiKey: "test-backup-key",
  model: "backup-1",
  askForUsage: true,
};
const ASK: ChatMessage[] = [{ role: "user", content: "Watch ETH for me" }];

// One try per provider: these tests are about the order of providers.
// Trying again has tests of its own (modelRetry.test.ts).
function config(providers: Provider[], firstTokenTimeoutMs = 20_000): ModelConfig {
  return { providers, firstTokenTimeoutMs, historyMessages: 12, maxTokens: 700, planMaxTokens: 200, retry: { attempts: 1, backoffMs: 0 } };
}

const enc = new TextEncoder();
const frame = (data: unknown) => enc.encode(`data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`);
const delta = (content: string) => frame({ choices: [{ index: 0, delta: { content } }] });

// A streamed chat completion in SERV's shape: deltas, a last chunk with usage,
// then [DONE].
function streamed(words: string[], usage = { prompt_tokens: 120, completion_tokens: 8 }): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(frame({ choices: [{ index: 0, delta: { role: "assistant" } }] }));
        for (const w of words) c.enqueue(delta(w));
        c.enqueue(frame({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage }));
        c.enqueue(frame("[DONE]"));
        c.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

const refused = (status: number) => new Response(JSON.stringify({ error: { message: "nope" } }), { status });

// Hangs until the request is aborted, like a provider that never answers.
const silent = (init: RequestInit) =>
  new Promise<Response>((_, reject) => init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));

interface Call {
  url: string;
  headers: Headers;
  body: Record<string, unknown>;
}

// Each handler answers one call, in order. A call past the last handler fails.
function mockFetch(...handlers: ((init: RequestInit) => Response | Promise<Response>)[]) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    calls.push({ url: String(input), headers: new Headers(init.headers), body: JSON.parse(String(init.body)) });
    const handler = handlers[calls.length - 1];
    if (!handler) throw new Error(`unexpected call ${calls.length} to ${String(input)}`);
    return handler(init);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

async function run(cfg: ModelConfig, fetchImpl: typeof fetch, signal = new AbortController().signal) {
  const events: ReplyEvent[] = [];
  for await (const ev of streamReply(ASK, { config: cfg, signal, fetchImpl })) events.push(ev);
  const text = events.map((e) => (e.type === "delta" ? e.text : "")).join("");
  const end = events.at(-1);
  if (end?.type !== "end") throw new Error("no end event");
  return { events, text, result: end.result as ReplyResult, start: events.find((e) => e.type === "start") };
}

describe("streamReply", () => {
  it("streams a SERV reply and reports its usage", async () => {
    const { fetchImpl, calls } = mockFetch(() => streamed(["Hello", " there"]));
    const { text, result, start } = await run(config([SERV, BACKUP]), fetchImpl);
    expect(start).toEqual({ type: "start", provider: "serv", label: "SERV Reasoning" });
    expect(text).toBe("Hello there");
    expect(calls).toHaveLength(1);
    expect(result).toMatchObject({ outcome: "ok", provider: "serv", model: "claude-haiku-4.5", promptTokens: 120, completionTokens: 8, cutOff: false, error: null });
    expect(result.firstTokenMs).not.toBeNull();
  });

  it("on a SERV 402 goes to the backup and never calls SERV again", async () => {
    const { fetchImpl, calls } = mockFetch(
      () => refused(402),
      () => streamed(["From", " the backup"]),
    );
    const { text, result, start } = await run(config([SERV, BACKUP]), fetchImpl);
    expect(calls.map((c) => new URL(c.url).host)).toEqual(["inference-api.openserv.ai", "backup.test"]);
    expect(start).toMatchObject({ provider: "fallback", label: "Backup" });
    expect(text).toBe("From the backup");
    expect(result).toMatchObject({ outcome: "fell_back", provider: "fallback", model: "backup-1" });
    expect(result.failures).toEqual([{ provider: "serv", kind: "status", status: 402 }]);
  });

  it.each([500, 503, 429])("on a SERV %i goes to the backup", async (status) => {
    const { fetchImpl, calls } = mockFetch(
      () => refused(status),
      () => streamed(["ok"]),
    );
    const { result } = await run(config([SERV, BACKUP]), fetchImpl);
    expect(calls).toHaveLength(2);
    expect(result).toMatchObject({ outcome: "fell_back", provider: "fallback" });
  });

  it("on a timeout before the first token goes to the backup", async () => {
    const { fetchImpl, calls } = mockFetch(silent, () => streamed(["late", " but here"]));
    const { text, result } = await run(config([SERV, BACKUP], 40), fetchImpl);
    expect(calls).toHaveLength(2);
    expect(text).toBe("late but here");
    expect(result.failures).toEqual([{ provider: "serv", kind: "timeout" }]);
    expect(result.outcome).toBe("fell_back");
  });

  it("on a network error or an empty reply goes to the backup", async () => {
    const network = mockFetch(
      () => Promise.reject(new TypeError("fetch failed")),
      () => streamed(["ok"]),
    );
    expect((await run(config([SERV, BACKUP]), network.fetchImpl)).result.failures).toEqual([{ provider: "serv", kind: "network" }]);
    const empty = mockFetch(
      () => streamed([]),
      () => streamed(["ok"]),
    );
    expect((await run(config([SERV, BACKUP]), empty.fetchImpl)).result.failures).toEqual([{ provider: "serv", kind: "empty" }]);
  });

  it("does not retry after the first token, and reports the reply as cut off", async () => {
    const { fetchImpl, calls } = mockFetch(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(c) {
              c.enqueue(delta("Half a"));
              setTimeout(() => c.error(new Error("connection reset")), 5);
            },
          }),
          { status: 200 },
        ),
    );
    const { text, result, start } = await run(config([SERV, BACKUP]), fetchImpl);
    expect(calls).toHaveLength(1);
    expect(start).toMatchObject({ provider: "serv" });
    // The route adds the cut-off note (CUT_OFF_SUFFIX) after the text.
    expect(text).toBe("Half a");
    expect(result).toMatchObject({ outcome: "failed", provider: "serv", cutOff: true, error: null });
  });

  it("stops quietly when the person presses stop: no note, no backup", async () => {
    const stop = new AbortController();
    const { fetchImpl, calls } = mockFetch(
      (init) =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(c) {
              c.enqueue(delta("Partial"));
              init.signal?.addEventListener("abort", () => c.error(new DOMException("aborted", "AbortError")));
              setTimeout(() => stop.abort(), 5);
            },
          }),
          { status: 200 },
        ),
    );
    const { text, result } = await run(config([SERV, BACKUP]), fetchImpl, stop.signal);
    expect(calls).toHaveLength(1);
    expect(text).toBe("Partial");
    expect(result).toMatchObject({ outcome: "ok", provider: "serv", cutOff: false });
  });

  it("when every provider fails, shows a plain error and no reply", async () => {
    const { fetchImpl } = mockFetch(
      () => refused(500),
      () => refused(502),
    );
    const { events, result } = await run(config([SERV, BACKUP]), fetchImpl);
    expect(events.some((e) => e.type === "start" || e.type === "delta")).toBe(false);
    expect(result.outcome).toBe("failed");
    expect(result.error).toBe(
      "SERV Reasoning had a server error (500), and the backup model had a server error (502), so there is no reply. Try again in a minute.",
    );
  });

  it("says to top up when SERV is out of credit and nothing else answered", async () => {
    const { fetchImpl } = mockFetch(() => refused(402));
    const { result } = await run(config([SERV]), fetchImpl);
    expect(result.error).toBe("SERV Reasoning is out of credit, so there is no reply. Top up SERV credit, then try again.");
  });

  it("does not fall back on a refusal the backup would repeat (401)", async () => {
    const { fetchImpl, calls } = mockFetch(() => refused(401));
    const { result } = await run(config([SERV, BACKUP]), fetchImpl);
    expect(calls).toHaveLength(1);
    expect(result.error).toContain("refused the request (401)");
    expect(result.error).toContain("Check the model settings");
  });

  it("with no provider set up, shows a plain error (the demo is development only, see demo-unreachable.test.ts)", async () => {
    const { fetchImpl, calls } = mockFetch();
    const { events, result } = await run(config([]), fetchImpl);
    expect(calls).toHaveLength(0);
    expect(events).toHaveLength(1);
    expect(result.error).toBe(NO_MODEL_ERROR);
  });
});

describe("the request SERV receives", () => {
  it("has a system message, claude-haiku-4.5, a token cap and nothing else", async () => {
    const { fetchImpl, calls } = mockFetch(() => streamed(["ok"]));
    await run(config([SERV, BACKUP]), fetchImpl);
    const [call] = calls;
    expect(call!.url).toBe("https://inference-api.openserv.ai/v1/chat/completions");
    expect(call!.headers.get("authorization")).toBe("Bearer test-serv-key");
    expect(Object.keys(call!.body).sort()).toEqual(["max_tokens", "messages", "model", "stream"]);
    expect(call!.body).toMatchObject({ model: "claude-haiku-4.5", max_tokens: 700, stream: true });
    const messages = call!.body.messages as ChatMessage[];
    expect(messages[0]).toEqual({ role: "system", content: SYSTEM_PROMPT });
    expect(messages.slice(1)).toEqual(ASK);
  });

  it("switches on no paid add-on and carries no banned schema keyword", async () => {
    const { fetchImpl, calls } = mockFetch(() => streamed(["ok"]));
    await run(config([SERV]), fetchImpl);
    const raw = JSON.stringify(calls[0]!.body);
    // Prompt Guard and Shadow Agent are serv_* tools; Multipath and Kronos are model suffixes.
    expect(calls[0]!.body.tools).toBeUndefined();
    expect(raw).not.toMatch(/serv_|-serv-|kronos|multipath|prompt_guard|shadow/i);
    for (const k of ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf"]) expect(raw).not.toContain(`"${k}"`);
  });

  it("asks an OpenAI-style backup for usage, which SERV sends unasked", async () => {
    const { fetchImpl, calls } = mockFetch(
      () => refused(503),
      () => streamed(["ok"]),
    );
    await run(config([SERV, BACKUP]), fetchImpl);
    expect(calls[0]!.body.stream_options).toBeUndefined();
    expect(calls[1]!.body).toMatchObject({ model: "backup-1", stream_options: { include_usage: true } });
    expect(calls[1]!.headers.get("authorization")).toBe("Bearer test-backup-key");
  });
});

describe("modelConfig", () => {
  it("puts SERV first and needs all three FALLBACK_* values for a backup", () => {
    const full = modelConfig({ SERV_API_KEY: "k", FALLBACK_BASE_URL: "https://b.test/v1/", FALLBACK_API_KEY: "f", FALLBACK_MODEL: "m" });
    expect(full.providers.map((p) => p.id)).toEqual(["serv", "fallback"]);
    expect(full.providers[1]).toMatchObject({ baseUrl: "https://b.test/v1", label: "m" });
    expect(modelConfig({ FALLBACK_BASE_URL: "https://b.test/v1", FALLBACK_API_KEY: "f" }).providers).toEqual([]);
  });

  it("defaults to a 20s first-token timeout, 12 messages and 700 tokens, all configurable", () => {
    expect(modelConfig({})).toMatchObject({ firstTokenTimeoutMs: 20_000, historyMessages: 12, maxTokens: 700 });
    expect(modelConfig({ MODEL_FIRST_TOKEN_TIMEOUT_MS: "5000", CHAT_HISTORY_MESSAGES: "6", CHAT_MAX_TOKENS: "300" })).toMatchObject({
      firstTokenTimeoutMs: 5_000,
      historyMessages: 6,
      maxTokens: 300,
    });
    expect(modelConfig({ CHAT_MAX_TOKENS: "lots" }).maxTokens).toBe(700);
  });
});

describe("contextFor", () => {
  const turns = (n: number): ChatMessage[] =>
    Array.from({ length: n }, (_, i) => ({ role: i % 2 === 0 ? "user" : "assistant", content: `m${i}` }) as ChatMessage);

  it("keeps the last 12 messages, dropping older ones, starting with the person", () => {
    const out = contextFor(turns(30), 12);
    expect(out).toHaveLength(12);
    expect(out[0]).toEqual({ role: "user", content: "m18" });
    // An odd window would start on a reply; that reply is dropped too.
    const odd = contextFor(turns(30), 11);
    expect(odd[0]?.role).toBe("user");
    expect(odd).toHaveLength(10);
  });

  it("strips the cut-off note before the history goes back to a model", () => {
    const out = contextFor(
      [
        { role: "user", content: "hi" },
        { role: "assistant", content: `Half a reply\n\n_${CUT_OFF_NOTE}_` },
      ],
      12,
    );
    expect(out[1]?.content).toBe("Half a reply");
  });
});

describe("Dolphin, second in the order", () => {
  const ALL = { SERV_API_KEY: "k", DOLPHIN_API_KEY: "d", FALLBACK_BASE_URL: "https://b.test/v1", FALLBACK_API_KEY: "f", FALLBACK_MODEL: "m" };

  it("comes after SERV and before the backup, which still needs all three FALLBACK_* values", () => {
    expect(modelConfig(ALL).providers.map((p) => p.id)).toEqual(["serv", "dolphin", "fallback"]);
    expect(modelConfig({ ...ALL, FALLBACK_MODEL: "" }).providers.map((p) => p.id)).toEqual(["serv", "dolphin"]);
    expect(modelConfig({ DOLPHIN_API_KEY: "d" }).providers.map((p) => p.id)).toEqual(["dolphin"]);
    expect(modelConfig({ SERV_API_KEY: "k" }).providers.map((p) => p.id)).toEqual(["serv"]);
  });

  it("uses the base url and model from Dolphin's docs unless DOLPHIN_* says otherwise, and asks for usage", () => {
    expect(modelConfig(ALL).providers[1]).toEqual({
      id: "dolphin",
      label: "Dolphin",
      baseUrl: "https://lighthouse.dphn.ai/run/text-v/v1",
      apiKey: "d",
      model: "deepseek-ai/DeepSeek-V4.1-Flash",
      askForUsage: true,
    });
    expect(DOLPHIN_BASE_URL).toBe("https://lighthouse.dphn.ai/run/text-v/v1");
    expect(DOLPHIN_MODEL).toBe("deepseek-ai/DeepSeek-V4.1-Flash");
    expect(modelConfig({ DOLPHIN_API_KEY: "d", DOLPHIN_BASE_URL: "https://dolphin.test/v1/", DOLPHIN_MODEL: "other" }).providers[0]).toMatchObject({
      baseUrl: "https://dolphin.test/v1",
      model: "other",
    });
  });

  it("answers when SERV fails before its first token, and the backup only when Dolphin fails too", async () => {
    const [serv, dolphin, backup] = modelConfig(ALL).providers;
    const first = mockFetch(
      () => refused(503),
      () => streamed(["From", " Dolphin"]),
    );
    const viaDolphin = await run(config([serv!, dolphin!, backup!]), first.fetchImpl);
    expect(first.calls.map((c) => new URL(c.url).host)).toEqual(["inference-api.openserv.ai", "lighthouse.dphn.ai"]);
    expect(first.calls[1]!.headers.get("authorization")).toBe("Bearer d");
    expect(first.calls[1]!.body).toMatchObject({ model: DOLPHIN_MODEL, stream_options: { include_usage: true } });
    expect(viaDolphin.start).toMatchObject({ provider: "dolphin", label: "Dolphin" });
    expect(viaDolphin.result).toMatchObject({ outcome: "fell_back", provider: "dolphin", model: DOLPHIN_MODEL, promptTokens: 120 });

    const second = mockFetch(
      () => refused(402),
      () => refused(429),
      () => streamed(["From the backup"]),
    );
    const viaBackup = await run(config([serv!, dolphin!, backup!]), second.fetchImpl);
    expect(second.calls.map((c) => new URL(c.url).host)).toEqual(["inference-api.openserv.ai", "lighthouse.dphn.ai", "b.test"]);
    expect(viaBackup.result).toMatchObject({ provider: "fallback", failures: [{ provider: "serv", status: 402 }, { provider: "dolphin", status: 429 }] });
  });

  it("is left out, with the backup, for someone on their own SERV key", () => {
    const own = modelConfig(ALL, { servKey: "own-key" });
    expect(own.ownKey).toBe(true);
    expect(own.providers).toEqual([{ id: "serv", label: "SERV Reasoning", baseUrl: "https://inference-api.openserv.ai/v1", apiKey: "own-key", model: "claude-haiku-4.5", askForUsage: false }]);
    expect(modelConfig({ DOLPHIN_API_KEY: "d" }, { servKey: "own-key" }).providers.map((p) => p.id)).toEqual(["serv"]);
    expect(modelConfig(ALL).ownKey).toBe(false);
  });
});

describe("modelPrices", () => {
  it("prices SERV at 1.25 and 6.50, Dolphin at 0.01 and 0.07, the backup like SERV, each changeable", () => {
    expect(modelPrices({})).toEqual({ serv: { input: 1.25, output: 6.5 }, dolphin: { input: 0.01, output: 0.07 }, fallback: { input: 1.25, output: 6.5 } });
    expect(modelPrices({ DOLPHIN_PRICE_OUTPUT_PER_M: "0.2", FALLBACK_PRICE_INPUT_PER_M: "0.15", SERV_PRICE_INPUT_PER_M: "nope" })).toEqual({
      serv: { input: 1.25, output: 6.5 },
      dolphin: { input: 0.01, output: 0.2 },
      fallback: { input: 0.15, output: 6.5 },
    });
  });
});

describe("userError", () => {
  it("is one plain sentence, never a status or a setting", () => {
    expect(REPLIES_UNAVAILABLE).toBe("Replies aren't available right now. Try again in a few minutes.");
    expect(userError([{ provider: "serv", kind: "status", status: 402 }])).toBe(REPLIES_UNAVAILABLE);
    expect(userError([], false, "The helper could not answer just now.")).toBe("The helper could not answer just now.");
  });

  it("tells someone on their own key what they can fix", () => {
    expect(userError([{ provider: "serv", kind: "status", status: 402 }], true)).toMatch(/^Your SERV key is out of credit\./);
    expect(userError([{ provider: "serv", kind: "status", status: 401 }], true)).toBe("SERV didn't accept your key. Check it in the account menu.");
    expect(userError([{ provider: "serv", kind: "timeout" }], true)).toBe(REPLIES_UNAVAILABLE);
  });
});
