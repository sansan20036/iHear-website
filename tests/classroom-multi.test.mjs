import { afterAll, beforeEach, describe, expect, test, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// P3-Multi (2026-11-09) on the server, with the file store and a scripted stand-in for Zoom: a block
// with a Lobby and teaching rooms, the manager first in, the breakout, moves, visits, recall, end
// and cancel, the 10-person rooms, who may enter where, the 18.2 states, and the recording rules
// that keep a block safe while recording stays off (Classroom Only) and when an owner turns it on.
// Synthetic only: nothing here says how real Zoom behaves.
const directory = await mkdtemp(path.join(os.tmpdir(), "ihear-multi-"));
vi.stubEnv("IHEAR_FORCE_FILE_STORE", "1");
vi.stubEnv("IHEAR_TEST_DATA_DIR", directory);
vi.stubEnv("CLASSROOM_DRIVE", "local");
vi.stubEnv("VERCEL_ENV", "");
const { classroomStore } = await import("../lib/classroom-store");
const { classroomDrive } = await import("../lib/classroom-drive");
const { classroomStatus, joinClassroom, recordHostReport, runClassroomTick, setSyntheticConsent } = await import("../lib/classroom-service");
const { blockView, blockWhere, chooseInBlock, createClassroomBlock, manageBlock, myClassroomBlocks } = await import("../lib/classroom-blocks");
// @ts-ignore
const { storeEvent } = await import("../tools/recording-pathway/classroom/webhook-ingest.mjs");
// @ts-ignore
const { buildSessionTokenClaims, roomNameOf, signSessionToken } = await import("../tools/recording-pathway/classroom/eligibility.mjs");

afterAll(async () => {
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});
beforeEach(() => { vi.stubEnv("CLASSROOM_MULTI_RECORDING", ""); });

const store = classroomStore();
const drive = classroomDrive();
const MIN = 60_000, SEC = 1000;
const START = Date.parse("2026-12-01T08:00:00Z"); // Taipei 16:00
const OWNER = { email: "multi-owner@example.test", owner: true };
const keyOf = link => new URLSearchParams(link.split("#")[1]).get("k");
const claimsOf = token => JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));

// A stand-in for Zoom: tokens as the Video SDK's (signed with a test secret), every request listed.
function zoom({ observe } = {}) {
  const calls = [];
  const provider = {
    name: "synthetic", webhookSecret: null,
    sessionToken: ({ lesson, participant, now, generation = 0 }) => {
      const claims = buildSessionTokenClaims({ lesson, participant, appKey: "synthetic-app", now, generation });
      return { token: signSessionToken(claims, "multi-test-secret-not-real"), issuedAt: now, expiresAt: now + 30 * MIN };
    },
    startRecording: async (lesson, sessionId) => { calls.push(["start", lesson.id, sessionId]); return { ok: true, httpStatus: 202 }; },
    stopRecording: async (lesson, sessionId) => { calls.push(["stop", lesson.id, sessionId]); return { ok: true, httpStatus: 202 }; },
    endSession: async (lesson, sessionId) => { calls.push(["end", lesson.id, sessionId]); return { ok: true, httpStatus: 204 }; },
    removeUser: async () => ({ ok: false, httpStatus: 501 }),
    snapshot: async () => null,
    observe: async (lesson, sessionId) => { calls.push(["observe", lesson.id, sessionId]); return observe ? observe(lesson, sessionId) : { live: true, recording: null }; },
    download: async () => Buffer.alloc(0),
    deleteRecording: async () => ({ ok: false, httpStatus: 501 }),
  };
  return { provider, calls, sent: type => calls.filter(([kind]) => kind === type) };
}

let blocks = 0;
// A block: a manager, tutors, an observer and students, rooms R1..Rn, first seats as given.
async function makeBlock({ rooms = ["R1", "R2"], students = 4, tutors = [["lead_tutor", "R1"], ["lead_tutor", "R2"]], seats = null, observers = 1 } = {}) {
  blocks += 1;
  const code = `TEST-MB${blocks}`;
  const members = [{ code: `${code}-M`, role: "manager", englishName: "Mia Manager", email: `manager${blocks}@example.test` }];
  tutors.forEach(([role], index) => members.push({ code: `${code}-T${index + 1}`, role, englishName: `Tutor ${String.fromCharCode(65 + index)}`, email: `tutor${blocks}-${index + 1}@example.test` }));
  for (let index = 0; index < observers; index += 1) members.push({ code: `${code}-O${index + 1}`, role: "observer", englishName: `Olly Observer`, email: `observer${blocks}-${index + 1}@example.test` });
  for (let index = 0; index < students; index += 1) members.push({ code: `${code}-S${index + 1}`, role: "student", englishName: `Student ${String.fromCharCode(65 + index)}` });
  const assignments = seats ?? [
    ...tutors.map(([, room], index) => ({ member: `${code}-T${index + 1}`, room })),
    ...Array.from({ length: students }, (_, index) => ({ member: `${code}-S${index + 1}`, room: rooms[index % rooms.length] })),
  ];
  const created = await createClassroomBlock({
    store, actor: OWNER.email, now: START - 60 * MIN,
    input: { code, date: "2026-12-01", time: "16:00", minutes: 60, rooms, members, assignments },
  });
  const block = await store.block(created.block.blockId);
  const links = Object.fromEntries(created.studentLinks.map(entry => [entry.code, keyOf(entry.link)]));
  const staff = Object.fromEntries(members.filter(member => member.email).map(member => [member.code, member.email]));
  return { code, block, links, staff, members, manager: { email: members[0].email, owner: false } };
}
const lessonByLabel = async (ctx, label) => {
  const block = await store.block(ctx.block.id);
  if (label === "LOBBY") return store.lesson(block.lobbyId);
  for (const id of block.roomIds) { const lesson = await store.lesson(id); if (lesson.roomLabel === label) return lesson; }
  return null;
};
const version = async ctx => (await store.block(ctx.block.id)).version;
const manage = async (ctx, action, input = {}, { principal = OWNER, now = START, fake = zoom() } = {}) =>
  manageBlock({ store, provider: fake.provider, drive, blockId: ctx.block.id, principal, action, input: { version: await version(ctx), ...input }, now });
const join = async (ctx, label, who, { now = START, fake = zoom() } = {}) => {
  const lesson = await lessonByLabel(ctx, label);
  return joinClassroom({ store, provider: fake.provider, lessonId: lesson.id, ...who, now });
};
const asStudent = (ctx, n) => ({ key: ctx.links[`${ctx.code}-S${n}`] });
const asStaff = (ctx, code) => ({ sessionEmail: ctx.staff[`${ctx.code}-${code}`] });
const where = (ctx, who, now = START) => blockWhere({ store, blockId: ctx.block.id, ...who, now });
// The manager enters the Lobby and opens it; then the breakout starts.
async function openAndBreakout(ctx, fake = zoom()) {
  expect((await join(ctx, "LOBBY", asStaff(ctx, "M"), { fake })).status).toBe(200);
  expect((await manage(ctx, "open_lobby")).status).toBe(200);
  expect((await manage(ctx, "start_breakout", { confirm: true })).status).toBe(200);
}
let facts = 0;
async function fact(lessonId, type, at, fields) {
  facts += 1;
  await store.transaction(tx => storeEvent(tx, { source: "zoom_webhook", type, lessonId, occurredAt: at, receivedAt: at, key: `${type}:${at}:${facts}`, ...fields }));
}
const participantOf = (lesson, ctx, memberCode) => lesson.participants.find(entry => entry.code === `${ctx.code}-${memberCode}` && entry.active !== false);

describe("the Lobby: the manager first, then personal links and sign-ins", () => {
  test("before the manager opens it, students wait and get no token; it cannot be opened before the manager is in; once open, students enter it with their link", async () => {
    const ctx = await makeBlock();
    expect((await where(ctx, asStudent(ctx, 1))).body).toMatchObject({ ok: true, target: { kind: "wait", lessonId: null } });
    expect((await join(ctx, "LOBBY", asStudent(ctx, 1))).body).toMatchObject({ code: "LOBBY_NOT_OPEN" });
    expect((await manage(ctx, "open_lobby")).body).toMatchObject({ code: "MANAGER_NOT_IN_LOBBY" });
    const manager = await join(ctx, "LOBBY", asStaff(ctx, "M"));
    expect(manager.status).toBe(200);
    const lobby = await lessonByLabel(ctx, "LOBBY");
    expect(claimsOf(manager.body.session.token)).toMatchObject({ role_type: 1, tpc: roomNameOf(lobby.id, 0), session_key: lobby.id });
    expect((await manage(ctx, "open_lobby")).status).toBe(200);
    const student = await join(ctx, "LOBBY", asStudent(ctx, 1));
    expect(student.status).toBe(200);
    expect(claimsOf(student.body.session.token)).toMatchObject({ role_type: 0, tpc: roomNameOf(lobby.id, 0) });
    // A tutor waits in the Lobby as a participant (no host controls there).
    const tutor = await join(ctx, "LOBBY", asStaff(ctx, "T1"));
    expect(tutor.body).toMatchObject({ ok: true, role: "student", block: { roomKind: "lobby", memberRole: "lead_tutor" } });
    expect(claimsOf(tutor.body.session.token).role_type).toBe(0);
  });

  test("a wrong key, another block's key, an unknown sign-in or none at all gets nothing", async () => {
    const ctx = await makeBlock();
    const other = await makeBlock();
    await join(ctx, "LOBBY", asStaff(ctx, "M"));
    await manage(ctx, "open_lobby");
    for (const who of [{ key: "not-a-real-key" }, asStudent(other, 1), { sessionEmail: "stranger@example.test" }, asStaff(other, "M"), {}]) {
      const answer = await join(ctx, "LOBBY", who);
      expect(answer.status).toBe(403);
      expect((await where(ctx, who)).status).toBe(403);
    }
  });
});

describe("rooms: every shape shares one participant model", () => {
  test("one-to-one, many students with one tutor, one student with several tutors, many with many: each person is sent to their room only, tutors host it", async () => {
    const ctx = await makeBlock({
      rooms: ["R1", "R2", "R3", "R4"], students: 7, observers: 0,
      tutors: [["lead_tutor", "R1"], ["lead_tutor", "R2"], ["lead_tutor", "R3"], ["co_tutor", "R3"], ["lead_tutor", "R4"], ["co_tutor", "R4"]],
      seats: null,
    });
    // Re-seat students into the four shapes: R1 1:1, R2 3:1, R3 1:2, R4 2:2.
    const plan = { 1: "R1", 2: "R2", 3: "R2", 4: "R2", 5: "R3", 6: "R4", 7: "R4" };
    for (const [n, room] of Object.entries(plan)) expect((await manage(ctx, "assign", { member: `${ctx.code}-S${n}`, room })).status).toBe(200);
    await openAndBreakout(ctx);
    for (const [n, room] of Object.entries(plan)) {
      const answer = await where(ctx, asStudent(ctx, Number(n)));
      const lesson = await lessonByLabel(ctx, room);
      expect(answer.body.target).toEqual({ kind: "room", lessonId: lesson.id, label: room });
      const joined = await join(ctx, room, asStudent(ctx, Number(n)));
      expect(claimsOf(joined.body.session.token)).toMatchObject({ role_type: 0, tpc: roomNameOf(lesson.id, 0), session_key: lesson.id });
    }
    for (const [tutor, room] of [["T1", "R1"], ["T2", "R2"], ["T3", "R3"], ["T4", "R3"], ["T5", "R4"], ["T6", "R4"]]) {
      const joined = await join(ctx, room, asStaff(ctx, tutor));
      expect(joined.body).toMatchObject({ ok: true, role: "tutor" });
      expect(claimsOf(joined.body.session.token).role_type).toBe(1);
    }
    const view = await blockView({ store, blockId: ctx.block.id, now: START });
    expect(Object.fromEntries(view.rooms.map(room => [room.label, room.occupied]))).toEqual({ R1: 2, R2: 4, R3: 3, R4: 4 });
  });

  test("several rooms at once are separate sessions: a fact about one room changes nothing in another", async () => {
    const ctx = await makeBlock();
    await openAndBreakout(ctx);
    const [r1, r2] = [await lessonByLabel(ctx, "R1"), await lessonByLabel(ctx, "R2")];
    const t1 = claimsOf((await join(ctx, "R1", asStaff(ctx, "T1"))).body.session.token);
    const t2 = claimsOf((await join(ctx, "R2", asStaff(ctx, "T2"))).body.session.token);
    expect(t1.tpc).not.toBe(t2.tpc);
    expect(t1.session_key).not.toBe(t2.session_key);
    await fact(r1.id, "session.started", START, { providerSessionId: "ZS-R1", sessionName: roomNameOf(r1.id, 0) });
    expect((await store.eventsFor([r2.id])).some(event => event.type === "session.started")).toBe(false);
  });
});

describe("10 people per room, whatever arrives at once", () => {
  test("the 11th seat is refused; visits count too", async () => {
    const ctx = await makeBlock({ rooms: ["R1", "R2"], students: 11, tutors: [["lead_tutor", "R1"]], seats: [] });
    // R1: the tutor and nine students make 10.
    expect((await manage(ctx, "assign", { member: `${ctx.code}-T1`, room: "R1" })).status).toBe(200);
    for (let n = 1; n <= 9; n += 1) expect((await manage(ctx, "assign", { member: `${ctx.code}-S${n}`, room: "R1" })).status).toBe(200);
    const full = await manage(ctx, "assign", { member: `${ctx.code}-S10`, room: "R1" });
    expect(full).toMatchObject({ status: 409, body: { code: "ROOM_FULL" } });
    await openAndBreakout(ctx);
    expect((await manage(ctx, "visit", { member: `${ctx.code}-O1`, room: "R1" })).body).toMatchObject({ code: "ROOM_FULL" });
    expect((await manage(ctx, "assign", { member: `${ctx.code}-S9`, room: null })).status).toBe(200);
    expect((await manage(ctx, "visit", { member: `${ctx.code}-O1`, room: "R1" })).status).toBe(200);
    const view = await blockView({ store, blockId: ctx.block.id, now: START });
    expect(view.rooms.find(room => room.label === "R1").occupied).toBe(10);
  });

  test("twelve seat changes into one empty room at the same moment: exactly ten get in", async () => {
    const ctx = await makeBlock({ rooms: ["R1"], students: 12, tutors: [], observers: 0, seats: [] });
    const block = await store.block(ctx.block.id);
    const room = await lessonByLabel(ctx, "R1");
    const results = await Promise.all(block.members.filter(member => member.role === "student").map(member => store.changeBlock({
      blockId: block.id, seat: { memberId: member.id, roomId: room.id, seat: "assigned", capacity: 10, participant: { id: `P-${member.id.slice(2)}`, code: member.code, role: "student" } }, events: [],
    })));
    expect(results.filter(result => result.ok)).toHaveLength(10);
    expect(results.filter(result => !result.ok).map(result => result.reason)).toEqual(["ROOM_FULL", "ROOM_FULL"]);
    expect((await store.lesson(room.id)).participants.filter(entry => entry.active !== false)).toHaveLength(10);
  });

  test("two managers move the same student at once from the same view: one change is made, the other is refused as stale", async () => {
    const ctx = await makeBlock({ rooms: ["R1", "R2", "R3"] });
    const seen = await version(ctx);
    const [a, b] = await Promise.all([
      manageBlock({ store, provider: zoom().provider, drive, blockId: ctx.block.id, principal: OWNER, action: "assign", input: { version: seen, member: `${ctx.code}-S1`, room: "R2" }, now: START }),
      manageBlock({ store, provider: zoom().provider, drive, blockId: ctx.block.id, principal: ctx.manager, action: "assign", input: { version: seen, member: `${ctx.code}-S1`, room: "R3" }, now: START }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect([a, b].find(result => result.status === 409).body).toMatchObject({ code: "STALE_VERSION", version: seen + 1 });
    const view = await blockView({ store, blockId: ctx.block.id, now: START });
    expect(["R2", "R3"]).toContain(view.members.find(member => member.code === `${ctx.code}-S1`).seat);
  });
});

describe("nobody gets into a room the server did not put them in", () => {
  test("a student, a tutor and a moved student are refused in other rooms, at the door, for the status and for reports; the page's own parameters change nothing", async () => {
    const ctx = await makeBlock();
    await openAndBreakout(ctx);
    const r2 = await lessonByLabel(ctx, "R2");
    expect((await join(ctx, "R2", asStudent(ctx, 1))).body).toMatchObject({ code: "NOT_ASSIGNED_HERE" });
    expect((await classroomStatus({ store, lessonId: r2.id, ...asStudent(ctx, 1), now: START })).body).toMatchObject({ code: "NOT_ASSIGNED_HERE" });
    expect((await join(ctx, "R2", asStaff(ctx, "T1"))).body).toMatchObject({ code: "NOT_ASSIGNED_HERE" });
    expect((await recordHostReport({ store, provider: zoom().provider, drive, lessonId: r2.id, sessionEmail: ctx.staff[`${ctx.code}-T1`], report: { type: "heartbeat" }, now: START })).body).toMatchObject({ code: "NOT_ASSIGNED_HERE" });
    // Even the Lobby is not this student's place during the breakout (they are seated in R1).
    expect((await join(ctx, "LOBBY", asStudent(ctx, 1))).body).toMatchObject({ code: "NOT_ASSIGNED_HERE" });
    // Moved to R2: the old room refuses them from then on, the new one takes them.
    await manage(ctx, "assign", { member: `${ctx.code}-S1`, room: "R2" });
    expect((await join(ctx, "R1", asStudent(ctx, 1))).body).toMatchObject({ code: "NOT_ASSIGNED_HERE" });
    expect((await join(ctx, "R2", asStudent(ctx, 1))).status).toBe(200);
    // Only the manager or an owner runs the block.
    for (const principal of [{ email: ctx.staff[`${ctx.code}-T1`], owner: false }, { email: null, owner: false }]) {
      expect((await manage(ctx, "recall", {}, { principal })).body).toMatchObject({ code: "NOT_BLOCK_MANAGER" });
    }
  });
});

describe("the breakout, moves, recall, the end, and the 18.2 states", () => {
  test("ASSIGNED → JOINING → JOINED; moved: MOVING until confirmed in the new room; recalled: RETURNING then WAITING; left: DISCONNECTED; a failed join: FAILED; revoked: REVOKED", async () => {
    const ctx = await makeBlock();
    expect((await where(ctx, asStudent(ctx, 1))).body.state).toBe("ASSIGNED");
    await openAndBreakout(ctx);
    const [lobby, r1, r2] = [await lessonByLabel(ctx, "LOBBY"), await lessonByLabel(ctx, "R1"), await lessonByLabel(ctx, "R2")];
    expect((await where(ctx, asStudent(ctx, 1))).body.state).toBe("ASSIGNED");
    await join(ctx, "R1", asStudent(ctx, 1));
    expect((await where(ctx, asStudent(ctx, 1), START + SEC)).body.state).toBe("JOINING");
    await fact(r1.id, "session.user_joined", START + 5 * SEC, { providerSessionId: "ZS-R1", participantId: participantOf(r1, ctx, "S1").id });
    expect((await where(ctx, asStudent(ctx, 1), START + 6 * SEC)).body.state).toBe("JOINED");
    await manage(ctx, "assign", { member: `${ctx.code}-S1`, room: "R2" }, { now: START + 10 * SEC });
    expect((await where(ctx, asStudent(ctx, 1), START + 11 * SEC)).body).toMatchObject({ state: "MOVING", target: { label: "R2" } });
    await fact(r1.id, "session.user_left", START + 12 * SEC, { providerSessionId: "ZS-R1", participantId: participantOf(r1, ctx, "S1")?.id ?? (await store.lesson(r1.id)).participants.find(entry => entry.code === `${ctx.code}-S1`).id });
    const r2now = await store.lesson(r2.id);
    await join(ctx, "R2", asStudent(ctx, 1), { now: START + 13 * SEC });
    await fact(r2.id, "session.user_joined", START + 15 * SEC, { providerSessionId: "ZS-R2", participantId: participantOf(r2now, ctx, "S1").id });
    expect((await where(ctx, asStudent(ctx, 1), START + 16 * SEC)).body.state).toBe("JOINED");
    await manage(ctx, "recall", {}, { now: START + 20 * SEC });
    expect((await where(ctx, asStudent(ctx, 1), START + 21 * SEC)).body).toMatchObject({ state: "RETURNING", target: { kind: "lobby" } });
    await fact(r2.id, "session.user_left", START + 22 * SEC, { providerSessionId: "ZS-R2", participantId: participantOf(r2now, ctx, "S1").id });
    await fact(lobby.id, "session.user_joined", START + 25 * SEC, { providerSessionId: "ZS-L", participantId: participantOf(lobby, ctx, "S1").id });
    expect((await where(ctx, asStudent(ctx, 1), START + 26 * SEC)).body.state).toBe("WAITING");
    await fact(lobby.id, "session.user_left", START + 30 * SEC, { providerSessionId: "ZS-L", participantId: participantOf(lobby, ctx, "S1").id });
    expect((await where(ctx, asStudent(ctx, 1), START + 10 * MIN)).body.state).toBe("DISCONNECTED");
    // S2: its page says joining failed after the token: FAILED (a page's word never makes JOINED).
    await join(ctx, "LOBBY", asStudent(ctx, 2), { now: START + 40 * SEC });
    expect((await where(ctx, asStudent(ctx, 2), START + 41 * SEC)).body.state).toBe("JOINING");
    await blockWhere({ store, blockId: ctx.block.id, ...asStudent(ctx, 2), report: { state: "failed", lessonId: lobby.id }, now: START + 42 * SEC });
    expect((await where(ctx, asStudent(ctx, 2), START + 43 * SEC)).body.state).toBe("FAILED");
    // S3 revoked: the old link gets nothing anywhere; the manager's view says REVOKED.
    const revoked = await manage(ctx, "revoke_link", { member: `${ctx.code}-S3` }, { now: START + 50 * SEC });
    expect(revoked.status).toBe(200);
    expect((await where(ctx, asStudent(ctx, 3), START + 51 * SEC)).status).toBe(403);
    expect((await join(ctx, "LOBBY", asStudent(ctx, 3), { now: START + 51 * SEC })).status).toBe(403);
    expect(revoked.body.view.members.find(member => member.code === `${ctx.code}-S3`).state).toBe("REVOKED");
  });

  test("offline and back: the server keeps where everyone belongs; a page that comes back after the manager moved it is sent to its new room", async () => {
    const ctx = await makeBlock();
    await openAndBreakout(ctx);
    // S1's page goes quiet; meanwhile it is moved, then the breakout is recalled and started again.
    await manage(ctx, "assign", { member: `${ctx.code}-S1`, room: "R2" }, { now: START + MIN });
    await manage(ctx, "recall", {}, { now: START + 2 * MIN });
    await manage(ctx, "start_breakout", { confirm: true }, { now: START + 3 * MIN });
    const back = await where(ctx, asStudent(ctx, 1), START + 10 * MIN);
    expect(back.body.target).toMatchObject({ kind: "room", label: "R2" });
    expect((await join(ctx, "R2", asStudent(ctx, 1), { now: START + 10 * MIN })).status).toBe(200);
  });

  test("a student may go back to the Lobby during the breakout and back to their room; the manager visits a room as an observer, counted in its seats, never a stranger there", async () => {
    const ctx = await makeBlock();
    await openAndBreakout(ctx);
    expect((await chooseInBlock({ store, blockId: ctx.block.id, ...asStudent(ctx, 1), choice: "lobby", now: START + MIN })).body.target).toMatchObject({ kind: "lobby" });
    expect((await join(ctx, "LOBBY", asStudent(ctx, 1), { now: START + MIN })).status).toBe(200);
    expect((await chooseInBlock({ store, blockId: ctx.block.id, ...asStudent(ctx, 1), choice: "room", now: START + 2 * MIN })).body.target).toMatchObject({ kind: "room", label: "R1" });
    // The manager visits R1, as an observer (no host controls), and the room's rules know them.
    expect((await manage(ctx, "visit", { room: "R1" }, { principal: ctx.manager, now: START + 3 * MIN })).status).toBe(200);
    expect((await where(ctx, asStaff(ctx, "M"), START + 3 * MIN)).body.target).toMatchObject({ kind: "room", label: "R1" });
    const visiting = await join(ctx, "R1", asStaff(ctx, "M"), { now: START + 3 * MIN });
    expect(visiting.body).toMatchObject({ ok: true, role: "student", block: { memberRole: "manager" } });
    expect(claimsOf(visiting.body.session.token).role_type).toBe(0);
    const r1 = await store.lesson((await lessonByLabel(ctx, "R1")).id);
    await fact(r1.id, "session.user_joined", START + 4 * MIN, { providerSessionId: "ZS-R1", participantId: participantOf(r1, ctx, "M").id });
    const view = await blockView({ store, blockId: ctx.block.id, now: START + 5 * MIN });
    expect(view.rooms.find(room => room.label === "R1").anomalies.map(entry => entry.code)).not.toContain("UNKNOWN_PARTICIPANT");
    expect((await manage(ctx, "end_visit", {}, { principal: ctx.manager, now: START + 6 * MIN })).status).toBe(200);
    expect((await where(ctx, asStaff(ctx, "M"), START + 6 * MIN)).body.target).toMatchObject({ kind: "lobby" });
  });

  test("ending the block: no new token anywhere, and every live session is ended by the server; cancelling: the same, and the links stop", async () => {
    for (const action of ["end_block", "cancel_block"]) {
      const ctx = await makeBlock();
      const fake = zoom();
      await openAndBreakout(ctx, fake);
      const r1 = await lessonByLabel(ctx, "R1");
      await fact(r1.id, "session.started", START + MIN, { providerSessionId: `ZS-END-${action}`, sessionName: roomNameOf(r1.id, 0) });
      expect((await manage(ctx, action, {}, { fake, now: START + 2 * MIN })).status).toBe(200);
      expect((await where(ctx, asStudent(ctx, 1), START + 3 * MIN)).status).toBe(403);
      for (const label of ["LOBBY", "R1", "R2"]) expect((await join(ctx, label, asStudent(ctx, 1), { now: START + 3 * MIN })).status).toBe(403);
      expect(fake.sent("end").map(([, lessonId, sessionId]) => [lessonId, sessionId])).toContainEqual([r1.id, `ZS-END-${action}`]);
      expect(fake.sent("start")).toEqual([]);
    }
  });

  test("the scheduled tick ends a block's live sessions after the join window closes, with no manager signed in (18.1)", async () => {
    const ctx = await makeBlock();
    await openAndBreakout(ctx);
    const r1 = await lessonByLabel(ctx, "R1");
    await fact(r1.id, "session.started", START + MIN, { providerSessionId: "ZS-LATE", sessionName: roomNameOf(r1.id, 0) });
    const fake = zoom();
    await runClassroomTick({ store, provider: fake.provider, drive, now: START + 60 * MIN + 14 * MIN, lessonIds: [r1.id], workerId: "cron" });
    expect(fake.sent("end")).toEqual([]);
    await runClassroomTick({ store, provider: fake.provider, drive, now: START + 60 * MIN + 16 * MIN, lessonIds: [r1.id], workerId: "cron" });
    expect(fake.sent("end").map(([, , sessionId]) => sessionId)).toEqual(["ZS-LATE"]);
  });
});

describe("the manager away (18.1)", () => {
  test("with the manager gone, rooms carry on: members still enter and read their status, nothing starts recording; a sign-in that ended runs nothing; signing in again does", async () => {
    const ctx = await makeBlock();
    const fake = zoom();
    await openAndBreakout(ctx, fake);
    const later = START + 30 * MIN;
    expect((await join(ctx, "R1", asStudent(ctx, 1), { now: later, fake })).status).toBe(200);
    expect((await join(ctx, "R1", asStaff(ctx, "T1"), { now: later, fake })).status).toBe(200);
    const r1 = await lessonByLabel(ctx, "R1");
    await runClassroomTick({ store, provider: fake.provider, drive, now: later, lessonIds: [r1.id], workerId: "cron" });
    expect(fake.sent("start")).toEqual([]);
    expect((await manage(ctx, "recall", {}, { principal: { email: null, owner: false }, now: later })).body).toMatchObject({ code: "NOT_BLOCK_MANAGER" });
    expect((await manage(ctx, "recall", {}, { principal: ctx.manager, now: later })).status).toBe(200);
  });
});

describe("recording stays safe in a block (第五部分, 18.6)", () => {
  // Consent for everyone in R1 and R2, and every staff notice; the site's switch on; the owner
  // turns the block to Classroom + Recording.
  async function recordingBlock({ consented = [1, 2, 3, 4], noticeFor = ["T1", "T2", "M", "O1"] } = {}) {
    vi.stubEnv("CLASSROOM_MULTI_RECORDING", "on");
    const ctx = await makeBlock();
    for (const n of consented) await setSyntheticConsent({ store, personCode: `${ctx.code}-S${n}`, role: "student", status: "granted", actor: OWNER.email, now: START - 30 * MIN });
    for (const code of noticeFor) await setSyntheticConsent({ store, personCode: `${ctx.code}-${code}`, role: "tutor", status: "granted", actor: OWNER.email, now: START - 30 * MIN });
    return ctx;
  }
  async function live(ctx, label, sessionId, codes, at = START + MIN) {
    const lesson = await store.lesson((await lessonByLabel(ctx, label)).id);
    await fact(lesson.id, "session.started", at, { providerSessionId: sessionId, sessionName: roomNameOf(lesson.id, 0) });
    for (const code of codes) await fact(lesson.id, "session.user_joined", at, { providerSessionId: sessionId, participantId: participantOf(lesson, ctx, code).id });
    return lesson;
  }

  test("Classroom Only (the default): rooms with full consent never start recording; the mode can only be changed by an owner, and only where the site allows it", async () => {
    const ctx = await recordingBlock();
    const fake = zoom();
    await openAndBreakout(ctx, fake);
    const r1 = await live(ctx, "R1", "ZS-CO-R1", ["T1", "S1", "S3"]);
    // Even with recording in blocks allowed for the site, a block nobody switched stays Classroom Only.
    for (const at of [2, 3, 4]) await runClassroomTick({ store, provider: fake.provider, drive, now: START + at * MIN, lessonIds: [r1.id], workerId: "t" });
    expect(fake.sent("start")).toEqual([]);
    vi.stubEnv("CLASSROOM_MULTI_RECORDING", "");
    expect((await manage(ctx, "set_recording_mode", { mode: "classroom_recording" }, { principal: ctx.manager })).body).toMatchObject({ code: "OWNER_REQUIRED" });
    expect((await manage(ctx, "set_recording_mode", { mode: "classroom_recording" })).body).toMatchObject({ code: "RECORDING_NOT_AVAILABLE" });
  });

  test("Classroom + Recording: each room records on its own (start to its own session only); a room missing a consent is not recorded; the Lobby never is", async () => {
    const ctx = await recordingBlock({ consented: [1, 3] }); // R1 has S1 and S3; R2 has S2 and S4 (no consent)
    const fake = zoom();
    await openAndBreakout(ctx, fake);
    expect((await manage(ctx, "set_recording_mode", { mode: "classroom_recording" })).status).toBe(200);
    const r1 = await live(ctx, "R1", "ZS-REC-R1", ["T1", "S1", "S3"]);
    const r2 = await live(ctx, "R2", "ZS-REC-R2", ["T2", "S2", "S4"]);
    const lobby = await live(ctx, "LOBBY", "ZS-REC-L", ["M"]);
    for (const at of [2, 3, 4]) await runClassroomTick({ store, provider: fake.provider, drive, now: START + at * MIN, lessonIds: [r1.id, r2.id, lobby.id], workerId: "t" });
    expect(fake.sent("start").map(([, lessonId, sessionId]) => [lessonId === r1.id ? "R1" : lessonId === r2.id ? "R2" : "LOBBY", sessionId].join(":"))).toEqual(["R1:ZS-REC-R1"]);
    // A recording started in the Lobby anyway (by hand, say): flagged and stopped by the server.
    await fact(lobby.id, "session.recording_started", START + 5 * MIN, { providerSessionId: "ZS-REC-L", status: "Recording" });
    await runClassroomTick({ store, provider: fake.provider, drive, now: START + 6 * MIN, lessonIds: [lobby.id], workerId: "t" });
    expect(fake.sent("stop").map(([, lessonId, sessionId]) => lessonId === lobby.id && sessionId)).toContain("ZS-REC-L");
    expect(fake.sent("stop").some(([, lessonId]) => lessonId === r1.id || lessonId === r2.id)).toBe(false);
  });

  test("the Lobby is never recorded, even with every consent and notice valid, recording on and the manager and students in it", async () => {
    const ctx = await recordingBlock({ consented: [1, 2, 3, 4], noticeFor: ["T1", "T2", "M", "O1"] });
    const fake = zoom();
    expect((await join(ctx, "LOBBY", asStaff(ctx, "M"), { fake })).status).toBe(200);
    expect((await manage(ctx, "open_lobby")).status).toBe(200);
    expect((await manage(ctx, "set_recording_mode", { mode: "classroom_recording" })).status).toBe(200);
    const lobby = await live(ctx, "LOBBY", "ZS-LOBBY-ALL", ["M", "S1", "S2"]);
    for (const at of [2, 3, 4, 5]) await runClassroomTick({ store, provider: fake.provider, drive, now: START + at * MIN, lessonIds: [lobby.id], workerId: "t" });
    expect(fake.sent("start")).toEqual([]);
    const decisions = (await store.eventsFor([lobby.id])).filter(event => event.type === "server.recording_eligibility");
    expect(decisions.every(event => event.eligible === false)).toBe(true);
  });

  test("a room with two tutors records only when both gave the notice", async () => {
    const ctx = await recordingBlock({ consented: [1, 2], noticeFor: ["T1"] });
    const fake = zoom();
    // Make T2 a second tutor of R1 (lead tutors may host any room they are seated in).
    expect((await manage(ctx, "assign", { member: `${ctx.code}-T2`, room: "R1" })).status).toBe(200);
    expect((await manage(ctx, "assign", { member: `${ctx.code}-S2`, room: "R1" })).status).toBe(200);
    expect((await manage(ctx, "assign", { member: `${ctx.code}-S3`, room: "R2" })).status).toBe(200);
    await openAndBreakout(ctx, fake);
    expect((await manage(ctx, "set_recording_mode", { mode: "classroom_recording" })).status).toBe(200);
    const r1 = await live(ctx, "R1", "ZS-2T", ["T1", "T2", "S1", "S2"]);
    for (const at of [2, 3]) await runClassroomTick({ store, provider: fake.provider, drive, now: START + at * MIN, lessonIds: [r1.id], workerId: "t" });
    expect(fake.sent("start")).toEqual([]);
    const decisions = (await store.eventsFor([r1.id])).filter(event => event.type === "server.recording_eligibility");
    expect(decisions.at(-1)).toMatchObject({ eligible: false, reason: "STAFF_NOTICE_MISSING" });
    await setSyntheticConsent({ store, personCode: `${ctx.code}-T2`, role: "tutor", status: "granted", actor: OWNER.email, now: START + 4 * MIN });
    for (const at of [5, 6]) await runClassroomTick({ store, provider: fake.provider, drive, now: START + at * MIN, lessonIds: [r1.id], workerId: "t" });
    expect(fake.sent("start").map(([, , sessionId]) => sessionId)).toEqual(["ZS-2T"]);
  });

  test("into a room that is recording: a student without valid consent or staff without the notice is refused and nothing moves; with consent the move is made and the room decides again", async () => {
    const ctx = await recordingBlock({ consented: [1, 3, 4], noticeFor: ["T1", "T2"] });
    const fake = zoom();
    await openAndBreakout(ctx, fake);
    expect((await manage(ctx, "set_recording_mode", { mode: "classroom_recording" })).status).toBe(200);
    const r1 = await live(ctx, "R1", "ZS-SAFE", ["T1", "S1", "S3"]);
    for (const at of [2, 3]) await runClassroomTick({ store, provider: fake.provider, drive, now: START + at * MIN, lessonIds: [r1.id], workerId: "t" });
    await fact(r1.id, "session.recording_started", START + 3 * MIN + 10 * SEC, { providerSessionId: "ZS-SAFE", status: "Recording" });
    const now = START + 4 * MIN;
    const refused = await manage(ctx, "assign", { member: `${ctx.code}-S2`, room: "R1" }, { now });
    expect(refused).toMatchObject({ status: 409, body: { code: "CONSENT_REQUIRED_FOR_RECORDING_ROOM" } });
    expect((await blockView({ store, blockId: ctx.block.id, now })).members.find(member => member.code === `${ctx.code}-S2`).seat).toBe("R2");
    expect((await manage(ctx, "visit", { member: `${ctx.code}-O1`, room: "R1" }, { now })).body).toMatchObject({ code: "STAFF_NOTICE_REQUIRED_FOR_RECORDING_ROOM" });
    const before = (await store.eventsFor([r1.id])).filter(event => event.type === "server.recording_eligibility").length;
    expect((await manage(ctx, "assign", { member: `${ctx.code}-S4`, room: "R1" }, { now })).status).toBe(200);
    await runClassroomTick({ store, provider: fake.provider, drive, now: now + SEC, lessonIds: [r1.id], workerId: "t" });
    expect((await store.eventsFor([r1.id])).filter(event => event.type === "server.recording_eligibility").length).toBeGreaterThan(before);
    // While the room records, Classroom Only cannot be chosen before it is stopped.
    expect((await manage(ctx, "set_recording_mode", { mode: "classroom_only" }, { now: now + 2 * SEC })).body).toMatchObject({ code: "RECORDING_MAY_BE_ON" });
  });

  test("a student whose consent lapses after being seated in a recording room is kept in the Lobby, never let in", async () => {
    const ctx = await recordingBlock({ consented: [1, 3] });
    const fake = zoom();
    await openAndBreakout(ctx, fake);
    expect((await manage(ctx, "set_recording_mode", { mode: "classroom_recording" })).status).toBe(200);
    const r1 = await live(ctx, "R1", "ZS-LAPSE", ["T1", "S1", "S3"]);
    for (const at of [2, 3]) await runClassroomTick({ store, provider: fake.provider, drive, now: START + at * MIN, lessonIds: [r1.id], workerId: "t" });
    await fact(r1.id, "session.recording_started", START + 3 * MIN + 10 * SEC, { providerSessionId: "ZS-LAPSE", status: "Recording" });
    const [consent] = await store.listConsents([`${ctx.code}-S3`]);
    await store.setConsent({ ...consent, expiresAt: START + 4 * MIN });
    const answer = await where(ctx, asStudent(ctx, 3), START + 5 * MIN);
    expect(answer.body.target).toMatchObject({ kind: "lobby", heldBack: "CONSENT_REQUIRED_FOR_RECORDING_ROOM" });
    expect((await join(ctx, "R1", asStudent(ctx, 3), { now: START + 5 * MIN })).body).toMatchObject({ code: "NOT_ASSIGNED_HERE" });
    expect((await join(ctx, "LOBBY", asStudent(ctx, 3), { now: START + 5 * MIN })).status).toBe(200);
  });

  test("an unresolved start (UNKNOWN): the mode cannot change; the read-only check asks Zoom and sends nothing; the stop goes to that room's session only (18.7)", async () => {
    const ctx = await recordingBlock({ consented: [1, 2, 3, 4] });
    const fake = zoom({ observe: () => ({ live: true, recording: null }) });
    fake.provider.startRecording = async (lesson, sessionId) => { fake.calls.push(["start", lesson.id, sessionId]); return { ok: false, httpStatus: 504 }; };
    await openAndBreakout(ctx, fake);
    expect((await manage(ctx, "set_recording_mode", { mode: "classroom_recording" })).status).toBe(200);
    const r1 = await live(ctx, "R1", "ZS-UNK", ["T1", "S1", "S3"]);
    const r2 = await live(ctx, "R2", "ZS-OTHER", ["T2", "S2", "S4"]);
    for (const at of [2, 3, 4]) await runClassroomTick({ store, provider: fake.provider, drive, now: START + at * MIN, lessonIds: [r1.id], workerId: "t" });
    const view = await blockView({ store, blockId: ctx.block.id, now: START + 5 * MIN });
    const card = view.rooms.find(room => room.label === "R1");
    expect(card.operations.some(entry => entry.state === "UNKNOWN" || entry.state === "UNCERTAIN")).toBe(true);
    expect(card.advice).toMatch(/唯讀查核/);
    expect((await manage(ctx, "set_recording_mode", { mode: "classroom_only" }, { now: START + 5 * MIN })).body).toMatchObject({ code: "UNKNOWN_RECORDING_STATE" });
    const starts = fake.sent("start").length;
    const checked = await manage(ctx, "check_recording", { room: "R1" }, { fake, now: START + 5 * MIN });
    expect(checked.body).toMatchObject({ ok: true, sent: 0, observed: [{ sessionId: "ZS-UNK", live: true, recording: null }] });
    expect(fake.sent("start")).toHaveLength(starts);
    const stopped = await manage(ctx, "stop_room_recording", { room: "R1" }, { fake, now: START + 6 * MIN });
    expect(stopped.status).toBe(200);
    expect(fake.sent("stop").map(([, lessonId, sessionId]) => [lessonId === r1.id, sessionId])).toEqual([[true, "ZS-UNK"]]);
    expect(fake.sent("stop").some(([, lessonId]) => lessonId === r2.id)).toBe(false);
  });
});

describe("staff see their blocks", () => {
  test("a tutor and the manager see the block on their list; a stranger does not; a block's rooms are never listed as one-to-one lessons", async () => {
    const ctx = await makeBlock();
    const tutor = await myClassroomBlocks({ store, email: ctx.staff[`${ctx.code}-T1`], now: START });
    expect(tutor.find(entry => entry.code === ctx.code)).toMatchObject({ role: "lead_tutor", manages: false });
    expect((await myClassroomBlocks({ store, email: ctx.manager.email, now: START })).find(entry => entry.code === ctx.code)).toMatchObject({ manages: true });
    expect(await myClassroomBlocks({ store, email: "stranger@example.test", now: START })).toEqual([]);
  });
});
