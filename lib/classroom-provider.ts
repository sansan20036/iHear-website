import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

// @ts-ignore - shared classroom logic, plain JavaScript tested with node --test.
import { buildSessionTokenClaims, signSessionToken } from "../tools/recording-pathway/classroom/eligibility.mjs";
import { MEDIA_PROVIDERS, type MediaProviderName } from "./classroom-media";
import { recordingDecision } from "./classroom-service";
import { classroomStore, type ClassroomEvent, type ClassroomLesson, type ClassroomParticipant, type RecordingFile } from "./classroom-store";
import { vendorDeletionEnabled } from "./classroom-switches";
import { fileRoomRegistry, tencentLcicConfig, tencentLcicProvider } from "./classroom-vendors/tencent-lcic";
import { zoomVideoSdkConfig, zoomVideoSdkProvider } from "./classroom-vendors/zoom-video-sdk";

// The server side of the video provider behind the classroom; the browser side is
// lib/classroom-media.ts, and both use the same provider names. The candidates (2026-10-30) are
// the Zoom Video SDK and Tencent LCIC (lib/classroom-vendors/); neither is chosen, and neither
// has run against a real account. Each needs its own configuration and refuses to start without
// it. The synthetic provider is the local stand-in: it accepts the server's requests (start or stop recording, end the
// session, remove someone), records each request, and leaves the provider's side (webhooks,
// snapshots) to the tests. Its webhooks are Zoom-shaped because the first design targeted
// Zoom. It never runs in production. A real provider implements this same type, and is
// accepted against the real service separately.

export type ProviderCall = { ok: boolean; httpStatus: number };
export type ProviderSnapshot = {
  lessonId: string;
  providerSessionId: string | null;
  // null when the vendor would not describe the session (then only its recordings are used).
  details: Record<string, unknown> | null;
  users: Record<string, unknown>[];
  recordings: Record<string, unknown>[];
  // Earlier sessions of the lesson whose recordings were asked for as well.
  sessions?: { providerSessionId: string; recordings: Record<string, unknown>[] }[];
};
// A vendor session of a lesson, from trusted facts only (see knownSessions).
export type KnownSession = { id: string; ended: boolean; recordingsKnown: boolean };
// The vendor's answer about a session id the tutor's page reported; null when it could not be
// asked now.
export type SessionCheck = { verified: true; ended: boolean } | { verified: false; reason: "NOT_FOUND" | "MISMATCH" } | null;
export type SessionToken = { token: string; issuedAt: number; expiresAt: number };
// What the browser needs to enter: a token for an SDK (Zoom, synthetic), or the address of the
// vendor's classroom page (LCIC). The token's hash is what iHear stores, never the token.
export type PreparedJoin =
  | (SessionToken & { kind: "sdk"; sessionName?: string })
  | (SessionToken & { kind: "embed"; embedUrl: string; recordingDisabled: boolean });

export type ClassroomProvider = {
  name: MediaProviderName;
  webhookSecret: string | null;
  // The token the browser's media adapter joins with; it names the participant by our id.
  sessionToken(input: { lesson: ClassroomLesson; participant: ClassroomParticipant; now: number }): SessionToken;
  // A provider whose entry needs the vendor's API (LCIC creates the room and logs people in).
  prepareJoin?(input: { lesson: ClassroomLesson; participant: ClassroomParticipant; now: number }): Promise<PreparedJoin>;
  startRecording(lesson: ClassroomLesson): Promise<ProviderCall>;
  stopRecording(lesson: ClassroomLesson): Promise<ProviderCall>;
  endSession(lesson: ClassroomLesson): Promise<ProviderCall>;
  removeUser(lesson: ClassroomLesson, userKey: string): Promise<ProviderCall>;
  snapshot(lesson: ClassroomLesson): Promise<ProviderSnapshot | null>;
  // Whether a session id the tutor's page reported is really this lesson's session.
  verifySession?(lesson: ClassroomLesson, sessionId: string): Promise<SessionCheck>;
  // One byte range [start, end) of a finished recording; the filing worker moves it in chunks.
  download(record: RecordingFile, range: { start: number; end: number }): Promise<Buffer>;
  deleteRecording(record: { providerFileId: string | null }): Promise<ProviderCall>;
};

const TRUSTED_SOURCES = new Set(["zoom_webhook", "zoom_api"]);

/**
 * A lesson's vendor sessions, oldest first, from trusted facts only: the vendor's own notices
 * and API answers, and ids the server confirmed with the vendor (server.session_verified). A
 * session id the tutor's page reported is not among them until it is confirmed. The last one is
 * the session the lesson is in now, or was in last.
 */
export function knownSessions(events: ClassroomEvent[]): KnownSession[] {
  const trusted = events
    .filter((event) => typeof event.providerSessionId === "string" && event.providerSessionId
      && (TRUSTED_SOURCES.has(event.source) || event.type === "server.session_verified"))
    .sort((a, b) => a.occurredAt - b.occurredAt);
  const ids = [...new Set(trusted.map((event) => String(event.providerSessionId)))];
  const about = (id: string) => events.filter((event) => event.providerSessionId === id);
  return ids.map((id) => ({
    id,
    ended: about(id).some((event) => event.type === "session.ended" || (event.type === "server.session_verified" && event.ended === true)),
    recordingsKnown: about(id).some((event) => event.type === "session.recording_completed"),
  }));
}

export class ClassroomProviderUnavailableError extends Error {}

type SyntheticState = { calls: { type: string; lessonId: string; detail?: string }[]; snapshots: Record<string, ProviderSnapshot> };

const generatedSecret = randomBytes(32).toString("base64url");

function syntheticFile() {
  return path.join(process.env.IHEAR_TEST_DATA_DIR || path.join(process.cwd(), "data"), "synthetic-zoom.json");
}

async function readSynthetic(): Promise<SyntheticState> {
  try {
    return { calls: [], snapshots: {}, ...(JSON.parse(await readFile(syntheticFile(), "utf8")) as Partial<SyntheticState>) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { calls: [], snapshots: {} };
    throw error;
  }
}

let syntheticQueue: Promise<unknown> = Promise.resolve();
function recordCall(type: string, lessonId: string, detail?: string) {
  const operation = syntheticQueue.then(async () => {
    const state = await readSynthetic();
    state.calls.push({ type, lessonId, ...(detail ? { detail } : {}) });
    await writeFile(syntheticFile(), `${JSON.stringify(state, null, 2)}\n`, "utf8");
  });
  syntheticQueue = operation.catch(() => undefined);
  return operation;
}

function syntheticProvider(): ClassroomProvider {
  const accepted = async (type: string, lessonId: string, detail?: string) => {
    await recordCall(type, lessonId, detail);
    return { ok: true, httpStatus: 202 };
  };
  return {
    name: "synthetic",
    webhookSecret: process.env.CLASSROOM_WEBHOOK_SECRET || null,
    sessionToken({ lesson, participant, now }) {
      const claims = buildSessionTokenClaims({ lesson, participant, appKey: "synthetic-app-key", now });
      const token = signSessionToken(claims, process.env.CLASSROOM_SYNTHETIC_SECRET || generatedSecret);
      return { token, issuedAt: claims.iat * 1000, expiresAt: claims.exp * 1000 };
    },
    startRecording: (lesson) => accepted("recording.start", lesson.id),
    stopRecording: (lesson) => accepted("recording.stop", lesson.id),
    endSession: (lesson) => accepted("session.end", lesson.id),
    removeUser: (lesson, userKey) => accepted("user.remove", lesson.id, userKey),
    async snapshot(lesson) {
      return (await readSynthetic()).snapshots[lesson.id] ?? null;
    },
    // The stand-in's sessions are named after their lesson: SYN-SESSION-<lesson id>, and -2, -3...
    // for a lesson that ran in several. Any other id is not this lesson's.
    async verifySession(lesson, sessionId) {
      const own = `SYN-SESSION-${lesson.id}`;
      const ours = sessionId === own || (sessionId.startsWith(own) && /^-\d{1,3}$/.test(sessionId.slice(own.length)));
      return ours ? { verified: true, ended: false } : { verified: false, reason: "MISMATCH" };
    },
    async download(record, { start, end }) {
      return Buffer.alloc(Math.max(0, Math.min(end, Number(record.size) || 0) - start), 7);
    },
    deleteRecording: (record) => accepted("recording.delete", String(record.providerFileId)),
  };
}

// A lesson's Zoom sessions as the stored facts give them (knownSessions: trusted facts only).
async function zoomSessionsOf(lesson: ClassroomLesson) {
  return knownSessions(await classroomStore().eventsFor([lesson.id]));
}

async function recordingAllowedNow(lesson: ClassroomLesson) {
  return recordingDecision(await classroomStore().eventsFor([lesson.id])).allowed;
}

export function classroomProvider(): ClassroomProvider {
  const name = process.env.CLASSROOM_PROVIDER || "";
  if (name === "synthetic") {
    if (process.env.VERCEL_ENV === "production") throw new ClassroomProviderUnavailableError("The synthetic classroom provider never runs in production");
    return syntheticProvider();
  }
  if (name === "zoom-video-sdk") {
    const config = zoomVideoSdkConfig(process.env);
    if (!config) throw new ClassroomProviderUnavailableError("The Zoom Video SDK is not configured");
    return zoomVideoSdkProvider(config, { sessionsOf: zoomSessionsOf });
  }
  if (name === "tencent-lcic") {
    const config = tencentLcicConfig(process.env);
    if (!config) throw new ClassroomProviderUnavailableError("Tencent LCIC is not configured");
    // The lesson-to-room map is a local file in this prototype; a hosted site needs a table first.
    if (process.env.VERCEL || process.env.NETLIFY) throw new ClassroomProviderUnavailableError("Tencent LCIC needs its room table before it can run on a hosted site");
    // Real students are never recorded through LCIC until a trial shows StopRecord stops a
    // recording mid-class; until then only TEST- lessons can record (see tencent-lcic.ts).
    return tencentLcicProvider(config, {
      rooms: fileRoomRegistry(), recordingAllowed: recordingAllowedNow, midClassStopVerified: process.env.LCIC_MIDCLASS_STOP_VERIFIED === "1",
      deletionEnabled: vendorDeletionEnabled(),
    });
  }
  throw new ClassroomProviderUnavailableError(MEDIA_PROVIDERS.includes(name as MediaProviderName)
    ? `The ${name} provider is not available`
    : "No classroom provider is configured");
}
