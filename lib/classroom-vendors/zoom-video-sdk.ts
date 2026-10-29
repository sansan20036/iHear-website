import { createHmac } from "node:crypto";

// @ts-ignore - shared classroom logic, plain JavaScript tested with node --test.
import { buildSessionTokenClaims, roomNameOf, signSessionToken } from "../../tools/recording-pathway/classroom/eligibility.mjs";
import type { ClassroomProvider, ProviderCall } from "../classroom-provider";
import type { ClassroomLesson } from "../classroom-store";
import { fetchTransport, setting, type VendorTransport } from "./http";

// The Zoom Video SDK on the server: the join token the browser's adapter uses, and the REST
// calls the iHear server makes for recording and ending a session, so recording follows the
// lesson's consent decision (never Zoom's automatic recording). Written from Zoom's
// documentation (2026-10-30); NOT yet run against a real Video SDK account. Endpoints marked
// "not documented" answer 501 instead of guessing.
//   Join token: HS256 JWT with app_key, tpc, role_type, version, session_key, user_key, iat, exp
//   REST auth:  a Video SDK API JWT (iss = API key, signed with the API secret), Bearer header
//   Recording:  PATCH /v2/videosdk/sessions/{sessionId}/events {"method":"recording.start"|"recording.stop"} -> 202
//   End:        PUT   /v2/videosdk/sessions/{sessionId}/status {"action":"end"}

export type ZoomVideoSdkConfig = {
  sdkKey: string; sdkSecret: string;
  apiKey: string; apiSecret: string;
  webhookSecret: string;
  apiBase: string;
};

/** The configuration, or null unless every value is set. Values are never logged. */
export function zoomVideoSdkConfig(env: Record<string, string | undefined>): ZoomVideoSdkConfig | null {
  const sdkKey = setting(env, "ZOOM_VIDEO_SDK_KEY"), sdkSecret = setting(env, "ZOOM_VIDEO_SDK_SECRET");
  const apiKey = setting(env, "ZOOM_VIDEO_SDK_API_KEY"), apiSecret = setting(env, "ZOOM_VIDEO_SDK_API_SECRET");
  const webhookSecret = setting(env, "ZOOM_VIDEO_SDK_WEBHOOK_SECRET");
  if (!sdkKey || !sdkSecret || !apiKey || !apiSecret || !webhookSecret) return null;
  return { sdkKey, sdkSecret, apiKey, apiSecret, webhookSecret, apiBase: setting(env, "ZOOM_API_BASE") || "https://api.zoom.us/v2" };
}

/** The REST token: valid for at most an hour, as Zoom recommends. */
export function zoomApiToken(config: Pick<ZoomVideoSdkConfig, "apiKey" | "apiSecret">, now: number) {
  const iat = Math.floor(now / 1000);
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const body = `${encode({ alg: "HS256", typ: "JWT" })}.${encode({ iss: config.apiKey, iat, exp: iat + 3600 })}`;
  return `${body}.${createHmac("sha256", config.apiSecret).update(body).digest("base64url")}`;
}

type Options = {
  transport?: VendorTransport;
  // Zoom's own session id for a lesson, from the stored session.started notice.
  sessionIdOf: (lesson: ClassroomLesson) => Promise<string | null>;
  now?: () => number;
};

const notDocumented = async (): Promise<ProviderCall> => ({ ok: false, httpStatus: 501 });

export function zoomVideoSdkProvider(config: ZoomVideoSdkConfig, options: Options): ClassroomProvider {
  const transport = options.transport ?? fetchTransport;
  const now = options.now ?? Date.now;
  const call = async (method: "GET" | "PUT" | "PATCH", lesson: ClassroomLesson, suffix: string, body?: unknown) => {
    const sessionId = await options.sessionIdOf(lesson);
    // Zoom has not reported the session yet (nobody joined): there is nothing to control.
    if (!sessionId) return { ok: false, httpStatus: 409, body: "" };
    const response = await transport({
      method,
      url: `${config.apiBase}/videosdk/sessions/${encodeURIComponent(sessionId)}${suffix}`,
      headers: { Authorization: `Bearer ${zoomApiToken(config, now())}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { ok: response.status >= 200 && response.status < 300, httpStatus: response.status, body: response.body, bytes: response.bytes };
  };
  const control = async (lesson: ClassroomLesson, method: string) => {
    const result = await call("PATCH", lesson, "/events", { method });
    return { ok: result.ok, httpStatus: result.httpStatus };
  };
  const json = (text: string) => { try { return JSON.parse(text) as Record<string, unknown>; } catch { return null; } };
  return {
    name: "zoom-video-sdk",
    webhookSecret: config.webhookSecret,
    sessionToken({ lesson, participant, now: at }) {
      const claims = buildSessionTokenClaims({ lesson, participant, appKey: config.sdkKey, now: at });
      return { token: signSessionToken(claims, config.sdkSecret), issuedAt: claims.iat * 1000, expiresAt: claims.exp * 1000 };
    },
    async prepareJoin({ lesson, participant, now: at }) {
      const token = this.sessionToken({ lesson, participant, now: at });
      // The browser must join the same topic (tpc) the token names.
      return { kind: "sdk", ...token, sessionName: roomNameOf(lesson.id) };
    },
    startRecording: (lesson) => control(lesson, "recording.start"),
    stopRecording: (lesson) => control(lesson, "recording.stop"),
    async endSession(lesson) {
      const result = await call("PUT", lesson, "/status", { action: "end" });
      return { ok: result.ok, httpStatus: result.httpStatus };
    },
    // Not documented as a REST call for Video SDK sessions: the tutor's page removes a person
    // through the SDK, and the overview flags anyone it could not remove.
    removeUser: notDocumented,
    async snapshot(lesson) {
      const details = await call("GET", lesson, "");
      if (!details.ok) return null;
      const users = await call("GET", lesson, "/users");
      const recordings = await call("GET", lesson, "/recordings");
      const parsed = json(details.body);
      return {
        lessonId: lesson.id,
        providerSessionId: typeof parsed?.id === "string" ? parsed.id : await options.sessionIdOf(lesson),
        details: parsed,
        users: users.ok ? ((json(users.body)?.users as Record<string, unknown>[] | undefined) ?? []) : [],
        recordings: recordings.ok ? ((json(recordings.body)?.recording_files as Record<string, unknown>[] | undefined) ?? []) : [],
      };
    },
    // One byte range of a finished recording. The download address is read fresh from the
    // session's recordings each time, so no signed address is ever stored.
    async download(record, { start, end }) {
      const lesson = { id: String(record.lessonId ?? "") } as ClassroomLesson;
      const listed = await call("GET", lesson, "/recordings");
      const file = listed.ok ? ((json(listed.body)?.recording_files as Record<string, unknown>[] | undefined) ?? []).find(entry => String(entry.id) === record.providerFileId) : null;
      const url = typeof file?.download_url === "string" ? file.download_url : null;
      if (!url || !url.startsWith("https://")) throw new Error("The recording's download address is not available");
      const response = await transport({ method: "GET", url, headers: { Authorization: `Bearer ${zoomApiToken(config, now())}`, Range: `bytes=${start}-${end - 1}` } });
      if (response.status !== 206 && !(response.status === 200 && start === 0)) throw new Error(`Download answered ${response.status}`);
      return response.bytes ?? Buffer.from(response.body);
    },
    // Not documented for Video SDK recordings yet: files stay at Zoom until removed by hand.
    deleteRecording: notDocumented,
  };
}
