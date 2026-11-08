"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  createMediaAdapter, hostReportFor, MediaAdapterUnavailableError, SYNTHETIC_SCENARIOS, SyntheticMediaAdapter,
  type ClassroomMediaAdapter, type ConnectionState, type DeviceKind, type DeviceProblem, type DeviceState, type MediaEvent, type MediaSystemCheck, type SyntheticScenario,
} from "../../../lib/classroom-media";
import { classroomDeviceOf, deviceLimits, type CapabilityName, type ClassroomDevice } from "../../../lib/classroom-capabilities";
import { entryEndedBy, rejoinRoom, requestJoin, type JoinedSession } from "../../../lib/classroom-join-client";
import { browserClassroomLocale, CLASSROOM_LOCALES, htmlLangOf, intlLocaleOf, LOCALE_NAMES, type ClassroomLocale } from "../../../lib/classroom-locale";
import { roomCopy as copy, vendorCopy } from "./classroom-copy";

// The vendor-specific parts of the room (2026-10-30): Zoom draws its video in our page; LCIC is
// Tencent's own classroom page in an iframe. Notes per device come from lib/classroom-capabilities
// (vendor documentation, not yet tried on real devices).
const VENDOR_PROVIDERS = new Set(["zoom-video-sdk", "tencent-lcic"]);

// What a student or a tutor sees: one button to enter, a plain reason when they cannot, and once
// inside, the lesson's facts, the video stage with camera and microphone controls, and whether
// the lesson is being recorded. The video goes through a provider-neutral adapter
// (lib/classroom-media.ts); only the synthetic stand-in exists, and it carries no audio or
// video, which the page says. Recording is started and stopped by the server, never from this
// page: the tutor's page only reports what it sees, every 30 seconds, or every 10 while
// recording so that a stop reaches it quickly, and both pages read the recording state.

type Locale = ClassroomLocale;


const HEARTBEAT_MS = 30_000;
const RECORDING_HEARTBEAT_MS = 10_000;
const STATUS_MS = 15_000;
const RETRY_MS = 5_000;
const ACTIVE = new Set(["START_REQUESTED", "RECORDING", "PAUSED"]);
// While the video connection is down the tutor is not in class, so no heartbeat says otherwise.
const DOWN = new Set<ConnectionState>(["reconnecting", "disconnected", "failed"]);

type Phase = "ready" | "joining" | "joined" | "blocked" | "left";
// sessionReports: the join answer asked this (tutor's) page to report the vendor's session id.
type Joined = { provider: string; lesson: { code: string; startsAt: string; endsAt: string }; role: "tutor" | "student"; participantCode: string; sessionReports: boolean };
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
  const [locale, setLocale] = useState<Locale>("zhHant");
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
  // D-5 (2026-11-08): the server's regular answers say which room new tokens lead to. A page in
  // another room (its lesson's link was revoked or reissued, D-1) moves there with a new token:
  // the same protected request as "Connect again", never a token it already had.
  const moveRoom = useRef<() => void>(() => undefined);
  const followRoom = useCallback((room: unknown) => {
    const here = session.current?.sessionName;
    if (typeof room === "string" && room && here && room !== here) moveRoom.current();
  }, []);
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
    setLocale(browserClassroomLocale());
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
    document.documentElement.lang = htmlLangOf(locale);
  }, [locale]);

  async function enter() {
    setPhase("joining");
    setReason("");
    setRejoinProblem("");
    const answer = await requestJoin(lessonId, joinKey);
    if (answer.ok) {
      session.current = answer.session;
      setJoined({ provider: answer.provider, lesson: answer.lesson, role: answer.role, participantCode: answer.participantCode, sessionReports: answer.sessionReports === true });
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
      // The lesson was cancelled: leave the room (this page's own leaving; see entryEndedBy).
      const ended = entryEndedBy({ status: response.status, code: data?.code }, { role: "tutor", hasKey: false });
      if (ended) {
        setReason(ended);
        setPhase("blocked");
        return HEARTBEAT_MS;
      }
      if (!response.ok || !data?.ok) {
        setHostProblem("unstable");
        // A refusal or a rate limit is not helped by asking again at once.
        return response.status === 403 || response.status === 429 ? HEARTBEAT_MS : RETRY_MS;
      }
      setHostProblem("");
      const status = String(data.recording?.status ?? "");
      setRecording({ decided: data.recordingDecided === true, allowed: data.recordingAllowed === true, status, basis: String(data.recording?.basis ?? "") });
      followRoom(data.room);
      return ACTIVE.has(status) ? RECORDING_HEARTBEAT_MS : HEARTBEAT_MS;
    } catch {
      setHostProblem("unstable");
      return RETRY_MS;
    }
  }, [hostUrl, followRoom]);

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
      } else if (event.type === "whiteboard") {
        setMedia((state) => ({ ...state, whiteboard: event.state }));
      }
      // A session id changes nothing on screen; it is reported only when the join answer asked.
      if (joined.role === "tutor") {
        const body = hostReportFor(event);
        if (body && (body.type !== "session" || joined.sessionReports)) void report(body);
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
        // The lesson was cancelled, or this link was revoked or replaced: leave the room.
        const ended = entryEndedBy({ status: response.status, code: data?.code }, { role: "student", hasKey: Boolean(joinKey) });
        if (ended) {
          stopped = true;
          setReason(ended);
          setPhase("blocked");
          return;
        }
        if (response.ok && data?.ok) {
          setStatusProblem(false);
          setRecording({ decided: data.recordingDecided === true, allowed: data.recordingAllowed === true, status: String(data.recording?.status ?? ""), basis: String(data.recording?.basis ?? "") });
          followRoom(data.room);
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
  }, [isStudent, statusUrl, joinKey, followRoom]);

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
  // Moving to the room the server names is this same request (see moveRoom above).
  useEffect(() => {
    moveRoom.current = () => { void reconnect(); };
  });

  async function leave() {
    // Leaving the media room reports "Closed" through the adapter; without one, say it directly.
    if (adapter.current) await adapter.current.leave();
    else if (joined?.role === "tutor") await report({ type: "connection", state: "Closed" });
    session.current = null;
    setRejoinProblem("");
    setPhase("left");
  }

  const when = (iso: string) => new Intl.DateTimeFormat(intlLocaleOf(locale), {
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
        <div className="classroom-langs" role="group" aria-label="Language / 語言 / 语言">{CLASSROOM_LOCALES.filter(item => item !== locale).map(item => <button key={item} type="button" className="classroom-lang" lang={htmlLangOf(item)} onClick={() => setLocale(item)}>{LOCALE_NAMES[item]}</button>)}</div>
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
