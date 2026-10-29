// Synthetic tests for Tencent LCIC's callbacks joining the same intake and P1 filing as Zoom's
// notices. Nothing here reaches Tencent: the deliveries are built by hand from LCIC's callback
// reference, and the database and Drive are the in-memory fakes. Passing shows LCIC's events can
// feed the existing pipeline; it says nothing about LCIC's real payloads or timing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { minimizeLcicCallback } from '../classroom/lcic-callback.mjs';
import { fileRecording, ingestFacts, processJobs, storeEvent } from '../classroom/webhook-ingest.mjs';
import { createClassroomStore, createDrive, syntheticDownload } from './fake-classroom-store.mjs';

const START = Date.parse('2026-11-03T02:00:00Z');
const MIN = 60_000;
const ROOT = 'root:[測試] iHear 錄影存放區';
const iso = value => new Date(value).toISOString();
const lesson = {
  id: 'L-TEST-LCIC', code: 'TEST-LC1', date: '2026-11-03', startsAt: iso(START), endsAt: iso(START + 60 * MIN),
  participants: [{ id: 'P-TEST-T01', code: 'TEST-T01', role: 'tutor' }, { id: 'P-TEST-S01', code: 'TEST-S01', role: 'student' }],
};
const ROOM = 345678;
const users = { 'P-TEST-T01': 'lcic-user-tutor', 'P-TEST-S01': 'lcic-user-student' };
const lookup = async roomId => (roomId === ROOM ? { lessonId: lesson.id, users } : null);
const callback = (EventType, EventData, at) => ({ SdkAppId: 1400000000, Timestamp: Math.floor(at / 1000), ExpireTime: Math.floor(at / 1000) + 300, Sign: 'checked-by-the-route', EventType, EventData });
const finished = at => callback('RecordFinish', { RoomId: ROOM, Duration: 3540, RecordSize: 96, RecordUrl: 'https://example.invalid/synthetic/recording.mp4?sign=synthetic-not-real' }, at);

async function setup({ eligible = true } = {}) {
  const store = createClassroomStore({ lessons: [lesson] });
  await store.transaction(tx => storeEvent(tx, { source: 'server', type: 'server.recording_eligibility', lessonId: lesson.id, occurredAt: START - 15 * MIN, receivedAt: START - 15 * MIN, key: 'decide:L-TEST-LCIC', eligible }));
  return { store, drive: createDrive() };
}
const handlersFor = (store, drive) => ({
  file_recording: ({ job, leaseVersion, now }) => fileRecording({ store, drive, download: syntheticDownload, job, leaseVersion, now, rootFolderId: ROOT, options: { chunkBytes: 16 } }),
  delete_vendor_copy: ({ job, leaseVersion }) => ({ status: store.completeJob({ jobId: job.id, leaseVersion }) ? 'DONE' : 'LEASE_LOST' }),
});
const intake = async (store, body, now) => ingestFacts({ store, facts: await minimizeLcicCallback(body, { lookup, receivedAt: now }) });

test('room and member events become the same facts as Zoom notices, keyed by our lesson and participant', async () => {
  const [started] = await minimizeLcicCallback(callback('RoomStart', { RoomId: ROOM }, START), { lookup, receivedAt: START });
  assert.deepEqual({ type: started.type, lessonId: started.lessonId, providerSessionId: started.providerSessionId, source: started.source, occurredAt: started.occurredAt },
    { type: 'session.started', lessonId: lesson.id, providerSessionId: `lcic-${ROOM}`, source: 'lcic_callback', occurredAt: START });
  const [joined] = await minimizeLcicCallback(callback('MemberJoin', { RoomId: ROOM, UserId: 'lcic-user-student' }, START + MIN), { lookup, receivedAt: START + MIN });
  assert.equal(joined.type, 'session.user_joined');
  assert.equal(joined.participantId, 'P-TEST-S01');
  const [stranger] = await minimizeLcicCallback(callback('MemberJoin', { RoomId: ROOM, UserId: 'someone-else' }, START + 2 * MIN), { lookup, receivedAt: START + 2 * MIN });
  assert.equal(stranger.participantId, null);
  const [ended] = await minimizeLcicCallback(callback('RoomEnd', { RoomId: ROOM }, START + 60 * MIN), { lookup, receivedAt: START + 60 * MIN });
  assert.equal(ended.type, 'session.ended');
});

test('callbacks for rooms iHear did not create, and unknown events, are ignored', async () => {
  assert.deepEqual(await minimizeLcicCallback(callback('RoomStart', { RoomId: 1 }, START), { lookup, receivedAt: START }), []);
  assert.deepEqual(await minimizeLcicCallback(callback('DocumentCreate', { RoomId: ROOM }, START), { lookup, receivedAt: START }), []);
  assert.deepEqual(await minimizeLcicCallback({ EventType: 'RoomStart', EventData: {} }, { lookup, receivedAt: START }), []);
});

test('RecordFinish files the class recording through P1 once, and keeps no signed address', async () => {
  const { store, drive } = await setup();
  const first = await intake(store, finished(START + 62 * MIN), START + 62 * MIN);
  assert.equal(first.status, 200);
  assert.equal(first.body.stored, 1);
  const again = await intake(store, finished(START + 62 * MIN), START + 63 * MIN);
  assert.equal(again.body.duplicates, 1);
  const [record] = store.fileRecords();
  assert.equal(record.providerFileId, `lcic-${ROOM}`);
  await processJobs({ store, now: START + 71 * MIN, workerId: 'worker-1', handlers: handlersFor(store, drive) });
  assert.equal(store.fileRecord(`lcic-${ROOM}`).status, 'STORED');
  assert.equal(drive.activeFiles().filter(file => file.appProperties.providerFileId === `lcic-${ROOM}`).length, 1);
  const everything = JSON.stringify([store.events(), store.fileRecords(), store.jobs()]);
  assert.equal(everything.includes('synthetic-not-real'), false);
  assert.equal(everything.includes('example.invalid'), false);
});

test('without recording consent a finished LCIC recording is never filed', async () => {
  const { store, drive } = await setup({ eligible: false });
  await intake(store, finished(START + 62 * MIN), START + 62 * MIN);
  await processJobs({ store, now: START + 71 * MIN, workerId: 'worker-1', handlers: handlersFor(store, drive) });
  assert.notEqual(store.fileRecord(`lcic-${ROOM}`)?.status, 'STORED');
  assert.equal(drive.activeFiles().length, 0);
});
