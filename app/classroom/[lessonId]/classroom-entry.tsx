"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  createMediaAdapter, hostReportFor, MediaAdapterUnavailableError, SYNTHETIC_SCENARIOS, SyntheticMediaAdapter,
  type ClassroomMediaAdapter, type ConnectionState, type DeviceKind, type DeviceProblem, type DeviceState, type MediaEvent, type MediaSystemCheck, type SyntheticScenario,
} from "../../../lib/classroom-media";
import { classroomDeviceOf, deviceLimits, type CapabilityName, type ClassroomDevice } from "../../../lib/classroom-capabilities";
import { rejoinRoom, requestJoin, type JoinedSession } from "../../../lib/classroom-join-client";

// The vendor-specific parts of the room (2026-10-30): Zoom draws its video in our page; LCIC is
// Tencent's own classroom page in an iframe. Notes per device come from lib/classroom-capabilities
// (vendor documentation, not yet tried on real devices).
const VENDOR_PROVIDERS = new Set(["zoom-video-sdk", "tencent-lcic"]);
const vendorCopy = {
  zh: {
    limitsTitle: "這台裝置的限制",
    device: { desktop: "電腦", tablet: "平板", phone: "手機" } as Record<ClassroomDevice, string>,
    unknown: "（未確認）",
    limits: {
      video: "視訊在這台裝置上的效果未確認", documents: "教材（PDF、PPT）只能用分享畫面觀看，或效果未確認",
      whiteboard: "白板只能觀看、不能在上面畫，或效果未確認", screenShare: "不能從這台裝置分享畫面",
      fileTransfer: "傳送檔案的方式未確認", recording: "上課中由系統停止錄影的方式尚未實測；必要時會結束這間教室，再開一間不錄影的教室",
    } as Record<CapabilityName, string>,
    lcicNote: "以下是騰訊的教室畫面：鏡頭、麥克風、教材和白板都在裡面操作。連線狀態也顯示在騰訊的畫面內。",
    lcicRecordingOff: "這堂課的教室建立時不錄影。",
    zoomVideo: "Zoom 視訊畫面",
    share: "分享畫面（教材）", shareStop: "停止分享畫面", whiteboard: "開啟白板", whiteboardStop: "關閉白板", exportBoard: "下載白板 PDF",
    sharing: "你正在分享畫面。", receiving: "正在顯示對方分享的畫面。", presenting: "你正在主持白板，對方會同時看到。", viewing: "正在顯示小老師的白板。",
    shareHint: "教材（PDF、PPT）：先在這台電腦打開檔案，再按「分享畫面」，選擇那個視窗或瀏覽器分頁。",
    noShareHere: "這台裝置不能分享畫面；要展示教材請改用電腦。",
    shareFailed: "畫面沒有開始分享（可能取消了選擇）。",
    boardFailed: "白板無法開啟：這個帳號可能沒有開啟白板，或這台裝置不支援。",
    sdkCheck: (check: MediaSystemCheck) => `Zoom 視訊 ${check.sdkVersion}：音訊${check.audio ? "可用" : "不可用"}、視訊${check.video ? "可用" : "不可用"}、分享畫面${check.screenShare ? "可用" : "不可用"}`,
  },
  en: {
    limitsTitle: "Limits on this device",
    device: { desktop: "Computer", tablet: "Tablet", phone: "Phone" } as Record<ClassroomDevice, string>,
    unknown: " (not confirmed)",
    limits: {
      video: "Video on this device is not confirmed", documents: "Materials (PDF, PPT) only through a shared screen, or not confirmed",
      whiteboard: "The whiteboard is view-only here, or not confirmed", screenShare: "This device cannot share its screen",
      fileTransfer: "Sending files is not confirmed", recording: "Stopping a recording mid-class from iHear is not yet tested; if needed the class is ended and a new one opens without recording",
    } as Record<CapabilityName, string>,
    lcicNote: "Below is Tencent's classroom: the camera, microphone, materials and whiteboard are all inside it, and so is the connection status.",
    lcicRecordingOff: "This class was opened without recording.",
    zoomVideo: "Zoom video",
    share: "Share screen (materials)", shareStop: "Stop sharing", whiteboard: "Open whiteboard", whiteboardStop: "Close whiteboard", exportBoard: "Download whiteboard PDF",
    sharing: "You are sharing your screen.", receiving: "Showing the other person’s shared screen.", presenting: "You are presenting the whiteboard; the other person sees it too.", viewing: "Showing the tutor’s whiteboard.",
    shareHint: "Materials (PDF, PPT): open the file on this computer first, then choose Share screen and pick that window or browser tab.",
    noShareHere: "This device cannot share its screen; use a computer to show materials.",
    shareFailed: "The screen was not shared (the choice may have been cancelled).",
    boardFailed: "The whiteboard could not open: it may be off for this account, or this device does not support it.",
    sdkCheck: (check: MediaSystemCheck) => `Zoom video ${check.sdkVersion}: audio ${check.audio ? "supported" : "not supported"}, video ${check.video ? "supported" : "not supported"}, screen sharing ${check.screenShare ? "supported" : "not supported"}`,
  },
};

// What a student or a tutor sees: one button to enter, a plain reason when they cannot, and once
// inside, the lesson's facts, the video stage with camera and microphone controls, and whether
// the lesson is being recorded. The video goes through a provider-neutral adapter
// (lib/classroom-media.ts); only the synthetic stand-in exists, and it carries no audio or
// video, which the page says. Recording is started and stopped by the server, never from this
// page: the tutor's page only reports what it sees, every 30 seconds, or every 10 while
// recording so that a stop reaches it quickly, and both pages read the recording state.

type Locale = "en" | "zh";

const copy = {
  en: {
    title: "iHear Classroom", other: "中文",
    synthetic: "Test classroom: synthetic data only. No video or recording is connected.",
    enter: "Enter the classroom", entering: "Checking…", retry: "Try again", leave: "Leave the classroom",
    left: "You have left the classroom.", rejoin: "Enter again", signIn: "Tutor sign-in",
    lesson: "Lesson", time: "Time (Taipei)", you: "You", tutor: "Tutor", student: "Student",
    stage: "Video", self: "You", other_tutor: "Tutor", other_student: "Student",
    noVideo: "No real video in this test classroom.",
    cameraOnSimulated: "Camera on (simulated: no real picture)", cameraOn: "Camera on", cameraOff: "Camera off",
    cameraDenied: "Camera not allowed", cameraUnavailable: "No camera found",
    micOn: "Microphone on", micOff: "Microphone muted", micDenied: "Microphone not allowed", micUnavailable: "No microphone found",
    cameraStarting: "Camera starting…", cameraFailed: "Camera did not start", micStarting: "Microphone starting…", micFailed: "Microphone did not start",
    waitingOther: "Waiting for the other person to enter.",
    syntheticOther: "The test classroom cannot see the other person; use the simulation controls below.",
    otherLeft: "The other person has left the classroom.",
    controls: "Classroom controls", camera: "Camera", microphone: "Microphone", on: "on", off: "off", starting: "starting…", retryDevice: "Try again",
    connection: { idle: "Not connected", connecting: "Connecting…", connected: "Connected", reconnecting: "Reconnecting…", disconnected: "Disconnected", failed: "Connection failed" } as Record<ConnectionState, string>,
    notConnected: "Video is not connected: no video service has been chosen for this classroom yet.",
    reconnecting: "The video connection dropped. Reconnecting…",
    failed: "The video could not connect. Try connecting again.", reconnect: "Connect again",
    deviceHelp: {
      camera: { denied: "The camera is blocked. Allow the camera for this site in the browser's settings, then try again.", unavailable: "No camera was found. Check that one is connected and not used by another app." },
      microphone: { denied: "The microphone is blocked. Allow the microphone for this site in the browser's settings, then try again.", unavailable: "No microphone was found. Check that one is connected and not used by another app." },
    } as Record<DeviceKind, Partial<Record<DeviceState, string>>>,
    // A press that did not start, by what went wrong ("error" for the rest); "Try again" sits beside it.
    deviceFailed: {
      camera: { error: "The camera did not start. Press “Try again”. If it still does not start, reload this page.", missing: "No camera was found. Check that it is connected, then press “Try again”.", busy: "Another app may be using the camera (another video app, for example). Close it, then press “Try again”." },
      microphone: { error: "The microphone did not start. Press “Try again”. If it still does not start, reload this page.", autoplay: "The browser paused this page's sound. Press “Try again” to start it.", missing: "No microphone was found. Check that it is connected, then press “Try again”.", busy: "Another app may be using the microphone. Close it, then press “Try again”." },
    } as Record<DeviceKind, Partial<Record<DeviceProblem, string>>>,
    recording: "Recording", recordingNote: "Recording starts and stops on its own; you do not need to do anything.",
    allowed: "This lesson may be recorded.", notAllowed: "This lesson is not recorded.", waiting: "Waiting for the first report…",
    undecided: "Whether this lesson is recorded is decided automatically before it starts.",
    badge: { recording: "Recording", starting: "Starting recording", paused: "Recording paused", off: "Not recording", unknown: "Recording state unknown" },
    studentNotice: {
      recording: "This lesson is being recorded.", starting: "Recording is about to start.", paused: "Recording is paused.",
      off: "This lesson is not being recorded.", unknown: "The recording state could not be checked just now.",
    },
    basis: { confirmed: "confirmed", requested: "requested, waiting for the video service", inferred: "inferred" } as Record<string, string>,
    status: {
      NOT_REQUESTED: "Not started", BLOCKED: "Not recorded (consent conditions not met)", START_REQUESTED: "Start requested",
      RECORDING: "Recording", PAUSED: "Paused", STOPPED: "Stopped, waiting for the file", POSSIBLY_STOPPED: "Possibly stopped",
      FAILED: "Recording failed", COMPLETED: "Recording complete",
    } as Record<string, string>,
    failedRecording: "Recording failed. iHear has been notified; the lesson carries on.",
    unstable: "The connection to iHear is unstable. Still trying…",
    signedOut: "Your sign-in has expired. Sign in again so the lesson keeps being reported.",
    simulate: "Simulation controls (test classroom only)",
    simulateNote: "These buttons play what a real video service would report. Nothing is sent to anyone.",
    scenario: {
      "remote-joins": "Other person enters", "remote-leaves": "Other person leaves", "remote-camera-off": "Their camera off", "remote-camera-on": "Their camera on",
      "network-drop": "Network drops", "network-restore": "Network back", "connection-failed": "Connection fails",
      "camera-denied": "Camera blocked", "microphone-unavailable": "No microphone", "devices-restored": "Devices back",
    } as Record<SyntheticScenario, string>,
    reasons: {
      LESSON_NOT_FOUND: "This lesson could not be found. Check that the link is complete, or contact iHear.",
      LESSON_CANCELLED: "This lesson has been cancelled.",
      NOT_ON_ROSTER_LINK: "This link does not open this lesson. Ask iHear for a new link.",
      NOT_ON_ROSTER: "Students: open the personal link from iHear. Tutors: sign in with your iHear account first.",
      IDENTITY_UNVERIFIED: "Your identity could not be confirmed. Tutors: sign in with your iHear account.",
      OBSERVER_NOT_ENABLED: "Observing lessons is not available yet.",
      OUTSIDE_JOIN_WINDOW: "The classroom opens 15 minutes before the lesson and closes 15 minutes after it ends.",
      CHECK_FAILED: "Entry could not be checked just now. Please try again.",
      PROVIDER_UNAVAILABLE: "The classroom is not open yet.",
      RATE_LIMITED: "Too many attempts. Please wait a few minutes and try again.",
      UNAVAILABLE: "The classroom cannot be reached right now. Please try again.",
    } as Record<string, string>,
  },
  zh: {
    title: "iHear 線上教室", other: "English",
    synthetic: "測試教室：只有合成資料，沒有接上視訊或錄影。",
    enter: "進入教室", entering: "確認中…", retry: "再試一次", leave: "離開教室",
    left: "你已離開教室。", rejoin: "重新進入", signIn: "小老師登入",
    lesson: "課程", time: "時間（台北）", you: "你的身分", tutor: "小老師", student: "學生",
    stage: "視訊畫面", self: "你", other_tutor: "小老師", other_student: "學生",
    noVideo: "測試教室沒有真實視訊。",
    cameraOnSimulated: "攝影機開啟（模擬：沒有真實畫面）", cameraOn: "攝影機開啟", cameraOff: "攝影機關閉",
    cameraDenied: "沒有攝影機權限", cameraUnavailable: "找不到攝影機",
    micOn: "麥克風開啟", micOff: "麥克風靜音", micDenied: "沒有麥克風權限", micUnavailable: "找不到麥克風",
    cameraStarting: "攝影機開啟中…", cameraFailed: "攝影機沒有開啟", micStarting: "麥克風開啟中…", micFailed: "麥克風沒有開啟",
    waitingOther: "等待對方進入教室。",
    syntheticOther: "測試教室看不到對方是否進入，可以用下方的模擬控制。",
    otherLeft: "對方已離開教室。",
    controls: "教室控制", camera: "攝影機", microphone: "麥克風", on: "開", off: "關", starting: "開啟中…", retryDevice: "再試一次",
    connection: { idle: "未連線", connecting: "連線中…", connected: "已連線", reconnecting: "重新連線中…", disconnected: "已中斷", failed: "連線失敗" } as Record<ConnectionState, string>,
    notConnected: "視訊尚未接上：這間教室還沒有選定視訊服務。",
    reconnecting: "視訊連線中斷，正在重新連線…",
    failed: "視訊無法連線，請再試一次。", reconnect: "重新連線",
    deviceHelp: {
      camera: { denied: "攝影機被封鎖。請在瀏覽器的網站設定允許使用攝影機，再試一次。", unavailable: "找不到攝影機。請確認攝影機已接上，而且沒有被其他程式使用。" },
      microphone: { denied: "麥克風被封鎖。請在瀏覽器的網站設定允許使用麥克風，再試一次。", unavailable: "找不到麥克風。請確認麥克風已接上，而且沒有被其他程式使用。" },
    } as Record<DeviceKind, Partial<Record<DeviceState, string>>>,
    deviceFailed: {
      camera: { error: "攝影機沒有成功開啟。請按「再試一次」；如果還是不行，請重新整理這個頁面。", missing: "找不到攝影機。請確認攝影機已接上，再按「再試一次」。", busy: "攝影機可能正被其他程式使用（例如另一個視訊軟體）。請關閉那個程式，再按「再試一次」。" },
      microphone: { error: "麥克風沒有成功開啟。請按「再試一次」；如果還是不行，請重新整理這個頁面。", autoplay: "瀏覽器暫停了這個頁面的聲音。請按「再試一次」讓聲音開始。", missing: "找不到麥克風。請確認麥克風已接上，再按「再試一次」。", busy: "麥克風可能正被其他程式使用。請關閉那個程式，再按「再試一次」。" },
    } as Record<DeviceKind, Partial<Record<DeviceProblem, string>>>,
    recording: "錄影", recordingNote: "錄影會自動開始和停止，你不需要操作。",
    allowed: "這堂課可以錄影。", notAllowed: "這堂課不錄影。", waiting: "等待第一次回報…",
    undecided: "是否錄影會在上課前自動決定。",
    badge: { recording: "錄影中", starting: "正在啟動錄影", paused: "錄影暫停", off: "未錄影", unknown: "錄影狀態不明" },
    studentNotice: {
      recording: "這堂課正在錄影。", starting: "錄影即將開始。", paused: "錄影已暫停。",
      off: "這堂課目前沒有錄影。", unknown: "暫時無法確認錄影狀態。",
    },
    basis: { confirmed: "已確認", requested: "已請求，等待視訊服務確認", inferred: "推測" } as Record<string, string>,
    status: {
      NOT_REQUESTED: "未開始", BLOCKED: "不錄影（同意條件不符）", START_REQUESTED: "已送出錄影啟動請求",
      RECORDING: "錄影中", PAUSED: "暫停", STOPPED: "已停止，等待錄影檔", POSSIBLY_STOPPED: "可能已停止",
      FAILED: "錄影失敗", COMPLETED: "錄影已完成",
    } as Record<string, string>,
    failedRecording: "錄影失敗。已通知 iHear 管理員，課程照常進行。",
    unstable: "和 iHear 的連線不穩定，正在重試…",
    signedOut: "登入已過期。請重新登入，系統才能繼續記錄這堂課。",
    simulate: "模擬控制（只在測試教室）",
    simulateNote: "這些按鈕模擬真實視訊服務會回報的狀況，不會傳送給任何人。",
    scenario: {
      "remote-joins": "對方進入", "remote-leaves": "對方離開", "remote-camera-off": "對方關攝影機", "remote-camera-on": "對方開攝影機",
      "network-drop": "網路中斷", "network-restore": "網路恢復", "connection-failed": "連線失敗",
      "camera-denied": "攝影機被封鎖", "microphone-unavailable": "找不到麥克風", "devices-restored": "裝置恢復",
    } as Record<SyntheticScenario, string>,
    reasons: {
      LESSON_NOT_FOUND: "找不到這堂課。請確認連結是否完整，或聯絡 iHear。",
      LESSON_CANCELLED: "這堂課已經取消。",
      NOT_ON_ROSTER_LINK: "這個連結無法進入這堂課。請向 iHear 索取新的連結。",
      NOT_ON_ROSTER: "學生請使用 iHear 提供的個人專屬連結；小老師請先用 iHear 帳號登入。",
      IDENTITY_UNVERIFIED: "無法確認你的身分。小老師請用 iHear 帳號登入。",
      OBSERVER_NOT_ENABLED: "旁聽功能尚未開放。",
      OUTSIDE_JOIN_WINDOW: "教室在上課前 15 分鐘開放，下課後 15 分鐘關閉。",
      CHECK_FAILED: "暫時無法確認入場資格，請稍後再試。",
      PROVIDER_UNAVAILABLE: "教室尚未開放。",
      RATE_LIMITED: "嘗試次數太多，請過幾分鐘再試。",
      UNAVAILABLE: "暫時連不上教室，請稍後再試。",
    } as Record<string, string>,
  },
};

const HEARTBEAT_MS = 30_000;
const RECORDING_HEARTBEAT_MS = 10_000;
const STATUS_MS = 15_000;
const RETRY_MS = 5_000;
const ACTIVE = new Set(["START_REQUESTED", "RECORDING", "PAUSED"]);
// While the video connection is down the tutor is not in class, so no heartbeat says otherwise.
const DOWN = new Set<ConnectionState>(["reconnecting", "disconnected", "failed"]);

type Phase = "ready" | "joining" | "joined" | "blocked" | "left";
type Joined = { provider: string; lesson: { code: string; startsAt: string; endsAt: string }; role: "tutor" | "student"; participantCode: string };
type Recording = { decided: boolean; allowed: boolean; status: string; basis: string };
type Media = {
  available: boolean;
  connection: ConnectionState;
  devices: Record<DeviceKind, DeviceState>;
  // Why a device that was pressed did not start, for the message beside "Try again".
  deviceProblems: Partial<Record<DeviceKind, DeviceProblem>>;
  remote: { present: boolean; camera: boolean; microphone: boolean; seen: boolean };
  share: "none" | "sending" | "receiving";
  whiteboard: "none" | "presenting" | "viewing";
};

const initialMedia = (): Media => ({ available: true, connection: "idle", devices: { camera: "off", microphone: "off" }, deviceProblems: {}, remote: { present: false, camera: false, microphone: false, seen: false }, share: "none", whiteboard: "none" });

function initialLocale(): Locale {
  try {
    const stored = localStorage.getItem("ihear-lang");
    if (stored === "en") return "en";
    if (stored === "zhTW" || stored === "zhCN") return "zh";
  } catch {
    // Storage can be blocked; fall back to the browser's language.
  }
  return navigator.language.toLowerCase().startsWith("zh") ? "zh" : "en";
}

// The personal key from the address: behind # (#k=…), or the older ?k=. It is taken out of the
// address bar at once (replacing the history entry, so none keeps it): not left in the history,
// a bookmark, a screenshot or an address passed on. It lives in this page's memory only, never in
// storage. Null when the address has none.
function takeJoinKey(): string | null {
  const url = new URL(window.location.href);
  const fragment = new URLSearchParams(url.hash.replace(/^#/, ""));
  if (!fragment.has("k") && !url.searchParams.has("k")) return null;
  const key = fragment.get("k") || url.searchParams.get("k");
  fragment.delete("k");
  url.searchParams.delete("k");
  const rest = fragment.toString();
  window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${rest ? `#${rest}` : ""}`);
  return key || null;
}

// One word for the badge both people see, from the recording status.
function badgeOf(recording: Recording | null): "recording" | "starting" | "paused" | "off" | "unknown" {
  if (!recording) return "unknown";
  if (recording.status === "RECORDING") return "recording";
  if (recording.status === "START_REQUESTED") return "starting";
  if (recording.status === "PAUSED") return "paused";
  // "Possibly stopped" is only inferred, so nobody is told the recording has ended.
  if (recording.status === "POSSIBLY_STOPPED") return "unknown";
  return "off";
}

export default function ClassroomEntry({ lessonId, synthetic }: { lessonId: string; synthetic: boolean }) {
  const [locale, setLocale] = useState<Locale>("zh");
  const [joinKey, setJoinKey] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>("ready");
  const [reason, setReason] = useState("");
  const [joined, setJoined] = useState<Joined | null>(null);
  const [recording, setRecording] = useState<Recording | null>(null);
  const [statusProblem, setStatusProblem] = useState(false);
  const [hostProblem, setHostProblem] = useState<"" | "unstable" | "signedOut">("");
  const [media, setMedia] = useState<Media>(initialMedia);
  const [simulator, setSimulator] = useState<SyntheticMediaAdapter | null>(null);
  // The vendor's own check of this browser, and a problem starting the materials or whiteboard.
  const [sdkCheck, setSdkCheck] = useState<MediaSystemCheck | null>(null);
  const [toolProblem, setToolProblem] = useState<"" | "share" | "board">("");
  // The provider's session token. It is never shown; it goes only to the media adapter.
  const session = useRef<JoinedSession | null>(null);
  // "Connect again" on its way, and why the join check refused it (its code), if it did.
  const [rejoining, setRejoining] = useState(false);
  const [rejoinProblem, setRejoinProblem] = useState("");
  const vendorStage = useRef<HTMLDivElement | null>(null);
  const [device, setDevice] = useState<ClassroomDevice>("desktop");
  const adapter = useRef<ClassroomMediaAdapter | null>(null);
  const connection = useRef<ConnectionState>("idle");
  const text = copy[locale];
  const hostUrl = `/api/classroom/${encodeURIComponent(lessonId)}/host-events`;
  const statusUrl = `/api/classroom/${encodeURIComponent(lessonId)}/status`;
  const signInUrl = `/api/auth/signin?callbackUrl=${encodeURIComponent(`/classroom/${lessonId}`)}`;

  useEffect(() => {
    setLocale(initialLocale());
    const key = takeJoinKey();
    if (key) setJoinKey(key);
    setDevice(classroomDeviceOf(navigator.userAgent, navigator.maxTouchPoints));
    // A new link opened in a tab that already shows this room changes only the part after #,
    // which reloads nothing; its key is taken the same way.
    const onHash = () => {
      const next = takeJoinKey();
      if (next) setJoinKey(next);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  useEffect(() => {
    document.documentElement.lang = locale === "en" ? "en" : "zh-Hant";
  }, [locale]);

  async function enter() {
    setPhase("joining");
    setReason("");
    setRejoinProblem("");
    const answer = await requestJoin(lessonId, joinKey);
    if (answer.ok) {
      session.current = answer.session;
      setJoined({ provider: answer.provider, lesson: answer.lesson, role: answer.role, participantCode: answer.participantCode });
      setRecording(null);
      setMedia(initialMedia());
      setPhase("joined");
      return;
    }
    setReason(answer.code);
    setPhase("blocked");
  }

  // One report from the tutor's page; the answer says how soon to report again.
  const report = useCallback(async (body: Record<string, unknown>) => {
    try {
      const response = await fetch(hostUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...body, at: new Date().toISOString() }),
      });
      if (response.status === 401) {
        setHostProblem("signedOut");
        return HEARTBEAT_MS;
      }
      const data = await response.json().catch(() => null);
      if (!response.ok || !data?.ok) {
        setHostProblem("unstable");
        return RETRY_MS;
      }
      setHostProblem("");
      const status = String(data.recording?.status ?? "");
      setRecording({ decided: data.recordingDecided === true, allowed: data.recordingAllowed === true, status, basis: String(data.recording?.basis ?? "") });
      return ACTIVE.has(status) ? RECORDING_HEARTBEAT_MS : HEARTBEAT_MS;
    } catch {
      setHostProblem("unstable");
      return RETRY_MS;
    }
  }, [hostUrl]);

  const isTutor = phase === "joined" && joined?.role === "tutor";
  const isStudent = phase === "joined" && joined?.role === "student";

  // The media adapter for this provider. Its events drive the stage, and on the tutor's page they
  // are reported to iHear the moment they happen.
  useEffect(() => {
    if (phase !== "joined" || !joined) return;
    let current: ClassroomMediaAdapter;
    try {
      current = createMediaAdapter(joined.provider);
    } catch (error) {
      if (!(error instanceof MediaAdapterUnavailableError)) throw error;
      setMedia((state) => ({ ...state, available: false }));
      return;
    }
    adapter.current = current;
    setSimulator(current instanceof SyntheticMediaAdapter ? current : null);
    const unsubscribe = current.subscribe((event: MediaEvent) => {
      if (event.type === "connection") {
        connection.current = event.state;
        setMedia((state) => ({ ...state, connection: event.state }));
      } else if (event.type === "device") {
        setMedia((state) => ({
          ...state, devices: { ...state.devices, [event.kind]: event.state },
          deviceProblems: { ...state.deviceProblems, [event.kind]: event.state === "failed" ? event.problem ?? "error" : undefined },
        }));
      } else if (event.type === "remote") {
        setMedia((state) => ({ ...state, remote: { present: event.present, camera: event.camera, microphone: event.microphone, seen: state.remote.seen || event.present } }));
      } else if (event.type === "share") {
        setMedia((state) => ({ ...state, share: event.state }));
      } else {
        setMedia((state) => ({ ...state, whiteboard: event.state }));
      }
      if (joined.role === "tutor") {
        const body = hostReportFor(event);
        if (body) void report(body);
      }
    });
    if (vendorStage.current && current.mount) current.mount(vendorStage.current);
    current.systemCheck?.().then(setSdkCheck, () => setSdkCheck(null));
    if (session.current) {
      current.join({
        sessionToken: session.current.token ?? "", sessionName: session.current.sessionName, embedUrl: session.current.embedUrl,
        lessonCode: joined.lesson.code, participantCode: joined.participantCode, role: joined.role,
      }).catch((error: unknown) => {
        // A vendor that cannot load (the Zoom package before the trial) says "not connected".
        if (error instanceof MediaAdapterUnavailableError) setMedia((state) => ({ ...state, available: false }));
      });
    }
    return () => {
      unsubscribe();
      void current.leave();
      adapter.current = null;
      setSimulator(null);
      setSdkCheck(null);
      setToolProblem("");
      connection.current = "idle";
    };
  }, [phase, joined, report]);

  useEffect(() => {
    if (!isTutor) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const beat = async () => {
      const next = DOWN.has(connection.current) ? HEARTBEAT_MS : await report({ type: "heartbeat" });
      if (!stopped) timer = setTimeout(beat, DOWN.has(connection.current) ? RETRY_MS : next);
    };
    beat();
    // Closing the tab or leaving the page counts as the tutor leaving; keepalive lets the report
    // outlive the page.
    const onHide = () => {
      fetch(hostUrl, {
        method: "POST",
        keepalive: true,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "connection", state: "Closed", at: new Date().toISOString() }),
      }).catch(() => undefined);
    };
    window.addEventListener("pagehide", onHide);
    return () => {
      stopped = true;
      clearTimeout(timer);
      window.removeEventListener("pagehide", onHide);
    };
  }, [isTutor, report, hostUrl]);

  // The student is told whether the lesson is being recorded, from the same server state the
  // tutor sees.
  useEffect(() => {
    if (!isStudent) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = async () => {
      try {
        const response = await fetch(statusUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(joinKey ? { key: joinKey } : {}),
        });
        const data = await response.json().catch(() => null);
        if (response.ok && data?.ok) {
          setStatusProblem(false);
          setRecording({ decided: data.recordingDecided === true, allowed: data.recordingAllowed === true, status: String(data.recording?.status ?? ""), basis: String(data.recording?.basis ?? "") });
        } else {
          setStatusProblem(true);
        }
      } catch {
        setStatusProblem(true);
      }
      if (!stopped) timer = setTimeout(read, STATUS_MS);
    };
    read();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [isStudent, statusUrl, joinKey]);

  async function toggle(kind: DeviceKind) {
    const current = adapter.current;
    if (!current) return;
    await current.setDevice(kind, media.devices[kind] !== "on");
  }

  // The tutor's materials and whiteboard (Zoom). Starting either can be refused by the browser or
  // the account; the page says so and the lesson carries on.
  async function toggleShare() {
    const current = adapter.current;
    if (!current?.setScreenShare) return;
    setToolProblem("");
    const on = media.share !== "sending";
    const started = await current.setScreenShare(on).catch(() => false);
    if (on && !started) setToolProblem("share");
  }

  async function toggleBoard() {
    const current = adapter.current;
    if (!current?.setWhiteboard) return;
    setToolProblem("");
    const on = media.whiteboard !== "presenting";
    const started = await current.setWhiteboard(on).catch(() => false);
    if (on && !started) setToolProblem("board");
  }

  // "Connect again" asks the protected join check again, exactly as entering does, and joins with
  // the new token; the token from entry is never reused (R-1). A refusal (the time window closed,
  // the lesson cancelled, the sign-in ended) is shown and nothing connects.
  async function reconnect() {
    const current = adapter.current;
    if (!current || !joined) return;
    setRejoining(true);
    setRejoinProblem("");
    const result = await rejoinRoom(current, () => requestJoin(lessonId, joinKey), {
      lessonCode: joined.lesson.code, participantCode: joined.participantCode, role: joined.role,
    });
    setRejoining(false);
    // Left (or entered anew) meanwhile: this answer belongs to a room that is gone.
    if (adapter.current !== current) return;
    if (result.ok) session.current = result.session;
    else if (result.code !== "CONNECT_FAILED") setRejoinProblem(result.code);
  }

  async function leave() {
    // Leaving the media room reports "Closed" through the adapter; without one, say it directly.
    if (adapter.current) await adapter.current.leave();
    else if (joined?.role === "tutor") await report({ type: "connection", state: "Closed" });
    session.current = null;
    setRejoinProblem("");
    setPhase("left");
  }

  const when = (iso: string) => new Intl.DateTimeFormat(locale === "en" ? "en-GB" : "zh-TW", {
    timeZone: "Asia/Taipei", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(new Date(iso));
  const until = (iso: string) => new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Taipei", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso));
  const showSignIn = phase === "blocked" && !joinKey && ["NOT_ON_ROSTER", "IDENTITY_UNVERIFIED"].includes(reason);
  const badge = statusProblem && isStudent ? "unknown" : badgeOf(recording);
  // "Simulated" only in the synthetic stand-in; a vendor adapter carries real video.
  const cameraOn = simulator ? text.cameraOnSimulated : text.cameraOn;
  const cameraText = { on: cameraOn, off: text.cameraOff, denied: text.cameraDenied, unavailable: text.cameraUnavailable, starting: text.cameraStarting, failed: text.cameraFailed }[media.devices.camera];
  const micText = { on: text.micOn, off: text.micOff, denied: text.micDenied, unavailable: text.micUnavailable, starting: text.micStarting, failed: text.micFailed }[media.devices.microphone];
  const otherName = joined?.role === "tutor" ? text.other_student : text.other_tutor;
  const connected = media.connection === "connected";

  return (
    <main className="classroom-room">
      <header className="classroom-room-head">
        <h1>{text.title}</h1>
        <button type="button" className="classroom-lang" onClick={() => setLocale(locale === "en" ? "zh" : "en")}>{text.other}</button>
      </header>
      {synthetic && <p className="classroom-room-note" role="note">{text.synthetic}</p>}

      {phase !== "joined" && (
        <section className="classroom-room-card" aria-live="polite">
          {phase === "left" && <p>{text.left}</p>}
          {phase === "blocked" && <p className="classroom-room-problem" role="alert">{text.reasons[reason] ?? text.reasons.UNAVAILABLE}</p>}
          <div className="classroom-room-actions">
            <button type="button" className="classroom-room-primary" disabled={phase === "joining"} onClick={enter}>
              {phase === "joining" ? text.entering : phase === "blocked" ? text.retry : phase === "left" ? text.rejoin : text.enter}
            </button>
            {showSignIn && <a className="classroom-room-secondary" href={signInUrl}>{text.signIn}</a>}
          </div>
        </section>
      )}

      {phase === "joined" && joined && (
        <>
          <dl className="classroom-room-facts">
            <div><dt>{text.lesson}</dt><dd>{joined.lesson.code}</dd></div>
            <div><dt>{text.time}</dt><dd>{when(joined.lesson.startsAt)}–{until(joined.lesson.endsAt)}</dd></div>
            <div><dt>{text.you}</dt><dd>{joined.role === "tutor" ? text.tutor : text.student} {joined.participantCode}</dd></div>
          </dl>

          <div className="classroom-room-statusbar">
            <span className={`classroom-room-connection ${media.available ? media.connection : "unavailable"}`} role="status">
              {media.available ? text.connection[media.connection] : text.connection.idle}
            </span>
            <span className={`classroom-room-badge ${badge}`} role="status" aria-label={`${text.recording}：${text.badge[badge]}`}>{text.badge[badge]}</span>
          </div>

          {VENDOR_PROVIDERS.has(joined.provider) && (() => {
            const limits = deviceLimits(joined.provider, device);
            const v = vendorCopy[locale];
            return (
              <>
                {joined.provider === "tencent-lcic" && <p className="classroom-room-note" role="note">{v.lcicNote}{session.current?.recordingDisabled ? ` ${v.lcicRecordingOff}` : ""}</p>}
                <div className={`classroom-vendor-stage ${joined.provider}`} ref={vendorStage} aria-label={joined.provider === "zoom-video-sdk" ? v.zoomVideo : text.stage} data-provider={joined.provider} />
                {joined.provider === "zoom-video-sdk" && (
                  <div className="classroom-room-tools" aria-live="polite">
                    {media.share !== "none" && <p className="classroom-room-note" role="status">{media.share === "sending" ? v.sharing : v.receiving}</p>}
                    {media.whiteboard !== "none" && <p className="classroom-room-note" role="status">{media.whiteboard === "presenting" ? v.presenting : v.viewing}</p>}
                    {joined.role === "tutor" && (
                      <>
                        <div className="classroom-room-controls" role="toolbar" aria-label={v.zoomVideo}>
                          <button type="button" className="classroom-room-control" aria-pressed={media.share === "sending"} data-tool="share"
                            disabled={!connected || device !== "desktop" || sdkCheck?.screenShare === false} onClick={toggleShare}>
                            {media.share === "sending" ? v.shareStop : v.share}
                          </button>
                          <button type="button" className="classroom-room-control" aria-pressed={media.whiteboard === "presenting"} data-tool="whiteboard"
                            disabled={!connected} onClick={toggleBoard}>
                            {media.whiteboard === "presenting" ? v.whiteboardStop : v.whiteboard}
                          </button>
                          {media.whiteboard === "presenting" && (
                            <button type="button" className="classroom-room-secondary" data-tool="export"
                              onClick={() => void adapter.current?.exportWhiteboard?.(`iHear-${joined.lesson.code}`).catch(() => setToolProblem("board"))}>{v.exportBoard}</button>
                          )}
                        </div>
                        <p className="classroom-room-muted">{device === "desktop" && sdkCheck?.screenShare !== false ? v.shareHint : v.noShareHere}</p>
                      </>
                    )}
                    {toolProblem && <p className="classroom-room-problem" role="alert">{toolProblem === "share" ? v.shareFailed : v.boardFailed}</p>}
                  </div>
                )}
                {limits.length > 0 && (
                  <details className="classroom-room-card classroom-room-limits" data-device={device}>
                    <summary>{v.limitsTitle}（{v.device[device]}）</summary>
                    {sdkCheck && <p className="classroom-room-muted" data-sdk-version={sdkCheck.sdkVersion}>{v.sdkCheck(sdkCheck)}</p>}
                    <ul>{limits.map(limit => <li key={limit.name} data-capability={limit.name} data-level={limit.level}>{v.limits[limit.name]}{limit.level === "unknown" ? v.unknown : ""}</li>)}</ul>
                  </details>
                )}
              </>
            );
          })()}

          {joined.provider !== "tencent-lcic" && <section className="classroom-room-stage" aria-label={text.stage}>
            <div className="classroom-room-tile remote">
              <p className="classroom-room-tile-name">{otherName}</p>
              {!media.available ? <p>{text.notConnected}</p>
                : media.remote.present ? (
                  <>
                    <p>{media.remote.camera ? cameraOn : text.cameraOff}</p>
                    <p className="classroom-room-tile-sub">{media.remote.microphone ? text.micOn : text.micOff}</p>
                  </>
                ) : (
                  <>
                    <p>{media.remote.seen ? text.otherLeft : text.waitingOther}</p>
                    {simulator && <p className="classroom-room-tile-sub">{text.syntheticOther}</p>}
                  </>
                )}
            </div>
            <div className="classroom-room-tile self">
              <p className="classroom-room-tile-name">{text.self}</p>
              <p>{cameraText}</p>
              <p className="classroom-room-tile-sub">{micText}</p>
            </div>
            {simulator && <p className="classroom-room-stage-note">{text.noVideo}</p>}
          </section>}

          {media.available && media.connection === "reconnecting" && <p className="classroom-room-problem" role="status">{text.reconnecting}</p>}
          {media.available && media.connection === "failed" && (
            <div className="classroom-room-problem classroom-room-problem-row" role="alert">
              <span>{text.failed}{rejoinProblem && ` ${text.reasons[rejoinProblem] ?? text.reasons.UNAVAILABLE}`}</span>
              {joined.role === "tutor" && ["NOT_ON_ROSTER", "IDENTITY_UNVERIFIED"].includes(rejoinProblem) && <a className="classroom-room-secondary" href={signInUrl}>{text.signIn}</a>}
              <button type="button" className="classroom-room-secondary" disabled={rejoining} onClick={reconnect}>{text.reconnect}</button>
            </div>
          )}
          {(["camera", "microphone"] as const).map((kind) => {
            // A press that did not start: what to do, and the button that tries again (a click of
            // its own, as the browser requires).
            if (media.devices[kind] === "failed") {
              const problem = media.deviceProblems[kind] ?? "error";
              return (
                <div key={kind} className="classroom-room-problem classroom-room-problem-row" role="alert" data-device-problem={`${kind}:${problem}`}>
                  <span>{text.deviceFailed[kind][problem] ?? text.deviceFailed[kind].error}</span>
                  <button type="button" className="classroom-room-secondary" onClick={() => toggle(kind)}>{text.retryDevice}</button>
                </div>
              );
            }
            const help = text.deviceHelp[kind][media.devices[kind]];
            return help ? <p key={kind} className="classroom-room-problem" role="alert">{help}</p> : null;
          })}

          <div className="classroom-room-controls" role="toolbar" aria-label={text.controls}>
            {joined.provider !== "tencent-lcic" && (["microphone", "camera"] as const).map((kind) => {
              const state = media.devices[kind];
              const blocked = state === "denied" || state === "unavailable";
              return (
                <button key={kind} type="button" className="classroom-room-control" aria-pressed={state === "on"}
                  disabled={!media.available || !connected || blocked || state === "starting"} onClick={() => toggle(kind)}>
                  {text[kind]}：{state === "on" ? text.on : state === "starting" ? text.starting : text.off}
                </button>
              );
            })}
            <button type="button" className="classroom-room-secondary" onClick={leave}>{text.leave}</button>
          </div>

          {joined.role === "tutor" ? (
            <section className="classroom-room-card" aria-live="polite">
              <h2>{text.recording}</h2>
              {recording ? (
                <>
                  <p className={`classroom-room-recording ${recording.status}`}>
                    {text.status[recording.status] ?? recording.status}
                    {recording.basis && <span>（{text.basis[recording.basis] ?? recording.basis}）</span>}
                  </p>
                  <p>{!recording.decided ? text.undecided : recording.allowed ? text.allowed : text.notAllowed}</p>
                  {recording.status === "FAILED" && <p className="classroom-room-problem" role="alert">{text.failedRecording}</p>}
                </>
              ) : <p>{text.waiting}</p>}
              <p className="classroom-room-muted">{text.recordingNote}</p>
              {hostProblem === "unstable" && <p className="classroom-room-problem" role="status">{text.unstable}</p>}
              {hostProblem === "signedOut" && <p className="classroom-room-problem" role="alert">{text.signedOut} <a href={signInUrl}>{text.signIn}</a></p>}
            </section>
          ) : (
            <section className="classroom-room-card classroom-room-notice" aria-live="polite">
              <h2>{text.recording}</h2>
              <p>{text.studentNotice[badge]}</p>
            </section>
          )}

          {simulator && (
            <details className="classroom-room-card classroom-room-simulator">
              <summary>{text.simulate}</summary>
              <p className="classroom-room-muted">{text.simulateNote}</p>
              <div className="classroom-room-simulator-buttons">
                {SYNTHETIC_SCENARIOS.map((scenario) => (
                  <button key={scenario} type="button" className="classroom-room-secondary" onClick={() => simulator.simulate(scenario)}>{text.scenario[scenario]}</button>
                ))}
              </div>
            </details>
          )}
        </>
      )}
    </main>
  );
}
