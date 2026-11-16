import { describe, expect, it } from "vitest";
import { inZone } from "./ownerTime";

// Times on every page are in the owner's own zone, whatever the browser's.

describe("a moment in the owner's zone", () => {
  it("is shown in that zone, not the browser's", () => {
    const at = "2026-11-16T20:36:52Z";
    expect(inZone(at, "Asia/Tokyo", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" })).toBe("05:36");
    expect(inZone(at, "Europe/Berlin", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" })).toBe("21:36");
    expect(inZone(null, "UTC")).toBe("");
  });
});
