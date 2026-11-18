import { afterAll, beforeEach, describe, expect, test, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// Adding a one-to-one lesson from the admin page (2026-11-19). On 11/18 an add with the code
// "ihear" was refused because a cancelled lesson from 11/16 already had it (codes are unique across
// every lesson); the page said "someone else changed this record", at the top of the page, for at
// most 15 seconds, and kept an earlier (cancelled) lesson's link under the form. These tests hold
// the form's checks to the server's and its words to what the lesson API really answers. The
// API, its rules, its authorisation and the uniqueness of codes are unchanged; local file store and
// the synthetic provider only, nothing reaches a hosted database, Zoom or Google.
const directory = await mkdtemp(path.join(os.tmpdir(), "ihear-lesson-form-"));
const ORIGIN = "http://localhost:3000";
const OWNER = "owner@example.test", TUTOR = "tutor@example.test";
vi.mock("../auth.js", () => ({ auth: vi.fn() }));
vi.mock("../lib/admin-store", () => ({ findAdminAccount: vi.fn(), appendAdminActivity: vi.fn() }));
vi.mock("../lib/rate-limit", async original => ({ ...await original(), enforceRateLimit: vi.fn() }));
import { auth } from "../auth.js";
import { appendAdminActivity, findAdminAccount } from "../lib/admin-store";
import { enforceRateLimit } from "../lib/rate-limit";
vi.stubEnv("AUTH_OWNER_EMAILS", OWNER);
vi.stubEnv("IHEAR_FORCE_FILE_STORE", "1");
vi.stubEnv("IHEAR_TEST_DATA_DIR", directory);
vi.stubEnv("CLASSROOM_PROVIDER", "synthetic");
vi.stubEnv("CLASSROOM_DRIVE", "local");
vi.stubEnv("CLASSROOM_SYNTHETIC_SECRET", "lesson-form-token-test-only");
vi.stubEnv("VERCEL_ENV", "");
const lessonsRoute = await import("../app/api/admin/classrooms/route");
const lessonRoute = await import("../app/api/admin/classrooms/[lessonId]/route");
const { adminFetch } = await import("../app/admin/admin-api");
const service = await import("../lib/classroom-service");
const checks = await import("../app/admin/classrooms/lesson-form-checks");
const { addBlockedBy, addFailureOf, fieldMessage, fieldsSummary, firstField, LESSON_FORM_WORDS, peopleFieldProblems, timeRefusalFields } = checks;

const realFetch = globalThis.fetch;
afterAll(async () => {
  globalThis.fetch = realFetch;
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});
beforeEach(() => {
  vi.clearAllMocks();
  auth.mockResolvedValue({ user: { email: OWNER } });
  findAdminAccount.mockResolvedValue(null);
  appendAdminActivity.mockResolvedValue(undefined);
  enforceRateLimit.mockResolvedValue({ limited: false, result: { allowed: true, limit: 30, remaining: 29, retryAfter: 60, resetAt: "2026-11-20T00:01:00.000Z" } });
  // The page's adminFetch, answered by the real lesson routes (same origin, as from the browser).
  globalThis.fetch = async (url, init = {}) => {
    const request = new Request(`${ORIGIN}${url}`, { ...init, headers: { origin: ORIGIN, ...init.headers } });
    const lessonId = /^\/api\/admin\/classrooms\/([^/]+)$/.exec(url)?.[1];
    return lessonId ? lessonRoute.PATCH(request, { params: Promise.resolve({ lessonId }) }) : lessonsRoute.POST(request);
  };
});

const lessonFields = (fields = {}) => ({ date: "2030-01-15", time: "20:00", minutes: 60, timeZone: "America/New_York", tutorCode: "TEST-T1", tutorEmail: TUTOR, studentCode: "TEST-S1", ...fields });
// The page's add: adminFetch to the lesson API; a refusal is what addFailureOf makes of it.
const add = async fields => {
  const request = lessonFields(fields);
  try {
    return { ok: true, data: await adminFetch("/api/admin/classrooms", { method: "POST", body: JSON.stringify(request) }) };
  } catch (error) {
    return { ok: false, error, failure: addFailureOf(error, request) };
  }
};

describe("the lesson API's real answers, as the add form reads them", () => {
  test("a code a CANCELLED lesson already has (the 11/18 'ihear' case) is said as taken, with the code trimmed; the API still answers 409 as before", async () => {
    const first = await add({ code: "TEST-IHEAR" });
    expect(first.ok).toBe(true);
    const lessonId = first.data.lesson.lessonId;
    await adminFetch(`/api/admin/classrooms/${lessonId}`, { method: "PATCH", body: JSON.stringify({ action: "cancel", studentCode: "TEST-S1" }) });
    const again = await add({ code: "  TEST-IHEAR " });
    expect(again.ok).toBe(false);
    expect(again.error).toMatchObject({ status: 409, message: "A lesson with this code already exists" });
    expect(again.failure).toEqual({ kind: "codeTaken", code: "TEST-IHEAR" });
    // Uniqueness is unchanged: a code differing only in case is another code.
    expect((await add({ code: "test-ihear" })).ok).toBe(true);
  });

  test("a lesson that started 7 minutes ago is added (with the server's warning); one whose whole entry time passed is refused as a time problem", async () => {
    const now = Date.now();
    const wall = instant => Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(instant).map(part => [part.type, part.value]));
    const started = wall(now - 7 * 60_000);
    const late = await add({ code: "TEST-STARTED", date: `${started.year}-${started.month}-${started.day}`, time: `${started.hour}:${started.minute}` });
    expect(late.ok).toBe(true);
    expect(late.data.warnings).toEqual(["START_PASSED"]);
    const gone = wall(now - 3 * 3_600_000);
    const passed = await add({ code: "TEST-GONE", date: `${gone.year}-${gone.month}-${gone.day}`, time: `${gone.hour}:${gone.minute}` });
    expect(passed.failure).toEqual({ kind: "time", reason: "ENTRY_WINDOW_PASSED" });
    expect(timeRefusalFields("ENTRY_WINDOW_PASSED")).toEqual({ date: "check", time: "check" });
  });

  test("times the zone skips or has twice, and a zone that is not one, are time problems on the right fields", async () => {
    expect((await add({ code: "TEST-GAP", date: "2030-03-10", time: "02:30" })).failure).toEqual({ kind: "time", reason: "TIME_DOES_NOT_EXIST" });
    expect((await add({ code: "TEST-TWICE", date: "2030-11-03", time: "01:30" })).failure).toEqual({ kind: "time", reason: "TIME_IS_AMBIGUOUS" });
    expect((await add({ code: "TEST-ZONE", timeZone: "Mars/Olympus" })).failure).toEqual({ kind: "time", reason: "TIME_ZONE_INVALID" });
    expect(timeRefusalFields("TIME_ZONE_INVALID")).toEqual({ timeZone: "check" });
  });

  test("fields the server refuses are the fields marked, in form order; nothing else of the server's answer is used", async () => {
    const refused = await add({ code: "with space", tutorEmail: "not-an-email", studentCode: "" });
    expect(refused.error.status).toBe(400);
    expect(refused.failure).toEqual({ kind: "fields", fields: { code: "check", tutorEmail: "check", studentCode: "check" } });
    expect(firstField(refused.failure.fields)).toBe("code");
  });

  test("signed out, cross-origin, too many requests or a server failure are 'other'; another 409 is never called a used code", async () => {
    auth.mockResolvedValue(null);
    expect((await add({ code: "TEST-OUT" })).failure).toMatchObject({ kind: "other", error: { status: 403 } });
    auth.mockResolvedValue({ user: { email: OWNER } });
    enforceRateLimit.mockResolvedValue({ limited: true, response: new Response(JSON.stringify({ error: "Too many requests", retryAfter: 30 }), { status: 429, headers: { "content-type": "application/json" } }) });
    expect((await add({ code: "TEST-BUSY" })).failure).toMatchObject({ kind: "other", error: { status: 429 } });
    expect(addFailureOf(Object.assign(new Error("The lesson is cancelled"), { status: 409, code: "LESSON_CANCELLED" }), { code: "X" }).kind).toBe("other");
    expect(addFailureOf(Object.assign(new Error("Could not add the lesson"), { status: 500 }), { code: "X" }).kind).toBe("other");
    expect(addFailureOf(null, { code: "X" }).kind).toBe("other");
  });

  test("the success answer carries the lesson's own code and a link only behind #, for the box under the form", async () => {
    const made = await add({ code: "TEST-NEW1" });
    expect(made.data.lesson.code).toBe("TEST-NEW1");
    expect(made.data.studentLink).toMatch(/^\/classroom\/L-[0-9a-f]{32}#k=[A-Za-z0-9_-]{43}$/);
  });
});

describe("the form's own checks are the server's", () => {
  test("the same patterns as lib/classroom-service.ts", () => {
    expect(checks.LESSON_CODE_RULE.source).toBe(service.LESSON_CODE.source);
    expect(checks.PERSON_CODE_RULE.source).toBe(service.PERSON_CODE.source);
  });

  // Each case through the real server and through the form: the same fields are refused.
  const cases = [
    {}, { code: "" }, { code: "a b" }, { code: "x".repeat(41) }, { code: "x".repeat(40) }, { code: "  TEST-TRIM  " },
    { tutorCode: "" }, { tutorCode: "Bryan" }, { tutorCode: "名字" }, { tutorCode: "y".repeat(21) },
    { tutorEmail: "" }, { tutorEmail: "Name.With.Dots@Gmail.com" }, { tutorEmail: "no-at-sign" }, { tutorEmail: "a@b" }, { tutorEmail: " spaced@example.test " }, { tutorEmail: `${"e".repeat(310)}@example.test` },
    { studentCode: "" }, { studentCode: "Ryan" }, { studentCode: "TEST-T1" }, { studentCode: "test-t1" }, { tutorCode: "", studentCode: "" },
  ];
  test.each(cases.map((fields, index) => [index, fields]))("case %i: the form marks exactly the people fields the server refuses", async (index, fields) => {
    const values = { code: `TEST-EQ${index}`, ...lessonFields(), ...fields };
    const serverFields = await service.createClassroomLesson({ store: { createLesson: async () => undefined }, input: values, actor: OWNER, now: Date.parse("2030-01-01T00:00:00Z") })
      .then(() => [], error => Object.keys(error.issues ?? {}).filter(key => ["code", "tutorCode", "tutorEmail", "studentCode"].includes(key)).sort());
    expect(Object.keys(peopleFieldProblems(values)).sort()).toEqual(serverFields);
  });

  test("what each problem is called", () => {
    expect(peopleFieldProblems({ code: "", tutorCode: "a b", tutorEmail: "x@y", studentCode: "T1" })).toEqual({ code: "missing", tutorCode: "format", tutorEmail: "format" });
    expect(peopleFieldProblems({ code: "C1", tutorCode: "T1", tutorEmail: "t@e.st", studentCode: "T1" })).toEqual({ studentCode: "sameAsTutor" });
    expect(peopleFieldProblems({ code: " C1 ", tutorCode: "T1", tutorEmail: " T@E.ST ", studentCode: "S1" })).toEqual({});
  });
});

describe("why the button waits", () => {
  const state = (changes = {}) => ({ plan: "ok", windowPassed: false, zoneChoicePending: false, confirmed: true, ...changes });
  test("in the order the person meets them on the form; nothing when it can be pressed", () => {
    expect(addBlockedBy(state())).toBeNull();
    expect(addBlockedBy(state({ confirmed: false }))).toBe("confirm");
    expect(addBlockedBy(state({ windowPassed: true, confirmed: false }))).toBe("windowPassed");
    expect(addBlockedBy(state({ plan: "error", confirmed: false }))).toBe("timeProblem");
    expect(addBlockedBy(state({ plan: "minutes" }))).toBe("minutes");
    expect(addBlockedBy(state({ plan: "incomplete", confirmed: false }))).toBe("time");
    expect(addBlockedBy(state({ plan: "incomplete", zoneChoicePending: true }))).toBe("zoneChoice");
  });
});

describe("the words, in English, Traditional and Simplified Chinese", () => {
  const locales = ["en", "zhHant", "zhHans"];
  const shape = value => (typeof value === "function" ? `fn${value.length}` : typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, shape(item)])) : typeof value);
  test("the same messages in each language (same keys, same kinds, every reason and field)", () => {
    const [en, ...others] = locales.map(locale => shape(LESSON_FORM_WORDS[locale]));
    for (const other of others) expect(other).toEqual(en);
    for (const locale of locales) {
      expect(Object.keys(LESSON_FORM_WORDS[locale].fieldNames).sort()).toEqual([...checks.LESSON_FIELDS].sort());
      expect(Object.keys(LESSON_FORM_WORDS[locale].blocked).sort()).toEqual(["confirm", "minutes", "time", "timeProblem", "windowPassed", "zoneChoice"]);
    }
  });

  const every = words => [
    ...Object.values(words.fieldNames), ...Object.values(words.blocked), words.codeFormat, words.emailFormat, words.sameAsTutor, words.copyFirst, words.listNote, words.serverFailed,
    words.notAdded("WHY"), words.fixFields("F1、F2"), words.missing("FIELD"), words.personFormat("FIELD"), words.check("FIELD"),
    words.codeTaken("CODE-X1"), words.linkCreated("CODE-X1"), words.linkReissued("CODE-X1"), words.linkHidden("CODE-X1"),
  ];
  test("every message is filled in, and the code, field or reason it is given is in it", () => {
    for (const locale of locales) {
      const words = LESSON_FORM_WORDS[locale];
      for (const line of every(words)) expect(line.trim().length).toBeGreaterThan(0);
      for (const line of [words.codeTaken("CODE-X1"), words.linkCreated("CODE-X1"), words.linkReissued("CODE-X1"), words.linkHidden("CODE-X1")]) expect(line).toContain("CODE-X1");
      expect(words.notAdded("WHY")).toContain("WHY");
      for (const line of [words.missing("FIELD"), words.personFormat("FIELD"), words.check("FIELD")]) expect(line).toContain("FIELD");
    }
  });
  test("each language is written in its own script: no Chinese in English, no Simplified in Traditional, no Traditional in Simplified", () => {
    const simplifiedOnly = /[课码请时间师学这显确认选择钟连链钮动单检标栏户号账录间]/u;
    const traditionalOnly = /[課碼請時間師學這顯確認選擇鐘連鏈鈕動單檢標欄戶號帳錄]/u;
    for (const line of every(LESSON_FORM_WORDS.en)) expect(line).not.toMatch(/\p{Script=Han}/u);
    for (const line of every(LESSON_FORM_WORDS.zhHant)) expect(line).not.toMatch(simplifiedOnly);
    for (const line of every(LESSON_FORM_WORDS.zhHans)) expect(line).not.toMatch(traditionalOnly);
  });
  test("a used code says so, cancelled and unlisted lessons included; the field and the line under the button agree", () => {
    const zh = LESSON_FORM_WORDS.zhHant;
    expect(zh.codeTaken("ihear")).toBe("課程代碼「ihear」已被其他課程使用（包括已取消、以及不在清單上的課程），請換一個新的代碼。");
    expect(fieldMessage(zh, "code", "taken", "ihear")).toBe(zh.codeTaken("ihear"));
    expect(zh.codeTaken("ihear")).not.toMatch(/其他管理員已更改/);
    expect(fieldsSummary(zh, { studentCode: "missing", code: "format" })).toBe("課程沒有建立。請修正標示的欄位：課程代碼、學生代碼。");
    expect(fieldMessage(LESSON_FORM_WORDS.en, "tutorCode", "format")).toBe("Use 1–20 letters, digits or hyphens (-) for the tutor code, without spaces.");
    expect(fieldMessage(zh, "tutorEmail", "format")).toBe(zh.emailFormat);
    expect(fieldMessage(zh, "studentCode", "sameAsTutor")).toBe(zh.sameAsTutor);
  });
  test("no message carries a link, a key or an address of its own", () => {
    for (const locale of locales) for (const line of every(LESSON_FORM_WORDS[locale])) expect(line).not.toMatch(/https?:|#k=|\/classroom\/L-/);
  });
});
