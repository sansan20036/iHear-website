import { createHmac } from "node:crypto";

// @ts-ignore - shared classroom logic, plain JavaScript tested with node --test.
import { buildSessionTokenClaims, generationOfRoom, roomNameOf, signSessionToken } from "../../tools/recording-pathway/classroom/eligibility.mjs";
// @ts-ignore - shared classroom logic, plain JavaScript tested with node --test.
import { checkVendorRange, classifyVendorResponse, FAILURE, FilingError } from "../../tools/recording-pathway/classroom/recording-filing.mjs";
import type { ClassroomProvider, KnownSession, ProviderCall } from "../classroom-provider";
import type { ClassroomLesson } from "../classroom-store";
import { fetchTransport, headerOf, setting, type VendorResponse, type VendorTransport } from "./http";

// The Zoom Video SDK on the server: the join token the browser's adapter uses, and the REST
// calls the iHear server makes for recording and ending a session, so recording follows the
// lesson's consent decision (never Zoom's automatic recording). Written from Zoom's Video SDK API
// reference (checked 2026-10-31); NOT yet run against a real Video SDK account. Calls Zoom does
// not offer, or that are not wired yet, answer 501 without a request.
//   Join token: HS256 JWT with app_key, tpc, role_type, version, session_key, user_key, iat, exp
//   REST auth:  a Video SDK API JWT (iss = API key, signed with the API secret), Bearer header;
//               the claim layout is still to be confirmed by a first read-only call
//   Recording:  PATCH /v2/videosdk/sessions/{sessionId}/events {"method":"recording.start"|"recording.stop"} -> 202
//   End:        PUT   /v2/videosdk/sessions/{sessionId}/status {"action":"end"}
//   Look-ups:   GET   /v2/videosdk/sessions/{sessionId}?type=live|past (default live), .../users?type=...,
//               .../recordings (no type)
// Zoom's session id comes from its webhooks, its API answers, or the tutor's page (Video SDK
// getSessionInfo().sessionId), and the last only once Zoom has confirmed the session is this
// lesson's (verifySession). A lesson can run in several sessions; each file is fetched from its
// own session.

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

/**
 * A session id in a URL path, as Zoom's API reference asks (2026-10-31): the recordings calls
 * want it encoded twice when it contains any "/"; the session, users, events and status calls
 * when it begins with "/" or contains "//". Otherwise once.
 */
export function zoomSessionPath(id: string, rule: "session" | "recordings") {
  const twice = rule === "recordings" ? id.includes("/") : id.startsWith("/") || id.includes("//");
  const once = encodeURIComponent(id);
  return twice ? encodeURIComponent(once) : once;
}

type Options = {
  transport?: VendorTransport;
  // The lesson's Zoom sessions known from trusted facts (Zoom's own notices and answers, and ids
  // confirmed with Zoom), oldest first; the last is the session the lesson is in, or was in last.
  sessionsOf: (lesson: ClassroomLesson) => Promise<KnownSession[]>;
  now?: () => number;
};

const notOffered = async (): Promise<ProviderCall> => ({ ok: false, httpStatus: 501 });

export function zoomVideoSdkProvider(config: ZoomVideoSdkConfig, options: Options): ClassroomProvider {
  const transport = options.transport ?? fetchTransport;
  const now = options.now ?? Date.now;
  const json = (text: string) => { try { return JSON.parse(text) as Record<string, unknown>; } catch { return null; } };
  // No answer at all is status 0, which is retried like a server error.
  const request = async (method: "GET" | "PUT" | "PATCH", path: string, body?: unknown): Promise<VendorResponse> => {
    try {
      return await transport({
        method,
        url: `${config.apiBase}${path}`,
        headers: { Authorization: `Bearer ${zoomApiToken(config, now())}`, ...(body ? { "Content-Type": "application/json" } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch {
      return { status: 0, body: "" };
    }
  };
  const sessionPath = (id: string, suffix = "") => `/videosdk/sessions/${zoomSessionPath(id, suffix === "/recordings" ? "recordings" : "session")}${suffix}`;
  // A request for one session: the one named (G-3: the server names each session it means), or
  // without a name the lesson's latest known session, as before.
  const control = async (lesson: ClassroomLesson, method: "PATCH" | "PUT", suffix: string, body: unknown, sessionId?: string): Promise<ProviderCall> => {
    const id = sessionId ?? (await options.sessionsOf(lesson)).at(-1)?.id;
    // No confirmed session yet (nobody joined, or the id is still being checked): nothing to control.
    if (!id) return { ok: false, httpStatus: 409 };
    const response = await request(method, sessionPath(id, suffix), body);
    return { ok: response.status >= 200 && response.status < 300, httpStatus: response.status };
  };
  // A session's details. Zoom describes a session only under its own type (live by default), so
  // a session that has ended must be asked as past; 400 and 404 mean "not under this type".
  const details = async (id: string, order: ("live" | "past")[]) => {
    let status = 404;
    for (const type of order) {
      const response = await request("GET", `${sessionPath(id)}?type=${type}`);
      if (response.status === 200) return { found: true as const, type, body: json(response.body) };
      status = response.status;
      if (status !== 400 && status !== 404) break;
    }
    return { found: false as const, status };
  };
  // One session's recording files: [] when it has none (404), null when Zoom would not say.
  const recordingsOf = async (id: string) => {
    const response = await request("GET", sessionPath(id, "/recordings"));
    if (response.status === 404) return { files: [] as Record<string, unknown>[], response };
    if (response.status !== 200) return { files: null, response };
    return { files: (json(response.body)?.recording_files as Record<string, unknown>[] | undefined) ?? [], response };
  };
  return {
    name: "zoom-video-sdk",
    webhookSecret: config.webhookSecret,
    sessionToken({ lesson, participant, now: at, generation = 0 }) {
      const claims = buildSessionTokenClaims({ lesson, participant, appKey: config.sdkKey, now: at, generation });
      return { token: signSessionToken(claims, config.sdkSecret), issuedAt: claims.iat * 1000, expiresAt: claims.exp * 1000 };
    },
    async prepareJoin({ lesson, participant, now: at, generation = 0 }) {
      const token = this.sessionToken({ lesson, participant, now: at, generation });
      // The browser must join the same topic (tpc) the token names: the room's current generation.
      return { kind: "sdk", ...token, sessionName: roomNameOf(lesson.id, generation) };
    },
    startRecording: (lesson, sessionId) => control(lesson, "PATCH", "/events", { method: "recording.start" }, sessionId),
    stopRecording: (lesson, sessionId) => control(lesson, "PATCH", "/events", { method: "recording.stop" }, sessionId),
    endSession: (lesson, sessionId) => control(lesson, "PUT", "/status", { action: "end" }, sessionId),
    // Not offered as a REST call for Video SDK sessions: the tutor's page removes a person
    // through the SDK, and the overview flags anyone it could not remove.
    removeUser: notOffered,
    // A session id the tutor's page reported, checked with Zoom before anything acts on it: the
    // session must exist and carry this lesson's key (the token's session_key) or name (its tpc),
    // and contradict neither. null: Zoom could not be asked now, so ask again later.
    async verifySession(lesson, sessionId) {
      const found = await details(sessionId, ["live", "past"]);
      if (!found.found) return found.status === 400 || found.status === 404 ? { verified: false, reason: "NOT_FOUND" } : null;
      const key = found.body?.session_key, name = found.body?.session_name;
      const keyMatches = typeof key === "string" && key ? key === lesson.id : null;
      // Any generation of this lesson's room (D-1) is this lesson's; another name is not.
      const nameMatches = typeof name === "string" && name ? generationOfRoom(lesson.id, name) !== null : null;
      if (keyMatches === false || nameMatches === false || (keyMatches === null && nameMatches === null)) return { verified: false, reason: "MISMATCH" };
      return { verified: true, ended: found.type === "past", ...(nameMatches ? { name: String(name).toLowerCase() } : {}) };
    },
    // The current session's details and people (as past once it has ended), its recordings, and
    // the recordings of any earlier session whose files are not known yet. Recordings are asked
    // for even when Zoom no longer describes the session.
    async snapshot(lesson) {
      const sessions = await options.sessionsOf(lesson);
      const session = sessions.at(-1);
      if (!session) return null;
      const found = await details(session.id, session.ended ? ["past", "live"] : ["live", "past"]);
      const people = found.found ? await request("GET", `${sessionPath(session.id, "/users")}?type=${found.type}`) : null;
      const own = await recordingsOf(session.id);
      if (!found.found && own.files === null) return null;
      const earlier: { providerSessionId: string; recordings: Record<string, unknown>[] }[] = [];
      for (const entry of sessions.slice(0, -1)) {
        if (entry.recordingsKnown) continue;
        const listed = await recordingsOf(entry.id);
        if (listed.files) earlier.push({ providerSessionId: entry.id, recordings: listed.files });
      }
      return {
        lessonId: lesson.id,
        providerSessionId: session.id,
        details: found.found ? found.body : null,
        users: people?.status === 200 ? ((json(people.body)?.users as Record<string, unknown>[] | undefined) ?? []) : [],
        recordings: own.files ?? [],
        sessions: earlier,
      };
    },
    // One byte range of a finished recording, from the recording's own session (or, for a record
    // that does not name one, the lesson's sessions from the newest). The download address is read
    // fresh each time, so no signed address is ever stored, and the answer is checked: the bytes
    // sent and the whole file's size must be the ones asked for and the ones Zoom's notice gave.
    async download(record, { start, end }) {
      const ids = record.providerSessionId
        ? [String(record.providerSessionId)]
        : (await options.sessionsOf({ id: String(record.lessonId ?? "") } as ClassroomLesson)).map((entry) => entry.id).reverse();
      for (const id of ids) {
        const listed = await recordingsOf(id);
        if (listed.files === null) {
          const failure = classifyVendorResponse({ status: listed.response.status, retryAfter: headerOf(listed.response, "retry-after") });
          throw new FilingError(failure.code, `Zoom answered ${listed.response.status} to the list of recordings`, failure);
        }
        const file = listed.files.find((entry) => String(entry.id) === record.providerFileId);
        if (!file) continue;
        const url = typeof file.download_url === "string" ? file.download_url : "";
        if (!url.startsWith("https://")) throw new FilingError(FAILURE.TRANSIENT, "The recording's download address is not available yet");
        let response: VendorResponse;
        try {
          response = await transport({ method: "GET", url, headers: { Authorization: `Bearer ${zoomApiToken(config, now())}`, Range: `bytes=${start}-${end - 1}` } });
        } catch {
          throw new FilingError(FAILURE.TRANSIENT, "No answer from Zoom's download");
        }
        return checkVendorRange({
          status: response.status, contentRange: headerOf(response, "content-range"), retryAfter: headerOf(response, "retry-after"),
          bytes: response.bytes ?? Buffer.from(response.body), start, end, size: Number(record.size),
        });
      }
      throw new FilingError(FAILURE.VENDOR_FILE_GONE, "Zoom no longer lists this recording");
    },
    // Zoom documents deleting a recording file (DELETE .../recordings/{recordingId}, action=trash,
    // with "The host can delete cloud recordings" on). It is not wired: Zoom's copy stays until the
    // retention decisions are made (see lib/classroom-switches.ts).
    deleteRecording: notOffered,
  };
}
