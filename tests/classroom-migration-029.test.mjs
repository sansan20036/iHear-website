import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import postgres from 'postgres';
import { createClassroomBlock } from '../lib/classroom-blocks';
import { createClassroomLesson } from '../lib/classroom-service';
import { createPostgresClassroomStore } from '../lib/classroom-store';

// P3-Multi B5 (2026-11-09): how 028 and the draft 029 reach a database, checked on a localhost-only
// disposable PostgreSQL 17 created and removed by this test, through the project's own migration
// runner (scripts/migrate-database.mjs) with 029 placed in a temporary copy of db/migrations: a new
// database; one at 027 (today's production structure) with data; one at 028 with one-to-one
// lessons; a run repeated; a broken 029 that fails half way; two runners at once; an edited 029
// after it was applied; and a backup, the draft rollback and a restore. It never loads .env, uses an
// inherited database address or reaches a hosted database; nothing here approves 029 (M-8) or 028 (H8).
// Synthetic data only. Run by itself: npm run test:classroom:migration (Docker needed).
vi.setConfig({ testTimeout: 180000 });
const container = `ihear-mig029-${randomUUID()}`;
const password = 'isolated-migration-test-only';
const MIN = 60_000;
const START = Date.parse('2026-12-01T08:00:00Z');
const docker = (args, input) => execFileSync('docker', args, { encoding: 'utf8', windowsHide: true, timeout: 120000, stdio: ['pipe', 'pipe', 'pipe'], ...(input ? { input } : {}) }).trim();
let started = false, port;
const clients = [];
const workspaces = [];
const url = database => `postgres://postgres:${password}@127.0.0.1:${port}/${database}`;
const connect = database => { const client = postgres(url(database), { ssl: false, max: 4, prepare: false, connect_timeout: 2, onnotice: () => {} }); clients.push(client); return client; };
const MIGRATION_029 = path.join('db', 'multiroom', '029_classroom_multiroom.sql');
const DOWN_029 = path.join('db', 'multiroom', '029_classroom_multiroom.down.sql');
let root, migrations, up029, down029, up030, down030;

beforeAll(async () => {
  docker(['run', '--detach', '--pull=never', '--name', container, '--label', 'ihear-test=classroom-migration', '-p', '127.0.0.1::5432', '-e', `POSTGRES_PASSWORD=${password}`, 'postgres:17-alpine']);
  started = true;
  port = docker(['port', container, '5432/tcp']).match(/^127\.0\.0\.1:(\d+)$/)?.[1];
  if (!port) throw new Error('Expected a localhost-only PostgreSQL port');
  root = connect('postgres');
  let ready = false;
  for (let attempt = 0; attempt < 60 && !ready; attempt++) {
    try { await root`SELECT 1`; ready = true; } catch { await new Promise(resolve => { setTimeout(resolve, 300); }); }
  }
  if (!ready) throw new Error('Disposable PostgreSQL did not become ready');
  migrations = (await readdir('db/migrations')).filter(name => /^\d+_[a-z0-9_]+\.sql$/i.test(name)).sort();
  up029 = await readFile(MIGRATION_029, 'utf8');
  down029 = await readFile(DOWN_029, 'utf8');
  up030 = await readFile(path.join('db', 'multiroom', '030_classroom_programs.sql'), 'utf8');
  down030 = await readFile(path.join('db', 'multiroom', '030_classroom_programs.down.sql'), 'utf8');
}, 180000);

afterAll(async () => {
  for (const client of clients) await client.end({ timeout: 2 });
  if (started) docker(['rm', '--force', '--volumes', container]);
  for (const workspace of workspaces) {
    if ((await realpath(workspace)).startsWith(await realpath(os.tmpdir()))) await rm(workspace, { recursive: true, force: true });
  }
}, 60000);

async function database(name) {
  await root.unsafe(`CREATE DATABASE ${name}`);
  return connect(name);
}

// The project's runner on a temporary copy of db/migrations: every file up to `upTo`, and 029 (as
// given) when asked. Resolves with its exit code and its one-line report.
async function migrate(name, { upTo = '028', with029 = null, with030 = null } = {}) {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'ihear-mig029-'));
  workspaces.push(workspace);
  await mkdir(path.join(workspace, 'db', 'migrations'), { recursive: true });
  for (const file of migrations.filter(file => file.split('_')[0] <= upTo)) await copyFile(path.join('db', 'migrations', file), path.join(workspace, 'db', 'migrations', file));
  if (with029 != null) await writeFile(path.join(workspace, 'db', 'migrations', '029_classroom_multiroom.sql'), with029);
  if (with030 != null) await writeFile(path.join(workspace, 'db', 'migrations', '030_classroom_programs.sql'), with030);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.resolve('scripts/migrate-database.mjs')], {
      cwd: workspace, windowsHide: true,
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: os.tmpdir(), TMP: os.tmpdir(), POSTGRES_URL: url(name), DATABASE_URL: '', POSTGRES_SSL: 'disable' },
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', status => {
      const line = (status === 0 ? stdout : stderr).trim().split('\n').pop() || '{}';
      resolve({ status, report: JSON.parse(line) });
    });
  });
}

const tableNames = async sql => (await sql`
  SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname LIKE 'classroom_%' ORDER BY c.relname
`).map(row => row.name);
const recorded = async sql => (await sql`SELECT version FROM public.schema_migrations ORDER BY version`).map(row => row.version);
const columns = async (sql, table) => (await sql`SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ${table} ORDER BY column_name`).map(row => row.column_name);
// The schema as pg_dump writes it (inside the container), without comments, settings or the
// per-run \restrict keys, so two dumps of the same structure compare equal.
const schemaOf = name => docker(['exec', container, 'pg_dump', '-U', 'postgres', '-d', name, '--schema-only', '--no-owner', '--no-privileges'])
  .split('\n').filter(line => line.trim() && !line.startsWith('--') && !/^(SET |SELECT pg_catalog\.set_config|\\(un)?restrict)/.test(line)).join('\n');

// A SQL file run as psql -f would: on its own connection, closed afterwards (a failed transaction
// is rolled back with it).
async function runFile(name, text) {
  const one = postgres(url(name), { ssl: false, max: 1, prepare: false, connect_timeout: 2, onnotice: () => {} });
  try { await one.unsafe(text); } finally { await one.end({ timeout: 2 }); }
}
async function oneToOne(store, n) {
  return createClassroomLesson({ store, actor: 'mig-owner@example.test', now: START - 60 * MIN, input: { code: `TEST-MIG-L${n}`, date: '2026-12-01', time: '16:00', minutes: 60, tutorCode: `TEST-MIG-T${n}`, tutorEmail: `mig-t${n}@example.test`, studentCode: `TEST-MIG-S${n}` } });
}
async function aBlock(store, n) {
  return createClassroomBlock({ store, actor: 'mig-owner@example.test', now: START - 60 * MIN, input: {
    code: `TEST-MIGB${n}`, date: '2026-12-01', time: '16:00', minutes: 60, rooms: ['R1', 'R2'],
    members: [{ code: `TEST-MIGB${n}-M`, role: 'manager', englishName: 'Mia Manager', email: `migb-m${n}@example.test` },
      { code: `TEST-MIGB${n}-T`, role: 'lead_tutor', englishName: 'Carol Chen', email: `migb-t${n}@example.test` },
      { code: `TEST-MIGB${n}-S1`, role: 'student', englishName: 'Amy Wang' }],
    assignments: [{ member: `TEST-MIGB${n}-T`, room: 'R1' }, { member: `TEST-MIGB${n}-S1`, room: 'R1' }],
  } });
}

describe('028 and the draft 029 through the project\'s migration runner (B5)', () => {
  test('a new database: every migration through 029 in order, each in its own transaction; the two block tables have row level security', async () => {
    const sql = await database('mig_fresh');
    const run = await migrate('mig_fresh', { with029: up029 });
    expect(run.status).toBe(0);
    expect(run.report.applied.at(-2)).toBe('028_classroom_mvp.sql');
    expect(run.report.applied.at(-1)).toBe('029_classroom_multiroom.sql');
    expect((await recorded(sql)).slice(-2)).toEqual(['028', '029']);
    expect(await tableNames(sql)).toEqual(expect.arrayContaining(['classroom_block_members', 'classroom_blocks', 'classroom_lessons', 'classroom_participants']));
    const rls = await sql`SELECT c.relname AS name, c.relrowsecurity AS rls FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname LIKE 'classroom_%'`;
    expect(rls.length).toBe(11);
    expect(rls.every(row => row.rls)).toBe(true);
  });

  test('a database at 027 (today\'s production structure) with data: 028 then 029 are added, the older data stays exactly as it was', async () => {
    const sql = await database('mig_old');
    expect((await migrate('mig_old', { upTo: '027' })).status).toBe(0);
    expect(await tableNames(sql)).toEqual([]);
    await sql`INSERT INTO public.api_rate_limits (bucket_key, request_count) VALUES (${'a'.repeat(64)}, 7)`;
    const before = await recorded(sql);
    const run = await migrate('mig_old', { with029: up029 });
    expect(run.status).toBe(0);
    expect(run.report.applied).toEqual(['028_classroom_mvp.sql', '029_classroom_multiroom.sql']);
    expect(run.report.skipped).toHaveLength(before.length);
    expect((await sql`SELECT request_count FROM public.api_rate_limits`).map(row => row.request_count)).toEqual([7]);
  });

  test('a database at 028 with one-to-one lessons: the block reads answer "none" before 029; 029 keeps every lesson and its rules; run again, nothing changes', async () => {
    const sql = await database('mig_028');
    expect((await migrate('mig_028')).status).toBe(0);
    const store = createPostgresClassroomStore(sql);
    const { lesson } = await oneToOne(store, 1);
    // Before 029: no block tables or columns, and the block reads say "none" instead of failing.
    expect(await store.block('B-none')).toBeNull();
    expect(await store.blockVersion('B-none')).toBeNull();
    expect(await store.lessonsOfBlock('B-none')).toEqual([]);
    const before = await store.lesson(lesson.id);
    const run = await migrate('mig_028', { with029: up029 });
    expect(run.status).toBe(0);
    expect(run.report.applied).toEqual(['029_classroom_multiroom.sql']);
    const after = await store.lesson(lesson.id);
    expect(after).toMatchObject({ id: before.id, code: before.code, blockId: null, roomKind: null });
    expect(after.participants.map(entry => [entry.code, entry.role, entry.active, entry.seat ?? null])).toEqual(before.participants.map(entry => [entry.code, entry.role, true, null]));
    // 028's identity rule still holds for one-to-one rows.
    await expect(sql`INSERT INTO public.classroom_participants (lesson_id, participant_id, code, role) VALUES (${lesson.id}, 'P-bad', 'TEST-MIG-X', 'student')`).rejects.toThrow(/classroom_participants_identity/);
    // Blocks work after 029.
    const block = await aBlock(store, 1);
    expect((await store.block(block.block.blockId)).version).toBe(0);
    // A second run applies nothing; 029 run by hand again changes nothing and fails nothing.
    const again = await migrate('mig_028', { with029: up029 });
    expect(again.status).toBe(0);
    expect(again.report.applied).toEqual([]);
    const schema = schemaOf('mig_028');
    await runFile('mig_028', up029);
    expect(schemaOf('mig_028')).toBe(schema);
    expect((await store.block(block.block.blockId)).members).toHaveLength(3);
  });

  test('a broken 029 that fails half way: nothing of it stays (no table, no column, no record); the corrected file then applies', async () => {
    const sql = await database('mig_fail');
    expect((await migrate('mig_fail')).status).toBe(0);
    const broken = `${up029}\nSELECT 1 / 0;\n`;
    const failed = await migrate('mig_fail', { with029: broken });
    expect(failed.status).toBe(1);
    expect(failed.report).toMatchObject({ connected: false, code: '22012' });
    expect(await tableNames(sql)).not.toContain('classroom_blocks');
    expect(await columns(sql, 'classroom_lessons')).not.toContain('block_id');
    expect(await recorded(sql)).not.toContain('029');
    const fixed = await migrate('mig_fail', { with029: up029 });
    expect(fixed.status).toBe(0);
    expect(fixed.report.applied).toEqual(['029_classroom_multiroom.sql']);
  });

  test('two runners at the same moment: 029 is applied once (the runner\'s advisory lock); an edited 029 after it was applied is refused', async () => {
    const sql = await database('mig_race');
    expect((await migrate('mig_race')).status).toBe(0);
    const [one, two] = await Promise.all([migrate('mig_race', { with029: up029 }), migrate('mig_race', { with029: up029 })]);
    expect([one.status, two.status]).toEqual([0, 0]);
    expect([...one.report.applied, ...two.report.applied]).toEqual(['029_classroom_multiroom.sql']);
    expect((await recorded(sql)).filter(version => version === '029')).toHaveLength(1);
    const edited = await migrate('mig_race', { with029: `${up029}\n-- edited after it was applied\n` });
    expect(edited.status).toBe(1);
    expect(edited.report.message).toMatch(/differs from the recorded file/);
  });

  test('backup, rollback and restore: the draft rollback refuses while blocks exist (nothing changed); with a backup taken and the blocks removed it gives back 028\'s exact schema; the backup restores every block', async () => {
    const sql = await database('mig_rb');
    expect((await migrate('mig_rb')).status).toBe(0);
    const store = createPostgresClassroomStore(sql);
    await oneToOne(store, 2);
    const schema028 = schemaOf('mig_rb');
    expect((await migrate('mig_rb', { with029: up029 })).status).toBe(0);
    const block = await aBlock(store, 2);
    // Refused, and the refusal changes nothing (one transaction).
    const schema029 = schemaOf('mig_rb');
    await expect(runFile('mig_rb', down029)).rejects.toThrow(/classroom blocks exist/);
    expect(schemaOf('mig_rb')).toBe(schema029);
    expect(await recorded(sql)).toContain('029');
    // The backup first (custom format, inside the container), then the blocks removed by hand.
    docker(['exec', container, 'pg_dump', '-U', 'postgres', '-d', 'mig_rb', '--format=custom', '--no-owner', '--file=/tmp/mig_rb.dump']);
    const counts = async client => (await client`SELECT (SELECT count(*) FROM public.classroom_blocks)::int AS blocks, (SELECT count(*) FROM public.classroom_block_members)::int AS members, (SELECT count(*) FROM public.classroom_lessons)::int AS lessons, (SELECT count(*) FROM public.classroom_participants)::int AS participants`)[0];
    const backedUp = await counts(sql);
    expect(backedUp).toMatchObject({ blocks: 1, members: 3, lessons: 4 });
    await sql`DELETE FROM public.classroom_blocks WHERE id = ${block.block.blockId}`;
    await runFile('mig_rb', down029);
    expect(schemaOf('mig_rb')).toBe(schema028);
    expect(await recorded(sql)).not.toContain('029');
    const kept = await sql`SELECT code FROM public.classroom_lessons ORDER BY code`;
    expect(kept.map(row => row.code)).toEqual(['TEST-MIG-L2']);
    // The runner can apply 029 again afterwards.
    expect((await migrate('mig_rb', { with029: up029 })).report.applied).toEqual(['029_classroom_multiroom.sql']);
    // The backup restores into a new database with every block row and row level security on.
    await root.unsafe('CREATE DATABASE mig_restored');
    docker(['exec', container, 'pg_restore', '-U', 'postgres', '-d', 'mig_restored', '--no-owner', '--exit-on-error', '/tmp/mig_rb.dump']);
    const restored = connect('mig_restored');
    expect(await counts(restored)).toEqual(backedUp);
    const rls = await restored`SELECT bool_and(c.relrowsecurity) AS on FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname LIKE 'classroom_%'`;
    expect(rls[0].on).toBe(true);
    expect((await createPostgresClassroomStore(restored).block(block.block.blockId)).code).toBe('TEST-MIGB2');
  });
});

// Draft 030 (programs and courses, 2026-11-09) after 029, through the same runner.
describe('the draft 030 on top of 029 (B5/§7)', () => {
  test('a database at 029 with blocks takes 030: blocks keep working with and without a course; a second run changes nothing; a block reads its course', async () => {
    const sql = await database('mig_030');
    expect((await migrate('mig_030', { with029: up029 })).status).toBe(0);
    const store = createPostgresClassroomStore(sql);
    expect(await store.listPrograms()).toEqual({ programs: [], courses: [] });
    const before = await aBlock(store, 30);
    const run = await migrate('mig_030', { with029: up029, with030: up030 });
    expect(run.report.applied).toEqual(['030_classroom_programs.sql']);
    expect((await store.block(before.block.blockId)).courseId).toBeNull();
    const at = new Date(START).toISOString();
    await store.createProgram({ id: 'PG-1', code: 'TEST-MIGP', name: 'Synthetic', archived: false, createdBy: 'o@example.test', createdAt: at, updatedAt: at });
    await store.createCourse({ id: 'CR-1', programId: 'PG-1', code: 'TEST-MIGC', name: 'Synthetic', timeZone: 'America/New_York', cancelled: false, createdBy: 'o@example.test', createdAt: at, updatedAt: at });
    const withCourse = await createClassroomBlock({ store, actor: 'mig-owner@example.test', now: START - 60 * MIN, input: {
      code: 'TEST-MIGB31', date: '2026-12-02', time: '16:00', minutes: 60, rooms: ['R1'], course: 'TEST-MIGC', sourceKey: 's:20261202:1600:1700',
      members: [{ code: 'TEST-MIGB31-M', role: 'manager', englishName: 'Mia Manager', email: 'migb-m31@example.test' }, { code: 'TEST-MIGB31-S', role: 'student', englishName: 'Amy Wang' }], assignments: [],
    } });
    expect(await store.blockBySource('CR-1', 's:20261202:1600:1700')).toMatchObject({ id: withCourse.block.blockId, courseId: 'CR-1' });
    // The same place in the course twice is refused by the database itself.
    await expect(sql`UPDATE public.classroom_blocks SET course_id = 'CR-1', source_key = 's:20261202:1600:1700' WHERE id = ${before.block.blockId}`).rejects.toThrow(/classroom_blocks_course_source/);
    await expect(sql`UPDATE public.classroom_blocks SET source_key = 's:x' WHERE id = ${before.block.blockId}`).rejects.toThrow(/classroom_blocks_source_needs_course/);
    const schema = schemaOf('mig_030');
    expect((await migrate('mig_030', { with029: up029, with030: up030 })).report.applied).toEqual([]);
    await runFile('mig_030', up030);
    expect(schemaOf('mig_030')).toBe(schema);
  });

  test('a broken 030 leaves nothing behind; the rollback refuses while programs exist and, once they are gone, gives back 029 exactly', async () => {
    const sql = await database('mig_030b');
    expect((await migrate('mig_030b', { with029: up029 })).status).toBe(0);
    const schema029 = schemaOf('mig_030b');
    const failed = await migrate('mig_030b', { with029: up029, with030: `${up030}
SELECT 1 / 0;
` });
    expect(failed.status).toBe(1);
    expect(await tableNames(sql)).not.toContain('classroom_programs');
    expect(await columns(sql, 'classroom_blocks')).not.toContain('course_id');
    expect(schemaOf('mig_030b')).toBe(schema029);
    expect((await migrate('mig_030b', { with029: up029, with030: up030 })).report.applied).toEqual(['030_classroom_programs.sql']);
    await sql`INSERT INTO public.classroom_programs (id, code, name, created_by) VALUES ('PG-2', 'TEST-MIGP2', 'Synthetic', 'o@example.test')`;
    await expect(runFile('mig_030b', down030)).rejects.toThrow(/programs or courses exist/);
    expect(await tableNames(sql)).toContain('classroom_programs');
    await sql`DELETE FROM public.classroom_programs`;
    await runFile('mig_030b', down030);
    expect(schemaOf('mig_030b')).toBe(schema029);
    expect(await recorded(sql)).not.toContain('030');
  });
});
