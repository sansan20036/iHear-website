import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import postgres from 'postgres';
import { createClassroomBlock } from '../lib/classroom-blocks';
import { createClassroomCourse, createClassroomProgram } from '../lib/classroom-programs';
import { createClassroomLesson } from '../lib/classroom-service';
import { createPostgresClassroomStore } from '../lib/classroom-store';

// P3-Multi backup version 12 (2026-11-09), on a localhost-only disposable PostgreSQL 17 created and
// removed by this test: the project's own backup, file check, restore check (rolled back), audit
// and monthly-drill SQL, run as the workflows run them, against a database with 028, the draft 029
// (blocks) and the draft 030 (programs and courses). Also: tampered and truncated files, a backup
// with blocks offered to a database without them, an old version 11 backup on the new structure,
// and a column the tools do not know. The daily backup's classroom part stays off unless
// BACKUP_INCLUDE_CLASSROOM=1 (H8 is iHear's decision). Synthetic data only; never .env, never a
// hosted database.
vi.setConfig({ testTimeout: 180000 });
const container = `ihear-v12-${randomUUID()}`;
const password = 'isolated-backup-v12-test-only';
const MIN = 60_000;
const NOW = Date.parse('2026-11-20T07:55:00Z');
const docker = args => execFileSync('docker', args, { encoding: 'utf8', windowsHide: true, timeout: 120000, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
let started = false, port, workspace, root, sql, sql028, store;
const clients = [];
const url = database => `postgres://postgres:${password}@127.0.0.1:${port}/${database}`;
const connect = database => { const client = postgres(url(database), { ssl: false, max: 4, prepare: false, connect_timeout: 2, onnotice: () => {} }); clients.push(client); return client; };
const scriptEnv = (database, extra = {}) => ({ PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: os.tmpdir(), TMP: os.tmpdir(), POSTGRES_URL: url(database), DATABASE_URL: '', POSTGRES_SSL: 'disable', ...extra });
function script(name, { database, args = [], env = {} }) {
  const result = spawnSync(process.execPath, [path.resolve('scripts', name), ...args], { cwd: workspace, encoding: 'utf8', windowsHide: true, timeout: 120000, env: scriptEnv(database, env) });
  const output = `${result.stdout}\n${result.stderr}`;
  let json = null;
  for (const line of output.trim().split('\n').reverse()) { try { json = JSON.parse(line); break; } catch { /* not the result line */ } }
  return { status: result.status, output, json };
}
function audit(database) {
  const result = spawnSync(process.execPath, [path.resolve('scripts/audit-database.mjs')], { cwd: workspace, encoding: 'utf8', windowsHide: true, timeout: 120000, env: scriptEnv(database) });
  const start = result.stdout.lastIndexOf('{\n  "connected"');
  if (start < 0) throw new Error(`the audit printed no result: ${result.stderr}`);
  return JSON.parse(result.stdout.slice(start));
}
function drillSql() {
  const lines = readFileSync('.github/workflows/monthly-restore-drill.yml', 'utf8').split(/\r?\n/);
  const start = lines.findIndex(line => line.includes("<<'SQL'"));
  const end = lines.findIndex((line, index) => index > start && line.trim() === 'SQL');
  const body = lines.slice(start + 1, end);
  const indent = Math.min(...body.filter(line => line.trim()).map(line => line.match(/^ */)[0].length));
  return body.map(line => line.slice(indent)).join('\n');
}
async function migrate(database) {
  const result = spawnSync(process.execPath, [path.resolve('scripts/migrate-database.mjs')], { cwd: workspace, encoding: 'utf8', windowsHide: true, timeout: 120000, env: scriptEnv(database) });
  if (result.status !== 0) throw new Error(`Migration runner failed: ${result.stderr}`);
}
async function resigned(file, change) {
  const backup = JSON.parse(await readFile(file, 'utf8'));
  change(backup.payload);
  backup.checksum = createHash('sha256').update(JSON.stringify(backup.payload)).digest('hex');
  const target = path.join(workspace, 'backups', `tampered-${randomUUID()}.json`);
  await writeFile(target, `${JSON.stringify(backup, null, 2)}\n`);
  return target;
}

beforeAll(async () => {
  docker(['run', '--detach', '--pull=never', '--name', container, '--label', 'ihear-test=classroom-backup-v12', '-p', '127.0.0.1::5432', '-e', `POSTGRES_PASSWORD=${password}`, 'postgres:17-alpine']);
  started = true;
  port = docker(['port', container, '5432/tcp']).match(/^127\.0\.0\.1:(\d+)$/)?.[1];
  root = connect('postgres');
  for (let attempt = 0; attempt < 60; attempt++) { try { await root`SELECT 1`; break; } catch { await new Promise(resolve => { setTimeout(resolve, 300); }); } }
  workspace = await mkdtemp(path.join(os.tmpdir(), 'ihear-v12-'));
  await mkdir(path.join(workspace, 'db', 'migrations'), { recursive: true });
  for (const file of (await readdir('db/migrations')).filter(name => /^\d+_[a-z0-9_]+\.sql$/i.test(name))) await copyFile(path.join('db', 'migrations', file), path.join(workspace, 'db', 'migrations', file));
  for (const name of ['v12', 'v11_only']) await root.unsafe(`CREATE DATABASE ${name}`);
  await migrate('v12');
  await migrate('v11_only');
  sql = connect('v12');
  sql028 = connect('v11_only');
  for (const file of ['029_classroom_multiroom.sql', '030_classroom_programs.sql']) await sql.unsafe(await readFile(path.join('db', 'multiroom', file), 'utf8'));
  store = createPostgresClassroomStore(sql);
  await createClassroomLesson({ store, actor: 'owner@example.test', now: NOW - 60 * MIN, input: { code: 'TEST-V12-L1', date: '2026-11-20', time: '16:00', minutes: 60, tutorCode: 'TEST-V12-LT', tutorEmail: 'lt@example.test', studentCode: 'TEST-V12-LS' } });
  const program = await createClassroomProgram({ store, actor: 'owner@example.test', now: NOW, input: { code: 'TEST-V12-P', name: 'Synthetic Program' } });
  await createClassroomCourse({ store, actor: 'owner@example.test', now: NOW, input: { program: program.code, code: 'TEST-V12-C', name: 'Synthetic Course', timeZone: 'America/New_York' } });
  await createClassroomBlock({ store, actor: 'owner@example.test', now: NOW, input: {
    code: 'TEST-V12-B1', date: '2026-11-21', time: '16:00', minutes: 60, rooms: ['R1', 'R2'], course: 'TEST-V12-C', sourceKey: 's:20261121:1600:1700',
    members: [{ code: 'TEST-V12-M', role: 'manager', englishName: 'Mia Manager', email: 'm@example.test' }, { code: 'TEST-V12-T', role: 'lead_tutor', englishName: 'Carol Chen', email: 't@example.test' },
      { code: 'TEST-V12-S1', role: 'student', englishName: 'Amy Wang' }, { code: 'TEST-V12-S2', role: 'student', englishName: 'Ben Lee' }],
    assignments: [{ member: 'TEST-V12-T', room: 'R1' }, { member: 'TEST-V12-S1', room: 'R1' }],
  } });
  await createClassroomLesson({ store: createPostgresClassroomStore(sql028), actor: 'owner@example.test', now: NOW - 60 * MIN, input: { code: 'TEST-V11-L1', date: '2026-11-20', time: '16:00', minutes: 60, tutorCode: 'TEST-V11-LT', tutorEmail: 'lt@example.test', studentCode: 'TEST-V11-LS' } });
}, 240000);

afterAll(async () => {
  for (const client of clients) await client.end({ timeout: 2 });
  if (started) docker(['rm', '--force', '--volumes', container]);
  if (workspace && (await realpath(workspace)).startsWith(await realpath(os.tmpdir()))) await rm(workspace, { recursive: true, force: true });
}, 60000);

describe('backup version 12 with blocks, programs and courses', () => {
  let file, v11File;
  test('the backup states its levels, holds all 13 classroom tables, only key hashes and no personal link; the file check and the rolled-back restore pass; the database is unchanged', async () => {
    const off = script('backup-database.mjs', { database: 'v12' });
    expect(off.json).toMatchObject({ created: true, classroom: 'off' });
    const on = script('backup-database.mjs', { database: 'v12', env: { BACKUP_INCLUDE_CLASSROOM: '1' } });
    expect(on.status).toBe(0);
    expect(on.json).toMatchObject({ created: true, classroom: 'included', classroomSchema: ['028', '029', '030'] });
    file = path.join(workspace, on.json.path);
    const text = await readFile(file, 'utf8');
    const backup = JSON.parse(text);
    expect(backup.payload).toMatchObject({ version: 12, classroomSchema: ['028', '029', '030'] });
    expect(Object.keys(backup.payload.tables).filter(name => name.startsWith('classroom_')).sort()).toHaveLength(13);
    expect(backup.payload.tables.classroom_blocks[0]).toMatchObject({ code: 'TEST-V12-B1', source_key: 's:20261121:1600:1700' });
    expect(backup.payload.tables.classroom_block_members.filter(row => row.role === 'student').every(row => /^[0-9a-f]{64}$/.test(row.join_key_hash.trim()))).toBe(true);
    expect(text).not.toMatch(/[#?&]k=/);
    const checked = script('verify-backup-file.mjs', { database: 'v12', args: [file] });
    expect(checked.json).toMatchObject({ verified: true, version: 12, classroomSchema: ['028', '029', '030'] });
    const counts = async () => (await sql`SELECT (SELECT count(*) FROM public.classroom_blocks)::int AS b, (SELECT count(*) FROM public.classroom_block_members)::int AS m, (SELECT count(*) FROM public.classroom_courses)::int AS c, (SELECT count(*) FROM public.classroom_lessons)::int AS l`)[0];
    const before = await counts();
    const restored = script('verify-backup.mjs', { database: 'v12', args: [file] });
    expect(restored.status).toBe(0);
    expect(restored.json).toMatchObject({ verified: true, restoreSimulation: 'passed-and-rolled-back', databaseUnchanged: true });
    expect(restored.json.rowCounts).toMatchObject({ classroom_blocks: 1, classroom_block_members: 4, classroom_programs: 1, classroom_courses: 1, classroom_lessons: 4 });
    expect(await counts()).toEqual(before);
  });

  test('a tampered file is refused, each for its reason: an unknown column, an unknown table, a missing table, a broken reference, a personal link, a version that does not match its levels, a truncated file, a wrong checksum', async () => {
    const refusedBy = async (change, message) => {
      const tampered = await resigned(file, change);
      const result = script('verify-backup-file.mjs', { database: 'v12', args: [tampered] });
      expect(result.status, message).toBe(1);
      expect(result.output).toMatch(message);
    };
    await refusedBy(payload => { payload.tables.classroom_blocks[0].extra = 'x'; }, /classroom_blocks has a row with unexpected columns/);
    await refusedBy(payload => { payload.tables.classroom_future = []; }, /classroom table its levels do not have: classroom_future/);
    await refusedBy(payload => { delete payload.tables.classroom_courses; }, /missing classroom_courses/);
    await refusedBy(payload => { payload.tables.classroom_block_members[0].block_id = 'B-missing'; }, /refers to a block that is not in the backup/);
    await refusedBy(payload => { payload.tables.classroom_events[0].data = { ...payload.tables.classroom_events[0].data, note: '/classroom/b/x#k=abcdefghijklmnopqrstuvwxyz0123' }; }, /personal link with its key/);
    await refusedBy(payload => { payload.version = 11; }, /does not match its classroom levels/);
    await refusedBy(payload => { payload.classroomSchema = ['028', '030']; }, /levels the tools do not know/);
    const truncated = path.join(workspace, 'backups', `truncated-${randomUUID()}.json`);
    const text = await readFile(file, 'utf8');
    await writeFile(truncated, text.slice(0, Math.floor(text.length / 2)));
    expect(script('verify-backup-file.mjs', { database: 'v12', args: [truncated] }).status).toBe(1);
    const unsigned = path.join(workspace, 'backups', `unsigned-${randomUUID()}.json`);
    const altered = JSON.parse(text);
    altered.payload.tables.classroom_programs[0].name = 'Changed';
    await writeFile(unsigned, JSON.stringify(altered));
    expect(script('verify-backup-file.mjs', { database: 'v12', args: [unsigned] }).output).toMatch(/checksum does not match/);
    // The restore check refuses the same tampering before writing anything.
    const tampered = await resigned(file, payload => { payload.tables.classroom_lessons.find(row => row.block_id).block_id = 'B-missing'; });
    expect(script('verify-backup.mjs', { database: 'v12', args: [tampered] }).output).toMatch(/refers to a block that is not in the backup/);
  });

  test('a backup with blocks is never replayed into a database without them; an old version 11 backup replays on the new structure', async () => {
    const refused = script('verify-backup.mjs', { database: 'v11_only', args: [file] });
    expect(refused.status).toBe(1);
    expect(refused.output).toMatch(/does not have the classroom structure the backup needs \(029, 030\)/);
    const old = script('backup-database.mjs', { database: 'v11_only', env: { BACKUP_INCLUDE_CLASSROOM: '1' } });
    expect(old.json).toMatchObject({ created: true, classroom: 'included' });
    v11File = path.join(workspace, old.json.path);
    expect(JSON.parse(await readFile(v11File, 'utf8')).payload).toMatchObject({ version: 11 });
    expect(JSON.parse(await readFile(v11File, 'utf8')).payload.classroomSchema).toEqual(['028']);
    expect(script('verify-backup-file.mjs', { database: 'v12', args: [v11File] }).json).toMatchObject({ verified: true, version: 11 });
    const replayed = script('verify-backup.mjs', { database: 'v12', args: [v11File] });
    expect(replayed.status).toBe(0);
    expect(replayed.json.rowCounts).toMatchObject({ classroom_lessons: 1 });
  });

  test('a classroom column the tools do not know stops the backup (no file is written); removed again, the backup works', async () => {
    await sql`ALTER TABLE public.classroom_blocks ADD COLUMN unexpected_note TEXT`;
    try {
      const listing = async () => (await readdir(path.join(workspace, 'backups'))).sort();
      const before = await listing();
      const stopped = script('backup-database.mjs', { database: 'v12', env: { BACKUP_INCLUDE_CLASSROOM: '1' } });
      expect(stopped.status).toBe(1);
      expect(stopped.output).toMatch(/classroom_blocks has a row with unexpected columns/);
      expect(await listing()).toEqual(before);
    } finally {
      await sql`ALTER TABLE public.classroom_blocks DROP COLUMN unexpected_note`;
    }
    expect(script('backup-database.mjs', { database: 'v12', env: { BACKUP_INCLUDE_CLASSROOM: '1' } }).status).toBe(0);
  });

  test('the audit knows the blocks and programs (no false problems; row level security checked on all 13), and the monthly drill SQL passes on a restored copy', async () => {
    const result = audit('v12');
    expect(result.classroom).toMatchObject({ applied: true, levels: ['028', '029', '030'], missingTables: [], rlsOff: [], policies: [] });
    expect(Object.values(result.classroom.invalid).every(count => count === 0)).toBe(true);
    expect(result.issues.classroomIssues).toEqual([]);
    await sql`ALTER TABLE public.classroom_courses DISABLE ROW LEVEL SECURITY`;
    try {
      expect(audit('v12').classroom.rlsOff).toEqual(['classroom_courses']);
    } finally {
      await sql`ALTER TABLE public.classroom_courses ENABLE ROW LEVEL SECURITY`;
    }
    docker(['exec', container, 'pg_dump', '-U', 'postgres', '-d', 'v12', '--format=custom', '--no-owner', '--no-privileges', '--schema=public', '--file=/tmp/v12.dump']);
    docker(['exec', container, 'createdb', '-U', 'postgres', 'v12_drill']);
    docker(['exec', container, 'pg_restore', '-U', 'postgres', '-d', 'v12_drill', '--clean', '--if-exists', '--exit-on-error', '/tmp/v12.dump']);
    const drill = spawnSync('docker', ['exec', '-i', container, 'psql', '-X', '-q', '-t', '-A', '-U', 'postgres', '-d', 'v12_drill', '--set=ON_ERROR_STOP=1'], { input: drillSql(), encoding: 'utf8', windowsHide: true, timeout: 60000 });
    expect(drill.status, drill.stderr).toBe(0);
    const counts = JSON.parse(drill.stdout.trim().split('\n').pop());
    expect(counts).toMatchObject({ classroom_blocks: 1, classroom_block_members: 4, classroom_programs: 1, classroom_courses: 1 });
  });
});
