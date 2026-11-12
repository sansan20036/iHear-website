"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode, type Ref } from "react";
import { createPortal } from "react-dom";

import { appendChat, CHAT_MAX_LENGTH, chatTextOf, type ChatLine, type RaisedHand } from "../../../lib/classroom-chat";
import {
  createMediaAdapter, hostReportFor, MAX_REMOTE_VIDEOS, MediaAdapterUnavailableError, SYNTHETIC_SCENARIOS, SyntheticMediaAdapter,
  type ClassroomMediaAdapter, type ConnectionState, type DeviceKind, type DeviceProblem, type DeviceState, type MediaEvent, type MediaSystemCheck, type RoomPerson, type SyntheticScenario,
} from "../../../lib/classroom-media";
import { classroomDeviceOf, deviceLimits, type CapabilityName, type ClassroomDevice } from "../../../lib/classroom-capabilities";
import { entryEndedBy, rejoinRoom, requestJoin, type JoinedSession } from "../../../lib/classroom-join-client";
import { browserClassroomLocale, CLASSROOM_LOCALES, htmlLangOf, intlLocaleOf, LOCALE_NAMES, type ClassroomLocale } from "../../../lib/classroom-locale";
import { HAND_NOTICE_MS, initialsOf, newHands, orderPeople, personLabel, spotlightOf, stageModeOf } from "../../../lib/classroom-room";
import { roomCopy as copy, vendorCopy } from "./classroom-copy";
import { RoomIcon, type RoomIconName } from "./classroom-icons";

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
//
// Classroom 2.0 (2026-11-12): the same room laid out around the lesson's content. A top bar with the
// lesson and its states in words; the main stage shows what is being taught (the shared screen or
// the whiteboard, else the people); the people's tiles sit in a column beside it (a row on phones and
// tablets); chat, the participants and the lesson's details share one side panel; one toolbar holds
// the controls in groups. The vendor's parts are placed once when the room opens and never moved:
// a change of layout is styling only (see classroom.css), which still has to be confirmed with a
// real Zoom session.

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
  remote: { present: boolean; camera: boolean; microphone: boolean; seen: boolean; others?: number; waiting?: number };
  share: "none" | "sending" | "receiving";
  whiteboard: "none" | "presenting" | "viewing";
};
// The one side panel: chat, the participants, or the lesson's details (Classroom 2.0).
type Panel = "none" | "chat" | "people" | "info";

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

// The tiles the adapter drew, by person (Classroom 2.0); the page writes into them.
function sameTiles(a: ReadonlyMap<string, HTMLElement>, b: ReadonlyMap<string, HTMLElement>) {
  if (a.size !== b.size) return false;
  for (const [id, cell] of a) if (b.get(id) !== cell) return false;
  return true;
}

// Arrow keys, Home and End move between the enabled buttons of a toolbar or a menu.
function moveFocus(event: ReactKeyboardEvent<HTMLElement>, items: HTMLElement[], keys: { back: string; next: string }) {
  const index = items.indexOf(document.activeElement as HTMLElement);
  if (index < 0) return;
  const last = items.length - 1;
  const to = event.key === "Home" ? 0 : event.key === "End" ? last : event.key === keys.next ? (index === last ? 0 : index + 1) : event.key === keys.back ? (index === 0 ? last : index - 1) : -1;
  if (to < 0) return;
  event.preventDefault();
  items[to]?.focus();
}

// P3-Multi (2026-11-09): a block's page (app/classroom/b) shows this same room for the Lobby or the
// room the server puts the person in, and switches by showing it again for the next one. It gives
// the personal key itself (joinKey), enters at once once the person has entered before
// (autoEnter), and hears when this room's entry ended so it can ask where to go now. Without these
// the page is exactly the one-to-one lesson's.
// After a move the camera and microphone start off in the new room. The page never turns them on
// by itself (the browser may have to ask again): it offers one press to turn on what was on before
// (restoreDevices), and tells the block's page what this person turned on or off (onDevicesChange).
type BlockRoomProps = {
  joinKey?: string | null; autoEnter?: boolean; roomLabel?: string | null; signInPath?: string;
  onEntered?: () => void; onEntryEnded?: (code: string) => void;
  restoreDevices?: { camera: boolean; microphone: boolean } | null;
  onDevicesChange?: (devices: { camera: boolean; microphone: boolean }) => void;
};

export default function ClassroomEntry({ lessonId, synthetic, joinKey: givenKey, autoEnter = false, roomLabel = null, signInPath, onEntered, onEntryEnded, restoreDevices = null, onDevicesChange }: { lessonId: string; synthetic: boolean } & BlockRoomProps) {
  const devicesChanged = useRef(onDevicesChange);
  devicesChanged.current = onDevicesChange;
  const [restoreOffered, setRestoreOffered] = useState(true);
  const [locale, setLocale] = useState<Locale>("zhHant");
  const [joinKey, setJoinKey] = useState<string | null>(givenKey ?? null);
  const blockMode = givenKey !== undefined;
  const onEnded = useRef(onEntryEnded);
  onEnded.current = onEntryEnded;
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
  // In-class chat and raised hands (2026-11-12): on this page only and never saved (the owner's
  // decision); leaving the room clears them. The unread count shows on the chat button while the
  // chat is closed: a sign to see, not a sound.
  const [features, setFeatures] = useState({ chat: false, raiseHand: false });
  const [chat, setChat] = useState<readonly ChatLine[]>([]);
  const [unread, setUnread] = useState(0);
  const [draft, setDraft] = useState("");
  const [chatProblem, setChatProblem] = useState(false);
  const [hands, setHands] = useState<RaisedHand[]>([]);
  const [handProblem, setHandProblem] = useState(false);
  const chatLog = useRef<HTMLOListElement | null>(null);
  // Classroom 2.0 (2026-11-12): who is in the room and who is talking; the open side panel (chat
  // among them); focus mode; the "More" menu; the person enlarged on this page only; the raised
  // hands being told on top of the stage; the tiles the adapter drew; full screen.
  const [panel, setPanel] = useState<Panel>("none");
  const chatOpen = panel === "chat";
  const chatOpenNow = useRef(false);
  chatOpenNow.current = chatOpen;
  const [people, setPeople] = useState<RoomPerson[]>([]);
  const [speaking, setSpeaking] = useState<string[]>([]);
  const [focus, setFocus] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [spotlight, setSpotlight] = useState<string | null>(null);
  const [handNotices, setHandNotices] = useState<RaisedHand[]>([]);
  const handsBefore = useRef<RaisedHand[]>([]);
  const [tiles, setTiles] = useState<ReadonlyMap<string, HTMLElement>>(() => new Map());
  const [hiddenInStrip, setHiddenInStrip] = useState(0);
  const [fullscreen, setFullscreen] = useState(false);
  const [canFullscreen, setCanFullscreen] = useState(false);
  const videosHost = useRef<HTMLDivElement | null>(null);
  const strip = useRef<HTMLDivElement | null>(null);
  const moreButton = useRef<HTMLButtonElement | null>(null);
  const menu = useRef<HTMLDivElement | null>(null);
  const panelBox = useRef<HTMLElement | null>(null);
  const panelOpener = useRef<HTMLElement | null>(null);
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
  const deviceRef = useRef<ClassroomDevice>("desktop");
  deviceRef.current = device;
  const adapter = useRef<ClassroomMediaAdapter | null>(null);
  const connection = useRef<ConnectionState>("idle");
  const text = copy[locale];
  const hostUrl = `/api/classroom/${encodeURIComponent(lessonId)}/host-events`;
  const statusUrl = `/api/classroom/${encodeURIComponent(lessonId)}/status`;
  const signInUrl = `/api/auth/signin?callbackUrl=${encodeURIComponent(signInPath ?? `/classroom/${lessonId}`)}`;

  useEffect(() => {
    setLocale(browserClassroomLocale());
    setDevice(classroomDeviceOf(navigator.userAgent, navigator.maxTouchPoints));
    // In a block the block's page has taken the key from the address already.
    if (blockMode) return;
    const key = takeJoinKey();
    if (key) setJoinKey(key);
    // A new link opened in a tab that already shows this room changes only the part after #,
    // which reloads nothing; its key is taken the same way.
    const onHash = () => {
      const next = takeJoinKey();
      if (next) setJoinKey(next);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, [blockMode]);
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
      onEntered?.();
      return;
    }
    setReason(answer.code);
    setPhase("blocked");
    onEnded.current?.(answer.code);
  }
  // In a block, after the person entered once, the next room is entered without another press.
  const enterNow = useRef(enter);
  enterNow.current = enter;
  useEffect(() => {
    if (autoEnter) void enterNow.current();
  }, [autoEnter]);

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
        onEnded.current?.(ended);
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
      // A phone or tablet draws at most 9 videos, a computer 25 (P3-Multi rooms hold up to 10).
      current = createMediaAdapter(joined.provider, { maxVideos: deviceRef.current === "desktop" ? MAX_REMOTE_VIDEOS.desktop : MAX_REMOTE_VIDEOS.mobile });
    } catch (error) {
      if (!(error instanceof MediaAdapterUnavailableError)) throw error;
      setMedia((state) => ({ ...state, available: false }));
      return;
    }
    adapter.current = current;
    setSimulator(current instanceof SyntheticMediaAdapter ? current : null);
    setFeatures({ chat: current.capabilities.chat, raiseHand: current.capabilities.raiseHand });
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
        setMedia((state) => ({ ...state, remote: { present: event.present, camera: event.camera, microphone: event.microphone, seen: state.remote.seen || event.present, others: event.others, waiting: event.videosWaiting } }));
      } else if (event.type === "share") {
        setMedia((state) => ({ ...state, share: event.state }));
      } else if (event.type === "whiteboard") {
        setMedia((state) => ({ ...state, whiteboard: event.state }));
      } else if (event.type === "chat") {
        setChat((lines) => appendChat(lines, event.line));
        if (event.line.from !== "self" && !chatOpenNow.current) setUnread((count) => count + 1);
      } else if (event.type === "hands") {
        setHands(event.raised);
      } else if (event.type === "people") {
        setPeople(event.people);
      } else if (event.type === "speaking") {
        setSpeaking(event.ids);
      }
      // A session id changes nothing on screen; it is reported only when the join answer asked.
      if (joined.role === "tutor") {
        const body = hostReportFor(event);
        if (body && (body.type !== "session" || joined.sessionReports)) void report(body);
      }
    });
    // Placed once: the stage (shared screen, whiteboard, or the vendor's classroom) and the column
    // of tiles. Nothing the vendor draws is moved after this.
    if (vendorStage.current && current.mount) current.mount(vendorStage.current, videosHost.current ?? undefined);
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
      // Chat is not kept: leaving the room (or moving to another) clears it.
      setFeatures({ chat: false, raiseHand: false });
      setChat([]);
      setPanel("none");
      setUnread(0);
      setDraft("");
      setChatProblem(false);
      setHands([]);
      setHandProblem(false);
      setPeople([]);
      setSpeaking([]);
      setSpotlight(null);
      setHandNotices([]);
      handsBefore.current = [];
    };
  }, [phase, joined, report]);

  // The newest line stays in view.
  useEffect(() => {
    const log = chatLog.current;
    if (log) log.scrollTop = log.scrollHeight;
  }, [chat, chatOpen]);

  // Opening the chat clears the unread count, however it was opened.
  useEffect(() => {
    if (chatOpen) setUnread(0);
  }, [chatOpen]);

  // The tiles the adapter drew for each person: the page writes names and states into them.
  useEffect(() => {
    const next = new Map<string, HTMLElement>();
    videosHost.current?.querySelectorAll<HTMLElement>("[data-person]").forEach((cell) => {
      const id = cell.getAttribute("data-person");
      if (id) next.set(id, cell);
    });
    setTiles((current) => (sameTiles(current, next) ? current : next));
  }, [people, phase]);

  // The person enlarged on this page stays only while they are here; the ring follows who talks.
  useEffect(() => {
    setSpotlight((current) => spotlightOf(current, people));
  }, [people]);
  useEffect(() => {
    for (const [id, cell] of tiles) {
      cell.toggleAttribute("data-spotlight", id === spotlight);
      cell.toggleAttribute("data-speaking", speaking.includes(id));
      cell.toggleAttribute("data-hand", hands.some((hand) => hand.id === id));
    }
  }, [tiles, spotlight, speaking, hands]);

  // A newly raised hand is told on top of the stage for a few seconds (the tutor's page); then the
  // participants button, the top bar and the list keep it until the hand is lowered.
  useEffect(() => {
    const fresh = isTutor ? newHands(handsBefore.current, hands) : [];
    handsBefore.current = hands;
    setHandNotices((current) => {
      const still = current.filter((notice) => hands.some((hand) => hand.id === notice.id));
      return fresh.length === 0 && still.length === current.length ? current : [...still, ...fresh];
    });
  }, [hands, isTutor]);
  useEffect(() => {
    if (handNotices.length === 0) return;
    const timer = setTimeout(() => setHandNotices([]), HAND_NOTICE_MS);
    return () => clearTimeout(timer);
  }, [handNotices]);

  // How many tiles are past the end of a row that scrolls sideways (phones, tablets): "N more".
  useEffect(() => {
    const row = strip.current;
    if (!row || phase !== "joined") return;
    const count = () => {
      let hidden = 0;
      if (row.scrollWidth > row.clientWidth + 1) {
        const edge = row.getBoundingClientRect().right;
        row.querySelectorAll<HTMLElement>("[data-person]").forEach((tile) => {
          const box = tile.getBoundingClientRect();
          if (box.width > 0 && (box.left + box.right) / 2 > edge) hidden += 1;
        });
      }
      setHiddenInStrip(hidden);
    };
    count();
    row.addEventListener("scroll", count, { passive: true });
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(count);
    observer?.observe(row);
    return () => {
      row.removeEventListener("scroll", count);
      observer?.disconnect();
    };
  }, [phase, people, panel, focus, tiles]);

  // Full screen where the browser allows it (not on iPhones), for the whole room.
  useEffect(() => {
    setCanFullscreen(document.fullscreenEnabled === true);
    const onChange = () => setFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  // The "More" menu: its first item takes the focus; a press elsewhere closes it.
  useEffect(() => {
    if (!menuOpen) return;
    menu.current?.querySelector<HTMLElement>("[role^='menuitem']")?.focus();
    const onDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!menu.current?.contains(target) && !moreButton.current?.contains(target)) setMenuOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      // A choice closed the menu: the focus goes back to its button, unless the choice moved it on.
      requestAnimationFrame(() => {
        if (!document.activeElement || document.activeElement === document.body) moreButton.current?.focus();
      });
    };
  }, [menuOpen]);

  // A panel that opens takes the focus to its selected tab, so a keyboard or screen reader lands in it.
  useEffect(() => {
    if (panel !== "none") panelBox.current?.querySelector<HTMLElement>("[role='tab'][aria-selected='true']")?.focus({ preventScroll: true });
  }, [panel]);

  // Escape closes the menu, then a panel the focus is in, then leaves focus mode.
  useEffect(() => {
    if (phase !== "joined") return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (menuOpen) {
        setMenuOpen(false);
        moreButton.current?.focus();
      } else if (panel !== "none" && panelBox.current?.contains(document.activeElement)) {
        closePanel();
      } else if (focus) {
        setFocus(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

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
          onEnded.current?.(ended);
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
    const on = media.devices[kind] !== "on";
    // What this person wants on, from their own presses only (P3-Multi: offered again after a move).
    devicesChanged.current?.({ camera: kind === "camera" ? on : media.devices.camera === "on", microphone: kind === "microphone" ? on : media.devices.microphone === "on" });
    await current.setDevice(kind, on);
  }

  // After a move: one press turns on again what was on in the previous room (never by itself).
  async function restoreNow() {
    const current = adapter.current;
    setRestoreOffered(false);
    if (!current || !restoreDevices) return;
    for (const kind of ["camera", "microphone"] as DeviceKind[]) {
      if (restoreDevices[kind] && media.devices[kind] !== "on") await current.setDevice(kind, true).catch(() => undefined);
    }
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

  // The side panel (Classroom 2.0): a toolbar button opens its panel or closes it again; closing
  // gives the focus back to the button that opened it.
  function togglePanel(next: Exclude<Panel, "none">, opener?: HTMLElement | null) {
    setMenuOpen(false);
    if (opener) panelOpener.current = opener;
    if (panel === next) closePanel();
    else setPanel(next);
  }

  function closePanel() {
    setPanel("none");
    const opener = panelOpener.current;
    if (opener?.isConnected) requestAnimationFrame(() => opener.focus());
  }

  function toggleFocus() {
    setMenuOpen(false);
    const next = !focus;
    setFocus(next);
    if (next) setPanel("none");
  }

  async function toggleFullscreen() {
    setMenuOpen(false);
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen();
    } catch {
      // The browser refused (or has no full screen here): nothing changes.
    }
  }

  // In-class chat and raised hands (2026-11-12). A line that did not go through stays in the box to
  // try again.
  async function sendChat(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const current = adapter.current;
    if (!current?.sendChat || !chatTextOf(draft)) return;
    setChatProblem(false);
    const sent = await current.sendChat(draft).catch(() => false);
    if (sent) setDraft("");
    else setChatProblem(true);
  }

  async function toggleHand() {
    const current = adapter.current;
    if (!current?.setHand) return;
    setHandProblem(false);
    const done = await current.setHand(!hands.some((hand) => hand.self)).catch(() => false);
    if (!done) setHandProblem(true);
  }

  async function lowerHand(id: string) {
    const current = adapter.current;
    if (!current?.lowerHand) return;
    setHandProblem(false);
    const done = await current.lowerHand(id).catch(() => false);
    if (!done) setHandProblem(true);
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
    setMenuOpen(false);
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
  const connected = media.connection === "connected";
  const handUp = hands.some((hand) => hand.self);
  const othersHands = hands.filter((hand) => !hand.self);
  // A chat line's time, Taipei like the lesson's.
  const clock = (at: number) => until(new Date(at).toISOString());
  const languages = (
    <div className="classroom-langs" role="group" aria-label="Language / 語言 / 语言">{CLASSROOM_LOCALES.filter(item => item !== locale).map(item => <button key={item} type="button" className="classroom-lang" lang={htmlLangOf(item)} onClick={() => setLocale(item)}>{LOCALE_NAMES[item]}</button>)}</div>
  );
  // A room inside a block sits in the block's own page, which has the page's <main>.
  const Shell = blockMode ? "div" : "main";

  if (phase !== "joined" || !joined) {
    return (
      <Shell className="classroom-room">
        <header className="classroom-room-head">
          <h1>{text.title}</h1>
          {languages}
        </header>
        {synthetic && <p className="classroom-room-note" role="note">{text.synthetic}</p>}
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
      </Shell>
    );
  }

  const v = vendorCopy[locale];
  const provider = joined.provider;
  const zoom = provider === "zoom-video-sdk";
  const lcic = provider === "tencent-lcic";
  const mode = stageModeOf(provider, media.share, media.whiteboard);
  const limits = VENDOR_PROVIDERS.has(provider) ? deviceLimits(provider, device) : [];
  const ordered = orderPeople(people, hands);
  const words = { tutor: text.tutor, student: text.student };
  const labelOf = (person: RoomPerson) => personLabel(person, words);
  const raised = (id: string) => hands.some((hand) => hand.id === id);
  const shareTools = isTutor && !!adapter.current?.setScreenShare && (zoom || !!simulator);
  const boardTools = isTutor && !!adapter.current?.setWhiteboard && (zoom || !!simulator);
  const canExport = media.whiteboard === "presenting" && !!adapter.current?.exportWhiteboard;
  const stageLabel = mode === "share" ? (media.share === "sending" ? text.stageLabel.ownShare : text.stageLabel.share) : text.stageLabel[mode];
  const roomName = roomLabel === "Lobby" ? (locale === "en" ? "Lobby" : "主會議室") : roomLabel;
  const headcount = blockMode && media.remote.others != null ? media.remote.others + 1 : null;

  // What a tile says over the video: the role and code, a muted microphone, a raised hand, and a
  // button to enlarge it on this page. The test room, which has no picture, says the states in words.
  const decor = (person: RoomPerson): ReactNode => {
    const label = labelOf(person) + (person.self ? text.youTag : "");
    const spotlit = spotlight === person.id;
    return (
      <div className="room2-tile">
        {(person.video !== "shown" || simulator) && <span className="room2-avatar" aria-hidden="true">{initialsOf(person, words)}</span>}
        {simulator && (
          <div className="room2-tile-states">
            <p>{person.self ? cameraText : person.camera ? cameraOn : text.cameraOff}</p>
            <p className="classroom-room-tile-sub">{person.self ? micText : person.microphone ? text.micOn : text.micOff}</p>
          </div>
        )}
        {person.video === "waiting" && <p className="room2-tile-wait">{text.videoWaiting}</p>}
        <div className="room2-tile-foot">
          {/* The role in its own part: a narrow tile keeps a student's code and hides the word "Student". */}
          <span className="room2-tile-name" title={label}>
            <span className={`room2-tile-role${person.host || !person.name ? " is-key" : ""}`}>{person.host ? text.tutor : text.student}</span>
            {person.name && <span className="room2-tile-code"> {person.name}</span>}
            {person.self && <span className="room2-tile-you">{text.youTag}</span>}
          </span>
          {!person.microphone && <span className="room2-tile-icon"><RoomIcon name="microphone-off" /><span className="sr-only">{text.micOff}</span></span>}
          {raised(person.id) && <span className="room2-tile-hand"><RoomIcon name="hand" />{text.handRaised}</span>}
        </div>
        <button type="button" className="room2-spot" aria-pressed={spotlit} aria-label={spotlit ? text.spotlightOff(label) : text.spotlight(label)}
          onClick={() => setSpotlight((current) => (current === person.id ? null : person.id))}>
          <RoomIcon name={spotlit ? "shrink" : "enlarge"} />
        </button>
      </div>
    );
  };

  // A toolbar button: an icon with a short word under it; the whole name for screen readers and the
  // tooltip. `name` stays the button's name exactly as before 2.0 where tests and people rely on it.
  const toolButton = (props: { control?: string; tool?: string; icon: RoomIconName; label: ReactNode; name?: string; tip?: string; pressed?: boolean; expanded?: boolean; controls?: string; popup?: "menu"; disabled?: boolean; danger?: boolean; badge?: ReactNode; onClick: (event: ReactMouseEvent<HTMLButtonElement>) => void; refTo?: Ref<HTMLButtonElement> }) => (
    <button type="button" ref={props.refTo} className={`classroom-room-control classroom-room-iconbutton room2-tool${props.danger ? " room2-leave" : ""}`}
      data-control={props.control} data-tool={props.tool} data-tip={props.tip ?? props.name}
      aria-label={props.name} aria-pressed={props.pressed} aria-expanded={props.expanded} aria-controls={props.controls} aria-haspopup={props.popup}
      disabled={props.disabled} onClick={props.onClick}>
      <RoomIcon name={props.icon} />
      <span className="classroom-room-iconlabel">{props.label}</span>
      {props.badge}
    </button>
  );

  const facts = (
    <dl className="classroom-room-facts">
      <div><dt>{text.lesson}</dt><dd>{joined.lesson.code}</dd></div>
      {roomLabel && <div><dt>{locale === "en" ? "Room" : "教室"}</dt><dd>{roomName}</dd></div>}
      <div><dt>{text.time}</dt><dd>{when(joined.lesson.startsAt)}–{until(joined.lesson.endsAt)}</dd></div>
      <div><dt>{text.you}</dt><dd>{joined.role === "tutor" ? text.tutor : text.student} {joined.participantCode}</dd></div>
    </dl>
  );

  return (
    <Shell className="classroom-room room2" data-mode={mode} data-panel={panel} data-focus={focus ? "on" : "off"} data-role={joined.role}
      data-provider={provider} data-device={device} data-count={people.length} data-spot={spotlight ? "on" : "off"}>
      <div className="room2-shell">
        <header className="room2-top">
          <div className="room2-brand">
            <span className="room2-mark" aria-hidden="true"><RoomIcon name="camera" /></span>
            <h1>{text.title}</h1>
          </div>
          <div className="room2-lesson">
            <span className="room2-chip room2-chip-lesson">
              <span className="sr-only">{text.lesson} </span>{joined.lesson.code}
              <span className="room2-chip-time"><span aria-hidden="true"> · </span><span className="sr-only">{text.time} </span>{until(joined.lesson.startsAt)}–{until(joined.lesson.endsAt)}</span>
            </span>
            {roomLabel && <span className="room2-chip room2-chip-room" data-room-label={roomLabel}>{locale === "en" ? "Room " : "教室 "}{roomName}</span>}
          </div>
          <div className="room2-status classroom-room-statusbar">
            <span className={`classroom-room-connection ${media.available ? media.connection : "unavailable"}`} role="status">
              {media.available ? text.connection[media.connection] : text.connection.idle}
            </span>
            <span className={`classroom-room-badge ${badge}`} role="status" aria-label={`${text.recording}：${text.badge[badge]}`}>{text.badge[badge]}</span>
            {headcount != null && <span className="classroom-room-connection" role="status" data-headcount={headcount}>{locale === "en" ? `${headcount} in the room` : `教室人數：${headcount}`}</span>}
            {isTutor && othersHands.length > 0 && (
              <button type="button" className="room2-chip room2-hands-chip" data-hands-chip={othersHands.length}
                onClick={(event) => togglePanel("people", event.currentTarget)}>
                <RoomIcon name="hand" />{text.handsWaiting(othersHands.length)}
              </button>
            )}
          </div>
          {languages}
          <button type="button" className="room2-top-leave" data-control="leave-top" aria-label={text.leave} onClick={leave}>
            <RoomIcon name="leave" /><span className="room2-top-leave-text" aria-hidden="true">{text.leave}</span>
          </button>
        </header>

        <div className="room2-alerts">
          {synthetic && <p className="classroom-room-note" role="note">{text.synthetic}</p>}
          {!media.available && <p className="classroom-room-problem" role="alert">{text.notConnected}</p>}
          {blockMode && (media.remote.waiting ?? 0) > 0 && (
            <p className="classroom-room-note" role="note" data-videos-waiting={media.remote.waiting}>
              {locale === "en" ? `This device shows a limited number of videos; ${media.remote.waiting} more appear when a tile is free.` : `這台裝置能同時顯示的視訊有限，另有 ${media.remote.waiting} 位的視訊會在有空位時出現。`}
            </p>
          )}
          {blockMode && restoreDevices && restoreOffered && ((restoreDevices.camera && media.devices.camera !== "on") || (restoreDevices.microphone && media.devices.microphone !== "on")) && (
            <div className="classroom-room-note" role="note" data-restore-devices>
              <p>{locale === "en" ? "You moved to another room, so your camera and microphone start off here. Turn on what you had on before?" : "換了教室，攝影機和麥克風先保持關閉。要重新開啟你在上一間教室開著的裝置嗎？"}</p>
              <button type="button" className="classroom-room-secondary" onClick={() => void restoreNow()}>{locale === "en" ? "Turn them on" : "重新開啟"}</button>
              <button type="button" className="classroom-room-secondary" onClick={() => setRestoreOffered(false)}>{locale === "en" ? "Not now" : "不用"}</button>
            </div>
          )}
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
          {toolProblem && <p className="classroom-room-problem" role="alert">{toolProblem === "share" ? v.shareFailed : v.boardFailed}</p>}
          {handProblem && <p className="classroom-room-problem" role="alert">{text.handFailed}</p>}
          {isTutor && recording?.status === "FAILED" && <p className="classroom-room-problem" role="alert">{text.failedRecording}</p>}
          {isTutor && hostProblem === "unstable" && <p className="classroom-room-problem" role="status">{text.unstable}</p>}
          {isTutor && hostProblem === "signedOut" && <p className="classroom-room-problem" role="alert">{text.signedOut} <a href={signInUrl}>{text.signIn}</a></p>}
        </div>

        <div className="room2-main">
          <section className="room2-stage" aria-label={lcic ? text.stage : text.materials}>
            <div className="room2-stage-bar">
              <span className="room2-stage-label">{stageLabel}</span>
              <div className="room2-stage-tools">
                <button type="button" className="room2-stage-tool" aria-pressed={focus} onClick={toggleFocus}>
                  <RoomIcon name="focus" /><span>{focus ? text.focusExit : text.focus}</span>
                </button>
                {canFullscreen && (
                  <button type="button" className="room2-stage-tool" aria-pressed={fullscreen} aria-label={fullscreen ? text.fullscreenExit : text.fullscreen} onClick={() => void toggleFullscreen()}>
                    <RoomIcon name={fullscreen ? "fullscreen-exit" : "fullscreen"} />
                  </button>
                )}
              </div>
            </div>
            <div className={`classroom-vendor-stage ${provider}`} ref={vendorStage} data-provider={provider} />
            {simulator && mode === "share" && <p className="room2-simulated">{text.simulatedShare}</p>}
            {simulator && mode === "board" && <p className="room2-simulated">{text.simulatedBoard}</p>}
          </section>

          {!lcic && (
            <section className="room2-videos classroom-room-stage" aria-label={text.stage}>
              <div className="room2-strip" ref={strip}>
                <div className="room2-videos-host" ref={videosHost} />
              </div>
              {media.available && !media.remote.present && (
                <p className="room2-waiting">
                  {media.remote.seen ? text.otherLeft : text.waitingOther}
                  {simulator && <span className="classroom-room-tile-sub"> {text.syntheticOther}</span>}
                </p>
              )}
              {hiddenInStrip > 0 && (
                <button type="button" className="room2-more-chip" onClick={(event) => togglePanel("people", event.currentTarget)}>{text.moreOthers(hiddenInStrip)}</button>
              )}
              {simulator && <p className="classroom-room-stage-note">{text.noVideo}</p>}
              {[...tiles].map(([id, cell]) => {
                const person = people.find((item) => item.id === id);
                return person ? createPortal(decor(person), cell, id) : null;
              })}
            </section>
          )}

          <div className="room2-notices" role="status" aria-live="polite">
            {handNotices.map((hand) => {
              const person = people.find((item) => item.id === hand.id);
              const label = person ? labelOf(person) : hand.name ? `${text.student} ${hand.name}` : text.student;
              return (
                <div key={hand.id} className="room2-notice" data-hand-notice={hand.id}>
                  <RoomIcon name="hand" />
                  <span>{text.handNotice(label)}</span>
                  <button type="button" className="classroom-room-secondary" onClick={() => void lowerHand(hand.id)}>{text.handLower(hand.name)}</button>
                  <button type="button" className="classroom-room-secondary" onClick={() => setHandNotices([])}>{text.handNoticeDismiss}</button>
                </div>
              );
            })}
          </div>

          <aside className="room2-panel" ref={panelBox} hidden={panel === "none"} aria-label={panel === "chat" ? text.chat : panel === "people" ? text.people : text.info}>
            <div className="room2-panel-head">
              <div className="room2-tabs" role="tablist">
                {features.chat && <button type="button" role="tab" id="classroom-tab-chat" aria-selected={panel === "chat"} aria-controls="classroom-chat" onClick={() => setPanel("chat")}>{text.chat}{unread > 0 && <span className="room2-tab-count">{unread}</span>}</button>}
                {!lcic && <button type="button" role="tab" id="classroom-tab-people" aria-selected={panel === "people"} aria-controls="classroom-people" onClick={() => setPanel("people")}>{text.people}{isTutor && othersHands.length > 0 && <span className="room2-tab-count">{othersHands.length}</span>}</button>}
                <button type="button" role="tab" id="classroom-tab-info" aria-selected={panel === "info"} aria-controls="classroom-info" onClick={() => setPanel("info")}>{text.info}</button>
              </div>
              <button type="button" className="room2-panel-close" aria-label={panel === "chat" ? text.chatClose : panel === "people" ? text.peopleClose : text.infoClose} onClick={closePanel}>
                <RoomIcon name="close" />
              </button>
            </div>

            {features.chat && (
              <section id="classroom-chat" role="tabpanel" aria-labelledby="classroom-tab-chat" className="room2-tabpanel classroom-room-chat" hidden={panel !== "chat"}>
                <h2 className="sr-only">{text.chat}</h2>
                <p className="classroom-room-muted">{text.chatNotSaved}</p>
                <ol className="classroom-room-chat-lines" ref={chatLog} role="log" aria-live="polite" aria-label={text.chat}>
                  {chat.length === 0 && <li className="classroom-room-chat-empty">{text.chatEmpty}</li>}
                  {chat.map((line) => (
                    <li key={line.id} className={`from-${line.from}`}>
                      <span className="classroom-room-chat-who">{line.from === "self" ? text.chatYou : line.from === "tutor" ? text.tutor : `${text.student}${line.name ? ` ${line.name}` : ""}`}</span>
                      <span className="classroom-room-chat-time">{clock(line.at)}</span>
                      <p>{line.text}</p>
                    </li>
                  ))}
                </ol>
                <form className="classroom-room-chat-form" onSubmit={(event) => void sendChat(event)}>
                  <label className="sr-only" htmlFor="classroom-chat-input">{text.chatLabel}</label>
                  <input id="classroom-chat-input" type="text" value={draft} maxLength={CHAT_MAX_LENGTH} autoComplete="off" placeholder={text.chatPlaceholder}
                    disabled={!connected} onChange={(event) => { setDraft(event.target.value); setChatProblem(false); }} />
                  <button type="submit" className="classroom-room-primary" disabled={!connected || !chatTextOf(draft)}>{text.chatSend}</button>
                </form>
                {chatProblem && <p className="classroom-room-problem" role="alert">{text.chatFailed}</p>}
              </section>
            )}

            {!lcic && (
              <section id="classroom-people" role="tabpanel" aria-labelledby="classroom-tab-people" className="room2-tabpanel" hidden={panel !== "people"}>
                <h2 className="sr-only">{text.people}</h2>
                {/* The tutor sees who raised a hand, plainly, and can lower it. */}
                {isTutor && othersHands.length > 0 && (
                  <div className="classroom-room-hands" role="status" data-hands={othersHands.length}>
                    <RoomIcon name="hand" />
                    <span>{text.handsRaised}{othersHands.map((hand) => hand.name || text.student).join(text.nameSeparator)}</span>
                    {othersHands.map((hand) => (
                      <button key={hand.id} type="button" className="classroom-room-secondary" onClick={() => void lowerHand(hand.id)}>{text.handLower(hand.name)}</button>
                    ))}
                  </div>
                )}
                <ul className="room2-people">
                  {ordered.map((person) => (
                    <li key={person.id} data-person-row={person.id} data-host={person.host} data-self={person.self}>
                      <span className="room2-avatar-sm" aria-hidden="true">{initialsOf(person, words)}</span>
                      <span className="room2-person-name">{labelOf(person)}{person.self ? text.youTag : ""}</span>
                      <span className="room2-person-state">
                        {raised(person.id) && <span className="room2-hand-tag"><RoomIcon name="hand" />{text.handRaised}</span>}
                        <span className="room2-state-icon" data-on={person.microphone}><RoomIcon name={person.microphone ? "microphone" : "microphone-off"} /><span className="sr-only">{person.microphone ? text.micOn : text.micOff}</span></span>
                        <span className="room2-state-icon" data-on={person.camera}><RoomIcon name={person.camera ? "camera" : "camera-off"} /><span className="sr-only">{person.camera ? text.cameraOn : text.cameraOff}</span></span>
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            <section id="classroom-info" role="tabpanel" aria-labelledby="classroom-tab-info" className="room2-tabpanel room2-info" hidden={panel !== "info"}>
              <h2 className="sr-only">{text.info}</h2>
              {facts}
              {joined.role === "tutor" ? (
                <section className="classroom-room-card" aria-live="polite">
                  <h3>{text.recording}</h3>
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
                </section>
              ) : (
                <section className="classroom-room-card classroom-room-notice" aria-live="polite">
                  <h3>{text.recording}</h3>
                  <p>{text.studentNotice[badge]}</p>
                </section>
              )}
              {lcic && <p className="classroom-room-note" role="note">{v.lcicNote}{session.current?.recordingDisabled ? ` ${v.lcicRecordingOff}` : ""}</p>}
              {zoom && isTutor && (
                <div className="classroom-room-tools">
                  <p className="classroom-room-muted">{device === "desktop" && sdkCheck?.screenShare !== false ? v.shareHint : v.noShareHere}</p>
                </div>
              )}
              {limits.length > 0 && (
                <details className="classroom-room-card classroom-room-limits" data-device={device}>
                  <summary>{v.limitsTitle}（{v.device[device]}）</summary>
                  {sdkCheck && <p className="classroom-room-muted" data-sdk-version={sdkCheck.sdkVersion}>{v.sdkCheck(sdkCheck)}</p>}
                  <ul>{limits.map(limit => <li key={limit.name} data-capability={limit.name} data-level={limit.level}>{v.limits[limit.name as CapabilityName]}{limit.level === "unknown" ? v.unknown : ""}</li>)}</ul>
                </details>
              )}
            </section>
          </aside>
        </div>

        {/* Icons with a short word under each (2026-11-12), in groups (2.0); the state is in the icon
            and the colour, and in words for screen readers, so each button still reads "Camera: on". */}
        <div className="classroom-room-controls classroom-room-iconbar room2-bar" role="toolbar" aria-label={text.controls}
          onKeyDown={(event) => {
            if ((event.target as HTMLElement).closest("[role='menu']")) return;
            const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")].filter((button) => !button.closest("[role='menu']") && button.offsetParent !== null);
            moveFocus(event, buttons, { back: "ArrowLeft", next: "ArrowRight" });
          }}>
          {!lcic && (
            <div className="room2-group" role="group" aria-label={text.groups.av}>
              {(["microphone", "camera"] as const).map((kind) => {
                const state = media.devices[kind];
                const blocked = state === "denied" || state === "unavailable";
                // The whole name in one piece ("Camera: on"): browsers may put a space between the
                // word under the icon and the hidden state when they build a name from the parts.
                const name = `${text[kind]}：${state === "on" ? text.on : state === "starting" ? text.starting : text.off}`;
                return (
                  <button key={kind} type="button" className={`classroom-room-control classroom-room-iconbutton room2-tool${state === "on" ? "" : " is-off"}`} data-control={kind} data-tip={name} aria-pressed={state === "on"} aria-label={name}
                    disabled={!media.available || !connected || blocked || state === "starting"} onClick={() => toggle(kind)}>
                    <RoomIcon name={state === "on" ? kind : `${kind}-off`} />
                    <span className="classroom-room-iconlabel">{text[kind]}<span className="sr-only">{name.slice(text[kind].length)}</span></span>
                  </button>
                );
              })}
            </div>
          )}
          {(shareTools || boardTools || (features.raiseHand && isStudent)) && (
            <div className="room2-group" role="group" aria-label={text.groups.teach}>
              {shareTools && device === "desktop" && toolButton({
                tool: "share", icon: "share", label: media.share === "sending" ? v.shareStopShort : v.shareShort, name: media.share === "sending" ? v.shareStop : v.share,
                pressed: media.share === "sending", disabled: !connected || device !== "desktop" || sdkCheck?.screenShare === false, onClick: () => void toggleShare(),
              })}
              {boardTools && toolButton({
                tool: "whiteboard", icon: "whiteboard", label: v.whiteboardShort, name: media.whiteboard === "presenting" ? v.whiteboardStop : v.whiteboard,
                pressed: media.whiteboard === "presenting", disabled: !connected, onClick: () => void toggleBoard(),
              })}
              {features.raiseHand && isStudent && (
                <button type="button" className={`classroom-room-control classroom-room-iconbutton room2-tool${handUp ? " is-hand" : ""}`} data-control="hand" data-tip={handUp ? text.handDown : text.handUp} aria-pressed={handUp}
                  disabled={!connected} onClick={() => void toggleHand()}>
                  <RoomIcon name="hand" /><span className="classroom-room-iconlabel">{handUp ? text.handDown : text.handUp}</span>
                </button>
              )}
            </div>
          )}
          {(features.chat || !lcic) && (
            <div className="room2-group" role="group" aria-label={text.groups.together}>
              {features.chat && (
                <button type="button" className="classroom-room-control classroom-room-iconbutton room2-tool" data-control="chat" data-tip={text.chat} aria-expanded={chatOpen} aria-controls="classroom-chat"
                  aria-label={unread > 0 ? `${text.chat}（${text.chatUnread(unread)}）` : text.chat} onClick={(event) => togglePanel("chat", event.currentTarget)}>
                  <RoomIcon name="chat" /><span className="classroom-room-iconlabel">{text.chat}</span>
                  {unread > 0 && <span className="classroom-room-unread" aria-hidden="true">{unread > 99 ? "99+" : unread}</span>}
                </button>
              )}
              {!lcic && toolButton({
                control: "people", icon: "people", label: text.people, name: text.peopleButton(people.length, isTutor ? othersHands.length : 0), tip: text.people,
                expanded: panel === "people", controls: "classroom-people", onClick: (event) => togglePanel("people", event.currentTarget),
                badge: isTutor && othersHands.length > 0 ? <span className="classroom-room-unread room2-hands-badge" aria-hidden="true">{othersHands.length}</span> : null,
              })}
            </div>
          )}
          <div className="room2-group room2-group-end" role="group" aria-label={text.groups.room}>
            <div className="room2-more">
              {toolButton({
                control: "more", icon: "more", label: text.more, name: text.more, expanded: menuOpen, controls: "classroom-more", popup: "menu", refTo: moreButton,
                onClick: () => setMenuOpen((open) => !open),
              })}
              {menuOpen && (
                <div className="room2-menu" id="classroom-more" role="menu" aria-label={text.more} ref={menu}
                  onKeyDown={(event) => {
                    const items = [...event.currentTarget.querySelectorAll<HTMLElement>("[role^='menuitem']:not(:disabled)")];
                    if (event.key === "Tab") setMenuOpen(false);
                    else moveFocus(event, items, { back: "ArrowUp", next: "ArrowDown" });
                  }}>
                  <button type="button" role="menuitem" onClick={(event) => togglePanel("info", moreButton.current ?? event.currentTarget)}><RoomIcon name="info" />{text.info}</button>
                  <button type="button" role="menuitemcheckbox" aria-checked={focus} onClick={toggleFocus}><RoomIcon name="focus" />{focus ? text.focusExit : text.focus}</button>
                  {canFullscreen && <button type="button" role="menuitemcheckbox" aria-checked={fullscreen} onClick={() => void toggleFullscreen()}><RoomIcon name={fullscreen ? "fullscreen-exit" : "fullscreen"} />{fullscreen ? text.fullscreenExit : text.fullscreen}</button>}
                  {shareTools && device !== "desktop" && <button type="button" role="menuitem" disabled><RoomIcon name="share" />{v.share}</button>}
                  {canExport && (
                    <button type="button" role="menuitem" data-tool="export"
                      onClick={() => { setMenuOpen(false); void adapter.current?.exportWhiteboard?.(`iHear-${joined.lesson.code}`).catch(() => setToolProblem("board")); }}>
                      <RoomIcon name="download" />{v.exportBoard}
                    </button>
                  )}
                </div>
              )}
            </div>
            <button type="button" className="classroom-room-secondary classroom-room-iconbutton room2-tool room2-leave" data-control="leave" data-tip={text.leave} onClick={leave}>
              <RoomIcon name="leave" /><span className="classroom-room-iconlabel">{text.leave}</span>
            </button>
          </div>
        </div>
      </div>

      {simulator && (
        <details className="classroom-room-card classroom-room-simulator">
          <summary>{text.simulate}</summary>
          <p className="classroom-room-muted">{text.simulateNote}</p>
          <div className="classroom-room-simulator-buttons">
            {SYNTHETIC_SCENARIOS.map((scenario: SyntheticScenario) => (
              <button key={scenario} type="button" className="classroom-room-secondary" onClick={() => simulator.simulate(scenario)}>{text.scenario[scenario]}</button>
            ))}
          </div>
        </details>
      )}
    </Shell>
  );
}
