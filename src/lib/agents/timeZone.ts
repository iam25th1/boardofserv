// A run's time zone, inside the sandbox. QuickJS reads local time from the
// host, so code a step runs (new Date().getHours(), toLocaleDateString())
// would see the server's own zone. Instead the sandbox's Date keeps time
// in the zone the run belongs to: the renter's (an installation's) or the
// maker's (a test), and UTC when none is known, never the server's.

// Minutes the zone is ahead of UTC at that moment (DST included).
export function zoneOffsetMinutes(timeZone: string, ms: number): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" }).formatToParts(new Date(ms));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return Math.round((asUtc - (ms - (((ms % 1000) + 1000) % 1000))) / 60_000);
}

export function knownZone(timeZone: string | null | undefined): string {
  if (!timeZone) return "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return timeZone;
  } catch {
    return "UTC";
  }
}

// The sandbox's Date, in the run's zone: local fields, local components,
// local strings and their parsing all go by __tzOffset (the host's answer
// for the zone), and everything in UTC stays as it is.
export const ZONED_DATE = `(() => {
  const Real = Date;
  const offsetAt = globalThis.__tzOffset;
  const zone = globalThis.__tzName;
  delete globalThis.__tzOffset;
  delete globalThis.__tzName;
  const P = Real.prototype;
  const time = (d) => P.getTime.call(d);
  const off = (t) => (Number.isFinite(t) ? offsetAt(t) : 0);
  const shifted = (t) => new Real(t + off(t) * 60000);
  // A local wall time to its moment: the offset found again once, for the
  // hour a change of clocks moves.
  const fromLocal = (wall) => {
    let t = wall - off(wall) * 60000;
    const again = off(t);
    if (wall - again * 60000 !== t) t = wall - again * 60000;
    return t;
  };
  const NO_ZONE = /^\\d{4}-\\d{2}-\\d{2}[T ]\\d{2}:\\d{2}(?::\\d{2}(?:\\.\\d+)?)?$/;
  const HAS_ZONE = /(?:Z|[+-]\\d{2}:?\\d{2}|GMT|UTC)\\s*$/i;
  const parseLocal = (s) => {
    const host = Real.parse(s);
    if (!Number.isFinite(host) || /^\\d{4}-\\d{2}-\\d{2}$/.test(s.trim()) || HAS_ZONE.test(s.trim())) return host;
    // Read as the host's local time: back to its wall time, then into this zone.
    const wall = NO_ZONE.test(s.trim()) ? Real.parse(s.trim().replace(" ", "T") + "Z") : host - P.getTimezoneOffset.call(new Real(host)) * 60000;
    return fromLocal(wall);
  };
  const pad = (n, w = 2) => String(n).padStart(w, "0");
  const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const gmt = (t) => {
    const o = off(t);
    return "GMT" + (o < 0 ? "-" : "+") + pad(Math.floor(Math.abs(o) / 60)) + pad(Math.abs(o) % 60);
  };
  class ZonedDate extends Real {
    constructor(...a) {
      if (a.length >= 2) super(fromLocal(Real.UTC(a[0], a[1], a.length > 2 ? a[2] : 1, a[3] || 0, a[4] || 0, a[5] || 0, a[6] || 0)));
      else if (a.length === 1 && typeof a[0] === "string") super(parseLocal(a[0]));
      else super(...a);
    }
    static parse(s) {
      return parseLocal(String(s));
    }
    getTimezoneOffset() {
      return -off(time(this));
    }
  }
  const local = { FullYear: "getUTCFullYear", Month: "getUTCMonth", Date: "getUTCDate", Day: "getUTCDay", Hours: "getUTCHours", Minutes: "getUTCMinutes", Seconds: "getUTCSeconds", Milliseconds: "getUTCMilliseconds" };
  for (const [name, utc] of Object.entries(local)) {
    ZonedDate.prototype["get" + name] = function () {
      const t = time(this);
      return Number.isFinite(t) ? P[utc].call(shifted(t)) : NaN;
    };
    if (name === "Day") continue;
    ZonedDate.prototype["set" + name] = function (...args) {
      const t = time(this);
      const s = shifted(Number.isFinite(t) ? t : 0);
      P["setUTC" + name].apply(s, args);
      return P.setTime.call(this, fromLocal(time(s)));
    };
  }
  const parts = (d) => {
    const s = shifted(time(d));
    return { y: P.getUTCFullYear.call(s), mo: P.getUTCMonth.call(s), d: P.getUTCDate.call(s), wd: P.getUTCDay.call(s), h: P.getUTCHours.call(s), mi: P.getUTCMinutes.call(s), se: P.getUTCSeconds.call(s) };
  };
  const dateText = (p, o) => {
    if (o && (o.weekday || o.month === "long" || o.month === "short")) {
      const month = o.month === "short" ? MONTHS[p.mo].slice(0, 3) : MONTHS[p.mo];
      const wd = o.weekday === "short" ? DAYS[p.wd].slice(0, 3) : DAYS[p.wd];
      return [o.weekday ? wd + "," : "", o.month ? month : "", o.day ? String(p.d) + (o.year ? "," : "") : "", o.year ? String(p.y) : ""].filter(Boolean).join(" ");
    }
    return (p.mo + 1) + "/" + p.d + "/" + p.y;
  };
  const timeText = (p) => (p.h % 12 || 12) + ":" + pad(p.mi) + ":" + pad(p.se) + " " + (p.h < 12 ? "AM" : "PM");
  const valid = (d) => Number.isFinite(time(d));
  ZonedDate.prototype.toString = function () {
    if (!valid(this)) return "Invalid Date";
    const p = parts(this);
    return DAYS[p.wd].slice(0, 3) + " " + MONTHS[p.mo].slice(0, 3) + " " + pad(p.d) + " " + p.y + " " + pad(p.h) + ":" + pad(p.mi) + ":" + pad(p.se) + " " + gmt(time(this)) + " (" + zone + ")";
  };
  ZonedDate.prototype.toDateString = function () {
    if (!valid(this)) return "Invalid Date";
    const p = parts(this);
    return DAYS[p.wd].slice(0, 3) + " " + MONTHS[p.mo].slice(0, 3) + " " + pad(p.d) + " " + p.y;
  };
  ZonedDate.prototype.toTimeString = function () {
    if (!valid(this)) return "Invalid Date";
    const p = parts(this);
    return pad(p.h) + ":" + pad(p.mi) + ":" + pad(p.se) + " " + gmt(time(this)) + " (" + zone + ")";
  };
  ZonedDate.prototype.toLocaleDateString = function (_l, o) {
    return valid(this) ? dateText(parts(this), o) : "Invalid Date";
  };
  ZonedDate.prototype.toLocaleTimeString = function () {
    return valid(this) ? timeText(parts(this)) : "Invalid Date";
  };
  ZonedDate.prototype.toLocaleString = function (_l, o) {
    if (!valid(this)) return "Invalid Date";
    const p = parts(this);
    return dateText(p, o) + ", " + timeText(p);
  };
  Object.defineProperty(globalThis, "Date", { value: ZonedDate, writable: true, configurable: true });
})();`;
