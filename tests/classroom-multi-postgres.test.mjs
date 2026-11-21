import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readdir, readFile, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import postgres from 'postgres';
import { createClassroomBlock, manageBlock } from '../lib/classroom-blocks';
import { createClassroomLesson, joinClassroom } from '../lib/classroom-service';
import { manageFixedRoom, manageFixedRoomsBulk, requestEntry, requestStatus } from '../lib/classroom-fixed-rooms';
import { createPostgresClassroomStore } from '../lib/classroom-store';
import { buildSessionTokenClaims, signSessionToken } from '../tools/recording-pathway/classroom/eligibility.mjs';

// P3-Multi (2026-11-09): 029 (db/migrations) applied on top of migration 028, on a localhost-only
// disposable PostgreSQL created and removed by this test. It never loads .env, uses an inherited
// database URL or connects to a hosted database; 029 is applied here only, never by the project's
// migration runner. Synthetic data only.
const container = `ihear-multi-${randomUUID()}`;
const password = 'isolated-multi-test-only';
const MIN = 60_000;
const START = Date.parse('2026-12-01T08:00:00Z');
const docker = args => execFileSync('docker', args, { encoding: 'utf8', windowsHide: true, timeout: 60000, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
let started = false, port, workspace, sql, store;
const clients = [];
const databaseUrl = database => `postgres://postgres:${password}@127.0.0.1:${port}/${database}`;
function connect(database, max = 12) {
  const client = postgres(databaseUrl(database), { ssl: false, max, prepare: false, connect_timeout: 2, onnotice: () => {} });
  clients.push(client);
  return client;
}

beforeAll(async () => {
  docker(['run', '--detach', '--pull=never', '--name', container, '--label', 'ihear-test=classroom-multi', '-p', '127.0.0.1::5432', '-e', `POSTGRES_PASSWORD=${password}`, 'postgres:17-alpine']);
  started = true;
  port = docker(['port', container, '5432/tcp']).match(/^127\.0\.0\.1:(\d+)$/)?.[1];
  if (!port) throw new Error('Expected a localhost-only PostgreSQL port');
  const root = connect('postgres', 2);
  let ready = false;
  for (let attempt = 0; attempt < 60 && !ready; attempt++) {
    try { await root`SELECT 1`; ready = true; } catch { await new Promise(resolve => { setTimeout(resolve, 300); }); }
  }
  if (!ready) throw new Error('Disposable PostgreSQL did not become ready');
  await root.unsafe('CREATE DATABASE classroom_multi');
  workspace = await mkdtemp(path.join(os.tmpdir(), 'ihear-multi-migrations-'));
  await mkdir(path.join(workspace, 'db', 'migrations'), { recursive: true });
  for (const file of (await readdir('db/migrations')).filter(name => /^\d+_[a-z0-9_]+\.sql$/i.test(name) && name.split('_', 1)[0] <= '028')) {
    await copyFile(path.join('db', 'migrations', file), path.join(workspace, 'db', 'migrations', file));
  }
  const result = spawnSync(process.execPath, [path.resolve('scripts/migrate-database.mjs')], {
    cwd: workspace, encoding: 'utf8', windowsHide: true, timeout: 120000,
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: os.tmpdir(), TMP: os.tmpdir(), POSTGRES_URL: databaseUrl('classroom_multi'), DATABASE_URL: '', POSTGRES_SSL: 'disable' },
  });
  if (result.status !== 0) throw new Error(`Migration runner failed: ${result.stderr}`);
  expect(JSON.parse(result.stdout.trim().split('\n').pop()).applied.at(-1)).toBe('028_classroom_mvp.sql');
  sql = connect('classroom_multi');
  await sql.unsafe(await readFile(path.join('db', 'migrations', '029_classroom_multiroom.sql'), 'utf8'));
  store = createPostgresClassroomStore(sql);
}, 180000);

afterAll(async () => {
  for (const client of clients) await client.end({ timeout: 2 });
  if (started) docker(['rm', '--force', '--volumes', container]);
  if (workspace && (await realpath(workspace)).startsWith(await realpath(os.tmpdir()))) await rm(workspace, { recursive: true, force: true });
}, 30000);

const provider = {
  name: 'synthetic', webhookSecret: null,
  sessionToken: ({ lesson, participant, now, generation = 0 }) => ({ token: signSessionToken(buildSessionTokenClaims({ lesson, participant, appKey: 'pg-app', now, generation }), 'pg-secret-not-real'), issuedAt: now, expiresAt: now + 30 * MIN }),
  startRecording: async () => ({ ok: true, httpStatus: 202 }), stopRecording: async () => ({ ok: true, httpStatus: 202 }), endSession: async () => ({ ok: true, httpStatus: 204 }),
  removeUser: async () => ({ ok: false, httpStatus: 501 }), snapshot: async () => null, download: async () => Buffer.alloc(0), deleteRecording: async () => ({ ok: false, httpStatus: 501 }),
};
const drive = { kind: 'local', rootFolderId: 'root' };
let blocks = 0;
async function block({ students = 3, seats = true } = {}) {
  blocks += 1;
  const code = `TEST-PG${blocks}`;
  const members = [{ code: `${code}-M`, role: 'manager', englishName: 'Mia Manager', email: `pg-m${blocks}@example.test` },
    { code: `${code}-T`, role: 'lead_tutor', englishName: 'Carol Chen', email: `pg-t${blocks}@example.test` },
    ...Array.from({ length: students }, (_, index) => ({ code: `${code}-S${index + 1}`, role: 'student', englishName: `Student ${String.fromCharCode(65 + index)}` }))];
  const created = await createClassroomBlock({
    store, actor: 'pg-owner@example.test', now: START - 60 * MIN,
    input: { code, date: '2026-12-01', time: '16:00', minutes: 60, rooms: ['R1', 'R2'], members, assignments: seats ? [{ member: `${code}-T`, room: 'R1' }, { member: `${code}-S1`, room: 'R1' }] : [] },
  });
  return { code, created, block: await store.block(created.block.blockId) };
}

describe('draft 029 on PostgreSQL', () => {
  test('applies on top of 028: two new tables with row level security; a one-to-one lesson still keeps 028\x27s identity rule', async () => {
    const tables = await sql`
      SELECT c.relname AS name, c.relrowsecurity AS rls FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname IN ('classroom_blocks', 'classroom_block_members') ORDER BY c.relname
    `;
    expect(tables).toEqual([{ name: 'classroom_block_members', rls: true }, { name: 'classroom_blocks', rls: true }]);
    const { lesson } = await createClassroomLesson({ store, actor: 'pg-owner@example.test', now: START, input: { code: 'TEST-PG-L1', date: '2026-12-01', time: '16:00', minutes: 60, tutorCode: 'TEST-PG-LT', tutorEmail: 'pg-lt@example.test', studentCode: 'TEST-PG-LS' } });
    const stored = await store.lesson(lesson.id);
    expect(stored).toMatchObject({ blockId: null, roomKind: null, participants: [{ role: 'tutor', memberId: null, active: true }, { role: 'student', memberId: null, active: true }] });
    // A one-to-one student row without a key, or an observer outside a block, is still refused.
    await expect(sql`INSERT INTO public.classroom_participants (lesson_id, participant_id, code, role) VALUES (${lesson.id}, 'P-bad', 'TEST-PG-X', 'student')`).rejects.toThrow(/classroom_participants_identity/);
    await expect(sql`INSERT INTO public.classroom_participants (lesson_id, participant_id, code, role, staff_email) VALUES (${lesson.id}, 'P-obs', 'TEST-PG-O', 'observer', 'o@example.test')`).rejects.toThrow(/classroom_participants_identity/);
  });

  test('a block reads back as written: members (no e-mail or key on any room row), its Lobby and rooms, version 0', async () => {
    const { block: stored, code } = await block();
    expect(stored).toMatchObject({ code, version: 0, cancelled: false });
    expect(stored.members.map(member => member.role).sort()).toEqual(['lead_tutor', 'manager', 'student', 'student', 'student']);
    const lobby = await store.lesson(stored.lobbyId);
    expect(lobby).toMatchObject({ blockId: stored.id, roomKind: 'lobby', roomLabel: 'LOBBY' });
    expect(lobby.participants.every(entry => entry.staffEmail === null && entry.joinKeyHash === null && entry.seat === 'lobby')).toBe(true);
    const r1 = await store.lesson(stored.roomIds[0]);
    expect(r1.participants.map(entry => [entry.code, entry.role, entry.seat]).sort()).toEqual([[`${code}-S1`, 'student', 'assigned'], [`${code}-T`, 'tutor', 'assigned']]);
  });

  test('twelve seat changes into one room at the same moment, from twelve connections: exactly ten get in (the block row is locked)', async () => {
    const { block: stored } = await block({ students: 12, seats: false });
    const room = stored.roomIds[1];
    const pool = connect('classroom_multi', 12);
    const parallel = createPostgresClassroomStore(pool);
    const results = await Promise.all(stored.members.filter(member => member.role === 'student').map(member => parallel.changeBlock({
      blockId: stored.id, seat: { memberId: member.id, roomId: room, seat: 'assigned', capacity: 10, participant: { id: `P-${member.id.slice(2)}`, code: member.code, role: 'student' } }, events: [],
    })));
    expect(results.filter(result => result.ok)).toHaveLength(10);
    expect(results.filter(result => !result.ok).map(result => result.reason)).toEqual(['ROOM_FULL', 'ROOM_FULL']);
    const [{ count }] = await sql`SELECT count(*)::int AS count FROM public.classroom_participants WHERE lesson_id = ${room} AND active`;
    expect(count).toBe(10);
    expect((await store.block(stored.id)).version).toBe(10);
  });

  test('two changes made on the same version at the same moment: one is made, the other refused as stale, nothing half-done', async () => {
    const { block: stored, code } = await block();
    const student = stored.members.find(member => member.code === `${code}-S2`);
    const pool = connect('classroom_multi', 4);
    const parallel = createPostgresClassroomStore(pool);
    const change = room => parallel.changeBlock({ blockId: stored.id, expectedVersion: 0, seat: { memberId: student.id, roomId: room, seat: 'assigned', capacity: 10, participant: { id: `P-${randomUUID().replace(/-/g, '')}`, code: student.code, role: 'student' } }, events: [] });
    const results = await Promise.all([change(stored.roomIds[0]), change(stored.roomIds[1])]);
    expect(results.map(result => result.ok ? 'ok' : result.reason).sort()).toEqual(['STALE_VERSION', 'ok']);
    const rows = await sql`SELECT lesson_id FROM public.classroom_participants WHERE member_id = ${student.id} AND active AND seat = 'assigned'`;
    expect(rows).toHaveLength(1);
  });

  test('a link revoked: every row of that student gets a new id in one step; a second change on the old ids changes nothing', async () => {
    const { block: stored, code } = await block();
    const student = stored.members.find(member => member.code === `${code}-S1`);
    const lessons = await Promise.all([stored.lobbyId, ...stored.roomIds].map(id => store.lesson(id)));
    const rotations = lessons.flatMap(lesson => lesson.participants.filter(entry => entry.memberId === student.id).map(entry => ({ lessonId: lesson.id, fromId: entry.id, toId: `P-${randomUUID().replace(/-/g, '')}` })));
    expect(rotations).toHaveLength(2);
    const first = await store.changeBlock({ blockId: stored.id, rotate: { memberId: student.id, keyHash: 'a'.repeat(64), rotations }, events: [] });
    expect(first.ok).toBe(true);
    const again = await store.changeBlock({ blockId: stored.id, rotate: { memberId: student.id, keyHash: 'b'.repeat(64), rotations }, events: [] });
    expect(again).toMatchObject({ ok: false, reason: 'CHANGED_CONCURRENTLY' });
    const after = await store.block(stored.id);
    expect(after.members.find(member => member.id === student.id).joinKeyHash).toBe('a'.repeat(64));
    const room = await store.lesson(stored.roomIds[0]);
    expect(room.participants.find(entry => entry.memberId === student.id)).toMatchObject({ id: rotations.find(entry => entry.lessonId === room.id).toId, active: false });
  });

  // Round 3 (2026-11-21): fixed rooms on PostgreSQL. Twelve people let in at the same moment from
  // separate connections: the lesson's lock keeps it to ten, one lesson is opened, every person has a
  // row and a code of their own; a ticket enters its lesson; taking one out frees a place.
  test('FR-PG: a fixed room on PostgreSQL: twelve let in at once give ten seats in one lesson, two told the room is full; a ticket enters; a removal frees a place', async () => {
    vi.stubEnv('CLASSROOM_FIXED_ROOMS', 'on');
    try {
      const now = Date.parse('2026-12-23T08:00:00Z');
      const owner = { email: 'pg-rooms-owner@example.test', owner: true };
      const pool = connect('classroom_multi', 8);
      const parallel = createPostgresClassroomStore(pool);
      const act = (action, input, at = now, on = store) => manageFixedRoom({ store: on, provider, drive, principal: owner, action, input, now: at });
      const made = await act('create', { label: 'PG Room' });
      expect(made.status).toBe(201);
      const roomId = made.body.room.id;
      const key = new URLSearchParams(made.body.link.split('#')[1]).get('k');
      const asked = [];
      for (let n = 0; n < 12; n += 1) {
        const answer = await requestEntry({ store, roomId, key, name: `P${String.fromCharCode(65 + n)}`, now });
        expect(answer.status).toBe(200);
        asked.push(answer.body);
      }
      const first = await Promise.all(asked.map(entry => act('admit', { room: roomId, request: entry.requestId }, now, parallel)));
      // Any answered "try again" are asked once more, one at a time (the iHear teacher pressing again).
      const answers = [...first];
      for (const [index, answer] of first.entries()) if (answer.body.code === 'TRY_AGAIN') answers[index] = await act('admit', { room: roomId, request: asked[index].requestId });
      expect(answers.filter(answer => answer.status === 200)).toHaveLength(10);
      expect(answers.filter(answer => answer.body.code === 'ROOM_FULL')).toHaveLength(2);
      const states = await Promise.all(asked.map(entry => requestStatus({ store, roomId, requestId: entry.requestId, ticket: entry.ticket, now })));
      const lessons = new Set(states.filter(answer => answer.body.state === 'admitted').map(answer => answer.body.lessonId));
      expect(lessons.size).toBe(1);
      const [lessonId] = [...lessons];
      const [{ count: rows }] = await sql`SELECT count(*)::int AS count FROM public.classroom_participants WHERE lesson_id = ${lessonId} AND role = 'student' AND active`;
      expect(rows).toBe(10);
      const [{ codes }] = await sql`SELECT count(DISTINCT code)::int AS codes FROM public.classroom_participants WHERE lesson_id = ${lessonId}`;
      expect(codes).toBe(10);
      const inside = asked[states.findIndex(answer => answer.body.state === 'admitted')];
      const entered = await joinClassroom({ store, provider, lessonId, key: inside.ticket, now });
      expect(entered.status).toBe(200);
      expect(entered.body.fixedRoom).toBe(true);
      // One taken out: their ticket gets nothing; a place is free for one of the two who waited.
      expect((await act('remove', { room: roomId, request: inside.requestId }, now + MIN)).status).toBe(200);
      expect((await joinClassroom({ store, provider, lessonId, key: inside.ticket, now: now + MIN })).body.code).toBe('NOT_ON_ROSTER');
      const waited = asked[answers.findIndex(answer => answer.body.code === 'ROOM_FULL')];
      expect((await act('admit', { room: roomId, request: waited.requestId }, now + 2 * MIN)).status).toBe(200);
      const [{ count: after }] = await sql`SELECT count(*)::int AS count FROM public.classroom_participants WHERE lesson_id = ${lessonId} AND role = 'student'`;
      expect(after).toBe(11);
    } finally {
      vi.stubEnv('CLASSROOM_FIXED_ROOMS', '');
    }
  });

  // Round 7 (2026-11-21): a room taken out of use and back, the same room changed twice at the same
  // moment from separate connections, and rooms made and their links given again in bulk, at once
  // from two connections.
  test('FR-PG2: on PostgreSQL a room out of use closes its waiting requests for good and takes new ones once back; two link replacements at once give one link; 30 rooms made in bulk, then all their links given twice at once: each room one new link, the other told it changed', async () => {
    vi.stubEnv('CLASSROOM_FIXED_ROOMS', 'on');
    try {
      const now = Date.parse('2026-12-24T08:00:00Z');
      const owner = { email: 'pg-rooms-owner@example.test', owner: true };
      const pool = connect('classroom_multi', 8);
      const parallel = createPostgresClassroomStore(pool);
      const act = (action, input, at = now, on = store) => manageFixedRoom({ store: on, provider, drive, principal: owner, action, input, now: at });
      const keyOf = link => new URLSearchParams(link.split('#')[1]).get('k');
      const made = await act('create', { label: 'PG Use Room' });
      expect(made.status).toBe(201);
      const roomId = made.body.room.id;
      const waiting = await requestEntry({ store, roomId, key: keyOf(made.body.link), name: 'Ann', now });
      expect(waiting.status).toBe(200);
      const stateOf = async at => (await requestStatus({ store, roomId, requestId: waiting.body.requestId, ticket: waiting.body.ticket, now: at })).body.state;
      expect((await act('disable', { room: roomId }, now + 1)).body).toMatchObject({ ok: true, inUse: false });
      expect((await requestEntry({ store, roomId, key: keyOf(made.body.link), name: 'Bo', now: now + 2 })).body.code).toBe('ROOM_DISABLED');
      expect(await stateOf(now + 2)).toBe('closed');
      expect((await act('enable', { room: roomId }, now + MIN)).body).toMatchObject({ ok: true, inUse: true });
      expect(await stateOf(now + MIN)).toBe('closed');
      expect((await requestEntry({ store, roomId, key: keyOf(made.body.link), name: 'Ann', now: now + MIN })).status).toBe(200);
      const [{ count: uses }] = await sql`SELECT count(*)::int AS count FROM public.classroom_events WHERE lesson_id = ${roomId} AND type IN ('server.room_disabled', 'server.room_enabled')`;
      expect(uses).toBe(2);

      // Two replacements of one room's link at the same moment, from two connections.
      const twice = await Promise.all([act('replace_link', { room: roomId }, now + 2 * MIN, parallel), act('replace_link', { room: roomId }, now + 2 * MIN)]);
      expect(twice.map(answer => answer.status).sort()).toEqual([200, 409]);
      expect(twice.find(answer => answer.status === 409).body.code).toBe('CHANGED_CONCURRENTLY');
      const winner = twice.find(answer => answer.status === 200).body.link;
      expect((await requestEntry({ store, roomId, key: keyOf(winner), name: 'Cy', now: now + 2 * MIN })).status).toBe(200);
      expect((await requestEntry({ store, roomId, key: keyOf(made.body.link), name: 'Di', now: now + 2 * MIN })).body.code).toBe('LINK_REPLACED');

      // 30 rooms in bulk; then every link given again twice at once, from two connections.
      const bulk = (action, input, on = store) => manageFixedRoomsBulk({ store: on, principal: owner, action, input, now: now + 3 * MIN });
      const many = await bulk('create_many', { prefix: 'PGB', from: 1, to: 30 });
      expect(many.status).toBe(201);
      expect(many.body.rooms).toHaveLength(30);
      expect([many.body.failed, many.body.unknown, many.body.notAttempted]).toEqual([[], [], []]);
      const ids = many.body.rooms.map(room => room.id);
      const both = await Promise.all([bulk('export_links', { rooms: ids }, parallel), bulk('export_links', { rooms: ids })]);
      for (const answer of both) expect(answer.status).toBe(200);
      const links = both.flatMap(answer => answer.body.links);
      const failed = both.flatMap(answer => answer.body.failed);
      expect(links).toHaveLength(30);
      expect(new Set(links.map(entry => entry.room)).size).toBe(30);
      expect(failed).toHaveLength(30);
      expect(new Set(failed.map(entry => entry.code))).toEqual(new Set(['CHANGED_CONCURRENTLY']));
      expect(new Set(links.map(entry => entry.generation))).toEqual(new Set([2]));
      // Each room's link given out works; each room's first link lets nobody new in.
      for (const entry of links.slice(0, 5)) {
        expect((await requestEntry({ store, roomId: entry.room, key: keyOf(entry.link), name: 'Ed', now: now + 4 * MIN })).status).toBe(200);
        const first = many.body.rooms.find(room => room.id === entry.room).link;
        expect((await requestEntry({ store, roomId: entry.room, key: keyOf(first), name: 'Fay', now: now + 4 * MIN })).body.code).toBe('LINK_REPLACED');
      }
    } finally {
      vi.stubEnv('CLASSROOM_FIXED_ROOMS', '');
    }
  });

  test('the whole flow on PostgreSQL: the manager enters the Lobby, opens it, starts the breakout; a student is let into its room only; cancelling closes every lesson', async () => {
    const { block: stored, created, code } = await block();
    const manager = { email: `pg-m${blocks}@example.test`, owner: false };
    const key = new URLSearchParams(created.studentLinks.find(entry => entry.code === `${code}-S1`).link.split('#')[1]).get('k');
    expect((await joinClassroom({ store, provider, lessonId: stored.lobbyId, sessionEmail: manager.email, now: START })).status).toBe(200);
    for (const [action, input] of [['open_lobby', {}], ['start_breakout', { confirm: true }]]) {
      const version = (await store.block(stored.id)).version;
      expect((await manageBlock({ store, provider, drive, blockId: stored.id, principal: manager, action, input: { version, ...input }, now: START })).status).toBe(200);
    }
    expect((await joinClassroom({ store, provider, lessonId: stored.roomIds[0], key, now: START })).status).toBe(200);
    expect((await joinClassroom({ store, provider, lessonId: stored.roomIds[1], key, now: START })).body).toMatchObject({ code: 'NOT_ASSIGNED_HERE' });
    const version = (await store.block(stored.id)).version;
    expect((await manageBlock({ store, provider, drive, blockId: stored.id, principal: manager, action: 'cancel_block', input: { version }, now: START + MIN })).status).toBe(200);
    const cancelled = await sql`SELECT count(*)::int AS count FROM public.classroom_lessons WHERE block_id = ${stored.id} AND cancelled`;
    expect(cancelled[0].count).toBe(3);
    expect((await joinClassroom({ store, provider, lessonId: stored.roomIds[0], key, now: START + MIN })).status).toBe(403);
  });
});
