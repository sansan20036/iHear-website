import { afterAll, beforeEach, describe, expect, test, vi } from "vitest";
import { createHmac } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// Revoking rotates the student's participant id, and recording after the room moved (2026-11-08),
// end to end through the site's own routes: the owner's revoke, reissue, cancel, emergency stop
// and authorization to record in the new room; the classroom's join; Zoom's signed webhooks; the
// tick. Synthetic data only (TEST- codes, example.test addresses, test-only secrets). The
// synthetic provider stands in for Zoom and records each request with the session it named.
// Passing says our own logic is right, not how the real Zoom behaves.
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

const directory = await mkdtemp(path.join(os.tmpdir(), "ihear-room-move-"));
const SECRET = "room-move-webhook-test-only";
const OWNER = "room-move-owner@example.test";
const EDITOR = "room-move-editor@example.test";
const TUTOR = "room-move-tutor@example.test";
const ORIGIN = "http://localhost:3000";
vi.stubEnv("AUTH_OWNER_EMAILS", OWNER);
vi.stubEnv("IHEAR_FORCE_FILE_STORE", "1");
vi.stubEnv("IHEAR_TEST_DATA_DIR", directory);
vi.stubEnv("CLASSROOM_PROVIDER", "synthetic");
vi.stubEnv("CLASSROOM_DRIVE", "local");
vi.stubEnv("CLASSROOM_WEBHOOK_SECRET", SECRET);
vi.stubEnv("CLASSROOM_SYNTHETIC_SECRET", "room-move-token-test-only");
vi.stubEnv("VERCEL_ENV", "");
const lessonsRoute = await import("../app/api/admin/classrooms/route");
const lessonRoute = await import("../app/api/admin/classrooms/[lessonId]/route");
const resumeRoute = await import("../app/api/admin/classrooms/[lessonId]/resume-recording/route");
const stopRoute = await import("../app/api/admin/classrooms/[lessonId]/stop-recording/route");
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
  findAdminAccount.mockImplementation(async email => (email === EDITOR ? { email, enabled: true } : null));
  appendAdminActivity.mockResolvedValue(undefined);
  enforceRateLimit.mockResolvedValue({ limited: false, result: { allowed: true, limit: 60, remaining: 59, retryAfter: 60, resetAt: "2026-12-03T00:01:00.000Z" } });
});

const MIN = 60_000, SEC = 1000;
const at = iso => vi.setSystemTime(new Date(iso));
const advance = ms => vi.setSystemTime(new Date(Date.now() + ms));
const signedIn = email => auth.mockResolvedValue(email ? { user: { email } } : null);
const params = lessonId => ({ params: Promise.resolve({ lessonId }) });
const post = (pathname, body = {}, origin = ORIGIN) => new Request(`${ORIGIN}${pathname}`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(body) });
const read = async response => ({ status: response.status, body: await response.json() });
const keyOf = link => new URLSearchParams(new URL(link, ORIGIN).hash.slice(1)).get("k");
const claimsOf = token => JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));

let codes = 0;
async function lessonWithConsent(time = "16:00") {
  codes += 1;
  const code = `TEST-RM${codes}`;
  signedIn(OWNER);
  const created = await read(await lessonsRoute.POST(post("/api/admin/classrooms", { code, date: "2026-12-03", time, minutes: 60, tutorCode: `${code}-T`, tutorEmail: TUTOR, studentCode: `${code}-S` })));
  expect(created.status).toBe(201);
  for (const [personCode, role] of [[`${code}-S`, "student"], [`${code}-T`, "tutor"]]) {
    signedIn(OWNER);
    expect((await consents.POST(post("/api/admin/classrooms/consents", { personCode, role, status: "granted" }))).status).toBe(200);
  }
  return { code, id: created.body.lesson.lessonId, key: keyOf(created.body.studentLink) };
}
const change = async (lesson, action, origin = ORIGIN) => {
  signedIn(OWNER);
  const request = new Request(`${ORIGIN}/api/admin/classrooms/${lesson.id}`, { method: "PATCH", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ action }) });
  return read(await lessonRoute.PATCH(request, params(lesson.id)));
};
const resume = async (lesson, { email = OWNER, origin = ORIGIN } = {}) => { signedIn(email); return read(await resumeRoute.POST(post(`/api/admin/classrooms/${lesson.id}/resume-recording`, {}, origin), params(lesson.id))); };
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
const started = (lesson, sessionId, generation = 0) => zoom("session.started", lesson, sessionId, { session_name: roomNameOf(lesson.id, generation), start_time: new Date().toISOString() });
let uuids = 0;
const joined = (lesson, sessionId, userKey) => zoom("session.user_joined", lesson, sessionId, { user: { user_key: userKey, participant_uuid: `u-${uuids += 1}`, join_time: new Date().toISOString() } });
const recordingIs = (lesson, sessionId, status, generation = 0) => zoom(status === "Recording" ? "session.recording_started" : "session.recording_stopped", lesson, sessionId, { session_name: roomNameOf(lesson.id, generation), recording_file: { recording_start: new Date().toISOString() } });
// What the server asked the stand-in for this lesson: [type, the session it named].
const calls = async lesson => JSON.parse(await readFile(path.join(directory, "synthetic-zoom.json"), "utf8").catch(() => '{"calls":[]}'))
  .calls.filter(call => call.lessonId === lesson.id).map(call => [call.type, call.detail ?? null]);
const eventsOf = lesson => classroomStore().eventsFor([lesson.id]);
const stateOf = async lesson => {
  const stored = await classroomStore().lesson(lesson.id);
  return deriveLesson({ ...stored, participants: stored.participants.map(({ id, code, role }) => ({ id, code, role })) }, await eventsOf(lesson), Date.now());
};
const studentIdOf = async lesson => (await classroomStore().lesson(lesson.id)).participants.find(entry => entry.role === "student").id;

// Both in the first room, recording started by the server and confirmed by Zoom.
async function recordedLesson(sessionId) {
  at("2026-12-03T07:50:00Z");
  const lesson = await lessonWithConsent();
  at("2026-12-03T07:56:00Z");
  const student = await join(lesson, { key: lesson.key });
  const tutor = await join(lesson, { email: TUTOR });
  lesson.studentId = claimsOf(student.body.session.token).user_key;
  lesson.tutorId = claimsOf(tutor.body.session.token).user_key;
  await started(lesson, sessionId);
  await joined(lesson, sessionId, lesson.tutorId);
  await joined(lesson, sessionId, lesson.studentId);
  advance(10 * SEC); await tick();
  advance(10 * SEC); await tick();
  expect(await calls(lesson)).toEqual([["recording.start", sessionId]]);
  advance(10 * SEC);
  await recordingIs(lesson, sessionId, "Recording");
  return lesson;
}
// After a reissue: both people in the new room's session.
async function intoNewRoom(lesson, sessionId, generation, key) {
  const student = await join(lesson, { key });
  const tutor = await join(lesson, { email: TUTOR });
  expect([student.status, tutor.status]).toEqual([200, 200]);
  expect(claimsOf(tutor.body.session.token).tpc).toBe(roomNameOf(lesson.id, generation));
  const newId = claimsOf(student.body.session.token).user_key;
  await started(lesson, sessionId, generation);
  await joined(lesson, sessionId, lesson.tutorId ?? claimsOf(tutor.body.session.token).user_key);
  await joined(lesson, sessionId, newId);
  return newId;
}

describe("phase 2: revoking rotates the student's participant id, as reissuing does", () => {
  test("a revoke gives the student a new id and the room a new generation in one step; the old link, on every device, gets no token for any room again, and every token ever given under the old id leads to the first room only", async () => {
    at("2026-12-03T07:50:00Z");
    const lesson = await lessonWithConsent();
    at("2026-12-03T07:56:00Z");
    // Two devices, a second apart (the same moment would give the very same token).
    const devices = [await join(lesson, { key: lesson.key })];
    advance(SEC);
    devices.push(await join(lesson, { key: lesson.key }));
    const oldId = claimsOf(devices[0].body.session.token).user_key;
    expect(devices.map(answer => claimsOf(answer.body.session.token))).toEqual([expect.objectContaining({ user_key: oldId, tpc: roomNameOf(lesson.id, 0) }), expect.objectContaining({ user_key: oldId, tpc: roomNameOf(lesson.id, 0) })]);
    advance(MIN);
    expect(await change(lesson, "revoke_link")).toMatchObject({ status: 200, body: { revoked: true } });
    const revokedAt = Date.now();
    expect(await studentIdOf(lesson)).not.toBe(oldId);
    const events = await eventsOf(lesson);
    expect(events.filter(event => event.type === "server.participant_rotated").map(event => [event.from, event.reason, event.generation])).toEqual([[oldId, "revoke_link", 1]]);
    expect(events.filter(event => event.type === "server.room_generation").map(event => event.generation)).toEqual([1]);
    advance(SEC);
    for (let n = 0; n < 2; n += 1) expect(await join(lesson, { key: lesson.key })).toMatchObject({ status: 403, body: { code: "NOT_ON_ROSTER" } });
    // The tutor enters again with the sign-in: into the new room.
    const tutor = await join(lesson, { email: TUTOR });
    expect(claimsOf(tutor.body.session.token).tpc).toBe(roomNameOf(lesson.id, 1));
    const tokens = await classroomStore().listJoinTokens(lesson.id);
    expect(tokens.filter(token => token.participantId === oldId).every(token => token.issuedAt < revokedAt)).toBe(true);
    expect(tokens.filter(token => token.participantId === oldId)).toHaveLength(2);
  });

  test("a join that read the lesson just before a revoke and its facts just after never gets a token: the server reads the lesson again and refuses the old key", async () => {
    at("2026-12-03T07:50:00Z");
    const lesson = await lessonWithConsent();
    at("2026-12-03T07:56:00Z");
    const store = classroomStore();
    const stale = await store.lesson(lesson.id);
    expect(await change(lesson, "revoke_link")).toMatchObject({ status: 200 });
    const original = store.lesson;
    let served = 0;
    store.lesson = async id => { served += 1; return served === 1 ? stale : original.call(store, id); };
    try {
      expect(await join(lesson, { key: lesson.key })).toMatchObject({ status: 403, body: { code: "NOT_ON_ROSTER" } });
    } finally {
      store.lesson = original;
    }
    expect(served).toBe(2);
    const oldId = stale.participants.find(entry => entry.role === "student").id;
    expect((await store.listJoinTokens(lesson.id)).filter(token => token.participantId === oldId)).toEqual([]);
  });

  test("a reissue on two devices: the new link enters on both under one new id into the new room, the old link on neither; the old id coming back into the old room is someone who should not be there", async () => {
    at("2026-12-03T07:50:00Z");
    const lesson = await lessonWithConsent();
    at("2026-12-03T07:56:00Z");
    const first = await join(lesson, { key: lesson.key });
    const oldId = claimsOf(first.body.session.token).user_key;
    await started(lesson, "ZS-D1", 0);
    await joined(lesson, "ZS-D1", oldId);
    advance(MIN);
    const reissued = await change(lesson, "reissue_link");
    const key = keyOf(reissued.body.studentLink);
    advance(SEC);
    const both = [await join(lesson, { key }), await join(lesson, { key })].map(answer => claimsOf(answer.body.session.token));
    expect(new Set(both.map(claims => claims.user_key)).size).toBe(1);
    expect(both[0].user_key).not.toBe(oldId);
    expect(both.every(claims => claims.tpc === roomNameOf(lesson.id, 1))).toBe(true);
    for (let n = 0; n < 2; n += 1) expect((await join(lesson, { key: lesson.key })).status).toBe(403);
    advance(10 * SEC);
    await joined(lesson, "ZS-D1", oldId);
    const state = await stateOf(lesson);
    expect(state.anomalies.map(entry => entry.code)).toEqual(expect.arrayContaining(["UNKNOWN_PARTICIPANT", "OLD_ROOM_SUSPECT"]));
  });

  test("the store refuses a rotation whose generation another change already took, and then nothing of it happened: not the id, not the key, not its facts", async () => {
    at("2026-12-03T07:50:00Z");
    const lesson = await lessonWithConsent();
    const store = classroomStore();
    const from = await studentIdOf(lesson);
    const now = Date.now();
    const generation = (n, reason) => ({ source: "server", type: "server.room_generation", lessonId: lesson.id, generation: n, reason, occurredAt: now, receivedAt: now, key: `room_generation:${lesson.id}:${n}` });
    const rotation = to => ({ source: "server", type: "server.participant_rotated", lessonId: lesson.id, from, to, reason: "revoke_link", generation: 1, occurredAt: now, receivedAt: now, key: `server.participant_rotated:${lesson.id}:${to}` });
    await store.transaction(tx => tx.insertEvent(generation(1, "reissue_link")));
    const before = JSON.stringify((await store.lesson(lesson.id)).participants);
    expect(await store.rotateStudent(lesson.id, from, "P-TAKEN-1", "a".repeat(64), [generation(1, "revoke_link"), rotation("P-TAKEN-1")])).toBe(false);
    expect(JSON.stringify((await store.lesson(lesson.id)).participants)).toBe(before);
    const facts = (await eventsOf(lesson)).filter(event => ["server.room_generation", "server.participant_rotated"].includes(event.type));
    expect(facts.map(event => [event.type, event.reason])).toEqual([["server.room_generation", "reissue_link"]]);
    expect(await store.rotateStudent(lesson.id, from, "P-TAKEN-2", "b".repeat(64), [generation(2, "revoke_link"), rotation("P-TAKEN-2")])).toBe(true);
    expect(await studentIdOf(lesson)).toBe("P-TAKEN-2");
  });

  test("three revokes at once: generations 1, 2 and 3, one unbroken chain of ids ending at the roster, and the original key never enters", async () => {
    at("2026-12-03T07:50:00Z");
    const lesson = await lessonWithConsent();
    const original = await studentIdOf(lesson);
    const answers = await Promise.all([1, 2, 3].map(() => change(lesson, "revoke_link")));
    expect(answers.map(answer => answer.status)).toEqual([200, 200, 200]);
    const events = await eventsOf(lesson);
    expect(events.filter(event => event.type === "server.room_generation").map(event => event.generation).sort()).toEqual([1, 2, 3]);
    const chain = events.filter(event => event.type === "server.participant_rotated").sort((a, b) => a.generation - b.generation);
    expect(chain[0].from).toBe(original);
    for (let n = 1; n < chain.length; n += 1) expect(chain[n].from).toBe(chain[n - 1].to);
    expect(chain.at(-1).to).toBe(await studentIdOf(lesson));
    at("2026-12-03T07:56:00Z");
    expect((await join(lesson, { key: lesson.key })).status).toBe(403);
  });

  test("replays are refused every time: the original link after a reissue, an earlier reissued link after a later one, the latest after a revoke; each refusal is on record, and the latest link works until it is revoked", async () => {
    at("2026-12-03T07:50:00Z");
    const lesson = await lessonWithConsent();
    const second = keyOf((await change(lesson, "reissue_link")).body.studentLink);
    const third = keyOf((await change(lesson, "reissue_link")).body.studentLink);
    at("2026-12-03T07:56:00Z");
    for (const key of [lesson.key, second, lesson.key, second]) expect((await join(lesson, { key })).status).toBe(403);
    expect(claimsOf((await join(lesson, { key: third })).body.session.token).tpc).toBe(roomNameOf(lesson.id, 2));
    expect((await change(lesson, "revoke_link")).status).toBe(200);
    for (let n = 0; n < 3; n += 1) expect((await join(lesson, { key: third })).status).toBe(403);
    expect((await eventsOf(lesson)).filter(event => event.type === "server.join_blocked")).toHaveLength(7);
  });

  test("the record keeps which change it was, when, by whom (the activity log) and the ids it changed; never a key or a link, anywhere the server writes", async () => {
    at("2026-12-03T07:50:00Z");
    const lesson = await lessonWithConsent();
    const link = (await change(lesson, "reissue_link")).body.studentLink;
    const reissuedKey = keyOf(link);
    expect((await change(lesson, "revoke_link")).status).toBe(200);
    const rotations = (await eventsOf(lesson)).filter(event => event.type === "server.participant_rotated");
    expect(rotations.map(event => [event.reason, event.generation])).toEqual([["reissue_link", 1], ["revoke_link", 2]]);
    for (const event of rotations) expect(Object.keys(event).sort()).toEqual(["from", "generation", "key", "lessonId", "occurredAt", "reason", "receivedAt", "source", "to", "type"]);
    expect(appendAdminActivity.mock.calls.map(([entry]) => entry).filter(entry => entry.action.startsWith("classroom.student_link")).map(entry => [entry.action, entry.actorEmail, entry.changedFields])).toEqual([
      ["classroom.student_link_reissued", OWNER, ["studentLink"]],
      ["classroom.student_link_revoked", OWNER, ["studentLink"]],
    ]);
    const written = [await readFile(path.join(directory, "classroom.json"), "utf8"), JSON.stringify(appendAdminActivity.mock.calls)].join("\n");
    for (const secret of [lesson.key, reissuedKey, link]) expect(written).not.toContain(secret);
  });
});

describe("phase 3: recording after the room moved", () => {
  test("A: moved before anything was recorded (a reissue before class): the tick checks again for the new room and starts there only", async () => {
    at("2026-12-03T07:50:00Z");
    const lesson = await lessonWithConsent();
    const key = keyOf((await change(lesson, "reissue_link")).body.studentLink);
    at("2026-12-03T07:56:00Z");
    await intoNewRoom(lesson, "ZS-A1", 1, key);
    advance(10 * SEC); await tick();
    const checks = (await eventsOf(lesson)).filter(event => event.type === "server.recording_eligibility");
    expect(checks.map(event => [event.generation ?? 0, event.eligible])).toEqual([[0, true], [1, true]]);
    advance(10 * SEC); await tick();
    expect(await calls(lesson)).toEqual([["recording.start", "ZS-A1"]]);
  });

  test("A: a consent that has expired by the time of the new room's check stops it from starting; the overview says the new room is not recorded", async () => {
    at("2026-12-03T07:50:00Z");
    const lesson = await lessonWithConsent();
    advance(MIN); await tick(); // the lesson's own decision: eligible
    const key = keyOf((await change(lesson, "reissue_link")).body.studentLink);
    const consent = (await classroomStore().listConsents([`${lesson.code}-S`]))[0];
    await classroomStore().setConsent({ ...consent, expiresAt: Date.now() + MIN });
    at("2026-12-03T07:56:00Z");
    await intoNewRoom(lesson, "ZS-A2", 1, key);
    advance(10 * SEC); await tick();
    advance(10 * SEC); await tick();
    expect(await calls(lesson)).toEqual([]);
    const state = await stateOf(lesson);
    expect([state.roomRecording.status, state.roomRecording.reason]).toEqual(["RECHECK_REFUSED", "CONSENT_EXPIRED"]);
  });

  test("B: recording, then a reissue: the old room is stopped and ended; nothing starts in the new room; the owner's authorization is refused while the old room may still record, then accepted; the check passes and the start goes to the new room only", async () => {
    const lesson = await recordedLesson("ZS-B1");
    advance(5 * MIN);
    const key = keyOf((await change(lesson, "reissue_link")).body.studentLink);
    advance(10 * SEC);
    await intoNewRoom(lesson, "ZS-B2", 1, key);
    advance(10 * SEC); await tick();
    expect(await calls(lesson)).toEqual([["recording.start", "ZS-B1"], ["recording.stop", "ZS-B1"], ["session.end", "ZS-B1"]]);
    advance(30 * SEC); await tick();
    expect((await calls(lesson)).filter(([type]) => type === "recording.start")).toEqual([["recording.start", "ZS-B1"]]);
    expect(await resume(lesson)).toMatchObject({ status: 409, body: { code: "OLD_ROOM_STILL_RECORDING" } });
    // The pages are told the lesson may not be recorded in the new room until it is authorized and checked.
    expect(await recordingAllowed(lesson, key)).toBe(false);
    await recordingIs(lesson, "ZS-B1", "Stopped");
    advance(SEC);
    const authorized = await resume(lesson);
    expect(await recordingAllowed(lesson, key)).toBe(true);
    expect(authorized).toMatchObject({ status: 200, body: { authorized: true, generation: 1, roomRecording: { status: "ALLOWED" } } });
    expect((await calls(lesson)).filter(([type]) => type === "recording.start")).toEqual([["recording.start", "ZS-B1"], ["recording.start", "ZS-B2"]]);
    expect(appendAdminActivity.mock.calls.map(([entry]) => entry.action)).toContain("classroom.recording_resume_authorized");
    // Confirmed by Zoom: recording in the new room, and nothing flagged as unapproved.
    await recordingIs(lesson, "ZS-B2", "Recording", 1);
    const state = await stateOf(lesson);
    expect(state.recording.status).toBe("RECORDING");
    expect(state.anomalies.map(entry => entry.code)).not.toContain("UNAPPROVED_RECORDING_START");
  });

  test("B with a refused check: the owner authorizes after the student's consent expired; the new room's check refuses and nothing starts there, the pages are told so, and the first room's recording, arriving later, is still filed by its own room's decision", async () => {
    const lesson = await recordedLesson("ZS-R1");
    advance(5 * MIN);
    const key = keyOf((await change(lesson, "reissue_link")).body.studentLink);
    advance(10 * SEC);
    await intoNewRoom(lesson, "ZS-R2", 1, key);
    advance(10 * SEC); await tick();
    await recordingIs(lesson, "ZS-R1", "Stopped");
    const consent = (await classroomStore().listConsents([`${lesson.code}-S`]))[0];
    await classroomStore().setConsent({ ...consent, expiresAt: Date.now() });
    advance(SEC);
    expect(await resume(lesson)).toMatchObject({ status: 200, body: { roomRecording: { status: "RECHECK_REFUSED", reason: "CONSENT_EXPIRED" } } });
    expect((await calls(lesson)).filter(([type]) => type === "recording.start")).toEqual([["recording.start", "ZS-R1"]]);
    expect(await recordingAllowed(lesson, key)).toBe(false);
    const file = { id: "f-r1", file_type: "MP4", recording_type: "shared_screen_with_speaker_view", file_size: 2048, status: "completed", recording_start: "2026-12-03T07:57:00Z", recording_end: new Date().toISOString(), download_url: "https://example.invalid/never-kept" };
    await zoom("session.recording_completed", lesson, "ZS-R1", { session_name: roomNameOf(lesson.id, 0), recording_files: [file] });
    expect((await classroomStore().fileRecord("f-r1")).hold).toBeNull();
  });

  for (const [name, protect, code] of [
    ["a withdrawal of consent", async lesson => { signedIn(OWNER); expect((await consents.POST(post("/api/admin/classrooms/consents", { personCode: `${lesson.code}-S`, role: "student", status: "withdrawn" }))).status).toBe(200); }, "CONSENT_WITHDRAWN"],
    ["an emergency stop", async lesson => { signedIn(OWNER); expect((await stopRoute.POST(post(`/api/admin/classrooms/${lesson.id}/stop-recording`), params(lesson.id))).status).toBe(200); }, "EMERGENCY_STOP"],
    ["a cancellation", async lesson => { expect((await change(lesson, "cancel")).status).toBe(200); }, "LESSON_CANCELLED"],
  ]) {
    test(`B refused for good after ${name}: a later revoke moves the room, the old room is cleaned up, the owner's authorization is refused (409 ${code}), and nothing starts again, even with an authorization and a passing check forged into the store`, async () => {
      const lesson = await recordedLesson(`ZS-${code}`);
      advance(MIN);
      await protect(lesson);
      advance(10 * SEC); await tick();
      await recordingIs(lesson, `ZS-${code}`, "Stopped");
      advance(MIN);
      expect((await change(lesson, "revoke_link")).status).toBe(200);
      advance(10 * SEC);
      const tutor = await join(lesson, { email: TUTOR });
      if (code === "LESSON_CANCELLED") expect(tutor.status).toBe(403);
      await started(lesson, `ZS-${code}-2`, 1);
      await joined(lesson, `ZS-${code}-2`, lesson.tutorId);
      await joined(lesson, `ZS-${code}-2`, await studentIdOf(lesson));
      expect(await resume(lesson)).toMatchObject({ status: 409, body: { code } });
      // Forged straight into the store: an authorization and a passing check for the new room.
      const now = Date.now();
      await classroomStore().transaction(async tx => {
        await tx.insertEvent({ source: "server", type: "server.recording_resume_authorized", lessonId: lesson.id, generation: 1, occurredAt: now, receivedAt: now, key: `forged-resume:${lesson.id}` });
        await tx.insertEvent({ source: "server", type: "server.recording_eligibility", lessonId: lesson.id, generation: 1, eligible: true, reason: "ALL_CONSENTED", occurredAt: now + 1, receivedAt: now + 1, key: `forged-check:${lesson.id}` });
      });
      for (let n = 0; n < 3; n += 1) { advance(30 * SEC); await tick(); }
      expect((await calls(lesson)).filter(([type]) => type === "recording.start")).toEqual([["recording.start", `ZS-${code}`]]);
      expect((await stateOf(lesson)).roomRecording).toMatchObject({ status: "BLOCKED", reason: code, canAuthorize: false });
    });
  }

  test("the authorization keeps the admin checks (signed out, an editor, another site's page: 403) and is refused where it does not apply: a room that never moved, or nothing recorded before the move", async () => {
    at("2026-12-03T07:50:00Z");
    const lesson = await lessonWithConsent();
    expect((await resume(lesson, { email: null })).status).toBe(403);
    expect((await resume(lesson, { email: EDITOR })).status).toBe(403);
    expect(await resume(lesson, { origin: "https://elsewhere.example" })).toMatchObject({ status: 403, body: { error: "Cross-origin request blocked" } });
    expect(await resume(lesson)).toMatchObject({ status: 409, body: { code: "ROOM_NOT_MOVED" } });
    expect((await change(lesson, "reissue_link")).status).toBe(200);
    expect(await resume(lesson)).toMatchObject({ status: 409, body: { code: "NO_AUTHORIZATION_NEEDED" } });
    expect((await eventsOf(lesson)).filter(event => event.type === "server.recording_resume_authorized")).toEqual([]);
  });

  test("two moves while recording: only the newest room can be authorized and record; the files of both rooms are listed with the room they were recorded in", async () => {
    const lesson = await recordedLesson("ZS-T1");
    advance(5 * MIN);
    const key1 = keyOf((await change(lesson, "reissue_link")).body.studentLink);
    advance(10 * SEC);
    await intoNewRoom(lesson, "ZS-T2", 1, key1);
    advance(10 * SEC); await tick();
    await recordingIs(lesson, "ZS-T1", "Stopped");
    advance(MIN);
    const key2 = keyOf((await change(lesson, "reissue_link")).body.studentLink);
    advance(10 * SEC);
    await intoNewRoom(lesson, "ZS-T3", 2, key2);
    advance(10 * SEC); await tick();
    expect(await resume(lesson)).toMatchObject({ status: 200, body: { generation: 2 } });
    const startsAfter = (await calls(lesson)).filter(([type]) => type === "recording.start");
    expect(startsAfter).toEqual([["recording.start", "ZS-T1"], ["recording.start", "ZS-T3"]]);
    await recordingIs(lesson, "ZS-T3", "Recording", 2);
    advance(10 * MIN);
    await recordingIs(lesson, "ZS-T3", "Stopped", 2);
    const file = (id, start) => ({ id, file_type: "MP4", recording_type: "shared_screen_with_speaker_view", file_size: 2048, status: "completed", recording_start: start, recording_end: new Date().toISOString(), download_url: "https://example.invalid/never-kept" });
    await zoom("session.recording_completed", lesson, "ZS-T1", { session_name: roomNameOf(lesson.id, 0), recording_files: [file("f-t1", "2026-12-03T07:57:00Z")] });
    await zoom("session.recording_completed", lesson, "ZS-T3", { session_name: roomNameOf(lesson.id, 2), recording_files: [file("f-t3", "2026-12-03T08:07:00Z")] });
    const state = await stateOf(lesson);
    expect(state.filing.items.map(item => [item.sessionId, item.generation])).toEqual([["ZS-T1", 0], ["ZS-T3", 2]]);
    // Neither is held for want of consent: each is judged by its own room's decision.
    const records = await Promise.all(["f-t1", "f-t3"].map(id => classroomStore().fileRecord(id)));
    expect(records.map(record => [record.providerSessionId, record.hold])).toEqual([["ZS-T1", null], ["ZS-T3", null]]);
  });
});
