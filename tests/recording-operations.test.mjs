import { afterAll, describe, expect, test, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// G1 and G2 (2026-11-09) on the server's own tick, with the file store and a scripted stand-in for
// Zoom: a recording action (start, stop, end) is carried out by one executor at a time, under a
// claim stored before Zoom is asked; an answer that was lost, a crash or a lease that ran out is
// settled by asking Zoom's state first, never by sending a start again blindly; every start checks
// the lesson, the room, the owner's word and every consent just before Zoom is asked. Synthetic
// only: nothing here says how real Zoom behaves.
//
// Each test states its success condition in its title, and fails on any other outcome.
const directory = await mkdtemp(path.join(os.tmpdir(), "ihear-operations-"));
vi.stubEnv("IHEAR_FORCE_FILE_STORE", "1");
vi.stubEnv("IHEAR_TEST_DATA_DIR", directory);
vi.stubEnv("CLASSROOM_DRIVE", "local");
vi.stubEnv("VERCEL_ENV", "");
const { classroomStore } = await import("../lib/classroom-store");
const { classroomDrive } = await import("../lib/classroom-drive");
const { changeLessonAccess, createClassroomLesson, runClassroomTick, setSyntheticConsent } = await import("../lib/classroom-service");
// @ts-ignore - shared classroom logic, plain JavaScript.
const { storeEvent } = await import("../tools/recording-pathway/classroom/webhook-ingest.mjs");
// @ts-ignore
const { deriveLesson } = await import("../tools/recording-pathway/classroom/lesson-state.mjs");
// @ts-ignore
const { roomNameOf } = await import("../tools/recording-pathway/classroom/eligibility.mjs");
// @ts-ignore
const { OPERATION, operationKey } = await import("../tools/recording-pathway/classroom/operations.mjs");

afterAll(async () => {
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

const store = classroomStore();
const drive = classroomDrive();
const MIN = 60_000, SEC = 1000;
const TUTOR = "operations-tutor@example.test";
const pause = ms => new Promise(resolve => { setTimeout(resolve, ms); });

// A stand-in for Zoom whose answers each test scripts. `calls` lists what it was asked.
function zoom({ start, observe } = {}) {
  const calls = [];
  const provider = {
    name: "synthetic", webhookSecret: null,
    sessionToken: () => ({ token: "synthetic", issuedAt: 0, expiresAt: 1 }),
    startRecording: async (lesson, sessionId) => { calls.push(["start", sessionId]); return start ? start(sessionId) : (await pause(20), { ok: true, httpStatus: 202 }); },
    stopRecording: async (lesson, sessionId) => { calls.push(["stop", sessionId]); await pause(20); return { ok: true, httpStatus: 202 }; },
    endSession: async (lesson, sessionId) => { calls.push(["end", sessionId]); await pause(20); return { ok: true, httpStatus: 204 }; },
    removeUser: async () => ({ ok: false, httpStatus: 501 }),
    snapshot: async () => null,
    ...(observe ? { observe: async (lesson, sessionId) => { calls.push(["observe", sessionId]); return observe(sessionId); } } : {}),
    download: async () => Buffer.alloc(0),
    deleteRecording: async () => ({ ok: false, httpStatus: 501 }),
  };
  return { provider, calls, starts: () => calls.filter(([type]) => type === "start").length };
}

let lessons = 0;
// A lesson with consent and the tutor's notice, its Zoom session started, both people in it.
async function liveLesson() {
  lessons += 1;
  const code = `TEST-OP${lessons}`;
  const { lesson } = await createClassroomLesson({
    store, actor: "operations-owner@example.test", now: Date.parse("2026-12-01T07:00:00Z"),
    input: { code, date: "2026-12-01", time: "16:00", minutes: 60, tutorCode: `${code}-T`, tutorEmail: TUTOR, studentCode: `${code}-S` },
  });
  const consentAt = Date.parse("2026-12-01T07:00:00Z");
  await setSyntheticConsent({ store, personCode: `${code}-S`, role: "student", status: "granted", actor: "operations-owner@example.test", now: consentAt });
  await setSyntheticConsent({ store, personCode: `${code}-T`, role: "tutor", status: "granted", actor: "operations-owner@example.test", now: consentAt });
  const start = Date.parse(lesson.startsAt);
  const sessionId = `ZS-OP-${lessons}`;
  const [tutor, student] = lesson.participants;
  await fact(lesson, "session.started", start - MIN, { providerSessionId: sessionId, sessionName: roomNameOf(lesson.id, 0) });
  await fact(lesson, "session.user_joined", start - MIN, { providerSessionId: sessionId, participantId: tutor.id });
  await fact(lesson, "session.user_joined", start, { providerSessionId: sessionId, participantId: student.id });
  return { lesson, start, sessionId, code };
}
let facts = 0;
async function fact(lesson, type, at, fields) {
  facts += 1;
  await store.transaction(tx => storeEvent(tx, { source: "zoom_webhook", type, lessonId: lesson.id, occurredAt: at, receivedAt: at, key: `${type}:${at}:${facts}`, ...fields }));
}
const tick = (ctx, provider, now, workerId = "tick") => runClassroomTick({ store, provider, drive, now, lessonIds: [ctx.lesson.id], workerId });
const eventsOf = ctx => store.eventsFor([ctx.lesson.id]);
const stateOf = async (ctx, now) => {
  const stored = await store.lesson(ctx.lesson.id);
  return deriveLesson({ ...stored, participants: stored.participants.map(({ id, code, role }) => ({ id, code, role })) }, await eventsOf(ctx), now);
};
const operationOf = async (ctx, key) => (await eventsOf(ctx)).find(event => event.key === operationKey(key));

describe("G1: one executor per recording action", () => {
  test("three ticks at once (three instances, say): the fake Zoom gets exactly one start for the lesson's session; one start is stored; its operation is DONE", async () => {
    const ctx = await liveLesson();
    const fake = zoom();
    await tick(ctx, fake.provider, ctx.start + 10 * SEC);
    await Promise.all(["a", "b", "c"].map(worker => tick(ctx, fake.provider, ctx.start + 20 * SEC, worker)));
    expect(fake.calls.filter(([type]) => type === "start")).toEqual([["start", ctx.sessionId]]);
    const events = await eventsOf(ctx);
    expect(events.filter(event => event.type === "server.start_requested").map(event => event.key)).toEqual([`start:${ctx.lesson.id}:1`]);
    expect(await operationOf(ctx, `start:${ctx.lesson.id}:1`)).toMatchObject({ state: "DONE", attempts: 1, version: 1 });
    // And again, three at once later: nothing more is sent.
    await Promise.all(["a", "b", "c"].map(worker => tick(ctx, fake.provider, ctx.start + 40 * SEC, worker)));
    expect(fake.starts()).toBe(1);
  });

  test("Zoom took the start but its answer was lost (no answer): nothing is stored as asked, the overview shows the start requested with its outcome unknown and recording as possibly on; Zoom's own recording notice settles it, and the start is never sent again", async () => {
    const ctx = await liveLesson();
    const fake = zoom({ start: async () => ({ ok: false, httpStatus: 0 }), observe: async () => ({ live: true, recording: null }) });
    await tick(ctx, fake.provider, ctx.start + 10 * SEC);
    await tick(ctx, fake.provider, ctx.start + 20 * SEC);
    expect(fake.starts()).toBe(1);
    expect((await eventsOf(ctx)).filter(event => event.type === "server.start_requested")).toEqual([]);
    expect(await operationOf(ctx, `start:${ctx.lesson.id}:1`)).toMatchObject({ state: "UNCERTAIN" });
    let state = await stateOf(ctx, ctx.start + 21 * SEC);
    expect(state.recording).toMatchObject({ status: "START_REQUESTED", outcome: "UNCERTAIN" });
    expect(state.sessions.find(entry => entry.id === ctx.sessionId).capture).toBe("RECORDING");
    // Zoom's notice that it records arrives; the next tick asks before anything else and settles it.
    await fact(ctx.lesson, "session.recording_started", ctx.start + 25 * SEC, { providerSessionId: ctx.sessionId, status: "Recording" });
    await tick(ctx, fake.provider, ctx.start + 30 * SEC);
    for (const at of [40, 70, 130]) await tick(ctx, fake.provider, ctx.start + at * SEC);
    expect(fake.starts()).toBe(1);
    expect(await operationOf(ctx, `start:${ctx.lesson.id}:1`)).toMatchObject({ state: "DONE", outcome: { confirmedBy: "zoom" } });
    state = await stateOf(ctx, ctx.start + 131 * SEC);
    expect(state.recording.status).toBe("RECORDING");
  });

  test("an answer that was lost and a Zoom state that cannot be told: UNKNOWN, flagged as an error, never sent again on later ticks; asked again after a minute; once Zoom's notice comes the flag goes", async () => {
    const ctx = await liveLesson();
    const fake = zoom({ start: async () => ({ ok: false, httpStatus: 504 }), observe: async () => ({ live: true, recording: null }) });
    await tick(ctx, fake.provider, ctx.start + 10 * SEC);
    await tick(ctx, fake.provider, ctx.start + 20 * SEC);
    await tick(ctx, fake.provider, ctx.start + 30 * SEC);
    expect(await operationOf(ctx, `start:${ctx.lesson.id}:1`)).toMatchObject({ state: "UNKNOWN" });
    let state = await stateOf(ctx, ctx.start + 31 * SEC);
    expect(state.anomalies.find(entry => entry.code === "RECORDING_ACTION_UNKNOWN")).toMatchObject({ severity: "error" });
    expect(state.recording).toMatchObject({ status: "START_REQUESTED", outcome: "UNKNOWN" });
    const observed = fake.calls.filter(([type]) => type === "observe").length;
    for (const at of [40, 50, 60]) await tick(ctx, fake.provider, ctx.start + at * SEC);
    expect(fake.calls.filter(([type]) => type === "observe").length).toBe(observed);
    await tick(ctx, fake.provider, ctx.start + 30 * SEC + OPERATION.unknownRetryMs + SEC);
    expect(fake.calls.filter(([type]) => type === "observe").length).toBe(observed + 1);
    expect(fake.starts()).toBe(1);
    await fact(ctx.lesson, "session.recording_started", ctx.start + 3 * MIN, { providerSessionId: ctx.sessionId, status: "Recording" });
    await tick(ctx, fake.provider, ctx.start + 3 * MIN + OPERATION.unknownRetryMs);
    state = await stateOf(ctx, ctx.start + 5 * MIN);
    expect(state.anomalies.map(entry => entry.code)).not.toContain("RECORDING_ACTION_UNKNOWN");
    expect(fake.starts()).toBe(1);
  });

  test("an answer that was lost, and Zoom's state shows the start did not happen: NOT_EXECUTED, and the start is sent exactly once more", async () => {
    const ctx = await liveLesson();
    let answers = 0;
    const fake = zoom({ start: async () => (answers++ === 0 ? { ok: false, httpStatus: 0 } : { ok: true, httpStatus: 202 }), observe: async () => ({ live: true, recording: false }) });
    await tick(ctx, fake.provider, ctx.start + 10 * SEC);
    await tick(ctx, fake.provider, ctx.start + 20 * SEC);
    await tick(ctx, fake.provider, ctx.start + 30 * SEC);
    await tick(ctx, fake.provider, ctx.start + 40 * SEC);
    await tick(ctx, fake.provider, ctx.start + 50 * SEC);
    expect(fake.starts()).toBe(2);
    expect(await operationOf(ctx, `start:${ctx.lesson.id}:1`)).toMatchObject({ state: "DONE" });
    expect((await eventsOf(ctx)).filter(event => event.type === "server.start_requested")).toHaveLength(1);
  });

  test("the executor stopped right after claiming the start, before asking Zoom: while its lease holds no other tick sends it; after the lease a tick asks Zoom's state first (not done), and the tick after sends it once", async () => {
    const ctx = await liveLesson();
    const fake = zoom({ observe: async () => ({ live: true, recording: false }) });
    await tick(ctx, fake.provider, ctx.start + 10 * SEC);
    const crashing = { ...store, claimOperation: async input => { const claim = await store.claimOperation(input); throw Object.assign(new Error("the function was stopped"), { claim }); } };
    await expect(runClassroomTick({ store: crashing, provider: fake.provider, drive, now: ctx.start + 20 * SEC, lessonIds: [ctx.lesson.id], workerId: "crashing" })).rejects.toThrow("stopped");
    expect(await operationOf(ctx, `start:${ctx.lesson.id}:1`)).toMatchObject({ state: "IN_FLIGHT", owner: "crashing" });
    await tick(ctx, fake.provider, ctx.start + 30 * SEC);
    await tick(ctx, fake.provider, ctx.start + 60 * SEC);
    expect(fake.starts()).toBe(0);
    const after = ctx.start + 20 * SEC + OPERATION.leaseMs + SEC;
    await tick(ctx, fake.provider, after);
    expect(fake.calls.map(([type]) => type)).toEqual(["observe"]);
    expect(await operationOf(ctx, `start:${ctx.lesson.id}:1`)).toMatchObject({ state: "NOT_EXECUTED", previous: "IN_FLIGHT" });
    await tick(ctx, fake.provider, after + 10 * SEC);
    await tick(ctx, fake.provider, after + 20 * SEC);
    expect(fake.calls.map(([type]) => type)).toEqual(["observe", "start"]);
    expect(await operationOf(ctx, `start:${ctx.lesson.id}:1`)).toMatchObject({ state: "DONE", attempts: 3, previous: "NOT_EXECUTED" });
  });

  test("a slow Zoom: the lease runs out while the first executor still waits; the second asks Zoom's state (cannot tell) and sends nothing; the first, answered at last, is fenced out of the operation but its answer is kept once as a fact; one start in all", async () => {
    const ctx = await liveLesson();
    let release;
    const slow = zoom({ start: () => new Promise(resolve => { release = () => resolve({ ok: true, httpStatus: 202 }); }), observe: async () => ({ live: true, recording: null }) });
    await tick(ctx, slow.provider, ctx.start + 10 * SEC);
    const first = runClassroomTick({ store, provider: slow.provider, drive, now: ctx.start + 20 * SEC, lessonIds: [ctx.lesson.id], workerId: "first" });
    while (!release) await pause(5);
    await tick(ctx, slow.provider, ctx.start + 20 * SEC + OPERATION.leaseMs + SEC, "second");
    expect(await operationOf(ctx, `start:${ctx.lesson.id}:1`)).toMatchObject({ state: "UNKNOWN", version: 2 });
    release();
    await first;
    expect(slow.starts()).toBe(1);
    const events = await eventsOf(ctx);
    expect(events.filter(event => event.type === "server.start_response").map(event => event.ok)).toEqual([true]);
    expect(await operationOf(ctx, `start:${ctx.lesson.id}:1`)).toMatchObject({ state: "UNKNOWN", version: 2 });
    // The start is known from Zoom's answer now: no longer unresolved, not flagged.
    const state = await stateOf(ctx, ctx.start + 3 * MIN);
    expect(state.anomalies.map(entry => entry.code)).not.toContain("RECORDING_ACTION_UNKNOWN");
  });

  test("a stop whose executor stopped after Zoom took it: once its lease ran out, Zoom's state is asked first and, as it shows the recording stopped, that stop is not sent again (only the protective round's own next stop goes out)", async () => {
    const ctx = await liveLesson();
    const fake = zoom({ observe: async () => ({ live: true, recording: false }) });
    await tick(ctx, fake.provider, ctx.start + 10 * SEC);
    await tick(ctx, fake.provider, ctx.start + 20 * SEC);
    await fact(ctx.lesson, "session.recording_started", ctx.start + 25 * SEC, { providerSessionId: ctx.sessionId, status: "Recording" });
    const at = ctx.start + MIN;
    await setSyntheticConsent({ store, personCode: `${ctx.code}-S`, role: "student", status: "withdrawn", actor: "operations-owner@example.test", now: at });
    // The executor stops after Zoom took the first stop, before its result is stored.
    const crashing = { ...store, finishOperation: async input => { if (input.events?.some(event => event.type === "server.stop_requested")) throw new Error("the function was stopped"); return store.finishOperation(input); } };
    await expect(runClassroomTick({ store: crashing, provider: fake.provider, drive, now: at + SEC, lessonIds: [ctx.lesson.id], workerId: "crashing" })).rejects.toThrow("stopped");
    const firstStop = (await eventsOf(ctx)).find(event => event.type === "server.operation" && event.action === "STOP_RECORDING");
    expect(firstStop).toMatchObject({ state: "IN_FLIGHT", owner: "crashing" });
    expect(fake.calls.filter(([type]) => type === "stop")).toHaveLength(1);
    await tick(ctx, fake.provider, at + SEC + OPERATION.leaseMs + SEC);
    expect(await operationOf(ctx, firstStop.operation)).toMatchObject({ state: "DONE", outcome: { confirmedBy: "zoom" } });
    // One more stop only: the protective round's second (its own key), never the first again.
    expect(fake.calls.filter(([type]) => type === "stop")).toHaveLength(2);
    expect((await eventsOf(ctx)).filter(event => event.type === "server.stop_requested").map(event => event.attempt).sort()).toEqual([1, 2]);
  });

  test("stop and end are claimed too: a cancellation's stop and end, with three ticks at once, reach Zoom once each", async () => {
    const ctx = await liveLesson();
    const fake = zoom();
    await tick(ctx, fake.provider, ctx.start + 10 * SEC);
    await tick(ctx, fake.provider, ctx.start + 20 * SEC);
    await fact(ctx.lesson, "session.recording_started", ctx.start + 25 * SEC, { providerSessionId: ctx.sessionId, status: "Recording" });
    await store.setLessonCancelled(ctx.lesson.id);
    const at = ctx.start + 5 * MIN;
    await Promise.all(["a", "b", "c"].map(worker => tick(ctx, fake.provider, at, worker)));
    expect(fake.calls.filter(([type]) => type === "stop")).toEqual([["stop", ctx.sessionId]]);
    await fact(ctx.lesson, "session.recording_stopped", at + 5 * SEC, { providerSessionId: ctx.sessionId, status: "Stopped" });
    await Promise.all(["a", "b", "c"].map(worker => tick(ctx, fake.provider, at + 10 * SEC, worker)));
    expect(fake.calls.filter(([type]) => type === "end")).toEqual([["end", ctx.sessionId]]);
  });

  test("after a start whose answer was lost, a withdrawal: recording counts as possibly on, so the protective stop goes to that session at once", async () => {
    const ctx = await liveLesson();
    const fake = zoom({ start: async () => ({ ok: false, httpStatus: 0 }), observe: async () => ({ live: true, recording: null }) });
    await tick(ctx, fake.provider, ctx.start + 10 * SEC);
    await tick(ctx, fake.provider, ctx.start + 20 * SEC);
    await setSyntheticConsent({ store, personCode: `${ctx.code}-S`, role: "student", status: "withdrawn", actor: "operations-owner@example.test", now: ctx.start + 30 * SEC });
    await tick(ctx, fake.provider, ctx.start + 31 * SEC);
    expect(fake.calls.filter(([type]) => type === "stop")).toEqual([["stop", ctx.sessionId]]);
    expect(fake.starts()).toBe(1);
  });
});

describe("G2: every start checks again just before Zoom is asked", () => {
  for (const [name, change, reason] of [
    ["the student's consent expired", async ctx => { const [consent] = await store.listConsents([`${ctx.code}-S`]); await store.setConsent({ ...consent, expiresAt: ctx.start }); }, "CONSENT_EXPIRED"],
    ["the student's consent was withdrawn", async ctx => setSyntheticConsent({ store, personCode: `${ctx.code}-S`, role: "student", status: "withdrawn", actor: "operations-owner@example.test", now: ctx.start + 15 * SEC }), "CONSENT_WITHDRAWN"],
    ["the link was revoked (the room moved)", async ctx => changeLessonAccess({ store, lessonId: ctx.lesson.id, action: "revoke_link", now: ctx.start + 15 * SEC }), "ROOM_CHANGED"],
    ["the lesson was cancelled", async ctx => store.setLessonCancelled(ctx.lesson.id), "LESSON_CANCELLED"],
  ]) {
    test(`${name} between the plan and the start: the start is refused at its own check (${reason}), Zoom is never asked, and the operation is NOT_EXECUTED`, async () => {
      const ctx = await liveLesson();
      const fake = zoom();
      await tick(ctx, fake.provider, ctx.start + 10 * SEC);
      // The change lands right after the start was claimed, before its check.
      let changed = false;
      const racing = { ...store, claimOperation: async input => { const claim = await store.claimOperation(input); if (!changed && input.action === "START_RECORDING") { changed = true; await change(ctx); } return claim; } };
      await runClassroomTick({ store: racing, provider: fake.provider, drive, now: ctx.start + 20 * SEC, lessonIds: [ctx.lesson.id], workerId: "racing" });
      expect(changed).toBe(true);
      expect(fake.starts()).toBe(0);
      expect(await operationOf(ctx, `start:${ctx.lesson.id}:1`)).toMatchObject({ state: "NOT_EXECUTED", outcome: { refused: reason } });
    });
  }

  test("the session ended between the plan and the start, and the lesson went on in a new session: the start is refused at its check (SESSION_ENDED), and a later tick sends it once, to the new session", async () => {
    const ctx = await liveLesson();
    const fake = zoom();
    await tick(ctx, fake.provider, ctx.start + 10 * SEC);
    const [tutor, student] = ctx.lesson.participants;
    const next = `${ctx.sessionId}-B`;
    let changed = false;
    const racing = { ...store, claimOperation: async input => {
      const claim = await store.claimOperation(input);
      if (!changed && input.action === "START_RECORDING") {
        changed = true;
        await fact(ctx.lesson, "session.ended", ctx.start + 15 * SEC, { providerSessionId: ctx.sessionId });
        await fact(ctx.lesson, "session.started", ctx.start + 16 * SEC, { providerSessionId: next, sessionName: roomNameOf(ctx.lesson.id, 0) });
        await fact(ctx.lesson, "session.user_joined", ctx.start + 17 * SEC, { providerSessionId: next, participantId: tutor.id });
        await fact(ctx.lesson, "session.user_joined", ctx.start + 17 * SEC, { providerSessionId: next, participantId: student.id });
      }
      return claim;
    } };
    await runClassroomTick({ store: racing, provider: fake.provider, drive, now: ctx.start + 20 * SEC, lessonIds: [ctx.lesson.id], workerId: "racing" });
    expect(changed).toBe(true);
    expect(fake.starts()).toBe(0);
    expect(await operationOf(ctx, `start:${ctx.lesson.id}:1`)).toMatchObject({ state: "NOT_EXECUTED", outcome: { refused: "SESSION_ENDED" } });
    for (const at of [30, 40, 50]) await tick(ctx, fake.provider, ctx.start + at * SEC);
    expect(fake.calls.filter(([type]) => type === "start")).toEqual([["start", next]]);
    expect(await operationOf(ctx, `start:${ctx.lesson.id}:1`)).toMatchObject({ state: "DONE", params: { targets: [next] } });
  });

  test("the check a start makes is stored as a decision covering the recording: its time is before the start, and it carries the room it was for", async () => {
    const ctx = await liveLesson();
    const fake = zoom();
    await tick(ctx, fake.provider, ctx.start + 10 * SEC);
    await tick(ctx, fake.provider, ctx.start + 20 * SEC);
    const events = await eventsOf(ctx);
    const check = events.find(event => event.type === "server.recording_eligibility" && event.beforeStart === true);
    const asked = events.find(event => event.type === "server.start_requested");
    expect(check).toMatchObject({ eligible: true, key: `start:${ctx.lesson.id}:1:check:1` });
    expect(check.generation).toBeUndefined();
    expect(check.occurredAt).toBeLessThanOrEqual(asked.occurredAt);
  });
});
