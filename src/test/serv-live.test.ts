// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { ReplyEvent } from "@/lib/model";

// A live demonstration of the model layer in model.ts: one real SERV Reasoning
// reply (a few dozen tokens at most), and one forced fallback where a local
// server stands in for both providers: SERV answers 402, the backup streams.
// The SERV reply runs only with RUN_SERV_DEMO=1 and SERV_API_KEY in the
// environment. The forced fallback is all local, so it always runs.
const enabled = process.env.RUN_SERV_DEMO === "1" && Boolean(process.env.SERV_API_KEY);
const maybe = enabled ? it : it.skip;

let mock: Server;
let mockUrl = "";

async function collect(gen: AsyncIterable<ReplyEvent>): Promise<{ text: string; events: ReplyEvent[] }> {
  const events: ReplyEvent[] = [];
  let text = "";
  for await (const ev of gen) {
    events.push(ev);
    if (ev.type === "delta") text += ev.text;
  }
  return { text, events };
}

beforeAll(async () => {
  mock = createServer((req, res) => {
    if (req.url?.startsWith("/serv/")) {
      res.writeHead(402, { "content-type": "application/json" }).end(JSON.stringify({ error: "out of credit" }));
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const word of "This reply comes from the local backup model, not from SERV.".split(" ")) {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: `${word} ` } }] })}\n\n`);
    }
    res.end("data: [DONE]\n\n");
  });
  await new Promise<void>((r) => mock.listen(0, r));
  mockUrl = `http://localhost:${(mock.address() as AddressInfo).port}`;
});

afterAll(() => {
  mock?.close();
});

describe("model layer, live", () => {
  maybe("a SERV reply streams and is labelled SERV Reasoning", async () => {
    const { modelConfig, streamReply } = await import("@/lib/model");
    // A live call spends real credit: keep the reply tiny.
    const config = modelConfig({ SERV_API_KEY: process.env.SERV_API_KEY, CHAT_MAX_TOKENS: "40" });
    const { text, events } = await collect(
      streamReply([{ role: "user", content: "In one short sentence, what will boardofserv help me do?" }], { config, signal: new AbortController().signal }),
    );
    const end = events.at(-1);
    console.log(`\n[SERV demo] ${JSON.stringify(end?.type === "end" ? { ...end.result, failures: end.result.failures.length } : end)}\n${text}\n`);
    expect(end?.type === "end" && end.result.provider).toBe("serv");
    expect(text.length).toBeGreaterThan(0);
  }, 45_000);

  it("SERV out of credit falls back to the backup, labelled as the backup", async () => {
    const { streamReply } = await import("@/lib/model");
    const serv = { id: "serv" as const, label: "SERV Reasoning", baseUrl: `${mockUrl}/serv`, apiKey: "local", model: "claude-haiku-4.5", askForUsage: false };
    const backup = { id: "fallback" as const, label: "Local backup", baseUrl: `${mockUrl}/backup`, apiKey: "local", model: "demo-echo", askForUsage: true };
    const { text, events } = await collect(
      streamReply([{ role: "user", content: "Say hello." }], { config: { providers: [serv, backup], firstTokenTimeoutMs: 5_000, historyMessages: 12, maxTokens: 50, extractMaxTokens: 50 }, signal: new AbortController().signal }),
    );
    const end = events.at(-1);
    expect(end?.type === "end" && end.result.outcome).toBe("fell_back");
    expect(events.find((e) => e.type === "start")).toMatchObject({ provider: "fallback", label: "Local backup" });
    expect(text).toContain("backup");
  }, 20_000);
});
