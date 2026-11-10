// @vitest-environment node
import { describe, expect, it } from "vitest";
import { completeJson, modelConfig, retryPolicy, streamReply, type ChatMessage, type ModelConfig, type Provider, type ReplyEvent, type ReplyResult } from "./model";

// The SERV client trying again, as servpit measured SERV needs: an empty
// answer, or one with nothing usable, is tried again like a network error,
// with a growing pause; a 402 never is. Every try is in the result.

const SERV = modelConfig({ SERV_API_KEY: "test-serv-key" }).providers[0]!;
const DOLPHIN = modelConfig({ DOLPHIN_API_KEY: "test-dolphin" }).providers[0]!;
const ASK: ChatMessage[] = [{ role: "user", content: "Is there a new enquiry?" }];
const SCHEMA = { name: "decision", schema: { type: "object", properties: { outcome: { type: "string" } } } };

const config = (providers: Provider[], retry = { attempts: 3, backoffMs: 0 }): ModelConfig => ({ providers, firstTokenTimeoutMs: 20_000, historyMessages: 12, maxTokens: 700, planMaxTokens: 320, retry });

const answer = (content: string | null, usage = { prompt_tokens: 600, completion_tokens: 25 }) => Response.json({ choices: [{ message: { content } }], usage });
const status = (code: number) => new Response(JSON.stringify({ error: { message: "nope" } }), { status: code });

function mockFetch(...handlers: (() => Response | Promise<Response>)[]) {
  const bodies: Record<string, unknown>[] = [];
  const hosts: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    bodies.push(JSON.parse(String(init.body)));
    hosts.push(new URL(String(input)).host);
    const h = handlers[bodies.length - 1];
    if (!h) throw new Error(`unexpected call ${bodies.length}`);
    return h();
  }) as typeof fetch;
  return { fetchImpl, bodies, hosts };
}

const ask = (cfg: ModelConfig, fetchImpl: typeof fetch) => completeJson(ASK, { config: cfg, purpose: "decision", schema: SCHEMA, signal: new AbortController().signal, fetchImpl });

describe("an empty answer", () => {
  it("is tried again on the same provider, and the answer that comes is used", async () => {
    const { fetchImpl, bodies } = mockFetch(
      () => answer(""),
      () => answer(null, { prompt_tokens: 0, completion_tokens: 0 }),
      () => answer(JSON.stringify({ outcome: "enquiry_found" })),
    );
    const r = await ask(config([SERV]), fetchImpl);
    expect(r).toMatchObject({ content: JSON.stringify({ outcome: "enquiry_found" }), outcome: "ok", provider: "serv" });
    expect(bodies).toHaveLength(3);
    expect(r.attempts.map((a) => [a.retry, a.outcome, a.empty, a.status])).toEqual([
      [0, "empty", true, 200],
      [1, "empty", true, 200],
      [2, "ok", false, 200],
    ]);
    // Every try is paid for: the tokens are all of theirs.
    expect(r).toMatchObject({ promptTokens: 1200, completionTokens: 50 });
    expect(r.failures).toEqual([
      { provider: "serv", kind: "empty" },
      { provider: "serv", kind: "empty" },
    ]);
  });

  it("counts an answer with nothing usable (not JSON, blanks, JSON cut off) as empty too", async () => {
    for (const bad of ["Sorry, I can't help with that.", "   ", '{"outcome": "enquiry_fo']) {
      const { fetchImpl } = mockFetch(
        () => answer(bad),
        () => answer(JSON.stringify({ outcome: "no_enquiry" })),
      );
      const r = await ask(config([SERV]), fetchImpl);
      expect(r.content, bad).toBe(JSON.stringify({ outcome: "no_enquiry" }));
      expect(r.attempts[0], bad).toMatchObject({ outcome: bad.trim() ? "unusable" : "empty", empty: true, retry: 0 });
    }
  });

  it("is tried three times in all, then the next provider is asked", async () => {
    const { fetchImpl, hosts } = mockFetch(
      () => answer(""),
      () => answer(""),
      () => answer(""),
      () => answer(JSON.stringify({ outcome: "enquiry_found" })),
    );
    const r = await ask(config([SERV, DOLPHIN]), fetchImpl);
    expect(hosts).toEqual(["inference-api.openserv.ai", "inference-api.openserv.ai", "inference-api.openserv.ai", "lighthouse.dphn.ai"]);
    expect(r).toMatchObject({ outcome: "fell_back", provider: "dolphin" });
    expect(r.attempts.map((a) => [a.provider, a.retry])).toEqual([
      ["serv", 0],
      ["serv", 1],
      ["serv", 2],
      ["dolphin", 0],
    ]);
  });

  it("is tried again after a pause that grows", async () => {
    const { fetchImpl } = mockFetch(
      () => answer(""),
      () => answer(""),
      () => answer(JSON.stringify({ outcome: "enquiry_found" })),
    );
    const started = Date.now();
    const r = await ask(config([SERV], { attempts: 3, backoffMs: 40 }), fetchImpl);
    // 40 ms before the second try, 80 before the third.
    expect(Date.now() - started).toBeGreaterThanOrEqual(115);
    expect(r.outcome).toBe("ok");
  });
});

describe("other failures", () => {
  it.each([
    ["a network error", () => Promise.reject(new TypeError("fetch failed")), "network"],
    ["a 503", () => status(503), "status"],
    ["a 500", () => status(500), "status"],
    ["a 429", () => status(429), "status"],
  ] as const)("try again after %s", async (_what, fail, kind) => {
    const { fetchImpl, bodies } = mockFetch(fail, () => answer(JSON.stringify({ outcome: "enquiry_found" })));
    const r = await ask(config([SERV]), fetchImpl);
    expect(bodies).toHaveLength(2);
    expect(r.outcome).toBe("ok");
    expect(r.attempts[0]).toMatchObject({ outcome: kind, empty: false, retry: 0 });
  });

  it("never try a 402 again: out of credit goes straight to the next provider", async () => {
    const { fetchImpl, hosts } = mockFetch(
      () => status(402),
      () => answer(JSON.stringify({ outcome: "enquiry_found" })),
    );
    const r = await ask(config([SERV, DOLPHIN]), fetchImpl);
    expect(hosts).toEqual(["inference-api.openserv.ai", "lighthouse.dphn.ai"]);
    expect(r.attempts.map((a) => [a.provider, a.status, a.retry])).toEqual([
      ["serv", 402, 0],
      ["dolphin", 200, 0],
    ]);
    // On SERV alone (someone's own key), one try and done.
    const own = mockFetch(() => status(402));
    const alone = await ask(config([SERV]), own.fetchImpl);
    expect(own.bodies).toHaveLength(1);
    expect(alone).toMatchObject({ content: null, outcome: "failed", failures: [{ provider: "serv", kind: "status", status: 402 }] });
  });

  it("stop at any other refusal, as before", async () => {
    const { fetchImpl, bodies } = mockFetch(() => status(400));
    const r = await ask(config([SERV, DOLPHIN]), fetchImpl);
    expect(bodies).toHaveLength(1);
    expect(r.outcome).toBe("failed");
  });
});

describe("a streamed reply", () => {
  const enc = new TextEncoder();
  const frame = (data: unknown) => enc.encode(`data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`);
  const streamed = (words: string[]) =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(c) {
          for (const w of words) c.enqueue(frame({ choices: [{ delta: { content: w } }] }));
          c.enqueue(frame({ choices: [{ delta: {} }], usage: { prompt_tokens: 120, completion_tokens: 8 } }));
          c.enqueue(frame("[DONE]"));
          c.close();
        },
      }),
      { status: 200 },
    );

  async function run(cfg: ModelConfig, fetchImpl: typeof fetch) {
    const events: ReplyEvent[] = [];
    for await (const ev of streamReply(ASK, { config: cfg, signal: new AbortController().signal, fetchImpl, purpose: "chat" })) events.push(ev);
    return { text: events.map((e) => (e.type === "delta" ? e.text : "")).join(""), result: (events.at(-1) as { result: ReplyResult }).result };
  }

  it("is tried again when the stream ends with nothing in it, before a word was shown", async () => {
    const { fetchImpl } = mockFetch(
      () => streamed([]),
      () => streamed(["Here", " it is"]),
    );
    const { text, result } = await run(config([SERV]), fetchImpl);
    expect(text).toBe("Here it is");
    expect(result.attempts.map((a) => [a.purpose, a.outcome, a.retry, a.empty])).toEqual([
      ["chat", "empty", 0, true],
      ["chat", "ok", 1, false],
    ]);
  });

  it("is never tried again after a 402", async () => {
    const { fetchImpl, bodies } = mockFetch(() => status(402));
    const { result } = await run(config([SERV]), fetchImpl);
    expect(bodies).toHaveLength(1);
    expect(result.outcome).toBe("failed");
  });
});

describe("the retry settings", () => {
  it("default to three tries, half a second apart, and can be set", () => {
    expect(retryPolicy(modelConfig({}))).toEqual({ attempts: 3, backoffMs: 500 });
    expect(retryPolicy(modelConfig({ MODEL_RETRY_ATTEMPTS: "2", MODEL_RETRY_BACKOFF_MS: "0" }))).toEqual({ attempts: 2, backoffMs: 0 });
    expect(retryPolicy(modelConfig({ MODEL_RETRY_ATTEMPTS: "lots", MODEL_RETRY_BACKOFF_MS: "-1" }))).toEqual({ attempts: 3, backoffMs: 500 });
    // A config made by hand without them gets the defaults.
    expect(retryPolicy({})).toEqual({ attempts: 3, backoffMs: 500 });
  });
});
