// @vitest-environment node
import { describe, expect, it } from "vitest";
import { modelConfig, type ModelConfig, type Provider } from "./model";
import { planTurn, SKETCH_SCHEMA } from "./sketchPlan";
import { mergeSketch } from "./sketchBlock";
import { PLAN_PROMPT } from "./systemPrompt";
import type { SketchDTO } from "./types";

// The plan call against a mocked fetch. Nothing leaves the machine.

const SERV = modelConfig({ SERV_API_KEY: "test-serv-key" }).providers[0]!;
const BACKUP: Provider = { id: "fallback", label: "Backup", baseUrl: "https://backup.test/v1", apiKey: "test-backup-key", model: "backup-1", askForUsage: true };
const config = (providers: Provider[]): ModelConfig => ({ providers, firstTokenTimeoutMs: 1_000, historyMessages: 12, maxTokens: 400, planMaxTokens: 200 });

const stored: SketchDTO = {
  name: "ETH floor watch",
  kind: "watcher",
  watches: "ETH price",
  when: "below $2,000",
  how: null,
  tells: null,
  asking: "how",
  live: false,
};
const TURN = { stored, previous: "How often should it check the price?", said: "Every 5 minutes" };

const answer = (o: Record<string, unknown>) =>
  Response.json({
    choices: [
      { message: { content: JSON.stringify({ name: "", kind: "none", watches: "", when: "", how: "", tells: "", asking: "none", choices: [], ...o }) } },
    ],
    usage: { prompt_tokens: 240, completion_tokens: 60 },
  });

function mockFetch(...handlers: (() => Response)[]) {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const fetchImpl = (async (url: RequestInfo | URL, init: RequestInit = {}) => {
    calls.push({ url: String(url), body: JSON.parse(String(init.body)) });
    const handler = handlers[calls.length - 1];
    if (!handler) throw new Error(`unexpected call ${calls.length}`);
    return handler();
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const run = (providers: Provider[], fetchImpl: typeof fetch) =>
  planTurn(TURN, { config: config(providers), signal: new AbortController().signal, fetchImpl });

describe("planTurn", () => {
  it("reads a valid result, which merges into the stored sketch", async () => {
    const { fetchImpl } = mockFetch(() => answer({ name: "ETH floor watch", watches: "ETH price", how: "every 5 minutes", asking: "tells", choices: ["Telegram", "Email"] }));
    const { sketch, result } = await run([SERV, BACKUP], fetchImpl);
    expect(result).toMatchObject({ outcome: "ok", provider: "serv", promptTokens: 240, completionTokens: 60 });
    expect(sketch).toMatchObject({ how: "every 5 minutes", when: null, kind: null, asking: "tells", choices: ["Telegram", "Email"] });
    expect(mergeSketch(stored, sketch!)).toEqual({ ...stored, how: "every 5 minutes", asking: "tells" });
  });

  it("ignores a result that does not validate", async () => {
    const bad = mockFetch(() => Response.json({ choices: [{ message: { content: '{"name": "half' } }] }));
    expect((await run([SERV], bad.fetchImpl)).sketch).toBeNull();
    const wrong = mockFetch(() => Response.json({ choices: [{ message: { content: '{"name": 7, "watches": ["a"]}' } }] }));
    expect((await run([SERV], wrong.fetchImpl)).sketch).toBeNull();
  });

  it("ignores a provider failure, after the same fallback rules as a reply", async () => {
    const down = mockFetch(
      () => new Response("{}", { status: 500 }),
      () => new Response("{}", { status: 503 }),
    );
    const failed = await run([SERV, BACKUP], down.fetchImpl);
    expect(failed.sketch).toBeNull();
    expect(failed.result).toMatchObject({ outcome: "failed", content: null });

    // A 402 goes to the backup once and SERV is not called again.
    const credit = mockFetch(
      () => new Response("{}", { status: 402 }),
      () => answer({ tells: "Telegram" }),
    );
    const fell = await run([SERV, BACKUP], credit.fetchImpl);
    expect(credit.calls.map((c) => new URL(c.url).host)).toEqual(["inference-api.openserv.ai", "backup.test"]);
    expect(fell.result.outcome).toBe("fell_back");
    expect(fell.sketch?.tells).toBe("Telegram");

    // A 401 does not fall back.
    const refused = mockFetch(() => new Response("{}", { status: 401 }));
    expect((await run([SERV, BACKUP], refused.fetchImpl)).result.failures).toEqual([{ provider: "serv", kind: "status", status: 401 }]);
  });

  it("trims choices to four and every field to a short length", async () => {
    const { fetchImpl } = mockFetch(() => answer({ name: "n".repeat(100), watches: "w".repeat(300), choices: ["A", "B", "C", "D", "E", "F"] }));
    const { sketch } = await run([SERV], fetchImpl);
    expect(sketch?.name).toHaveLength(60);
    expect(sketch?.watches).toHaveLength(80);
    expect(sketch?.choices).toEqual(["A", "B", "C", "D"]);
  });

  it("sends one strict, non-streaming request with its own short prompt", async () => {
    const { fetchImpl, calls } = mockFetch(() => answer({}));
    await run([SERV], fetchImpl);
    const body = calls[0]!.body;
    expect(Object.keys(body).sort()).toEqual(["max_tokens", "messages", "model", "response_format", "stream"]);
    expect(body).toMatchObject({ model: "claude-haiku-4.5", max_tokens: 200, stream: false });
    const messages = body.messages as { role: string; content: string }[];
    expect(messages[0]).toEqual({ role: "system", content: PLAN_PROMPT });
    expect(messages[1]!.content).toContain('"watches":"ETH price"');
    expect(messages[1]!.content).toContain(`Last reply: ${TURN.previous}`);
    expect(messages[1]!.content).toContain("Person: Every 5 minutes");
    expect(body.response_format).toMatchObject({ type: "json_schema", json_schema: { name: "agent_sketch", strict: true } });
  });
});

describe("the sketch schema", () => {
  // SERV rejects numeric range keywords; minItems and maxItems are left out too
  // and enforced in code.
  const BANNED = ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "minItems", "maxItems"];

  function keywords(node: unknown, found = new Set<string>()): Set<string> {
    if (Array.isArray(node)) node.forEach((n) => keywords(n, found));
    else if (node && typeof node === "object") {
      for (const [k, v] of Object.entries(node)) {
        found.add(k);
        keywords(v, found);
      }
    }
    return found;
  }

  it("has none of the banned keywords, and every property required with nothing extra", () => {
    const used = keywords(SKETCH_SCHEMA.schema);
    for (const k of BANNED) expect(used.has(k), k).toBe(false);
    expect(SKETCH_SCHEMA.schema.additionalProperties).toBe(false);
    expect([...SKETCH_SCHEMA.schema.required].sort()).toEqual(Object.keys(SKETCH_SCHEMA.schema.properties).sort());
  });

  it("uses no nullable types: unknown is an empty string or none", () => {
    expect(JSON.stringify(SKETCH_SCHEMA.schema)).not.toContain("null");
  });
});
