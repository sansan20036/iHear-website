import { afterAll, beforeEach, describe, expect, test, vi } from "vitest";
import { createHmac } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// The second rule set on recording after a room move (2026-11-08), end to end through the site's
// own routes: consent given after the move counts for the new room's check; consent never reaches
// back to a recording that started before it (held at Zoom as BEFORE_CONSENT); the owner's
// authorization never replaces the student's consent or the tutor's notice; a withdrawal is never
// undone; an old room Zoom has not confirmed stopped blocks the new room until Zoom confirms; and
// changes at the same time. Synthetic data only (TEST- codes, example.test addresses, test-only
// secrets). Passing says our own logic is right, not how the real Zoom behaves.
//
// Each test states its success condition in its title, and fails on any other outcome.
const afterResponse = vi.hoisted(() => []);
vi.mock("next/server", async original => ({ ...await original(), after: task => { afterResponse.push(task); } }));
vi.mock("../auth.js", () => ({ auth: vi.fn() }));
vi.mock("../lib/admin-store", () => ({ findAdminAccount: vi.fn(), appendAdminActivity: vi.fn() }));
vi.mock("../lib/rate-limit", async original => ({ ...await original(), enforceRateLimit: vi.fn() }));

import { auth } from "../auth.js";
import { appendAdminActivity, findAdminAccount } from "../lib/admin-store";
import { enforceRateLimit } from "../lib/rate-limit";

const directory = await mkdtemp(path.join(os.tmpdir(), "ihear-room-consent-"));
const SECRET = "room-consent-webhook-test-only";
const OWNER = "room-consent-owner@example.test";
const TUTOR = "room-consent-tutor@example.test";
const ORIGIN = "http://localhost:3000";
vi.stubEnv("AUTH_OWNER_EMAILS", OWNER);
vi.stubEnv("IHEAR_FORCE_FILE_STORE", "1");
vi.stubEnv("IHEAR_TEST_DATA_DIR", directory);
vi.stubEnv("CLASSROOM_PROVIDER", "synthetic");
vi.stubEnv("CLASSROOM_DRIVE", "local");
vi.stubEnv("CLASSROOM_WEBHOOK_SECRET", SECRET);
vi.stubEnv("CLASSROOM_SYNTHETIC_SECRET", "room-consent-token-test-only");
vi.stubEnv("VERCEL_ENV", "");
const lessonsRoute = await import("../app/api/admin/classrooms/route");
const lessonRoute = await import("../app/api/admin/classrooms/[lessonId]/route");
const resumeRoute = await import("../app/api/admin/classrooms/[lessonId]/resume-recording/route");
const tickRoute = await import("../app/api/admin/classrooms/tick/route");
const consents = await import("../app/api/admin/classrooms/consents/route");
const joinRoute = await import("../app/api/classroom/[lessonId]/join/route");
const statusRoute = await import("../app/api/classroom/[lessonId]/status/route");
const webhook = await import("../app/api/recordings/zoom/webhook/route");
const { classroomStore } = await import("../lib/classroom-store");
// @ts-ignore - shared classroom logic, plain JavaScript.
const { roomNameOf } = await import("../tools/recording-pathway/classroom/eligibility.mjs");
// @ts-ignore
const { deriveLesson } = await import("../tools/recording-pathway/classroom/lesson-state.mjs");

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
  enforceRateLimit.mockResolvedValue({ limited: false, result: { allowed: true, limit: 60, remaining: 59, retryAfter: 60, resetAt: "2026-12-03T00:01:00.000Z" } });
});

const MIN = 60_000, SEC = 1000;
const at = iso => vi.setSystemTime(new Date(iso));
const advance = ms => vi.setSystemTime(new Date(Date.now() + ms));
const signedIn = email => auth.mockResolvedValue(email ? { user: { email } } : null);
const params = lessonId => ({ params: Promise.resolve({ lessonId }) });
const post = (pathname, body = {}) => new Request(`${ORIGIN}${pathname}`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify(body) });
const read = async response => ({ status: response.status, body: await response.json() });
const keyOf = link => new URLSearchParams(new URL(link, ORIGIN).hash.slice(1)).get("k");
const claimsOf = token => JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));

let codes = 0;
// A TEST- lesson; consent for the student and the tutor's notice only where asked.
async function newLesson({ student = true, tutor = true } = {}) {
  codes += 1;
  const code = `TEST-RC${codes}`;
  signedIn(OWNER);
  const created = await read(await lessonsRoute.POST(post("/api/admin/classrooms", { code, date: "2026-12-03", time: "16:00", minutes: 60, tutorCode: `${code}-T`, tutorEmail: TUTOR, studentCode: `${code}-S` })));
  expect(created.status).toBe(201);
  const lesson = { code, id: created.body.lesson.lessonId, key: keyOf(created.body.studentLink) };
  if (student) await consent(lesson, "student", "granted");
  if (tutor) await consent(lesson, "tutor", "granted");
  return lesson;
}
async function consent(lesson, role, status) {
  signedIn(OWNER);
  const answer = await consents.POST(post("/api/admin/classrooms/consents", { personCode: `${lesson.code}-${role === "student" ? "S" : "T"}`, role, status }));
  expect(answer.status).toBe(200);
}
const change = async (lesson, action) => {
  signedIn(OWNER);
  const request = new Request(`${ORIGIN}/api/admin/classrooms/${lesson.id}`, { method: "PATCH", headers: { origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify({ action }) });
  return read(await lessonRoute.PATCH(request, params(lesson.id)));
};
const resume = async lesson => { signedIn(OWNER); return read(await resumeRoute.POST(post(`/api/admin/classrooms/${lesson.id}/resume-recording`), params(lesson.id))); };
const join = async (lesson, { key, email } = {}) => { signedIn(email); return read(await joinRoute.POST(post(`/api/classroom/${lesson.id}/join`, key ? { key } : {}), params(lesson.id))); };
const tick = async () => { signedIn(OWNER); expect((await tickRoute.POST(post("/api/admin/classrooms/tick"))).status).toBe(200); };
// What the classroom pages are told about recording (the tutor's page stops recording when not allowed).
const recordingAllowed = async (lesson, key) => { signedIn(null); return (await read(await statusRoute.POST(post(`/api/classroom/${lesson.id}/status`, { key }), params(lesson.id)))).body.recordingAllowed; };
async function zoom(type, lesson, sessionId, object = {}) {
  const rawBody = JSON.stringify({ event: type, event_ts: Date.now(), payload: { account_id: "synthetic", object: { id: sessionId, session_id: sessionId, session_key: lesson.id, ...object } } });
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = `v0=${createHmac("sha256", SECRET).update(`v0:${timestamp}:${rawBody}`).digest("hex")}`;
  const answer = await read(await webhook.POST(new Request(`${ORIGIN}/api/recordings/zoom/webhook`, { method: "POST", headers: { "content-type": "application/json", "x-zm-request-timestamp": String(timestamp), "x-zm-signature": signature }, body: rawBody })));
  for (const task of afterResponse.splice(0)) await task();
  return answer;
}
let uuids = 0;
const started = (lesson, sessionId, generation) => zoom("session.started", lesson, sessionId, { session_name: roomNameOf(lesson.id, generation), start_time: new Date().toISOString() });
const joined = (lesson, sessionId, userKey) => zoom("session.user_joined", lesson, sessionId, { user: { user_key: userKey, participant_uuid: `u-${uuids += 1}`, join_time: new Date().toISOString() } });
const recordingIs = (lesson, sessionId, status, generation) => zoom(status === "Recording" ? "session.recording_started" : "session.recording_stopped", lesson, sessionId, { session_name: roomNameOf(lesson.id, generation), recording_file: { recording_start: new Date().toISOString() } });
const sentTo = async lesson => JSON.parse(await readFile(path.join(directory, "synthetic-zoom.json"), "utf8").catch(() => '{"calls":[]}'))
  .calls.filter(call => call.lessonId === lesson.id).map(call => [call.type, call.detail ?? null]);
const startsTo = async (lesson, sessionId) => (await sentTo(lesson)).filter(([type, detail]) => type === "recording.start" && detail === sessionId).length;
const eventsOf = lesson => classroomStore().eventsFor([lesson.id]);
const stateOf = async lesson => {
  const stored = await classroomStore().lesson(lesson.id);
  return deriveLesson({ ...stored, participants: stored.participants.map(({ id, code, role }) => ({ id, code, role })) }, await eventsOf(lesson), Date.now());
};
// Both people into a room of this generation (the student with this key, the tutor by sign-in).
async function bothInto(lesson, sessionId, generation, key) {
  const student = await join(lesson, { key });
  const tutor = await join(lesson, { email: TUTOR });
  expect([student.status, tutor.status]).toEqual([200, 200]);
  expect(claimsOf(tutor.body.session.token).tpc).toBe(roomNameOf(lesson.id, generation));
  lesson.tutorId = claimsOf(tutor.body.session.token).user_key;
  lesson.studentId = claimsOf(student.body.session.token).user_key;
  await started(lesson, sessionId, generation);
  await joined(lesson, sessionId, lesson.tutorId);
  await joined(lesson, sessionId, lesson.studentId);
}
// Recording in the first room, started by the server and confirmed by Zoom.
async function recordingInFirstRoom(sessionId, options) {
  at("2026-12-03T07:50:00Z");
  const lesson = await newLesson(options);
  at("2026-12-03T07:56:00Z");
  await bothInto(lesson, sessionId, 0, lesson.key);
  advance(10 * SEC); await tick();
  advance(10 * SEC); await tick();
  expect(await startsTo(lesson, sessionId)).toBe(1);
  advance(10 * SEC);
  await recordingIs(lesson, sessionId, "Recording", 0);
  return lesson;
}
const file = (id, start, end) => ({ id, file_type: "MP4", recording_type: "shared_screen_with_speaker_view", file_size: 2048, status: "completed", recording_start: start, recording_end: end, download_url: "https://example.invalid/never-kept" });

describe("consent after a move", () => {
  test("A: a lesson without the student's consent at its start; after a reissue the new room's check refuses; the owner records the consent; the check runs again by itself and the start goes to the new room only", async () => {
    at("2026-12-03T07:50:00Z");
    const lesson = await newLesson({ student: false });
    advance(MIN); await tick();
    expect((await eventsOf(lesson)).filter(event => event.type === "server.recording_eligibility").map(event => [event.generation ?? 0, event.eligible, event.reason])).toEqual([[0, false, "CONSENT_MISSING"]]);
    const key = keyOf((await change(lesson, "reissue_link")).body.studentLink);
    at("2026-12-03T07:56:00Z");
    await bothInto(lesson, "ZS-A1", 1, key);
    advance(10 * SEC); await tick();
    advance(10 * SEC); await tick();
    expect(await sentTo(lesson)).toEqual([]);
    expect((await stateOf(lesson)).roomRecording).toMatchObject({ status: "RECHECK_REFUSED", reason: "CONSENT_MISSING" });
    expect(await recordingAllowed(lesson, key)).toBe(false);
    advance(MIN);
    await consent(lesson, "student", "granted");
    advance(10 * SEC); await tick();
    advance(10 * SEC); await tick();
    expect(await sentTo(lesson)).toEqual([["recording.start", "ZS-A1"]]);
    // The pages go by the new room's own check, not the lesson's first decision.
    expect(await recordingAllowed(lesson, key)).toBe(true);
    const checks = (await eventsOf(lesson)).filter(event => event.type === "server.recording_eligibility").map(event => [event.generation ?? 0, event.eligible]);
    expect(checks).toEqual([[0, false], [1, false], [1, true]]);
  });

  test("consent never reaches back: in a moved room, a recording that started before the consent (not ours) is stopped and held at Zoom as BEFORE_CONSENT; the one the server started after the check is filed", async () => {
    at("2026-12-03T07:50:00Z");
    const lesson = await newLesson({ student: false });
    advance(MIN); await tick();
    const key = keyOf((await change(lesson, "reissue_link")).body.studentLink);
    at("2026-12-03T07:56:00Z");
    await bothInto(lesson, "ZS-B4C", 1, key);
    advance(10 * SEC); await tick();
    // A recording no start of ours covers (Zoom's automatic recording, say), before any consent.
    const rogueStart = new Date().toISOString();
    await recordingIs(lesson, "ZS-B4C", "Recording", 1);
    advance(5 * SEC); await tick();
    expect(await sentTo(lesson)).toEqual([["recording.stop", "ZS-B4C"]]);
    advance(5 * SEC);
    const rogueEnd = new Date().toISOString();
    await recordingIs(lesson, "ZS-B4C", "Stopped", 1);
    advance(MIN);
    await consent(lesson, "student", "granted");
    advance(10 * SEC); await tick();
    advance(10 * SEC); await tick();
    expect(await startsTo(lesson, "ZS-B4C")).toBe(1);
    advance(5 * SEC);
    const legitStart = new Date().toISOString();
    await recordingIs(lesson, "ZS-B4C", "Recording", 1);
    advance(10 * MIN);
    await recordingIs(lesson, "ZS-B4C", "Stopped", 1);
    await zoom("session.recording_completed", lesson, "ZS-B4C", { session_name: roomNameOf(lesson.id, 1), recording_files: [file("f-rogue", rogueStart, rogueEnd), file("f-legit", legitStart, new Date().toISOString())] });
    const records = await Promise.all(["f-rogue", "f-legit"].map(id => classroomStore().fileRecord(id)));
    expect(records.map(record => [record.providerFileId, record.hold])).toEqual([["f-rogue", "BEFORE_CONSENT"], ["f-legit", null]]);
    expect(records[0].status).toBe("HOLD");
  });

  test("B: the owner's authorization never replaces the tutor's notice: refused while it is missing; once the tutor's notice is recorded the check runs again by itself and the start follows, without a second authorization", async () => {
    const lesson = await recordingInFirstRoom("ZS-N1");
    advance(5 * MIN);
    const key = keyOf((await change(lesson, "reissue_link")).body.studentLink);
    advance(10 * SEC);
    await bothInto(lesson, "ZS-N2", 1, key);
    advance(10 * SEC); await tick();
    await recordingIs(lesson, "ZS-N1", "Stopped", 0);
    // The tutor's notice is no longer of the current version (a new notice version, say).
    const [notice] = await classroomStore().listStaffNotices([`${lesson.code}-T`]);
    await classroomStore().setStaffNotice({ ...notice, version: "an-older-notice" });
    advance(SEC);
    expect(await resume(lesson)).toMatchObject({ status: 200, body: { roomRecording: { status: "RECHECK_REFUSED", reason: "STAFF_NOTICE_MISSING" } } });
    expect(await startsTo(lesson, "ZS-N2")).toBe(0);
    advance(MIN);
    await consent(lesson, "tutor", "granted");
    advance(10 * SEC); await tick();
    advance(10 * SEC); await tick();
    expect(await startsTo(lesson, "ZS-N2")).toBe(1);
    expect((await eventsOf(lesson)).filter(event => event.type === "server.recording_resume_authorized")).toHaveLength(1);
  });

  test("a withdrawal is never undone: the student's consent withdrawn, given again, then a reissue: no check and no start in the new room, and the authorization is refused", async () => {
    const lesson = await recordingInFirstRoom("ZS-W1");
    advance(MIN);
    await consent(lesson, "student", "withdrawn");
    advance(10 * SEC); await tick();
    await recordingIs(lesson, "ZS-W1", "Stopped", 0);
    advance(MIN);
    await consent(lesson, "student", "granted");
    const key = keyOf((await change(lesson, "reissue_link")).body.studentLink);
    advance(10 * SEC);
    await bothInto(lesson, "ZS-W2", 1, key);
    for (let n = 0; n < 3; n += 1) { advance(30 * SEC); await tick(); }
    expect(await resume(lesson)).toMatchObject({ status: 409, body: { code: "CONSENT_WITHDRAWN" } });
    expect(await startsTo(lesson, "ZS-W2")).toBe(0);
    expect((await eventsOf(lesson)).filter(event => event.type === "server.recording_eligibility" && Number(event.generation) === 1)).toEqual([]);
  });

  test("an old room Zoom has not confirmed stopped: the new room does not record, the overview never reads it as stopped and keeps the error; once Zoom's end notice for the old room comes, the owner can authorize and the start goes to the new room", async () => {
    const lesson = await recordingInFirstRoom("ZS-U1");
    advance(5 * MIN);
    const key = keyOf((await change(lesson, "reissue_link")).body.studentLink);
    advance(10 * SEC);
    await bothInto(lesson, "ZS-U2", 1, key);
    for (let n = 0; n < 3; n += 1) { advance(30 * SEC); await tick(); }
    expect(await resume(lesson)).toMatchObject({ status: 409, body: { code: "OLD_ROOM_STILL_RECORDING" } });
    const state = await stateOf(lesson);
    expect(state.recording.status).not.toBe("STOPPED");
    expect(state.anomalies.map(entry => entry.code)).toEqual(expect.arrayContaining(["OLD_ROOM_STOP_UNCONFIRMED", "SESSION_END_UNCONFIRMED"]));
    expect(state.sessions.find(entry => entry.id === "ZS-U1").capture).toBe("STOP_REQUESTED");
    expect(await startsTo(lesson, "ZS-U2")).toBe(0);
    await zoom("session.ended", lesson, "ZS-U1", { end_time: new Date().toISOString() });
    advance(SEC);
    expect(await resume(lesson)).toMatchObject({ status: 200, body: { roomRecording: { status: "ALLOWED" } } });
    expect(await startsTo(lesson, "ZS-U2")).toBe(1);
    expect((await stateOf(lesson)).anomalies.map(entry => entry.code)).not.toContain("OLD_ROOM_STOP_UNCONFIRMED");
  });
});

describe("changes at the same time", () => {
  test("consent given while ticks run at once (A): one check stored per key and one start stored for the new room; how many start requests reached the provider is recorded (at least once, never in another room)", async () => {
    at("2026-12-03T07:50:00Z");
    const lesson = await newLesson({ student: false });
    advance(MIN); await tick();
    const key = keyOf((await change(lesson, "reissue_link")).body.studentLink);
    at("2026-12-03T07:56:00Z");
    await bothInto(lesson, "ZS-C1", 1, key);
    advance(10 * SEC); await tick();
    advance(MIN);
    await Promise.all([consent(lesson, "student", "granted"), tick(), tick()]);
    advance(10 * SEC);
    await Promise.all([tick(), tick(), tick()]);
    advance(10 * SEC);
    await Promise.all([tick(), tick(), tick()]);
    const events = await eventsOf(lesson);
    const checkKeys = events.filter(event => event.type === "server.recording_eligibility" && Number(event.generation) === 1).map(event => event.key);
    expect(new Set(checkKeys).size).toBe(checkKeys.length);
    expect(events.filter(event => event.type === "server.start_requested").map(event => event.key)).toEqual([`start:${lesson.id}:g1:1`]);
    const calls = await sentTo(lesson);
    expect(calls.every(([type, detail]) => type === "recording.start" && detail === "ZS-C1")).toBe(true);
    expect(calls.length).toBeGreaterThanOrEqual(1);
    console.info(`concurrent ticks: ${calls.length} start request(s) reached the provider for one stored start`);
  });

  test("two owner authorizations at once (B): both answered, one start stored for the new room, never a start in the old room", async () => {
    const lesson = await recordingInFirstRoom("ZS-D1");
    advance(5 * MIN);
    const key = keyOf((await change(lesson, "reissue_link")).body.studentLink);
    advance(10 * SEC);
    await bothInto(lesson, "ZS-D2", 1, key);
    advance(10 * SEC); await tick();
    await recordingIs(lesson, "ZS-D1", "Stopped", 0);
    advance(SEC);
    const answers = await Promise.all([resume(lesson), resume(lesson)]);
    expect(answers.every(answer => [200, 409].includes(answer.status))).toBe(true);
    expect(answers.some(answer => answer.status === 200)).toBe(true);
    const events = await eventsOf(lesson);
    expect(events.filter(event => event.type === "server.start_requested" && Number(event.generation) === 1).map(event => event.key)).toEqual([`start:${lesson.id}:g1:1`]);
    expect(await startsTo(lesson, "ZS-D1")).toBe(1);
    expect(await startsTo(lesson, "ZS-D2")).toBeGreaterThanOrEqual(1);
  });

  test("an authorization and a withdrawal at once (B): whichever comes first, afterwards nothing records in the new room (a start that slipped in is stopped), the room reads as blocked, and a later authorization is refused", async () => {
    const lesson = await recordingInFirstRoom("ZS-X1");
    advance(5 * MIN);
    const key = keyOf((await change(lesson, "reissue_link")).body.studentLink);
    advance(10 * SEC);
    await bothInto(lesson, "ZS-X2", 1, key);
    advance(10 * SEC); await tick();
    await recordingIs(lesson, "ZS-X1", "Stopped", 0);
    advance(SEC);
    await Promise.all([resume(lesson), consent(lesson, "student", "withdrawn")]);
    if (await startsTo(lesson, "ZS-X2")) await recordingIs(lesson, "ZS-X2", "Recording", 1);
    for (let n = 0; n < 3; n += 1) { advance(30 * SEC); await tick(); }
    const sent = await sentTo(lesson);
    const lastStart = sent.map(([type]) => type).lastIndexOf("recording.start");
    const stopAfter = sent.slice(lastStart + 1).some(([type, detail]) => type === "recording.stop" && detail === "ZS-X2");
    if (await startsTo(lesson, "ZS-X2")) expect(stopAfter).toBe(true);
    expect((await stateOf(lesson)).roomRecording).toMatchObject({ status: "BLOCKED", reason: "CONSENT_WITHDRAWN", canAuthorize: false });
    expect(await resume(lesson)).toMatchObject({ status: 409, body: { code: "CONSENT_WITHDRAWN" } });
  });

  test("a revoke while consent is being given (A): the room ends up in the newest generation, its own check reads the consent, and the start goes there only", async () => {
    at("2026-12-03T07:50:00Z");
    const lesson = await newLesson({ student: false });
    advance(MIN); await tick();
    const key1 = keyOf((await change(lesson, "reissue_link")).body.studentLink);
    at("2026-12-03T07:56:00Z");
    await bothInto(lesson, "ZS-R1", 1, key1);
    advance(10 * SEC); await tick();
    advance(MIN);
    const [, reissued] = await Promise.all([consent(lesson, "student", "granted"), change(lesson, "reissue_link")]);
    expect(reissued.status).toBe(200);
    advance(10 * SEC);
    await bothInto(lesson, "ZS-R2", 2, keyOf(reissued.body.studentLink));
    for (let n = 0; n < 3; n += 1) { advance(10 * SEC); await tick(); }
    expect((await sentTo(lesson)).filter(([type]) => type === "recording.start")).toEqual([["recording.start", "ZS-R2"]]);
    const checks = (await eventsOf(lesson)).filter(event => event.type === "server.recording_eligibility" && Number(event.generation) === 2);
    expect(checks.at(-1)).toMatchObject({ eligible: true });
  });
});
