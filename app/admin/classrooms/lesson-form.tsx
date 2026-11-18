"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { AdminLocale } from "../admin-context";
import { displayError } from "../admin-api";
import {
  addBlockedBy, fieldMessage, fieldsSummary, firstField, LESSON_FORM_WORDS, peopleFieldProblems, timeRefusalFields,
  type AddFailure, type FieldProblems, type LessonField, type TimeRefusal,
} from "./lesson-form-checks";
import { COMMON_TIME_ZONES, describeInstant, parseClock, parseIsoDate, validTimeZone, wallIn, zonedInstant } from "../../../lib/zoned-time";
import { allTimeZones, INTL_LOCALE, offsetAt, shortStamp, zoneMark, zoneName } from "./time-zone-names";

// Adding a one-to-one lesson (2026-11-17): time zone → date → start → length, then the lesson and
// its people, then the converted times to check, a confirmation, and only then the button. The
// zone defaults to US Eastern (the house zone); the start is picked on a 24-hour clock, so AM and
// PM cannot be mixed up. The preview converts with the same code the server uses
// (lib/zoned-time.ts); the server checks everything again and is the one that decides.
//
// 2026-11-19: the result of a press is said next to the button and stays there (the overview's
// automatic refresh never clears it); the field to fix is marked and focused; a disabled button
// says why; the lesson and people fields are checked with the server's own rules before sending;
// a code another lesson has is said as such (lesson-form-checks.ts). Any change to the form tells
// the page (onChange), which then hides the previous lesson's student link.

export type Scheduling = { houseTimeZone: string; legacyTimeZone: string; joinWindowBeforeMs: number; joinWindowAfterMs: number };
export type LessonRequest = { code: string; date: string; time: string; minutes: number; tutorCode: string; tutorEmail: string; studentCode: string; timeZone: string };
/** What the page answers for one press: the lesson's code when it was added, or why it was not. */
export type AddResult = { ok: true; code: string } | { ok: false; failure: AddFailure };

const TAIPEI = "Asia/Taipei";
const OTHER = "__other";
const HOURS = Array.from({ length: 24 }, (_, hour) => String(hour).padStart(2, "0"));
const MINUTES = Array.from({ length: 60 }, (_, minute) => String(minute).padStart(2, "0"));

type Copy = {
  title: string; timeZone: string; commonZones: string; otherZone: string; searchZone: string; searchPlaceholder: string; searchHint: string; searchNoMatch: string;
  date: string; time: string; hour: string; minute: string; minutes: string; code: string; tutorCode: string; tutorEmail: string; studentCode: string; emailHint: string;
  previewTitle: string; incomplete: string; minutesInvalid: string; entered: string; house: string; taipei: string; yours: (zone: string) => string;
  entry: (zone: string, from: string, to: string, before: number, after: number) => string;
  startPassed: (minutes: number, after: number) => string; windowPassed: (after: number) => string;
  gap: (zone: string, date: string, time: string) => string; repeat: (zone: string, date: string, time: string) => string; zoneInvalid: string;
  zoneChanged: (from: string, to: string) => string; keepLocal: string; keepLocalNote: (text: string) => string; keepInstant: string; keepInstantNote: (text: string) => string; choose: string;
  confirm: (text: string) => string; add: string; adding: string; created: (code: string, text: string) => string;
};

const copy: Record<AdminLocale, Copy> = {
  en: {
    title: "Add a one-to-one lesson",
    timeZone: "Time zone", commonZones: "Common time zones", otherZone: "Other time zone (search)…", searchZone: "Search all time zones",
    searchPlaceholder: "City or region, e.g. Paris", searchHint: "Type a city or region, then pick it from the list.", searchNoMatch: "No time zone has that name. Pick one from the list.",
    date: "Date", time: "Start time (24-hour)", hour: "Start time: hour", minute: "Start time: minute", minutes: "Length (minutes)",
    code: "Lesson code", tutorCode: "Tutor code", tutorEmail: "Tutor sign-in email", studentCode: "Student code",
    emailHint: "The tutor must sign in to the classroom with exactly this Google account. Capital letters don't matter; every other character must match, including the dots in a Gmail address.",
    previewTitle: "Check the converted times",
    incomplete: "Choose the time zone, the date and the start time to see the lesson in other time zones.",
    minutesInvalid: "The length must be 15 to 240 minutes.",
    entered: "As entered", house: "US Eastern", taipei: "Taiwan", yours: (zone) => `Your computer: ${zone}`,
    entry: (zone, from, to, before, after) => `The classroom is open ${from} to ${to} (${zone}): from ${before} minutes before the start to ${after} minutes after the end.`,
    startPassed: (minutes, after) => `The start time was ${minutes} minute${minutes === 1 ? "" : "s"} ago. You can still add it: the tutor and the student can enter until ${after} minutes after the end.`,
    windowPassed: (after) => `This lesson's whole entry time has already passed (the classroom closes ${after} minutes after the end), so it cannot be added. Check the date, the time and the time zone.`,
    gap: (zone, date, time) => `${time} on ${date} does not exist in ${zone}: that night the clocks jump forward for daylight saving time and skip it. Choose another time.`,
    repeat: (zone, date, time) => `${time} on ${date} happens twice in ${zone}: that night the clocks go back at the end of daylight saving time, so it is not clear which one is meant. Choose another time.`,
    zoneInvalid: "Choose a time zone from the list.",
    zoneChanged: (from, to) => `You changed the time zone from ${from} to ${to}. What should happen to the start time?`,
    keepLocal: "Keep the time as typed", keepLocalNote: (text) => `${text}. The lesson moves to a different moment.`,
    keepInstant: "Keep the same moment", keepInstantNote: (text) => `Becomes ${text}: the same moment as before.`,
    choose: "Choose one of the two before adding the lesson.",
    confirm: (text) => `I have checked the date, the time zone and the start time: ${text}`,
    add: "Add a one-to-one lesson", adding: "Adding…",
    created: (code, text) => `Added ${code}: ${text}`,
  },
  zhHant: {
    title: "新增一對一課程",
    timeZone: "時區", commonZones: "常用時區", otherZone: "其他時區（搜尋）…", searchZone: "搜尋所有時區",
    searchPlaceholder: "城市或地區，例如 Paris", searchHint: "輸入城市或地區，再從清單中選擇。", searchNoMatch: "找不到這個時區，請從清單中選擇。",
    date: "日期", time: "開始時間（24 小時制）", hour: "開始時間：時", minute: "開始時間：分", minutes: "時長（分鐘）",
    code: "課程代碼", tutorCode: "小老師代碼", tutorEmail: "小老師登入 Email", studentCode: "學生代碼",
    emailHint: "小老師必須用這個 Google 帳號登入教室。大小寫沒關係，但其他每個字元都要一樣，包括 Gmail 地址裡的「.」。",
    previewTitle: "確認換算結果",
    incomplete: "選好時區、日期和開始時間後，這裡會顯示各地的上課時間。",
    minutesInvalid: "時長請填 15 到 240 分鐘。",
    entered: "輸入的時間", house: "美東時間", taipei: "台灣時間", yours: (zone) => `你的電腦：${zone}`,
    entry: (zone, from, to, before, after) => `教室開放時間：${zone} ${from} 到 ${to}（開始前 ${before} 分鐘到結束後 ${after} 分鐘）。`,
    startPassed: (minutes, after) => `開始時間已經過了 ${minutes} 分鐘。仍可建立：結束後 ${after} 分鐘內，小老師和學生都還能進入。`,
    windowPassed: (after) => `這堂課的入場時間已經全部過了（教室在結束後 ${after} 分鐘關閉），不能建立。請檢查日期、時間和時區。`,
    gap: (zone, date, time) => `${zone}在 ${date} 調為夏令時間，時鐘會跳過 ${time}，所以這個時間不存在。請改選其他時間。`,
    repeat: (zone, date, time) => `${zone}在 ${date} 結束夏令時間，時鐘撥回，${time} 會出現兩次，無法確定是哪一次。請改選其他時間。`,
    zoneInvalid: "請從清單選擇時區。",
    zoneChanged: (from, to) => `時區已從「${from}」改成「${to}」。開始時間要怎麼處理？`,
    keepLocal: "保留輸入的當地時間", keepLocalNote: (text) => `${text}：課程的實際時間點會改變。`,
    keepInstant: "保留同一個實際時間點", keepInstantNote: (text) => `改成 ${text}，和原本是同一時刻。`,
    choose: "請先從這兩個選項中選一個，才能新增課程。",
    confirm: (text) => `我已確認日期、時區和開始時間：${text}`,
    add: "新增一對一課程", adding: "新增中…",
    created: (code, text) => `已建立 ${code}：${text}`,
  },
  zhHans: {
    title: "新增一对一课程",
    timeZone: "时区", commonZones: "常用时区", otherZone: "其他时区（搜索）…", searchZone: "搜索所有时区",
    searchPlaceholder: "城市或地区，例如 Paris", searchHint: "输入城市或地区，再从列表中选择。", searchNoMatch: "找不到这个时区，请从列表中选择。",
    date: "日期", time: "开始时间（24 小时制）", hour: "开始时间：时", minute: "开始时间：分", minutes: "时长（分钟）",
    code: "课程代码", tutorCode: "小老师代码", tutorEmail: "小老师登录 Email", studentCode: "学生代码",
    emailHint: "小老师必须用这个 Google 账号登录教室。大小写没关系，但其他每个字符都要一样，包括 Gmail 地址里的「.」。",
    previewTitle: "确认换算结果",
    incomplete: "选好时区、日期和开始时间后，这里会显示各地的上课时间。",
    minutesInvalid: "时长请填 15 到 240 分钟。",
    entered: "输入的时间", house: "美东时间", taipei: "台湾时间", yours: (zone) => `你的电脑：${zone}`,
    entry: (zone, from, to, before, after) => `教室开放时间：${zone} ${from} 到 ${to}（开始前 ${before} 分钟到结束后 ${after} 分钟）。`,
    startPassed: (minutes, after) => `开始时间已经过了 ${minutes} 分钟。仍可建立：结束后 ${after} 分钟内，小老师和学生都还能进入。`,
    windowPassed: (after) => `这堂课的入场时间已经全部过了（教室在结束后 ${after} 分钟关闭），不能建立。请检查日期、时间和时区。`,
    gap: (zone, date, time) => `${zone}在 ${date} 调为夏令时间，时钟会跳过 ${time}，所以这个时间不存在。请改选其他时间。`,
    repeat: (zone, date, time) => `${zone}在 ${date} 结束夏令时间，时钟拨回，${time} 会出现两次，无法确定是哪一次。请改选其他时间。`,
    zoneInvalid: "请从列表选择时区。",
    zoneChanged: (from, to) => `时区已从「${from}」改成「${to}」。开始时间要怎么处理？`,
    keepLocal: "保留输入的当地时间", keepLocalNote: (text) => `${text}：课程的实际时间点会改变。`,
    keepInstant: "保留同一个实际时间点", keepInstantNote: (text) => `改成 ${text}，和原本是同一时刻。`,
    choose: "请先从这两个选项中选一个，才能新增课程。",
    confirm: (text) => `我已确认日期、时区和开始时间：${text}`,
    add: "新增一对一课程", adding: "新增中…",
    created: (code, text) => `已建立 ${code}：${text}`,
  },
};

type Draft = { timeZone: string; date: string; hour: string; minute: string; minutes: string; code: string; tutorCode: string; tutorEmail: string; studentCode: string };
const emptyDraft = (timeZone: string): Draft => ({ timeZone, date: "", hour: "", minute: "", minutes: "60", code: "", tutorCode: "", tutorEmail: "", studentCode: "" });
const FIELD_OF: Record<keyof Draft, LessonField> = { timeZone: "timeZone", date: "date", hour: "time", minute: "time", minutes: "minutes", code: "code", tutorCode: "tutorCode", tutorEmail: "tutorEmail", studentCode: "studentCode" };
// The last press that did not add a lesson: why (its words are chosen when shown, so they follow a
// change of language), whether the line under the button still shows (until the form is changed),
// and the fields still to fix (each until it is changed).
type Outcome = { failure: AddFailure; summary: boolean; fields: FieldProblems };

type Plan =
  | { kind: "incomplete" | "minutes" }
  | { kind: "error"; reason: "TIME_ZONE_INVALID" | "TIME_DOES_NOT_EXIST" | "TIME_IS_AMBIGUOUS" }
  | { kind: "ok"; start: number; end: number; startPassed: boolean; windowPassed: boolean };

function planOf(draft: Draft, now: number, scheduling: Scheduling | null): Plan {
  if (!validTimeZone(draft.timeZone)) return { kind: "error", reason: "TIME_ZONE_INVALID" };
  const day = parseIsoDate(draft.date);
  const clock = parseClock(draft.hour && draft.minute ? `${draft.hour}:${draft.minute}` : "");
  if (!day || !clock) return { kind: "incomplete" };
  const at = zonedInstant(day, clock, draft.timeZone);
  if (!at.ok) return { kind: "error", reason: at.reason === "NONEXISTENT" ? "TIME_DOES_NOT_EXIST" : "TIME_IS_AMBIGUOUS" };
  const length = Number(draft.minutes);
  if (!Number.isInteger(length) || length < 15 || length > 240) return { kind: "minutes" };
  const end = at.instant + length * 60_000;
  const windowPassed = scheduling ? end + scheduling.joinWindowAfterMs <= now : false;
  return { kind: "ok", start: at.instant, end, startPassed: at.instant < now, windowPassed };
}

/** "2026年11月20日 星期五" for a wall date in a zone (noon, so it exists on every day). */
function longDateOf(date: string, zone: string, locale: AdminLocale) {
  const day = parseIsoDate(date);
  const noon = day ? zonedInstant(day, { h: 12, min: 0 }, zone) : null;
  return noon?.ok ? describeInstant(noon.instant, zone, INTL_LOCALE[locale]).date : date;
}

/** One zone's line: the long date, start–end, and the zone's abbreviation and UTC offset. */
function spanIn(start: number, end: number, zone: string, locale: AdminLocale) {
  const from = describeInstant(start, zone, INTL_LOCALE[locale]);
  const to = describeInstant(end, zone, INTL_LOCALE[locale]);
  const sameDay = from.date === to.date;
  const marks = from.offset === to.offset ? `${from.abbreviation ? `${from.abbreviation} · ` : ""}${from.offset}` : `${from.abbreviation ?? from.offset} → ${to.abbreviation ?? to.offset}`;
  return { when: sameDay ? `${from.date} ${from.time}–${to.time}` : `${from.date} ${from.time} – ${to.date} ${to.time}`, marks };
}

export function LessonForm({ locale, busy, scheduling, onSubmit, onChange }: {
  locale: AdminLocale; busy: boolean; scheduling: Scheduling | null;
  onSubmit: (request: LessonRequest) => Promise<AddResult>;
  onChange?: () => void;
}) {
  const text = copy[locale];
  const words = LESSON_FORM_WORDS[locale];
  const house = scheduling?.houseTimeZone ?? "America/New_York";
  const ids = { time: useId(), hint: useId(), zones: useId(), blocked: useId(), problem: useId(), field: useId() };
  const formRef = useRef<HTMLDivElement>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [focusField, setFocusField] = useState<LessonField | null>(null);
  const [draft, setDraft] = useState<Draft>(() => emptyDraft(house));
  const [confirmed, setConfirmed] = useState(false);
  const [pending, setPending] = useState<{ from: string; instant: number; date: string; time: string } | null>(null);
  const [searching, setSearching] = useState(false);
  const [search, setSearch] = useState("");
  const [created, setCreated] = useState<{ code: string; start: number; end: number; zone: string } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [browserZone, setBrowserZone] = useState<string | null>(null);
  useEffect(() => {
    setBrowserZone(Intl.DateTimeFormat().resolvedOptions().timeZone || null);
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  // The first field to fix gets the focus (and so comes into view).
  useEffect(() => {
    if (!focusField) return;
    formRef.current?.querySelector<HTMLElement>(`[data-field="${focusField}"] input, [data-field="${focusField}"] select`)?.focus();
    setFocusField(null);
  }, [focusField]);
  const zones = useMemo(() => (searching ? allTimeZones() : []), [searching]);
  const plan = useMemo(() => planOf(draft, now, scheduling), [draft, now, scheduling]);
  const time = draft.hour && draft.minute ? `${draft.hour}:${draft.minute}` : "";
  const day = parseIsoDate(draft.date);
  const optionInstant = day ? Date.UTC(day.y, day.m - 1, day.d, 12) : now;
  const zoneOption = (zone: string) => `${zoneName(zone, locale)} · ${offsetAt(optionInstant, zone)}`;
  const common = (COMMON_TIME_ZONES as readonly string[]).includes(draft.timeZone);

  // Any change to the time asks for a new confirmation; a pending zone question is dropped when
  // the time itself is typed again.
  const touched = (keys: (keyof Draft)[]) => {
    setOutcome((current) => {
      if (!current) return current;
      const fields = { ...current.fields };
      for (const key of keys) delete fields[FIELD_OF[key]];
      return Object.keys(fields).length ? { ...current, summary: false, fields } : null;
    });
    onChange?.();
  };
  const edit = (changes: Partial<Draft>, timeChanged: boolean) => {
    setDraft((current) => ({ ...current, ...changes }));
    touched(Object.keys(changes) as (keyof Draft)[]);
    setCreated(null);
    if (timeChanged) {
      setConfirmed(false);
      setPending(null);
    }
  };
  // A new zone with a start already typed: ask whether the typed time or the moment stays.
  const changeZone = (next: string) => {
    if (!validTimeZone(next) || next === draft.timeZone) return;
    const start = zonedStart(draft);
    setPending(Number.isFinite(start) ? { from: draft.timeZone, instant: start, date: draft.date, time } : null);
    setDraft((current) => ({ ...current, timeZone: next }));
    touched(["timeZone"]);
    setConfirmed(false);
    setCreated(null);
    setSearching(false);
    setSearch("");
  };
  const keepInstant = () => {
    if (!pending) return;
    const wall = wallIn(pending.instant, draft.timeZone);
    setDraft((current) => ({ ...current, date: wall.date, hour: wall.time.slice(0, 2), minute: wall.time.slice(3, 5) }));
    setPending(null);
    touched(["date", "hour", "minute"]);
  };
  const timeRefusalText = (reason: TimeRefusal) => {
    const after = Math.round((scheduling?.joinWindowAfterMs ?? 15 * 60_000) / 60_000);
    if (reason === "ENTRY_WINDOW_PASSED") return text.windowPassed(after);
    if (reason === "TIME_ZONE_INVALID") return text.zoneInvalid;
    return (reason === "TIME_DOES_NOT_EXIST" ? text.gap : text.repeat)(zoneName(draft.timeZone, locale), longDateOf(draft.date, draft.timeZone, locale), time);
  };
  const fieldsOf = (failure: AddFailure): FieldProblems =>
    failure.kind === "fields" ? failure.fields : failure.kind === "codeTaken" ? { code: "taken" } : failure.kind === "time" ? timeRefusalFields(failure.reason) : {};
  const summaryOf = (failure: AddFailure) => {
    if (failure.kind === "fields") return fieldsSummary(words, failure.fields);
    if (failure.kind === "codeTaken") return words.notAdded(words.codeTaken(failure.code));
    if (failure.kind === "time") return words.notAdded(timeRefusalText(failure.reason));
    // Signed out or too many requests: the usual admin wording. Anything else: the lesson may have
    // been saved before the server failed, so the list is checked before trying again.
    const status = (failure.error as { status?: number } | null)?.status;
    return words.notAdded(status === 403 || status === 429 ? displayError(failure.error, locale) : words.serverFailed);
  };
  const show = (failure: AddFailure) => {
    const fields = fieldsOf(failure);
    setOutcome({ failure, summary: true, fields });
    setFocusField(firstField(fields));
  };
  const submit = async () => {
    if (plan.kind !== "ok" || blocked || busy) return;
    const local = peopleFieldProblems(draft);
    if (firstField(local)) {
      onChange?.();
      show({ kind: "fields", fields: local });
      return;
    }
    const request: LessonRequest = {
      code: draft.code, date: draft.date, time, minutes: Number(draft.minutes),
      tutorCode: draft.tutorCode, tutorEmail: draft.tutorEmail, studentCode: draft.studentCode, timeZone: draft.timeZone,
    };
    const result = await onSubmit(request);
    if (result.ok) {
      setOutcome(null);
      setCreated({ code: result.code, start: plan.start, end: plan.end, zone: request.timeZone });
      setDraft(emptyDraft(draft.timeZone));
      setConfirmed(false);
    } else {
      show(result.failure);
    }
  };

  const enteredName = zoneName(draft.timeZone, locale);
  const rows = plan.kind === "ok" ? [
    { key: "entered", label: text.entered, tag: enteredName, zone: draft.timeZone },
    ...(draft.timeZone !== house ? [{ key: "house", label: text.house, tag: null, zone: house }] : []),
    ...(draft.timeZone !== TAIPEI ? [{ key: "taipei", label: text.taipei, tag: null, zone: TAIPEI }] : []),
    ...(browserZone && validTimeZone(browserZone) && ![draft.timeZone, house, TAIPEI].includes(browserZone)
      ? [{ key: "yours", label: text.yours(zoneName(browserZone, locale)), tag: null, zone: browserZone }] : []),
  ] : [];
  const pendingText = pending ? {
    from: zoneName(pending.from, locale),
    local: `${zoneName(draft.timeZone, locale)} ${longDateOf(pending.date, draft.timeZone, locale)} ${pending.time}`,
    instant: (() => { const wall = wallIn(pending.instant, draft.timeZone); return `${zoneName(draft.timeZone, locale)} ${longDateOf(wall.date, draft.timeZone, locale)} ${wall.time}`; })(),
  } : null;
  const windowMinutes = scheduling ? { before: Math.round(scheduling.joinWindowBeforeMs / 60_000), after: Math.round(scheduling.joinWindowAfterMs / 60_000) } : null;
  const blocked = addBlockedBy({ plan: plan.kind, windowPassed: plan.kind === "ok" && plan.windowPassed, zoneChoicePending: Boolean(pending), confirmed });
  const canSubmit = !blocked && !busy;
  // A field to fix: marked, its message under it, and the message read with it.
  const problemOf = (field: LessonField) => outcome?.fields[field];
  const errorId = (field: LessonField) => `${ids.field}-${field}`;
  const fieldError = (field: LessonField) => {
    const problem = problemOf(field);
    const taken = outcome?.failure.kind === "codeTaken" ? outcome.failure.code : "";
    return problem ? <p className="classroom-field-error" id={errorId(field)}>{fieldMessage(words, field, problem, taken)}</p> : null;
  };
  const marked = (field: LessonField, describedBy?: string) => {
    const described = [problemOf(field) ? errorId(field) : null, describedBy].filter(Boolean).join(" ");
    return { ...(problemOf(field) ? { "aria-invalid": true as const } : {}), ...(described ? { "aria-describedby": described } : {}) };
  };
  const invalid = (field: LessonField) => (problemOf(field) ? "true" : undefined);

  return (
    <>
      <h2>{text.title}</h2>
      <div className="classroom-form" ref={formRef}>
        <div className="classroom-form-group">
          <div className="classroom-zone-field" data-field="timeZone" data-invalid={invalid("timeZone")}>
            <label className="admin-field">
              <span>{text.timeZone}</span>
              <select aria-label={text.timeZone} {...marked("timeZone")} title={validTimeZone(draft.timeZone) ? zoneOption(draft.timeZone) : undefined} value={searching ? OTHER : draft.timeZone} onChange={(event) => {
                if (event.target.value === OTHER) setSearching(true);
                else { setSearching(false); changeZone(event.target.value); }
              }}>
                <optgroup label={text.commonZones}>
                  {COMMON_TIME_ZONES.map((zone) => <option key={zone} value={zone}>{zoneOption(zone)}</option>)}
                </optgroup>
                {!common && validTimeZone(draft.timeZone) && <option value={draft.timeZone}>{zoneOption(draft.timeZone)}</option>}
                <option value={OTHER}>{text.otherZone}</option>
              </select>
            </label>
            {searching && (
              <div className="classroom-zone-search">
                <input
                  className="admin-search" list={ids.zones} value={search} aria-label={text.searchZone} placeholder={text.searchPlaceholder} autoFocus
                  onChange={(event) => {
                    setSearch(event.target.value);
                    const exact = zones.find((zone) => zone === event.target.value);
                    if (exact) changeZone(exact);
                  }}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter") return;
                    event.preventDefault();
                    const typed = search.trim().toLowerCase();
                    const match = zones.find((zone) => zone.toLowerCase() === typed) ?? zones.find((zone) => zone.toLowerCase().endsWith(`/${typed.replace(/ /g, "_")}`));
                    if (match) changeZone(match);
                  }}
                />
                <datalist id={ids.zones}>{zones.map((zone) => <option key={zone} value={zone}>{zoneName(zone, locale)}</option>)}</datalist>
                <p className="classroom-field-hint">{search && !zones.some((zone) => zone.toLowerCase().includes(search.trim().toLowerCase().replace(/ /g, "_"))) ? text.searchNoMatch : text.searchHint}</p>
              </div>
            )}
            {fieldError("timeZone")}
          </div>
          <div data-field="date" data-invalid={invalid("date")}>
            <label className="admin-field"><span>{text.date}</span>
              <input type="date" {...marked("date")} value={draft.date} onChange={(event) => edit({ date: event.target.value }, true)} />
            </label>
            {fieldError("date")}
          </div>
          <div data-field="time" data-invalid={invalid("time")} className="admin-field" role="group" aria-labelledby={ids.time}>
            <span id={ids.time}>{text.time}</span>
            <div className="classroom-time-pick">
              <select aria-label={text.hour} {...marked("time")} value={draft.hour} onChange={(event) => edit({ hour: event.target.value, minute: draft.minute || "00" }, true)}>
                <option value="">--</option>
                {HOURS.map((hour) => <option key={hour} value={hour}>{hour}</option>)}
              </select>
              <span aria-hidden="true">:</span>
              <select aria-label={text.minute} {...marked("time")} value={draft.minute} onChange={(event) => edit({ minute: event.target.value }, true)}>
                <option value="">--</option>
                {MINUTES.map((minute) => <option key={minute} value={minute}>{minute}</option>)}
              </select>
            </div>
            {fieldError("time")}
          </div>
          <div data-field="minutes" data-invalid={invalid("minutes")}>
            <label className="admin-field"><span>{text.minutes}</span>
              <input type="number" min={15} max={240} step={5} inputMode="numeric" {...marked("minutes")} value={draft.minutes} onChange={(event) => edit({ minutes: event.target.value }, true)} />
            </label>
            {fieldError("minutes")}
          </div>
        </div>
        <div className="classroom-form-group">
          <div data-field="code" data-invalid={invalid("code")}>
            <label className="admin-field"><span>{text.code}</span>
              <input {...marked("code")} value={draft.code} onChange={(event) => edit({ code: event.target.value }, false)} />
            </label>
            {fieldError("code")}
          </div>
          <div data-field="tutorCode" data-invalid={invalid("tutorCode")}>
            <label className="admin-field"><span>{text.tutorCode}</span>
              <input {...marked("tutorCode")} value={draft.tutorCode} onChange={(event) => edit({ tutorCode: event.target.value }, false)} />
            </label>
            {fieldError("tutorCode")}
          </div>
          <div data-field="tutorEmail" data-invalid={invalid("tutorEmail")}>
            <label className="admin-field"><span>{text.tutorEmail}</span>
              <input type="email" autoComplete="off" {...marked("tutorEmail", ids.hint)} value={draft.tutorEmail} onChange={(event) => edit({ tutorEmail: event.target.value }, false)} />
            </label>
            {fieldError("tutorEmail")}
            <p id={ids.hint} className="classroom-field-hint">{text.emailHint}</p>
          </div>
          <div data-field="studentCode" data-invalid={invalid("studentCode")}>
            <label className="admin-field"><span>{text.studentCode}</span>
              <input {...marked("studentCode")} value={draft.studentCode} onChange={(event) => edit({ studentCode: event.target.value }, false)} />
            </label>
            {fieldError("studentCode")}
          </div>
        </div>

        {pending && pendingText ? (
          <div className="classroom-zone-choice" role="group" aria-label={text.zoneChanged(pendingText.from, enteredName)} data-zone-choice>
            <p>{text.zoneChanged(pendingText.from, enteredName)}</p>
            <button type="button" className="admin-button secondary" onClick={() => setPending(null)}>
              <strong>{text.keepLocal}</strong><span>{text.keepLocalNote(pendingText.local)}</span>
            </button>
            <button type="button" className="admin-button secondary" onClick={keepInstant}>
              <strong>{text.keepInstant}</strong><span>{text.keepInstantNote(pendingText.instant)}</span>
            </button>
            <p className="classroom-field-hint">{text.choose}</p>
          </div>
        ) : (
          <section className="classroom-preview" aria-live="polite" data-preview={plan.kind}>
            <h3>{text.previewTitle}</h3>
            {plan.kind === "incomplete" && <p className="admin-muted">{text.incomplete}</p>}
            {plan.kind === "minutes" && <p className="classroom-check is-error" role="alert">{text.minutesInvalid}</p>}
            {plan.kind === "error" && (
              <p className="classroom-check is-error" role="alert" data-check={plan.reason}>
                {plan.reason === "TIME_ZONE_INVALID" ? text.zoneInvalid
                  : (plan.reason === "TIME_DOES_NOT_EXIST" ? text.gap : text.repeat)(enteredName, longDateOf(draft.date, draft.timeZone, locale), time)}
              </p>
            )}
            {plan.kind === "ok" && (
              <>
                <dl>
                  {rows.map((row) => {
                    const span = spanIn(plan.start, plan.end, row.zone, locale);
                    return (
                      <div key={row.key} className={`is-${row.key}`}>
                        <dt>{row.label}{row.tag && <span className="classroom-zone-tag">{row.tag}</span>}</dt>
                        <dd>{span.when}<span className="classroom-zone-tag">{span.marks}</span></dd>
                      </div>
                    );
                  })}
                </dl>
                {windowMinutes && !plan.windowPassed && (
                  <p className="admin-muted">{text.entry(enteredName, shortStamp(plan.start - windowMinutes.before * 60_000, draft.timeZone, locale), shortStamp(plan.end + windowMinutes.after * 60_000, draft.timeZone, locale), windowMinutes.before, windowMinutes.after)}</p>
                )}
                {plan.windowPassed && windowMinutes && <p className="classroom-check is-error" role="alert" data-check="ENTRY_WINDOW_PASSED">{text.windowPassed(windowMinutes.after)}</p>}
                {!plan.windowPassed && plan.startPassed && windowMinutes && (
                  <p className="classroom-check is-warning" role="status" data-check="START_PASSED">{text.startPassed(Math.max(1, Math.floor((now - plan.start) / 60_000)), windowMinutes.after)}</p>
                )}
                {!plan.windowPassed && (
                  <label className="classroom-confirm" data-confirm>
                    <input type="checkbox" checked={confirmed} onChange={(event) => { setConfirmed(event.target.checked); onChange?.(); }} />
                    <span>{text.confirm(`${enteredName} ${longDateOf(draft.date, draft.timeZone, locale)} ${time}`)}</span>
                  </label>
                )}
              </>
            )}
          </section>
        )}
      </div>
      <button type="button" className="admin-button primary" data-add-lesson disabled={!canSubmit} onClick={submit}
        aria-describedby={[blocked && !busy ? ids.blocked : null, outcome?.summary ? ids.problem : null].filter(Boolean).join(" ") || undefined}>
        {busy ? text.adding : text.add}
      </button>
      {blocked && !busy && <p id={ids.blocked} className="classroom-add-hint" data-add-blocked={blocked}>{words.blocked[blocked]}</p>}
      {outcome?.summary && <p id={ids.problem} className="classroom-add-problem" role="alert" data-add-problem={outcome.failure.kind}>{summaryOf(outcome.failure)}</p>}
      {created && (
        <p className="classroom-created" role="status" data-created={created.code}>
          {text.created(created.code, `${zoneName(created.zone, locale)} ${spanIn(created.start, created.end, created.zone, locale).when} ${zoneMark(created.start, created.zone)}`
            + (created.zone !== house ? ` · ${text.house} ${shortStamp(created.start, house, locale)}` : "")
            + (created.zone !== TAIPEI ? ` · ${text.taipei} ${shortStamp(created.start, TAIPEI, locale)}` : ""))}
        </p>
      )}
    </>
  );
}

// The start of a draft in its own zone (used when its length is still being typed).
function zonedStart(draft: Draft): number {
  const day = parseIsoDate(draft.date);
  const clock = parseClock(draft.hour && draft.minute ? `${draft.hour}:${draft.minute}` : "");
  const at = day && clock ? zonedInstant(day, clock, draft.timeZone) : null;
  return at?.ok ? at.instant : Number.NaN;
}
