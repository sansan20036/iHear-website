// The room channel on PostgreSQL (2026-11-23): the draft tables (db/room-channel/031…, on top of
// the migrations production has, up to 030) and the PostgreSQL store, on a localhost-only disposable PostgreSQL that this
// test creates and removes. It never loads .env, never uses an inherited database address and
// never reaches a hosted database. Synthetic data only.
//
// It needs Docker and the postgres:17-alpine image already on this computer (it never pulls), so
// it runs only when asked for:
//   ROOM_CHANNEL_PG=1 node --test "tests/room-channel/postgres.test.mjs"
// Without that, the file says so and does nothing.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test, { after, before } from 'node:test';
import { fileURLToPath } from 'node:url';

import postgres from 'postgres';

import { createRoomChannel } from '../../lib/room-channel/service.mjs';
import { createPostgresStore } from '../../lib/room-channel/store-postgres.mjs';
import { LESSONS, serviceSuite } from './service-suite.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const asked = process.env.ROOM_CHANNEL_PG === '1';
const T0 = 1_800_000_000_000;

if (!asked) {
  test('PostgreSQL store: not run (set ROOM_CHANNEL_PG=1; needs Docker and the postgres:17-alpine image)', { skip: true }, () => {});
} else {
  const container = `ihear-room-channel-${randomUUID()}`;
  const password = 'isolated-room-channel-test-only';
  const docker = args => execFileSync('docker', args, { encoding: 'utf8', windowsHide: true, timeout: 60_000, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  const TABLES = ['classroom_room_channel', 'classroom_room_board_lines', 'classroom_room_board_parts', 'classroom_room_board_ops'];
  const up = readFileSync(path.join(ROOT, 'db', 'room-channel', '031_classroom_room_channel.sql'), 'utf8');
  const down = readFileSync(path.join(ROOT, 'db', 'room-channel', '031_classroom_room_channel.down.sql'), 'utf8');
  let sql = null, second = null, started = false;
  const connect = port => postgres(`postgres://postgres:${password}@127.0.0.1:${port}/postgres`, { ssl: false, max: 6, prepare: false, connect_timeout: 3, onnotice: () => {} });
  const tablesNow = async () => (await sql`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name LIKE 'classroom_room_%' ORDER BY 1`).map(row => row.table_name);

  before(async () => {
    docker(['run', '--detach', '--pull=never', '--name', container, '--label', 'ihear-test=room-channel', '-p', '127.0.0.1::5432', '-e', `POSTGRES_PASSWORD=${password}`, 'postgres:17-alpine']);
    started = true;
    const port = docker(['port', container, '5432/tcp']).match(/^127\.0\.0\.1:(\d+)$/m)?.[1];
    if (!port) throw new Error('Expected a localhost-only PostgreSQL port');
    sql = connect(port);
    second = connect(port);
    let ready = false;
    for (let attempt = 0; attempt < 60 && !ready; attempt += 1) {
      try { await sql`SELECT 1`; ready = true; } catch { await new Promise(resolve => { setTimeout(resolve, 500); }); }
    }
    if (!ready) throw new Error('The disposable PostgreSQL did not become ready');
    // Today's production structure: every migration up to 030, in order, and nothing after it.
    const files = readdirSync(path.join(ROOT, 'db', 'migrations')).filter(name => /^\d+_[a-z0-9_]+\.sql$/i.test(name) && name.split('_', 1)[0] <= '030').sort();
    assert.equal(files.at(-1).split('_', 1)[0], '030');
    assert.equal(readdirSync(path.join(ROOT, 'db', 'migrations')).some(name => name.startsWith('031')), false, 'the draft is not among the migrations the runner applies');
    for (const name of files) await sql.begin(tx => tx.unsafe(readFileSync(path.join(ROOT, 'db', 'migrations', name), 'utf8')));
    await sql.begin(tx => tx.unsafe(up));
    for (const [index, id] of LESSONS.entries()) {
      await sql`INSERT INTO public.classroom_lessons (id, code, lesson_date, starts_at, ends_at, created_by) VALUES (${id}, ${`TEST-${index}`}, '2027-01-15', '2027-01-15T08:00:00Z', '2027-01-15T11:00:00Z', 'room-channel-test')`;
    }
  });
  after(async () => {
    await sql?.end({ timeout: 5 }).catch(() => undefined);
    await second?.end({ timeout: 5 }).catch(() => undefined);
    if (started) { try { docker(['rm', '--force', '--volumes', container]); } catch { /* reported by the next run's docker ps */ } }
  });

  const empty = async () => { await sql`TRUNCATE public.classroom_room_channel, public.classroom_room_board_lines, public.classroom_room_board_parts, public.classroom_room_board_ops`; };
  // The same tests as over the store in memory (one seed of the long comparison: it is about 4,500 exchanges).
  serviceSuite({ label: 'PostgreSQL: ', seeds: [11], quick: process.env.ROOM_CHANNEL_PG_QUICK === '1', make: async () => { await empty(); return createPostgresStore(sql); } });

  test('PG-1: the draft names no table but classroom_lessons, protects its tables, and its down file takes exactly them away', async () => {
    assert.deepEqual(await tablesNow(), [...TABLES].sort());
    const open = await sql`SELECT relname FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relname LIKE 'classroom_room_%' AND relkind = 'r' AND NOT relrowsecurity`;
    assert.deepEqual(open.map(row => row.relname), [], 'row level security is on for each of the four tables');
    // Of the tables that were there before, its foreign keys name classroom_lessons and no other.
    const named = await sql`SELECT DISTINCT target.relname FROM pg_constraint c JOIN pg_class source ON source.oid = c.conrelid JOIN pg_class target ON target.oid = c.confrelid WHERE c.contype = 'f' AND source.relname LIKE 'classroom_room_%' AND target.relname NOT LIKE 'classroom_room_%'`;
    assert.deepEqual(named.map(row => row.relname), ['classroom_lessons']);
    // Applied again it changes nothing; taken away and put back, the tables are as before.
    const shape = async () => (await sql`SELECT table_name, column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema = 'public' AND table_name LIKE 'classroom_room_%' ORDER BY 1, ordinal_position`).map(row => Object.values(row).join(' '));
    const first = await shape();
    await sql.begin(tx => tx.unsafe(up));
    assert.deepEqual(await shape(), first);
    await sql.begin(tx => tx.unsafe(down));
    assert.deepEqual(await tablesNow(), []);
    assert.equal((await sql`SELECT count(*)::int AS lessons FROM public.classroom_lessons`)[0].lessons, LESSONS.length, 'the down file touches nothing else');
    await sql.begin(tx => tx.unsafe(up));
    assert.deepEqual(await shape(), first);
  });

  test('PG-2: a lesson that is deleted takes its whiteboard, chat and turn with it', async () => {
    await empty();
    await sql`INSERT INTO public.classroom_lessons (id, code, lesson_date, starts_at, ends_at, created_by) VALUES ('L-temp', 'TEST-TEMP', '2027-01-15', '2027-01-15T08:00:00Z', '2027-01-15T11:00:00Z', 'room-channel-test')`;
    const store = createPostgresStore(sql), channel = createRoomChannel(store);
    const lesson = { id: 'L-temp', roomId: 'FR-1', scheduledEnd: T0 + 3 * 3_600_000, endedAt: null, people: ['P-1'] };
    const answer = await channel.exchange({ lesson, who: { id: 'P-1', name: 'P-1', member: true }, on: { board: true, chat: true, turn: true }, now: T0, send: [
      { part: 'board', input: { kind: 'stroke', op: 'a-0', line: 'a', part: 0, points: [[1, 1], [2, 2]], color: 1, width: 2, done: true } }, { part: 'chat', input: { op: 'm1', text: 'hi' } }, { part: 'turn', action: 'claim' }] });
    assert.deepEqual(answer.sent.map(item => item.ok), [true, true, true]);
    assert.deepEqual((await store.stats(T0)).parts, { board: 1, chat: 1, turn: 1 });
    await sql`DELETE FROM public.classroom_lessons WHERE id = 'L-temp'`;
    const held = await store.stats(T0);
    assert.deepEqual([held.parts, held.lines, held.operations], [{ board: 0, chat: 0, turn: 0 }, 0, 0]);
    assert.equal((await sql`SELECT count(*)::int AS parts FROM public.classroom_room_board_parts`)[0].parts, 0);
  });

  test('PG-3: the tables themselves refuse what the rules never write', async () => {
    await empty();
    const row = (part, state = {}) => sql`INSERT INTO public.classroom_room_channel (lesson_id, part, seq, state, last_at, delete_after) VALUES ('L-1', ${part}, 0, ${sql.json(state)}, NOW(), NOW())`;
    await assert.rejects(row('files'), /check/i);
    await assert.rejects(sql`INSERT INTO public.classroom_room_channel (lesson_id, part, seq, state, last_at, delete_after) VALUES ('L-none', 'chat', 0, '{}'::jsonb, NOW(), NOW())`, /foreign key/i);
    await assert.rejects(row('chat', { filler: 'x'.repeat(600_001) }), /check/i);
    await assert.rejects(sql`INSERT INTO public.classroom_room_board_parts (lesson_id, line, part, points) VALUES ('L-1', 'P-1:none', 0, '[[1,1]]'::jsonb)`, /foreign key/i);
    await assert.rejects(sql`INSERT INTO public.classroom_room_board_lines (lesson_id, line, sender, color, width, parts, points, done, began_seq) VALUES ('L-1', 'P-1:a', 'P-1', 9, 2, 1, 1, false, 1)`, /check/i);
    await assert.rejects(sql`INSERT INTO public.classroom_room_board_lines (lesson_id, line, sender, color, width, parts, points, done, began_seq) VALUES ('L-1', 'P-1:a', 'P-1', 1, 3, 1, 1, false, 1)`, /check/i);
    assert.equal((await createPostgresStore(sql).stats(T0)).lines, 0);
  });

  test('PG-4: two servers writing to the same room at once: one order, nothing lost, nothing twice', async () => {
    await empty();
    const servers = [createRoomChannel(createPostgresStore(sql)), createRoomChannel(createPostgresStore(second))];
    const lesson = { id: 'L-1', roomId: 'FR-1', scheduledEnd: T0 + 3 * 3_600_000, endedAt: null, people: ['P-1', 'P-2', 'P-3', 'P-4'] };
    const jobs = [];
    for (let round = 0; round < 30; round += 1) {
      for (const [index, id] of lesson.people.entries()) {
        const input = { kind: 'stroke', op: `r${round}`, line: `r${round}`, part: 0, points: [[round, index]], color: 1, width: 2, done: true };
        // The same request reaches both servers (a page that sent it again): it counts once.
        jobs.push(servers[index % 2].exchange({ lesson, who: { id, name: id, member: true }, on: { board: true, chat: false, turn: false }, now: T0 + round * 200, send: [{ part: 'board', input }] }));
        if (round % 5 === 0) jobs.push(servers[(index + 1) % 2].exchange({ lesson, who: { id, name: id, member: true }, on: { board: true, chat: false, turn: false }, now: T0 + round * 200, send: [{ part: 'board', input }] }));
      }
    }
    const answers = (await Promise.all(jobs)).map(answer => answer.sent[0]);
    assert.ok(answers.every(answer => answer.ok), JSON.stringify(answers.find(answer => !answer.ok)));
    const firsts = answers.filter(answer => !answer.duplicate).map(answer => answer.seq).sort((a, b) => a - b);
    assert.deepEqual(firsts, Array.from({ length: 120 }, (_, index) => index + 1));
    assert.equal(answers.filter(answer => answer.duplicate).length, 24);
    const store = createPostgresStore(sql);
    const row = await store.withPart('L-1', 'board', tx => tx.read());
    assert.deepEqual([row.state.seq, row.state.shown], [120, { lines: 120, points: 120 }]);
    assert.equal((await store.stats(T0)).lines, 120);
  });
}
