// @vitest-environment node
import { describe, expect, it } from "vitest";
import { checkDefinition } from "./definition";
import { runAgent } from "./runner";
import { runInSandbox } from "./sandbox";
import { emptyBench, type RunEvent } from "./types";
import { zoneOffsetMinutes } from "./timeZone";

// A step's local time is its run's time zone: the renter's or the maker's,
// UTC when none is known, never the server's (which, for the live beta,
// is America/Los_Angeles).

const at = Date.UTC(2026, 10, 13, 16, 30, 0); // 13 Nov 2026, 16:30 UTC
const run = async (body: string, timeZone?: string) => {
  const r = await runInSandbox(`async function run(input) { ${body} }`, { at }, { allowed: [], call: async () => null, timeZone });
  if (!r.ok) throw new Error(r.error);
  return r.output;
};

describe("a step's local time", () => {
  it("is in the run's zone", async () => {
    expect(await run("const d = new Date(input.at); return { h: d.getHours(), day: d.getDate(), wd: d.getDay(), off: d.getTimezoneOffset() };", "Asia/Tokyo")).toEqual({ h: 1, day: 14, wd: 6, off: -540 });
    expect(await run("const d = new Date(input.at); return { h: d.getHours(), m: d.getMinutes(), off: d.getTimezoneOffset() };", "Asia/Kolkata")).toEqual({ h: 22, m: 0, off: -330 });
    expect(await run("return new Date(input.at).toLocaleDateString();", "Asia/Tokyo")).toBe("11/14/2026");
    expect(await run("return new Date(input.at).toLocaleString();", "Europe/London")).toBe("11/13/2026, 4:30:00 PM");
    expect(await run("return new Date(input.at).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });", "Asia/Tokyo")).toBe("Saturday, November 14");
    expect(await run("return new Date(input.at).toString();", "America/New_York")).toBe("Fri Nov 13 2026 11:30:00 GMT-0500 (America/New_York)");
  });

  it("is UTC when no zone is known, never the server's", async () => {
    expect(await run("const d = new Date(input.at); return [d.getHours(), d.getTimezoneOffset()];")).toEqual([16, 0]);
  });

  it("reads local components and local strings in the zone, and leaves UTC alone", async () => {
    expect(await run("return new Date(2026, 10, 13, 8, 0).toISOString();", "America/New_York")).toBe("2026-11-13T13:00:00.000Z");
    expect(await run("return new Date('2026-11-13T08:00').toISOString();", "Asia/Tokyo")).toBe("2026-11-12T23:00:00.000Z");
    expect(await run("return Date.parse('2026-11-13T08:00:00Z');", "Asia/Tokyo")).toBe(Date.UTC(2026, 10, 13, 8));
    expect(await run("return new Date(input.at).toISOString();", "Asia/Tokyo")).toBe("2026-11-13T16:30:00.000Z");
    expect(await run("const d = new Date(input.at); d.setHours(0, 0, 0, 0); return d.toISOString();", "Asia/Tokyo")).toBe("2026-11-13T15:00:00.000Z");
    expect(await run("return typeof Date.now() === 'number' && new Date() instanceof Date;", "Asia/Tokyo")).toBe(true);
  });

  it("follows the clocks changing", () => {
    expect(zoneOffsetMinutes("America/New_York", Date.UTC(2026, 6, 1))).toBe(-240);
    expect(zoneOffsetMinutes("America/New_York", Date.UTC(2026, 11, 1))).toBe(-300);
  });
});

describe("a run", () => {
  it("hands its time zone to every code step", async () => {
    const c = checkDefinition({
      format: 1,
      name: "Clock",
      job: { does: "Says the hour.", done: "Said." },
      triggers: [{ kind: "schedule", every: "day", at: "08:00", description: "Every day" }],
      settings: [],
      rules: [],
      memory: [],
      steps: [{ id: "hour", title: "The hour", kind: "code", inputs: [], outputs: ["zone"], description: "Return zone, the hour's offset.", tools: [], next: null }],
      actions: [],
      limits: { maxSteps: 2, maxRunSeconds: 10, maxSpendUsd: 0 },
    });
    if (!c.ok) throw new Error(c.errors.join("; "));
    const events: RunEvent[] = [];
    const code = { hour: { spec: "", status: "approved" as const, source: "async function run() { return { zone: new Date().getTimezoneOffset() }; }", rounds: 1, note: null, updatedAt: "" } };
    await runAgent({ definition: c.definition, code, bench: emptyBench(), dryRun: true, onEvent: (e) => events.push(e), timeZone: "Asia/Kolkata" });
    expect(events.find((e) => e.type === "step_done")).toMatchObject({ status: "ok", output: { zone: -330 } });
  });
});

