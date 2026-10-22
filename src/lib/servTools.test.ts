// @vitest-environment node
import { describe, expect, it } from "vitest";
import { modelConfig, requestBody, SERV_PROMPT_GUARD, type ChatMessage, type Provider } from "./model";

// Per-request SERV tools: declared to SERV only, never to another provider,
// and never on a chat request.

const SERV = modelConfig({ SERV_API_KEY: "test-serv-key" }).providers[0]!;
const BACKUP: Provider = { id: "fallback", label: "Backup", baseUrl: "https://backup.test/v1", apiKey: "test-backup-key", model: "backup-1", askForUsage: true };
const chat: ChatMessage[] = [
  { role: "system", content: "You write blurbs." },
  { role: "user", content: "A mug" },
];

describe("SERV tools on a request", () => {
  it("declares the prompt guard to SERV when asked", () => {
    expect(requestBody(SERV, chat, 400, SERV_PROMPT_GUARD).tools).toEqual([{ type: "function", function: { name: "serv_prompt_guard" } }]);
  });

  it("never sends them to another provider, where they would be callable functions", () => {
    expect(requestBody(BACKUP, chat, 400, SERV_PROMPT_GUARD).tools).toBeUndefined();
  });

  it("sends none by default, so the chat stays free of add-ons", () => {
    expect(requestBody(SERV, chat, 400).tools).toBeUndefined();
  });
});
