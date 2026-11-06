// The guarantees the shared classroom logic relies on, checked against any classroom store:
// all-or-nothing transactions, events stored once by key, jobs claimed under a lease with
// fencing, filing finished in one fenced write, and anomaly records that ask for fresh
// attention when a problem comes back. Synthetic data only.
import { createHash } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { ClassroomLessonConflictError } from '../../lib/classroom-store';

const OWNER = 'owner@example.test';
const hashOf = value => createHash('sha256').update(value).digest('hex');
const T = Date.parse('2026-11-20T09:00:00Z');

export function contractLesson(id, code, startsAt = '2026-11-20T08:00:00.000Z') {
  return {
    id, code, date: '2026-11-20', startsAt, endsAt: new Date(Date.parse(startsAt) + 3600_000).toISOString(), cancelled: false,
    createdBy: OWNER, createdAt: '2026-11-19T00:00:00.000Z',
    participants: [
      { id: `${id}-T`, code: `${code}-T`, role: 'tutor', staffEmail: 'tutor@example.test', joinKeyHash: null },
      { id: `${id}-S`, code: `${code}-S`, role: 'student', staffEmail: null, joinKeyHash: hashOf(`${id}-link`) },
    ],
  };
}

// Claims every due job so the next check starts from an empty queue.
async function drain(store, now) {
  for (let claimed = await store.claimJob({ workerId: 'drain', now, leaseMs: 60_000 }); claimed; claimed = await store.claimJob({ workerId: 'drain', now, leaseMs: 60_000 })) {
    await store.completeJob({ jobId: claimed.job.id, leaseVersion: claimed.leaseVersion });
  }
}

export function classroomStoreContract(name, getStore) {
  const A = 'L-contract-a';
  const event = (key, type, extra = {}) => ({ key, type, source: 'zoom_webhook', lessonId: A, occurredAt: 1000, receivedAt: 1000, ...extra });

  describe(`${name}: the classroom store contract`, () => {
    test('lessons keep codes, the tutor sign-in and only the hash of the student link; codes are unique', async () => {
      const store = getStore();
      const lesson = contractLesson(A, 'TEST-CA');
      await store.createLesson(lesson);
      expect(await store.lesson(A)).toEqual(lesson);
      await expect(store.createLesson({ ...contractLesson('L-contract-dup', 'TEST-CA'), code: 'TEST-CA' })).rejects.toBeInstanceOf(ClassroomLessonConflictError);
      expect(await store.lesson('L-contract-dup')).toBeNull();
      const during = await store.listLessons({ from: Date.parse('2026-11-20T08:30:00Z'), to: Date.parse('2026-11-20T08:31:00Z') });
      expect(during.map(entry => entry.id)).toContain(A);
      const nextDay = await store.listLessons({ from: Date.parse('2026-11-21T00:00:00Z'), to: Date.parse('2026-11-21T01:00:00Z') });
      expect(nextDay.map(entry => entry.id)).not.toContain(A);
    });

    test('a lesson can be cancelled and its student key hash replaced; only an existing student row changes', async () => {
      const store = getStore();
      const B = 'L-contract-access';
      await store.createLesson(contractLesson(B, 'TEST-CX'));
      expect(await store.setLessonCancelled(B)).toBe(true);
      expect((await store.lesson(B)).cancelled).toBe(true);
      expect(await store.setLessonCancelled('L-contract-missing')).toBe(false);
      const fresh = hashOf(`${B}-new-link`);
      expect(await store.replaceStudentKeyHash(B, `${B}-S`, fresh)).toBe(true);
      expect((await store.lesson(B)).participants.find(entry => entry.role === 'student').joinKeyHash).toBe(fresh);
      // The tutor signs in and has no key; a tutor row never takes one.
      expect(await store.replaceStudentKeyHash(B, `${B}-T`, hashOf('x'))).toBe(false);
      expect((await store.lesson(B)).participants.find(entry => entry.role === 'tutor').joinKeyHash).toBeNull();
      expect(await store.replaceStudentKeyHash('L-contract-missing', `${B}-S`, fresh)).toBe(false);
    });

    test("a tutor's lessons are found by the sign-in email within a time window; a student row never matches", async () => {
      const store = getStore();
      const C = 'L-contract-mine';
      const lesson = contractLesson(C, 'TEST-CM', '2026-11-25T08:00:00.000Z');
      lesson.participants[0].staffEmail = 'mine@example.test';
      await store.createLesson(lesson);
      const day = { from: Date.parse('2026-11-25T00:00:00Z'), to: Date.parse('2026-11-26T00:00:00Z') };
      expect((await store.listLessonsForStaff('mine@example.test', day)).map(entry => entry.id)).toEqual([C]);
      expect(await store.listLessonsForStaff('tutor@example.test', day)).toEqual([]);
      expect(await store.listLessonsForStaff('mine@example.test', { from: Date.parse('2026-11-26T00:00:00Z'), to: Date.parse('2026-11-27T00:00:00Z') })).toEqual([]);
      expect(await store.listLessonsForStaff('', day)).toEqual([]);
    });

    test('a transaction is all or nothing', async () => {
      const store = getStore();
      await expect(store.transaction(async tx => {
        await tx.insertEvent(event('contract:rolled-back', 'session.started'));
        throw new Error('synthetic failure');
      })).rejects.toThrow('synthetic failure');
      expect((await store.eventsFor([A])).map(entry => entry.key)).not.toContain('contract:rolled-back');
    });

    test('an event key is stored once, and the heartbeat row only moves forward', async () => {
      const store = getStore();
      const joined = event('contract:joined', 'session.user_joined', { participantId: `${A}-T` });
      expect(await store.transaction(tx => tx.insertEvent(joined))).toBe(true);
      expect(await store.transaction(tx => tx.insertEvent({ ...joined, occurredAt: 999 }))).toBe(false);
      const beat = { key: 'contract:heartbeat', type: 'host.heartbeat', source: 'host_sdk', lessonId: A, occurredAt: 2000, receivedAt: 2000 };
      expect(await store.transaction(tx => tx.keepLatest(beat))).toBe(true);
      expect(await store.transaction(tx => tx.keepLatest({ ...beat, occurredAt: 1500 }))).toBe(false);
      expect(await store.transaction(tx => tx.keepLatest({ ...beat, occurredAt: 2500 }))).toBe(true);
      const events = await store.eventsFor([A]);
      expect(events.filter(entry => entry.key === 'contract:joined').map(entry => entry.occurredAt)).toEqual([1000]);
      expect(events.filter(entry => entry.key === 'contract:heartbeat').map(entry => entry.occurredAt)).toEqual([2500]);
    });

    test('lookups the filing rules use: the latest recording decision, the first withdrawal, the first unknown person', async () => {
      const store = getStore();
      await store.transaction(async tx => {
        await tx.insertEvent({ ...event('contract:decision-1', 'server.recording_eligibility', { eligible: false }), source: 'server', occurredAt: 7000 });
        await tx.insertEvent({ ...event('contract:decision-2', 'server.recording_eligibility', { eligible: true }), source: 'server', occurredAt: 8000 });
        await tx.insertEvent({ ...event('contract:withdrawn-2', 'server.consent_withdrawn', { participantId: `${A}-S` }), source: 'server', occurredAt: 9000 });
        await tx.insertEvent({ ...event('contract:withdrawn-1', 'server.consent_withdrawn', { participantId: `${A}-S` }), source: 'server', occurredAt: 5000 });
        await tx.insertEvent(event('contract:stranger', 'session.user_joined', { participantId: 'P-stranger', occurredAt: 6000 }));
      });
      expect(await store.transaction(tx => tx.eligibility(A))).toMatchObject({ eligible: true, occurredAt: 8000 });
      expect(await store.withdrawalAt(A)).toBe(5000);
      expect(await store.transaction(tx => tx.withdrawalAt(A))).toBe(5000);
      expect(await store.unknownJoinAt(A)).toBe(6000);
    });

    test('consent, the tutor notice and issued tokens are kept by code and hash', async () => {
      const store = getStore();
      const consent = { personCode: 'TEST-CA-S', status: 'granted', version: 'synthetic-2026-11', grantedAt: 1000, withdrawnAt: null, expiresAt: null, synthetic: true, recordedBy: OWNER };
      await store.setConsent(consent);
      await store.setConsent({ ...consent, status: 'withdrawn', withdrawnAt: 2000 });
      expect(await store.listConsents(['TEST-CA-S', 'TEST-NONE'])).toEqual([{ ...consent, status: 'withdrawn', withdrawnAt: 2000 }]);
      const notice = { personCode: 'TEST-CA-T', version: 'synthetic-2026-11', acknowledgedAt: 3000, recordedBy: OWNER };
      await store.setStaffNotice(notice);
      expect(await store.listStaffNotices(['TEST-CA-T'])).toEqual([notice]);
      const token = { tokenHash: hashOf('synthetic-token'), lessonId: A, participantId: `${A}-S`, issuedAt: 4000, expiresAt: 4000 + 1800_000 };
      await store.recordJoinToken(token);
      await store.recordJoinToken(token);
      expect(await store.listJoinTokens(A)).toEqual([token]);
    });

    test('a job is leased; a worker whose lease ran out can neither record its upload nor finish the filing', async () => {
      const store = getStore();
      await drain(store, T);
      await store.transaction(async tx => {
        expect(await tx.insertFileRecord({ providerFileId: 'SYN-C-F1', lessonId: A, status: 'PENDING', provider: 'synthetic', extension: 'mp4', size: 10 })).toBe(true);
        expect(await tx.insertFileRecord({ providerFileId: 'SYN-C-F1', lessonId: A, status: 'PENDING', provider: 'synthetic' })).toBe(false);
        expect(await tx.insertJob({ id: 'file:SYN-C-F1', type: 'file_recording', lessonId: A, providerFileId: 'SYN-C-F1' })).toBe(true);
        expect(await tx.insertJob({ id: 'file:SYN-C-F1', type: 'file_recording', lessonId: A, providerFileId: 'SYN-C-F1' })).toBe(false);
      });
      const a = await store.claimJob({ workerId: 'worker-a', now: T, leaseMs: 60_000 });
      expect(a).toMatchObject({ leaseVersion: 1, job: { id: 'file:SYN-C-F1', status: 'running', attempts: 1 } });
      expect(await store.claimJob({ workerId: 'worker-b', now: T + 1000, leaseMs: 60_000 })).toBeNull();
      const b = await store.claimJob({ workerId: 'worker-b', now: T + 61_000, leaseMs: 60_000 });
      expect(b).toMatchObject({ leaseVersion: 2, job: { id: 'file:SYN-C-F1' } });
      const transfer = (job, leaseVersion, uri) => store.recordTransfer({ jobId: job.id, leaseVersion, providerFileId: 'SYN-C-F1', uri, uploadedBytes: 0, now: T + 62_000, leaseMs: 60_000 });
      expect(await transfer(a.job, 1, 'local-upload://stale')).toBe(false);
      expect(await transfer(b.job, 2, 'local-upload://current')).toBe(true);
      const finish = (leaseVersion, driveFileId) => store.finishFiling({
        jobId: 'file:SYN-C-F1', leaseVersion, providerFileId: 'SYN-C-F1',
        changes: { status: 'STORED', driveFileId, filedAt: T + 70_000 },
        events: [{ key: `contract:filed:${leaseVersion}`, type: 'p1.filing', source: 'p1', lessonId: A, occurredAt: T + 70_000, status: 'STORED' }],
        jobs: [{ id: `delete-vendor:SYN-C-F1:${leaseVersion}`, type: 'delete_vendor_copy', lessonId: A, providerFileId: 'SYN-C-F1' }],
      });
      expect(await finish(1, 'drive-stale')).toBe(false);
      const unchanged = await store.fileRecord('SYN-C-F1');
      expect(unchanged).toMatchObject({ status: 'PENDING', uploadSessionUri: 'local-upload://current' });
      expect(unchanged.driveFileId ?? null).toBeNull();
      expect((await store.eventsFor([A])).map(entry => entry.key)).not.toContain('contract:filed:1');
      expect(await finish(2, 'drive-current')).toBe(true);
      expect(await store.fileRecord('SYN-C-F1')).toMatchObject({ status: 'STORED', driveFileId: 'drive-current', filedAt: T + 70_000 });
      expect((await store.eventsFor([A])).map(entry => entry.key)).toContain('contract:filed:2');
      expect(await finish(2, 'drive-again')).toBe(false);
      expect(await store.fileRecord('SYN-C-F1')).toMatchObject({ driveFileId: 'drive-current' });
      // The follow-up job came with the filing, and the finished job is never handed out again.
      const next = await store.claimJob({ workerId: 'worker-c', now: T + 80_000, leaseMs: 60_000 });
      expect(next.job).toMatchObject({ id: 'delete-vendor:SYN-C-F1:2', type: 'delete_vendor_copy', providerFileId: 'SYN-C-F1' });
      expect(await store.completeJob({ jobId: next.job.id, leaseVersion: next.leaseVersion })).toBe(true);
      expect(await store.claimJob({ workerId: 'worker-c', now: T + 10 * 60_000, leaseMs: 60_000 })).toBeNull();
    });

    test('a failing job backs off, then gives up after the last attempt and marks its file', async () => {
      const store = getStore();
      await drain(store, T + 3600_000);
      await store.transaction(async tx => {
        await tx.insertFileRecord({ providerFileId: 'SYN-C-F2', lessonId: A, status: 'PENDING', provider: 'synthetic' });
        await tx.insertJob({ id: 'file:SYN-C-F2', type: 'file_recording', lessonId: A, providerFileId: 'SYN-C-F2', availableAt: T });
      });
      const now = T + 2 * 3600_000;
      const first = await store.claimJob({ workerId: 'w', now, leaseMs: 60_000 });
      expect(await store.failJob({ jobId: first.job.id, leaseVersion: first.leaseVersion, now, error: 'synthetic drive 503', maxAttempts: 2 })).toBe(true);
      expect(await store.claimJob({ workerId: 'w', now: now + 1000, leaseMs: 60_000 })).toBeNull();
      const second = await store.claimJob({ workerId: 'w', now: now + 31_000, leaseMs: 60_000 });
      expect(second).toMatchObject({ leaseVersion: 2, job: { attempts: 2 } });
      expect(await store.failJob({ jobId: first.job.id, leaseVersion: first.leaseVersion, now: now + 31_000, error: 'stale worker', maxAttempts: 2 })).toBe(false);
      const giveUp = { fileChanges: { status: 'FAILED' }, events: [{ key: 'contract:gave-up', type: 'p1.filing', source: 'p1', lessonId: A, occurredAt: now + 31_000, status: 'FAILED' }] };
      expect(await store.failJob({ jobId: second.job.id, leaseVersion: second.leaseVersion, now: now + 31_000, error: 'synthetic drive 503', maxAttempts: 2, giveUp })).toBe(true);
      expect(await store.fileRecord('SYN-C-F2')).toMatchObject({ status: 'FAILED' });
      expect((await store.eventsFor([A])).map(entry => entry.key)).toContain('contract:gave-up');
      expect(await store.claimJob({ workerId: 'w', now: now + 24 * 3600_000, leaseMs: 60_000 })).toBeNull();
    });

    test('a chunked transfer renews the lease, counts attempts from its last progress, and carries on or waits out a block without using attempts', async () => {
      const store = getStore();
      const now = T + 10 * 24 * 3600_000;
      await drain(store, now);
      await store.transaction(async tx => {
        await tx.insertFileRecord({ providerFileId: 'SYN-C-F3', lessonId: A, status: 'PENDING', provider: 'synthetic', extension: 'mp4', size: 300 });
        await tx.insertJob({ id: 'file:SYN-C-F3', type: 'file_recording', lessonId: A, providerFileId: 'SYN-C-F3', availableAt: now });
      });
      expect(await store.listOpenFilingLessonIds()).toContain(A);
      const claim = async at => store.claimJob({ workerId: 'w', now: at, leaseMs: 60_000 });
      const first = await claim(now);
      const transfer = (leaseVersion, uploadedBytes, at, events = []) => store.recordTransfer({ jobId: 'file:SYN-C-F3', leaseVersion, providerFileId: 'SYN-C-F3', uri: 'local-upload://f3', uploadedBytes, now: at, leaseMs: 60_000, events });
      // Each saved chunk renews the lease: the job is not handed out while the worker keeps going.
      expect(await transfer(first.leaseVersion, 100, now + 50_000)).toBe(true);
      expect(await claim(now + 70_000)).toBeNull();
      expect(await store.fileRecord('SYN-C-F3')).toMatchObject({ uploadSessionUri: 'local-upload://f3', uploadedBytes: 100 });
      // Out of time: back in the queue at once, the attempt not counted.
      expect(await store.rescheduleJob({ jobId: 'file:SYN-C-F3', leaseVersion: first.leaseVersion, availableAt: now + 80_000 })).toBe(true);
      const second = await claim(now + 80_000);
      expect(second.job).toMatchObject({ attempts: 1, blockedReason: null });
      // A full Drive: blocked with a reason, the attempt refunded, the event stored once.
      const blocked = { key: 'contract:blocked', type: 'p1.filing', source: 'p1', lessonId: A, occurredAt: now + 81_000, status: 'BLOCKED', reason: 'DRIVE_QUOTA' };
      const block = leaseVersion => store.rescheduleJob({ jobId: 'file:SYN-C-F3', leaseVersion, availableAt: now + 31 * 60_000, refundAttempt: true, blockedReason: 'DRIVE_QUOTA', error: 'DRIVE_QUOTA: synthetic', events: [blocked] });
      expect(await block(first.leaseVersion)).toBe(false);
      expect(await block(second.leaseVersion)).toBe(true);
      expect(await claim(now + 30 * 60_000)).toBeNull();
      const third = await claim(now + 31 * 60_000);
      expect(third.job).toMatchObject({ attempts: 1, blockedReason: 'DRIVE_QUOTA', error: 'DRIVE_QUOTA: synthetic' });
      expect((await store.eventsFor([A])).filter(entry => entry.key === 'contract:blocked')).toHaveLength(1);
      // Progress again: the block is cleared and the attempt count starts over.
      const resumed = { key: 'contract:resumed', type: 'p1.filing', source: 'p1', lessonId: A, occurredAt: now + 31 * 60_000, status: 'RESUMED' };
      expect(await transfer(third.leaseVersion, 200, now + 31 * 60_000, [resumed])).toBe(true);
      expect(await store.failJob({ jobId: 'file:SYN-C-F3', leaseVersion: third.leaseVersion, now: now + 32 * 60_000, error: 'RATE_LIMITED: synthetic', maxAttempts: 1, retryAfterMs: 10 * 60_000 })).toBe(true);
      // Not given up (the count was reset), and not retried before Retry-After.
      expect(await claim(now + 41 * 60_000)).toBeNull();
      const fourth = await claim(now + 42 * 60_000);
      expect(fourth.job).toMatchObject({ id: 'file:SYN-C-F3', attempts: 1, blockedReason: null });
      expect((await store.eventsFor([A])).map(entry => entry.key)).toContain('contract:resumed');
      // Blocked or running, the lesson counts as still filing until the job is done.
      expect(await store.listOpenFilingLessonIds()).toContain(A);
      await store.completeJob({ jobId: fourth.job.id, leaseVersion: fourth.leaseVersion });
      expect(await store.listOpenFilingLessonIds()).not.toContain(A);
    });

    test('simultaneous claims never hand out the same job twice', async () => {
      const store = getStore();
      const now = T + 30 * 24 * 3600_000;
      await drain(store, now);
      await store.transaction(async tx => {
        for (const id of ['race-1', 'race-2', 'race-3']) await tx.insertJob({ id: `delete-vendor:${id}`, type: 'delete_vendor_copy', lessonId: A, providerFileId: id, availableAt: now });
      });
      const claims = await Promise.all(Array.from({ length: 6 }, (_, index) => store.claimJob({ workerId: `worker-${index}`, now, leaseMs: 60_000 })));
      const ids = claims.filter(Boolean).map(claim => claim.job.id);
      expect(ids.sort()).toEqual(['delete-vendor:race-1', 'delete-vendor:race-2', 'delete-vendor:race-3']);
      for (const claim of claims.filter(Boolean)) await store.completeJob({ jobId: claim.job.id, leaseVersion: claim.leaseVersion });
    });

    test('a problem that comes back, or a warning that becomes an error, needs handling again; the earlier note stays', async () => {
      const store = getStore();
      const record = async () => (await store.listAnomalies([A])).find(entry => entry.code === 'HOST_SIGNAL_LOST');
      await store.syncAnomalies(A, [{ code: 'HOST_SIGNAL_LOST', severity: 'warning' }, { code: 'STALE_DATA', severity: 'warning' }], 1000);
      await store.acknowledgeAnomaly({ lessonId: A, code: 'HOST_SIGNAL_LOST', actor: OWNER, note: 'TEST: called the tutor', now: 2000 });
      await store.syncAnomalies(A, [{ code: 'HOST_SIGNAL_LOST', severity: 'warning' }], 3000);
      expect(await record()).toMatchObject({ firstSeenAt: 1000, openedAt: 1000, lastSeenAt: 3000, resolvedAt: null, acknowledgedAt: 2000 });
      expect((await store.listAnomalies([A])).find(entry => entry.code === 'STALE_DATA')).toMatchObject({ resolvedAt: 3000 });
      await store.syncAnomalies(A, [], 4000);
      expect(await record()).toMatchObject({ resolvedAt: 4000 });
      await store.syncAnomalies(A, [{ code: 'HOST_SIGNAL_LOST', severity: 'warning' }], 5000);
      expect(await record()).toMatchObject({ firstSeenAt: 1000, openedAt: 5000, resolvedAt: null, acknowledgedBy: OWNER, acknowledgedAt: 2000, note: 'TEST: called the tutor' });
      await store.acknowledgeAnomaly({ lessonId: A, code: 'HOST_SIGNAL_LOST', actor: OWNER, note: 'TEST: tutor back online', now: 6000 });
      await store.syncAnomalies(A, [{ code: 'HOST_SIGNAL_LOST', severity: 'error' }], 7000);
      expect(await record()).toMatchObject({ severity: 'error', openedAt: 7000, acknowledgedAt: 6000 });
      await store.syncAnomalies(A, [{ code: 'HOST_SIGNAL_LOST', severity: 'warning' }], 8000);
      expect(await record()).toMatchObject({ severity: 'error', openedAt: 7000, lastSeenAt: 8000 });
      expect(await store.acknowledgeAnomaly({ lessonId: A, code: 'NOT_RECORDED', actor: OWNER, note: 'x', now: 9000 })).toBeNull();
    });
  });
}
