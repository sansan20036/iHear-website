// Synthetic acceptance tests for P1's automatic filing. Zoom's recording-completed notices
// arrive as signed webhooks (simulated), and a worker moves each recording into Drive in chunks
// within a time budget, as a serverless function would. Checked here: which lesson a recording
// belongs to, file names and part numbers, the work surviving a function stopped at any point,
// and Drive succeeding, failing, retrying, filling up and holding duplicates. Consent, holds and
// duplicate notices are in webhook-ingest.test.mjs. Everything runs on the in-memory fakes in
// fake-classroom-store.mjs: this shows our logic is right and proves nothing about Zoom, Drive,
// PostgreSQL or Vercel themselves.
import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyDriveResponse, classifyVendorResponse, driveUploadState, FAILURE, fileRecording, MAX_JOB_ATTEMPTS, processJobs } from '../classroom/recording-filing.mjs';
import { ingestWebhook, signZoomRequest, storeEvent } from '../classroom/webhook-ingest.mjs';
import { deriveLesson } from '../classroom/lesson-state.mjs';
import { lessonCard } from '../classroom/live-dashboard.mjs';
import { createClassroomStore, createClock, createDrive, createVendor, Killed, killSwitch, syntheticContent } from './fake-classroom-store.mjs';

const SECRET = 'synthetic-webhook-secret-not-real';
const START = Date.parse('2026-11-03T02:00:00Z');
const MIN = 60_000;
const ROOT = 'root:[測試] iHear 錄影存放區';
const MONTH = '[iHear] 11.2026.Zoom Recordings';
const CHUNK = 64;
const iso = value => new Date(value).toISOString();

function lessonFor(n, students = ['TEST-S01']) {
  const id = `L-TEST-${String(n).padStart(3, '0')}`;
  return {
    id,
    code: `TEST-L${String(n).padStart(3, '0')}`,
    date: '2026-11-03',
    startsAt: iso(START),
    endsAt: iso(START + 60 * MIN),
    participants: [
      { id: `${id}-T01`, code: 'TEST-T01', role: 'tutor' },
      ...students.map((code, i) => ({ id: `${id}-S${i + 1}`, code, role: 'student' })),
    ],
  };
}
const video = (id, startMin, endMin, size) => ({
  id, recording_start: iso(START + startMin * MIN), recording_end: iso(START + endMin * MIN), file_type: 'MP4', file_extension: 'MP4',
  file_size: size, status: 'completed', recording_type: 'shared_screen_with_speaker_view', download_url: 'https://example.invalid/synthetic',
});
const completed = (lessonId, sessionId, files, at) => ({
  event: 'session.recording_completed',
  event_ts: at,
  payload: { object: { id: sessionId, session_id: sessionId, session_key: lessonId, recording_files: files } },
});

async function world({ lessons = [lessonFor(1)], quotaLimit = null, msPerByte = 0 } = {}) {
  const clock = createClock(START + 70 * MIN);
  const store = createClassroomStore({ lessons });
  for (const lesson of lessons) {
    await store.transaction(tx => storeEvent(tx, { source: 'server', type: 'server.recording_eligibility', lessonId: lesson.id, occurredAt: START - 15 * MIN, receivedAt: START - 15 * MIN, key: `decide:${lesson.id}`, eligible: true }));
  }
  return { clock, store, drive: createDrive({ quotaLimit, clock, msPerByte }), vendor: createVendor({ clock, msPerByte }), lessons };
}

// Zoom delivers a signed notice; it must be stored (200).
async function deliver(w, body) {
  const raw = JSON.stringify(body);
  const timestamp = Math.floor(w.clock.now() / 1000);
  const headers = { 'x-zm-request-timestamp': String(timestamp), 'x-zm-signature': signZoomRequest(SECRET, timestamp, raw) };
  const response = await ingestWebhook({ headers, rawBody: raw, secret: SECRET, now: w.clock.now(), store: w.store });
  assert.equal(response.status, 200);
}

// One serverless call: the worker runs until its time budget is used up. With `kill` (or a
// kill switch in `stop`) the function is stopped after that many calls into the store, Drive or
// Zoom. Every call checks that no chunk ran past the deadline.
async function invoke(w, { budgetMs = 60_000, kill = null, stop = kill == null ? null : killSwitch(kill), chunkBytes = CHUNK, workerId = 'worker' } = {}) {
  const store = stop ? stop.wrap(w.store) : w.store;
  const drive = stop ? stop.wrap(w.drive) : w.drive;
  const download = stop ? stop.wrapFn(w.vendor.download) : w.vendor.download;
  const deadline = w.clock.now() + budgetMs;
  const handlers = {
    file_recording: ({ job, leaseVersion, clock, deadline: until, leaseMs }) =>
      fileRecording({ store, drive, download, job, leaseVersion, clock, deadline: until, leaseMs, rootFolderId: ROOT, options: { chunkBytes } }),
    delete_vendor_copy: async ({ job, leaseVersion }) => ({ status: (await store.completeJob({ jobId: job.id, leaseVersion })) ? 'DELETED' : 'LEASE_LOST' }),
  };
  try {
    const results = await processJobs({ store, clock: w.clock.now, deadline, workerId, handlers });
    assert.ok(w.clock.now() <= deadline, `the call ran ${w.clock.now() - deadline} ms past its deadline`);
    return results;
  } catch (error) {
    if (error instanceof Killed) return [{ status: 'KILLED' }];
    throw error;
  }
}

const open = w => w.store.jobs().filter(job => job.status === 'pending' || job.status === 'running');
// The worker is called every `stepMs` (a scheduler) until nothing is left to do.
async function runUntilSettled(w, { stepMs = MIN, maxCalls = 400, ...options } = {}) {
  for (let calls = 0; calls < maxCalls; calls++) {
    if (!open(w).length) return calls;
    await invoke(w, options);
    w.clock.advance(stepMs);
  }
  return assert.fail('the jobs did not settle');
}
const copiesOf = (w, id) => w.drive.activeFiles().filter(file => file.appProperties.providerFileId === id);
const jobOf = (w, id) => w.store.jobs().find(job => job.id === id);
const stateOf = (w, lesson) => deriveLesson(lesson, w.store.eventsFor(lesson.id), w.clock.now());
const anomalyOf = (w, lesson, code) => stateOf(w, lesson).anomalies.find(entry => entry.code === code);

// The month's folder, then the lesson's own folder (its date and code) inside it.
const lessonFolderOf = (w, file) => {
  const lesson = w.lessons.find(entry => entry.id === w.store.fileRecord(file.id).lessonId);
  return `${MONTH} / ${lesson.date}_${lesson.code}`;
};

function assertStoredOnce(w, file, { name, folder = lessonFolderOf(w, file) } = {}) {
  const copies = copiesOf(w, file.id);
  assert.equal(copies.length, 1, `${file.id}: one copy in Drive`);
  assert.ok(w.drive.contentOf(copies[0].id).equals(syntheticContent(file.id, 0, file.file_size)), `${file.id}: every byte right`);
  assert.equal(w.drive.folderPath(copies[0].parentId), folder);
  if (name) assert.equal(copies[0].name, name);
  const record = w.store.fileRecord(file.id);
  assert.deepEqual([record.status, record.driveFileId], ['STORED', copies[0].id]);
  const stored = w.store.events().filter(event => event.type === 'p1.filing' && event.providerFileId === file.id && event.status === 'STORED');
  assert.equal(stored.length, 1, `${file.id}: STORED recorded once`);
  assert.equal(w.store.jobs().filter(job => job.id === `delete-vendor:${file.id}`).length, 1, `${file.id}: Zoom's copy queued for deletion once`);
}

// --- Which lesson, names and part numbers ---------------------------------------------------

test('a notice for one of our lessons is filed under that lesson; a notice for a lesson this site does not hold is not stored at all and stays at Zoom', async () => {
  const w = await world();
  const ours = video('f-ours', 1, 59, 300);
  const stray = video('f-stray', 1, 59, 300);
  await deliver(w, completed('L-TEST-001', 'sess-1', [ours], w.clock.now()));
  await deliver(w, completed('L-TEST-999', 'sess-x', [stray], w.clock.now()));
  // W1 (2026-11-11): a session outside the site (a local rehearsal on the same Zoom account) leaves
  // nothing in the database, not even a held record; before, it was kept as HOLD / UNKNOWN_SESSION.
  assert.equal(w.store.fileRecord('f-stray'), null);
  await runUntilSettled(w);
  assertStoredOnce(w, ours, { name: '2026-11-03_TEST-S01_TEST-T01_P01.mp4' });
  assert.equal(copiesOf(w, 'f-stray').length, 0, 'nothing from an unknown session is uploaded');
  assert.equal(w.store.jobs().some(job => job.providerFileId === 'f-stray'), false);
});

test('a group lesson names every student code, in roster order', async () => {
  const lesson = lessonFor(2, ['TEST-S01', 'TEST-S02']);
  const w = await world({ lessons: [lesson] });
  const file = video('f-group', 1, 59, 200);
  await deliver(w, completed(lesson.id, 'sess-2', [file], w.clock.now()));
  await runUntilSettled(w);
  assertStoredOnce(w, file, { name: '2026-11-03_TEST-S01+TEST-S02_TEST-T01_P01.mp4' });
});

test('parts are numbered by when they were recorded, within a notice and across notices', async () => {
  const w = await world();
  const [a, b, c, d] = [video('f-a', 1, 10, 130), video('f-b', 12, 25, 70), video('f-c', 27, 40, 64), video('f-d', 45, 59, 10)];
  await deliver(w, completed('L-TEST-001', 'sess-1', [c, a, b], w.clock.now()));
  w.clock.advance(5 * MIN);
  await deliver(w, completed('L-TEST-001', 'sess-2', [d], w.clock.now()));
  await runUntilSettled(w);
  for (const [file, part] of [[a, 1], [b, 2], [c, 3], [d, 4]]) assertStoredOnce(w, file, { name: `2026-11-03_TEST-S01_TEST-T01_P0${part}.mp4` });
  assert.equal(anomalyOf(w, w.lessons[0], 'PART_OUT_OF_ORDER'), undefined);
});

test('a notice that arrives after a later recording keeps unique part numbers and flags the lesson', async () => {
  const w = await world();
  const early = video('f-early', 1, 20, 100);
  const late = video('f-late', 30, 59, 100);
  // Zoom's first delivery about the earlier session failed, so the later session came first.
  await deliver(w, completed('L-TEST-001', 'sess-late', [late], w.clock.now()));
  w.clock.advance(5 * MIN);
  await deliver(w, completed('L-TEST-001', 'sess-early', [early], w.clock.now()));
  await runUntilSettled(w);
  assertStoredOnce(w, late, { name: '2026-11-03_TEST-S01_TEST-T01_P01.mp4' });
  assertStoredOnce(w, early, { name: '2026-11-03_TEST-S01_TEST-T01_P02.mp4' });
  assert.equal(anomalyOf(w, w.lessons[0], 'PART_OUT_OF_ORDER')?.severity, 'warning');
  assert.equal(lessonCard(stateOf(w, w.lessons[0]), w.clock.now()).anomalies.find(entry => entry.code === 'PART_OUT_OF_ORDER').label, '分段編號與錄影先後不符');
});

test('a file someone else put in the folder under our name is left alone; ours takes the next part', async () => {
  const w = await world();
  const folder = w.drive.ensureFolder(w.drive.ensureFolder(ROOT, MONTH), '2026-11-03_TEST-L001');
  const foreign = w.drive.addFile({ name: '2026-11-03_TEST-S01_TEST-T01_P01.mp4', parentId: folder, appProperties: {}, size: 5 });
  const file = video('f-video', 1, 59, 150);
  await deliver(w, completed('L-TEST-001', 'sess-1', [file], w.clock.now()));
  await runUntilSettled(w);
  assertStoredOnce(w, file, { name: '2026-11-03_TEST-S01_TEST-T01_P02.mp4' });
  assert.ok(w.drive.activeFiles().some(entry => entry.id === foreign), 'the other file is untouched');
});

// --- Background work that survives the function ending ---------------------------------------

test('a recording bigger than one call moves over several calls through one upload session', async () => {
  const w = await world({ msPerByte: 50 });            // a 64-byte chunk takes 6.4 s to fetch and send
  const file = video('f-big', 1, 59, 20 * CHUNK + 17);
  await deliver(w, completed('L-TEST-001', 'sess-1', [file], w.clock.now()));
  const outcomes = [];
  for (let call = 0; call < 40 && open(w).length; call++) {
    outcomes.push(...(await invoke(w, { budgetMs: 40_000 })).map(result => result.status));
    w.clock.advance(1000);
  }
  assert.ok(outcomes.filter(status => status === 'CONTINUE').length >= 4, outcomes.join(' '));
  assertStoredOnce(w, file);
  assert.equal(w.drive.counters.sessionsStarted, 1, 'one upload session throughout');
  assert.equal(w.drive.counters.bytesUploaded, file.file_size, 'no byte sent twice');
  assert.ok(jobOf(w, 'file:f-big').attempts <= 1, 'carrying on is not a failed attempt');
});

test('with slow chunks a call moves only what fits before its deadline', async () => {
  const w = await world({ msPerByte: 200 });           // 25.6 s per chunk
  const file = video('f-slow', 1, 59, 3 * CHUNK);
  await deliver(w, completed('L-TEST-001', 'sess-1', [file], w.clock.now()));
  const first = await invoke(w, { budgetMs: 60_000 });
  assert.equal(first[0].status, 'CONTINUE');
  assert.equal(first[0].uploadedBytes, CHUNK, 'one chunk, then it stops rather than overrun');
  await runUntilSettled(w, { budgetMs: 60_000, stepMs: 1000 });
  assertStoredOnce(w, file);
});

test('a function stopped after any single step loses nothing: later calls file the recording exactly once', async () => {
  const file = video('f-video', 1, 59, 5 * CHUNK - 3);
  const fresh = async () => {
    const w = await world();
    await deliver(w, completed('L-TEST-001', 'sess-1', [file], w.clock.now()));
    return w;
  };
  // Count the steps of an uninterrupted call, then stop a fresh run after each of them in turn.
  const probe = killSwitch(1e6);
  await invoke(await fresh(), { stop: probe });
  const steps = 1e6 - probe.gate.left;
  assert.ok(steps > 20, `${steps} steps`);
  for (let kill = 0; kill < steps; kill++) {
    const w = await fresh();
    assert.equal((await invoke(w, { kill }))[0].status, 'KILLED', `stopped after ${kill} steps`);
    w.clock.advance(3 * MIN);                           // its lease runs out
    await runUntilSettled(w);
    assertStoredOnce(w, file);
    assert.ok(w.drive.activeFiles().every(entry => entry.appProperties.providerFileId === 'f-video'));
  }
});

test('a job stopped again and again before moving a byte gives up and is reported', async () => {
  const w = await world();
  const file = video('f-video', 1, 59, 3 * CHUNK);
  await deliver(w, completed('L-TEST-001', 'sess-1', [file], w.clock.now()));
  for (let i = 0; i < MAX_JOB_ATTEMPTS; i++) {
    assert.equal((await invoke(w, { kill: 3 }))[0].status, 'KILLED');
    w.clock.advance(3 * MIN);
  }
  await invoke(w);
  assert.equal(jobOf(w, 'file:f-video').status, 'dead');
  assert.equal(w.store.fileRecord('f-video').status, 'FAILED');
  assert.equal(anomalyOf(w, w.lessons[0], 'FILING_FAILED')?.severity, 'error');
  assert.equal(w.store.jobs().some(job => job.type === 'delete_vendor_copy'), false, "Zoom's copy is kept");
});

test('a stalled worker that outlives its lease is fenced out; the new owner carries on the same upload', async () => {
  const w = await world();
  const file = video('f-video', 1, 59, 6 * CHUNK);
  await deliver(w, completed('L-TEST-001', 'sess-1', [file], w.clock.now()));
  const run = (claim, until) => fileRecording({ store: w.store, drive: w.drive, download: w.vendor.download, job: claim.job, leaseVersion: claim.leaseVersion, clock: w.clock.now, deadline: until, leaseMs: 2 * MIN, rootFolderId: ROOT, options: { chunkBytes: CHUNK } });
  let release;
  let reached;
  const atGate = new Promise(resolve => { reached = resolve; });
  w.drive.faults.holdUpload = { gate: new Promise(resolve => { release = resolve; }), reached };
  const claimA = w.store.claimJob({ workerId: 'A', now: w.clock.now(), leaseMs: 2 * MIN });
  const runningA = run(claimA, Infinity);
  await atGate;                                        // A stalls inside its first chunk
  w.clock.advance(3 * MIN);
  const claimB = w.store.claimJob({ workerId: 'B', now: w.clock.now(), leaseMs: 2 * MIN });
  assert.equal(claimB.leaseVersion, claimA.leaseVersion + 1);
  const resultB = await run(claimB, Infinity);
  release();
  const resultA = await runningA;
  assert.equal(resultB.status, 'STORED');
  assert.equal(resultA.status, 'LEASE_LOST');
  assertStoredOnce(w, file);
  assert.equal(w.drive.counters.sessionsStarted, 1, 'B carried on the session A had started');
  assert.equal(w.drive.trashedFiles().length, 0);
});

test('a stored notice with no worker running shows FILING_DELAYED, and the next call files it', async () => {
  const w = await world();
  const file = video('f-video', 1, 59, 2 * CHUNK);
  await deliver(w, completed('L-TEST-001', 'sess-1', [file], w.clock.now()));
  assert.equal(jobOf(w, 'file:f-video').status, 'pending', 'stored, waiting for a worker');
  w.clock.advance(61 * MIN);
  assert.equal(anomalyOf(w, w.lessons[0], 'FILING_DELAYED')?.severity, 'warning');
  w.clock.advance(5 * 60 * MIN);
  assert.equal(anomalyOf(w, w.lessons[0], 'FILING_DELAYED')?.severity, 'error');
  await runUntilSettled(w);
  assertStoredOnce(w, file);
  assert.equal(anomalyOf(w, w.lessons[0], 'FILING_DELAYED'), undefined);
});

test('randomised: several lessons, stopped functions, Drive and Zoom failures and short budgets never lose or duplicate a recording', async () => {
  const outcomes = { stored: 0, failed: 0 };
  for (let seed = 1; seed <= 60; seed++) {
    const random = mulberry32(seed);
    const lessons = [lessonFor(1), lessonFor(2), lessonFor(3)];
    const w = await world({ lessons, msPerByte: 10 });
    const files = [];
    for (const lesson of lessons) {
      const list = Array.from({ length: 1 + Math.floor(random() * 3) }, (_, i) => video(`f-${seed}-${lesson.id}-${i}`, 1 + i * 15, 14 + i * 15, 1 + Math.floor(random() * 12 * CHUNK)));
      files.push(...list);
      await deliver(w, completed(lesson.id, `sess-${lesson.id}`, list, w.clock.now()));
    }
    const faults = [
      () => w.drive.failNext('uploadChunk', FAILURE.TRANSIENT),
      () => w.drive.failNext('uploadChunk', FAILURE.RATE_LIMITED, { retryAfterMs: 2 * MIN }),
      () => w.drive.failNext('findByAppProperty', FAILURE.TRANSIENT),
      () => w.vendor.failNext(FAILURE.TRANSIENT),
      () => { w.drive.faults.keepPartialOnce += 1; },
      () => { w.vendor.faults.shortReadOnce += 1; },
      () => { w.drive.faults.reportGoneOnce += 1; },
      () => { w.drive.faults.crashAfterComplete += 1; },
    ];
    for (let calls = 0; open(w).length; calls++) {
      assert.ok(calls < 600, `seed ${seed}: the jobs did not settle`);
      if (random() < 0.15) faults[Math.floor(random() * faults.length)]();
      const kill = random() < 0.2 ? Math.floor(random() * 40) : null;
      await invoke(w, { budgetMs: 20_000 + Math.floor(random() * 70_000), kill });
      w.clock.advance(MIN + Math.floor(random() * 5 * MIN));
    }
    for (const file of files) {
      const record = w.store.fileRecord(file.id);
      if (record.status === 'FAILED') {
        // Allowed only when it is reported and nothing half-done is left behind.
        outcomes.failed += 1;
        assert.equal(copiesOf(w, file.id).length, 0, `seed ${seed}: ${file.id}`);
        assert.ok(w.store.events().some(event => event.type === 'p1.filing' && event.providerFileId === file.id && event.status === 'FAILED'));
        assert.equal(w.store.jobs().some(job => job.id === `delete-vendor:${file.id}`), false);
        continue;
      }
      outcomes.stored += 1;
      assertStoredOnce(w, file);
    }
    const kept = new Set(w.store.fileRecords().map(record => record.driveFileId).filter(Boolean));
    assert.ok(w.drive.activeFiles().every(entry => kept.has(entry.id)), `seed ${seed}: no stray copy left in Drive`);
  }
  assert.ok(outcomes.stored > 0);
  console.log(`randomised filing: ${outcomes.stored} stored once, ${outcomes.failed} reported as failed`);
});

// --- Google Drive: success, failure, retry, a full Drive, duplicates ------------------------

test("a successful upload leaves one verified copy, and Zoom's copy is queued for deletion only afterwards", async () => {
  const w = await world();
  const file = video('f-video', 1, 59, 3 * CHUNK + 5);
  await deliver(w, completed('L-TEST-001', 'sess-1', [file], w.clock.now()));
  assert.equal(w.store.jobs().some(job => job.type === 'delete_vendor_copy'), false);
  await runUntilSettled(w);
  assertStoredOnce(w, file, { name: '2026-11-03_TEST-S01_TEST-T01_P01.mp4' });
  assert.equal(jobOf(w, 'delete-vendor:f-video').status, 'done');
  assert.equal(stateOf(w, w.lessons[0]).filing.status, 'STORED');
});

test('a Drive server error mid-upload is retried after a backoff and resumes from what Drive holds', async () => {
  const w = await world({ msPerByte: 50 });
  const file = video('f-video', 1, 59, 8 * CHUNK);
  await deliver(w, completed('L-TEST-001', 'sess-1', [file], w.clock.now()));
  assert.equal((await invoke(w, { budgetMs: 40_000 }))[0].status, 'CONTINUE');
  w.drive.failNext('uploadChunk', FAILURE.TRANSIENT);
  const [failed] = await invoke(w, { budgetMs: 40_000 });
  assert.deepEqual([failed.status, failed.reason], ['RETRY', FAILURE.TRANSIENT]);
  assert.ok(jobOf(w, 'file:f-video').availableAt > w.clock.now(), 'not retried at once');
  assert.deepEqual(await invoke(w), [], 'nothing to do before the backoff ends');
  w.clock.advance(MIN);
  await runUntilSettled(w, { budgetMs: 40_000 });
  assertStoredOnce(w, file);
  assert.equal(w.drive.counters.sessionsStarted, 1);
  assert.equal(w.drive.counters.bytesUploaded, file.file_size, 'what Drive already had was not sent again');
});

test('a rate limit is respected: no retry before Retry-After', async () => {
  const w = await world();
  const file = video('f-video', 1, 59, 2 * CHUNK);
  await deliver(w, completed('L-TEST-001', 'sess-1', [file], w.clock.now()));
  w.drive.failNext('uploadChunk', FAILURE.RATE_LIMITED, { retryAfterMs: 10 * MIN });
  assert.equal((await invoke(w))[0].reason, FAILURE.RATE_LIMITED);
  assert.ok(jobOf(w, 'file:f-video').availableAt >= w.clock.now() + 10 * MIN - 1000);
  w.clock.advance(9 * MIN);
  assert.deepEqual(await invoke(w), []);
  w.clock.advance(2 * MIN);
  await runUntilSettled(w);
  assertStoredOnce(w, file);
});

test("failures that never stop give up after five attempts, keep Zoom's copy and are reported", async () => {
  const w = await world();
  const file = video('f-video', 1, 59, 3 * CHUNK);
  await deliver(w, completed('L-TEST-001', 'sess-1', [file], w.clock.now()));
  w.drive.failNext('uploadChunk', FAILURE.TRANSIENT, { times: 50 });
  await runUntilSettled(w, { stepMs: 31 * MIN });
  assert.deepEqual([jobOf(w, 'file:f-video').status, jobOf(w, 'file:f-video').attempts], ['dead', MAX_JOB_ATTEMPTS]);
  assert.equal(w.store.fileRecord('f-video').status, 'FAILED');
  assert.equal(copiesOf(w, 'f-video').length, 0);
  assert.equal(w.store.jobs().some(job => job.type === 'delete_vendor_copy'), false, "Zoom's copy is kept");
  assert.equal(anomalyOf(w, w.lessons[0], 'FILING_FAILED')?.severity, 'error');
});

test('Drive full before the upload: blocked without using attempts, Zoom keeps its copy, and filing resumes by itself once there is room', async () => {
  const w = await world({ quotaLimit: 100 });
  const file = video('f-video', 1, 59, 4 * CHUNK);
  await deliver(w, completed('L-TEST-001', 'sess-1', [file], w.clock.now()));
  const [first] = await invoke(w);
  assert.deepEqual([first.status, first.reason], ['BLOCKED', FAILURE.DRIVE_QUOTA]);
  const job = jobOf(w, 'file:f-video');
  assert.deepEqual([job.status, job.attempts, job.blockedReason], ['pending', 0, FAILURE.DRIVE_QUOTA]);
  assert.equal(w.drive.counters.sessionsStarted, 0, 'no upload was started');
  assert.equal(w.store.jobs().some(entry => entry.type === 'delete_vendor_copy'), false, "Zoom's copy is kept");
  const state = stateOf(w, w.lessons[0]);
  assert.equal(state.filing.status, 'BLOCKED');
  const blocked = state.anomalies.find(entry => entry.code === 'FILING_BLOCKED');
  assert.deepEqual([blocked.severity, blocked.reason], ['error', FAILURE.DRIVE_QUOTA]);
  const card = lessonCard(state, w.clock.now());
  assert.deepEqual([card.filing.label, card.filing.reasonLabel], ['歸檔暫停，待管理員處理', '雲端硬碟空間不足']);
  // It looks again every 30 minutes; still full, it stays blocked without a new record.
  w.clock.advance(10 * MIN);
  assert.deepEqual(await invoke(w), []);
  w.clock.advance(25 * MIN);
  assert.equal((await invoke(w))[0].status, 'BLOCKED');
  assert.equal(w.store.events().filter(event => event.type === 'p1.filing' && event.status === 'BLOCKED').length, 1);
  // An administrator frees space.
  w.drive.setQuotaLimit(10_000);
  w.clock.advance(31 * MIN);
  await runUntilSettled(w);
  assertStoredOnce(w, file);
  assert.equal(anomalyOf(w, w.lessons[0], 'FILING_BLOCKED'), undefined);
  assert.ok(w.store.events().some(event => event.type === 'p1.filing' && event.status === 'RESUMED'));
});

test("Drive fills up mid-upload: blocked, then a new session starts over, as Drive's guide asks after a 4xx", async () => {
  const w = await world({ quotaLimit: 10_000, msPerByte: 50 });
  const file = video('f-video', 1, 59, 10 * CHUNK);
  await deliver(w, completed('L-TEST-001', 'sess-1', [file], w.clock.now()));
  assert.equal((await invoke(w, { budgetMs: 40_000 }))[0].status, 'CONTINUE');
  const sentBefore = w.drive.counters.bytesUploaded;
  w.drive.faults.otherUsage = 10_000 - 100;            // other files fill the Drive
  w.clock.advance(MIN);
  const [blocked] = await invoke(w, { budgetMs: 40_000 });
  assert.deepEqual([blocked.status, blocked.reason], ['BLOCKED', FAILURE.DRIVE_QUOTA]);
  assert.deepEqual([w.store.fileRecord('f-video').uploadSessionUri, w.store.fileRecord('f-video').uploadedBytes], [null, 0], 'the spent session is forgotten');
  w.drive.faults.otherUsage = 0;
  w.clock.advance(31 * MIN);
  await runUntilSettled(w, { budgetMs: 40_000 });
  assertStoredOnce(w, file);
  assert.equal(w.drive.counters.sessionsStarted, 2);
  assert.equal(w.drive.counters.bytesUploaded, sentBefore + file.file_size, 'the new session sent the whole file');
});

test("after a 4xx on a chunk the session is dropped and the upload starts over; after a 5xx it is resumed", async () => {
  for (const [code, sessions] of [[FAILURE.RATE_LIMITED, 2], [FAILURE.TRANSIENT, 1]]) {
    const w = await world({ msPerByte: 50 });
    const file = video('f-video', 1, 59, 8 * CHUNK);
    await deliver(w, completed('L-TEST-001', 'sess-1', [file], w.clock.now()));
    assert.equal((await invoke(w, { budgetMs: 40_000 }))[0].status, 'CONTINUE');
    w.drive.failNext('uploadChunk', code);
    assert.equal((await invoke(w, { budgetMs: 40_000 }))[0].reason, code);
    w.clock.advance(31 * MIN);
    await runUntilSettled(w, { budgetMs: 40_000 });
    assertStoredOnce(w, file);
    assert.equal(w.drive.counters.sessionsStarted, sessions, code);
  }
});

test("a session's state is read from Drive's answer as its upload guide describes", () => {
  assert.deepEqual(driveUploadState({ status: 308, range: 'bytes=0-42' }), { state: 'active', received: 43 }, 'Range is inclusive');
  assert.deepEqual(driveUploadState({ status: 308 }), { state: 'active', received: 0 }, 'no Range: nothing received');
  assert.deepEqual(driveUploadState({ status: 200, fileId: 'drive-1' }), { state: 'complete', fileId: 'drive-1' });
  assert.deepEqual(driveUploadState({ status: 201, fileId: 'drive-1' }), { state: 'complete', fileId: 'drive-1' });
  for (const status of [400, 401, 403, 404, 410, 429]) assert.deepEqual(driveUploadState({ status }), { state: 'gone' }, `${status}: start a new session`);
  assert.throws(() => driveUploadState({ status: 503 }), error => error.code === FAILURE.TRANSIENT && !error.restartSession);
  assert.throws(() => driveUploadState({ status: 308, range: 'bytes=10-42' }), error => error.code === FAILURE.INVALID);
});

test('revoked Drive access or a missing folder blocks filing with its own reason until it is fixed', async () => {
  for (const [op, reason, label] of [['quota', FAILURE.DRIVE_AUTH, '雲端硬碟授權失效'], ['ensureFolder', FAILURE.DRIVE_FOLDER_MISSING, '歸檔資料夾不存在或無權限']]) {
    const w = await world();
    const file = video('f-video', 1, 59, 2 * CHUNK);
    await deliver(w, completed('L-TEST-001', 'sess-1', [file], w.clock.now()));
    w.drive.failNext(op, reason);
    assert.deepEqual((await invoke(w)).map(result => [result.status, result.reason]), [['BLOCKED', reason]]);
    assert.equal(lessonCard(stateOf(w, w.lessons[0]), w.clock.now()).filing.reasonLabel, label);
    w.clock.advance(31 * MIN);
    await runUntilSettled(w);
    assertStoredOnce(w, file);
  }
});

// 2026-11-10: the first real Drive test filed into a folder open to anyone with the link (edit).
// Every recording, one-to-one lessons included, is checked before anything is uploaded.
test('a recording folder open to anyone with the link: nothing is uploaded or made in it, filing waits with its reason, and resumes once it is fixed', async () => {
  const w = await world();
  const file = video('f-video', 1, 59, 3 * CHUNK);
  w.drive.share(ROOT, { type: 'anyone', role: 'writer' });
  await deliver(w, completed('L-TEST-001', 'sess-1', [file], w.clock.now()));
  assert.deepEqual((await invoke(w)).map(result => [result.status, result.reason]), [['BLOCKED', FAILURE.DRIVE_SHARING]]);
  assert.equal(w.drive.counters.sessionsStarted, 0, 'no upload was started');
  assert.equal(w.drive.folderCount(), 0, 'no folder was made in the shared folder');
  assert.equal(copiesOf(w, file.id).length, 0);
  assert.notEqual(w.store.fileRecord(file.id).status, 'STORED');
  assert.equal(w.store.jobs().some(entry => entry.type === 'delete_vendor_copy'), false, "Zoom's copy is kept");
  const state = stateOf(w, w.lessons[0]);
  assert.equal(state.anomalies.find(entry => entry.code === 'FILING_BLOCKED')?.reason, FAILURE.DRIVE_SHARING);
  assert.match(lessonCard(state, w.clock.now()).filing.reasonLabel, /共用範圍超出錄影政策/);
  // Still shared: it stays blocked, without uploading.
  w.clock.advance(31 * MIN);
  assert.deepEqual((await invoke(w)).map(result => result.reason), [FAILURE.DRIVE_SHARING]);
  assert.equal(w.drive.counters.sessionsStarted, 0);
  // Someone points filing at a folder that is not shared that way (or fixes it): filed once.
  w.drive.unshare(ROOT);
  w.clock.advance(31 * MIN);
  await runUntilSettled(w);
  assertStoredOnce(w, file);
});

test('a domain-wide share, or a month folder shared with anyone on its own, also stops the upload', async () => {
  const w = await world();
  const file = video('f-video', 1, 59, 2 * CHUNK);
  w.drive.share(ROOT, { type: 'domain', role: 'reader', domain: 'example.test' });
  await deliver(w, completed('L-TEST-001', 'sess-1', [file], w.clock.now()));
  assert.deepEqual((await invoke(w)).map(result => result.reason), [FAILURE.DRIVE_SHARING]);
  w.drive.unshare(ROOT);
  const month = await w.drive.ensureFolder(ROOT, MONTH);
  w.drive.share(month, { type: 'anyone', role: 'reader' });
  w.clock.advance(31 * MIN);
  assert.deepEqual((await invoke(w)).map(result => result.reason), [FAILURE.DRIVE_SHARING]);
  assert.equal(w.drive.counters.sessionsStarted, 0, 'no upload was started');
});

test('the folder is shared with anyone while the upload runs: the copy never counts as filed, is deleted for good (not left in the trash), and Zoom keeps its copy', async () => {
  const w = await world({ msPerByte: 50 });
  const file = video('f-video', 1, 59, 8 * CHUNK);
  await deliver(w, completed('L-TEST-001', 'sess-1', [file], w.clock.now()));
  assert.equal((await invoke(w, { budgetMs: 40_000 }))[0].status, 'CONTINUE', 'part of the file is in Drive');
  w.drive.share(ROOT, { type: 'anyone', role: 'writer' });
  w.clock.advance(MIN);
  const results = [];
  for (let calls = 0; calls < 20 && !results.some(result => result.status === 'BLOCKED'); calls++) {
    results.push(...await invoke(w, { budgetMs: 40_000 }));
    w.clock.advance(MIN);
  }
  assert.deepEqual(results.at(-1) && [results.at(-1).status, results.at(-1).reason], ['BLOCKED', FAILURE.DRIVE_SHARING]);
  assert.equal(w.drive.counters.uploadsFinished, 1, 'the upload did finish');
  assert.equal(copiesOf(w, file.id).length, 0, 'no copy is left in the folder');
  assert.equal(w.drive.trashedFiles().length, 0, 'nor in the trash, where everyone with access could still open it');
  assert.equal(w.drive.counters.removed, 1);
  assert.notEqual(w.store.fileRecord(file.id).status, 'STORED');
  assert.equal(w.store.fileRecord(file.id).uploadSessionUri, null, 'the spent session is forgotten');
  assert.equal(w.store.events().some(event => event.type === 'p1.filing' && event.status === 'STORED'), false);
  assert.equal(w.store.jobs().some(entry => entry.type === 'delete_vendor_copy'), false, "Zoom's copy is kept");
  w.drive.unshare(ROOT);
  w.clock.advance(31 * MIN);
  await runUntilSettled(w, { budgetMs: 40_000 });
  assertStoredOnce(w, file);
});

test('an expired upload session starts over in a new one and still leaves one copy', async () => {
  const w = await world({ msPerByte: 50 });
  const file = video('f-video', 1, 59, 8 * CHUNK);
  await deliver(w, completed('L-TEST-001', 'sess-1', [file], w.clock.now()));
  assert.equal((await invoke(w, { budgetMs: 40_000 }))[0].status, 'CONTINUE');
  w.drive.expireSessions();
  w.clock.advance(MIN);
  await runUntilSettled(w, { budgetMs: 40_000 });
  assertStoredOnce(w, file);
  assert.equal(w.drive.counters.sessionsStarted, 2);
});

test('Drive keeping only part of a chunk, or Zoom sending a short read, never corrupts the file', async () => {
  const w = await world();
  const file = video('f-video', 1, 59, 6 * CHUNK + 9);
  await deliver(w, completed('L-TEST-001', 'sess-1', [file], w.clock.now()));
  w.drive.faults.keepPartialOnce = 2;
  w.vendor.faults.shortReadOnce = 1;
  await runUntilSettled(w);
  assertStoredOnce(w, file);
});

test('a fresh upload that Drive search does not show yet is checked by its id, not thrown away', async () => {
  const w = await world();
  const file = video('f-video', 1, 59, 3 * CHUNK);
  await deliver(w, completed('L-TEST-001', 'sess-1', [file], w.clock.now()));
  w.drive.faults.searchLagging = true;
  await runUntilSettled(w);
  w.drive.faults.hiddenFromSearch.clear();
  assertStoredOnce(w, file);
  assert.deepEqual([w.drive.counters.sessionsStarted, w.drive.counters.uploadsFinished, w.drive.trashedFiles().length], [1, 1, 0]);
});

test('a recording Zoom no longer has is reported as failed at once, without retries', async () => {
  const w = await world();
  const file = video('f-video', 1, 59, 2 * CHUNK);
  await deliver(w, completed('L-TEST-001', 'sess-1', [file], w.clock.now()));
  w.vendor.faults.gone.add('f-video');
  assert.deepEqual((await invoke(w)).map(result => [result.status, result.reason]), [['FAILED', FAILURE.VENDOR_FILE_GONE]]);
  assert.deepEqual([jobOf(w, 'file:f-video').status, jobOf(w, 'file:f-video').attempts], ['dead', 1]);
  const failed = w.store.events().find(event => event.type === 'p1.filing' && event.status === 'FAILED');
  assert.equal(failed.reason, FAILURE.VENDOR_FILE_GONE);
  assert.equal(anomalyOf(w, w.lessons[0], 'FILING_FAILED')?.severity, 'error');
});

test("Drive's and Zoom's answers map to what the worker does next", () => {
  const drive = input => classifyDriveResponse(input).code;
  assert.equal(drive({ status: 403, reason: 'storageQuotaExceeded' }), FAILURE.DRIVE_QUOTA);
  assert.equal(drive({ status: 403, reason: 'userRateLimitExceeded' }), FAILURE.RATE_LIMITED);
  assert.equal(drive({ status: 403, reason: 'rateLimitExceeded' }), FAILURE.RATE_LIMITED);
  assert.ok(classifyDriveResponse({ status: 403, reason: 'dailyLimitExceeded' }).retryAfterMs >= 60 * MIN);
  assert.equal(drive({ status: 403, reason: 'insufficientFilePermissions' }), FAILURE.DRIVE_AUTH);
  assert.equal(drive({ status: 401 }), FAILURE.DRIVE_AUTH);
  assert.deepEqual(classifyDriveResponse({ status: 429, retryAfter: '120' }), { code: FAILURE.RATE_LIMITED, retryAfterMs: 120_000, restartSession: false });
  // On an upload session any 4xx means starting a new session; a 5xx means resuming it.
  for (const status of [400, 401, 403, 404, 429]) assert.equal(classifyDriveResponse({ status, operation: 'session' }).restartSession, true, String(status));
  assert.equal(classifyDriveResponse({ status: 503, operation: 'session' }).restartSession, false);
  assert.equal(drive({ status: 404, operation: 'session' }), FAILURE.SESSION_GONE);
  assert.equal(drive({ status: 410, operation: 'session' }), FAILURE.SESSION_GONE);
  assert.equal(drive({ status: 404 }), FAILURE.DRIVE_FOLDER_MISSING);
  for (const status of [0, 500, 502, 503, 504]) assert.equal(drive({ status }), FAILURE.TRANSIENT);
  assert.equal(drive({ status: 400 }), FAILURE.INVALID);
  const zoom = input => classifyVendorResponse(input).code;
  assert.equal(zoom({ status: 404 }), FAILURE.VENDOR_FILE_GONE);
  assert.equal(zoom({ status: 401 }), FAILURE.VENDOR_AUTH);
  assert.equal(zoom({ status: 429 }), FAILURE.RATE_LIMITED);
  assert.equal(zoom({ status: 502 }), FAILURE.TRANSIENT);
  assert.equal(zoom({ status: 416 }), FAILURE.INVALID);
});

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 2026-11-10 readiness audit: the two branches of the sharing gate the mutation check found untested.
test('a Drive that cannot say who can open the folder counts as shared too widely: nothing is uploaded or made, and filing resumes once it can', async () => {
  const w = await world();
  const file = video('f-video', 1, 59, 2 * CHUNK);
  const permissions = w.drive.permissions;
  w.drive.permissions = undefined;
  await deliver(w, completed('L-TEST-001', 'sess-1', [file], w.clock.now()));
  assert.deepEqual((await invoke(w)).map(result => [result.status, result.reason]), [['BLOCKED', FAILURE.DRIVE_SHARING]]);
  assert.equal(w.drive.counters.sessionsStarted, 0, 'no upload was started');
  assert.equal(w.drive.folderCount(), 0, 'no folder was made');
  assert.notEqual(w.store.fileRecord(file.id).status, 'STORED');
  w.drive.permissions = permissions;
  w.clock.advance(31 * MIN);
  await runUntilSettled(w);
  assertStoredOnce(w, file);
});

test('a copy found shared after another worker already stored the recording is left to that worker: nothing is deleted', async () => {
  const w = await world();
  const file = video('f-video', 1, 59, 2 * CHUNK);
  await deliver(w, completed('L-TEST-001', 'sess-1', [file], w.clock.now()));
  const permissions = w.drive.permissions.bind(w.drive);
  let raced = false;
  w.drive.permissions = async id => {
    if (!raced && w.drive.activeFiles().some(entry => entry.id === id)) {
      raced = true;
      await w.store.transaction(tx => tx.updateFileRecord(file.id, { status: 'STORED' }));
      w.drive.share(id, { type: 'anyone', role: 'reader' });
    }
    return permissions(id);
  };
  const results = await invoke(w);
  assert.equal(raced, true, 'the copy was checked after the upload');
  assert.deepEqual(results.map(result => result.status), ['LEASE_LOST']);
  assert.equal(w.drive.counters.removed ?? 0, 0, 'the stored copy is not deleted by the worker that lost');
  assert.equal(copiesOf(w, file.id).length, 1);
});
