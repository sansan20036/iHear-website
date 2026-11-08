// Synthetic tests for the room's generations (D-1) and the clean-up of an older generation's room
// (D-5), on the lesson state alone (2026-11-08, P1+P3 integration). Our rules only: nothing here
// says how real Zoom behaves.
import test from 'node:test';
import assert from 'node:assert/strict';
import { generationOfRoom, roomNameOf } from '../classroom/eligibility.mjs';
import { deriveLesson, planActions, TIMING } from '../classroom/lesson-state.mjs';
import { LESSON_START, makeLesson, MIN } from './fake-zoom.mjs';

const T = LESSON_START;
const SEC = 1000;
const lesson = makeLesson(0);
const TUTOR = lesson.participants[0].id;
const STUDENT = lesson.participants[1].id;
const OLD = 'old-room', NEW = 'new-room';

let n = 0;
const fact = (type, at, fields = {}, source = 'zoom_webhook') => ({ type, source, lessonId: lesson.id, occurredAt: at, receivedAt: at, key: fields.key ?? `${type}:${at}:${n += 1}`, ...fields });
const room = (sid, at, generation) => fact('session.started', at, { providerSessionId: sid, sessionName: roomNameOf(lesson.id, generation) });
const joined = (sid, who, at) => fact('session.user_joined', at, { providerSessionId: sid, participantId: who });
const leftRoom = (sid, who, at) => fact('session.user_left', at, { providerSessionId: sid, participantId: who });
const generation = (value, at) => fact('server.room_generation', at, { generation: value, key: `room_generation:${lesson.id}:${value}` }, 'server');
const rotated = (from, to, at) => fact('server.participant_rotated', at, { from, to, key: `server.participant_rotated:${lesson.id}:${to}` }, 'server');
const recording = (sid, status, at) => fact(status === 'Recording' ? 'session.recording_started' : 'session.recording_stopped', at, { providerSessionId: sid, status });
const done = (action, at) => fact({ STOP_RECORDING: 'server.stop_requested', END_SESSION: 'server.session_end_requested' }[action.type] ?? 'server.other', at, { key: action.key, reason: action.reason, attempt: action.attempt, targets: action.targets }, 'server');
const of = (actions, type) => actions.filter(action => action.type === type);
const ends = actions => of(actions, 'END_SESSION').map(action => [action.reason, action.targets]);

// The lesson in its first room: both in, nobody recording.
const firstRoom = () => [room(OLD, T - 3 * MIN, 0), joined(OLD, TUTOR, T - 3 * MIN), joined(OLD, STUDENT, T)];

test('a room name tells its generation; any other name is none of this lesson\'s', () => {
  assert.equal(roomNameOf(lesson.id), roomNameOf(lesson.id, 0));
  assert.equal(generationOfRoom(lesson.id, roomNameOf(lesson.id)), 0);
  assert.equal(generationOfRoom(lesson.id, roomNameOf(lesson.id, 3).toUpperCase()), 3);
  for (const name of [roomNameOf('L-OTHER', 1), `${roomNameOf(lesson.id)}-g0`, `${roomNameOf(lesson.id)}-gx`, 'Someone\'s room', '', null]) {
    assert.equal(generationOfRoom(lesson.id, name), null, String(name));
  }
  const state = deriveLesson(lesson, [...firstRoom(), generation(1, T + 10 * MIN), room(NEW, T + 10 * MIN + 20 * SEC, 1)], T + 11 * MIN);
  assert.equal(state.generation, 1);
  assert.deepEqual(state.sessions.map(entry => [entry.id, entry.generation, entry.live]), [[OLD, 0, true], [NEW, 1, true]]);
});

test('D-5: the old room is ended as soon as everyone legitimate is in the new one, and not before', () => {
  const at = T + 10 * MIN;
  const moving = [...firstRoom(), generation(1, at), room(NEW, at + 20 * SEC, 1), joined(NEW, TUTOR, at + 20 * SEC)];
  // Only the tutor has moved: the old room waits (the student is still in it).
  assert.deepEqual(ends(planActions(lesson, moving, at + 30 * SEC)), []);
  const moved = [...moving, joined(NEW, STUDENT, at + 40 * SEC)];
  assert.deepEqual(ends(planActions(lesson, moved, at + 41 * SEC)), [['old_room', [OLD]]]);
  // The new room is never touched by this.
  assert.ok(!planActions(lesson, moved, at + 41 * SEC).some(action => action.targets?.includes(NEW)));
});

test('D-5: someone left behind in the old room (the revoked link\'s holder, say) does not keep it open past the grace', () => {
  const at = T + 10 * MIN;
  const events = [...firstRoom(), generation(1, at), room(NEW, at + 20 * SEC, 1), joined(NEW, TUTOR, at + 20 * SEC), leftRoom(OLD, TUTOR, at + 21 * SEC)];
  assert.deepEqual(ends(planActions(lesson, events, at + TIMING.oldRoomEndMs - SEC)), []);
  assert.deepEqual(ends(planActions(lesson, events, at + TIMING.oldRoomEndMs)), [['old_room', [OLD]]]);
});

test('D-5 with nothing recording: an old id coming back into the old room after a reissue is a stranger, and the room ends a minute after the reissue (at once for a later stranger)', () => {
  const at = T + 10 * MIN;
  const STUDENT2 = 'P-rotated-student';
  const reissued = { ...lesson, participants: lesson.participants.map(entry => (entry.id === STUDENT ? { ...entry, id: STUDENT2 } : entry)) };
  const back = at + 30 * SEC;
  const events = [...firstRoom(), generation(1, at), rotated(STUDENT, STUDENT2, at), room(NEW, at + 20 * SEC, 1), joined(NEW, TUTOR, at + 20 * SEC), leftRoom(OLD, TUTOR, at + 21 * SEC),
    leftRoom(OLD, STUDENT, at + 25 * SEC), joined(OLD, STUDENT, back)];
  const state = deriveLesson(reissued, events, back + SEC);
  assert.ok(state.anomalies.some(entry => entry.code === 'OLD_ROOM_SUSPECT'));
  // The earlier join (before the reissue) is still the student's: only the return is a stranger.
  assert.equal(state.anomalies.find(entry => entry.code === 'UNKNOWN_PARTICIPANT').count, 1);
  assert.deepEqual(ends(planActions(reissued, events, at + TIMING.oldRoomSuspectEndMs - SEC)), []);
  assert.deepEqual(ends(planActions(reissued, events, at + TIMING.oldRoomSuspectEndMs)), [['old_room_suspect', [OLD]]]);
  assert.ok(TIMING.oldRoomSuspectEndMs < TIMING.oldRoomEndMs);
  // A stranger who comes five minutes after the reissue finds the room ended at once.
  const late = [...events.slice(0, -1), joined(OLD, STUDENT, at + 5 * MIN)];
  assert.deepEqual(ends(planActions(reissued, late, at + 5 * MIN + SEC)), [['old_room_suspect', [OLD]]]);
  // Without a stranger the same room would still be waiting then (the student had not moved).
  assert.deepEqual(ends(planActions(reissued, events.slice(0, -1), at + 2 * MIN)), []);
});

test('D-5: a recording still running in the old room is stopped at once, before the room is ended', () => {
  const at = T + 10 * MIN;
  // A recording the server started with consent (so nothing about it is unapproved).
  const approved = [
    fact('server.recording_eligibility', T - 15 * MIN, { eligible: true, reason: 'ALL_CONSENTED', key: `decide:${lesson.id}` }, 'server'),
    fact('server.start_requested', T + MIN - 5 * SEC, { attempt: 1, targets: [OLD], key: `start:${lesson.id}:1` }, 'server'),
    fact('server.start_response', T + MIN - 5 * SEC, { attempt: 1, ok: true, targets: [OLD], key: `start:${lesson.id}:1:response` }, 'server'),
  ];
  const events = [...approved, ...firstRoom(), recording(OLD, 'Recording', T + MIN), generation(1, at), room(NEW, at + 20 * SEC, 1)];
  const actions = planActions(lesson, events, at + 21 * SEC);
  assert.deepEqual(of(actions, 'STOP_RECORDING').map(action => [action.reason, action.targets]), [['old_room', [OLD]]]);
  assert.deepEqual(ends(actions), []);
});

test('D-5: an old room whose end Zoom does not confirm is asked again, and stays flagged', () => {
  const at = T + 10 * MIN;
  let events = [...firstRoom(), generation(1, at), room(NEW, at + 20 * SEC, 1), joined(NEW, TUTOR, at + 20 * SEC), joined(NEW, STUDENT, at + 25 * SEC)];
  const end = planActions(lesson, events, at + 30 * SEC);
  events = [...events, ...end.map(action => done(action, at + 30 * SEC))];
  assert.deepEqual(ends(planActions(lesson, events, at + 30 * SEC + TIMING.endRetryMs[0] - SEC)), []);
  assert.ok(deriveLesson(lesson, events, at + 2 * MIN).anomalies.some(entry => entry.code === 'SESSION_END_UNCONFIRMED'));
  const retry = of(planActions(lesson, events, at + 30 * SEC + TIMING.endRetryMs[0]), 'END_SESSION');
  assert.deepEqual(retry.map(action => [action.key.endsWith(':retry1'), action.targets]), [[true, [OLD]]]);
  // Zoom says it ended: nothing more, nothing flagged.
  events = [...events, fact('session.ended', at + 3 * MIN, { providerSessionId: OLD })];
  assert.deepEqual(ends(planActions(lesson, events, at + 40 * MIN)), []);
  assert.ok(!deriveLesson(lesson, events, at + 40 * MIN).anomalies.some(entry => entry.code === 'SESSION_END_UNCONFIRMED'));
});
