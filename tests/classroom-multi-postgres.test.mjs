import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readdir, readFile, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import postgres from 'postgres';
import { createClassroomBlock, manageBlock } from '../lib/classroom-blocks';
import { createClassroomLesson, joinClassroom } from '../lib/classroom-service';
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
