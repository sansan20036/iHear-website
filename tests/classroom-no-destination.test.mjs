import { afterAll, beforeEach, describe, expect, test, vi } from "vitest";
import { createHmac } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// P3-MVP (2026-11-11): the closed trial's lessons with nothing recorded run with no recording
// destination at all (env-check --profile lessons: no CLASSROOM_DRIVE). Every other classroom test
// sets the local stand-in, so this file is the one that runs the routes without any Drive: the
// tutor's reports, the overview's tick and the emergency stop must work, and a recording that
// should not exist (say Zoom's automatic recording was left on) must never be filed anywhere:
// its filing waits and Zoom's copy is kept. Synthetic data only: TEST- codes, example.test addresses.
const afterResponse = vi.hoisted(() => []);
vi.mock("next/server", async original => ({ ...await original(), after: task => { afterResponse.push(task); } }));
vi.mock("../auth.js", () => ({ auth: vi.fn() }));
vi.mock("../lib/admin-store", () => ({ findAdminAccount: vi.fn(), appendAdminActivity: vi.fn() }));
vi.mock("../lib/rate-limit", async original => ({ ...await original(), enforceRateLimit: vi.fn() }));

import { auth } from "../auth.js";
import { appendAdminActivity, findAdminAccount } from "../lib/admin-store";
import { enforceRateLimit } from "../lib/rate-limit";

const directory = await mkdtemp(path.join(os.tmpdir(), "ihear-no-destination-"));
const SECRET = "classroom-webhook-test-only";
const OWNER = "owner@example.test";
const TUTOR = "tutor@example.test";
const ORIGIN = "http://localhost:3000";
vi.stubEnv("AUTH_OWNER_EMAILS", OWNER);
vi.stubEnv("IHEAR_FORCE_FILE_STORE", "1");
vi.stubEnv("IHEAR_TEST_DATA_DIR", directory);
vi.stubEnv("CLASSROOM_PROVIDER", "synthetic");
vi.stubEnv("CLASSROOM_DRIVE", "");
vi.stubEnv("CLASSROOM_WEBHOOK_SECRET", SECRET);
vi.stubEnv("CLASSROOM_SYNTHETIC_SECRET", "classroom-token-test-only");
vi.stubEnv("VERCEL_ENV", "");
const lessons = await import("../app/api/admin/classrooms/route");
const tickRoute = await import("../app/api/admin/classrooms/tick/route");
const stopRecording = await import("../app/api/admin/classrooms/[lessonId]/stop-recording/route");
const joinRoute = await import("../app/api/classroom/[lessonId]/join/route");
const hostRoute = await import("../app/api/classroom/[lessonId]/host-events/route");
const webhook = await import("../app/api/recordings/zoom/webhook/route");
const { classroomStore } = await import("../lib/classroom-store");

vi.useFakeTimers({ toFake: ["Date"] });
afterAll(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});
beforeEach(() => {
  vi.clearAllMocks();
  afterResponse.length = 0;
  auth.mockResolvedValue(null);
  findAdminAccount.mockResolvedValue(null);
  appendAdminActivity.mockResolvedValue(undefined);
  enforceRateLimit.mockResolvedValue({ limited: false, result: { allowed: true, limit: 30, remaining: 29, retryAfter: 60, resetAt: "2026-11-20T00:01:00.000Z" } });
});

const at = iso => vi.setSystemTime(new Date(iso));
const signedIn = email => auth.mockResolvedValue(email ? { user: { email } } : null);
const params = lessonId => ({ params: Promise.resolve({ lessonId }) });
const post = (pathname, body = {}) => new Request(`${ORIGIN}${pathname}`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify(body) });
const read = async response => ({ status: response.status, body: await response.json() });
const claimsOf = token => JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
const keyOf = link => new URLSearchParams(new URL(link, ORIGIN).hash.slice(1)).get("k") ?? new URL(link, ORIGIN).searchParams.get("k");

async function createLesson(fields) {
  signedIn(OWNER);
  const result = await read(await lessons.POST(post("/api/admin/classrooms", { date: "2026-11-20", minutes: 60, tutorEmail: TUTOR, ...fields })));
  expect(result.status).toBe(201);
  return { lessonId: result.body.lesson.lessonId, key: keyOf(result.body.studentLink) };
}
async function join(lessonId, { key, email } = {}) {
  signedIn(email);
  return read(await joinRoute.POST(post(`/api/classroom/${lessonId}/join`, key ? { key } : {}), params(lessonId)));
}
async function hostReport(lessonId, report) {
  signedIn(TUTOR);
  return read(await hostRoute.POST(post(`/api/classroom/${lessonId}/host-events`, { at: new Date().toISOString(), ...report }), params(lessonId)));
}
async function tick() {
  signedIn(OWNER);
  return read(await tickRoute.POST(post("/api/admin/classrooms/tick")));
}
async function overviewCard(code) {
  signedIn(OWNER);
  const view = (await read(await lessons.GET(new Request(`${ORIGIN}/api/admin/classrooms`)))).body;
  for (const [group, cards] of Object.entries(view.dashboard.groups)) {
    const card = cards.find(entry => entry.lessonCode === code);
    if (card) return { group, ...card };
  }
  return null;
}
async function syntheticCalls(subject) {
  const state = JSON.parse(await readFile(path.join(directory, "synthetic-zoom.json"), "utf8").catch(() => '{"calls":[]}'));
  return state.calls.filter(call => call.lessonId === subject).map(call => call.type);
}
function zoom(type, lesson, object = {}) {
  const raw = JSON.stringify({ event: type, event_ts: Date.now(), payload: { account_id: "synthetic-account", object: { id: lesson.sessionId, session_id: lesson.sessionId, session_key: lesson.lessonId, ...object } } });
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = `v0=${createHmac("sha256", SECRET).update(`v0:${timestamp}:${raw}`).digest("hex")}`;
  return webhook.POST(new Request(`${ORIGIN}/api/recordings/zoom/webhook`, { method: "POST", headers: { "content-type": "application/json", "x-zm-request-timestamp": String(timestamp), "x-zm-signature": signature }, body: raw }));
}
const zoomUser = (userKey, uuid, times) => ({ user: { id: "16778240", user_key: userKey, participant_uuid: uuid, ...times } });

async function startLesson(lesson) {
  const student = await join(lesson.lessonId, { key: lesson.key });
  const tutor = await join(lesson.lessonId, { email: TUTOR });
  expect(student.status).toBe(200);
  expect(tutor.status).toBe(200);
  const now = new Date().toISOString();
  expect((await zoom("session.started", lesson, { start_time: now })).status).toBe(200);
  expect((await zoom("session.user_joined", lesson, zoomUser(claimsOf(tutor.body.session.token).user_key, "UUID-ND-T", { join_time: now }))).status).toBe(200);
  expect((await zoom("session.user_joined", lesson, zoomUser(claimsOf(student.body.session.token).user_key, "UUID-ND-S", { join_time: now }))).status).toBe(200);
}

describe("no recording destination (env-check --profile lessons)", () => {
  test("a lesson runs: the tutor's reports, the overview's tick and the emergency stop answer, and nothing is recorded", async () => {
    at("2026-11-20T09:50:00Z");
    const lesson = { ...(await createLesson({ code: "TEST-ND-L1", time: "18:00", tutorCode: "TEST-ND-T1", studentCode: "TEST-ND-S1" })), sessionId: "SYN-SESSION-ND1" };
    at("2026-11-20T09:56:00Z");
    await startLesson(lesson);
    for (const time of ["09:56:10", "09:56:20", "09:57:30"]) {
      at(`2026-11-20T${time}Z`);
      expect((await tick()).status).toBe(200);
    }
    expect(await hostReport(lesson.lessonId, { type: "heartbeat" })).toMatchObject({ status: 200, body: { recordingAllowed: false, recording: { status: "BLOCKED" } } });
    expect(await syntheticCalls(lesson.lessonId)).toEqual([]);
    expect(await overviewCard("TEST-ND-L1")).toMatchObject({ group: "LIVE", recording: { status: "BLOCKED", label: "不錄影（同意條件不符）" } });
    signedIn(OWNER);
    const stop = await read(await stopRecording.POST(post(`/api/admin/classrooms/${lesson.lessonId}/stop-recording`), params(lesson.lessonId)));
    expect(stop.status).not.toBe(503);
    expect(stop.body.code).not.toBe("PROVIDER_UNAVAILABLE");
  });

  test("a recording that should not exist is never filed without a destination: filing waits and Zoom's copy is kept", async () => {
    at("2026-11-20T10:50:00Z");
    const lesson = { ...(await createLesson({ code: "TEST-ND-L2", time: "19:00", tutorCode: "TEST-ND-T2", studentCode: "TEST-ND-S2" })), sessionId: "SYN-SESSION-ND2" };
    at("2026-11-20T10:56:00Z");
    await startLesson(lesson);
    // Zoom records on its own (no start of ours): flagged, and the server asks it to stop.
    expect((await zoom("session.recording_started", lesson, { recording_file: { recording_start: new Date().toISOString() } })).status).toBe(200);
    at("2026-11-20T10:56:10Z");
    expect((await tick()).status).toBe(200);
    expect(await syntheticCalls(lesson.lessonId)).not.toContain("recording.start");
    at("2026-11-20T10:58:00Z");
    await zoom("session.recording_stopped", lesson, { recording_file: { recording_end: new Date().toISOString() } });
    await zoom("session.ended", lesson, { end_time: new Date().toISOString() });
    at("2026-11-20T11:03:00Z");
    const file = { id: "SYN-FILE-ND2", recording_type: "shared_screen_with_speaker_view", file_extension: "MP4", file_type: "MP4", file_size: 1024, status: "completed", recording_start: "2026-11-20T10:56:00Z", recording_end: "2026-11-20T10:58:00Z", download_url: "https://example.invalid/synthetic/download" };
    expect((await zoom("session.recording_completed", lesson, { recording_files: [file] })).status).toBe(200);
    for (const task of afterResponse.splice(0)) await task();
    expect((await tick()).status).toBe(200);
    const record = await classroomStore().fileRecord("SYN-FILE-ND2");
    expect(record).toMatchObject({ lessonId: lesson.lessonId });
    expect(record.status).not.toBe("STORED");
    expect((await overviewCard("TEST-ND-L2")).filing).toMatchObject({ status: expect.not.stringMatching(/^STORED$/) });
    // Nothing was written anywhere: no Drive stand-in folder exists, and Zoom was not asked to delete.
    await expect(readFile(path.join(directory, "synthetic-drive", "index.json"), "utf8")).rejects.toThrow();
    expect(await syntheticCalls("SYN-FILE-ND2")).toEqual([]);
  });
});
