import { describe, expect, it } from "vitest";
import { chatNames } from "./chatNames";

// What each chat is called in the agents list: two that would look the
// same never do.

const chat = (id: string, o: { title?: string; sketchName?: string | null; createdAt: string }) => ({ id, title: o.title ?? "New conversation", sketchName: o.sketchName ?? null, createdAt: o.createdAt });

describe("chat names", () => {
  it("go by the agent's name, or by the first message when there's no sketch", () => {
    const names = chatNames([
      chat("a", { title: "Check my hackathon sheet every 15 minutes", sketchName: "Hackathon Submission Checker", createdAt: "2026-11-10T09:00:00Z" }),
      chat("b", { title: "Daily Gmail summary", createdAt: "2026-11-10T10:00:00Z" }),
    ]);
    expect(names.get("a")).toEqual({ name: "Hackathon Submission Checker", detail: null });
    expect(names.get("b")).toEqual({ name: "Daily Gmail summary", detail: null });
  });

  it("tell two chats with the same name apart by when they were started, and by a count when even that is the same", () => {
    const names = chatNames([
      chat("first", { sketchName: "Hackathon Submission Checker", createdAt: "2026-11-10T09:00:00Z" }),
      chat("second", { sketchName: "hackathon submission checker", createdAt: "2026-11-10T21:30:00Z" }),
      chat("twin-a", { title: "New conversation", createdAt: "2026-11-11T08:15:05Z" }),
      chat("twin-b", { title: "New conversation", createdAt: "2026-11-11T08:15:40Z" }),
    ]);
    const shown = ["first", "second", "twin-a", "twin-b"].map((id) => `${names.get(id)!.name} (${names.get(id)!.detail})`);
    expect(new Set(shown).size).toBe(4);
    expect(names.get("first")!.detail).toMatch(/^started 10 Nov/);
    expect(names.get("second")!.detail).not.toBe(names.get("first")!.detail);
    expect(names.get("twin-a")!.detail).toMatch(/, 1 of 2$/);
    expect(names.get("twin-b")!.detail).toMatch(/, 2 of 2$/);
  });
});
