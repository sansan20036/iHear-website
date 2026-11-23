import { afterAll, beforeEach, describe, expect, test, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readAllBeforeWriting } from "./helpers/read-before-write.mjs";

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

  test("FR-4: let in by an owner: the room opens a lesson, the person is its student by their ticket, and only then enters; the token carries a code, never the name (the name Zoom shows comes apart, FR-4n); no host, no chat", async () => {
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
    expect(normal.body.displayName).toBeUndefined();
  });

  // The user's decision (2026-11-24): in a fixed room Zoom shows the first name a person typed.
  test("FR-4n: the name Zoom shows is the one the owner saw when letting the person in (the second Kyle is \"kyle B\"), recorded by the server and checked again when read; a forged or unsafe name gives none, and then the code is shown", async () => {
    const r = await room();
    const kyle = await ask(r, "Kyle");
    await manage("admit", { room: r.id, request: kyle.body.requestId });
    const lessonId = (await status(r, kyle)).body.lessonId;
    const twin = await ask(r, "kyle");
    await manage("admit", { room: r.id, request: twin.body.requestId });
    const first = await join(lessonId, kyle.body.ticket), second = await join(lessonId, twin.body.ticket);
    expect(first.body.displayName).toBe("Kyle");
    expect(second.body.displayName).toBe("kyle B");
    // The token never carries the name; the code stays the person's identity in the lesson.
    expect(JSON.stringify(claimsOf(first.body.session.token))).not.toMatch(/kyle/i);
    expect(first.body.participantCode).toMatch(/^R[0-9a-f]{8}-[0-9a-f]{6}$/);
    // A name that is not a safe one (another source, markup, too long) is not shown; the code is.
    const { displayNameOf, PARTICIPANT_DISPLAY_NAME } = await import("../lib/classroom-fixed-room-facts");
    const code = first.body.participantCode;
    const fact = (name, extra = {}) => ({ source: "server", type: PARTICIPANT_DISPLAY_NAME, lessonId, participantCode: code, name, occurredAt: START + 1, receivedAt: START + 1, key: `t:${name}`, ...extra });
    expect(displayNameOf([fact("Kyle")], code)).toBe("Kyle");
    for (const bad of ["<b>Kyle</b>", "Kyle\u0000", "K".repeat(43), "", "1Kyle", "Kyle_B"]) expect(displayNameOf([fact(bad)], code), JSON.stringify(bad)).toBeNull();
    expect(displayNameOf([fact("Kyle", { source: "page" })], code)).toBeNull();
    expect(displayNameOf([fact("Kyle")], "R00000000-000000")).toBeNull();
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

  test("FR-14: the store's own step refuses whole: past its limit, a key or code taken, a cancelled or a block's lesson, a lesson that is not there", async () => {
    const r = await room();
    const asked = [];
    for (const name of ["Ann", "Bo"]) {
      asked.push(await ask(r, name));
      await manage("admit", { room: r.id, request: asked.at(-1).body.requestId });
    }
    const lessonId = (await status(r, asked[0])).body.lessonId;
    const person = n => ({ id: `P-fr14-${made}-${n}`, code: `RFR14${made}-${n}`, role: "student", staffEmail: null, joinKeyHash: `${String(n).padStart(2, "0")}${"f".repeat(62)}` });
    const add = (participant, max = 10, id = lessonId) => store.addLessonParticipant({ lessonId: id, participant, max, events: [] });
    expect(await add(person(1), 2)).toEqual({ ok: false, reason: "ROOM_FULL" });
    expect(await add(person(1))).toEqual({ ok: true });
    expect(await add({ ...person(2), joinKeyHash: person(1).joinKeyHash })).toEqual({ ok: false, reason: "CODE_TAKEN" });
    expect(await add({ ...person(3), code: person(1).code })).toEqual({ ok: false, reason: "CODE_TAKEN" });
    expect(await add(person(4), 10, "L-not-there")).toEqual({ ok: false, reason: "LESSON_NOT_FOUND" });
    await manage("end_lesson", { room: r.id });
    expect(await add(person(5))).toEqual({ ok: false, reason: "LESSON_CANCELLED" });
    expect((await store.lesson(lessonId)).participants).toHaveLength(3);
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
    return { r, lessonId, sessionId, rowOf, asked };
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

  test("FR-REC-7: the site's switch turned off later wins over a room's switch left on: nothing records", async () => {
    vi.stubEnv("CLASSROOM_FIXED_ROOM_RECORDING", "on");
    const both = await inRoom(["Ann", "Kyle"]);
    expect((await manage("set_recording", { room: both.r.id, on: true })).status).toBe(200);
    vi.stubEnv("CLASSROOM_FIXED_ROOM_RECORDING", "");
    for (const at of [2, 3]) await tick(both.lessonId, at);
    expect(await lastDecision(both.lessonId)).toMatchObject({ eligible: false, reason: "RECORDING_DISABLED" });
    expect(starts.filter(([id]) => id === both.lessonId)).toEqual([]);
  });

  test("FR-REC-8: after a person is taken out the lesson moves to a new Zoom session, and that one too starts only with two people in it", async () => {
    vi.stubEnv("CLASSROOM_FIXED_ROOM_RECORDING", "on");
    try {
      const three = await inRoom(["Ann", "Kyle", "Bo"], { present: [] });
      await manage("set_recording", { room: three.r.id, on: true });
      const bo = (await view(three.r)).inRoom.find(person => person.name === "Bo");
      expect((await manage("remove", { room: three.r.id, request: bo.request })).status).toBe(200);
      const lesson = await store.lesson(three.lessonId);
      expect(roomGeneration(await store.eventsFor([lesson.id]))).toBe(1);
      const moved = `ZS-G1-${three.lessonId.slice(2, 10)}`;
      await fact(lesson.id, "session.started", START + 2 * MIN, { providerSessionId: moved, sessionName: roomNameOf(lesson.id, 1) });
      const idOf = name => lesson.participants.find(entry => entry.code === three.rowOf(name).code).id;
      await fact(lesson.id, "session.user_joined", START + 2 * MIN, { providerSessionId: moved, participantId: idOf("Ann") });
      for (const at of [3, 4]) await tick(lesson.id, at);
      expect(starts.filter(([id]) => id === lesson.id)).toEqual([]);
      await fact(lesson.id, "session.user_joined", START + 5 * MIN, { providerSessionId: moved, participantId: idOf("Kyle") });
      for (const at of [6, 7]) await tick(lesson.id, at);
      expect(starts.filter(([id]) => id === lesson.id)).toEqual([[lesson.id, moved]]);
    } finally {
      vi.stubEnv("CLASSROOM_FIXED_ROOM_RECORDING", "");
    }
  });

  test("FR-REC-6: decided with the room's switch off, then turned on: the lesson decides again and starts; never on the old decision", async () => {
    vi.stubEnv("CLASSROOM_FIXED_ROOM_RECORDING", "on");
    try {
      const both = await inRoom(["Ann", "Kyle"]);
      for (const at of [2, 3]) await tick(both.lessonId, at);
      expect(await lastDecision(both.lessonId)).toMatchObject({ eligible: false, reason: "RECORDING_DISABLED" });
      expect(starts.filter(([id]) => id === both.lessonId)).toEqual([]);
      expect((await manage("set_recording", { room: both.r.id, on: true }, { now: START + 4 * MIN })).status).toBe(200);
      for (const at of [5, 6]) await tick(both.lessonId, at);
      expect(await lastDecision(both.lessonId)).toMatchObject({ eligible: true });
      expect(starts.filter(([id]) => id === both.lessonId)).toEqual([[both.lessonId, both.sessionId]]);
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

  // Gate B round 10 (2026-11-22): a typed name never goes into a file's name (it is not an identity):
  // people let in with a code of their own are named by that code (GB-9 has the list's names).
  test("FR-REC-4: a fixed room's recording is named room_New-York-date-time_people and filed in <month>/<room>; people let in by a typed name are said by their codes, never the typed names; no tutor never breaks its naming", async () => {
    const { r, lessonId, sessionId } = await inRoom(["Kyle", "Ann"]);
    const people = (await store.lesson(lessonId)).participants.filter(entry => entry.role === "student").map(entry => entry.code.replace(/[^A-Za-z0-9 .']/g, "")).sort((a, b) => a.localeCompare(b)).join("-");
    expect(people).toMatch(/^R[0-9a-f]{14}-R[0-9a-f]{14}$/);
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
    expect((await store.fileRecord(first)).plannedName).toBe(`${r.label}_2026-12-10 1002_${people}.mp4`);
    expect((await store.fileRecord(second)).plannedName).toBe(`${r.label}_2026-12-10 1035_${people}.mp4`);
    for (const id of [first, second]) expect((await store.fileRecord(id)).plannedName).not.toMatch(/Ann|Kyle/);
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
    expect((await fake.listNames(folder)).sort()).toEqual([`${r.label}_2026-12-10 1002_${people}.mp4`, `${r.label}_2026-12-10 1035_${people}.mp4`]);
  });
// Round 7 (2026-11-21): a room taken out of use and back.
  test("FR-D1: only an owner takes a room out of use or back; the holder of its current link is told it is not in use, anyone else still gets not found; people waiting are closed out for good and nobody is let in; back in use, the same link works for new requests; the page says it in three languages", async () => {
    const r = await room();
    const before = await ask(r, "Ann");
    expect(before.status).toBe(200);
    expect((await manage("disable", { room: r.id }, { principal: { email: "staff@example.test", owner: false } })).body.code).toBe("OWNER_REQUIRED");
    expect((await manage("disable", { room: r.id }, { principal: null })).body.code).toBe("OWNER_REQUIRED");
    expect((await view(r)).disabled).toBe(false);
    expect((await manage("disable", { room: r.id })).body).toMatchObject({ ok: true, inUse: false });
    expect((await manage("disable", { room: r.id })).body).toMatchObject({ ok: true, inUse: false, unchanged: true });
    expect((await view(r)).disabled).toBe(true);
    expect((await ask(r, "Bo")).body.code).toBe("ROOM_DISABLED");
    expect((await ask(r, "Bo", { key: "not-this-rooms-key" })).status).toBe(404);
    expect((await status(r, before)).body.state).toBe("closed");
    expect((await manage("admit", { room: r.id, request: before.body.requestId })).body.code).toBe("ROOM_DISABLED");
    expect((await view(r)).waiting).toEqual([]);
    const later = START + MIN;
    expect((await manage("enable", { room: r.id }, { now: later })).body).toMatchObject({ ok: true, inUse: true });
    expect((await view(r, later)).disabled).toBe(false);
    // The request from before stays closed (its page has stopped waiting); a new one waits and enters.
    expect((await status(r, before, later)).body.state).toBe("closed");
    expect((await manage("admit", { room: r.id, request: before.body.requestId }, { now: later })).body.code).toBe("NOT_WAITING");
    const again = await ask(r, "Ann", { now: later });
    expect(again.status).toBe(200);
    expect((await manage("admit", { room: r.id, request: again.body.requestId }, { now: later })).status).toBe(200);
    expect((await status(r, again, later)).body.state).toBe("admitted");
    const { ROOM_COPY } = await import("../app/classroom/r/[roomId]/room-copy");
    for (const [language, text] of Object.entries(ROOM_COPY)) {
      expect(text.states.closed, language).toBeTruthy();
      expect(text.reasons.ROOM_DISABLED, language).toBeTruthy();
    }
  });

  test("FR-D2: a room with a lesson open is not taken out of use (the teacher ends the lesson first) and nobody in it is moved; once the lesson has ended it is; a room that does not exist is said so", async () => {
    const r = await room();
    const asked = await ask(r, "Cy");
    expect((await manage("admit", { room: r.id, request: asked.body.requestId })).status).toBe(200);
    expect((await manage("disable", { room: r.id })).body.code).toBe("LESSON_IN_PROGRESS");
    expect((await view(r)).disabled).toBe(false);
    expect((await status(r, asked)).body.state).toBe("admitted");
    expect((await manage("end_lesson", { room: r.id }, { now: START + MIN })).status).toBe(200);
    expect((await manage("disable", { room: r.id }, { now: START + 2 * MIN })).body).toMatchObject({ ok: true, inUse: false });
    expect((await manage("enable", { room: `FR-${"0".repeat(32)}` })).body.code).toBe("NO_SUCH_ROOM");
  });

  // Round 8 (2026-11-21): two owners pressing at the same moment, made so: both read before either
  // writes (tests/helpers/read-before-write.mjs). Before, nothing tested this path on its own: the
  // PostgreSQL case only hoped two calls would overlap, and on 11/21 they did not.
  test("FR-C1: two link replacements that both read before either writes give one new link, the other told it changed; two rooms of one name made together give one room; two bulk link lists at once give each room one new link and the other told it changed", async () => {
    const act = (on, action, input) => rooms.manageFixedRoom({ store: on, provider, drive, principal: OWNER, action, input, now: START });
    const bulk = (on, action, input) => rooms.manageFixedRoomsBulk({ store: on, principal: OWNER, action, input, now: START });
    const r = await room();
    const [a, b] = readAllBeforeWriting([store, store]);
    const twice = await Promise.all([act(a, "replace_link", { room: r.id }), act(b, "replace_link", { room: r.id })]);
    expect(twice.map(answer => answer.status).sort()).toEqual([200, 409]);
    expect(twice.find(answer => answer.status === 409).body.code).toBe("CHANGED_CONCURRENTLY");
    const winner = twice.find(answer => answer.status === 200).body;
    expect(winner.generation).toBe(2);
    expect((await ask(r, "Hal", { key: keyOf(winner.link) })).status).toBe(200);
    expect((await ask(r, "Ida")).body.code).toBe("LINK_REPLACED");
    expect((await view(r)).linkGeneration).toBe(2);

    made += 1;
    const label = `Twin ${made}`;
    // Every fact the two requests write, as written (round 9: the loser used to leave a link behind).
    const written = [];
    const recording = inner => new Proxy(inner, {
      get(target, property) {
        if (property !== "transaction") { const value = target[property]; return typeof value === "function" ? value.bind(target) : value; }
        return fn => target.transaction(tx => fn(new Proxy(tx, {
          get(t, p) {
            if (p === "insertEvent") return async event => { const made = await t.insertEvent(event); written.push({ type: event.type, roomId: event.roomId, made }); return made; };
            const value = t[p];
            return typeof value === "function" ? value.bind(t) : value;
          },
        })));
      },
    });
    const [c, d] = readAllBeforeWriting([recording(store), recording(store)]);
    const pair = await Promise.all([act(c, "create", { label }), act(d, "create", { label })]);
    expect(pair.map(answer => answer.status).sort()).toEqual([201, 409]);
    expect(pair.find(answer => answer.status === 409).body.code).toBe("LABEL_TAKEN");
    expect((await rooms.fixedRoomsView({ store, now: START })).filter(entry => entry.label === label)).toHaveLength(1);
    const namedRoom = pair.find(answer => answer.status === 201).body.room.id;
    expect(written.filter(entry => entry.type === "server.room_link" && entry.made).map(entry => entry.roomId)).toEqual([namedRoom]);

    const many = await bulk(store, "create_many", { prefix: `Pair${made}x`, from: 1, to: 6 });
    expect(many.status).toBe(201);
    const ids = many.body.rooms.map(entry => entry.id);
    const [e, f] = readAllBeforeWriting([store, store]);
    const both = await Promise.all([bulk(e, "export_links", { rooms: ids }), bulk(f, "export_links", { rooms: ids })]);
    for (const answer of both) expect(answer.status).toBe(200);
    const links = both.flatMap(answer => answer.body.links);
    const failed = both.flatMap(answer => answer.body.failed);
    expect([links.length, failed.length]).toEqual([6, 6]);
    expect(new Set(links.map(entry => entry.room)).size).toBe(6);
    expect(new Set(links.map(entry => entry.generation))).toEqual(new Set([2]));
    expect(new Set(failed.map(entry => entry.code))).toEqual(new Set(["CHANGED_CONCURRENTLY"]));
  });

  // Round 8 (2026-11-21), Gate B: simulation and security checks of how a person's identity, their
  // consent, the Zoom session and the filing are bound (planning/2026-11-21-gate-b-recording-binding.md).
  // Recording stays off on the site; the switches are turned on inside these tests only. Today a
  // consent belongs to the code a person was let in with (the stand-in for a bound student code).
  // Round 9 (2026-11-22): GB-0 holds the gate to its purpose: with Gate B closed it never shuts out anyone.
  test("GB-0: with Gate B closed the consent gate shuts out nobody: the site's switch off (as on the site), students without any consent enter, before and after a decision and when let in late; a room whose own switch was turned on while the site allowed it, the site's switch then off before anything recorded, lets a late arrival in too", async () => {
    vi.stubEnv("CLASSROOM_FIXED_ROOM_RECORDING", "");
    const off = await inRoom(["Ann", "Kyle"], { consented: [] });
    expect((await manage("set_recording", { room: off.r.id, on: true })).body.code).toBe("RECORDING_NOT_AVAILABLE");
    for (const name of ["Ann", "Kyle"]) expect((await join(off.lessonId, off.asked[name].body.ticket, START + MIN)).status).toBe(200);
    for (const at of [2, 3]) await tick(off.lessonId, at);
    for (const name of ["Ann", "Kyle"]) expect((await join(off.lessonId, off.asked[name].body.ticket, START + 4 * MIN)).status).toBe(200);
    const late = await ask(off.r, "Bo", { now: START + 5 * MIN });
    expect((await manage("admit", { room: off.r.id, request: late.body.requestId }, { now: START + 5 * MIN })).status).toBe(200);
    expect((await join(off.lessonId, late.body.ticket, START + 6 * MIN)).status).toBe(200);
    expect(starts.filter(([id]) => id === off.lessonId)).toEqual([]);
    vi.stubEnv("CLASSROOM_FIXED_ROOM_RECORDING", "on");
    try {
      const turned = await inRoom(["Ann", "Kyle"], { consented: [] });
      expect((await manage("set_recording", { room: turned.r.id, on: true })).status).toBe(200);
      vi.stubEnv("CLASSROOM_FIXED_ROOM_RECORDING", "");
      for (const at of [2, 3]) await tick(turned.lessonId, at);
      const later = await ask(turned.r, "Cy", { now: START + 5 * MIN });
      expect((await manage("admit", { room: turned.r.id, request: later.body.requestId }, { now: START + 5 * MIN })).status).toBe(200);
      expect((await join(turned.lessonId, later.body.ticket, START + 6 * MIN)).status).toBe(200);
      expect(starts.filter(([id]) => id === turned.lessonId)).toEqual([]);
    } finally {
      vi.stubEnv("CLASSROOM_FIXED_ROOM_RECORDING", "");
    }
  });

  test("GB-1: a typed name never carries a consent: another person typing the same names, here or in another room, is a new code without consent and that lesson is not recorded; someone let in without consent while a lesson records gets no token (18.2 step 7), and the recording goes on for the people who consented", async () => {
    vi.stubEnv("CLASSROOM_FIXED_ROOM_RECORDING", "on");
    try {
      const both = await inRoom(["Ann", "Kyle"]);
      await manage("set_recording", { room: both.r.id, on: true });
      const copies = await inRoom(["Ann", "Kyle"], { consented: [] });
      await manage("set_recording", { room: copies.r.id, on: true });
      for (const at of [2, 3]) { await tick(both.lessonId, at); await tick(copies.lessonId, at); }
      expect(starts.filter(([id]) => id === both.lessonId)).toEqual([[both.lessonId, both.sessionId]]);
      expect(starts.filter(([id]) => id === copies.lessonId)).toEqual([]);
      expect(await lastDecision(copies.lessonId)).toMatchObject({ eligible: false, reason: "CONSENT_MISSING" });
      expect(new Set([both.rowOf("Ann").code, copies.rowOf("Ann").code, both.rowOf("Kyle").code, copies.rowOf("Kyle").code]).size).toBe(4);
      // While it records, a third person types "Ann" at the same room and is let in: no consent.
      await fact(both.lessonId, "session.recording_started", START + 4 * MIN, { providerSessionId: both.sessionId, status: "Recording" });
      const third = await ask(both.r, "Ann", { now: START + 5 * MIN });
      expect(third.status).toBe(200);
      expect((await manage("admit", { room: both.r.id, request: third.body.requestId }, { now: START + 5 * MIN })).status).toBe(200);
      const refused = await join(both.lessonId, third.body.ticket, START + 5 * MIN);
      expect(refused).toMatchObject({ status: 403, body: { code: "CONSENT_REQUIRED_FOR_RECORDING_ROOM" } });
      expect(JSON.stringify(refused.body)).not.toMatch(/token/i);
      // The people who consented still enter, and their recording is not stopped for it.
      expect((await join(both.lessonId, both.asked.Kyle.body.ticket, START + 5 * MIN)).status).toBe(200);
      for (const at of [6, 7]) await tick(both.lessonId, at);
      expect(stops.filter(([id]) => id === both.lessonId)).toEqual([]);
      // The site switch turned off while Zoom still says it records: still no token (a recording that
      // may be on keeps the door shut; the switch itself stops nothing already running, see the report).
      vi.stubEnv("CLASSROOM_FIXED_ROOM_RECORDING", "");
      expect((await join(both.lessonId, third.body.ticket, START + 8 * MIN)).body.code).toBe("CONSENT_REQUIRED_FOR_RECORDING_ROOM");
    } finally {
      vi.stubEnv("CLASSROOM_FIXED_ROOM_RECORDING", "");
    }
  });

  test("GB-2: a consent withdrawn while the lesson records makes it decide again and stop", async () => {
    vi.stubEnv("CLASSROOM_FIXED_ROOM_RECORDING", "on");
    try {
      const both = await inRoom(["Ann", "Kyle"]);
      await manage("set_recording", { room: both.r.id, on: true });
      for (const at of [2, 3]) await tick(both.lessonId, at);
      expect(starts.filter(([id]) => id === both.lessonId)).toHaveLength(1);
      await fact(both.lessonId, "session.recording_started", START + 4 * MIN, { providerSessionId: both.sessionId, status: "Recording" });
      await setSyntheticConsent({ store, personCode: both.rowOf("Kyle").code, role: "student", status: "withdrawn", actor: OWNER.email, now: START + 5 * MIN });
      for (const at of [6, 7]) await tick(both.lessonId, at);
      // A live lesson keeps its decision; the withdrawal is written to it and stops the recording.
      expect((await store.eventsFor([both.lessonId])).filter(event => event.type === "server.consent_withdrawn")).toHaveLength(1);
      expect(stops.filter(([id]) => id === both.lessonId).map(([, sessionId]) => sessionId)).toContain(both.sessionId);
    } finally {
      vi.stubEnv("CLASSROOM_FIXED_ROOM_RECORDING", "");
    }
  });

  test("GB-3: consents given under an older policy version do not count once a new version is in force: nothing records", async () => {
    vi.stubEnv("CLASSROOM_FIXED_ROOM_RECORDING", "on");
    try {
      const both = await inRoom(["Ann", "Kyle"]);
      vi.stubEnv("CLASSROOM_CONSENT_VERSION", "test-consent-version-next");
      await manage("set_recording", { room: both.r.id, on: true });
      for (const at of [2, 3]) await tick(both.lessonId, at);
      expect(starts.filter(([id]) => id === both.lessonId)).toEqual([]);
      expect(await lastDecision(both.lessonId)).toMatchObject({ eligible: false, reason: "CONSENT_VERSION_MISMATCH" });
    } finally {
      vi.stubEnv("CLASSROOM_CONSENT_VERSION", "");
      vi.stubEnv("CLASSROOM_FIXED_ROOM_RECORDING", "");
    }
  });

  // Round 9 (2026-11-22), from the independent review of d43aaf1: the gate shuts the door only while
  // the lesson may be capturing. GB-4 and GB-5 are the two cases where round 8's gate shut out a
  // person for nothing; GB-6 the room's own switch.
  test("GB-4: decided (recording allowed) but not recording yet: someone let in without consent enters, and the room then never starts (the start's own check refuses while anyone let in lacks consent)", async () => {
    vi.stubEnv("CLASSROOM_FIXED_ROOM_RECORDING", "on");
    try {
      const waiting = await inRoom(["Ann", "Kyle"], { present: ["Ann"] });
      await manage("set_recording", { room: waiting.r.id, on: true });
      for (const at of [2, 3]) await tick(waiting.lessonId, at);
      expect(await lastDecision(waiting.lessonId)).toMatchObject({ eligible: true });
      expect(starts.filter(([id]) => id === waiting.lessonId)).toEqual([]);
      const bo = await ask(waiting.r, "Bo", { now: START + 4 * MIN });
      expect((await manage("admit", { room: waiting.r.id, request: bo.body.requestId }, { now: START + 4 * MIN })).status).toBe(200);
      expect((await join(waiting.lessonId, bo.body.ticket, START + 4 * MIN)).status).toBe(200);
      const lesson = await store.lesson(waiting.lessonId);
      await fact(waiting.lessonId, "session.user_joined", START + 5 * MIN, { providerSessionId: waiting.sessionId, participantId: waiting.rowOf("Kyle").id });
      await fact(waiting.lessonId, "session.user_joined", START + 5 * MIN, { providerSessionId: waiting.sessionId, participantId: lesson.participants.find(entry => entry.code !== waiting.rowOf("Ann").code && entry.code !== waiting.rowOf("Kyle").code).id });
      for (const at of [6, 7, 8]) await tick(waiting.lessonId, at);
      expect(starts.filter(([id]) => id === waiting.lessonId)).toEqual([]);
    } finally {
      vi.stubEnv("CLASSROOM_FIXED_ROOM_RECORDING", "");
    }
  });

  test("GB-5: once Zoom confirmed the stop (a consent withdrawn), someone let in without consent enters, and nothing starts again", async () => {
    vi.stubEnv("CLASSROOM_FIXED_ROOM_RECORDING", "on");
    try {
      const both = await inRoom(["Ann", "Kyle"]);
      await manage("set_recording", { room: both.r.id, on: true });
      for (const at of [2, 3]) await tick(both.lessonId, at);
      await fact(both.lessonId, "session.recording_started", START + 4 * MIN, { providerSessionId: both.sessionId, status: "Recording" });
      const early = await ask(both.r, "Bo", { now: START + 4 * MIN });
      expect((await manage("admit", { room: both.r.id, request: early.body.requestId }, { now: START + 4 * MIN })).status).toBe(200);
      expect((await join(both.lessonId, early.body.ticket, START + 4 * MIN)).body.code).toBe("CONSENT_REQUIRED_FOR_RECORDING_ROOM");
      await setSyntheticConsent({ store, personCode: both.rowOf("Kyle").code, role: "student", status: "withdrawn", actor: OWNER.email, now: START + 5 * MIN });
      await tick(both.lessonId, 6);
      expect(stops.filter(([id]) => id === both.lessonId).map(([, sessionId]) => sessionId)).toContain(both.sessionId);
      // Asked to stop, not yet confirmed by Zoom: it may still be recording, so still no token.
      expect((await join(both.lessonId, early.body.ticket, START + 6.5 * MIN)).body.code).toBe("CONSENT_REQUIRED_FOR_RECORDING_ROOM");
      await fact(both.lessonId, "session.recording_stopped", START + 7 * MIN, { providerSessionId: both.sessionId, status: "Stopped" });
      expect((await join(both.lessonId, early.body.ticket, START + 8 * MIN)).status).toBe(200);
      for (const at of [9, 10]) await tick(both.lessonId, at);
      expect(starts.filter(([id]) => id === both.lessonId)).toHaveLength(1);
    } finally {
      vi.stubEnv("CLASSROOM_FIXED_ROOM_RECORDING", "");
    }
  });

  test("GB-6: the site's switch on and the room's own switch off: nobody is shut out and nothing records", async () => {
    vi.stubEnv("CLASSROOM_FIXED_ROOM_RECORDING", "on");
    try {
      const room = await inRoom(["Ann", "Kyle"], { consented: [] });
      for (const at of [2, 3]) await tick(room.lessonId, at);
      const cy = await ask(room.r, "Cy", { now: START + 4 * MIN });
      expect((await manage("admit", { room: room.r.id, request: cy.body.requestId }, { now: START + 4 * MIN })).status).toBe(200);
      for (const ticket of [room.asked.Ann.body.ticket, cy.body.ticket]) expect((await join(room.lessonId, ticket, START + 5 * MIN)).status).toBe(200);
      expect(starts.filter(([id]) => id === room.lessonId)).toEqual([]);
    } finally {
      vi.stubEnv("CLASSROOM_FIXED_ROOM_RECORDING", "");
    }
  });

  // Round 10 (2026-11-22), Gate B engineering, policy neutral and off on the site: a student on a
  // room's list is let in as that student, by their own pass (option A) or the owner's word (option B),
  // so their code in the lesson is the code their consent is kept under. Which option, who is on a
  // list and how a pass reaches a student are the Gate B decision's; the switches go on in tests only.
  let studentsMade = 0;
  const studentCode = () => `ST-${made}-${++studentsMade}`;
  const passOf = link => new URLSearchParams(link.split("#")[1]).get("p");
  const askWithPass = (r, pass, now = START) => rooms.requestEntry({ store, roomId: r.id, key: null, name: null, pass, now });
  const sortedPairs = rows => rows.map(row => JSON.stringify(row)).sort();
  // A room whose students are on its list, each let in as that student, those named consented, and
  // its lesson's Zoom session live with everyone in it.
  async function boundRoom(students, { consented = students.map(student => student.code), by = "pass" } = {}) {
    const r = await room();
    const passes = {};
    for (const student of students) {
      const added = await manage("add_member", { room: r.id, code: student.code, name: student.name });
      expect(added.status, JSON.stringify(added.body)).toBe(201);
      passes[student.code] = passOf(added.body.passLink);
    }
    const asked = {};
    for (const student of students) {
      asked[student.code] = by === "pass" ? await askWithPass(r, passes[student.code]) : await ask(r, student.name);
      expect(asked[student.code].status, JSON.stringify(asked[student.code].body)).toBe(200);
      const admitted = await manage("admit", { room: r.id, request: asked[student.code].body.requestId, ...(by === "owner" ? { bindTo: student.code } : {}) });
      expect(admitted.body, JSON.stringify(admitted.body)).toMatchObject({ ok: true, code: student.code, student: student.code });
    }
    const lessonId = (await status(r, asked[students[0].code])).body.lessonId;
    const lesson = await store.lesson(lessonId);
    const rowOf = code => lesson.participants.find(entry => entry.code === code);
    for (const code of consented) await setSyntheticConsent({ store, personCode: code, role: "student", status: "granted", actor: OWNER.email, now: START - 30 * MIN });
    const sessionId = `ZS-${lessonId.slice(2, 10)}`;
    await fact(lessonId, "session.started", START + MIN, { providerSessionId: sessionId, sessionName: roomNameOf(lessonId, 0) });
    for (const student of students) await fact(lessonId, "session.user_joined", START + MIN, { providerSessionId: sessionId, participantId: rowOf(student.code).id });
    return { r, lessonId, sessionId, rowOf, asked, passes };
  }
  const completed = (both, id, from, to) => store.transaction(tx => storeEvent(tx, {
    source: "zoom_api", type: "session.recording_completed", lessonId: both.lessonId, provider: "synthetic", providerSessionId: both.sessionId, sessionName: roomNameOf(both.lessonId, 0),
    occurredAt: to + 5 * MIN, receivedAt: to + 5 * MIN, key: `session.recording_completed:${id}`,
    files: [{ providerFileId: id, kind: "composite", extension: "mp4", size: 1000, status: "completed", recordingStart: from, recordingEnd: to }],
  }));

  test("GB-7: a student's own pass (option A): nothing of it with the site's switch off; made once and kept as its hash; the request carries the list's name, none typed; let in, the person's code is the student's code, under which their consent is kept, so two consented students record; files are named by the list's names, or by codes where the site says so", async () => {
    vi.stubEnv("CLASSROOM_FIXED_ROOM_RECORDING", "");
    const closed = await room();
    // With Gate B closed the list's actions are unknown, as before round 10 (review finding 6).
    const unknown = await manage("add_member", { room: closed.id, code: "ST-closed", name: "Ann" });
    expect(unknown.body.code).toBe("INVALID_ACTION");
    expect(unknown.body.error).toBe("Use one of: create, replace_link, admit, decline, remove, end_lesson, set_recording, disable, enable");
    expect((await askWithPass(closed, "a".repeat(43))).status).toBe(404);
    // A pass sent with the room's current link is ignored: the request is what it was before Gate B.
    expect((await rooms.requestEntry({ store, roomId: closed.id, key: closed.key, name: "Ann", pass: "a".repeat(43), now: START })).body).toMatchObject({ ok: true, name: "Ann" });
    expect((await view(closed)).members).toBeUndefined();
    vi.stubEnv("CLASSROOM_FIXED_ROOM_RECORDING", "on");
    try {
      const ann = { code: studentCode(), name: "Ann" }, bo = { code: studentCode(), name: "Bo" };
      const both = await boundRoom([ann, bo]);
      for (const pass of Object.values(both.passes)) expect(pass).toMatch(/^[A-Za-z0-9_-]{43}$/);
      const roomFacts = JSON.stringify(await store.eventsFor([both.r.id]));
      for (const pass of Object.values(both.passes)) expect(roomFacts).not.toContain(pass);
      expect(both.asked[ann.code].body.name).toBe("Ann");
      expect((await view(both.r)).members.map(({ code, name }) => ({ code, name }))).toEqual([ann, bo].sort((a, b) => a.code.localeCompare(b.code)));
      expect((await view(both.r)).members.every(member => member.passIssuedAt === new Date(START).toISOString())).toBe(true);
      const decisions = (await store.eventsFor([both.r.id])).filter(event => event.type === "server.room_decision");
      expect(sortedPairs(decisions.map(event => [event.code, event.personCode, event.boundName, event.boundBy]))).toEqual(sortedPairs([[ann.code, ann.code, "Ann", "pass"], [bo.code, bo.code, "Bo", "pass"]]));
      expect(sortedPairs((await view(both.r)).inRoom.map(person => [person.code, person.student, person.boundBy, person.consent]))).toEqual(sortedPairs([[ann.code, ann.code, "pass", "CONSENTED"], [bo.code, bo.code, "pass", "CONSENTED"]]));
      await manage("set_recording", { room: both.r.id, on: true });
      for (const at of [2, 3]) await tick(both.lessonId, at);
      expect(starts.filter(([id]) => id === both.lessonId)).toEqual([[both.lessonId, both.sessionId]]);
      expect(await lastDecision(both.lessonId)).toMatchObject({ eligible: true, reason: "ALL_CONSENTED" });
      const named = `GB7-${made}-A`, coded = `GB7-${made}-B`;
      await completed(both, named, START + 4 * MIN, START + 30 * MIN);
      expect((await store.fileRecord(named)).plannedName).toBe(`${both.r.label}_2026-12-10 1004_Ann-Bo.mp4`);
      vi.stubEnv("CLASSROOM_FIXED_ROOM_FILE_NAMES", "codes");
      await completed(both, coded, START + 35 * MIN, START + 50 * MIN);
      const codes = [ann.code, bo.code].map(code => code.replace(/[^A-Za-z0-9 .']/g, "")).sort((a, b) => a.localeCompare(b)).join("-");
      expect((await store.fileRecord(coded)).plannedName).toBe(`${both.r.label}_2026-12-10 1035_${codes}.mp4`);
      vi.stubEnv("CLASSROOM_FIXED_ROOM_FILE_NAMES", "none");
      const bare = `GB7-${made}-C`;
      await completed(both, bare, START + 55 * MIN, START + 58 * MIN);
      expect((await store.fileRecord(bare)).plannedName).toBe(`${both.r.label}_2026-12-10 1055.mp4`);
    } finally {
      vi.stubEnv("CLASSROOM_FIXED_ROOM_RECORDING", "");
      vi.stubEnv("CLASSROOM_FIXED_ROOM_FILE_NAMES", "");
    }
  });

  test("GB-8: the owner says which student on the list a person asking with the room's link is (option B): only a student on the list, only with the site's switch on; a pass's request is never bound to another student; one student never has two places in a lesson; not bound, a code of its own as before", async () => {
    vi.stubEnv("CLASSROOM_FIXED_ROOM_RECORDING", "on");
    try {
      const r = await room();
      const kyle = { code: studentCode(), name: "Kyle" }, ann = { code: studentCode(), name: "Ann" };
      const passes = {};
      for (const student of [kyle, ann]) passes[student.code] = passOf((await manage("add_member", { room: r.id, ...student })).body.passLink);
      const typed = await ask(r, "Kyle");
      expect((await view(r)).waiting.find(person => person.request === typed.body.requestId).student).toBeNull();
      expect((await manage("admit", { room: r.id, request: typed.body.requestId, bindTo: "ST-nobody" })).body.code).toBe("NO_SUCH_MEMBER");
      // The site's switch off: the owner's word is ignored (nothing records), and the person is let in
      // with a code of their own, as before Gate B (review finding 6).
      const other = await ask(r, "Lu");
      vi.stubEnv("CLASSROOM_FIXED_ROOM_RECORDING", "");
      const ignored = await manage("admit", { room: r.id, request: other.body.requestId, bindTo: kyle.code });
      expect(ignored.body.code).toMatch(/^R[0-9a-f]{8}-[0-9a-f]{6}$/);
      expect(ignored.body.student).toBeUndefined();
      vi.stubEnv("CLASSROOM_FIXED_ROOM_RECORDING", "on");
      expect((await manage("admit", { room: r.id, request: typed.body.requestId, bindTo: kyle.code })).body).toMatchObject({ ok: true, code: kyle.code, student: kyle.code });
      const ownerFact = (await store.eventsFor([r.id])).find(event => event.type === "server.room_decision" && event.requestId === typed.body.requestId);
      expect(ownerFact).toMatchObject({ personCode: kyle.code, boundName: "Kyle", boundBy: "owner", actor: OWNER.email });
      // Kyle again: by another typed request, or by his own pass: he already has a place.
      const again = await ask(r, "Kyle");
      expect((await manage("admit", { room: r.id, request: again.body.requestId, bindTo: kyle.code })).body.code).toBe("ALREADY_IN_LESSON");
      const ownPass = await askWithPass(r, passes[kyle.code]);
      expect((await manage("admit", { room: r.id, request: ownPass.body.requestId })).body.code).toBe("ALREADY_IN_LESSON");
      // Ann's own pass is Ann: never bound to another student.
      const annAsked = await askWithPass(r, passes[ann.code]);
      expect((await view(r)).waiting.find(person => person.request === annAsked.body.requestId).student).toBe(ann.code);
      expect((await manage("admit", { room: r.id, request: annAsked.body.requestId, bindTo: kyle.code })).body.code).toBe("ALREADY_BOUND");
      expect((await manage("admit", { room: r.id, request: annAsked.body.requestId, bindTo: ann.code })).body).toMatchObject({ ok: true, code: ann.code });
      const guest = await ask(r, "Cy");
      const plain = await manage("admit", { room: r.id, request: guest.body.requestId });
      expect(plain.body.code).toMatch(/^R[0-9a-f]{8}-[0-9a-f]{6}$/);
      expect(plain.body.student).toBeUndefined();
      expect((await view(r)).inRoom.find(person => person.request === guest.body.requestId)).toMatchObject({ student: null, consent: "CONSENT_MISSING" });
    } finally {
      vi.stubEnv("CLASSROOM_FIXED_ROOM_RECORDING", "");
    }
  });

  test("GB-8b: a student taken out of the room cannot come back into the same lesson with their pass or by the owner's word (their place in it is gone); the room's next lesson lets them in", async () => {
    vi.stubEnv("CLASSROOM_FIXED_ROOM_RECORDING", "on");
    try {
      const r = await room();
      const kyle = { code: studentCode(), name: "Kyle" };
      const pass = passOf((await manage("add_member", { room: r.id, ...kyle })).body.passLink);
      const first = await askWithPass(r, pass);
      expect((await manage("admit", { room: r.id, request: first.body.requestId })).body).toMatchObject({ ok: true, code: kyle.code });
      expect((await manage("remove", { room: r.id, request: first.body.requestId })).status).toBe(200);
      const again = await askWithPass(r, pass, START + MIN);
      expect((await manage("admit", { room: r.id, request: again.body.requestId }, { now: START + MIN })).body.code).toBe("ALREADY_IN_LESSON");
      const typed = await ask(r, "Kyle", { now: START + MIN });
      expect((await manage("admit", { room: r.id, request: typed.body.requestId, bindTo: kyle.code }, { now: START + MIN })).body.code).toBe("ALREADY_IN_LESSON");
      expect((await manage("end_lesson", { room: r.id }, { now: START + 2 * MIN })).status).toBe(200);
      const next = await askWithPass(r, pass, START + 3 * MIN);
      expect((await manage("admit", { room: r.id, request: next.body.requestId }, { now: START + 3 * MIN })).body).toMatchObject({ ok: true, code: kyle.code });
    } finally {
      vi.stubEnv("CLASSROOM_FIXED_ROOM_RECORDING", "");
    }
  });

  test("GB-9: a pass reissued, or a student taken off the list: the old pass is the same as no room, a request made with it and still waiting is no longer valid, someone let in stays; two changes to the list at the same moment: one made, the other said; codes and names are checked; with the site's switch off nothing of the list answers", async () => {
    vi.stubEnv("CLASSROOM_FIXED_ROOM_RECORDING", "on");
    try {
      const r = await room();
      const ann = { code: studentCode(), name: "Ann" }, bo = { code: studentCode(), name: "Bo" };
      const annAdded = await manage("add_member", { room: r.id, ...ann });
      const boAdded = await manage("add_member", { room: r.id, ...bo });
      expect(annAdded.body.passLink).toMatch(new RegExp(`^/classroom/r/${r.id}#p=[A-Za-z0-9_-]{43}$`));
      expect((await manage("add_member", { room: r.id, code: ann.code.toLowerCase(), name: "Ann" })).body.code).toBe("MEMBER_EXISTS");
      for (const bad of ["", "R0123abcd-0a1b2c", "R0123ABCD-0A1B2C", "has space", "x".repeat(21), "小明", "a/b"]) expect((await manage("add_member", { room: r.id, code: bad, name: "Ann" })).body.code, bad).toBe("INVALID_CODE");
      expect((await manage("add_member", { room: r.id, code: studentCode(), name: "小明" })).body.code).toBe("INVALID_NAME");
      const oldPass = passOf(annAdded.body.passLink);
      const waitingOld = await askWithPass(r, oldPass);
      expect((await status(r, waitingOld)).body.state).toBe("waiting");
      const reissued = await manage("reissue_pass", { room: r.id, code: ann.code });
      expect(reissued.status).toBe(200);
      const newPass = passOf(reissued.body.passLink);
      expect(newPass).not.toBe(oldPass);
      expect((await askWithPass(r, oldPass)).status).toBe(404);
      expect((await status(r, waitingOld)).body.state).toBe("replaced");
      expect((await manage("admit", { room: r.id, request: waitingOld.body.requestId })).body.code).toBe("NOT_WAITING");
      const fresh = await askWithPass(r, newPass);
      expect((await manage("admit", { room: r.id, request: fresh.body.requestId })).body).toMatchObject({ ok: true, code: ann.code });
      const boWaiting = await askWithPass(r, passOf(boAdded.body.passLink));
      for (const code of [ann.code, bo.code]) expect((await manage("remove_member", { room: r.id, code })).status).toBe(200);
      expect((await askWithPass(r, newPass)).status).toBe(404);
      expect((await status(r, fresh)).body.state).toBe("admitted");
      expect((await status(r, boWaiting)).body.state).toBe("replaced");
      for (const action of ["remove_member", "reissue_pass"]) expect((await manage(action, { room: r.id, code: bo.code })).body.code, action).toBe("NO_SUCH_MEMBER");
      // Taken off and put back: a new pass; the old one stays dead.
      const back = await manage("add_member", { room: r.id, ...bo });
      expect(back.status).toBe(201);
      expect((await askWithPass(r, passOf(boAdded.body.passLink))).status).toBe(404);
      expect((await askWithPass(r, passOf(back.body.passLink))).status).toBe(200);
      const [x, y] = readAllBeforeWriting([store, store]);
      const raced = await Promise.all([
        rooms.manageFixedRoom({ store: x, provider, drive, principal: OWNER, action: "add_member", input: { room: r.id, code: studentCode(), name: "Cy" }, now: START }),
        rooms.manageFixedRoom({ store: y, provider, drive, principal: OWNER, action: "add_member", input: { room: r.id, code: studentCode(), name: "Di" }, now: START }),
      ]);
      expect(raced.map(answer => answer.status).sort()).toEqual([201, 409]);
      expect(raced.find(answer => answer.status === 409).body.code).toBe("ROSTER_CHANGED");
      // A pass request made while the switch was on, let in after it went off: a code of its own.
      const waitingThen = await askWithPass(r, passOf(back.body.passLink));
      expect(waitingThen.status).toBe(200);
      vi.stubEnv("CLASSROOM_FIXED_ROOM_RECORDING", "");
      for (const action of ["add_member", "reissue_pass", "remove_member"]) expect((await manage(action, { room: r.id, code: bo.code, name: "Bo" })).body.code, action).toBe("INVALID_ACTION");
      expect((await askWithPass(r, passOf(back.body.passLink))).status).toBe(404);
      const shown = await view(r);
      expect(shown.members).toBeUndefined();
      expect(shown.inRoom.every(person => !("student" in person) && !("consent" in person) && !("boundBy" in person))).toBe(true);
      expect(shown.waiting.every(person => !("student" in person))).toBe(true);
      expect(Object.keys(shown.recording).sort()).toEqual(["available", "on"]);
      const lateLetIn = await manage("admit", { room: r.id, request: waitingThen.body.requestId });
      expect(lateLetIn.body.code).toMatch(/^R[0-9a-f]{8}-[0-9a-f]{6}$/);
      expect(lateLetIn.body.student).toBeUndefined();
    } finally {
      vi.stubEnv("CLASSROOM_FIXED_ROOM_RECORDING", "");
    }
  });

  test("GB-10: a room's list holds at most 100 students", { timeout: 120_000 }, async () => {
    vi.stubEnv("CLASSROOM_FIXED_ROOM_RECORDING", "on");
    try {
      const r = await room();
      for (let n = 0; n < rooms.ROSTER_MAX; n += 1) expect((await manage("add_member", { room: r.id, code: `${r.id.slice(3, 9)}-${n}`, name: "Ann" })).status).toBe(201);
      expect((await manage("add_member", { room: r.id, code: `${r.id.slice(3, 9)}-x`, name: "Ann" })).body.code).toBe("ROSTER_FULL");
    } finally {
      vi.stubEnv("CLASSROOM_FIXED_ROOM_RECORDING", "");
    }
  });

  test("GB-11: a bound student's consent withdrawn while the room records: the room stops; when Zoom never confirms the stop, the session is ended and, still unconfirmed, an error is raised for the owners (WITHDRAWAL_STOP_UNCONFIRMED, noted as their notice) and shown on the room; Zoom's confirmation clears it", async () => {
    vi.stubEnv("CLASSROOM_FIXED_ROOM_RECORDING", "on");
    try {
      const ann = { code: studentCode(), name: "Ann" }, bo = { code: studentCode(), name: "Bo" };
      const both = await boundRoom([ann, bo], { by: "owner" });
      await manage("set_recording", { room: both.r.id, on: true });
      for (const at of [2, 3]) await tick(both.lessonId, at);
      await fact(both.lessonId, "session.recording_started", START + 4 * MIN, { providerSessionId: both.sessionId, status: "Recording" });
      expect((await view(both.r, START + 4.5 * MIN)).recording).toMatchObject({ on: true, available: true, status: "RECORDING" });
      await setSyntheticConsent({ store, personCode: bo.code, role: "student", status: "withdrawn", actor: OWNER.email, now: START + 5 * MIN });
      expect((await view(both.r, START + 5 * MIN)).inRoom.find(person => person.code === bo.code).consent).toBe("CONSENT_WITHDRAWN");
      for (const at of [6, 7, 8, 9, 10]) await tick(both.lessonId, at);
      expect(stops.filter(([id]) => id === both.lessonId).map(([, sessionId]) => sessionId)).toContain(both.sessionId);
      expect(calls.filter(([kind, id]) => kind === "end" && id === both.lessonId).length).toBeGreaterThan(0);
      const notices = (await store.eventsFor([both.lessonId])).filter(event => event.type === "server.admin_notified").map(event => event.code);
      expect(notices).toContain("WITHDRAWAL_STOP_UNCONFIRMED");
      expect((await view(both.r, START + 10 * MIN)).recording.anomalies.map(entry => entry.code)).toContain("WITHDRAWAL_STOP_UNCONFIRMED");
      await fact(both.lessonId, "session.recording_stopped", START + 11 * MIN, { providerSessionId: both.sessionId, status: "Stopped" });
      expect((await view(both.r, START + 11.5 * MIN)).recording.anomalies.map(entry => entry.code)).not.toContain("WITHDRAWAL_STOP_UNCONFIRMED");
    } finally {
      vi.stubEnv("CLASSROOM_FIXED_ROOM_RECORDING", "");
    }
  });

  test("GB-12: a fixed room's recording told twice (the same notice again, and once more under another key) is one recording, filed once; a Drive failure is tried again and then filed; a destination shared beyond the policy is refused before anything is uploaded", async () => {
    vi.stubEnv("CLASSROOM_FIXED_ROOM_RECORDING", "on");
    try {
      const ann = { code: studentCode(), name: "Ann" }, bo = { code: studentCode(), name: "Bo" };
      const both = await boundRoom([ann, bo]);
      await manage("set_recording", { room: both.r.id, on: true });
      for (const at of [2, 3]) await tick(both.lessonId, at);
      const id = `GB12-${made}`;
      await completed(both, id, START + 4 * MIN, START + 30 * MIN);
      await completed(both, id, START + 4 * MIN, START + 30 * MIN);
      await store.transaction(tx => storeEvent(tx, {
        source: "zoom_webhook", type: "session.recording_completed", lessonId: both.lessonId, provider: "synthetic", providerSessionId: both.sessionId, sessionName: roomNameOf(both.lessonId, 0),
        occurredAt: START + 36 * MIN, receivedAt: START + 36 * MIN, key: `session.recording_completed:${id}:again`,
        files: [{ providerFileId: id, kind: "composite", extension: "mp4", size: 1000, status: "completed", recordingStart: START + 4 * MIN, recordingEnd: START + 30 * MIN }],
      }));
      expect((await store.filings([both.lessonId])).map(row => row.record.providerFileId)).toEqual([id]);
      const fake = createDrive();
      fake.failNext("startUpload", "TRANSIENT");
      const run = now => processJobs({
        store, now, workerId: "gb12", handlers: {
          file_recording: input => fileRecording({ store, drive: fake, download: async (record, { start, end }) => syntheticContent(record.providerFileId, start, end), rootFolderId: fake.rootFolderId, ...input }),
          delete_vendor_copy: async ({ job, leaseVersion }) => ({ status: (await store.completeJob({ jobId: job.id, leaseVersion })) ? "DONE" : "LEASE_LOST" }),
        },
      });
      await run(START + 60 * MIN);
      expect((await store.fileRecord(id)).status).not.toBe("STORED");
      await run(START + 70 * MIN);
      expect((await store.fileRecord(id)).status).toBe("STORED");
      const lesson = await store.lesson(both.lessonId);
      const folder = fake.ensureFolder(fake.ensureFolder(fake.rootFolderId, Core.monthlyFolderName(lesson.date)), both.r.label);
      expect(await fake.listNames(folder)).toEqual([`${both.r.label}_2026-12-10 1004_Ann-Bo.mp4`]);
      // Another room's recording, its month folder shared with anyone who has the link: nothing uploaded.
      const other = await boundRoom([{ code: studentCode(), name: "Cy" }, { code: studentCode(), name: "Di" }]);
      await manage("set_recording", { room: other.r.id, on: true });
      for (const at of [2, 3]) await tick(other.lessonId, at);
      const shared = `GB12-${made}-shared`;
      await completed(other, shared, START + 4 * MIN, START + 30 * MIN);
      const sharedDrive = createDrive();
      sharedDrive.share(sharedDrive.ensureFolder(sharedDrive.rootFolderId, Core.monthlyFolderName((await store.lesson(other.lessonId)).date)), { type: "anyone", role: "reader" });
      await processJobs({
        store, now: START + 80 * MIN, workerId: "gb12-shared", handlers: {
          file_recording: input => fileRecording({ store, drive: sharedDrive, download: async (record, { start, end }) => syntheticContent(record.providerFileId, start, end), rootFolderId: sharedDrive.rootFolderId, ...input }),
          delete_vendor_copy: async ({ job, leaseVersion }) => ({ status: (await store.completeJob({ jobId: job.id, leaseVersion })) ? "DONE" : "LEASE_LOST" }),
        },
      });
      expect(sharedDrive.counters.sessionsStarted).toBe(0);
      expect((await store.fileRecord(shared)).status).not.toBe("STORED");
      const [row] = (await store.filings([other.lessonId])).filter(entry => entry.record.providerFileId === shared);
      expect(row.job.blockedReason).toBe("DRIVE_SHARING");
    } finally {
      vi.stubEnv("CLASSROOM_FIXED_ROOM_RECORDING", "");
    }
  });

  // Round 10, after the independent review of 500d20b.
  // A store whose addLessonParticipant first lets another owner change the list (the race the review found).
  const listChangedMeanwhile = change => new Proxy(store, {
    get(target, property) {
      if (property === "addLessonParticipant") return async input => { await change(); return target.addLessonParticipant(input); };
      const value = target[property];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const admitWith = (on, r, request, extra = {}) => rooms.manageFixedRoom({ store: on, provider, drive, principal: OWNER, action: "admit", input: { room: r.id, request, ...extra }, now: START });

  test("GB-13: let in on a list that changed at the same moment (the student's pass reissued, or the student taken off the list): the admission is undone and said, the person is out and their key leads nowhere", async () => {
    vi.stubEnv("CLASSROOM_FIXED_ROOM_RECORDING", "on");
    try {
      const r = await room();
      const kyle = { code: studentCode(), name: "Kyle" }, ann = { code: studentCode(), name: "Ann" };
      const passes = {};
      for (const student of [kyle, ann]) passes[student.code] = passOf((await manage("add_member", { room: r.id, ...student })).body.passLink);
      const leaked = await askWithPass(r, passes[kyle.code]);
      const reissued = await admitWith(listChangedMeanwhile(() => manage("reissue_pass", { room: r.id, code: kyle.code })), r, leaked.body.requestId);
      expect(reissued.body.code).toBe("BINDING_CHANGED");
      expect((await status(r, leaked)).body.state).toBe("removed");
      expect((await view(r)).inRoom.map(person => person.code)).not.toContain(kyle.code);
      const lessonId = (await view(r)).lesson?.lessonId;
      if (lessonId) expect((await join(lessonId, leaked.body.ticket)).status).not.toBe(200);
      // Option B racing a removal from the list.
      const typed = await ask(r, "Ann");
      const removed = await admitWith(listChangedMeanwhile(() => manage("remove_member", { room: r.id, code: ann.code })), r, typed.body.requestId, { bindTo: ann.code });
      expect(removed.body.code).toBe("BINDING_CHANGED");
      expect((await status(r, typed)).body.state).toBe("removed");
      expect((await view(r)).inRoom).toEqual([]);
    } finally {
      vi.stubEnv("CLASSROOM_FIXED_ROOM_RECORDING", "");
    }
  });

  test("GB-14: one code is one student across the rooms: on another room's list only the same code with the same name; let in to one room's lesson at a time; let in to two rooms at the same moment, exactly one stays", async () => {
    vi.stubEnv("CLASSROOM_FIXED_ROOM_RECORDING", "on");
    try {
      const a = await room(), b = await room();
      const code = studentCode();
      const inA = await manage("add_member", { room: a.id, code, name: "Ann" });
      expect(inA.status).toBe(201);
      expect((await manage("add_member", { room: b.id, code, name: "Bo" })).body.code).toBe("CODE_NAME_MISMATCH");
      expect((await manage("add_member", { room: b.id, code: code.toLowerCase(), name: "Ann" })).body.code).toBe("CODE_NAME_MISMATCH");
      const inB = await manage("add_member", { room: b.id, code, name: "Ann" });
      expect(inB.status).toBe(201);
      const askA = await askWithPass(a, passOf(inA.body.passLink));
      expect((await manage("admit", { room: a.id, request: askA.body.requestId })).body).toMatchObject({ ok: true, code });
      const askB = await askWithPass(b, passOf(inB.body.passLink));
      expect((await manage("admit", { room: b.id, request: askB.body.requestId })).body.code).toBe("ALREADY_IN_ANOTHER_ROOM");
      expect((await status(b, askB)).body.state).toBe("waiting");
      // Two other rooms let the same student in at the same moment (both looked before either wrote).
      const c = await room(), d = await room();
      const both = studentCode();
      const passC = passOf((await manage("add_member", { room: c.id, code: both, name: "Cy" })).body.passLink);
      const passD = passOf((await manage("add_member", { room: d.id, code: both, name: "Cy" })).body.passLink);
      const askC = await askWithPass(c, passC), askD = await askWithPass(d, passD);
      const [x, y] = readAllBeforeWriting([store, store]);
      const answers = await Promise.all([admitWith(x, c, askC.body.requestId), admitWith(y, d, askD.body.requestId)]);
      expect(answers.map(answer => answer.status).sort()).toEqual([200, 409]);
      expect(answers.find(answer => answer.status === 409).body.code).toBe("ALREADY_IN_ANOTHER_ROOM");
      const seated = [await view(c), await view(d)].filter(entry => entry.inRoom.some(person => person.code === both));
      expect(seated).toHaveLength(1);
      // The one kept is the earlier admission (the same moment: the smaller request id).
      expect(seated[0].id).toBe(askC.body.requestId < askD.body.requestId ? c.id : d.id);
    } finally {
      vi.stubEnv("CLASSROOM_FIXED_ROOM_RECORDING", "");
    }
  });

  test("GB-15: in Zoom and on their page a student let in as themselves shows by a name of this lesson only, never their code (their consent's); the same name every time they enter; anyone let in with a code of their own shows by that code", async () => {
    vi.stubEnv("CLASSROOM_FIXED_ROOM_RECORDING", "on");
    try {
      const ann = { code: studentCode(), name: "Ann" }, bo = { code: studentCode(), name: "Bo" };
      const both = await boundRoom([ann, bo]);
      const first = await join(both.lessonId, both.asked[ann.code].body.ticket, START + MIN);
      expect(first.status).toBe(200);
      expect(first.body.participantCode).toMatch(/^R[0-9a-f]{8}-[0-9a-f]{6}$/);
      expect(first.body.participantCode).not.toBe(ann.code);
      expect((await join(both.lessonId, both.asked[ann.code].body.ticket, START + 2 * MIN)).body.participantCode).toBe(first.body.participantCode);
      const boShown = (await join(both.lessonId, both.asked[bo.code].body.ticket, START + MIN)).body.participantCode;
      expect(boShown).not.toBe(first.body.participantCode);
      expect(JSON.stringify(first.body)).not.toContain(ann.code);
      // The owner still sees the student's code; a guest shows by their own code everywhere.
      expect((await view(both.r)).inRoom.map(person => person.code).sort()).toEqual([ann.code, bo.code].sort());
      const guest = await ask(both.r, "Cy");
      const plain = await manage("admit", { room: both.r.id, request: guest.body.requestId });
      expect((await join(both.lessonId, guest.body.ticket, START + MIN)).body.participantCode).toBe(plain.body.code);
    } finally {
      vi.stubEnv("CLASSROOM_FIXED_ROOM_RECORDING", "");
    }
  });

  test("GB-16: someone without consent let in and then taken out still counts for this lesson's recording rule, and the owners' view says so (not only the people in the room now)", async () => {
    vi.stubEnv("CLASSROOM_FIXED_ROOM_RECORDING", "on");
    try {
      const ann = { code: studentCode(), name: "Ann" }, bo = { code: studentCode(), name: "Bo" }, di = { code: studentCode(), name: "Di" };
      const both = await boundRoom([ann, bo, di]);
      await manage("set_recording", { room: both.r.id, on: true });
      const cy = await ask(both.r, "Cy");
      const cyCode = (await manage("admit", { room: both.r.id, request: cy.body.requestId })).body.code;
      expect((await view(both.r)).recording.consentLacking).toEqual({ inRoom: 1, takenOut: [] });
      expect((await manage("remove", { room: both.r.id, request: cy.body.requestId })).status).toBe(200);
      // Di, consented, taken out too: their consent is read as well, so they are never said to lack one
      // (mutation R7 of round 10 read consent only for the people in the room now).
      expect((await manage("remove", { room: both.r.id, request: both.asked[di.code].body.requestId })).status).toBe(200);
      for (const at of [2, 3]) await tick(both.lessonId, at);
      expect(await lastDecision(both.lessonId)).toMatchObject({ eligible: false, reason: "CONSENT_MISSING" });
      const shown = await view(both.r, START + 4 * MIN);
      expect(shown.inRoom.map(person => person.code).sort()).toEqual([ann.code, bo.code].sort());
      expect(shown.recording.consentLacking).toEqual({ inRoom: 0, takenOut: [cyCode] });
    } finally {
      vi.stubEnv("CLASSROOM_FIXED_ROOM_RECORDING", "");
    }
  });
});
