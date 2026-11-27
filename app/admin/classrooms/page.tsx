"use client";

import { Fragment, useCallback, useEffect, useState } from "react";
import { useAdmin } from "../admin-context";
import { adminFetch, displayError } from "../admin-api";
import { HOUSE_TIME_ZONE, wallIn } from "../../../lib/zoned-time";
import { LessonForm, type AddResult, type LessonRequest, type Scheduling } from "./lesson-form";
import { addFailureOf, LESSON_FORM_WORDS } from "./lesson-form-checks";
import { shortStamp, zoneMark, zoneName } from "./time-zone-names";
import "./classrooms.css";

// The live classroom overview for owners. It polls every 15 seconds while the tab is visible:
// first the server's periodic work (the same tick the tutor's heartbeat runs), then the
// overview. Cards come from the server already reduced to codes and labels.
//
// A student's personal link (2026-11-19) is shown only right after it was made: a lesson just added
// from the form, or a link just reissued, always under that lesson's code. As soon as the add form
// is changed, or an add is refused, the link and its copy button are hidden (the page says whose
// link was hidden), so an earlier lesson's link is never taken for the lesson being typed.

const copy = {
  en: {
    title: "Classrooms", intro: "Live state of today's one-to-one lessons. Recording and filing only count as done when the video service or P1 confirmed them.",
    synthetic: "Synthetic mode: test data only, not connected to a video service or Google Drive.", ownerOnly: "Owner access is required.",
    refreshed: "Updated", tickFailed: "The server's periodic work did not run on the last refresh; the overview may lag.",
    groups: { ANOMALY: "Problems", LIVE: "In progress", WAITING: "Waiting to start", ENDED: "Ended" } as Record<string, string>,
    empty: "No lessons today.", tutor: "Tutor", student: "Student", recording: "Recording", filing: "Filing", data: "Data", scheduled: "Scheduled", started: "Started",
    check: "Check now", checking: "Checking…",
    anomalies: "Problem records", anomaliesIntro: "Every problem the overview found stays here, with who handled it and how. Write codes and actions, never names.",
    noAnomalies: "No problems recorded.", open: "Open", resolved: "Cleared", handled: "Handled", unhandled: "Needs handling", earlier: "Handled before it came back", note: "What was done", save: "Record handling", firstSeen: "First seen", lastSeen: "Last seen",
    lessons: "Lessons", houseTimes: "Times on this page are US Eastern (New York) unless marked otherwise.", house: "US Eastern", taipei: "Taiwan", enteredIn: "Entered as",
    copyLink: "Copy link", copied: "Copied",
    consentReached: "saved; it reaches these lessons:", consentReachedNone: "saved, but no lesson from yesterday to tomorrow has this code: check the lesson's codes for a typing mistake (e.g. TEST-T4 and TEST-T24).",
    findLesson: "Find a lesson by its code (e.g. TEST-R25)", showRooms: "Also show the fixed rooms' lessons (ROOM-…)", hiddenRooms: "fixed-room lesson(s) not shown (see Fixed rooms)", noMatch: "No lesson matches.",
    revokeLink: "Revoke student link", reissueLink: "Reissue student link", cancelLesson: "Cancel lesson", cancelledMark: "Cancelled",
    confirmRevoke: "Revoke the student's link? It can no longer be used to enter, and no new link is made. Someone already in the room is not disconnected at once: the classroom page normally leaves within about 15 seconds, but this cannot be guaranteed.",
    confirmReissue: "Make a new student link? The current link can no longer be used to enter. Someone already in the room with it is not disconnected at once: the classroom page normally leaves within about 15 seconds, but this cannot be guaranteed.",
    confirmCancel: "Cancel this lesson? Neither the student's link nor the tutor can enter it any more. People already in the room are not disconnected at once: the classroom pages normally leave within about 30 seconds, but this cannot be guaranteed.",
    revokedNotice: "Student link revoked. The old link no longer enters; anyone still in the room is not disconnected at once.", cancelledNotice: "Lesson cancelled. Anyone still in the room is not disconnected at once.",
    consent: "Synthetic consent (local testing only)", consentIntro: "The consent policy is still to be approved; these records are synthetic.",
    trialConsentIntro: "Vendor trial: test consent can be set only for TEST- codes (adult testers). Real students cannot be recorded.", personCode: "Person code", role: "Role", status: "Status",
    granted: "Consented", withdrawn: "Withdrawn", staffNotice: "Tutor notice acknowledged", setConsent: "Save",
    files: "Files", openFile: "Open in Google Drive",
    emergencyStop: "Emergency stop recording", stopping: "Stopping…",
    emergencyConfirm: "Stop recording this lesson now? It will not be recorded again in this lesson, and anything already recorded is kept out of the normal folders until an owner reviews it.",
    emergencyPressed: "Emergency stop pressed",
    resumeRecording: "Authorize recording in the new room", resuming: "Checking…",
    resumeConfirm: "Authorize recording in the new room? The server first checks the lesson, the roster and every consent again; it starts only if all of that passes, both people are in the new room and the old room's recording is confirmed stopped. A withdrawal, an emergency stop or a cancellation can never be undone this way.",
    resumeNotice: "Authorized. Recording starts only after the server's new check passes (see the card).",
    fileRoom: "room",
  },
  zhHant: {
    title: "教室總覽", intro: "今天各堂一對一課程的即時狀態。錄影與歸檔要有視訊服務或 P1 的確認才算完成。",
    synthetic: "合成模式：只有測試資料，沒有連到視訊服務或 Google Drive。", ownerOnly: "需要擁有者權限。",
    refreshed: "更新時間", tickFailed: "上一次更新時，伺服器排程沒有執行，總覽可能落後。",
    groups: { ANOMALY: "異常", LIVE: "進行中", WAITING: "等待開始", ENDED: "已結束" } as Record<string, string>,
    empty: "今天沒有課程。", tutor: "小老師", student: "學生", recording: "錄影", filing: "歸檔", data: "資料", scheduled: "表定", started: "實際",
    check: "重新核對", checking: "核對中…",
    anomalies: "異常紀錄", anomaliesIntro: "總覽發現的每個問題都會留在這裡，並記下誰處理、怎麼處理。請寫代碼與處置，不要寫姓名。",
    noAnomalies: "目前沒有異常紀錄。", open: "未解除", resolved: "已解除", handled: "已處置", unhandled: "待處置", earlier: "先前處置（之後又再發生）", note: "處置說明", save: "記錄處置", firstSeen: "首次發現", lastSeen: "最後出現",
    lessons: "課程", houseTimes: "本頁時間除另有標示外，皆為美東時間（紐約）。", house: "美東", taipei: "台灣", enteredIn: "建立時輸入",
    copyLink: "複製連結", copied: "已複製",
    consentReached: "已儲存，套用到這些課：", consentReachedNone: "已儲存，但昨天到明天之間沒有任何課用這個代碼：請確認課程的小老師或學生代碼有沒有打錯（例如 TEST-T4 和 TEST-T24）。",
    findLesson: "找課：輸入代碼（例如 TEST-R25）", showRooms: "也顯示固定教室的課（ROOM-…）", hiddenRooms: "堂固定教室的課沒有顯示（請看「固定教室」頁）", noMatch: "沒有符合的課程。",
    revokeLink: "撤銷學生連結", reissueLink: "重發學生連結", cancelLesson: "取消課程", cancelledMark: "已取消",
    confirmRevoke: "確定撤銷學生連結？目前的連結會立即無法再用來進入，也不會產生新連結。已在教室裡的人不會立即斷線：教室頁面通常會在約 15 秒內自行離開，但無法保證。",
    confirmReissue: "確定重發學生連結？目前的連結會立即無法再用來進入。已用舊連結在教室裡的人不會立即斷線：教室頁面通常會在約 15 秒內自行離開，但無法保證。",
    confirmCancel: "確定取消這堂課？學生連結和小老師都將無法再進入。已在教室裡的人不會立即斷線：教室頁面通常會在約 30 秒內自行離開，但無法保證。",
    revokedNotice: "學生連結已撤銷，舊連結已無法進入；仍在教室裡的人不會立即斷線。", cancelledNotice: "課程已取消；仍在教室裡的人不會立即斷線。",
    consent: "合成同意資料（僅限本機測試）", consentIntro: "錄影同意政策尚待確認；這裡的紀錄都是合成資料。",
    trialConsentIntro: "廠商試用：只能替 TEST- 代碼（成人測試者）設定測試同意，真實學生無法錄影。", personCode: "人員代碼", role: "角色", status: "狀態",
    granted: "已同意", withdrawn: "已撤回", staffNotice: "小老師已確認告知", setConsent: "儲存",
    files: "錄影檔", openFile: "在 Google 雲端硬碟開啟",
    emergencyStop: "緊急停止錄影", stopping: "停止中…",
    emergencyConfirm: "確定要立即停止這堂課的錄影嗎？停止後這堂課不會再錄影；已經錄到的內容會先隔離，不放進一般資料夾，等擁有者確認。",
    emergencyPressed: "已按下緊急停止",
    resumeRecording: "授權在新教室錄影", resuming: "確認中…",
    resumeConfirm: "確定授權在新教室錄影？伺服器會先重新確認課程、名單和每一份同意；全部通過、兩人都在新教室、而且舊教室的錄影已確認停止，才會開始錄影。撤回同意、緊急停止或取消課程之後，無法用這個方式恢復錄影。",
    resumeNotice: "已授權。伺服器重新確認通過後才會開始錄影（請看課程卡片）。",
    fileRoom: "教室第",
  },
  zhHans: {
    title: "教室总览", intro: "今天各堂一对一课程的实时状态。录像与归档要有视频服务或 P1 的确认才算完成。",
    synthetic: "合成模式：只有测试数据，没有连接到视频服务或 Google Drive。", ownerOnly: "需要所有者权限。",
    refreshed: "更新时间", tickFailed: "上一次更新时，服务器的定时作业没有执行，总览可能滞后。",
    groups: { ANOMALY: "异常", LIVE: "进行中", WAITING: "等待开始", ENDED: "已结束" } as Record<string, string>,
    empty: "今天没有课程。", tutor: "小老师", student: "学生", recording: "录像", filing: "归档", data: "数据", scheduled: "预定", started: "实际",
    check: "重新核对", checking: "核对中…",
    anomalies: "异常记录", anomaliesIntro: "总览发现的每个问题都会留在这里，并记下谁处理、怎么处理。请写代码与处置，不要写姓名。",
    noAnomalies: "目前没有异常记录。", open: "未解除", resolved: "已解除", handled: "已处置", unhandled: "待处置", earlier: "先前处置（之后又再发生）", note: "处置说明", save: "记录处置", firstSeen: "首次发现", lastSeen: "最后出现",
    lessons: "课程", houseTimes: "本页时间除另有标示外，均为美东时间（纽约）。", house: "美东", taipei: "台湾", enteredIn: "建立时输入",
    copyLink: "复制链接", copied: "已复制",
    consentReached: "已保存，套用到这些课：", consentReachedNone: "已保存，但昨天到明天之间没有任何课用这个代码：请确认课程的小老师或学生代码有没有打错（例如 TEST-T4 和 TEST-T24）。",
    findLesson: "找课：输入代码（例如 TEST-R25）", showRooms: "也显示固定教室的课（ROOM-…）", hiddenRooms: "堂固定教室的课没有显示（请看「固定教室」页）", noMatch: "没有符合的课程。",
    revokeLink: "撤销学生链接", reissueLink: "重发学生链接", cancelLesson: "取消课程", cancelledMark: "已取消",
    confirmRevoke: "确定撤销学生链接？目前的链接会立即无法再用来进入，也不会产生新链接。已在教室里的人不会立即断线：教室页面通常会在约 15 秒内自行离开，但无法保证。",
    confirmReissue: "确定重发学生链接？目前的链接会立即无法再用来进入。已用旧链接在教室里的人不会立即断线：教室页面通常会在约 15 秒内自行离开，但无法保证。",
    confirmCancel: "确定取消这堂课？学生链接和小老师都将无法再进入。已在教室里的人不会立即断线：教室页面通常会在约 30 秒内自行离开，但无法保证。",
    revokedNotice: "学生链接已撤销，旧链接已无法进入；仍在教室里的人不会立即断线。", cancelledNotice: "课程已取消；仍在教室里的人不会立即断线。",
    consent: "合成同意数据（仅限本机测试）", consentIntro: "录像同意政策尚待确认；这里的记录都是合成数据。",
    trialConsentIntro: "厂商试用：只能为 TEST- 代码（成人测试者）设置测试同意，真实学生无法录像。", personCode: "人员代码", role: "角色", status: "状态",
    granted: "已同意", withdrawn: "已撤回", staffNotice: "小老师已确认告知", setConsent: "保存",
    files: "录像文件", openFile: "在 Google 云端硬盘打开",
    emergencyStop: "紧急停止录像", stopping: "停止中…",
    emergencyConfirm: "确定要立即停止这堂课的录像吗？停止后这堂课不会再录像；已经录到的内容会先隔离，不放进一般文件夹，等所有者确认。",
    emergencyPressed: "已按下紧急停止",
    resumeRecording: "授权在新教室录像", resuming: "确认中…",
    resumeConfirm: "确定授权在新教室录像？服务器会先重新确认课程、名单和每一份同意；全部通过、两人都在新教室、而且旧教室的录像已确认停止，才会开始录像。撤回同意、紧急停止或取消课程之后，无法用这个方式恢复录像。",
    resumeNotice: "已授权。服务器重新确认通过后才会开始录像（请看课程卡片）。",
    fileRoom: "教室第",
  },
};

type Person = { code: string; status: string; basis: string; label: string };
// One recording file and where it was filed: P1's name and folder, size, Drive's checksum.
type FilingItem = { generation?: number | null; extension: string | null; status: string; destination: string | null; label: string; reasonLabel: string | null; name: string | null; folder: string | null; size: number | null; md5: string | null; link?: string | null };
const megabytes = (bytes: number | null) => (bytes == null ? "" : `${(bytes / 1024 / 1024).toFixed(1)} MB`);
type Card = {
  lessonCode: string; scheduledStart: string | null; actualStart: string | null;
  phase: { value: string; basis: string; label: string };
  tutor: Person | null; students: Person[];
  recording: { status: string; basis: string; basisLabel: string; source: string | null; label: string };
  filing: { status: string; label: string; reasonLabel?: string | null; items?: FilingItem[] };
  // stopState: CONFIRMED (the video service said so), WAITING, or NO_RECORDING_KNOWN; the label says which.
  emergency?: { pressedAt: string | null; stopState: string | null; stopLabel: string | null; available: boolean };
  // After the room moved: may the new room record, and may an owner authorize it now.
  roomRecording?: { generation: number; status: string; label: string; reason: string | null; canAuthorize: boolean; oldRoomStillRecording: boolean } | null;
  anomalies: { code: string; severity: string; label: string }[];
  dataState: { value: string; label: string; lastConfirmedAt: string | null; ageSeconds: number | null };
};
type Anomaly = { lessonId: string; lessonCode: string | null; code: string; label: string; severity: string; firstSeenAt: string | null; openedAt: string | null; lastSeenAt: string | null; resolvedAt: string | null; handled: boolean; acknowledgedBy: string | null; acknowledgedAt: string | null; note: string | null };
type Lesson = { lessonId: string; code: string; startsAt: string; endsAt: string; timeZone?: string | null; cancelled: boolean; tutorCode: string | null; studentCodes: string[] };
type AccessAction = "cancel" | "revoke_link" | "reissue_link";
type Overview = { mode: string | null; trialConsent?: boolean; scheduling?: Scheduling; dashboard: { generatedAt: string; groups: Record<string, Card[]>; counts: Record<string, number> }; anomalies: Anomaly[]; lessons: Lesson[] };

const GROUPS = ["ANOMALY", "LIVE", "WAITING", "ENDED"];
// Times are shown in US Eastern (the house zone) with their abbreviation (2026-11-17); before,
// they were Taipei times without a label.
const HOUSE = HOUSE_TIME_ZONE;
const TAIPEI = "Asia/Taipei";
// Where a confirmation came from. The source names inside the events still say zoom (the
// synthetic provider plays Zoom-shaped events); the page names no vendor while none is chosen.
const SOURCE = { zoom_webhook: "視訊服務", host_sdk: "小老師端", zoom_api: "視訊服務查詢", zoom: "視訊服務" } as Record<string, string>;

export default function ClassroomsPage() {
  const { locale, principal, setSubmitting } = useAdmin();
  const text = copy[locale];
  const words = LESSON_FORM_WORDS[locale];
  const stamp = (iso: string | null) => (iso ? `${shortStamp(Date.parse(iso), HOUSE, locale)} ${zoneMark(Date.parse(iso), HOUSE)}` : "—");
  const [overview, setOverview] = useState<Overview | null>(null);
  const [error, setError] = useState("");
  const [tickFailed, setTickFailed] = useState(false);
  const [refreshedAt, setRefreshedAt] = useState<string | null>(null);
  const [checking, setChecking] = useState("");
  // Round 18d (the user: 「內容太亂了」): one-to-one lessons by default, a fixed room's lessons on demand; find by code.
  const [lessonSearch, setLessonSearch] = useState("");
  const [showRoomLessons, setShowRoomLessons] = useState(false);
  const [stopping, setStopping] = useState("");
  const [resuming, setResuming] = useState("");
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  // The link on show (whose, and how it was made) and the code of a link just hidden.
  const [linkBox, setLinkBox] = useState<{ code: string; url: string; kind: "created" | "reissued" } | null>(null);
  const [hiddenLink, setHiddenLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [notice, setNotice] = useState("");
  const [consent, setConsent] = useState({ personCode: "", role: "student", status: "granted" });

  const refresh = useCallback(async () => {
    try {
      await adminFetch("/api/admin/classrooms/tick", { method: "POST", body: "{}" }).then(() => setTickFailed(false), () => setTickFailed(true));
      setOverview(await adminFetch<Overview>("/api/admin/classrooms"));
      setRefreshedAt(new Date().toISOString());
      setError("");
    } catch (failure) {
      setError(displayError(failure, locale));
    }
  }, [locale]);

  useEffect(() => {
    if (principal.role !== "owner") return;
    refresh();
    const timer = setInterval(() => { if (document.visibilityState === "visible") refresh(); }, 15_000);
    return () => clearInterval(timer);
  }, [principal.role, refresh]);

  if (principal.role !== "owner") return <section className="admin-page"><p className="admin-alert">{text.ownerOnly}</p></section>;

  const lessonIdOf = (code: string) => overview?.lessons.find((item) => item.code === code)?.lessonId ?? "";
  async function mutate(run: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setSubmitting(true);
    setError("");
    try {
      await run();
    } catch (failure) {
      setError(displayError(failure, locale));
    } finally {
      setBusy(false);
      setSubmitting(false);
    }
  }
  const checkNow = (code: string) => mutate(async () => {
    setChecking(code);
    try {
      await adminFetch(`/api/admin/classrooms/${encodeURIComponent(lessonIdOf(code))}/reconcile`, { method: "POST", body: "{}" });
      await refresh();
    } finally {
      setChecking("");
    }
  });
  // One press, one confirmation: the server stops recording at once and keeps it stopped.
  const emergencyStop = (code: string) => {
    if (!window.confirm(text.emergencyConfirm)) return;
    return mutate(async () => {
      setStopping(code);
      try {
        await adminFetch(`/api/admin/classrooms/${encodeURIComponent(lessonIdOf(code))}/stop-recording`, { method: "POST", body: "{}" });
        await refresh();
      } finally {
        setStopping("");
      }
    });
  };
  // After a move during a recording: one press, one confirmation; the server checks again and
  // starts only if that passes.
  const resumeRecording = (code: string) => {
    if (!window.confirm(text.resumeConfirm)) return;
    return mutate(async () => {
      setResuming(code);
      try {
        await adminFetch(`/api/admin/classrooms/${encodeURIComponent(lessonIdOf(code))}/resume-recording`, { method: "POST", body: "{}" });
        setNotice(text.resumeNotice);
        await refresh();
      } finally {
        setResuming("");
      }
    });
  };
  const handle = (item: Anomaly) => mutate(async () => {
    const id = `${item.lessonId}:${item.code}`;
    await adminFetch("/api/admin/classrooms/anomalies", { method: "POST", body: JSON.stringify({ lessonId: item.lessonId, code: item.code, note: notes[id] ?? "" }) });
    setNotes((current) => ({ ...current, [id]: "" }));
    await refresh();
  });
  // Any link on show is hidden, and the page says whose it was.
  const hideLink = () => {
    if (!linkBox) return;
    setHiddenLink(linkBox.code);
    setLinkBox(null);
    setCopied(false);
  };
  // An add answers the form itself (the result is shown by the button, never in the page's
  // top alert, which the automatic refresh clears). The same lesson API and checks as before.
  const addLesson = async (request: LessonRequest): Promise<AddResult> => {
    if (busy) return { ok: false, failure: { kind: "other", error: null } };
    setBusy(true);
    setSubmitting(true);
    try {
      const data = await adminFetch<{ studentLink: string; lesson?: { code?: string } }>("/api/admin/classrooms", { method: "POST", body: JSON.stringify(request) });
      const code = data.lesson?.code ?? request.code.trim();
      setLinkBox({ code, url: `${window.location.origin}${data.studentLink}`, kind: "created" });
      setHiddenLink(null);
      setCopied(false);
      setNotice("");
      await refresh();
      return { ok: true, code };
    } catch (failure) {
      hideLink();
      return { ok: false, failure: addFailureOf(failure, request) };
    } finally {
      setBusy(false);
      setSubmitting(false);
    }
  };
  // Revoke or reissue the student's link, or cancel the lesson; each asks first. A reissued link
  // is shown once, in the same box as a new lesson's.
  const changeAccess = (item: Lesson, action: AccessAction) => {
    const question = { cancel: text.confirmCancel, revoke_link: text.confirmRevoke, reissue_link: text.confirmReissue }[action];
    if (!window.confirm(`${item.code}：${question}`)) return;
    return mutate(async () => {
      const data = await adminFetch<{ studentLink?: string }>(`/api/admin/classrooms/${encodeURIComponent(item.lessonId)}`, {
        method: "PATCH", body: JSON.stringify({ action, studentCode: item.studentCodes[0] }),
      });
      setLinkBox(data.studentLink ? { code: item.code, url: `${window.location.origin}${data.studentLink}`, kind: "reissued" } : null);
      setHiddenLink(null);
      setCopied(false);
      setNotice(action === "cancel" ? `${item.code}：${text.cancelledNotice}` : action === "revoke_link" ? `${item.code}：${text.revokedNotice}` : "");
      await refresh();
    });
  };
  // Round 18f (the user, sixth real-Zoom sitting: the same as fixed rooms, 「連結我希望在卡片中顯示」):
  // a link reissued from a lesson's row is shown right under that row; a new lesson's link stays beside
  // the form that made it.
  const linkBoxView = (where: "row" | "top") => linkBox && (
          <div className="classroom-link" role="status" data-link-code={linkBox.code} data-link-kind={linkBox.kind} data-link-in={where}>
            <p>{linkBox.kind === "created" ? words.linkCreated(linkBox.code) : words.linkReissued(linkBox.code)}</p>
            <code>{linkBox.url}</code>
            <button type="button" className="admin-button secondary" onClick={() => navigator.clipboard?.writeText(linkBox.url).then(() => setCopied(true), () => setCopied(false))}>{copied ? text.copied : text.copyLink}</button>
            {linkBox.kind === "created" && <p className="classroom-link-note">{words.copyFirst}</p>}
          </div>
  );
  const saveConsent = () => mutate(async () => {
    const saved = await adminFetch<{ lessons?: string[] }>("/api/admin/classrooms/consents", { method: "POST", body: JSON.stringify(consent) });
    // Round 18d: which lessons it reached, or a warning that it reached none (a mistyped code).
    const reached = Array.isArray(saved?.lessons) ? saved.lessons : [];
    setNotice(reached.length ? `${consent.personCode.trim()}：${text.consentReached} ${reached.join("、")}` : `${consent.personCode.trim()}：${text.consentReachedNone}`);
    setConsent((current) => ({ ...current, personCode: "" }));
    await refresh();
  });

  const isRoomLesson = (code: string) => code.startsWith("ROOM-");
  const wanted = lessonSearch.trim().toLowerCase();
  const shownIn = (group: string) => (overview?.dashboard.groups[group] ?? []).filter((card) => (showRoomLessons || !isRoomLesson(card.lessonCode)) && (!wanted || card.lessonCode.toLowerCase().includes(wanted)));
  const hiddenRoomLessons = showRoomLessons ? 0 : GROUPS.reduce((sum, group) => sum + (overview?.dashboard.groups[group] ?? []).filter((card) => isRoomLesson(card.lessonCode)).length, 0);
  const counts = Object.fromEntries(GROUPS.map((group) => [group, shownIn(group).length]));
  // Round 18f: a reissued link goes right under its lesson's row in the list, where it was asked for.
  const linkInRow = linkBox?.kind === "reissued" && !!overview?.lessons.some((item) => item.code === linkBox.code);
  // Open and not yet handled first, then open, then cleared; most recent first within each.
  const rank = (item: Anomaly) => (item.resolvedAt ? 2 : item.handled ? 1 : 0);
  const anomalies = [...(overview?.anomalies ?? [])].sort((a, b) => rank(a) - rank(b) || String(b.lastSeenAt).localeCompare(String(a.lastSeenAt)));
  return (
    <section className="admin-page classroom-overview">
      <header className="admin-page-head">
        <div><h1>{text.title}</h1><p>{text.intro}</p></div>
        <p className="admin-muted">{text.refreshed}: {refreshedAt ? stamp(refreshedAt) : "—"}<br />{text.houseTimes}</p>
      </header>
      {overview?.mode === "synthetic" && <p className="classroom-synthetic" role="note">{text.synthetic}</p>}
      {tickFailed && <p className="admin-alert" role="status">{text.tickFailed}</p>}
      {error && <p className="admin-alert" role="alert">{error}</p>}

      <div className="admin-toolbar classroom-lesson-filter" data-lesson-filter>
        <input className="admin-search" type="search" value={lessonSearch} placeholder={text.findLesson} aria-label={text.findLesson} onChange={(event) => setLessonSearch(event.target.value)} />
        <label className="admin-muted"><input type="checkbox" checked={showRoomLessons} onChange={(event) => setShowRoomLessons(event.target.checked)} /> {text.showRooms}</label>
        {hiddenRoomLessons > 0 && <span className="admin-muted" data-hidden-room-lessons={hiddenRoomLessons}>{hiddenRoomLessons} {text.hiddenRooms}</span>}
      </div>
      <div className="classroom-counts">
        {GROUPS.map((group) => <div key={group} className={`classroom-count classroom-${group.toLowerCase()}`}><span>{text.groups[group]}</span><strong>{counts[group] ?? 0}</strong></div>)}
      </div>

      {overview && !GROUPS.some((group) => overview.dashboard.groups[group]?.length) && <p className="admin-muted">{text.empty}</p>}
      {overview && GROUPS.some((group) => overview.dashboard.groups[group]?.length) && !GROUPS.some((group) => shownIn(group).length) && <p className="admin-muted">{text.noMatch}</p>}
      {GROUPS.filter((group) => shownIn(group).length).map((group) => (
        <section key={group} className="classroom-group" aria-label={text.groups[group]}>
          <h2>{text.groups[group]}（{shownIn(group).length}）</h2>
          <div className="classroom-cards">
            {shownIn(group).map((card) => (
              <article key={card.lessonCode} className={`classroom-card${group === "ANOMALY" ? " is-problem" : ""}`}>
                <div className="classroom-card-head">
                  <strong>{card.lessonCode}</strong>
                  <span className={`classroom-data ${card.dataState.value}`}>{card.dataState.label}</span>
                </div>
                <dl>
                  {/* Round 18d: the recording files first, so a filed recording is seen at once. */}
                  {card.filing.items && card.filing.items.length > 0 && (
                    <div className="classroom-files-row" data-files-first><dt>{text.files}</dt><dd>
                      <ul className="classroom-files">
                        {card.filing.items.map((item, index) => (
                          <li key={`${item.name ?? item.extension}-${index}`}>
                            <span className={`classroom-file-status ${item.status}`}>{item.label}{item.reasonLabel ? `（${item.reasonLabel}）` : ""}</span>
                            {item.name && <span className="classroom-file-name">{item.folder ? `${item.folder} / ` : ""}{item.name}</span>}
                            {item.generation != null && item.generation > 0 && <span className="classroom-basis">{locale === "en" ? `${text.fileRoom} ${item.generation + 1}` : `${text.fileRoom} ${item.generation + 1} 間`}</span>}
                            {item.size != null && <span className="classroom-basis">{megabytes(item.size)}</span>}
                            {item.md5 && <span className="classroom-basis" title={item.md5}>md5 {item.md5.slice(0, 8)}…</span>}
                            {item.link && <a href={item.link} target="_blank" rel="noreferrer noopener">{text.openFile}</a>}
                          </li>
                        ))}
                      </ul>
                    </dd></div>
                  )}
                  <div><dt>{text.scheduled}</dt><dd>{stamp(card.scheduledStart)}　{text.started} {stamp(card.actualStart)}　{card.phase.label}</dd></div>
                  {card.tutor && <div><dt>{text.tutor}</dt><dd>{card.tutor.code}　{card.tutor.label}</dd></div>}
                  {card.students.map((student) => <div key={student.code}><dt>{text.student}</dt><dd>{student.code}　{student.label}</dd></div>)}
                  <div><dt>{text.recording}</dt><dd>{card.recording.label}{card.recording.basis === "confirmed" && card.recording.source ? <span className="classroom-basis">（{SOURCE[card.recording.source] ?? card.recording.source}確認）</span> : null}</dd></div>
                  {card.filing.label && <div><dt>{text.filing}</dt><dd>{card.filing.label}{card.filing.reasonLabel ? `（${card.filing.reasonLabel}）` : null}</dd></div>}
                  <div><dt>{text.data}</dt><dd>{card.dataState.lastConfirmedAt ? stamp(card.dataState.lastConfirmedAt) : "—"}</dd></div>
                </dl>
                {card.anomalies.length > 0 && <ul className="classroom-alerts">{card.anomalies.map((item) => <li key={item.code} className={item.severity}>{item.label}</li>)}</ul>}
                {card.emergency?.pressedAt && (
                  <p className={`classroom-emergency${card.emergency.stopState === "CONFIRMED" ? " is-confirmed" : ""}`} role="status">{text.emergencyPressed}（{stamp(card.emergency.pressedAt)}）：{card.emergency.stopLabel}</p>
                )}
                {card.roomRecording && <p className="classroom-room-recording" role="status">{card.roomRecording.label}</p>}
                <div className="admin-card-actions">
                  <button type="button" className="admin-button secondary" disabled={busy || !lessonIdOf(card.lessonCode)} onClick={() => checkNow(card.lessonCode)}>{checking === card.lessonCode ? text.checking : text.check}</button>
                  {card.emergency?.available && (
                    <button type="button" className="admin-button danger" disabled={busy || !lessonIdOf(card.lessonCode)} onClick={() => emergencyStop(card.lessonCode)}>{stopping === card.lessonCode ? text.stopping : text.emergencyStop}</button>
                  )}
                  {card.roomRecording?.canAuthorize && (
                    <button type="button" className="admin-button secondary" disabled={busy || !lessonIdOf(card.lessonCode)} onClick={() => resumeRecording(card.lessonCode)}>{resuming === card.lessonCode ? text.resuming : text.resumeRecording}</button>
                  )}
                </div>
              </article>
            ))}
          </div>
        </section>
      ))}

      <div className="admin-panel classroom-panel">
        <h2>{text.anomalies}</h2>
        <p className="admin-muted">{text.anomaliesIntro}</p>
        {anomalies.length ? (
          <div className="admin-table-wrap">
            <table className="admin-table">
              <tbody>
                {anomalies.map((item) => {
                  const id = `${item.lessonId}:${item.code}`;
                  return (
                    <tr key={id}>
                      <td><strong>{item.lessonCode}</strong><div className="admin-muted">{item.label}</div></td>
                      <td>
                        <span className={`admin-status ${item.resolvedAt ? "published" : "archived"}`}>{item.resolvedAt ? text.resolved : text.open}</span>{" "}
                        <span className={`classroom-severity ${item.severity}`}>{item.severity}</span>
                        {!item.resolvedAt && !item.handled && <div className="classroom-unhandled">{text.unhandled}</div>}
                      </td>
                      <td className="admin-muted">{text.firstSeen} {stamp(item.firstSeenAt)}<br />{text.lastSeen} {stamp(item.resolvedAt ?? item.lastSeenAt)}</td>
                      <td>
                        {item.acknowledgedBy && <p className={`classroom-handled${item.handled ? "" : " is-earlier"}`}>{item.handled ? text.handled : text.earlier}：{item.note}（{item.acknowledgedBy}，{stamp(item.acknowledgedAt)}）</p>}
                        <div className="admin-toolbar">
                          <input className="admin-search" value={notes[id] ?? ""} maxLength={500} placeholder={text.note} onChange={(event) => setNotes((current) => ({ ...current, [id]: event.target.value }))} />
                          <button type="button" className="admin-button secondary" disabled={busy || !(notes[id] ?? "").trim()} onClick={() => handle(item)}>{text.save}</button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : <p className="admin-muted">{text.noAnomalies}</p>}
      </div>

      <div className="admin-panel classroom-panel classroom-add-panel">
        <LessonForm locale={locale} busy={busy} scheduling={overview?.scheduling ?? null} onSubmit={addLesson} onChange={hideLink} />
        {linkBox && !linkInRow && linkBoxView("top")}
        {hiddenLink && !linkBox && <p className="classroom-link-hidden" role="status" data-link-hidden={hiddenLink}>{words.linkHidden(hiddenLink)}</p>}
        {notice && <p className="classroom-notice" role="status">{notice}</p>}
        <p className="admin-muted classroom-list-note" data-list-window>{words.listNote}</p>
        {overview?.lessons.length ? (
          <div className="admin-table-wrap">
            <table className="admin-table classroom-lessons">
              <tbody>
                {overview.lessons.map((item) => (
                  <Fragment key={item.lessonId}>
                  <tr className={item.cancelled ? "is-cancelled" : undefined}>
                    <td><strong>{item.code}</strong>{item.cancelled && <span className="classroom-cancelled">{text.cancelledMark}</span>}</td>
                    <td className="classroom-lesson-time">
                      <div><span className="classroom-zone-label">{text.house}</span> {shortStamp(Date.parse(item.startsAt), HOUSE, locale)}–{wallIn(Date.parse(item.endsAt), HOUSE).time} {zoneMark(Date.parse(item.startsAt), HOUSE)}</div>
                      <div className="admin-muted"><span className="classroom-zone-label">{text.taipei}</span> {shortStamp(Date.parse(item.startsAt), TAIPEI, locale)}–{wallIn(Date.parse(item.endsAt), TAIPEI).time}</div>
                      {item.timeZone && item.timeZone !== HOUSE && item.timeZone !== TAIPEI && (
                        <div className="admin-muted">{text.enteredIn} {zoneName(item.timeZone, locale)} {shortStamp(Date.parse(item.startsAt), item.timeZone, locale)}</div>
                      )}
                    </td>
                    <td>{text.tutor} {item.tutorCode}</td>
                    <td>{text.student} {item.studentCodes.join("、")}</td>
                    <td className="classroom-lesson-actions">
                      <button type="button" className="admin-button secondary" disabled={busy || item.cancelled} onClick={() => changeAccess(item, "revoke_link")}>{text.revokeLink}</button>
                      <button type="button" className="admin-button secondary" disabled={busy || item.cancelled} onClick={() => changeAccess(item, "reissue_link")}>{text.reissueLink}</button>
                      <button type="button" className="admin-button secondary" disabled={busy || item.cancelled} onClick={() => changeAccess(item, "cancel")}>{text.cancelLesson}</button>
                    </td>
                  </tr>
                  {linkInRow && linkBox?.code === item.code && <tr className="classroom-link-row"><td colSpan={5}>{linkBoxView("row")}</td></tr>}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </div>

      {(overview?.mode === "synthetic" || overview?.trialConsent) && (
        <div className="admin-panel classroom-panel">
          <h2>{text.consent}</h2>
          <p className="admin-muted">{overview?.mode === "synthetic" ? text.consentIntro : text.trialConsentIntro}</p>
          <div className="admin-toolbar">
            <input className="admin-search" value={consent.personCode} placeholder={text.personCode} onChange={(event) => setConsent((current) => ({ ...current, personCode: event.target.value }))} />
            <select className="admin-select" value={consent.role} aria-label={text.role} onChange={(event) => setConsent((current) => ({ ...current, role: event.target.value }))}>
              <option value="student">{text.student}</option>
              <option value="tutor">{text.tutor}</option>
            </select>
            {consent.role === "student" ? (
              <select className="admin-select" value={consent.status} aria-label={text.status} onChange={(event) => setConsent((current) => ({ ...current, status: event.target.value }))}>
                <option value="granted">{text.granted}</option>
                <option value="withdrawn">{text.withdrawn}</option>
              </select>
            ) : <span className="admin-muted">{text.staffNotice}</span>}
            <button type="button" className="admin-button secondary" disabled={busy || !consent.personCode.trim()} onClick={saveConsent}>{text.setConsent}</button>
          </div>
        </div>
      )}
    </section>
  );
}
