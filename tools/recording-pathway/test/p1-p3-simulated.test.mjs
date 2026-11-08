// P1/P3 integration on simulated recordings. A lesson's recording travels from a vendor's notice
// through that vendor's Recording Adapter into P1, which checks it, dedupes it, moves it into
// Drive in chunks and records the outcome; then the vendor's copy is deleted through the same
// adapter. The same lesson runs through Zoom's, LCIC's and a synthetic vendor's adapter, and P1's
// result must not depend on which. The worker's handlers are the ones lib/classroom-service.ts
// runs. Everything is in memory (fake-classroom-store.mjs, fake-recording-adapter.mjs) with TEST-
// codes only: this shows the interface and P1's logic hold together, and proves nothing about
// any vendor, Google Drive, PostgreSQL or Vercel.
import test from 'node:test';
import assert from 'node:assert/strict';
import { FAILURE, fileRecording, processJobs } from '../classroom/recording-filing.mjs';
import { ingestApiSnapshot, ingestFacts, ingestWebhook, signZoomRequest, storeEvent } from '../classroom/webhook-ingest.mjs';
import { deriveLesson } from '../classroom/lesson-state.mjs';
import { lessonCard } from '../classroom/live-dashboard.mjs';
import { assertRecordingAdapter } from '../classroom/recording-adapter.mjs';
import { createClassroomStore, createClock, createDrive, Killed, killSwitch, syntheticContent } from './fake-classroom-store.mjs';
import { createVendorBackend, lcicAdapter, syntheticAdapter, zoomAdapter } from './fake-recording-adapter.mjs';

const SECRET = 'synthetic-webhook-secret-not-real';
const START = Date.parse('2026-11-03T02:00:00Z');
const MIN = 60_000;
const ROOT = 'root:[測試] iHear 錄影存放區';
const MONTH = '[iHear] 11.2026.Zoom Recordings';
const QUARANTINE = '_待確認';
const CHUNK = 64;
const ROOM = 345678;
const iso = value => new Date(value).toISOString();
// Planted where vendors put them; none may reach iHear's records.
const NAME = 'Synthetic Student Name';
const EMAIL = 'student@example.invalid';
const LINK = 'https://example.invalid/signed';
const TOKEN = 'synthetic-download-token-not-real';
const PLANTED = [NAME, EMAIL, LINK, TOKEN];
const PROVIDERS = ['zoom-video-sdk', 'tencent-lcic', 'synthetic'];

function lessonFor(n, students = ['TEST-S01']) {
  const id = `L-TEST-${String(n).padStart(3, '0')}`;
  return {
    id, code: `TEST-L${String(n).padStart(3, '0')}`, date: '2026-11-03', startsAt: iso(START), endsAt: iso(START + 60 * MIN),
    participants: [{ id: `${id}-T01`, code: 'TEST-T01', role: 'tutor' }, ...students.map((code, i) => ({ id: `${id}-S${i + 1}`, code, role: 'student' }))],
  };
}

async function world({ provider = 'synthetic', lessons = [lessonFor(1)], eligible = true, deletion = 'ok' } = {}) {
  const clock = createClock(START + 70 * MIN);
  const store = createClassroomStore({ lessons });
  if (eligible) {
    for (const lesson of lessons) {
      await store.transaction(tx => storeEvent(tx, { source: 'server', type: 'server.recording_eligibility', lessonId: lesson.id, occurredAt: START - 15 * MIN, receivedAt: START - 15 * MIN, key: `decide:${lesson.id}`, eligible: true }));
    }
  }
  const backend = createVendorBackend({ clock, deletion });
  const rooms = new Map(lessons.map((lesson, i) => [ROOM + i, { lessonId: lesson.id, users: {} }]));
  const adapter = { 'zoom-video-sdk': zoomAdapter, 'tencent-lcic': b => lcicAdapter(b, rooms), synthetic: syntheticAdapter }[provider](backend);
  assert.deepEqual(assertRecordingAdapter(adapter), []);
  return { clock, store, drive: createDrive({ clock }), backend, adapter, lessons, rooms };
}

// One lesson's recording files as its vendor announces them. Files are given neutrally:
// { id, size, from, to (minutes into the lesson), type, format }. LCIC has one mixed file per
// room, whose id is lcic-<RoomId>.
function noticeFor(w, lesson, files) {
  const spec = files.map(file => ({ from: 1, to: 59, type: 'composite', format: 'MP4', ...file }));
  const end = Math.max(...spec.map(file => file.to));
  switch (w.adapter.provider) {
    case 'zoom-video-sdk': {
      const types = { composite: 'shared_screen_with_speaker_view', audio: 'audio_only', chat: 'chat_file' };
      const session = `SYN-SESSION-${lesson.id}`;
      return {
        event: 'session.recording_completed', event_ts: START + end * MIN, download_token: TOKEN,
        payload: { object: { id: session, session_id: session, session_key: lesson.id, host_email: EMAIL, recording_files: spec.map(file => ({
          id: file.id, recording_type: types[file.type], file_extension: file.format, file_type: file.format, file_size: file.size, status: 'completed',
          recording_start: iso(START + file.from * MIN), recording_end: iso(START + file.to * MIN), download_url: `${LINK}/${file.id}`,
        })) } },
      };
    }
    case 'tencent-lcic': {
      const [file] = spec;
      const roomId = [...w.rooms].find(([, room]) => room.lessonId === lesson.id)?.[0] ?? 999999;
      return {
        SdkAppId: 1400000000, Timestamp: Math.floor((START + file.to * MIN) / 1000), ExpireTime: Math.floor((START + 70 * MIN) / 1000), Sign: 'checked-by-the-route',
        EventType: 'RecordFinish', EventData: { RoomId: roomId, Duration: (file.to - file.from) * 60, RecordSize: file.size, RecordUrl: `${LINK}/lcic.mp4?sign=${TOKEN}` },
      };
    }
    default:
      return {
        room: `SYN-ROOM-${lesson.id}`, lesson: lesson.id, finishedAt: iso(START + end * MIN),
        files: spec.map(file => ({
          fileId: file.id, type: file.type, format: file.format, bytes: file.size, from: iso(START + file.from * MIN), to: iso(START + file.to * MIN),
          state: 'ready', link: `${LINK}/${file.id}?token=${TOKEN}`, owner: { name: NAME, email: EMAIL },
        })),
      };
  }
}
const fileIdFor = (w, id) => (w.adapter.provider === 'tencent-lcic' ? `lcic-${ROOM}` : id);

// Through the vendor's own way in: Zoom's notices are signed webhooks; the others are normalized
// by their adapter and stored as the LCIC callback route does.
async function deliver(w, notice) {
  const now = w.clock.now();
  if (w.adapter.provider === 'zoom-video-sdk') {
    const raw = JSON.stringify(notice);
    const timestamp = Math.floor(now / 1000);
    const headers = { 'x-zm-request-timestamp': String(timestamp), 'x-zm-signature': signZoomRequest(SECRET, timestamp, raw) };
    return ingestWebhook({ headers, rawBody: raw, secret: SECRET, now, store: w.store });
  }
  return ingestFacts({ store: w.store, facts: await w.adapter.normalize(notice, { receivedAt: now }) });
}

// One serverless call of P1's worker, with the handlers lib/classroom-service.ts gives it; the
// vendor is reached only through the adapter. `stop` stops the call after that many operations.
async function invoke(w, { budgetMs = 60_000, stop = null } = {}) {
  const store = stop ? stop.wrap(w.store) : w.store;
  const drive = stop ? stop.wrap(w.drive) : w.drive;
  const download = stop ? stop.wrapFn(w.adapter.download) : w.adapter.download;
  const deleteVendorCopy = stop ? stop.wrapFn(w.adapter.deleteVendorCopy) : w.adapter.deleteVendorCopy;
  const handlers = {
    file_recording: ({ job, leaseVersion, clock, deadline, leaseMs }) =>
      fileRecording({ store, drive, download, job, leaseVersion, clock, deadline, leaseMs, rootFolderId: ROOT, options: { chunkBytes: CHUNK } }),
    delete_vendor_copy: async ({ job, leaseVersion }) => {
      const result = await deleteVendorCopy(job);
      if (!result.ok) throw new Error(`vendor copy not deleted (${result.httpStatus})`);
      await store.completeJob({ jobId: job.id, leaseVersion });
      return { status: 'VENDOR_COPY_DELETED' };
    },
  };
  try {
    return await processJobs({ store, clock: w.clock.now, deadline: w.clock.now() + budgetMs, workerId: 'worker', handlers });
  } catch (error) {
    if (error instanceof Killed) return [{ status: 'KILLED' }];
    throw error;
  }
}

const open = w => w.store.jobs().filter(job => job.status === 'pending' || job.status === 'running');
// A scheduler calls the worker every minute until nothing is left to do.
async function runUntilSettled(w, { maxCalls = 400 } = {}) {
  for (let calls = 0; calls < maxCalls; calls++) {
    if (!open(w).length) return calls;
    await invoke(w);
    w.clock.advance(MIN);
  }
  return assert.fail('the jobs did not settle');
}

const copiesOf = (w, id) => w.drive.activeFiles().filter(file => file.appProperties.providerFileId === id);
// Where one recording ended up, everything an administrator could check.
function outcome(w, id) {
  const record = w.store.fileRecord(id);
  return {
    status: record?.status ?? null,
    hold: record?.hold ?? null,
    copies: copiesOf(w, id).map(copy => ({ name: copy.name, folder: w.drive.folderPath(copy.parentId), bytesRight: w.drive.contentOf(copy.id).equals(syntheticContent(id, 0, record.size)) })),
    filings: w.store.events().filter(event => event.type === 'p1.filing' && event.providerFileId === id).sort((a, b) => a.occurredAt - b.occurredAt).map(event => event.status),
    deletionJobs: w.store.jobs().filter(job => job.type === 'delete_vendor_copy' && job.providerFileId === id).map(job => job.status),
    deletions: w.backend.deletions.filter(entry => entry === id).length,
  };
}
// The month's folder, then the lesson's own folder (its date and code).
const LESSON_FOLDER = `${MONTH} / 2026-11-03_TEST-L001`;
const filedOnce = (name, folder = LESSON_FOLDER) => ({ status: 'STORED', hold: null, copies: [{ name, folder, bytesRight: true }], filings: ['STORED'], deletionJobs: ['done'], deletions: 1 });
const heldAtVendor = hold => ({ status: 'HOLD', hold, copies: [], filings: ['HOLD'], deletionJobs: [], deletions: 0 });
const stateOf = (w, lesson) => deriveLesson(lesson, w.store.eventsFor(lesson.id), w.clock.now());
const P01 = '2026-11-03_TEST-S01_TEST-T01_P01.mp4';

// --- One P1 whatever the vendor ------------------------------------------------------------------

test('the same lesson filed through Zoom\'s, LCIC\'s or a synthetic vendor\'s adapter ends the same in Drive', async () => {
  for (const provider of PROVIDERS) {
    const w = await world({ provider });
    const [lesson] = w.lessons;
    const id = fileIdFor(w, 'SYN-SAME-1');
    assert.equal((await deliver(w, noticeFor(w, lesson, [{ id, size: 300 }]))).status, 200, provider);
    await runUntilSettled(w);
    assert.deepEqual(outcome(w, id), filedOnce(P01), provider);
    assert.deepEqual(w.drive.activeFiles().map(file => file.appProperties), [{ providerFileId: id, lessonId: lesson.id }], provider);
    assert.equal(w.store.fileRecord(id).provider, provider);
    assert.equal(lessonCard(stateOf(w, lesson), w.clock.now()).filing.label, '已歸檔', provider);
    // Nothing that names a person or opens a file reached iHear's records or Drive.
    const kept = JSON.stringify([w.store.events(), w.store.fileRecords(), w.store.jobs(), w.drive.activeFiles()]);
    for (const planted of PLANTED) assert.ok(!kept.includes(planted), `${provider}: ${planted}`);
  }
});

test('what a vendor hands P1 for a recording: lesson, recording id, status, where the file is, and when it finished', async () => {
  const w = await world();
  const [lesson] = w.lessons;
  const notice = noticeFor(w, lesson, [{ id: 'SYN-IFACE-1', size: 300 }]);
  const [fact] = await w.adapter.normalize(notice, { receivedAt: w.clock.now() });
  // Where the file is: the vendor and its file id. The address is asked for at each download.
  assert.deepEqual({
    lessonId: fact.lessonId, recordingId: fact.files[0].providerFileId, status: fact.files[0].status,
    location: { provider: fact.provider, providerFileId: fact.files[0].providerFileId }, completedAt: fact.occurredAt,
  }, { lessonId: lesson.id, recordingId: 'SYN-IFACE-1', status: 'completed', location: { provider: 'synthetic', providerFileId: 'SYN-IFACE-1' }, completedAt: START + 59 * MIN });
  assert.ok(!JSON.stringify(fact).includes(LINK));
  // A session whose files are not all ready yet gives nothing: P1 waits for the vendor.
  assert.deepEqual(await w.adapter.normalize({ ...notice, files: [{ ...notice.files[0], state: 'processing' }] }, { receivedAt: w.clock.now() }), []);
  await deliver(w, notice);
  await runUntilSettled(w);
  assert.equal(w.backend.vendor.counters.bytesRead, 300, 'every byte read once from the vendor, in ranges');
  assert.equal(w.backend.vendor.counters.downloads, Math.ceil(300 / CHUNK));
});

// --- Names, folders and kinds ----------------------------------------------------------------------

test('names and folders: parts in recording order, every student code, and nothing but the lesson video uploaded', async () => {
  const lesson = lessonFor(2, ['TEST-S01', 'TEST-S02']);
  const w = await world({ lessons: [lesson] });
  const answer = await deliver(w, noticeFor(w, lesson, [
    { id: 'SYN-PART-2', size: 200, from: 31, to: 59 },
    { id: 'SYN-PART-1', size: 260, from: 1, to: 30 },
    { id: 'SYN-AUDIO', size: 90, type: 'audio', format: 'M4A' },
    { id: 'SYN-CHAT', size: 0, type: 'chat', format: 'TXT' },
  ]));
  assert.equal(answer.status, 200);
  await runUntilSettled(w);
  assert.deepEqual(outcome(w, 'SYN-PART-1'), filedOnce('2026-11-03_TEST-S01+TEST-S02_TEST-T01_P01.mp4', `${MONTH} / 2026-11-03_TEST-L002`));
  assert.deepEqual(outcome(w, 'SYN-PART-2'), filedOnce('2026-11-03_TEST-S01+TEST-S02_TEST-T01_P02.mp4', `${MONTH} / 2026-11-03_TEST-L002`));
  for (const id of ['SYN-AUDIO', 'SYN-CHAT']) {
    assert.equal(w.store.fileRecord(id).status, 'SKIPPED', id);
    assert.deepEqual([copiesOf(w, id).length, w.store.jobs().some(job => job.providerFileId === id)], [0, false], id);
  }
  // Every copy can be found by its lesson without reading a name.
  assert.ok(w.drive.activeFiles().every(file => file.appProperties.lessonId === lesson.id));
});

// --- Duplicates --------------------------------------------------------------------------------------

test('a recording announced three times and found again by reconciliation is filed once', async () => {
  const w = await world();
  const [lesson] = w.lessons;
  const notice = noticeFor(w, lesson, [{ id: 'SYN-DUP', size: 300 }]);
  for (let i = 0; i < 3; i++) {
    assert.equal((await deliver(w, notice)).status, 200);
    w.clock.advance(MIN);
  }
  // The website's reconciliation asks the vendor's API and names the vendor.
  const snapshot = {
    lessonId: lesson.id, providerSessionId: `SYN-ROOM-${lesson.id}`, details: { start_time: iso(START), end_time: iso(START + 60 * MIN) }, users: [], provider: 'synthetic',
    recordings: [{ id: 'SYN-DUP', recording_type: 'composite', file_extension: 'MP4', file_size: 300, status: 'completed', recording_start: iso(START + MIN), recording_end: iso(START + 59 * MIN) }],
  };
  assert.equal((await ingestApiSnapshot({ snapshot, now: w.clock.now(), store: w.store })).status, 200);
  await runUntilSettled(w);
  assert.equal(w.store.events().filter(event => event.type === 'session.recording_completed').length, 1);
  assert.deepEqual([w.store.fileRecords().length, w.store.jobs().filter(job => job.type === 'file_recording').length, w.drive.counters.uploadsFinished], [1, 1, 1]);
  assert.deepEqual(outcome(w, 'SYN-DUP'), filedOnce(P01));
});

// --- Consent and lessons that are not ours ---------------------------------------------------------

test('without consent nothing moves; after a withdrawal later recording stays at the vendor and earlier recording is quarantined', async () => {
  const none = await world({ eligible: false });
  await deliver(none, noticeFor(none, none.lessons[0], [{ id: 'SYN-NO-CONSENT', size: 300 }]));
  await runUntilSettled(none);
  assert.deepEqual(outcome(none, 'SYN-NO-CONSENT'), heldAtVendor('NO_CONSENT'));
  assert.equal(none.backend.vendor.counters.downloads, 0, 'not a byte downloaded');

  const w = await world();
  const [lesson] = w.lessons;
  await w.store.transaction(tx => storeEvent(tx, { source: 'server', type: 'server.consent_withdrawn', lessonId: lesson.id, occurredAt: START + 30 * MIN, receivedAt: START + 30 * MIN, key: `withdrawn:${lesson.id}` }));
  await deliver(w, noticeFor(w, lesson, [{ id: 'SYN-BEFORE', size: 200, from: 1, to: 29 }, { id: 'SYN-AFTER', size: 200, from: 31, to: 59 }]));
  await runUntilSettled(w);
  assert.deepEqual(outcome(w, 'SYN-AFTER'), heldAtVendor('AFTER_WITHDRAWAL'));
  // Quarantined for an administrator to decide; the vendor's copy is not deleted.
  assert.deepEqual(outcome(w, 'SYN-BEFORE'), { status: 'QUARANTINED', hold: 'CONSENT_WITHDRAWN', copies: [{ name: P01, folder: QUARANTINE, bytesRight: true }], filings: ['QUARANTINED'], deletionJobs: [], deletions: 0 });
});

test('an emergency stop protects like a withdrawal: what ran past it stays at the vendor, what ended before it is quarantined', async () => {
  const pressed = START + 30 * MIN;
  const emergency = lesson => ({ source: 'server', type: 'server.emergency_stop', lessonId: lesson.id, occurredAt: pressed, receivedAt: pressed, key: `server.emergency_stop:${lesson.id}` });
  // The stop came before Zoom's notice.
  const w = await world();
  const [lesson] = w.lessons;
  await w.store.transaction(tx => storeEvent(tx, emergency(lesson)));
  await deliver(w, noticeFor(w, lesson, [{ id: 'SYN-E-BEFORE', size: 200, from: 1, to: 29 }, { id: 'SYN-E-AFTER', size: 200, from: 31, to: 59 }]));
  await runUntilSettled(w);
  assert.deepEqual(outcome(w, 'SYN-E-AFTER'), heldAtVendor('AFTER_WITHDRAWAL'));
  assert.deepEqual(outcome(w, 'SYN-E-BEFORE'), { status: 'QUARANTINED', hold: 'CONSENT_WITHDRAWN', copies: [{ name: P01, folder: QUARANTINE, bytesRight: true }], filings: ['QUARANTINED'], deletionJobs: [], deletions: 0 });
  const quarantined = w.store.events().find(event => event.type === 'p1.filing' && event.providerFileId === 'SYN-E-BEFORE');
  assert.deepEqual([quarantined.folder, quarantined.name, quarantined.size], [QUARANTINE, P01, 200]);

  // The stop came after Zoom's notice was registered but before it was filed: it still applies.
  const v = await world();
  await deliver(v, noticeFor(v, v.lessons[0], [{ id: 'SYN-E-SPAN', size: 200, from: 1, to: 59 }]));
  await v.store.transaction(tx => storeEvent(tx, emergency(v.lessons[0])));
  await runUntilSettled(v);
  // Registered before the stop, so it carries no hold reason of its own; the worker holds it.
  assert.deepEqual(outcome(v, 'SYN-E-SPAN'), heldAtVendor(null));
  assert.equal(v.backend.vendor.counters.downloads, 0, 'not a byte downloaded');
});

test('a recording from a session that is not one of our lessons stays at the vendor', async () => {
  const w = await world();
  await deliver(w, noticeFor(w, lessonFor(999), [{ id: 'SYN-STRAY', size: 300 }]));
  await deliver(w, { ...noticeFor(w, w.lessons[0], [{ id: 'SYN-NO-LESSON', size: 300 }]), lesson: null, room: 'SYN-ROOM-X' });
  await runUntilSettled(w);
  for (const id of ['SYN-STRAY', 'SYN-NO-LESSON']) assert.deepEqual(outcome(w, id), heldAtVendor('UNKNOWN_SESSION'), id);
  assert.equal(w.backend.vendor.counters.downloads, 0);
});

// --- Failures ----------------------------------------------------------------------------------------

test('brief failures at the vendor or at Drive are retried, and the upload carries on in the same session', async () => {
  const w = await world();
  const [lesson] = w.lessons;
  await deliver(w, noticeFor(w, lesson, [{ id: 'SYN-FLAKY', size: 640 }]));
  w.backend.vendor.failNext(FAILURE.TRANSIENT, { times: 2 });
  w.drive.failNext('uploadChunk', FAILURE.TRANSIENT);
  await runUntilSettled(w);
  assert.deepEqual(outcome(w, 'SYN-FLAKY'), filedOnce(P01));
  assert.equal(w.drive.counters.sessionsStarted, 1, 'one upload session from the first byte to the last');
});

test('a recording the vendor no longer has fails at once, shows as a filing failure, and nothing is deleted', async () => {
  const w = await world();
  const [lesson] = w.lessons;
  await deliver(w, noticeFor(w, lesson, [{ id: 'SYN-GONE', size: 300 }]));
  w.backend.vendor.faults.gone.add('SYN-GONE');
  await runUntilSettled(w);
  assert.deepEqual(outcome(w, 'SYN-GONE'), { status: 'FAILED', hold: null, copies: [], filings: ['FAILED'], deletionJobs: [], deletions: 0 });
  assert.equal(w.store.jobs().find(job => job.id === 'file:SYN-GONE').attempts, 1, 'not retried');
  const state = stateOf(w, lesson);
  assert.ok(state.anomalies.some(entry => entry.code === 'FILING_FAILED' && entry.severity === 'error'));
  assert.equal(lessonCard(state, w.clock.now()).filing.label, '歸檔失敗');
});

test('a worker stopped at any point loses nothing: the next call carries on from what Drive confirmed', async () => {
  let stoppedMidUpload = 0;
  for (let kill = 1; kill <= 60; kill += 3) {
    const w = await world();
    const [lesson] = w.lessons;
    await deliver(w, noticeFor(w, lesson, [{ id: 'SYN-KILL', size: 640 }]));
    await invoke(w, { stop: killSwitch(kill) });
    const moved = w.store.fileRecord('SYN-KILL').uploadedBytes ?? 0;
    if (moved > 0 && moved < 640) stoppedMidUpload += 1;
    // The stopped call's lease runs out before anyone else may take the job.
    w.clock.advance(3 * MIN);
    await runUntilSettled(w);
    const result = outcome(w, 'SYN-KILL');
    assert.deepEqual({ ...result, deletions: result.deletions >= 1 }, { ...filedOnce(P01), deletions: true }, `stopped after ${kill} operations`);
    assert.ok(w.drive.counters.sessionsStarted <= 2, `stopped after ${kill} operations: at most one restarted upload`);
  }
  assert.ok(stoppedMidUpload >= 5, `only ${stoppedMidUpload} runs were stopped part-way through the upload`);
});

test('a full Drive blocks the filing without using up its attempts; it carries on once there is room, and every step is recorded', async () => {
  const w = await world({ provider: 'zoom-video-sdk' });
  const [lesson] = w.lessons;
  await deliver(w, noticeFor(w, lesson, [{ id: 'SYN-QUOTA', size: 300 }]));
  w.drive.setQuotaLimit(100);
  await invoke(w);
  const blocked = stateOf(w, lesson);
  assert.ok(blocked.anomalies.some(entry => entry.code === 'FILING_BLOCKED' && entry.reason === 'DRIVE_QUOTA'));
  assert.equal(lessonCard(blocked, w.clock.now()).filing.reasonLabel, '雲端硬碟空間不足');
  assert.equal(w.backend.vendor.counters.downloads, 0, 'refused before a byte moved');
  w.drive.setQuotaLimit(null);
  w.clock.advance(31 * MIN);
  await runUntilSettled(w);
  assert.deepEqual(outcome(w, 'SYN-QUOTA'), { ...filedOnce(P01), filings: ['BLOCKED', 'RESUMED', 'STORED'] });
  assert.ok(!stateOf(w, lesson).anomalies.some(entry => entry.code === 'FILING_BLOCKED'));
});

// --- Deleting the vendor's copy ----------------------------------------------------------------------

test('known limit: a vendor whose deletion is not available keeps its copy after five tries, and the filing stands', async () => {
  // Zoom's adapter answers 501 until its delete API is confirmed (lib/classroom-vendors/zoom-video-sdk.ts).
  const w = await world({ deletion: 'unsupported' });
  const [lesson] = w.lessons;
  await deliver(w, noticeFor(w, lesson, [{ id: 'SYN-KEEP', size: 300 }]));
  await runUntilSettled(w);
  assert.deepEqual(outcome(w, 'SYN-KEEP'), { ...filedOnce(P01), deletionJobs: ['dead'], deletions: 5 });
  // The dead job is the only trace: the overview says nothing about the copy the vendor still holds.
  assert.equal(lessonCard(stateOf(w, lesson), w.clock.now()).filing.label, '已歸檔');
  assert.ok(!w.store.events().some(event => /vendor/i.test(event.type)));
});

// --- The overview --------------------------------------------------------------------------------------

test('a vendor\'s callback confirms on the overview like Zoom\'s webhook', async () => {
  const w = await world({ provider: 'tencent-lcic' });
  const [lesson] = w.lessons;
  const body = { SdkAppId: 1400000000, Timestamp: Math.floor(START / 1000), ExpireTime: Math.floor(START / 1000) + 300, Sign: 'checked-by-the-route', EventType: 'RoomStart', EventData: { RoomId: ROOM } };
  assert.equal((await ingestFacts({ store: w.store, facts: await w.adapter.normalize(body, { receivedAt: START }) })).status, 200);
  const state = deriveLesson(lesson, w.store.eventsFor(lesson.id), START + MIN);
  assert.deepEqual([state.phase.value, state.dataState.lastConfirmedAt, state.dataState.value], ['LIVE', START, 'REALTIME']);
});

test('a Zoom notice that breaks the contract is answered 422, recorded as refused, raised at once, and nothing moves', async () => {
  const w = await world({ provider: 'zoom-video-sdk' });
  const [lesson] = w.lessons;
  const answer = await deliver(w, noticeFor(w, lesson, [{ id: 'SYN-NO-SIZE', size: 0 }]));
  assert.equal(answer.status, 422);
  await runUntilSettled(w);
  assert.deepEqual([w.store.fileRecords(), w.store.jobs(), w.drive.activeFiles()], [[], [], []]);
  const state = stateOf(w, lesson);
  assert.deepEqual(state.anomalies.filter(entry => entry.code === 'RECORDING_REFUSED').map(entry => entry.severity), ['error']);
  assert.equal(state.dataState.value, 'ANOMALY');
});
