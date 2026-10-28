// Synthetic tests for webhook intake and recording filing: answer 200 only after the event is
// committed, 503 on any storage problem so Zoom retries, never a duplicate record or filing,
// and nothing personal kept. The database and Drive are the in-memory fakes; see
// fake-classroom-store.mjs for what they guarantee and what they cannot prove.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import {
  fileRecording,
  ingestApiSnapshot,
  ingestWebhook,
  minimizeZoomEvent,
  processJobs,
  signZoomRequest,
  storeEvent,
} from '../classroom/webhook-ingest.mjs';
import { deriveLesson } from '../classroom/lesson-state.mjs';
import { createClassroomStore, createDrive, syntheticDownload } from './fake-classroom-store.mjs';

const SECRET = 'synthetic-webhook-secret-not-real';
const START = Date.parse('2026-11-03T02:00:00Z');
const MIN = 60_000;
const ROOT = 'root:[測試] iHear 錄影存放區';
const iso = value => new Date(value).toISOString();
const lesson = {
  id: 'L-TEST-001',
  code: 'TEST-L001',
  date: '2026-11-03',
  startsAt: iso(START),
  endsAt: iso(START + 60 * MIN),
  participants: [
    { id: 'P-TEST-T01', code: 'TEST-T01', role: 'tutor' },
    { id: 'P-TEST-S01', code: 'TEST-S01', role: 'student' },
  ],
};
const PLANTED = ['Synthetic Display Name', '203.0.113.', 'synthetic-download-token-not-real', 'example.invalid', '/synthetic/path', '+886-2'];

function sessionObject(extra = {}) {
  return { id: 'sess-TEST-001', session_id: 'sess-TEST-001', session_name: 'ihear-l-test-001', session_key: 'L-TEST-001', ...extra };
}
function joined(at, user = {}) {
  return {
    event: 'session.user_joined',
    event_ts: at,
    payload: { account_id: 'synthetic-account', object: sessionObject({ user: { id: '16778240', name: 'Synthetic Display Name', join_time: iso(at), participant_uuid: 'uuid-TEST-S01', user_key: 'P-TEST-S01', phone_number: '+886-2-0000-0000', ...user } }) },
  };
}
function video(id, start, end) {
  return {
    id, recording_start: iso(start), recording_end: iso(end), file_name: 'Synthetic Display Name recording', file_path: '/synthetic/path',
    file_type: 'MP4', file_size: 64, file_extension: 'MP4', download_url: 'https://example.invalid/synthetic/download', status: 'completed',
    recording_type: 'shared_screen_with_speaker_view',
  };
}
function audio(id, start, end) {
  return { ...video(id, start, end), file_type: 'M4A', file_extension: 'M4A', file_size: 32, recording_type: 'audio_only' };
}
function completed(at, files) {
  return { event: 'session.recording_completed', event_ts: at, download_token: 'synthetic-download-token-not-real', payload: { object: sessionObject({ start_time: iso(START), recording_files: files }) } };
}
function reshuffled(value) {
  if (Array.isArray(value)) return value.map(reshuffled);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).reverse().map(([key, entry]) => [key, reshuffled(entry)]));
  return value;
}
// A signed delivery as Zoom would send it; options change its bytes or break it.
function delivery(body, now, { ageMs = 0, tamper = false, reshuffle = false } = {}) {
  const raw = reshuffle ? JSON.stringify(reshuffled(body), null, 2) : JSON.stringify(body);
  const timestamp = Math.floor((now - ageMs) / 1000);
  return {
    headers: { 'x-zm-request-timestamp': String(timestamp), 'x-zm-signature': signZoomRequest(SECRET, timestamp, raw) },
    rawBody: tamper ? raw.replace('P-TEST-S01', 'P-TEST-S66') : raw,
    secret: SECRET,
    now,
  };
}
async function setup({ eligible = true } = {}) {
  const store = createClassroomStore({ lessons: [lesson] });
  await store.transaction(tx => storeEvent(tx, { source: 'server', type: 'server.recording_eligibility', lessonId: lesson.id, occurredAt: START - 15 * MIN, receivedAt: START - 15 * MIN, key: 'decide:L-TEST-001', eligible }));
  return { store, drive: createDrive() };
}
const handlersFor = (store, drive, download = syntheticDownload) => ({
  file_recording: ({ job, leaseVersion, now }) => fileRecording({ store, drive, download, job, leaseVersion, now, rootFolderId: ROOT, options: { chunkBytes: 16 } }),
  delete_vendor_copy: ({ job, leaseVersion }) => ({ status: store.completeJob({ jobId: job.id, leaseVersion }) ? 'DONE' : 'LEASE_LOST' }),
});
const filingEvents = store => store.events().filter(event => event.type === 'p1.filing');
const copiesOf = (drive, id) => drive.activeFiles().filter(file => file.appProperties.providerFileId === id);

test('a webhook is answered 200 only once its event is committed', async () => {
  const { store } = await setup();
  store.faults.delayMs = 20;
  const response = await ingestWebhook({ ...delivery(joined(START + MIN), START + MIN + 2_000), store });
  assert.equal(response.status, 200);
  // When the answer exists, the event is already in the database.
  const stored = store.events().filter(event => event.type === 'session.user_joined');
  assert.equal(stored.length, 1);
  assert.equal(stored[0].participantId, 'P-TEST-S01');
  assert.equal(stored[0].lessonId, 'L-TEST-001');
});

test('a storage failure answers 503 and writes nothing; the retries are stored once', async () => {
  const { store } = await setup();
  const body = completed(START + 70 * MIN, [video('f-video', START + MIN, START + 60 * MIN), audio('f-audio', START + MIN, START + 60 * MIN)]);
  store.faults.failTransactions = 1;
  const first = await ingestWebhook({ ...delivery(body, START + 70 * MIN), store });
  assert.equal(first.status, 503);
  assert.equal(store.events().filter(event => event.type === 'session.recording_completed').length, 0);
  assert.equal(store.fileRecords().length, 0);
  assert.equal(store.jobs().length, 0);
  // Zoom's retries come 5 and 25 minutes later, the second with different bytes.
  const second = await ingestWebhook({ ...delivery(body, START + 75 * MIN), store });
  const third = await ingestWebhook({ ...delivery(body, START + 95 * MIN, { reshuffle: true }), store });
  assert.deepEqual([second.status, second.body.stored, third.status, third.body.duplicates], [200, 1, 200, 1]);
  assert.equal(store.events().filter(event => event.type === 'session.recording_completed').length, 1);
  assert.deepEqual(store.fileRecords().map(record => `${record.providerFileId}:${record.status}`).sort(), ['f-audio:SKIPPED', 'f-video:PENDING']);
  assert.deepEqual(store.jobs().map(job => job.id), ['file:f-video']);
});

test('a slow database answers 503 within the time budget, and its late commit is not repeated', async () => {
  const { store } = await setup();
  store.faults.delayMs = 60;
  const response = await ingestWebhook({ ...delivery(joined(START + MIN), START + MIN), store, budgetMs: 10 });
  assert.equal(response.status, 503);
  await new Promise(resolve => { setTimeout(resolve, 100); });
  assert.equal(store.events().filter(event => event.type === 'session.user_joined').length, 1, 'the slow commit landed after the answer');
  store.faults.delayMs = 0;
  const retry = await ingestWebhook({ ...delivery(joined(START + MIN), START + 6 * MIN), store });
  assert.deepEqual([retry.status, retry.body.duplicates], [200, 1]);
  assert.equal(store.events().filter(event => event.type === 'session.user_joined').length, 1);
});

test('a bad signature, a stale or missing timestamp answers 401 and stores nothing', async () => {
  const { store } = await setup();
  const before = store.events().length;
  const body = joined(START + MIN);
  const tampered = await ingestWebhook({ ...delivery(body, START + MIN, { tamper: true }), store });
  const stale = await ingestWebhook({ ...delivery(body, START + MIN, { ageMs: 10 * MIN }), store });
  const missing = await ingestWebhook({ headers: {}, rawBody: JSON.stringify(body), secret: SECRET, now: START + MIN, store });
  assert.deepEqual([tampered.status, tampered.body.error], [401, 'SIGNATURE_MISMATCH']);
  assert.deepEqual([stale.status, stale.body.error], [401, 'STALE_OR_MISSING_TIMESTAMP']);
  assert.equal(missing.status, 401);
  assert.equal(store.events().length, before);
});

test("Zoom's URL validation gets the HMAC of its plain token, and nothing is stored", async () => {
  const { store } = await setup();
  const before = store.events().length;
  const body = { event: 'endpoint.url_validation', event_ts: START, payload: { plainToken: 'synthetic-plain-token' } };
  const response = await ingestWebhook({ ...delivery(body, START), store });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { plainToken: 'synthetic-plain-token', encryptedToken: createHmac('sha256', SECRET).update('synthetic-plain-token').digest('hex') });
  assert.equal(store.events().length, before);
});

test('stored events, records and jobs keep no names, numbers, addresses, links or tokens', async () => {
  const { store, drive } = await setup();
  await ingestWebhook({ ...delivery(joined(START + MIN), START + MIN), store });
  await ingestWebhook({ ...delivery(completed(START + 70 * MIN, [video('f-video', START + MIN, START + 60 * MIN)]), START + 70 * MIN), store });
  await ingestApiSnapshot({
    snapshot: {
      lessonId: lesson.id,
      providerSessionId: 'sess-TEST-001',
      details: { start_time: iso(START) },
      users: [{ user_key: 'P-TEST-S01', participant_uuid: 'uuid-TEST-S01', join_time: iso(START + MIN), name: 'Synthetic Display Name', ip_address: '203.0.113.7', device: 'Synthetic Device' }],
      recordings: [],
    },
    now: START + 5 * MIN,
    store,
  });
  await processJobs({ store, now: START + 71 * MIN, workerId: 'worker-1', handlers: handlersFor(store, drive) });
  const everything = JSON.stringify([store.events(), store.fileRecords(), store.jobs(), drive.activeFiles()]);
  for (const planted of [...PLANTED, 'Synthetic Device']) assert.equal(everything.includes(planted), false, planted);
  assert.equal(minimizeZoomEvent(joined(START), START).participantId, 'P-TEST-S01');
});

test('duplicates are recognised by meaning: other bytes, or the same fact from a REST snapshot', async () => {
  const { store } = await setup();
  await ingestWebhook({ ...delivery(joined(START + MIN), START + MIN), store });
  const again = await ingestWebhook({ ...delivery(joined(START + MIN), START + 6 * MIN, { reshuffle: true }), store });
  assert.equal(again.body.duplicates, 1);
  const snapshot = await ingestApiSnapshot({
    snapshot: { lessonId: lesson.id, providerSessionId: 'sess-TEST-001', details: { start_time: iso(START) }, users: [{ user_key: 'P-TEST-S01', participant_uuid: 'uuid-TEST-S01', join_time: iso(START + MIN) }], recordings: [] },
    now: START + 7 * MIN,
    store,
  });
  // session.started and the join were already known; only the snapshot marker is new.
  assert.deepEqual([snapshot.body.stored, snapshot.body.duplicates], [2, 1]);
  assert.equal(store.events().filter(event => event.type === 'session.user_joined').length, 1);
});

test('a job left behind by a crash before processing is done exactly once later', async () => {
  const { store, drive } = await setup();
  await ingestWebhook({ ...delivery(completed(START + 70 * MIN, [video('f-video', START + MIN, START + 60 * MIN)]), START + 70 * MIN), store });
  // The process stopped right after answering 200: nothing was processed yet.
  assert.equal(store.jobs().find(job => job.id === 'file:f-video').status, 'pending');
  const first = await processJobs({ store, now: START + 90 * MIN, workerId: 'worker-2', handlers: handlersFor(store, drive) });
  const second = await processJobs({ store, now: START + 91 * MIN, workerId: 'worker-2', handlers: handlersFor(store, drive) });
  assert.equal(first.find(result => result.jobId === 'file:f-video').status, 'STORED');
  assert.equal(second.filter(result => result.jobId === 'file:f-video').length, 0);
  assert.equal(copiesOf(drive, 'f-video').length, 1);
  assert.equal(filingEvents(store).filter(event => event.status === 'STORED').length, 1);
  const [copy] = copiesOf(drive, 'f-video');
  assert.equal(copy.name, '2026-11-03_TEST-S01_TEST-T01_P01.mp4');
  assert.equal(drive.folderName(copy.parentId), '[iHear] 11.2026.Zoom Recordings');
});

test('two workers racing on one filing job, with the lease running out, keep one copy and one STORED', async () => {
  const { store, drive } = await setup();
  await ingestWebhook({ ...delivery(completed(START + 70 * MIN, [video('f-video', START + MIN, START + 60 * MIN)]), START + 70 * MIN), store });
  let release;
  let reached;
  const atGate = new Promise(resolve => { reached = resolve; });
  drive.faults.holdUpload = { gate: new Promise(resolve => { release = resolve; }), reached };
  const T = START + 71 * MIN;
  const claimA = store.claimJob({ workerId: 'A', now: T, leaseMs: 5 * MIN });
  const runningA = fileRecording({ store, drive, download: syntheticDownload, job: claimA.job, leaseVersion: claimA.leaseVersion, now: T, rootFolderId: ROOT });
  // A has recorded its upload session and stalls inside the upload. Its lease runs out, B takes
  // the job and, finding A's upload session unusable, uploads its own copy.
  await atGate;
  drive.faults.reportGoneOnce = 1;
  const claimB = store.claimJob({ workerId: 'B', now: T + 6 * MIN, leaseMs: 5 * MIN });
  assert.equal(claimB.leaseVersion, claimA.leaseVersion + 1);
  const resultB = await fileRecording({ store, drive, download: syntheticDownload, job: claimB.job, leaseVersion: claimB.leaseVersion, now: T + 6 * MIN, rootFolderId: ROOT });
  release();
  const resultA = await runningA;
  assert.equal(resultB.status, 'STORED');
  assert.equal(resultA.status, 'LEASE_LOST');
  assert.equal(copiesOf(drive, 'f-video').length, 1, 'one active copy');
  assert.equal(copiesOf(drive, 'f-video')[0].id, resultB.driveFileId);
  assert.equal(drive.trashedFiles().length, 1, "A's extra copy went to the trash");
  assert.equal(store.fileRecord('f-video').driveFileId, resultB.driveFileId);
  assert.equal(filingEvents(store).filter(event => event.status === 'STORED').length, 1);
  assert.equal(store.jobs().filter(job => job.type === 'delete_vendor_copy').length, 1);
});

test('a crash right after a successful upload is recovered without uploading again', async () => {
  const { store, drive } = await setup();
  await ingestWebhook({ ...delivery(completed(START + 70 * MIN, [video('f-video', START + MIN, START + 60 * MIN)]), START + 70 * MIN), store });
  drive.faults.crashAfterComplete = 1;
  const first = await processJobs({ store, now: START + 71 * MIN, workerId: 'worker-1', handlers: handlersFor(store, drive) });
  assert.equal(first[0].status, 'RETRY');
  assert.equal(store.fileRecord('f-video').status, 'PENDING');
  assert.equal(copiesOf(drive, 'f-video').length, 1, 'the upload itself had finished');
  const second = await processJobs({ store, now: START + 72 * MIN, workerId: 'worker-2', handlers: handlersFor(store, drive) });
  assert.equal(second[0].status, 'STORED');
  assert.deepEqual([drive.counters.sessionsStarted, drive.counters.uploadsFinished], [1, 1]);
  assert.equal(copiesOf(drive, 'f-video').length, 1);
});

test('an upload interrupted halfway resumes the same upload session', async () => {
  const { store, drive } = await setup();
  await ingestWebhook({ ...delivery(completed(START + 70 * MIN, [video('f-video', START + MIN, START + 60 * MIN)]), START + 70 * MIN), store });
  drive.faults.crashAfterChunks = 2;
  const first = await processJobs({ store, now: START + 71 * MIN, workerId: 'worker-1', handlers: handlersFor(store, drive) });
  assert.equal(first[0].status, 'RETRY');
  assert.equal(copiesOf(drive, 'f-video').length, 0);
  const second = await processJobs({ store, now: START + 72 * MIN, workerId: 'worker-1', handlers: handlersFor(store, drive) });
  assert.equal(second[0].status, 'STORED');
  assert.equal(drive.counters.sessionsStarted, 1, 'no second upload session');
  assert.equal(copiesOf(drive, 'f-video')[0].size, 64);
});

test('a completed notice delivered three times and found again by reconciliation is filed once', async () => {
  const { store, drive } = await setup();
  const files = [video('f-video', START + MIN, START + 60 * MIN), audio('f-audio', START + MIN, START + 60 * MIN)];
  for (const [at, reshuffle] of [[70, false], [75, true], [95, true]]) {
    await ingestWebhook({ ...delivery(completed(START + 70 * MIN, files), START + at * MIN, { reshuffle }), store });
  }
  await ingestApiSnapshot({
    snapshot: { lessonId: lesson.id, providerSessionId: 'sess-TEST-001', details: { start_time: iso(START), end_time: iso(START + 60 * MIN) }, users: [], recordings: files },
    now: START + 100 * MIN,
    store,
  });
  assert.equal(store.jobs().filter(job => job.type === 'file_recording').length, 1);
  for (const minute of [101, 102, 103]) await processJobs({ store, now: START + minute * MIN, workerId: 'worker-1', handlers: handlersFor(store, drive) });
  assert.equal(copiesOf(drive, 'f-video').length, 1);
  assert.equal(copiesOf(drive, 'f-audio').length, 0, 'audio is not kept');
  assert.equal(filingEvents(store).length, 1);
});

test('copies left over from earlier attempts converge to the earliest verified one', async () => {
  const { store, drive } = await setup();
  await ingestWebhook({ ...delivery(completed(START + 70 * MIN, [video('f-video', START + MIN, START + 60 * MIN)]), START + 70 * MIN), store });
  const folder = drive.ensureFolder(ROOT, '[iHear] 11.2026.Zoom Recordings');
  const meta = { parentId: folder, appProperties: { providerFileId: 'f-video', lessonId: lesson.id } };
  const broken = drive.addFile({ ...meta, name: 'partial.mp4', size: 10 });
  const earliest = drive.addFile({ ...meta, name: 'first.mp4', size: 64 });
  const later = drive.addFile({ ...meta, name: 'second.mp4', size: 64 });
  const [result] = await processJobs({ store, now: START + 71 * MIN, workerId: 'worker-1', handlers: handlersFor(store, drive) });
  assert.deepEqual([result.status, result.driveFileId], ['STORED', earliest]);
  assert.equal(drive.counters.sessionsStarted, 0, 'nothing uploaded again');
  assert.deepEqual(copiesOf(drive, 'f-video').map(file => file.id), [earliest]);
  assert.deepEqual(drive.trashedFiles().map(file => file.id).sort(), [broken, later].sort());
});

test('a filing that keeps failing gives up after five attempts and shows as FAILED', async () => {
  const { store, drive } = await setup();
  await ingestWebhook({ ...delivery(completed(START + 70 * MIN, [video('f-video', START + MIN, START + 60 * MIN)]), START + 70 * MIN), store });
  const failing = async () => { throw new Error('synthetic download failure'); };
  let now = START + 71 * MIN;
  for (let i = 0; i < 8; i++) {
    await processJobs({ store, now, workerId: 'worker-1', handlers: handlersFor(store, drive, failing) });
    now += 31 * MIN;
  }
  const job = store.jobs().find(entry => entry.id === 'file:f-video');
  assert.deepEqual([job.status, job.attempts], ['dead', 5]);
  assert.equal(store.fileRecord('f-video').status, 'FAILED');
  const state = deriveLesson(lesson, store.eventsFor(lesson.id), now);
  assert.equal(state.filing.status, 'FAILED');
  assert.ok(state.anomalies.some(entry => entry.code === 'FILING_FAILED' && entry.severity === 'error'));
});

test('after a withdrawal, later recording is never uploaded and earlier recording is quarantined', async () => {
  const { store, drive } = await setup();
  await store.transaction(tx => storeEvent(tx, { source: 'server', type: 'server.consent_withdrawn', lessonId: lesson.id, occurredAt: START + 20 * MIN, receivedAt: START + 20 * MIN, key: 'withdrawn:L-TEST-001' }));
  const files = [video('f-before', START + MIN, START + 19 * MIN), video('f-after', START + 19.5 * MIN, START + 21 * MIN)];
  await ingestWebhook({ ...delivery(completed(START + 31 * MIN, files), START + 31 * MIN), store });
  assert.equal(store.fileRecord('f-after').status, 'HOLD');
  assert.equal(store.fileRecord('f-after').hold, 'AFTER_WITHDRAWAL');
  await processJobs({ store, now: START + 32 * MIN, workerId: 'worker-1', handlers: handlersFor(store, drive) });
  assert.equal(store.fileRecord('f-before').status, 'QUARANTINED');
  assert.equal(drive.folderName(copiesOf(drive, 'f-before')[0].parentId), '_待確認');
  assert.equal(copiesOf(drive, 'f-after').length, 0, 'nothing after the withdrawal is uploaded');
  assert.equal(store.jobs().filter(job => job.type === 'delete_vendor_copy').length, 0, "Zoom's copy stays until someone decides");
});

test('recordings without consent, or made with someone unknown in the room, stay on hold at Zoom', async () => {
  const blocked = await setup({ eligible: false });
  await ingestWebhook({ ...delivery(completed(START + 70 * MIN, [video('f-video', START + MIN, START + 60 * MIN)]), START + 70 * MIN), store: blocked.store });
  assert.deepEqual([blocked.store.fileRecord('f-video').status, blocked.store.fileRecord('f-video').hold], ['HOLD', 'NO_CONSENT']);
  assert.equal(blocked.store.jobs().length, 0);

  const { store, drive } = await setup();
  await ingestWebhook({ ...delivery(joined(START + 10 * MIN, { user_key: 'P-TEST-X99', participant_uuid: 'uuid-X99' }), START + 10 * MIN), store });
  const files = [video('f-early', START + MIN, START + 9 * MIN), video('f-late', START + 9.5 * MIN, START + 15 * MIN)];
  await ingestWebhook({ ...delivery(completed(START + 25 * MIN, files), START + 25 * MIN), store });
  await processJobs({ store, now: START + 26 * MIN, workerId: 'worker-1', handlers: handlersFor(store, drive) });
  assert.equal(store.fileRecord('f-early').status, 'STORED');
  assert.deepEqual([store.fileRecord('f-late').status, store.fileRecord('f-late').hold], ['HOLD', 'UNKNOWN_PARTICIPANT']);
  assert.equal(copiesOf(drive, 'f-late').length, 0);
});
