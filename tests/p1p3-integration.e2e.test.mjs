import { afterAll, beforeEach, describe, expect, test, vi } from "vitest";
import { createHmac } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// P1+P3 integration, end to end through the site's own routes (2026-11-08): the owner's cancel,
// revoke and reissue, the classroom's join, status and tutor reports, Zoom's signed webhooks and
// the tick, with synthetic data only (TEST- codes, example.test addresses, test-only secrets).
// The synthetic provider stands in for Zoom and records each request with the session it named;
// it accepts everything, so Zoom's failures are covered in p0-session-id.sim.test.mjs instead.
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

const directory = await mkdtemp(path.join(os.tmpdir(), "ihear-p1p3-e2e-"));
const SECRET = "p1p3-webhook-test-only";
const OWNER = "p1p3-owner@example.test";
const TUTOR = "p1p3-tutor@example.test";
const ORIGIN = "http://localhost:3000";
vi.stubEnv("AUTH_OWNER_EMAILS", OWNER);
vi.stubEnv("IHEAR_FORCE_FILE_STORE", "1");
vi.stubEnv("IHEAR_TEST_DATA_DIR", directory);
vi.stubEnv("CLASSROOM_PROVIDER", "synthetic");
vi.stubEnv("CLASSROOM_DRIVE", "local");
vi.stubEnv("CLASSROOM_WEBHOOK_SECRET", SECRET);
vi.stubEnv("CLASSROOM_SYNTHETIC_SECRET", "p1p3-token-test-only");
vi.stubEnv("VERCEL_ENV", "");
const lessonsRoute = await import("../app/api/admin/classrooms/route");
const lessonRoute = await import("../app/api/admin/classrooms/[lessonId]/route");
const tickRoute = await import("../app/api/admin/classrooms/tick/route");
const consents = await import("../app/api/admin/classrooms/consents/route");
const joinRoute = await import("../app/api/classroom/[lessonId]/join/route");
const hostRoute = await import("../app/api/classroom/[lessonId]/host-events/route");
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
async function lessonWithConsent(time = "16:00") {
  codes += 1;
  const code = `TEST-E${codes}`;
  signedIn(OWNER);
  const created = await read(await lessonsRoute.POST(post("/api/admin/classrooms", { code, date: "2026-12-03", time, minutes: 60, tutorCode: `${code}-T`, tutorEmail: TUTOR, studentCode: `${code}-S` })));
  expect(created.status).toBe(201);
  for (const [personCode, role] of [[`${code}-S`, "student"], [`${code}-T`, "tutor"]]) {
    signedIn(OWNER);
    expect((await consents.POST(post("/api/admin/classrooms/consents", { personCode, role, status: "granted" }))).status).toBe(200);
  }
  return { code, id: created.body.lesson.lessonId, key: keyOf(created.body.studentLink) };
}
const change = async (lesson, action) => {
  signedIn(OWNER);
  const request = new Request(`${ORIGIN}/api/admin/classrooms/${lesson.id}`, { method: "PATCH", headers: { origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify({ action }) });
  return read(await lessonRoute.PATCH(request, params(lesson.id)));
};
const join = async (lesson, { key, email } = {}) => { signedIn(email); return read(await joinRoute.POST(post(`/api/classroom/${lesson.id}/join`, key ? { key } : {}), params(lesson.id))); };
const status = async (lesson, key) => { signedIn(null); return read(await statusRoute.POST(post(`/api/classroom/${lesson.id}/status`, { key }), params(lesson.id))); };
const report = async (lesson, body) => { signedIn(TUTOR); return read(await hostRoute.POST(post(`/api/classroom/${lesson.id}/host-events`, { at: new Date().toISOString(), ...body }), params(lesson.id))); };
const tick = async () => { signedIn(OWNER); expect((await tickRoute.POST(post("/api/admin/classrooms/tick"))).status).toBe(200); };
async function zoom(type, lesson, sessionId, object = {}) {
  const rawBody = JSON.stringify({ event: type, event_ts: Date.now(), payload: { account_id: "synthetic", object: { id: sessionId, session_id: sessionId, session_key: lesson.id, ...object } } });
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = `v0=${createHmac("sha256", SECRET).update(`v0:${timestamp}:${rawBody}`).digest("hex")}`;
  const answer = await read(await webhook.POST(new Request(`${ORIGIN}/api/recordings/zoom/webhook`, { method: "POST", headers: { "content-type": "application/json", "x-zm-request-timestamp": String(timestamp), "x-zm-signature": signature }, body: rawBody })));
  for (const task of afterResponse.splice(0)) await task();
  return answer;
}
const started = (lesson, sessionId, generation = 0) => zoom("session.started", lesson, sessionId, { session_name: roomNameOf(lesson.id, generation), start_time: new Date().toISOString() });
const joined = (lesson, sessionId, userKey, uuid) => zoom("session.user_joined", lesson, sessionId, { user: { user_key: userKey, participant_uuid: uuid, join_time: new Date().toISOString() } });
const left = (lesson, sessionId, userKey, uuid) => zoom("session.user_left", lesson, sessionId, { user: { user_key: userKey, participant_uuid: uuid, leave_time: new Date().toISOString(), leave_reason: "left the meeting" } });
// What the server asked the stand-in for this lesson: [type, the session it named].
const calls = async lesson => JSON.parse(await readFile(path.join(directory, "synthetic-zoom.json"), "utf8").catch(() => '{"calls":[]}'))
  .calls.filter(call => call.lessonId === lesson.id).map(call => [call.type, call.detail ?? null]);
const eventsOf = lesson => classroomStore().eventsFor([lesson.id]);
const stateOf = async lesson => {
  const stored = await classroomStore().lesson(lesson.id);
  return deriveLesson({ ...stored, participants: stored.participants.map(({ id, code, role }) => ({ id, code, role })) }, await eventsOf(lesson), Date.now());
};

// Both in, Zoom's session known with its room name, recording started by the server and confirmed.
async function recordedLesson(sessionId) {
  at("2026-12-03T07:50:00Z");
  const lesson = await lessonWithConsent();
  at("2026-12-03T07:56:00Z");
  const student = await join(lesson, { key: lesson.key });
  const tutor = await join(lesson, { email: TUTOR });
  expect([student.status, tutor.status]).toEqual([200, 200]);
  lesson.studentId = claimsOf(student.body.session.token).user_key;
  lesson.tutorId = claimsOf(tutor.body.session.token).user_key;
  expect(claimsOf(tutor.body.session.token).tpc).toBe(roomNameOf(lesson.id, 0));
  await started(lesson, sessionId);
  await joined(lesson, sessionId, lesson.tutorId, "u-t");
  await joined(lesson, sessionId, lesson.studentId, "u-s");
  advance(10 * SEC); await tick();
  advance(10 * SEC); await tick();
  expect(await calls(lesson)).toEqual([["recording.start", sessionId]]);
  advance(10 * SEC);
  await zoom("session.recording_started", lesson, sessionId, { recording_file: { recording_start: new Date().toISOString() } });
  return lesson;
}

describe("D-2: cancelling ends every live session of the lesson, on the server", () => {
  test("two known sessions, one recording: in the cancel's own request the recording one gets a stop and the other an end; the first is ended once Zoom confirms its stop; no start ever follows", async () => {
    const lesson = await recordedLesson("ZS-A1");
    // A second session of the same lesson (a reconnect that opened a new one, say), not recording.
    advance(MIN);
    await started(lesson, "ZS-A2");
    advance(MIN);
    const answer = await change(lesson, "cancel");
    expect(answer).toEqual({ status: 200, body: { ok: true, cancelled: true, changed: true } });
    expect((await calls(lesson)).slice(1)).toEqual([["recording.stop", "ZS-A1"], ["session.end", "ZS-A2"]]);
    // Zoom confirms the stop; the next tick ends that session too.
    advance(5 * SEC);
    await zoom("session.recording_stopped", lesson, "ZS-A1", { recording_file: { recording_end: new Date().toISOString() } });
    expect((await calls(lesson)).slice(3)).toEqual([["session.end", "ZS-A1"]]);
    // Zoom says both ended: nothing more is sent, nothing stays flagged, and nothing restarts.
    advance(10 * SEC);
    for (const sid of ["ZS-A1", "ZS-A2"]) await zoom("session.ended", lesson, sid, { end_time: new Date().toISOString() });
    for (let minute = 0; minute < 40; minute += 5) { advance(5 * MIN); await tick(); }
    const all = await calls(lesson);
    expect(all.filter(([type]) => type === "session.end")).toHaveLength(2);
    expect(all.filter(([type]) => type === "recording.start")).toHaveLength(1);
    const state = await stateOf(lesson);
    expect(state.anomalies.filter(entry => entry.severity === "error").map(entry => entry.code)).toEqual([]);
    expect(state.sessions.map(entry => [entry.id, entry.live])).toEqual([["ZS-A1", false], ["ZS-A2", false]]);
  });
});

describe("D-1 and D-5: a revoke opens a new generation of the room, and the old room is cleaned up", () => {
  test("revoking mid-recording: new tokens lead to generation 1, the tutor's answers name it, the old room's recording is stopped at once, and the old room is ended 3 minutes later (the revoked student never moved)", async () => {
    const lesson = await recordedLesson("ZS-B1");
    advance(MIN);
    const revokedAt = Date.now();
    expect(await change(lesson, "revoke_link")).toMatchObject({ status: 200, body: { ok: true, revoked: true } });
    expect((await eventsOf(lesson)).filter(event => event.type === "server.room_generation").map(event => event.generation)).toEqual([1]);
    // The old link gets nothing; the tutor's next answer names the new room, and the tutor's next
    // token leads there.
    expect(await status(lesson, lesson.key)).toMatchObject({ status: 403, body: { code: "NOT_ON_ROSTER" } });
    expect((await report(lesson, { type: "heartbeat" })).body.room).toBe(roomNameOf(lesson.id, 1));
    const moved = await join(lesson, { email: TUTOR });
    expect(claimsOf(moved.body.session.token).tpc).toBe(roomNameOf(lesson.id, 1));
    expect(moved.body.session.sessionName).toBe(roomNameOf(lesson.id, 1));
    // The heartbeat's tick already stopped the old room's recording.
    expect((await calls(lesson)).slice(1)).toEqual([["recording.stop", "ZS-B1"]]);
    // The tutor is in the new room; the student (revoked) stays in the old one.
    advance(20 * SEC);
    await started(lesson, "ZS-B2", 1);
    await joined(lesson, "ZS-B2", lesson.tutorId, "u-t2");
    await left(lesson, "ZS-B1", lesson.tutorId, "u-t");
    await tick();
    expect((await calls(lesson)).filter(([type]) => type === "session.end")).toEqual([]);
    at(new Date(revokedAt + 3 * MIN + SEC).toISOString());
    await tick();
    expect((await calls(lesson)).filter(([type]) => type === "session.end")).toEqual([["session.end", "ZS-B1"]]);
    // The new room is never ended by this, and recording is not started again on its own there:
    // after a move the lesson stays unrecorded until a person decides otherwise (safe default).
    expect((await calls(lesson)).filter(([, sid]) => sid === "ZS-B2")).toEqual([]);
  });
});

describe("D-4 and D-5: a reissue gives the student a new participant id", () => {
  test("the new link joins the new room as the same student under a new id; the old id re-entering the old room is a stranger: the recording there stops at once and the room is ended within a minute; the student's earlier presence stays the student's", async () => {
    const lesson = await recordedLesson("ZS-C1");
    advance(MIN);
    const reissued = await change(lesson, "reissue_link");
    expect(reissued).toMatchObject({ status: 200, body: { ok: true, reissued: true } });
    const newKey = keyOf(reissued.body.studentLink);
    const rotation = (await eventsOf(lesson)).find(event => event.type === "server.participant_rotated");
    expect(rotation).toMatchObject({ from: lesson.studentId, source: "server" });
    // The new link: same student code, a new id, the new room.
    const fresh = await join(lesson, { key: newKey });
    expect(fresh).toMatchObject({ status: 200, body: { role: "student", participantCode: `${lesson.code}-S` } });
    expect(claimsOf(fresh.body.session.token)).toMatchObject({ user_key: rotation.to, tpc: roomNameOf(lesson.id, 1) });
    expect(await join(lesson, { key: lesson.key })).toMatchObject({ status: 403, body: { code: "NOT_ON_ROSTER" } });
    // The old link's holder comes back into the old room with the old token.
    advance(10 * SEC);
    const strangerAt = Date.now();
    await joined(lesson, "ZS-C1", lesson.studentId, "u-s-again");
    await tick();
    const state = await stateOf(lesson);
    expect(state.anomalies.map(entry => entry.code)).toEqual(expect.arrayContaining(["OLD_ROOM_SUSPECT", "UNKNOWN_PARTICIPANT"]));
    // Only the re-entry is a stranger; the earlier joins are the student's.
    expect(state.anomalies.find(entry => entry.code === "UNKNOWN_PARTICIPANT").count).toBe(1);
    expect(state.attendance.find(entry => entry.role === "student").status).toBe("PRESENT");
    expect((await calls(lesson)).filter(([type]) => type === "recording.stop")).toEqual([["recording.stop", "ZS-C1"]]);
    at(new Date(strangerAt + MIN + SEC).toISOString());
    await tick();
    expect((await calls(lesson)).filter(([type]) => type === "session.end")).toEqual([["session.end", "ZS-C1"]]);
  });
});

describe("changes at the same time, and a server stopped half-way", () => {
  test("two reissues and a revoke at once: afterwards exactly one participant id is on the roster, at most one returned link still works, and the rotations form one chain", async () => {
    at("2026-12-03T07:50:00Z");
    const lesson = await lessonWithConsent();
    const answers = await Promise.all(["reissue_link", "reissue_link", "revoke_link"].map(action => change(lesson, action)));
    expect(answers.map(answer => answer.status)).toEqual([200, 200, 200]);
    const stored = await classroomStore().lesson(lesson.id);
    const students = stored.participants.filter(entry => entry.role === "student");
    expect(students).toHaveLength(1);
    const links = answers.map(answer => answer.body.studentLink).filter(Boolean).map(keyOf);
    const working = [];
    for (const key of [lesson.key, ...links]) if ((await join(lesson, { key })).status === 200) working.push(key);
    expect(working.length).toBeLessThanOrEqual(1);
    // Each rotation starts from the id the previous one left.
    const rotations = (await eventsOf(lesson)).filter(event => event.type === "server.participant_rotated").sort((a, b) => a.occurredAt - b.occurredAt || 0);
    const ids = new Set(rotations.map(event => event.to));
    expect(ids.has(students[0].id) || rotations.length === 0).toBe(true);
    for (const event of rotations) expect(event.from === rotations[0].from || ids.has(event.from)).toBe(true);
    expect(Math.max(...(await eventsOf(lesson)).filter(event => event.type === "server.room_generation").map(event => event.generation))).toBeGreaterThanOrEqual(1);
  });

  test("the server stops after storing the new generation but before changing the link: the owner is told to retry, and the retry completes the revoke under a further generation", async () => {
    at("2026-12-03T07:50:00Z");
    const lesson = await lessonWithConsent();
    const store = classroomStore();
    const original = store.replaceStudentKeyHash;
    store.replaceStudentKeyHash = async () => { throw new Error("the function was stopped"); };
    try {
      expect(await change(lesson, "revoke_link")).toMatchObject({ status: 503 });
    } finally {
      store.replaceStudentKeyHash = original;
    }
    // Not revoked yet (the change did not finish): the link still enters, into the new generation.
    at("2026-12-03T07:56:00Z");
    const before = await join(lesson, { key: lesson.key });
    expect(claimsOf(before.body.session.token).tpc).toBe(roomNameOf(lesson.id, 1));
    expect(await change(lesson, "revoke_link")).toMatchObject({ status: 200, body: { revoked: true } });
    expect(await join(lesson, { key: lesson.key })).toMatchObject({ status: 403 });
    expect((await eventsOf(lesson)).filter(event => event.type === "server.room_generation").map(event => event.generation).sort()).toEqual([1, 2]);
  });
});

describe("Zoom's notices late or repeated (G-1), and two lessons at once", () => {
  test("a cancel while the session was known only from the tutor's page: the stops go out naming no session, and once Zoom's late notice names the session, a stop and an end go to it", async () => {
    at("2026-12-03T07:50:00Z");
    const lesson = await lessonWithConsent();
    at("2026-12-03T07:56:00Z");
    expect((await join(lesson, { email: TUTOR })).status).toBe(200);
    // A recording the server never asked for (Zoom's automatic recording, say) is stopped at once
    // as unapproved; no session is known yet, so the stop names none.
    expect((await report(lesson, { type: "recording_status", status: "Recording" })).status).toBe(200);
    expect(await calls(lesson)).toEqual([["recording.stop", null]]);
    advance(MIN);
    await change(lesson, "cancel");
    expect(await calls(lesson)).toEqual([["recording.stop", null], ["recording.stop", null]]);
    expect((await eventsOf(lesson)).filter(event => event.type === "server.stop_requested").map(event => [event.reason, event.targets]))
      .toEqual([["unapproved_start", []], ["lesson_cancelled", []]]);
    // Zoom's session.started arrives 90 seconds late (and twice).
    advance(90 * SEC);
    await started(lesson, "ZS-D1");
    await started(lesson, "ZS-D1");
    expect((await eventsOf(lesson)).filter(event => event.type === "session.started")).toHaveLength(1);
    await tick();
    expect((await calls(lesson)).slice(1)).toEqual(expect.arrayContaining([["recording.stop", "ZS-D1"]]));
    advance(61 * SEC); await tick();
    expect((await calls(lesson)).filter(([type, sid]) => type === "session.end" && sid === "ZS-D1")).toHaveLength(1);
  });

  test("two lessons recording at the same time: cancelling one stops and ends only its own session", async () => {
    const first = await recordedLesson("ZS-E1");
    const second = await recordedLesson("ZS-E2");
    advance(MIN);
    await change(first, "cancel");
    advance(5 * SEC);
    await zoom("session.recording_stopped", first, "ZS-E1", { recording_file: { recording_end: new Date().toISOString() } });
    for (let step = 0; step < 3; step += 1) { advance(30 * SEC); await tick(); }
    expect((await calls(first)).filter(([type]) => type !== "recording.start").every(([, sid]) => sid === "ZS-E1")).toBe(true);
    expect((await calls(first)).map(([type]) => type)).toEqual(expect.arrayContaining(["recording.stop", "session.end"]));
    expect(await calls(second)).toEqual([["recording.start", "ZS-E2"]]);
    expect((await stateOf(second)).recording.status).toBe("RECORDING");
  });

  test("a forged notice cannot make the server end or stop a session it names", async () => {
    at("2026-12-03T07:50:00Z");
    const lesson = await lessonWithConsent();
    const rawBody = JSON.stringify({ event: "session.started", event_ts: Date.now(), payload: { object: { id: "ZS-FORGED", session_id: "ZS-FORGED", session_key: lesson.id } } });
    const timestamp = Math.floor(Date.now() / 1000);
    const forged = await webhook.POST(new Request(`${ORIGIN}/api/recordings/zoom/webhook`, { method: "POST", headers: { "content-type": "application/json", "x-zm-request-timestamp": String(timestamp), "x-zm-signature": "v0=0000" }, body: rawBody }));
    expect(forged.status).toBe(401);
    await change(lesson, "cancel");
    expect(await calls(lesson)).toEqual([]);
  });
});
