// @vitest-environment node
import { describe, expect, it } from "vitest";

// A live check of the sketch block against the real SERV model: the three
// example prompts from the empty state, one call each (max_tokens 400),
// through the same model layer, splitter and parser as /api/chat.
// Runs only with RUN_SKETCH_LIVE=1 and SERV_API_KEY in the environment.
const enabled = process.env.RUN_SKETCH_LIVE === "1" && Boolean(process.env.SERV_API_KEY);

const PROMPTS = [
  "Tell me when ETH drops below $2,000",
  "Send me the three biggest AI stories every morning",
  "A Telegram bot that answers questions about my shop",
];

describe.runIf(enabled)("the sketch block, live", () => {
  it.each(PROMPTS)("%s", async (prompt) => {
    const { modelConfig, streamReply } = await import("@/lib/model");
    const { parseSketchBlock, SketchSplitter } = await import("@/lib/sketchBlock");
    const config = modelConfig({ SERV_API_KEY: process.env.SERV_API_KEY, CHAT_MAX_TOKENS: "400" });
    const split = new SketchSplitter();
    let shown = "";
    let result;
    for await (const ev of streamReply([{ role: "user", content: prompt }], { config, signal: new AbortController().signal })) {
      if (ev.type === "delta") shown += split.push(ev.text);
      if (ev.type === "end") result = ev.result;
    }
    const { rest, raw } = split.finish();
    shown += rest;
    const sketch = parseSketchBlock(raw);
    console.log(
      `\n[sketch live] ${prompt}\n` +
        `${JSON.stringify({ outcome: result?.outcome, failures: result?.failures, promptTokens: result?.promptTokens, completionTokens: result?.completionTokens, firstTokenMs: result?.firstTokenMs, blockFound: raw !== null, sketchValid: sketch !== null })}\n` +
        `reply: ${shown.trim()}\nsketch: ${JSON.stringify(sketch)}\n`,
    );
    expect(result?.outcome).toBe("ok");
    expect(sketch).not.toBeNull();
  }, 60_000);
});
