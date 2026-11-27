"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode, type Ref, type CSSProperties } from "react";
import { createPortal } from "react-dom";

import { appendChat, CHAT_MAX_LENGTH, chatTextOf, type ChatLine, type RaisedHand } from "../../../lib/classroom-chat";
import {
  createMediaAdapter, FIXED_ROOM_SCENARIOS, hostReportFor, MAX_REMOTE_VIDEOS, MediaAdapterUnavailableError, SYNTHETIC_SCENARIOS, SyntheticMediaAdapter,
  ZOOM_WHITEBOARD_ACCOUNT_DISABLE, ZOOM_WHITEBOARD_HOST_PRIVILEGE_REQUIRED, ZOOM_WHITEBOARD_SCREEN_SHARE_CONFLICT, ZOOM_WHITEBOARD_UNSUPPORTED,
  type ClassroomMediaAdapter, type ConnectionState, type DeviceKind, type DeviceProblem, type DeviceState, type MediaEvent, type MediaSystemCheck, type RoomPerson, type SoundProblem, type SoundState, type SyntheticScenario,
} from "../../../lib/classroom-media";
import { classroomDeviceOf, deviceLimits, type CapabilityName, type ClassroomDevice } from "../../../lib/classroom-capabilities";
import { entryEndedBy, reasonShown, rejoinRoom, requestJoin, type JoinedSession } from "../../../lib/classroom-join-client";
import { browserClassroomLocale, CLASSROOM_LOCALES, htmlLangOf, intlLocaleOf, LOCALE_NAMES, type ClassroomLocale } from "../../../lib/classroom-locale";
import { connectionStep, devicesToOffer, soundOffered, HAND_NOTICE_MS, initialsOf, newHands, orderPeople, personLabel, spotlightOf, stageModeOf, stripPicks } from "../../../lib/classroom-room";
import { claimLessonTab, lessonTabName, type TabClaim } from "../../../lib/classroom-tab";
import { roomCopy as copy, vendorCopy } from "./classroom-copy";
import { RoomIcon, type RoomIconName } from "./classroom-icons";
import ClassroomPrejoin from "./classroom-prejoin";
import { RoomBoard, RoomChat, RoomTurn, useRoomChannel, type RoomChannelMedia } from "./room-channel";
import { VideoCheck } from "./video-check";
import { testToolsAllowed } from "../../../lib/classroom-test-tools";
import { useLessonPreview } from "./use-lesson-preview";

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


// What the room says when Zoom's whiteboard did not start ("board") or could not be shown here
// ("boardView"), by Zoom's code (2026-11-18). The code is added for support, except where the words
// already say everything (a screen share in progress, 8002).
// `anyone`: a fixed room (D-14), where the board may have been opened by anyone, not the tutor.
function boardProblemText(v: (typeof vendorCopy)[keyof typeof vendorCopy], problem: "board" | "boardView", code: number | null, anyone = false) {
  const number = code == null ? "" : v.zoomCode(code);
  if (problem === "boardView") return `${anyone ? v.boardViewFailedAny : v.boardViewFailed}${number}`;
  if (code === ZOOM_WHITEBOARD_SCREEN_SHARE_CONFLICT) return v.boardShareConflict;
  const words = code === ZOOM_WHITEBOARD_ACCOUNT_DISABLE ? v.boardDisabled
    : code === ZOOM_WHITEBOARD_UNSUPPORTED ? v.boardUnsupported
      : code === ZOOM_WHITEBOARD_HOST_PRIVILEGE_REQUIRED ? v.boardHostOnly
        : v.boardFailed;
  return `${words}${number}`;
}

// Nothing known yet about what Zoom lets this person start (fixed rooms, D-14).
const NO_TOOLS = { share: null, whiteboard: null } as const;

const HEARTBEAT_MS = 30_000;
const RECORDING_HEARTBEAT_MS = 10_000;
const STATUS_MS = 15_000;
// Round 18c: the room channel brings the lesson's status this often (f1's review: then a change reaches
// the page within about 15 s, as the page's own 15 s request did); its answer counts while at most
// this old, after which the page asks itself again.
const CHANNEL_STATUS_EVERY_MS = 10_000;
const CHANNEL_STATUS_FRESH_MS = 40_000;
// What the lesson's status says (the status route's answer, or the same inside the room channel's).
type LessonAnswer = { ok?: boolean; code?: string; recordingDecided?: boolean; recordingAllowed?: boolean; recording?: { status?: unknown; basis?: unknown }; room?: unknown; endsAt?: unknown };
// A fixed room's lesson (2026-11-24): its "ends in … minutes" note shows from this many minutes before
// its planned end; the page's clock for it moves every CLOCK_MS.
const TIME_LEFT_NOTE_MINUTES = 10;
const CLOCK_MS = 20_000;
const RETRY_MS = 5_000;
const ACTIVE = new Set(["START_REQUESTED", "RECORDING", "PAUSED"]);
// While the video connection is down the tutor is not in class, so no heartbeat says otherwise.
const DOWN = new Set<ConnectionState>(["reconnecting", "disconnected", "failed"]);
// How long the room waits before each try of its own to connect again after Zoom gave up.
const AUTO_RECONNECT_MS = [3000, 8000, 20000];

type Phase = "ready" | "joining" | "joined" | "blocked" | "left";
// sessionReports: the join answer asked this (tutor's) page to report the vendor's session id.
// fixedRoom: a fixed room's lesson (round 3): no host. Everyone gets the same teaching tools as far
// as Zoom allows an ordinary participant (D-14, 2026-11-21); chat and raised hands stay off.
// displayName: a fixed room's recorded first name, which Zoom shows (the user, 2026-11-24); null elsewhere.
type Joined = { provider: string; lesson: { code: string; startsAt: string; endsAt: string }; role: "tutor" | "student"; participantCode: string; sessionReports: boolean; fixedRoom: boolean; displayName: string | null; roomChannel: boolean };
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
  // Whether this page hears the room (2026-11-20), and why "Turn on sound" did not work.
  sound: SoundState;
  soundProblem?: SoundProblem;
};
// The one side panel: chat, the participants, or the lesson's details (Classroom 2.0).
type Panel = "none" | "chat" | "people" | "info";

const initialMedia = (): Media => ({ available: true, connection: "idle", devices: { camera: "off", microphone: "off" }, deviceProblems: {}, remote: { present: false, camera: false, microphone: false, seen: false }, share: "none", whiteboard: "none", sound: "off" });

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

// Round 16 (2026-11-24, the user's choice B): a fixed room's lesson page that was reloaded has no key
// (above: it lives in the page's memory only). The room's door keeps this tab's request for 4 hours,
// as before, and notes which lesson it took the person to; this page then goes back through that door,
// which asks the server where the request stands: taken out, ended or lapsed, the door says so and
// nobody comes back; still in, the door takes the person on to this lesson again. One-to-one and
// block lessons have no door: nothing changes for them.
// The reload fix (round 16, f1's finding F1): trips back are counted, at most 3 automatic ones in 2
// minutes (until then one trip in 15 s: a second reload inside that left the person on the one-to-one
// refusal for good). A double or triple reload comes back; a real loop still stops after 3 trips, and
// then, as whenever no automatic trip is left, the page offers the room's door by a button.
const DOOR_PREFIX = "ihear-fixed-room:";
const DOOR_KEEP_MS = 4 * 60 * 60_000;
const DOOR_TRIPS_MAX = 3;
const DOOR_TRIPS_WINDOW_MS = 2 * 60_000;
function doorBackTo(lessonId: string): { door: string; automatic: boolean } | null {
  // Round 18: the door keeps its record in localStorage (an earlier version: this tab's sessionStorage).
  // Reaching a storage can itself throw (a private window): that one is skipped.
  for (const pick of [() => localStorage, () => sessionStorage]) {
    let storage: Storage;
    try { storage = pick(); } catch { continue; }
    const found = doorBackIn(storage, lessonId);
    if (found) return found;
  }
  return null;
}
function doorBackIn(storage: Storage, lessonId: string): { door: string; automatic: boolean } | null {
  try {
    for (let index = 0; index < storage.length; index += 1) {
      const name = storage.key(index);
      if (!name?.startsWith(DOOR_PREFIX)) continue;
      const kept = JSON.parse(storage.getItem(name) ?? "null") as { lessonId?: string; requestId?: string; ticket?: string; at?: number; backs?: unknown } | null;
      if (!kept || kept.lessonId !== lessonId || !kept.requestId || !kept.ticket) continue;
      const now = Date.now();
      if (kept.at && now - kept.at >= DOOR_KEEP_MS) continue;
      const door = `/classroom/r/${encodeURIComponent(name.slice(DOOR_PREFIX.length))}`;
      const backs = (Array.isArray(kept.backs) ? kept.backs : []).filter((at): at is number => typeof at === "number" && now - at < DOOR_TRIPS_WINDOW_MS && at <= now);
      if (backs.length >= DOOR_TRIPS_MAX) return { door, automatic: false };
      storage.setItem(name, JSON.stringify({ ...kept, backs: [...backs, now] }));
      return { door, automatic: true };
    }
  } catch { /* storage refused (a private window): as before */ }
  return null;
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

// The zoom steps for a shared screen (1 is "fit to screen").
const SHARE_ZOOMS = [1, 1.25, 1.5, 2, 3];
const stepZoom = (value: number, step: 1 | -1) => {
  const index = SHARE_ZOOMS.findIndex((zoom) => zoom >= value);
  const at = index < 0 ? SHARE_ZOOMS.length - 1 : index;
  return SHARE_ZOOMS[Math.max(0, Math.min(SHARE_ZOOMS.length - 1, at + step))];
};

export default function ClassroomEntry({ lessonId, synthetic, joinKey: givenKey, autoEnter = false, roomLabel = null, signInPath, onEntered, onEntryEnded, restoreDevices = null, onDevicesChange }: { lessonId: string; synthetic: boolean } & BlockRoomProps) {
  const devicesChanged = useRef(onDevicesChange);
  devicesChanged.current = onDevicesChange;
  const [restoreOffered, setRestoreOffered] = useState(true);
  // A one-to-one room after a reconnect (2026-11-20): what this person turned on with their own
  // presses in this room, and, once the room is connected again, what to offer to turn on again.
  const wanted = useRef<Record<DeviceKind, boolean>>({ camera: false, microphone: false });
  const [rejoinOffer, setRejoinOffer] = useState<Record<DeviceKind, boolean> | null>(null);
  const [locale, setLocale] = useState<Locale>("zhHant");
  const [joinKey, setJoinKey] = useState<string | null>(givenKey ?? null);
  const blockMode = givenKey !== undefined;
  // Classroom 2.1 lobby (2026-11-13): the one-to-one lesson's pre-class screen looks at its lesson
  // once the personal key has been taken from the address (never before, so it is not asked twice).
  const [keyRead, setKeyRead] = useState(false);
  // A fixed room's door for this tab when no automatic trip back is left (the reload fix, round 16).
  const [roomDoor, setRoomDoor] = useState<string | null>(null);
  const { view: preview, recheck: recheckPreview } = useLessonPreview(lessonId, joinKey, keyRead && !blockMode);
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
  // "boardView": the other person opened a whiteboard this page could not show (2026-11-18).
  const [toolProblem, setToolProblem] = useState<"" | "share" | "board" | "boardView">("");
  // Zoom's numeric error code for the whiteboard problem now shown, if Zoom gave one (2026-11-18).
  const [boardCode, setBoardCode] = useState<number | null>(null);
  // D-14 (2026-11-21), fixed rooms: what Zoom lets this person start now (the adapter's "tools").
  const [tools, setTools] = useState<{ share: boolean | null; whiteboard: boolean | null }>(NO_TOOLS);
  // In-class chat and raised hands (2026-11-12): on this page only and never saved (the owner's
  // decision); leaving the room clears them. The unread count shows on the chat button while the
  // chat is closed: a sign to see, not a sound.
  const [features, setFeatures] = useState({ chat: false, raiseHand: false, sound: false });
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
  // Round 18h (「說話的人優先」): the last one other than this page's person who spoke, and whether the
  // screen is a phone's (the short row of people).
  const [lastSpeaker, setLastSpeaker] = useState<string | null>(null);
  const [narrow, setNarrow] = useState(false);
  const [focus, setFocus] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [spotlight, setSpotlight] = useState<string | null>(null);
  const [handNotices, setHandNotices] = useState<RaisedHand[]>([]);
  const handsBefore = useRef<RaisedHand[]>([]);
  const [tiles, setTiles] = useState<ReadonlyMap<string, HTMLElement>>(() => new Map());
  const [hiddenInStrip, setHiddenInStrip] = useState(0);
  const [fullscreen, setFullscreen] = useState(false);
  const [canFullscreen, setCanFullscreen] = useState(false);
  // 2026-11-19: this tab's hold on the lesson (one page per person, lib/classroom-tab.ts); how many
  // other pages or devices this person is in the room from as well; reading a shared screen: its
  // zoom and the stage alone full screen.
  const tabClaim = useRef<TabClaim | null>(null);
  const [elsewhere, setElsewhere] = useState(0);
  const [shareZoom, setShareZoom] = useState(1);
  const stageBox = useRef<HTMLElement | null>(null);
  const [stageFull, setStageFull] = useState(false);
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
  // How many times this page has moved to another session of the lesson (a new room after someone
  // was taken out, D-4/D-5). Shown as data-room-moves on the connection state, a count only, so a
  // check can tell "connected again in the new session" from the old session's label (W1 on real
  // Zoom, 2026-11-23: a check read 已連線 before the old session had ended).
  const [roomMoves, setRoomMoves] = useState(0);
  // A fixed room's lesson end as the server says it now (an owner's extension moves it), and the page's
  // clock for its "ends in … minutes" note (the user, 2026-11-24: at most 120 minutes unless extended).
  const [lessonEndsAt, setLessonEndsAt] = useState<string | null>(null);
  const [nowTick, setNowTick] = useState(() => Date.now());
  // "Connect again" on its way, and why the join check refused it (its code), if it did.
  const [rejoining, setRejoining] = useState(false);
  const [rejoinProblem, setRejoinProblem] = useState("");
  const vendorStage = useRef<HTMLDivElement | null>(null);
  const [device, setDevice] = useState<ClassroomDevice>("desktop");
  const deviceRef = useRef<ClassroomDevice>("desktop");
  deviceRef.current = device;
  const adapter = useRef<ClassroomMediaAdapter | null>(null);
  // Round 16 (2026-11-24, the user's item 5): a fixed room's own whiteboard, public chat and share
  // turn (lib/room-channel, built by f1), each only where the server offers it (three switches, off
  // unless set: then nothing of this shows and the page is as before). One whiteboard per room:
  // while the room's own is offered, Zoom's is not. The turn knows people by participant id (Zoom's
  // user key); the adapter says who shares (shareKeys) and shows the holder's share only.
  const shareKeyListeners = useRef(new Set<() => void>());
  const turnOffered = useRef(false);
  const channelMedia = useMemo<RoomChannelMedia>(() => ({
    startShare: async () => Boolean(await adapter.current?.setScreenShare?.(true).catch(() => false)),
    stopShare: async () => { await adapter.current?.setScreenShare?.(false).catch(() => false); },
    sharers: () => adapter.current?.shareKeys?.() ?? [],
    onSharersChange: (listener) => { shareKeyListeners.current.add(listener); return () => { shareKeyListeners.current.delete(listener); }; },
    // Only while the room offers the turn: without it every share shows, as before the turn.
    showShareOf: (key) => { if (turnOffered.current) adapter.current?.showShareOf?.(key); },
  }), []);
  // Only where the join answer says the site offers a part of it: with all three switches off the page
  // never asks the channel (as before it existed).
  const channelOn = phase === "joined" && joined?.fixedRoom === true && joined.roomChannel === true;
  // Round 18c (load check 2026-11-27): the channel's requests also bring the lesson's status every
  // STATUS_MS, so the page's own status request (below) is left out while that answer is fresh.
  const channel = useRoomChannel({ lessonId, ticket: joinKey, media: channelMedia, enabled: channelOn, lessonStatusEveryMs: CHANNEL_STATUS_EVERY_MS });
  const channelStatus = useRef<{ status: number; body: unknown; at: number } | null>(null);
  useEffect(() => { channelStatus.current = channelOn && !channel.stopped ? channel.lessonStatus : null; });
  turnOffered.current = joined?.fixedRoom === true && channel.parts?.turn === true;
  // The room's board on this page's stage (each page chooses; it starts shown). Someone else's share
  // coming in puts the share first; when it ends the board comes back by itself, unless the person
  // pressed the board button meanwhile (then their choice stays).
  const [roomBoardShown, setRoomBoardShown] = useState(true);
  // Round 18f: the online test site's video check, and "fill" off for this page (never on the live site).
  const testTools = useMemo(() => testToolsAllowed(), []);
  const [videoCheck, setVideoCheck] = useState(false);
  const [fillOff, setFillOff] = useState(false);
  const shareBefore = useRef(media.share);
  const boardHiddenByShare = useRef(false);
  useEffect(() => {
    const before = shareBefore.current;
    shareBefore.current = media.share;
    if (media.share === "receiving" && before !== "receiving") {
      setRoomBoardShown((shown) => { if (shown) boardHiddenByShare.current = true; return false; });
    } else if (media.share !== "receiving" && before === "receiving" && boardHiddenByShare.current) {
      boardHiddenByShare.current = false;
      setRoomBoardShown(true);
    }
  }, [media.share]);
  const pressBoard = () => { boardHiddenByShare.current = false; setRoomBoardShown((shown) => !shown); };
  // The room's chat: messages from others not yet seen while the chat is closed.
  const roomChatSeen = useRef(0);
  const roomChatNewest = channel.chat.messages.at(-1)?.seq ?? 0;
  useEffect(() => {
    if (chatOpen) roomChatSeen.current = roomChatNewest;
  }, [chatOpen, roomChatNewest]);
  // The share handed to this person (10 s to take it): the people panel, where the turn is, opens.
  const offeredToMe = channel.share.offeredToMe;
  useEffect(() => {
    if (offeredToMe) setPanel("people");
  }, [offeredToMe]);
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
    else {
      const back = doorBackTo(lessonId);
      if (back?.automatic) { window.location.replace(back.door); return; }
      // No automatic trip left: the room's door is offered by a button, not the one-to-one words.
      if (back) setRoomDoor(back.door);
    }
    setKeyRead(true);
    // A new link opened in a tab that already shows this room changes only the part after #,
    // which reloads nothing; its key is taken the same way.
    const onHash = () => {
      const next = takeJoinKey();
      if (next) setJoinKey(next);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, [blockMode, lessonId]);
  useEffect(() => {
    document.documentElement.lang = htmlLangOf(locale);
  }, [locale]);

  async function enter(takeOver = false) {
    setPhase("joining");
    setReason("");
    setRejoinProblem("");
    if (!blockMode) {
      const claim = await claimLessonTab(lessonTabName(lessonId, joinKey), { steal: takeOver });
      if (!claim) {
        setReason("OTHER_TAB");
        setPhase("blocked");
        return;
      }
      tabClaim.current?.release();
      tabClaim.current = claim;
      // Another tab continued the lesson: this one leaves the room and says so.
      void claim.lost.then(() => {
        if (tabClaim.current !== claim) return;
        tabClaim.current = null;
        void leaveFor("TAKEN_OVER");
      });
    }
    const answer = await requestJoin(lessonId, joinKey);
    if (answer.ok) {
      session.current = answer.session;
      setJoined({ provider: answer.provider, lesson: answer.lesson, role: answer.role, participantCode: answer.participantCode, sessionReports: answer.sessionReports === true, fixedRoom: answer.fixedRoom === true,
        roomChannel: answer.fixedRoom === true && !!answer.roomChannel && (answer.roomChannel.board || answer.roomChannel.chat || answer.roomChannel.turn),
        displayName: answer.fixedRoom === true && answer.displayName ? answer.displayName : null });
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
  // Out of the room (left, refused, taken over): the lesson's lock goes too, so another tab may enter.
  useEffect(() => {
    if (phase === "joining" || phase === "joined") return;
    tabClaim.current?.release();
    tabClaim.current = null;
  }, [phase]);
  useEffect(() => () => { tabClaim.current?.release(); }, []);
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
  // Raised hands (the user, 2026-11-24: on in fixed rooms too). Who sees the others' hands: the tutor,
  // and everyone in a fixed room (nobody hosts there). Who may lower someone else's: the tutor only;
  // in a fixed room each person lowers their own.
  const seesHands = isTutor || (phase === "joined" && joined?.fixedRoom === true);

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
    setTools(NO_TOOLS);
    // A fixed room has no host to keep chat public: no chat and no raised hands there (D-14 settled
    // the teaching tools only; chat waits for its own decision).
    // A fixed room: no chat (nobody can make it public-only without a host; the server's own public
    // chat is a separate piece), but raised hands, on Zoom's command channel, which needs no host
    // (W1 on real Zoom, 2026-11-23; the user turned them on 2026-11-24).
    setFeatures({ chat: current.capabilities.chat && !joined.fixedRoom, raiseHand: current.capabilities.raiseHand, sound: typeof current.joinSound === "function" });
    // A new room starts with both devices off and nothing pressed yet.
    wanted.current = { camera: false, microphone: false };
    let lost = false;
    const offShareKeys = current.onShareKeysChange?.(() => { for (const listener of [...shareKeyListeners.current]) listener(); });
    const unsubscribe = current.subscribe((event: MediaEvent) => {
      if (event.type === "connection") {
        const step = connectionStep(lost, connection.current, event.state);
        lost = step.lost;
        connection.current = event.state;
        setMedia((state) => ({ ...state, connection: event.state }));
        // Connected again after losing the connection: what was on came back off, and the room
        // offers it (`offered` below, shown only while connected).
        if (step.back) setRejoinOffer({ ...wanted.current });
      } else if (event.type === "device") {
        setMedia((state) => ({
          ...state, devices: { ...state.devices, [event.kind]: event.state },
          deviceProblems: { ...state.deviceProblems, [event.kind]: event.state === "failed" ? event.problem ?? "error" : undefined },
        }));
      } else if (event.type === "sound") {
        setMedia((state) => ({ ...state, sound: event.state, soundProblem: event.state === "failed" ? event.problem ?? "error" : undefined }));
      } else if (event.type === "remote") {
        setMedia((state) => ({ ...state, remote: { present: event.present, camera: event.camera, microphone: event.microphone, seen: state.remote.seen || event.present, others: event.others, waiting: event.videosWaiting } }));
      } else if (event.type === "share") {
        setMedia((state) => ({ ...state, share: event.state }));
      } else if (event.type === "whiteboard") {
        setMedia((state) => ({ ...state, whiteboard: event.state }));
        // A board that did not start, or that the other person opened and this page could not show,
        // is said with Zoom's code, never hidden; a board shown later (opened again) clears it.
        if (event.problem) {
          setBoardCode(event.code ?? null);
          setToolProblem(event.problem === "view" ? "boardView" : "board");
        } else if (event.state !== "none") setToolProblem((problem) => (problem === "boardView" || problem === "board" ? "" : problem));
      } else if (event.type === "chat") {
        setChat((lines) => appendChat(lines, event.line));
        if (event.line.from !== "self" && !chatOpenNow.current) setUnread((count) => count + 1);
      } else if (event.type === "hands") {
        setHands(event.raised);
      } else if (event.type === "people") {
        setPeople(event.people);
      } else if (event.type === "speaking") {
        setSpeaking(event.ids);
      } else if (event.type === "duplicate") {
        setElsewhere(event.count);
      } else if (event.type === "tools") {
        setTools({ share: event.share, whiteboard: event.whiteboard });
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
        lessonCode: joined.lesson.code, participantCode: joined.participantCode, role: joined.role, equalTools: joined.fixedRoom, ...(joined.displayName ? { displayName: joined.displayName } : {}),
      }).catch((error: unknown) => {
        // A vendor that cannot load (the Zoom package before the trial) says "not connected".
        if (error instanceof MediaAdapterUnavailableError) setMedia((state) => ({ ...state, available: false }));
      });
    }
    return () => {
      unsubscribe();
      offShareKeys?.();
      void current.leave();
      adapter.current = null;
      setSimulator(null);
      setSdkCheck(null);
      setToolProblem("");
      connection.current = "idle";
      // Chat is not kept: leaving the room (or moving to another) clears it.
      setFeatures({ chat: false, raiseHand: false, sound: false });
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
      setElsewhere(0);
      setRejoinOffer(null);
    };
  }, [phase, joined, report]);

  // A share that ended: the next one starts at "fit", and the stage leaves full screen.
  const readingNow = phase === "joined" && media.share === "receiving";
  useEffect(() => {
    if (readingNow) return;
    setShareZoom(1);
    if (document.fullscreenElement && document.fullscreenElement === stageBox.current && media.whiteboard === "none") void document.exitFullscreen().catch(() => undefined);
  }, [readingNow, media.whiteboard]);

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
    const own = people.find((person) => person.self)?.id;
    const someone = speaking.find((id) => id !== own);
    if (someone) setLastSpeaker(someone);
  }, [speaking, people]);
  useEffect(() => {
    if (typeof matchMedia !== "function") return;
    const query = matchMedia("(max-width: 600px)");
    const follow = () => setNarrow(query.matches);
    follow();
    query.addEventListener("change", follow);
    return () => query.removeEventListener("change", follow);
  }, []);
  // The short row's marks (round 18h), after every render: who is picked is worked out below, where
  // the stage's mode is known.
  const stripPicked = useRef<Set<string> | null>(null);
  useEffect(() => {
    const picked = stripPicked.current;
    for (const [id, cell] of tiles) cell.toggleAttribute("data-strip-hidden", !!picked && !picked.has(id));
  });
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
    const fresh = seesHands ? newHands(handsBefore.current, hands) : [];
    handsBefore.current = hands;
    setHandNotices((current) => {
      const still = current.filter((notice) => hands.some((hand) => hand.id === notice.id));
      return fresh.length === 0 && still.length === current.length ? current : [...still, ...fresh];
    });
  }, [hands, seesHands]);
  useEffect(() => {
    if (handNotices.length === 0) return;
    const timer = setTimeout(() => setHandNotices([]), HAND_NOTICE_MS);
    return () => clearTimeout(timer);
  }, [handNotices]);
  // A fixed room's lesson: the page's clock for its "ends in … minutes" note (2026-11-24).
  const fixedRoomJoined = phase === "joined" && joined?.fixedRoom === true;
  useEffect(() => {
    if (!fixedRoomJoined) return;
    setNowTick(Date.now());
    const timer = setInterval(() => setNowTick(Date.now()), CLOCK_MS);
    return () => clearInterval(timer);
  }, [fixedRoomJoined]);

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
    const onChange = () => {
      setFullscreen(Boolean(document.fullscreenElement) && document.fullscreenElement !== stageBox.current);
      setStageFull(Boolean(stageBox.current) && document.fullscreenElement === stageBox.current);
    };
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
  // Round 18c (load check 2026-11-27; f1's review): one handling for an answer about the lesson, from
  // this page's own request or from the room channel's, which brings it every 10 s and is taken the
  // moment it arrives. Once the lesson has ended for this page, nothing more is handled.
  const statusDone = useRef(false);
  const applyStatus = useCallback((status: number, data: LessonAnswer | null) => {
    if (statusDone.current) return true;
    // The lesson was cancelled, or this link was revoked or replaced: leave the room.
    const ended = entryEndedBy({ status, code: data?.code }, { role: "student", hasKey: Boolean(joinKey) });
    if (ended) {
      statusDone.current = true;
      setReason(ended);
      setPhase("blocked");
      onEnded.current?.(ended);
      return true;
    }
    if (status >= 200 && status < 300 && data?.ok) {
      setStatusProblem(false);
      setRecording({ decided: data.recordingDecided === true, allowed: data.recordingAllowed === true, status: String(data.recording?.status ?? ""), basis: String(data.recording?.basis ?? "") });
      followRoom(data.room);
      if (typeof data.endsAt === "string" && Number.isFinite(Date.parse(data.endsAt))) setLessonEndsAt(data.endsAt);
    } else {
      setStatusProblem(true);
    }
    return false;
  }, [joinKey, followRoom]);
  // Asks at once (the room channel stopped); null while no status loop runs.
  const statusKick = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (!isStudent) return;
    let stopped = false;
    let reading = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = async () => {
      if (reading || stopped) return;
      reading = true;
      clearTimeout(timer);
      // Round 18c: while the room channel's answer is fresh it was handled when it came (below), and
      // this page sends no request of its own.
      const fresh = channelStatus.current !== null && Date.now() - channelStatus.current.at <= CHANNEL_STATUS_FRESH_MS;
      if (!fresh) {
        try {
          const response = await fetch(statusUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(joinKey ? { key: joinKey } : {}),
          });
          const data = (await response.json().catch(() => null)) as LessonAnswer | null;
          if (!stopped && applyStatus(response.status, data)) stopped = true;
        } catch {
          if (!stopped) setStatusProblem(true);
        }
      }
      reading = false;
      if (!stopped) timer = setTimeout(() => { void read(); }, STATUS_MS);
    };
    statusKick.current = () => { void read(); };
    void read();
    return () => {
      stopped = true;
      clearTimeout(timer);
      statusKick.current = null;
    };
  }, [isStudent, statusUrl, joinKey, applyStatus]);
  // Round 18c: the room channel's answer about the lesson, taken when it arrives.
  useEffect(() => {
    if (!isStudent || !channelOn || channel.stopped || !channel.lessonStatus) return;
    const body = channel.lessonStatus.body;
    applyStatus(channel.lessonStatus.status, (body && typeof body === "object" ? body : null) as LessonAnswer | null);
  }, [isStudent, channelOn, channel.stopped, channel.lessonStatus, applyStatus]);
  // Round 18c: the room channel stopped (taken out, the lesson over, the link replaced): ask at once.
  useEffect(() => {
    if (channel.stopped) statusKick.current?.();
  }, [channel.stopped]);

  async function toggle(kind: DeviceKind) {
    const current = adapter.current;
    if (!current) return;
    const on = media.devices[kind] !== "on";
    // What this person wants on, from their own presses only (P3-Multi: offered again after a move).
    devicesChanged.current?.({ camera: kind === "camera" ? on : media.devices.camera === "on", microphone: kind === "microphone" ? on : media.devices.microphone === "on" });
    // The same for a reconnect in this room; a press of its own answers the offer for that device.
    wanted.current = { ...wanted.current, [kind]: on };
    setRejoinOffer((offer) => (offer?.[kind] ? { ...offer, [kind]: false } : offer));
    await current.setDevice(kind, on);
  }

  // After a reconnect: one press turns on again what this person had on (never by itself). The
  // microphone first (devicesToOffer): its sound needs the press, and a camera can be slow to start.
  async function turnOnAgain(kinds: readonly DeviceKind[]) {
    const current = adapter.current;
    setRejoinOffer(null);
    if (!current) return;
    for (const kind of kinds) await current.setDevice(kind, true).catch(() => undefined);
  }

  // "Turn on sound" (2026-11-20): one press and the room is heard; the microphone stays muted.
  async function hearRoom() {
    const current = adapter.current;
    if (!current?.joinSound) return;
    await current.joinSound().catch(() => false);
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
    // Zoom shares no screen while its whiteboard is open (real Zoom, 2026-11-19: the press did
    // nothing and the page blamed a cancelled choice). This page's own board is closed first, so one
    // press shares, the same way one press on the whiteboard stops this page's own share.
    if (on && media.whiteboard === "presenting" && current.setWhiteboard) await current.setWhiteboard(false).catch(() => false);
    const started = await current.setScreenShare(on).catch(() => false);
    if (on && !started) setToolProblem("share");
  }

  async function toggleBoard() {
    const current = adapter.current;
    if (!current?.setWhiteboard) return;
    setToolProblem("");
    setBoardCode(null);
    const on = media.whiteboard !== "presenting";
    // Round 18 (the user, 2026-11-26: Zoom's whiteboard menus were cut off; full screen showed them):
    // Zoom's board is an iframe, so its menus fit only in a tall stage. Opening it takes the stage full
    // screen in the same press (a browser allows that only during the press); closing the board leaves
    // it again (the effect on media.whiteboard above). Nobody else is taken full screen: their stage bar
    // offers it ("全螢幕檢視教材").
    const refused = on && media.share !== "none" && media.share !== "sending";
    if (on && !refused && canFullscreen && !document.fullscreenElement) void stageBox.current?.requestFullscreen?.().catch(() => undefined);
    // Zoom does not open its whiteboard during a screen share (its error 8002). This page's own share
    // is stopped first, so one press opens the board (2026-11-19); someone else's share is said at
    // once, and nothing is tried.
    if (on && media.share === "sending" && current.setScreenShare) await current.setScreenShare(false).catch(() => false);
    else if (on && media.share !== "none") {
      setBoardCode(ZOOM_WHITEBOARD_SCREEN_SHARE_CONFLICT);
      setToolProblem("board");
      return;
    }
    const started = await current.setWhiteboard(on).catch(() => false);
    if (on && !started) setToolProblem("board");
    // A board that did not open leaves no empty full screen behind.
    if (on && !started && document.fullscreenElement && document.fullscreenElement === stageBox.current) void document.exitFullscreen().catch(() => undefined);
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

  // The shared screen or the whiteboard alone, full screen (2026-11-19: on a laptop the student could
  // not read the tutor's slides beside the video column).
  async function toggleStageFullscreen() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await stageBox.current?.requestFullscreen();
    } catch {
      // The browser refused: nothing changes.
    }
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
      lessonCode: joined.lesson.code, participantCode: joined.participantCode, role: joined.role, equalTools: joined.fixedRoom, ...(joined.displayName ? { displayName: joined.displayName } : {}),
    });
    setRejoining(false);
    // Left (or entered anew) meanwhile: this answer belongs to a room that is gone.
    if (adapter.current !== current) return;
    if (result.ok) {
      if (result.session.sessionName && result.session.sessionName !== session.current?.sessionName) setRoomMoves((moves) => moves + 1);
      session.current = result.session;
    } else if (result.code !== "CONNECT_FAILED") setRejoinProblem(result.code);
  }
  // Moving to the room the server names is this same request (see moveRoom above).
  useEffect(() => {
    moveRoom.current = () => { void reconnect(); };
  });

  // The enlarged material can be moved by dragging it (asked for after the real test of
  // 2026-11-19; before, only the scroll bars moved it). Only while enlarged, and only with a mouse
  // or pen: a finger already scrolls it.
  const draggable = phase === "joined" && media.share === "receiving" && shareZoom > 1;
  useEffect(() => {
    const area = draggable ? stageBox.current?.querySelector<HTMLElement>(".classroom-zoom-share") : null;
    if (!area) return;
    let from: { x: number; y: number; left: number; top: number } | null = null;
    const down = (event: PointerEvent) => {
      if (event.pointerType === "touch" || event.button !== 0) return;
      from = { x: event.clientX, y: event.clientY, left: area.scrollLeft, top: area.scrollTop };
      area.setPointerCapture?.(event.pointerId);
      area.dataset.dragging = "on";
    };
    const move = (event: PointerEvent) => {
      if (!from) return;
      area.scrollLeft = from.left - (event.clientX - from.x);
      area.scrollTop = from.top - (event.clientY - from.y);
    };
    const up = (event: PointerEvent) => {
      if (!from) return;
      from = null;
      area.releasePointerCapture?.(event.pointerId);
      delete area.dataset.dragging;
    };
    area.addEventListener("pointerdown", down);
    area.addEventListener("pointermove", move);
    area.addEventListener("pointerup", up);
    area.addEventListener("pointercancel", up);
    return () => {
      area.removeEventListener("pointerdown", down);
      area.removeEventListener("pointermove", move);
      area.removeEventListener("pointerup", up);
      area.removeEventListener("pointercancel", up);
      delete area.dataset.dragging;
    };
  }, [draggable]);

  // Zoom gave up on a connection (real Zoom, 2026-11-19: after 4 of 9 network cuts of 30 seconds the
  // room said "connection failed" and waited for a press on "Connect again"; a child does not know
  // to press it). The page now asks again by itself, after 3, 8 and 20 seconds; after that only the
  // button is left. Each try is the same protected request as the button. A refusal by the server
  // (the lesson ended, the link was revoked) ends the tries, and being connected starts them anew.
  const autoTries = useRef(0);
  useEffect(() => {
    if (media.connection === "connected") { autoTries.current = 0; return; }
    if (media.connection !== "failed" || !joined || rejoining || rejoinProblem) return;
    const wait = AUTO_RECONNECT_MS[autoTries.current];
    if (wait === undefined) return;
    const timer = setTimeout(() => { autoTries.current += 1; moveRoom.current(); }, wait);
    return () => clearTimeout(timer);
  }, [media.connection, joined, rejoining, rejoinProblem]);

  async function leaveFor(why: string) {
    if (adapter.current) await adapter.current.leave();
    session.current = null;
    setRejoinProblem("");
    setReason(why);
    setPhase("blocked");
  }

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
  // P2 (2026-11-23): a fixed room says being taken out and the lesson's end in its own words; the
  // decisions above and below keep the server's code.
  const fixedRoom = joined?.fixedRoom === true;
  const shownReason = reasonShown(reason, fixedRoom);
  const badge = statusProblem && isStudent ? "unknown" : badgeOf(recording);
  // "Simulated" only in the synthetic stand-in; a vendor adapter carries real video.
  const cameraOn = simulator ? text.cameraOnSimulated : text.cameraOn;
  const cameraText = { on: cameraOn, off: text.cameraOff, denied: text.cameraDenied, unavailable: text.cameraUnavailable, starting: text.cameraStarting, failed: text.cameraFailed }[media.devices.camera];
  const micText = { on: text.micOn, off: text.micOff, denied: text.micDenied, unavailable: text.micUnavailable, starting: text.micStarting, failed: text.micFailed }[media.devices.microphone];
  const connected = media.connection === "connected";
  // A one-to-one room only: a block's rooms offer what was on after a move (restoreDevices).
  const offered = !blockMode && connected ? devicesToOffer(rejoinOffer, media.devices) : [];
  // "Turn on sound", unless an offer above already turns the microphone on again.
  const restoringMic = Boolean(blockMode && restoreDevices?.microphone && restoreOffered && media.devices.microphone !== "on");
  const offerSound = soundOffered({ connected: media.available && connected, canJoin: features.sound, sound: media.sound, microphone: media.devices.microphone, micOffered: offered.includes("microphone") || restoringMic });
  // A fixed room's lesson near its planned end (the server's latest word, else the join answer's).
  const endsAtMs = fixedRoomJoined ? Date.parse(lessonEndsAt ?? joined?.lesson.endsAt ?? "") : NaN;
  const minutesLeft = Number.isFinite(endsAtMs) ? Math.ceil((endsAtMs - nowTick) / 60_000) : null;
  const showTimeLeft = minutesLeft != null && minutesLeft > 0 && minutesLeft <= TIME_LEFT_NOTE_MINUTES;
  const soundText = media.sound === "failed" ? text.sound[media.soundProblem ?? "error"] : text.sound.off;
  const handUp = hands.some((hand) => hand.self);
  const othersHands = hands.filter((hand) => !hand.self);
  // A chat line's time, Taipei like the lesson's.
  const clock = (at: number) => until(new Date(at).toISOString());
  const languages = (
    <div className="classroom-langs" role="group" aria-label="Language / 語言 / 语言">{CLASSROOM_LOCALES.filter(item => item !== locale).map(item => <button key={item} type="button" className="classroom-lang" lang={htmlLangOf(item)} onClick={() => setLocale(item)}>{LOCALE_NAMES[item]}</button>)}</div>
  );
  // A room inside a block sits in the block's own page, which has the page's <main>.
  const Shell = blockMode ? "div" : "main";

  if ((phase !== "joined" || !joined) && !blockMode) {
    return (
      <ClassroomPrejoin
        locale={locale} onLocale={setLocale} phase={phase === "joined" ? "joining" : phase} reason={shownReason} synthetic={synthetic}
        preview={preview} onRecheck={recheckPreview} onEnter={() => void enter(phase === "blocked" && (reason === "OTHER_TAB" || reason === "TAKEN_OVER"))} showSignIn={showSignIn} signInUrl={signInUrl}
        enterLabel={phase === "blocked" && (reason === "OTHER_TAB" || reason === "TAKEN_OVER") ? text.continueHere : undefined}
        roomDoor={roomDoor}
      />
    );
  }

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
          {phase === "blocked" && <p className="classroom-room-problem" role="alert">{text.reasons[shownReason] ?? text.reasons.UNAVAILABLE}</p>}
          <div className="classroom-room-actions">
            <button type="button" className="classroom-room-primary" disabled={phase === "joining"} onClick={() => void enter()}>
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
  // Round 18 (the user's plan, point 10: the system does not tell tutors from students): in a fixed
  // room a person with a name is shown by that name alone, without "Student".
  const labelOf = (person: RoomPerson) => (joined.fixedRoom && person.name ? person.name : personLabel(person, words));
  const raised = (id: string) => hands.some((hand) => hand.id === id);
  // D-14 (2026-11-21): a fixed room has no host, and everyone in it gets the same teaching tools:
  // sharing on a computer (not while someone else shares: Zoom lets one person share at a time),
  // and the whiteboard when Zoom says this person may open one (and to close one's own). Managing
  // the room (letting people in, taking them out, ending the lesson) stays with its owner on the
  // admin page: nothing on this page does it, and Zoom gives nobody here the host's powers.
  const equalTools = joined.fixedRoom;
  const shareTools = (isTutor || equalTools) && !!adapter.current?.setScreenShare && (zoom || !!simulator);
  const roomBoard = equalTools && channel.parts?.board === true;
  const roomChat = equalTools && channel.parts?.chat === true;
  const roomTurn = equalTools && channel.parts?.turn === true;
  const boardOnStage = roomBoard && roomBoardShown;
  const boardTools = !roomBoard && (isTutor || (equalTools && (tools.whiteboard === true || media.whiteboard === "presenting"))) && !!adapter.current?.setWhiteboard && (zoom || !!simulator);
  // Someone else shares in Zoom (D-14: one at a time), or, with the turn, it is someone else's or
  // offered to someone else (the server's word): either keeps this page from sharing.
  const zoomShareBusy = !isTutor && equalTools && tools.share === false && media.share !== "sending";
  const turnBusy = roomTurn && !channel.share.sharing && (channel.share.busy || (channel.share.offeredTo !== null && !channel.share.offeredToMe));
  const shareBusy = zoomShareBusy || turnBusy;
  const sharingNow = roomTurn ? channel.share.sharing : media.share === "sending";
  const boardBusy = !isTutor && equalTools && media.whiteboard === "viewing";
  const canExport = !roomBoard && media.whiteboard === "presenting" && !!adapter.current?.exportWhiteboard;
  // Who the share can be handed to (f1's RoomTurn): the server's list of people let into the lesson
  // (channel.people: participant id and the name the server recorded); where Zoom says who is here
  // (people carry their participant id), only those. The stand-in's people are a simulation, never the
  // other real pages, so there the server's list is used as it is.
  const presentKeys = new Set(people.flatMap((person) => (person.key ? [person.key] : [])));
  const turnPeople = !roomTurn ? [] : presentKeys.size > 0 ? channel.people.filter((person) => presentKeys.has(person.id)) : channel.people;
  const roomUnread = roomChat && !chatOpen ? channel.chat.messages.filter((message) => message.by !== channel.you && message.seq > roomChatSeen.current).length : 0;
  const chatUnread = roomChat ? roomUnread : unread;
  const stageLabel = boardOnStage ? text.stageLabel.board : mode === "share" ? (media.share === "sending" ? text.stageLabel.ownShare : text.stageLabel.share) : text.stageLabel[mode];
  // Someone else's screen on this page (2026-11-19): the material comes first (the videos go to a
  // narrow column) and can be enlarged, scrolled, or shown full screen.
  const reading = !boardOnStage && mode === "share" && media.share === "receiving";
  // The room's own board is on the stage the way Zoom's was (the material first).
  const shownMode = boardOnStage ? "board" : mode;
  // Round 18h (the user, 2026-11-28: 「說話的人優先」): on a phone the row beside a board or a share shows
  // three people and the people view six: this page's own, the one enlarged, the last speaker and the
  // anchor first (lib/classroom-room.ts stripPicks); the rest wait in "N more", which opens the list.
  const stripLimit = narrow ? (shownMode === "people" ? 6 : 3) : 0;
  // A plain value here (after the not-joined return no hook may be added); the marks are written by
  // the effect above that return, from stripPicked.
  const picks = stripLimit > 0 && people.length > stripLimit ? stripPicks(people, lastSpeaker, stripLimit, spotlight) : null;
  stripPicked.current = picks;
  const moreCount = hiddenInStrip + (picks ? people.length - picks.size : 0);
  const zoomed = reading && shareZoom > 1;
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
            {!(joined.fixedRoom && person.name) && <span className={`room2-tile-role${person.host || !person.name ? " is-key" : ""}`}>{person.host ? text.tutor : text.student}</span>}
            {person.name && <span className="room2-tile-code">{joined.fixedRoom ? "" : " "}{person.name}</span>}
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
  const toolButton = (props: { control?: string; tool?: string; icon: RoomIconName; label: ReactNode; name?: string; tip?: string; pressed?: boolean; expanded?: boolean; controls?: string; popup?: "menu"; disabled?: boolean; danger?: boolean; badge?: ReactNode; marks?: Record<string, string>; onClick: (event: ReactMouseEvent<HTMLButtonElement>) => void; refTo?: Ref<HTMLButtonElement> }) => (
    <button type="button" ref={props.refTo} className={`classroom-room-control classroom-room-iconbutton room2-tool${props.danger ? " room2-leave" : ""}`} {...props.marks}
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
    <Shell className="classroom-room room2" data-mode={shownMode} data-panel={panel} data-focus={focus ? "on" : "off"} data-role={joined.role}
      data-provider={provider} data-device={device} data-count={people.length} data-spot={spotlight ? "on" : "off"}
      data-reading={reading ? "on" : "off"} data-share-zoom={zoomed ? "zoomed" : "fit"} data-zoom-fill={fillOff ? "off" : "on"} data-strip={picks ? "short" : "all"}
      {...(roomBoard || roomChat || roomTurn ? { "data-room-channel": "", "data-you": channel.you ?? "", "data-stopped": channel.stopped ?? "", "data-online": String(channel.online), "data-room-board-shown": String(boardOnStage) } : {})}
      style={reading ? ({ "--share-zoom": String(shareZoom) } as CSSProperties) : undefined}>
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
            <span className={`classroom-room-connection ${media.available ? media.connection : "unavailable"}`} role="status" data-room-moves={roomMoves}>
              {media.available ? text.connection[media.connection] : text.connection.idle}
            </span>
            <span className={`classroom-room-badge ${badge}`} role="status" aria-label={`${text.recording}：${text.badge[badge]}`}>{text.badge[badge]}</span>
            {headcount != null && <span className="classroom-room-connection" role="status" data-headcount={headcount}>{locale === "en" ? `${headcount} in the room` : `教室人數：${headcount}`}</span>}
            {seesHands && othersHands.length > 0 && (
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
          {offered.length > 0 && (
            <div className="classroom-room-note" role="status" data-rejoin-devices={offered.join(" ")}>
              <p>{offered.length > 1 ? text.rejoinDevices.both : text.rejoinDevices[offered[0]]}</p>
              <button type="button" className="classroom-room-secondary" onClick={() => void turnOnAgain(offered)}>{text.rejoinTurnOn}</button>
              <button type="button" className="classroom-room-secondary" onClick={() => setRejoinOffer(null)}>{text.rejoinNotNow}</button>
            </div>
          )}
          {offerSound && (
            <div className="classroom-room-note room2-sound" role="status" data-sound={media.sound} data-sound-problem={media.sound === "failed" ? media.soundProblem ?? "error" : undefined}>
              {/* A failure is always said in full; otherwise a phone shows the short line. */}
              <p>{media.sound === "failed" ? soundText : <><span className="room2-sound-long">{text.sound.off}</span><span className="room2-sound-short">{text.sound.short}</span></>}</p>
              <button type="button" className="classroom-room-secondary" data-control="sound" disabled={media.sound === "joining"} onClick={() => void hearRoom()}>
                {media.sound === "joining" ? text.sound.joining : text.sound.turnOn}
              </button>
            </div>
          )}
          {media.available && media.connection === "reconnecting" && <p className="classroom-room-problem" role="status">{text.reconnecting}</p>}
          {showTimeLeft && <p className="classroom-room-problem" role="status" data-time-left={minutesLeft}>{text.timeLeft(minutesLeft)}</p>}
          {media.available && media.connection === "failed" && (
            <div className="classroom-room-problem classroom-room-problem-row" role="alert">
              <span>{text.failed}{rejoinProblem && ` ${text.reasons[reasonShown(rejoinProblem, fixedRoom)] ?? text.reasons.UNAVAILABLE}`}</span>
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
          {toolProblem && <p className="classroom-room-problem" role="alert" data-board-code={toolProblem === "share" ? undefined : boardCode ?? undefined}>{toolProblem === "share" ? v.shareFailed : boardProblemText(v, toolProblem, boardCode, joined.fixedRoom)}</p>}
          {handProblem && <p className="classroom-room-problem" role="alert">{text.handFailed}</p>}
          {elsewhere > 0 && <p className="classroom-room-problem" role="alert" data-elsewhere={elsewhere}>{text.elsewhere}</p>}
          {isTutor && recording?.status === "FAILED" && <p className="classroom-room-problem" role="alert">{text.failedRecording}</p>}
          {isTutor && hostProblem === "unstable" && <p className="classroom-room-problem" role="status">{text.unstable}</p>}
          {isTutor && hostProblem === "signedOut" && <p className="classroom-room-problem" role="alert">{text.signedOut} <a href={signInUrl}>{text.signIn}</a></p>}
        </div>

        <div className="room2-main">
          <section className="room2-stage" ref={stageBox} aria-label={lcic ? text.stage : text.materials}>
            <div className="room2-stage-bar">
              <span className="room2-stage-label">{stageLabel}</span>
              <div className="room2-stage-tools">
                {reading && (
                  <div className="room2-zoom" role="group" aria-label={text.zoomLevel(Math.round(shareZoom * 100))} data-share-zoom-level={Math.round(shareZoom * 100)}>
                    <button type="button" className="room2-stage-tool" aria-label={text.zoomOut} disabled={shareZoom <= SHARE_ZOOMS[0]} onClick={() => setShareZoom((value) => stepZoom(value, -1))}>−</button>
                    <button type="button" className="room2-stage-tool room2-zoom-fit" aria-pressed={shareZoom === 1} onClick={() => setShareZoom(1)}>
                      {shareZoom === 1 ? text.zoomFit : `${Math.round(shareZoom * 100)}%`}
                    </button>
                    <button type="button" className="room2-stage-tool" aria-label={text.zoomIn} disabled={shareZoom >= SHARE_ZOOMS[SHARE_ZOOMS.length - 1]} onClick={() => setShareZoom((value) => stepZoom(value, 1))}>+</button>
                  </div>
                )}
                {canFullscreen && (mode === "share" || mode === "board") && (
                  <button type="button" className="room2-stage-tool" data-stage-fullscreen aria-pressed={stageFull} aria-label={stageFull ? text.materialFullscreenExit : text.materialFullscreen} onClick={() => void toggleStageFullscreen()}>
                    <RoomIcon name={stageFull ? "fullscreen-exit" : "fullscreen"} /><span>{stageFull ? text.materialFullscreenExit : text.materialFullscreen}</span>
                  </button>
                )}
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
            {boardOnStage && <div className="room2-room-board" data-room-board-stage><RoomBoard channel={channel} locale={locale} /></div>}
            <div className={`classroom-vendor-stage ${provider}`} ref={vendorStage} data-provider={provider} hidden={boardOnStage} />
            {simulator && mode === "share" && <p className="room2-simulated">{text.simulatedShare}</p>}
            {reading && device !== "desktop" && <p className="room2-reading-tip">{text.readingTip}</p>}
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
              {moreCount > 0 && (
                <button type="button" className="room2-more-chip" onClick={(event) => togglePanel("people", event.currentTarget)}>{text.moreOthers(moreCount)}</button>
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
                  {isTutor && <button type="button" className="classroom-room-secondary" onClick={() => void lowerHand(hand.id)}>{text.handLower(hand.name)}</button>}
                  <button type="button" className="classroom-room-secondary" onClick={() => setHandNotices([])}>{text.handNoticeDismiss}</button>
                </div>
              );
            })}
          </div>

          <aside className="room2-panel" ref={panelBox} hidden={panel === "none"} aria-label={panel === "chat" ? text.chat : panel === "people" ? text.people : text.info}>
            <div className="room2-panel-head">
              <div className="room2-tabs" role="tablist">
                {(features.chat || roomChat) && <button type="button" role="tab" id="classroom-tab-chat" aria-selected={panel === "chat"} aria-controls="classroom-chat" onClick={() => setPanel("chat")}>{text.chat}{chatUnread > 0 && <span className="room2-tab-count">{chatUnread}</span>}</button>}
                {!lcic && <button type="button" role="tab" id="classroom-tab-people" aria-selected={panel === "people"} aria-controls="classroom-people" onClick={() => setPanel("people")}>{text.people}{seesHands && othersHands.length > 0 && <span className="room2-tab-count">{othersHands.length}</span>}</button>}
                <button type="button" role="tab" id="classroom-tab-info" aria-selected={panel === "info"} aria-controls="classroom-info" onClick={() => setPanel("info")}>{text.info}</button>
              </div>
              <button type="button" className="room2-panel-close" aria-label={panel === "chat" ? text.chatClose : panel === "people" ? text.peopleClose : text.infoClose} onClick={closePanel}>
                <RoomIcon name="close" />
              </button>
            </div>

            {roomChat && (
              <section id="classroom-chat" role="tabpanel" aria-labelledby="classroom-tab-chat" className="room2-tabpanel room2-room-chat" hidden={panel !== "chat"} data-room-chat-panel>
                <h2 className="sr-only">{text.chat}</h2>
                <RoomChat channel={channel} locale={locale} />
              </section>
            )}

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
                {/* The tutor sees who raised a hand, plainly, and can lower it; in a fixed room everyone
                    sees it, and each person lowers their own. */}
                {seesHands && othersHands.length > 0 && (
                  <div className="classroom-room-hands" role="status" data-hands={othersHands.length}>
                    <RoomIcon name="hand" />
                    <span>{text.handsRaised}{othersHands.map((hand) => hand.name || text.student).join(text.nameSeparator)}</span>
                    {isTutor && othersHands.map((hand) => (
                      <button key={hand.id} type="button" className="classroom-room-secondary" onClick={() => void lowerHand(hand.id)}>{text.handLower(hand.name)}</button>
                    ))}
                  </div>
                )}
                {/* The share turn: who shares, handing it over, taking it when handed (f1's RoomTurn; the
                    toolbar's share button is the page's own, so RoomTurn shows none). */}
                {roomTurn && <div className="room2-turn"><RoomTurn channel={channel} people={turnPeople} locale={locale} button={false} /></div>}
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
              {zoom && (isTutor || equalTools) && (
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
          {(shareTools || boardTools || roomBoard || (features.raiseHand && isStudent)) && (
            <div className="room2-group" role="group" aria-label={text.groups.teach}>
              {shareTools && device === "desktop" && toolButton({
                tool: "share", icon: "share", label: sharingNow ? v.shareStopShort : v.shareShort, name: sharingNow ? v.shareStop : zoomShareBusy ? v.shareBusy : turnBusy ? v.turnBusy : v.share,
                pressed: sharingNow, disabled: !connected || device !== "desktop" || sdkCheck?.screenShare === false || shareBusy, ...(roomTurn ? { marks: { "data-room-turn-button": "" } } : {}),
                onClick: () => void (roomTurn ? (channel.share.sharing ? channel.share.stop() : channel.share.start()) : toggleShare()),
              })}
              {roomBoard && toolButton({
                tool: "room-board", icon: "whiteboard", label: v.whiteboardShort, name: boardOnStage ? v.roomBoardHide : v.roomBoardShow,
                pressed: boardOnStage, marks: { "data-room-board-toggle": "" }, onClick: pressBoard,
              })}
              {boardTools && toolButton({
                tool: "whiteboard", icon: "whiteboard", label: v.whiteboardShort, name: media.whiteboard === "presenting" ? v.whiteboardStop : v.whiteboard,
                pressed: media.whiteboard === "presenting", disabled: !connected || boardBusy, onClick: () => void toggleBoard(),
              })}
              {features.raiseHand && isStudent && (
                <button type="button" className={`classroom-room-control classroom-room-iconbutton room2-tool${handUp ? " is-hand" : ""}`} data-control="hand" data-tip={handUp ? text.handDown : text.handUp} aria-pressed={handUp}
                  disabled={!connected} onClick={() => void toggleHand()}>
                  <RoomIcon name="hand" /><span className="classroom-room-iconlabel">{handUp ? text.handDown : text.handUp}</span>
                </button>
              )}
            </div>
          )}
          {(features.chat || roomChat || !lcic) && (
            <div className="room2-group" role="group" aria-label={text.groups.together}>
              {(features.chat || roomChat) && (
                <button type="button" className="classroom-room-control classroom-room-iconbutton room2-tool" data-control="chat" data-tip={text.chat} aria-expanded={chatOpen} aria-controls="classroom-chat"
                  aria-label={chatUnread > 0 ? `${text.chat}（${text.chatUnread(chatUnread)}）` : text.chat} onClick={(event) => togglePanel("chat", event.currentTarget)}>
                  <RoomIcon name="chat" /><span className="classroom-room-iconlabel">{text.chat}</span>
                  {chatUnread > 0 && <span className="classroom-room-unread" aria-hidden="true">{chatUnread > 99 ? "99+" : chatUnread}</span>}
                </button>
              )}
              {!lcic && toolButton({
                control: "people", icon: "people", label: text.people, name: text.peopleButton(people.length, seesHands ? othersHands.length : 0), tip: text.people,
                expanded: panel === "people", controls: "classroom-people", onClick: (event) => togglePanel("people", event.currentTarget),
                badge: seesHands && othersHands.length > 0 ? <span className="classroom-room-unread room2-hands-badge" aria-hidden="true">{othersHands.length}</span> : null,
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
                  {testTools && (
                    <button type="button" role="menuitemcheckbox" aria-checked={videoCheck} data-video-check-toggle
                      onClick={() => { setMenuOpen(false); setVideoCheck((open) => !open); }}>
                      <RoomIcon name="info" />{text.videoCheck}
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

      {testTools && videoCheck && <VideoCheck fill={!fillOff} onFill={() => setFillOff((off) => !off)} onClose={() => setVideoCheck(false)} text={text} />}
      {simulator && (
        <details className="classroom-room-card classroom-room-simulator">
          <summary>{text.simulate}</summary>
          <p className="classroom-room-muted">{text.simulateNote}</p>
          <div className="classroom-room-simulator-buttons">
            {SYNTHETIC_SCENARIOS.filter((scenario) => joined.fixedRoom || !FIXED_ROOM_SCENARIOS.has(scenario)).map((scenario: SyntheticScenario) => (
              <button key={scenario} type="button" className="classroom-room-secondary" onClick={() => simulator.simulate(scenario)}>{text.scenario[scenario]}</button>
            ))}
          </div>
        </details>
      )}
    </Shell>
  );
}
