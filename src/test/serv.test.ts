import { describe, expect, it } from "vitest";
import { ensureSystemMessage, sanitizeJsonSchema, SYSTEM_PROMPT, type ChatMessage } from "@/lib/serv";

describe("SERV request rules", () => {
  it("guarantees a system message (SERV rejects a request without one)", () => {
    const user: ChatMessage[] = [{ role: "user", content: "hi" }];
    const out = ensureSystemMessage(user);
    expect(out[0]?.role).toBe("system");
    expect(out[0]?.content).toBe(SYSTEM_PROMPT);
    expect(out).toHaveLength(2);
  });

  it("does not add a second system message when one exists", () => {
    const msgs: ChatMessage[] = [
      { role: "system", content: "custom" },
      { role: "user", content: "hi" },
    ];
    expect(ensureSystemMessage(msgs)).toHaveLength(2);
  });

  it("strips numeric range keywords from a json schema (SERV rejects them)", () => {
    const schema = {
      type: "object",
      properties: {
        amount: { type: "number", minimum: 0, maximum: 100, exclusiveMinimum: 1, multipleOf: 2 },
        name: { type: "string", minLength: 1, maxLength: 20 },
        tags: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 5 },
      },
    };
    const clean = sanitizeJsonSchema(schema);
    const json = JSON.stringify(clean);
    for (const k of ["minimum", "maximum", "exclusiveMinimum", "multipleOf", "minLength", "maxLength", "minItems", "maxItems"]) {
      expect(json).not.toContain(k);
    }
    // Shape is otherwise preserved.
    expect(clean.properties.amount.type).toBe("number");
    expect(clean.properties.tags.items.type).toBe("string");
  });
});
