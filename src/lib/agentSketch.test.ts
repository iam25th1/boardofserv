import { describe, expect, it } from "vitest";
import { isReady, linksOf, nodesOf, statusLine, type AgentSketch } from "./agentSketch";

const empty: AgentSketch = {
  name: "",
  watches: { value: "", status: "empty" },
  when: { value: "", status: "empty" },
  how: { value: "", status: "empty" },
  tells: { value: "", status: "empty" },
  cost: null,
  live: false,
};

const set = (value: string) => ({ value, status: "set" as const });

describe("agent sketch", () => {
  it("starts with every node off and says it is sketching", () => {
    expect(nodesOf(empty)).toEqual({ watch: "off", decide: "off", tell: "off" });
    expect(linksOf(nodesOf(empty))).toEqual([false, false]);
    expect(statusLine(empty, false)).toBe("Sketching");
  });

  it("fills decide only when both when and how are set", () => {
    const half = { ...empty, watches: set("ETH"), when: set("Below $2,000") };
    expect(nodesOf(half).decide).toBe("off");
    const both = { ...half, how: set("Every 5 minutes") };
    expect(nodesOf(both).decide).toBe("on");
    expect(linksOf(nodesOf(both))).toEqual([true, false]);
  });

  it("marks a node waiting on the user and says so", () => {
    const waiting = { ...empty, watches: set("ETH"), when: set("x"), how: set("y"), tells: { value: "", status: "waiting" as const } };
    expect(nodesOf(waiting).tell).toBe("ask");
    expect(isReady(waiting)).toBe(false);
    expect(statusLine(waiting, false)).toBe("Waiting on one answer from you");
  });

  it("is ready when all three nodes are filled, then live or paused", () => {
    const ready = { ...empty, watches: set("ETH"), when: set("x"), how: set("y"), tells: set("Telegram") };
    expect(isReady(ready)).toBe(true);
    expect(linksOf(nodesOf(ready))).toEqual([true, true]);
    expect(statusLine(ready, false)).toBe("Ready. Flip the switch to start it");
    expect(statusLine({ ...ready, live: true }, false)).toBe("Running on your credit");
    expect(statusLine(ready, true)).toBe("Paused");
  });
});
