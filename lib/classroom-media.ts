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
// claims to carry audio or video (capabilities.realMedia is false). The Zoom adapter works only
// with the SDK package, which is added with the trial account; until then it says so.

export const MEDIA_PROVIDERS = ["synthetic", "zoom-video-sdk", "tencent-lcic"] as const;
export type MediaProviderName = (typeof MEDIA_PROVIDERS)[number];

export type ConnectionState = "idle" | "connecting" | "connected" | "reconnecting" | "disconnected" | "failed";
export type DeviceKind = "camera" | "microphone";
export type DeviceState = "off" | "on" | "denied" | "unavailable";
export type MediaRole = "tutor" | "student";

export type MediaEvent =
  | { type: "connection"; state: ConnectionState; at: number }
  | { type: "device"; kind: DeviceKind; state: DeviceState; at: number }
  // The other person in the room. A real adapter also passes their user key (our participant
  // id, which the session token carries) so the tutor's page can report joins and leaves.
  | { type: "remote"; present: boolean; camera: boolean; microphone: boolean; userKey: string | null; at: number };

export type MediaCapabilities = {
  // True only for an adapter that really carries audio and video.
  realMedia: boolean;
  screenShare: boolean;
  // False when the vendor's own page runs the call (LCIC): our page then sees no connection,
  // device or remote events, and the overview relies on the vendor's callbacks.
  observable: boolean;
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
}

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
  | "camera-denied" | "microphone-unavailable" | "devices-restored";

export const SYNTHETIC_SCENARIOS: readonly SyntheticScenario[] = [
  "remote-joins", "remote-leaves", "remote-camera-off", "remote-camera-on",
  "network-drop", "network-restore", "connection-failed",
  "camera-denied", "microphone-unavailable", "devices-restored",
];

type SyntheticOptions = { connectDelayMs?: number; now?: () => number };

export class SyntheticMediaAdapter implements ClassroomMediaAdapter {
  readonly provider = "synthetic" as const;
  readonly capabilities: MediaCapabilities = { realMedia: false, screenShare: false, observable: true };
  private readonly listeners = new Set<(event: MediaEvent) => void>();
  private connection: ConnectionState = "idle";
  private readonly devices: Record<DeviceKind, DeviceState> = { camera: "off", microphone: "off" };
  private readonly blocked: Record<DeviceKind, DeviceState | null> = { camera: null, microphone: null };
  private remote = { present: false, camera: false, microphone: false };
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
    this.setConnection("connecting");
    if (this.connectDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.connectDelayMs));
    // leave() or a simulated failure may have happened while connecting.
    if ((this.connection as ConnectionState) !== "connecting") return;
    this.setConnection("connected");
  }

  async leave() {
    if (this.connection === "idle" || this.connection === "disconnected") return;
    this.setRemote({ present: false, camera: false, microphone: false });
    this.setConnection("disconnected");
  }

  async setDevice(kind: DeviceKind, on: boolean) {
    const state: DeviceState = this.blocked[kind] ?? (on ? "on" : "off");
    this.devices[kind] = state;
    this.emit({ type: "device", kind, state, at: this.now() });
    return state;
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

// The part of the Zoom Video SDK (web, 2.x) the adapter uses, as Zoom documents it. Only these
// calls are made, so a test can stand in for the SDK. To be checked against the real package.
export type ZoomParticipant = { userId: number; userIdentity?: string; userKey?: string; bVideoOn?: boolean; muted?: boolean; audio?: string };
export type ZoomStream = {
  startAudio(): Promise<unknown>; muteAudio(): Promise<unknown>; unmuteAudio(): Promise<unknown>;
  startVideo(): Promise<unknown>; stopVideo(): Promise<unknown>;
  attachVideo?(userId: number, quality: number): Promise<unknown>; detachVideo?(userId: number): Promise<unknown>;
};
export type ZoomClient = {
  init(language: string, dependentAssets: string, options?: Record<string, unknown>): Promise<unknown>;
  join(topic: string, token: string, userName: string): Promise<unknown>;
  leave(): Promise<unknown>;
  getMediaStream(): ZoomStream;
  getCurrentUserInfo(): { userId: number } | null;
  getAllUser(): ZoomParticipant[];
  on(event: string, handler: (payload: unknown) => void): void;
  off(event: string, handler: (payload: unknown) => void): void;
};
export type ZoomVideoSdk = { createClient(): ZoomClient };

// The npm package @zoom/videosdk is installed together with the trial account (it needs a Video
// SDK key to do anything); until then the adapter reports that it cannot connect.
export async function loadZoomVideoSdkPackage(): Promise<ZoomVideoSdk> {
  throw new MediaAdapterUnavailableError("zoom-video-sdk", "The Zoom Video SDK package is not installed yet (it comes with the trial account)");
}

const ZOOM_CONNECTION: Record<string, ConnectionState> = { Connected: "connected", Reconnecting: "reconnecting", Closed: "disconnected", Fail: "failed" };
const VIDEO_720P = 3;

export class ZoomVideoSdkMediaAdapter implements ClassroomMediaAdapter {
  readonly provider = "zoom-video-sdk" as const;
  readonly capabilities: MediaCapabilities = { realMedia: true, screenShare: false, observable: true };
  private readonly listeners = new Set<(event: MediaEvent) => void>();
  private client: ZoomClient | null = null;
  private stream: ZoomStream | null = null;
  private container: HTMLElement | null = null;
  private audioStarted = false;
  private readonly tiles = new Map<number, unknown>();
  private readonly handlers: [string, (payload: unknown) => void][] = [];

  constructor(private readonly load: () => Promise<ZoomVideoSdk> = loadZoomVideoSdkPackage, private readonly now: () => number = Date.now) {}

  subscribe(listener: (event: MediaEvent) => void) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  mount(element: HTMLElement) { this.container = element; }

  async join(input: MediaJoin) {
    if (!input.sessionToken || !input.sessionName) throw new Error("A Zoom join token and its session name are required");
    if (this.client) return;
    this.emit({ type: "connection", state: "connecting", at: this.now() });
    try {
      const sdk = await this.load();
      const client = sdk.createClient();
      this.client = client;
      // "Global": the default data centres; the China options are not part of phase 1.
      await client.init("en-US", "Global", { patchJsMedia: true });
      this.listen("connection-change", (payload) => {
        const state = ZOOM_CONNECTION[String((payload as { state?: string })?.state)];
        if (state) this.emit({ type: "connection", state, at: this.now() });
      });
      for (const name of ["user-added", "user-updated", "user-removed"]) this.listen(name, () => this.reportRemote());
      this.listen("peer-video-state-change", (payload) => void this.peerVideo(payload as { action?: string; userId?: number }));
      // The display name is the participant code: no student name reaches Zoom.
      await client.join(input.sessionName, input.sessionToken, input.participantCode);
      this.stream = client.getMediaStream();
      this.emit({ type: "connection", state: "connected", at: this.now() });
      this.reportRemote();
    } catch (error) {
      this.client = null;
      this.emit({ type: "connection", state: "failed", at: this.now() });
      throw error;
    }
  }

  async leave() {
    const client = this.client;
    if (!client) return;
    for (const [name, handler] of this.handlers.splice(0)) client.off(name, handler);
    this.client = null; this.stream = null; this.audioStarted = false; this.tiles.clear();
    await client.leave().catch(() => undefined);
    this.container?.replaceChildren();
    this.emit({ type: "connection", state: "disconnected", at: this.now() });
  }

  async setDevice(kind: DeviceKind, on: boolean) {
    const stream = this.stream;
    if (!stream) return "off" as DeviceState;
    let state: DeviceState;
    try {
      if (kind === "microphone") {
        if (on && !this.audioStarted) { await stream.startAudio(); this.audioStarted = true; }
        else if (on) await stream.unmuteAudio();
        else if (this.audioStarted) await stream.muteAudio();
      } else if (on) {
        await stream.startVideo();
        const self = this.client?.getCurrentUserInfo()?.userId;
        if (self != null) await this.attach(self);
      } else await stream.stopVideo();
      state = on ? "on" : "off";
    } catch (error) {
      state = (error as { name?: string })?.name === "NotAllowedError" || /PERMISSION/i.test(String((error as { type?: string })?.type ?? "")) ? "denied" : "unavailable";
    }
    this.emit({ type: "device", kind, state, at: this.now() });
    return state;
  }

  private listen(name: string, handler: (payload: unknown) => void) {
    this.client?.on(name, handler);
    this.handlers.push([name, handler]);
  }

  private reportRemote() {
    const self = this.client?.getCurrentUserInfo()?.userId;
    const other = this.client?.getAllUser().find(user => user.userId !== self) ?? null;
    // The user key is our participant id from the join token; Zoom reports it on each person.
    this.emit({
      type: "remote", present: Boolean(other), camera: Boolean(other?.bVideoOn), microphone: Boolean(other && other.audio && !other.muted),
      userKey: other ? (other.userKey ?? other.userIdentity ?? null) : null, at: this.now(),
    });
  }

  private async peerVideo(payload: { action?: string; userId?: number }) {
    if (payload.userId == null) return;
    if (payload.action === "Start") await this.attach(payload.userId);
    else if (payload.action === "Stop") { await this.stream?.detachVideo?.(payload.userId); this.tiles.delete(payload.userId); }
    this.reportRemote();
  }

  private async attach(userId: number) {
    if (!this.stream?.attachVideo || !this.container || this.tiles.has(userId)) return;
    const element = await this.stream.attachVideo(userId, VIDEO_720P);
    this.tiles.set(userId, element);
    if (element && typeof (element as Node).nodeType === "number") this.container.append(element as Node);
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
  readonly capabilities: MediaCapabilities = { realMedia: true, screenShare: true, observable: false };
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

export type MediaAdapterOptions = SyntheticOptions & { loadZoomSdk?: () => Promise<ZoomVideoSdk> };

export function createMediaAdapter(provider: string, options?: MediaAdapterOptions): ClassroomMediaAdapter {
  if (provider === "synthetic") return new SyntheticMediaAdapter(options);
  if (provider === "zoom-video-sdk") return new ZoomVideoSdkMediaAdapter(options?.loadZoomSdk);
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
  return null;
}
