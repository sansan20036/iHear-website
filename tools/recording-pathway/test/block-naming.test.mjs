import { test } from 'node:test';
import assert from 'node:assert/strict';

import { blockBaseName, blockFolderPath, FILE_NAME_SAFE, nameList, newYorkDate, recordingSnapshot } from '../classroom/block-naming.mjs';

// P3-Multi (2026-11-09; 18.3, 18.4 and the task book's section 9): Drive names for a block's rooms
// and each recording's participant snapshot. Synthetic names only.

test('the New York date of the scheduled start: EST and EDT, the day before Taipei, across a month and a year, and both DST changes', () => {
  const cases = [
    ['2026-12-01T08:00:00Z', '2026-12-01', 'Taipei 16:00 is New York 03:00 (EST), same day'],
    ['2026-07-01T08:00:00Z', '2026-07-01', 'Taipei 16:00 is New York 04:00 (EDT), same day'],
    ['2026-11-30T01:00:00Z', '2026-11-29', 'Taipei 09:00 is the evening before in New York'],
    ['2026-12-01T01:00:00Z', '2026-11-30', 'Taipei morning on the 1st: still November in New York'],
    ['2027-01-01T02:00:00Z', '2026-12-31', 'Taipei New Year morning: still last year in New York'],
    ['2026-03-08T06:59:00Z', '2026-03-08', 'just before clocks go forward (01:59 EST)'],
    ['2026-03-08T07:00:00Z', '2026-03-08', 'clocks go forward (03:00 EDT)'],
    ['2026-11-01T05:30:00Z', '2026-11-01', 'the repeated hour in November, first time (01:30 EDT)'],
    ['2026-11-01T06:30:00Z', '2026-11-01', 'the repeated hour in November, second time (01:30 EST)'],
    ['2026-11-01T04:30:00Z', '2026-11-01', 'New York 00:30 EDT'],
    ['2026-11-01T03:59:00Z', '2026-10-31', 'New York 23:59 EDT the day before'],
  ];
  for (const [at, expected, what] of cases) assert.equal(newYorkDate(at), expected, what);
  // Never Taipei minus a fixed 13 hours: in summer (EDT) New York is 12 hours behind Taipei.
  const taipeiMinus13 = new Date(Date.parse('2026-07-01T04:30:00Z') + (8 - 13) * 3600_000).toISOString().slice(0, 10);
  assert.equal(taipeiMinus13, '2026-06-30');
  assert.equal(newYorkDate('2026-07-01T04:30:00Z'), '2026-07-01');
});

test('section 9 names: Alice_Emily, Alice_Emily-Jason, Alice-Ben_Emily, Alice-Ben-Chloe_Emily-Jason; folders <students>/<tutors>', () => {
  const date = '2026-11-09';
  assert.equal(blockBaseName({ students: ['Alice'], tutors: ['Emily'], date }), 'Alice_Emily_2026-11-09');
  assert.equal(blockBaseName({ students: ['Alice'], tutors: ['Emily', 'Jason'], date }), 'Alice_Emily-Jason_2026-11-09');
  assert.equal(blockBaseName({ students: ['Alice', 'Ben'], tutors: ['Emily'], date }), 'Alice-Ben_Emily_2026-11-09');
  assert.equal(blockBaseName({ students: ['Alice', 'Ben', 'Chloe'], tutors: ['Emily', 'Jason'], date }), 'Alice-Ben-Chloe_Emily-Jason_2026-11-09');
  assert.deepEqual(blockFolderPath('Alice-Ben-Chloe_Emily-Jason_2026-11-09.mp4'), ['Alice-Ben-Chloe', 'Emily-Jason']);
  assert.deepEqual(blockFolderPath('Alice_Emily_2026-11-09_P02.mp4'), ['Alice', 'Emily']);
});

test('a name for files holds no - or _ (they join and separate the parts), nor path characters', () => {
  for (const name of ['Alice', 'Alice Wang', "O'Brien", 'J. R. Smith']) assert.ok(FILE_NAME_SAFE.test(name), name);
  for (const name of ['Mary-Jane', 'Ann_Lee', 'a/b', 'x\\y', '', ' Alice', '王小明', 'A'.repeat(61)]) assert.ok(!FILE_NAME_SAFE.test(name), name);
});

test('a list too long for a name keeps the first names, says how many more, and a fingerprint of the whole list: stable, and different groups never share it', () => {
  const ten = Array.from({ length: 10 }, (_, index) => `Student Number ${String.fromCharCode(65 + index)}`);
  const first = nameList(ten, 100);
  assert.ok(first.length <= 100, first);
  assert.match(first, /^Student Number A-Student Number B.*\+\d+~[0-9a-f]{6}$/);
  assert.ok(!first.includes('_'), 'never the part separator');
  assert.equal(nameList([...ten], 100), first, 'the same people give the same name');
  assert.notEqual(nameList([...ten.slice(0, 9), 'Student Number Z'], 100), first, 'one person different: another fingerprint');
  assert.equal(nameList([], 100), 'Unknown');
});

// A room with three students, a lead and a co-tutor, and an observer; facts in minutes from T.
const T = Date.parse('2026-12-01T08:00:00Z');
const MIN = 60_000;
const policy = { consentVersion: 'v1', staffNoticeVersion: 'n1' };
const block = {
  id: 'B-1', code: 'TEST-M1', lobbyId: 'L-0', members: [
    { id: 'M-a', code: 'S-A', role: 'student', englishName: 'Alice' },
    { id: 'M-b', code: 'S-B', role: 'student', englishName: 'Ben' },
    { id: 'M-c', code: 'S-C', role: 'student', englishName: 'Chloe' },
    { id: 'M-t', code: 'T-1', role: 'lead_tutor', englishName: 'Emily' },
    { id: 'M-u', code: 'T-2', role: 'co_tutor', englishName: 'Jason' },
    { id: 'M-o', code: 'O-1', role: 'observer', englishName: 'Olly' },
  ],
};
const row = (id, memberId, role, active = true) => ({ id, code: id, role, memberId, active, seat: 'assigned' });
const lesson = {
  id: 'L-1', code: 'TEST-M1-R1', roomLabel: 'R1', startsAt: '2026-12-01T08:00:00Z',
  participants: [row('P-a', 'M-a', 'student'), row('P-b', 'M-b', 'student', false), row('P-c', 'M-c', 'student'), row('P-t', 'M-t', 'tutor'), row('P-u', 'M-u', 'tutor'), row('P-o', 'M-o', 'observer')],
};
const fact = (type, participantId, minutes) => ({ type, lessonId: 'L-1', participantId, occurredAt: T + minutes * MIN, key: `${type}:${participantId}:${minutes}` });
const granted = code => ({ personCode: code, status: 'granted', version: 'v1', grantedAt: T - 60 * MIN, withdrawnAt: null, expiresAt: null });
const notice = code => ({ personCode: code, version: 'n1', acknowledgedAt: T - 60 * MIN });
const decision = { key: 'start:L-1:1:check:1', eligible: true, reason: 'ALL_CONSENTED', occurredAt: T + 9 * MIN, beforeStart: true };
const base = {
  lesson, block, decision, policy,
  consents: ['S-A', 'S-B', 'S-C'].map(granted), notices: ['T-1', 'T-2', 'O-1'].map(notice),
  record: { providerFileId: 'F-1', providerSessionId: 'ZS-1', recordingStart: T + 10 * MIN, recordingEnd: T + 50 * MIN, hold: null },
};

test('18.4: each person the recording covers, with their own ids, role, times, seat changes and consent or notice; who it does not cover is kept out of the name', () => {
  // Ben left before the recording; Chloe joins mid-way after a move from R2; Jason substitutes for
  // Emily from minute 30; the observer drops in at 20.
  const events = [
    fact('session.user_joined', 'P-a', 0), fact('session.user_joined', 'P-b', 0), fact('session.user_left', 'P-b', 5),
    fact('session.user_joined', 'P-t', 0), fact('session.user_left', 'P-t', 32), fact('session.user_joined', 'P-u', 30),
    fact('session.user_joined', 'P-o', 20), fact('session.user_left', 'P-o', 25), fact('session.user_joined', 'P-c', 31),
  ];
  const lobbyEvents = [{ type: 'server.seat_changed', memberId: 'M-c', code: 'S-C', seat: 'assigned', from: 'R2', to: 'R1', occurredAt: T + 29 * MIN, key: 'seat-c' }];
  const snapshot = recordingSnapshot({ ...base, events, lobbyEvents, generation: 0 });
  assert.deepEqual(snapshot.names, { students: ['Alice', 'Chloe'], tutors: ['Emily', 'Jason'] });
  const chloe = snapshot.people.find(entry => entry.code === 'S-C');
  assert.deepEqual([chloe.memberId, chloe.participantIds, chloe.role, chloe.roomRoles, chloe.covered, chloe.coveredFrom], ['M-c', ['P-c'], 'student', ['student'], true, T + 31 * MIN]);
  assert.deepEqual(chloe.seatChanges, [{ at: T + 29 * MIN, seat: 'assigned', from: 'R2', to: 'R1' }]);
  assert.deepEqual(chloe.evidence, { kind: 'consent', status: 'granted', version: 'v1', grantedAt: T - 60 * MIN, withdrawnAt: null, expiresAt: null });
  assert.equal(chloe.problem, null);
  const jason = snapshot.people.find(entry => entry.code === 'T-2');
  assert.deepEqual([jason.covered, jason.coveredFrom, jason.evidence.kind, jason.problem], [true, T + 30 * MIN, 'notice', null]);
  const olly = snapshot.people.find(entry => entry.code === 'O-1');
  assert.deepEqual([olly.covered, olly.joins, olly.leaves], [true, [T + 20 * MIN], [T + 25 * MIN]]);
  assert.equal(snapshot.people.find(entry => entry.code === 'S-B').covered, false);
  assert.deepEqual(snapshot.rosterChanges, [{ at: T + 29 * MIN, member: 'S-C', seat: 'assigned', from: 'R2', to: 'R1' }]);
  assert.deepEqual([snapshot.recordingId, snapshot.providerSessionId, snapshot.generation, snapshot.decision.key], ['F-1', 'ZS-1', 0, 'start:L-1:1:check:1']);
  assert.deepEqual(snapshot.filing, { eligible: true, problems: [], policy: { consentVersion: 'v1', staffNoticeVersion: 'n1' } });
});

test('18.4: one person without valid consent or notice for their part makes the recording ineligible, without hiding anyone else\'s evidence', () => {
  const events = [fact('session.user_joined', 'P-a', 0), fact('session.user_joined', 'P-t', 0), fact('session.user_joined', 'P-c', 20), fact('session.user_joined', 'P-o', 15)];
  const cases = [
    ['a student with no consent joins mid-way', { consents: ['S-A'].map(granted) }, [{ code: 'CONSENT_MISSING', member: 'S-C' }]],
    ['a student withdraws while covered', { consents: [granted('S-A'), { ...granted('S-C'), withdrawnAt: T + 40 * MIN }] }, [{ code: 'CONSENT_WITHDRAWN_DURING', member: 'S-C' }]],
    ['a consent expires while covered', { consents: [granted('S-A'), { ...granted('S-C'), expiresAt: T + 45 * MIN }] }, [{ code: 'CONSENT_EXPIRED_DURING', member: 'S-C' }]],
    ['an old consent version', { consents: [granted('S-A'), { ...granted('S-C'), version: 'v0' }] }, [{ code: 'CONSENT_VERSION_MISMATCH', member: 'S-C' }]],
    ['an observer without the notice drops in', { notices: ['T-1'].map(notice) }, [{ code: 'STAFF_NOTICE_MISSING', member: 'O-1' }]],
    ['no decision allowing the recording', { decision: { ...decision, eligible: false, reason: 'CONSENT_MISSING' } }, [{ code: 'DECISION_NOT_ELIGIBLE', member: null }]],
  ];
  for (const [what, changes, problems] of cases) {
    const snapshot = recordingSnapshot({ ...base, events, ...changes });
    assert.equal(snapshot.filing.eligible, false, what);
    assert.deepEqual(snapshot.filing.problems, problems, what);
    assert.equal(snapshot.people.find(entry => entry.code === 'S-A').problem, null, `${what}: Alice's own evidence stays valid`);
  }
});

test('18.4: two segments of one lesson are never merged: each covers its own people and keeps its own evidence', () => {
  const events = [fact('session.user_joined', 'P-a', 0), fact('session.user_joined', 'P-t', 0), fact('session.user_joined', 'P-c', 0), fact('session.user_left', 'P-c', 30)];
  const first = recordingSnapshot({ ...base, events, record: { ...base.record, providerFileId: 'F-1', recordingStart: T + 5 * MIN, recordingEnd: T + 25 * MIN } });
  const second = recordingSnapshot({ ...base, events, record: { ...base.record, providerFileId: 'F-2', recordingStart: T + 35 * MIN, recordingEnd: T + 55 * MIN } });
  assert.deepEqual(first.names.students, ['Alice', 'Chloe']);
  assert.deepEqual(second.names.students, ['Alice']);
  assert.deepEqual([first.recordingId, second.recordingId], ['F-1', 'F-2']);
});
