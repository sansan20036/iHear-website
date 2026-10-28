// The browser side of the classroom's video provider: joining the room, the camera and the
// microphone, and what the connection is doing. Pages use only this interface, so a vendor SDK
// (Tencent RTC, Agora or the Zoom Video SDK, none chosen yet) can be added later as one more
// adapter without touching the classroom page.
//
// Recording is deliberately not here. The server alone starts and stops it after the consent
// check, so no browser, and no SDK running in one, can start a recording.
//
// Only the synthetic stand-in exists. It has no camera, no microphone and no network: it plays
// the states a real SDK reports, so the page, the tutor's reports and the overview can be shown
// and tested. It never claims to carry audio or video (capabilities.realMedia is false).

export const MEDIA_PROVIDERS = ["synthetic", "tencent-rtc", "agora", "zoom-video-sdk"] as const;
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
};

export type MediaJoin = { sessionToken: string; lessonCode: string; participantCode: string; role: MediaRole };

export interface ClassroomMediaAdapter {
  readonly provider: MediaProviderName;
  readonly capabilities: MediaCapabilities;
  join(input: MediaJoin): Promise<void>;
  leave(): Promise<void>;
  setDevice(kind: DeviceKind, on: boolean): Promise<DeviceState>;
  subscribe(listener: (event: MediaEvent) => void): () => void;
}

export class MediaAdapterUnavailableError extends Error {
  constructor(readonly provider: string) {
    super(MEDIA_PROVIDERS.includes(provider as MediaProviderName)
      ? `The ${provider} adapter is not built yet: no video SDK has been chosen`
      : `Unknown video provider: ${provider || "(none)"}`);
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
  readonly capabilities: MediaCapabilities = { realMedia: false, screenShare: false };
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

export function createMediaAdapter(provider: string, options?: SyntheticOptions): ClassroomMediaAdapter {
  if (provider === "synthetic") return new SyntheticMediaAdapter(options);
  // Tencent RTC, Agora and the Zoom Video SDK each get an adapter here once one is chosen and
  // accepted in the cross-region tests; until then the page says the video is not connected.
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
