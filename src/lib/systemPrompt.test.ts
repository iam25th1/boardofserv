import { describe, expect, it } from "vitest";
import { askLine, replySystemPrompt, SYSTEM_PROMPT } from "./systemPrompt";
import type { SketchDTO } from "./types";

// What the reply is told to ask, from the stored sketch and the turn's plan.

const half: SketchDTO = { name: "ETH floor watch", kind: "watcher", watches: "ETH price", when: "below $2,000", how: null, tells: null, asking: "how", live: false };
const full: SketchDTO = { ...half, how: "every 5 minutes", tells: "Telegram", asking: null };

describe("askLine", () => {
  it("asks the planned field, in words that fit the exact buttons", () => {
    expect(askLine(half, { asking: "how", choices: ["Every minute", "Every hour"] })).toBe(
      'Ask about: how (how often it checks). The user will see these buttons: "Every minute", "Every hour". Your question must fit them.',
    );
    expect(askLine(half, { asking: "tells", choices: [] })).toBe("Ask about: tells (where it tells them).");
  });

  it("confirms a fully described agent when there is nothing to ask", () => {
    expect(askLine(full, { asking: null, choices: [] })).toBe(
      "The agent is fully described: confirm that, say switching it on comes in the next update, and ask nothing.",
    );
  });

  it("lets the reply pick its question with no plan, or a plan that asks nothing while a field is empty", () => {
    expect(askLine(half, null)).toBe("Ask about the most important missing piece.");
    expect(askLine(null, null)).toBe("Ask about the most important missing piece.");
    expect(askLine(half, { asking: null, choices: [] })).toBe("Ask about the most important missing piece.");
  });

  it("goes in the reply's system message after the known sketch line", () => {
    expect(replySystemPrompt(half, { asking: "how", choices: ["Every hour"] }).split("\n")).toEqual([
      SYSTEM_PROMPT,
      "Known so far: name ETH floor watch, kind watcher, watches ETH price, when below $2,000; missing: how, tells.",
      'Ask about: how (how often it checks). The user will see these buttons: "Every hour". Your question must fit them.',
    ]);
  });
});
