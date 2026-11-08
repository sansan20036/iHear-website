// Contract tests for the Recording Adapter (classroom/recording-adapter.mjs): every vendor's
// recording facts keep the one shape P1 relies on, vendors' recording types map to the neutral
// kinds, nothing that names a person or opens a file gets through, and a fact that breaks the
// contract is refused whole and the refusal recorded. The notices are synthetic, built from each
// vendor's documentation; passing says nothing about a vendor's real payloads.
import test from 'node:test';
import assert from 'node:assert/strict';
import { assertRecordingAdapter, FILED_KINDS, isVendor, neutralKind, RECORDING_KINDS, validateRecordingFact, VENDORS } from '../classroom/recording-adapter.mjs';
import { dedupeKeyOf, ingestFacts, isKeptRecording, normalizeApiSnapshot } from '../classroom/webhook-ingest.mjs';
import { deriveLesson, planActions } from '../classroom/lesson-state.mjs';
import { lessonCard } from '../classroom/live-dashboard.mjs';
import { createClassroomStore } from './fake-classroom-store.mjs';
import { createVendorBackend, lcicAdapter, syntheticAdapter, zoomAdapter } from './fake-recording-adapter.mjs';

const START = Date.parse('2026-11-03T02:00:00Z');
const MIN = 60_000;
const AT = START + 70 * MIN;
const ROOM = 345678;
const iso = value => new Date(value).toISOString();
// Planted where vendors put them; none may reach a fact.
const NAME = 'Synthetic Student Name';
const EMAIL = 'student@example.invalid';
const LINK = 'https://example.invalid/signed';
const TOKEN = 'synthetic-download-token-not-real';
const TOPIC = 'Synthetic Topic';
const PLANTED = [NAME, EMAIL, LINK, TOKEN, TOPIC];
const lesson = {
  id: 'L-TEST-001', code: 'TEST-L001', date: '2026-11-03', startsAt: iso(START), endsAt: iso(START + 60 * MIN),
  participants: [{ id: 'L-TEST-001-T01', code: 'TEST-T01', role: 'tutor' }, { id: 'L-TEST-001-S1', code: 'TEST-S01', role: 'student' }],
};

const zoomFile = (id, recordingType, size = 300) => ({
  id, recording_type: recordingType, file_extension: 'MP4', file_type: 'MP4', file_size: size, status: 'completed',
  recording_start: iso(START + MIN), recording_end: iso(START + 59 * MIN), download_url: `${LINK}/${id}`, play_url: `${LINK}/play/${id}`,
});
const zoomNotice = files => ({
  event: 'session.recording_completed', event_ts: AT, download_token: TOKEN,
  payload: { object: { id: 'SYN-SESSION-1', session_id: 'SYN-SESSION-1', session_key: lesson.id, session_name: TOPIC, host_email: EMAIL, user_name: NAME, recording_files: files } },
});
const lcicFinished = size => ({
  SdkAppId: 1400000000, Timestamp: Math.floor((START + 59 * MIN) / 1000), ExpireTime: Math.floor(AT / 1000), Sign: 'checked-by-the-route',
  EventType: 'RecordFinish', EventData: { RoomId: ROOM, Duration: 3480, RecordSize: size, RecordUrl: `${LINK}/lcic.mp4?sign=${TOKEN}` },
});
const syntheticNotice = files => ({ room: 'SYN-ROOM-1', lesson: lesson.id, finishedAt: iso(START + 59 * MIN), files });
const syntheticFile = (fileId, type = 'composite', bytes = 300) => ({
  fileId, type, format: 'MP4', bytes, from: iso(START + MIN), to: iso(START + 59 * MIN), state: 'ready', link: `${LINK}/${fileId}?token=${TOKEN}`, owner: { name: NAME, email: EMAIL },
});

async function factsFromEveryAdapter() {
  const backend = createVendorBackend();
  const rooms = new Map([[ROOM, { lessonId: lesson.id, users: {} }]]);
  return {
    zoom: zoomAdapter(backend).normalize(zoomNotice([zoomFile('SYN-Z-1', 'shared_screen_with_speaker_view'), zoomFile('SYN-Z-2', 'audio_only')]), { receivedAt: AT }),
    lcic: await lcicAdapter(backend, rooms).normalize(lcicFinished(300), { receivedAt: AT }),
    synthetic: syntheticAdapter(backend).normalize(syntheticNotice([syntheticFile('SYN-S-1'), syntheticFile('SYN-S-2', 'chat', 0)]), { receivedAt: AT }),
    // Reconciliation: the website asks the vendor's API and names the vendor.
    reconciled: normalizeApiSnapshot({
      lessonId: lesson.id, providerSessionId: 'SYN-SESSION-R', details: { start_time: iso(START), end_time: iso(START + 60 * MIN) },
      recordings: [zoomFile('SYN-R-1', 'shared_screen_with_speaker_view')], observedAt: AT, provider: 'synthetic',
    }).filter(fact => fact.type === 'session.recording_completed'),
  };
}

// --- One shape from every vendor -------------------------------------------------------------

test('Zoom, LCIC, a synthetic vendor and a reconciliation answer all give facts that keep the contract', async () => {
  const facts = await factsFromEveryAdapter();
  for (const [name, list] of Object.entries(facts)) {
    assert.equal(list.length, 1, `${name}: one fact`);
    assert.deepEqual(validateRecordingFact(list[0]), [], name);
    assert.equal(list[0].key, dedupeKeyOf(list[0]), `${name}: keyed by what it means`);
  }
  assert.deepEqual(Object.values(facts).map(list => list[0].provider), ['zoom-video-sdk', 'tencent-lcic', 'synthetic', 'synthetic']);
  // The lesson, the vendor session and, for each file, only its id, kind, extension, size, status and times.
  for (const list of Object.values(facts)) {
    assert.equal(list[0].lessonId, lesson.id);
    for (const file of list[0].files) assert.deepEqual(Object.keys(file).sort(), ['extension', 'kind', 'providerFileId', 'recordingEnd', 'recordingStart', 'size', 'status']);
  }
  assert.deepEqual(facts.lcic[0].files.map(file => [file.providerFileId, file.kind, file.extension, file.size]), [[`lcic-${ROOM}`, 'composite', 'mp4', 300]]);
});

test('each vendor names its recording types, and only the combined lesson video is filed', () => {
  assert.deepEqual(['shared_screen_with_speaker_view', 'audio_only', 'chat_file', 'audio_transcript', 'closed_caption', 'gallery_view'].map(type => neutralKind('zoom-video-sdk', type)),
    ['composite', 'audio', 'chat', 'transcript', 'transcript', 'other']);
  assert.equal(neutralKind('tencent-lcic', 'lcic_mixed'), 'composite');
  // A type means what its own vendor says: LCIC's name from Zoom, or any type from an unknown vendor, is 'other'.
  assert.equal(neutralKind('zoom-video-sdk', 'lcic_mixed'), 'other');
  assert.equal(neutralKind('agora', 'composite'), 'other');
  // Names every object has are not mappings.
  for (const type of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) assert.equal(neutralKind('zoom-video-sdk', type), 'other', type);
  for (const name of ['constructor', '__proto__', 'toString']) assert.equal(isVendor(name), false, name);
  assert.deepEqual(FILED_KINDS, ['composite']);
  for (const kind of RECORDING_KINDS) assert.equal(isKeptRecording({ kind, extension: 'mp4' }), kind === 'composite', kind);
  // P1's own rule still decides the formats: a lesson video in a format P1 does not file is skipped.
  assert.equal(isKeptRecording({ kind: 'composite', extension: 'webm' }), false);
});

test('the vendor registry maps only to neutral kinds, names each vendor\'s lesson video, and keeps file ids apart', () => {
  for (const [name, entry] of Object.entries(VENDORS)) {
    for (const kind of Object.values(entry.kinds)) assert.ok(RECORDING_KINDS.includes(kind), `${name}: ${kind}`);
    assert.ok(Object.values(entry.kinds).includes('composite'), `${name} says which recording is the lesson video`);
    assert.ok(Object.isFrozen(entry) && Object.isFrozen(entry.kinds), `${name} cannot be changed at run time`);
  }
  assert.ok(Object.isFrozen(VENDORS));
  const prefixes = Object.values(VENDORS).map(entry => entry.fileIdPrefix).filter(Boolean);
  for (const a of prefixes) for (const b of prefixes) if (a !== b) assert.ok(!a.startsWith(b), `${a} and ${b} overlap`);
});

// --- Privacy ---------------------------------------------------------------------------------

test('names, e-mail addresses, links and tokens never reach a fact, and a fact carrying one is refused by its path', async () => {
  const facts = Object.values(await factsFromEveryAdapter()).flat();
  const text = JSON.stringify(facts);
  for (const planted of PLANTED) assert.ok(!text.includes(planted), `${planted} reached a fact`);
  const [fact] = (await factsFromEveryAdapter()).synthetic;
  const withLink = { ...fact, files: [{ ...fact.files[0], download_url: `${LINK}/x` }] };
  assert.deepEqual(validateRecordingFact(withLink), ['fact.files[0].download_url: not allowed: names, links and tokens stay with the vendor']);
  const nested = { ...fact, extra: { host: { Email: EMAIL, display_name: NAME } }, token: TOKEN };
  assert.deepEqual(validateRecordingFact(nested), [
    'fact.extra.host.Email: not allowed: names, links and tokens stay with the vendor',
    'fact.extra.host.display_name: not allowed: names, links and tokens stay with the vendor',
    'fact.token: not allowed: names, links and tokens stay with the vendor',
  ]);
  // The problems name where, never what.
  for (const planted of PLANTED) assert.ok(!validateRecordingFact(nested).join(' ').includes(planted));
});

// --- What the contract refuses -----------------------------------------------------------------

test('each way a fact can break the contract is named by its path', async () => {
  const [good] = (await factsFromEveryAdapter()).synthetic;
  const withFile = changes => ({ ...good, files: [{ ...good.files[0], ...changes }] });
  const cases = [
    [{ ...good, type: 'session.ended' }, 'type'],
    [{ ...good, provider: 'Zoom' }, 'provider'],
    [{ ...good, provider: undefined }, 'provider'],
    [{ ...good, provider: 'agora' }, 'provider'],
    [{ ...good, lessonId: 'L 001; DROP' }, 'lessonId'],
    [{ ...good, providerSessionId: '' }, 'providerSessionId'],
    [{ ...good, files: [] }, 'files'],
    [withFile({ providerFileId: '' }), 'files[0].providerFileId'],
    [withFile({ providerFileId: 'x'.repeat(201) }), 'files[0].providerFileId'],
    [withFile({ kind: 'shared_screen_with_speaker_view' }), 'files[0].kind'],
    [withFile({ extension: 'MP4' }), 'files[0].extension'],
    [withFile({ extension: 'mpeg4x' }), 'files[0].extension'],
    [withFile({ size: -1 }), 'files[0].size'],
    [withFile({ size: 1.5 }), 'files[0].size'],
    [withFile({ size: '300' }), 'files[0].size'],
    // A lesson video of unknown size: P1 could not verify its copy.
    [withFile({ size: 0 }), 'files[0].size'],
    [withFile({ recordingStart: 'yesterday' }), 'files[0].recordingStart'],
    [withFile({ recordingStart: START + 60 * MIN, recordingEnd: START }), 'files[0]'],
  ];
  for (const [fact, path] of cases) {
    const problems = validateRecordingFact(fact);
    assert.equal(problems.length, 1, `${path}: ${problems.join(' | ')}`);
    assert.ok(problems[0].startsWith(`${path}: `), problems[0]);
  }
  // Only a lesson video needs its size: a chat file may be empty.
  assert.deepEqual(validateRecordingFact(withFile({ kind: 'chat', size: 0, extension: 'txt' })), []);
  // A vendor after the first namespaces its ids: LCIC's are lcic-<RoomId>.
  const [lcic] = (await factsFromEveryAdapter()).lcic;
  assert.deepEqual(validateRecordingFact({ ...lcic, files: [{ ...lcic.files[0], providerFileId: String(ROOM) }] }), ['files[0].providerFileId: tencent-lcic file ids start with lcic-']);
});

test('LCIC\'s callback without a size is refused rather than filed unverifiable', async () => {
  const rooms = new Map([[ROOM, { lessonId: lesson.id, users: {} }]]);
  const [fact] = await lcicAdapter(createVendorBackend(), rooms).normalize(lcicFinished(undefined), { receivedAt: AT });
  assert.deepEqual(validateRecordingFact(fact), ['files[0].size: a lesson video needs its size in bytes, or its copy cannot be verified']);
});

test('a batch holding a fact that breaks the contract is refused whole; the refusal is recorded once, without the files', async () => {
  const store = createClassroomStore({ lessons: [lesson] });
  const [good] = (await factsFromEveryAdapter()).synthetic;
  const started = { source: 'synthetic_notice', type: 'session.started', lessonId: lesson.id, providerSessionId: 'SYN-ROOM-1', occurredAt: START, receivedAt: START };
  started.key = dedupeKeyOf(started);
  const bad = { ...good, files: [{ ...good.files[0], size: 0 }] };
  bad.key = dedupeKeyOf(bad);
  const answer = await ingestFacts({ store, facts: [started, bad] });
  assert.equal(answer.status, 422);
  assert.deepEqual(answer.body.problems, ['files[0].size: a lesson video needs its size in bytes, or its copy cannot be verified']);
  // Not even the batch's valid fact is stored: only the refusal.
  assert.deepEqual(store.events().map(event => event.type), ['server.recording_refused']);
  assert.deepEqual([store.fileRecords(), store.jobs()], [[], []]);
  const [refusal] = store.events();
  assert.deepEqual({ lessonId: refusal.lessonId, provider: refusal.provider, providerSessionId: refusal.providerSessionId, problems: refusal.problems, source: refusal.source, occurredAt: refusal.occurredAt },
    { lessonId: lesson.id, provider: 'synthetic', providerSessionId: 'SYN-ROOM-1', problems: answer.body.problems, source: 'server', occurredAt: AT });
  assert.equal('files' in refusal, false);
  // Delivered again: refused again, recorded once.
  assert.equal((await ingestFacts({ store, facts: [bad] })).status, 422);
  assert.equal(store.events().length, 1);
  // A refusal for a lesson id that is not one is kept without it.
  const stray = { ...bad, lessonId: 'not a lesson id!', providerSessionId: 'SYN-ROOM-2' };
  stray.key = dedupeKeyOf(stray);
  assert.equal((await ingestFacts({ store, facts: [stray] })).status, 422);
  assert.equal(store.events().find(event => event.key === `server.recording_refused:${stray.key}`).lessonId, null);
  // The valid fact on its own is taken.
  assert.equal((await ingestFacts({ store, facts: [started] })).status, 200);
  // If even the refusal cannot be written, the answer is still 422 and nothing is half-written.
  const failing = createClassroomStore({ lessons: [lesson] });
  failing.faults.failTransactions = 1;
  assert.equal((await ingestFacts({ store: failing, facts: [bad] })).status, 422);
  assert.deepEqual(failing.events(), []);
});

test('the overview raises a refused recording at once as an error, and an administrator is notified', () => {
  const refusal = { source: 'server', type: 'server.recording_refused', lessonId: lesson.id, providerSessionId: 'SYN-ROOM-1', provider: 'synthetic', problems: ['files[0].size: …'], occurredAt: AT, receivedAt: AT, key: 'server.recording_refused:x' };
  const state = deriveLesson(lesson, [refusal], AT + MIN);
  assert.deepEqual(state.anomalies.filter(entry => entry.code === 'RECORDING_REFUSED').map(entry => [entry.severity, entry.since]), [['error', AT]]);
  assert.equal(lessonCard(state, AT + MIN).anomalies.find(entry => entry.code === 'RECORDING_REFUSED').label, '錄影通知格式不符，未交給歸檔（需管理員處理）');
  assert.ok(planActions(lesson, [refusal], AT + MIN).some(action => action.type === 'NOTIFY_ADMIN' && action.code === 'RECORDING_REFUSED'));
});

// --- Adapters --------------------------------------------------------------------------------

test('the three adapters have everything P1 calls; a partial or unregistered one is named precisely', () => {
  const backend = createVendorBackend();
  for (const adapter of [zoomAdapter(backend), lcicAdapter(backend, new Map()), syntheticAdapter(backend)]) assert.deepEqual(assertRecordingAdapter(adapter), [], adapter.provider);
  assert.deepEqual(assertRecordingAdapter({ provider: 'synthetic', normalize() {} }), ['download: must be a function', 'deleteVendorCopy: must be a function']);
  assert.deepEqual(assertRecordingAdapter({ provider: 'agora', normalize() {}, download() {}, deleteVendorCopy() {} }), ['provider: one of the registered vendors (zoom-video-sdk, tencent-lcic, synthetic)']);
  assert.equal(assertRecordingAdapter(null).length, 4);
});

// --- Known limits, kept visible ------------------------------------------------------------------

test('known limit: LCIC\'s reconciliation answer has no size or status yet, so it yields no recording fact', () => {
  // What lib/classroom-vendors/tencent-lcic.ts snapshot() returns today for a finished class.
  const facts = normalizeApiSnapshot({ lessonId: lesson.id, providerSessionId: `lcic-${ROOM}`, details: {}, recordings: [{ id: `lcic-${ROOM}`, recording_type: 'lcic_mixed' }], observedAt: AT, provider: 'tencent-lcic' });
  assert.deepEqual(facts.filter(fact => fact.type === 'session.recording_completed'), []);
});
