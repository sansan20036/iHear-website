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

export type MediaEvent =
  | { type: "connection"; state: ConnectionState; at: number }
  | { type: "device"; kind: DeviceKind; state: DeviceState; problem?: DeviceProblem; at: number }
  // The other person in the room. A real adapter also passes their user key (our participant
  // id, which the session token carries) so the tutor's page can report joins and leaves.
  // P3-Multi: in a room of several, how many others are there and how many of their videos are shown
  // (a phone shows at most 9 tiles, a computer 25) or waiting for a free tile.
  | { type: "remote"; present: boolean; camera: boolean; microphone: boolean; userKey: string | null; at: number; others?: number; videosShown?: number; videosWaiting?: number }
  // Materials and the whiteboard: what this page is showing or sending right now.
  | { type: "share"; state: "none" | "sending" | "receiving"; at: number }
  | { type: "whiteboard"; state: "none" | "presenting" | "viewing"; at: number }
  // The vendor's id for the session this page joined. Nothing on the page shows it; the tutor's
  // page reports it where the server confirms such ids with the vendor.
  | { type: "session"; sessionId: string; at: number }
  // In-class chat (2026-11-12): one line, this page's own or someone else's. Never reported to iHear
  // and never saved: the page shows it until the room is left.
  | { type: "chat"; line: ChatLine; at: number }
  // The hands raised in the room right now (this page's own among them, marked self).
  | { type: "hands"; raised: RaisedHand[]; at: number };

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
  subscribe(listener: (event: MediaEvent) => void): () => void;
  // Where the vendor draws video or its classroom; the synthetic stand-in draws nothing.
  mount?(element: HTMLElement): void;
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
  | "remote-chat" | "remote-raises-hand" | "remote-lowers-hand";

export const SYNTHETIC_SCENARIOS: readonly SyntheticScenario[] = [
  "remote-joins", "remote-leaves", "remote-camera-off", "remote-camera-on",
  "network-drop", "network-restore", "connection-failed",
  "camera-denied", "microphone-unavailable", "devices-restored",
  "remote-chat", "remote-raises-hand", "remote-lowers-hand",
];
// The other person's line in the synthetic room: no real person writes it.
const SYNTHETIC_CHAT = "TEST: Hello / 你好 / 你好";

type SyntheticOptions = { connectDelayMs?: number; now?: () => number };

export class SyntheticMediaAdapter implements ClassroomMediaAdapter {
  readonly provider = "synthetic" as const;
  readonly capabilities: MediaCapabilities = { realMedia: false, screenShare: false, whiteboard: false, observable: true, chat: true, raiseHand: true };
  private readonly listeners = new Set<(event: MediaEvent) => void>();
  private connection: ConnectionState = "idle";
  private readonly devices: Record<DeviceKind, DeviceState> = { camera: "off", microphone: "off" };
  private readonly blocked: Record<DeviceKind, DeviceState | null> = { camera: null, microphone: null };
  private remote = { present: false, camera: false, microphone: false };
  // Chat and raised hands stay on this page: nothing travels to another page or the server.
  private role: MediaRole = "student";
  private readonly hands = new Map<string, RaisedHand>();
  private lines = 0;
  private readonly connectDelayMs: number;
  private readonly now: () => number;

  constructor(options: SyntheticOptions = {}) {
    this.connectDelayMs = options.connectDelayMs ?? 300;
    this.now = options.now ?? Date.now;
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
    this.setConnection("connecting");
    if (this.connectDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.connectDelayMs));
    // leave() or a simulated failure may have happened while connecting.
    if ((this.connection as ConnectionState) !== "connecting") return;
    this.setConnection("connected");
  }

  async leave() {
    if (this.connection === "idle" || this.connection === "disconnected") return;
    this.setRemote({ present: false, camera: false, microphone: false });
    this.clearHands();
    this.setConnection("disconnected");
  }

  async setDevice(kind: DeviceKind, on: boolean) {
    const state: DeviceState = this.blocked[kind] ?? (on ? "on" : "off");
    this.devices[kind] = state;
    this.emit({ type: "device", kind, state, at: this.now() });
    return state;
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
          this.setRemote({ present: false, camera: false, microphone: false });
          this.setConnection("failed");
        }
        break;
      case "camera-denied":
        this.block("camera", "denied");
        break;
      case "microphone-unavailable":
        this.block("microphone", "unavailable");
        break;
      case "devices-restored":
        for (const kind of ["camera", "microphone"] as const) {
          if (!this.blocked[kind]) continue;
          this.blocked[kind] = null;
          this.devices[kind] = "off";
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
    }
  }

  private block(kind: DeviceKind, state: DeviceState) {
    this.blocked[kind] = state;
    this.devices[kind] = state;
    this.emit({ type: "device", kind, state, at: this.now() });
  }

  private setConnection(state: ConnectionState) {
    if (this.connection === state) return;
    this.connection = state;
    this.emit({ type: "connection", state, at: this.now() });
  }

  private setRemote(next: { present: boolean; camera: boolean; microphone: boolean }) {
    if (next.present === this.remote.present && next.camera === this.remote.camera && next.microphone === this.remote.microphone) return;
    this.remote = next;
    // The synthetic room has no real other person, so there is no user key to report.
    this.emit({ type: "remote", ...next, userKey: null, at: this.now() });
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
  startAudio(): Promise<unknown>; stopAudio(): Promise<unknown>; muteAudio(): Promise<unknown>; unmuteAudio(): Promise<unknown>;
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
// How long a press of the camera or microphone may wait for Zoom before the page offers to try
// again; starting normally takes a second or two.
const DEVICE_START_MS = 10_000;
type DeviceAnswer = { state: DeviceState; problem?: DeviceProblem };
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
  private sharing: "none" | "sending" | "receiving" = "none";
  private sharer: number | null = null;
  private board: "none" | "presenting" | "viewing" = "none";
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
  // The room (session name) this page joined last; a join to another room moves there (D-5).
  private sessionName: string | null = null;
  // This page's camera and microphone, the latest press of each, and the press now waiting for Zoom.
  private readonly devices: Record<DeviceKind, DeviceState> = { camera: "off", microphone: "off" };
  private readonly presses: Record<DeviceKind, number> = { camera: 0, microphone: 0 };
  private readonly waiting: Partial<Record<DeviceKind, (answer: DeviceAnswer) => void>> = {};
  // Presses made while Zoom is still finishing the join, waiting for its media stream.
  private readonly streamWaiters = new Set<() => void>();
  private readonly deviceStartMs: number;

  constructor(private readonly load: () => Promise<ZoomVideoSdk> = loadZoomVideoSdkPackage, private readonly now: () => number = Date.now, options: { deviceStartMs?: number; maxVideos?: number } = {}) {
    this.deviceStartMs = options.deviceStartMs ?? DEVICE_START_MS;
    this.maxVideos = options.maxVideos ?? MAX_REMOTE_VIDEOS.desktop;
  }

  subscribe(listener: (event: MediaEvent) => void) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  // Zoom draws each video into a <video-player-container> and a shared screen into another one
  // (its rule: the two are never mixed); the whiteboard and the tutor's own share get plain elements.
  mount(element: HTMLElement) {
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
    element.replaceChildren(this.stage.share, this.stage.whiteboard, this.stage.videos, this.stage.ownShare);
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
        if (state) this.setConnection(state);
      });
      // Someone new hears this page's raised hand again (Zoom keeps no hands of its own); someone who
      // leaves takes theirs along.
      listen("user-added", () => {
        this.reportRemote();
        if (this.handUp) void this.sendCommand(handCommand(true));
      });
      listen("user-updated", () => this.reportRemote());
      listen("user-removed", (payload) => {
        this.reportRemote();
        this.dropHands(payload);
      });
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
        if (action === "join") this.audioStarted = true;
        if (action === "leave") this.audioStarted = false;
        if (action === "join" || action === "unmuted") this.fromZoom("microphone", { state: "on" });
        else if ((action === "muted" || action === "leave") && this.devices.microphone === "on") this.fromZoom("microphone", { state: "off" });
      });
      // Zoom: this "may occur when invoking stream.startAudio() immediately after joining"; the
      // browser waits for the person to press something again.
      listen("auto-play-audio-failed", () => this.fromZoom("microphone", { state: "failed", problem: "autoplay" }));
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
    this.client = null; this.stream = null; this.audioStarted = false; this.tiles.clear(); this.sharer = null;
    for (const ready of [...this.streamWaiters]) ready();
    // A press still waiting ends with the room; the next join starts with both devices off, and the
    // page is told so (after a reconnect it must not still show a device as on).
    for (const kind of ["camera", "microphone"] as const) {
      this.presses[kind] += 1;
      const pending = this.waiting[kind];
      delete this.waiting[kind];
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
    this.setShare("none");
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
    // After a press that did not start, Zoom's half-started camera or audio is cleared first.
    const retry = this.devices[kind] === "failed";
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
    const answer = await this.start(kind, stream, retry);
    // A later press, or leaving, took over: its own answer stands.
    if (press !== this.presses[kind] || stream !== this.stream) return this.devices[kind];
    await this.settle(kind, answer);
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

  // Zoom's call, Zoom's own report or the deadline, whichever comes first.
  private start(kind: DeviceKind, stream: ZoomStream, retry: boolean) {
    return new Promise<DeviceAnswer>((resolve) => {
      const deadline = setTimeout(() => done({ state: "failed", problem: "timeout" }), this.deviceStartMs);
      const done = (answer: DeviceAnswer) => {
        clearTimeout(deadline);
        if (this.waiting[kind] === done) delete this.waiting[kind];
        resolve(answer);
      };
      this.waiting[kind] = done;
      this.callStart(kind, stream, retry).then(() => done({ state: "on" }), (error: unknown) => done(deviceAnswerOf(error)));
    });
  }

  private async callStart(kind: DeviceKind, stream: ZoomStream, retry: boolean) {
    if (kind === "camera") {
      // Already capturing: an earlier press started after all.
      if (stream.isCapturingVideo()) return;
      if (retry) await stream.stopVideo().catch(() => undefined);
      await stream.startVideo();
      return;
    }
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
    if (!board.isWhiteboardEnabled() || !board.canStartWhiteboard()) return false;
    stage.whiteboard.hidden = false;
    try {
      await board.startWhiteboardScreen(stage.whiteboard);
    } catch {
      this.hideBoard();
      return false;
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

  private reportRemote() {
    const self = this.client?.getCurrentUserInfo()?.userId;
    const others = this.client?.getAllUser().filter(user => user.userId !== self) ?? [];
    const other = others[0] ?? null;
    // The user key is our participant id from the join token; Zoom reports it on each person.
    this.emit({
      type: "remote", present: Boolean(other), camera: Boolean(other?.bVideoOn), microphone: Boolean(other && other.audio && !other.muted),
      userKey: other ? (other.userKey ?? other.userIdentity ?? null) : null, at: this.now(),
      others: others.length, videosShown: [...this.tiles.keys()].length, videosWaiting: this.waitingVideos.size,
    });
  }

  private async peerVideo(payload: { action?: string; userId?: number }) {
    if (payload.userId == null) return;
    if (payload.action === "Start") await this.attach(payload.userId);
    else if (payload.action === "Stop") {
      if (this.waitingVideos.delete(payload.userId)) { this.reportRemote(); return; }
      await this.stream?.detachVideo(payload.userId);
      this.tiles.delete(payload.userId);
      // A tile came free: the longest-waiting video takes it.
      const next = this.waitingVideos.values().next();
      if (!next.done) { this.waitingVideos.delete(next.value); await this.attach(next.value); }
    }
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
      if (isNode(element)) this.stage.videos.append(element);
    } catch (error) {
      this.tiles.delete(userId);
      throw error;
    }
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
      stage.whiteboard.hidden = false;
      await board.startWhiteboardView(stage.whiteboard, payload.userId).then(() => this.setBoard("viewing"), () => this.hideBoard());
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
    this.setBoard("none");
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
