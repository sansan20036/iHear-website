import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";

// Who is asking, and what a request to the room channel costs, when everything is on PostgreSQL
// (2026-11-24). Two things:
//   1. the one-statement check (lib/room-channel/caller-postgres.mjs) answers exactly as the check
//      through the classroom store does (lib/room-channel/caller.ts), case by case;
//   2. a measurement of a look and of a stroke, with the check as it is today and with the
//      one-statement check, on a lesson with few events and with many. A measurement, not a rule.
// A disposable local PostgreSQL that this file creates and removes; it never loads .env and never
// reaches a hosted database. Synthetic people only.
//   ROOM_CHANNEL_PG=1 npx vitest run tests/room-channel/vitest/route-cost.test.mjs
// Without ROOM_CHANNEL_PG=1 it does nothing. It says nothing about the production site: there the
// database is elsewhere and every statement is a trip over a network.
const asked = process.env.ROOM_CHANNEL_PG === "1";
vi.mock("../../../auth.js", () => ({ auth: vi.fn() }));

const ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
const container = `ihear-room-channel-route-${randomUUID()}`;
const password = "isolated-room-channel-route-only";
const docker = args => execFileSync("docker", args, { encoding: "utf8", windowsHide: true, timeout: 60_000, stdio: ["pipe", "pipe", "pipe"] }).trim();
const ORIGIN = "http://localhost:3000";
const MIN = 60_000, HOUR = 60 * MIN;
const START = Date.parse("2026-12-10T15:00:00Z");
const OWNER = { email: "rooms-owner@example.test", owner: true };
const ON = { board: true, chat: true, turn: true };
const provider = { name: "synthetic", webhookSecret: null, sessionToken: () => ({ token: "x", issuedAt: 0, expiresAt: 0 }), startRecording: async () => ({ ok: true, httpStatus: 202 }), stopRecording: async () => ({ ok: true, httpStatus: 202 }), endSession: async () => ({ ok: true, httpStatus: 204 }), removeUser: async () => ({ ok: false, httpStatus: 501 }), snapshot: async () => null, observe: async () => ({ live: false, recording: null }), download: async () => Buffer.alloc(0), deleteRecording: async () => ({ ok: false, httpStatus: 501 }) };
const spread = values => { const sorted = [...values].sort((a, b) => a - b); const at = share => Math.round(sorted[Math.min(sorted.length - 1, Math.floor(share * sorted.length))] * 10) / 10; return { n: sorted.length, p50: at(0.5), p95: at(0.95), max: at(1) }; };
const keyOf = link => new URLSearchParams(link.split("#")[1]).get("k");
let started = false, made = 0;

describe.skipIf(!asked)("the room channel on PostgreSQL: who is asking, and what a request costs", () => {
  let channelRoute, rooms, store, drive, sql, sqlCaller, channel, hashKey, roomChannelCaller, personAndPlaceLimit, askedOf, createClassroomLesson;
  const manage = (action, input = {}, now = START) => rooms.manageFixedRoom({ store, provider, drive, principal: OWNER, action, input, now });
  async function roomWith(names, now = START) {
    made += 1;
    const created = await manage("create", { label: `Cost ${made}` }, now);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const room = { id: created.body.room.id, key: keyOf(created.body.link) };
    const people = [];
    for (const name of names) {
      const request = await rooms.requestEntry({ store, roomId: room.id, key: room.key, name, now });
      expect((await manage("admit", { room: room.id, request: request.body.requestId }, now)).status).toBe(200);
      people.push({ ticket: request.body.ticket, requestId: request.body.requestId });
    }
    const lessonId = (await rooms.requestStatus({ store, roomId: room.id, requestId: people[0].requestId, ticket: people[0].ticket, now })).body.lessonId;
    return { room, people, lessonId };
  }

  beforeAll(async () => {
    docker(["run", "--detach", "--pull=never", "--name", container, "--label", "ihear-test=room-channel", "-p", "127.0.0.1::5432", "-e", `POSTGRES_PASSWORD=${password}`, "postgres:17-alpine"]);
    started = true;
    const port = docker(["port", container, "5432/tcp"]).match(/^127\.0\.0\.1:(\d+)$/m)?.[1];
    const url = `postgres://postgres:${password}@127.0.0.1:${port}/postgres`;
    const { default: postgres } = await import("postgres");
    sql = postgres(url, { ssl: false, max: 2, prepare: false, connect_timeout: 3, onnotice: () => {} });
    let ready = false;
    for (let attempt = 0; attempt < 60 && !ready; attempt += 1) { try { await sql`SELECT 1`; ready = true; } catch { await new Promise(resolve => { setTimeout(resolve, 500); }); } }
    expect(ready).toBe(true);
    const files = readdirSync(path.join(ROOT, "db", "migrations")).filter(name => /^\d+_[a-z0-9_]+\.sql$/i.test(name) && name.split("_", 1)[0] <= "030").sort();
    for (const name of files) await sql.begin(tx => tx.unsafe(readFileSync(path.join(ROOT, "db", "migrations", name), "utf8")));
    await sql.begin(tx => tx.unsafe(readFileSync(path.join(ROOT, "db", "room-channel", "031_classroom_room_channel.sql"), "utf8")));
    vi.stubEnv("POSTGRES_URL", url);
    vi.stubEnv("POSTGRES_SSL", "disable");
    vi.stubEnv("IHEAR_FORCE_FILE_STORE", "");
    vi.stubEnv("CLASSROOM_DRIVE", "local");
    vi.stubEnv("VERCEL_ENV", "");
    vi.stubEnv("CLASSROOM_FIXED_ROOMS", "on");
    for (const name of ["CLASSROOM_ROOM_BOARD", "CLASSROOM_ROOM_CHAT", "CLASSROOM_ROOM_SHARE_TURN"]) vi.stubEnv(name, "on");
    store = (await import("../../../lib/classroom-store")).classroomStore();
    drive = (await import("../../../lib/classroom-drive")).classroomDrive();
    rooms = await import("../../../lib/classroom-fixed-rooms");
    ({ createClassroomLesson } = await import("../../../lib/classroom-service"));
    ({ hashKey } = await import("../../../lib/classroom-block-rules"));
    ({ roomChannelCaller } = await import("../../../lib/room-channel/caller"));
    ({ personAndPlaceLimit } = await import("../../../lib/classroom-rate-limit"));
    channelRoute = await import("../../../app/api/classroom/[lessonId]/room-channel/route");
    const { createPostgresCaller } = await import("../../../lib/room-channel/caller-postgres.mjs");
    const { createPostgresStore } = await import("../../../lib/room-channel/store-postgres.mjs");
    const service = await import("../../../lib/room-channel/service.mjs");
    askedOf = service.askedOf;
    sqlCaller = createPostgresCaller(sql);
    channel = service.createRoomChannel(createPostgresStore(sql));
  }, 180_000);
  afterAll(async () => {
    vi.unstubAllEnvs();
    await sql?.end({ timeout: 5 }).catch(() => undefined);
    if (started) { try { docker(["rm", "--force", "--volumes", container]); } catch { /* shown by docker ps */ } }
  });

  test("IC-1: the one-statement check answers as the check through the classroom store does, case by case", async () => {
    const first = await roomWith(["Kyle", "Ann", "Bo"]);
    const elsewhere = await roomWith(["Kim"]);
    const ending = await roomWith(["Lee", "May"]);
    const plain = await createClassroomLesson({ store, actor: OWNER.email, now: START - HOUR, input: { code: "TEST-IC-PLAIN", date: "2026-12-10", time: "10:00", minutes: 60, tutorCode: "TEST-ICT", tutorEmail: "ic-tutor@example.test", studentCode: "TEST-ICS", timeZone: "America/New_York" } });
    expect((await manage("remove", { room: first.room.id, request: first.people[2].requestId }, START + MIN)).status).toBe(200);
    expect((await manage("end_lesson", { room: ending.room.id }, START + 50 * MIN)).status).toBe(200);
    const keys = [
      ["their own ticket", first.people[0].ticket], ["another person's ticket", first.people[1].ticket], ["the ticket of a person taken out", first.people[2].ticket], ["no ticket", null], ["a ticket that is no one's", "not-a-ticket"],
      ["the ticket of a person in another room", elsewhere.people[0].ticket], ["the room's own link key", first.room.key], ["a one-to-one lesson's link", keyOf(plain.studentLink)], ["a ticket of the lesson that was ended", ending.people[0].ticket],
    ];
    const lessons = [["the room's lesson", first.lessonId], ["another room's lesson", elsewhere.lessonId], ["a lesson the teacher ended", ending.lessonId], ["a one-to-one lesson", plain.lesson.id], ["no lesson", "L-does-not-exist"]];
    const moments = [START - 20 * MIN, START + 2 * MIN, START + 51 * MIN, START + 2 * HOUR, START + 3 * HOUR - 1, START + 3 * HOUR, START + 3 * HOUR + 10 * MIN, START + 27 * HOUR];
    const tidy = answer => (answer.ok ? { ...answer, lesson: { ...answer.lesson, people: [...answer.lesson.people].sort() } } : answer);
    let compared = 0, allowed = 0;
    for (const [lessonLabel, lessonId] of lessons) {
      for (const [keyLabel, key] of keys) {
        for (const now of moments) {
          const reference = tidy(await roomChannelCaller({ store, lessonId, key, now }));
          const one = tidy(await sqlCaller.who({ lessonId, keyHash: key ? hashKey(key) : null, now }));
          expect(one, `${lessonLabel}, ${keyLabel}, at ${Math.round((now - START) / MIN)} min`).toEqual(reference);
          compared += 1;
          if (reference.ok) allowed += 1;
        }
      }
    }
    expect([compared, allowed > 20, allowed < compared / 2]).toEqual([lessons.length * keys.length * moments.length, true, true]);
    // The person taken out: refused by both from the moment of the removal; the others' list no longer holds that place.
    const after = await sqlCaller.who({ lessonId: first.lessonId, keyHash: hashKey(first.people[0].ticket), now: START + 2 * MIN });
    expect(after.lesson.people).toHaveLength(2);
    expect(await sqlCaller.who({ lessonId: first.lessonId, keyHash: hashKey(first.people[2].ticket), now: START + 2 * MIN })).toEqual({ ok: false, status: 403, code: "NOT_IN_ROOM" });
    // Who is asking and what is new, in one statement: the same news as asked apart, and none for someone refused.
    const lesson = (await roomChannelCaller({ store, lessonId: first.lessonId, key: first.people[0].ticket, now: START + 2 * MIN }));
    await channel.exchange({ lesson: lesson.lesson, who: lesson.who, on: ON, now: START + 2 * MIN, send: [{ part: "board", input: { kind: "stroke", op: "a-0", line: "a", part: 0, points: [[1, 1]], color: 1, width: 2, done: true } }, { part: "chat", input: { op: "m1", text: "hello" } }] });
    const cursors = askedOf(ON, { board: 0, chat: 0, turn: 0 }).asked;
    const together = await sqlCaller.look({ lessonId: first.lessonId, keyHash: hashKey(first.people[1].ticket), cursors, now: START + 3 * MIN });
    expect(together.caller.ok).toBe(true);
    expect([together.seen.board.entries.length, together.seen.chat.messages.length]).toEqual([1, 1]);
    const refused = await sqlCaller.look({ lessonId: first.lessonId, keyHash: hashKey(first.people[2].ticket), cursors, now: START + 3 * MIN });
    expect(refused).toEqual({ caller: { ok: false, status: 403, code: "NOT_IN_ROOM" }, seen: null });
  }, 300_000);

  test("IC-2: a look and a stroke, with the check as it is and with the one-statement check: time, and how often the database is asked", async () => {
    const now0 = Date.now();
    const { people, lessonId } = await roomWith(["Kyle", "Ann", "Bo"], now0);
    const request = body => new Request(`${ORIGIN}/api/classroom/${lessonId}/room-channel`, { method: "POST", headers: { "content-type": "application/json", origin: ORIGIN, "x-forwarded-for": "203.0.113.10" }, body: JSON.stringify(body) });
    // A: the route as it is (the limit, the check through the classroom store, the channel).
    const asItIs = async body => {
      const began = performance.now();
      const response = await channelRoute.POST(request(body), { params: Promise.resolve({ lessonId }) });
      await response.json();
      return { status: response.status, ms: performance.now() - began };
    };
    // B: the same steps, the check by one statement; a look reads who and what is new together.
    const oneStatement = async body => {
      const began = performance.now();
      const decision = await personAndPlaceLimit(request(body), { scope: "classroom-room-channel", place: lessonId, person: body.key, perPerson: 900, perPlace: 9_000 });
      if (decision.limited) return { status: decision.response.status, ms: performance.now() - began };
      const now = Date.now(), keyHash = hashKey(body.key), send = body.send ?? [];
      let caller = null, seen = null;
      if (send.length) caller = await sqlCaller.who({ lessonId, keyHash, now });
      else ({ caller, seen } = await sqlCaller.look({ lessonId, keyHash, cursors: askedOf(ON, body.cursors).asked, now }));
      if (!caller.ok) return { status: caller.status, ms: performance.now() - began };
      const result = await channel.exchange({ lesson: caller.lesson, who: caller.who, on: ON, cursors: body.cursors, send, now, seen });
      return { status: result.ok ? 200 : 400, ms: performance.now() - began };
    };
    // The database counts its own transactions (a statement sent alone is one; BEGIN…COMMIT is one),
    // but an idle connection hands its count in only after about ten seconds: so wait before reading.
    const counter = async () => Number((await sql`SELECT xact_commit + xact_rollback AS n FROM pg_stat_database WHERE datname = current_database()`)[0].n);
    const settled = async () => { await new Promise(resolve => { setTimeout(resolve, 11_500); }); return counter(); };
    // The very first request of a new server process is answered 503 by the several-bucket request
    // limit (lib/rate-limit.ts: a new database client's first query cannot carry an array with the
    // client library in use; found by this measurement). It is counted here, not hidden.
    let firstRefused = 0;
    for (let n = 0; n < 10; n += 1) { const warm = await asItIs({ key: people[0].ticket, cursors: { board: 0, chat: 0, turn: 0 } }); if (n === 0 && warm.status === 503) firstRefused += 1; else expect(warm.status).toBe(200); }
    for (let n = 0; n < 5; n += 1) expect((await oneStatement({ key: people[0].ticket, cursors: { board: 0, chat: 0, turn: 0 } })).status).toBe(200);
    let serial = 0;
    const measure = async (post, count, make) => {
      const before = await settled();
      const times = [];
      for (let n = 0; n < count; n += 1) { const result = await post(make()); expect(result.status).toBe(200); times.push(result.ms); }
      // The counter's own first reading is one transaction: taken off.
      return { ...spread(times), databaseTransactionsEach: Math.round(((await settled()) - before - 1) / count * 10) / 10 };
    };
    const look = () => ({ key: people[1].ticket, cursors: { board: 0, chat: 0, turn: 0 } });
    const stroke = () => { serial += 1; return { key: people[0].ticket, cursors: { board: 0 }, send: [{ part: "board", input: { kind: "stroke", op: `s${serial}`, line: `l${serial}`, part: 0, points: [[serial % 9000, 1], [5, 5]], color: 1, width: 2, done: true } }] }; };
    const result = { measuredAt: new Date(now0).toISOString(), what: "one person after another, through the route's own steps (no HTTP server, no Next.js), on a disposable local PostgreSQL", firstRequestOfTheProcessRefusedByTheLimit: firstRefused };
    result.fewEvents = {
      eventsOfTheLesson: Number((await sql`SELECT count(*) AS n FROM public.classroom_events WHERE lesson_id = ${lessonId}`)[0].n),
      asItIs: { look: await measure(asItIs, 120, look) }, oneStatement: { look: await measure(oneStatement, 120, look) },
    };
    // A lesson late in its three hours: many facts on record (joins and leaves, reports, decisions).
    await sql`INSERT INTO public.classroom_events (key, lesson_id, type, source, occurred_at, received_at, data)
      SELECT 'measure:' || ${lessonId} || ':' || n, ${lessonId}, 'host.report', 'host_sdk', NOW(), NOW(), jsonb_build_object('source', 'host_sdk', 'type', 'host.report', 'lessonId', ${lessonId}::text, 'occurredAt', ${now0}::bigint + n, 'receivedAt', ${now0}::bigint + n, 'key', 'measure:' || n, 'filler', repeat('x', 300))
      FROM generate_series(1, 2000) AS n`;
    result.manyEvents = {
      eventsOfTheLesson: Number((await sql`SELECT count(*) AS n FROM public.classroom_events WHERE lesson_id = ${lessonId}`)[0].n),
      asItIs: { look: await measure(asItIs, 120, look), stroke: await measure(asItIs, 120, stroke) },
      oneStatement: { look: await measure(oneStatement, 120, look), stroke: await measure(oneStatement, 120, stroke) },
    };
    console.log(`ROUTE COST ${JSON.stringify(result)}`);
    if (process.env.ROOM_CHANNEL_COST_OUT) writeFileSync(process.env.ROOM_CHANNEL_COST_OUT, `${JSON.stringify(result, null, 2)}\n`);
    expect(result.manyEvents.oneStatement.look.n).toBe(120);
  }, 600_000);
});
