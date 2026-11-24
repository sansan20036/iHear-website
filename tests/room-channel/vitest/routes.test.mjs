import { afterAll, beforeEach, describe, expect, test, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// The room channel through its two routes, and who it takes a caller to be (2026-11-23). The file
// store, a scripted stand-in for Zoom, synthetic people only. Local logic: it says nothing about
// real Zoom, a real database or the production site.
//   npx vitest run tests/room-channel/vitest/routes.test.mjs
vi.mock("../../../auth.js", () => ({ auth: vi.fn() }));
vi.mock("../../../lib/rate-limit", async original => ({ ...await original(), enforceRateLimits: vi.fn() }));

const directory = await mkdtemp(path.join(os.tmpdir(), "ihear-room-channel-"));
vi.stubEnv("IHEAR_FORCE_FILE_STORE", "1");
vi.stubEnv("IHEAR_TEST_DATA_DIR", directory);
vi.stubEnv("CLASSROOM_DRIVE", "local");
vi.stubEnv("VERCEL_ENV", "");
const { enforceRateLimits } = await import("../../../lib/rate-limit");
const { classroomStore } = await import("../../../lib/classroom-store");
const { classroomDrive } = await import("../../../lib/classroom-drive");
const { classroomStatus, createClassroomLesson } = await import("../../../lib/classroom-service");
const rooms = await import("../../../lib/classroom-fixed-rooms");
const { roomChannelCaller } = await import("../../../lib/room-channel/caller");
const channelRoute = await import("../../../app/api/classroom/[lessonId]/room-channel/route");
const purgeRoute = await import("../../../app/api/classroom/room-channel-purge/route");
// @ts-ignore
const { buildSessionTokenClaims, signSessionToken } = await import("../../../tools/recording-pathway/classroom/eligibility.mjs");

const store = classroomStore();
const drive = classroomDrive();
const MIN = 60_000, HOUR = 60 * MIN;
const START = Date.parse("2026-12-10T15:00:00Z");
const ORIGIN = "http://localhost:3000";
const OWNER = { email: "rooms-owner@example.test", owner: true };
const CRON = "room-channel-sweep-test-only-0123456789abcdef";
const provider = {
  name: "synthetic", webhookSecret: null,
  sessionToken: ({ lesson, participant, now, generation = 0 }) => ({ token: signSessionToken(buildSessionTokenClaims({ lesson, participant, appKey: "synthetic-app", now, generation }), "room-channel-test-secret-not-real"), issuedAt: now, expiresAt: now + 30 * MIN }),
  startRecording: async () => ({ ok: true, httpStatus: 202 }), stopRecording: async () => ({ ok: true, httpStatus: 202 }), endSession: async () => ({ ok: true, httpStatus: 204 }),
  removeUser: async () => ({ ok: false, httpStatus: 501 }), snapshot: async () => null, observe: async () => ({ live: false, recording: null }),
  download: async () => Buffer.alloc(0), deleteRecording: async () => ({ ok: false, httpStatus: 501 }),
};
const keyOf = link => new URLSearchParams(link.split("#")[1]).get("k");
const manage = (action, input = {}, now = START) => rooms.manageFixedRoom({ store, provider, drive, principal: OWNER, action, input, now });
let made = 0;
// A room with people let in at `now`: their tickets, the lesson they are in, and how to take one out.
async function roomWith(names, now = START) {
  made += 1;
  const created = await manage("create", { label: `Channel ${made}` }, now);
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const room = { id: created.body.room.id, key: keyOf(created.body.link) };
  const people = [];
  for (const name of names) {
    const asked = await rooms.requestEntry({ store, roomId: room.id, key: room.key, name, now });
    expect((await manage("admit", { room: room.id, request: asked.body.requestId }, now)).status).toBe(200);
    people.push({ name, ticket: asked.body.ticket, requestId: asked.body.requestId });
  }
  const lessonId = (await rooms.requestStatus({ store, roomId: room.id, requestId: people[0].requestId, ticket: people[0].ticket, now })).body.lessonId;
  return { room, people, lessonId };
}
const post = (lessonId, body, { origin = ORIGIN, raw = null } = {}) => channelRoute.POST(
  new Request(`${ORIGIN}/api/classroom/${lessonId}/room-channel`, { method: "POST", headers: { "content-type": "application/json", ...(origin ? { origin } : {}) }, body: raw ?? JSON.stringify(body) }),
  { params: Promise.resolve({ lessonId }) },
);
const exchange = async (lessonId, ticket, more = {}) => { const response = await post(lessonId, { key: ticket, ...more }); return { status: response.status, body: await response.json() }; };
const stroke = (line, part = 0) => ({ kind: "stroke", op: `${line}-${part}`, line, part, points: [[10, 10], [20, 20]], color: 1, width: 2, done: true });
const sweep = (authorization = `Bearer ${CRON}`) => purgeRoute.GET(new Request(`${ORIGIN}/api/classroom/room-channel-purge`, { headers: authorization ? { authorization } : {} }));
const allOn = () => { vi.stubEnv("CLASSROOM_ROOM_BOARD", "on"); vi.stubEnv("CLASSROOM_ROOM_CHAT", "on"); vi.stubEnv("CLASSROOM_ROOM_SHARE_TURN", "on"); };

vi.useFakeTimers({ toFake: ["Date"] });
afterAll(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});
beforeEach(() => {
  vi.setSystemTime(START);
  vi.stubEnv("CLASSROOM_FIXED_ROOMS", "on");
  vi.stubEnv("CRON_SECRET", CRON);
  allOn();
  enforceRateLimits.mockReset();
  enforceRateLimits.mockResolvedValue({ limited: false, result: { allowed: true, limit: 900, remaining: 899, retryAfter: 60, resetAt: "2026-12-10T15:01:00.000Z" } });
});

describe("the room channel's routes", () => {
  test("RR-1: with every switch off, or fixed rooms off, the route is not there, and nobody is looked up", async () => {
    const { people, lessonId } = await roomWith(["Kyle"]);
    for (const name of ["CLASSROOM_ROOM_BOARD", "CLASSROOM_ROOM_CHAT", "CLASSROOM_ROOM_SHARE_TURN"]) vi.stubEnv(name, "");
    expect((await exchange(lessonId, people[0].ticket, { cursors: { board: 0 } })).status).toBe(404);
    // "on" exactly: anything else is off.
    vi.stubEnv("CLASSROOM_ROOM_BOARD", "true");
    vi.stubEnv("CLASSROOM_ROOM_CHAT", "1");
    vi.stubEnv("CLASSROOM_ROOM_SHARE_TURN", "ON");
    expect((await exchange(lessonId, people[0].ticket, { cursors: { board: 0 } })).status).toBe(404);
    allOn();
    vi.stubEnv("CLASSROOM_FIXED_ROOMS", "");
    expect((await exchange(lessonId, people[0].ticket, { cursors: { board: 0 } })).status).toBe(404);
    expect(enforceRateLimits).not.toHaveBeenCalled();
    // One switch on: that part answers, the others are not offered and not read.
    vi.stubEnv("CLASSROOM_FIXED_ROOMS", "on");
    vi.stubEnv("CLASSROOM_ROOM_CHAT", "");
    vi.stubEnv("CLASSROOM_ROOM_SHARE_TURN", "");
    const only = await exchange(lessonId, people[0].ticket, { cursors: { board: 0, chat: 0, turn: 0 }, send: [{ part: "board", input: stroke("a") }, { part: "chat", input: { op: "m1", text: "hi" } }, { part: "turn", action: "claim" }] });
    expect(only.status).toBe(200);
    expect(only.body.sent.map(answer => answer.ok ? "ok" : answer.error)).toEqual(["ok", "NOT_OFFERED", "NOT_OFFERED"]);
    expect([only.body.board.entries.length, only.body.chat, only.body.turn]).toEqual([1, undefined, undefined]);
    // Every answer says which parts this classroom offers, so the page shows only those.
    expect(only.body.on).toEqual({ board: true, chat: false, turn: false });
  });

  test("RR-2: a person is who their ticket says; nothing in the body can say otherwise, and a message has no receiver", async () => {
    const { people, lessonId } = await roomWith(["Kyle", "Ann"]);
    const [kyle, ann] = people;
    const first = await exchange(lessonId, kyle.ticket, { cursors: { board: 0, chat: 0, turn: 0 }, by: "someone-else", who: { id: "x" }, send: [
      { part: "board", input: stroke("a") }, { part: "chat", input: { op: "m1", text: "hello all" } }, { part: "turn", action: "claim" },
      { part: "chat", input: { op: "m2", text: "psst", to: "Ann" } }, { part: "chat", input: { op: "m3", text: "as another", by: "x" } }, { part: "board", input: { ...stroke("b"), by: "x" } },
    ] });
    expect(first.status).toBe(200);
    expect(first.body.sent.map(answer => answer.ok ? "ok" : answer.error)).toEqual(["ok", "ok", "ok", "PRIVATE_NOT_OFFERED", "FIELDS", "FIELDS"]);
    const you = first.body.you;
    expect(typeof you).toBe("string");
    expect(first.body.turn.holder).toBe(you);
    // The other person sees it all under the first person's own name in the room, and is someone else.
    const other = await exchange(lessonId, ann.ticket, { cursors: { board: 0, chat: 0, turn: 0 } });
    expect(other.body.you).not.toBe(you);
    expect(other.body.board.entries.map(entry => [entry.by, entry.line])).toEqual([[you, `${you}:a`]]);
    expect(other.body.chat.messages.map(message => [message.by, message.text])).toEqual([[you, "hello all"]]);
    // A person is known by their place on the lesson's list, which is what Zoom carries for them too.
    const lesson = await store.lesson(lessonId);
    expect(lesson.participants.map(entry => entry.id)).toContain(you);
    expect(other.body.chat.messages[0].name).toBe(lesson.participants.find(entry => entry.id === you).code);
    expect(other.body.turn.holder).toBe(you);
    // Nothing a person typed at the door is in what the room hands out: people show by code only.
    expect(JSON.stringify(other.body)).not.toMatch(/Kyle|Ann/);
    // The limit is asked for each request, per person (never the ticket itself) and per address.
    const buckets = enforceRateLimits.mock.calls[0][1];
    expect(buckets.map(bucket => [bucket.scope, bucket.limit])).toEqual([["classroom-room-channel", 9000], ["classroom-room-channel-person", 900]]);
    expect(JSON.stringify(buckets)).not.toContain(kyle.ticket);
  });

  test("RR-3: while the lesson is open, the caller is allowed exactly when the classroom's own check allows", async () => {
    const { room, people, lessonId } = await roomWith(["Kyle", "Ann", "Bo"]);
    const elsewhere = await roomWith(["Kim"]);
    const plain = await createClassroomLesson({ store, actor: OWNER.email, now: START - HOUR, input: { code: `TEST-RC-PLAIN${made}`, date: "2026-12-10", time: "10:00", minutes: 60, tutorCode: `TEST-RCT${made}`, tutorEmail: `rc-tutor${made}@example.test`, studentCode: `TEST-RCS${made}`, timeZone: "America/New_York" } });
    expect((await manage("remove", { room: room.id, request: people[2].requestId }, START + MIN)).status).toBe(200);
    const cases = [
      ["their own ticket", people[0].ticket], ["another person's ticket", people[1].ticket], ["no ticket", null], ["a ticket that is no one's", "not-a-ticket"],
      ["the ticket of a person in another room", elsewhere.people[0].ticket], ["the room's own link key", room.key], ["a one-to-one lesson's link", keyOf(plain.studentLink)], ["the ticket of a person taken out", people[2].ticket],
    ];
    // Also a moment before the lesson's door opened (it opened when the first person was let in).
    for (const now of [START - 20 * MIN, START + 2 * MIN, START + 2 * HOUR, START + 3 * HOUR - 1]) {
      for (const [label, key] of cases) {
        const mine = await roomChannelCaller({ store, lessonId, key, now });
        const theirs = await classroomStatus({ store, lessonId, key, sessionEmail: null, now });
        expect(mine.ok, `${label} at +${Math.round((now - START) / MIN)} min`).toBe(theirs.status === 200);
      }
    }
    expect((await roomChannelCaller({ store, lessonId, key: people[0].ticket, now: START + 2 * MIN })).ok).toBe(true);
    // A signed-in member of staff is not a person in the room for the channel: only a ticket counts.
    const facts = (await roomChannelCaller({ store, lessonId, key: people[0].ticket, now: START + 2 * MIN })).lesson;
    expect(facts).toMatchObject({ id: lessonId, roomId: room.id, scheduledEnd: START + 3 * HOUR, endedAt: null });
    expect(facts.people).toHaveLength(2);
  });

  test("RR-4: taken out of the room: refused on the very next request, their share turn is free, their lines stay for the others", async () => {
    const { room, people, lessonId } = await roomWith(["Kyle", "Ann", "Bo"]);
    const [kyle, ann, bo] = people;
    const held = await exchange(lessonId, bo.ticket, { cursors: { turn: 0 }, send: [{ part: "turn", action: "claim" }, { part: "board", input: stroke("mine") }, { part: "chat", input: { op: "m1", text: "bye" } }] });
    const boName = held.body.you;
    expect(held.body.turn.holder).toBe(boName);
    vi.setSystemTime(START + MIN);
    expect((await manage("remove", { room: room.id, request: bo.requestId }, START + MIN)).status).toBe(200);
    const refused = await exchange(lessonId, bo.ticket, { cursors: { board: 0, chat: 0, turn: 0 }, send: [{ part: "board", input: stroke("again") }] });
    expect([refused.status, refused.body.code]).toEqual([403, "NOT_IN_ROOM"]);
    expect(refused.body.board).toBeUndefined();
    // The others: the turn is free at once (no waiting for the lease), the line and the message are still there.
    const after = await exchange(lessonId, ann.ticket, { cursors: { board: 0, chat: 0, turn: 0 } });
    expect(after.body.turn.holder).toBe(null);
    expect(after.body.board.entries.map(entry => entry.line)).toEqual([`${boName}:mine`]);
    expect(after.body.chat.messages).toHaveLength(1);
    expect((await exchange(lessonId, kyle.ticket, { cursors: { turn: 0 }, send: [{ part: "turn", action: "claim" }] })).body.turn.holder).not.toBe(boName);
    // Handing the turn to the person taken out is refused: they are not in the lesson.
    const handed = await exchange(lessonId, kyle.ticket, { send: [{ part: "turn", action: "handOver", to: boName }] });
    expect(handed.body.sent[0].error).toBe("NO_SUCH_PERSON");
  });

  test("RR-5: a one-to-one lesson and a lesson that does not exist get the same answer: not found", async () => {
    const plain = await createClassroomLesson({ store, actor: OWNER.email, now: START - HOUR, input: { code: `TEST-RC-ONE${made += 1}`, date: "2026-12-10", time: "10:00", minutes: 60, tutorCode: `TEST-RCT${made}`, tutorEmail: `rc-one${made}@example.test`, studentCode: `TEST-RCS${made}`, timeZone: "America/New_York" } });
    const real = await exchange(plain.lesson.id, keyOf(plain.studentLink), { cursors: { board: 0 }, send: [{ part: "board", input: stroke("a") }] });
    const none = await exchange("L-does-not-exist", "any", { cursors: { board: 0 } });
    expect([real.status, real.body]).toEqual([404, { error: "Not found", code: "NOT_FOUND" }]);
    expect([none.status, none.body]).toEqual([404, { error: "Not found", code: "NOT_FOUND" }]);
  });

  test("RR-6: ended by the iHear teacher: the end is that moment; the board can be read, nothing written; chat and turn are gone", async () => {
    const { room, people, lessonId } = await roomWith(["Kyle", "Ann"]);
    const [kyle, ann] = people;
    await exchange(lessonId, kyle.ticket, { send: [{ part: "board", input: stroke("a") }, { part: "chat", input: { op: "m1", text: "notes" } }, { part: "turn", action: "claim" }] });
    const endedAt = START + 50 * MIN;
    expect((await manage("end_lesson", { room: room.id }, endedAt)).status).toBe(200);
    // Somebody's page asks half an hour later.
    vi.setSystemTime(endedAt + 30 * MIN);
    const caller = await roomChannelCaller({ store, lessonId, key: ann.ticket, now: endedAt + 30 * MIN });
    expect(caller.lesson.endedAt).toBe(endedAt);
    const after = await exchange(lessonId, ann.ticket, { cursors: { board: 0, chat: 0, turn: 0 }, send: [{ part: "board", input: stroke("late") }, { part: "chat", input: { op: "m2", text: "late" } }] });
    expect(after.status).toBe(200);
    expect(after.body.sent.map(answer => answer.error)).toEqual(["LESSON_ENDED", "LESSON_ENDED"]);
    expect([after.body.board.ended, after.body.board.entries.length]).toEqual([true, 1]);
    expect(after.body.chat).toEqual({ ok: true, seq: 0, ended: true, missed: false, messages: [], more: false });
    expect([after.body.turn.holder, after.body.turn.ended]).toEqual([null, true]);
    // 24 hours from the END (not from this request): readable just before, gone at that moment.
    vi.setSystemTime(endedAt + 24 * HOUR - 1);
    expect((await exchange(lessonId, ann.ticket, { cursors: { board: 9 } })).body.board.picture.lines).toHaveLength(1);
    vi.setSystemTime(endedAt + 24 * HOUR);
    expect((await exchange(lessonId, ann.ticket, { cursors: { board: 9 } })).body.board.picture.lines).toHaveLength(0);
    // A lesson that simply ran to its planned end: the end is the planned end.
    const second = await roomWith(["Kim"], START);
    expect((await roomChannelCaller({ store, lessonId: second.lessonId, key: second.people[0].ticket, now: START + 3 * HOUR })).lesson.endedAt).toBe(START + 3 * HOUR);
    expect((await roomChannelCaller({ store, lessonId: second.lessonId, key: second.people[0].ticket, now: START + 3 * HOUR - 1 })).lesson.endedAt).toBe(null);
  });

  test("RR-7: the request itself: same origin only; a body too large or not JSON goes no further; a refused limit answers alone", async () => {
    const { people, lessonId } = await roomWith(["Kyle"]);
    const cross = await post(lessonId, { key: people[0].ticket }, { origin: "https://elsewhere.example" });
    expect(cross.status).toBe(403);
    expect((await post(lessonId, null, { raw: "{" })).status).toBe(400);
    expect((await post(lessonId, null, { raw: "[1,2]" })).status).toBe(400);
    expect((await post(lessonId, null, { raw: JSON.stringify({ key: people[0].ticket, filler: "x".repeat(160_001) }) })).status).toBe(413);
    expect(enforceRateLimits).not.toHaveBeenCalled();
    enforceRateLimits.mockResolvedValueOnce({ limited: true, response: new Response(JSON.stringify({ error: "Too many requests" }), { status: 429 }) });
    expect((await post(lessonId, { key: people[0].ticket, cursors: { board: 0 } })).status).toBe(429);
    // More than a request may carry.
    const many = await exchange(lessonId, people[0].ticket, { send: Array.from({ length: 17 }, () => ({ part: "turn", action: "beat" })) });
    expect([many.status, many.body.error]).toEqual([400, "TOO_MANY"]);
    // Answers are never to be stored by anything in between.
    const fine = await post(lessonId, { key: people[0].ticket, cursors: { board: 0 } });
    expect([fine.status, fine.headers.get("cache-control")]).toEqual([200, "private, no-store, max-age=0"]);
  });

  test("RR-8: the sweep route: nothing without the secret; with it, it closes and deletes, whatever the switches say", async () => {
    const { room, people, lessonId } = await roomWith(["Kyle"]);
    await exchange(lessonId, people[0].ticket, { send: [{ part: "board", input: stroke("a") }, { part: "chat", input: { op: "m1", text: "notes" } }, { part: "turn", action: "claim" }] });
    vi.stubEnv("CRON_SECRET", "");
    expect((await sweep()).status).toBe(503);
    vi.stubEnv("CRON_SECRET", "too-short");
    expect((await sweep("Bearer too-short")).status).toBe(503);
    vi.stubEnv("CRON_SECRET", CRON);
    expect((await sweep(null)).status).toBe(401);
    expect((await sweep("Bearer wrong-secret-wrong-secret-wrong-secret")).status).toBe(401);
    // The three switches are turned off: what was stored must still be deleted.
    for (const name of ["CLASSROOM_ROOM_BOARD", "CLASSROOM_ROOM_CHAT", "CLASSROOM_ROOM_SHARE_TURN"]) vi.stubEnv(name, "");
    const idle = await (await sweep()).json();
    expect(idle).toMatchObject({ ok: true, deleted: 0, lessonsClosed: 0 });
    expect(idle.held.parts).toMatchObject({ board: expect.any(Number), chat: expect.any(Number), turn: expect.any(Number) });
    const before = idle.held.parts;
    // The iHear teacher ends the lesson and nobody's page comes back: the next sweep closes it.
    const endedAt = START + 40 * MIN;
    expect((await manage("end_lesson", { room: room.id }, endedAt)).status).toBe(200);
    vi.setSystemTime(endedAt + 4 * MIN);
    const closed = await (await sweep()).json();
    expect(closed.lessonsClosed).toBeGreaterThanOrEqual(1);
    expect([closed.held.parts.chat, closed.held.parts.turn]).toEqual([before.chat - 1, before.turn - 1]);
    expect(closed.held.overdue).toBe(0);
    // A day after the end the board is deleted by the sweep, with nobody asking for it.
    vi.setSystemTime(endedAt + 24 * HOUR);
    const gone = await (await sweep()).json();
    expect(gone.deleted).toBeGreaterThanOrEqual(1);
    expect(gone.held.overdue).toBe(0);
    allOn();
    expect((await exchange(lessonId, people[0].ticket, { cursors: { board: 9 } })).body.board.picture.lines).toHaveLength(0);
  });

  test("RR-9: a page's last request as it goes away: the turn it holds is free at once and nothing is read; from someone who holds no turn it takes nothing", async () => {
    const { people: [ann, bo], lessonId } = await roomWith(["Ann", "Bo"]);
    const claimed = await exchange(lessonId, ann.ticket, { cursors: { turn: 0 }, send: [{ part: "turn", action: "claim" }] });
    const annName = claimed.body.you;
    expect(claimed.body.turn.holder).toBe(annName);
    const last = { cursors: {}, send: [{ part: "turn", action: "release" }] };   // lib/room-channel/client.mjs: parting()
    // Bo's page goes away: Bo holds no turn, so nothing changes.
    const notHolder = await exchange(lessonId, bo.ticket, last);
    expect([notHolder.status, notHolder.body.sent[0].wasHolder]).toEqual([200, false]);
    expect((await exchange(lessonId, bo.ticket, { cursors: { turn: 0 } })).body.turn.holder).toBe(annName);
    // Ann's page goes away: the turn is free on the next look of anyone, well inside the lease.
    vi.setSystemTime(START + 2000);
    const gone = await exchange(lessonId, ann.ticket, last);
    expect([gone.status, gone.body.sent[0].wasHolder]).toEqual([200, true]);
    expect(Object.keys(gone.body).sort()).toEqual(["ok", "on", "people", "sent", "you"]);
    expect((await exchange(lessonId, bo.ticket, { cursors: { turn: 0 } })).body.turn.holder).toBe(null);
    expect((await exchange(lessonId, bo.ticket, { cursors: { turn: 0 }, send: [{ part: "turn", action: "claim" }] })).body.turn.holder).not.toBe(annName);
  });

  test("RR-10: with the share turn, the answer says who is in the lesson: the people let in, by the names beside their messages; a person taken out is gone from it; without the turn it is not sent", async () => {
    const { room, people: [ann, bo, cy], lessonId } = await roomWith(["Ann", "Bo", "Cy"]);
    const said = {};
    for (const person of [ann, bo, cy]) {
      const answer = await exchange(lessonId, person.ticket, { cursors: { chat: 0 }, send: [{ part: "chat", input: { op: `hello-${person.name}`, text: person.name } }] });
      said[answer.body.you] = answer.body.chat.messages.find(message => message.by === answer.body.you).name;
    }
    const first = await exchange(lessonId, ann.ticket, { cursors: { turn: 0 } });
    // Everyone let in, each once, the asker among them, each with the name their messages carry.
    expect(first.body.people.map(person => person.id).sort()).toEqual(Object.keys(said).sort());
    expect(first.body.people.map(person => person.id)).toContain(first.body.you);
    for (const person of first.body.people) expect(person).toEqual({ id: person.id, name: said[person.id] });
    // Handing the turn to someone on the list works; that is what the list is for.
    const boId = (await exchange(lessonId, bo.ticket, {})).body.you;
    await exchange(lessonId, ann.ticket, { send: [{ part: "turn", action: "claim" }] });
    expect((await exchange(lessonId, ann.ticket, { cursors: { turn: 0 }, send: [{ part: "turn", action: "handOver", to: boId }] })).body.turn.offeredTo).toBe(boId);
    // Bo is taken out: gone from the list on the next answer of anyone.
    vi.setSystemTime(START + MIN);
    expect((await manage("remove", { room: room.id, request: bo.requestId }, START + MIN)).status).toBe(200);
    const after = await exchange(lessonId, cy.ticket, { cursors: { turn: 0 } });
    expect(after.body.people.map(person => person.id)).not.toContain(boId);
    expect(after.body.people).toHaveLength(2);
    // Without the share turn nobody is listed: the board and the chat do not need it.
    vi.stubEnv("CLASSROOM_ROOM_SHARE_TURN", "");
    const quiet = await exchange(lessonId, cy.ticket, { cursors: { board: 0 } });
    expect([quiet.status, "people" in quiet.body]).toEqual([200, false]);
  });
});
