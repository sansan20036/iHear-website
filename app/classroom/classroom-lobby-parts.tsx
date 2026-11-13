"use client";

import { useEffect, useId, useRef, useState, type MutableRefObject, type ReactNode } from "react";

import { classroomDeviceOf, type ClassroomDevice } from "../../lib/classroom-capabilities";
import { browserReadiness, deviceProblemOf, levelOf, type DeviceCheckProblem } from "../../lib/classroom-lobby";
import { CLASSROOM_LOCALES, htmlLangOf, LOCALE_NAMES, type ClassroomLocale } from "../../lib/classroom-locale";
import { CLASSROOM_RELEASE } from "../../lib/classroom-release";

// The languages' short names, shown on phones where the whole names do not fit beside the logo.
const SHORT_NAMES: Record<ClassroomLocale, string> = { en: "EN", zhHant: "繁", zhHans: "简" };
import type { LobbyCopy } from "./classroom-lobby-copy";

// The Classroom 2.1 lobby's shared parts (2026-11-13): the top bar of /classroom, the pre-class
// screen and the device check page, and the device check itself.

export type LobbyIconName = "camera" | "microphone" | "speaker" | "browser" | "link" | "tutor" | "check" | "clock" | "arrow" | "shield" | "help" | "enter";

const ICONS: Record<LobbyIconName, ReactNode> = {
  camera: <><rect x="3" y="6.5" width="12" height="11" rx="2.5" /><path d="M15 10.5l5-3v9l-5-3z" /></>,
  microphone: <><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21M8.5 21h7" /></>,
  speaker: <><path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" /><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11" /></>,
  browser: <><rect x="3" y="4.5" width="18" height="15" rx="2.5" /><path d="M3 9h18M6.5 6.8h.01M9 6.8h.01" /></>,
  link: <><path d="M10.2 13.8a4 4 0 0 0 5.6 0l3-3a4 4 0 0 0-5.6-5.6l-1.4 1.4" /><path d="M13.8 10.2a4 4 0 0 0-5.6 0l-3 3a4 4 0 0 0 5.6 5.6l1.4-1.4" /></>,
  tutor: <><circle cx="12" cy="8" r="3.6" /><path d="M4.8 19.5c1.3-3.5 4-5.2 7.2-5.2s5.9 1.7 7.2 5.2" /></>,
  check: <path d="M5 12.5l4.2 4.2L19 7" />,
  clock: <><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></>,
  arrow: <path d="M5 12h13M13 6.5l5.5 5.5-5.5 5.5" />,
  shield: <><path d="M12 3.5l7 2.5v5.5c0 4.4-3 7.6-7 9-4-1.4-7-4.6-7-9V6z" /><path d="M9 12l2.2 2.2L15.5 10" /></>,
  help: <><circle cx="12" cy="12" r="8.5" /><path d="M9.8 9.5a2.3 2.3 0 1 1 3.3 2.1c-.7.4-1.1.9-1.1 1.7v.4M12 16.6h.01" /></>,
  enter: <><path d="M10 4H17a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-7" /><path d="M4 12h10M10.5 8.5 14 12l-3.5 3.5" /></>,
};

export function LobbyIcon({ name }: { name: LobbyIconName }) {
  return (
    <svg className="lobby-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {ICONS[name]}
    </svg>
  );
}

// The top bar: iHear's logo (back to the site), the classroom's name, and the three languages with
// the one in use pressed. Anything else (a way back to the entrance) comes in as children. It carries
// the release's version (data-classroom-release), and nothing else about the page or the person.
export function LobbyNav({ locale, onLocale, text, children }: { locale: ClassroomLocale; onLocale: (locale: ClassroomLocale) => void; text: LobbyCopy; children?: ReactNode }) {
  return (
    <header className="lobby-nav" data-classroom-release={CLASSROOM_RELEASE.version}>
      <a className="lobby-logo" href="/">
        <img src="/assets/logo.png" alt={text.home} width={109} height={40} />
      </a>
      <span className="lobby-brand">
        <span className="lobby-brand-name">{text.brand}</span>
        <span className="lobby-brand-tag">{text.tag}</span>
      </span>
      <div className="lobby-nav-end">
        {children}
        <div className="lobby-langs" role="group" aria-label={text.language}>
          {CLASSROOM_LOCALES.map((item) => (
            <button key={item} type="button" className="lobby-lang" lang={htmlLangOf(item)} aria-pressed={item === locale} aria-label={LOCALE_NAMES[item]} onClick={() => onLocale(item)}>
              <span className="lobby-lang-full" aria-hidden="true">{LOCALE_NAMES[item]}</span>
              <span className="lobby-lang-short" aria-hidden="true">{SHORT_NAMES[item]}</span>
            </button>
          ))}
        </div>
      </div>
    </header>
  );
}

type Check = { state: "idle" | "checking" | "ok" | "problem"; problem?: DeviceCheckProblem; live?: boolean; label?: string };
type Speaker = "idle" | "playing" | "asking" | "ok" | "problem";

type AudioContextClass = typeof AudioContext;
const audioContextClass = (): AudioContextClass | null =>
  (typeof window === "undefined" ? null : window.AudioContext ?? (window as unknown as { webkitAudioContext?: AudioContextClass }).webkitAudioContext ?? null);

// The device check: the camera's picture, the microphone's level and a test sound, each started by
// its own press and only on this device (the browser asks for permission then, never before).
// Nothing is recorded or sent. Everything it opened is closed when the check is left, and before
// the classroom is entered (release), so the video service can have the camera and microphone.
export function DeviceCheck({ text, releaseRef, headingLevel = 2 }: { text: LobbyCopy; releaseRef?: MutableRefObject<(() => void) | null>; headingLevel?: 1 | 2 }) {
  const id = useId();
  const [camera, setCamera] = useState<Check>({ state: "idle" });
  const [microphone, setMicrophone] = useState<Check>({ state: "idle" });
  const [level, setLevel] = useState(0);
  const [speaker, setSpeaker] = useState<Speaker>("idle");
  const [browser, setBrowser] = useState<{ ready: boolean } | null>(null);
  const [device, setDevice] = useState<ClassroomDevice | null>(null);
  const video = useRef<HTMLVideoElement | null>(null);
  const cameraStream = useRef<MediaStream | null>(null);
  const microphoneStream = useRef<MediaStream | null>(null);
  const meterContext = useRef<AudioContext | null>(null);
  const toneContext = useRef<AudioContext | null>(null);
  const frame = useRef<number | null>(null);
  const asked = useRef<ReturnType<typeof setTimeout> | null>(null);
  const alive = useRef(true);

  const stopCamera = (keep = true) => {
    cameraStream.current?.getTracks().forEach((track) => track.stop());
    cameraStream.current = null;
    if (video.current) video.current.srcObject = null;
    setCamera((state) => (keep && state.state === "ok" ? { ...state, live: false } : { state: "idle" }));
  };
  const stopMicrophone = (keep = true) => {
    if (frame.current != null) cancelAnimationFrame(frame.current);
    frame.current = null;
    microphoneStream.current?.getTracks().forEach((track) => track.stop());
    microphoneStream.current = null;
    void meterContext.current?.close().catch(() => undefined);
    meterContext.current = null;
    setLevel(0);
    setMicrophone((state) => (keep && state.state === "ok" ? { ...state, live: false } : { state: "idle" }));
  };
  const release = () => {
    stopCamera(false);
    stopMicrophone(false);
    if (asked.current) clearTimeout(asked.current);
    void toneContext.current?.close().catch(() => undefined);
    toneContext.current = null;
  };
  const releaseNow = useRef(release);
  releaseNow.current = release;
  useEffect(() => {
    if (releaseRef) releaseRef.current = () => releaseNow.current();
  });

  useEffect(() => {
    alive.current = true;
    setBrowser(browserReadiness({
      isSecureContext: window.isSecureContext, mediaDevices: navigator.mediaDevices,
      RTCPeerConnection: (window as unknown as { RTCPeerConnection?: unknown }).RTCPeerConnection,
      WebAssembly: (globalThis as unknown as { WebAssembly?: unknown }).WebAssembly,
    }));
    setDevice(classroomDeviceOf(navigator.userAgent, navigator.maxTouchPoints));
    return () => {
      alive.current = false;
      releaseNow.current();
    };
  }, []);

  async function startCamera() {
    if (!navigator.mediaDevices?.getUserMedia) {
      setCamera({ state: "problem", problem: "unsupported" });
      return;
    }
    setCamera({ state: "checking" });
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 640 }, height: { ideal: 360 } }, audio: false });
      if (!alive.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      cameraStream.current = stream;
      if (video.current) {
        video.current.srcObject = stream;
        await video.current.play().catch(() => undefined);
      }
      setCamera({ state: "ok", live: true, label: stream.getVideoTracks()[0]?.label || "" });
    } catch (error) {
      if (alive.current) setCamera({ state: "problem", problem: deviceProblemOf(error) });
    }
  }

  async function startMicrophone() {
    const Context = audioContextClass();
    if (!navigator.mediaDevices?.getUserMedia || !Context) {
      setMicrophone({ state: "problem", problem: "unsupported" });
      return;
    }
    setMicrophone({ state: "checking" });
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false });
      if (!alive.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      microphoneStream.current = stream;
      const context = new Context();
      meterContext.current = context;
      await context.resume().catch(() => undefined);
      const analyser = context.createAnalyser();
      analyser.fftSize = 1024;
      context.createMediaStreamSource(stream).connect(analyser);
      const samples = new Uint8Array(analyser.fftSize);
      let shown = 0;
      const read = (time: number) => {
        analyser.getByteTimeDomainData(samples);
        const value = levelOf(samples);
        // About ten updates a second are enough for the bar.
        if (time - shown > 90) {
          shown = time;
          setLevel(value);
          if (value > 0.06) setMicrophone((state) => (state.state === "ok" ? state : { state: "ok", live: true, label: stream.getAudioTracks()[0]?.label || "" }));
        }
        frame.current = requestAnimationFrame(read);
      };
      frame.current = requestAnimationFrame(read);
      setMicrophone({ state: "checking", live: true, label: stream.getAudioTracks()[0]?.label || "" });
    } catch (error) {
      if (alive.current) setMicrophone({ state: "problem", problem: deviceProblemOf(error) });
    }
  }

  // Two short tones, quiet enough for headphones.
  async function playTone() {
    const Context = audioContextClass();
    if (!Context) {
      setSpeaker("problem");
      return;
    }
    try {
      const context = toneContext.current ?? new Context();
      toneContext.current = context;
      await context.resume().catch(() => undefined);
      const start = context.currentTime + 0.05;
      for (const [frequency, at] of [[660, 0], [880, 0.34]] as const) {
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        oscillator.type = "sine";
        oscillator.frequency.value = frequency;
        gain.gain.setValueAtTime(0.0001, start + at);
        gain.gain.exponentialRampToValueAtTime(0.22, start + at + 0.03);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + at + 0.5);
        oscillator.connect(gain).connect(context.destination);
        oscillator.start(start + at);
        oscillator.stop(start + at + 0.55);
      }
      setSpeaker("playing");
      if (asked.current) clearTimeout(asked.current);
      asked.current = setTimeout(() => { if (alive.current) setSpeaker("asking"); }, 1000);
    } catch {
      setSpeaker("problem");
    }
  }

  const statusOf = (state: Check["state"]) => text.status[state];
  const problemText = (check: Check, word: string) => (check.problem ? text.problem[check.problem](word) : "");
  const Heading = headingLevel === 1 ? "h1" : "h2";
  const speakerState = speaker === "ok" ? "ok" : speaker === "problem" ? "problem" : speaker === "idle" ? "idle" : "checking";
  const speakerStatus = speaker === "asking" ? text.status.asking : speaker === "playing" ? text.status.checking : text.status[speakerState as Check["state"]];

  return (
    <section className="lobby-card device-check" aria-labelledby={`${id}-title`} data-device-check="">
      <div className="lobby-card-head">
        <Heading id={`${id}-title`}>{text.checkTitle}</Heading>
        <span className="lobby-tag">{text.optional}</span>
      </div>
      <p className="lobby-muted lobby-with-icon"><LobbyIcon name="shield" />{text.checkIntro}</p>
      <div className="device-preview" data-live={camera.live ? "on" : "off"}>
        <video ref={video} muted playsInline autoPlay aria-label={text.preview} hidden={!camera.live} />
        {!camera.live && <p className="device-preview-idle"><LobbyIcon name="camera" /><span>{text.previewIdle}</span></p>}
      </div>
      <ul className="device-rows">
        <li className="device-row" data-device="camera" data-state={camera.state}>
          <span className="device-row-icon"><LobbyIcon name="camera" /></span>
          <div className="device-row-main">
            <p className="device-row-name">{text.camera}<span className={`lobby-status is-${camera.state}`}>{statusOf(camera.state)}</span></p>
            <p className="device-row-detail" aria-live="polite">
              {camera.state === "ok" ? `${text.cameraOk}${camera.label ? ` ${camera.label}` : ""}` : problemText(camera, text.deviceWord.camera)}
            </p>
          </div>
          {camera.live
            ? <button type="button" className="lobby-button is-quiet" onClick={() => stopCamera()}>{text.stopCamera}</button>
            : <button type="button" className="lobby-button" disabled={camera.state === "checking"} onClick={() => void startCamera()}>{camera.state === "problem" ? text.retry : text.testCamera}</button>}
        </li>
        <li className="device-row" data-device="microphone" data-state={microphone.state}>
          <span className="device-row-icon"><LobbyIcon name="microphone" /></span>
          <div className="device-row-main">
            <p className="device-row-name">{text.microphone}<span className={`lobby-status is-${microphone.state}`}>{statusOf(microphone.state)}</span></p>
            {microphone.live && (
              <div className="device-meter" role="meter" aria-label={text.micLevel} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(level * 100)}>
                <span style={{ transform: `scaleX(${Math.max(0.02, level)})` }} />
              </div>
            )}
            <p className="device-row-detail" aria-live="polite">
              {microphone.state === "ok" ? text.micOk : microphone.live ? text.micPrompt : problemText(microphone, text.deviceWord.microphone)}
            </p>
          </div>
          {microphone.live
            ? <button type="button" className="lobby-button is-quiet" onClick={() => stopMicrophone()}>{text.stopMicrophone}</button>
            : <button type="button" className="lobby-button" disabled={microphone.state === "checking"} onClick={() => void startMicrophone()}>{microphone.state === "problem" ? text.retry : text.testMicrophone}</button>}
        </li>
        <li className="device-row" data-device="speaker" data-state={speakerState}>
          <span className="device-row-icon"><LobbyIcon name="speaker" /></span>
          <div className="device-row-main">
            <p className="device-row-name">{text.speaker}<span className={`lobby-status is-${speakerState}`}>{speakerStatus}</span></p>
            <div className="device-row-detail" aria-live="polite">
              {speaker === "asking" && (
                <div className="device-ask">
                  <span>{text.speakerAsk}</span>
                  <button type="button" className="lobby-button is-small" onClick={() => setSpeaker("ok")}>{text.heard}</button>
                  <button type="button" className="lobby-button is-small is-quiet" onClick={() => setSpeaker("problem")}>{text.notHeard}</button>
                </div>
              )}
              {speaker === "ok" && <p>{text.speakerOk}</p>}
              {speaker === "problem" && <p>{text.speakerHelp}</p>}
            </div>
          </div>
          <button type="button" className="lobby-button" disabled={speaker === "playing"} onClick={() => void playTone()}>{text.testSpeaker}</button>
        </li>
        <li className="device-row" data-device="browser" data-state={browser ? (browser.ready ? "ok" : "problem") : "idle"}>
          <span className="device-row-icon"><LobbyIcon name="browser" /></span>
          <div className="device-row-main">
            <p className="device-row-name">{text.browser}{browser && <span className={`lobby-status is-${browser.ready ? "ok" : "problem"}`}>{browser.ready ? text.status.ok : text.status.problem}</span>}</p>
            <p className="device-row-detail">
              {browser ? (browser.ready ? text.browserOk : text.browserWarn) : ""}
              {device && <span className="device-kind">{text.thisDevice(text.device[device])}</span>}
            </p>
          </div>
        </li>
      </ul>
    </section>
  );
}
