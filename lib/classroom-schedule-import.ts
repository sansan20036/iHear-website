import { createHash } from "node:crypto";

// @ts-ignore - shared classroom logic, plain JavaScript tested with node --test.
import { FILE_NAME_SAFE } from "../tools/recording-pathway/classroom/block-naming.mjs";
import { MAX_MEMBERS, MAX_ROOMS, ROOM_CAPACITY } from "./classroom-block-rules";
import { createClassroomBlock } from "./classroom-blocks";
import { validTimeZone } from "./classroom-programs";
import { PERSON_CODE } from "./classroom-service";
import type { BlockRole, ClassroomBlock, ClassroomStore } from "./classroom-store";

// P3-Multi §10 (2026-11-09): iHear's schedule (Tutee, Date, Start, End, Lead Tutor, Co-Tutor,
// Observer, Pre-assign Room Name, Email Address) turned into blocks of one course, first as a
// preview and only on an owner's confirmation into blocks. The rules:
//   - The schedule's times are read in the course's own time zone, which the owner confirms; a time
//     that does not exist there (a spring-forward gap) or exists twice (fall-back) is refused.
//   - People are found only in a directory iHear keeps (code, role, confirmed English name,
//     sign-in e-mail for staff, and the exact names the schedule uses for them). A name matches
//     only exactly (ignoring case and repeated spaces); never by similarity, and never by an
//     e-mail. Anyone not found, or found twice, waits for a person to confirm (blocking).
//   - The Email Address column is only checked against the lead tutor found by name: a different
//     address stops that block for review. It never finds or creates anyone.
//   - The same schedule imported again finds its blocks (course + source date and times) and adds
//     nothing; a block whose rows changed is shown with its differences and left as it is.
//   - Nothing here starts a Zoom session or a recording: blocks are made in their first phase, and
//     their manager opens them as usual.
// The reader is replaceable: CSV text today, Google Sheets' values (readGoogleSheetValues) once
// iHear approves access; both give the same rows.

export const SCHEDULE_FIELDS = [
  { key: "tutee", header: "Tutee", required: true },
  { key: "date", header: "Date", required: true },
  { key: "start", header: "Start", required: true },
  { key: "end", header: "End", required: true },
  { key: "leadTutor", header: "Lead Tutor", required: true },
  { key: "coTutor", header: "Co-Tutor", required: false },
  { key: "observer", header: "Observer", required: false },
  { key: "room", header: "Pre-assign Room Name", required: false },
  { key: "email", header: "Email Address", required: false },
] as const;
export type ScheduleField = (typeof SCHEDULE_FIELDS)[number]["key"];
export const DIRECTORY_FIELDS = [
  { key: "code", header: "Code", required: true },
  { key: "role", header: "Role", required: true },
  { key: "englishName", header: "English Name", required: true },
  { key: "email", header: "Sign-in Email", required: false },
  { key: "names", header: "Schedule Names", required: false },
] as const;
type DirectoryField = (typeof DIRECTORY_FIELDS)[number]["key"];

export const IMPORT_LIMITS = { bytes: 200_000, rows: 2_000, blocks: 200 };
const ROOM_LABEL = /^[A-Za-z0-9-]{1,8}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DIRECTORY_ROLES = ["student", "tutor", "observer", "manager"] as const;
type DirectoryRole = (typeof DIRECTORY_ROLES)[number];

export type ImportIssue = { code: string; detail: string; row?: number; block?: string; blocking: boolean };
export class ScheduleFormatError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

// ---- Reading ---------------------------------------------------------------------------------

/** RFC 4180 CSV: quoted fields, "" inside quotes, CRLF or LF, a leading BOM. Blank lines dropped. */
export function parseCsv(text: string): string[][] {
  if (text.length > IMPORT_LIMITS.bytes) throw new ScheduleFormatError("TOO_LARGE", `At most ${IMPORT_LIMITS.bytes} characters`);
  const source = text.replace(/^﻿/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (quoted) {
      if (char === '"' && source[i + 1] === '"') { field += '"'; i += 1; }
      else if (char === '"') quoted = false;
      else field += char;
      continue;
    }
    if (char === '"' && field === "") quoted = true;
    else if (char === ",") { row.push(field); field = ""; }
    else if (char === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (char !== "\r") field += char;
  }
  if (quoted) throw new ScheduleFormatError("UNTERMINATED_QUOTE", "A quoted field is not closed");
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  const kept = rows.filter((cells) => cells.some((cell) => cell.trim() !== ""));
  if (kept.length > IMPORT_LIMITS.rows + 1) throw new ScheduleFormatError("TOO_MANY_ROWS", `At most ${IMPORT_LIMITS.rows} rows`);
  return kept;
}

/** Google Sheets' values (spreadsheets.values.get, majorDimension ROWS) as the same rows. */
export function rowsFromSheetValues(values: unknown): string[][] {
  if (!Array.isArray(values)) throw new ScheduleFormatError("NOT_ROWS", "The sheet gave no rows");
  const rows = values.map((row) => (Array.isArray(row) ? row.map((cell) => (cell == null ? "" : String(cell))) : []));
  const kept = rows.filter((cells) => cells.some((cell) => cell.trim() !== ""));
  if (kept.length > IMPORT_LIMITS.rows + 1) throw new ScheduleFormatError("TOO_MANY_ROWS", `At most ${IMPORT_LIMITS.rows} rows`);
  return kept;
}

/**
 * Reads one range of a Google Sheet (formatted values, as people see them). Not connected to any
 * account: the caller supplies an access token once iHear approves read-only access to its sheet
 * (spreadsheets.readonly). Only https (or a local test server) is used.
 */
export async function readGoogleSheetValues({ spreadsheetId, range, accessToken, fetchImpl = fetch, apiBase = "https://sheets.googleapis.com" }: {
  spreadsheetId: string; range: string; accessToken: () => Promise<string>; fetchImpl?: typeof fetch; apiBase?: string;
}) {
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(spreadsheetId)) throw new ScheduleFormatError("BAD_SHEET_ID", "Not a spreadsheet id");
  const base = new URL(apiBase);
  if (base.protocol !== "https:" && !["127.0.0.1", "localhost", "[::1]"].includes(base.hostname)) throw new ScheduleFormatError("BAD_API_BASE", "Sheets is read over https only");
  const url = new URL(`/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}`, base);
  url.searchParams.set("majorDimension", "ROWS");
  url.searchParams.set("valueRenderOption", "FORMATTED_VALUE");
  const response = await fetchImpl(url, { headers: { Authorization: `Bearer ${await accessToken()}` } });
  if (!response.ok) throw new ScheduleFormatError("SHEET_UNAVAILABLE", `The sheet answered ${response.status}`);
  return rowsFromSheetValues(((await response.json()) as { values?: unknown }).values ?? []);
}

const headerKey = (value: string) => value.normalize("NFKC").toLowerCase().replace(/[^a-z0-9]/g, "");

/** Which column holds which field: by header (ignoring case, spaces and punctuation), or as given. */
export function mapColumns<K extends string>(header: string[], fields: readonly { key: K; header: string; required: boolean }[], mapping: Partial<Record<K, string>> = {}) {
  const issues: ImportIssue[] = [];
  const keys = header.map(headerKey);
  const seen = new Map<string, number>();
  keys.forEach((key, index) => {
    if (key && seen.has(key)) issues.push({ code: "DUPLICATE_COLUMN", detail: `Column "${header[index]}" appears twice`, blocking: true });
    seen.set(key, index);
  });
  const index = {} as Record<K, number>;
  for (const field of fields) {
    const wanted = headerKey(mapping[field.key] ?? field.header);
    index[field.key] = keys.indexOf(wanted);
    if (index[field.key] < 0 && field.required) issues.push({ code: "MISSING_COLUMN", detail: `No "${mapping[field.key] ?? field.header}" column`, blocking: true });
  }
  const used = new Set(Object.values(index) as number[]);
  const ignored = header.filter((name, position) => name.trim() && !used.has(position));
  return { index, issues, ignored };
}

// ---- Times -----------------------------------------------------------------------------------

function parseDate(value: string) {
  const text = value.trim();
  let match = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  let y: number, m: number, d: number;
  if (match) [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  else if ((match = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/))) [m, d, y] = [Number(match[1]), Number(match[2]), Number(match[3])];
  else return null;
  const check = new Date(Date.UTC(y, m - 1, d));
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d) return null;
  return { y, m, d };
}

function parseTime(value: string) {
  const text = value.trim();
  let match = text.match(/^(\d{1,2}):(\d{2})(?::00)?$/);
  if (match) {
    const [h, min] = [Number(match[1]), Number(match[2])];
    return h <= 23 && min <= 59 ? { h, min } : null;
  }
  match = text.match(/^(\d{1,2})(?::(\d{2}))?\s*([AaPp])\.?\s*[Mm]\.?$/);
  if (!match) return null;
  const [h12, min] = [Number(match[1]), Number(match[2] ?? 0)];
  if (h12 < 1 || h12 > 12 || min > 59) return null;
  return { h: (h12 % 12) + (/[Pp]/.test(match[3]) ? 12 : 0), min };
}

const two = (value: number) => String(value).padStart(2, "0");
function offsetMinutes(instant: number, timeZone: string) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(instant).map((part) => [part.type, part.value]));
  const asUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
  return Math.round((asUtc - instant) / 60_000);
}

/** A wall-clock time in a time zone as one instant; refused when the zone skips it or has it twice. */
export function zonedInstant(date: { y: number; m: number; d: number }, time: { h: number; min: number }, timeZone: string):
  { ok: true; instant: number } | { ok: false; reason: "NONEXISTENT" | "AMBIGUOUS" } {
  const wall = Date.UTC(date.y, date.m - 1, date.d, time.h, time.min);
  const offsets = new Set([-12, 0, 12].map((hours) => offsetMinutes(wall + hours * 3_600_000, timeZone)));
  const matches = [...new Set([...offsets].map((offset) => wall - offset * 60_000))].filter((instant) => offsetMinutes(instant, timeZone) === (wall - instant) / 60_000);
  if (!matches.length) return { ok: false, reason: "NONEXISTENT" };
  if (matches.length > 1) return { ok: false, reason: "AMBIGUOUS" };
  return { ok: true, instant: matches[0] };
}

function wallIn(instant: number, timeZone: string) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  }).formatToParts(instant).map((part) => [part.type, part.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

// ---- The directory ---------------------------------------------------------------------------

export type DirectoryPerson = { code: string; role: DirectoryRole; englishName: string; email: string | null; names: string[] };
/** The exact-match key: Unicode-normalised, trimmed, single spaces, lower case. Nothing more. */
export const nameKey = (value: string) => value.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();

export function readDirectory(rows: string[][]) {
  const issues: ImportIssue[] = [];
  if (!rows.length) return { people: [] as DirectoryPerson[], issues: [{ code: "EMPTY_DIRECTORY", detail: "The directory is empty", blocking: true }] };
  const { index, issues: columnIssues } = mapColumns<DirectoryField>(rows[0], DIRECTORY_FIELDS);
  issues.push(...columnIssues);
  if (columnIssues.some((issue) => issue.blocking)) return { people: [], issues };
  const people: DirectoryPerson[] = [];
  const cell = (row: string[], key: DirectoryField) => (index[key] >= 0 ? (row[index[key]] ?? "").trim() : "");
  rows.slice(1).forEach((row, offset) => {
    const line = offset + 2;
    const code = cell(row, "code");
    const role = cell(row, "role").toLowerCase() as DirectoryRole;
    const englishName = cell(row, "englishName").replace(/\s+/g, " ");
    const email = cell(row, "email").toLowerCase() || null;
    const problems: string[] = [];
    if (!PERSON_CODE.test(code)) problems.push("code");
    if (!DIRECTORY_ROLES.includes(role)) problems.push("role");
    if (!FILE_NAME_SAFE.test(englishName)) problems.push("English name (letters, spaces, . and ' only)");
    if (role === "student" && email) problems.push("a student has no sign-in e-mail");
    if (role !== "student" && (!email || !EMAIL.test(email))) problems.push("sign-in e-mail");
    if (problems.length) { issues.push({ code: "DIRECTORY_ROW_INVALID", detail: `Directory line ${line}: ${problems.join(", ")}`, blocking: true }); return; }
    if (people.some((person) => person.code === code)) { issues.push({ code: "DIRECTORY_DUPLICATE_CODE", detail: `Directory line ${line}: code ${code} appears twice`, blocking: true }); return; }
    const names = [...new Set([englishName, ...cell(row, "names").split(";")].map(nameKey).filter(Boolean))];
    people.push({ code, role, englishName, email, names });
  });
  return { people, issues };
}

/** Every directory person a schedule name matches exactly: none, one, or (a mistake) several. */
function lookUp(people: DirectoryPerson[], name: string) {
  const key = nameKey(name);
  return key ? people.filter((person) => person.names.includes(key)) : [];
}

// ---- The plan --------------------------------------------------------------------------------

export type PlanBlock = {
  sourceKey: string; code: string; rows: number[];
  source: { date: string; start: string; end: string; timeZone: string };
  startsAt: string; endsAt: string; minutes: number; taipei: { date: string; time: string };
  rooms: string[];
  members: { code: string; role: BlockRole; englishName: string; email?: string }[];
  assignments: { member: string; room: string }[];
  status: "new" | "unchanged" | "changed" | "blocked";
  differences: string[];
  existing: { blockId: string; code: string; cancelled: boolean } | null;
  issues: ImportIssue[];
};
export type ImportPlan = {
  course: { id: string; code: string; timeZone: string } | null;
  manager: string | null;
  ignoredColumns: string[];
  issues: ImportIssue[];
  blocks: PlanBlock[];
  counts: { rows: number; new: number; unchanged: number; changed: number; blocked: number };
  ready: boolean;
  planHash: string;
};
export type ImportInput = {
  courseId: unknown; timeZone: unknown; manager: unknown;
  schedule: string[][]; directory: string[][];
  mapping?: Partial<Record<ScheduleField, string>>;
};

const splitNames = (value: string) => value.split(/[;\n]/).map((part) => part.trim()).filter(Boolean);

export async function planScheduleImport({ store, input }: { store: ClassroomStore; input: ImportInput; now?: number }): Promise<ImportPlan> {
  const issues: ImportIssue[] = [];
  const { programs, courses } = await store.listPrograms();
  const course = courses.find((item) => item.id === input.courseId) ?? null;
  const program = course ? programs.find((item) => item.id === course.programId) : null;
  if (!course || !program) issues.push({ code: "NO_COURSE", detail: "Choose an existing course", blocking: true });
  else if (course.cancelled || program.archived) issues.push({ code: "COURSE_CLOSED", detail: "The course is cancelled or its program archived", blocking: true });
  // The owner confirms the zone the sheet is written in, and it must be the course's own.
  if (!validTimeZone(input.timeZone)) issues.push({ code: "TIME_ZONE_REQUIRED", detail: "Confirm the time zone the schedule is written in", blocking: true });
  else if (course && input.timeZone !== course.timeZone) issues.push({ code: "TIME_ZONE_MISMATCH", detail: `The course's schedule is in ${course.timeZone}, not ${String(input.timeZone)}`, blocking: true });

  const { people, issues: directoryIssues } = readDirectory(input.directory);
  issues.push(...directoryIssues);
  const managerCode = String(input.manager ?? "").trim();
  const manager = people.find((person) => person.code === managerCode && person.role === "manager") ?? null;
  if (!manager) issues.push({ code: "NO_MANAGER", detail: "Name the block manager by a directory code with role manager", blocking: true });

  const header = input.schedule[0] ?? [];
  const { index, issues: columnIssues, ignored } = mapColumns<ScheduleField>(header, SCHEDULE_FIELDS, input.mapping);
  issues.push(...columnIssues);
  const rows = input.schedule.slice(1);
  if (!rows.length) issues.push({ code: "EMPTY_SCHEDULE", detail: "The schedule has no rows", blocking: true });
  const cell = (row: string[], key: ScheduleField) => (index[key] >= 0 ? (row[index[key]] ?? "").trim() : "");

  const groups = new Map<string, { key: string; date: string; start: string; end: string; starts: number; ends: number; rows: number[]; issues: ImportIssue[]; entries: { line: number; row: string[] }[] }>();
  const zone = course?.timeZone ?? (validTimeZone(input.timeZone) ? String(input.timeZone) : "UTC");
  if (!columnIssues.some((issue) => issue.blocking)) {
    rows.forEach((row, offset) => {
      const line = offset + 2;
      const date = parseDate(cell(row, "date"));
      const start = parseTime(cell(row, "start"));
      const end = parseTime(cell(row, "end"));
      if (!date || !start || !end) {
        issues.push({ code: "BAD_DATE_OR_TIME", row: line, detail: `Line ${line}: dates are YYYY-MM-DD or M/D/YYYY, times HH:MM or h:mm AM/PM`, blocking: true });
        return;
      }
      const from = zonedInstant(date, start, zone);
      const to = zonedInstant(date, end, zone);
      if (!from.ok || !to.ok) {
        const reason = !from.ok ? from.reason : (to as { reason: string }).reason;
        issues.push({ code: reason === "NONEXISTENT" ? "TIME_DOES_NOT_EXIST" : "TIME_IS_AMBIGUOUS", row: line, detail: `Line ${line}: ${cell(row, "date")} ${reason === "NONEXISTENT" ? "skips" : "repeats"} that hour in ${zone} (daylight saving); fix the time by hand`, blocking: true });
        return;
      }
      const minutes = (to.instant - from.instant) / 60_000;
      if (minutes < 15 || minutes > 240) {
        issues.push({ code: "BAD_DURATION", row: line, detail: `Line ${line}: a lesson lasts 15–240 minutes`, blocking: true });
        return;
      }
      const dateText = `${date.y}-${two(date.m)}-${two(date.d)}`;
      const startText = `${two(start.h)}${two(start.min)}`;
      const endText = `${two(end.h)}${two(end.min)}`;
      const key = `s:${dateText.replace(/-/g, "")}:${startText}:${endText}`;
      const group = groups.get(key) ?? { key, date: dateText, start: `${two(start.h)}:${two(start.min)}`, end: `${two(end.h)}:${two(end.min)}`, starts: from.instant, ends: to.instant, rows: [], issues: [], entries: [] };
      group.rows.push(line);
      group.entries.push({ line, row });
      groups.set(key, group);
    });
  }
  if (groups.size > IMPORT_LIMITS.blocks) issues.push({ code: "TOO_MANY_BLOCKS", detail: `At most ${IMPORT_LIMITS.blocks} blocks per import`, blocking: true });

  const blocks: PlanBlock[] = [];
  for (const group of [...groups.values()].sort((a, b) => a.starts - b.starts)) {
    const blockIssues: ImportIssue[] = [];
    const code = `${(course?.code ?? "COURSE").slice(0, 14)}-${group.date.replace(/-/g, "")}-${group.start.replace(":", "")}`;
    const members = new Map<string, { code: string; role: BlockRole; englishName: string; email?: string }>();
    const seats = new Map<string, string>();
    const rooms: string[] = [];
    const resolve = (name: string, wanted: DirectoryRole[], what: string, line: number) => {
      const found = lookUp(people, name);
      if (found.length !== 1) {
        blockIssues.push({ code: found.length ? "PERSON_AMBIGUOUS" : "PERSON_UNMATCHED", row: line, block: code, detail: `Line ${line}: ${what} "${name}" ${found.length ? "matches more than one person in the directory" : "is not in the directory"}; 待人工確認`, blocking: true });
        return null;
      }
      if (!wanted.includes(found[0].role)) {
        blockIssues.push({ code: "ROLE_MISMATCH", row: line, block: code, detail: `Line ${line}: ${what} "${name}" is ${found[0].role} in the directory`, blocking: true });
        return null;
      }
      return found[0];
    };
    const seat = (person: DirectoryPerson, role: BlockRole, room: string | null, line: number) => {
      const before = members.get(person.code);
      const tutors = new Set<BlockRole>(["lead_tutor", "co_tutor"]);
      if (before && before.role !== role && !(tutors.has(before.role) && tutors.has(role))) {
        blockIssues.push({ code: "ROLE_CONFLICT", row: line, block: code, detail: `Line ${line}: ${person.code} has two roles in one block`, blocking: true });
        return;
      }
      if (!before || (before.role === "co_tutor" && role === "lead_tutor")) members.set(person.code, { code: person.code, role, englishName: person.englishName, ...(person.email ? { email: person.email } : {}) });
      if (room) {
        const other = seats.get(person.code);
        if (other && other !== room) blockIssues.push({ code: "PERSON_IN_TWO_ROOMS", row: line, block: code, detail: `Line ${line}: ${person.code} is in ${other} and ${room} at once`, blocking: true });
        else seats.set(person.code, room);
      }
    };
    for (const { line, row } of group.entries) {
      const room = cell(row, "room");
      if (room && (!ROOM_LABEL.test(room) || room.toUpperCase() === "LOBBY")) blockIssues.push({ code: "BAD_ROOM_NAME", row: line, block: code, detail: `Line ${line}: room names are 1–8 letters, digits or hyphens (not LOBBY)`, blocking: true });
      const roomLabel = room && ROOM_LABEL.test(room) && room.toUpperCase() !== "LOBBY" ? room : null;
      if (roomLabel && !rooms.includes(roomLabel)) rooms.push(roomLabel);
      if (!room) blockIssues.push({ code: "NO_ROOM", row: line, block: code, detail: `Line ${line}: no room given; the people stay in the Lobby until the manager seats them`, blocking: false });
      const tutees = splitNames(cell(row, "tutee"));
      if (tutees.length !== 1) blockIssues.push({ code: "ONE_TUTEE_PER_LINE", row: line, block: code, detail: `Line ${line}: one tutee per line`, blocking: true });
      for (const name of tutees.slice(0, 1)) { const person = resolve(name, ["student"], "Tutee", line); if (person) seat(person, "student", roomLabel, line); }
      const leadName = cell(row, "leadTutor");
      const lead = leadName ? resolve(leadName, ["tutor"], "Lead Tutor", line) : null;
      if (!leadName) blockIssues.push({ code: "NO_LEAD_TUTOR", row: line, block: code, detail: `Line ${line}: no lead tutor`, blocking: true });
      if (lead) seat(lead, "lead_tutor", roomLabel, line);
      // The e-mail on the line is checked against the lead tutor found by name, never used to find anyone.
      const email = cell(row, "email").toLowerCase();
      if (email && lead && lead.email !== email) blockIssues.push({ code: "EMAIL_MISMATCH", row: line, block: code, detail: `Line ${line}: the e-mail does not match ${lead.code}'s sign-in e-mail in the directory; 待人工確認`, blocking: true });
      for (const name of splitNames(cell(row, "coTutor"))) { const person = resolve(name, ["tutor"], "Co-Tutor", line); if (person) seat(person, "co_tutor", roomLabel, line); }
      for (const name of splitNames(cell(row, "observer"))) { const person = resolve(name, ["observer", "tutor"], "Observer", line); if (person) seat(person, "observer", roomLabel, line); }
    }
    if (manager) {
      if (members.has(manager.code)) blockIssues.push({ code: "MANAGER_SEATED", block: code, detail: `The manager ${manager.code} is also on a line of this block`, blocking: true });
      members.set(manager.code, { code: manager.code, role: "manager", englishName: manager.englishName, email: manager.email ?? undefined });
    }
    if (rooms.length > MAX_ROOMS) blockIssues.push({ code: "TOO_MANY_ROOMS", block: code, detail: `At most ${MAX_ROOMS} rooms`, blocking: true });
    if (!rooms.length) blockIssues.push({ code: "NO_ROOMS", block: code, detail: "A block needs at least one teaching room", blocking: true });
    if (members.size > MAX_MEMBERS) blockIssues.push({ code: "TOO_MANY_PEOPLE", block: code, detail: `At most ${MAX_MEMBERS} people`, blocking: true });
    for (const label of rooms) {
      const taken = [...seats.values()].filter((value) => value === label).length;
      if (taken > ROOM_CAPACITY) blockIssues.push({ code: "ROOM_OVER_CAPACITY", block: code, detail: `${label}: ${taken} people, at most ${ROOM_CAPACITY}`, blocking: true });
    }
    const taipei = wallIn(group.starts, "Asia/Taipei");
    const plan: PlanBlock = {
      sourceKey: group.key, code, rows: group.rows,
      source: { date: group.date, start: group.start, end: group.end, timeZone: zone },
      startsAt: new Date(group.starts).toISOString(), endsAt: new Date(group.ends).toISOString(), minutes: (group.ends - group.starts) / 60_000, taipei,
      rooms: [...rooms].sort(),
      members: [...members.values()].sort((a, b) => a.code.localeCompare(b.code)),
      assignments: [...seats.entries()].map(([member, room]) => ({ member, room })).sort((a, b) => a.member.localeCompare(b.member)),
      status: "new", differences: [], existing: null, issues: blockIssues,
    };
    blocks.push(plan);
  }

  // People in two blocks at the same time, within this import and against blocks already made.
  const window = blocks.length ? { from: Math.min(...blocks.map((block) => Date.parse(block.startsAt))) - 86_400_000, to: Math.max(...blocks.map((block) => Date.parse(block.endsAt))) + 86_400_000 } : null;
  const existingBlocks: ClassroomBlock[] = window ? await store.listBlocks(window) : [];
  for (const block of blocks) {
    if (course) {
      const existing = await store.blockBySource(course.id, block.sourceKey);
      if (existing) {
        block.existing = { blockId: existing.id, code: existing.code, cancelled: existing.cancelled };
        block.differences = await differencesFrom(store, existing, block);
        block.status = existing.cancelled ? "changed" : block.differences.length ? "changed" : "unchanged";
        if (existing.cancelled) block.differences.unshift("the block made from this line was cancelled");
      } else if (existingBlocks.some((other) => other.code === block.code)) {
        block.issues.push({ code: "CODE_TAKEN", block: block.code, detail: `Another block already uses the code ${block.code}`, blocking: true });
      }
    }
    if (block.status === "new") {
      const start = Date.parse(block.startsAt), end = Date.parse(block.endsAt);
      for (const member of block.members) {
        const clash = [
          ...blocks.filter((other) => other !== block && Date.parse(other.startsAt) < end && Date.parse(other.endsAt) > start && other.members.some((item) => item.code === member.code)).map((other) => other.code),
          ...existingBlocks.filter((other) => !other.cancelled && other.id !== block.existing?.blockId && Date.parse(other.startsAt) < end && Date.parse(other.endsAt) > start && other.members.some((item) => item.code === member.code)).map((other) => other.code),
        ];
        if (clash.length) block.issues.push({ code: "PERSON_DOUBLE_BOOKED", block: block.code, detail: `${member.code} is also in ${[...new Set(clash)].join(", ")} at that time`, blocking: true });
      }
      if (block.issues.some((issue) => issue.blocking)) block.status = "blocked";
    }
  }

  const blockingAnywhere = issues.some((issue) => issue.blocking) || blocks.some((block) => block.status === "blocked");
  const actionable = blocks.filter((block) => block.status === "new").map((block) => ({ code: block.code, sourceKey: block.sourceKey, startsAt: block.startsAt, endsAt: block.endsAt, rooms: block.rooms, members: block.members, assignments: block.assignments }));
  const planHash = createHash("sha256").update(JSON.stringify({ course: course?.id ?? null, zone, manager: manager?.code ?? null, actionable })).digest("hex");
  return {
    course: course ? { id: course.id, code: course.code, timeZone: course.timeZone } : null,
    manager: manager?.code ?? null,
    ignoredColumns: ignored,
    issues,
    blocks,
    counts: {
      rows: rows.length,
      new: blocks.filter((block) => block.status === "new").length,
      unchanged: blocks.filter((block) => block.status === "unchanged").length,
      changed: blocks.filter((block) => block.status === "changed").length,
      blocked: blocks.filter((block) => block.status === "blocked").length,
    },
    ready: !blockingAnywhere && blocks.some((block) => block.status === "new"),
    planHash,
  };
}

// What differs between a block already made from these lines and the lines as they are now.
async function differencesFrom(store: ClassroomStore, existing: ClassroomBlock, plan: PlanBlock) {
  const out: string[] = [];
  if (existing.startsAt !== plan.startsAt || existing.endsAt !== plan.endsAt) out.push(`time: ${existing.startsAt}–${existing.endsAt} → ${plan.startsAt}–${plan.endsAt}`);
  const lessons = await store.lessonsOfBlock(existing.id);
  const labels = lessons.filter((lesson) => lesson.roomKind === "room").map((lesson) => String(lesson.roomLabel)).sort();
  if (labels.join(",") !== plan.rooms.join(",")) out.push(`rooms: ${labels.join(", ")} → ${plan.rooms.join(", ")}`);
  const before = new Map(existing.members.map((member) => [member.code, member.role]));
  const after = new Map(plan.members.map((member) => [member.code, member.role]));
  for (const [code, role] of after) if (!before.has(code)) out.push(`added: ${code} (${role})`); else if (before.get(code) !== role) out.push(`role: ${code} ${before.get(code)} → ${role}`);
  for (const [code] of before) if (!after.has(code)) out.push(`removed: ${code}`);
  const seatOf = new Map<string, string>();
  for (const lesson of lessons.filter((item) => item.roomKind === "room")) {
    for (const participant of lesson.participants) {
      const member = existing.members.find((item) => item.id === participant.memberId);
      if (member && participant.active !== false && participant.seat === "assigned") seatOf.set(member.code, String(lesson.roomLabel));
    }
  }
  for (const { member, room } of plan.assignments) if (before.has(member) && seatOf.get(member) !== room) out.push(`room: ${member} ${seatOf.get(member) ?? "Lobby"} → ${room}`);
  return out;
}

/**
 * The owner's confirmation: the plan is made again from the same input and must still be the one
 * previewed (planHash) and free of anything blocking. Then each new block is made (blocks already
 * made from these lines, changed or not, are left as they are). Each block is made in one step; a
 * later run of the same import skips those made, so a run stopped half way can simply be repeated.
 */
export async function applyScheduleImport({ store, input, planHash, actor, now }: { store: ClassroomStore; input: ImportInput; planHash: unknown; actor: string; now: number }) {
  const plan = await planScheduleImport({ store, input });
  if (plan.planHash !== planHash) return { status: 409, body: { error: "The schedule or the blocks changed since the preview; preview again", code: "STALE_PREVIEW", plan } };
  if (!plan.ready) return { status: 409, body: { error: "Resolve every blocking problem first", code: "NOT_READY", plan } };
  const created: { code: string; blockId: string; studentLinks: { code: string; link: string }[] }[] = [];
  for (const block of plan.blocks.filter((item) => item.status === "new")) {
    try {
      const made = await createClassroomBlock({
        store, actor, now,
        input: {
          code: block.code, date: block.taipei.date, time: block.taipei.time, minutes: block.minutes, rooms: block.rooms,
          members: block.members.map((member) => ({ code: member.code, role: member.role, englishName: member.englishName, ...(member.email ? { email: member.email } : {}) })),
          assignments: block.assignments, course: plan.course!.id, sourceKey: block.sourceKey,
        },
      });
      created.push({ code: block.code, blockId: made.block.blockId, studentLinks: made.studentLinks });
    } catch (error) {
      return { status: 409, body: { error: `Stopped at ${block.code}: ${(error as Error).message}; the blocks before it were made, run the import again for the rest`, code: "PARTLY_MADE", created } };
    }
  }
  return {
    status: 200,
    body: {
      ok: true, created,
      unchanged: plan.blocks.filter((block) => block.status === "unchanged").map((block) => block.code),
      changed: plan.blocks.filter((block) => block.status === "changed").map((block) => ({ code: block.code, differences: block.differences })),
    },
  };
}

