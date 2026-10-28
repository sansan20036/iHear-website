"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  createMediaAdapter, hostReportFor, MediaAdapterUnavailableError, SYNTHETIC_SCENARIOS, SyntheticMediaAdapter,
  type ClassroomMediaAdapter, type ConnectionState, type DeviceKind, type DeviceState, type MediaEvent, type SyntheticScenario,
} from "../../../lib/classroom-media";

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
    cameraOnSimulated: "Camera on (simulated: no real picture)", cameraOff: "Camera off",
    cameraDenied: "Camera not allowed", cameraUnavailable: "No camera found",
    micOn: "Microphone on", micOff: "Microphone muted", micDenied: "Microphone not allowed", micUnavailable: "No microphone found",
    waitingOther: "Waiting for the other person to enter.",
    syntheticOther: "The test classroom cannot see the other person; use the simulation controls below.",
    otherLeft: "The other person has left the classroom.",
    controls: "Classroom controls", camera: "Camera", microphone: "Microphone", on: "on", off: "off",
    connection: { idle: "Not connected", connecting: "Connecting…", connected: "Connected", reconnecting: "Reconnecting…", disconnected: "Disconnected", failed: "Connection failed" } as Record<ConnectionState, string>,
    notConnected: "Video is not connected: no video service has been chosen for this classroom yet.",
    reconnecting: "The video connection dropped. Reconnecting…",
    failed: "The video could not connect. Try connecting again.", reconnect: "Connect again",
    deviceHelp: {
      camera: { denied: "The camera is blocked. Allow the camera for this site in the browser's settings, then try again.", unavailable: "No camera was found. Check that one is connected and not used by another app." },
      microphone: { denied: "The microphone is blocked. Allow the microphone for this site in the browser's settings, then try again.", unavailable: "No microphone was found. Check that one is connected and not used by another app." },
    } as Record<DeviceKind, Partial<Record<DeviceState, string>>>,
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
    cameraOnSimulated: "攝影機開啟（模擬：沒有真實畫面）", cameraOff: "攝影機關閉",
    cameraDenied: "沒有攝影機權限", cameraUnavailable: "找不到攝影機",
    micOn: "麥克風開啟", micOff: "麥克風靜音", micDenied: "沒有麥克風權限", micUnavailable: "找不到麥克風",
    waitingOther: "等待對方進入教室。",
    syntheticOther: "測試教室看不到對方是否進入，可以用下方的模擬控制。",
    otherLeft: "對方已離開教室。",
    controls: "教室控制", camera: "攝影機", microphone: "麥克風", on: "開", off: "關",
    connection: { idle: "未連線", connecting: "連線中…", connected: "已連線", reconnecting: "重新連線中…", disconnected: "已中斷", failed: "連線失敗" } as Record<ConnectionState, string>,
    notConnected: "視訊尚未接上：這間教室還沒有選定視訊服務。",
    reconnecting: "視訊連線中斷，正在重新連線…",
    failed: "視訊無法連線，請再試一次。", reconnect: "重新連線",
    deviceHelp: {
      camera: { denied: "攝影機被封鎖。請在瀏覽器的網站設定允許使用攝影機，再試一次。", unavailable: "找不到攝影機。請確認攝影機已接上，而且沒有被其他程式使用。" },
      microphone: { denied: "麥克風被封鎖。請在瀏覽器的網站設定允許使用麥克風，再試一次。", unavailable: "找不到麥克風。請確認麥克風已接上，而且沒有被其他程式使用。" },
    } as Record<DeviceKind, Partial<Record<DeviceState, string>>>,
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
  remote: { present: boolean; camera: boolean; microphone: boolean; seen: boolean };
};

const initialMedia = (): Media => ({ available: true, connection: "idle", devices: { camera: "off", microphone: "off" }, remote: { present: false, camera: false, microphone: false, seen: false } });

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
  // The provider's session token. It is never shown; it goes only to the media adapter.
  const session = useRef<{ token: string; expiresAt: string } | null>(null);
  const adapter = useRef<ClassroomMediaAdapter | null>(null);
  const connection = useRef<ConnectionState>("idle");
  const text = copy[locale];
  const hostUrl = `/api/classroom/${encodeURIComponent(lessonId)}/host-events`;
  const statusUrl = `/api/classroom/${encodeURIComponent(lessonId)}/status`;
  const signInUrl = `/api/auth/signin?callbackUrl=${encodeURIComponent(`/classroom/${lessonId}`)}`;

  useEffect(() => {
    setLocale(initialLocale());
    setJoinKey(new URLSearchParams(window.location.search).get("k"));
  }, []);
  useEffect(() => {
    document.documentElement.lang = locale === "en" ? "en" : "zh-Hant";
  }, [locale]);

  async function enter() {
    setPhase("joining");
    setReason("");
    try {
      const response = await fetch(`/api/classroom/${encodeURIComponent(lessonId)}/join`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(joinKey ? { key: joinKey } : {}),
      });
      const data = await response.json().catch(() => ({}));
      if (response.ok && data.ok) {
        session.current = data.session ?? null;
        setJoined({ provider: data.provider, lesson: data.lesson, role: data.role, participantCode: data.participantCode });
        setRecording(null);
        setMedia(initialMedia());
        setPhase("joined");
        return;
      }
      const code = response.status === 429 ? "RATE_LIMITED" : typeof data.code === "string" ? data.code : "UNAVAILABLE";
      setReason(code === "NOT_ON_ROSTER" && joinKey ? "NOT_ON_ROSTER_LINK" : code);
    } catch {
      setReason("UNAVAILABLE");
    }
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
        setMedia((state) => ({ ...state, devices: { ...state.devices, [event.kind]: event.state } }));
      } else {
        setMedia((state) => ({ ...state, remote: { present: event.present, camera: event.camera, microphone: event.microphone, seen: state.remote.seen || event.present } }));
      }
      if (joined.role === "tutor") {
        const body = hostReportFor(event);
        if (body) void report(body);
      }
    });
    if (session.current) {
      void current.join({ sessionToken: session.current.token, lessonCode: joined.lesson.code, participantCode: joined.participantCode, role: joined.role });
    }
    return () => {
      unsubscribe();
      void current.leave();
      adapter.current = null;
      setSimulator(null);
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

  async function reconnect() {
    const current = adapter.current;
    if (!current || !session.current || !joined) return;
    await current.join({ sessionToken: session.current.token, lessonCode: joined.lesson.code, participantCode: joined.participantCode, role: joined.role });
  }

  async function leave() {
    // Leaving the media room reports "Closed" through the adapter; without one, say it directly.
    if (adapter.current) await adapter.current.leave();
    else if (joined?.role === "tutor") await report({ type: "connection", state: "Closed" });
    session.current = null;
    setPhase("left");
  }

  const when = (iso: string) => new Intl.DateTimeFormat(locale === "en" ? "en-GB" : "zh-TW", {
    timeZone: "Asia/Taipei", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(new Date(iso));
  const until = (iso: string) => new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Taipei", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso));
  const showSignIn = phase === "blocked" && !joinKey && ["NOT_ON_ROSTER", "IDENTITY_UNVERIFIED"].includes(reason);
  const badge = statusProblem && isStudent ? "unknown" : badgeOf(recording);
  const cameraText = { on: text.cameraOnSimulated, off: text.cameraOff, denied: text.cameraDenied, unavailable: text.cameraUnavailable }[media.devices.camera];
  const micText = { on: text.micOn, off: text.micOff, denied: text.micDenied, unavailable: text.micUnavailable }[media.devices.microphone];
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

          <section className="classroom-room-stage" aria-label={text.stage}>
            <div className="classroom-room-tile remote">
              <p className="classroom-room-tile-name">{otherName}</p>
              {!media.available ? <p>{text.notConnected}</p>
                : media.remote.present ? (
                  <>
                    <p>{media.remote.camera ? text.cameraOnSimulated : text.cameraOff}</p>
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
          </section>

          {media.available && media.connection === "reconnecting" && <p className="classroom-room-problem" role="status">{text.reconnecting}</p>}
          {media.available && media.connection === "failed" && (
            <div className="classroom-room-problem classroom-room-problem-row" role="alert">
              <span>{text.failed}</span>
              <button type="button" className="classroom-room-secondary" onClick={reconnect}>{text.reconnect}</button>
            </div>
          )}
          {(["camera", "microphone"] as const).map((kind) => {
            const help = text.deviceHelp[kind][media.devices[kind]];
            return help ? <p key={kind} className="classroom-room-problem" role="alert">{help}</p> : null;
          })}

          <div className="classroom-room-controls" role="toolbar" aria-label={text.controls}>
            {(["microphone", "camera"] as const).map((kind) => {
              const state = media.devices[kind];
              const blocked = state === "denied" || state === "unavailable";
              return (
                <button key={kind} type="button" className="classroom-room-control" aria-pressed={state === "on"}
                  disabled={!media.available || !connected || blocked} onClick={() => toggle(kind)}>
                  {text[kind]}：{state === "on" ? text.on : text.off}
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
