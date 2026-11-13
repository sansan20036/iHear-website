import { afterAll, beforeEach, describe, expect, test, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

vi.mock("../auth.js", () => ({ auth: vi.fn() }));
vi.mock("../lib/admin-store", () => ({ findAdminAccount: vi.fn(), appendAdminActivity: vi.fn() }));
vi.mock("../lib/rate-limit", async original => ({ ...await original(), enforceRateLimit: vi.fn() }));

import { auth } from "../auth.js";
import { appendAdminActivity, findAdminAccount } from "../lib/admin-store";
import { enforceRateLimit } from "../lib/rate-limit";
import {
  browserReadiness, deviceProblemOf, doorAt, levelOf, nextLessonOf, previewViewOf, sameWallClock, waitParts, zonedTimes,
} from "../lib/classroom-lobby";
import { classroomPreview, lessonDoorOf } from "../lib/classroom-preview";

// The Classroom 2.0 lobby (2026-11-13): the pre-class screen's look at a lesson (POST
// /api/classroom/<id>/preview) and the rules the lobby pages follow. Synthetic data only: TEST-
// codes, example.test addresses, test-only secrets and the synthetic provider; nothing reaches Zoom.
const directory = await mkdtemp(path.join(os.tmpdir(), "ihear-classroom-lobby-"));
const OWNER = "owner@example.test";
const TUTOR = "tutor@example.test";
const STRANGER = "someone@example.test";
const ORIGIN = "http://localhost:3000";
vi.stubEnv("AUTH_OWNER_EMAILS", OWNER);
vi.stubEnv("IHEAR_FORCE_FILE_STORE", "1");
vi.stubEnv("IHEAR_TEST_DATA_DIR", directory);
vi.stubEnv("CLASSROOM_PROVIDER", "synthetic");
vi.stubEnv("CLASSROOM_DRIVE", "local");
vi.stubEnv("CLASSROOM_WEBHOOK_SECRET", "classroom-lobby-webhook-test-only");
vi.stubEnv("CLASSROOM_SYNTHETIC_SECRET", "classroom-lobby-token-test-only");
vi.stubEnv("VERCEL_ENV", "");
const { classroomStore } = await import("../lib/classroom-store");
const lessons = await import("../app/api/admin/classrooms/route");
const lessonRoute = await import("../app/api/admin/classrooms/[lessonId]/route");
const joinRoute = await import("../app/api/classroom/[lessonId]/join/route");
const previewRoute = await import("../app/api/classroom/[lessonId]/preview/route");

vi.useFakeTimers({ toFake: ["Date"] });
afterAll(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});
beforeEach(() => {
  vi.clearAllMocks();
  auth.mockResolvedValue(null);
  findAdminAccount.mockResolvedValue(null);
  appendAdminActivity.mockResolvedValue(undefined);
  enforceRateLimit.mockResolvedValue({ limited: false, result: { allowed: true, limit: 30, remaining: 29, retryAfter: 60, resetAt: "2026-11-20T00:01:00.000Z" } });
});

const at = iso => vi.setSystemTime(new Date(iso));
const signedIn = email => auth.mockResolvedValue(email ? { user: { email } } : null);
const params = lessonId => ({ params: Promise.resolve({ lessonId }) });
const post = (pathname, body = {}, headers = {}) => new Request(`${ORIGIN}${pathname}`, {
  method: "POST", headers: { origin: ORIGIN, "content-type": "application/json", ...headers }, body: JSON.stringify(body),
});
const read = async response => ({ status: response.status, body: await response.json(), headers: response.headers });
const keyOf = link => new URLSearchParams(new URL(link, ORIGIN).hash.slice(1)).get("k");

async function createLesson(fields) {
  signedIn(OWNER);
  const result = await read(await lessons.POST(post("/api/admin/classrooms", { date: "2026-11-20", minutes: 60, tutorEmail: TUTOR, ...fields })));
  expect(result.status).toBe(201);
  return { lessonId: result.body.lesson.lessonId, key: keyOf(result.body.studentLink) };
}
async function lessonAccess(lessonId, body) {
  signedIn(OWNER);
  const request = new Request(`${ORIGIN}/api/admin/classrooms/${lessonId}`, { method: "PATCH", headers: { origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify(body) });
  return read(await lessonRoute.PATCH(request, params(lessonId)));
}
async function preview(lessonId, { key, email } = {}, headers = {}) {
  signedIn(email);
  return read(await previewRoute.POST(post(`/api/classroom/${lessonId}/preview`, key ? { key } : {}, headers), params(lessonId)));
}
async function join(lessonId, { key, email } = {}) {
  signedIn(email);
  return read(await joinRoute.POST(post(`/api/classroom/${lessonId}/join`, key ? { key } : {}), params(lessonId)));
}

// A lesson at 14:00–15:00 Taipei on 2026-11-20 is 06:00–07:00 UTC; its door is open 05:45–07:15 UTC.
describe("the pre-class screen's look at a lesson (POST /api/classroom/<id>/preview)", () => {
  test("the student with the personal link learns the lesson, their role and the door, hours before it opens; entering is still refused then", async () => {
    at("2026-11-20T03:00:00Z");
    const lesson = await createLesson({ code: "TEST-LB1", time: "14:00", tutorCode: "TEST-LBT1", studentCode: "TEST-LBS1" });
    const answer = await preview(lesson.lessonId, { key: lesson.key });
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({
      ok: true,
      lesson: { code: "TEST-LB1", startsAt: "2026-11-20T06:00:00.000Z", endsAt: "2026-11-20T07:00:00.000Z", opensAt: "2026-11-20T05:45:00.000Z", closesAt: "2026-11-20T07:15:00.000Z" },
      state: "before", role: "student", participantCode: "TEST-LBS1",
      // Who else is in it, by the code the room shows on their tile.
      with: { role: "tutor", codes: ["TEST-LBT1"] },
    });
    expect(answer.headers.get("cache-control")).toContain("no-store");
    // Nothing that enters, signs or names anyone: no token, session, e-mail, key or hash.
    const text = JSON.stringify(answer.body);
    for (const value of [lesson.key, TUTOR, OWNER, "token", "session", "joinKeyHash", "staffEmail", "@"]) expect(text).not.toContain(value);
    // The door is still the entry check's: before the window it refuses, as before.
    expect(await join(lesson.lessonId, { key: lesson.key })).toMatchObject({ status: 403, body: { code: "OUTSIDE_JOIN_WINDOW" } });
  });

  test("the door follows the time: open from 15 minutes before until 15 minutes after, then ended", async () => {
    at("2026-11-20T03:00:00Z");
    const lesson = await createLesson({ code: "TEST-LB2", time: "14:00", tutorCode: "TEST-LBT2", studentCode: "TEST-LBS2" });
    for (const [time, state] of [["05:44:59", "before"], ["05:45:00", "open"], ["06:30:00", "open"], ["07:15:00", "open"], ["07:15:01", "ended"]]) {
      at(`2026-11-20T${time}Z`);
      expect((await preview(lesson.lessonId, { key: lesson.key })).body.state).toBe(state);
    }
  });

  test("the lesson's tutor signed in sees it as the tutor; nobody else learns anything, not even whether it exists beyond 'not on the roster'", async () => {
    at("2026-11-20T05:50:00Z");
    const lesson = await createLesson({ code: "TEST-LB3", time: "14:00", tutorCode: "TEST-LBT3", studentCode: "TEST-LBS3" });
    expect(await preview(lesson.lessonId, { email: TUTOR })).toMatchObject({ status: 200, body: { role: "tutor", participantCode: "TEST-LBT3", state: "open", with: { role: "student", codes: ["TEST-LBS3"] } } });
    for (const who of [{}, { email: STRANGER }, { email: OWNER }, { key: "A".repeat(43) }, { key: lesson.key.slice(0, 42) + (lesson.key.endsWith("A") ? "B" : "A") }]) {
      const refused = await preview(lesson.lessonId, who);
      expect(refused).toMatchObject({ status: 403, body: { code: "NOT_ON_ROSTER" } });
      expect(JSON.stringify(refused.body)).not.toContain("TEST-LB3");
      expect(refused.body.lesson).toBeUndefined();
    }
    expect(await preview("L-00000000000000000000000000000000", { key: lesson.key })).toMatchObject({ status: 404, body: { code: "LESSON_NOT_FOUND" } });
  });

  test("a cancelled lesson says so to the student, and to nobody else; a revoked link stops working at once, a reissued one starts", async () => {
    at("2026-11-20T05:50:00Z");
    const lesson = await createLesson({ code: "TEST-LB4", time: "14:00", tutorCode: "TEST-LBT4", studentCode: "TEST-LBS4" });
    const other = await createLesson({ code: "TEST-LB5", time: "16:00", tutorCode: "TEST-LBT5", studentCode: "TEST-LBS5" });
    expect((await lessonAccess(lesson.lessonId, { action: "cancel" })).status).toBe(200);
    expect(await preview(lesson.lessonId, { key: lesson.key })).toMatchObject({ status: 200, body: { state: "cancelled" } });
    expect(await preview(lesson.lessonId)).toMatchObject({ status: 403, body: { code: "NOT_ON_ROSTER" } });
    // Another lesson's key never opens this one.
    expect(await preview(lesson.lessonId, { key: other.key })).toMatchObject({ status: 403, body: { code: "NOT_ON_ROSTER" } });
    expect((await lessonAccess(other.lessonId, { action: "revoke_link" })).status).toBe(200);
    expect(await preview(other.lessonId, { key: other.key })).toMatchObject({ status: 403, body: { code: "NOT_ON_ROSTER" } });
    const reissued = await lessonAccess(other.lessonId, { action: "reissue_link" });
    expect(reissued.status).toBe(200);
    const newKey = keyOf(reissued.body.studentLink);
    expect(await preview(other.lessonId, { key: newKey })).toMatchObject({ status: 200, body: { role: "student", state: "before" } });
    expect(await preview(other.lessonId, { key: other.key })).toMatchObject({ status: 403 });
  });

  test("it only reads: no event, no token and no call to the video service, however often it is asked", async () => {
    at("2026-11-20T05:50:00Z");
    const lesson = await createLesson({ code: "TEST-LB6", time: "14:00", tutorCode: "TEST-LBT6", studentCode: "TEST-LBS6" });
    const store = classroomStore();
    const before = JSON.stringify({ lesson: await store.lesson(lesson.lessonId), events: await store.eventsFor([lesson.lessonId]) });
    for (let round = 0; round < 3; round++) {
      await preview(lesson.lessonId, { key: lesson.key });
      await preview(lesson.lessonId, { email: TUTOR });
      await preview(lesson.lessonId);
    }
    expect(JSON.stringify({ lesson: await store.lesson(lesson.lessonId), events: await store.eventsFor([lesson.lessonId]) })).toBe(before);
  });

  test("another site cannot ask, the allowance is the door's own (per address and lesson), and a closed classroom says only that", async () => {
    at("2026-11-20T05:50:00Z");
    const lesson = await createLesson({ code: "TEST-LB7", time: "14:00", tutorCode: "TEST-LBT7", studentCode: "TEST-LBS7" });
    expect(await preview(lesson.lessonId, { key: lesson.key }, { origin: "https://evil.example" })).toMatchObject({ status: 403 });
    await preview(lesson.lessonId, { key: lesson.key }, { "x-forwarded-for": "198.51.100.7" });
    expect(enforceRateLimit).toHaveBeenLastCalledWith(expect.any(Request), expect.objectContaining({ scope: "classroom-preview", limit: 30, windowSeconds: 60, identifier: expect.stringContaining(lesson.lessonId) }));
    enforceRateLimit.mockResolvedValueOnce({ limited: true, response: new Response(JSON.stringify({ error: "Too many requests" }), { status: 429 }) });
    expect((await preview(lesson.lessonId, { key: lesson.key })).status).toBe(429);
    vi.stubEnv("CLASSROOM_PROVIDER", "");
    try {
      expect(await preview(lesson.lessonId, { key: lesson.key })).toMatchObject({ status: 503, body: { code: "PROVIDER_UNAVAILABLE" } });
    } finally {
      vi.stubEnv("CLASSROOM_PROVIDER", "synthetic");
    }
  });

  test("a block's Lobby or room is entered through its block, not this screen", async () => {
    const lesson = { id: "L-block", code: "TEST-BLK", startsAt: "2026-11-20T06:00:00.000Z", endsAt: "2026-11-20T07:00:00.000Z", cancelled: false, blockId: "B-1", participants: [] };
    expect(await classroomPreview({ store: { lesson: async () => lesson }, lessonId: "L-block", key: "x".repeat(43), now: Date.parse("2026-11-20T06:00:00Z") }))
      .toEqual({ status: 409, body: { error: "This lesson is entered through its block", code: "BLOCK_LESSON" } });
    expect(lessonDoorOf(lesson, Date.parse("2026-11-20T05:44:00Z")).state).toBe("before");
    expect(lessonDoorOf({ ...lesson, cancelled: true }, Date.parse("2026-11-20T06:00:00Z")).state).toBe("cancelled");
  });
});

describe("the lobby's rules", () => {
  const times = { startsAt: "2026-11-20T06:00:00.000Z", endsAt: "2026-11-20T07:00:00.000Z", opensAt: "2026-11-20T05:45:00.000Z", closesAt: "2026-11-20T07:15:00.000Z" };
  const ms = iso => Date.parse(iso);

  test("the door on the page follows the clock: before, open (early, live, running over), ended; a cancelled or ended lesson never reopens", () => {
    expect(doorAt(times, "before", ms("2026-11-20T05:30:00Z"))).toMatchObject({ state: "before", stage: null, msToOpen: 15 * 60_000 });
    expect(doorAt(times, "before", ms("2026-11-20T05:45:00Z"))).toMatchObject({ state: "open", stage: "early" });
    expect(doorAt(times, "open", ms("2026-11-20T06:10:00Z"))).toMatchObject({ state: "open", stage: "live" });
    expect(doorAt(times, "open", ms("2026-11-20T07:05:00Z"))).toMatchObject({ state: "open", stage: "overtime" });
    expect(doorAt(times, "open", ms("2026-11-20T07:15:01Z"))).toMatchObject({ state: "ended" });
    expect(doorAt(times, "cancelled", ms("2026-11-20T06:10:00Z"))).toMatchObject({ state: "cancelled" });
    expect(doorAt(times, "ended", ms("2026-11-20T06:10:00Z"))).toMatchObject({ state: "ended" });
  });

  test("a wait is said in whole days, hours and minutes, rounded up", () => {
    expect(waitParts(1)).toEqual({ days: 0, hours: 0, minutes: 1, totalMinutes: 1 });
    expect(waitParts(60 * 60_000)).toEqual({ days: 0, hours: 1, minutes: 0, totalMinutes: 60 });
    expect(waitParts(61 * 60_000 + 1)).toEqual({ days: 0, hours: 1, minutes: 2, totalMinutes: 62 });
    expect(waitParts((2 * 1440 + 3 * 60 + 4) * 60_000)).toEqual({ days: 2, hours: 3, minutes: 4, totalMinutes: 2 * 1440 + 184 });
    expect(waitParts(-5)).toEqual({ days: 0, hours: 0, minutes: 0, totalMinutes: 0 });
  });

  test("the lesson's time is given in the visitor's zone and, when it reads differently, in Taipei's", () => {
    expect(zonedTimes("en-GB", "Asia/Taipei", times.startsAt, times.endsAt)).toMatchObject({ range: "14:00–15:00", zone: "GMT+8" });
    const newYork = zonedTimes("en-US", "America/New_York", times.startsAt, times.endsAt);
    expect(newYork.range).toBe("01:00–02:00");
    expect(newYork.zone).toBe("EST");
    expect(newYork.date).toContain("November 20");
    // Summer time in New York (EDT, UTC-4).
    expect(zonedTimes("en-US", "America/New_York", "2026-07-15T13:00:00Z", "2026-07-15T14:00:00Z")).toMatchObject({ range: "09:00–10:00", zone: "EDT" });
    expect(zonedTimes("zh-TW", "Asia/Taipei", times.startsAt, times.endsAt).date).toContain("11月20日");
    expect(sameWallClock("Asia/Taipei", times.startsAt, times.endsAt)).toBe(true);
    expect(sameWallClock("Asia/Shanghai", times.startsAt, times.endsAt)).toBe(true);
    expect(sameWallClock("America/New_York", times.startsAt, times.endsAt)).toBe(false);
  });

  test("a tutor's next lesson is the earliest open one, else the next to open; past and cancelled lessons never come next", () => {
    const lesson = (id, start, state) => {
      const startsAt = new Date(ms(start)).toISOString();
      return { lessonId: id, code: id, startsAt, endsAt: new Date(ms(start) + 3600_000).toISOString(), opensAt: new Date(ms(start) - 900_000).toISOString(), closesAt: new Date(ms(start) + 4500_000).toISOString(), state };
    };
    const now = ms("2026-11-20T06:10:00Z");
    const list = [lesson("later", "2026-11-21T06:00:00Z", "before"), lesson("past", "2026-11-19T06:00:00Z", "ended"), lesson("now", "2026-11-20T06:00:00Z", "open"), lesson("off", "2026-11-20T05:00:00Z", "cancelled")];
    expect(nextLessonOf(list, now)?.lessonId).toBe("now");
    expect(nextLessonOf(list.filter(item => item.lessonId !== "now"), now)?.lessonId).toBe("later");
    expect(nextLessonOf([lesson("past", "2026-11-19T06:00:00Z", "ended")], now)).toBeNull();
    // A lesson the server listed as "before" whose door has opened since is next, and open.
    expect(nextLessonOf([lesson("soon", "2026-11-20T06:20:00Z", "before")], now)?.lessonId).toBe("soon");
    expect(doorAt(lesson("soon", "2026-11-20T06:20:00Z", "before"), "before", now).state).toBe("open");
  });

  test("the pre-class screen reads the server's answer: only definite refusals change what it offers", () => {
    const good = { ok: true, lesson: { code: "TEST-1", ...times }, state: "open", role: "student", participantCode: "TEST-S1" };
    expect(previewViewOf(200, good, true)).toEqual({ kind: "ready", data: good });
    expect(previewViewOf(200, { ...good, role: "observer" }, true)).toEqual({ kind: "unknown" });
    expect(previewViewOf(200, { ...good, lesson: { code: "TEST-1" } }, true)).toEqual({ kind: "unknown" });
    expect(previewViewOf(200, { ...good, with: { role: "tutor", codes: ["TEST-T1"] } }, true).kind).toBe("ready");
    expect(previewViewOf(200, { ...good, with: "TEST-T1" }, true)).toEqual({ kind: "unknown" });
    expect(previewViewOf(403, { code: "NOT_ON_ROSTER" }, true)).toEqual({ kind: "refused", code: "NOT_ON_ROSTER_LINK" });
    expect(previewViewOf(403, { code: "NOT_ON_ROSTER" }, false)).toEqual({ kind: "refused", code: "NOT_ON_ROSTER" });
    expect(previewViewOf(404, { code: "LESSON_NOT_FOUND" }, true)).toEqual({ kind: "refused", code: "LESSON_NOT_FOUND" });
    expect(previewViewOf(503, { code: "PROVIDER_UNAVAILABLE" }, true)).toEqual({ kind: "refused", code: "PROVIDER_UNAVAILABLE" });
    expect(previewViewOf(409, { code: "BLOCK_LESSON" }, true)).toEqual({ kind: "unknown", quiet: true });
    for (const [status, body] of [[409, {}], [429, {}], [503, { error: "temporarily unavailable" }], [403, { error: "Cross-origin request blocked" }], [500, null]]) {
      expect(previewViewOf(status, body, true)).toEqual({ kind: "unknown" });
    }
  });

  test("a refused device check says why, and the browser check names what is missing", () => {
    const named = name => Object.assign(new Error(name), { name });
    expect(deviceProblemOf(named("NotAllowedError"))).toBe("denied");
    expect(deviceProblemOf(named("SecurityError"))).toBe("denied");
    expect(deviceProblemOf(named("NotFoundError"))).toBe("missing");
    expect(deviceProblemOf(named("OverconstrainedError"))).toBe("missing");
    expect(deviceProblemOf(named("NotReadableError"))).toBe("busy");
    expect(deviceProblemOf(named("AbortError"))).toBe("busy");
    expect(deviceProblemOf(new TypeError("no"))).toBe("unsupported");
    expect(deviceProblemOf("strange")).toBe("error");
    expect(browserReadiness({ isSecureContext: true, mediaDevices: {}, RTCPeerConnection: () => {}, WebAssembly: {} })).toEqual({ ready: true, missing: [] });
    expect(browserReadiness({ isSecureContext: false })).toEqual({ ready: false, missing: ["secure", "media", "webrtc", "wasm"] });
  });

  test("the microphone bar is still in silence and moves with sound", () => {
    expect(levelOf(new Uint8Array(512).fill(128))).toBe(0);
    expect(levelOf([])).toBe(0);
    const loud = Uint8Array.from({ length: 512 }, (_, index) => (index % 2 ? 200 : 56));
    expect(levelOf(loud)).toBe(1);
    const soft = Uint8Array.from({ length: 512 }, (_, index) => (index % 2 ? 136 : 120));
    expect(levelOf(soft)).toBeGreaterThan(0.1);
    expect(levelOf(soft)).toBeLessThan(1);
  });
});
