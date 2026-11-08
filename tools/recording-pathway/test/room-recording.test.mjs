// Synthetic tests for recording after the room moved (2026-11-08): a link revoked or reissued
// opens a new generation of the lesson's room. Our rules only, on the lesson state alone; nothing
// here says how real Zoom behaves.
//
//   A  moved before anything was recorded: the new room's own check (consent as it is then, so
//      consent given after the move counts too), then the usual start there
//   B  moved while recording: the old room stopped and cleaned up; nothing starts in the new room
//      until an owner authorizes it and the check (from that moment) passes
//   never: a withdrawal, an emergency stop or a cancellation is undone by a move
//
// Each test states its success condition in its title, and fails on any other outcome.
import test from 'node:test';
import assert from 'node:assert/strict';
import { roomNameOf } from '../classroom/eligibility.mjs';
import { deriveLesson, planActions, TIMING } from '../classroom/lesson-state.mjs';
import { LESSON_START, makeLesson, MIN } from './fake-zoom.mjs';

const T = LESSON_START;
const SEC = 1000;
const lesson = makeLesson(0);
const TUTOR = lesson.participants[0].id;
const STUDENT = lesson.participants[1].id;
const OLD = 'ZS-OLD', NEW = 'ZS-NEW', NEWER = 'ZS-NEWER';
const MOVE = T + 20 * MIN;

let n = 0;
const fact = (type, at, fields = {}, source = 'zoom_webhook') => ({ type, source, lessonId: lesson.id, occurredAt: at, receivedAt: at, key: fields.key ?? `${type}:${at}:${n += 1}`, ...fields });
const server = (type, at, fields) => fact(type, at, fields, 'server');
const room = (sid, at, generation) => fact('session.started', at, { providerSessionId: sid, sessionName: roomNameOf(lesson.id, generation) });
const joined = (sid, who, at) => fact('session.user_joined', at, { providerSessionId: sid, participantId: who });
const leftRoom = (sid, who, at) => fact('session.user_left', at, { providerSessionId: sid, participantId: who });
const recording = (sid, status, at, source = 'zoom_webhook') => fact(status === 'Recording' ? 'session.recording_started' : status === 'Paused' ? 'session.recording_paused' : 'session.recording_stopped', at, { providerSessionId: sid, status }, source);
const hostReport = (status, at) => fact('host.recording_status', at, { status }, 'host_sdk');
const decision = (eligible, at, extra = {}) => server('server.recording_eligibility', at, { eligible, reason: eligible ? 'ALL_CONSENTED' : extra.reason ?? 'CONSENT_EXPIRED', key: `decide:${lesson.id}:${at}`, ...extra });
const generation = (value, at) => server('server.room_generation', at, { generation: value, key: `room_generation:${lesson.id}:${value}` });
const rotated = (from, to, at) => server('server.participant_rotated', at, { from, to, key: `server.participant_rotated:${lesson.id}:${to}` });
const authorized = (value, at) => server('server.recording_resume_authorized', at, { generation: value, key: `resume:${lesson.id}:${value}:${at}` });
// What the server would store for an action it performed, as the service does.
function done(action, at, { ok = true } = {}) {
  const named = { targets: action.targets, ...(action.generation ? { generation: action.generation } : {}) };
  if (action.type === 'START_RECORDING') {
    return [server('server.start_requested', at, { key: action.key, attempt: action.attempt, ...named }), server('server.start_response', at, { key: `${action.key}:response`, attempt: action.attempt, ok, ...named })];
  }
  if (action.type === 'STOP_RECORDING') return [server('server.stop_requested', at, { key: action.key, reason: action.reason, attempt: action.attempt, targets: action.targets })];
  if (action.type === 'END_SESSION') return [server('server.session_end_requested', at, { key: action.key, reason: action.reason, targets: action.targets })];
  if (action.type === 'DECIDE_RECORDING') return [decision(true, at, { key: action.key, ...(action.generation ? { generation: action.generation } : {}) })];
  return [];
}
const of = (actions, type) => actions.filter(action => action.type === type);
const starts = actions => of(actions, 'START_RECORDING').map(action => [action.key.replace(`${lesson.id}:`, ''), action.targets]);

// The lesson's own decision, made before it started: eligible.
const decided = () => [decision(true, T - 15 * MIN, { key: `decide:${lesson.id}` })];
// The lesson in its first room with both people in.
const inFirstRoom = () => [room(OLD, T - 3 * MIN, 0), joined(OLD, TUTOR, T - 3 * MIN), joined(OLD, STUDENT, T)];
// Recorded in the first room: our start, Zoom's confirmation.
const recordedInFirstRoom = () => [
  server('server.start_requested', T + MIN - 5 * SEC, { key: `start:${lesson.id}:1`, attempt: 1, targets: [OLD] }),
  server('server.start_response', T + MIN - 5 * SEC, { key: `start:${lesson.id}:1:response`, attempt: 1, ok: true, targets: [OLD] }),
  recording(OLD, 'Recording', T + MIN),
];
// The move, and both people in the new room.
const movedIn = (to = NEW, g = 1, at = MOVE, student = STUDENT) => [generation(g, at), room(to, at + 20 * SEC, g), joined(to, TUTOR, at + 20 * SEC), joined(to, student, at + 30 * SEC)];

test('A: moved before anything was recorded: the new room\'s own check comes first, and only once it passes does a start go to the new room\'s session (never the old one)', () => {
  // The lesson started without both people confirmed in time, so nothing was recorded; then a link was revoked.
  const events = [...decided(), room(OLD, T - 3 * MIN, 0), joined(OLD, TUTOR, T - 3 * MIN), ...movedIn()];
  const now = MOVE + MIN;
  const first = planActions(lesson, events, now);
  const check = of(first, 'DECIDE_RECORDING');
  assert.deepEqual(check.map(action => [action.key, action.generation]), [[`decide:${lesson.id}:g1:${MOVE}`, 1]]);
  assert.deepEqual(starts(first), []);
  assert.equal(deriveLesson(lesson, events, now).roomRecording.status, 'RECHECK_PENDING');
  const checked = [...events, ...done(check[0], now)];
  assert.deepEqual(starts(planActions(lesson, checked, now + SEC)), [['start:g1:1', [NEW]]]);
  assert.equal(deriveLesson(lesson, checked, now + SEC).roomRecording.status, 'ALLOWED');
});

test('A: the new room\'s check refuses (a consent expired, was withdrawn or is of another version by now): nothing starts, and the overview says the new room is not recorded and why', () => {
  const events = [...decided(), room(OLD, T - 3 * MIN, 0), joined(OLD, TUTOR, T - 3 * MIN), ...movedIn(), decision(false, MOVE + MIN, { generation: 1, reason: 'CONSENT_EXPIRED', key: `decide:${lesson.id}:g1:${MOVE}` })];
  const state = deriveLesson(lesson, events, MOVE + 2 * MIN);
  assert.deepEqual([state.roomRecording.status, state.roomRecording.reason], ['RECHECK_REFUSED', 'CONSENT_EXPIRED']);
  assert.deepEqual([state.recording.status, state.recording.reason], ['BLOCKED', 'CONSENT_EXPIRED']);
  assert.deepEqual(starts(planActions(lesson, events, MOVE + 2 * MIN)), []);
});

test('A: a lesson that was not eligible when it started is checked again after the move, with consent as it is now: it records in the new room only if that check passes (consent valid now counts)', () => {
  const events = [decision(false, T - 15 * MIN, { key: `decide:${lesson.id}`, reason: 'CONSENT_MISSING' }), room(OLD, T - 3 * MIN, 0), joined(OLD, TUTOR, T - 3 * MIN), ...movedIn()];
  const now = MOVE + 2 * MIN;
  const check = of(planActions(lesson, events, now), 'DECIDE_RECORDING');
  assert.deepEqual(check.map(action => action.generation), [1]);
  assert.deepEqual(starts(planActions(lesson, events, now)), []);
  const refused = [...events, decision(false, now, { generation: 1, reason: 'CONSENT_MISSING', key: check[0].key })];
  assert.deepEqual(starts(planActions(lesson, refused, now + SEC)), []);
  assert.deepEqual([deriveLesson(lesson, refused, now + SEC).roomRecording.status, deriveLesson(lesson, refused, now + SEC).roomRecording.reason], ['RECHECK_REFUSED', 'CONSENT_MISSING']);
  const passed = [...events, ...done(check[0], now)];
  assert.deepEqual(starts(planActions(lesson, passed, now + SEC)), [['start:g1:1', [NEW]]]);
});

test('B: moved while recording: the old room\'s recording is stopped, and nothing starts or is checked for the new room on its own, though both people are there and the lesson is eligible', () => {
  const events = [...decided(), ...inFirstRoom(), ...recordedInFirstRoom(), ...movedIn()];
  const now = MOVE + MIN;
  const actions = planActions(lesson, events, now);
  assert.deepEqual(of(actions, 'STOP_RECORDING').map(action => [action.reason, action.targets]), [['old_room', [OLD]]]);
  assert.deepEqual([of(actions, 'DECIDE_RECORDING').length, starts(actions).length], [0, 0]);
  const state = deriveLesson(lesson, events, now);
  // The old room may still be recording: the owner cannot authorize yet.
  assert.deepEqual([state.roomRecording.status, state.roomRecording.canAuthorize, state.roomRecording.oldRoomStillRecording], ['WAITING_FOR_AUTHORIZATION', false, true]);
  // Zoom confirms the old room stopped: now an owner may authorize, and still nothing starts.
  const stopped = [...events, ...done(of(actions, 'STOP_RECORDING')[0], now), recording(OLD, 'Stopped', now + 5 * SEC)];
  const later = deriveLesson(lesson, stopped, now + 10 * SEC).roomRecording;
  assert.deepEqual([later.status, later.canAuthorize, later.oldRoomStillRecording], ['WAITING_FOR_AUTHORIZATION', true, false]);
  assert.deepEqual(starts(planActions(lesson, stopped, now + 30 * MIN)), []);
});

test('B: after an owner\'s authorization the check runs from that moment, and only when it passes does a start go to the new room\'s session, under the new room\'s own keys', () => {
  const base = [...decided(), ...inFirstRoom(), ...recordedInFirstRoom(), ...movedIn(), server('server.stop_requested', MOVE + MIN, { key: `migrate:${lesson.id}:${OLD}:stop`, reason: 'old_room', attempt: 1, targets: [OLD] }), recording(OLD, 'Stopped', MOVE + MIN + 5 * SEC)];
  const at = MOVE + 3 * MIN;
  const events = [...base, authorized(1, at)];
  const check = of(planActions(lesson, events, at + SEC), 'DECIDE_RECORDING');
  assert.deepEqual(check.map(action => [action.key, action.generation]), [[`decide:${lesson.id}:g1:${at}`, 1]]);
  // A check made before the authorization does not count for it.
  const early = [...base, decision(true, MOVE + 2 * MIN, { generation: 1 }), authorized(1, at)];
  assert.deepEqual(starts(planActions(lesson, early, at + SEC)), []);
  const checked = [...events, ...done(check[0], at + SEC)];
  const actions = planActions(lesson, checked, at + 2 * SEC);
  assert.deepEqual(starts(actions), [['start:g1:1', [NEW]]]);
  assert.equal(of(actions, 'START_RECORDING')[0].generation, 1);
  // Zoom confirms: recording in the new room, nothing flagged as unapproved, no further start.
  const recordingNew = [...checked, ...done(of(actions, 'START_RECORDING')[0], at + 3 * SEC), recording(NEW, 'Recording', at + 5 * SEC)];
  const state = deriveLesson(lesson, recordingNew, at + 10 * SEC);
  assert.equal(state.recording.status, 'RECORDING');
  assert.ok(!state.anomalies.some(entry => entry.code === 'UNAPPROVED_RECORDING_START'));
  assert.deepEqual(starts(planActions(lesson, recordingNew, at + 10 * SEC)), []);
});

test('B: an authorization while the old room may still be recording starts nothing (the check may run; the start waits for the old room\'s confirmed stop)', () => {
  const at = MOVE + MIN;
  const events = [...decided(), ...inFirstRoom(), ...recordedInFirstRoom(), ...movedIn(), authorized(1, at), decision(true, at + SEC, { generation: 1, key: `decide:${lesson.id}:g1:${at}` })];
  assert.deepEqual(starts(planActions(lesson, events, at + 2 * SEC)), []);
  // Zoom says the old room stopped: now the start goes to the new room only.
  assert.deepEqual(starts(planActions(lesson, [...events, recording(OLD, 'Stopped', at + 5 * SEC)], at + 6 * SEC)), [['start:g1:1', [NEW]]]);
});

for (const [name, protective] of [
  ['a withdrawal of consent', at => server('server.consent_withdrawn', at, { participantId: STUDENT, key: `server.consent_withdrawn:${lesson.id}:x` })],
  ['an emergency stop', at => server('server.emergency_stop', at, { key: `server.emergency_stop:${lesson.id}` })],
  ['a cancellation', at => server('server.lesson_cancelled', at, { key: `server.lesson_cancelled:${lesson.id}` })],
]) {
  test(`${name} before the move is never undone by it: no check, no start in the new room, even with an owner's authorization and an eligible check stored`, () => {
    const events = [...decided(), ...inFirstRoom(), ...recordedInFirstRoom(), protective(T + 5 * MIN), recording(OLD, 'Stopped', T + 5 * MIN + 10 * SEC), ...movedIn(),
      authorized(1, MOVE + MIN), decision(true, MOVE + MIN + SEC, { generation: 1, key: `decide:${lesson.id}:g1:forged` })];
    const actions = planActions(lesson, events, MOVE + 2 * MIN);
    assert.deepEqual([of(actions, 'DECIDE_RECORDING').length, starts(actions).length], [0, 0]);
    const state = deriveLesson(lesson, events, MOVE + 2 * MIN);
    assert.deepEqual([state.roomRecording.status, state.roomRecording.canAuthorize], ['BLOCKED', false]);
    // Nor in case A (nothing recorded before the move).
    const unrecorded = [...decided(), room(OLD, T - 3 * MIN, 0), joined(OLD, TUTOR, T - 3 * MIN), protective(T + 5 * MIN), ...movedIn()];
    const planned = planActions(lesson, unrecorded, MOVE + 2 * MIN);
    assert.deepEqual([of(planned, 'DECIDE_RECORDING').length, starts(planned).length], [0, 0]);
  });
}

test('the old room\'s stop is asked again at 30 s and the room is ended at 60 s if Zoom has not confirmed; OLD_ROOM_STOP_UNCONFIRMED stays an error, and the old room is never shown as stopped meanwhile', () => {
  let events = [...decided(), ...inFirstRoom(), ...recordedInFirstRoom(), generation(1, MOVE), room(NEW, MOVE + 20 * SEC, 1)];
  const at = MOVE + 30 * SEC;
  const first = of(planActions(lesson, events, at), 'STOP_RECORDING');
  assert.deepEqual(first.map(action => [action.key, action.targets]), [[`migrate:${lesson.id}:${OLD}:stop`, [OLD]]]);
  events = [...events, ...done(first[0], at)];
  assert.deepEqual(of(planActions(lesson, events, at + TIMING.stopRetryMs - SEC), 'STOP_RECORDING'), []);
  const again = of(planActions(lesson, events, at + TIMING.stopRetryMs), 'STOP_RECORDING');
  assert.deepEqual(again.map(action => action.key), [`migrate:${lesson.id}:${OLD}:stop:2`]);
  let state = deriveLesson(lesson, events, at + TIMING.stopRetryMs);
  assert.ok(state.anomalies.some(entry => entry.code === 'OLD_ROOM_STOP_UNCONFIRMED' && entry.severity === 'error'));
  assert.equal(state.sessions.find(entry => entry.id === OLD).capture, 'STOP_REQUESTED');
  events = [...events, ...done(again[0], at + TIMING.stopRetryMs)];
  // Not ended before the minute (the student is still in the old room, so no other rule ends it).
  assert.deepEqual(of(planActions(lesson, events, at + TIMING.endSessionMs - SEC), 'END_SESSION'), []);
  const end = of(planActions(lesson, events, at + TIMING.endSessionMs), 'END_SESSION');
  assert.deepEqual(end.map(action => [action.reason, action.targets]), [['old_room', [OLD]]]);
  events = [...events, ...done(end[0], at + TIMING.endSessionMs)];
  state = deriveLesson(lesson, events, at + 5 * MIN);
  assert.ok(state.anomalies.some(entry => entry.code === 'OLD_ROOM_STOP_UNCONFIRMED'));
  assert.ok(state.anomalies.some(entry => entry.code === 'SESSION_END_UNCONFIRMED'));
  assert.notEqual(state.sessions.find(entry => entry.id === OLD).capture, 'STOPPED');
  // Zoom confirms the stop: no longer flagged, and the old room reads as stopped on Zoom's word.
  state = deriveLesson(lesson, [...events, recording(OLD, 'Stopped', at + 5 * MIN)], at + 5 * MIN + SEC);
  assert.ok(!state.anomalies.some(entry => entry.code === 'OLD_ROOM_STOP_UNCONFIRMED'));
  assert.equal(state.sessions.find(entry => entry.id === OLD).capture, 'STOPPED');
});

test('the tutor\'s page in the new room saying "stopped" says nothing about the old room: it still may be recording, and a withdrawal then is not shown as safely stopped', () => {
  const events = [...decided(), ...inFirstRoom(), ...recordedInFirstRoom(), ...movedIn(), hostReport('Stopped', MOVE + MIN)];
  let state = deriveLesson(lesson, events, MOVE + MIN + SEC);
  assert.notEqual(state.sessions.find(entry => entry.id === OLD).capture, 'STOPPED');
  const withdrawn = [...events, server('server.consent_withdrawn', MOVE + 2 * MIN, { participantId: STUDENT, key: `server.consent_withdrawn:${lesson.id}:y` })];
  state = deriveLesson(lesson, withdrawn, MOVE + 2 * MIN + SEC);
  assert.equal(state.withdrawal.captureStopped, false);
  assert.ok(of(planActions(lesson, withdrawn, MOVE + 2 * MIN + SEC), 'STOP_RECORDING').some(action => action.targets.includes(OLD)));
});

test('a recording no start of ours covers after a move is stopped in its own session only: one in the new room before its check, and one restarted in the old room after its stop', () => {
  // (a) The new room starts recording on its own (Zoom's automatic recording, or the host).
  const rogue = [...decided(), room(OLD, T - 3 * MIN, 0), joined(OLD, TUTOR, T - 3 * MIN), ...movedIn(), recording(NEW, 'Recording', MOVE + MIN)];
  const state = deriveLesson(lesson, rogue, MOVE + MIN + SEC);
  const flagged = state.anomalies.find(entry => entry.code === 'UNAPPROVED_RECORDING_START');
  assert.equal(flagged?.roomGeneration, 1);
  const stops = of(planActions(lesson, rogue, MOVE + MIN + SEC), 'STOP_RECORDING');
  assert.deepEqual(stops.map(action => [action.reason, action.targets]), [['unapproved_start', [NEW]]]);
  assert.ok(stops[0].key.includes(`:e${MOVE + MIN}:`));
  // Once Zoom says it stopped, the episode is over: the new room's own check and start may follow.
  const over = [...rogue, ...done(stops[0], MOVE + MIN + SEC), recording(NEW, 'Stopped', MOVE + MIN + 5 * SEC)];
  const next = planActions(lesson, over, MOVE + 2 * MIN);
  assert.deepEqual(of(next, 'STOP_RECORDING'), []);
  assert.equal(of(next, 'DECIDE_RECORDING').length, 1);
  // (b) The old room starts recording again after its stop was confirmed.
  const restarted = [...decided(), ...inFirstRoom(), ...recordedInFirstRoom(), ...movedIn(),
    server('server.stop_requested', MOVE + MIN, { key: `migrate:${lesson.id}:${OLD}:stop`, reason: 'old_room', attempt: 1, targets: [OLD] }),
    recording(OLD, 'Stopped', MOVE + MIN + 5 * SEC), recording(OLD, 'Recording', MOVE + 4 * MIN)];
  const restops = of(planActions(lesson, restarted, MOVE + 4 * MIN + SEC), 'STOP_RECORDING');
  assert.ok(restops.length > 0);
  assert.ok(restops.every(action => action.targets.length === 1 && action.targets[0] === OLD));
  assert.ok(restops.some(action => action.key === `migrate:${lesson.id}:${OLD}:stop:r${MOVE + 4 * MIN}` || action.key.includes(':e')));
});

test('three generations live at once: both older rooms are stopped and ended, and only the newest room may record, after its own check', () => {
  const second = MOVE + 5 * MIN;
  let events = [...decided(), ...inFirstRoom(), ...recordedInFirstRoom(), ...movedIn(), generation(2, second), room(NEWER, second + 20 * SEC, 2), joined(NEWER, TUTOR, second + 20 * SEC), joined(NEWER, STUDENT, second + 30 * SEC)];
  const at = second + MIN;
  const state = deriveLesson(lesson, events, at);
  assert.deepEqual(state.sessions.map(entry => [entry.id, entry.generation]), [[OLD, 0], [NEW, 1], [NEWER, 2]]);
  const actions = planActions(lesson, events, at);
  assert.deepEqual(of(actions, 'STOP_RECORDING').map(action => action.targets), [[OLD]]);
  // Everyone legitimate is in the newest room: both older rooms are ended; the newest never is.
  assert.deepEqual(of(actions, 'END_SESSION').map(action => action.targets).sort(), [[NEW], [OLD]].sort());
  assert.ok(!actions.some(action => action.targets?.includes(NEWER)));
  // Authorized for the newest room; the old one confirmed stopped: the check, then the start, there only.
  events = [...events, recording(OLD, 'Stopped', at + SEC), authorized(2, at + 2 * SEC)];
  const check = of(planActions(lesson, events, at + 3 * SEC), 'DECIDE_RECORDING');
  assert.deepEqual(check.map(action => action.generation), [2]);
  assert.deepEqual(starts(planActions(lesson, [...events, ...done(check[0], at + 3 * SEC)], at + 4 * SEC)), [['start:g2:1', [NEWER]]]);
  // An authorization for the middle room counts for nothing now.
  const wrong = [...events.slice(0, -1), authorized(1, at + 2 * SEC)];
  assert.deepEqual(of(planActions(lesson, wrong, at + 3 * SEC), 'DECIDE_RECORDING'), []);
});

test('no start in the new room while someone who should not be there is in it, while the tutor is out of it (a dropped connection), or before a student is in it; it follows once that is resolved', () => {
  const ready = [...decided(), room(OLD, T - 3 * MIN, 0), joined(OLD, TUTOR, T - 3 * MIN), ...movedIn(), decision(true, MOVE + MIN, { generation: 1, key: `decide:${lesson.id}:g1:${MOVE}` })];
  const at = MOVE + 2 * MIN;
  assert.deepEqual(starts(planActions(lesson, ready, at)), [['start:g1:1', [NEW]]]);
  assert.deepEqual(starts(planActions(lesson, [...ready, joined(NEW, 'P-NOT-ON-ROSTER', MOVE + MIN + 30 * SEC)], at)), []);
  const dropped = [...ready, leftRoom(NEW, TUTOR, MOVE + MIN + 30 * SEC)];
  assert.deepEqual(starts(planActions(lesson, dropped, at)), []);
  assert.deepEqual(starts(planActions(lesson, [...dropped, joined(NEW, TUTOR, MOVE + MIN + 50 * SEC)], at)), [['start:g1:1', [NEW]]]);
  const noStudent = [...decided(), room(OLD, T - 3 * MIN, 0), joined(OLD, TUTOR, T - 3 * MIN), generation(1, MOVE), room(NEW, MOVE + 20 * SEC, 1), joined(NEW, TUTOR, MOVE + 20 * SEC), decision(true, MOVE + MIN, { generation: 1, key: `decide:${lesson.id}:g1:${MOVE}` })];
  assert.deepEqual(starts(planActions(lesson, noStudent, at)), []);
});

test('Zoom refuses the new room\'s start (an API error): tried again after 10 s and 30 s, three tries in all, each under the new room\'s own key, and then reported as failed', () => {
  let events = [...decided(), room(OLD, T - 3 * MIN, 0), joined(OLD, TUTOR, T - 3 * MIN), ...movedIn(), decision(true, MOVE + MIN, { generation: 1, key: `decide:${lesson.id}:g1:${MOVE}` })];
  let at = MOVE + 2 * MIN;
  for (const [tryNo, wait] of [[1, 0], [2, TIMING.startRetryDelaysMs[0]], [3, TIMING.startRetryDelaysMs[1]]]) {
    at += wait;
    const start = of(planActions(lesson, events, at), 'START_RECORDING');
    assert.deepEqual(start.map(action => [action.key, action.attempt]), [[`start:${lesson.id}:g1:${tryNo}`, tryNo]]);
    events = [...events, ...done(start[0], at, { ok: false })];
  }
  assert.deepEqual(starts(planActions(lesson, events, at + 5 * MIN)), []);
  const state = deriveLesson(lesson, events, at + SEC);
  assert.deepEqual([state.recording.status, state.recording.reason], ['FAILED', 'START_API_ERROR']);
});

test('the student\'s id changed with a reissue: consent goes by the person, so the new id in the new room counts, and the old id there is someone who should not be', () => {
  const STUDENT2 = 'P-ROTATED-STUDENT';
  const reissued = { ...lesson, participants: lesson.participants.map(entry => (entry.id === STUDENT ? { ...entry, id: STUDENT2 } : entry)) };
  const base = [...decided(), room(OLD, T - 3 * MIN, 0), joined(OLD, TUTOR, T - 3 * MIN), generation(1, MOVE), rotated(STUDENT, STUDENT2, MOVE),
    room(NEW, MOVE + 20 * SEC, 1), joined(NEW, TUTOR, MOVE + 20 * SEC), decision(true, MOVE + MIN, { generation: 1, key: `decide:${lesson.id}:g1:${MOVE}` })];
  assert.deepEqual(starts(planActions(reissued, [...base, joined(NEW, STUDENT2, MOVE + 30 * SEC)], MOVE + 2 * MIN)), [['start:g1:1', [NEW]]]);
  const oldId = [...base, joined(NEW, STUDENT, MOVE + 30 * SEC)];
  assert.deepEqual(starts(planActions(reissued, oldId, MOVE + 2 * MIN)), []);
  assert.ok(deriveLesson(reissued, oldId, MOVE + 2 * MIN).anomalies.some(entry => entry.code === 'UNKNOWN_PARTICIPANT'));
});

test('each recording file keeps the room it was recorded in: the overview lists the old room\'s and the new room\'s files with their session and generation', () => {
  const at = MOVE + 3 * MIN;
  const file = (id, start) => ({ providerFileId: id, kind: 'composite', extension: 'mp4', size: 1024, status: 'completed', recordingStart: start, recordingEnd: start + MIN });
  const events = [...decided(), ...inFirstRoom(), ...recordedInFirstRoom(), ...movedIn(), recording(OLD, 'Stopped', MOVE + MIN), authorized(1, at),
    decision(true, at + SEC, { generation: 1, key: `decide:${lesson.id}:g1:${at}` }),
    server('server.start_requested', at + 2 * SEC, { key: `start:${lesson.id}:g1:1`, attempt: 1, targets: [NEW], generation: 1 }),
    server('server.start_response', at + 2 * SEC, { key: `start:${lesson.id}:g1:1:response`, attempt: 1, ok: true, targets: [NEW], generation: 1 }),
    recording(NEW, 'Recording', at + 5 * SEC), recording(NEW, 'Stopped', at + 20 * MIN),
    fact('session.recording_completed', MOVE + 10 * MIN, { providerSessionId: OLD, files: [file('f-old', T + MIN)] }),
    fact('session.recording_completed', at + 30 * MIN, { providerSessionId: NEW, files: [file('f-new', at + 5 * SEC)] })];
  const state = deriveLesson(lesson, events, at + 31 * MIN);
  assert.deepEqual(state.filing.items.map(item => [item.sessionId, item.generation]), [[OLD, 0], [NEW, 1]]);
  // While the new room was still recording, the lesson was not shown as completed.
  const midway = deriveLesson(lesson, events.filter(event => !(event.type === 'session.recording_completed' && event.providerSessionId === NEW) && !(event.type === 'session.recording_stopped' && event.providerSessionId === NEW)), at + 15 * MIN);
  assert.equal(midway.recording.status, 'RECORDING');
});
