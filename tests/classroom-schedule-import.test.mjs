import { afterAll, describe, expect, test, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// P3-Multi (draft 030 and §10, 2026-11-09): programs and courses above the blocks, and iHear's
// schedule imported into a course's blocks: CSV and Google Sheets rows, column mapping, the
// course's own time zone (daylight-saving gaps and repeats refused), people found only by an
// exact name in iHear's directory (never by similarity or by e-mail), a preview that changes
// nothing, the owner's confirmation with the previewed plan, no duplicates on a second import,
// differences shown and left alone, and nothing that starts Zoom or a recording. Synthetic data.
const directory = await mkdtemp(path.join(os.tmpdir(), "ihear-schedule-import-"));
vi.stubEnv("IHEAR_FORCE_FILE_STORE", "1");
vi.stubEnv("IHEAR_TEST_DATA_DIR", directory);
vi.stubEnv("VERCEL_ENV", "");
const { createFileClassroomStore } = await import("../lib/classroom-store");
const { createClassroomBlock } = await import("../lib/classroom-blocks");
const { createClassroomLesson } = await import("../lib/classroom-service");
const { createClassroomCourse, createClassroomProgram, listClassroomPrograms, updateClassroomCourse, updateClassroomProgram, validTimeZone } = await import("../lib/classroom-programs");
const { applyScheduleImport, mapColumns, parseCsv, planScheduleImport, readGoogleSheetValues, rowsFromSheetValues, SCHEDULE_FIELDS, zonedInstant } = await import("../lib/classroom-schedule-import");

afterAll(async () => { await rm(directory, { recursive: true, force: true }); });

const NOW = Date.parse("2026-11-20T12:00:00Z");
let stores = 0;
const freshStore = () => createFileClassroomStore(path.join(directory, `import-${++stores}.json`));
async function withCourse(store, { timeZone = "America/New_York", code = "TEST-C1" } = {}) {
  const program = await createClassroomProgram({ store, actor: "owner@example.test", now: NOW, input: { code: `${code}-P`, name: "Synthetic Program" } });
  const course = await createClassroomCourse({ store, actor: "owner@example.test", now: NOW, input: { program: program.code, code, name: "Synthetic Course", timeZone } });
  return { program, course };
}
const DIRECTORY = [
  "Code,Role,English Name,Sign-in Email,Schedule Names",
  "TEST-M,manager,Mia Manager,m@example.test,",
  "TEST-T1,tutor,Carol Chen,t1@example.test,Carol;Ms Chen",
  "TEST-T2,tutor,Dan Wu,t2@example.test,",
  "TEST-O1,observer,Olive Ong,o1@example.test,",
  "TEST-S1,student,Amy Wang,,Amy",
  "TEST-S2,student,Ben Lee,,",
  "TEST-S3,student,Cid Park,,",
].join("\n");
const HEADER = "Tutee,Date,Start,End,Lead Tutor,Co-Tutor,Observer,Pre-assign Room Name,Email Address";
const csv = (...lines) => [HEADER, ...lines].join("\r\n");
const input = (course, schedule, extra = {}) => ({ courseId: course.id, timeZone: course.timeZone, manager: "TEST-M", schedule: parseCsv(schedule), directory: parseCsv(DIRECTORY), ...extra });
const blockingCodes = plan => [...plan.issues, ...plan.blocks.flatMap(block => block.issues)].filter(issue => issue.blocking).map(issue => issue.code);

describe("programs and courses (draft 030)", () => {
  test("a program holds courses; a course states a real time zone it never changes; a cancelled course or an archived program takes no new block; one-to-one lessons and blocks without a course are unchanged", async () => {
    const store = freshStore();
    const { program, course } = await withCourse(store);
    expect(course).toMatchObject({ programId: program.id, timeZone: "America/New_York", cancelled: false });
    for (const timeZone of ["EST", "+08:00", "UTC", "Mars/Olympus", ""]) expect(validTimeZone(timeZone)).toBe(false);
    expect(validTimeZone("Asia/Taipei")).toBe(true);
    await expect(createClassroomCourse({ store, actor: "o@example.test", now: NOW, input: { program: program.code, code: "TEST-C2", name: "X", timeZone: "EST" } })).rejects.toMatchObject({ issues: { timeZone: expect.any(String) } });
    await expect(createClassroomCourse({ store, actor: "o@example.test", now: NOW, input: { program: program.code, code: course.code, name: "Again", timeZone: "Asia/Taipei" } })).rejects.toThrow(/already exists/);
    await expect(updateClassroomCourse({ store, id: course.id, input: { timeZone: "Asia/Taipei" }, now: NOW })).rejects.toMatchObject({ issues: { timeZone: expect.any(String) } });
    // A block can belong to the course; a one-to-one lesson and a block without a course still work.
    const members = [{ code: "TEST-M", role: "manager", englishName: "Mia Manager", email: "m@example.test" }, { code: "TEST-S1", role: "student", englishName: "Amy Wang" }];
    const withCourseBlock = await createClassroomBlock({ store, actor: "o@example.test", now: NOW, input: { code: "TEST-B1", date: "2026-12-01", time: "16:00", minutes: 60, rooms: ["R1"], members, assignments: [], course: course.code } });
    expect((await store.block(withCourseBlock.block.blockId)).courseId).toBe(course.id);
    const plain = await createClassroomBlock({ store, actor: "o@example.test", now: NOW, input: { code: "TEST-B2", date: "2026-12-01", time: "16:00", minutes: 60, rooms: ["R1"], members: members.map(member => ({ ...member, code: `${member.code}X`, ...(member.email ? { email: "m2@example.test" } : {}) })), assignments: [] } });
    expect((await store.block(plain.block.blockId)).courseId ?? null).toBeNull();
    await createClassroomLesson({ store, actor: "o@example.test", now: NOW, input: { code: "TEST-L1", date: "2026-12-01", time: "16:00", minutes: 60, tutorCode: "TEST-LT", tutorEmail: "lt@example.test", studentCode: "TEST-LS" } });
    // Cancelled course, then archived program: no new block in them.
    await updateClassroomCourse({ store, id: course.id, input: { cancelled: true }, now: NOW });
    await expect(createClassroomBlock({ store, actor: "o@example.test", now: NOW, input: { code: "TEST-B3", date: "2026-12-02", time: "16:00", minutes: 60, rooms: ["R1"], members, assignments: [], course: course.code } })).rejects.toMatchObject({ issues: { course: expect.stringMatching(/cancelled/) } });
    await updateClassroomProgram({ store, id: program.id, input: { archived: true }, now: NOW });
    await expect(createClassroomCourse({ store, actor: "o@example.test", now: NOW, input: { program: program.code, code: "TEST-C3", name: "X", timeZone: "Asia/Taipei" } })).rejects.toMatchObject({ issues: { program: expect.stringMatching(/archived/) } });
    const listed = await listClassroomPrograms({ store, now: NOW });
    expect(listed.programs[0].courses[0]).toMatchObject({ code: course.code, cancelled: true, blocks: 1, upcoming: 1 });
  });
});

describe("reading the schedule", () => {
  test("CSV: quotes, doubled quotes, CRLF, a leading BOM and blank lines; an open quote is refused", () => {
    expect(parseCsv('﻿a,b\r\n"x, y","say ""hi"""\r\n\r\n,\r\nlast,')).toEqual([["a", "b"], ["x, y", 'say "hi"'], ["last", ""]]);
    expect(() => parseCsv('a,"b\nc')).toThrow(/not closed/);
    expect(() => parseCsv("x".repeat(200_001))).toThrow(/At most/);
  });

  test("Google Sheets: the same rows from spreadsheets.values (read-only, https, bearer token); refusals are reported, never guessed", async () => {
    const calls = [];
    const fetchImpl = async (url, options) => { calls.push({ url: String(url), auth: options.headers.Authorization }); return new Response(JSON.stringify({ values: [["Tutee", "Date"], ["Amy", "2026-12-01"], []] }), { status: 200 }); };
    const rows = await readGoogleSheetValues({ spreadsheetId: "1abcDEFghiJKLmnoPQRstu", range: "Schedule!A1:I200", accessToken: async () => "synthetic-token", fetchImpl });
    expect(rows).toEqual([["Tutee", "Date"], ["Amy", "2026-12-01"]]);
    expect(calls[0].url).toBe("https://sheets.googleapis.com/v4/spreadsheets/1abcDEFghiJKLmnoPQRstu/values/Schedule!A1%3AI200?majorDimension=ROWS&valueRenderOption=FORMATTED_VALUE");
    expect(calls[0].auth).toBe("Bearer synthetic-token");
    expect(rowsFromSheetValues([[1, null, "x"]])).toEqual([["1", "", "x"]]);
    await expect(readGoogleSheetValues({ spreadsheetId: "short", range: "A1", accessToken: async () => "t", fetchImpl })).rejects.toThrow(/spreadsheet id/);
    await expect(readGoogleSheetValues({ spreadsheetId: "1abcDEFghiJKLmnoPQRstu", range: "A1", accessToken: async () => "t", fetchImpl, apiBase: "http://sheets.example.test" })).rejects.toThrow(/https/);
    await expect(readGoogleSheetValues({ spreadsheetId: "1abcDEFghiJKLmnoPQRstu", range: "A1", accessToken: async () => "t", fetchImpl: async () => new Response("{}", { status: 403 }) })).rejects.toThrow(/403/);
  });

  test("columns are found by name whatever the case, spaces or punctuation; a missing or doubled column stops the import; others are listed as unused; a mapping can name them", () => {
    const loose = mapColumns(["tutee", "DATE", "start", "End", "lead tutor", "Co Tutor", "observer", "Pre-Assign Room Name", "EMAIL ADDRESS", "Notes"], SCHEDULE_FIELDS);
    expect(loose.issues).toEqual([]);
    expect(loose.index.coTutor).toBe(5);
    expect(loose.ignored).toEqual(["Notes"]);
    expect(mapColumns(["Tutee", "Date", "Start"], SCHEDULE_FIELDS).issues.map(issue => issue.code)).toEqual(["MISSING_COLUMN", "MISSING_COLUMN"]);
    expect(mapColumns(["Tutee", "Tutee", "Date", "Start", "End", "Lead Tutor"], SCHEDULE_FIELDS).issues.map(issue => issue.code)).toEqual(["DUPLICATE_COLUMN"]);
    expect(mapColumns(["Student", "Date", "Start", "End", "Lead Tutor"], SCHEDULE_FIELDS, { tutee: "Student" }).issues).toEqual([]);
  });

  test("times are read in the course's zone: New York's spring-forward gap does not exist and its fall-back hour is ambiguous; both are refused", () => {
    expect(zonedInstant({ y: 2026, m: 12, d: 1 }, { h: 16, min: 0 }, "America/New_York")).toEqual({ ok: true, instant: Date.parse("2026-12-01T21:00:00Z") });
    expect(zonedInstant({ y: 2026, m: 7, d: 1 }, { h: 16, min: 0 }, "America/New_York")).toEqual({ ok: true, instant: Date.parse("2026-07-01T20:00:00Z") });
    expect(zonedInstant({ y: 2026, m: 3, d: 8 }, { h: 2, min: 30 }, "America/New_York")).toEqual({ ok: false, reason: "NONEXISTENT" });
    expect(zonedInstant({ y: 2026, m: 11, d: 1 }, { h: 1, min: 30 }, "America/New_York")).toEqual({ ok: false, reason: "AMBIGUOUS" });
    expect(zonedInstant({ y: 2026, m: 12, d: 1 }, { h: 16, min: 0 }, "Asia/Taipei")).toEqual({ ok: true, instant: Date.parse("2026-12-01T08:00:00Z") });
  });
});

describe("the import plan (preview)", () => {
  test("rows become blocks: one per date and time, rooms from the sheet, people only from the directory; Taipei time for the block; the preview writes nothing", async () => {
    const store = freshStore();
    const { course } = await withCourse(store);
    const before = JSON.stringify(await store.listBlocks({ from: 0, to: Date.parse("2030-01-01") }));
    const plan = await planScheduleImport({ store, input: input(course, csv(
      "Amy,12/1/2026,4:00 PM,5:00 PM,Carol,,,R1,t1@example.test",
      "Ben Lee,2026-12-01,16:00,17:00,Dan Wu,,Olive Ong,R2,",
      "Ben Lee,2026-12-01,16:00,17:00,Dan Wu,Dan Wu,,R2,",
      "Cid Park,2026-12-02,16:00,17:00,Ms Chen,,,R1,",
    )) });
    expect(blockingCodes(plan)).toEqual([]);
    expect(plan.ready).toBe(true);
    expect(plan.counts).toMatchObject({ rows: 4, new: 2, unchanged: 0, changed: 0, blocked: 0 });
    const [first, second] = plan.blocks;
    expect(first).toMatchObject({
      code: "TEST-C1-20261201-1600", sourceKey: "s:20261201:1600:1700", startsAt: "2026-12-01T21:00:00.000Z", endsAt: "2026-12-01T22:00:00.000Z", minutes: 60,
      taipei: { date: "2026-12-02", time: "05:00" }, rooms: ["R1", "R2"], source: { timeZone: "America/New_York" },
    });
    // A repeated line and a tutor named both lead and co-tutor in one room: one seat, the lead role.
    expect(first.members.find(member => member.code === "TEST-T2").role).toBe("lead_tutor");
    expect(first.assignments).toEqual(expect.arrayContaining([{ member: "TEST-S1", room: "R1" }, { member: "TEST-S2", room: "R2" }, { member: "TEST-O1", room: "R2" }]));
    expect(second.members.map(member => [member.code, member.role])).toEqual([["TEST-M", "manager"], ["TEST-S3", "student"], ["TEST-T1", "lead_tutor"]]);
    expect(JSON.stringify(await store.listBlocks({ from: 0, to: Date.parse("2030-01-01") }))).toBe(before);
  });

  test("a person is found only by an exact name (case and spaces aside): a near name, an e-mail alone or a name two people share waits for a person (待人工確認); a different e-mail on the line stops the block", async () => {
    const store = freshStore();
    const { course } = await withCourse(store);
    const directoryWithTwins = `${DIRECTORY}\nTEST-S4,student,Amy Wu,,Amy`;
    const plan = await planScheduleImport({ store, input: { ...input(course, csv(
      "  amy   WANG ,2026-12-01,16:00,17:00,carol chen,,,R1,T1@example.test",
      "Ben Leee,2026-12-01,16:00,17:00,Carol Chen,,,R1,",
      "Cid Park,2026-12-02,16:00,17:00,Unknown Person,,,R1,t2@example.test",
      "Cid Park,2026-12-03,16:00,17:00,Dan Wu,,,R1,t1@example.test",
      "Amy,2026-12-04,16:00,17:00,Dan Wu,,,R1,",
      "Ben Lee,2026-12-05,16:00,17:00,Amy Wang,,,R1,",
    )), directory: parseCsv(directoryWithTwins) } });
    const byBlock = Object.fromEntries(plan.blocks.map(block => [block.code.slice(-13, -5), block.issues.map(issue => issue.code)]));
    expect(byBlock["20261201"]).toEqual(["PERSON_UNMATCHED"]);
    // The e-mail on the line matches TEST-T2, yet the lead tutor stays unknown: an e-mail never finds anyone.
    expect(byBlock["20261202"]).toEqual(["PERSON_UNMATCHED"]);
    expect(byBlock["20261203"]).toEqual(["EMAIL_MISMATCH"]);
    expect(byBlock["20261204"]).toEqual(["PERSON_AMBIGUOUS"]);
    expect(byBlock["20261205"]).toEqual(["ROLE_MISMATCH"]);
    expect(plan.blocks.find(block => block.code.includes("20261201")).members.map(member => member.code)).toEqual(["TEST-M", "TEST-S1", "TEST-T1"]);
    expect(plan.blocks.every(block => block.status === "blocked")).toBe(true);
    expect(plan.ready).toBe(false);
    expect(plan.blocks[0].issues[0].detail).toContain("待人工確認");
  });

  test("the zone is confirmed and must be the course's; a gap or a repeated hour, a bad date, a room over 10, a person in two rooms or two blocks at once and a missing manager are all refused", async () => {
    const store = freshStore();
    const { course } = await withCourse(store);
    const lines = ["Amy,2026-03-08,2:30 AM,3:30 AM,Carol,,,R1,", "Ben Lee,2026-11-01,1:30 AM,2:15 AM,Carol,,,R1,", "Cid Park,2026-02-30,16:00,17:00,Carol,,,R1,"];
    const times = await planScheduleImport({ store, input: input(course, csv(...lines)) });
    expect(times.issues.map(issue => issue.code)).toEqual(["TIME_DOES_NOT_EXIST", "TIME_IS_AMBIGUOUS", "BAD_DATE_OR_TIME"]);
    expect((await planScheduleImport({ store, input: input(course, csv("Amy,2026-12-01,16:00,17:00,Carol,,,R1,"), { timeZone: undefined }) })).issues.map(issue => issue.code)).toContain("TIME_ZONE_REQUIRED");
    expect((await planScheduleImport({ store, input: input(course, csv("Amy,2026-12-01,16:00,17:00,Carol,,,R1,"), { timeZone: "Asia/Taipei" }) })).issues.map(issue => issue.code)).toContain("TIME_ZONE_MISMATCH");
    expect((await planScheduleImport({ store, input: input(course, csv("Amy,2026-12-01,16:00,17:00,Carol,,,R1,"), { manager: "TEST-T1" }) })).issues.map(issue => issue.code)).toContain("NO_MANAGER");
    // Eleven students in R1.
    const many = Array.from({ length: 11 }, (_, n) => `TEST-X${n},student,Kid ${String.fromCharCode(65 + n)},,`).join("\n");
    const crowded = await planScheduleImport({ store, input: { ...input(course, csv(...Array.from({ length: 11 }, (_, n) => `Kid ${String.fromCharCode(65 + n)},2026-12-01,16:00,17:00,Carol,,,R1,`))), directory: parseCsv(`${DIRECTORY}\n${many}`) } });
    expect(blockingCodes(crowded)).toEqual(["ROOM_OVER_CAPACITY"]);
    const twice = await planScheduleImport({ store, input: input(course, csv("Amy,2026-12-01,16:00,17:00,Carol,,,R1,", "Ben Lee,2026-12-01,16:00,17:00,Carol,,,R2,")) });
    expect(blockingCodes(twice)).toEqual(["PERSON_IN_TWO_ROOMS"]);
    const overlap = await planScheduleImport({ store, input: input(course, csv("Amy,2026-12-01,16:00,17:00,Carol,,,R1,", "Ben Lee,2026-12-01,16:30,17:30,Carol,,,R1,")) });
    expect(blockingCodes(overlap)).toEqual(["PERSON_DOUBLE_BOOKED", "PERSON_DOUBLE_BOOKED", "PERSON_DOUBLE_BOOKED", "PERSON_DOUBLE_BOOKED"]);
  });
});

describe("the owner's confirmation", () => {
  test("only the previewed plan, free of problems, is made; the same schedule again adds nothing; a changed block is shown with its differences and left alone; nothing starts Zoom or recording", async () => {
    const store = freshStore();
    const { course } = await withCourse(store);
    const schedule = csv("Amy,2026-12-01,16:00,17:00,Carol,,,R1,", "Ben Lee,2026-12-01,16:00,17:00,Dan Wu,,,R2,");
    const plan = await planScheduleImport({ store, input: input(course, schedule) });
    expect((await applyScheduleImport({ store, input: input(course, schedule), planHash: "0".repeat(64), actor: "owner@example.test", now: NOW })).body).toMatchObject({ code: "STALE_PREVIEW" });
    const applied = await applyScheduleImport({ store, input: input(course, schedule), planHash: plan.planHash, actor: "owner@example.test", now: NOW });
    expect(applied.status).toBe(200);
    expect(applied.body.created).toHaveLength(1);
    expect(applied.body.created[0].studentLinks.map(entry => entry.code).sort()).toEqual(["TEST-S1", "TEST-S2"]);
    const made = await store.block(applied.body.created[0].blockId);
    expect(made).toMatchObject({ code: "TEST-C1-20261201-1600", courseId: course.id, sourceKey: "s:20261201:1600:1700", startsAt: "2026-12-01T21:00:00.000Z", version: 0 });
    // Made in its first phase: only the block's own audit fact; no session, token or recording.
    const facts = await store.eventsFor([made.lobbyId, ...made.roomIds]);
    expect(facts.map(event => event.type)).toEqual(["server.block_audit"]);
    expect(await store.listJoinTokensFor([made.lobbyId, ...made.roomIds])).toEqual([]);
    // Again: nothing new, nothing doubled.
    const again = await planScheduleImport({ store, input: input(course, schedule) });
    expect(again.counts).toMatchObject({ new: 0, unchanged: 1 });
    expect((await applyScheduleImport({ store, input: input(course, schedule), planHash: again.planHash, actor: "owner@example.test", now: NOW })).body).toMatchObject({ code: "NOT_READY" });
    // Changed (Ben moved to R1, a co-tutor added) plus a new day: the new one is made, the changed one is not.
    const changedSchedule = csv("Amy,2026-12-01,16:00,17:00,Carol,Dan Wu,,R1,", "Ben Lee,2026-12-01,16:00,17:00,Carol,,,R1,", "Cid Park,2026-12-08,16:00,17:00,Carol,,,R1,");
    const changed = await planScheduleImport({ store, input: input(course, changedSchedule) });
    expect(changed.counts).toMatchObject({ new: 1, changed: 1 });
    expect(changed.blocks[0].differences).toEqual(expect.arrayContaining(["rooms: R1, R2 → R1", "room: TEST-S2 R2 → R1", "role: TEST-T2 lead_tutor → co_tutor"]));
    const second = await applyScheduleImport({ store, input: input(course, changedSchedule), planHash: changed.planHash, actor: "owner@example.test", now: NOW });
    expect(second.body.created.map(block => block.code)).toEqual(["TEST-C1-20261208-1600"]);
    expect(second.body.changed).toEqual([{ code: "TEST-C1-20261201-1600", differences: changed.blocks[0].differences }]);
    expect((await store.block(made.id)).version).toBe(0);
    const all = await store.listBlocks({ from: 0, to: Date.parse("2030-01-01") });
    expect(all.map(block => block.code).sort()).toEqual(["TEST-C1-20261201-1600", "TEST-C1-20261208-1600"]);
  });

  test("two confirmations of the same plan at once make each block once; a cancelled course takes no import", async () => {
    const store = freshStore();
    const { course } = await withCourse(store);
    const schedule = csv("Amy,2026-12-01,16:00,17:00,Carol,,,R1,", "Ben Lee,2026-12-02,16:00,17:00,Carol,,,R1,");
    const plan = await planScheduleImport({ store, input: input(course, schedule) });
    const results = await Promise.all([1, 2].map(() => applyScheduleImport({ store, input: input(course, schedule), planHash: plan.planHash, actor: "owner@example.test", now: NOW })));
    const made = results.flatMap(result => result.body.created ?? []);
    expect(made.map(block => block.code).sort()).toEqual(["TEST-C1-20261201-1600", "TEST-C1-20261202-1600"]);
    expect((await store.listBlocks({ from: 0, to: Date.parse("2030-01-01") }))).toHaveLength(2);
    await updateClassroomCourse({ store, id: course.id, input: { cancelled: true }, now: NOW });
    expect((await planScheduleImport({ store, input: input(course, csv("Cid Park,2026-12-09,16:00,17:00,Carol,,,R1,")) })).issues.map(issue => issue.code)).toContain("COURSE_CLOSED");
  });

  test("a Taipei course reads its schedule in Taipei time", async () => {
    const store = freshStore();
    const { course } = await withCourse(store, { timeZone: "Asia/Taipei", code: "TEST-TW" });
    const plan = await planScheduleImport({ store, input: input(course, csv("Amy,2026-12-01,16:00,17:00,Carol,,,R1,")) });
    expect(plan.blocks[0]).toMatchObject({ startsAt: "2026-12-01T08:00:00.000Z", taipei: { date: "2026-12-01", time: "16:00" } });
  });
});
