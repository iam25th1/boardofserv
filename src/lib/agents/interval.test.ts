import { afterEach, describe, expect, it, vi } from "vitest";
import { restockDefinition } from "@/test/runtimeFixtures";
import { checkDefinition } from "./definition";
import { describeSchedule, describeTriggers, nextRun, scheduleSpec } from "./schedule";
import { checkAnswers } from "./settingsForm";
import { runsPerWeek } from "./metering";
import { wireToDefinition } from "./plan";
import { RESTOCK_WIRE } from "@/test/agentFixtures";

// Schedules: every N minutes or hours, every day at a time, every week on
// days at a time, in the renter's time zone, never more often than the
// platform's minimum interval, and the planner can say each of them.

afterEach(() => vi.unstubAllEnvs());

type Schedule = Extract<ReturnType<typeof restockDefinition>["triggers"][number], { kind: "schedule" }>;
const sched = (t: Partial<Schedule>): Schedule => ({ kind: "schedule", every: "day", at: null, description: "x", ...t }) as Schedule;
const at = (iso: string) => new Date(iso);

describe("intervals", () => {
  it("run every 15 minutes from the renter's midnight, across it, in their time zone", () => {
    const s = scheduleSpec(sched({ every: "minutes", interval: 15 }));
    expect(describeSchedule(s)).toBe("every 15 minutes");
    expect(nextRun(s, "UTC", at("2026-11-12T10:07:00Z")).toISOString()).toBe("2026-11-12T10:15:00.000Z");
    expect(nextRun(s, "UTC", at("2026-11-12T10:15:00Z")).toISOString()).toBe("2026-11-12T10:30:00.000Z");
    expect(nextRun(s, "UTC", at("2026-11-12T23:50:00Z")).toISOString()).toBe("2026-11-13T00:00:00.000Z");
    // 10:07 in New York is 15:07 UTC.
    expect(nextRun(s, "America/New_York", at("2026-11-12T15:07:00Z")).toISOString()).toBe("2026-11-12T15:15:00.000Z");
  });

  it("run every N hours at minutes past, and every week on some days at a time", () => {
    const h = scheduleSpec(sched({ every: "hours", interval: 2, at: "00:30" }));
    expect(describeSchedule(h)).toBe("every 2 hours at :30");
    expect(nextRun(h, "UTC", at("2026-11-12T10:45:00Z")).toISOString()).toBe("2026-11-12T12:30:00.000Z");
    const w = scheduleSpec(sched({ every: "week", days: [1, 4], at: "09:00" }));
    expect(describeSchedule(w)).toBe("every Monday and Thursday at 9:00");
    // 2026-11-12 is a Thursday.
    expect(nextRun(w, "UTC", at("2026-11-12T10:00:00Z")).toISOString()).toBe("2026-11-16T09:00:00.000Z");
    expect(nextRun(w, "UTC", at("2026-11-12T08:00:00Z")).toISOString()).toBe("2026-11-12T09:00:00.000Z");
    // The renter's own days and time win.
    expect(describeSchedule(scheduleSpec(sched({ every: "week", days: [1], at: "09:00" }), { at: "18:15", day: null, days: [2, 5] }))).toBe("every Tuesday and Friday at 18:15");
    // "hour" from before intervals is every hour.
    expect(describeSchedule(scheduleSpec(sched({ every: "hour", at: null })))).toBe("every hour, on the hour");
  });

  it("never run more often than the platform's minimum", () => {
    expect(scheduleSpec(sched({ every: "minutes", interval: 5 })).interval).toBe(15);
    vi.stubEnv("AGENT_MIN_INTERVAL_MINUTES", "30");
    expect(scheduleSpec(sched({ every: "minutes", interval: 15 })).interval).toBe(30);
    expect(scheduleSpec(sched({ every: "minutes", interval: 15 }), { at: null, day: null, interval: 1 }).interval).toBe(30);
    expect(describeTriggers({ triggers: [{ kind: "check", everyMinutes: 10, watch: "the price", when: "it drops", step: "c" }] })).toEqual(["Runs when it drops: checks every 30 minutes (the price)"]);
  });
});

describe("checking plans and answers", () => {
  const plan = (triggers: unknown[]) => checkDefinition({ ...restockDefinition(), triggers });

  it("refuses a plan that runs more often than the minimum, or names no hours or days", () => {
    expect(plan([{ kind: "schedule", every: "minutes", interval: 15, at: null, description: "Every 15 minutes" }]).ok).toBe(true);
    const fast = plan([{ kind: "schedule", every: "minutes", interval: 5, at: null, description: "x" }]);
    expect(fast.ok ? [] : fast.errors.join(" ")).toMatch(/a schedule runs at most every 15 minutes/);
    const hours = plan([{ kind: "schedule", every: "hours", at: null, description: "x" }]);
    expect(hours.ok ? [] : hours.errors.join(" ")).toMatch(/says every how many hours/);
    const days = plan([{ kind: "schedule", every: "week", days: [], at: "09:00", description: "x" }]);
    expect(days.ok ? [] : days.errors.join(" ")).toMatch(/names at least one day/);
  });

  it("takes a renter's own interval and days within the rules", () => {
    const d = { settings: [], rules: [], triggers: [sched({ every: "minutes", interval: 30 })] };
    const ok = checkAnswers(d, { settings: {}, rules: {}, timezone: "UTC", schedule: { at: null, day: null, interval: 45 } });
    expect(ok.ok ? ok.schedule : null).toEqual({ at: null, day: null, days: null, interval: 45 });
    const tooFast = checkAnswers(d, { settings: {}, rules: {}, timezone: "UTC", schedule: { at: null, day: null, interval: 5 } });
    expect(tooFast.ok ? null : tooFast.errors.schedule).toBe("Give whole minutes, at least 15.");
    const w = { settings: [], rules: [], triggers: [sched({ every: "week", days: [1], at: "09:00" })] };
    const noDays = checkAnswers(w, { settings: {}, rules: {}, timezone: "UTC", schedule: { at: "09:00", day: null, days: [] } });
    expect(noDays.ok ? null : noDays.errors.schedule).toBe("Pick at least one day of the week.");
  });
});

describe("the planner", () => {
  it("can say every 15 minutes and twice a week as schedules", () => {
    const d = wireToDefinition({
      ...RESTOCK_WIRE,
      triggers: [
        { kind: "schedule", every: "minutes", at: "", everyMinutes: 15, watch: "", when: "", step: "", description: "Every 15 minutes" },
        { kind: "schedule", every: "week", at: "09:00", everyMinutes: 0, watch: "", when: "monday, Thursday", step: "", description: "Twice a week" },
      ],
    }) as { triggers: unknown[] };
    expect(d.triggers).toEqual([
      { kind: "schedule", every: "minutes", interval: 15, at: null, description: "Every 15 minutes" },
      { kind: "schedule", every: "week", at: "09:00", days: [1, 4], description: "Twice a week" },
    ]);
    expect(runsPerWeek({ triggers: d.triggers } as never)).toBe(672 + 2);
  });
});
