import { afterAll, describe, expect, test, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// P0 technical verification (2026-11-08): how the server learns, checks and keeps Zoom's session
// id, and what cancelling, stopping and ending do when webhooks are late, repeated or forged,
// the server stops half-way, or Zoom's API fails. It runs the real P1 code (Zoom adapter, webhook
// intake, lesson state, tick) against a fake Zoom behind the HTTP transport: no request leaves
// this machine, nothing here says how the real Zoom behaves, and every id is synthetic.
//
// test.fails marks a gap: the test states what the design requires, and fails today. When the
// gap is fixed the test passes and vitest asks for the marker to be removed.
const directory = await mkdtemp(path.join(os.tmpdir(), "ihear-p0-session-"));
vi.stubEnv("IHEAR_FORCE_FILE_STORE", "1");
vi.stubEnv("IHEAR_TEST_DATA_DIR", directory);
vi.stubEnv("CLASSROOM_DRIVE", "local");
vi.stubEnv("CLASSROOM_SESSION_REPORTS", "verify");
vi.stubEnv("VERCEL_ENV", "");
const { classroomStore } = await import("../lib/classroom-store");
const { classroomDrive } = await import("../lib/classroom-drive");
const { knownSessions } = await import("../lib/classroom-provider");
const { zoomVideoSdkProvider } = await import("../lib/classroom-vendors/zoom-video-sdk");
const { createClassroomLesson, recordHostReport, runClassroomTick, stopRecordingForCancelledLesson } = await import("../lib/classroom-service");
// @ts-ignore - shared classroom logic, plain JavaScript.
const { ingestWebhook, signZoomRequest, storeEvent } = await import("../tools/recording-pathway/classroom/webhook-ingest.mjs");
// @ts-ignore
const { deriveLesson } = await import("../tools/recording-pathway/classroom/lesson-state.mjs");
// @ts-ignore
const { roomNameOf } = await import("../tools/recording-pathway/classroom/eligibility.mjs");
// @ts-ignore
const { lessonCard } = await import("../tools/recording-pathway/classroom/live-dashboard.mjs");

afterAll(async () => {
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

const MIN = 60_000, SEC = 1000;
const SECRET = "p0-webhook-secret-test-only";
const TUTOR = "p0-tutor@example.test";
const CONFIG = { sdkKey: "p0-sdk-key", sdkSecret: "p0-sdk-secret-test-only", apiKey: "p0-api-key", apiSecret: "p0-api-secret-test-only", webhookSecret: SECRET, apiBase: "https://zoom.invalid/v2" };
const store = classroomStore();
const drive = classroomDrive();
const iso = ms => new Date(ms).toISOString();

// A stand-in for Zoom's REST API: sessions by id, their recording, and failures to inject.
function fakeZoom() {
  const sessions = new Map();
  const calls = [];
  const failures = [];
  const transport = async ({ method, url, body }) => {
    const address = new URL(url);
    const pathname = address.pathname.replace(/^\/v2/, "");
    const request = { method, path: pathname, body: body ? JSON.parse(body) : null };
    calls.push(request);
    const failure = failures.findIndex(entry => entry.method === method && pathname.endsWith(entry.suffix));
    if (failure >= 0) {
      const [entry] = failures.splice(failure, 1);
      if (entry.throws) throw new Error("no answer");
      return { status: entry.status, body: "" };
    }
    const match = pathname.match(/^\/videosdk\/sessions\/([^/]+)(\/[a-z]+)?$/);
    if (!match) return { status: 404, body: "" };
    const id = decodeURIComponent(match[1]);
    const session = sessions.get(id);
    const suffix = match[2] || "";
    if (method === "GET" && !suffix) {
      const type = address.searchParams.get("type") || "live";
      if (!session || (type === "live") !== session.live) return { status: 404, body: "" };
      return { status: 200, body: JSON.stringify({ id, session_key: session.key, session_name: session.name }) };
    }
    if (method === "GET" && suffix === "/users") return { status: 200, body: JSON.stringify({ users: [] }) };
    if (method === "GET" && suffix === "/recordings") return { status: 404, body: "" };
    if (!session || !session.live) return { status: 404, body: "" };
    if (method === "PATCH" && suffix === "/events") {
      if (request.body.method === "recording.start") session.recording = "Recording";
      if (request.body.method === "recording.stop") session.recording = "Stopped";
      return { status: 202, body: "" };
    }
    if (method === "PUT" && suffix === "/status") {
      session.live = false;
      return { status: 204, body: "" };
    }
    return { status: 404, body: "" };
  };
  const sent = (method, suffix, filter = () => true) => calls.filter(call => call.method === method && call.path.endsWith(suffix) && filter(call));
  return { sessions, calls, failures, transport, sent };
}

let lessons = 0;
async function setup() {
  lessons += 1;
  const { lesson } = await createClassroomLesson({
    store, actor: "p0-owner@example.test", now: Date.parse("2026-12-01T07:00:00Z"),
    input: { code: `TEST-P0-${lessons}`, date: "2026-12-01", time: "16:00", minutes: 60, tutorCode: `TEST-P0T${lessons}`, tutorEmail: TUTOR, studentCode: `TEST-P0S${lessons}` },
  });
  const start = Date.parse(lesson.startsAt);
  const zoom = fakeZoom();
  const provider = zoomVideoSdkProvider(CONFIG, { transport: zoom.transport, sessionsOf: async target => knownSessions(await store.eventsFor([target.id])) });
  await store.transaction(tx => storeEvent(tx, { source: "server", type: "server.recording_eligibility", lessonId: lesson.id, eligible: true, reason: "ALL_CONSENTED", count: 0, occurredAt: start - 15 * MIN, receivedAt: start - 15 * MIN, key: `decide:${lesson.id}` }));
  const [tutor, student] = lesson.participants;
  const ctx = { lesson, start, zoom, provider, tutor, student };
  ctx.deliver = (type, object, at, { secret = SECRET } = {}) => {
    const rawBody = JSON.stringify({ event: type, event_ts: at, payload: { account_id: "synthetic", object: { session_key: lesson.id, ...object } } });
    const timestamp = Math.floor(at / 1000);
    return ingestWebhook({ headers: { "x-zm-request-timestamp": String(timestamp), "x-zm-signature": signZoomRequest(secret, timestamp, rawBody) }, rawBody, secret: SECRET, now: at, store });
  };
  ctx.sessionStarts = async (id, at, { webhook = true } = {}) => {
    zoom.sessions.set(id, { key: lesson.id, name: roomNameOf(lesson.id), live: true, recording: null });
    if (webhook) expect((await ctx.deliver("session.started", { id, session_id: id, session_name: roomNameOf(lesson.id), start_time: iso(at) }, at)).status).toBe(200);
  };
  ctx.joined = async (id, who, uuid, at) => expect((await ctx.deliver("session.user_joined", { session_id: id, user: { user_key: who.id, participant_uuid: uuid, join_time: iso(at) } }, at)).status).toBe(200);
  ctx.tick = at => runClassroomTick({ store, provider, drive, now: at, lessonIds: [lesson.id] });
  ctx.cancel = async at => {
    await store.setLessonCancelled(lesson.id);
    return stopRecordingForCancelledLesson({ store, provider, drive, lessonId: lesson.id, now: at });
  };
  ctx.state = async at => deriveLesson({ ...(await store.lesson(lesson.id)), participants: lesson.participants.map(({ id, code, role }) => ({ id, code, role })) }, await store.eventsFor([lesson.id]), at);
  ctx.events = async type => (await store.eventsFor([lesson.id])).filter(event => event.type === type);
  return ctx;
}

// Both in, the server asks Zoom to record (its own start), and Zoom's webhook confirms it.
async function recordingInSession(ctx, id) {
  await ctx.sessionStarts(id, ctx.start - 3 * MIN);
  await ctx.joined(id, ctx.tutor, "u-t", ctx.start - 3 * MIN);
  await ctx.joined(id, ctx.student, "u-s", ctx.start);
  await ctx.tick(ctx.start + MIN);
  expect(ctx.zoom.sent("PATCH", "/events", call => call.body.method === "recording.start")).toHaveLength(1);
  expect((await ctx.deliver("session.recording_started", { session_id: id, recording_file: { recording_start: iso(ctx.start + MIN + 5 * SEC) } }, ctx.start + MIN + 5 * SEC)).status).toBe(200);
}

describe("P0: the session id from Zoom's webhook (main path)", () => {
  test("a signed session.started is the trusted source; cancel's stop goes to that session; three states are told apart", async () => {
    const ctx = await setup();
    await recordingInSession(ctx, "ZS-1");
    expect(knownSessions(await store.eventsFor([ctx.lesson.id])).map(session => session.id)).toEqual(["ZS-1"]);
    const at = ctx.start + 20 * MIN;
    const answer = await ctx.cancel(at);
    expect(ctx.zoom.sent("PATCH", "/events", call => call.body.method === "recording.stop").map(call => call.path)).toEqual(["/videosdk/sessions/ZS-1/events"]);
    // 1. Zoom accepted the stop (202): requested, not stopped.
    expect(answer.body).toMatchObject({ stopRequested: true, stopState: "WAITING" });
    let state = await ctx.state(at);
    expect([state.recording.status, state.recording.pending]).toEqual(["RECORDING", "STOP_REQUESTED"]);
    // 2. Zoom says the recording stopped (its webhook): stopped, waiting for the file.
    await ctx.deliver("session.recording_stopped", { session_id: "ZS-1", recording_file: { recording_end: iso(at + 4 * SEC) } }, at + 4 * SEC);
    state = await ctx.state(at + 5 * SEC);
    expect([state.recording.status, state.recording.basis, state.cancellation.stopState]).toEqual(["STOPPED", "confirmed", "CONFIRMED"]);
    expect(lessonCard(state, at + 5 * SEC).recording.label).toBe("已停止，等待錄影檔");
    // 3. Zoom says the MP4 is ready (recording_completed with a completed file): completed. What
    // becomes of it is the filing rule's: recorded past the cancellation, it stays at Zoom.
    await ctx.deliver("session.recording_completed", { session_id: "ZS-1", recording_files: [{ id: "ZF-1", recording_type: "shared_screen_with_speaker_view", file_extension: "MP4", file_size: 1000, status: "completed", recording_start: iso(ctx.start + MIN + 5 * SEC), recording_end: iso(at + 4 * SEC) }] }, at + 10 * MIN);
    state = await ctx.state(at + 11 * MIN);
    expect(state.recording.status).toBe("COMPLETED");
    expect(lessonCard(state, at + 11 * MIN).recording.label).toBe("錄影已完成");
    // The file record names its own session: file → session → lesson.
    const files = await store.transaction(tx => tx.fileRecordsForLesson(ctx.lesson.id));
    expect(files.map(file => [file.providerFileId, file.providerSessionId])).toEqual([["ZF-1", "ZS-1"]]);
  });

  test("repeated and out-of-order webhooks are stored once and give the same state", async () => {
    const a = await setup();
    await recordingInSession(a, "ZS-2");
    for (let copy = 0; copy < 3; copy += 1) expect((await a.deliver("session.started", { id: "ZS-2", session_id: "ZS-2", start_time: iso(a.start - 3 * MIN) }, a.start - 3 * MIN)).status).toBe(200);
    expect(await a.events("session.started")).toHaveLength(1);
    const stopAt = a.start + 30 * MIN;
    for (let copy = 0; copy < 2; copy += 1) await a.deliver("session.recording_stopped", { session_id: "ZS-2", recording_file: { recording_end: iso(stopAt) } }, stopAt);
    expect(await a.events("session.recording_stopped")).toHaveLength(1);
    // The same facts delivered in another order to another lesson give the same state.
    const b = await setup();
    b.zoom.sessions.set("ZS-2b", { key: b.lesson.id, name: roomNameOf(b.lesson.id), live: true, recording: null });
    await b.deliver("session.recording_stopped", { session_id: "ZS-2b", recording_file: { recording_end: iso(stopAt) } }, stopAt);
    await b.deliver("session.recording_started", { session_id: "ZS-2b", recording_file: { recording_start: iso(b.start + MIN + 5 * SEC) } }, b.start + MIN + 5 * SEC);
    await b.joined("ZS-2b", b.student, "u-s", b.start);
    await b.joined("ZS-2b", b.tutor, "u-t", b.start - 3 * MIN);
    await b.deliver("session.started", { id: "ZS-2b", session_id: "ZS-2b", start_time: iso(b.start - 3 * MIN) }, b.start - 3 * MIN);
    const pick = state => [state.phase.value, state.recording.status, state.recording.basis];
    expect(pick(await b.state(stopAt + MIN))).toEqual(pick(await a.state(stopAt + MIN)));
  });

  test("a webhook with a bad signature is refused and stored nowhere; a stop then has no session to go to", async () => {
    const ctx = await setup();
    ctx.zoom.sessions.set("ZS-FORGED", { key: ctx.lesson.id, name: roomNameOf(ctx.lesson.id), live: true, recording: "Recording" });
    const refused = await ctx.deliver("session.started", { id: "ZS-FORGED", session_id: "ZS-FORGED", start_time: iso(ctx.start) }, ctx.start, { secret: "someone-else" });
    expect(refused.status).toBe(401);
    expect(knownSessions(await store.eventsFor([ctx.lesson.id]))).toEqual([]);
    expect(await ctx.provider.stopRecording(ctx.lesson)).toEqual({ ok: false, httpStatus: 409 });
    expect(ctx.zoom.calls).toEqual([]);
  });

  test.fails("G-5: the stored session.started keeps Zoom's session name, so a generation (its tpc) can be told apart", async () => {
    const ctx = await setup();
    await ctx.sessionStarts("ZS-NAME", ctx.start);
    const [started] = await ctx.events("session.started");
    expect(started.sessionName).toBe(roomNameOf(ctx.lesson.id));
  });
});

describe("P0: the session id the tutor's page reports (backup path, checked with Zoom first)", () => {
  test("an id Zoom confirms as this lesson's becomes trusted; one Zoom knows as another lesson's is refused and never used", async () => {
    const ctx = await setup();
    // No webhook at all: Zoom knows the session, iHear does not yet.
    await ctx.sessionStarts("ZS-4", ctx.start, { webhook: false });
    ctx.zoom.sessions.set("ZS-OTHER", { key: "L-someone-elses-lesson", name: "ihear-l-other", live: true, recording: null });
    const report = (sessionId, at) => recordHostReport({ store, provider: ctx.provider, drive, lessonId: ctx.lesson.id, sessionEmail: TUTOR, report: { type: "session", sessionId, at: iso(at) }, now: at });
    expect((await report("ZS-OTHER", ctx.start + MIN)).status).toBe(200);
    expect((await report("ZS-4", ctx.start + 2 * MIN)).status).toBe(200);
    expect((await ctx.events("server.session_rejected")).map(event => [event.reportedSessionId, event.reason])).toEqual([["ZS-OTHER", "MISMATCH"]]);
    expect((await ctx.events("server.session_verified")).map(event => event.providerSessionId)).toEqual(["ZS-4"]);
    expect(knownSessions(await store.eventsFor([ctx.lesson.id])).map(session => session.id)).toEqual(["ZS-4"]);
    // Before it was verified nothing went to Zoom but the look-ups; afterwards a stop goes to ZS-4 only.
    expect(ctx.zoom.calls.filter(call => call.method !== "GET")).toEqual([]);
    expect(await ctx.provider.stopRecording(ctx.lesson)).toMatchObject({ ok: true, httpStatus: 202 });
    expect(ctx.zoom.sent("PATCH", "/events").map(call => call.path)).toEqual(["/videosdk/sessions/ZS-4/events"]);
  });

  test("Zoom unreachable while checking: the id stays untrusted and is asked again a minute later", async () => {
    const ctx = await setup();
    await ctx.sessionStarts("ZS-4b", ctx.start, { webhook: false });
    ctx.zoom.failures.push({ method: "GET", suffix: "/ZS-4b", status: 503 });
    await recordHostReport({ store, provider: ctx.provider, drive, lessonId: ctx.lesson.id, sessionEmail: TUTOR, report: { type: "session", sessionId: "ZS-4b", at: iso(ctx.start + MIN) }, now: ctx.start + MIN });
    expect(await ctx.events("server.session_unconfirmed")).toHaveLength(1);
    expect(knownSessions(await store.eventsFor([ctx.lesson.id]))).toEqual([]);
    await ctx.tick(ctx.start + 2 * MIN + SEC);
    expect((await ctx.events("server.session_verified")).map(event => event.providerSessionId)).toEqual(["ZS-4b"]);
  });
});

describe("P0: cancelling, stopping and ending under failure", () => {
  test("the server stopped between marking the lesson cancelled and storing it: the next tick stores it and stops in the right session", async () => {
    const ctx = await setup();
    await recordingInSession(ctx, "ZS-6");
    const found = ctx.start + 20 * MIN;
    await store.setLessonCancelled(ctx.lesson.id);
    await runClassroomTick({ store, provider: ctx.provider, drive, now: found });
    expect(await ctx.events("server.lesson_cancelled")).toHaveLength(1);
    expect(ctx.zoom.sent("PATCH", "/events", call => call.body.method === "recording.stop").map(call => call.path)).toEqual(["/videosdk/sessions/ZS-6/events"]);
  });

  test("the server stopped after Zoom took the stop but before storing it: the next tick sends it again (at least once) and keeps one record", async () => {
    const ctx = await setup();
    await recordingInSession(ctx, "ZS-7");
    let crash = true;
    const crashing = {
      ...store,
      transaction: fn => store.transaction(tx => fn({ ...tx, insertEvent: async event => {
        if (crash && event.type === "server.stop_requested") { crash = false; throw new Error("the function was stopped"); }
        return tx.insertEvent(event);
      } })),
    };
    const at = ctx.start + 20 * MIN;
    await store.setLessonCancelled(ctx.lesson.id);
    const answer = await stopRecordingForCancelledLesson({ store: crashing, provider: ctx.provider, drive, lessonId: ctx.lesson.id, now: at });
    expect(answer.body.ticked).toBe(false);
    await ctx.tick(at + 10 * SEC);
    expect(ctx.zoom.sent("PATCH", "/events", call => call.body.method === "recording.stop")).toHaveLength(2);
    expect((await ctx.events("server.stop_requested")).filter(event => event.attempt === 1)).toHaveLength(1);
  });

  test("Zoom's API fails (429, 500, no answer): the stop is retried at 30 s, the end is tried at 60 s, and the lesson is flagged", async () => {
    const ctx = await setup();
    await recordingInSession(ctx, "ZS-8");
    ctx.zoom.failures.push({ method: "PATCH", suffix: "/events", status: 429 }, { method: "PATCH", suffix: "/events", status: 500 }, { method: "PUT", suffix: "/status", throws: true });
    const at = ctx.start + 20 * MIN;
    await ctx.cancel(at);
    for (const later of [at + 30 * SEC, at + 60 * SEC, at + 2 * MIN + SEC]) await ctx.tick(later);
    expect((await ctx.events("server.stop_requested")).map(event => event.ok)).toEqual([false, false]);
    expect((await ctx.events("server.session_end_requested")).map(event => event.ok)).toEqual([false]);
    expect((await store.listAnomalies([ctx.lesson.id])).find(entry => entry.code === "LESSON_CANCELLED_STOP_UNCONFIRMED")).toMatchObject({ severity: "error" });
    // Zoom is still recording: the fake never received a stop it accepted.
    expect(ctx.zoom.sessions.get("ZS-8")).toMatchObject({ live: true, recording: "Recording" });
  });

  test.fails("G-2: after the end request failed, the server keeps trying (with a back-off) until Zoom confirms", async () => {
    const ctx = await setup();
    await recordingInSession(ctx, "ZS-8b");
    ctx.zoom.failures.push({ method: "PATCH", suffix: "/events", status: 500 }, { method: "PATCH", suffix: "/events", status: 500 }, { method: "PUT", suffix: "/status", status: 500 });
    const at = ctx.start + 20 * MIN;
    await ctx.cancel(at);
    for (const later of [at + 30 * SEC, at + 60 * SEC, at + 5 * MIN, at + 10 * MIN]) await ctx.tick(later);
    expect(ctx.zoom.sessions.get("ZS-8b").live).toBe(false);
  });

  test.fails("G-1: a stop asked for before Zoom's session id was known is sent once the id becomes known", async () => {
    const ctx = await setup();
    // Recording known only from the tutor's page (Zoom's automatic recording, say); no webhook yet.
    await ctx.sessionStarts("ZS-5", ctx.start, { webhook: false });
    ctx.zoom.sessions.get("ZS-5").recording = "Recording";
    await recordHostReport({ store, provider: ctx.provider, drive, lessonId: ctx.lesson.id, sessionEmail: TUTOR, report: { type: "recording_status", status: "Recording", at: iso(ctx.start + MIN) }, now: ctx.start + MIN });
    const at = ctx.start + 20 * MIN;
    await ctx.cancel(at);
    for (const later of [at + 30 * SEC, at + 60 * SEC]) await ctx.tick(later);
    expect((await ctx.events("server.stop_requested")).map(event => event.ok)).toEqual([false, false]);
    // Zoom's session.started arrives 90 seconds late.
    await ctx.deliver("session.started", { id: "ZS-5", session_id: "ZS-5", start_time: iso(ctx.start) }, at + 90 * SEC);
    for (const later of [at + 2 * MIN, at + 3 * MIN]) await ctx.tick(later);
    expect(ctx.zoom.sent("PATCH", "/events", call => call.body.method === "recording.stop" && call.path.includes("ZS-5")).length).toBeGreaterThan(0);
  });

  test.fails("G-3: with two live sessions (an old generation still open), cancel stops and ends every one of them", async () => {
    const ctx = await setup();
    await recordingInSession(ctx, "ZS-9A");
    // A newer session of the same lesson starts while the old one is still live.
    await ctx.sessionStarts("ZS-9B", ctx.start + 10 * MIN);
    const at = ctx.start + 20 * MIN;
    await ctx.cancel(at);
    for (const later of [at + 30 * SEC, at + 60 * SEC]) await ctx.tick(later);
    expect(ctx.zoom.sent("PATCH", "/events", call => call.body.method === "recording.stop").map(call => call.path)).toContain("/videosdk/sessions/ZS-9A/events");
    expect(ctx.zoom.sessions.get("ZS-9A").live).toBe(false);
    expect(ctx.zoom.sessions.get("ZS-9B").live).toBe(false);
  });

  test.fails("G-4 (D-2): cancelling ends the lesson's live Zoom session even when nothing is recording", async () => {
    const ctx = await setup();
    await ctx.sessionStarts("ZS-11", ctx.start - 3 * MIN);
    await ctx.joined("ZS-11", ctx.tutor, "u-t", ctx.start - 3 * MIN);
    await ctx.cancel(ctx.start + 5 * MIN);
    for (const later of [ctx.start + 6 * MIN, ctx.start + 7 * MIN]) await ctx.tick(later);
    expect(ctx.zoom.sent("PUT", "/status").map(call => call.path)).toEqual(["/videosdk/sessions/ZS-11/status"]);
  });
});
