import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// The classroom preflight tools (2026-11-10). Synthetic only: test-only keys and secrets, TEST-
// codes, a local stand-in for Zoom's REST API, and the site's own webhook route with its store
// replaced by a spy that records any use. Nothing here reaches Zoom, Google, Vercel or a database.
const storeCalls = vi.hoisted(() => []);
vi.mock('next/server', async original => ({ ...await original(), after: () => {} }));
vi.mock('../lib/classroom-store', async original => ({
  ...await original(),
  classroomStore: () => new Proxy({}, {
    get: (_, prop) => (prop === 'then' ? undefined : () => { storeCalls.push(String(prop)); return Promise.reject(new Error(`store.${String(prop)} used`)); }),
  }),
}));

const { checkMetadata, checkValues, summary, PILOT_REQUIRED, PILOT_CONSENT_VERSION } = await import('../tools/classroom-preflight/env-check.mjs');
const { assessSettings } = await import('../tools/classroom-preflight/zoom-settings.mjs');
const { describeSession, describeRecordings } = await import('../tools/classroom-preflight/zoom-sessions.mjs');
const { runSafeChecks, validationBody, ONLY_EVENT } = await import('../tools/classroom-preflight/webhook-safe-check.mjs');
const { run: emergencyRun } = await import('../tools/classroom-preflight/emergency-stop-live.mjs');
const { readSettingsFile } = await import('../tools/classroom-preflight/common.mjs');

const SECRET = 'zoom-webhook-secret-for-preflight-tests';
const LESSON = `L-${'a'.repeat(32)}`;
const OTHER = `L-${'b'.repeat(32)}`;

describe('env-check', () => {
  // Today's production as the 11/10 snapshot shows it, with made-up ids.
  const closedListing = [
    ...['AUTH_SECRET', 'AUTH_GOOGLE_ID', 'AUTH_GOOGLE_SECRET', 'AUTH_URL', 'NEXTAUTH_URL', 'AUTH_ADMIN_EMAILS'].map(key => ({ key, type: 'sensitive', target: ['preview', 'production'] })),
    ...['POSTGRES_URL', 'RESEND_API_KEY', 'ACADEMY_INQUIRY_FROM', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_STORAGE_BUCKET', 'TEAM_PAGE_PASSWORD', 'TRANSLATION_RECEIPT_SECRET'].map(key => ({ key, type: 'sensitive', target: ['production'] })),
    ...['GOOGLE_CLOUD_PROJECT_ID', 'GOOGLE_CLOUD_PROJECT_NUMBER'].map(key => ({ key, type: 'encrypted', target: ['production'] })),
    { key: 'ZOOM_VIDEO_SDK_WEBHOOK_SECRET', type: 'sensitive', target: ['production'] },
  ];
  const pilotListing = [...closedListing, ...Object.keys(PILOT_REQUIRED).filter(k => k !== 'ZOOM_VIDEO_SDK_WEBHOOK_SECRET').map(key => ({ key, type: 'sensitive', target: ['production'] })), { key: 'CLASSROOM_SESSION_REPORTS', type: 'sensitive', target: ['production'] }];
  const codes = findings => findings.map(f => `${f.level}:${f.name}:${f.code}`);

  test('today\'s production is the closed profile, and is not ready for the pilot', () => {
    expect(checkMetadata(closedListing, 'closed')).toEqual([]);
    const pilot = checkMetadata(closedListing, 'pilot');
    expect(codes(pilot)).toContain('error:CLASSROOM_PROVIDER:MISSING');
    expect(summary(pilot).errors).toBe(Object.keys(PILOT_REQUIRED).length - 1);
  });

  test('the closed profile refuses anything that opens or configures the classroom', () => {
    expect(codes(checkMetadata([...closedListing, { key: 'CLASSROOM_PROVIDER', type: 'sensitive', target: ['production'] }], 'closed'))).toEqual(['error:CLASSROOM_PROVIDER:OPENS_OR_CONFIGURES_THE_CLASSROOM']);
    expect(codes(checkMetadata([...closedListing, { key: 'CRON_SECRET', type: 'sensitive', target: ['production'] }], 'closed'))).toEqual(['error:CRON_SECRET:OPENS_OR_CONFIGURES_THE_CLASSROOM']);
    expect(codes(checkMetadata(closedListing.filter(e => e.key !== 'ZOOM_VIDEO_SDK_WEBHOOK_SECRET'), 'closed'))).toEqual(['error:ZOOM_VIDEO_SDK_WEBHOOK_SECRET:MISSING']);
  });

  test('the pilot profile: complete passes; forbidden, non-sensitive, non-production and unknown settings fail', () => {
    expect(checkMetadata(pilotListing, 'pilot')).toEqual([]);
    const swap = (key, entry) => pilotListing.map(e => (e.key === key ? { ...e, ...entry } : e));
    expect(codes(checkMetadata(swap('ZOOM_VIDEO_SDK_API_SECRET', { type: 'encrypted' }), 'pilot'))).toEqual(['error:ZOOM_VIDEO_SDK_API_SECRET:SECRET_NOT_SENSITIVE']);
    expect(codes(checkMetadata(swap('CLASSROOM_PROVIDER', { target: ['preview', 'production'] }), 'pilot'))).toEqual(['error:CLASSROOM_PROVIDER:NOT_PRODUCTION_ONLY']);
    expect(codes(checkMetadata([...pilotListing, { key: 'CLASSROOM_VENDOR_DELETION', type: 'sensitive', target: ['production'] }], 'pilot'))).toEqual(['error:CLASSROOM_VENDOR_DELETION:FORBIDDEN_IN_PRODUCTION']);
    expect(codes(checkMetadata([...pilotListing, { key: 'CLASSROOM_MULTI_RECORDING', type: 'sensitive', target: ['production'] }], 'pilot'))).toEqual(['error:CLASSROOM_MULTI_RECORDING:FORBIDDEN_IN_PRODUCTION']);
    expect(codes(checkMetadata([...pilotListing, { key: 'CLASSROOM_SOMETHING_NEW', type: 'sensitive', target: ['production'] }], 'pilot'))).toEqual(['error:CLASSROOM_SOMETHING_NEW:UNKNOWN_CLASSROOM_SETTING']);
    expect(codes(checkMetadata(pilotListing.filter(e => e.key !== 'CLASSROOM_SESSION_REPORTS'), 'pilot'))).toEqual(['warn:CLASSROOM_SESSION_REPORTS:RECOMMENDED_MISSING']);
  });

  const goodValues = {
    CLASSROOM_PROVIDER: 'zoom-video-sdk',
    ZOOM_VIDEO_SDK_KEY: 'sdkkeyAAAAAAAAAAAAAAAA01',
    ZOOM_VIDEO_SDK_SECRET: 'sdksecretBBBBBBBBBBBBBBBB02',
    ZOOM_VIDEO_SDK_API_KEY: 'apikeyCCCCCCCCCCCCCCCC03',
    ZOOM_VIDEO_SDK_API_SECRET: 'apisecretDDDDDDDDDDDDDDDD04',
    ZOOM_VIDEO_SDK_WEBHOOK_SECRET: 'webhooksecretEEEEEEEEEEEE05',
    CLASSROOM_PILOT_CONSENT: '1',
    CLASSROOM_CONSENT_VERSION: PILOT_CONSENT_VERSION,
    CLASSROOM_STAFF_NOTICE_VERSION: PILOT_CONSENT_VERSION,
    CLASSROOM_DRIVE: 'google',
    CLASSROOM_DRIVE_GRANT: 'production',
    CLASSROOM_GOOGLE_CLIENT_ID: '123456789012-abcdefghijklmnopqrstuvwxyz012345.apps.googleusercontent.com',
    CLASSROOM_GOOGLE_CLIENT_SECRET: 'GOCSPX-FFFFFFFFFFFFFFFFFFFFFFFF06',
    CLASSROOM_GOOGLE_REFRESH_TOKEN: '1//0gGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGG07',
    CLASSROOM_DRIVE_PARENT_FOLDER_ID: '1HHHHHHHHHHHHHHHHHHHHHHHHHHHHHH08',
    CLASSROOM_SESSION_REPORTS: 'verify',
    CRON_SECRET: 'cronsecretIIIIIIIIIIIIIIIIIIIIIIIIIII09',
  };

  test('a complete values file passes; switches must have their exact values', () => {
    expect(checkValues(goodValues)).toEqual([]);
    expect(codes(checkValues({ ...goodValues, CLASSROOM_CONSENT_VERSION: 'ihear-adult-pilot-consent-v2' }))).toEqual(['error:CLASSROOM_CONSENT_VERSION:WRONG_VALUE']);
    expect(codes(checkValues({ ...goodValues, CLASSROOM_PROVIDER: 'synthetic' }))).toEqual(['error:CLASSROOM_PROVIDER:WRONG_VALUE']);
    expect(codes(checkValues({ ...goodValues, CLASSROOM_PILOT_CONSENT: 'true' }))).toEqual(['error:CLASSROOM_PILOT_CONSENT:WRONG_VALUE']);
    expect(codes(checkValues({ ...goodValues, CLASSROOM_DRIVE_GRANT: undefined }))).toEqual(['error:CLASSROOM_DRIVE_GRANT:MISSING']);
  });

  test('secrets: placeholders, short or repeated values, forbidden names and a mismatch with the checked zoom.env fail', () => {
    expect(codes(checkValues({ ...goodValues, ZOOM_VIDEO_SDK_API_SECRET: 'placeholder-api-secret-000' }))).toEqual(['error:ZOOM_VIDEO_SDK_API_SECRET:LOOKS_LIKE_A_PLACEHOLDER']);
    expect(codes(checkValues({ ...goodValues, CRON_SECRET: 'tooshortcronsecret' }))).toEqual(['error:CRON_SECRET:IMPLAUSIBLE_LENGTH']);
    expect(codes(checkValues({ ...goodValues, ZOOM_VIDEO_SDK_SECRET: goodValues.ZOOM_VIDEO_SDK_KEY }))).toEqual(['error:ZOOM_VIDEO_SDK_KEY:SAME_AS_ANOTHER_SECRET', 'error:ZOOM_VIDEO_SDK_SECRET:SAME_AS_ANOTHER_SECRET']);
    expect(codes(checkValues({ ...goodValues, CLASSROOM_VENDOR_DELETION: 'on' }))).toEqual(['error:CLASSROOM_VENDOR_DELETION:FORBIDDEN_IN_PRODUCTION']);
    expect(codes(checkValues({ ...goodValues, CLASSROOM_DRIVE_PARENT_FOLDER_ID: 'https://drive.google.com/x' }))).toEqual(['error:CLASSROOM_DRIVE_PARENT_FOLDER_ID:NOT_A_DRIVE_FOLDER_ID']);
    const zoomEnv = Object.fromEntries(Object.entries(goodValues).filter(([k]) => k.startsWith('ZOOM_')));
    expect(checkValues(goodValues, { zoomEnv })).toEqual([]);
    expect(codes(checkValues(goodValues, { zoomEnv: { ...zoomEnv, ZOOM_VIDEO_SDK_WEBHOOK_SECRET: 'another-webhook-secret-xyz' } }))).toEqual(['error:ZOOM_VIDEO_SDK_WEBHOOK_SECRET:DIFFERS_FROM_THE_CHECKED_ZOOM_ENV']);
  });

  test('no finding ever carries a value', () => {
    const broken = Object.fromEntries(Object.entries(goodValues).map(([k, v]) => [k, `${v}?placeholder`]));
    const text = summary(checkValues(broken)).lines.join('\n');
    for (const value of [...Object.values(goodValues), ...Object.values(broken)]) if (value.length > 3) expect(text).not.toContain(value);
  });

  test('settings files are refused inside the repository and in OneDrive', () => {
    expect(() => readSettingsFile(path.resolve('package.json'))).toThrow(/outside the repository/);
    // Outside the repository on every platform (I1, 2026-11-11: a Windows-only path such as
    // C:\Users\someone\OneDrive\... is relative on Linux, so CI resolved it inside the repository).
    expect(() => readSettingsFile(path.join(os.tmpdir(), 'OneDrive - iHear', 'Desktop', 'pilot.env'), { root: path.resolve('.') })).toThrow(/OneDrive/);
    if (process.platform === 'win32') expect(() => readSettingsFile('C:\\Users\\someone\\OneDrive\\Desktop\\pilot.env', { root: path.resolve('.') })).toThrow(/OneDrive/);
  });
});

describe('zoom-settings and zoom-sessions (output only)', () => {
  test('the settings Zoom returned on 2026-11-10 (shape): cloud recording on, automatic recording not returned, chat saving to check', () => {
    const { rows } = assessSettings({ recording: { cloud_recording: true, record_speaker_view: true, record_gallery_view: false, record_audio_file: false, save_chat_text: true, show_timestamp: false, cloud_recording_download: true, auto_delete_cmr: false } });
    const by = Object.fromEntries(rows.map(r => [r.name, r.verdict]));
    expect(by).toMatchObject({ cloud_recording: 'OK', auto_recording: 'UNKNOWN', save_chat_text: 'CHECK', auto_delete_cmr: 'INFO' });
  });

  test('automatic recording on, or cloud recording off, fails; text never shows', () => {
    const { rows, review } = assessSettings({ recording: { cloud_recording: false, auto_recording: 'cloud', note: 'someone@example.org' }, in_meeting: { auto_saving_chat: true, allow_participants_to_record: 'Teacher Name' } });
    const by = Object.fromEntries(rows.map(r => [r.name, r.verdict]));
    expect(by).toMatchObject({ cloud_recording: 'FAIL', auto_recording: 'FAIL' });
    expect(JSON.stringify({ rows, review })).not.toMatch(/example\.org|Teacher Name/);
  });

  test('sessions show a short id and our own key only; recording files lose their links', () => {
    const s = describeSession({ id: 'abcdefghij/klmnop==', session_key: LESSON, session_name: 'Teacher Name', start_time: '2026-11-10T01:00:00Z', user_count: 2, recording_size: 0 });
    expect(s).toEqual({ session: 'abcdef…', key: LESSON, start: '2026-11-10T01:00:00Z', end: null, duration: null, users: 2, recordingSize: 0, hasRecording: null });
    expect(describeSession({ id: 'zzzzzzzzzzzz', session_key: 'Somebody' }).key).toBe('[not ours]');
    const files = describeRecordings({ recording_files: [{ recording_type: 'shared_screen_with_speaker_view', file_type: 'MP4', file_size: 2104395, status: 'completed', download_url: 'https://zoom.us/rec/download/x', download_token: 'tok' }] });
    expect(files).toEqual([{ type: 'shared_screen_with_speaker_view', fileType: 'MP4', size: 2104395, status: 'completed' }]);
  });
});

describe('webhook-safe-check against the site\'s own route', () => {
  let route;
  beforeAll(async () => {
    vi.stubEnv('VERCEL_ENV', '');
    vi.stubEnv('ZOOM_VIDEO_SDK_KEY', 'sdk-key-test-only');
    vi.stubEnv('ZOOM_VIDEO_SDK_SECRET', 'sdk-secret-test-only');
    vi.stubEnv('ZOOM_VIDEO_SDK_API_KEY', 'api-key-test-only');
    vi.stubEnv('ZOOM_VIDEO_SDK_API_SECRET', 'api-secret-test-only');
    vi.stubEnv('ZOOM_VIDEO_SDK_WEBHOOK_SECRET', SECRET);
    vi.stubEnv('ZOOM_API_BASE', 'http://127.0.0.1:9/v2');
    vi.stubEnv('CLASSROOM_DRIVE', 'local');
    route = await import('../app/api/recordings/zoom/webhook/route');
  });
  afterAll(() => { vi.unstubAllEnvs(); });
  const sent = [];
  const fetchImpl = async (url, init) => { sent.push(JSON.parse(init.body)); return route.POST(new Request(url, init)); };
  const endpoint = 'http://localhost:3000/api/recordings/zoom/webhook';

  test('classroom OPEN: every check passes and the store is never used', async () => {
    vi.stubEnv('CLASSROOM_PROVIDER', 'zoom-video-sdk');
    storeCalls.length = 0;
    const results = await runSafeChecks({ endpoint, secret: SECRET, fetchImpl });
    expect(results.map(r => [r.label, r.status, r.pass])).toEqual([
      ['url_validation #1', 200, true], ['url_validation #2', 200, true], ['url_validation #3', 200, true],
      ['no signature headers', 401, true], ['wrong signature', 401, true], ['signed with another secret', 401, true], ['timestamp 6 minutes old', 401, true],
    ]);
    expect(storeCalls).toEqual([]);
    expect(sent.every(body => body.event === ONLY_EVENT)).toBe(true);
  });

  test('negative control: a signed lesson event through the same open route DOES reach the store', async () => {
    vi.stubEnv('CLASSROOM_PROVIDER', 'zoom-video-sdk');
    storeCalls.length = 0;
    const raw = JSON.stringify({ event: 'session.started', event_ts: Date.now(), payload: { account_id: 'TEST', object: { id: 'TEST-SESSION', session_id: 'TEST-SESSION', session_key: LESSON, start_time: new Date().toISOString() } } });
    const at = Date.now();
    const signature = `v0=${createHmac('sha256', SECRET).update(`v0:${Math.floor(at / 1000)}:${raw}`).digest('hex')}`;
    await route.POST(new Request(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', 'x-zm-request-timestamp': String(Math.floor(at / 1000)), 'x-zm-signature': signature }, body: raw }));
    expect(storeCalls.length).toBeGreaterThan(0);
  });

  test('classroom CLOSED: the same checks pass and the store is never used', async () => {
    vi.stubEnv('CLASSROOM_PROVIDER', '');
    storeCalls.length = 0;
    const results = await runSafeChecks({ endpoint, secret: SECRET, fetchImpl });
    expect(results.every(r => r.pass)).toBe(true);
    expect(storeCalls).toEqual([]);
  });

  test('an endpoint that accepts bad signatures, or answers validation wrongly, is reported as failing', async () => {
    const lax = async (url, init) => {
      const body = JSON.parse(init.body);
      return new Response(JSON.stringify({ plainToken: body.payload.plainToken, encryptedToken: 'wrong' }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const results = await runSafeChecks({ endpoint, secret: SECRET, fetchImpl: lax });
    expect(results.filter(r => r.pass)).toEqual([]);
  });

  test('the tool refuses to send anything but URL validation', async () => {
    expect(JSON.parse(validationBody('x')).event).toBe(ONLY_EVENT);
    const tampering = async () => { throw new Error('must not be reached'); };
    await expect(runSafeChecks({ endpoint, secret: '', fetchImpl: tampering })).rejects.toThrow(/No Secret Token/);
  });
});

describe('emergency-stop-live against a local stand-in for Zoom', () => {
  let dir, envFile, server, base;
  const requests = [];
  let stillLive = false;
  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'ihear-preflight-stop-'));
    envFile = path.join(dir, 'zoom.env');
    await writeFile(envFile, ['CLASSROOM_PROVIDER=zoom-video-sdk', 'ZOOM_VIDEO_SDK_KEY=test-sdk-key-not-real-01', 'ZOOM_VIDEO_SDK_SECRET=test-sdk-secret-not-real-01', 'ZOOM_VIDEO_SDK_API_KEY=test-api-key-not-real-01', 'ZOOM_VIDEO_SDK_API_SECRET=test-api-secret-not-real-01', `ZOOM_VIDEO_SDK_WEBHOOK_SECRET=${SECRET}`].join('\n'));
    server = createServer((request, response) => {
      requests.push({ method: request.method, url: request.url });
      const url = new URL(request.url, 'http://x');
      if (request.method === 'GET' && url.pathname === '/v2/videosdk/sessions') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ sessions: url.searchParams.get('type') === 'live' ? [{ id: 'live/one==', session_key: LESSON }, { id: 'live-two==', session_key: OTHER }] : [], next_page_token: '' }));
        return;
      }
      const status = request.method === 'PATCH' ? 202 : request.method === 'PUT' ? 204 : stillLive ? 200 : 404;
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end('{}');
    });
    await new Promise(resolve => { server.listen(0, '127.0.0.1', resolve); });
    base = `http://127.0.0.1:${server.address().port}/v2`;
  });
  afterAll(async () => {
    await new Promise(resolve => { server.close(resolve); });
    await rm(dir, { recursive: true, force: true });
  });
  const log = [];
  const quiet = line => log.push(line);

  test('without --yes it lists and sends nothing', async () => {
    requests.length = 0;
    const result = await emergencyRun(['--env', envFile, '--lesson', LESSON, '--api-base', base], { log: quiet });
    expect(result).toMatchObject({ exit: 0, sent: false });
    expect(requests.filter(r => r.method !== 'GET')).toEqual([]);
  });

  test('--yes --lesson stops and ends only that lesson\'s live session, and confirms it is no longer live', async () => {
    requests.length = 0;
    stillLive = false;
    const result = await emergencyRun(['--env', envFile, '--lesson', LESSON, '--yes', '--api-base', base], { log: quiet });
    expect(result.exit).toBe(0);
    const writes = requests.filter(r => r.method !== 'GET').map(r => `${r.method} ${r.url}`);
    expect(writes).toEqual(['PATCH /v2/videosdk/sessions/live%2Fone%3D%3D/events', 'PUT /v2/videosdk/sessions/live%2Fone%3D%3D/status']);
  });

  test('a session Zoom still reports live is NOT confirmed', async () => {
    stillLive = true;
    const result = await emergencyRun(['--env', envFile, '--lesson', LESSON, '--yes', '--api-base', base], { log: quiet });
    expect(result.exit).toBe(1);
    stillLive = false;
  });

  test('--yes without a lesson needs --all-live; output never shows a full session id', async () => {
    await expect(emergencyRun(['--env', envFile, '--yes', '--api-base', base], { log: quiet })).rejects.toThrow(/--all-live/);
    expect(log.join('\n')).not.toMatch(/live\/one==|live-two==/);
  });
});
