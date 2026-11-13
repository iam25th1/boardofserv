import { describe, expect, it } from "vitest";
import { backTo } from "./backTo";

describe("where a page may send someone back to", () => {
  it("is a path inside the app, never another site", () => {
    expect(backTo("/app/chat?c=1234")).toBe("/app/chat?c=1234");
    expect(backTo("https://evil.example/app/chat")).toBeNull();
    expect(backTo("//evil.example/app")).toBeNull();
    expect(backTo("/app//evil.example")).toBeNull();
    expect(backTo("/login")).toBeNull();
    expect(backTo("/app/chat\\x")).toBeNull();
    expect(backTo(null)).toBeNull();
  });
});
