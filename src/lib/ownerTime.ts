// A moment in its owner's own time zone (their account's: their browser's,
// or the one they chose), for any page that shows when something happened
// or will: never the browser's when they chose another, never the server's.
export function inZone(iso: string | null | undefined, zone: string, opts: Intl.DateTimeFormatOptions = {}): string {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleString(undefined, { ...opts, timeZone: zone });
  } catch {
    return new Date(iso).toLocaleString(undefined, opts);
  }
}
