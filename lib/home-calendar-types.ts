// The homepage calendar: one published document of events that administrators manage in
// /admin/calendar and visitors see on the homepage. Times are entered and stored in Taipei
// time (UTC+8, no daylight saving); visitors elsewhere also see their own local time.
// Event text is entered once and shown in every site language.

export const HOME_CALENDAR_KEY = "home_calendar_v1";
export const HOME_CALENDAR_TIME_ZONE = "Asia/Taipei";
export const HOME_CALENDAR_MAX_EVENTS = 200;
export const HOME_CALENDAR_LIMITS = { title: 120, description: 1000, linkUrl: 500, linkLabel: 60 } as const;
// The largest document (200 events at every limit) stays under the 400,000-character
// database limit of migration 027; the request limit leaves room for JSON escaping.
export const HOME_CALENDAR_MAX_BODY_BYTES = 900_000;
export const HOME_CALENDAR_MAX_RECORD_VERSION = 2_147_483_647;

export type HomeCalendarLink = { url: string; label: string };
export type HomeCalendarEvent = {
  id: string;
  title: string;
  date: string;
  startTime: string | null;
  endTime: string | null;
  description: string;
  link: HomeCalendarLink | null;
};
export type HomeCalendarConfig = { schemaVersion: 1; timeZone: typeof HOME_CALENDAR_TIME_ZONE; events: HomeCalendarEvent[] };
export type HomeCalendarRecord = { config: HomeCalendarConfig; recordVersion: number; updatedAt: string; updatedBy: string };
export type HomeCalendarValidationCode = "required" | "too_long" | "single_line" | "unsupported" | "invalid_date" | "invalid_time"
  | "end_before_start" | "invalid_link" | "duplicate_id" | "too_many" | "invalid_request" | "too_large";

export class HomeCalendarValidationError extends Error {
  constructor(message: string, readonly field = "config", readonly code: HomeCalendarValidationCode = "invalid_request", readonly status = 400) {
    super(message);
    this.name = "HomeCalendarValidationError";
  }
}

export function emptyHomeCalendar(): HomeCalendarConfig {
  return { schemaVersion: 1, timeZone: HOME_CALENDAR_TIME_ZONE, events: [] };
}

const ID = /^[a-z0-9][a-z0-9-]{7,39}$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
// Control characters (other than a newline in the description), lone surrogates and
// the Unicode noncharacters cannot be stored.
const UNSUPPORTED = /[\u0000-\u0009\u000B-\u001F\u007F-\u009F￾￿]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

export function homeCalendarCharacterCount(value: string) {
  return [...value].length;
}

function plainObject(value: unknown, field: string, keys: string[]) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HomeCalendarValidationError("Submit a calendar object.", field);
  const fields = value as Record<string, unknown>;
  if (Object.keys(fields).some(key => !keys.includes(key))) throw new HomeCalendarValidationError("The calendar contains unsupported fields.", field);
  return fields;
}

function text(value: unknown, field: string, max: number, options: { required: boolean; multiline: boolean }) {
  if (value === undefined || value === null) value = "";
  if (typeof value !== "string") throw new HomeCalendarValidationError("Enter text.", field);
  const normalized = value.replace(/\r\n?/g, "\n").trim();
  if (options.required && !normalized) throw new HomeCalendarValidationError("This field is required.", field, "required");
  if (!options.multiline && normalized.includes("\n")) throw new HomeCalendarValidationError("Keep this field on one line.", field, "single_line");
  if (UNSUPPORTED.test(normalized.replace(/\n/g, " "))) throw new HomeCalendarValidationError("Remove unsupported characters.", field, "unsupported");
  if (homeCalendarCharacterCount(normalized) > max) throw new HomeCalendarValidationError(`Use at most ${max} characters.`, field, "too_long");
  return normalized;
}

/** A real calendar date from 2000-01-01 to 2100-12-31. */
export function validHomeCalendarDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = DATE.exec(value);
  if (!match) return false;
  const [year, month, day] = match.slice(1).map(Number);
  if (year < 2000 || year > 2100) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function time(value: unknown, field: string) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !TIME.test(value)) throw new HomeCalendarValidationError("Enter a time as HH:MM.", field, "invalid_time");
  return value;
}

function link(value: unknown, field: string): HomeCalendarLink | null {
  if (value === undefined || value === null) return null;
  const fields = plainObject(value, field, ["url", "label"]);
  const url = text(fields.url, `${field}.url`, HOME_CALENDAR_LIMITS.linkUrl, { required: false, multiline: false });
  const label = text(fields.label, `${field}.label`, HOME_CALENDAR_LIMITS.linkLabel, { required: false, multiline: false });
  if (!url) {
    if (label) throw new HomeCalendarValidationError("Enter the link address.", `${field}.url`, "required");
    return null;
  }
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new HomeCalendarValidationError("Enter a full web address starting with https://.", `${field}.url`, "invalid_link"); }
  // Only web links: no javascript:, data: or mailto: addresses and no embedded credentials.
  if (!["https:", "http:"].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password || /\s/.test(url)) {
    throw new HomeCalendarValidationError("Enter a full web address starting with https://.", `${field}.url`, "invalid_link");
  }
  return { url, label };
}

function event(value: unknown, index: number): HomeCalendarEvent {
  const field = `events.${index}`;
  const fields = plainObject(value, field, ["id", "title", "date", "startTime", "endTime", "description", "link"]);
  if (typeof fields.id !== "string" || !ID.test(fields.id)) throw new HomeCalendarValidationError("Reload the calendar before saving.", `${field}.id`);
  if (!validHomeCalendarDate(fields.date)) throw new HomeCalendarValidationError("Choose a date.", `${field}.date`, "invalid_date");
  const startTime = time(fields.startTime, `${field}.startTime`);
  const endTime = time(fields.endTime, `${field}.endTime`);
  if (endTime && !startTime) throw new HomeCalendarValidationError("Enter a start time first.", `${field}.startTime`, "required");
  if (startTime && endTime && endTime <= startTime) throw new HomeCalendarValidationError("The end time must be after the start time.", `${field}.endTime`, "end_before_start");
  return {
    id: fields.id,
    title: text(fields.title, `${field}.title`, HOME_CALENDAR_LIMITS.title, { required: true, multiline: false }),
    date: fields.date,
    startTime,
    endTime,
    description: text(fields.description, `${field}.description`, HOME_CALENDAR_LIMITS.description, { required: false, multiline: true }),
    link: link(fields.link, `${field}.link`),
  };
}

/** Events in display order: by date, all-day events first, then by start time and title. */
export function sortHomeCalendarEvents(events: HomeCalendarEvent[]) {
  return [...events].sort((a, b) => a.date.localeCompare(b.date)
    || (a.startTime ?? "").localeCompare(b.startTime ?? "")
    || a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
}

export function parseHomeCalendarConfig(value: unknown): HomeCalendarConfig {
  const fields = plainObject(value, "config", ["schemaVersion", "timeZone", "events"]);
  if (fields.schemaVersion !== 1 || fields.timeZone !== HOME_CALENDAR_TIME_ZONE) throw new HomeCalendarValidationError("Reload the calendar before saving.");
  if (!Array.isArray(fields.events)) throw new HomeCalendarValidationError("Submit a list of events.", "events");
  if (fields.events.length > HOME_CALENDAR_MAX_EVENTS) {
    throw new HomeCalendarValidationError(`The calendar can hold at most ${HOME_CALENDAR_MAX_EVENTS} events. Delete past events first.`, "events", "too_many");
  }
  const events = fields.events.map(event);
  const ids = new Set<string>();
  for (const [index, item] of events.entries()) {
    if (ids.has(item.id)) throw new HomeCalendarValidationError("Reload the calendar before saving.", `events.${index}.id`, "duplicate_id");
    ids.add(item.id);
  }
  return { schemaVersion: 1, timeZone: HOME_CALENDAR_TIME_ZONE, events: sortHomeCalendarEvents(events) };
}

/** What visitors receive: the events and the version, never the editor's identity. */
export function publicHomeCalendar(record: HomeCalendarRecord) {
  return { config: record.config, recordVersion: record.recordVersion };
}

/** Changed event ids for the audit log, bounded to the column's 80 entries. */
export function homeCalendarChangedFields(previous: HomeCalendarConfig, next: HomeCalendarConfig) {
  const before = new Map(previous.events.map(item => [item.id, JSON.stringify(item)]));
  const after = new Map(next.events.map(item => [item.id, JSON.stringify(item)]));
  const fields: string[] = [];
  for (const [id, value] of after) {
    if (!before.has(id)) fields.push(`events.${id}.created`);
    else if (before.get(id) !== value) fields.push(`events.${id}.updated`);
  }
  for (const id of before.keys()) if (!after.has(id)) fields.push(`events.${id}.deleted`);
  return fields.length <= 80 ? fields : [...fields.slice(0, 79), `+${fields.length - 79} more events`];
}

/** The instant an event starts, for converting a Taipei time to another time zone. */
export function homeCalendarStartInstant(item: Pick<HomeCalendarEvent, "date" | "startTime">) {
  if (!item.startTime) return null;
  const [year, month, day] = item.date.split("-").map(Number);
  const [hour, minute] = item.startTime.split(":").map(Number);
  // Taipei is UTC+8 all year.
  return new Date(Date.UTC(year, month - 1, day, hour - 8, minute));
}
