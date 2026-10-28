import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

// @ts-ignore - shared classroom logic, plain JavaScript tested with node --test.
import { buildSessionTokenClaims, signSessionToken } from "../tools/recording-pathway/classroom/eligibility.mjs";
import { MEDIA_PROVIDERS, type MediaProviderName } from "./classroom-media";
import type { ClassroomLesson, ClassroomParticipant, RecordingFile } from "./classroom-store";

// The server side of the video provider behind the classroom; the browser side is
// lib/classroom-media.ts, and both use the same provider names. No video service has been
// chosen (Tencent RTC, Agora and the Zoom Video SDK are all still candidates), so only the
// synthetic provider exists: it accepts the server's requests (start or stop recording, end the
// session, remove someone), records each request, and leaves the provider's side (webhooks,
// snapshots) to the tests. Its webhooks are Zoom-shaped because the first design targeted
// Zoom. It never runs in production. A real provider implements this same type, and is
// accepted against the real service separately.

export type ProviderCall = { ok: boolean; httpStatus: number };
export type ProviderSnapshot = {
  lessonId: string;
  providerSessionId: string | null;
  details: Record<string, unknown> | null;
  users: Record<string, unknown>[];
  recordings: Record<string, unknown>[];
};
export type SessionToken = { token: string; issuedAt: number; expiresAt: number };

export type ClassroomProvider = {
  name: MediaProviderName;
  webhookSecret: string | null;
  // The token the browser's media adapter joins with; it names the participant by our id.
  sessionToken(input: { lesson: ClassroomLesson; participant: ClassroomParticipant; now: number }): SessionToken;
  startRecording(lesson: ClassroomLesson): Promise<ProviderCall>;
  stopRecording(lesson: ClassroomLesson): Promise<ProviderCall>;
  endSession(lesson: ClassroomLesson): Promise<ProviderCall>;
  removeUser(lesson: ClassroomLesson, userKey: string): Promise<ProviderCall>;
  snapshot(lesson: ClassroomLesson): Promise<ProviderSnapshot | null>;
  // One byte range [start, end) of a finished recording; the filing worker moves it in chunks.
  download(record: RecordingFile, range: { start: number; end: number }): Promise<Buffer>;
  deleteRecording(record: { providerFileId: string | null }): Promise<ProviderCall>;
};

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
    async download(record, { start, end }) {
      return Buffer.alloc(Math.max(0, Math.min(end, Number(record.size) || 0) - start), 7);
    },
    deleteRecording: (record) => accepted("recording.delete", String(record.providerFileId)),
  };
}

export function classroomProvider(): ClassroomProvider {
  const name = process.env.CLASSROOM_PROVIDER || "";
  if (name === "synthetic") {
    if (process.env.VERCEL_ENV === "production") throw new ClassroomProviderUnavailableError("The synthetic classroom provider never runs in production");
    return syntheticProvider();
  }
  throw new ClassroomProviderUnavailableError(MEDIA_PROVIDERS.includes(name as MediaProviderName) || name === "zoom"
    ? `The ${name} provider is not built: no video service has been chosen yet`
    : "No classroom provider is configured");
}
