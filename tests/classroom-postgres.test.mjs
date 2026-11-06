import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import postgres from 'postgres';
import { changeLessonAccess, joinClassroom, myClassroomLessons } from '../lib/classroom-service';
import { createPostgresClassroomStore } from '../lib/classroom-store';
import { fileRecording, ingestWebhook, signZoomRequest, storeEvent } from '../tools/recording-pathway/classroom/webhook-ingest.mjs';
import { createDrive, syntheticDownload } from '../tools/recording-pathway/test/fake-classroom-store.mjs';
import { classroomStoreContract, contractLesson } from './helpers/classroom-store-contract.mjs';

// Migration 028 and the PostgreSQL classroom store on a localhost-only disposable PostgreSQL,
// created and removed by this test. It never loads .env, uses an inherited database URL or
// connects to a hosted database. Synthetic data only.
const container = `ihear-classroom-${randomUUID()}`;
const password = 'isolated-classroom-test-only';
const SECRET = 'synthetic-webhook-secret-not-real';
const MIN = 60_000;
const docker = args => execFileSync('docker', args, { encoding: 'utf8', windowsHide: true, timeout: 60000, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
let started = false, port, workspace, sql, store, migration;
const clients = [];
const databaseUrl = database => `postgres://postgres:${password}@127.0.0.1:${port}/${database}`;
function connect(database) {
  const client = postgres(databaseUrl(database), { ssl: false, max: 4, prepare: false, connect_timeout: 2, onnotice: () => {} });
  clients.push(client);
  return client;
}

beforeAll(async () => {
  docker(['run', '--detach', '--pull=never', '--name', container, '--label', 'ihear-test=classroom', '-p', '127.0.0.1::5432', '-e', `POSTGRES_PASSWORD=${password}`, 'postgres:17-alpine']);
  started = true;
  port = docker(['port', container, '5432/tcp']).match(/^127\.0\.0\.1:(\d+)$/)?.[1];
  if (!port) throw new Error('Expected a localhost-only PostgreSQL port');
  const root = connect('postgres');
  let ready = false;
  for (let attempt = 0; attempt < 60 && !ready; attempt++) {
    try { await root`SELECT 1`; ready = true; } catch { await new Promise(resolve => { setTimeout(resolve, 300); }); }
  }
  if (!ready) throw new Error('Disposable PostgreSQL did not become ready');
  await root.unsafe('CREATE DATABASE classroom_test');
  // The project's own migration runner, from a folder holding only db/migrations and with an
  // environment that holds only the disposable database URL.
  workspace = await mkdtemp(path.join(os.tmpdir(), 'ihear-classroom-migrations-'));
  await mkdir(path.join(workspace, 'db', 'migrations'), { recursive: true });
  for (const file of (await readdir('db/migrations')).filter(name => /^\d+_[a-z0-9_]+\.sql$/i.test(name))) {
    await copyFile(path.join('db', 'migrations', file), path.join(workspace, 'db', 'migrations', file));
  }
  const result = spawnSync(process.execPath, [path.resolve('scripts/migrate-database.mjs')], {
    cwd: workspace, encoding: 'utf8', windowsHide: true, timeout: 120000,
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: os.tmpdir(), TMP: os.tmpdir(), POSTGRES_URL: databaseUrl('classroom_test'), DATABASE_URL: '', POSTGRES_SSL: 'disable' },
  });
  if (result.status !== 0) throw new Error(`Migration runner failed: ${result.stderr}`);
  migration = JSON.parse(result.stdout.trim().split('\n').pop());
  sql = connect('classroom_test');
  store = createPostgresClassroomStore(sql);
}, 180000);

afterAll(async () => {
  for (const client of clients) await client.end({ timeout: 2 });
  if (started) docker(['rm', '--force', '--volumes', container]);
  if (workspace && (await realpath(workspace)).startsWith(await realpath(os.tmpdir()))) await rm(workspace, { recursive: true, force: true });
}, 30000);

describe('migration 028', () => {
  test('applies after the existing migrations, with row level security on every classroom table', async () => {
    expect(migration.applied.at(-1)).toBe('028_classroom_mvp.sql');
    const tables = await sql`
      SELECT c.relname AS name, c.relrowsecurity AS rls FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname LIKE 'classroom\\_%' ORDER BY c.relname
    `;
    expect(tables.map(table => table.name)).toEqual([
      'classroom_anomalies', 'classroom_consents', 'classroom_events', 'classroom_jobs', 'classroom_join_tokens',
      'classroom_lessons', 'classroom_participants', 'classroom_recording_files', 'classroom_staff_notices',
    ]);
    expect(tables.every(table => table.rls)).toBe(true);
    // No policies: only the server's own connection reaches these tables.
    expect(await sql`SELECT policyname FROM pg_policies WHERE tablename LIKE 'classroom\\_%'`).toEqual([]);
  });

  test('constraints keep identities apart, events bounded and the activity log open to classroom entries', async () => {
    await sql`
      INSERT INTO public.admin_activity_log (id, actor_email, actor_role, action, entity_type, entity_id)
      VALUES (${randomUUID()}, 'owner@example.test', 'owner', 'classroom.lesson_created', 'classroom', 'L-constraint')
    `;
    // 028 redefines the activity types after 027 (the homepage calendar): calendar entries stay allowed.
    await sql`
      INSERT INTO public.admin_activity_log (id, actor_email, actor_role, action, entity_type, entity_id)
      VALUES (${randomUUID()}, 'owner@example.test', 'owner', 'calendar.events.updated', 'calendar', 'home_calendar_v1')
    `;
    await sql`INSERT INTO public.classroom_lessons (id, code, lesson_date, starts_at, ends_at, created_by) VALUES ('L-constraint', 'TEST-K', '2026-11-20', '2026-11-20T08:00:00Z', '2026-11-20T09:00:00Z', 'owner@example.test')`;
    const participant = (role, email, hash) => sql`
      INSERT INTO public.classroom_participants (lesson_id, participant_id, code, role, staff_email, join_key_hash)
      VALUES ('L-constraint', ${`P-${randomUUID().slice(0, 8)}`}, ${`TEST-${randomUUID().slice(0, 6)}`}, ${role}, ${email}, ${hash})
    `;
    const hash = 'a'.repeat(64);
    await expect(participant('student', 'student@example.test', hash)).rejects.toMatchObject({ code: '23514' });
    await expect(participant('tutor', 'Tutor@Example.test', null)).rejects.toMatchObject({ code: '23514' });
    await expect(participant('tutor', 'tutor@example.test', hash)).rejects.toMatchObject({ code: '23514' });
    await expect(sql`INSERT INTO public.classroom_lessons (id, code, lesson_date, starts_at, ends_at, created_by) VALUES ('L-long', 'TEST-LONG', '2026-11-20', '2026-11-20T08:00:00Z', '2026-11-20T12:30:00Z', 'owner@example.test')`)
      .rejects.toMatchObject({ code: '23514' });
    await expect(sql`
      INSERT INTO public.classroom_events (key, lesson_id, type, source, occurred_at, received_at, data)
      VALUES ('too-big', 'L-constraint', 'session.alert', 'zoom_webhook', NOW(), NOW(), ${sql.json({ filler: 'x'.repeat(21000) })})
    `).rejects.toMatchObject({ code: '23514' });
    await expect(sql`
      INSERT INTO public.classroom_events (key, lesson_id, type, source, occurred_at, received_at, data)
      VALUES ('bad-source', 'L-constraint', 'session.alert', 'browser', NOW(), NOW(), ${sql.json({})})
    `).rejects.toMatchObject({ code: '23514' });
    await expect(sql`INSERT INTO public.classroom_consents (person_code, status, version, recorded_by) VALUES ('TEST-K-S', 'granted', 'v1', 'owner@example.test')`)
      .rejects.toMatchObject({ code: '23514' });
  });
});

classroomStoreContract('PostgreSQL store', () => store);

describe('the shared filing logic on PostgreSQL', () => {
  test('two workers racing on one filing job, with the lease running out, keep one copy and one STORED', async () => {
    const lesson = contractLesson('L-race', 'TEST-R');
    await store.createLesson(lesson);
    const START = Date.parse(lesson.startsAt);
    const iso = value => new Date(value).toISOString();
    await store.transaction(tx => storeEvent(tx, { source: 'server', type: 'server.recording_eligibility', lessonId: lesson.id, occurredAt: START - 15 * MIN, receivedAt: START - 15 * MIN, key: `decide:${lesson.id}`, eligible: true }));
    const rawBody = JSON.stringify({
      event: 'session.recording_completed',
      event_ts: START + 70 * MIN,
      download_token: 'synthetic-download-token-not-real',
      payload: { object: { id: 'SYN-SESSION-R', session_id: 'SYN-SESSION-R', session_key: lesson.id, recording_files: [{
        id: 'SYN-RACE-V1', recording_type: 'shared_screen_with_speaker_view', file_extension: 'MP4', file_type: 'MP4', file_size: 64, status: 'completed',
        recording_start: iso(START + MIN), recording_end: iso(START + 60 * MIN), download_url: 'https://example.invalid/synthetic/download',
      }] } },
    });
    const timestamp = Math.floor((START + 70 * MIN) / 1000);
    const headers = { 'x-zm-request-timestamp': String(timestamp), 'x-zm-signature': signZoomRequest(SECRET, timestamp, rawBody) };
    expect((await ingestWebhook({ headers, rawBody, secret: SECRET, now: START + 70 * MIN, store })).status).toBe(200);
    // Zoom delivers again: still one record and one job.
    expect((await ingestWebhook({ headers, rawBody, secret: SECRET, now: START + 72 * MIN, store })).body).toMatchObject({ duplicates: 1 });
    expect(await sql`SELECT id FROM public.classroom_jobs WHERE provider_file_id = 'SYN-RACE-V1'`).toHaveLength(1);

    const drive = createDrive();
    const ROOT = 'root:[測試] iHear 錄影存放區';
    let release;
    let reached;
    const atGate = new Promise(resolve => { reached = resolve; });
    drive.faults.holdUpload = { gate: new Promise(resolve => { release = resolve; }), reached };
    const T = START + 75 * MIN;
    const claimA = await store.claimJob({ workerId: 'A', now: T, leaseMs: 5 * MIN });
    const runningA = fileRecording({ store, drive, download: syntheticDownload, job: claimA.job, leaseVersion: claimA.leaseVersion, now: T, rootFolderId: ROOT });
    // A stalls inside its upload; its lease runs out and B takes the job with a new fencing number.
    await atGate;
    drive.faults.reportGoneOnce = 1;
    const claimB = await store.claimJob({ workerId: 'B', now: T + 6 * MIN, leaseMs: 5 * MIN });
    expect(claimB.leaseVersion).toBe(claimA.leaseVersion + 1);
    const resultB = await fileRecording({ store, drive, download: syntheticDownload, job: claimB.job, leaseVersion: claimB.leaseVersion, now: T + 6 * MIN, rootFolderId: ROOT });
    release();
    const resultA = await runningA;
    expect(resultB.status).toBe('STORED');
    expect(resultA.status).toBe('LEASE_LOST');
    const copies = drive.activeFiles().filter(file => file.appProperties.providerFileId === 'SYN-RACE-V1');
    expect(copies).toHaveLength(1);
    expect(copies[0]).toMatchObject({ id: resultB.driveFileId, name: '2026-11-20_TEST-R-S_TEST-R-T_P01.mp4' });
    expect(drive.trashedFiles()).toHaveLength(1);
    expect(await store.fileRecord('SYN-RACE-V1')).toMatchObject({ status: 'STORED', driveFileId: resultB.driveFileId });
    const filings = await sql`SELECT data->>'status' AS status FROM public.classroom_events WHERE type = 'p1.filing' AND lesson_id = ${lesson.id}`;
    expect(filings.map(row => row.status)).toEqual(['STORED']);
    expect(await sql`SELECT id FROM public.classroom_jobs WHERE type = 'delete_vendor_copy' AND provider_file_id = 'SYN-RACE-V1'`).toHaveLength(1);
    const stored = JSON.stringify(await sql`SELECT data FROM public.classroom_events WHERE lesson_id = ${lesson.id}`);
    for (const planted of ['synthetic-download-token-not-real', 'example.invalid']) expect(stored).not.toContain(planted);
  });
});

// 0344bde (2026-11-07): cancelling, revoking and reissuing, and "my lessons", through the website's
// own service functions on PostgreSQL. A stand-in provider signs nothing real.
describe('student links and my lessons on PostgreSQL', () => {
  const hashOf = value => createHash('sha256').update(value).digest('hex');
  const NOW = Date.parse('2026-11-20T07:55:00Z');
  const provider = {
    name: 'synthetic',
    sessionToken: ({ participant, now }) => ({ token: `synthetic-token-${participant.id}-${now}`, issuedAt: now, expiresAt: now + 30 * MIN }),
  };
  const enter = (lessonId, who, now = NOW) => joinClassroom({ store, provider, lessonId, key: who.key ?? null, sessionEmail: who.email ?? null, now });
  const keyOf = answer => new URLSearchParams(answer.body.studentLink.split('#')[1]).get('k');
  const studentHash = async lessonId => (await sql`SELECT join_key_hash FROM public.classroom_participants WHERE lesson_id = ${lessonId} AND role = 'student'`)[0].join_key_hash.trim();
  const keys = [];

  test('revoke, reissue and cancel: an old link gets no token, the new one does; the tutor is unaffected until the lesson is cancelled', async () => {
    const lesson = contractLesson('L-pg-links', 'TEST-PL');
    await store.createLesson(lesson);
    const oldKey = `${lesson.id}-link`;
    keys.push(oldKey);
    expect((await enter(lesson.id, { key: oldKey })).status).toBe(200);

    expect(await changeLessonAccess({ store, lessonId: lesson.id, action: 'revoke_link' })).toMatchObject({ status: 200, body: { ok: true, revoked: true } });
    const revoked = await enter(lesson.id, { key: oldKey });
    expect(revoked).toMatchObject({ status: 403, body: { code: 'NOT_ON_ROSTER' } });
    expect(revoked.body.session).toBeUndefined();
    // The row holds a hash nobody was given: a valid hash, not the old one.
    expect(await studentHash(lesson.id)).toMatch(/^[0-9a-f]{64}$/);
    expect(await studentHash(lesson.id)).not.toBe(hashOf(oldKey));

    const reissued = await changeLessonAccess({ store, lessonId: lesson.id, action: 'reissue_link' });
    const newKey = keyOf(reissued);
    keys.push(newKey);
    expect(await studentHash(lesson.id)).toBe(hashOf(newKey));
    expect((await enter(lesson.id, { key: oldKey })).status).toBe(403);
    expect(await enter(lesson.id, { key: newKey })).toMatchObject({ status: 200, body: { role: 'student', participantCode: 'TEST-PL-S' } });
    expect(await enter(lesson.id, { email: 'tutor@example.test' })).toMatchObject({ status: 200, body: { role: 'tutor' } });

    const [before] = await sql`SELECT updated_at FROM public.classroom_lessons WHERE id = ${lesson.id}`;
    expect(await changeLessonAccess({ store, lessonId: lesson.id, action: 'cancel' })).toMatchObject({ status: 200, body: { cancelled: true, changed: true } });
    const [after] = await sql`SELECT cancelled, updated_at FROM public.classroom_lessons WHERE id = ${lesson.id}`;
    expect(after.cancelled).toBe(true);
    expect(after.updated_at.getTime()).toBeGreaterThanOrEqual(before.updated_at.getTime());
    for (const who of [{ key: newKey }, { email: 'tutor@example.test' }]) {
      const refused = await enter(lesson.id, who);
      expect(refused).toMatchObject({ status: 403, body: { code: 'LESSON_CANCELLED' } });
      expect(refused.body.session).toBeUndefined();
    }
    expect(await changeLessonAccess({ store, lessonId: lesson.id, action: 'reissue_link' })).toMatchObject({ status: 409, body: { code: 'LESSON_CANCELLED' } });
    expect(await changeLessonAccess({ store, lessonId: lesson.id, action: 'cancel' })).toMatchObject({ status: 200, body: { changed: false } });
  });

  test('two reissues at once leave exactly one working link, and the row holds that link\'s hash', async () => {
    const lesson = contractLesson('L-pg-race2', 'TEST-PR2');
    await store.createLesson(lesson);
    const answers = await Promise.all([1, 2].map(() => changeLessonAccess({ store, lessonId: lesson.id, action: 'reissue_link' })));
    const racing = answers.map(keyOf);
    keys.push(...racing);
    expect(new Set(racing).size).toBe(2);
    const entries = await Promise.all(racing.map(key => enter(lesson.id, { key })));
    expect(entries.map(entry => entry.status).sort()).toEqual([200, 403]);
    const winner = racing[entries.findIndex(entry => entry.status === 200)];
    expect(await studentHash(lesson.id)).toBe(hashOf(winner));
    expect((await enter(lesson.id, { key: `${lesson.id}-link` })).status).toBe(403);
  });

  test('errors change nothing: a hash already used by another student, an unknown lesson, student or action', async () => {
    const x = contractLesson('L-pg-dup-x', 'TEST-PX');
    const y = contractLesson('L-pg-dup-y', 'TEST-PY');
    await store.createLesson(x);
    await store.createLesson(y);
    const yHash = await studentHash(y.id);
    // The unique index refuses a second student with the same key; the statement changes nothing.
    await expect(store.replaceStudentKeyHash(y.id, `${y.id}-S`, hashOf(`${x.id}-link`))).rejects.toMatchObject({ code: '23505' });
    expect(await studentHash(y.id)).toBe(yHash);
    // The database's own message names the value, which is why the route answers with its own words.
    const refusal = await store.replaceStudentKeyHash(y.id, `${y.id}-S`, hashOf(`${x.id}-link`)).catch(error => error);
    expect(String(refusal.detail)).toContain(hashOf(`${x.id}-link`));
    // A tutor row can never take a key, even written directly (028's identity rule).
    await expect(sql`UPDATE public.classroom_participants SET join_key_hash = ${'b'.repeat(64)} WHERE lesson_id = ${y.id} AND role = 'tutor'`).rejects.toMatchObject({ code: '23514' });
    expect(await changeLessonAccess({ store, lessonId: 'L-pg-missing', action: 'cancel' })).toMatchObject({ status: 404, body: { code: 'LESSON_NOT_FOUND' } });
    expect(await changeLessonAccess({ store, lessonId: y.id, action: 'revoke_link', studentCode: 'TEST-NONE' })).toMatchObject({ status: 404, body: { code: 'STUDENT_NOT_FOUND' } });
    expect(await changeLessonAccess({ store, lessonId: y.id, action: 'drop' })).toMatchObject({ status: 400, body: { code: 'INVALID_ACTION' } });
    expect(await studentHash(y.id)).toBe(yHash);
    expect((await sql`SELECT cancelled FROM public.classroom_lessons WHERE id = ${y.id}`)[0].cancelled).toBe(false);
  });

  test("my lessons: only the signed-in tutor's own, codes and times only, in the right state", async () => {
    const mine = contractLesson('L-pg-mine', 'TEST-PM', '2026-11-20T08:00:00.000Z');
    mine.participants[0].staffEmail = 'pg-tutor@example.test';
    const later = contractLesson('L-pg-later', 'TEST-PN', '2026-11-27T08:00:00.000Z');
    later.participants[0].staffEmail = 'pg-tutor@example.test';
    const far = contractLesson('L-pg-far', 'TEST-PF', '2026-12-20T08:00:00.000Z');
    far.participants[0].staffEmail = 'pg-tutor@example.test';
    for (const lesson of [mine, later, far]) await store.createLesson(lesson);
    const listed = await myClassroomLessons({ store, email: 'pg-tutor@example.test', now: NOW });
    expect(listed.map(lesson => [lesson.code, lesson.state])).toEqual([['TEST-PM', 'open'], ['TEST-PN', 'before']]);
    expect(listed[0]).toEqual({
      lessonId: 'L-pg-mine', code: 'TEST-PM', startsAt: '2026-11-20T08:00:00.000Z', endsAt: '2026-11-20T09:00:00.000Z',
      opensAt: '2026-11-20T07:45:00.000Z', closesAt: '2026-11-20T09:15:00.000Z', state: 'open', participantCode: 'TEST-PM-T', studentCodes: ['TEST-PM-S'],
    });
    expect(JSON.stringify(listed)).not.toMatch(/[0-9a-f]{64}|@|token/);
    expect(await myClassroomLessons({ store, email: 'someone@example.test', now: NOW })).toEqual([]);
    await changeLessonAccess({ store, lessonId: 'L-pg-later', action: 'cancel' });
    expect((await myClassroomLessons({ store, email: 'pg-tutor@example.test', now: NOW }))[1]).toMatchObject({ code: 'TEST-PN', state: 'cancelled' });
  });

  test("Supabase's API roles get nothing from these tables: no rows, no key hash, no change", async () => {
    // As on Supabase: the API roles may use every public table, and row level security with no
    // policy is what keeps them out. The server's own connection is the table owner.
    await sql.unsafe(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
      END $$;
      GRANT USAGE ON SCHEMA public TO anon, authenticated;
      GRANT ALL ON ALL TABLES IN SCHEMA public TO anon, authenticated;
    `);
    for (const role of ['anon', 'authenticated']) {
      const seen = await sql.begin(async tx => {
        await tx.unsafe(`SET LOCAL ROLE ${role}`);
        const [lessons] = await tx`SELECT count(*)::int AS n FROM public.classroom_lessons`;
        const [participants] = await tx`SELECT count(*)::int AS n FROM public.classroom_participants`;
        const cancelled = await tx`UPDATE public.classroom_lessons SET cancelled = TRUE RETURNING id`;
        const rekeyed = await tx`UPDATE public.classroom_participants SET join_key_hash = ${'c'.repeat(64)} WHERE role = 'student' RETURNING participant_id`;
        return { lessons: lessons.n, participants: participants.n, cancelled: cancelled.length, rekeyed: rekeyed.length };
      });
      expect(seen).toEqual({ lessons: 0, participants: 0, cancelled: 0, rekeyed: 0 });
      await expect(sql.begin(async tx => {
        await tx.unsafe(`SET LOCAL ROLE ${role}`);
        await tx`INSERT INTO public.classroom_lessons (id, code, lesson_date, starts_at, ends_at, created_by) VALUES ('L-api-role', 'TEST-API', '2026-11-20', '2026-11-20T08:00:00Z', '2026-11-20T09:00:00Z', 'x@example.test')`;
      })).rejects.toMatchObject({ code: '42501' });
    }
    // The server's own connection still sees everything it wrote.
    expect((await sql`SELECT count(*)::int AS n FROM public.classroom_lessons WHERE id = 'L-pg-links' AND cancelled`)[0].n).toBe(1);
    expect((await sql`SELECT count(*)::int AS n FROM public.classroom_participants WHERE join_key_hash = ${'c'.repeat(64)}`)[0].n).toBe(0);
  });

  test('no personal key is kept anywhere: not in the classroom tables, not in the database log', async () => {
    expect(keys.length).toBeGreaterThanOrEqual(4);
    const tables = ['classroom_lessons', 'classroom_participants', 'classroom_join_tokens', 'classroom_events', 'classroom_anomalies'];
    // The table names are this list's own constants.
    const dump = JSON.stringify(await Promise.all(tables.map(table => sql.unsafe(`SELECT to_jsonb(t) AS row FROM public.${table} t`))));
    for (const key of keys) expect(dump).not.toContain(key);
    const log = spawnSync('docker', ['logs', container], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
    expect(log.status).toBe(0);
    for (const key of keys) expect(`${log.stdout}${log.stderr}`).not.toContain(key);
  });
});

// D1 (2026-11-07): the daily backup, its file check, the restore check, the monthly drill and the
// audit with migration 028's nine classroom tables, on databases at 027 and at 028 (each a fresh
// database in this disposable server). The scripts run from a folder that holds only
// db/migrations, with only the disposable database's address. Synthetic data only. The daily
// backup's classroom part stays off unless BACKUP_INCLUDE_CLASSROOM=1: iHear has not yet
// confirmed encryption, access and retention for lesson data (H8).
// Every test here runs the real scripts as child processes (two to four in a row), so each gets a minute.
describe('backups, the restore check, the monthly drill and the audit with the classroom tables', { timeout: 60000 }, () => {
  const CLASSROOM = ['classroom_lessons', 'classroom_participants', 'classroom_consents', 'classroom_staff_notices', 'classroom_join_tokens', 'classroom_events', 'classroom_jobs', 'classroom_recording_files', 'classroom_anomalies'];
  const NOW = Date.parse('2026-11-20T07:55:00Z');
  const provider = {
    name: 'synthetic',
    sessionToken: ({ participant, now }) => ({ token: `synthetic-token-${participant.id}-${now}`, issuedAt: now, expiresAt: now + 30 * MIN }),
  };
  let workspace027, sql027, plantedKey, backupFile;
  const scriptEnv = (database, extra = {}) => ({ PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: os.tmpdir(), TMP: os.tmpdir(), POSTGRES_URL: databaseUrl(database), DATABASE_URL: '', POSTGRES_SSL: 'disable', ...extra });
  function script(name, { database, cwd = workspace, args = [], env = {} }) {
    const result = spawnSync(process.execPath, [path.resolve('scripts', name), ...args], { cwd, encoding: 'utf8', windowsHide: true, timeout: 120000, env: scriptEnv(database, env) });
    const output = `${result.stdout}\n${result.stderr}`;
    let json = null;
    for (const line of output.trim().split('\n').reverse()) { try { json = JSON.parse(line); break; } catch { /* not the result line */ } }
    return { status: result.status, output, json };
  }
  function audit(database, cwd = workspace) {
    const result = spawnSync(process.execPath, [path.resolve('scripts/audit-database.mjs')], { cwd, encoding: 'utf8', windowsHide: true, timeout: 120000, env: scriptEnv(database) });
    const start = result.stdout.lastIndexOf('{\n  "connected"');
    if (start < 0) throw new Error(`the audit printed no result: ${result.stderr}`);
    return { status: result.status, ...JSON.parse(result.stdout.slice(start)) };
  }
  const counts = async client => Object.fromEntries(await Promise.all(CLASSROOM.map(async table => [table, Number((await client.unsafe(`SELECT count(*) AS n FROM public.${table}`))[0].n)])));
  function psql(database, text) {
    const result = spawnSync('docker', ['exec', '-i', container, 'psql', '-X', '-q', '-t', '-A', '-U', 'postgres', '-d', database, '--set=ON_ERROR_STOP=1'], { input: text, encoding: 'utf8', windowsHide: true, timeout: 60000 });
    return { status: result.status, output: `${result.stdout}\n${result.stderr}` };
  }
  // The monthly drill's own verification SQL, as the workflow runs it.
  function drillSql() {
    const lines = readFileSync('.github/workflows/monthly-restore-drill.yml', 'utf8').split(/\r?\n/);
    const start = lines.findIndex(line => line.includes("<<'SQL'"));
    const end = lines.findIndex((line, index) => index > start && line.trim() === 'SQL');
    const body = lines.slice(start + 1, end);
    const indent = Math.min(...body.filter(line => line.trim()).map(line => line.match(/^ */)[0].length));
    return body.map(line => line.slice(indent)).join('\n');
  }
  // The drill's dump and restore, inside this disposable server.
  function dumpAndRestore(source, target, extra = []) {
    docker(['exec', container, 'pg_dump', '-U', 'postgres', '-d', source, '--format=custom', '--no-owner', '--no-privileges', '--schema=public', '--exclude-table-data=public.api_rate_limits', ...extra, `--file=/tmp/${target}.dump`]);
    docker(['exec', container, 'createdb', '-U', 'postgres', target]);
    docker(['exec', container, 'pg_restore', '-U', 'postgres', '-d', target, '--clean', '--if-exists', '--exit-on-error', `/tmp/${target}.dump`]);
  }
  async function resigned(change) {
    const backup = JSON.parse(await readFile(backupFile, 'utf8'));
    change(backup.payload);
    backup.checksum = createHash('sha256').update(JSON.stringify(backup.payload)).digest('hex');
    const file = path.join(workspace, 'backups', `tampered-${randomUUID()}.json`);
    await writeFile(file, `${JSON.stringify(backup, null, 2)}\n`);
    return file;
  }

  beforeAll(async () => {
    await connect('postgres').unsafe('CREATE DATABASE classroom_027');
    workspace027 = await mkdtemp(path.join(os.tmpdir(), 'ihear-classroom-027-'));
    await mkdir(path.join(workspace027, 'db', 'migrations'), { recursive: true });
    for (const file of (await readdir('db/migrations')).filter(name => /^\d+_[a-z0-9_]+\.sql$/i.test(name) && Number(name.slice(0, 3)) <= 27)) {
      await copyFile(path.join('db', 'migrations', file), path.join(workspace027, 'db', 'migrations', file));
    }
    const migrated = spawnSync(process.execPath, [path.resolve('scripts/migrate-database.mjs')], { cwd: workspace027, encoding: 'utf8', windowsHide: true, timeout: 120000, env: scriptEnv('classroom_027') });
    if (migrated.status !== 0) throw new Error(`Migration runner (027) failed: ${migrated.stderr}`);
    sql027 = connect('classroom_027');
    // The constraint test above leaves a lesson whose participant rows were all refused; no real
    // lesson is ever without its tutor and student, which the audit checks.
    await sql`DELETE FROM public.classroom_lessons WHERE id = 'L-constraint'`;
    // At least one synthetic row in every classroom table, and a personal key that exists only here.
    const lesson = contractLesson('L-backup-a', 'TEST-BA');
    await store.createLesson(lesson);
    plantedKey = new URLSearchParams((await changeLessonAccess({ store, lessonId: lesson.id, action: 'reissue_link' })).body.studentLink.split('#')[1]).get('k');
    expect((await joinClassroom({ store, provider, lessonId: lesson.id, key: plantedKey, sessionEmail: null, now: NOW })).status).toBe(200);
    await sql`INSERT INTO public.classroom_consents (person_code, status, version, granted_at, synthetic, recorded_by) VALUES ('TEST-BA-S', 'granted', 'synthetic-2026-11', NOW(), TRUE, 'owner@example.test') ON CONFLICT DO NOTHING`;
    await sql`INSERT INTO public.classroom_staff_notices (person_code, version, acknowledged_at, recorded_by) VALUES ('TEST-BA-T', 'synthetic-2026-11', NOW(), 'owner@example.test') ON CONFLICT DO NOTHING`;
    await sql`INSERT INTO public.classroom_events (key, lesson_id, type, source, occurred_at, received_at, data) VALUES ('backup:started', ${lesson.id}, 'session.started', 'server', NOW(), NOW(), ${sql.json({ note: 'synthetic' })}) ON CONFLICT DO NOTHING`;
    await sql`INSERT INTO public.classroom_jobs (id, type, lesson_id, provider_file_id, status) VALUES ('backup-job', 'file_recording', ${lesson.id}, 'SYN-BACKUP-1', 'pending') ON CONFLICT DO NOTHING`;
    await sql`INSERT INTO public.classroom_recording_files (provider_file_id, provider, lesson_id, status, size) VALUES ('SYN-BACKUP-1', 'synthetic', ${lesson.id}, 'PENDING', 64) ON CONFLICT DO NOTHING`;
    await sql`INSERT INTO public.classroom_anomalies (lesson_id, code, severity, first_seen_at, opened_at, last_seen_at) VALUES (${lesson.id}, 'STALE_DATA', 'warning', NOW(), NOW(), NOW()) ON CONFLICT DO NOTHING`;
  }, 180000);
  afterAll(async () => {
    if (workspace027 && (await realpath(workspace027)).startsWith(await realpath(os.tmpdir()))) await rm(workspace027, { recursive: true, force: true });
  });

  test('the daily backup leaves the classroom tables out unless switched on, and the scheduled workflow never switches it on', async () => {
    const off = script('backup-database.mjs', { database: 'classroom_test' });
    expect(off.status, off.output).toBe(0);
    expect(off.json).toMatchObject({ created: true, classroom: 'off' });
    const backup = JSON.parse(await readFile(path.join(workspace, off.json.path), 'utf8'));
    expect(backup.payload.version).toBe(10);
    for (const table of CLASSROOM) expect(backup.payload.tables[table]).toBeUndefined();
    const workflow = readFileSync('.github/workflows/daily-application-backup.yml', 'utf8');
    expect(workflow).not.toContain('BACKUP_INCLUDE_CLASSROOM');
  });

  test('switched on, it backs up all nine tables as version 11, with key hashes only and never a personal key', async () => {
    const on = script('backup-database.mjs', { database: 'classroom_test', env: { BACKUP_INCLUDE_CLASSROOM: '1' } });
    expect(on.status, on.output).toBe(0);
    expect(on.json).toMatchObject({ created: true, classroom: 'included' });
    backupFile = path.join(workspace, on.json.path);
    const text = await readFile(backupFile, 'utf8');
    const backup = JSON.parse(text);
    expect(backup.payload.version).toBe(11);
    const now = await counts(sql);
    for (const table of CLASSROOM) {
      expect(backup.payload.tables[table], table).toHaveLength(now[table]);
      expect(now[table], table).toBeGreaterThan(0);
      expect(on.json.rowCounts[table], table).toBe(now[table]);
    }
    expect(backup.payload.schema.constraints.map(row => row.constraint_name)).toEqual(expect.arrayContaining(['classroom_participants_identity', 'classroom_lessons_time_order']));
    expect(backup.payload.schema.indexes.map(row => row.index_name)).toEqual(expect.arrayContaining(['classroom_participants_join_key_idx', 'classroom_lessons_starts_at_idx']));
    expect(backup.payload.tables.classroom_participants.find(row => row.lesson_id === 'L-backup-a' && row.role === 'student').join_key_hash.trim()).toBe(createHash('sha256').update(plantedKey).digest('hex'));
    expect(text).not.toContain(plantedKey);
    expect(on.output).not.toContain(plantedKey);
    const verified = script('verify-backup-file.mjs', { database: 'classroom_test', args: [backupFile] });
    expect(verified.status, verified.output).toBe(0);
    expect(verified.json).toMatchObject({ verified: true, version: 11 });
  });

  test.each([
    ['a changed row without a new checksum', null, /checksum/i],
    ['a table left out', payload => { delete payload.tables.classroom_anomalies; }, /classroom_anomalies/],
    ['a second row with the same key', payload => { payload.tables.classroom_lessons.push({ ...payload.tables.classroom_lessons[0] }); }, /duplicate|classroom_lessons/i],
    ['a key hash on a tutor', payload => { payload.tables.classroom_participants.find(row => row.role === 'tutor').join_key_hash = 'a'.repeat(64); }, /tutor/i],
    ['a student link that is not a 64-character hash', payload => { payload.tables.classroom_participants.find(row => row.role === 'student').join_key_hash = 'not-a-hash'; }, /hash/i],
    ['a participant of a lesson that is not in the backup', payload => { payload.tables.classroom_participants[0].lesson_id = 'L-not-backed-up'; }, /lesson/i],
    ['a column the table does not have', payload => { payload.tables.classroom_participants[0].join_key = 'planted-raw-key'; }, /column/i],
    ['migration 028 missing from the record', payload => { payload.tables.schema_migrations = payload.tables.schema_migrations.filter(row => String(row.version) !== '028'); }, /028/],
    ['a version nobody writes', payload => { payload.version = 12; }, /unsupported/i],
  ])('the backup file check refuses %s', async (_name, change, message) => {
    let file;
    if (change) file = await resigned(change);
    else {
      const backup = JSON.parse(await readFile(backupFile, 'utf8'));
      backup.payload.tables.classroom_lessons[0].code = 'TEST-CHANGED';
      file = path.join(workspace, 'backups', `tampered-${randomUUID()}.json`);
      await writeFile(file, `${JSON.stringify(backup, null, 2)}\n`);
    }
    const refused = script('verify-backup-file.mjs', { database: 'classroom_test', args: [file] });
    expect(refused.status).not.toBe(0);
    expect(refused.json).toMatchObject({ verified: false });
    expect(refused.json.message).toMatch(message);
  });

  test('the restore check writes all nine tables back in a rolled-back transaction and leaves the database exactly as it was', async () => {
    const before = await counts(sql);
    const [revisionsBefore] = await sql`SELECT json_object_agg(scope, revision) AS r FROM public.site_content_revisions`;
    const restored = script('verify-backup.mjs', { database: 'classroom_test', args: [backupFile] });
    expect(restored.status, restored.output).toBe(0);
    expect(restored.json).toMatchObject({ verified: true, restoreSimulation: 'passed-and-rolled-back', databaseUnchanged: true });
    for (const table of CLASSROOM) expect(restored.json.rowCounts[table], table).toBe(before[table]);
    expect(await counts(sql)).toEqual(before);
    const [revisionsAfter] = await sql`SELECT json_object_agg(scope, revision) AS r FROM public.site_content_revisions`;
    expect(revisionsAfter).toEqual(revisionsBefore);
    expect(restored.output).not.toContain(plantedKey);
    // A backup whose rows differ from what is written back is caught, not passed.
    const altered = await resigned(payload => { payload.tables.classroom_events[0].data = { ...payload.tables.classroom_events[0].data, extra: 'x'.repeat(30000) }; });
    const refused = script('verify-backup.mjs', { database: 'classroom_test', args: [altered] });
    expect(refused.status).not.toBe(0);
    expect(await counts(sql)).toEqual(before);
  });

  test('on a database at 027 the backup keeps the old format even when switched on, and every check passes', async () => {
    expect((await sql027`SELECT to_regclass('public.classroom_lessons') AS t, (SELECT max(version) FROM public.schema_migrations) AS v`)[0]).toEqual({ t: null, v: '027' });
    const at027 = script('backup-database.mjs', { database: 'classroom_027', cwd: workspace027, env: { BACKUP_INCLUDE_CLASSROOM: '1' } });
    expect(at027.status, at027.output).toBe(0);
    expect(at027.json).toMatchObject({ created: true, classroom: 'not-applied' });
    const file = path.join(workspace027, at027.json.path);
    expect(JSON.parse(await readFile(file, 'utf8')).payload.version).toBe(10);
    expect(script('verify-backup-file.mjs', { database: 'classroom_027', cwd: workspace027, args: [file] }).status).toBe(0);
    const restored = script('verify-backup.mjs', { database: 'classroom_027', cwd: workspace027, args: [file] });
    expect(restored.status, restored.output).toBe(0);
  });

  test('the audit checks the classroom tables once 028 is recorded, and only then', async () => {
    const at028 = audit('classroom_test');
    expect(at028.classroom).toMatchObject({ applied: true, missingTables: [], missingConstraints: [], missingIndexes: [], rlsOff: [], policies: [], activityAllowsClassroom: true });
    expect(Object.values(at028.classroom.invalid).every(count => count === 0)).toBe(true);
    expect(at028.issues.classroomIssues).toEqual([]);
    // At 027 with the 027 code: nothing about classrooms is expected, and nothing is reported missing.
    const at027 = audit('classroom_027', workspace027);
    expect(at027.classroom).toEqual({ applied: false });
    expect(at027.issues.classroomIssues).toEqual([]);
    expect(at027.issues.migrationIssues).toEqual([]);
    // At 027 with code that has 028: only the true fact that 028 is not applied yet.
    const pending = audit('classroom_027');
    expect(pending.classroom).toEqual({ applied: false });
    expect(pending.issues.classroomIssues).toEqual([]);
    expect(pending.issues.migrationIssues).toEqual(['028_classroom_mvp.sql: not tracked']);
  });

  test("the monthly drill's checks pass on restored copies at 027 and 028, and fail when a classroom table lost row level security", async () => {
    dumpAndRestore('classroom_test', 'classroom_restore');
    const drill = psql('classroom_restore', drillSql());
    expect(drill.status, drill.output).toBe(0);
    const restoredCounts = JSON.parse(drill.output.trim().split('\n').filter(Boolean).at(-1));
    expect(restoredCounts).toEqual(await counts(sql));
    dumpAndRestore('classroom_027', 'classroom_restore_027');
    const drill027 = psql('classroom_restore_027', drillSql());
    expect(drill027.status, drill027.output).toBe(0);
    expect(JSON.parse(drill027.output.trim().split('\n').filter(Boolean).at(-1))).toEqual({});
    // A restored copy without row level security on one classroom table fails the drill and the audit.
    expect(psql('classroom_restore', 'ALTER TABLE public.classroom_jobs DISABLE ROW LEVEL SECURITY;').status).toBe(0);
    const broken = psql('classroom_restore', drillSql());
    expect(broken.status).not.toBe(0);
    expect(broken.output).toMatch(/row level security is off/i);
    const audited = audit('classroom_restore');
    expect(audited.classroom.rlsOff).toEqual(['classroom_jobs']);
    expect(audited.healthy).toBe(false);
    // 028 recorded but a classroom table gone: the drill says so.
    expect(psql('classroom_restore', 'ALTER TABLE public.classroom_jobs ENABLE ROW LEVEL SECURITY; DROP TABLE public.classroom_anomalies;').status).toBe(0);
    const missing = psql('classroom_restore', drillSql());
    expect(missing.status).not.toBe(0);
    expect(missing.output).toMatch(/classroom tables are missing/i);
  });

  // H8 option 乙 (2026-11-07), researched here only: the weekly and monthly workflows are not
  // changed until iHear confirms the data-retention risk. Left out of a full dump, the classroom
  // rows are gone from the backup, yet the database still restores whole around them.
  test("H8 option 乙, researched only: a full dump without the classroom rows restores every classroom table empty, with row level security, and passes the drill and the audit", async () => {
    dumpAndRestore('classroom_test', 'classroom_restore_h8', ['--exclude-table-data=public.classroom_*']);
    const drill = psql('classroom_restore_h8', drillSql());
    expect(drill.status, drill.output).toBe(0);
    const restored = JSON.parse(drill.output.trim().split('\n').filter(Boolean).at(-1));
    expect(Object.keys(restored).sort()).toEqual([...CLASSROOM].sort());
    expect(Object.values(restored)).toEqual(CLASSROOM.map(() => 0));
    // Only the dump left them out: the source still has a row in every classroom table.
    for (const [table, count] of Object.entries(await counts(sql))) expect(count, table).toBeGreaterThan(0);
    const audited = audit('classroom_restore_h8');
    expect(audited.classroom).toMatchObject({ applied: true, missingTables: [], missingConstraints: [], missingIndexes: [], rlsOff: [], policies: [] });
    expect(audited.issues.classroomIssues).toEqual([]);
    // Everything else came back whole, 028's record included.
    const rows = (database, query) => psql(database, query).output.trim();
    for (const table of ['schema_migrations', 'site_settings', 'content_overrides', 'admin_activity_log']) {
      expect(rows('classroom_restore_h8', `SELECT count(*) FROM public.${table};`), table).toBe(rows('classroom_test', `SELECT count(*) FROM public.${table};`));
    }
    expect(rows('classroom_restore_h8', "SELECT count(*) FROM public.schema_migrations WHERE version = '028';")).toBe('1');
    // No classroom row, code or key hash is anywhere in the dump file itself.
    const planted = createHash('sha256').update(plantedKey).digest('hex');
    const found = docker(['exec', container, 'sh', '-c', `pg_restore -f - /tmp/classroom_restore_h8.dump | grep -c -e TEST-BA -e L-backup-a -e ${planted} || true`]);
    expect(found).toBe('0');
  });
});
