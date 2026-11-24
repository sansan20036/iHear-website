// The step that puts the room channel's tables on the TEST database, rehearsed for real: the same
// main() the command runs, its own child script and the site's own migration runner, against a
// localhost-only disposable PostgreSQL that this test creates and removes. It never loads .env,
// never uses an inherited database address and never reaches a hosted database.
//
// Two things are played, because a local database has neither: that the address names the expected
// Supabase project (the test says "it does"), and git (the files are taken as committed). Both
// guards are tested for themselves in apply-test-db.test.mjs.
//
// It needs Docker and the postgres:17-alpine image already on this computer (it never pulls):
//   ROOM_CHANNEL_PG=1 node --test tests/room-channel/apply-test-db.postgres.test.mjs
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';
import { fileURLToPath } from 'node:url';

import postgres from 'postgres';

import { createRoomChannel } from '../../lib/room-channel/service.mjs';
import { createPostgresStore } from '../../lib/room-channel/store-postgres.mjs';
import { main } from '../../tools/room-channel-db/apply-test-db.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

if (process.env.ROOM_CHANNEL_PG !== '1') {
  test('the 031 step on a real database: not run (set ROOM_CHANNEL_PG=1; needs Docker and the postgres:17-alpine image)', { skip: true }, () => {});
} else {
  const container = `ihear-room-channel-step-${randomUUID()}`;
  const password = 'isolated-room-channel-step-only';
  const REF = 'rehearsal00000000000';
  const WORDS = 'rehearsal on a disposable local database';
  const docker = args => execFileSync('docker', args, { encoding: 'utf8', windowsHide: true, timeout: 60_000, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'ihear-room-channel-step-'));
  const evidence = path.join(scratch, 'evidence.json');
  let port = null, address = null, db = null, started = false;

  // The same main() as the command, with the real child processes; only the two things a local
  // database cannot give are played.
  const spawned = (cmd, args, { cwd, env } = {}) => new Promise(resolve => {
    const child = spawn(cmd, args, { cwd, env, windowsHide: true });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.on('error', error => resolve({ code: 127, stdout, stderr: error.message }));
    child.on('close', code => resolve({ code: code ?? 1, stdout, stderr }));
  });
  const step = async (...more) => {
    const logs = [];
    const code = await main(['--db-env', 'played', '--expect-ref', REF, '--evidence', evidence, ...more], {
      log: text => logs.push(text),
      readSettings: () => ({ POSTGRES_URL: address }),
      target: () => ({ ref: REF }),
      childEnv: { TEST_DB_SSL: 'disable', POSTGRES_SSL: 'disable' },
      exec: (cmd, args, options) => (cmd === 'git' ? Promise.resolve({ code: 0, stdout: args.includes('status') ? '' : `${'b'.repeat(40)}\n`, stderr: '' }) : spawned(cmd, args, options)),
    });
    return { code, said: logs.join('\n') };
  };
  const schema = () => docker(['exec', container, 'pg_dump', '-U', 'postgres', '-d', 'rehearsal', '--schema-only', '--no-owner', '--no-privileges'])
    .split('\n').filter(line => line.trim() && !line.startsWith('--') && !/^(SET |SELECT pg_catalog\.set_config|\\(un)?restrict)/.test(line)).join('\n');
  const ledger = async () => (await db`SELECT version FROM public.schema_migrations ORDER BY version`).map(row => row.version);
  const roomTables = async () => (await db`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name LIKE 'classroom_room_%' ORDER BY 1`).map(row => row.table_name);

  before(async () => {
    docker(['run', '--detach', '--pull=never', '--name', container, '--label', 'ihear-test=room-channel', '-p', '127.0.0.1::5432', '-e', `POSTGRES_PASSWORD=${password}`, 'postgres:17-alpine']);
    started = true;
    port = docker(['port', container, '5432/tcp']).match(/^127\.0\.0\.1:(\d+)$/m)?.[1];
    if (!port) throw new Error('Expected a localhost-only PostgreSQL port');
    const admin = postgres(`postgres://postgres:${password}@127.0.0.1:${port}/postgres`, { ssl: false, max: 1, prepare: false, connect_timeout: 3, onnotice: () => {} });
    let ready = false;
    for (let attempt = 0; attempt < 60 && !ready; attempt += 1) {
      try { await admin`SELECT 1`; ready = true; } catch { await new Promise(resolve => { setTimeout(resolve, 500); }); }
    }
    if (!ready) throw new Error('The disposable PostgreSQL did not start');
    await admin.unsafe('CREATE DATABASE rehearsal');
    await admin.end({ timeout: 5 });
    address = `postgres://postgres:${password}@127.0.0.1:${port}/rehearsal`;
    db = postgres(address, { ssl: false, max: 3, prepare: false, onnotice: () => {} });
    // A database as the release tool's migrate-test-db leaves it, short of its marker: 001–030 by
    // the site's own runner, with something in it.
    const workspace = path.join(scratch, 'to-030');
    mkdirSync(path.join(workspace, 'db', 'migrations'), { recursive: true });
    for (const name of readdirSync(path.join(ROOT, 'db', 'migrations')).filter(file => /^\d+_[a-z0-9_]+\.sql$/i.test(file))) copyFileSync(path.join(ROOT, 'db', 'migrations', name), path.join(workspace, 'db', 'migrations', name));
    const run = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'migrate-database.mjs')], { cwd: workspace, encoding: 'utf8', windowsHide: true, timeout: 120_000,
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: os.tmpdir(), TMP: os.tmpdir(), POSTGRES_URL: address, DATABASE_URL: '', POSTGRES_SSL: 'disable' } });
    assert.equal(run.status, 0, String(run.stderr).slice(-300));
    await db`INSERT INTO public.classroom_lessons (id, code, lesson_date, starts_at, ends_at, created_by) VALUES ('L-kept', 'TEST-KEPT', '2027-01-15', '2027-01-15T08:00:00Z', '2027-01-15T10:00:00Z', 'room-channel-step-test')`;
  });
  after(async () => {
    await db?.end({ timeout: 5 }).catch(() => undefined);
    if (started) { try { docker(['rm', '--force', '--volumes', container]); } catch { /* reported by the caller's own check for leftovers */ } }
    rmSync(scratch, { recursive: true, force: true });
  });

  test('TS-1: the whole way on a real database: refused without the marker; a dry run writes nothing; applied once; "already applied"; back to exactly 030; applied again', async () => {
    assert.equal((await ledger()).at(-1), '030');
    const at030 = schema();

    // No marker yet: not a test database for this step, also with every word of approval given.
    const unmarked = await step('--execute', '--authorization', WORDS);
    assert.equal(unmarked.code, 1);
    assert.match(unmarked.said, /no test marker/);
    assert.deepEqual([(await ledger()).at(-1), await roomTables()], ['030', []]);

    // The marker, as the release tool leaves it.
    await db.unsafe('CREATE TABLE public._ihear_test_marker (note text NOT NULL, created_at timestamptz NOT NULL DEFAULT now())');
    await db.unsafe('ALTER TABLE public._ihear_test_marker ENABLE ROW LEVEL SECURITY');
    await db`INSERT INTO public._ihear_test_marker (note) VALUES ('rehearsal')`;
    const marked = schema();

    const dry = await step();
    assert.equal(dry.code, 0, dry.said);
    assert.match(dry.said, /Dry run: nothing was written/);
    assert.deepEqual([(await ledger()).at(-1), await roomTables()], ['030', []]);
    assert.equal(schema(), marked);

    const applied = await step('--execute', '--authorization', WORDS);
    assert.equal(applied.code, 0, applied.said);
    assert.match(applied.said, /4 tables, protected, no policy, empty/);
    assert.equal((await ledger()).at(-1), '031');
    assert.equal((await roomTables()).length, 4);
    assert.equal((await db`SELECT count(*)::int AS n FROM public.classroom_lessons`)[0].n, 1, 'the row that was there is there');
    const record = JSON.parse(readFileSync(evidence, 'utf8'));
    assert.deepEqual([record.action, record.result, record.authorization, record.runner.applied, record.before.latest, record.after.latest], ['apply', 'PASS', WORDS, ['031_classroom_room_channel.sql'], '030', '031']);
    assert.ok(!readFileSync(evidence, 'utf8').includes(password) && !applied.said.includes(password), 'the password is nowhere');

    const again = await step('--execute', '--authorization', WORDS);
    assert.equal(again.code, 0);
    assert.match(again.said, /already applied/);

    // The tables work: the channel keeps a stroke and a message in them.
    const channel = createRoomChannel(createPostgresStore(db));
    const kept = await channel.exchange({ lesson: { id: 'L-kept', roomId: 'FR-1', scheduledEnd: 1_800_000_000_000 + 7_200_000, endedAt: null, people: ['P-1'] }, who: { id: 'P-1', name: 'P-1', member: true },
      on: { board: true, chat: true, turn: true }, now: 1_800_000_000_000, send: [{ part: 'board', input: { kind: 'stroke', op: 'a-0', line: 'a', part: 0, points: [[1, 1]], color: 1, width: 2, done: true } }, { part: 'chat', input: { op: 'm1', text: 'hi' } }] });
    assert.deepEqual(kept.sent.map(item => item.ok), [true, true]);

    // The way back does not throw rows away unless told to; then the structure is what it was.
    const kept031 = await step('--down', '--execute', '--authorization', WORDS);
    assert.equal(kept031.code, 1);
    assert.match(kept031.said, /--discard-rows/);
    assert.equal((await ledger()).at(-1), '031');
    const back = await step('--down', '--discard-rows', '--execute', '--authorization', WORDS);
    assert.equal(back.code, 0, back.said);
    assert.deepEqual([(await ledger()).at(-1), await roomTables()], ['030', []]);
    assert.equal(schema(), marked, 'after going back the structure is exactly what it was with the marker at 030');
    assert.notEqual(at030, marked, 'the marker itself is the only difference from the plain 030 structure');
    assert.equal((await db`SELECT count(*)::int AS n FROM public.classroom_lessons`)[0].n, 1);

    const forward = await step('--execute', '--authorization', WORDS);
    assert.equal(forward.code, 0, forward.said);
    assert.deepEqual([(await ledger()).at(-1), (await roomTables()).length], ['031', 4]);
    assert.equal((await db`SELECT count(*)::int AS n FROM public.classroom_room_channel`)[0].n, 0, 'applied anew, and empty');
  });
}
