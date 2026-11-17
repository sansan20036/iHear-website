import { afterAll, describe, expect, test, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// One-to-one lessons in any time zone (2026-11-17). The admin form defaults to US Eastern and lets
// the owner pick the zone the time is written in; the server converts it once, with the zone's
// own rules (US daylight saving time: EDT UTC−4, EST UTC−5), refuses a time the zone skips or has
// twice, refuses a lesson whose whole entry time has passed, and keeps the zone it was entered in.
// A request without a zone is Taipei time, exactly as before. The entry window, tokens and the
// student link are untouched: they work from the stored UTC instants. Local file store and the
// synthetic provider only; nothing reaches Zoom, Google or a hosted database.
const directory = await mkdtemp(path.join(os.tmpdir(), "ihear-time-zones-"));
vi.stubEnv("IHEAR_FORCE_FILE_STORE", "1");
vi.stubEnv("IHEAR_TEST_DATA_DIR", directory);
vi.stubEnv("CLASSROOM_PROVIDER", "synthetic");
vi.stubEnv("CLASSROOM_DRIVE", "local");
vi.stubEnv("CLASSROOM_SYNTHETIC_SECRET", "time-zones-token-test-only");
vi.stubEnv("VERCEL_ENV", "");
const zoned = await import("../lib/zoned-time");
const { createFileClassroomStore } = await import("../lib/classroom-store");
const { classroomProvider } = await import("../lib/classroom-provider");
const { ClassroomInputError, classroomOverview, createClassroomLesson, joinClassroom } = await import("../lib/classroom-service");
const { zonedInstant: importZonedInstant } = await import("../lib/classroom-schedule-import");
const { validTimeZone: programsValidTimeZone } = await import("../lib/classroom-programs");

afterAll(async () => {
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

const MIN = 60_000;
const NOW = Date.parse("2026-11-20T12:00:00Z");
let stores = 0;
const freshStore = () => createFileClassroomStore(path.join(directory, `tz-${++stores}.json`));
let codes = 0;
const lessonInput = (fields = {}) => {
  codes += 1;
  return { code: `TEST-TZ${codes}`, minutes: 60, tutorCode: `TEST-T${codes}`, tutorEmail: "tutor@example.test", studentCode: `TEST-S${codes}`, ...fields };
};
const make = (store, fields, now = NOW) => createClassroomLesson({ store, actor: "owner@example.test", now, input: lessonInput(fields) });
const refusal = async promise => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ClassroomInputError) return { issues: error.issues, codes: error.codes };
    throw error;
  }
  throw new Error("expected a refusal");
};
const at = (date, time, zone) => {
  const [y, m, d] = date.split("-").map(Number);
  const [h, min] = time.split(":").map(Number);
  return zoned.zonedInstant({ y, m, d }, { h, min }, zone);
};

describe("wall-clock times in IANA zones (lib/zoned-time.ts)", () => {
  test("US Eastern follows daylight saving time: EST is UTC−5 in winter, EDT is UTC−4 in summer, never a fixed −5", () => {
    expect(at("2026-11-20", "18:00", "America/New_York")).toEqual({ ok: true, instant: Date.parse("2026-11-20T23:00:00Z") });
    expect(at("2026-07-10", "18:00", "America/New_York")).toEqual({ ok: true, instant: Date.parse("2026-07-10T22:00:00Z") });
    // The last minute before each change and the first after it.
    expect(at("2026-03-08", "01:59", "America/New_York")).toEqual({ ok: true, instant: Date.parse("2026-03-08T06:59:00Z") });
    expect(at("2026-03-08", "03:00", "America/New_York")).toEqual({ ok: true, instant: Date.parse("2026-03-08T07:00:00Z") });
    expect(at("2026-11-01", "00:59", "America/New_York")).toEqual({ ok: true, instant: Date.parse("2026-11-01T04:59:00Z") });
    expect(at("2026-11-01", "02:00", "America/New_York")).toEqual({ ok: true, instant: Date.parse("2026-11-01T07:00:00Z") });
    // Rules, not dates written into the code: 2027 changes on 14 March and 7 November.
    expect(at("2027-03-13", "18:00", "America/New_York")).toEqual({ ok: true, instant: Date.parse("2027-03-13T23:00:00Z") });
    expect(at("2027-03-15", "18:00", "America/New_York")).toEqual({ ok: true, instant: Date.parse("2027-03-15T22:00:00Z") });
    expect(zoned.offsetMinutes(Date.parse("2027-11-06T12:00:00Z"), "America/New_York")).toBe(-240);
    expect(zoned.offsetMinutes(Date.parse("2027-11-08T12:00:00Z"), "America/New_York")).toBe(-300);
  });

  test("a time the zone skips (spring forward) or has twice (fall back) is refused, never guessed", () => {
    for (const [date, time, zone] of [["2026-03-08", "02:30", "America/New_York"], ["2027-03-14", "02:00", "America/New_York"], ["2027-03-14", "02:59", "America/Chicago"],
      ["2027-03-14", "02:15", "America/Denver"], ["2027-03-14", "02:45", "America/Los_Angeles"], ["2027-03-28", "01:30", "Europe/London"]]) {
      expect(at(date, time, zone), `${zone} ${date} ${time}`).toEqual({ ok: false, reason: "NONEXISTENT" });
    }
    for (const [date, time, zone] of [["2026-11-01", "01:30", "America/New_York"], ["2027-11-07", "01:00", "America/New_York"], ["2027-11-07", "01:59", "America/Los_Angeles"],
      ["2026-10-25", "01:30", "Europe/London"], ["2027-10-31", "01:15", "Europe/London"]]) {
      expect(at(date, time, zone), `${zone} ${date} ${time}`).toEqual({ ok: false, reason: "AMBIGUOUS" });
    }
  });

  test("the zones the form offers, winter and summer; Taipei and Shanghai are UTC+8 all year", () => {
    const cases = [
      ["America/Chicago", "2026-12-01T00:00:00Z", "2026-07-01T23:00:00Z"],
      ["America/Denver", "2026-12-01T01:00:00Z", "2026-07-02T00:00:00Z"],
      ["America/Los_Angeles", "2026-12-01T02:00:00Z", "2026-07-02T01:00:00Z"],
      ["Asia/Taipei", "2026-11-30T10:00:00Z", "2026-07-01T10:00:00Z"],
      ["Asia/Shanghai", "2026-11-30T10:00:00Z", "2026-07-01T10:00:00Z"],
      ["Asia/Tokyo", "2026-11-30T09:00:00Z", "2026-07-01T09:00:00Z"],
      ["Europe/London", "2026-11-30T18:00:00Z", "2026-07-01T17:00:00Z"],
    ];
    for (const [zone, winter, summer] of cases) {
      expect(at("2026-11-30", "18:00", zone), zone).toEqual({ ok: true, instant: Date.parse(winter) });
      expect(at("2026-07-01", "18:00", zone), zone).toEqual({ ok: true, instant: Date.parse(summer) });
    }
    expect(zoned.COMMON_TIME_ZONES).toEqual(["America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles", "Asia/Taipei", "Asia/Shanghai", "Asia/Tokyo", "Europe/London"]);
    expect(zoned.HOUSE_TIME_ZONE).toBe("America/New_York");
  });

  test("conversions across midnight and the new year", () => {
    const eve = at("2026-12-31", "20:00", "America/New_York");
    expect(eve).toEqual({ ok: true, instant: Date.parse("2027-01-01T01:00:00Z") });
    expect(zoned.wallIn(eve.instant, "Asia/Taipei")).toEqual({ date: "2027-01-01", time: "09:00" });
    expect(zoned.wallIn(eve.instant, "America/Los_Angeles")).toEqual({ date: "2026-12-31", time: "17:00" });
    const taipeiMorning = at("2027-01-01", "08:00", "Asia/Taipei");
    expect(zoned.wallIn(taipeiMorning.instant, "America/New_York")).toEqual({ date: "2026-12-31", time: "19:00" });
    expect(zoned.wallIn(at("2026-11-20", "23:30", "America/Los_Angeles").instant, "Asia/Taipei")).toEqual({ date: "2026-11-21", time: "15:30" });
  });

  test("zones, dates and times are read strictly", () => {
    for (const zone of ["America/New_York", "Asia/Taipei", "America/Argentina/Buenos_Aires", "Europe/Paris"]) expect(zoned.validTimeZone(zone), zone).toBe(true);
    for (const zone of ["+08:00", "UTC+8", "EST", "UTC", "", null, undefined, "America/Nowhere", "../etc/passwd", "Asia/Taipei "]) expect(zoned.validTimeZone(zone), String(zone)).toBe(false);
    expect(zoned.parseIsoDate("2026-02-28")).toEqual({ y: 2026, m: 2, d: 28 });
    expect(zoned.parseIsoDate("2026-02-30")).toBeNull();
    expect(zoned.parseIsoDate("2026/11/20")).toBeNull();
    expect(zoned.parseClock("18:05")).toEqual({ h: 18, min: 5 });
    for (const text of ["24:00", "6:00", "6:00 PM", "18:60", "1800"]) expect(zoned.parseClock(text), text).toBeNull();
    // The modules that used these before share the same functions now (no second copy).
    expect(importZonedInstant).toBe(zoned.zonedInstant);
    expect(programsValidTimeZone).toBe(zoned.validTimeZone);
  });

  test("what people read: abbreviation and UTC offset, the long date with its weekday in three languages", () => {
    const winter = Date.parse("2026-11-20T23:00:00Z"), summer = Date.parse("2026-07-10T22:00:00Z");
    expect(zoned.zoneAbbreviation(winter, "America/New_York")).toBe("EST");
    expect(zoned.zoneAbbreviation(summer, "America/New_York")).toBe("EDT");
    expect(zoned.zoneAbbreviation(winter, "America/Los_Angeles")).toBe("PST");
    expect(zoned.zoneAbbreviation(summer, "Europe/London")).toBe("BST");
    expect(zoned.zoneAbbreviation(winter, "Asia/Taipei")).toBeNull();
    expect(zoned.formatUtcOffset(-300)).toBe("UTC−05:00");
    expect(zoned.formatUtcOffset(480)).toBe("UTC+08:00");
    expect(zoned.formatUtcOffset(345)).toBe("UTC+05:45");
    expect(zoned.describeInstant(winter, "America/New_York", "en-US")).toMatchObject({ date: "Friday, November 20, 2026", time: "18:00", wallDate: "2026-11-20", abbreviation: "EST", offset: "UTC−05:00" });
    expect(zoned.describeInstant(winter, "America/New_York", "zh-TW")).toMatchObject({ date: "2026年11月20日 星期五", weekday: "週五" });
    expect(zoned.describeInstant(winter, "Asia/Taipei", "zh-CN")).toMatchObject({ date: "2026年11月21日星期六", time: "07:00", offset: "UTC+08:00", abbreviation: null });
  });
});

describe("creating a one-to-one lesson in a time zone", () => {
  test("US Eastern, winter and summer: stored in UTC; the zone and the time as entered are kept in the same write", async () => {
    const store = freshStore();
    const winter = await make(store, { date: "2026-11-27", time: "18:00", timeZone: "America/New_York" });
    expect(winter.lesson).toMatchObject({ startsAt: "2026-11-27T23:00:00.000Z", endsAt: "2026-11-28T00:00:00.000Z", date: "2026-11-28" });
    expect(winter.schedule).toEqual({ timeZone: "America/New_York", localDate: "2026-11-27", localTime: "18:00", zoneGiven: true });
    expect(winter.warnings).toEqual([]);
    const summer = await make(store, { date: "2027-07-09", time: "20:00", timeZone: "America/New_York", minutes: 45 });
    expect(summer.lesson).toMatchObject({ startsAt: "2027-07-10T00:00:00.000Z", endsAt: "2027-07-10T00:45:00.000Z", date: "2027-07-10" });
    const [event] = (await store.eventsFor([winter.lesson.id])).filter(item => item.type === "server.lesson_scheduled");
    expect(event).toMatchObject({ source: "server", key: `server.lesson_scheduled:${winter.lesson.id}`, lessonId: winter.lesson.id, occurredAt: NOW, timeZone: "America/New_York", localDate: "2026-11-27", localTime: "18:00", minutes: 60, zoneGiven: true });
    // Codes and a zone only: no e-mail address, key or name in the event.
    expect(JSON.stringify(event)).not.toMatch(/@|#k=/);
    // The student link is made exactly as before.
    expect(winter.studentLink).toMatch(/^\/classroom\/L-[0-9a-f]{32}#k=[A-Za-z0-9_-]{43}$/);
  });

  test("without a time zone the request is Taipei time, exactly as before 2026-11-17", async () => {
    const store = freshStore();
    for (const [date, time] of [["2026-11-21", "07:00"], ["2026-12-31", "23:30"], ["2027-01-01", "00:15"], ["2027-03-14", "02:30"], ["2027-11-07", "01:30"]]) {
      const made = await make(store, { date, time });
      // The old formula: Date.parse(`${date}T${time}:00+08:00`).
      expect(made.lesson.startsAt, `${date} ${time}`).toBe(new Date(Date.parse(`${date}T${time}:00+08:00`)).toISOString());
      expect(made.lesson.date).toBe(date);
      expect(made.schedule).toEqual({ timeZone: "Asia/Taipei", localDate: date, localTime: time, zoneGiven: false });
    }
  });

  test("Taipei and Shanghai give the same instant; Chicago, Denver, Los Angeles, Tokyo and London follow their own rules", async () => {
    const store = freshStore();
    const taipei = await make(store, { date: "2026-12-02", time: "20:00", timeZone: "Asia/Taipei" });
    const shanghai = await make(store, { date: "2026-12-02", time: "20:00", timeZone: "Asia/Shanghai" });
    expect(shanghai.lesson.startsAt).toBe(taipei.lesson.startsAt);
    expect(taipei.lesson.startsAt).toBe("2026-12-02T12:00:00.000Z");
    const expected = { "America/Chicago": "2026-12-03T02:00:00.000Z", "America/Denver": "2026-12-03T03:00:00.000Z", "America/Los_Angeles": "2026-12-03T04:00:00.000Z", "Asia/Tokyo": "2026-12-02T11:00:00.000Z", "Europe/London": "2026-12-02T20:00:00.000Z" };
    for (const [timeZone, startsAt] of Object.entries(expected)) {
      expect((await make(store, { date: "2026-12-02", time: "20:00", timeZone })).lesson.startsAt, timeZone).toBe(startsAt);
    }
  });

  test("a skipped or doubled time, a bad zone, a bad date or a 12-hour time is refused with a code; nothing is stored", async () => {
    const store = freshStore();
    expect(await refusal(make(store, { date: "2027-03-14", time: "02:30", timeZone: "America/New_York" }))).toMatchObject({ codes: { time: "TIME_DOES_NOT_EXIST" } });
    expect(await refusal(make(store, { date: "2027-11-07", time: "01:30", timeZone: "America/New_York" }))).toMatchObject({ codes: { time: "TIME_IS_AMBIGUOUS" } });
    expect(await refusal(make(store, { date: "2027-03-28", time: "01:30", timeZone: "Europe/London" }))).toMatchObject({ codes: { time: "TIME_DOES_NOT_EXIST" } });
    for (const timeZone of ["+08:00", "EST", "", "Mars/Olympus"]) {
      expect(await refusal(make(store, { date: "2026-12-02", time: "20:00", timeZone })), timeZone).toMatchObject({ codes: { timeZone: "TIME_ZONE_INVALID" } });
    }
    expect((await refusal(make(store, { date: "2026-02-30", time: "20:00", timeZone: "America/New_York" }))).issues).toHaveProperty("date");
    expect((await refusal(make(store, { date: "2026-12-02", time: "6:00 PM", timeZone: "America/New_York" }))).issues).toHaveProperty("time");
    expect(await store.listLessons({ from: 0, to: Date.parse("2030-01-01") })).toEqual([]);
  });

  test("a lesson whose whole entry time has passed is refused; one that started but can still be entered is made with a warning", async () => {
    const store = freshStore();
    const wall = instant => zoned.wallIn(instant, "America/New_York");
    // 60 minutes, door closes 15 minutes after the end: start 75 minutes ago closes exactly now.
    const closed = wall(NOW - 75 * MIN);
    expect(await refusal(make(store, { ...closed, timeZone: "America/New_York" }))).toMatchObject({ codes: { time: "ENTRY_WINDOW_PASSED" } });
    const open = wall(NOW - 74 * MIN);
    const late = await make(store, { ...open, timeZone: "America/New_York" });
    expect(late.warnings).toEqual(["START_PASSED"]);
    expect(Date.parse(late.lesson.startsAt)).toBe(NOW - 74 * MIN);
    // The same rule for a request without a zone (an admin page still open from before).
    const taipei = zoned.wallIn(NOW - 3 * 60 * MIN, "Asia/Taipei");
    expect(await refusal(make(store, taipei))).toMatchObject({ codes: { time: "ENTRY_WINDOW_PASSED" } });
    const soon = await make(store, { ...wall(NOW + 10 * MIN), timeZone: "America/New_York" });
    expect(soon.warnings).toEqual([]);
  });

  test("the same code twice: the second is refused and leaves no second scheduling record", async () => {
    const store = freshStore();
    const first = await make(store, { code: "TEST-TZ-DUP", date: "2026-12-02", time: "20:00", timeZone: "America/New_York" });
    await expect(make(store, { code: "TEST-TZ-DUP", date: "2026-12-03", time: "20:00", timeZone: "Asia/Tokyo" })).rejects.toThrow(/already exists/);
    const lessons = await store.listLessons({ from: 0, to: Date.parse("2030-01-01") });
    expect(lessons.map(lesson => lesson.id)).toEqual([first.lesson.id]);
    const scheduled = (await store.eventsFor([first.lesson.id])).filter(event => event.type === "server.lesson_scheduled");
    expect(scheduled).toHaveLength(1);
  });
});

describe("what does not change", () => {
  test("entering is decided by the stored instants: a US Eastern lesson and the same moment entered as Taipei time open and close together", async () => {
    const store = freshStore();
    const provider = classroomProvider();
    const eastern = await make(store, { date: "2026-11-27", time: "18:00", timeZone: "America/New_York" }, NOW);
    const taipei = await make(store, { date: "2026-11-28", time: "07:00" }, NOW);
    expect(taipei.lesson.startsAt).toBe(eastern.lesson.startsAt);
    const start = Date.parse(eastern.lesson.startsAt), end = Date.parse(eastern.lesson.endsAt);
    const keyOf = link => new URLSearchParams(link.split("#")[1]).get("k");
    const tryAt = async (made, now) => (await joinClassroom({ store, provider, lessonId: made.lesson.id, key: keyOf(made.studentLink), now })).status;
    const tutorAt = async (made, now) => (await joinClassroom({ store, provider, lessonId: made.lesson.id, sessionEmail: "tutor@example.test", now })).status;
    for (const made of [eastern, taipei]) {
      expect(await tryAt(made, start - 16 * MIN)).toBe(403);
      expect(await tryAt(made, start - 15 * MIN)).toBe(200);
      expect(await tutorAt(made, start - 14 * MIN)).toBe(200);
      expect(await tryAt(made, end + 15 * MIN)).toBe(200);
      expect(await tryAt(made, end + 16 * MIN)).toBe(403);
    }
  });

  test("the overview gives the form the house zone and the entry window, and each lesson the zone it was entered in", async () => {
    const store = freshStore();
    const eastern = await make(store, { date: "2026-11-20", time: "18:00", timeZone: "America/New_York" });
    const tokyo = await make(store, { date: "2026-11-21", time: "09:00", timeZone: "Asia/Tokyo" });
    const view = await classroomOverview({ store, now: NOW });
    expect(view.scheduling).toEqual({ houseTimeZone: "America/New_York", legacyTimeZone: "Asia/Taipei", joinWindowBeforeMs: 15 * MIN, joinWindowAfterMs: 15 * MIN });
    expect(view.lessons.find(item => item.lessonId === eastern.lesson.id)).toMatchObject({ startsAt: "2026-11-20T23:00:00.000Z", timeZone: "America/New_York" });
    expect(view.lessons.find(item => item.lessonId === tokyo.lesson.id)).toMatchObject({ startsAt: "2026-11-21T00:00:00.000Z", timeZone: "Asia/Tokyo" });
    // A lesson stored before the change (no scheduling record) has no zone: it was Taipei time.
    await store.createLesson({ ...eastern.lesson, id: "L-0000000000000000000000000000old0", code: "TEST-TZ-OLD", participants: eastern.lesson.participants.map(entry => ({ ...entry, id: `${entry.id}x`, joinKeyHash: entry.joinKeyHash ? "0".repeat(64) : null })) });
    const again = await classroomOverview({ store, now: NOW });
    expect(again.lessons.find(item => item.code === "TEST-TZ-OLD")).toMatchObject({ timeZone: null });
  });
});
