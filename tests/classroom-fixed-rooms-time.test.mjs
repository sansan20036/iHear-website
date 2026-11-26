import { afterAll, beforeEach, describe, expect, test, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// The user's decisions of 2026-11-24 (items 5 and 6): one-to-one and group rooms with a capacity of
// their own, a lesson of at most 120 minutes unless the owner extends it (30 minutes at a time, to at
// most 180), a note on the page near the end, and the server ending a lesson whose time is over.
// The file store and a scripted stand-in for Zoom, as in classroom-fixed-rooms.test.mjs. Synthetic only.
const directory = await mkdtemp(path.join(os.tmpdir(), "ihear-fixed-rooms-time-"));
vi.stubEnv("IHEAR_FORCE_FILE_STORE", "1");
vi.stubEnv("IHEAR_TEST_DATA_DIR", directory);
vi.stubEnv("CLASSROOM_DRIVE", "local");
vi.stubEnv("VERCEL_ENV", "");
const { classroomStore } = await import("../lib/classroom-store");
const { classroomDrive } = await import("../lib/classroom-drive");
const { classroomStatus, joinClassroom, runClassroomTick } = await import("../lib/classroom-service");
const { entryEndedBy, reasonShown } = await import("../lib/classroom-join-client");
const rooms = await import("../lib/classroom-fixed-rooms");
// @ts-ignore
const { buildSessionTokenClaims, signSessionToken } = await import("../tools/recording-pathway/classroom/eligibility.mjs");

afterAll(async () => {
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});
beforeEach(() => { vi.stubEnv("CLASSROOM_FIXED_ROOMS", "on"); });

const store = classroomStore();
const drive = classroomDrive();
const MIN = 60_000;
const START = Date.parse("2026-12-11T15:00:00Z");
const OWNER = { email: "rooms-owner@example.test", owner: true };
const NOT_OWNER = { email: "tutor@example.test", owner: false };
const keyOf = link => new URLSearchParams(link.split("#")[1]).get("k");
const provider = {
  name: "synthetic", webhookSecret: null,
  sessionToken: ({ lesson, participant, now, generation = 0 }) => {
    const claims = buildSessionTokenClaims({ lesson, participant, appKey: "synthetic-app", now, generation });
    return { token: signSessionToken(claims, "fixed-rooms-time-test-secret-not-real"), issuedAt: now, expiresAt: now + 30 * MIN };
  },
  startRecording: async () => ({ ok: true, httpStatus: 202 }), stopRecording: async () => ({ ok: true, httpStatus: 202 }),
  endSession: async () => ({ ok: true, httpStatus: 204 }),
  removeUser: async () => ({ ok: false, httpStatus: 501 }), snapshot: async () => null, observe: async () => ({ live: false, recording: null }),
  download: async () => Buffer.alloc(0), deleteRecording: async () => ({ ok: false, httpStatus: 501 }),
};
const manage = (action, input = {}, { now = START, principal = OWNER } = {}) => rooms.manageFixedRoom({ store, provider, drive, principal, action, input, now });
let made = 0;
async function room() {
  made += 1;
  const created = await manage("create", { label: `Time Room ${made}` });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  return { id: created.body.room.id, key: keyOf(created.body.link) };
}
const ask = (r, name, now = START) => rooms.requestEntry({ store, roomId: r.id, key: r.key, name, now });
const status = (r, asked, now = START) => rooms.requestStatus({ store, roomId: r.id, requestId: asked.body.requestId, ticket: asked.body.ticket, now });
const view = async (r, now = START) => (await rooms.fixedRoomsView({ store, now })).find(entry => entry.id === r.id);
const join = (lessonId, ticket, now = START) => joinClassroom({ store, provider, lessonId, key: ticket, now });
const admitOne = async (r, name, now = START) => {
  const asked = await ask(r, name, now);
  const answer = await manage("admit", { room: r.id, request: asked.body.requestId }, { now });
  return { asked, answer };
};
const iso = ms => new Date(ms).toISOString();

describe("a room's settings", () => {
  test("ST-1: a room starts as a group of up to 10 with 120-minute lessons; only an owner changes that, within 2–10 people and 30–180 minutes; a form changed alone takes its own capacity", async () => {
    const r = await room();
    expect(await view(r)).toMatchObject({ form: "group", capacity: 10, minutes: 120 });
    expect((await manage("set_settings", { room: r.id, form: "one_to_one" }, { principal: NOT_OWNER })).body.code).toBe("OWNER_REQUIRED");
    const bad = [[{ form: "class" }, "INVALID_FORM"], [{ capacity: 1 }, "INVALID_CAPACITY"], [{ capacity: 11 }, "INVALID_CAPACITY"], [{ capacity: 2.5 }, "INVALID_CAPACITY"], [{ capacity: "4" }, "INVALID_CAPACITY"], [{ minutes: 29 }, "INVALID_MINUTES"], [{ minutes: 181 }, "INVALID_MINUTES"], [{ minutes: "90" }, "INVALID_MINUTES"]];
    for (const [input, code] of bad) expect((await manage("set_settings", { room: r.id, ...input })).body.code, JSON.stringify(input)).toBe(code);
    expect(await view(r)).toMatchObject({ form: "group", capacity: 10, minutes: 120 });
    expect((await manage("set_settings", { room: r.id, form: "one_to_one" })).body.settings).toEqual({ form: "one_to_one", capacity: 2, minutes: 120, entry: "approval" });
    expect((await manage("set_settings", { room: r.id, capacity: 3, minutes: 90 })).body.settings).toEqual({ form: "one_to_one", capacity: 3, minutes: 90, entry: "approval" });
    expect(await view(r)).toMatchObject({ form: "one_to_one", capacity: 3, minutes: 90 });
    expect((await manage("set_settings", { room: r.id, form: "group" })).body.settings).toEqual({ form: "group", capacity: 10, minutes: 90, entry: "approval" });
    // Two owners at the same moment: one change is made, the other is told so.
    const [a, b] = await Promise.all([manage("set_settings", { room: r.id, capacity: 5 }), manage("set_settings", { room: r.id, capacity: 6 })]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect([a.body.code, b.body.code]).toContain("CHANGED_CONCURRENTLY");
    expect((await view(r)).capacity).toBe(a.status === 200 ? 5 : 6);
  });

  test("ST-2: a room's capacity holds at the door and when letting in; lowered below who is in, those in stay and nobody new comes in", async () => {
    const r = await room();
    await manage("set_settings", { room: r.id, form: "one_to_one" });
    expect((await admitOne(r, "Ann")).answer.status).toBe(200);
    const bo = await ask(r, "Bo");
    const cy = await ask(r, "Cy");
    expect((await manage("admit", { room: r.id, request: bo.body.requestId })).status).toBe(200);
    expect((await manage("admit", { room: r.id, request: cy.body.requestId })).body.code).toBe("ROOM_FULL");
    expect((await ask(r, "Di")).body.code).toBe("ROOM_FULL");
    await manage("set_settings", { room: r.id, capacity: 4 });
    expect((await manage("admit", { room: r.id, request: cy.body.requestId })).status).toBe(200);
    expect((await manage("set_settings", { room: r.id, capacity: 2 })).body).toMatchObject({ ok: true, inRoom: 3 });
    expect((await view(r)).inRoom).toHaveLength(3);
    expect((await ask(r, "Ed")).body.code).toBe("ROOM_FULL");
  });
});

describe("a lesson's time", () => {
  test("ST-3: a lesson lasts the room's minutes (120 unless set), on the lesson's own record too; a new length counts from the next lesson", async () => {
    const r = await room();
    const first = await admitOne(r, "Ann");
    const lessonId = (await status(r, first.asked)).body.lessonId;
    expect((await store.lesson(lessonId)).endsAt).toBe(iso(START + 120 * MIN));
    expect((await view(r)).lesson).toMatchObject({ lessonId, startedAt: iso(START), endsAt: iso(START + 120 * MIN), extendable: true });
    await manage("set_settings", { room: r.id, minutes: 60 });
    expect((await store.lesson(lessonId)).endsAt).toBe(iso(START + 120 * MIN));
    await manage("end_lesson", { room: r.id }, { now: START + 10 * MIN });
    const next = await admitOne(r, "Ann", START + 20 * MIN);
    const nextId = (await status(r, next.asked, START + 20 * MIN)).body.lessonId;
    expect((await store.lesson(nextId)).endsAt).toBe(iso(START + 80 * MIN));
  });

  test("ST-4: an owner extends the lesson now by 30 minutes at a time, to at most 180 in all; the lesson's record, the view and a person's status all say the new end; two presses at the same moment extend once", async () => {
    const r = await room();
    const ann = await admitOne(r, "Ann");
    const lessonId = (await status(r, ann.asked)).body.lessonId;
    expect((await manage("extend_lesson", { room: r.id }, { principal: NOT_OWNER })).body.code).toBe("OWNER_REQUIRED");
    const [one, two] = await Promise.all([manage("extend_lesson", { room: r.id }, { now: START + 100 * MIN }), manage("extend_lesson", { room: r.id }, { now: START + 100 * MIN })]);
    expect([one.status, two.status].sort()).toEqual([200, 409]);
    expect([one.body.code, two.body.code]).toContain("CHANGED_CONCURRENTLY");
    expect((await store.lesson(lessonId)).endsAt).toBe(iso(START + 150 * MIN));
    expect((await view(r, START + 100 * MIN)).lesson).toMatchObject({ endsAt: iso(START + 150 * MIN), extendable: true });
    expect((await classroomStatus({ store, lessonId, key: ann.asked.body.ticket, now: START + 100 * MIN })).body.endsAt).toBe(iso(START + 150 * MIN));
    expect((await manage("extend_lesson", { room: r.id }, { now: START + 120 * MIN })).body.endsAt).toBe(iso(START + 180 * MIN));
    expect((await view(r, START + 120 * MIN)).lesson.extendable).toBe(false);
    expect((await manage("extend_lesson", { room: r.id }, { now: START + 130 * MIN })).body.code).toBe("EXTEND_LIMIT");
    expect((await store.lesson(lessonId)).endsAt).toBe(iso(START + 180 * MIN));
    // Past its end there is no lesson to extend.
    expect((await manage("extend_lesson", { room: r.id }, { now: START + 181 * MIN })).body.code).toBe("NO_LESSON");
  });

  test("ST-5: at its planned end the regular tick ends the lesson: the page is told LESSON_TIME_UP (not cancelled) and leaves; the room's next person opens a new lesson; before the end nothing happens; with the fixed rooms off nothing happens; an owner's end stays LESSON_CANCELLED", async () => {
    const r = await room();
    const ann = await admitOne(r, "Ann");
    const lessonId = (await status(r, ann.asked)).body.lessonId;
    expect((await rooms.endLessonsPastTime({ store, provider, drive, now: START + 119 * MIN })).ended).not.toContain(lessonId);
    vi.stubEnv("CLASSROOM_FIXED_ROOMS", "");
    expect((await rooms.endLessonsPastTime({ store, provider, drive, now: START + 121 * MIN })).ended).toEqual([]);
    vi.stubEnv("CLASSROOM_FIXED_ROOMS", "on");
    expect((await store.lesson(lessonId)).cancelled).toBe(false);
    const summary = await runClassroomTick({ store, provider, drive, now: START + 121 * MIN, workerId: "st-5" });
    expect(summary.fixedRoomLessonsTimeUp).toBeGreaterThanOrEqual(1);
    expect((await store.lesson(lessonId)).cancelled).toBe(true);
    const refused = await classroomStatus({ store, lessonId, key: ann.asked.body.ticket, now: START + 122 * MIN });
    expect(refused).toMatchObject({ status: 403, body: { code: "LESSON_TIME_UP" } });
    expect((await join(lessonId, ann.asked.body.ticket, START + 122 * MIN)).body.code).toBe("LESSON_TIME_UP");
    const left = entryEndedBy({ status: refused.status, code: refused.body.code }, { role: "student", hasKey: true });
    expect(left).toBe("LESSON_TIME_UP");
    expect(reasonShown(left, true)).toBe("FIXED_ROOM_TIME_UP");
    expect((await status(r, ann.asked, START + 122 * MIN)).body.state).toBe("ended");
    const again = await admitOne(r, "Ann", START + 123 * MIN);
    const nextId = (await status(r, again.asked, START + 123 * MIN)).body.lessonId;
    expect(nextId).not.toBe(lessonId);
    await manage("end_lesson", { room: r.id }, { now: START + 130 * MIN });
    expect((await classroomStatus({ store, lessonId: nextId, key: again.asked.body.ticket, now: START + 131 * MIN })).body.code).toBe("LESSON_CANCELLED");
  });

  // Round 15 (2026-11-24): with the fixed rooms off (as on the site) the tick costs what it did before.
  test("ST-6: while the fixed rooms are off the tick does not even load their module, by the same switch as fixedRoomsEnabled(); a failure there, loading included, never stops the tick", async () => {
    const source = await readFile("lib/classroom-service.ts", "utf8");
    expect(source).toContain('const timeUp = lessonIds || process.env.CLASSROOM_FIXED_ROOMS !== "on" ? { ended: [] as string[] }');
    expect(source).toContain('await import("./classroom-fixed-rooms").then((fixed) => fixed.endLessonsPastTime({ store, provider, drive, now })).catch(() => ({ ended: [] as string[], failed: true }));');
    for (const [value, on] of [["on", true], ["", false], ["ON", false], ["1", false]]) expect(rooms.fixedRoomsEnabled({ CLASSROOM_FIXED_ROOMS: value }), value).toBe(on);
    const r = await room();
    const ann = await admitOne(r, "Ann");
    const lessonId = (await status(r, ann.asked)).body.lessonId;
    vi.stubEnv("CLASSROOM_FIXED_ROOMS", "");
    const off = await runClassroomTick({ store, provider, drive, now: START + 500 * MIN, workerId: "st-6" });
    expect(off.fixedRoomLessonsTimeUp).toBeUndefined();
    expect(off.fixedRoomTimeUpFailed).toBeUndefined();
    expect((await store.lesson(lessonId)).cancelled).toBe(false);
    vi.stubEnv("CLASSROOM_FIXED_ROOMS", "on");
    const on = await runClassroomTick({ store, provider, drive, now: START + 501 * MIN, workerId: "st-6" });
    expect(on.fixedRoomLessonsTimeUp).toBeGreaterThanOrEqual(1);
    expect((await store.lesson(lessonId)).cancelled).toBe(true);
  });
});
