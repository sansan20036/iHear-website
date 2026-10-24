"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// What a student or a tutor sees: one button to enter, a plain reason when they cannot, and for
// the tutor the lesson's recording state. Week 1 has no video (synthetic provider); the Zoom
// Video SDK joins behind the same answer in week 2. Recording is started and stopped by the
// server, never from this page: the tutor's page only reports what it sees, every 30 seconds,
// or every 10 while recording so that a stop reaches it quickly.

type Locale = "en" | "zh";

const copy = {
  en: {
    title: "iHear Classroom", other: "中文",
    synthetic: "Test classroom: synthetic data only. No video or recording is connected.",
    enter: "Enter the classroom", entering: "Checking…", retry: "Try again", leave: "Leave the classroom",
    left: "You have left the classroom.", rejoin: "Enter again", signIn: "Tutor sign-in",
    lesson: "Lesson", time: "Time (Taipei)", you: "You", tutor: "Tutor", student: "Student",
    video: "Video appears here once the classroom is connected to Zoom. This test build has no video.",
    recording: "Recording", recordingNote: "Recording starts and stops on its own; you do not need to do anything.",
    allowed: "This lesson may be recorded.", notAllowed: "This lesson is not recorded.", waiting: "Waiting for the first report…",
    undecided: "Whether this lesson is recorded is decided automatically before it starts.",
    basis: { confirmed: "confirmed", requested: "requested, waiting for Zoom", inferred: "inferred" } as Record<string, string>,
    status: {
      NOT_REQUESTED: "Not started", BLOCKED: "Not recorded (consent conditions not met)", START_REQUESTED: "Start requested",
      RECORDING: "Recording", PAUSED: "Paused", STOPPED: "Stopped, waiting for the file", POSSIBLY_STOPPED: "Possibly stopped",
      FAILED: "Recording failed", COMPLETED: "Recording complete",
    } as Record<string, string>,
    unstable: "The connection to iHear is unstable. Still trying…",
    signedOut: "Your sign-in has expired. Sign in again so the lesson keeps being reported.",
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
    video: "教室接上 Zoom 之後，視訊畫面會出現在這裡。這個測試版本沒有視訊。",
    recording: "錄影", recordingNote: "錄影會自動開始和停止，你不需要操作。",
    allowed: "這堂課可以錄影。", notAllowed: "這堂課不錄影。", waiting: "等待第一次回報…",
    undecided: "是否錄影會在上課前自動決定。",
    basis: { confirmed: "已確認", requested: "已請求，等待 Zoom 確認", inferred: "推測" } as Record<string, string>,
    status: {
      NOT_REQUESTED: "未開始", BLOCKED: "不錄影（同意條件不符）", START_REQUESTED: "已送出錄影啟動請求",
      RECORDING: "錄影中", PAUSED: "暫停", STOPPED: "已停止，等待錄影檔", POSSIBLY_STOPPED: "可能已停止",
      FAILED: "錄影失敗", COMPLETED: "錄影已完成",
    } as Record<string, string>,
    unstable: "和 iHear 的連線不穩定，正在重試…",
    signedOut: "登入已過期。請重新登入，系統才能繼續記錄這堂課。",
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
const RETRY_MS = 5_000;
const ACTIVE = new Set(["START_REQUESTED", "RECORDING", "PAUSED"]);

type Phase = "ready" | "joining" | "joined" | "blocked" | "left";
type Joined = { provider: string; lesson: { code: string; startsAt: string; endsAt: string }; role: "tutor" | "student"; participantCode: string };
type Recording = { decided: boolean; allowed: boolean; status: string; basis: string };

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

export default function ClassroomEntry({ lessonId, synthetic }: { lessonId: string; synthetic: boolean }) {
  const [locale, setLocale] = useState<Locale>("zh");
  const [joinKey, setJoinKey] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>("ready");
  const [reason, setReason] = useState("");
  const [joined, setJoined] = useState<Joined | null>(null);
  const [recording, setRecording] = useState<Recording | null>(null);
  const [hostProblem, setHostProblem] = useState<"" | "unstable" | "signedOut">("");
  // The provider's session token. It is never shown; week 2 hands it to the Video SDK.
  const session = useRef<{ token: string; expiresAt: string } | null>(null);
  const text = copy[locale];
  const hostUrl = `/api/classroom/${encodeURIComponent(lessonId)}/host-events`;
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
  useEffect(() => {
    if (!isTutor) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const beat = async () => {
      const next = await report({ type: "heartbeat" });
      if (!stopped) timer = setTimeout(beat, next);
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

  async function leave() {
    if (joined?.role === "tutor") await report({ type: "connection", state: "Closed" });
    session.current = null;
    setPhase("left");
  }

  const when = (iso: string) => new Intl.DateTimeFormat(locale === "en" ? "en-GB" : "zh-TW", {
    timeZone: "Asia/Taipei", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(new Date(iso));
  const until = (iso: string) => new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Taipei", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso));
  const showSignIn = phase === "blocked" && !joinKey && ["NOT_ON_ROSTER", "IDENTITY_UNVERIFIED"].includes(reason);

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
          <div className="classroom-room-stage" role="img" aria-label={text.video}><p>{text.video}</p></div>
          {joined.role === "tutor" && (
            <section className="classroom-room-card" aria-live="polite">
              <h2>{text.recording}</h2>
              {recording ? (
                <>
                  <p className={`classroom-room-recording ${recording.status}`}>
                    {text.status[recording.status] ?? recording.status}
                    {recording.basis && <span>（{text.basis[recording.basis] ?? recording.basis}）</span>}
                  </p>
                  <p>{!recording.decided ? text.undecided : recording.allowed ? text.allowed : text.notAllowed}</p>
                </>
              ) : <p>{text.waiting}</p>}
              <p className="classroom-room-muted">{text.recordingNote}</p>
              {hostProblem === "unstable" && <p className="classroom-room-problem" role="status">{text.unstable}</p>}
              {hostProblem === "signedOut" && <p className="classroom-room-problem" role="alert">{text.signedOut} <a href={signInUrl}>{text.signIn}</a></p>}
            </section>
          )}
          <div className="classroom-room-actions">
            <button type="button" className="classroom-room-secondary" onClick={leave}>{text.leave}</button>
          </div>
        </>
      )}
    </main>
  );
}
