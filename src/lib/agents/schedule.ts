import type { AgentDefinition } from "./definition";

// When an agent runs, in its owner's time zone: a schedule (every N minutes
// or hours, every day at a time, or every week on some days at a time), a
// value checked on an interval, or a message. Times are the owner's wall
// clock: "every day at 7:00" stays at 7:00 across daylight saving changes,
// and a time a change skips runs at the first minute after it. Intervals
// count from the owner's midnight (every 15 minutes runs at :00, :15, :30
// and :45), and never run more often than the platform's minimum interval.
// Shared by the server (to fire) and the pages (to say).

import { minIntervalMinutes } from "./interval";

type Trigger = AgentDefinition["triggers"][number];

export interface ScheduleSpec {
  every: "minutes" | "hours" | "day" | "week";
  // Minutes or hours between runs (1 for a day or a week).
  interval: number;
  // The time of day; for hours, only the minutes count.
  hour: number;
  minute: number;
  // For weekly: 0 is Sunday.
  days: number[];
}

// What a renter set for themselves over the maker's schedule.
export interface OwnSchedule {
  at: string | null;
  day: number | null;
  days?: number[] | null;
  interval?: number | null;
}

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

// A schedule trigger with the owner's own time, days and interval over the
// maker's, kept to the platform's minimum interval.
export function scheduleSpec(t: Extract<Trigger, { kind: "schedule" }>, own?: OwnSchedule | null): ScheduleSpec {
  const every = t.every === "hour" ? "hours" : t.every;
  const at = own?.at ?? t.at ?? (every === "day" || every === "week" ? "08:00" : "00:00");
  const [h, m] = at.split(":").map(Number);
  const least = minIntervalMinutes();
  const asked = own?.interval ?? t.interval ?? 1;
  const interval = every === "minutes" ? Math.min(1440, Math.max(least, asked)) : every === "hours" ? Math.min(24, Math.max(Math.ceil(least / 60), asked)) : 1;
  const chosen = own?.days?.length ? own.days : own?.day !== null && own?.day !== undefined ? [own.day] : t.days?.length ? t.days : [1];
  return { every, interval, hour: h ?? 8, minute: m ?? 0, days: every === "week" ? [...new Set(chosen)].sort((a, b) => a - b) : [] };
}

const pad = (n: number) => String(n).padStart(2, "0");

const list = (words: string[]) => (words.length <= 1 ? words.join("") : `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`);

// In plain words: "every 15 minutes", "every day at 7:00".
export function describeSchedule(s: ScheduleSpec): string {
  if (s.every === "minutes") return s.interval % 60 === 0 ? (s.interval === 60 ? "every hour" : `every ${s.interval / 60} hours`) : `every ${s.interval} minutes`;
  if (s.every === "hours") {
    if (s.interval === 1) return s.minute === 0 ? "every hour, on the hour" : `every hour at :${pad(s.minute)}`;
    return `every ${s.interval} hours${s.minute === 0 ? "" : ` at :${pad(s.minute)}`}`;
  }
  const time = `${s.hour}:${pad(s.minute)}`;
  if (s.every === "day") return `every day at ${time}`;
  return s.days.length === 7 ? `every day at ${time}` : `every ${list(s.days.map((d) => DAYS[d]!))} at ${time}`;
}

export function describeCheck(everyMinutes: number): string {
  if (everyMinutes % 1440 === 0) return everyMinutes === 1440 ? "checks once a day" : `checks every ${everyMinutes / 1440} days`;
  if (everyMinutes % 60 === 0) return everyMinutes === 60 ? "checks every hour" : `checks every ${everyMinutes / 60} hours`;
  return `checks every ${everyMinutes} minutes`;
}

// A value check's interval, kept to the platform's minimum.
export const checkInterval = (everyMinutes: number) => Math.max(minIntervalMinutes(), everyMinutes);

// Each trigger, in plain words, with the owner's schedule.
export function describeTriggers(d: Pick<AgentDefinition, "triggers">, own?: OwnSchedule | null): string[] {
  return d.triggers.map((t) => {
    if (t.kind === "schedule") return `Runs ${describeSchedule(scheduleSpec(t, own))}`;
    if (t.kind === "check") return `Runs when ${t.when}: ${describeCheck(checkInterval(t.everyMinutes))} (${t.watch})`;
    return "Runs when you message it";
  });
}

// The wall clock in a time zone at an instant.
function local(at: number, tz: string): { y: number; m: number; d: number; h: number; mi: number; wd: number } {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", weekday: "short" }).formatToParts(at);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "0";
  return { y: Number(get("year")), m: Number(get("month")), d: Number(get("day")), h: Number(get("hour")) % 24, mi: Number(get("minute")), wd: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(get("weekday")) };
}

// How far the zone's clock is ahead of UTC at an instant, in milliseconds.
function offset(at: number, tz: string): number {
  const l = local(at, tz);
  return Date.UTC(l.y, l.m - 1, l.d, l.h, l.mi) - Math.floor(at / 60_000) * 60_000;
}

// The instant the zone's clock shows this wall time: the earlier one when
// the clock shows it twice (the hour going back), and the first minute after
// the change when the clock skips it (the hour going forward).
export function zonedTime(y: number, m: number, d: number, h: number, mi: number, tz: string): Date {
  const wall = Date.UTC(y, m - 1, d, h, mi);
  const a = wall - offset(wall, tz);
  const b = wall - offset(a, tz);
  const shows = [a, b].filter((t) => t + offset(t, tz) === wall);
  if (shows.length) return new Date(Math.min(...shows));
  let lo = Math.min(a, b);
  let hi = Math.max(a, b);
  const before = offset(lo, tz);
  while (hi - lo > 60_000) {
    const mid = Math.floor((lo + hi) / 120_000) * 60_000;
    if (offset(mid, tz) === before) lo = mid;
    else hi = mid;
  }
  return new Date(hi);
}

// The first run strictly after `after`.
export function nextRun(s: ScheduleSpec, tz: string, after: Date): Date {
  const t = after.getTime();
  if (s.every === "minutes") {
    // The next multiple of the interval since the owner's midnight.
    for (let k = 0; k <= 2; k++) {
      const l = local(t + k * 86_400_000, tz);
      const since = k === 0 ? l.h * 60 + l.mi : -1;
      for (let m = (Math.floor(since / s.interval) + 1) * s.interval; m < 1440; m += s.interval) {
        const day = new Date(Date.UTC(l.y, l.m - 1, l.d));
        const at = zonedTime(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), Math.floor(m / 60), m % 60, tz);
        if (at.getTime() > t) return at;
      }
    }
  } else if (s.every === "hours") {
    for (let k = 0; k <= 49; k++) {
      const l = local(t + k * 3_600_000, tz);
      if (l.h % s.interval !== 0) continue;
      const at = zonedTime(l.y, l.m, l.d, l.h, s.minute, tz);
      if (at.getTime() > t) return at;
    }
  } else {
    const l = local(t, tz);
    for (let k = 0; k <= 8; k++) {
      const day = new Date(Date.UTC(l.y, l.m - 1, l.d + k));
      if (s.every === "week" && !s.days.includes(day.getUTCDay())) continue;
      const at = zonedTime(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), s.hour, s.minute, tz);
      if (at.getTime() > t) return at;
    }
  }
  // Never reached for a valid schedule; a day on is a safe fallback.
  return new Date(t + 86_400_000);
}
