import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHmac, randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readdir, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import postgres from 'postgres';

// Zoom's webhook end to end (2026-11-10): signed deliveries into the site's own route
// (app/api/recordings/zoom/webhook), with the Zoom Video SDK provider configured as on the live
// site, into a localhost-only disposable PostgreSQL migrated exactly as production (to 030), and
// out as the owners' overview shows the lesson's recording. Synthetic only: test-only secrets,
// TEST- codes, no request leaves this computer (Zoom's API address points at a closed local port,
// and the work the route schedules after answering is collected, not run). It shows our handling
// is right; it proves nothing about what the real Zoom sends.
const afterResponse = vi.hoisted(() => []);
vi.mock('next/server', async original => ({ ...await original(), after: task => { afterResponse.push(task); } }));

const container = `ihear-zoom-webhook-${randomUUID()}`;
const password = 'isolated-webhook-test-only';
const SECRET = 'zoom-webhook-secret-test-only';
const MIN = 60_000;
const docker = args => execFileSync('docker', args, { encoding: 'utf8', windowsHide: true, timeout: 60000, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
let started = false, workspace, sql, route, store, service, ingest;

vi.stubEnv('VERCEL_ENV', '');
vi.stubEnv('IHEAR_FORCE_FILE_STORE', '');
vi.stubEnv('CLASSROOM_PROVIDER', 'zoom-video-sdk');
vi.stubEnv('ZOOM_VIDEO_SDK_KEY', 'sdk-key-test-only');
vi.stubEnv('ZOOM_VIDEO_SDK_SECRET', 'sdk-secret-test-only');
vi.stubEnv('ZOOM_VIDEO_SDK_API_KEY', 'api-key-test-only');
vi.stubEnv('ZOOM_VIDEO_SDK_API_SECRET', 'api-secret-test-only');
vi.stubEnv('ZOOM_VIDEO_SDK_WEBHOOK_SECRET', SECRET);
vi.stubEnv('ZOOM_API_BASE', 'http://127.0.0.1:9/v2');
vi.stubEnv('CLASSROOM_DRIVE', 'local');

beforeAll(async () => {
  docker(['run', '--detach', '--pull=never', '--name', container, '--label', 'ihear-test=zoom-webhook', '-p', '127.0.0.1::5432', '-e', `POSTGRES_PASSWORD=${password}`, 'postgres:17-alpine']);
  started = true;
  const port = docker(['port', container, '5432/tcp']).match(/^127\.0\.0\.1:(\d+)$/)?.[1];
  if (!port) throw new Error('Expected a localhost-only PostgreSQL port');
  const url = database => `postgres://postgres:${password}@127.0.0.1:${port}/${database}`;
  const root = postgres(url('postgres'), { ssl: false, max: 1, connect_timeout: 2, onnotice: () => {} });
  let ready = false;
  for (let attempt = 0; attempt < 60 && !ready; attempt++) {
    try { await root`SELECT 1`; ready = true; } catch { await new Promise(resolve => { setTimeout(resolve, 300); }); }
  }
  if (!ready) throw new Error('Disposable PostgreSQL did not become ready');
  await root.unsafe('CREATE DATABASE webhook_test');
  await root.end({ timeout: 2 });
  // Every migration production has (through 030), by the project's own runner.
  workspace = await mkdtemp(path.join(os.tmpdir(), 'ihear-webhook-migrations-'));
  await mkdir(path.join(workspace, 'db', 'migrations'), { recursive: true });
  for (const file of (await readdir('db/migrations')).filter(name => /^\d+_[a-z0-9_]+\.sql$/i.test(name))) {
    await copyFile(path.join('db', 'migrations', file), path.join(workspace, 'db', 'migrations', file));
  }
  const result = spawnSync(process.execPath, [path.resolve('scripts/migrate-database.mjs')], {
    cwd: workspace, encoding: 'utf8', windowsHide: true, timeout: 120000,
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: os.tmpdir(), TMP: os.tmpdir(), POSTGRES_URL: url('webhook_test'), DATABASE_URL: '', POSTGRES_SSL: 'disable' },
  });
  if (result.status !== 0) throw new Error(`Migration runner failed: ${result.stderr}`);
  expect(JSON.parse(result.stdout.trim().split('\n').pop()).applied.at(-1)).toBe('030_classroom_programs.sql');
  vi.stubEnv('POSTGRES_URL', url('webhook_test'));
  vi.stubEnv('POSTGRES_SSL', 'disable');
  sql = postgres(url('webhook_test'), { ssl: false, max: 2, prepare: false, onnotice: () => {} });
  route = await import('../app/api/recordings/zoom/webhook/route');
  ({ classroomStore: store } = await import('../lib/classroom-store'));
  service = await import('../lib/classroom-service');
  ingest = await import('../tools/recording-pathway/classroom/webhook-ingest.mjs');
}, 180000);

afterAll(async () => {
  await sql?.end({ timeout: 2 });
  const shared = globalThis.ihearClassroomSql;
  if (shared) await shared.end({ timeout: 2 });
  if (started) docker(['rm', '--force', '--volumes', container]);
  if (workspace && (await realpath(workspace)).startsWith(await realpath(os.tmpdir()))) await rm(workspace, { recursive: true, force: true });
}, 30000);

// Zoom's delivery: x-zm-signature = v0=HMAC-SHA256(secret, "v0:{timestamp}:{raw body}").
function delivery(body, { secret = SECRET, at = Date.now(), signature = null } = {}) {
  const raw = JSON.stringify(body);
  const timestamp = String(Math.floor(at / 1000));
  const signed = signature ?? `v0=${createHmac('sha256', secret).update(`v0:${timestamp}:${raw}`).digest('hex')}`;
  return new Request('http://localhost:3000/api/recordings/zoom/webhook', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-zm-request-timestamp': timestamp, 'x-zm-signature': signed }, body: raw,
  });
}
const post = async (body, options) => {
  const response = await route.POST(delivery(body, options));
  return { status: response.status, body: await response.json() };
};
const eventCount = async () => Number((await sql`SELECT count(*)::int AS n FROM public.classroom_events`)[0].n);
const cardOf = async (code, now = Date.now()) => {
  const overview = await service.classroomOverview({ store: store(), now });
  return Object.values(overview.dashboard.groups).flat().find(card => card.lessonCode === code) ?? null;
};

describe('Zoom webhook → PostgreSQL → recording state (synthetic)', () => {
  test("URL validation is answered with HMAC-SHA256(Secret Token, plainToken); a bad signature, another secret or a stale timestamp answers 401 and stores nothing", async () => {
    const before = await eventCount();
    const plainToken = 'synthetic-plain-token-123';
    const answer = await post({ event: 'endpoint.url_validation', event_ts: Date.now(), payload: { plainToken } });
    expect(answer).toEqual({ status: 200, body: { plainToken, encryptedToken: createHmac('sha256', SECRET).update(plainToken).digest('hex') } });
    const started = { event: 'session.started', event_ts: Date.now(), payload: { object: { session_id: 'SYN-NOBODY', session_key: 'L-TEST-NOBODY' } } };
    expect((await post(started, { signature: 'v0=0000' })).status).toBe(401);
    expect((await post(started, { secret: 'some-other-secret' })).status).toBe(401);
    expect((await post(started, { at: Date.now() - 6 * MIN })).body).toEqual({ error: 'STALE_OR_MISSING_TIMESTAMP' });
    expect(await eventCount()).toBe(before);
  });

  test('a lesson recorded start to finish: each delivery is stored before the 200, duplicates once, the overview follows Zoom, and no name, address or download token is kept', async () => {
    const now = Date.now();
    const id = 'L-TEST-ZWH';
    const lesson = {
      id, code: 'TEST-ZWH', date: new Date(now).toISOString().slice(0, 10), startsAt: new Date(now - 10 * MIN).toISOString(), endsAt: new Date(now + 50 * MIN).toISOString(), cancelled: false,
      createdBy: 'owner@example.test', createdAt: new Date(now - 60 * MIN).toISOString(),
      participants: [
        { id: `${id}-T`, code: 'TEST-ZWH-T', role: 'tutor', staffEmail: 'tutor@example.test', joinKeyHash: null },
        { id: `${id}-S`, code: 'TEST-ZWH-S', role: 'student', staffEmail: null, joinKeyHash: 'a'.repeat(64) },
      ],
    };
    await store().createLesson(lesson);
    // The adult tester's consent and the tutor's notice, then the server's own decisions, as the
    // site records them before it asks Zoom to record.
    await service.setSyntheticConsent({ store: store(), personCode: 'TEST-ZWH-S', role: 'student', status: 'granted', actor: 'owner@example.test', now: now - 20 * MIN, synthetic: false });
    await service.setSyntheticConsent({ store: store(), personCode: 'TEST-ZWH-T', role: 'tutor', status: 'granted', actor: 'owner@example.test', now: now - 20 * MIN, synthetic: false });
    const server = (type, at, extra = {}) => store().transaction(tx => ingest.storeEvent(tx, { source: 'server', type, lessonId: id, occurredAt: at, receivedAt: at, key: `${type}:${id}`, ...extra }));
    await server('server.recording_eligibility', now - 15 * MIN, { eligible: true });
    await server('server.start_requested', now - 15_000, { attempt: 1 });
    await server('server.start_response', now - 15_000, { attempt: 1, ok: true, httpStatus: 202 });

    const session = { session_id: 'SYN-ZOOM-SESSION-1', session_key: id, session_name: 'ihear-test-zwh', id: 'SYN-ZOOM-SESSION-1' };
    // Seconds before now: Zoom's notices arrive within seconds of what they report.
    const at = seconds => new Date(now + seconds * 1000).toISOString();
    const person = (key, minute) => ({ user_key: key, participant_uuid: `uuid-${key}`, user_name: 'Synthetic Person Name', email: 'person@example.test', ip_address: '198.51.100.7', join_time: at(minute) });
    const send = async (event, object) => post({ event, event_ts: Date.now(), payload: { account_id: 'SYN-ACCOUNT', object: { ...session, ...object } } });
    const recording = async () => (await cardOf('TEST-ZWH'))?.recording;

    expect((await send('session.started', { start_time: at(-12) })).status).toBe(200);
    expect((await send('session.user_joined', { user: person(`${id}-T`, -11) })).status).toBe(200);
    expect((await send('session.user_joined', { user: person(`${id}-S`, -10) })).status).toBe(200);
    expect((await send('session.recording_started', { recording_file: { recording_start: at(-9) } })).body).toMatchObject({ stored: 1 });
    expect(await recording()).toMatchObject({ status: 'RECORDING', label: '錄影中' });
    await send('session.recording_paused', { recording_file: { recording_end: at(-8) } });
    expect((await recording()).status).toBe('PAUSED');
    await send('session.recording_resumed', { recording_file: { recording_start: at(-7) } });
    expect((await recording()).status).toBe('RECORDING');
    await send('session.recording_stopped', { recording_file: { recording_end: at(-6) } });
    expect(await recording()).toMatchObject({ status: 'STOPPED', label: '已停止，等待錄影檔' });
    await send('session.user_left', { user: { ...person(`${id}-S`, -10), leave_time: at(-5), leave_reason: 'left the session' } });
    await send('session.user_left', { user: { ...person(`${id}-T`, -11), leave_time: at(-4), leave_reason: 'left the session' } });
    await send('session.ended', { end_time: at(-3) });

    const completed = {
      download_token: 'SYN-DOWNLOAD-TOKEN-must-not-be-stored',
      recording_files: [
        { id: 'SYN-ZWH-VIDEO', recording_type: 'shared_screen_with_speaker_view', file_type: 'MP4', file_extension: 'MP4', file_size: 2104395, status: 'completed',
          download_url: 'https://zoom.example.test/rec/download/SYN-ZWH-VIDEO', recording_start: at(-9), recording_end: at(-6) },
        { id: 'SYN-ZWH-AUDIO', recording_type: 'audio_only', file_type: 'M4A', file_extension: 'M4A', file_size: 300000, status: 'completed',
          download_url: 'https://zoom.example.test/rec/download/SYN-ZWH-AUDIO', recording_start: at(-9), recording_end: at(-6) },
      ],
    };
    const queuedBefore = afterResponse.length;
    expect((await send('session.recording_completed', completed)).body).toMatchObject({ stored: 1 });
    expect(afterResponse.length).toBe(queuedBefore + 1);
    // Zoom delivers again (no answer within 3 seconds, say): stored once.
    expect((await send('session.recording_completed', completed)).body).toMatchObject({ duplicates: 1 });

    // Each delivery once (sorted: two can arrive within the same millisecond).
    const types = (await sql`SELECT type FROM public.classroom_events WHERE lesson_id = ${id} AND source = 'zoom_webhook'`).map(row => row.type).sort();
    expect(types).toEqual(['session.started', 'session.user_joined', 'session.user_joined', 'session.recording_started', 'session.recording_paused', 'session.recording_resumed',
      'session.recording_stopped', 'session.user_left', 'session.user_left', 'session.ended', 'session.recording_completed'].sort());
    const files = await sql`SELECT provider_file_id, provider, kind, extension, size, status, hold FROM public.classroom_recording_files WHERE lesson_id = ${id} ORDER BY provider_file_id`;
    expect(files.map(row => [row.provider_file_id, row.provider, row.kind, row.extension, Number(row.size), row.status, row.hold])).toEqual([
      ['SYN-ZWH-AUDIO', 'zoom', 'audio', 'm4a', 300000, 'SKIPPED', null],
      ['SYN-ZWH-VIDEO', 'zoom', 'composite', 'mp4', 2104395, 'PENDING', null],
    ]);
    const jobs = await sql`SELECT id, type, status FROM public.classroom_jobs WHERE lesson_id = ${id}`;
    expect(jobs.map(row => [row.id, row.type, row.status])).toEqual([['file:SYN-ZWH-VIDEO', 'file_recording', 'pending']]);
    const card = await cardOf('TEST-ZWH');
    expect(card.recording).toMatchObject({ status: 'COMPLETED', label: '錄影已完成' });
    expect(card.filing).toMatchObject({ status: 'PENDING' });
    // Nothing a person or Zoom's download could be found by reached the database.
    const everything = JSON.stringify(await sql`SELECT row_to_json(e) AS row FROM public.classroom_events e`) + JSON.stringify(await sql`SELECT row_to_json(f) AS row FROM public.classroom_recording_files f`);
    for (const secret of ['SYN-DOWNLOAD-TOKEN', 'zoom.example.test', 'Synthetic Person Name', 'person@example.test', '198.51.100.7', 'SYN-ACCOUNT']) expect(everything).not.toContain(secret);
  }, 60000);

  test('the database refuses a write: 503 so Zoom delivers again, and the retry is stored once', async () => {
    const body = { event: 'session.started', event_ts: Date.now(), payload: { object: { session_id: 'SYN-ZOOM-SESSION-RETRY', session_key: 'L-TEST-ZWH-R', start_time: new Date().toISOString() } } };
    await sql.unsafe('ALTER TABLE public.classroom_events ADD CONSTRAINT webhook_test_refuse CHECK (false) NOT VALID');
    try {
      expect((await post(body)).status).toBe(503);
    } finally {
      await sql.unsafe('ALTER TABLE public.classroom_events DROP CONSTRAINT webhook_test_refuse');
    }
    expect(Number((await sql`SELECT count(*)::int AS n FROM public.classroom_events WHERE lesson_id = 'L-TEST-ZWH-R'`)[0].n)).toBe(0);
    expect((await post(body)).body).toMatchObject({ stored: 1 });
    expect((await post(body)).body).toMatchObject({ duplicates: 1 });
    expect(Number((await sql`SELECT count(*)::int AS n FROM public.classroom_events WHERE lesson_id = 'L-TEST-ZWH-R'`)[0].n)).toBe(1);
  });

  test('the classroom closed (no provider) with the Secret Token set: URL validation is answered, other signed events are stored nowhere, a bad signature is 401; without the token 503', async () => {
    vi.stubEnv('CLASSROOM_PROVIDER', '');
    try {
      const before = await eventCount();
      const plainToken = 'closed-plain-token';
      expect(await post({ event: 'endpoint.url_validation', event_ts: Date.now(), payload: { plainToken } }))
        .toEqual({ status: 200, body: { plainToken, encryptedToken: createHmac('sha256', SECRET).update(plainToken).digest('hex') } });
      const started = { event: 'session.started', event_ts: Date.now(), payload: { object: { session_id: 'SYN-LOCAL-TRIAL', session_key: 'L-TEST-LOCAL', start_time: new Date().toISOString() } } };
      expect(await post(started)).toEqual({ status: 200, body: { ignored: 'session.started', closed: true } });
      expect((await post(started, { secret: 'some-other-secret' })).status).toBe(401);
      expect(await eventCount()).toBe(before);
      vi.stubEnv('ZOOM_VIDEO_SDK_WEBHOOK_SECRET', '');
      expect((await post(started)).status).toBe(503);
    } finally {
      vi.stubEnv('CLASSROOM_PROVIDER', 'zoom-video-sdk');
      vi.stubEnv('ZOOM_VIDEO_SDK_WEBHOOK_SECRET', SECRET);
    }
  });
});
