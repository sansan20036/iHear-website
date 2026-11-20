import { afterAll, beforeEach, describe, expect, test, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// Classroom 3.0 round 3 (2026-11-21): fixed classroom links on the server, with the file store and a
// scripted stand-in for Zoom. A link and a typed name never let anyone in by themselves: a person
// asks and waits, an owner (the iHear teacher) lets them in or not. Synthetic only: nothing here says
// how real Zoom behaves (a session with no host is D-14, still to be tried on real Zoom).
const directory = await mkdtemp(path.join(os.tmpdir(), "ihear-fixed-rooms-"));
vi.stubEnv("IHEAR_FORCE_FILE_STORE", "1");
vi.stubEnv("IHEAR_TEST_DATA_DIR", directory);
vi.stubEnv("CLASSROOM_DRIVE", "local");
vi.stubEnv("VERCEL_ENV", "");
const { classroomStore } = await import("../lib/classroom-store");
const { classroomDrive } = await import("../lib/classroom-drive");
const { createClassroomLesson, joinClassroom, roomGeneration } = await import("../lib/classroom-service");
const rooms = await import("../lib/classroom-fixed-rooms");
const { fixedRoomOf } = await import("../lib/classroom-fixed-room-facts");
// @ts-ignore
const { buildSessionTokenClaims, roomNameOf, signSessionToken } = await import("../tools/recording-pathway/classroom/eligibility.mjs");
// @ts-ignore
const { storeEvent } = await import("../tools/recording-pathway/classroom/webhook-ingest.mjs");

afterAll(async () => {
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});
beforeEach(() => { vi.stubEnv("CLASSROOM_FIXED_ROOMS", "on"); });

const store = classroomStore();
const drive = classroomDrive();
const MIN = 60_000;
const START = Date.parse("2026-12-10T15:00:00Z");
const OWNER = { email: "rooms-owner@example.test", owner: true };
const keyOf = link => new URLSearchParams(link.split("#")[1]).get("k");
const claimsOf = token => JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
const calls = [];
const provider = {
  name: "synthetic", webhookSecret: null,
  sessionToken: ({ lesson, participant, now, generation = 0 }) => {
    const claims = buildSessionTokenClaims({ lesson, participant, appKey: "synthetic-app", now, generation });
    return { token: signSessionToken(claims, "fixed-rooms-test-secret-not-real"), issuedAt: now, expiresAt: now + 30 * MIN };
  },
  startRecording: async () => ({ ok: true, httpStatus: 202 }), stopRecording: async () => ({ ok: true, httpStatus: 202 }),
  endSession: async (lesson, sessionId) => { calls.push(["end", lesson.id, sessionId]); return { ok: true, httpStatus: 204 }; },
  removeUser: async () => ({ ok: false, httpStatus: 501 }), snapshot: async () => null, observe: async () => ({ live: false, recording: null }),
  download: async () => Buffer.alloc(0), deleteRecording: async () => ({ ok: false, httpStatus: 501 }),
};
const manage = (action, input = {}, { now = START, principal = OWNER } = {}) => rooms.manageFixedRoom({ store, provider, drive, principal, action, input, now });
let made = 0;
async function room(label = null) {
  made += 1;
  const created = await manage("create", { label: label ?? `Room ${made}` });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  return { id: created.body.room.id, label: created.body.room.label, key: keyOf(created.body.link), link: created.body.link };
}
const ask = (r, name, { now = START, key = r.key } = {}) => rooms.requestEntry({ store, roomId: r.id, key, name, now });
const status = (r, asked, now = START) => rooms.requestStatus({ store, roomId: r.id, requestId: asked.body.requestId, ticket: asked.body.ticket, now });
const view = async (r, now = START) => (await rooms.fixedRoomsView({ store, now })).find(entry => entry.id === r.id);
const join = (lessonId, ticket, now = START) => joinClassroom({ store, provider, lessonId, key: ticket, now });

describe("fixed classroom links", () => {
  test("FR-1: switched off, nothing answers: requests, status and every owner action are 404", async () => {
    const r = await room();
    vi.stubEnv("CLASSROOM_FIXED_ROOMS", "");
    expect(rooms.fixedRoomsEnabled()).toBe(false);
    expect((await ask(r, "Kyle")).status).toBe(404);
    expect((await rooms.requestStatus({ store, roomId: r.id, requestId: "Q-x", ticket: "x", now: START })).status).toBe(404);
    expect((await manage("create", { label: "Room Off" })).status).toBe(404);
    expect(rooms.fixedRoomsEnabled({ CLASSROOM_FIXED_ROOMS: "on" })).toBe(true);
    expect(rooms.fixedRoomsEnabled({})).toBe(false);
  });

  test("FR-2: only an owner makes rooms; the link is given once and only its hash is kept; names are checked", async () => {
    expect((await manage("create", { label: "Room A" }, { principal: { email: "tutor@example.test", owner: false } })).body.code).toBe("OWNER_REQUIRED");
    expect((await manage("create", { label: "Room A" }, { principal: null })).body.code).toBe("OWNER_REQUIRED");
    const r = await room("Room A2");
    expect(r.link).toMatch(new RegExp(`^/classroom/r/FR-[0-9a-f]{32}#k=[A-Za-z0-9_-]{43}$`));
    expect(JSON.stringify(await store.eventsFor([r.id, "FR-REGISTRY"]))).not.toContain(r.key);
    for (const bad of ["", "Room-1", "Room_1", "小明教室", ".Room", "R".repeat(41)]) expect((await manage("create", { label: bad })).body.code, bad).toBe("INVALID_LABEL");
    expect((await manage("create", { label: "room a2" })).body.code).toBe("LABEL_TAKEN");
    expect((await manage("bogus", {})).body.code).toBe("INVALID_ACTION");
  });

  test("FR-3: a request needs the room's current link and an English first name; a wrong key is the same as no room; the answer gives the typed name and a ticket that opens nothing yet", async () => {
    const r = await room();
    expect((await ask(r, "Kyle", { key: "not-the-key" })).body.code).toBe("NOT_FOUND");
    expect((await rooms.requestEntry({ store, roomId: "FR-00000000000000000000000000000000", key: r.key, name: "Kyle", now: START })).body.code).toBe("NOT_FOUND");
    expect((await rooms.requestEntry({ store, roomId: "../etc", key: r.key, name: "Kyle", now: START })).body.code).toBe("NOT_FOUND");
    expect((await ask(r, "小明")).body.code).toBe("INVALID_NAME");
    const asked = await ask(r, "  Kyle ");
    expect(asked.body).toMatchObject({ ok: true, name: "Kyle" });
    expect(asked.body.ticket).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect((await status(r, asked)).body).toEqual({ ok: true, state: "waiting" });
    expect((await rooms.requestStatus({ store, roomId: r.id, requestId: asked.body.requestId, ticket: "wrong", now: START })).body.code).toBe("NOT_FOUND");
    // Waiting is nothing: no lesson, no seat, no token anywhere.
    expect((await view(r)).lesson).toBeNull();
    expect(JSON.stringify(await store.eventsFor([r.id]))).not.toContain(asked.body.ticket);
  });

  test("FR-4: let in by an owner: the room opens a lesson, the person is its student by their ticket, and only then enters; Zoom gets a code, never the name; no host, no chat", async () => {
    const r = await room();
    const kyle = await ask(r, "Kyle");
    expect((await manage("admit", { room: r.id, request: kyle.body.requestId })).status).toBe(200);
    const answer = (await status(r, kyle)).body;
    expect(answer).toMatchObject({ ok: true, state: "admitted" });
    const lesson = await store.lesson(answer.lessonId);
    expect(fixedRoomOf(await store.eventsFor([lesson.id]))).toBe(r.id);
    expect(lesson.participants).toEqual([expect.objectContaining({ role: "student", staffEmail: null, code: expect.stringMatching(/^R[0-9a-f]{8}-[0-9a-f]{6}$/) })]);
    const entered = await join(lesson.id, kyle.body.ticket);
    expect(entered.status).toBe(200);
    expect(entered.body).toMatchObject({ role: "student", fixedRoom: true });
    const claims = claimsOf(entered.body.session.token);
    expect(claims).toMatchObject({ role_type: 0, tpc: roomNameOf(lesson.id, 0), session_key: lesson.id });
    expect(JSON.stringify(claims)).not.toContain("Kyle");
    // A second person joins the same lesson; the owner sees both, by name.
    const ann = await ask(r, "Ann");
    expect((await manage("admit", { room: r.id, request: ann.body.requestId })).status).toBe(200);
    expect((await status(r, ann)).body.lessonId).toBe(lesson.id);
    expect((await view(r)).inRoom.map(person => person.name).sort()).toEqual(["Ann", "Kyle"]);
    expect((await view(r)).waiting).toEqual([]);
    // An ordinary one-to-one lesson is never taken for a fixed room.
    const { lesson: plain, studentLink } = await createClassroomLesson({ store, actor: OWNER.email, now: START - 60 * MIN, input: { code: `TEST-FR-PLAIN${made}`, date: "2026-12-10", time: "10:00", minutes: 60, tutorCode: `TEST-FRT${made}`, tutorEmail: `fr-tutor${made}@example.test`, studentCode: `TEST-FRS${made}`, timeZone: "America/New_York" } });
    const normal = await joinClassroom({ store, provider, lessonId: plain.id, key: keyOf(studentLink), now: START });
    expect(normal.status).toBe(200);
    expect(normal.body.fixedRoom).toBeUndefined();
  });

  test("FR-5: rooms are apart, and a typed name takes nobody's place: another room's ticket or key gets nothing; the same name again is a new person waiting (\"Kyle B\" for the teacher, never in the answer)", async () => {
    const a = await room(), b = await room();
    const kyle = await ask(a, "Kyle");
    await manage("admit", { room: a.id, request: kyle.body.requestId });
    const lessonA = (await status(a, kyle)).body.lessonId;
    const bo = await ask(b, "Bo");
    await manage("admit", { room: b.id, request: bo.body.requestId });
    const lessonB = (await status(b, bo)).body.lessonId;
    expect(lessonA).not.toBe(lessonB);
    expect((await join(lessonB, kyle.body.ticket)).body.code).toBe("NOT_ON_ROSTER");
    expect((await rooms.requestEntry({ store, roomId: b.id, key: a.key, name: "Kyle", now: START })).body.code).toBe("NOT_FOUND");
    // Someone types Kyle's name into room A: a new request, waiting, with nothing of Kyle's.
    const impostor = await ask(a, "kyle");
    expect(impostor.body).toMatchObject({ ok: true, name: "kyle" });
    expect((await status(a, impostor)).body).toEqual({ ok: true, state: "waiting" });
    expect((await view(a)).waiting.map(person => person.name)).toEqual(["kyle B"]);
    expect((await join(lessonA, impostor.body.ticket)).body.code).toBe("NOT_ON_ROSTER");
    expect((await join(lessonA, kyle.body.ticket)).status).toBe(200);
  });

  test("FR-6: not let in: the person is told so and gets nothing; a decided request is never let in later", async () => {
    const r = await room();
    const asked = await ask(r, "Kyle");
    expect((await manage("decline", { room: r.id, request: asked.body.requestId })).status).toBe(200);
    expect((await status(r, asked)).body).toEqual({ ok: true, state: "declined" });
    expect((await manage("admit", { room: r.id, request: asked.body.requestId })).body.code).toBe("NOT_WAITING");
    expect((await view(r)).lesson).toBeNull();
    expect((await manage("decline", { room: r.id, request: "Q-nobody" })).body.code).toBe("NO_SUCH_REQUEST");
  });

  test("FR-7: ten in a room at most: the eleventh is told the room is full, whether asking or being let in", async () => {
    const r = await room();
    const asked = [];
    for (let n = 0; n < 11; n += 1) asked.push(await ask(r, `P${String.fromCharCode(65 + n)}`));
    for (const entry of asked.slice(0, 10)) expect((await manage("admit", { room: r.id, request: entry.body.requestId })).status).toBe(200);
    expect((await manage("admit", { room: r.id, request: asked[10].body.requestId })).body.code).toBe("ROOM_FULL");
    expect((await ask(r, "Late")).body.code).toBe("ROOM_FULL");
    const lesson = await store.lesson((await status(r, asked[0])).body.lessonId);
    expect(lesson.participants.filter(entry => entry.role === "student")).toHaveLength(10);
  });

  test("FR-8: a replaced link lets nobody new in: the old one says so; a request made with it can no longer be let in; people already in stay", async () => {
    const r = await room();
    const kyle = await ask(r, "Kyle");
    await manage("admit", { room: r.id, request: kyle.body.requestId });
    const queued = await ask(r, "Ann");
    const replaced = await manage("replace_link", { room: r.id });
    expect(replaced.status).toBe(200);
    expect(replaced.body.generation).toBe(2);
    const newKey = keyOf(replaced.body.link);
    expect(newKey).not.toBe(r.key);
    expect((await ask(r, "Bo")).body.code).toBe("LINK_REPLACED");
    expect((await status(r, queued)).body.state).toBe("replaced");
    expect((await manage("admit", { room: r.id, request: queued.body.requestId })).body.code).toBe("NOT_WAITING");
    expect((await status(r, kyle)).body.state).toBe("admitted");
    expect((await join((await status(r, kyle)).body.lessonId, kyle.body.ticket)).status).toBe(200);
    expect((await ask(r, "Bo", { key: newKey })).body.ok).toBe(true);
  });

  test("FR-9: taken out: their ticket gets nothing more, the lesson moves to a new Zoom session (everyone else's next token leads there), and their place is free again", async () => {
    const r = await room();
    const people = [];
    for (const name of ["Ann", "Bo", "Cy", "Di", "Ed", "Fy", "Gu", "Hal", "Ivy", "Jo"]) {
      const asked = await ask(r, name);
      await manage("admit", { room: r.id, request: asked.body.requestId });
      people.push(asked);
    }
    const lessonId = (await status(r, people[0])).body.lessonId;
    expect(roomGeneration(await store.eventsFor([lessonId]))).toBe(0);
    expect((await manage("remove", { room: r.id, request: people[1].body.requestId }, { now: START + MIN })).status).toBe(200);
    expect((await status(r, people[1], START + MIN)).body.state).toBe("removed");
    expect((await join(lessonId, people[1].body.ticket, START + MIN)).body.code).toBe("NOT_ON_ROSTER");
    expect(roomGeneration(await store.eventsFor([lessonId]))).toBe(1);
    const next = await join(lessonId, people[0].body.ticket, START + MIN);
    expect(claimsOf(next.body.session.token).tpc).toBe(roomNameOf(lessonId, 1));
    expect((await view(r, START + MIN)).inRoom).toHaveLength(9);
    const late = await ask(r, "Kim", { now: START + 2 * MIN });
    expect((await manage("admit", { room: r.id, request: late.body.requestId }, { now: START + 2 * MIN })).status).toBe(200);
    expect((await manage("remove", { room: r.id, request: people[1].body.requestId }, { now: START + 3 * MIN })).body.code).toBe("NOT_IN_ROOM");
  });

  test("FR-10: the lesson ended by the owner: nobody enters it any more, and the next person let in opens a new lesson", async () => {
    const r = await room();
    const kyle = await ask(r, "Kyle");
    await manage("admit", { room: r.id, request: kyle.body.requestId });
    const first = (await status(r, kyle)).body.lessonId;
    expect((await manage("end_lesson", { room: r.id }, { now: START + 50 * MIN })).status).toBe(200);
    expect((await store.lesson(first)).cancelled).toBe(true);
    expect((await join(first, kyle.body.ticket, START + 51 * MIN)).status).toBe(403);
    expect((await status(r, kyle, START + 51 * MIN)).body.state).toBe("ended");
    expect((await manage("end_lesson", { room: r.id }, { now: START + 52 * MIN })).body.code).toBe("NO_LESSON");
    const again = await ask(r, "Kyle", { now: START + 60 * MIN });
    await manage("admit", { room: r.id, request: again.body.requestId }, { now: START + 60 * MIN });
    const second = (await status(r, again, START + 60 * MIN)).body.lessonId;
    expect(second).not.toBe(first);
    expect((await join(second, again.body.ticket, START + 60 * MIN)).status).toBe(200);
  });

  test("FR-11: twenty waiting at most; a request nobody answers lapses after 30 minutes and cannot be let in", async () => {
    const r = await room();
    const asked = [];
    for (let n = 0; n < 20; n += 1) asked.push(await ask(r, `W${String.fromCharCode(65 + n)}`));
    expect((await ask(r, "Over")).body.code).toBe("TOO_MANY_WAITING");
    const later = START + 31 * MIN;
    expect((await status(r, asked[0], later)).body.state).toBe("expired");
    expect((await manage("admit", { room: r.id, request: asked[0].body.requestId }, { now: later })).body.code).toBe("NOT_WAITING");
    expect((await ask(r, "Fresh", { now: later })).body.ok).toBe(true);
  });

  test("FR-12: let in at the same moment: one lesson, every person once, each with a code of their own; the same person let in twice at once is one row", async () => {
    const r = await room();
    const asked = [];
    for (const name of ["Ann", "Bo", "Cy", "Di"]) asked.push(await ask(r, name));
    const answers = await Promise.all(asked.map(entry => manage("admit", { room: r.id, request: entry.body.requestId })));
    expect(answers.every(answer => answer.status === 200), JSON.stringify(answers.map(answer => answer.body))).toBe(true);
    const lessons = new Set((await Promise.all(asked.map(entry => status(r, entry)))).map(answer => answer.body.lessonId));
    expect(lessons.size).toBe(1);
    const lesson = await store.lesson([...lessons][0]);
    const codes = lesson.participants.map(entry => entry.code);
    expect(new Set(codes).size).toBe(4);
    const twice = await ask(r, "Ed");
    const both = await Promise.all([manage("admit", { room: r.id, request: twice.body.requestId }), manage("admit", { room: r.id, request: twice.body.requestId })]);
    expect(both.filter(answer => answer.status === 200)).toHaveLength(1);
    expect((await store.lesson(lesson.id)).participants).toHaveLength(5);
  });

  test("FR-13: only the server's own facts count: a decision or a fixed-room mark stored by another path is nothing", async () => {
    const r = await room();
    const asked = await ask(r, "Kyle");
    await store.transaction(tx => storeEvent(tx, { source: "zoom_webhook", type: "server.room_decision", lessonId: r.id, roomId: r.id, requestId: asked.body.requestId, decision: "admitted", classLessonId: "L-forged", code: "R00000000-001", occurredAt: START + 1000, receivedAt: START + 1000, key: `forged:${asked.body.requestId}` }));
    expect((await status(r, asked)).body).toEqual({ ok: true, state: "waiting" });
    expect(fixedRoomOf([{ source: "zoom_webhook", type: "server.lesson_scheduled", lessonId: "L-x", fixedRoomId: r.id, occurredAt: 1, key: "k" }])).toBeNull();
    expect(fixedRoomOf([{ source: "server", type: "server.lesson_scheduled", lessonId: "L-x", fixedRoomId: r.id, occurredAt: 1, key: "k" }])).toBe(r.id);
  });
});

// Round 3, phase 4 (2026-11-21): recording in a fixed room. Its lesson has no tutor, so it records
// only with the site's and the room's switches on, two people in it by Zoom's word and every person
// let in holding a valid consent: two people in a room is never a consent. Its recordings are named
// by the room, the New York date and time and the names, filed in <month>/<room>. Synthetic only.
const { setSyntheticConsent, runClassroomTick } = await import("../lib/classroom-service");
// @ts-ignore
const { fileRecording, processJobs } = await import("../tools/recording-pathway/classroom/recording-filing.mjs");
// @ts-ignore
const { createDrive, syntheticContent } = await import("../tools/recording-pathway/test/fake-classroom-store.mjs");
// @ts-ignore
const Core = (await import("../tools/recording-pathway/apps-script/Core.js")).default;

describe("recording in a fixed room", () => {
  const starts = [];
  const stops = [];
  const recorder = {
    ...provider,
    startRecording: async (lesson, sessionId) => { starts.push([lesson.id, sessionId]); return { ok: true, httpStatus: 202 }; },
    stopRecording: async (lesson, sessionId) => { stops.push([lesson.id, sessionId]); return { ok: true, httpStatus: 202 }; },
  };
  let facts = 0;
  const fact = (lessonId, type, at, fields) => { facts += 1; return store.transaction(tx => storeEvent(tx, { source: "zoom_webhook", type, lessonId, occurredAt: at, receivedAt: at, key: `${type}:${lessonId}:${at}:${facts}`, ...fields })); };
  // A room with these people let in (consent for those named), and its lesson's Zoom session live.
  async function inRoom(names, { consented = names, present = names } = {}) {
    const r = await room();
    const asked = {};
    for (const name of names) {
      asked[name] = await ask(r, name);
      expect((await manage("admit", { room: r.id, request: asked[name].body.requestId })).status).toBe(200);
    }
    const lessonId = (await status(r, asked[names[0]])).body.lessonId;
    const lesson = await store.lesson(lessonId);
    // Let in in this order: the n-th person has the n-th row.
    const rowOf = name => lesson.participants[names.indexOf(name)];
    for (const name of consented) await setSyntheticConsent({ store, personCode: rowOf(name).code, role: "student", status: "granted", actor: OWNER.email, now: START - 30 * MIN });
    const sessionId = `ZS-${lessonId.slice(2, 10)}`;
    await fact(lessonId, "session.started", START + MIN, { providerSessionId: sessionId, sessionName: roomNameOf(lessonId, 0) });
    for (const name of present) await fact(lessonId, "session.user_joined", START + MIN, { providerSessionId: sessionId, participantId: rowOf(name).id });
    return { r, lessonId, sessionId, rowOf };
  }
  const tick = (lessonId, at) => runClassroomTick({ store, provider: recorder, drive, now: START + at * MIN, lessonIds: [lessonId], workerId: "fr-rec" });
  const lastDecision = async lessonId => (await store.eventsFor([lessonId])).filter(event => event.type === "server.recording_eligibility").at(-1);

  test("FR-REC-1: off by default: the site's switch off, a room cannot turn recording on, and two people with every consent never record", async () => {
    vi.stubEnv("CLASSROOM_FIXED_ROOM_RECORDING", "");
    const { r, lessonId } = await inRoom(["Ann", "Kyle"]);
    expect((await manage("set_recording", { room: r.id, on: true })).body.code).toBe("RECORDING_NOT_AVAILABLE");
    for (const at of [2, 3]) await tick(lessonId, at);
    expect(starts.filter(([id]) => id === lessonId)).toEqual([]);
    expect(await lastDecision(lessonId)).toMatchObject({ eligible: false, reason: "RECORDING_DISABLED" });
    expect((await view(r)).recording).toEqual({ on: false, available: false });
  });

  test("FR-REC-2: with both switches on: one person in never starts it (consent alone is not enough); two in, one without consent, never; two in with consent starts it; off while recording is refused, and ending the lesson stops it", async () => {
    vi.stubEnv("CLASSROOM_FIXED_ROOM_RECORDING", "on");
    try {
      const alone = await inRoom(["Ann"]);
      expect((await manage("set_recording", { room: alone.r.id, on: true })).status).toBe(200);
      for (const at of [2, 3]) await tick(alone.lessonId, at);
      expect(await lastDecision(alone.lessonId)).toMatchObject({ eligible: true });
      const unconsented = await inRoom(["Ann", "Bo"], { consented: ["Ann"] });
      await manage("set_recording", { room: unconsented.r.id, on: true });
      for (const at of [2, 3]) await tick(unconsented.lessonId, at);
      expect(await lastDecision(unconsented.lessonId)).toMatchObject({ eligible: false, reason: "CONSENT_MISSING" });
      const both = await inRoom(["Ann", "Kyle"]);
      // The room's switch turned on after its lesson opened: written to the lesson, which decides again.
      await manage("set_recording", { room: both.r.id, on: true });
      for (const at of [2, 3]) await tick(both.lessonId, at);
      expect(starts.filter(([id]) => id === both.lessonId)).toEqual([[both.lessonId, both.sessionId]]);
      for (const other of [alone.lessonId, unconsented.lessonId]) expect(starts.filter(([id]) => id === other)).toEqual([]);
      await fact(both.lessonId, "session.recording_started", START + 4 * MIN, { providerSessionId: both.sessionId, status: "Recording" });
      expect((await manage("set_recording", { room: both.r.id, on: false }, { now: START + 5 * MIN })).body.code).toBe("RECORDING_MAY_BE_ON");
      const ended = await rooms.manageFixedRoom({ store, provider: recorder, drive, principal: OWNER, action: "end_lesson", input: { room: both.r.id }, now: START + 5 * MIN });
      expect(ended.status).toBe(200);
      expect(stops.filter(([id]) => id === both.lessonId).map(([, sessionId]) => sessionId)).toContain(both.sessionId);
      expect((await manage("set_recording", { room: both.r.id, on: false }, { now: START + 6 * MIN })).status).toBe(200);
    } finally {
      vi.stubEnv("CLASSROOM_FIXED_ROOM_RECORDING", "");
    }
  });

  test("FR-REC-5: a recording stops once fewer than two people have been in the room for 5 minutes; a shorter time alone does not stop it", async () => {
    vi.stubEnv("CLASSROOM_FIXED_ROOM_RECORDING", "on");
    try {
      const both = await inRoom(["Ann", "Kyle"]);
      await manage("set_recording", { room: both.r.id, on: true });
      for (const at of [2, 3]) await tick(both.lessonId, at);
      expect(starts.filter(([id]) => id === both.lessonId)).toHaveLength(1);
      await fact(both.lessonId, "session.recording_started", START + 4 * MIN, { providerSessionId: both.sessionId, status: "Recording" });
      await fact(both.lessonId, "session.user_left", START + 5 * MIN, { providerSessionId: both.sessionId, participantId: both.rowOf("Kyle").id });
      await tick(both.lessonId, 8);
      expect(stops.filter(([id]) => id === both.lessonId)).toEqual([]);
      await tick(both.lessonId, 10.5);
      expect(stops.filter(([id]) => id === both.lessonId).map(([, sessionId]) => sessionId)).toEqual([both.sessionId]);
    } finally {
      vi.stubEnv("CLASSROOM_FIXED_ROOM_RECORDING", "");
    }
  });

  test("FR-REC-3: everyone let in must have consented, in the room or not: two consented people in it and a third let in without consent are not recorded", async () => {
    vi.stubEnv("CLASSROOM_FIXED_ROOM_RECORDING", "on");
    try {
      const three = await inRoom(["Ann", "Bo", "Cy"], { consented: ["Ann", "Bo"], present: ["Ann", "Bo"] });
      await manage("set_recording", { room: three.r.id, on: true });
      for (const at of [2, 3]) await tick(three.lessonId, at);
      expect(starts.filter(([id]) => id === three.lessonId)).toEqual([]);
      expect(await lastDecision(three.lessonId)).toMatchObject({ eligible: false, reason: "CONSENT_MISSING" });
    } finally {
      vi.stubEnv("CLASSROOM_FIXED_ROOM_RECORDING", "");
    }
  });

  test("FR-REC-4: a fixed room's recording is named room_New-York-date-time_names and filed in <month>/<room>; no tutor never breaks its naming", async () => {
    const { r, lessonId, sessionId } = await inRoom(["Kyle", "Ann"]);
    // The lesson's own decision allowed recording at its start (as its consent check would).
    await store.transaction(tx => storeEvent(tx, { source: "server", type: "server.recording_eligibility", lessonId, eligible: true, reason: "ALL_CONSENTED", count: 0, occurredAt: START, receivedAt: START, key: `server.recording_eligibility:${lessonId}:fr4` }));
    const recorded = (id, from, to) => store.transaction(tx => storeEvent(tx, {
      source: "zoom_api", type: "session.recording_completed", lessonId, provider: "synthetic", providerSessionId: sessionId, sessionName: roomNameOf(lessonId, 0),
      occurredAt: to + 5 * MIN, receivedAt: to + 5 * MIN, key: `session.recording_completed:${id}`,
      files: [{ providerFileId: id, kind: "composite", extension: "mp4", size: 1000, status: "completed", recordingStart: from, recordingEnd: to }],
    }));
    // START is 15:00 UTC on 10 December 2026: 10:00 in New York (EST).
    const first = `FR4-${made}-A`, second = `FR4-${made}-B`;
    await recorded(first, START + 2 * MIN, START + 30 * MIN);
    await recorded(second, START + 35 * MIN, START + 50 * MIN);
    expect((await store.fileRecord(first)).plannedName).toBe(`${r.label}_2026-12-10 1002_Ann-Kyle.mp4`);
    expect((await store.fileRecord(second)).plannedName).toBe(`${r.label}_2026-12-10 1035_Ann-Kyle.mp4`);
    const fake = createDrive();
    const results = await processJobs({
      store, now: START + 60 * MIN, workerId: "fr-filing", handlers: {
        file_recording: input => fileRecording({ store, drive: fake, download: async (record, { start, end }) => syntheticContent(record.providerFileId, start, end), rootFolderId: fake.rootFolderId, ...input }),
        delete_vendor_copy: async ({ job, leaseVersion }) => ({ status: (await store.completeJob({ jobId: job.id, leaseVersion })) ? "DONE" : "LEASE_LOST" }),
      },
    });
    expect(results.filter(result => String(result.jobId).startsWith("file:FR4")).map(result => result.status)).toEqual(["STORED", "STORED"]);
    const lesson = await store.lesson(lessonId);
    const folder = fake.ensureFolder(fake.ensureFolder(fake.rootFolderId, Core.monthlyFolderName(lesson.date)), r.label);
    expect((await fake.listNames(folder)).sort()).toEqual([`${r.label}_2026-12-10 1002_Ann-Kyle.mp4`, `${r.label}_2026-12-10 1035_Ann-Kyle.mp4`]);
  });
});
