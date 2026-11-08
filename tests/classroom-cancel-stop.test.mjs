import { afterAll, describe, expect, test, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// Cancelling a lesson stops its recording on the server (2026-11-08, P1+P3 integration worktree).
// The local file store, the synthetic provider (it records what the server asked of it) and a
// local folder for Drive; nothing reaches Zoom, Google or a hosted database. Passing says our own
// logic is right, not how Zoom behaves.
const directory = await mkdtemp(path.join(os.tmpdir(), "ihear-cancel-stop-"));
vi.stubEnv("IHEAR_FORCE_FILE_STORE", "1");
vi.stubEnv("IHEAR_TEST_DATA_DIR", directory);
vi.stubEnv("CLASSROOM_PROVIDER", "synthetic");
vi.stubEnv("CLASSROOM_DRIVE", "local");
vi.stubEnv("CLASSROOM_SYNTHETIC_SECRET", "cancel-stop-token-test-only");
vi.stubEnv("VERCEL_ENV", "");
const { classroomStore } = await import("../lib/classroom-store");
const { classroomProvider } = await import("../lib/classroom-provider");
const { classroomDrive } = await import("../lib/classroom-drive");
const { createClassroomLesson, recordingDecision, runClassroomTick, stopRecordingForCancelledLesson } = await import("../lib/classroom-service");
// @ts-ignore - shared classroom logic, plain JavaScript.
const { storeEvent } = await import("../tools/recording-pathway/classroom/webhook-ingest.mjs");

afterAll(async () => {
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

const MIN = 60_000;
const store = classroomStore();
const provider = classroomProvider();
const drive = classroomDrive();
const calls = async lessonId => JSON.parse(await readFile(path.join(directory, "synthetic-zoom.json"), "utf8").catch(() => '{"calls":[]}'))
  .calls.filter(call => call.lessonId === lessonId).map(call => call.type);
const events = lessonId => store.eventsFor([lessonId]);
const ofType = async (lessonId, type) => (await events(lessonId)).filter(event => event.type === type);

// A lesson at 16:00 Taipei (08:00Z) on 2026-11-30, recording confirmed by Zoom a minute in.
let codeNumber = 0;
async function recordingLesson() {
  codeNumber += 1;
  const { lesson } = await createClassroomLesson({
    store, actor: "owner@example.test", now: Date.parse("2026-11-30T07:00:00Z"),
    input: { code: `TEST-CX${codeNumber}`, date: "2026-11-30", time: "16:00", minutes: 60, tutorCode: `TEST-CT${codeNumber}`, tutorEmail: "tutor@example.test", studentCode: `TEST-CS${codeNumber}` },
  });
  const [tutor, student] = lesson.participants;
  const start = Date.parse(lesson.startsAt);
  const zoom = (type, at, fields = {}) => ({ source: "zoom_webhook", type, lessonId: lesson.id, providerSessionId: "SYN-SESSION-C", occurredAt: at, receivedAt: at, key: `${type}:${lesson.id}:${at}:${fields.participantId ?? ""}`, ...fields });
  const server = (type, at, fields) => ({ source: "server", type, lessonId: lesson.id, occurredAt: at, receivedAt: at, ...fields });
  await store.transaction(async tx => {
    for (const event of [
      server("server.recording_eligibility", start - 15 * MIN, { eligible: true, reason: "ALL_CONSENTED", count: 0, key: `decide:${lesson.id}` }),
      zoom("session.started", start - 3 * MIN),
      zoom("session.user_joined", start - 3 * MIN, { participantId: tutor.id, participantUuid: "u-t" }),
      zoom("session.user_joined", start, { participantId: student.id, participantUuid: "u-s" }),
      server("server.start_requested", start + MIN, { attempt: 1, key: `start:${lesson.id}:1` }),
      server("server.start_response", start + MIN, { attempt: 1, ok: true, httpStatus: 202, key: `start:${lesson.id}:1:response` }),
      zoom("session.recording_started", start + MIN + 5_000, { status: "Recording" }),
    ]) await storeEvent(tx, event);
  });
  return { lesson, start, zoom };
}

describe("a cancelled lesson's recording is stopped by the server", () => {
  test("P3's cancel: the stop goes out at once on both channels, again at 30 s, the session is ended at 60 s, and each is sent once", async () => {
    const { lesson, start } = await recordingLesson();
    const at = start + 20 * MIN;
    expect(await store.setLessonCancelled(lesson.id)).toBe(true);
    const answer = await stopRecordingForCancelledLesson({ store, provider, drive, lessonId: lesson.id, now: at });
    expect(answer).toMatchObject({ status: 200, body: { ok: true, ticked: true, stopRequested: true, stopState: "WAITING" } });
    // Requested is not stopped: the answer says so until Zoom confirms.
    expect(answer.body.recording.status).not.toBe("STOPPED");
    expect(await calls(lesson.id)).toEqual(["recording.stop"]);
    const first = (await ofType(lesson.id, "server.stop_requested"))[0];
    expect(first).toMatchObject({ reason: "lesson_cancelled", attempt: 1, channels: ["rest", "host"], occurredAt: at });
    for (const [later, expected] of [[at + 10_000, ["recording.stop"]], [at + 30_000, ["recording.stop", "recording.stop"]], [at + 60_000, ["recording.stop", "recording.stop", "session.end"]], [at + 5 * MIN, ["recording.stop", "recording.stop", "session.end"]]]) {
      await runClassroomTick({ store, provider, drive, now: later, lessonIds: [lesson.id] });
      expect(await calls(lesson.id), `at +${(later - at) / 1000} s`).toEqual(expected);
    }
    // Pressing cancel again (or a retried request) stores nothing new and sends nothing new.
    await stopRecordingForCancelledLesson({ store, provider, drive, lessonId: lesson.id, now: at + 6 * MIN });
    expect(await ofType(lesson.id, "server.lesson_cancelled")).toHaveLength(1);
    expect(await calls(lesson.id)).toEqual(["recording.stop", "recording.stop", "session.end"]);
    expect(recordingDecision(await events(lesson.id)).allowed).toBe(false);
  });

  test("never started again: with the lesson cancelled, later ticks send no start, even after Zoom confirms the stop and both are still in", async () => {
    const { lesson, start, zoom } = await recordingLesson();
    const at = start + 20 * MIN;
    await store.setLessonCancelled(lesson.id);
    await stopRecordingForCancelledLesson({ store, provider, drive, lessonId: lesson.id, now: at });
    await store.transaction(tx => storeEvent(tx, zoom("session.recording_stopped", at + 4_000, { status: "Stopped" })));
    for (const later of [at + 30_000, at + MIN, at + 10 * MIN, at + 30 * MIN]) await runClassroomTick({ store, provider, drive, now: later, lessonIds: [lesson.id] });
    expect(await calls(lesson.id)).toEqual(["recording.stop"]);
    const answer = await stopRecordingForCancelledLesson({ store, provider, drive, lessonId: lesson.id, now: at + 31 * MIN });
    expect(answer.body.stopState).toBe("CONFIRMED");
  });

  test("the cancel request failed before storing the cancellation: the scheduled tick finds the flag, stores it and stops, with the same retries", async () => {
    const { lesson, start } = await recordingLesson();
    const found = start + 20 * MIN;
    await store.setLessonCancelled(lesson.id);
    // The scheduled tick (no lesson named): it looks after every lesson around now.
    await runClassroomTick({ store, provider, drive, now: found });
    expect(await ofType(lesson.id, "server.lesson_cancelled")).toHaveLength(1);
    expect((await ofType(lesson.id, "server.lesson_cancelled"))[0].occurredAt).toBe(found);
    expect(await calls(lesson.id)).toEqual(["recording.stop"]);
    await runClassroomTick({ store, provider, drive, now: found + 30_000 });
    await runClassroomTick({ store, provider, drive, now: found + 60_000 });
    expect(await calls(lesson.id)).toEqual(["recording.stop", "recording.stop", "session.end"]);
  });

  test("the provider refusing or failing the stop does not stop the sequence; the stop is flagged unconfirmed", async () => {
    const { lesson, start } = await recordingLesson();
    const at = start + 20 * MIN;
    const sent = [];
    const failing = { ...provider, stopRecording: async () => { sent.push("stop"); throw new Error("network down"); }, endSession: async () => { sent.push("end"); return { ok: false, httpStatus: 503 }; } };
    await store.setLessonCancelled(lesson.id);
    const answer = await stopRecordingForCancelledLesson({ store, provider: failing, drive, lessonId: lesson.id, now: at });
    expect(answer.body).toMatchObject({ ok: true, stopRequested: true, stopState: "WAITING" });
    for (const later of [at + 30_000, at + 60_000, at + 2 * MIN + 1_000]) await runClassroomTick({ store, provider: failing, drive, now: later, lessonIds: [lesson.id] });
    expect(sent).toEqual(["stop", "stop", "end"]);
    expect((await ofType(lesson.id, "server.stop_requested")).map(event => event.ok)).toEqual([false, false]);
    const anomalies = await store.listAnomalies([lesson.id]);
    expect(anomalies.find(entry => entry.code === "LESSON_CANCELLED_STOP_UNCONFIRMED")).toMatchObject({ severity: "error" });
  });

  test("recordings after the cancellation are never filed: protection starts at the cancellation, as after a withdrawal", async () => {
    const { lesson, start } = await recordingLesson();
    const at = start + 20 * MIN;
    expect(await store.withdrawalAt(lesson.id)).toBeNull();
    await store.setLessonCancelled(lesson.id);
    await stopRecordingForCancelledLesson({ store, provider, drive, lessonId: lesson.id, now: at });
    expect(await store.withdrawalAt(lesson.id)).toBe(at);
  });

  test("only a cancelled lesson is stopped this way; an unknown lesson is not found", async () => {
    const { lesson } = await recordingLesson();
    expect(await stopRecordingForCancelledLesson({ store, provider, drive, lessonId: lesson.id, now: Date.now() })).toMatchObject({ status: 409, body: { code: "NOT_CANCELLED" } });
    expect(await stopRecordingForCancelledLesson({ store, provider, drive, lessonId: "L-00000000000000000000000000000000", now: Date.now() })).toMatchObject({ status: 404 });
    expect(await calls(lesson.id)).toEqual([]);
  });
});
