// Synthetic tests for the phase-3 fixes (2026-10-31): learning the vendor's session without
// webhooks (P-1), asking about ended sessions (P-2), lessons that ran in several sessions (P-3),
// a vendor's download answers (P-5, P-7) and side files that never finish (P-8). The website's
// half (the Zoom adapter, the routes) is in tests/classroom-vendors.test.mjs and
// tests/classroom-api.test.mjs. Synthetic data only: nothing here says how Zoom really answers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkVendorRange, FAILURE, FilingError, fileRecording, processJobs } from '../classroom/recording-filing.mjs';
import { ingestHostReport, normalizeApiSnapshot, SIDE_FILE_GRACE_MS, storeEvent } from '../classroom/webhook-ingest.mjs';
import { deriveLesson } from '../classroom/lesson-state.mjs';
import { lessonCard } from '../classroom/live-dashboard.mjs';
import { createClassroomStore, createDrive, syntheticContent } from './fake-classroom-store.mjs';

const START = Date.parse('2026-11-03T02:00:00Z');
const MIN = 60_000;
const iso = value => new Date(value).toISOString();
const lesson = {
  id: 'L-TEST-P3', code: 'TEST-P3', date: '2026-11-03', startsAt: iso(START), endsAt: iso(START + 60 * MIN),
  participants: [{ id: 'P-TEST-T01', code: 'TEST-T01', role: 'tutor' }, { id: 'P-TEST-S01', code: 'TEST-S01', role: 'student' }],
};
const video = (id, from, to, status = 'completed', size = 64) => ({
  id, recording_type: 'shared_screen_with_speaker_view', file_extension: 'MP4', file_type: 'MP4', file_size: size, status,
  recording_start: iso(START + from * MIN), recording_end: iso(START + to * MIN), download_url: 'https://example.invalid/synthetic',
});
const timeline = (id, status) => ({ id, recording_type: 'timeline', file_extension: 'JSON', file_type: 'TIMELINE', file_size: 10, status });
const recordingFacts = facts => facts.filter(fact => fact.type === 'session.recording_completed');
const failureOf = input => { try { checkVendorRange(input); return null; } catch (error) { return [error instanceof FilingError, error.code, error.retryAfterMs]; } };

// --- P-7: the vendor's answer to a byte range -------------------------------------------------

test('a byte range is taken only when the vendor says it sent exactly those bytes of a file of the notice\'s size', () => {
  const bytes = Buffer.alloc(16, 1);
  const range = { bytes, start: 16, end: 32, size: 64 };
  assert.equal(checkVendorRange({ status: 206, contentRange: 'bytes 16-31/64', ...range }), bytes);
  // Another size than the notice gave (a size in another unit, say): fails for good.
  assert.deepEqual(failureOf({ status: 206, contentRange: 'bytes 16-31/65536', ...range }), [true, FAILURE.SIZE_MISMATCH, 0]);
  // Not saying which bytes, or how big the file is, or sending other bytes: tried again.
  assert.deepEqual(failureOf({ status: 206, contentRange: null, ...range }), [true, FAILURE.TRANSIENT, 0]);
  assert.deepEqual(failureOf({ status: 206, contentRange: 'bytes 16-31/*', ...range }), [true, FAILURE.TRANSIENT, 0]);
  assert.deepEqual(failureOf({ status: 206, contentRange: 'bytes 0-15/64', ...range }), [true, FAILURE.TRANSIENT, 0]);
  assert.deepEqual(failureOf({ status: 206, contentRange: 'bytes 16-31/64', ...range, bytes: Buffer.alloc(15) }), [true, FAILURE.TRANSIENT, 0]);
  // The whole file: only for a range from byte 0, and only at the notice's size.
  const whole = Buffer.alloc(64, 2);
  assert.equal(checkVendorRange({ status: 200, bytes: whole, start: 0, end: 16, size: 64 }).length, 16);
  assert.deepEqual(failureOf({ status: 200, bytes: Buffer.alloc(80), start: 0, end: 16, size: 64 }), [true, FAILURE.SIZE_MISMATCH, 0]);
  assert.deepEqual(failureOf({ status: 200, bytes: whole, start: 16, end: 32, size: 64 }), [true, FAILURE.INVALID, 0]);
  // Everything else is classified like any vendor answer.
  assert.deepEqual(failureOf({ status: 404, ...range }), [true, FAILURE.VENDOR_FILE_GONE, 0]);
  assert.deepEqual(failureOf({ status: 401, ...range }), [true, FAILURE.VENDOR_AUTH, 0]);
  assert.deepEqual(failureOf({ status: 429, retryAfter: '20', ...range }), [true, FAILURE.RATE_LIMITED, 20_000]);
  assert.deepEqual(failureOf({ status: 502, ...range }), [true, FAILURE.TRANSIENT, 0]);
});

test('a recording whose vendor copy is not the size its notice said fails at once: nothing stored, the vendor copy kept, the reason shown', async () => {
  const store = createClassroomStore({ lessons: [lesson] });
  await store.transaction(tx => storeEvent(tx, { source: 'server', type: 'server.recording_eligibility', lessonId: lesson.id, occurredAt: START - 15 * MIN, receivedAt: START - 15 * MIN, key: 'decide', eligible: true }));
  const [fact] = recordingFacts(normalizeApiSnapshot({ lessonId: lesson.id, providerSessionId: 's-1', details: {}, recordings: [video('f-unit', 1, 59)], observedAt: START + 70 * MIN, provider: 'synthetic' }));
  await store.transaction(tx => storeEvent(tx, fact));
  const drive = createDrive();
  // The vendor holds 1,024 times as many bytes as its notice said.
  const download = async (record, { start, end }) => checkVendorRange({ status: 206, contentRange: `bytes ${start}-${end - 1}/${record.size * 1024}`, bytes: syntheticContent(record.providerFileId, start, end), start, end, size: record.size });
  const handlers = { file_recording: input => fileRecording({ store, drive, download, rootFolderId: 'root', options: { chunkBytes: 16 }, ...input }) };
  const results = await processJobs({ store, now: START + 71 * MIN, workerId: 'w', handlers });
  assert.deepEqual(results.map(result => [result.status, result.reason]), [['FAILED', FAILURE.SIZE_MISMATCH]]);
  assert.equal(store.fileRecord('f-unit').status, 'FAILED');
  assert.deepEqual(drive.activeFiles(), []);
  assert.equal(store.jobs().some(job => job.type === 'delete_vendor_copy'), false, 'the vendor copy is never deleted');
  const card = lessonCard(deriveLesson(lesson, store.eventsFor(lesson.id), START + 72 * MIN), START + 72 * MIN);
  assert.deepEqual([card.filing.status, card.filing.reason, card.filing.reasonLabel], ['FAILED', 'SIZE_MISMATCH', '錄影檔大小與視訊服務的通知不符，未存入（原檔保留）']);
});

// --- P-1: the session id the tutor's page reports ------------------------------------------------

test('a session id from the tutor\'s page is kept once, only as reported, and a malformed one is refused', async () => {
  const store = createClassroomStore({ lessons: [lesson] });
  const report = sessionId => ingestHostReport({ report: { type: 'session', sessionId }, lessonId: lesson.id, tutorId: 'P-TEST-T01', now: START, store });
  assert.equal((await report('oiFKKKL/RyGdm9W1r1Ll6w==')).status, 200);
  assert.equal((await report('oiFKKKL/RyGdm9W1r1Ll6w==')).body.duplicates, 1);
  const [kept] = store.events();
  assert.deepEqual({ type: kept.type, source: kept.source, reportedSessionId: kept.reportedSessionId, participantId: kept.participantId }, { type: 'host.session', source: 'host_sdk', reportedSessionId: 'oiFKKKL/RyGdm9W1r1Ll6w==', participantId: 'P-TEST-T01' });
  assert.equal('providerSessionId' in kept, false, 'nothing acts on it until the vendor confirms it');
  for (const bad of ['', 'has space', 'x'.repeat(101), '<script>', null]) assert.equal((await report(bad)).status, 400, String(bad));
  assert.equal(store.events().length, 1);
});

test('the overview raises a reported session the vendor refused', () => {
  const rejected = { source: 'server', type: 'server.session_rejected', lessonId: lesson.id, reportedSessionId: 's-x', reason: 'MISMATCH', occurredAt: START, receivedAt: START, key: 'r' };
  const state = deriveLesson(lesson, [rejected], START + MIN);
  assert.deepEqual(state.anomalies.filter(entry => entry.code === 'SESSION_REJECTED').map(entry => entry.severity), ['error']);
  assert.equal(lessonCard(state, START + MIN).anomalies.find(entry => entry.code === 'SESSION_REJECTED').label, '小老師頁回報的視訊 session 無法確認屬於這堂課（不會使用）');
});

// --- P-2 and P-3: what an API answer becomes ------------------------------------------------------

test('an answer about several sessions gives one recording fact per session, earliest first, so parts keep recording order', () => {
  const facts = normalizeApiSnapshot({
    lessonId: lesson.id, providerSessionId: 's-3', details: { start_time: iso(START + 40 * MIN) }, users: [], observedAt: START + 90 * MIN, provider: 'synthetic',
    recordings: [video('f-3', 41, 59)],
    sessions: [{ providerSessionId: 's-1', recordings: [video('f-1', 1, 19)] }, { providerSessionId: 's-2', recordings: [video('f-2a', 21, 29), video('f-2b', 30, 39)] }],
  });
  assert.deepEqual(recordingFacts(facts).map(fact => [fact.providerSessionId, fact.files.map(file => file.providerFileId)]), [['s-1', ['f-1']], ['s-2', ['f-2a', 'f-2b']], ['s-3', ['f-3']]]);
  // Each with the key a webhook for that session would have had: a later webhook is stored once.
  assert.deepEqual(recordingFacts(facts).map(fact => fact.key), ['session.recording_completed:s-1:f-1', 'session.recording_completed:s-2:f-2a,f-2b', 'session.recording_completed:s-3:f-3']);
});

test('without the session\'s details only its recordings are reported: no presence, no session start or end', () => {
  const facts = normalizeApiSnapshot({
    lessonId: lesson.id, providerSessionId: 's-1', details: null, observedAt: START + 90 * MIN, provider: 'synthetic',
    users: [{ user_key: 'P-TEST-T01', join_time: iso(START) }], recordings: [video('f-1', 1, 59)],
  });
  assert.deepEqual(facts.map(fact => fact.type), ['session.recording_completed']);
});

test('a side file that never finishes holds the lesson video back only for a while; an unfinished video is never reported', () => {
  const at = minutes => normalizeApiSnapshot({ lessonId: lesson.id, providerSessionId: 's-1', details: {}, observedAt: START + minutes * MIN, provider: 'synthetic', recordings: [video('f-1', 1, 59), timeline('t-1', 'processing')] });
  const files = minutes => recordingFacts(at(minutes)).flatMap(fact => fact.files.map(file => file.providerFileId));
  assert.deepEqual(files(59 + SIDE_FILE_GRACE_MS / MIN - 1), [], 'still waiting for the side file');
  assert.deepEqual(files(59 + SIDE_FILE_GRACE_MS / MIN), ['f-1'], 'the video alone, once it ended long enough ago');
  // Every file done: reported at once, side files included (they are skipped, not filed).
  const done = normalizeApiSnapshot({ lessonId: lesson.id, providerSessionId: 's-1', details: {}, observedAt: START + 60 * MIN, provider: 'synthetic', recordings: [video('f-1', 1, 59), timeline('t-1', 'completed')] });
  assert.deepEqual(recordingFacts(done).flatMap(fact => fact.files.map(file => [file.providerFileId, file.kind])), [['f-1', 'composite'], ['t-1', 'other']]);
  // A lesson video still processing: never, however long after.
  const processing = normalizeApiSnapshot({ lessonId: lesson.id, providerSessionId: 's-1', details: {}, observedAt: START + 600 * MIN, provider: 'synthetic', recordings: [video('f-1', 1, 59, 'processing'), timeline('t-1', 'completed')] });
  assert.deepEqual(recordingFacts(processing), []);
  // Two videos, one still processing: neither is reported early.
  const half = normalizeApiSnapshot({ lessonId: lesson.id, providerSessionId: 's-1', details: {}, observedAt: START + 600 * MIN, provider: 'synthetic', recordings: [video('f-1', 1, 29), video('f-2', 30, 59, 'processing')] });
  assert.deepEqual(recordingFacts(half), []);
});

test('the same session reported early (video only) and later (all files) is filed once: the later fact only adds the side file', async () => {
  const store = createClassroomStore({ lessons: [lesson] });
  await store.transaction(tx => storeEvent(tx, { source: 'server', type: 'server.recording_eligibility', lessonId: lesson.id, occurredAt: START - 15 * MIN, receivedAt: START - 15 * MIN, key: 'decide', eligible: true }));
  const snapshot = (minutes, side) => normalizeApiSnapshot({ lessonId: lesson.id, providerSessionId: 's-1', details: {}, observedAt: START + minutes * MIN, provider: 'synthetic', recordings: [video('f-1', 1, 59), timeline('t-1', side)] });
  for (const fact of recordingFacts([...snapshot(95, 'processing'), ...snapshot(120, 'completed')])) await store.transaction(tx => storeEvent(tx, fact));
  assert.deepEqual(store.fileRecords().map(record => [record.providerFileId, record.status]).sort(), [['f-1', 'PENDING'], ['t-1', 'SKIPPED']]);
  assert.deepEqual(store.jobs().map(job => job.id), ['file:f-1']);
});
