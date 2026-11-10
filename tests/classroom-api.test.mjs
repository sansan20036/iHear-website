import { afterAll, beforeEach, describe, expect, test, vi } from "vitest";
import { createHash, createHmac } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
const stopRecording = await import("../app/api/admin/classrooms/[lessonId]/stop-recording/route");
const joinRoute = await import("../app/api/classroom/[lessonId]/join/route");
const hostRoute = await import("../app/api/classroom/[lessonId]/host-events/route");
const statusRoute = await import("../app/api/classroom/[lessonId]/status/route");
const webhook = await import("../app/api/recordings/zoom/webhook/route");
const scheduledRoute = await import("../app/api/classroom/scheduled-tick/route");
const { classroomStore } = await import("../lib/classroom-store");
const { entryEndedBy } = await import("../lib/classroom-join-client");
const { knownSessions } = await import("../lib/classroom-provider");

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

// The key of a personal link: behind # (/classroom/<id>#k=<key>), never sent to a server.
const keyOf = link => new URLSearchParams(new URL(link, ORIGIN).hash.slice(1)).get("k") ?? new URL(link, ORIGIN).searchParams.get("k");
const hashOf = value => createHash("sha256").update(value).digest("hex");

async function createLesson(fields) {
  signedIn(OWNER);
  const result = await read(await lessons.POST(post("/api/admin/classrooms", { date: "2026-11-20", minutes: 60, tutorEmail: TUTOR, ...fields })));
  expect(result.status).toBe(201);
  return { lessonId: result.body.lesson.lessonId, key: keyOf(result.body.studentLink), link: result.body.studentLink };
}

// An owner's change to who can enter a lesson: cancel it, or revoke or reissue the student's link.
async function lessonAccess(lessonId, body, { email = OWNER, headers = {} } = {}) {
  signedIn(email);
  const route = await import("../app/api/admin/classrooms/[lessonId]/route");
  const request = new Request(`${ORIGIN}/api/admin/classrooms/${lessonId}`, {
    method: "PATCH", headers: { origin: ORIGIN, "content-type": "application/json", ...headers }, body: JSON.stringify(body),
  });
  return read(await route.PATCH(request, params(lessonId)));
}

async function join(lessonId, { key, email } = {}) {
  signedIn(email);
  return read(await joinRoute.POST(post(`/api/classroom/${lessonId}/join`, key ? { key } : {}), params(lessonId)));
}

async function roomStatus(lessonId, { key, email } = {}, headers = {}) {
  signedIn(email);
  return read(await statusRoute.POST(post(`/api/classroom/${lessonId}/status`, key ? { key } : {}, headers), params(lessonId)));
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
    expect((await stopRecording.POST(post("/api/admin/classrooms/L-x/stop-recording"), params("L-x"))).status).toBe(403);
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
    // The key is behind #, so the browser never sends it to a server, a log or another site.
    expect(lesson.link).toMatch(/^\/classroom\/L-[0-9a-f]{32}#k=[A-Za-z0-9_-]{43}$/);
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

  test("a vendor trial may record test consent only for TEST- codes, never for a real code and never in production", async () => {
    vi.stubEnv("CLASSROOM_PROVIDER", "zoom-video-sdk");
    try {
      expect(await setConsent("TEST-S7", "student")).toMatchObject({ status: 403, body: { code: "POLICY_PENDING" } });
      vi.stubEnv("CLASSROOM_TRIAL_CONSENT", "1");
      expect(await setConsent("TEST-S7", "student")).toMatchObject({ status: 200, body: { ok: true, synthetic: true } });
      expect(await setConsent("S-0007", "student")).toMatchObject({ status: 403, body: { code: "POLICY_PENDING" } });
      vi.stubEnv("VERCEL_ENV", "production");
      expect(await setConsent("TEST-S7", "student")).toMatchObject({ status: 403, body: { code: "POLICY_PENDING" } });
    } finally {
      vi.stubEnv("CLASSROOM_PROVIDER", "synthetic");
      vi.stubEnv("CLASSROOM_TRIAL_CONSENT", "");
      vi.stubEnv("VERCEL_ENV", "");
    }
  });

  test("the closed adult pilot (2026-11-10): in production, consent for TEST- codes only, only with CLASSROOM_PILOT_CONSENT=1 and both versions set to the pilot's; recorded as real, under that version", async () => {
    vi.stubEnv("CLASSROOM_PROVIDER", "zoom-video-sdk");
    vi.stubEnv("VERCEL_ENV", "production");
    const pilotEnv = { CLASSROOM_PILOT_CONSENT: "1", CLASSROOM_CONSENT_VERSION: "ihear-adult-pilot-consent-v1", CLASSROOM_STAFF_NOTICE_VERSION: "ihear-adult-pilot-consent-v1" };
    try {
      for (const name of Object.keys(pilotEnv)) {
        // Any one of the three missing or different: refused.
        for (const [other, value] of Object.entries(pilotEnv)) vi.stubEnv(other, other === name ? (value === "1" ? "yes" : "ihear-other-consent-v2") : value);
        expect(await setConsent("TEST-P1", "student")).toMatchObject({ status: 403, body: { code: "POLICY_PENDING" } });
      }
      for (const [name, value] of Object.entries(pilotEnv)) vi.stubEnv(name, value);
      // The vendor trial's switch alone still does nothing in production.
      vi.stubEnv("CLASSROOM_PILOT_CONSENT", "");
      vi.stubEnv("CLASSROOM_TRIAL_CONSENT", "1");
      expect(await setConsent("TEST-P1", "student")).toMatchObject({ status: 403, body: { code: "POLICY_PENDING" } });
      vi.stubEnv("CLASSROOM_PILOT_CONSENT", "1");
      expect(await setConsent("S-0009", "student")).toMatchObject({ status: 403, body: { code: "POLICY_PENDING" } });
      expect(await setConsent("TEST-P1", "student")).toMatchObject({ status: 200, body: { ok: true, synthetic: false, version: "ihear-adult-pilot-consent-v1" } });
      expect(await setConsent("TEST-PT1", "tutor")).toMatchObject({ status: 200, body: { ok: true, synthetic: false } });
      expect((await classroomStore().listConsents(["TEST-P1"]))[0]).toMatchObject({ personCode: "TEST-P1", status: "granted", version: "ihear-adult-pilot-consent-v1", synthetic: false });
      expect(await setConsent("TEST-P1", "student", "withdrawn")).toMatchObject({ status: 200 });
      expect((await classroomStore().listConsents(["TEST-P1"]))[0]).toMatchObject({ status: "withdrawn", version: "ihear-adult-pilot-consent-v1" });
    } finally {
      vi.stubEnv("CLASSROOM_PROVIDER", "synthetic");
      vi.stubEnv("VERCEL_ENV", "");
      for (const name of [...Object.keys(pilotEnv), "CLASSROOM_TRIAL_CONSENT"]) vi.stubEnv(name, "");
    }
  });

  test("both people can read the recording state with the same entry check; reading stores nothing and shows codes only", async () => {
    at("2026-11-20T05:00:00Z");
    const lesson = await createLesson({ code: "TEST-L11", time: "16:00", tutorCode: "TEST-T11", studentCode: "TEST-S11" });
    expect(await roomStatus(lesson.lessonId, { key: lesson.key })).toMatchObject({ status: 403, body: { code: "OUTSIDE_JOIN_WINDOW" } });
    at("2026-11-20T07:50:00Z");
    const before = JSON.stringify(await classroomStore().eventsFor([lesson.lessonId]));
    const student = await roomStatus(lesson.lessonId, { key: lesson.key });
    expect(student).toMatchObject({ status: 200, body: { ok: true, recordingDecided: false, recordingAllowed: false, recording: { status: "NOT_REQUESTED" } } });
    expect(student.headers.get("cache-control")).toContain("no-store");
    expect(await roomStatus(lesson.lessonId, { email: TUTOR })).toMatchObject({ status: 200, body: { ok: true, recording: { status: "NOT_REQUESTED" } } });
    expect(await roomStatus(lesson.lessonId, { key: "not-the-key" })).toMatchObject({ status: 403, body: { code: "NOT_ON_ROSTER" } });
    expect(await roomStatus(lesson.lessonId, {})).toMatchObject({ status: 403, body: { code: "NOT_ON_ROSTER" } });
    expect(await roomStatus(lesson.lessonId, { email: "someone@example.test" })).toMatchObject({ status: 403, body: { code: "NOT_ON_ROSTER" } });
    expect(await roomStatus("L-00000000000000000000000000000000", { key: lesson.key })).toMatchObject({ status: 404, body: { code: "LESSON_NOT_FOUND" } });
    expect((await roomStatus(lesson.lessonId, { key: lesson.key }, { origin: "https://evil.example" })).status).toBe(403);
    // Unlike entering, reading the state leaves no trace: no event, no token, no provider call.
    expect(JSON.stringify(await classroomStore().eventsFor([lesson.lessonId]))).toBe(before);
    expect(await classroomStore().listJoinTokens(lesson.lessonId)).toEqual([]);
    expect(await syntheticCalls(lesson.lessonId)).toEqual([]);
    for (const value of [TUTOR, lesson.key, "token"]) expect(JSON.stringify(student.body)).not.toContain(value);
    vi.stubEnv("CLASSROOM_PROVIDER", "");
    try {
      expect(await roomStatus(lesson.lessonId, { key: lesson.key })).toMatchObject({ status: 503, body: { code: "PROVIDER_UNAVAILABLE" } });
    } finally {
      vi.stubEnv("CLASSROOM_PROVIDER", "synthetic");
    }
  });

  test("only the lesson's signed-in tutor can report, and unknown reports are refused", async () => {
    at("2026-11-20T07:50:00Z");
    const lesson = await createLesson({ code: "TEST-L8", time: "16:00", tutorCode: "TEST-T8", studentCode: "TEST-S8" });
    expect(await hostReport(lesson.lessonId, { type: "heartbeat" }, null)).toMatchObject({ status: 401, body: { code: "SIGN_IN_REQUIRED" } });
    expect(await hostReport(lesson.lessonId, { type: "heartbeat" }, "someone@example.test")).toMatchObject({ status: 403, body: { code: "FORBIDDEN" } });
    expect((await hostReport(lesson.lessonId, { type: "something_else" })).status).toBe(400);
    // Before the door opens no page can be in the room, so a report is refused and stores nothing
    // (2026-11-08; "not decided yet" before the decision is checked through the status above).
    at("2026-11-20T05:00:00Z");
    const before = JSON.stringify(await classroomStore().eventsFor([lesson.lessonId]));
    expect(await hostReport(lesson.lessonId, { type: "heartbeat" })).toMatchObject({ status: 403, body: { code: "OUTSIDE_JOIN_WINDOW" } });
    expect(JSON.stringify(await classroomStore().eventsFor([lesson.lessonId]))).toBe(before);
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
    // A lesson of the site's own (W1, 2026-11-11: deliveries about any other lesson are not stored).
    await classroomStore().createLesson({
      id: lesson.lessonId, code: "TEST-WEBHOOK", date: "2026-11-20", startsAt: "2026-11-20T07:30:00.000Z", endsAt: "2026-11-20T08:30:00.000Z", cancelled: false,
      createdBy: "owner@example.test", createdAt: "2026-11-20T07:00:00.000Z",
      participants: [{ id: `${lesson.lessonId}-T`, code: "TEST-WEBHOOK-T", role: "tutor", staffEmail: "tutor-webhook@example.test", joinKeyHash: null }],
    });
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
    // The student is told too, from the same confirmed state.
    expect(await roomStatus(lesson.lessonId, { key: lesson.key })).toMatchObject({ status: 200, body: { recording: { status: "RECORDING", basis: "confirmed" } } });

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
    // Deleting Zoom's copy is off by default: Zoom is not asked, and the kept copy is recorded.
    expect(await syntheticCalls("SYN-FILE-V1")).toEqual([]);
    expect(await syntheticCalls("SYN-FILE-A1")).toEqual([]);
    const kept = (await classroomStore().eventsFor([lesson.lessonId])).filter(event => event.type === "p1.vendor_copy_kept");
    expect(kept.map(event => event.providerFileId)).toEqual(["SYN-FILE-V1"]);

    // Codes only: no e-mail address, personal link, token or planted personal data.
    const shown = JSON.stringify(view);
    for (const value of [TUTOR, lesson.key, createHash("sha256").update(lesson.key).digest("hex"), ...PLANTED]) expect(shown).not.toContain(value);
    const stored = await readFile(path.join(directory, "classroom.json"), "utf8");
    for (const value of PLANTED) expect(stored).not.toContain(value);
  });

  test("the scheduled tick files what no request got to, waits out a full Drive, and keeps the lesson in view until it is filed", async () => {
    // With deleting the vendor's copy switched on, it happens only after the copy is stored.
    vi.stubEnv("CLASSROOM_VENDOR_DELETION", "on");
    const SCHEDULED = "scheduled-tick-secret-test-only-0123456789";
    const scheduled = async authorization => read(await scheduledRoute.GET(new Request(`${ORIGIN}/api/classroom/scheduled-tick`, { headers: authorization ? { authorization } : {} })));
    vi.stubEnv("CRON_SECRET", "");
    expect((await scheduled(`Bearer ${SCHEDULED}`)).status).toBe(503);
    vi.stubEnv("CRON_SECRET", SCHEDULED);
    expect((await scheduled("Bearer not-the-secret")).status).toBe(401);
    expect((await scheduled()).status).toBe(401);

    at("2026-11-22T07:50:00Z");
    const lesson = { ...(await createLesson({ date: "2026-11-22", code: "TEST-L10", time: "16:00", tutorCode: "TEST-T10", studentCode: "TEST-S10" })), sessionId: "SYN-SESSION-10" };
    expect((await setConsent("TEST-S10", "student")).status).toBe(200);
    expect((await setConsent("TEST-T10", "tutor")).status).toBe(200);
    at("2026-11-22T07:56:00Z");
    await startLesson(lesson, ["UUID-T10", "UUID-S10"]);
    at("2026-11-22T07:56:10Z");
    await tick();

    // The Drive is full, and the work after the webhook's answer never ran (the function stopped).
    vi.stubEnv("CLASSROOM_DRIVE_LOCAL_QUOTA_BYTES", "100");
    at("2026-11-22T09:05:00Z");
    const video = { id: "SYN-FILE-V10", recording_type: "shared_screen_with_speaker_view", file_extension: "MP4", file_type: "MP4", file_size: 2048, status: "completed", recording_start: "2026-11-22T08:00:00Z", recording_end: "2026-11-22T09:00:00Z" };
    expect((await zoom("session.recording_completed", lesson, { recording_files: [video] })).status).toBe(200);
    afterResponse.length = 0;
    expect(await scheduled(`Bearer ${SCHEDULED}`)).toMatchObject({ status: 200, body: { ok: true } });
    let card = cardOf(await overview(), "TEST-L10");
    expect(card.filing).toMatchObject({ status: "BLOCKED", reasonLabel: "雲端硬碟空間不足" });
    expect(card.anomalies.map(entry => entry.code)).toContain("FILING_BLOCKED");
    expect(await syntheticCalls("SYN-FILE-V10")).toEqual([]);

    // Two days later the lesson is outside the overview's window, but it stays in view while blocked.
    at("2026-11-24T12:00:00Z");
    expect((await scheduled(`Bearer ${SCHEDULED}`)).status).toBe(200);
    expect(cardOf(await overview(), "TEST-L10")?.filing.status).toBe("BLOCKED");

    // Space is freed: the next scheduled tick files it, and Zoom's copy goes only after that.
    vi.stubEnv("CLASSROOM_DRIVE_LOCAL_QUOTA_BYTES", "");
    at("2026-11-24T12:31:00Z");
    expect(await scheduled(`Bearer ${SCHEDULED}`)).toMatchObject({ status: 200, body: { ok: true } });
    const drive = JSON.parse(await readFile(path.join(directory, "synthetic-drive", "index.json"), "utf8"));
    const filed = Object.values(drive.files).filter(entry => !entry.trashed && entry.appProperties.providerFileId === "SYN-FILE-V10");
    expect(filed).toMatchObject([{ name: "2026-11-22_TEST-S10_TEST-T10_P01.mp4", size: 2048 }]);
    expect(await syntheticCalls("SYN-FILE-V10")).toEqual(["recording.delete"]);
    // The anomaly record is closed by the tick that filed it, and the old lesson leaves the overview.
    const record = (await classroomStore().listAnomalies([lesson.lessonId])).find(entry => entry.code === "FILING_BLOCKED");
    expect(record).toMatchObject({ severity: "error", resolvedAt: Date.parse("2026-11-24T12:31:00Z") });
    expect(cardOf(await overview(), "TEST-L10")).toBeNull();
    vi.stubEnv("CLASSROOM_VENDOR_DELETION", "");
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

  test("consent entered before anyone is in the room counts; consent completed once the tutor is in counts from then on (G2, 2026-11-09, pending iHear's policy confirmation)", async () => {
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

    // TEST-L5: the tutor is already in when the consent is completed: the lesson is decided again
    // and may be recorded from then on (one rule for every lesson, moved or not); the start checks
    // once more just before Zoom is asked, and that check is what covers the recording.
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
    expect(await syntheticCalls(late.lessonId)).toEqual(["recording.start"]);
    const checks = (await classroomStore().eventsFor([late.lessonId])).filter(event => event.type === "server.recording_eligibility");
    const startCheck = checks.find(event => event.beforeStart === true);
    expect(startCheck).toMatchObject({ eligible: true });
    expect(startCheck.occurredAt).toBeGreaterThanOrEqual(Date.parse("2026-11-20T13:52:00Z"));
    view = await overview();
    expect(cardOf(view, "TEST-L5")).toMatchObject({ group: "LIVE", recording: { status: "START_REQUESTED" } });
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

// Phase 2 (2026-11-06): the student's personal link can be cancelled with the lesson, revoked and
// reissued, and a link that no longer counts gets no session token, whether entering, reconnecting
// (the same request) or reading the status. Every refusal leaves nothing issued.
describe("personal links: cancel, revoke and reissue", () => {
  test("another lesson's link or tutor sign-in gets nothing, and a role or person named in the request is ignored", async () => {
    at("2026-11-20T09:50:00Z");
    const a = await createLesson({ code: "TEST-K1", time: "18:00", tutorCode: "TEST-KT1", studentCode: "TEST-KS1" });
    const b = await createLesson({ code: "TEST-K2", time: "18:00", tutorCode: "TEST-KT2", studentCode: "TEST-KS2", tutorEmail: "other-tutor@example.test" });
    const refusals = [await join(b.lessonId, { key: a.key }), await join(b.lessonId, { email: TUTOR })];
    for (const refused of refusals) {
      expect(refused).toMatchObject({ status: 403, body: { code: "NOT_ON_ROSTER" } });
      expect(refused.body.session).toBeUndefined();
    }
    signedIn(null);
    const claimed = await read(await joinRoute.POST(post(`/api/classroom/${a.lessonId}/join`, { key: a.key, role: "tutor", participantCode: "TEST-KT1", email: TUTOR }), params(a.lessonId)));
    expect(claimed).toMatchObject({ status: 200, body: { role: "student", participantCode: "TEST-KS1" } });
    expect(claimsOf(claimed.body.session.token)).toMatchObject({ role_type: 0 });
  });

  test("cancelling: owners only, from this site, recorded once; then neither the link nor the tutor gets a token", async () => {
    at("2026-11-20T10:50:00Z");
    const lesson = await createLesson({ code: "TEST-K3", time: "19:00", tutorCode: "TEST-KT3", studentCode: "TEST-KS3" });
    expect((await join(lesson.lessonId, { key: lesson.key })).status).toBe(200);
    expect((await lessonAccess(lesson.lessonId, { action: "cancel" }, { email: null })).status).toBe(403);
    findAdminAccount.mockResolvedValue({ email: EDITOR, enabled: true });
    expect((await lessonAccess(lesson.lessonId, { action: "cancel" }, { email: EDITOR })).status).toBe(403);
    findAdminAccount.mockResolvedValue(null);
    expect((await lessonAccess(lesson.lessonId, { action: "cancel" }, { headers: { origin: "https://evil.example" } })).status).toBe(403);
    expect((await lessonAccess(lesson.lessonId, { action: "drop" })).status).toBe(400);
    expect((await lessonAccess("L-00000000000000000000000000000000", { action: "cancel" })).status).toBe(404);
    expect(appendAdminActivity).not.toHaveBeenCalledWith(expect.objectContaining({ action: "classroom.lesson_cancelled" }));
    expect(await join(lesson.lessonId, { key: lesson.key })).toMatchObject({ status: 200 });

    const cancelled = await lessonAccess(lesson.lessonId, { action: "cancel" });
    expect(cancelled).toMatchObject({ status: 200, body: { ok: true, cancelled: true, changed: true } });
    expect(appendAdminActivity).toHaveBeenCalledWith(expect.objectContaining({ action: "classroom.lesson_cancelled", entityType: "classroom", entityId: lesson.lessonId, actorEmail: OWNER }));
    for (const who of [{ key: lesson.key }, { email: TUTOR }]) {
      const refused = await join(lesson.lessonId, who);
      expect(refused).toMatchObject({ status: 403, body: { code: "LESSON_CANCELLED" } });
      expect(refused.body.session).toBeUndefined();
    }
    expect(await roomStatus(lesson.lessonId, { key: lesson.key })).toMatchObject({ status: 403, body: { code: "LESSON_CANCELLED" } });
    // A cancelled lesson gets no new link; cancelling again changes nothing and is not logged again.
    expect(await lessonAccess(lesson.lessonId, { action: "reissue_link" })).toMatchObject({ status: 409, body: { code: "LESSON_CANCELLED" } });
    appendAdminActivity.mockClear();
    expect(await lessonAccess(lesson.lessonId, { action: "cancel" })).toMatchObject({ status: 200, body: { cancelled: true, changed: false } });
    expect(appendAdminActivity).not.toHaveBeenCalled();
    expect((await overview()).lessons.find(item => item.lessonId === lesson.lessonId)).toMatchObject({ cancelled: true });
  });

  test("revoking the student's link: the old link gets no token at entry, on reconnect or for the status; the tutor is unaffected", async () => {
    at("2026-11-20T11:50:00Z");
    const lesson = await createLesson({ code: "TEST-K4", time: "20:00", tutorCode: "TEST-KT4", studentCode: "TEST-KS4" });
    expect((await join(lesson.lessonId, { key: lesson.key })).status).toBe(200);
    expect((await lessonAccess(lesson.lessonId, { action: "revoke_link", studentCode: "TEST-NONE" })).status).toBe(404);
    expect((await lessonAccess(lesson.lessonId, { action: "revoke_link", studentCode: "TEST-KT4" })).status).toBe(404);
    const revoked = await lessonAccess(lesson.lessonId, { action: "revoke_link", studentCode: "TEST-KS4" });
    expect(revoked).toMatchObject({ status: 200, body: { ok: true, revoked: true } });
    expect(revoked.body.studentLink).toBeUndefined();
    expect(appendAdminActivity).toHaveBeenCalledWith(expect.objectContaining({ action: "classroom.student_link_revoked", entityType: "classroom", entityId: lesson.lessonId }));
    // Entering again and reconnecting send the same request; the status uses the same check.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const again = await join(lesson.lessonId, { key: lesson.key });
      expect(again).toMatchObject({ status: 403, body: { code: "NOT_ON_ROSTER" } });
      expect(again.body.session).toBeUndefined();
    }
    expect(await roomStatus(lesson.lessonId, { key: lesson.key })).toMatchObject({ status: 403 });
    expect(await join(lesson.lessonId, { email: TUTOR })).toMatchObject({ status: 200, body: { role: "tutor" } });
    // The old key's hash is gone; neither the answer nor the activity entry names a key.
    const stored = await readFile(path.join(directory, "classroom.json"), "utf8");
    expect(stored).not.toContain(hashOf(lesson.key));
    expect(JSON.stringify([revoked.body, appendAdminActivity.mock.calls])).not.toMatch(/k=|[0-9a-f]{64}/);
  });

  test("reissuing: a new link behind #, shown in that answer only; the old link and any earlier reissue stop at once", async () => {
    at("2026-11-20T12:50:00Z");
    const lesson = await createLesson({ code: "TEST-K5", time: "21:00", tutorCode: "TEST-KT5", studentCode: "TEST-KS5" });
    const first = await lessonAccess(lesson.lessonId, { action: "reissue_link" });
    expect(first).toMatchObject({ status: 200, body: { ok: true } });
    expect(first.body.studentLink).toMatch(new RegExp(`^/classroom/${lesson.lessonId}#k=[A-Za-z0-9_-]{43}$`));
    const firstKey = keyOf(first.body.studentLink);
    expect(firstKey).not.toBe(lesson.key);
    expect(appendAdminActivity).toHaveBeenCalledWith(expect.objectContaining({ action: "classroom.student_link_reissued", entityType: "classroom", entityId: lesson.lessonId }));
    expect(JSON.stringify(appendAdminActivity.mock.calls)).not.toContain(firstKey);
    expect(await join(lesson.lessonId, { key: lesson.key })).toMatchObject({ status: 403, body: { code: "NOT_ON_ROSTER" } });
    expect(await join(lesson.lessonId, { key: firstKey })).toMatchObject({ status: 200, body: { role: "student", participantCode: "TEST-KS5" } });
    const second = await lessonAccess(lesson.lessonId, { action: "reissue_link", studentCode: "TEST-KS5" });
    const secondKey = keyOf(second.body.studentLink);
    expect((await join(lesson.lessonId, { key: firstKey })).status).toBe(403);
    expect((await join(lesson.lessonId, { key: secondKey })).status).toBe(200);
    const shown = JSON.stringify(await overview());
    const stored = await readFile(path.join(directory, "classroom.json"), "utf8");
    for (const key of [lesson.key, firstKey, secondKey]) {
      expect(shown).not.toContain(key);
      expect(stored).not.toContain(key);
    }
    expect(stored).toContain(hashOf(secondKey));
    expect(stored).not.toContain(hashOf(firstKey));
  });
});

// /classroom (2026-11-06): the entry page the home page will link to at the end of S3. A
// signed-in tutor sees their own lessons; students enter with their personal link and have no list.
describe("my lessons (/classroom)", () => {
  async function myLessons(email, extra = {}) {
    auth.mockResolvedValue(email ? { user: { email, ...extra } } : null);
    const route = await import("../app/api/classroom/my-lessons/route");
    return read(await route.GET(new Request(`${ORIGIN}/api/classroom/my-lessons`)));
  }

  test("signed out it asks for a sign-in, and while the classroom is closed it is closed for everyone; never cached", async () => {
    at("2026-11-21T01:00:00Z");
    const anonymous = await myLessons(null);
    expect(anonymous).toMatchObject({ status: 401, body: { code: "SIGN_IN_REQUIRED" } });
    expect(anonymous.body.lessons).toBeUndefined();
    expect(anonymous.headers.get("cache-control")).toBe("private, no-store, max-age=0");
    vi.stubEnv("CLASSROOM_PROVIDER", "");
    try {
      expect(await myLessons(TUTOR)).toMatchObject({ status: 503, body: { code: "PROVIDER_UNAVAILABLE" } });
    } finally {
      vi.stubEnv("CLASSROOM_PROVIDER", "synthetic");
    }
  });

  test("a tutor sees only their own lessons from a day ago to two weeks ahead, codes and times only; another account sees none", async () => {
    at("2026-11-21T01:00:00Z");
    await createLesson({ date: "2026-11-21", code: "TEST-M1", time: "10:00", tutorCode: "TEST-MT1", studentCode: "TEST-MS1" });
    await createLesson({ date: "2026-11-30", code: "TEST-M2", time: "10:00", tutorCode: "TEST-MT2", studentCode: "TEST-MS2" });
    await createLesson({ date: "2026-12-20", code: "TEST-M3", time: "10:00", tutorCode: "TEST-MT3", studentCode: "TEST-MS3" });
    await createLesson({ date: "2026-11-21", code: "TEST-M4", time: "10:00", tutorCode: "TEST-MT4", studentCode: "TEST-MS4", tutorEmail: "other-tutor@example.test" });
    // The sign-in email is matched however it is written.
    const result = await myLessons(TUTOR.toUpperCase());
    expect(result).toMatchObject({ status: 200, body: { ok: true, admin: false } });
    const codes = result.body.lessons.map(lesson => lesson.code);
    expect(codes).toEqual(expect.arrayContaining(["TEST-M1", "TEST-M2"]));
    for (const code of ["TEST-M3", "TEST-M4"]) expect(codes).not.toContain(code);
    // Nothing that could let anyone into a room: no token, topic, key, hash or email.
    for (const lesson of result.body.lessons) {
      expect(Object.keys(lesson).sort()).toEqual(["closesAt", "code", "endsAt", "lessonId", "opensAt", "participantCode", "startsAt", "state", "studentCodes"]);
    }
    expect(JSON.stringify(result.body)).not.toMatch(/token|sessionName|ihear-l-|joinKey|k=|[0-9a-f]{64}|@/i);
    const first = () => myLessons(TUTOR).then(answer => answer.body.lessons.find(lesson => lesson.code === "TEST-M1"));
    expect(await first()).toMatchObject({ state: "before", opensAt: "2026-11-21T01:45:00.000Z", participantCode: "TEST-MT1", studentCodes: ["TEST-MS1"] });
    at("2026-11-21T02:10:00Z");
    expect((await first()).state).toBe("open");
    at("2026-11-21T03:20:00Z");
    expect((await first()).state).toBe("ended");
    expect((await myLessons("someone@example.test")).body).toEqual({ ok: true, admin: false, lessons: [] });
    expect((await myLessons(OWNER, { isAdmin: true })).body).toMatchObject({ ok: true, admin: true, lessons: [] });
  });

  test("a cancelled lesson shows as cancelled", async () => {
    at("2026-11-21T04:00:00Z");
    const lesson = await createLesson({ date: "2026-11-22", code: "TEST-M5", time: "10:00", tutorCode: "TEST-MT5", studentCode: "TEST-MS5" });
    expect((await lessonAccess(lesson.lessonId, { action: "cancel" })).status).toBe(200);
    expect((await myLessons(TUTOR)).body.lessons.find(item => item.code === "TEST-M5")).toMatchObject({ state: "cancelled" });
  });
});

// The home page's classroom entry (D2, 2026-11-07): before it opens to everyone, the server alone
// decides who may preview it. A parameter in the address only asks; this answer is what counts.
describe("who may preview the classroom entry (/api/classroom/entry)", () => {
  async function entry(email, extra = {}) {
    auth.mockResolvedValue(email ? { user: { email, ...extra } } : null);
    const route = await import("../app/api/classroom/entry/route");
    return read(await route.GET(new Request(`${ORIGIN}/api/classroom/entry?classroom-preview=1`)));
  }

  test("the answer says only whether it is open and whether this person may preview it, and is never cached", async () => {
    at("2026-11-21T01:00:00Z");
    const anonymous = await entry(null);
    expect(anonymous).toMatchObject({ status: 200, body: { released: false, preview: false, signedIn: false } });
    expect(Object.keys(anonymous.body).sort()).toEqual(["preview", "released", "signedIn"]);
    expect(anonymous.headers.get("cache-control")).toBe("private, no-store, max-age=0");
    expect((await entry(OWNER, { isAdmin: true })).body).toEqual({ released: false, preview: true, signedIn: true });
    // Only the server's own administrator mark counts; anyone else signed in is not staff.
    expect((await entry("someone@example.test")).body).toEqual({ released: false, preview: false, signedIn: true });
    expect((await entry("someone@example.test", { isAdmin: "true" })).body).toEqual({ released: false, preview: false, signedIn: true });
  });

  test("a tutor of a lesson in the coming two weeks may preview; while the classroom is closed, only administrators", async () => {
    at("2026-11-21T01:00:00Z");
    await createLesson({ date: "2026-11-22", code: "TEST-E1", time: "10:00", tutorCode: "TEST-ET1", studentCode: "TEST-ES1", tutorEmail: "entry-tutor@example.test" });
    const tutor = await entry("Entry-Tutor@example.test");
    expect(tutor.body).toEqual({ released: false, preview: true, signedIn: true });
    expect(JSON.stringify(tutor.body)).not.toMatch(/@|TEST-|L-/);
    vi.stubEnv("CLASSROOM_PROVIDER", "");
    try {
      expect((await entry("entry-tutor@example.test")).body).toEqual({ released: false, preview: false, signedIn: true });
      expect((await entry(OWNER, { isAdmin: true })).body).toEqual({ released: false, preview: true, signedIn: true });
    } finally {
      vi.stubEnv("CLASSROOM_PROVIDER", "synthetic");
    }
  });

  test("it is rate limited like the other classroom reads", async () => {
    enforceRateLimit.mockResolvedValueOnce({ limited: true, response: new Response(JSON.stringify({ error: "Too many requests" }), { status: 429 }) });
    expect((await entry(OWNER, { isAdmin: true })).status).toBe(429);
    expect(enforceRateLimit).toHaveBeenCalledWith(expect.any(Request), expect.objectContaining({ scope: "classroom-entry" }));
  });
});

// P3-Auth (2026-11-08): every role against every classroom route, tampered links, the time
// window, the tutor's reports, one link on two devices, and what cancelling or revoking does and
// does not do. Synthetic identities (example.test) only; the synthetic provider stands in for Zoom.
describe("P3-Auth: roles, links and abuse", () => {
  const STRANGER = "someone@example.test";
  const OTHER_TUTOR = "other-tutor@example.test";
  const limited = () => ({ limited: true, response: new Response(JSON.stringify({ error: "Too many requests", code: "RATE_LIMITED" }), { status: 429 }) });
  const rawPost = (pathname, body, headers = {}) => new Request(`${ORIGIN}${pathname}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  const joinWith = async (lessonId, body) => { signedIn(null); return read(await joinRoute.POST(post(`/api/classroom/${lessonId}/join`, body), params(lessonId))); };
  const asEditorToo = () => findAdminAccount.mockImplementation(async email => (email === EDITOR ? { email: EDITOR, enabled: true } : null));

  test("every role against every classroom route: only the lesson's own people enter, only owners manage, and refusals issue nothing", async () => {
    at("2026-11-23T01:50:00Z");
    const lesson = await createLesson({ date: "2026-11-23", code: "TEST-A1", time: "10:00", tutorCode: "TEST-AT1", studentCode: "TEST-AS1" });
    const other = await createLesson({ date: "2026-11-23", code: "TEST-A2", time: "10:00", tutorCode: "TEST-AT2", studentCode: "TEST-AS2", tutorEmail: OTHER_TUTOR });
    asEditorToo();
    const manage = email => lessonAccess(lesson.lessonId, { action: "drop" }, { email });
    // Signed out, a stranger, an editor, an owner who is not the tutor, and the other lesson's
    // tutor and student: none of them enters, reads the room or reports for it.
    const outsiders = [
      { who: "signed out", email: null, host: 401, manage: 403 },
      { who: "stranger", email: STRANGER, host: 403, manage: 403 },
      { who: "editor", email: EDITOR, host: 403, manage: 403 },
      { who: "owner", email: OWNER, host: 403, manage: 400 },
      { who: "other tutor", email: OTHER_TUTOR, host: 403, manage: 403 },
      { who: "other student", key: other.key, email: null, host: 401, manage: 403 },
    ];
    for (const person of outsiders) {
      const entered = await join(lesson.lessonId, { key: person.key, email: person.email });
      expect(entered, person.who).toMatchObject({ status: 403, body: { code: "NOT_ON_ROSTER" } });
      expect(Object.keys(entered.body).sort(), person.who).toEqual(["code", "error"]);
      expect((await roomStatus(lesson.lessonId, { key: person.key, email: person.email })).status, person.who).toBe(403);
      expect((await hostReport(lesson.lessonId, { type: "heartbeat" }, person.email)).status, person.who).toBe(person.host);
      // Owners get past the permission check (400: the action is not one of theirs to name).
      expect((await manage(person.email)).status, person.who).toBe(person.manage);
    }
    expect(await classroomStore().listJoinTokens(lesson.lessonId)).toEqual([]);
    // The lesson's own tutor and student enter as themselves and nothing more.
    expect(await join(lesson.lessonId, { email: TUTOR })).toMatchObject({ status: 200, body: { role: "tutor", participantCode: "TEST-AT1" } });
    expect(await join(lesson.lessonId, { key: lesson.key })).toMatchObject({ status: 200, body: { role: "student", participantCode: "TEST-AS1" } });
    expect((await hostReport(lesson.lessonId, { type: "heartbeat" })).status).toBe(200);
    expect((await roomStatus(lesson.lessonId, { key: lesson.key })).status).toBe(200);
    // The student's key is no sign-in: it cannot report for the tutor.
    signedIn(null);
    expect((await read(await hostRoute.POST(post(`/api/classroom/${lesson.lessonId}/host-events`, { type: "heartbeat", key: lesson.key }), params(lesson.lessonId)))).status).toBe(401);
    // Neither manages the lesson.
    for (const email of [TUTOR, null]) expect((await manage(email)).status).toBe(403);
    expect((await classroomStore().listJoinTokens(lesson.lessonId)).length).toBe(2);
  });

  test("a tampered, shortened, lengthened, padded or wrongly typed key, or a changed lesson id, gets nothing and leaves no token", async () => {
    at("2026-11-23T02:50:00Z");
    const lesson = await createLesson({ date: "2026-11-23", code: "TEST-A3", time: "11:00", tutorCode: "TEST-AT3", studentCode: "TEST-AS3" });
    const flipped = `${lesson.key.slice(0, -1)}${lesson.key.endsWith("A") ? "B" : "A"}`;
    const keys = [flipped, lesson.key.slice(0, -1), `${lesson.key}x`, ` ${lesson.key}`, `${lesson.key}${"x".repeat(300)}`, lesson.key.toUpperCase(), hashOf(lesson.key), [lesson.key], { k: lesson.key }, 12345];
    for (const key of keys) {
      expect(await joinWith(lesson.lessonId, { key }), String(key).slice(0, 12)).toMatchObject({ status: 403, body: { code: "NOT_ON_ROSTER" } });
    }
    expect(await joinWith(lesson.lessonId.toUpperCase(), { key: lesson.key })).toMatchObject({ status: 404, body: { code: "LESSON_NOT_FOUND" } });
    expect(await joinWith(`${lesson.lessonId}0`, { key: lesson.key })).toMatchObject({ status: 404 });
    expect(await classroomStore().listJoinTokens(lesson.lessonId)).toEqual([]);
    expect(await joinWith(lesson.lessonId, { key: lesson.key })).toMatchObject({ status: 200 });
  });

  test("the door opens 15 minutes before and closes 15 minutes after; the last token handed out runs 30 minutes beyond", async () => {
    // 12:00–13:00 Taipei is 04:00–05:00Z: the door is open from 03:45:00Z to 05:15:00Z.
    at("2026-11-23T03:00:00Z");
    const lesson = await createLesson({ date: "2026-11-23", code: "TEST-A4", time: "12:00", tutorCode: "TEST-AT4", studentCode: "TEST-AS4" });
    at("2026-11-23T03:44:59Z");
    expect(await join(lesson.lessonId, { key: lesson.key })).toMatchObject({ status: 403, body: { code: "OUTSIDE_JOIN_WINDOW" } });
    at("2026-11-23T03:45:00Z");
    expect((await join(lesson.lessonId, { key: lesson.key })).status).toBe(200);
    at("2026-11-23T05:15:00Z");
    const last = await join(lesson.lessonId, { email: TUTOR });
    expect(last.status).toBe(200);
    const claims = claimsOf(last.body.session.token);
    expect(claims.exp - claims.iat).toBe(1800);
    expect(claims.exp * 1000).toBe(Date.parse("2026-11-23T05:45:00Z"));
    at("2026-11-23T05:15:01Z");
    for (const who of [{ key: lesson.key }, { email: TUTOR }]) expect(await join(lesson.lessonId, who)).toMatchObject({ status: 403, body: { code: "OUTSIDE_JOIN_WINDOW" } });
  });

  test("tutor reports: rate limited per account and lesson; refused signed out, cross-site, cancelled or outside their hours, and a refusal stores nothing and calls no provider", async () => {
    // 13:00–14:00 Taipei is 05:00–06:00Z: reports are taken from 04:45Z to 07:15Z.
    at("2026-11-23T04:50:00Z");
    const lesson = await createLesson({ date: "2026-11-23", code: "TEST-A5", time: "13:00", tutorCode: "TEST-AT5", studentCode: "TEST-AS5" });
    const cancelled = await createLesson({ date: "2026-11-23", code: "TEST-A6", time: "13:00", tutorCode: "TEST-AT6", studentCode: "TEST-AS6" });
    const snapshot = async lessonId => JSON.stringify([await classroomStore().eventsFor([lessonId]), await syntheticCalls(lessonId)]);
    expect((await hostReport(lesson.lessonId, { type: "heartbeat" })).status).toBe(200);
    expect(enforceRateLimit).toHaveBeenCalledWith(expect.any(Request), expect.objectContaining({ scope: "classroom-host", limit: 60, windowSeconds: 60, identifier: `${TUTOR}:${lesson.lessonId}` }));
    // Signed out: refused before the limit or the store is touched.
    enforceRateLimit.mockClear();
    expect((await hostReport(lesson.lessonId, { type: "heartbeat" }, null)).status).toBe(401);
    expect(enforceRateLimit).not.toHaveBeenCalled();
    signedIn(TUTOR);
    expect((await hostRoute.POST(post(`/api/classroom/${lesson.lessonId}/host-events`, { type: "heartbeat" }, { origin: "https://evil.example" }), params(lesson.lessonId))).status).toBe(403);
    // Over the limit: 429, nothing stored and no tick.
    let before = await snapshot(lesson.lessonId);
    enforceRateLimit.mockResolvedValueOnce(limited());
    expect(await hostReport(lesson.lessonId, { type: "connection", state: "Connected" })).toMatchObject({ status: 429, body: { code: "RATE_LIMITED" } });
    expect(await snapshot(lesson.lessonId)).toBe(before);
    // A cancelled lesson takes no report; a stranger is told only that they cannot report.
    expect((await hostReport(cancelled.lessonId, { type: "heartbeat" })).status).toBe(200);
    expect((await lessonAccess(cancelled.lessonId, { action: "cancel" })).status).toBe(200);
    before = await snapshot(cancelled.lessonId);
    expect(await hostReport(cancelled.lessonId, { type: "connection", state: "Connected" })).toMatchObject({ status: 403, body: { code: "LESSON_CANCELLED" } });
    expect(await hostReport(cancelled.lessonId, { type: "heartbeat" }, STRANGER)).toMatchObject({ status: 403, body: { code: "FORBIDDEN" } });
    expect(await snapshot(cancelled.lessonId)).toBe(before);
    // Up to an hour after the door closes (06:15Z) the page may still report; after that, not.
    at("2026-11-23T07:15:00Z");
    expect((await hostReport(lesson.lessonId, { type: "connection", state: "Closed" })).status).toBe(200);
    at("2026-11-23T07:15:01Z");
    before = await snapshot(lesson.lessonId);
    expect(await hostReport(lesson.lessonId, { type: "connection", state: "Closed" })).toMatchObject({ status: 403, body: { code: "OUTSIDE_JOIN_WINDOW" } });
    expect(await snapshot(lesson.lessonId)).toBe(before);
  });

  test("one personal link on two devices: both enter as the same person; after a revoke both are refused and told to leave, but the server disconnects no one", async () => {
    at("2026-11-23T06:50:00Z");
    const lesson = await createLesson({ date: "2026-11-23", code: "TEST-A7", time: "15:00", tutorCode: "TEST-AT7", studentCode: "TEST-AS7" });
    const phone = await join(lesson.lessonId, { key: lesson.key });
    at("2026-11-23T06:50:05Z");
    const laptop = await join(lesson.lessonId, { key: lesson.key });
    for (const device of [phone, laptop]) expect(device).toMatchObject({ status: 200, body: { role: "student", participantCode: "TEST-AS7" } });
    const [first, second] = [claimsOf(phone.body.session.token), claimsOf(laptop.body.session.token)];
    // The room sees one person twice: the same user_key, two different tokens, both recorded.
    expect(first.user_key).toBe(second.user_key);
    expect(phone.body.session.token).not.toBe(laptop.body.session.token);
    expect((await classroomStore().listJoinTokens(lesson.lessonId)).filter(token => token.participantId === first.user_key)).toHaveLength(2);
    expect((await lessonAccess(lesson.lessonId, { action: "revoke_link" })).status).toBe(200);
    for (let device = 0; device < 2; device += 1) {
      const answer = await roomStatus(lesson.lessonId, { key: lesson.key });
      expect(answer).toMatchObject({ status: 403, body: { code: "NOT_ON_ROSTER" } });
      expect(entryEndedBy({ status: answer.status, code: answer.body.code }, { role: "student", hasKey: true })).toBe("LINK_REVOKED");
    }
    // Nothing reaches the provider, and the tokens already handed out still run to their expiry.
    expect(await syntheticCalls(lesson.lessonId)).toEqual([]);
    expect(second.exp * 1000).toBeGreaterThan(Date.now());
  });

  test("cancelling with both people in the room: no provider call and no claim of a disconnection; both pages are told to leave at their next check", async () => {
    at("2026-11-23T07:50:00Z");
    const lesson = await createLesson({ date: "2026-11-23", code: "TEST-A8", time: "16:00", tutorCode: "TEST-AT8", studentCode: "TEST-AS8" });
    const student = await join(lesson.lessonId, { key: lesson.key });
    expect((await join(lesson.lessonId, { email: TUTOR })).status).toBe(200);
    expect((await hostReport(lesson.lessonId, { type: "heartbeat" })).status).toBe(200);
    const calls = await syntheticCalls(lesson.lessonId);
    const answer = await lessonAccess(lesson.lessonId, { action: "cancel" });
    expect(answer).toEqual(expect.objectContaining({ status: 200, body: { ok: true, cancelled: true, changed: true } }));
    expect(await syntheticCalls(lesson.lessonId)).toEqual(calls);
    const status = await roomStatus(lesson.lessonId, { key: lesson.key });
    expect(entryEndedBy({ status: status.status, code: status.body.code }, { role: "student", hasKey: true })).toBe("LESSON_CANCELLED");
    const report = await hostReport(lesson.lessonId, { type: "heartbeat" });
    expect(entryEndedBy({ status: report.status, code: report.body.code }, { role: "tutor", hasKey: false })).toBe("LESSON_CANCELLED");
    expect(claimsOf(student.body.session.token).exp * 1000).toBeGreaterThan(Date.now());
  });

  test("answers carry nothing secret: each person gets only their own token; no signing secret, e-mail, key or hash anywhere", async () => {
    at("2026-11-23T08:50:00Z");
    const lesson = await createLesson({ date: "2026-11-23", code: "TEST-A9", time: "17:00", tutorCode: "TEST-AT9", studentCode: "TEST-AS9" });
    const answers = {
      student: await join(lesson.lessonId, { key: lesson.key }),
      tutor: await join(lesson.lessonId, { email: TUTOR }),
      status: await roomStatus(lesson.lessonId, { key: lesson.key }),
      report: await hostReport(lesson.lessonId, { type: "heartbeat" }),
      refused: await join(lesson.lessonId, { key: "not-the-key" }),
    };
    for (const [name, answer] of Object.entries(answers)) {
      const text = JSON.stringify(answer.body);
      for (const secret of ["classroom-token-test-only", SECRET, lesson.key, hashOf(lesson.key), "@", "staffEmail", "joinKeyHash"]) expect(text, `${name}: ${secret}`).not.toContain(secret);
    }
    expect(Object.keys(claimsOf(answers.student.body.session.token)).sort()).toEqual(["app_key", "exp", "iat", "role_type", "session_key", "tpc", "user_key", "version"]);
    expect(Object.keys(claimsOf(answers.tutor.body.session.token)).sort()).toEqual(["app_key", "cloud_recording_option", "exp", "iat", "role_type", "session_key", "tpc", "user_key", "version"]);
    expect(claimsOf(answers.student.body.session.token).user_key).not.toBe(claimsOf(answers.tutor.body.session.token).user_key);
  });

  test("a request without an Origin header is not a way around anything: it still needs the sign-in or the personal key", async () => {
    at("2026-11-23T09:50:00Z");
    const created = await createLesson({ date: "2026-11-23", code: "TEST-A10", time: "18:00", tutorCode: "TEST-AT10", studentCode: "TEST-AS10" });
    const lesson = await classroomStore().lesson(created.lessonId);
    signedIn(null);
    expect((await joinRoute.POST(rawPost(`/api/classroom/${lesson.id}/join`, {}), params(lesson.id))).status).toBe(403);
    expect((await hostRoute.POST(rawPost(`/api/classroom/${lesson.id}/host-events`, { type: "heartbeat" }), params(lesson.id))).status).toBe(401);
    const route = await import("../app/api/admin/classrooms/[lessonId]/route");
    const patch = new Request(`${ORIGIN}/api/admin/classrooms/${lesson.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "cancel" }) });
    expect((await route.PATCH(patch, params(lesson.id))).status).toBe(403);
    expect((await classroomStore().lesson(lesson.id)).cancelled).toBe(false);
  });
});

// 2026-11-08: recording stops on its own when the lesson is over, and an owner can stop it at once.
describe("recording controls, synthetic end to end", () => {
  const press = async lessonId => read(await stopRecording.POST(post(`/api/admin/classrooms/${lessonId}/stop-recording`), params(lessonId)));

  test("emergency stop: owners only; stop at once on both channels, again at 30 s, end at 60 s; never recorded again, and what ran past it stays with the vendor", async () => {
    at("2026-11-28T07:50:00Z");
    const lesson = { ...(await createLesson({ date: "2026-11-28", code: "TEST-L40", time: "16:00", tutorCode: "TEST-T40", studentCode: "TEST-S40" })), sessionId: "SYN-SESSION-40" };
    await setConsent("TEST-S40", "student");
    await setConsent("TEST-T40", "tutor");
    at("2026-11-28T07:56:00Z");
    await startLesson(lesson, ["UUID-T40", "UUID-S40"]);
    for (const time of ["07:56:10", "07:56:20"]) {
      at(`2026-11-28T${time}Z`);
      await tick();
    }
    at("2026-11-28T07:56:30Z");
    await zoom("session.recording_started", lesson, { recording_file: { recording_start: new Date().toISOString() } });
    expect(await syntheticCalls(lesson.lessonId)).toEqual(["recording.start"]);

    at("2026-11-28T08:20:00Z");
    // Nobody but an owner can press it, and a refused press sends nothing.
    signedIn(EDITOR);
    findAdminAccount.mockResolvedValue({ email: EDITOR, enabled: true });
    expect((await press(lesson.lessonId)).status).toBe(403);
    expect(await syntheticCalls(lesson.lessonId)).toEqual(["recording.start"]);
    signedIn(OWNER);
    expect(await press(lesson.lessonId)).toMatchObject({ status: 200, body: { ok: true, alreadyStopped: false, stopRequested: true } });
    expect(await syntheticCalls(lesson.lessonId)).toEqual(["recording.start", "recording.stop"]);
    expect(appendAdminActivity).toHaveBeenCalledWith(expect.objectContaining({ action: "classroom.emergency_stop", entityId: lesson.lessonId, entityStatus: "stop-requested", actorEmail: OWNER }));
    // The tutor's page is told at once, so it stops on its side too.
    at("2026-11-28T08:20:05Z");
    expect(await hostReport(lesson.lessonId, { type: "heartbeat" })).toMatchObject({ status: 200, body: { recordingAllowed: false } });
    // Pressing again changes nothing.
    signedIn(OWNER);
    expect((await press(lesson.lessonId)).body).toMatchObject({ ok: true, alreadyStopped: true });
    expect(await syntheticCalls(lesson.lessonId)).toEqual(["recording.start", "recording.stop"]);
    // Asked, not confirmed: the overview never says stopped before the video service does.
    expect(cardOf(await overview(), "TEST-L40").emergency).toMatchObject({ stopState: "WAITING", stopLabel: "已送出停止請求，等待視訊服務確認（尚未確認停止）" });
    // Zoom has not confirmed: again at 30 s, and the session is ended at 60 s.
    at("2026-11-28T08:20:31Z");
    await tick();
    expect(await syntheticCalls(lesson.lessonId)).toEqual(["recording.start", "recording.stop", "recording.stop"]);
    at("2026-11-28T08:21:01Z");
    await tick();
    expect(await syntheticCalls(lesson.lessonId)).toEqual(["recording.start", "recording.stop", "recording.stop", "session.end"]);
    at("2026-11-28T08:21:10Z");
    await zoom("session.recording_stopped", lesson, { recording_file: { recording_end: "2026-11-28T08:21:05Z" } });
    let card = cardOf(await overview(), "TEST-L40");
    // The session.end request (60 s) alone was not taken as a stop; Zoom's own word is.
    expect(card.emergency).toEqual({ pressedAt: "2026-11-28T08:20:00.000Z", stopState: "CONFIRMED", stopLabel: "視訊服務已確認錄影停止", available: false });
    expect(card.anomalies.map(entry => entry.code)).toContain("EMERGENCY_STOP");
    expect(card.anomalies.map(entry => entry.code)).not.toContain("EMERGENCY_STOP_UNCONFIRMED");

    // Everyone comes back to a new session of the same lesson: it is never recorded again.
    const rejoined = { ...lesson, sessionId: "SYN-SESSION-40B" };
    at("2026-11-28T08:23:00Z");
    await zoom("session.started", rejoined, { start_time: new Date().toISOString() });
    await zoom("session.user_joined", rejoined, zoomUser(lesson.tutorId, "UUID-T40B", { join_time: new Date().toISOString() }));
    await zoom("session.user_joined", rejoined, zoomUser(lesson.studentId, "UUID-S40B", { join_time: new Date().toISOString() }));
    for (const time of ["08:23:10", "08:23:20", "08:24:30"]) {
      at(`2026-11-28T${time}Z`);
      await tick();
    }
    expect((await syntheticCalls(lesson.lessonId)).filter(type => type === "recording.start")).toHaveLength(1);

    // The recording ran past the press: it stays with the vendor, and not a byte goes to Drive.
    at("2026-11-28T09:05:00Z");
    const video = { id: "SYN-FILE-E40", recording_type: "shared_screen_with_speaker_view", file_extension: "MP4", file_type: "MP4", file_size: 1024, status: "completed", recording_start: "2026-11-28T07:56:30Z", recording_end: "2026-11-28T08:21:05Z" };
    afterResponse.length = 0;
    expect((await zoom("session.recording_completed", lesson, { recording_files: [video] })).status).toBe(200);
    await runAfterResponse();
    card = cardOf(await overview(), "TEST-L40");
    expect(card.filing.items).toMatchObject([{ status: "HOLD", label: "保留在視訊服務，不歸檔", name: null, driveFileId: null }]);
    const drive = JSON.parse(await readFile(path.join(directory, "synthetic-drive", "index.json"), "utf8"));
    expect(Object.values(drive.files).filter(entry => entry.appProperties.providerFileId === "SYN-FILE-E40")).toEqual([]);
  });

  test("class over: recording stops five minutes after the scheduled end, and is filed into the lesson's own folder, which the overview lists", async () => {
    at("2026-11-29T07:50:00Z");
    const lesson = { ...(await createLesson({ date: "2026-11-29", code: "TEST-L41", time: "16:00", tutorCode: "TEST-T41", studentCode: "TEST-S41" })), sessionId: "SYN-SESSION-41" };
    await setConsent("TEST-S41", "student");
    await setConsent("TEST-T41", "tutor");
    at("2026-11-29T07:56:00Z");
    await startLesson(lesson, ["UUID-T41", "UUID-S41"]);
    for (const time of ["07:56:10", "07:56:20"]) {
      at(`2026-11-29T${time}Z`);
      await tick();
    }
    at("2026-11-29T07:56:30Z");
    await zoom("session.recording_started", lesson, { recording_file: { recording_start: new Date().toISOString() } });

    // The lesson ends at 09:00; they are still talking. Nothing is stopped before 09:05.
    at("2026-11-29T09:04:59Z");
    await tick();
    expect(await syntheticCalls(lesson.lessonId)).toEqual(["recording.start"]);
    at("2026-11-29T09:05:00Z");
    await tick();
    expect(await syntheticCalls(lesson.lessonId)).toEqual(["recording.start", "recording.stop"]);
    expect(cardOf(await overview(), "TEST-L41").recording).toMatchObject({ status: "RECORDING", label: "錄影中（已送出停止請求）" });
    at("2026-11-29T09:05:30Z");
    await tick();
    expect(await syntheticCalls(lesson.lessonId)).toEqual(["recording.start", "recording.stop", "recording.stop"]);
    // Zoom confirms: the session is not ended for them.
    at("2026-11-29T09:05:40Z");
    await zoom("session.recording_stopped", lesson, { recording_file: { recording_end: "2026-11-29T09:05:35Z" } });
    at("2026-11-29T09:06:30Z");
    await tick();
    expect(await syntheticCalls(lesson.lessonId)).toEqual(["recording.start", "recording.stop", "recording.stop"]);
    await zoom("session.user_left", lesson, zoomUser(lesson.studentId, "UUID-S41", { leave_time: "2026-11-29T09:07:00Z", leave_reason: "left the session" }));
    await zoom("session.user_left", lesson, zoomUser(lesson.tutorId, "UUID-T41", { leave_time: "2026-11-29T09:07:05Z", leave_reason: "left the session" }));
    await zoom("session.ended", lesson, { end_time: "2026-11-29T09:07:10Z" });

    at("2026-11-29T09:20:00Z");
    const video = { id: "SYN-FILE-V41", recording_type: "shared_screen_with_speaker_view", file_extension: "MP4", file_type: "MP4", file_size: 2048, status: "completed", recording_start: "2026-11-29T07:56:30Z", recording_end: "2026-11-29T09:05:35Z" };
    afterResponse.length = 0;
    expect((await zoom("session.recording_completed", lesson, { recording_files: [video] })).status).toBe(200);
    await runAfterResponse();

    const card = cardOf(await overview(), "TEST-L41");
    expect(card).toMatchObject({ group: "ENDED", recording: { status: "COMPLETED" }, filing: { status: "STORED" } });
    expect(card.filing.items).toEqual([{
      // Which room the file was recorded in: none known here (the lesson never moved rooms).
      generation: null,
      extension: "mp4", recordingStart: "2026-11-29T07:56:30.000Z", recordingEnd: "2026-11-29T09:05:35.000Z",
      // Synthetic: the local stand-in, never shown as Google Drive.
      status: "STORED", destination: "local", label: "已存入本機模擬 Drive（合成測試，不是 Google Drive）", reason: null, reasonLabel: null, at: "2026-11-29T09:20:00.000Z",
      name: "2026-11-29_TEST-S41_TEST-T41_P01.mp4", folder: "[iHear] 11.2026.Zoom Recordings / 2026-11-29_TEST-L41", size: 2048, md5: null,
      driveFileId: expect.stringMatching(/^local-file-/),
      // The local stand-in has no page to open; Google Drive gets one.
      link: null,
    }]);
    // In the stand-in Drive: the month folder, then the lesson's folder, then the file, once.
    const drive = JSON.parse(await readFile(path.join(directory, "synthetic-drive", "index.json"), "utf8"));
    const filed = Object.values(drive.files).filter(entry => !entry.trashed && entry.appProperties.providerFileId === "SYN-FILE-V41");
    expect(filed).toHaveLength(1);
    const monthId = drive.folders["root/[iHear] 11.2026.Zoom Recordings"];
    expect(drive.folders[`${monthId}/2026-11-29_TEST-L41`]).toBe(filed[0].parentId);
  });
});

// P-1 (2026-10-31): without webhooks the server learns the vendor's session id from the tutor's
// page, and uses it only once the vendor has confirmed it is this lesson's session. The switch
// (CLASSROOM_SESSION_REPORTS=verify) is off by default, so nothing changes elsewhere.
describe("the vendor's session id without webhooks", () => {
  const eventsOf = async lessonId => classroomStore().eventsFor([lessonId]);

  test("switched off (the default): the page is not asked, and a session report is answered but not kept", async () => {
    at("2026-11-26T07:55:00Z");
    const lesson = await createLesson({ code: "TEST-L20", date: "2026-11-26", time: "16:00", tutorCode: "TEST-T20", studentCode: "TEST-S20" });
    const tutor = await join(lesson.lessonId, { email: TUTOR });
    expect(tutor.status).toBe(200);
    expect(tutor.body.sessionReports).toBeUndefined();
    const answer = await hostReport(lesson.lessonId, { type: "session", sessionId: `SYN-SESSION-${lesson.lessonId}` });
    expect(answer).toMatchObject({ status: 200, body: { ok: true } });
    expect((await eventsOf(lesson.lessonId)).filter(event => /session_|host\.session/.test(event.type))).toEqual([]);
    expect(knownSessions(await eventsOf(lesson.lessonId))).toEqual([]);
  });

  test("switched on: only the tutor's page is asked; an id is used once the vendor confirms it, and another lesson's is refused and raised", async () => {
    vi.stubEnv("CLASSROOM_SESSION_REPORTS", "verify");
    try {
      at("2026-11-27T07:55:00Z");
      const lesson = await createLesson({ code: "TEST-L21", date: "2026-11-27", time: "16:00", tutorCode: "TEST-T21", studentCode: "TEST-S21" });
      const student = await join(lesson.lessonId, { key: lesson.key });
      const tutor = await join(lesson.lessonId, { email: TUTOR });
      expect([student.body.sessionReports, tutor.body.sessionReports]).toEqual([undefined, true]);
      // A report is kept only as reported; the tick that follows asks the vendor and confirms it.
      const own = `SYN-SESSION-${lesson.lessonId}`;
      expect((await hostReport(lesson.lessonId, { type: "session", sessionId: own })).status).toBe(200);
      let events = await eventsOf(lesson.lessonId);
      const reported = events.find(event => event.type === "host.session");
      expect(reported).toMatchObject({ source: "host_sdk", reportedSessionId: own });
      expect("providerSessionId" in reported).toBe(false);
      expect(events.find(event => event.type === "server.session_verified")).toMatchObject({ source: "server", providerSessionId: own, reportedSessionId: own });
      // The stand-in names no session, so its name and room generation are unknown (G-5).
      expect(knownSessions(events)).toEqual([{ id: own, ended: false, recordingsKnown: false, name: null, generation: null }]);
      // Reported again: kept once, confirmed once.
      await hostReport(lesson.lessonId, { type: "session", sessionId: own });
      events = await eventsOf(lesson.lessonId);
      expect(events.filter(event => event.type === "host.session")).toHaveLength(1);
      expect(events.filter(event => event.type === "server.session_verified")).toHaveLength(1);
      // Another lesson's session: refused, never used, and on the overview at once.
      const other = "SYN-SESSION-L-SOMEONE-ELSE";
      await hostReport(lesson.lessonId, { type: "session", sessionId: other });
      events = await eventsOf(lesson.lessonId);
      expect(events.find(event => event.type === "server.session_rejected")).toMatchObject({ reportedSessionId: other, reason: "MISMATCH" });
      expect(knownSessions(events).map(session => session.id)).toEqual([own]);
      expect(cardOf(await overview(), "TEST-L21").anomalies).toEqual(expect.arrayContaining([expect.objectContaining({ code: "SESSION_REJECTED", severity: "error" })]));
      // Malformed ids are refused before anything is kept; only the lesson's tutor reports.
      expect((await hostReport(lesson.lessonId, { type: "session", sessionId: "not an id!" })).status).toBe(400);
      expect((await hostReport(lesson.lessonId, { type: "session", sessionId: own }, "someone@example.test")).status).toBe(403);
    } finally {
      vi.stubEnv("CLASSROOM_SESSION_REPORTS", "");
    }
  });

  test("polling a lesson that ran in two sessions files both sessions' videos, even after the vendor stops describing the session", async () => {
    at("2026-11-28T07:50:00Z");
    const lesson = await createLesson({ code: "TEST-L22", date: "2026-11-28", time: "16:00", tutorCode: "TEST-T22", studentCode: "TEST-S22" });
    expect((await setConsent("TEST-S22", "student")).status).toBe(200);
    expect((await setConsent("TEST-T22", "tutor")).status).toBe(200);
    at("2026-11-28T07:56:00Z");
    await tick();
    const iso = value => new Date(value).toISOString();
    const T = Date.parse("2026-11-28T08:00:00Z");
    const MIN = 60_000;
    const video = (id, from, to) => ({
      id, recording_type: "shared_screen_with_speaker_view", file_extension: "MP4", file_type: "MP4", file_size: 512, status: "completed",
      recording_start: iso(T + from * MIN), recording_end: iso(T + to * MIN), download_url: "https://example.invalid/synthetic",
    });
    // What the vendor's API gives: the current session is no longer described (details: null), its
    // video is done while its timeline is still processing, and an earlier session has its own video.
    const file = path.join(directory, "synthetic-zoom.json");
    const state = JSON.parse(await readFile(file, "utf8").catch(() => '{"calls":[]}'));
    state.snapshots = {
      ...state.snapshots,
      [lesson.lessonId]: {
        lessonId: lesson.lessonId, providerSessionId: "SYN-SESSION-B", details: null, users: [],
        recordings: [video("SYN-L22-B1", 31, 59), { id: "SYN-L22-B2", recording_type: "timeline", file_extension: "JSON", file_size: 10, status: "processing" }],
        sessions: [{ providerSessionId: "SYN-SESSION-A", recordings: [video("SYN-L22-A1", 1, 29)] }],
      },
    };
    await writeFile(file, `${JSON.stringify(state, null, 2)}\n`);
    at("2026-11-28T09:30:00Z");
    signedIn(OWNER);
    const result = await read(await reconcile.POST(post(`/api/admin/classrooms/${lesson.lessonId}/reconcile`), params(lesson.lessonId)));
    expect(result).toMatchObject({ status: 200, body: { ok: true, reconciled: true } });
    await tick();
    // Parts numbered in recording order: the earlier session's video is P01.
    const drive = JSON.parse(await readFile(path.join(directory, "synthetic-drive", "index.json"), "utf8"));
    const names = Object.values(drive.files).filter(entry => !entry.trashed && /^SYN-L22-/.test(entry.appProperties.providerFileId))
      .map(entry => [entry.appProperties.providerFileId, entry.name]).sort();
    expect(names).toEqual([["SYN-L22-A1", "2026-11-28_TEST-S22_TEST-T22_P01.mp4"], ["SYN-L22-B1", "2026-11-28_TEST-S22_TEST-T22_P02.mp4"]]);
    const events = await eventsOf(lesson.lessonId);
    expect(events.filter(event => event.type === "session.recording_completed").map(event => event.providerSessionId).sort()).toEqual(["SYN-SESSION-A", "SYN-SESSION-B"]);
    expect(events.some(event => event.type === "p1.part_order")).toBe(false);
    // The answer without session details is noted, and nothing is said about who was there.
    expect(events.some(event => event.type === "server.reconcile_partial")).toBe(true);
    expect(events.some(event => event.type === "api.snapshot")).toBe(false);
  });
});
