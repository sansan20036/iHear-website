// Wall-clock times in IANA time zones (2026-11-17). One module for the server (a lesson's start,
// the schedule import, a course's time zone) and the admin form's preview, so both read a time
// the same way. It has no server-only imports: it is bundled for the browser too.
//
// Lessons are kept as instants (UTC). A wall-clock time is converted once, when a lesson is made.
// The offset always comes from the zone's own rules (the runtime's time-zone data), never from a
// fixed number, so US daylight saving time (EDT UTC−4 in summer, EST UTC−5 in winter) is
// followed. A time the zone skips (the clocks go forward) or has twice (they go back) is refused,
// never guessed.

/** iHear schedules in US Eastern time first (Justine, 2026-11-17): the admin form's default. */
export const HOUSE_TIME_ZONE = "America/New_York";
/** What a lesson request without a time zone means: every caller before 2026-11-17 sent Taipei time. */
export const LEGACY_LESSON_TIME_ZONE = "Asia/Taipei";
/** The zones the admin form offers first; any other IANA zone can be searched. */
export const COMMON_TIME_ZONES = [
  "America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles",
  "Asia/Taipei", "Asia/Shanghai", "Asia/Tokyo", "Europe/London",
] as const;

export type WallDate = { y: number; m: number; d: number };
export type WallTime = { h: number; min: number };

/** A real IANA time zone with a region (America/New_York), not an offset or an abbreviation. */
export function validTimeZone(value: unknown): value is string {
  if (typeof value !== "string" || !/^[A-Za-z]+(\/[A-Za-z0-9_+-]+){1,2}$/.test(value)) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(0);
    return true;
  } catch {
    return false;
  }
}

/** YYYY-MM-DD naming a real calendar day (2026-02-30 is refused). */
export function parseIsoDate(value: unknown): WallDate | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value ?? "").trim());
  if (!match) return null;
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const check = new Date(Date.UTC(y, m - 1, d));
  return check.getUTCFullYear() === y && check.getUTCMonth() === m - 1 && check.getUTCDate() === d ? { y, m, d } : null;
}

/** HH:MM on a 24-hour clock. */
export function parseClock(value: unknown): WallTime | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(value ?? "").trim());
  return match ? { h: Number(match[1]), min: Number(match[2]) } : null;
}

const two = (value: number) => String(value).padStart(2, "0");

/** The zone's offset from UTC at an instant, in minutes: Taipei 480, New York −300 or −240. */
export function offsetMinutes(instant: number, timeZone: string) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(instant).map((part) => [part.type, part.value]));
  const asUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
  return Math.round((asUtc - instant) / 60_000);
}

/** A wall-clock time in a time zone as one instant; refused when the zone skips it or has it twice. */
export function zonedInstant(date: WallDate, time: WallTime, timeZone: string):
  { ok: true; instant: number } | { ok: false; reason: "NONEXISTENT" | "AMBIGUOUS" } {
  const wall = Date.UTC(date.y, date.m - 1, date.d, time.h, time.min);
  const offsets = new Set([-12, 0, 12].map((hours) => offsetMinutes(wall + hours * 3_600_000, timeZone)));
  const matches = [...new Set([...offsets].map((offset) => wall - offset * 60_000))].filter((instant) => offsetMinutes(instant, timeZone) === (wall - instant) / 60_000);
  if (!matches.length) return { ok: false, reason: "NONEXISTENT" };
  if (matches.length > 1) return { ok: false, reason: "AMBIGUOUS" };
  return { ok: true, instant: matches[0] };
}

/** The wall-clock date (YYYY-MM-DD) and time (HH:MM) of an instant in a zone. */
export function wallIn(instant: number, timeZone: string) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  }).formatToParts(instant).map((part) => [part.type, part.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

/** "UTC+08:00", "UTC−05:00" (a real minus sign), "UTC+05:45". */
export function formatUtcOffset(minutes: number) {
  const size = Math.abs(minutes);
  return `UTC${minutes < 0 ? "−" : "+"}${two(Math.floor(size / 60))}:${two(size % 60)}`;
}

/** The zone's usual abbreviation at an instant (EST, EDT, PST, GMT, BST), or null where the
 *  runtime knows only an offset ("GMT+8"); the UTC offset is always shown beside it. */
export function zoneAbbreviation(instant: number, timeZone: string): string | null {
  for (const locale of ["en-US", "en-GB"]) {
    const name = new Intl.DateTimeFormat(locale, { timeZone, timeZoneName: "short" }).formatToParts(instant).find((part) => part.type === "timeZoneName")?.value;
    if (name && !/^(GMT|UTC)[+−-]/.test(name)) return name;
  }
  return null;
}

/** An instant as people read it in a zone: the long date with its weekday, the 24-hour time, the
 *  abbreviation (when there is one) and the UTC offset. */
export function describeInstant(instant: number, timeZone: string, intlLocale: string) {
  const wall = wallIn(instant, timeZone);
  return {
    date: new Intl.DateTimeFormat(intlLocale, { timeZone, year: "numeric", month: "long", day: "numeric", weekday: "long" }).format(instant),
    weekday: new Intl.DateTimeFormat(intlLocale, { timeZone, weekday: "short" }).format(instant),
    time: wall.time,
    wallDate: wall.date,
    abbreviation: zoneAbbreviation(instant, timeZone),
    offset: formatUtcOffset(offsetMinutes(instant, timeZone)),
  };
}
