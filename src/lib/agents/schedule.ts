import type { AgentDefinition } from "./definition";

// When an agent runs, in its owner's time zone: a schedule (every hour, day
// or week, at a time of day), a value checked on an interval, or a message.
// Times are the owner's wall clock: "every day at 7:00" stays at 7:00 across
// daylight saving changes, and a time a change skips runs at the first
// minute after it. Shared by the server (to fire) and the pages (to say).

type Trigger = AgentDefinition["triggers"][number];

export interface ScheduleSpec {
  every: "hour" | "day" | "week";
  // The time of day; for hourly, only the minutes count.
  hour: number;
  minute: number;
  // For weekly: 0 is Sunday.
  day: number;
}

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

// A schedule trigger with the owner's own time and day over the maker's.
export function scheduleSpec(t: Extract<Trigger, { kind: "schedule" }>, own?: { at: string | null; day: number | null } | null): ScheduleSpec {
  const at = own?.at ?? t.at ?? "08:00";
  const [h, m] = at.split(":").map(Number);
  return { every: t.every, hour: h ?? 8, minute: m ?? 0, day: own?.day ?? 1 };
}

const pad = (n: number) => String(n).padStart(2, "0");

// In plain words: "every day at 7:00".
export function describeSchedule(s: ScheduleSpec): string {
  if (s.every === "hour") return s.minute === 0 ? "every hour, on the hour" : `every hour at :${pad(s.minute)}`;
  const time = `${s.hour}:${pad(s.minute)}`;
  return s.every === "day" ? `every day at ${time}` : `every ${DAYS[s.day]} at ${time}`;
}

export function describeCheck(everyMinutes: number): string {
  if (everyMinutes % 1440 === 0) return everyMinutes === 1440 ? "checks once a day" : `checks every ${everyMinutes / 1440} days`;
  if (everyMinutes % 60 === 0) return everyMinutes === 60 ? "checks every hour" : `checks every ${everyMinutes / 60} hours`;
  return `checks every ${everyMinutes} minutes`;
}

// Each trigger, in plain words, with the owner's schedule.
export function describeTriggers(d: Pick<AgentDefinition, "triggers">, own?: { at: string | null; day: number | null } | null): string[] {
  return d.triggers.map((t) => {
    if (t.kind === "schedule") return `Runs ${describeSchedule(scheduleSpec(t, own))}`;
    if (t.kind === "check") return `Runs when ${t.when}: ${describeCheck(t.everyMinutes)} (${t.watch})`;
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
  if (s.every === "hour") {
    for (let k = 0; k <= 49; k++) {
      const l = local(t + k * 3_600_000, tz);
      const at = zonedTime(l.y, l.m, l.d, l.h, s.minute, tz);
      if (at.getTime() > t) return at;
    }
  } else {
    const l = local(t, tz);
    for (let k = 0; k <= 8; k++) {
      const day = new Date(Date.UTC(l.y, l.m - 1, l.d + k));
      if (s.every === "week" && day.getUTCDay() !== s.day) continue;
      const at = zonedTime(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), s.hour, s.minute, tz);
      if (at.getTime() > t) return at;
    }
  }
  // Never reached for a valid schedule; a day on is a safe fallback.
  return new Date(t + 86_400_000);
}
