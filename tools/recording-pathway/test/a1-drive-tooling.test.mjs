// The Google Drive adapter, the A1 sign-in and the A1 runner, checked against a local stand-in
// of Google written from Google's guides (drive-test/mock-drive-server.mjs). No network, no
// account. Passing here says our side follows the documented protocol; test A1 then checks the
// same code against Google itself.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createGoogleDrive, driveQuote } from '../classroom/google-drive.mjs';
import { FAILURE, FilingError, fileRecording, processJobs } from '../classroom/recording-filing.mjs';
import { storeEvent } from '../classroom/webhook-ingest.mjs';
import { authorize, DRIVE_FILE_SCOPE, ensurePrivateDir, revokeSaved, tokenProvider } from '../drive-test/oauth.mjs';
import { startMockDrive } from '../drive-test/mock-drive-server.mjs';
import { selfTest } from '../drive-test/run-a1.mjs';
import { createClassroomStore } from './fake-classroom-store.mjs';

const KiB = 1024;
const lesson = {
  id: 'L-TEST-AD1', code: 'TEST-AD1', date: '2026-11-05', startsAt: '2026-11-05T08:00:00.000Z', endsAt: '2026-11-05T09:00:00.000Z',
  participants: [{ id: 'P-T', code: 'TEST-T01', role: 'tutor' }, { id: 'P-S', code: 'TEST-S01', role: 'student' }],
};
const bytesOf = size => {
  const bytes = Buffer.alloc(size);
  for (let i = 0; i < size; i++) bytes[i] = (i * 13 + (i >> 10)) & 0xff;
  return bytes;
};

// A signed-in adapter on a fresh stand-in, and the real worker filing one synthetic recording.
async function setup(t, mockOptions = {}) {
  const mock = await startMockDrive(mockOptions);
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ihear-adapter-'));
  t.after(async () => { await mock.close(); await rm(dir, { recursive: true, force: true }); });
  const secrets = path.join(dir, 'private');
  await ensurePrivateDir(secrets);
  const clientFile = path.join(secrets, 'client.json');
  const tokenFile = path.join(secrets, 'token.json');
  await writeFile(clientFile, JSON.stringify({ installed: { client_id: 'mock-client', client_secret: 'mock-not-secret' } }));
  await authorize({ clientFile, tokenFile, endpoints: mock.endpoints, openUrl: async url => { await fetch(url); } });
  const accessToken = tokenProvider({ clientFile, tokenFile, endpoint: mock.endpoints.token });
  const answers = [];
  const drive = createGoogleDrive({ accessToken, apiBase: mock.url, onAnswer: answer => answers.push(answer) });
  return { mock, drive, answers, clientFile, tokenFile, dir };
}

async function filing(drive, size, { chunkBytes = 256 * KiB } = {}) {
  const content = bytesOf(size);
  const store = createClassroomStore({ lessons: [lesson] });
  await store.transaction(tx => storeEvent(tx, { source: 'server', type: 'server.recording_eligibility', lessonId: lesson.id, occurredAt: 0, receivedAt: 0, key: 'decide', eligible: true }));
  await store.transaction(tx => storeEvent(tx, {
    source: 'zoom_api', type: 'session.recording_completed', lessonId: lesson.id, providerSessionId: 'S', receivedAt: 1, occurredAt: 1, key: 'completed',
    files: [{ providerFileId: 'F-AD1', kind: 'shared_screen_with_speaker_view', extension: 'mp4', size, status: 'completed', recordingStart: 0, recordingEnd: 60_000 }],
  }));
  let later = 0;
  const call = () => processJobs({
    store, clock: () => Date.now() + later, deadline: Date.now() + later + 60_000, workerId: 'adapter-test', safetyMs: 1000,
    handlers: {
      file_recording: ({ job, leaseVersion, clock, deadline, leaseMs }) => fileRecording({
        store, drive, download: async (_record, { start, end }) => content.subarray(start, end), job, leaseVersion, clock, deadline, leaseMs, rootFolderId: 'root', options: { chunkBytes, safetyMs: 1000 },
      }),
      delete_vendor_copy: async ({ job, leaseVersion }) => ({ status: (await store.completeJob({ jobId: job.id, leaseVersion })) ? 'DELETED' : 'LEASE_LOST' }),
    },
  });
  // The next call comes after any backoff or recheck has passed.
  const next = async ms => { later += ms; return call(); };
  return { store, content, call, next, record: () => store.fileRecord('F-AD1') };
}

test('A1 self-test: D1–D9, cleanup and revocation pass against the stand-in, and the evidence holds no token or session URI', async () => {
  const outcome = await selfTest({ log: () => {} });
  assert.equal(outcome.stopped, false);
  assert.deepEqual(outcome.results.map(entry => `${entry.id}:${entry.result}`), ['D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7', 'D8', 'D9'].map(id => `${id}:PASS`));
  assert.equal(outcome.cleaned.rootGone, true);
  assert.deepEqual([outcome.revoked.revokeStatus, outcome.revoked.refreshRefused, outcome.tokenFileGone], [200, true, true]);
  assert.doesNotMatch(outcome.evidence, /mock-refresh|mock-access|upload_id=|refresh_token|access_token/);
});

test('through the adapter: a whole recording in 256 KiB chunks, every byte checked', async t => {
  const { drive, answers, mock } = await setup(t);
  const run = await filing(drive, 3 * 256 * KiB + 777);
  await run.call();
  const stored = run.record();
  assert.equal(stored.status, 'STORED');
  const copy = await drive.getFile(stored.driveFileId);
  const kept = mock.files.get(stored.driveFileId);
  assert.equal(copy.name, '2026-11-05_TEST-S01_TEST-T01_P01.mp4');
  assert.equal(copy.size, run.content.length);
  assert.equal(kept.md5, (await import('node:crypto')).createHash('md5').update(run.content).digest('hex'));
  assert.deepEqual(answers.filter(answer => answer.operation === 'session').map(answer => answer.range ?? answer.status), ['bytes=0-262143', 'bytes=0-524287', 'bytes=0-786431', 200]);
});

test('through the adapter: a 5xx keeps the session; a 403 for a full Drive spends it and filing starts over once there is room', async t => {
  const { drive, mock } = await setup(t, { quotaLimit: 10 * 1024 * 1024 });
  const run = await filing(drive, 4 * 256 * KiB);
  mock.faults.nextChunk.push({ status: 503, reason: 'backendError' });
  assert.deepEqual((await run.call()).map(result => [result.status, result.reason]), [['RETRY', FAILURE.TRANSIENT]]);
  assert.ok(run.record().uploadSessionUri, 'a 5xx leaves the session to be resumed');
  mock.addForeignUsage(10 * 1024 * 1024 - 300 * KiB);           // someone else's files fill the Drive
  assert.deepEqual((await run.next(60_000)).map(result => [result.status, result.reason]), [['BLOCKED', FAILURE.DRIVE_QUOTA]]);
  assert.equal(run.record().uploadSessionUri, null, 'the 4xx spent the session');
  mock.files.clear();                                             // space is freed
  await run.next(31 * 60_000);
  assert.equal(run.record().status, 'STORED');
  assert.equal(mock.sessions.size, 2, 'a new session after the 4xx');
});

test('through the adapter: Retry-After is honoured, and a chunk that is not a multiple of 256 KiB is refused', async t => {
  const { drive, mock } = await setup(t);
  const run = await filing(drive, 2 * 256 * KiB);
  mock.faults.nextChunk.push({ status: 429, reason: 'rateLimitExceeded', retryAfter: 600 });
  assert.equal((await run.call())[0].reason, FAILURE.RATE_LIMITED);
  assert.deepEqual(await run.next(9 * 60_000), [], 'not before Retry-After');
  await run.next(2 * 60_000);
  assert.equal(run.record().status, 'STORED');
  const odd = await filing(drive, 3 * 100 * KiB, { chunkBytes: 100 * KiB });
  const [refused] = await odd.call();
  assert.equal(refused.reason, FAILURE.INVALID);
});

test('through the adapter: searches read every page, a fresh upload is read by id while search lags, and queries are escaped', async t => {
  const { drive } = await setup(t, { searchLagMs: 60_000 });
  const run = await filing(drive, 256 * KiB + 1);
  await run.call();
  assert.equal(run.record().status, 'STORED', 'search does not show it yet, so the worker read it by id');
  // While search lags, one process remembers the folder it made; another process cannot see it
  // yet and would make a second one. Test A1 (D2) measures whether Google lags like this.
  const folder = await drive.ensureFolder('root', "O'Neil \\ test");
  assert.equal(await drive.ensureFolder('root', "O'Neil \\ test"), folder);
  assert.deepEqual(await drive.findFolders('root', "O'Neil \\ test"), [], 'not searchable yet');
  assert.equal(driveQuote("O'Neil \\ x"), "'O\\'Neil \\\\ x'");
  const paged = await setup(t, { pageSize: 2 });
  for (let i = 0; i < 5; i++) await paged.drive.ensureFolder('root', `folder-${i}`);
  assert.equal((await paged.drive.listNames('root')).length, 5, 'five folders over three pages');
});

test('a bad or revoked token pauses filing (DRIVE_AUTH); revocation is checked; a grant with more than drive.file is refused', async t => {
  const { mock, clientFile, tokenFile, dir } = await setup(t);
  const bad = createGoogleDrive({ accessToken: async () => 'not-a-token', apiBase: mock.url });
  await assert.rejects(bad.quota(), error => error instanceof FilingError && error.code === FAILURE.DRIVE_AUTH);
  const revoked = await revokeSaved({ clientFile, tokenFile, endpoints: mock.endpoints });
  assert.deepEqual(revoked, { revokeStatus: 200, refreshRefused: true, tokenFileDeleted: true });
  // A token endpoint that grants more than was asked for.
  const greedy = async (url, init) => {
    const response = await fetch(url, init);
    if (!String(url).endsWith('/token')) return response;
    const body = await response.json();
    return new Response(JSON.stringify({ ...body, scope: `${DRIVE_FILE_SCOPE} https://www.googleapis.com/auth/drive` }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const second = path.join(dir, 'private', 'second-token.json');
  await assert.rejects(authorize({ clientFile, tokenFile: second, endpoints: mock.endpoints, openUrl: async url => { await fetch(url); }, fetchImpl: greedy }), /scopes other than drive.file/);
  await assert.rejects(readFile(second), { code: 'ENOENT' });
});
