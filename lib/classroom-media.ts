// The browser side of the classroom's video provider: joining the room, the camera and the
// microphone, and what the connection is doing. Pages use only this interface. The two candidates
// (2026-10-30) are the Zoom Video SDK (our own room page around Zoom's media) and Tencent LCIC
// (Tencent's whole classroom page in an iframe); neither is chosen and neither has run with a
// real account.
//
// Recording is deliberately not here. The server alone starts and stops it after the consent
// check, so no browser, and no SDK running in one, can start a recording.
//
// The synthetic stand-in has no camera, no microphone and no network: it plays the states a real
// SDK reports, so the page, the tutor's reports and the overview can be shown and tested. It never
// claims to carry audio or video (capabilities.realMedia is false). The Zoom adapter loads the
// official package (@zoom/videosdk 2.6.0, 2026-10-30); joining a real session still needs the
// Video SDK key of a trial account.

import type ZoomVideo from "@zoom/videosdk";

import { chatNameOf, chatTextOf, handCommand, parseHandCommand, type ChatFrom, type ChatLine, type RaisedHand } from "./classroom-chat";

export const MEDIA_PROVIDERS = ["synthetic", "zoom-video-sdk", "tencent-lcic"] as const;
export type MediaProviderName = (typeof MEDIA_PROVIDERS)[number];

export type ConnectionState = "idle" | "connecting" | "connected" | "reconnecting" | "disconnected" | "failed";
export type DeviceKind = "camera" | "microphone";
// "starting": a press is waiting for the browser and the provider. "failed": it did not start and
// can be pressed again; the problem says why, for the page's message.
export type DeviceState = "off" | "on" | "denied" | "unavailable" | "starting" | "failed";
export type DeviceProblem = "timeout" | "capture" | "autoplay" | "missing" | "busy" | "error";
export type MediaRole = "tutor" | "student";
// Whether this page hears the room (2026-11-20). Zoom plays the others' sound only once this page has
// joined its audio, and the page joined it only on the first microphone press, so nobody heard the
// room before pressing the microphone. "on": joined (by "Turn on sound" with the microphone muted,
// or by the microphone); "joining": on its way; "failed": did not join, can be pressed again.
export type SoundState = "off" | "joining" | "on" | "failed";
export type SoundProblem = "autoplay" | "capture" | "error";

export type MediaEvent =
  | { type: "connection"; state: ConnectionState; at: number }
  | { type: "device"; kind: DeviceKind; state: DeviceState; problem?: DeviceProblem; at: number }
  // Whether this page hears the room (see SoundState); never reported to iHear.
  | { type: "sound"; state: SoundState; problem?: SoundProblem; at: number }
  // The other person in the room. A real adapter also passes their user key (our participant
  // id, which the session token carries) so the tutor's page can report joins and leaves.
  // P3-Multi: in a room of several, how many others are there and how many of their videos are shown
  // (a phone shows at most 9 tiles, a computer 25) or waiting for a free tile.
  | { type: "remote"; present: boolean; camera: boolean; microphone: boolean; userKey: string | null; at: number; others?: number; videosShown?: number; videosWaiting?: number }
  // Materials and the whiteboard: what this page is showing or sending right now.
  | { type: "share"; state: "none" | "sending" | "receiving"; at: number }
  // A whiteboard that did not start on this page ("start"), or that the other person opened and this
  // page could not show ("view"): told, never swallowed, with Zoom's numeric error code when there is
  // one (8000–8006 for the whiteboard). Nothing else of Zoom's answer is kept (2026-11-18).
  | { type: "whiteboard"; state: "none" | "presenting" | "viewing"; problem?: "start" | "view"; code?: number | null; at: number }
  // This page's person is in the room from `count` other pages or devices as well (2026-11-19: on
  // the production site the tutor was in one lesson up to three times at once, and the student saw
  // and heard a different one than the tutor was using). Told when the count changes; 0 when gone.
  | { type: "duplicate"; count: number; at: number }
  // The vendor's id for the session this page joined. Nothing on the page shows it; the tutor's
  // page reports it where the server confirms such ids with the vendor.
  | { type: "session"; sessionId: string; at: number }
  // In-class chat (2026-11-12): one line, this page's own or someone else's. Never reported to iHear
  // and never saved: the page shows it until the room is left.
  | { type: "chat"; line: ChatLine; at: number }
  // The hands raised in the room right now (this page's own among them, marked self).
  | { type: "hands"; raised: RaisedHand[]; at: number }
  // Classroom 2.0 (2026-11-12): everyone in the room (this page's person among them, marked self),
  // for the names on the video tiles and the participants list; and who is talking right now
  // (Zoom's active speakers, loudest first). Neither is reported to iHear or saved.
  | { type: "people"; people: RoomPerson[]; at: number }
  | { type: "speaking"; ids: string[]; at: number };

// A person as the room shows them. The name is the participant code (the join passes the code as the
// display name, so no student's name reaches the video service); the host is the tutor. `video`:
// their video is drawn, waits for a free tile (P3-Multi), or is off.
export type RoomPerson = { id: string; name: string; host: boolean; self: boolean; camera: boolean; microphone: boolean; video: "shown" | "waiting" | "off" };

export type MediaCapabilities = {
  // True only for an adapter that really carries audio and video.
  realMedia: boolean;
  screenShare: boolean;
  // A whiteboard this page can start or show (LCIC's is inside Tencent's page).
  whiteboard: boolean;
  // False when the vendor's own page runs the call (LCIC): our page then sees no connection,
  // device or remote events, and the overview relies on the vendor's callbacks.
  observable: boolean;
  // In-class chat and raised hands on our own page (LCIC has its own, inside Tencent's page).
  chat: boolean;
  raiseHand: boolean;
};

export type MediaJoin = {
  sessionToken: string; lessonCode: string; participantCode: string; role: MediaRole;
  // Zoom: the topic the join token names. LCIC: Tencent's classroom address with its login.
  sessionName?: string; embedUrl?: string;
};

export interface ClassroomMediaAdapter {
  readonly provider: MediaProviderName;
  readonly capabilities: MediaCapabilities;
  join(input: MediaJoin): Promise<void>;
  leave(): Promise<void>;
  setDevice(kind: DeviceKind, on: boolean): Promise<DeviceState>;
  // Hear the room without the microphone (2026-11-20): joins the vendor's audio with the microphone
  // muted, on the person's own press; true once joined. Never turns the microphone on.
  joinSound?(): Promise<boolean>;
  subscribe(listener: (event: MediaEvent) => void): () => void;
  // Where the vendor draws: its classroom, the shared screen and the whiteboard in `element`, and
  // (Classroom 2.0) the people's tiles in `videos` when the page gives them a column of their own.
  // The synthetic stand-in draws tiles without any picture, and only when given `videos`.
  mount?(element: HTMLElement, videos?: HTMLElement): void;
  // What this browser supports, from the vendor's own check, before or after joining.
  systemCheck?(): Promise<MediaSystemCheck>;
  // The tutor's materials (sharing a screen, window or tab) and the whiteboard. True when started.
  setScreenShare?(on: boolean): Promise<boolean>;
  setWhiteboard?(on: boolean): Promise<boolean>;
  exportWhiteboard?(name: string): Promise<void>;
  // A chat line to everyone in the room; true once it was sent. A student raises or lowers their
  // own hand; the tutor lowers a student's (by the id a "hands" event gave). Nothing is saved.
  sendChat?(text: string): Promise<boolean>;
  setHand?(up: boolean): Promise<boolean>;
  lowerHand?(id: string): Promise<boolean>;
}

export type MediaSystemCheck = { sdkVersion: string; audio: boolean; video: boolean; screenShare: boolean; unsupported: string[] };

export class MediaAdapterUnavailableError extends Error {
  constructor(readonly provider: string, reason?: string) {
    super(reason ?? (MEDIA_PROVIDERS.includes(provider as MediaProviderName)
      ? `The ${provider} adapter is not available`
      : `Unknown video provider: ${provider || "(none)"}`));
  }
}

export type SyntheticScenario =
  | "remote-joins" | "remote-leaves" | "remote-camera-off" | "remote-camera-on"
  | "network-drop" | "network-restore" | "connection-failed"
  | "camera-denied" | "microphone-unavailable" | "devices-restored"
  | "remote-chat" | "remote-raises-hand" | "remote-lowers-hand"
  // Classroom 2.0 (2026-11-12): what the room's layout changes with, played without any picture.
  | "remote-shares-screen" | "remote-stops-sharing" | "remote-opens-whiteboard" | "remote-closes-whiteboard"
  | "remote-speaks" | "group-joins" | "group-leaves"
  // 2026-11-19: this page's person in the room from another page or device too, and that ending.
  | "self-elsewhere" | "self-elsewhere-ends"
  // 2026-11-20: the browser will not play the room's sound yet (cleared by "devices-restored").
  | "sound-blocked";

export const SYNTHETIC_SCENARIOS: readonly SyntheticScenario[] = [
  "remote-joins", "remote-leaves", "remote-camera-off", "remote-camera-on",
  "network-drop", "network-restore", "connection-failed",
  "camera-denied", "microphone-unavailable", "devices-restored",
  "remote-chat", "remote-raises-hand", "remote-lowers-hand",
  "remote-shares-screen", "remote-stops-sharing", "remote-opens-whiteboard", "remote-closes-whiteboard",
  "remote-speaks", "group-joins", "group-leaves",
  "self-elsewhere", "self-elsewhere-ends", "sound-blocked",
];
// The other person's line in the synthetic room: no real person writes it.
const SYNTHETIC_CHAT = "TEST: Hello / 你好 / 你好";
// Five more students for a group room in the test classroom (P3-Multi rooms hold up to 10): test
// codes only, some with the camera or microphone off, so the layout shows every kind of tile.
const SYNTHETIC_GROUP = ["TEST-S02", "TEST-S03", "TEST-S04", "TEST-S05", "TEST-S06"] as const;
// How long a ring stays around someone who stopped talking (Zoom reports talkers, not silence).
const SPEAKING_MS = 2_000;
// How long after Zoom's list of people changes the page looks at whose camera is on (2026-11-19).
const VIDEO_CHECK_MS = 1_000;
// After Zoom's own reconnect: how long to wait before asking Zoom a second time, when its first answer
// would close something on this page or it could not answer yet (2026-11-18).
const RESYNC_RETRY_MS = 2_000;

// Classroom 2.0 (2026-11-12): one tile per person inside the videos container, the way Zoom's own
// documentation places a video (a video-player inside a tile inside the video-player-container).
// The adapter keeps the tiles and puts each video into its person's tile; the page writes the name,
// microphone, raised hand and the rest into them. Only plain facts go on a tile, never words.
export class MediaTiles {
  private readonly cells = new Map<string, HTMLElement>();
  constructor(private readonly container: HTMLElement) {}

  // A tile for each person now in the room, in the order they came; the tiles of people who left go.
  sync(people: readonly RoomPerson[]) {
    const here = new Set(people.map((person) => person.id));
    for (const [id, cell] of this.cells) {
      if (here.has(id)) continue;
      cell.remove();
      this.cells.delete(id);
    }
    for (const person of people) {
      const cell = this.cellOf(person.id);
      cell.className = `classroom-media-tile ${person.self ? "self" : "remote"}`;
      cell.setAttribute("data-host", String(person.host));
      cell.setAttribute("data-self", String(person.self));
      cell.setAttribute("data-video", person.video);
    }
  }

  cellOf(id: string) {
    let cell = this.cells.get(id);
    if (!cell) {
      cell = this.container.ownerDocument.createElement("div");
      cell.className = "classroom-media-tile";
      cell.setAttribute("data-person", id);
      this.cells.set(id, cell);
      this.container.append(cell);
    }
    return cell;
  }

  clear() {
    for (const cell of this.cells.values()) cell.remove();
    this.cells.clear();
  }
}

type SyntheticOptions = { connectDelayMs?: number; now?: () => number; speakingMs?: number };

export class SyntheticMediaAdapter implements ClassroomMediaAdapter {
  readonly provider = "synthetic" as const;
  // Sharing and the whiteboard are played as states only (Classroom 2.0): the test room has no picture.
  readonly capabilities: MediaCapabilities = { realMedia: false, screenShare: true, whiteboard: true, observable: true, chat: true, raiseHand: true };
  private readonly listeners = new Set<(event: MediaEvent) => void>();
  private connection: ConnectionState = "idle";
  private readonly devices: Record<DeviceKind, DeviceState> = { camera: "off", microphone: "off" };
  private readonly blocked: Record<DeviceKind, DeviceState | null> = { camera: null, microphone: null };
  // Hearing the room, played as a state (2026-11-20), and the browser refusing to play it yet.
  private sound: SoundState = "off";
  private soundBlocked = false;
  private remote = { present: false, camera: false, microphone: false };
  // Chat and raised hands stay on this page: nothing travels to another page or the server.
  private role: MediaRole = "student";
  private readonly hands = new Map<string, RaisedHand>();
  private lines = 0;
  private readonly connectDelayMs: number;
  private readonly now: () => number;
  // Classroom 2.0: this page's code, the played share and whiteboard, a group of test students, the
  // tiles (only when the page gave them a place) and who is talking.
  private participantCode = "";
  private sharing: "none" | "sending" | "receiving" = "none";
  private board: "none" | "presenting" | "viewing" = "none";
  private group = false;
  private tiles: MediaTiles | null = null;
  private peopleKey = "[]";
  private speaking = "";
  private speakingTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly speakingMs: number;

  constructor(options: SyntheticOptions = {}) {
    this.connectDelayMs = options.connectDelayMs ?? 300;
    this.now = options.now ?? Date.now;
    this.speakingMs = options.speakingMs ?? SPEAKING_MS;
  }

  // The tiles go into the page's video column; with no column given, nothing is drawn (as before).
  mount(_element: HTMLElement, videos?: HTMLElement) {
    if (!videos) return;
    const container = videos.ownerDocument.createElement("div");
    container.className = "classroom-media-videos synthetic";
    videos.replaceChildren(container);
    this.tiles = new MediaTiles(container);
    this.reportPeople();
  }

  get state() {
    return { connection: this.connection, devices: { ...this.devices }, remote: { ...this.remote } };
  }

  subscribe(listener: (event: MediaEvent) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async join(input: MediaJoin) {
    if (!input.sessionToken) throw new Error("A session token from the join check is required");
    if (this.connection === "connected" || this.connection === "connecting") return;
    this.role = input.role;
    this.participantCode = input.participantCode;
    // Joining again (after a failure) starts with the camera and microphone off, as Zoom's does: its
    // old client is released first and a new one joins (ZoomVideoSdkMediaAdapter.teardown). A
    // blocked device stays blocked.
    for (const kind of ["camera", "microphone"] as const) {
      if (this.devices[kind] !== "on" && this.devices[kind] !== "starting") continue;
      this.devices[kind] = "off";
      this.emit({ type: "device", kind, state: "off", at: this.now() });
    }
    this.setConnection("connecting");
    if (this.connectDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.connectDelayMs));
    // leave() or a simulated failure may have happened while connecting.
    if ((this.connection as ConnectionState) !== "connecting") return;
    this.setConnection("connected");
  }

  async leave() {
    if (this.connection === "idle" || this.connection === "disconnected") return;
    this.group = false;
    this.setRemote({ present: false, camera: false, microphone: false });
    this.clearHands();
    this.endPlayed();
    this.setSound("off");
    this.setConnection("disconnected");
  }

  async setDevice(kind: DeviceKind, on: boolean) {
    const state: DeviceState = this.blocked[kind] ?? (on ? "on" : "off");
    this.devices[kind] = state;
    this.reportPeople();
    this.emit({ type: "device", kind, state, at: this.now() });
    // The microphone joins the room's sound as well, as Zoom's first microphone press does.
    if (kind === "microphone" && state === "on") this.setSound("on");
    return state;
  }

  // "Turn on sound": the room is heard with the microphone off. A microphone the browser blocks
  // (Zoom's muted join still needs it) or a sound the browser will not play yet makes it fail.
  async joinSound() {
    if (this.connection !== "connected") return false;
    if (this.sound === "on") return true;
    if (this.soundBlocked || this.blocked.microphone) {
      this.setSound("failed", this.soundBlocked ? "autoplay" : "capture");
      return false;
    }
    this.setSound("on");
    return true;
  }

  private setSound(state: SoundState, problem?: SoundProblem) {
    if (this.sound === state && state !== "failed") return;
    this.sound = state;
    this.emit({ type: "sound", state, ...(problem ? { problem } : {}), at: this.now() });
  }

  // The tutor's own share and whiteboard, played as states only: nothing is captured or sent.
  async setScreenShare(on: boolean) {
    if (this.connection !== "connected") return false;
    if (!on) {
      if (this.sharing === "sending") this.setShare("none");
      return false;
    }
    this.setShare("sending");
    return true;
  }

  async setWhiteboard(on: boolean) {
    if (this.connection !== "connected" || this.role !== "tutor") return false;
    if (!on) {
      if (this.board === "presenting") this.setBoard("none");
      return false;
    }
    this.setBoard("presenting");
    return true;
  }

  // This page's own line, shown back to it; there is nobody real to send it to.
  async sendChat(value: string) {
    const text = chatTextOf(value);
    if (!text || this.connection !== "connected") return false;
    this.emit({ type: "chat", line: { id: `synthetic-${++this.lines}`, from: "self", name: "", text, at: this.now() }, at: this.now() });
    return true;
  }

  // A student's own hand; a tutor has none to raise.
  async setHand(up: boolean) {
    if (this.role === "tutor" || this.connection !== "connected") return false;
    this.setHandOf({ id: "self", name: "", self: true }, up);
    return true;
  }

  async lowerHand(id: string) {
    if (this.role !== "tutor" || this.connection !== "connected" || !this.hands.has(id)) return false;
    this.setHandOf({ id, name: "", self: false }, false);
    return true;
  }

  private setHandOf(hand: RaisedHand, up: boolean) {
    if (up) this.hands.set(hand.id, hand);
    else if (!this.hands.delete(hand.id)) return;
    this.emit({ type: "hands", raised: [...this.hands.values()], at: this.now() });
  }

  private clearHands() {
    if (this.hands.size === 0) return;
    this.hands.clear();
    this.emit({ type: "hands", raised: [], at: this.now() });
  }

  // The cases a demonstration or a test needs; a real SDK reports them on its own.
  simulate(scenario: SyntheticScenario) {
    switch (scenario) {
      case "remote-joins":
        if (this.connection === "connected") this.setRemote({ present: true, camera: true, microphone: true });
        break;
      case "remote-leaves":
        this.setRemote({ present: false, camera: false, microphone: false });
        break;
      case "remote-camera-off":
      case "remote-camera-on":
        if (this.remote.present) this.setRemote({ ...this.remote, camera: scenario === "remote-camera-on" });
        break;
      case "network-drop":
        if (this.connection === "connected") this.setConnection("reconnecting");
        break;
      case "network-restore":
        if (this.connection === "reconnecting") this.setConnection("connected");
        break;
      case "connection-failed":
        if (this.connection !== "idle") {
          this.group = false;
          this.setRemote({ present: false, camera: false, microphone: false });
          this.endPlayed();
          this.setSound("off");
          this.setConnection("failed");
        }
        break;
      case "sound-blocked":
        this.soundBlocked = true;
        break;
      case "camera-denied":
        this.block("camera", "denied");
        break;
      case "microphone-unavailable":
        this.block("microphone", "unavailable");
        break;
      case "devices-restored":
        this.soundBlocked = false;
        for (const kind of ["camera", "microphone"] as const) {
          if (!this.blocked[kind]) continue;
          this.blocked[kind] = null;
          this.devices[kind] = "off";
          this.reportPeople();
          this.emit({ type: "device", kind, state: "off", at: this.now() });
        }
        break;
      // The other person's chat line and hand (the tutor's page shows a student's raised hand).
      case "remote-chat":
        if (this.connection === "connected") {
          const from: ChatFrom = this.role === "tutor" ? "student" : "tutor";
          this.emit({ type: "chat", line: { id: `synthetic-${++this.lines}`, from, name: "", text: SYNTHETIC_CHAT, at: this.now() }, at: this.now() });
        }
        break;
      case "remote-raises-hand":
        if (this.connection === "connected" && this.role === "tutor") this.setHandOf({ id: "remote", name: "", self: false }, true);
        break;
      case "remote-lowers-hand":
        this.setHandOf({ id: "remote", name: "", self: false }, false);
        break;
      // Classroom 2.0: the other side's share and whiteboard (states only), a voice, and a group.
      case "remote-shares-screen":
        if (this.connection === "connected" && this.sharing !== "sending") this.setShare("receiving");
        break;
      case "self-elsewhere":
        if (this.connection === "connected") this.emit({ type: "duplicate", count: 1, at: this.now() });
        break;
      case "self-elsewhere-ends":
        this.emit({ type: "duplicate", count: 0, at: this.now() });
        break;
      case "remote-stops-sharing":
        if (this.sharing === "receiving") this.setShare("none");
        break;
      case "remote-opens-whiteboard":
        if (this.connection === "connected" && this.board !== "presenting") this.setBoard("viewing");
        break;
      case "remote-closes-whiteboard":
        if (this.board === "viewing") this.setBoard("none");
        break;
      case "remote-speaks":
        if (this.remote.present) this.hearSpeakers(["remote"]);
        break;
      case "group-joins":
      case "group-leaves": {
        const joining = scenario === "group-joins";
        if (joining === this.group || (joining && this.connection !== "connected")) break;
        this.group = joining;
        this.reportPeople();
        this.emitRemote();
        break;
      }
    }
  }

  private block(kind: DeviceKind, state: DeviceState) {
    this.blocked[kind] = state;
    this.devices[kind] = state;
    this.reportPeople();
    this.emit({ type: "device", kind, state, at: this.now() });
  }

  private setConnection(state: ConnectionState) {
    if (this.connection === state) return;
    this.connection = state;
    this.emit({ type: "connection", state, at: this.now() });
    this.reportPeople();
  }

  private setRemote(next: { present: boolean; camera: boolean; microphone: boolean }) {
    if (next.present === this.remote.present && next.camera === this.remote.camera && next.microphone === this.remote.microphone) return;
    this.remote = next;
    if (!next.present) this.setSpeaking([]);
    this.reportPeople();
    this.emitRemote();
  }

  // The synthetic room has no real other person, so there is no user key to report. With the test
  // group in, it says how many others there are, as a real room of several does (P3-Multi).
  private emitRemote() {
    const others = (this.remote.present ? 1 : 0) + SYNTHETIC_GROUP.length;
    this.emit({ type: "remote", ...this.remote, userKey: null, at: this.now(), ...(this.group ? { others } : {}) });
  }

  // Everyone in the test room as the page shows them, and their tiles. The other person has no code
  // here (the test room cannot see them); the group's students have test codes.
  private reportPeople() {
    const people: RoomPerson[] = [];
    if (this.connection === "connected" || this.connection === "reconnecting") {
      const tutor = this.role === "tutor";
      if (this.remote.present) people.push({ id: "remote", name: "", host: !tutor, self: false, camera: this.remote.camera, microphone: this.remote.microphone, video: this.remote.camera ? "shown" : "off" });
      if (this.group) {
        SYNTHETIC_GROUP.forEach((code, index) => {
          const camera = index % 3 !== 2;
          people.push({ id: code, name: code, host: false, self: false, camera, microphone: index % 2 === 0, video: camera ? "shown" : "off" });
        });
      }
      const camera = this.devices.camera === "on";
      people.push({ id: "self", name: this.participantCode, host: tutor, self: true, camera, microphone: this.devices.microphone === "on", video: camera ? "shown" : "off" });
    }
    this.tiles?.sync(people);
    const key = JSON.stringify(people);
    if (key === this.peopleKey) return;
    this.peopleKey = key;
    this.emit({ type: "people", people, at: this.now() });
  }

  private setShare(state: "none" | "sending" | "receiving") {
    if (this.sharing === state) return;
    this.sharing = state;
    this.emit({ type: "share", state, at: this.now() });
  }

  private setBoard(state: "none" | "presenting" | "viewing") {
    if (this.board === state) return;
    this.board = state;
    this.emit({ type: "whiteboard", state, at: this.now() });
  }

  // Leaving or failing ends the played share, whiteboard and voices.
  private endPlayed() {
    this.setShare("none");
    this.setBoard("none");
    this.setSpeaking([]);
  }

  private hearSpeakers(ids: string[]) {
    clearTimeout(this.speakingTimer);
    this.setSpeaking(ids);
    if (ids.length > 0) this.speakingTimer = setTimeout(() => this.setSpeaking([]), this.speakingMs);
  }

  private setSpeaking(ids: string[]) {
    const key = ids.join(",");
    if (key === this.speaking) return;
    if (ids.length === 0) clearTimeout(this.speakingTimer);
    this.speaking = key;
    this.emit({ type: "speaking", ids, at: this.now() });
  }

  private emit(event: MediaEvent) {
    for (const listener of this.listeners) listener(event);
  }
}

// The part of the Zoom Video SDK (web 2.x) this adapter uses, as the official package declares it.
// OfficialZoomSdk below makes TypeScript check every call against @zoom/videosdk's own types, so a
// missing or changed call fails the type check; the tests stand in for the SDK with this shape.
export type ZoomParticipant = { userId: number; userIdentity?: string; userKey?: string; bVideoOn?: boolean; muted?: boolean; audio?: string; isHost?: boolean; displayName?: string };
// In-class chat (2026-11-12): Zoom's ChatMessage, as far as this page reads it, and the two calls
// it makes. Privilege 5 is ChatPrivilege.EveryonePublicly: everyone writes to everyone, nobody privately.
export type ZoomChatMessage = { id?: string; message?: string; file?: unknown; sender?: { userId?: number; name?: string }; timestamp?: number };
export type ZoomChat = { sendToAll(text: string): Promise<unknown>; setPrivilege(privilege: number): unknown };
// The command channel carries raised hands; without a target a message goes to the whole session.
export type ZoomCommand = { send(text: string, target?: number): Promise<unknown> };
export type ZoomStream = {
  // `mute`: Zoom's documented option "join audio with microphone muted" ("Turn on sound", 2026-11-20).
  startAudio(options?: { mute?: boolean }): Promise<unknown>; stopAudio(): Promise<unknown>; muteAudio(): Promise<unknown>; unmuteAudio(): Promise<unknown>;
  isAudioMuted?(): boolean;
  startVideo(): Promise<unknown>; stopVideo(): Promise<unknown>; isCapturingVideo(): boolean;
  attachVideo(userId: number, quality: number): Promise<unknown>; detachVideo(userId: number): Promise<unknown>;
  // Materials: the tutor shares a screen, window or tab; the other side sees it in a container of its own.
  isStartShareScreenWithVideoElement(): boolean;
  startShareScreen(target: HTMLCanvasElement | HTMLVideoElement): Promise<unknown>;
  stopShareScreen(): Promise<unknown>;
  getActiveShareUserId(): number;
  attachShareView(userId: number): Promise<unknown>;
  detachShareView(userId: number): Promise<unknown>;
};
export type ZoomWhiteboard = {
  isWhiteboardEnabled(): boolean;
  canStartWhiteboard(): boolean;
  startWhiteboardScreen(element: HTMLElement): Promise<unknown>;
  stopWhiteboardScreen(): Promise<unknown>;
  startWhiteboardView(element: HTMLElement, presenterId: number): Promise<unknown>;
  stopWhiteboardView(): Promise<unknown>;
  exportWhiteboard(format: "pdf", name?: string): Promise<unknown>;
  // Who presents a whiteboard now, or null (Zoom 2.3.5+).
  getWhiteboardPresenter?(): { userId?: number } | null;
};
export type ZoomClient = {
  init(language: string, dependentAssets: string, options?: { patchJsMedia?: boolean; leaveOnPageUnload?: boolean }): Promise<unknown>;
  join(topic: string, token: string, userName: string): Promise<unknown>;
  leave(): Promise<unknown>;
  getMediaStream(): ZoomStream;
  getWhiteboardClient(): ZoomWhiteboard;
  // Present in Zoom's client; a stand-in without them simply has no chat or raised hands.
  getChatClient?(): ZoomChat;
  getCommandClient?(): ZoomCommand;
  getCurrentUserInfo(): { userId: number; audio?: string; isHost?: boolean; displayName?: string } | null;
  getAllUser(): ZoomParticipant[];
  // Video SDK 2.6.0: SessionInfo.sessionId, Zoom's id for the session joined.
  getSessionInfo?(): { sessionId?: string } | null;
  on(event: string, handler: (payload: unknown) => void): void;
  off(event: string, handler: (payload: unknown) => void): void;
};
export type ZoomVideoSdk = {
  VERSION: string;
  // Returns the same client every time until destroyClient() (Zoom's typings for 2.6.0).
  createClient(): ZoomClient;
  destroyClient(): Promise<void>;
  checkSystemRequirements(): { audio: boolean; video: boolean; screen: boolean };
  checkFeatureRequirements(): { unSupportFeatures: string[] };
};
type MustProvide<Shape, Real extends Shape> = Real;
export type OfficialZoomSdk = MustProvide<ZoomVideoSdk, typeof ZoomVideo>;

// The official package, loaded only in the browser and only when a Zoom room opens, so its code
// stays out of every other page. Its WebAssembly and worker files come from Zoom's "Global"
// location (https://source.zoom.us/videosdk/<version>/lib/), which the classroom's CSP allows.
export async function loadZoomVideoSdkPackage(): Promise<ZoomVideoSdk> {
  if (typeof window === "undefined") throw new MediaAdapterUnavailableError("zoom-video-sdk", "The Zoom Video SDK runs only in a browser");
  const official = await import("@zoom/videosdk");
  return official.default;
}

const ZOOM_CONNECTION: Record<string, ConnectionState> = { Connected: "connected", Reconnecting: "reconnecting", Closed: "disconnected", Fail: "failed" };
const VIDEO_720P = 3;
// From the fourth video on, each is drawn at 360p (P3-Multi): several 720p videos at once are more
// than a phone or a slow connection carries. One or two people: 720p, as before.
const VIDEO_360P = 2;
// Remote videos drawn at once: Zoom's web rendering limit less this page's own (a computer 25, a
// phone or tablet 9); the others wait for a free tile.
export const MAX_REMOTE_VIDEOS = { desktop: 24, mobile: 8 } as const;
// How long a press of the camera or microphone may wait for Zoom before the page says it is taking
// long and offers to try again. Starting normally takes a second or two; on a slow computer Zoom
// took more than 10 seconds (real Zoom, 2026-11-18), and its answer still counts when it comes later.
const DEVICE_START_MS = 20_000;
// Zoom's whiteboard error codes (SDK 2.6.0 exception codes) the room words on its own: the account
// has no whiteboard (8000); this platform has none, phones for example (8001); a screen is being
// shared, and Zoom does not open its whiteboard then (8002); only the host may (8004). Any other
// code (8003, 8005, 8006, or one Zoom adds later) is shown as a number with the general words.
export const ZOOM_WHITEBOARD_ACCOUNT_DISABLE = 8000;
export const ZOOM_WHITEBOARD_UNSUPPORTED = 8001;
export const ZOOM_WHITEBOARD_SCREEN_SHARE_CONFLICT = 8002;
export const ZOOM_WHITEBOARD_HOST_PRIVILEGE_REQUIRED = 8004;
// Zoom's answer to a refused call: only its numeric code is kept. Zoom's words, addresses and
// anything else are dropped, so nothing private (a token, a link) reaches the page, its console or
// a report.
function zoomErrorCodeOf(error: unknown): number | null {
  const code = error && typeof error === "object" ? (error as { errorCode?: unknown }).errorCode : undefined;
  return typeof code === "number" && Number.isInteger(code) && code >= 0 && code < 100_000 ? code : null;
}
type DeviceAnswer = { state: DeviceState; problem?: DeviceProblem };
// "Turn on sound" refused: Zoom's muted audio still needs the microphone, so a microphone that is
// blocked, missing or busy (Zoom's AUDIO_CAPTURE_FAILED among them) is "capture"; anything else "error".
function soundProblemOf(error: unknown): SoundProblem {
  const { type, reason } = (error ?? {}) as { type?: string; reason?: string };
  if (/AUDIO_CAPTURE_FAILED|INSUFFICIENT_PRIVILEGES/i.test(`${type ?? ""} ${reason ?? ""}`)) return "capture";
  const answer = deviceAnswerOf(error);
  return answer.state === "denied" || answer.problem === "missing" || answer.problem === "busy" ? "capture" : "error";
}
// A refused start: blocked by the person or the browser, or worth another try (and why).
function deviceAnswerOf(error: unknown): DeviceAnswer {
  const { name, type, reason, message } = (error ?? {}) as { name?: string; type?: string; reason?: string; message?: string };
  const text = `${type ?? ""} ${reason ?? ""} ${message ?? ""}`;
  if (name === "NotAllowedError" || name === "SecurityError" || /PERMISSION|denied|not allowed/i.test(text)) return { state: "denied" };
  if (name === "NotFoundError" || name === "OverconstrainedError" || /not ?found|no (camera|microphone|device)/i.test(text)) return { state: "failed", problem: "missing" };
  if (name === "NotReadableError" || /in use|could not start|busy/i.test(text)) return { state: "failed", problem: "busy" };
  return { state: "failed", problem: "error" };
}
const isNode = (value: unknown): value is Node => Boolean(value) && typeof (value as Node).nodeType === "number";
type ZoomStage = { videos: HTMLElement; share: HTMLElement; whiteboard: HTMLElement; ownShare: HTMLElement };
type ZoomHandler = [string, (payload: unknown) => void];
// The states in which this page's client is in the session or on its way there (Zoom reconnects
// by itself while "reconnecting"): joining again leaves such a room alone.
const ZOOM_IN_SESSION = new Set<ConnectionState>(["connecting", "connected", "reconnecting"]);
// Zoom's client is one shared instance per page until it is destroyed, so a room waits for the
// previous room on this page to finish releasing it before taking it.
let zoomReleased: Promise<void> = Promise.resolve();
// ChatPrivilege.EveryonePublicly in @zoom/videosdk 2.6.0: no private messages between participants.
const CHAT_PUBLIC_ONLY = 5;
// How many chat ids a page remembers, so a line Zoom delivers twice is shown once.
const CHAT_IDS_KEPT = 500;
// Zoom answers a call that did not go through with { type, reason, errorCode } rather than throwing.
const isZoomFailure = (answer: unknown) => !answer || (typeof answer === "object" && "errorCode" in answer && !("sender" in answer));

export class ZoomVideoSdkMediaAdapter implements ClassroomMediaAdapter {
  readonly provider = "zoom-video-sdk" as const;
  readonly capabilities: MediaCapabilities = { realMedia: true, screenShare: true, whiteboard: true, observable: true, chat: true, raiseHand: true };
  // Chat and raised hands (2026-11-12): who this page is, the hands raised in this session (by
  // Zoom user id), whether this page's own hand is up, and the chat ids already shown.
  private role: MediaRole = "student";
  private readonly hands = new Map<number, RaisedHand>();
  private handUp = false;
  private readonly chatIds = new Set<string>();
  private ownLines = 0;
  private readonly listeners = new Set<(event: MediaEvent) => void>();
  private sdk: Promise<ZoomVideoSdk> | null = null;
  private client: ZoomClient | null = null;
  private stream: ZoomStream | null = null;
  private stage: ZoomStage | null = null;
  private audioStarted = false;
  // Hearing the room (2026-11-20): its state; "Turn on sound" on its way; and `soundOnly`: Zoom's
  // audio was joined for the sound with the microphone muted, so Zoom's "joined the audio" is not the
  // microphone going on (until the person presses the microphone); `soundBlockedNow`: the browser
  // refused to play the sound during that join.
  private sound: SoundState = "off";
  private soundJoin: Promise<boolean> | null = null;
  private soundOnly = false;
  private soundBlockedNow = false;
  private sharing: "none" | "sending" | "receiving" = "none";
  private sharer: number | null = null;
  private board: "none" | "presenting" | "viewing" = "none";
  // Whose whiteboard this page views, or is starting to view (2026-11-18).
  private viewedPresenter: number | null = null;
  private readonly tiles = new Map<number, unknown>();
  // Remote videos that are on but wait for a free tile (P3-Multi), in the order they started.
  private readonly waitingVideos = new Set<number>();
  private readonly maxVideos: number;
  // The listeners of the current client, removed when it is released.
  private handlers: ZoomHandler[] = [];
  private connection: ConnectionState = "idle";
  // The join on its way, so a second press waits for it; and a count that tells a join still on
  // its way that the room was left (or rejoined) meanwhile.
  private joining: Promise<void> | null = null;
  private attempt = 0;
  // Zoom keeps a page that was cut off (or closed without leaving) in its list of people for
  // minutes (real Zoom, 2026-11-19: about 3 to 4.5 minutes). Meanwhile the person who came back is
  // there twice: others saw two tiles of one student, and the student was told "you also entered
  // elsewhere" about a page that no longer existed. So this page remembers the ids Zoom gave its
  // own earlier joins in this session (they are never "elsewhere"), and of several entries with one
  // participant id it keeps the one that came last (usersNow).
  private pastSelf = new Set<number>();
  // The id Zoom gives this page now. Zoom gives a NEW id on every reconnect, its own included, and
  // after a failed connection the old client no longer says its id (real Zoom probe, 2026-11-19:
  // the page's own earlier entry stayed on its own page as another person, with the "entered
  // elsewhere" notice). So the id is remembered while it is known, and becomes a past one the
  // moment Zoom reports a different one.
  private selfId: number | null = null;
  private firstSeen = new Map<number, number>();
  private looks = 0;
  // The room (session name) this page joined last; a join to another room moves there (D-5).
  private sessionName: string | null = null;
  // This page's camera and microphone, the latest press of each, and the press now waiting for Zoom.
  private readonly devices: Record<DeviceKind, DeviceState> = { camera: "off", microphone: "off" };
  // Why each device's last press failed, while it is "failed".
  private readonly problems: Partial<Record<DeviceKind, DeviceProblem>> = {};
  private readonly presses: Record<DeviceKind, number> = { camera: 0, microphone: 0 };
  private readonly waiting: Partial<Record<DeviceKind, (answer: DeviceAnswer) => void>> = {};
  // Zoom's start call for each device while it is still on its way: Zoom may answer it after the
  // deadline, and "Try again" gives it one more deadline instead of stopping it.
  private readonly calls: Partial<Record<DeviceKind, Promise<void>>> = {};
  // Presses made while Zoom is still finishing the join, waiting for its media stream.
  private readonly streamWaiters = new Set<() => void>();
  private readonly deviceStartMs: number;
  // Classroom 2.0 (2026-11-12): one tile per person in the videos container, the people last told
  // to the page, and who is talking (Zoom's "active-speaker"; the ring goes a moment after it stops).
  private peopleTiles: MediaTiles | null = null;
  private peopleKey = "[]";
  private speaking = "";
  private speakingTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly speakingMs: number;
  // The check after Zoom's own reconnect (2026-11-18): one at a time (a reconnect during it asks for
  // one more afterwards), how many whiteboard views have been shown so far and how many are still
  // opening, and the moment waited before Zoom is asked again.
  private resyncing: Promise<void> | null = null;
  private resyncAgain = false;
  private boardViews = 0;
  private boardStarting = 0;
  private readonly resyncRetryMs: number;
  // The look at whose camera is on, a moment after Zoom's list of people changed (checkVideos), and
  // how many other pages or devices this page's person is in the room from as well.
  private videosTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly videoCheckMs: number;
  private elsewhere = 0;

  constructor(private readonly load: () => Promise<ZoomVideoSdk> = loadZoomVideoSdkPackage, private readonly now: () => number = Date.now, options: { deviceStartMs?: number; maxVideos?: number; speakingMs?: number; resyncRetryMs?: number; videoCheckMs?: number } = {}) {
    this.deviceStartMs = options.deviceStartMs ?? DEVICE_START_MS;
    this.maxVideos = options.maxVideos ?? MAX_REMOTE_VIDEOS.desktop;
    this.speakingMs = options.speakingMs ?? SPEAKING_MS;
    this.resyncRetryMs = options.resyncRetryMs ?? RESYNC_RETRY_MS;
    this.videoCheckMs = options.videoCheckMs ?? VIDEO_CHECK_MS;
  }

  subscribe(listener: (event: MediaEvent) => void) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  // Zoom draws each video into a <video-player-container> and a shared screen into another one
  // (its rule: the two are never mixed); the whiteboard and the tutor's own share get plain elements.
  // Classroom 2.0: the videos container may go into a column of its own (`videos`). Either way every
  // part is placed once, here, before anything is drawn, and never moved afterwards.
  mount(element: HTMLElement, videos?: HTMLElement) {
    const part = (tag: string, name: string, hidden: boolean) => {
      const child = element.ownerDocument.createElement(tag);
      child.className = `classroom-zoom-${name}`;
      child.hidden = hidden;
      return child;
    };
    this.stage = {
      share: part("video-player-container", "share", true), whiteboard: part("div", "whiteboard", true),
      videos: part("video-player-container", "videos", false), ownShare: part("div", "own-share", true),
    };
    if (videos) {
      element.replaceChildren(this.stage.share, this.stage.whiteboard, this.stage.ownShare);
      videos.replaceChildren(this.stage.videos);
    } else {
      element.replaceChildren(this.stage.share, this.stage.whiteboard, this.stage.videos, this.stage.ownShare);
    }
    this.peopleTiles = new MediaTiles(this.stage.videos);
  }

  // Zoom's own check of this browser (audio, video, screen sharing), without joining anything.
  async systemCheck(): Promise<MediaSystemCheck> {
    const sdk = await this.loadOnce();
    const support = sdk.checkSystemRequirements();
    return { sdkVersion: sdk.VERSION, audio: support.audio, video: support.video, screenShare: support.screen, unsupported: [...sdk.checkFeatureRequirements().unSupportFeatures] };
  }

  // Joining, and joining again after Zoom reported the session failed or closed. A second press
  // while joining waits for that join; a room that is in the session, or that Zoom is
  // reconnecting by itself, is left alone. After a failure the old client is finished: it is
  // released first and a new one joins with the new token. (R-2, 2026-11-06: before, join()
  // returned at once because the old client was still set, so "Connect again" did nothing.)
  // A join to another room (a new generation, D-1/D-5) leaves the current one first: the same
  // release-and-join as after a failure, never two sessions at once.
  async join(input: MediaJoin) {
    if (!input.sessionToken || !input.sessionName) throw new Error("A Zoom join token and its session name are required");
    if (this.joining) return this.joining;
    if (this.client && ZOOM_IN_SESSION.has(this.connection) && input.sessionName === this.sessionName) return;
    if (input.sessionName !== this.sessionName) { this.pastSelf.clear(); this.firstSeen.clear(); this.selfId = null; }
    this.sessionName = input.sessionName;
    const joining = this.connect({ ...input, sessionName: input.sessionName });
    this.joining = joining;
    try {
      await joining;
    } finally {
      if (this.joining === joining) this.joining = null;
    }
  }

  private async connect(input: MediaJoin & { sessionName: string }) {
    const attempt = ++this.attempt;
    // The client of a session that failed or closed: released, never reused.
    if (this.client) await this.teardown();
    if (attempt !== this.attempt) return;
    this.role = input.role;
    this.setConnection("connecting");
    let client: ZoomClient | null = null;
    const listening: ZoomHandler[] = [];
    // This join was overtaken (the room was left meanwhile): leave what it joined, so nobody stays
    // behind in the session. Its client was already destroyed by the leaving, so it is not
    // destroyed again (that would destroy a newer room's client).
    const overtaken = async () => {
      if (attempt === this.attempt) return false;
      if (client) await this.release(client, listening.splice(0), false);
      return true;
    };
    try {
      await zoomReleased;
      const sdk = await this.loadOnce();
      if (attempt !== this.attempt) return;
      const zoom = sdk.createClient();
      client = zoom;
      this.client = zoom;
      this.handlers = listening;
      // "Global": the default data centres; the China options are not part of phase 1.
      await zoom.init("en-US", "Global", { patchJsMedia: true, leaveOnPageUnload: true });
      if (await overtaken()) return;
      const listen = (name: string, handler: (payload: unknown) => void) => {
        zoom.on(name, handler);
        listening.push([name, handler]);
      };
      listen("connection-change", (payload) => {
        const state = ZOOM_CONNECTION[String((payload as { state?: string })?.state)];
        // Zoom says "Connected" before join() has finished. The room counts as connected, and its
        // buttons work, only once join() has given the media stream (seen in the real trial: a
        // camera pressed in between did nothing).
        if (state === "connected" && !this.stream) return;
        if (!state) return;
        // Back after Zoom reconnected by itself: what changed meanwhile is asked again (resyncAfterReconnect).
        const back = state === "connected" && this.connection === "reconnecting";
        this.setConnection(state);
        if (back) void this.resyncAfterReconnect();
      });
      // Someone new hears this page's raised hand again (Zoom keeps no hands of its own); someone who
      // leaves takes theirs along.
      listen("user-added", () => {
        this.reportRemote();
        this.scheduleVideoCheck();
        if (this.handUp) void this.sendCommand(handCommand(true));
      });
      listen("user-updated", () => {
        this.reportRemote();
        this.scheduleVideoCheck();
      });
      listen("user-removed", (payload) => {
        this.reportRemote();
        this.dropHands(payload);
        this.scheduleVideoCheck();
      });
      // Who is talking, loudest first (Zoom's ActiveSpeaker list), for the ring around their tile.
      listen("active-speaker", (payload) => this.hearSpeakers(payload));
      listen("chat-on-message", (payload) => this.receiveChat(payload as ZoomChatMessage));
      listen("command-channel-message", (payload) => this.receiveCommand(payload as { senderId?: number; text?: string }));
      listen("peer-video-state-change", (payload) => void this.peerVideo(payload as { action?: string; userId?: number }));
      listen("active-share-change", (payload) => void this.remoteShare(payload as { state?: string; userId?: number }));
      // The browser's own "stop sharing" button.
      listen("passively-stop-share", () => this.endOwnShare());
      listen("peer-whiteboard-state-change", (payload) => void this.remoteBoard(payload as { action?: string; userId?: number }));
      // Zoom's own reports on this page's camera and microphone. They settle a press even when the
      // call that started it never answers (seen when a device was pressed the moment both had
      // joined), and keep the buttons true when something else changes a device. Zoom 2.x marks
      // its old "media-sdk-change" readiness event as deprecated and always successful.
      listen("video-capturing-change", (payload) => {
        const state = (payload as { state?: string })?.state;
        if (state === "Started") this.fromZoom("camera", { state: "on" });
        else if (state === "Failed") this.fromZoom("camera", { state: "failed", problem: "capture" });
        else if (state === "Stopped" && this.devices.camera === "on") this.fromZoom("camera", { state: "off" });
      });
      listen("current-audio-change", (payload) => {
        const action = (payload as { action?: string })?.action;
        if (action === "join") { this.audioStarted = true; this.setSound("on"); }
        if (action === "leave") { this.audioStarted = false; this.soundOnly = false; this.setSound("off"); }
        // Joined for the sound only ("Turn on sound", microphone muted): the microphone stays off.
        if (action === "join" && this.soundOnly) return;
        if (action === "join" || action === "unmuted") this.fromZoom("microphone", { state: "on" });
        else if ((action === "muted" || action === "leave") && this.devices.microphone === "on") this.fromZoom("microphone", { state: "off" });
      });
      // Zoom: this "may occur when invoking stream.startAudio() immediately after joining"; the
      // browser waits for the person to press something again. During "Turn on sound" (no
      // microphone press waiting) it is the sound that did not start: that button is pressed again.
      listen("auto-play-audio-failed", () => {
        if (!this.waiting.microphone && (this.soundJoin || this.soundOnly)) {
          this.soundBlockedNow = true;
          this.setSound("failed", "autoplay");
          return;
        }
        this.fromZoom("microphone", { state: "failed", problem: "autoplay" });
      });
      listen("device-permission-change", (payload) => {
        const { name, state } = (payload ?? {}) as { name?: string; state?: string };
        if ((name === "camera" || name === "microphone") && state === "denied") this.fromZoom(name, { state: "denied" });
      });
      // The display name is the participant code: no student name reaches Zoom.
      await zoom.join(input.sessionName, input.sessionToken, input.participantCode);
      if (await overtaken()) return;
      this.stream = zoom.getMediaStream();
      for (const ready of [...this.streamWaiters]) ready();
      this.setConnection("connected");
      // Zoom's id for this session, for the server to confirm and then use without webhooks. An
      // SDK without it (or an empty id) just says nothing.
      const sessionId = client.getSessionInfo?.()?.sessionId;
      if (typeof sessionId === "string" && sessionId) this.emit({ type: "session", sessionId, at: this.now() });
      // The tutor's page (the session's host) lets everyone chat to everyone, but nobody privately.
      // Not waited for: a chat setting never holds up the lesson.
      if (input.role === "tutor") void Promise.resolve().then(() => zoom.getChatClient?.().setPrivilege(CHAT_PUBLIC_ONLY)).catch(() => undefined);
      this.reportRemote();
      const sharing = this.stream.getActiveShareUserId();
      if (sharing) await this.remoteShare({ state: "Active", userId: sharing });
      await this.drawVideosAlreadyOn();
      await this.showBoardAlreadyOpen();
    } catch (error) {
      if (attempt === this.attempt) {
        this.client = null;
        this.stream = null;
        for (const ready of [...this.streamWaiters]) ready();
        this.setConnection("failed");
        // A client whose join failed is released as well, so the next try starts clean.
        if (client) {
          this.handlers = [];
          zoomReleased = this.release(client, listening.splice(0), true);
          await zoomReleased;
        }
      }
      throw error;
    }
  }

  async leave() {
    if (!this.client && !this.joining) return;
    // A join still on its way stops, and leaves again what it joined (connect's `overtaken`).
    this.attempt += 1;
    this.joining = null;
    await this.teardown();
    this.setConnection("disconnected");
  }

  // Ends this page's part in the session: presses, videos, shares, and Zoom's client itself.
  private async teardown() {
    const client = this.client, handlers = this.handlers.splice(0);
    const own = client?.getCurrentUserInfo()?.userId;
    if (typeof own === "number") this.pastSelf.add(own);
    if (this.selfId !== null) this.pastSelf.add(this.selfId);
    this.selfId = null;
    this.client = null; this.stream = null; this.audioStarted = false; this.tiles.clear(); this.sharer = null;
    // The room's sound goes with the room: the next join hears nothing until the person turns it on.
    this.soundJoin = null; this.soundOnly = false; this.soundBlockedNow = false;
    this.setSound("off");
    clearTimeout(this.videosTimer);
    this.waitingVideos.clear();
    if (this.elsewhere) { this.elsewhere = 0; this.emit({ type: "duplicate", count: 0, at: this.now() }); }
    for (const ready of [...this.streamWaiters]) ready();
    // A press still waiting ends with the room; the next join starts with both devices off, and the
    // page is told so (after a reconnect it must not still show a device as on).
    for (const kind of ["camera", "microphone"] as const) {
      this.presses[kind] += 1;
      const pending = this.waiting[kind];
      delete this.waiting[kind];
      delete this.calls[kind];
      pending?.({ state: "off" });
      this.setDeviceState(kind, "off");
    }
    if (client) {
      zoomReleased = this.release(client, handlers, true);
      await zoomReleased;
    }
    if (this.stage) {
      for (const part of Object.values(this.stage)) part.replaceChildren();
      this.stage.share.hidden = true; this.stage.whiteboard.hidden = true; this.stage.ownShare.hidden = true;
    }
    // The tiles went with the videos container's children; the page hears that nobody is here.
    this.peopleTiles?.clear();
    this.reportPeople();
    this.setSpeaking([]);
    this.setShare("none");
    this.viewedPresenter = null;
    this.setBoard("none");
    // Hands belong to the session that ended (Zoom gives new user ids on joining again). Chat lines
    // already on the page stay there; only the ids Zoom gave this session are forgotten.
    this.handUp = false;
    this.chatIds.clear();
    this.clearHands();
  }

  // Our listeners off, out of the session, and (unless told not to) Zoom's shared client destroyed,
  // so the next join gets a fresh client rather than one initialised for an ended session.
  private async release(client: ZoomClient, handlers: ZoomHandler[], destroy: boolean) {
    for (const [name, handler] of handlers) client.off(name, handler);
    await Promise.resolve().then(() => client.leave()).catch(() => undefined);
    if (destroy) await this.sdk?.then((sdk) => sdk.destroyClient()).catch(() => undefined);
  }

  private setConnection(state: ConnectionState) {
    this.connection = state;
    this.emit({ type: "connection", state, at: this.now() });
  }

  // A press of the camera or microphone, always from the person's own click, as browsers require.
  // Turning on waits for Zoom's call or Zoom's own report, at most deviceStartMs; anything else
  // ends as "failed", which the page offers to try again.
  async setDevice(kind: DeviceKind, on: boolean) {
    const press = ++this.presses[kind];
    // After a press that did not start, Zoom's half-started camera or audio is cleared first; but a
    // start that only ran past the deadline and is still on its way first gets one more (start()).
    const retry = this.devices[kind] === "failed";
    const overdue = retry && this.problems[kind] === "timeout" ? this.calls[kind] : undefined;
    let stream = this.stream;
    if (!stream && on && this.client) {
      // Pressed while Zoom is still finishing the join: wait for its media stream, never drop it.
      this.setDeviceState(kind, "starting");
      stream = await this.streamWithin(this.deviceStartMs);
      if (press !== this.presses[kind]) return this.devices[kind];
      if (!stream) {
        this.setDeviceState(kind, "failed", "timeout");
        return "failed" as DeviceState;
      }
    }
    if (!stream) return "off" as DeviceState;
    if (!on) {
      try {
        if (kind === "camera") await stream.stopVideo();
        else if (this.audioStarted) await stream.muteAudio();
        await this.settle(kind, { state: "off" });
      } catch (error) {
        await this.settle(kind, deviceAnswerOf(error));
      }
      return this.devices[kind];
    }
    this.setDeviceState(kind, "starting");
    const { answer: pending, call } = this.start(kind, stream, retry, overdue);
    const answer = await pending;
    // A later press, or leaving, took over: its own answer stands.
    if (press !== this.presses[kind] || stream !== this.stream) return this.devices[kind];
    await this.settle(kind, answer);
    // Zoom answering after the deadline (a slow computer, 2026-11-18): the device is on after all,
    // unless the person pressed again or left meanwhile. Zoom's own report usually says so as well.
    if (answer.problem === "timeout") {
      call.then(() => {
        if (press === this.presses[kind] && stream === this.stream && this.devices[kind] === "failed") void this.settle(kind, { state: "on" });
      }, () => undefined);
    }
    return answer.state;
  }

  // The media stream once join() has given it, or null after `ms` (or on leaving).
  private streamWithin(ms: number) {
    return new Promise<ZoomStream | null>((resolve) => {
      const deadline = setTimeout(() => ready(), ms);
      const ready = () => {
        clearTimeout(deadline);
        this.streamWaiters.delete(ready);
        resolve(this.stream);
      };
      this.streamWaiters.add(ready);
    });
  }

  // Zoom's call, Zoom's own report or the deadline, whichever comes first; and the call itself, which
  // Zoom may still answer later. A "Try again" after a start that ran past the deadline (`earlier`,
  // still on its way) waits one more deadline for it before starting over, so its own is twice as long.
  private start(kind: DeviceKind, stream: ZoomStream, retry: boolean, earlier?: Promise<void>) {
    let call!: Promise<void>;
    const answer = new Promise<DeviceAnswer>((resolve) => {
      const deadline = setTimeout(() => done({ state: "failed", problem: "timeout" }), earlier ? 2 * this.deviceStartMs : this.deviceStartMs);
      const done = (result: DeviceAnswer) => {
        clearTimeout(deadline);
        if (this.waiting[kind] === done) delete this.waiting[kind];
        resolve(result);
      };
      this.waiting[kind] = done;
      call = this.callStart(kind, stream, retry, earlier);
      call.then(() => done({ state: "on" }), (error: unknown) => done(deviceAnswerOf(error)));
    });
    this.calls[kind] = call;
    const forget = () => { if (this.calls[kind] === call) delete this.calls[kind]; };
    call.then(forget, forget);
    return { answer, call };
  }

  // Whether a call answers (and succeeds) within `ms`.
  private answersWithin(call: Promise<void>, ms: number) {
    return new Promise<boolean>((resolve) => {
      const deadline = setTimeout(() => resolve(false), ms);
      call.then(() => { clearTimeout(deadline); resolve(true); }, () => { clearTimeout(deadline); resolve(false); });
    });
  }

  private async callStart(kind: DeviceKind, stream: ZoomStream, retry: boolean, earlier?: Promise<void>) {
    // "Try again" while Zoom is still working on the earlier start (real Zoom on a slow computer,
    // 2026-11-18): stopping that start made each new one fail at once, while the earlier one came on
    // by itself a little later. So it gets one more deadline; only one that still has not answered,
    // or that failed, is cleared and started again (a start that never answers, seen on 2026-10-30).
    if (earlier && await this.answersWithin(earlier, this.deviceStartMs)) return;
    if (kind === "camera") {
      // Already capturing: an earlier press started after all.
      if (stream.isCapturingVideo()) return;
      if (retry) await stream.stopVideo().catch(() => undefined);
      await stream.startVideo();
      return;
    }
    // "Turn on sound" on its way: the microphone waits for that join (one audio join at a time), then
    // unmutes it. From here on Zoom's audio reports are the microphone's again.
    if (this.soundJoin) await this.soundJoin;
    this.soundOnly = false;
    if (retry) {
      await stream.stopAudio().catch(() => undefined);
      this.audioStarted = false;
    }
    if (this.audioStarted) {
      await stream.unmuteAudio();
    } else {
      await stream.startAudio();
      this.audioStarted = true;
    }
    // The microphone's audio plays the room's sound too.
    if (stream === this.stream) this.setSound("on");
  }

  // "Turn on sound" (2026-11-20): on the person's own press, Zoom's audio is joined with the
  // microphone muted (startAudio's documented option `mute`), so the room is heard and nobody hears
  // this person. It is the same audio join the microphone has always used (heard by ear on real Zoom
  // after every re-entry, 2026-11-20 00:26–00:31), only muted from the start; should Zoom ever join
  // unmuted, the microphone is muted at once. Zoom's speaker-only audio is NOT used: switching from it
  // to the microphone left a re-entered person inaudible on production (802fb1b, rolled back 11/20).
  // The browser may ask for the microphone (Zoom's audio needs it even muted). Joining runs at most
  // deviceStartMs; one that answers later is taken from Zoom's own "joined" report.
  async joinSound(): Promise<boolean> {
    const stream = this.stream;
    if (!stream) return false;
    if (this.audioStarted && this.sound === "on") return true;
    // A microphone press on its way joins the audio itself.
    if (this.devices.microphone === "starting") return true;
    if (this.soundJoin) return this.soundJoin;
    const join = (async () => {
      // Pressed again after the browser refused to play: the audio is joined again (as the
      // microphone's "Try again" does), once, with the microphone still muted.
      const again = this.audioStarted;
      this.soundBlockedNow = false;
      this.soundOnly = true;
      this.setSound("joining");
      try {
        if (again) {
          await stream.stopAudio().catch(() => undefined);
          this.audioStarted = false;
        }
        const started = stream.startAudio({ mute: true });
        let deadline: ReturnType<typeof setTimeout> | undefined;
        const answered = await Promise.race([
          started.then(() => true),
          new Promise<boolean>((resolve) => { deadline = setTimeout(() => resolve(false), this.deviceStartMs); }),
        ]).finally(() => clearTimeout(deadline));
        if (stream !== this.stream) return false;
        if (!answered) {
          started.catch(() => undefined);
          this.setSound("failed", "error");
          return false;
        }
        this.audioStarted = true;
        if (stream.isAudioMuted?.() === false && this.soundOnly) await stream.muteAudio().catch(() => undefined);
        if (this.soundBlockedNow) {
          this.setSound("failed", "autoplay");
          return false;
        }
        this.setSound("on");
        return true;
      } catch (error) {
        if (stream === this.stream) this.setSound("failed", soundProblemOf(error));
        return false;
      }
    })();
    this.soundJoin = join;
    try {
      return await join;
    } finally {
      if (this.soundJoin === join) this.soundJoin = null;
    }
  }

  private setSound(state: SoundState, problem?: SoundProblem) {
    // A repeated failure is told again, for the page's message.
    if (this.sound === state && state !== "failed") return;
    this.sound = state;
    this.emit({ type: "sound", state, ...(problem ? { problem } : {}), at: this.now() });
  }

  // Zoom's own report on a device answers the press now waiting, or else stands by itself.
  private fromZoom(kind: DeviceKind, answer: DeviceAnswer) {
    const waiting = this.waiting[kind];
    if (waiting) waiting(answer);
    else void this.settle(kind, answer);
  }

  private async settle(kind: DeviceKind, answer: DeviceAnswer) {
    this.setDeviceState(kind, answer.state, answer.problem);
    const self = this.client?.getCurrentUserInfo()?.userId;
    if (kind === "camera" && answer.state === "on" && self != null) await this.attach(self).catch(() => undefined);
  }

  private setDeviceState(kind: DeviceKind, state: DeviceState, problem?: DeviceProblem) {
    // A repeated failure is told again, for the page's message.
    if (this.devices[kind] === state && state !== "failed") return;
    this.devices[kind] = state;
    this.problems[kind] = state === "failed" ? problem ?? "error" : undefined;
    this.reportPeople();
    this.emit({ type: "device", kind, state, ...(state === "failed" ? { problem: problem ?? "error" } : {}), at: this.now() });
  }

  // Materials: Zoom has no PDF or PPT upload, so the tutor shares the screen, window or browser tab
  // that shows them. Browsers on phones and tablets cannot share; the room offers this on computers.
  async setScreenShare(on: boolean) {
    const stream = this.stream, stage = this.stage;
    if (!stream || !stage) return false;
    if (!on) {
      if (this.sharing === "sending") { await stream.stopShareScreen().catch(() => undefined); this.endOwnShare(); }
      return false;
    }
    const target = stage.ownShare.ownerDocument.createElement(stream.isStartShareScreenWithVideoElement() ? "video" : "canvas");
    stage.ownShare.replaceChildren(target);
    stage.ownShare.hidden = false;
    try {
      await stream.startShareScreen(target);
    } catch {
      // Includes the browser's picker being cancelled.
      this.endOwnShare();
      return false;
    }
    this.setShare("sending");
    return true;
  }

  // Zoom's whiteboard: only the host (the tutor's token) starts it; the other person sees it and,
  // on a computer, can draw. Zoom keeps nothing afterwards, so the tutor exports a PDF if needed.
  async setWhiteboard(on: boolean) {
    const board = this.client?.getWhiteboardClient(), stage = this.stage;
    if (!board || !stage) return false;
    if (!on) {
      if (this.board === "presenting") { await board.stopWhiteboardScreen().catch(() => undefined); this.hideBoard(); }
      return false;
    }
    // Not tried during a screen share (sent or received): Zoom refuses its whiteboard then (8002).
    if (this.sharing !== "none") return this.boardRefused("start", ZOOM_WHITEBOARD_SCREEN_SHARE_CONFLICT);
    if (!board.isWhiteboardEnabled()) return this.boardRefused("start", ZOOM_WHITEBOARD_ACCOUNT_DISABLE);
    if (!board.canStartWhiteboard()) return this.boardRefused("start", null);
    stage.whiteboard.hidden = false;
    try {
      await board.startWhiteboardScreen(stage.whiteboard);
    } catch (error) {
      // Zoom may have opened the board for the others although this page could not show it (real
      // Zoom, 2026-11-18: the student saw a board the tutor could neither see nor close). It is closed
      // for everyone too, so both pages agree and the tutor can simply press again.
      await board.stopWhiteboardScreen().catch(() => undefined);
      this.hideBoard();
      return this.boardRefused("start", zoomErrorCodeOf(error));
    }
    this.setBoard("presenting");
    return true;
  }

  async exportWhiteboard(name: string) {
    await this.client?.getWhiteboardClient().exportWhiteboard("pdf", name);
  }

  // In-class chat (2026-11-12): a line to everyone in the session. Zoom answers with the message it
  // sent; that line shows here at once, and not again if Zoom also delivers it as received.
  async sendChat(value: string) {
    const chat = this.client?.getChatClient?.();
    const text = chatTextOf(value);
    if (!chat || !text || this.connection !== "connected") return false;
    let sent: unknown;
    try {
      sent = await chat.sendToAll(text);
    } catch {
      return false;
    }
    if (isZoomFailure(sent)) return false;
    const id = (sent as ZoomChatMessage).id;
    const key = id ? `zoom-${id}` : `own-${++this.ownLines}`;
    if (this.rememberChat(key)) this.emit({ type: "chat", line: { id: key, from: "self", name: "", text, at: this.now() }, at: this.now() });
    return true;
  }

  // A student's own hand, to everyone in the session; the tutor (the host) has none to raise.
  async setHand(up: boolean) {
    const self = this.client?.getCurrentUserInfo();
    if (this.role === "tutor" || !self || this.connection !== "connected") return false;
    if (!(await this.sendCommand(handCommand(up)))) return false;
    this.handUp = up;
    this.setHandOf(self.userId, "", up, true);
    return true;
  }

  // The tutor lowers a student's hand: every page in the session takes it down.
  async lowerHand(id: string) {
    const userId = Number(id);
    if (this.role !== "tutor" || !Number.isSafeInteger(userId) || !this.hands.has(userId) || this.connection !== "connected") return false;
    if (!(await this.sendCommand(handCommand(false, userId)))) return false;
    this.setHandOf(userId, "", false, false);
    return true;
  }

  private async sendCommand(text: string) {
    const channel = this.client?.getCommandClient?.();
    if (!channel) return false;
    try {
      return !isZoomFailure(await channel.send(text));
    } catch {
      return false;
    }
  }

  // A line someone wrote (or this page's own, when Zoom delivers it back). Files are not part of this
  // classroom, and a line with no text left is not shown.
  private receiveChat(message: ZoomChatMessage) {
    if (!message || typeof message !== "object" || message.file) return;
    const text = chatTextOf(message.message);
    const senderId = message.sender?.userId;
    if (!text || typeof senderId !== "number") return;
    const key = message.id ? `zoom-${message.id}` : `zoom-${senderId}-${message.timestamp ?? this.now()}`;
    if (!this.rememberChat(key)) return;
    const self = this.client?.getCurrentUserInfo()?.userId;
    const from: ChatFrom = senderId === self ? "self" : this.isHost(senderId) ? "tutor" : "student";
    this.emit({ type: "chat", line: { id: key, from, name: from === "self" ? "" : chatNameOf(message.sender?.name), text, at: this.now() }, at: this.now() });
  }

  // A hand raised or lowered by someone in the session. Lowering someone else's counts only from the
  // host (the tutor); anything else on the channel is not ours and is ignored.
  private receiveCommand(payload: { senderId?: number; text?: string }) {
    const command = parseHandCommand(payload?.text);
    const sender = payload?.senderId;
    if (!command || typeof sender !== "number") return;
    const self = this.client?.getCurrentUserInfo()?.userId;
    if (command.for !== undefined) {
      if (!this.isHost(sender)) return;
      if (command.for === self) this.handUp = false;
      this.setHandOf(command.for, "", false, command.for === self);
      return;
    }
    if (sender === self) return;
    this.setHandOf(sender, this.nameOf(sender), command.hand, false);
  }

  private setHandOf(userId: number, name: string, up: boolean, self: boolean) {
    if (up) {
      const known = this.hands.get(userId);
      if (known && known.name === name && known.self === self) return;
      this.hands.set(userId, { id: String(userId), name, self });
    } else if (!this.hands.delete(userId)) {
      return;
    }
    this.emit({ type: "hands", raised: [...this.hands.values()], at: this.now() });
  }

  private dropHands(payload: unknown) {
    const gone = (Array.isArray(payload) ? payload : [payload]).map(user => (user as { userId?: unknown } | null)?.userId);
    let changed = false;
    for (const userId of gone) if (typeof userId === "number" && this.hands.delete(userId)) changed = true;
    if (changed) this.emit({ type: "hands", raised: [...this.hands.values()], at: this.now() });
  }

  private clearHands() {
    if (this.hands.size === 0) return;
    this.hands.clear();
    this.emit({ type: "hands", raised: [], at: this.now() });
  }

  private isHost(userId: number) {
    return this.client?.getAllUser().find(user => user.userId === userId)?.isHost === true;
  }

  // Names in the room are participant codes (the join passes the code as the name), never students' names.
  private nameOf(userId: number) {
    return chatNameOf(this.client?.getAllUser().find(user => user.userId === userId)?.displayName);
  }

  private rememberChat(key: string) {
    if (this.chatIds.has(key)) return false;
    this.chatIds.add(key);
    if (this.chatIds.size > CHAT_IDS_KEPT) this.chatIds.delete(this.chatIds.values().next().value as string);
    return true;
  }

  private loadOnce() {
    this.sdk ??= this.load();
    return this.sdk.catch((error: unknown) => { this.sdk = null; throw error; });
  }

  // Everyone in the session as the page shows them, and their tiles (Classroom 2.0). The page's own
  // camera and microphone come from its own presses; everyone else's from Zoom's user list.
  // Zoom's list of people without the entries a cut-off or closed page left behind: never this
  // page's own earlier joins, and of several entries with one participant id (the user key from the
  // join token) only the one that came last. The page's own entry always stays; so does this
  // person's entry on ANOTHER page or device, which the room must still say (reportRemote).
  private usersNow(): ZoomParticipant[] {
    const all = this.client?.getAllUser() ?? [];
    const self = this.client?.getCurrentUserInfo()?.userId;
    const keyOf = (user: ZoomParticipant) => user.userKey ?? user.userIdentity ?? null;
    if (typeof self === "number" && self !== this.selfId) {
      if (this.selfId !== null) this.pastSelf.add(this.selfId);
      this.selfId = self;
      this.pastSelf.delete(self);
    }
    this.looks += 1;
    for (const user of all) if (!this.firstSeen.has(user.userId)) this.firstSeen.set(user.userId, this.looks);
    for (const id of [...this.firstSeen.keys()]) if (!all.some(user => user.userId === id)) this.firstSeen.delete(id);
    const later = (a: ZoomParticipant, b: ZoomParticipant) => {
      const seenA = this.firstSeen.get(a.userId) ?? 0, seenB = this.firstSeen.get(b.userId) ?? 0;
      return seenA !== seenB ? seenA > seenB : a.userId > b.userId;
    };
    const last = new Map<string, ZoomParticipant>();
    for (const user of all) {
      const key = keyOf(user);
      if (user.userId === self || this.pastSelf.has(user.userId) || !key) continue;
      const kept = last.get(key);
      if (!kept || later(user, kept)) last.set(key, user);
    }
    return all.filter((user) => {
      if (user.userId === self) return true;
      if (this.pastSelf.has(user.userId)) return false;
      const key = keyOf(user);
      return !key || last.get(key) === user;
    });
  }

  private reportPeople() {
    const client = this.client;
    const self = client?.getCurrentUserInfo()?.userId;
    const people: RoomPerson[] = this.usersNow().map((user) => {
      const own = user.userId === self;
      const camera = own ? this.devices.camera === "on" : Boolean(user.bVideoOn);
      return {
        id: String(user.userId), name: chatNameOf(user.displayName), host: user.isHost === true, self: own, camera,
        microphone: own ? this.devices.microphone === "on" : Boolean(user.audio && !user.muted),
        video: camera && this.tiles.get(user.userId) ? "shown" : this.waitingVideos.has(user.userId) ? "waiting" : "off",
      };
    });
    this.peopleTiles?.sync(people);
    const key = JSON.stringify(people);
    if (key === this.peopleKey) return;
    this.peopleKey = key;
    this.emit({ type: "people", people, at: this.now() });
  }

  private hearSpeakers(payload: unknown) {
    const ids = (Array.isArray(payload) ? payload : [])
      .map((item) => (item as { userId?: unknown } | null)?.userId)
      .filter((id): id is number => typeof id === "number")
      .map(String);
    clearTimeout(this.speakingTimer);
    this.setSpeaking(ids);
    if (ids.length > 0) this.speakingTimer = setTimeout(() => this.setSpeaking([]), this.speakingMs);
  }

  private setSpeaking(ids: string[]) {
    const key = ids.join(",");
    if (key === this.speaking) return;
    if (ids.length === 0) clearTimeout(this.speakingTimer);
    this.speaking = key;
    this.emit({ type: "speaking", ids, at: this.now() });
  }

  private reportRemote() {
    this.reportPeople();
    const self = this.client?.getCurrentUserInfo()?.userId;
    const all = this.usersNow();
    // The same person (the same participant id, which Zoom keeps as the user key) on another page.
    const keyOf = (user: ZoomParticipant | undefined) => user?.userKey ?? user?.userIdentity ?? null;
    const selfKey = keyOf(all.find(user => user.userId === self));
    const elsewhere = selfKey ? all.filter(user => user.userId !== self && keyOf(user) === selfKey).length : 0;
    if (elsewhere !== this.elsewhere) {
      this.elsewhere = elsewhere;
      this.emit({ type: "duplicate", count: elsewhere, at: this.now() });
    }
    const others = all.filter(user => user.userId !== self);
    const other = others[0] ?? null;
    // The user key is our participant id from the join token; Zoom reports it on each person.
    this.emit({
      type: "remote", present: Boolean(other), camera: Boolean(other?.bVideoOn), microphone: Boolean(other && other.audio && !other.muted),
      userKey: other ? (other.userKey ?? other.userIdentity ?? null) : null, at: this.now(),
      others: others.length, videosShown: [...this.tiles.keys()].length, videosWaiting: this.waitingVideos.size,
    });
  }

  // Cameras that were already on when this page joined, or joined again. Zoom's report that a camera
  // started does not reliably reach a page that comes in afterwards (real Zoom, 2026-11-18: the
  // student who came in second, or came back, saw no picture until the tutor turned the camera off
  // and on), so after joining, everyone whose camera Zoom's user list shows as on (bVideoOn) is drawn.
  // attach() claims each tile first, so a late report of the same camera never draws it twice, and
  // the device's tile limit (P3-Multi) still decides who waits.
  private async drawVideosAlreadyOn() {
    const self = this.client?.getCurrentUserInfo()?.userId;
    const before = this.tiles.size + this.waitingVideos.size;
    for (const user of this.usersNow()) {
      if (user.userId === self || !user.bVideoOn) continue;
      await this.attach(user.userId).catch(() => undefined);
    }
    // Told only when a camera was drawn (or is waiting), so a room with none on hears what it did before.
    if (this.tiles.size + this.waitingVideos.size !== before) this.reportRemote();
  }

  // Zoom's report that a camera started is the usual way a video is drawn. When it is missed (real
  // Zoom: for a page that joined later, 2026-11-18; with the tutor in the room twice, 2026-11-19, the
  // student heard the tutor but saw no picture), Zoom's list of people still says whose camera is
  // on. A moment after the list changes (someone joined, left, or turned a camera on or off), the
  // page draws every camera on that it does not show yet and lets go of the videos of people who
  // left, so their tiles never stay taken. A video already drawn is never drawn again.
  private scheduleVideoCheck() {
    clearTimeout(this.videosTimer);
    this.videosTimer = setTimeout(() => { void this.checkVideos().catch(() => undefined); }, this.videoCheckMs);
  }

  private async checkVideos() {
    if (!this.stream || this.connection !== "connected") return;
    const self = this.client?.getCurrentUserInfo()?.userId;
    const present = new Set(this.usersNow().map(user => user.userId));
    const before = `${[...this.tiles.keys()]}|${[...this.waitingVideos]}`;
    for (const userId of [...this.waitingVideos]) if (!present.has(userId)) this.waitingVideos.delete(userId);
    for (const userId of [...this.tiles.keys()]) if (userId !== self && !present.has(userId)) await this.releaseVideo(userId);
    await this.drawVideosAlreadyOn();
    // Told only when something changed (on the tutor's page each report also goes to iHear).
    if (`${[...this.tiles.keys()]}|${[...this.waitingVideos]}` !== before) this.reportRemote();
  }

  // One remote video off the page (Zoom said it stopped, or its person left); the longest-waiting
  // video takes the tile that came free.
  private async releaseVideo(userId: number) {
    if (this.waitingVideos.delete(userId)) return;
    if (!this.tiles.has(userId)) return;
    await this.stream?.detachVideo(userId).catch(() => undefined);
    const player = this.tiles.get(userId);
    this.tiles.delete(userId);
    // As Zoom's documentation does after detachVideo: the empty video-player leaves the page. The
    // person's tile stays (Classroom 2.0), now without video.
    if (isNode(player) && typeof (player as ChildNode).remove === "function") (player as ChildNode).remove();
    const next = this.waitingVideos.values().next();
    if (!next.done) { this.waitingVideos.delete(next.value); await this.attach(next.value).catch(() => undefined); }
  }

  // A whiteboard already open when this page joins, or joins again. Zoom's whiteboard guide: a page
  // that comes in later may miss "peer-whiteboard-state-change", so it asks who presents
  // (getWhiteboardPresenter, Zoom 2.3.5+) and views that board, as the Start report would have.
  private async showBoardAlreadyOpen() {
    let presenter: { userId?: number } | null | undefined;
    // A question about the whiteboard never stops anyone entering the room.
    try { presenter = this.client?.getWhiteboardClient().getWhiteboardPresenter?.(); } catch { return; }
    const self = this.client?.getCurrentUserInfo()?.userId;
    if (presenter?.userId == null || presenter.userId === self || this.board !== "none") return;
    await this.remoteBoard({ action: "Start", userId: presenter.userId });
  }

  // Zoom's startWhiteboardView, counted while it runs (so the check after a reconnect never starts a
  // second view on top of one still opening). Zoom's code when it fails (null without one), nothing
  // when the board is shown.
  private async startBoardView(board: ZoomWhiteboard, element: HTMLElement, presenter: number): Promise<number | null | undefined> {
    this.boardStarting += 1;
    try {
      await board.startWhiteboardView(element, presenter);
      return undefined;
    } catch (error) {
      return zoomErrorCodeOf(error);
    } finally {
      this.boardStarting -= 1;
    }
  }

  // After Zoom's own reconnect (its connection-change Reconnecting → Connected), this page asks Zoom
  // again what it may have missed meanwhile: who shares a screen, whose camera is on, who presents a
  // whiteboard. Real Zoom (2026-11-18, W6): after 30 s offline the student was back in 4 s, yet 6 s
  // later the whiteboard area was blank, while the page still showed the board (whether Zoom would
  // have restored it later is unknown). Only other people's media are drawn again; this page's own
  // camera and microphone are never started, stopped, muted or unmuted here. What is already shown
  // and still right is left alone (no camera is drawn twice; a board this page presents is never
  // restarted, as that would close it, strokes and all, for everyone).
  private resyncAfterReconnect() {
    if (this.resyncing) { this.resyncAgain = true; return this.resyncing; }
    const attempt = this.attempt;
    const running: Promise<void> = (async () => {
      do {
        this.resyncAgain = false;
        await this.resyncOnce(attempt);
      } while (this.resyncAgain && this.stillBack(attempt));
    })()
      .catch(() => undefined)
      .finally(() => { if (this.resyncing === running) this.resyncing = null; });
    this.resyncing = running;
    return running;
  }

  // Still in the same room, connected, with Zoom's media stream: otherwise the check stops (the room
  // was left, or Zoom is reconnecting again and will say Connected once more).
  private stillBack(attempt: number) {
    return attempt === this.attempt && this.connection === "connected" && this.stream !== null;
  }

  // A first look right away; a second one a moment later only when the first would close something
  // (Zoom's lists may lag a moment behind its "Connected") or Zoom could not answer yet.
  private async resyncOnce(attempt: number) {
    const views = this.boardViews;
    for (const final of [false, true]) {
      if (final) await new Promise((resolve) => { setTimeout(resolve, this.resyncRetryMs); });
      if (!this.stillBack(attempt)) return;
      this.reportRemote();
      const shareSettled = await this.resyncShare(final);
      if (!this.stillBack(attempt)) return;
      await this.drawVideosAlreadyOn();
      if (!this.stillBack(attempt)) return;
      const boardSettled = await this.resyncBoard(final, views);
      if (shareSettled && boardSettled) break;
    }
    // For support: what the page shows after the check, as states and a count, nothing else.
    if (this.stillBack(attempt)) console.info(`[classroom] after reconnect: whiteboard ${this.board}, share ${this.sharing}, videos ${this.tiles.size}`);
  }

  // The other person's screen share after a reconnect: one that started meanwhile is shown, one that
  // ended is closed (only when Zoom says so twice), and one still shown is left as it is. This page's
  // own share is never touched. A stale "receiving" would also keep the whiteboard from starting (8002).
  private async resyncShare(final: boolean) {
    if (!this.stream || this.sharing === "sending") return true;
    let sharer: number | null;
    try { sharer = this.stream.getActiveShareUserId() || null; } catch { return final; }
    if (sharer === this.sharer) return true;
    if (sharer === null && !final) return false;
    if (this.sharer !== null) await this.remoteShare({ state: "Inactive", userId: this.sharer });
    if (sharer !== null) await this.remoteShare({ state: "Active", userId: sharer });
    return true;
  }

  // The whiteboard after a reconnect, by Zoom's answer to who presents (getWhiteboardPresenter):
  // - someone else: their board is viewed again here, in the same place (Zoom may have emptied the
  //   view meanwhile); the old view goes first, so it is never shown twice, and the page's state
  //   stays "viewing", so nothing on the page flickers. A board already viewed again since the
  //   reconnect (Zoom's own Start came first) is left alone;
  // - this page: left as it is;
  // - nobody: a board shown here is closed, as Zoom's Stop would have done, but only when Zoom says
  //   so twice.
  // A view that fails twice is said, with Zoom's code, like any board that cannot be shown.
  private async resyncBoard(final: boolean, views: number) {
    const client = this.client, stage = this.stage;
    const board = client?.getWhiteboardClient();
    // An SDK without the question (before 2.3.5) leaves the board to Zoom's own reports.
    if (!board || !stage || typeof board.getWhiteboardPresenter !== "function") return true;
    // A view still opening finishes first (its own result decides); asked again in a moment.
    if (this.boardStarting > 0) return final;
    let presenter: number | null;
    try { presenter = board.getWhiteboardPresenter()?.userId ?? null; } catch { return final; }
    const self = client?.getCurrentUserInfo()?.userId;
    if (presenter !== null && presenter === self) return true;
    if (presenter === null) {
      if (this.board === "none") return true;
      if (!final) return false;
      if (this.board === "viewing") await board.stopWhiteboardView().catch(() => undefined);
      this.hideBoard();
      return true;
    }
    if (this.board === "viewing" && this.viewedPresenter === presenter && this.boardViews !== views) return true;
    // This page's own board went (Zoom now says someone else presents): it is closed here first.
    if (this.board === "presenting") this.hideBoard();
    if (this.board === "viewing") await board.stopWhiteboardView().catch(() => undefined);
    stage.whiteboard.replaceChildren();
    this.viewedPresenter = presenter;
    stage.whiteboard.hidden = false;
    const code = await this.startBoardView(board, stage.whiteboard, presenter);
    if (code === undefined) {
      if (this.viewedPresenter !== presenter) {
        if (this.viewedPresenter === null) await board.stopWhiteboardView().catch(() => undefined);
        return true;
      }
      this.boardViews += 1;
      this.setBoard("viewing");
      return true;
    }
    // Free for Zoom's own Start meanwhile; said only after the second try. A board this page was not
    // showing yet stays out of sight until then.
    if (this.viewedPresenter === presenter) this.viewedPresenter = null;
    if (this.board === "none") { stage.whiteboard.replaceChildren(); stage.whiteboard.hidden = true; }
    if (!final) return false;
    this.hideBoard();
    this.boardRefused("view", code);
    return true;
  }

  private async peerVideo(payload: { action?: string; userId?: number }) {
    if (payload.userId == null) return;
    if (payload.action === "Start") await this.attach(payload.userId);
    else if (payload.action === "Stop") await this.releaseVideo(payload.userId);
    this.reportRemote();
  }

  private async attach(userId: number) {
    if (!this.stream || !this.stage || this.tiles.has(userId)) return;
    // No free tile (P3-Multi): the video waits until one is.
    if (this.tiles.size >= this.maxVideos) { this.waitingVideos.add(userId); return; }
    // Claimed before the wait, so Zoom's report and the finished call never draw one video twice.
    this.tiles.set(userId, null);
    try {
      const element = await this.stream.attachVideo(userId, this.tiles.size > 3 ? VIDEO_360P : VIDEO_720P);
      this.tiles.set(userId, element);
      // Into the person's own tile inside the videos container (Zoom's documented pattern).
      if (isNode(element)) (this.peopleTiles?.cellOf(String(userId)) ?? this.stage.videos).append(element);
    } catch (error) {
      this.tiles.delete(userId);
      throw error;
    }
    this.reportPeople();
  }

  // The other person's shared screen, shown while they share.
  private async remoteShare(payload: { state?: string; userId?: number }) {
    const stream = this.stream, stage = this.stage;
    if (!stream || !stage || payload.userId == null || payload.userId === this.client?.getCurrentUserInfo()?.userId) return;
    if (payload.state === "Active" && this.sharer !== payload.userId) {
      const view = await stream.attachShareView(payload.userId).catch(() => null);
      if (!isNode(view)) return;
      stage.share.replaceChildren(view);
      stage.share.hidden = false;
      this.sharer = payload.userId;
      this.setShare("receiving");
    } else if (payload.state === "Inactive" && this.sharer === payload.userId) {
      await stream.detachShareView(payload.userId).catch(() => undefined);
      stage.share.replaceChildren();
      stage.share.hidden = true;
      this.sharer = null;
      this.setShare("none");
    }
  }

  private async remoteBoard(payload: { action?: string; userId?: number }) {
    const board = this.client?.getWhiteboardClient(), stage = this.stage;
    if (!board || !stage || payload.userId == null) return;
    if (payload.action === "Start") {
      // Claimed before the wait: the question on joining and Zoom's own (late) report of the same
      // board never start viewing it twice.
      if (this.viewedPresenter === payload.userId) return;
      this.viewedPresenter = payload.userId;
      stage.whiteboard.hidden = false;
      const code = await this.startBoardView(board, stage.whiteboard, payload.userId);
      if (code !== undefined) {
        // Before 2026-11-18 this was silent: the student saw nothing and nobody knew why.
        this.hideBoard();
        this.boardRefused("view", code);
        return;
      }
      // Closed while Zoom was opening it (Zoom's Stop, or the room was left): not shown after all. A
      // newer board claimed meanwhile is that board's own start to finish.
      if (this.viewedPresenter !== payload.userId) {
        if (this.viewedPresenter === null) await board.stopWhiteboardView().catch(() => undefined);
        return;
      }
      this.boardViews += 1;
      this.setBoard("viewing");
    } else if (payload.action === "Stop") {
      await board.stopWhiteboardView().catch(() => undefined);
      this.hideBoard();
    }
  }

  private endOwnShare() {
    if (this.stage) { this.stage.ownShare.replaceChildren(); this.stage.ownShare.hidden = true; }
    if (this.sharing === "sending") this.setShare("none");
  }

  private hideBoard() {
    if (this.stage) { this.stage.whiteboard.replaceChildren(); this.stage.whiteboard.hidden = true; }
    this.viewedPresenter = null;
    this.setBoard("none");
  }

  // A whiteboard that did not start ("start") or could not be shown ("view"): the page is told, with
  // Zoom's code when there is one, and the browser's console keeps the same number for support.
  // Only the number: never Zoom's words, an address or a token.
  private boardRefused(problem: "start" | "view", code: number | null) {
    this.emit({ type: "whiteboard", state: this.board, problem, code, at: this.now() });
    console.warn(`[classroom] whiteboard ${problem} failed${code == null ? "" : `: Zoom error ${code}`}`);
    return false;
  }

  private setShare(state: "none" | "sending" | "receiving") {
    if (this.sharing === state) return;
    this.sharing = state;
    this.emit({ type: "share", state, at: this.now() });
  }

  private setBoard(state: "none" | "presenting" | "viewing") {
    if (this.board === state) return;
    this.board = state;
    this.emit({ type: "whiteboard", state, at: this.now() });
  }

  private emit(event: MediaEvent) {
    for (const listener of this.listeners) listener(event);
  }
}

// LCIC runs the whole call inside Tencent's classroom page, so this adapter only places that
// page in the room and removes it on leaving. Cameras, microphones, courseware and the
// whiteboard are operated inside it; our page sees none of it (observable: false).
export const LCIC_EMBED_ORIGIN = "https://www.tencentclass.com";
export const LCIC_FRAME_PERMISSIONS = "camera; microphone; fullscreen; display-capture; clipboard-read; clipboard-write";

export class LcicEmbedAdapter implements ClassroomMediaAdapter {
  readonly provider = "tencent-lcic" as const;
  readonly capabilities: MediaCapabilities = { realMedia: true, screenShare: true, whiteboard: true, observable: false, chat: false, raiseHand: false };
  private readonly listeners = new Set<(event: MediaEvent) => void>();
  private container: HTMLElement | null = null;
  private frame: HTMLIFrameElement | null = null;

  constructor(private readonly doc: Pick<Document, "createElement"> | null = typeof document === "undefined" ? null : document, private readonly now: () => number = Date.now) {}

  subscribe(listener: (event: MediaEvent) => void) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  mount(element: HTMLElement) { this.container = element; }

  async join(input: MediaJoin) {
    let url: URL;
    try { url = new URL(String(input.embedUrl)); } catch { throw new Error("A Tencent classroom address is required"); }
    // Only Tencent's classroom page may be placed in the room.
    if (url.origin !== LCIC_EMBED_ORIGIN || url.pathname !== "/latest/class.html") throw new Error("Not a Tencent LCIC classroom address");
    if (!this.container || !this.doc) throw new Error("The room has no place for the classroom");
    if (this.frame) return;
    const frame = this.doc.createElement("iframe");
    frame.src = url.toString();
    frame.allow = LCIC_FRAME_PERMISSIONS;
    frame.referrerPolicy = "no-referrer";
    frame.title = "Tencent LCIC classroom";
    frame.className = "classroom-lcic-frame";
    this.container.replaceChildren(frame);
    this.frame = frame;
    // Connecting only: whether the call is up is known inside Tencent's page and from its callbacks.
    this.emit({ type: "connection", state: "connecting", at: this.now() });
  }

  async leave() {
    if (!this.frame) return;
    this.frame.remove();
    this.frame = null;
    this.emit({ type: "connection", state: "disconnected", at: this.now() });
  }

  // Devices are switched inside Tencent's classroom page.
  async setDevice(): Promise<DeviceState> { return "unavailable"; }

  private emit(event: MediaEvent) {
    for (const listener of this.listeners) listener(event);
  }
}

export type MediaAdapterOptions = SyntheticOptions & { loadZoomSdk?: () => Promise<ZoomVideoSdk>; maxVideos?: number };

export function createMediaAdapter(provider: string, options?: MediaAdapterOptions): ClassroomMediaAdapter {
  if (provider === "synthetic") return new SyntheticMediaAdapter(options);
  if (provider === "zoom-video-sdk") return new ZoomVideoSdkMediaAdapter(options?.loadZoomSdk, undefined, { maxVideos: options?.maxVideos });
  if (provider === "tencent-lcic") return new LcicEmbedAdapter();
  throw new MediaAdapterUnavailableError(provider);
}

// What the tutor's page reports to iHear for a media event, in the vocabulary the host-events
// route already stores. Joins and leaves are reported only with a user key, because a join
// without one would look like an unknown person in the room.
export function hostReportFor(event: MediaEvent): Record<string, unknown> | null {
  if (event.type === "connection") {
    const state = ({ connected: "Connected", reconnecting: "Reconnecting", disconnected: "Closed", failed: "Fail" } as Record<string, string>)[event.state];
    return state ? { type: "connection", state } : null;
  }
  if (event.type === "remote" && event.userKey) return { type: event.present ? "user_added" : "user_removed", userKey: event.userKey };
  // Sent only when the join answer asked for it (classroom-entry.tsx); the server confirms it.
  if (event.type === "session") return { type: "session", sessionId: event.sessionId };
  return null;
}
