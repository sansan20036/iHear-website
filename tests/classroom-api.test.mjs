import { afterAll, beforeEach, describe, expect, test, vi } from "vitest";
import { createHash, createHmac } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// Work a route leaves for after its response (next/server's after) is collected here and run by
// the test when it wants it, instead of by a request scope that does not exist in a unit test.
const afterResponse = vi.hoisted(() => []);
vi.mock("next/server", async original => ({ ...await original(), after: task => { afterResponse.push(task); } }));
vi.mock("../auth.js", () => ({ auth: vi.fn() }));
vi.mock("../lib/admin-store", () => ({ findAdminAccount: vi.fn(), appendAdminActivity: vi.fn() }));
vi.mock("../lib/rate-limit", async original => ({ ...await original(), enforceRateLimit: vi.fn() }));

import { auth } from "../auth.js";
import { appendAdminActivity, findAdminAccount } from "../lib/admin-store";
import { enforceRateLimit } from "../lib/rate-limit";

// The classroom MVP through its website routes, with synthetic data only: TEST- codes,
// example.test addresses and test-only secrets. The synthetic provider stands in for Zoom and a
// local folder for Google Drive; this file plays Zoom's webhooks itself. Passing here says our
// own logic is right. It says nothing about real Zoom behaviour, which is accepted separately.
const directory = await mkdtemp(path.join(os.tmpdir(), "ihear-classroom-"));
const SECRET = "classroom-webhook-test-only";
const OWNER = "owner@example.test";
const EDITOR = "editor@example.test";
const TUTOR = "tutor@example.test";
const ORIGIN = "http://localhost:3000";
// The owner list is read when lib/admins loads, so every module that imports it loads after this.
vi.stubEnv("AUTH_OWNER_EMAILS", OWNER);
vi.stubEnv("IHEAR_FORCE_FILE_STORE", "1");
vi.stubEnv("IHEAR_TEST_DATA_DIR", directory);
vi.stubEnv("CLASSROOM_PROVIDER", "synthetic");
vi.stubEnv("CLASSROOM_DRIVE", "local");
vi.stubEnv("CLASSROOM_WEBHOOK_SECRET", SECRET);
vi.stubEnv("CLASSROOM_SYNTHETIC_SECRET", "classroom-token-test-only");
vi.stubEnv("VERCEL_ENV", "");
const lessons = await import("../app/api/admin/classrooms/route");
const tickRoute = await import("../app/api/admin/classrooms/tick/route");
const consents = await import("../app/api/admin/classrooms/consents/route");
const anomalies = await import("../app/api/admin/classrooms/anomalies/route");
const reconcile = await import("../app/api/admin/classrooms/[lessonId]/reconcile/route");
const joinRoute = await import("../app/api/classroom/[lessonId]/join/route");
const hostRoute = await import("../app/api/classroom/[lessonId]/host-events/route");
const webhook = await import("../app/api/recordings/zoom/webhook/route");
const { classroomStore } = await import("../lib/classroom-store");

// Planted in the synthetic Zoom payloads; none of them may be stored or shown.
const PLANTED = ["Synthetic Display Name", "+886-2-0000-0000", "example.invalid", "synthetic-download-token-not-real", "203.0.113.7"];

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
const runAfterResponse = async () => { for (const task of afterResponse.splice(0)) await task(); };
const signedIn = email => auth.mockResolvedValue(email ? { user: { email } } : null);
const params = lessonId => ({ params: Promise.resolve({ lessonId }) });
const post = (pathname, body = {}, headers = {}) => new Request(`${ORIGIN}${pathname}`, {
  method: "POST", headers: { origin: ORIGIN, "content-type": "application/json", ...headers }, body: JSON.stringify(body),
});
const read = async response => ({ status: response.status, body: await response.json(), headers: response.headers });
const claimsOf = token => JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));

async function createLesson(fields) {
  signedIn(OWNER);
  const result = await read(await lessons.POST(post("/api/admin/classrooms", { date: "2026-11-20", minutes: 60, tutorEmail: TUTOR, ...fields })));
  expect(result.status).toBe(201);
  const link = new URL(result.body.studentLink, ORIGIN);
  return { lessonId: result.body.lesson.lessonId, key: link.searchParams.get("k"), link: result.body.studentLink };
}

async function join(lessonId, { key, email } = {}) {
  signedIn(email);
  return read(await joinRoute.POST(post(`/api/classroom/${lessonId}/join`, key ? { key } : {}), params(lessonId)));
}

async function hostReport(lessonId, report, email = TUTOR) {
  signedIn(email);
  return read(await hostRoute.POST(post(`/api/classroom/${lessonId}/host-events`, { at: new Date().toISOString(), ...report }), params(lessonId)));
}

async function setConsent(personCode, role, status = "granted") {
  signedIn(OWNER);
  return read(await consents.POST(post("/api/admin/classrooms/consents", { personCode, role, status })));
}

function signedWebhook(rawBody, { secret = SECRET, timestamp = Math.floor(Date.now() / 1000) } = {}) {
  const signature = `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${rawBody}`).digest("hex")}`;
  return new Request(`${ORIGIN}/api/recordings/zoom/webhook`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-zm-request-timestamp": String(timestamp), "x-zm-signature": signature },
    body: rawBody,
  });
}

// Zoom's side of a lesson, shaped like the Video SDK webhooks (with personal data planted).
function zoomBody(type, lesson, object = {}) {
  return JSON.stringify({
    event: type,
    event_ts: Date.now(),
    ...(type === "session.recording_completed" ? { download_token: "synthetic-download-token-not-real" } : {}),
    payload: { account_id: "synthetic-account", object: { id: lesson.sessionId, session_id: lesson.sessionId, session_key: lesson.lessonId, ...object } },
  });
}
async function zoom(type, lesson, object) {
  return read(await webhook.POST(signedWebhook(zoomBody(type, lesson, object))));
}
const zoomUser = (userKey, uuid, times) => ({ user: { id: "16778240", name: "Synthetic Display Name", phone_number: "+886-2-0000-0000", ip_address: "203.0.113.7", user_key: userKey, participant_uuid: uuid, ...times } });

async function tick() {
  signedIn(OWNER);
  const result = await read(await tickRoute.POST(post("/api/admin/classrooms/tick")));
  expect(result.status).toBe(200);
  return result.body;
}

async function overview() {
  signedIn(OWNER);
  const result = await read(await lessons.GET(new Request(`${ORIGIN}/api/admin/classrooms`)));
  expect(result.status).toBe(200);
  return result.body;
}
function cardOf(view, code) {
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

// Both people in, the session started and both joins confirmed by Zoom.
async function startLesson(lesson, uuids) {
  const student = await join(lesson.lessonId, { key: lesson.key });
  const tutor = await join(lesson.lessonId, { email: TUTOR });
  expect(student.status).toBe(200);
  expect(tutor.status).toBe(200);
  lesson.studentId = claimsOf(student.body.session.token).user_key;
  lesson.tutorId = claimsOf(tutor.body.session.token).user_key;
  const now = new Date().toISOString();
  expect((await zoom("session.started", lesson, { start_time: now })).status).toBe(200);
  expect((await zoom("session.user_joined", lesson, zoomUser(lesson.tutorId, uuids[0], { join_time: now }))).status).toBe(200);
  expect((await zoom("session.user_joined", lesson, zoomUser(lesson.studentId, uuids[1], { join_time: now }))).status).toBe(200);
  return { student, tutor };
}

describe("classroom access", () => {
  test("the overview and every administrator action are for owners only, never cached", async () => {
    at("2026-11-20T07:00:00Z");
    const request = () => new Request(`${ORIGIN}/api/admin/classrooms`);
    expect((await lessons.GET(request())).status).toBe(403);
    signedIn(EDITOR);
    findAdminAccount.mockResolvedValue({ email: EDITOR, enabled: true });
    expect((await lessons.GET(request())).status).toBe(403);
    expect((await lessons.POST(post("/api/admin/classrooms", { code: "TEST-X" }))).status).toBe(403);
    expect((await tickRoute.POST(post("/api/admin/classrooms/tick"))).status).toBe(403);
    expect((await consents.POST(post("/api/admin/classrooms/consents", { personCode: "TEST-S1" }))).status).toBe(403);
    expect((await anomalies.POST(post("/api/admin/classrooms/anomalies", { lessonId: "L-x", code: "STALE_DATA", note: "x" }))).status).toBe(403);
    expect((await reconcile.POST(post("/api/admin/classrooms/L-x/reconcile"), params("L-x"))).status).toBe(403);
    signedIn(OWNER);
    const response = await lessons.GET(request());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store, max-age=0");
    expect(response.headers.get("vercel-cdn-cache-control")).toBe("no-store");
    // The overview says when it shows synthetic data.
    expect(await response.json()).toMatchObject({ mode: "synthetic" });
  });

  test("owners add lessons from the same origin with valid codes; the personal link is shown once and only its hash is kept", async () => {
    at("2026-11-20T07:00:00Z");
    signedIn(OWNER);
    const crossOrigin = await lessons.POST(post("/api/admin/classrooms", {}, { origin: "https://evil.example" }));
    expect(crossOrigin.status).toBe(403);
    const invalid = await read(await lessons.POST(post("/api/admin/classrooms", { code: "bad code!", date: "2026-11-20", time: "25:00", minutes: 5, tutorCode: "TEST-T0", tutorEmail: "nope", studentCode: "TEST-T0" })));
    expect(invalid.status).toBe(400);
    expect(Object.keys(invalid.body.issues).sort()).toEqual(["code", "minutes", "studentCode", "time", "tutorEmail"]);
    const lesson = await createLesson({ code: "TEST-L0", time: "14:00", tutorCode: "TEST-T0", studentCode: "TEST-S0" });
    expect(lesson.link).toMatch(/^\/classroom\/L-[0-9a-f]{32}\?k=[A-Za-z0-9_-]{43}$/);
    expect(appendAdminActivity).toHaveBeenCalledWith(expect.objectContaining({ action: "classroom.lesson_created", entityType: "classroom", actorEmail: OWNER }));
    const stored = await readFile(path.join(directory, "classroom.json"), "utf8");
    expect(stored).not.toContain(lesson.key);
    expect(stored).toContain(createHash("sha256").update(lesson.key).digest("hex"));
    const duplicate = await lessons.POST(post("/api/admin/classrooms", { code: "TEST-L0", date: "2026-11-20", time: "15:00", minutes: 60, tutorCode: "TEST-T0", tutorEmail: TUTOR, studentCode: "TEST-S0" }));
    expect(duplicate.status).toBe(409);
    expect(JSON.stringify(await overview())).not.toContain(lesson.key);
  });

  test("entry checks identity, roster and time; refusals are recorded and nothing is issued", async () => {
    at("2026-11-20T05:00:00Z");
    const lesson = await createLesson({ code: "TEST-L9", time: "16:00", tutorCode: "TEST-T9", studentCode: "TEST-S9" });
    const early = await join(lesson.lessonId, { key: lesson.key });
    expect(early).toMatchObject({ status: 403, body: { code: "OUTSIDE_JOIN_WINDOW" } });
    expect(early.body.session).toBeUndefined();
    at("2026-11-20T07:50:00Z");
    expect(await join(lesson.lessonId, { key: "not-the-key" })).toMatchObject({ status: 403, body: { code: "NOT_ON_ROSTER" } });
    expect(await join(lesson.lessonId, {})).toMatchObject({ status: 403, body: { code: "NOT_ON_ROSTER" } });
    expect(await join(lesson.lessonId, { email: "someone@example.test" })).toMatchObject({ status: 403, body: { code: "NOT_ON_ROSTER" } });
    expect(await join("L-00000000000000000000000000000000", { key: lesson.key })).toMatchObject({ status: 404, body: { code: "LESSON_NOT_FOUND" } });
    const blocked = (await classroomStore().eventsFor([lesson.lessonId])).filter(event => event.type === "server.join_blocked");
    expect(blocked.map(event => event.reason)).toEqual(["OUTSIDE_JOIN_WINDOW", "NOT_ON_ROSTER", "NOT_ON_ROSTER", "NOT_ON_ROSTER"]);
    signedIn(null);
    expect((await joinRoute.POST(post(`/api/classroom/${lesson.lessonId}/join`, { key: lesson.key }, { origin: "https://evil.example" }), params(lesson.lessonId))).status).toBe(403);

    const student = await join(lesson.lessonId, { key: lesson.key });
    expect(student).toMatchObject({ status: 200, body: { ok: true, provider: "synthetic", role: "student", participantCode: "TEST-S9" } });
    const claims = claimsOf(student.body.session.token);
    expect(claims).toMatchObject({ role_type: 0, session_key: lesson.lessonId });
    expect(claims.exp - claims.iat).toBe(1800);
    const tutor = await join(lesson.lessonId, { email: TUTOR });
    expect(tutor).toMatchObject({ status: 200, body: { role: "tutor", participantCode: "TEST-T9" } });
    // Only the host's token carries the recording option: one combined video.
    expect(claimsOf(tutor.body.session.token)).toMatchObject({ role_type: 1, cloud_recording_option: 0 });
    const tokens = JSON.parse(await readFile(path.join(directory, "classroom.json"), "utf8"));
    expect(JSON.stringify(tokens)).not.toContain(student.body.session.token);
  });

  test("without a configured provider the classroom stays closed and consent records wait for the policy", async () => {
    at("2026-11-20T07:50:00Z");
    vi.stubEnv("CLASSROOM_PROVIDER", "");
    try {
      expect(await join("L-00000000000000000000000000000000", {})).toMatchObject({ status: 503, body: { code: "PROVIDER_UNAVAILABLE" } });
      expect(await setConsent("TEST-S1", "student")).toMatchObject({ status: 403, body: { code: "POLICY_PENDING" } });
      signedIn(OWNER);
      expect((await tickRoute.POST(post("/api/admin/classrooms/tick"))).status).toBe(503);
      expect((await webhook.POST(signedWebhook(zoomBody("session.started", { lessonId: "L-x", sessionId: "S" })))).status).toBe(503);
      vi.stubEnv("CLASSROOM_PROVIDER", "zoom");
      expect(await join("L-00000000000000000000000000000000", {})).toMatchObject({ status: 503, body: { code: "PROVIDER_UNAVAILABLE" } });
      vi.stubEnv("CLASSROOM_PROVIDER", "synthetic");
      vi.stubEnv("VERCEL_ENV", "production");
      expect(await join("L-00000000000000000000000000000000", {})).toMatchObject({ status: 503, body: { code: "PROVIDER_UNAVAILABLE" } });
      expect(await setConsent("TEST-S1", "student")).toMatchObject({ status: 403, body: { code: "POLICY_PENDING" } });
    } finally {
      vi.stubEnv("CLASSROOM_PROVIDER", "synthetic");
      vi.stubEnv("VERCEL_ENV", "");
    }
  });

  test("only the lesson's signed-in tutor can report, and unknown reports are refused", async () => {
    at("2026-11-20T07:50:00Z");
    const lesson = await createLesson({ code: "TEST-L8", time: "16:00", tutorCode: "TEST-T8", studentCode: "TEST-S8" });
    expect(await hostReport(lesson.lessonId, { type: "heartbeat" }, null)).toMatchObject({ status: 401, body: { code: "SIGN_IN_REQUIRED" } });
    expect(await hostReport(lesson.lessonId, { type: "heartbeat" }, "someone@example.test")).toMatchObject({ status: 403, body: { code: "FORBIDDEN" } });
    expect((await hostReport(lesson.lessonId, { type: "something_else" })).status).toBe(400);
    // Hours before the lesson nothing is decided yet, which is not the same as "not recorded".
    at("2026-11-20T05:00:00Z");
    expect(await hostReport(lesson.lessonId, { type: "heartbeat" })).toMatchObject({ status: 200, body: { ok: true, recordingAllowed: false, recordingDecided: false } });
    at("2026-11-20T07:50:00Z");
    expect(await hostReport(lesson.lessonId, { type: "heartbeat" })).toMatchObject({ status: 200, body: { ok: true, recordingAllowed: false, recordingDecided: true, recording: { status: "BLOCKED" } } });
  });
});

describe("Zoom webhooks", () => {
  const lesson = { lessonId: "L-webhooktest0000000000000000000000", sessionId: "SYN-SESSION-W" };

  test("a bad signature or an old timestamp is refused and stores nothing", async () => {
    at("2026-11-20T07:50:00Z");
    const body = zoomBody("session.started", lesson, { start_time: new Date().toISOString() });
    expect((await webhook.POST(signedWebhook(body, { secret: "wrong-secret" }))).status).toBe(401);
    expect((await webhook.POST(signedWebhook(body, { timestamp: Math.floor(Date.now() / 1000) - 600 }))).status).toBe(401);
    expect(await classroomStore().eventsFor([lesson.lessonId])).toEqual([]);
    expect(afterResponse).toHaveLength(0);
  });

  test("URL validation answers with the encrypted token", async () => {
    at("2026-11-20T07:50:00Z");
    const result = await read(await webhook.POST(signedWebhook(JSON.stringify({ event: "endpoint.url_validation", payload: { plainToken: "synthetic-plain-token" } }))));
    expect(result).toMatchObject({ status: 200, body: { plainToken: "synthetic-plain-token", encryptedToken: createHmac("sha256", SECRET).update("synthetic-plain-token").digest("hex") } });
  });

  test("a redelivered event is stored once and still answered 200, without personal data", async () => {
    at("2026-11-20T07:50:00Z");
    const object = zoomUser("P-webhookuser", "UUID-W1", { join_time: "2026-11-20T07:49:00Z" });
    const first = await zoom("session.user_joined", lesson, object);
    at("2026-11-20T07:55:00Z");
    const again = await zoom("session.user_joined", lesson, object);
    expect(first).toMatchObject({ status: 200, body: { stored: 1, duplicates: 0 } });
    expect(again).toMatchObject({ status: 200, body: { stored: 0, duplicates: 1 } });
    const events = await classroomStore().eventsFor([lesson.lessonId]);
    expect(events).toHaveLength(1);
    for (const value of PLANTED) expect(JSON.stringify(events)).not.toContain(value);
  });
});

describe("a recorded lesson, synthetic end to end", () => {
  test("consent for everyone: recording starts only on our request, is confirmed by Zoom, and the file is filed once", async () => {
    at("2026-11-20T07:50:00Z");
    const lesson = { ...(await createLesson({ code: "TEST-L1", time: "16:00", tutorCode: "TEST-T1", studentCode: "TEST-S1" })), sessionId: "SYN-SESSION-1" };
    expect((await setConsent("TEST-S1", "student")).status).toBe(200);
    expect((await setConsent("TEST-T1", "tutor")).status).toBe(200);
    at("2026-11-20T07:56:00Z");
    await startLesson(lesson, ["UUID-T1", "UUID-S1"]);

    at("2026-11-20T07:56:10Z");
    await tick();
    expect(await syntheticCalls(lesson.lessonId)).toEqual([]);
    at("2026-11-20T07:56:20Z");
    await tick();
    expect(await syntheticCalls(lesson.lessonId)).toEqual(["recording.start"]);
    let card = cardOf(await overview(), "TEST-L1");
    expect(card).toMatchObject({ group: "LIVE", recording: { status: "START_REQUESTED", basis: "requested" } });

    at("2026-11-20T07:56:30Z");
    await zoom("session.recording_started", lesson, { recording_file: { recording_start: new Date().toISOString() } });
    card = cardOf(await overview(), "TEST-L1");
    expect(card).toMatchObject({ group: "LIVE", recording: { status: "RECORDING", basis: "confirmed", source: "zoom_webhook" } });
    at("2026-11-20T07:57:00Z");
    expect(await hostReport(lesson.lessonId, { type: "heartbeat" })).toMatchObject({ status: 200, body: { recordingAllowed: true, recording: { status: "RECORDING" } } });

    at("2026-11-20T09:00:00Z");
    await zoom("session.recording_stopped", lesson, { recording_file: { recording_end: "2026-11-20T09:00:00Z" } });
    await zoom("session.user_left", lesson, zoomUser(lesson.studentId, "UUID-S1", { leave_time: "2026-11-20T09:00:10Z", leave_reason: "left the session" }));
    await zoom("session.user_left", lesson, zoomUser(lesson.tutorId, "UUID-T1", { leave_time: "2026-11-20T09:00:15Z", leave_reason: "left the session" }));
    await zoom("session.ended", lesson, { end_time: "2026-11-20T09:00:20Z" });
    at("2026-11-20T09:05:00Z");
    const file = (id, type, extension, size) => ({
      id, recording_type: type, file_extension: extension, file_type: extension, file_size: size, status: "completed",
      recording_start: "2026-11-20T07:56:30Z", recording_end: "2026-11-20T09:00:00Z",
      file_name: "Synthetic Display Name recording", download_url: "https://example.invalid/synthetic/download",
    });
    const files = { recording_files: [file("SYN-FILE-V1", "shared_screen_with_speaker_view", "MP4", 1024), file("SYN-FILE-A1", "audio_only", "M4A", 512)] };
    afterResponse.length = 0;
    expect((await zoom("session.recording_completed", lesson, files)).status).toBe(200);
    // Zoom delivers again after a timeout: still one record and one filing job.
    expect((await zoom("session.recording_completed", lesson, files)).body).toMatchObject({ duplicates: 1 });
    expect(await syntheticCalls("SYN-FILE-V1")).toEqual([]);
    // The work after the answer files the recording; nobody has to have the overview open.
    expect(afterResponse.length).toBeGreaterThan(0);
    await runAfterResponse();

    const view = await overview();
    card = cardOf(view, "TEST-L1");
    expect(card).toMatchObject({ group: "ENDED", recording: { status: "COMPLETED", basis: "confirmed" }, filing: { status: "STORED", label: "已歸檔" } });
    const drive = JSON.parse(await readFile(path.join(directory, "synthetic-drive", "index.json"), "utf8"));
    const filed = Object.values(drive.files).filter(entry => !entry.trashed);
    expect(filed).toHaveLength(1);
    // P1's naming: date, student code, tutor code, part.
    expect(filed[0]).toMatchObject({ name: "2026-11-20_TEST-S1_TEST-T1_P01.mp4", size: 1024, appProperties: { providerFileId: "SYN-FILE-V1" } });
    expect(await syntheticCalls("SYN-FILE-V1")).toEqual(["recording.delete"]);
    expect(await syntheticCalls("SYN-FILE-A1")).toEqual([]);

    // Codes only: no e-mail address, personal link, token or planted personal data.
    const shown = JSON.stringify(view);
    for (const value of [TUTOR, lesson.key, createHash("sha256").update(lesson.key).digest("hex"), ...PLANTED]) expect(shown).not.toContain(value);
    const stored = await readFile(path.join(directory, "classroom.json"), "utf8");
    for (const value of PLANTED) expect(stored).not.toContain(value);
  });

  test("a student without consent attends as usual; the whole lesson is simply not recorded", async () => {
    at("2026-11-20T09:50:00Z");
    const lesson = { ...(await createLesson({ code: "TEST-L2", time: "18:00", tutorCode: "TEST-T2", studentCode: "TEST-S2" })), sessionId: "SYN-SESSION-2" };
    expect((await setConsent("TEST-T2", "tutor")).status).toBe(200);
    at("2026-11-20T09:56:00Z");
    const { student } = await startLesson(lesson, ["UUID-T2", "UUID-S2"]);
    expect(student.body.role).toBe("student");
    for (const time of ["09:56:10", "09:56:20", "09:57:30"]) {
      at(`2026-11-20T${time}Z`);
      await tick();
    }
    expect(await syntheticCalls(lesson.lessonId)).toEqual([]);
    const card = cardOf(await overview(), "TEST-L2");
    expect(card).toMatchObject({ group: "LIVE", recording: { status: "BLOCKED", label: "不錄影（同意條件不符）" } });
    expect(await hostReport(lesson.lessonId, { type: "heartbeat" })).toMatchObject({ status: 200, body: { recordingAllowed: false, recording: { status: "BLOCKED" } } });
  });

  test("consent withdrawn mid-lesson: stop at once on both channels, again at 30 s, end the session at 60 s, then flag and record the handling", async () => {
    at("2026-11-20T11:50:00Z");
    const lesson = { ...(await createLesson({ code: "TEST-L3", time: "20:00", tutorCode: "TEST-T3", studentCode: "TEST-S3" })), sessionId: "SYN-SESSION-3" };
    await setConsent("TEST-S3", "student");
    await setConsent("TEST-T3", "tutor");
    at("2026-11-20T11:56:00Z");
    await startLesson(lesson, ["UUID-T3", "UUID-S3"]);
    at("2026-11-20T11:56:10Z");
    await tick();
    at("2026-11-20T11:56:20Z");
    await tick();
    at("2026-11-20T11:56:30Z");
    await zoom("session.recording_started", lesson, { recording_file: { recording_start: new Date().toISOString() } });
    expect(await syntheticCalls(lesson.lessonId)).toEqual(["recording.start"]);

    at("2026-11-20T12:20:00Z");
    expect((await setConsent("TEST-S3", "student", "withdrawn")).status).toBe(200);
    at("2026-11-20T12:20:01Z");
    await tick();
    expect(await syntheticCalls(lesson.lessonId)).toEqual(["recording.start", "recording.stop"]);
    at("2026-11-20T12:20:05Z");
    expect(await hostReport(lesson.lessonId, { type: "heartbeat" })).toMatchObject({ status: 200, body: { recordingAllowed: false } });
    at("2026-11-20T12:20:31Z");
    await tick();
    expect(await syntheticCalls(lesson.lessonId)).toEqual(["recording.start", "recording.stop", "recording.stop"]);
    at("2026-11-20T12:21:01Z");
    await tick();
    expect(await syntheticCalls(lesson.lessonId)).toEqual(["recording.start", "recording.stop", "recording.stop", "session.end"]);
    at("2026-11-20T12:22:02Z");
    await tick();

    let view = await overview();
    expect(cardOf(view, "TEST-L3").group).toBe("ANOMALY");
    const record = view.anomalies.find(item => item.lessonCode === "TEST-L3" && item.code === "WITHDRAWAL_STOP_UNCONFIRMED");
    expect(record).toMatchObject({ severity: "error", resolvedAt: null, acknowledgedBy: null, handled: false });
    expect(view.anomalies.some(item => item.lessonCode === "TEST-L3" && item.code === "CONSENT_WITHDRAWN")).toBe(true);

    signedIn(OWNER);
    const missingNote = await anomalies.POST(post("/api/admin/classrooms/anomalies", { lessonId: lesson.lessonId, code: "WITHDRAWAL_STOP_UNCONFIRMED", note: " " }));
    expect(missingNote.status).toBe(400);
    const handled = await anomalies.POST(post("/api/admin/classrooms/anomalies", { lessonId: lesson.lessonId, code: "WITHDRAWAL_STOP_UNCONFIRMED", note: "TEST: checked with the tutor; recording stopped" }));
    expect(handled.status).toBe(200);
    expect(appendAdminActivity).toHaveBeenCalledWith(expect.objectContaining({ action: "classroom.anomaly_handled", entityId: `${lesson.lessonId}:WITHDRAWAL_STOP_UNCONFIRMED` }));
    view = await overview();
    expect(view.anomalies.find(item => item.lessonCode === "TEST-L3" && item.code === "WITHDRAWAL_STOP_UNCONFIRMED"))
      .toMatchObject({ acknowledgedBy: OWNER, note: "TEST: checked with the tutor; recording stopped", handled: true });

    // Everyone comes back to a new session of the same lesson: it is never recorded again.
    const rejoined = { ...lesson, sessionId: "SYN-SESSION-3B" };
    at("2026-11-20T12:23:00Z");
    await zoom("session.started", rejoined, { start_time: new Date().toISOString() });
    await zoom("session.user_joined", rejoined, zoomUser(lesson.tutorId, "UUID-T3B", { join_time: new Date().toISOString() }));
    await zoom("session.user_joined", rejoined, zoomUser(lesson.studentId, "UUID-S3B", { join_time: new Date().toISOString() }));
    for (const time of ["12:23:10", "12:23:20", "12:24:30"]) {
      at(`2026-11-20T${time}Z`);
      await tick();
    }
    expect((await syntheticCalls(lesson.lessonId)).filter(type => type === "recording.start")).toHaveLength(1);
  });

  test("consent entered before anyone is in the room counts; consent completed once the tutor is in does not", async () => {
    at("2026-11-20T13:40:00Z");
    const early = { ...(await createLesson({ code: "TEST-L4", time: "22:00", tutorCode: "TEST-T4", studentCode: "TEST-S4" })), sessionId: "SYN-SESSION-4" };
    const late = { ...(await createLesson({ code: "TEST-L5", time: "22:00", tutorCode: "TEST-T5", studentCode: "TEST-S5" })), sessionId: "SYN-SESSION-5" };
    at("2026-11-20T13:46:00Z");
    await tick();
    let view = await overview();
    expect(cardOf(view, "TEST-L4").recording.status).toBe("BLOCKED");
    expect(cardOf(view, "TEST-L5").recording.status).toBe("BLOCKED");

    // TEST-L4: the consent arrives while nobody is in the room yet.
    at("2026-11-20T13:48:00Z");
    await setConsent("TEST-S4", "student");
    await setConsent("TEST-T4", "tutor");
    at("2026-11-20T13:48:10Z");
    await tick();
    expect(cardOf(await overview(), "TEST-L4").recording.status).toBe("NOT_REQUESTED");
    at("2026-11-20T13:50:00Z");
    await startLesson(early, ["UUID-T4", "UUID-S4"]);
    at("2026-11-20T13:50:10Z");
    await tick();
    expect(await syntheticCalls(early.lessonId)).toEqual(["recording.start"]);

    // TEST-L5: the tutor is already in when the consent is completed; the lesson stays unrecorded.
    at("2026-11-20T13:51:00Z");
    expect((await join(late.lessonId, { email: TUTOR })).status).toBe(200);
    expect((await hostReport(late.lessonId, { type: "heartbeat" })).body).toMatchObject({ recordingDecided: true, recordingAllowed: false });
    at("2026-11-20T13:52:00Z");
    await setConsent("TEST-S5", "student");
    await setConsent("TEST-T5", "tutor");
    at("2026-11-20T13:52:10Z");
    await startLesson(late, ["UUID-T5", "UUID-S5"]);
    for (const time of ["13:52:20", "13:52:30", "13:53:40"]) {
      at(`2026-11-20T${time}Z`);
      await tick();
    }
    expect(await syntheticCalls(late.lessonId)).toEqual([]);
    view = await overview();
    expect(cardOf(view, "TEST-L5")).toMatchObject({ group: "LIVE", recording: { status: "BLOCKED" } });
  });

  test("check now asks the provider and is recorded in the activity log", async () => {
    at("2026-11-20T12:30:00Z");
    const lesson = (await overview()).lessons.find(item => item.code === "TEST-L3");
    signedIn(OWNER);
    const result = await read(await reconcile.POST(post(`/api/admin/classrooms/${lesson.lessonId}/reconcile`), params(lesson.lessonId)));
    // The synthetic provider has no snapshot to give, which is reported, not hidden.
    expect(result).toMatchObject({ status: 200, body: { ok: true, reconciled: false } });
    expect(appendAdminActivity).toHaveBeenCalledWith(expect.objectContaining({ action: "classroom.reconciled", entityStatus: "not-reachable" }));
    const missing = await reconcile.POST(post("/api/admin/classrooms/L-00000000000000000000000000000000/reconcile"), params("L-00000000000000000000000000000000"));
    expect(missing.status).toBe(404);
  });
});
