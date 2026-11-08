import { test } from 'node:test';
import assert from 'node:assert/strict';

import { blockBaseName, blockFolderPath, nameList, newYorkDate, recordingSnapshot } from '../classroom/block-naming.mjs';

// P3-Multi (2026-11-09, 18.3 and 18.4): Drive names for a block's rooms. Synthetic names only.

test('the New York date of the scheduled start: EST and EDT, the day before Taipei, across a month and a year, and both DST changes', () => {
  const cases = [
    // [scheduled start (UTC), New York date, what it shows]
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
  // Taipei 12:30 on 1 July is New York 00:30 on 1 July, not 23:30 on 30 June.
  const taipeiMinus13 = new Date(Date.parse('2026-07-01T04:30:00Z') + (8 - 13) * 3600_000).toISOString().slice(0, 10);
  assert.equal(taipeiMinus13, '2026-06-30');
  assert.equal(newYorkDate('2026-07-01T04:30:00Z'), '2026-07-01');
});

test('folders: the New York month, then the date and the room code', () => {
  const lesson = { code: 'TEST-M1-R1', startsAt: '2026-12-01T01:00:00Z' };
  assert.deepEqual(blockFolderPath(lesson), ['[iHear] 11.2026.Zoom Recordings', '2026-11-30_TEST-M1-R1']);
});

test('names: students, then tutors, then the date; several joined with +', () => {
  assert.equal(blockBaseName({ students: ['Alice Wang'], tutors: ['Carol Chen'], date: '2026-11-30' }), 'Alice Wang_Carol Chen_2026-11-30');
  assert.equal(blockBaseName({ students: ['Alice Wang', 'Bob Lee'], tutors: ['Carol Chen', 'Dan Wu'], date: '2026-11-30' }), 'Alice Wang+Bob Lee_Carol Chen+Dan Wu_2026-11-30');
});

test('a list too long for a name keeps the first names, says how many more, and a fingerprint of the whole list: stable, and different groups never share it', () => {
  const ten = Array.from({ length: 10 }, (_, index) => `Student Number ${String.fromCharCode(65 + index)}`);
  const first = nameList(ten, 100);
  assert.ok(first.length <= 100, first);
  assert.match(first, /^Student Number A\+Student Number B.*\+\d+~[0-9a-f]{6}$/);
  assert.equal(nameList([...ten], 100), first, 'the same people give the same name');
  const other = [...ten.slice(0, 9), 'Student Number Z'];
  assert.notEqual(nameList(other, 100), first, 'one person different: another fingerprint');
  assert.equal(nameList([], 100), 'Unknown');
});

test('each recording covers the people present during it: a student who left before it, an observer and a tutor who never came are left out; one who joined in the middle is in', () => {
  const block = {
    id: 'B-1', code: 'TEST-M1', members: [
      { id: 'M-a', code: 'S-A', role: 'student', englishName: 'Alice Wang' },
      { id: 'M-b', code: 'S-B', role: 'student', englishName: 'Bob Lee' },
      { id: 'M-c', code: 'S-C', role: 'student', englishName: 'Cara Lin' },
      { id: 'M-t', code: 'T-1', role: 'lead_tutor', englishName: 'Carol Chen' },
      { id: 'M-u', code: 'T-2', role: 'co_tutor', englishName: 'Dan Wu' },
      { id: 'M-o', code: 'O-1', role: 'observer', englishName: 'Olly Observer' },
    ],
  };
  const row = (id, memberId, role, active = true) => ({ id, code: id, role, memberId, active, seat: 'assigned' });
  const lesson = {
    id: 'L-1', code: 'TEST-M1-R1', roomLabel: 'R1', startsAt: '2026-12-01T08:00:00Z',
    participants: [row('P-a', 'M-a', 'student'), row('P-b', 'M-b', 'student', false), row('P-c', 'M-c', 'student'), row('P-t', 'M-t', 'tutor'), row('P-u', 'M-u', 'tutor'), row('P-o', 'M-o', 'observer')],
  };
  const T = Date.parse('2026-12-01T08:00:00Z');
  const fact = (type, participantId, minutes) => ({ type, lessonId: 'L-1', participantId, occurredAt: T + minutes * 60_000, key: `${type}:${participantId}:${minutes}` });
  const events = [
    fact('session.user_joined', 'P-a', 0), fact('session.user_joined', 'P-b', 0), fact('session.user_left', 'P-b', 5),
    fact('session.user_joined', 'P-t', 0), fact('session.user_joined', 'P-o', 12), fact('session.user_joined', 'P-c', 30),
  ];
  const record = { providerFileId: 'F-1', providerSessionId: 'ZS-1', recordingStart: T + 10 * 60_000, recordingEnd: T + 50 * 60_000, hold: null };
  const snapshot = recordingSnapshot({ lesson, block, events, record, generation: 0, decision: { key: 'd', eligible: true, reason: 'ALL_CONSENTED', occurredAt: T + 9 * 60_000 } });
  assert.deepEqual(snapshot.names, { students: ['Alice Wang', 'Cara Lin'], tutors: ['Carol Chen'] });
  assert.equal(snapshot.date, '2026-12-01');
  assert.equal(snapshot.recordingId, 'F-1');
  assert.equal(snapshot.providerSessionId, 'ZS-1');
  assert.deepEqual(snapshot.decision, { key: 'd', eligible: true, reason: 'ALL_CONSENTED', at: T + 9 * 60_000, beforeStart: false });
  const observer = snapshot.people.find(entry => entry.code === 'O-1');
  assert.equal(observer.covered, true, 'the observer is in the snapshot');
  assert.ok(!snapshot.names.students.includes('Olly Observer') && !snapshot.names.tutors.includes('Olly Observer'), 'but never in the name');
  assert.equal(snapshot.people.find(entry => entry.code === 'S-B').covered, false);
  // A second segment after Cara left covers only Alice.
  const later = recordingSnapshot({ lesson, block, events: [...events, fact('session.user_left', 'P-c', 52)], record: { ...record, providerFileId: 'F-2', recordingStart: T + 55 * 60_000, recordingEnd: T + 58 * 60_000 } });
  assert.deepEqual(later.names.students, ['Alice Wang']);
});
