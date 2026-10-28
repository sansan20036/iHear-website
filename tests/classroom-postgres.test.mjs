import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readdir, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import postgres from 'postgres';
import { createPostgresClassroomStore } from '../lib/classroom-store';
import { fileRecording, ingestWebhook, signZoomRequest, storeEvent } from '../tools/recording-pathway/classroom/webhook-ingest.mjs';
import { createDrive, syntheticDownload } from '../tools/recording-pathway/test/fake-classroom-store.mjs';
import { classroomStoreContract, contractLesson } from './helpers/classroom-store-contract.mjs';

// Migration 027 and the PostgreSQL classroom store on a localhost-only disposable PostgreSQL,
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

describe('migration 027', () => {
  test('applies after the existing migrations, with row level security on every classroom table', async () => {
    expect(migration.applied.at(-1)).toBe('027_classroom_mvp.sql');
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
