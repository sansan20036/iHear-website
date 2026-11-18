// What stops a one-to-one lesson from being added, what went wrong when it was not added, and the
// words for both in the admin's three languages (2026-11-19). Before, a teacher pressed
// 「新增一對一課程」 and saw nothing: the button waited for the confirmation box without saying so,
// every refusal was written at the top of the page (out of sight, and cleared by the next automatic
// refresh), a lesson code already used was called "someone else changed this record", and the
// previous lesson's student link stayed under the form as if it were the new one.
//
// Pure functions and words only, so they are tested on their own (tests/classroom-admin-lesson-form.test.mjs).
// The server still checks everything and decides (lib/classroom-service.ts): these checks only say
// sooner, and in place, what it would refuse. Codes stay unique across every lesson, cancelled ones too.
import type { AdminLocale } from "../admin-context";

// The server's own rules (lib/classroom-service.ts LESSON_CODE, PERSON_CODE and EMAIL); a test
// keeps them the same.
export const LESSON_CODE_RULE = /^[A-Za-z0-9-]{1,40}$/;
export const PERSON_CODE_RULE = /^[A-Za-z0-9-]{1,20}$/;
export const EMAIL_RULE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type LessonField = "timeZone" | "date" | "time" | "minutes" | "code" | "tutorCode" | "tutorEmail" | "studentCode";
/** The fields in the order they are on the form: the first one marked is the one focused. */
export const LESSON_FIELDS: readonly LessonField[] = ["timeZone", "date", "time", "minutes", "code", "tutorCode", "tutorEmail", "studentCode"];
export const isLessonField = (value: string): value is LessonField => (LESSON_FIELDS as readonly string[]).includes(value);

// missing / format: this page's own check; sameAsTutor: the student code is the tutor's; taken: the
// lesson code belongs to another lesson; check: the server named the field without saying more.
export type FieldProblem = "missing" | "format" | "sameAsTutor" | "taken" | "check";
export type FieldProblems = Partial<Record<LessonField, FieldProblem>>;

/** The lesson and people fields, read as the server reads them (trimmed; the e-mail in lower case). */
export function peopleFieldProblems(values: { code: string; tutorCode: string; tutorEmail: string; studentCode: string }): FieldProblems {
  const problems: FieldProblems = {};
  const code = values.code.trim(), tutorCode = values.tutorCode.trim(), studentCode = values.studentCode.trim();
  const tutorEmail = values.tutorEmail.trim().toLowerCase();
  if (!code) problems.code = "missing";
  else if (!LESSON_CODE_RULE.test(code)) problems.code = "format";
  if (!tutorCode) problems.tutorCode = "missing";
  else if (!PERSON_CODE_RULE.test(tutorCode)) problems.tutorCode = "format";
  if (!tutorEmail) problems.tutorEmail = "missing";
  else if (!EMAIL_RULE.test(tutorEmail) || tutorEmail.length > 320) problems.tutorEmail = "format";
  if (!studentCode) problems.studentCode = "missing";
  else if (!PERSON_CODE_RULE.test(studentCode)) problems.studentCode = "format";
  else if (tutorCode === studentCode) problems.studentCode = "sameAsTutor";
  return problems;
}

/** The first marked field, in form order (the one to focus). */
export const firstField = (problems: FieldProblems) => LESSON_FIELDS.find((field) => problems[field]) ?? null;

// Why the button cannot be pressed yet, in the order the person meets them on the form.
export type BlockReason = "zoneChoice" | "time" | "minutes" | "timeProblem" | "windowPassed" | "confirm";
export function addBlockedBy(state: { plan: "incomplete" | "minutes" | "error" | "ok"; windowPassed: boolean; zoneChoicePending: boolean; confirmed: boolean }): BlockReason | null {
  if (state.zoneChoicePending) return "zoneChoice";
  if (state.plan === "incomplete") return "time";
  if (state.plan === "minutes") return "minutes";
  if (state.plan === "error") return "timeProblem";
  if (state.windowPassed) return "windowPassed";
  if (!state.confirmed) return "confirm";
  return null;
}

export type TimeRefusal = "ENTRY_WINDOW_PASSED" | "TIME_ZONE_INVALID" | "TIME_DOES_NOT_EXIST" | "TIME_IS_AMBIGUOUS";
const TIME_REFUSALS: readonly string[] = ["ENTRY_WINDOW_PASSED", "TIME_ZONE_INVALID", "TIME_DOES_NOT_EXIST", "TIME_IS_AMBIGUOUS"];
export type AddFailure =
  | { kind: "fields"; fields: FieldProblems }
  | { kind: "time"; reason: TimeRefusal }
  | { kind: "codeTaken"; code: string }
  | { kind: "other"; error: unknown };

// The answer the lesson API gives, unchanged, for a code another lesson already has: 409 with the
// store's "A lesson with this code already exists" (file and Postgres stores alike). Another 409 is
// not taken for a used code.
export const CODE_TAKEN_ANSWER = /^A lesson with this code already exists$/;

/** What a refused add means, from the lesson API's answer (adminFetch's error). */
export function addFailureOf(error: unknown, request: { code: string }): AddFailure {
  const details = (error ?? {}) as { status?: number; message?: string; codes?: Record<string, string>; issues?: Record<string, string> };
  if (details.status === 409 && CODE_TAKEN_ANSWER.test(String(details.message ?? ""))) return { kind: "codeTaken", code: request.code.trim() };
  if (details.status === 400) {
    const reason = details.codes?.time ?? details.codes?.timeZone;
    if (reason && TIME_REFUSALS.includes(reason)) return { kind: "time", reason: reason as TimeRefusal };
    const fields = Object.keys(details.issues ?? {}).filter(isLessonField);
    if (fields.length) return { kind: "fields", fields: Object.fromEntries(fields.map((field) => [field, "check"])) };
  }
  return { kind: "other", error };
}

/** The fields to mark for a refusal of the time itself. */
export const timeRefusalFields = (reason: TimeRefusal): FieldProblems =>
  reason === "TIME_ZONE_INVALID" ? { timeZone: "check" } : { date: "check", time: "check" };

export type LessonFormWords = {
  fieldNames: Record<LessonField, string>;
  blocked: Record<BlockReason, string>;
  notAdded: (why: string) => string;
  fixFields: (fields: string) => string;
  list: string;
  missing: (field: string) => string;
  codeFormat: string;
  personFormat: (field: string) => string;
  emailFormat: string;
  sameAsTutor: string;
  codeTaken: (code: string) => string;
  check: (field: string) => string;
  serverFailed: string;
  linkCreated: (code: string) => string;
  linkReissued: (code: string) => string;
  copyFirst: string;
  linkHidden: (code: string) => string;
  listNote: string;
};

export const LESSON_FORM_WORDS: Record<AdminLocale, LessonFormWords> = {
  en: {
    fieldNames: { timeZone: "time zone", date: "date", time: "start time", minutes: "length", code: "lesson code", tutorCode: "tutor code", tutorEmail: "tutor sign-in email", studentCode: "student code" },
    blocked: {
      zoneChoice: "Choose above what should happen to the start time after the time zone change; then the lesson can be added.",
      time: "Choose the time zone, the date and the start time first; then the lesson can be added.",
      minutes: "Set the length to 15–240 minutes first; then the lesson can be added.",
      timeProblem: "Fix the time problem shown above first; then the lesson can be added.",
      windowPassed: "This lesson's whole entry time has already passed, so it cannot be added. Check the date, the time and the time zone.",
      confirm: "Tick \"I have checked the date, the time zone and the start time\" above first; then the lesson can be added.",
    },
    notAdded: (why) => `The lesson was not added. ${why}`,
    fixFields: (fields) => `Fix the marked fields: ${fields}.`,
    list: ", ",
    missing: (field) => `Enter the ${field}.`,
    codeFormat: "Use 1–40 letters, digits or hyphens (-), without spaces.",
    personFormat: (field) => `Use 1–20 letters, digits or hyphens (-) for the ${field}, without spaces.`,
    emailFormat: "Enter the Google account e-mail the tutor signs in with, for example name@gmail.com.",
    sameAsTutor: "The student code must differ from the tutor code.",
    codeTaken: (code) => `The lesson code "${code}" is already used by another lesson (cancelled lessons and lessons not in the list count too). Choose a new code.`,
    check: (field) => `Check the ${field}.`,
    serverFailed: "The server did not finish adding it. Reload the page and look for the lesson in the list before trying again: it may have been added already.",
    linkCreated: (code) => `Lesson ${code} added. Its student's personal link (shown only now; send it to the family):`,
    linkReissued: (code) => `New student link for lesson ${code} (shown only now; the old link no longer enters):`,
    copyFirst: "Copy this link before you add the next lesson: it is hidden as soon as the form is changed.",
    linkHidden: (code) => `The student link of lesson ${code} is hidden now, so it cannot be taken for another lesson's. If it was not copied, use "Reissue student link" for ${code} in the list below while the lesson is listed (from 24 hours before to 24 hours after now).`,
    listNote: "This list shows only lessons from 24 hours ago to 24 hours ahead. A new lesson code must differ from every lesson made before, including lessons not shown here and cancelled ones.",
  },
  zhHant: {
    fieldNames: { timeZone: "時區", date: "日期", time: "開始時間", minutes: "時長", code: "課程代碼", tutorCode: "小老師代碼", tutorEmail: "小老師登入 Email", studentCode: "學生代碼" },
    blocked: {
      zoneChoice: "請先在上方選擇時區改變後開始時間要怎麼處理，才能新增課程。",
      time: "請先選好時區、日期和開始時間，才能新增課程。",
      minutes: "請先把時長改成 15 到 240 分鐘，才能新增課程。",
      timeProblem: "請先修正上方標示的時間問題，才能新增課程。",
      windowPassed: "這堂課的入場時間已經全部過了，不能新增。請檢查日期、時間和時區。",
      confirm: "請先勾選上方的「我已確認日期、時區和開始時間」，才能新增課程。",
    },
    notAdded: (why) => `課程沒有建立。${why}`,
    fixFields: (fields) => `請修正標示的欄位：${fields}。`,
    list: "、",
    missing: (field) => `請填寫${field}。`,
    codeFormat: "只能用英文字母、數字和「-」，1 到 40 個字元，不能有空格。",
    personFormat: (field) => `${field}只能用英文字母、數字和「-」，1 到 20 個字元，不能有空格。`,
    emailFormat: "請填寫小老師登入教室用的 Google 帳號 Email，例如 name@gmail.com。",
    sameAsTutor: "學生代碼不能和小老師代碼相同。",
    codeTaken: (code) => `課程代碼「${code}」已被其他課程使用（包括已取消、以及不在清單上的課程），請換一個新的代碼。`,
    check: (field) => `請檢查${field}。`,
    serverFailed: "伺服器沒有完成新增。再試之前，請先重新載入頁面，看看課程清單裡是否已經有這堂課。",
    linkCreated: (code) => `已建立課程 ${code}。這堂課的學生專屬連結（只顯示這一次，請交給家長）：`,
    linkReissued: (code) => `課程 ${code} 的新學生連結（只顯示這一次；舊連結已無法進入）：`,
    copyFirst: "新增下一堂課前，請先複製這個連結：表單一有修改，這個連結就會隱藏。",
    linkHidden: (code) => `課程 ${code} 的學生連結已隱藏，避免和其他課程的連結混淆。如果還沒複製，請在下方清單中 ${code} 那一列按「重發學生連結」（清單只列出前後 24 小時內的課程）。`,
    listNote: "這份清單只列出前後 24 小時內的課程。新的課程代碼不能和以前建立過的任何課程相同，包括沒有列在這裡和已取消的課程。",
  },
  zhHans: {
    fieldNames: { timeZone: "时区", date: "日期", time: "开始时间", minutes: "时长", code: "课程代码", tutorCode: "小老师代码", tutorEmail: "小老师登录 Email", studentCode: "学生代码" },
    blocked: {
      zoneChoice: "请先在上方选择时区改变后开始时间要怎么处理，才能新增课程。",
      time: "请先选好时区、日期和开始时间，才能新增课程。",
      minutes: "请先把时长改成 15 到 240 分钟，才能新增课程。",
      timeProblem: "请先修正上方标示的时间问题，才能新增课程。",
      windowPassed: "这堂课的入场时间已经全部过了，不能新增。请检查日期、时间和时区。",
      confirm: "请先勾选上方的「我已确认日期、时区和开始时间」，才能新增课程。",
    },
    notAdded: (why) => `课程没有建立。${why}`,
    fixFields: (fields) => `请修正标出的字段：${fields}。`,
    list: "、",
    missing: (field) => `请填写${field}。`,
    codeFormat: "只能用英文字母、数字和「-」，1 到 40 个字符，不能有空格。",
    personFormat: (field) => `${field}只能用英文字母、数字和「-」，1 到 20 个字符，不能有空格。`,
    emailFormat: "请填写小老师登录教室用的 Google 账号 Email，例如 name@gmail.com。",
    sameAsTutor: "学生代码不能和小老师代码相同。",
    codeTaken: (code) => `课程代码「${code}」已被其他课程使用（包括已取消、以及不在列表上的课程），请换一个新的代码。`,
    check: (field) => `请检查${field}。`,
    serverFailed: "服务器没有完成新增。再试之前，请先重新加载页面，看看课程列表里是否已经有这堂课。",
    linkCreated: (code) => `已建立课程 ${code}。这堂课的学生专属链接（只显示这一次，请交给家长）：`,
    linkReissued: (code) => `课程 ${code} 的新学生链接（只显示这一次；旧链接已无法进入）：`,
    copyFirst: "新增下一堂课前，请先复制这个链接：表单一有修改，这个链接就会隐藏。",
    linkHidden: (code) => `课程 ${code} 的学生链接已隐藏，避免和其他课程的链接混淆。如果还没复制，请在下方列表中 ${code} 那一行按「重发学生链接」（列表只列出前后 24 小时内的课程）。`,
    listNote: "这份列表只列出前后 24 小时内的课程。新的课程代码不能和以前建立过的任何课程相同，包括没有列在这里和已取消的课程。",
  },
};

/** The message under one field. */
export function fieldMessage(words: LessonFormWords, field: LessonField, problem: FieldProblem, code = ""): string {
  const name = words.fieldNames[field];
  if (problem === "missing") return words.missing(name);
  if (problem === "taken") return words.codeTaken(code);
  if (problem === "sameAsTutor") return words.sameAsTutor;
  if (problem === "format") {
    if (field === "code") return words.codeFormat;
    if (field === "tutorEmail") return words.emailFormat;
    return words.personFormat(name);
  }
  return words.check(name);
}

/** The line under the button for marked fields: "The lesson was not added. Fix the marked fields: …". */
export function fieldsSummary(words: LessonFormWords, problems: FieldProblems): string {
  const names = LESSON_FIELDS.filter((field) => problems[field]).map((field) => words.fieldNames[field]);
  return words.notAdded(words.fixFields(names.join(words.list)));
}
