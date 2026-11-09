// Synthetic tests for the second rule set on recording after a room move (2026-11-08): a moved
// room's check reads consent as it is at that moment (consent given after the move counts), runs
// again after each consent change, never reaches back to a recording that started earlier, and is
// never replaced by the owner's authorization; a withdrawal, an emergency stop or a cancellation
// is never undone; an old room Zoom has not confirmed stopped blocks the new room, stays flagged
// and never reads as stopped, until Zoom confirms (safe recovery). Our rules only, on the lesson
// state alone; nothing here says how real Zoom behaves.
//
// Each test states its success condition in its title, and fails on any other outcome.
import test from 'node:test';
import assert from 'node:assert/strict';
import { roomNameOf } from '../classroom/eligibility.mjs';
import { deriveLesson, planActions } from '../classroom/lesson-state.mjs';
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
const recording = (sid, status, at) => fact(status === 'Recording' ? 'session.recording_started' : 'session.recording_stopped', at, { providerSessionId: sid, status });
const decision = (eligible, at, extra = {}) => server('server.recording_eligibility', at, { eligible, reason: eligible ? 'ALL_CONSENTED' : extra.reason ?? 'CONSENT_MISSING', key: `decide:${lesson.id}:${at}`, ...extra });
const generation = (value, at) => server('server.room_generation', at, { generation: value, key: `room_generation:${lesson.id}:${value}` });
const authorized = (value, at) => server('server.recording_resume_authorized', at, { generation: value, key: `resume:${lesson.id}:${value}:${at}` });
const consentChanged = at => server('server.consent_changed', at, { key: `server.consent_changed:${lesson.id}:x:${at}` });
const madeCheck = (action, at, eligible = true) => decision(eligible, at, { key: action.key, generation: action.generation });
const of = (actions, type) => actions.filter(action => action.type === type);
const starts = actions => of(actions, 'START_RECORDING').map(action => [action.key.replace(`${lesson.id}:`, ''), action.targets]);
const checks = actions => of(actions, 'DECIDE_RECORDING').map(action => [action.key.replace(`${lesson.id}:`, ''), action.generation]);

const decided = (eligible = true) => [decision(eligible, T - 15 * MIN, { key: `decide:${lesson.id}` })];
const inFirstRoom = () => [room(OLD, T - 3 * MIN, 0), joined(OLD, TUTOR, T - 3 * MIN), joined(OLD, STUDENT, T)];
const tutorOnlyInFirstRoom = () => [room(OLD, T - 3 * MIN, 0), joined(OLD, TUTOR, T - 3 * MIN)];
const recordedInFirstRoom = () => [
  server('server.start_requested', T + MIN - 5 * SEC, { key: `start:${lesson.id}:1`, attempt: 1, targets: [OLD] }),
  server('server.start_response', T + MIN - 5 * SEC, { key: `start:${lesson.id}:1:response`, attempt: 1, ok: true, targets: [OLD] }),
  recording(OLD, 'Recording', T + MIN),
];
const movedIn = (to = NEW, g = 1, at = MOVE) => [generation(g, at), room(to, at + 20 * SEC, g), joined(to, TUTOR, at + 20 * SEC), joined(to, STUDENT, at + 30 * SEC)];

test('A: consent given after the move allows recording later: after a refused check, the consent change brings a new check (its own key), and then the start in the new room', () => {
  const base = [...decided(false), ...tutorOnlyInFirstRoom(), ...movedIn(), decision(false, MOVE + MIN, { generation: 1, key: `decide:${lesson.id}:g1:${MOVE}` })];
  assert.deepEqual(checks(planActions(lesson, base, MOVE + 2 * MIN)), []);
  assert.deepEqual(starts(planActions(lesson, base, MOVE + 2 * MIN)), []);
  const given = MOVE + 3 * MIN;
  const events = [...base, consentChanged(given)];
  const planned = planActions(lesson, events, given + SEC);
  assert.deepEqual(checks(planned), [[`decide:g1:${given}`, 1]]);
  assert.deepEqual(starts(planned), []);
  assert.deepEqual(starts(planActions(lesson, [...events, madeCheck(of(planned, 'DECIDE_RECORDING')[0], given + 2 * SEC)], given + 3 * SEC)), [['start:g1:1', [NEW]]]);
});

test('A: consent that was valid before the move and still is counts for the new room: one check, then the start', () => {
  const events = [...decided(true), ...tutorOnlyInFirstRoom(), ...movedIn()];
  const planned = planActions(lesson, events, MOVE + MIN);
  assert.deepEqual(checks(planned), [[`decide:g1:${MOVE}`, 1]]);
  assert.deepEqual(starts(planActions(lesson, [...events, madeCheck(of(planned, 'DECIDE_RECORDING')[0], MOVE + MIN)], MOVE + MIN + SEC)), [['start:g1:1', [NEW]]]);
});

test('consent never reaches back: a check made before a later consent change no longer counts for a start after it; the room waits for the new check', () => {
  const events = [...decided(true), ...tutorOnlyInFirstRoom(), ...movedIn(), decision(true, MOVE + MIN, { generation: 1, key: `decide:${lesson.id}:g1:${MOVE}` }), consentChanged(MOVE + 90 * SEC)];
  const planned = planActions(lesson, events, MOVE + 2 * MIN);
  assert.deepEqual(starts(planned), []);
  assert.deepEqual(checks(planned), [[`decide:g1:${MOVE + 90 * SEC}`, 1]]);
});

test('B: the owner\'s authorization never stands in for anyone\'s consent: a refused check (the tutor\'s notice missing) starts nothing; once the notice is given the check runs again by itself and the start follows, without a second authorization', () => {
  const at = MOVE + 3 * MIN;
  const base = [...decided(true), ...inFirstRoom(), ...recordedInFirstRoom(), ...movedIn(), recording(OLD, 'Stopped', MOVE + MIN), authorized(1, at),
    decision(false, at + SEC, { generation: 1, reason: 'STAFF_NOTICE_MISSING', key: `decide:${lesson.id}:g1:${at}` })];
  assert.deepEqual(starts(planActions(lesson, base, at + 2 * SEC)), []);
  const state = deriveLesson(lesson, base, at + 2 * SEC).roomRecording;
  assert.deepEqual([state.status, state.reason], ['RECHECK_REFUSED', 'STAFF_NOTICE_MISSING']);
  const notice = at + MIN;
  const events = [...base, consentChanged(notice)];
  const planned = planActions(lesson, events, notice + SEC);
  assert.deepEqual(checks(planned), [[`decide:g1:${notice}`, 1]]);
  assert.deepEqual(starts(planActions(lesson, [...events, madeCheck(of(planned, 'DECIDE_RECORDING')[0], notice + SEC)], notice + 2 * SEC)), [['start:g1:1', [NEW]]]);
  // Without the authorization the same consent change starts nothing and checks nothing in case B.
  const unauthorized = events.filter(event => event.type !== 'server.recording_resume_authorized');
  const none = planActions(lesson, unauthorized, notice + SEC);
  assert.deepEqual([checks(none).length, starts(none).length], [0, 0]);
});

test('a withdrawal stays for the whole lesson: consent given again and a move afterwards bring no check and no start, in case A and in case B, even with an authorization and a passing check stored', () => {
  const withdrawn = server('server.consent_withdrawn', T + 2 * MIN, { participantId: STUDENT, key: `server.consent_withdrawn:${lesson.id}:w` });
  for (const before of [tutorOnlyInFirstRoom(), [...inFirstRoom(), ...recordedInFirstRoom(), recording(OLD, 'Stopped', T + 2 * MIN + 10 * SEC)]]) {
    const events = [...decided(true), ...before, withdrawn, consentChanged(T + 10 * MIN), ...movedIn(), authorized(1, MOVE + MIN),
      decision(true, MOVE + MIN + SEC, { generation: 1, key: `decide:${lesson.id}:g1:forged` })];
    const planned = planActions(lesson, events, MOVE + 2 * MIN);
    assert.deepEqual([checks(planned).length, starts(planned).length], [0, 0]);
    const state = deriveLesson(lesson, events, MOVE + 2 * MIN).roomRecording;
    assert.deepEqual([state.status, state.reason, state.canAuthorize], ['BLOCKED', 'CONSENT_WITHDRAWN', false]);
  }
});

test('an old room Zoom has not confirmed stopped blocks the new room even with a passing check, stays flagged and never reads as stopped; Zoom\'s answer that the session is over, or its end notice, lets the start follow (safe recovery)', () => {
  const at = MOVE + 2 * MIN;
  // Recorded by a start Zoom accepted (no notice since), then moved; the old room's stop was asked for.
  const accepted = [server('server.start_requested', T + MIN, { key: `start:${lesson.id}:1`, attempt: 1, targets: [OLD] }), server('server.start_response', T + MIN, { key: `start:${lesson.id}:1:response`, attempt: 1, ok: true, targets: [OLD] })];
  const events = [...decided(true), ...inFirstRoom(), ...accepted, ...movedIn(), authorized(1, MOVE + MIN), decision(true, MOVE + MIN + SEC, { generation: 1, key: `decide:${lesson.id}:g1:${MOVE + MIN}` }),
    server('server.stop_requested', MOVE + 30 * SEC, { key: `migrate:${lesson.id}:${OLD}:stop`, reason: 'old_room', attempt: 1, targets: [OLD] })];
  assert.deepEqual(starts(planActions(lesson, events, at)), []);
  const state = deriveLesson(lesson, events, at);
  assert.ok(state.anomalies.some(entry => entry.code === 'OLD_ROOM_STOP_UNCONFIRMED' && entry.severity === 'error'));
  assert.equal(state.sessions.find(entry => entry.id === OLD).capture, 'STOP_REQUESTED');
  assert.notEqual(state.recording.status, 'STOPPED');
  assert.equal(state.roomRecording.canAuthorize, false);
  for (const confirmation of [fact('api.snapshot', at + SEC, { providerSessionId: OLD, live: false, present: [] }, 'zoom_api'), fact('session.ended', at + SEC, { providerSessionId: OLD })]) {
    const recovered = [...events, confirmation];
    assert.deepEqual(starts(planActions(lesson, recovered, at + 2 * SEC)), [['start:g1:1', [NEW]]]);
    assert.ok(!deriveLesson(lesson, recovered, at + 2 * SEC).anomalies.some(entry => entry.code === 'OLD_ROOM_STOP_UNCONFIRMED'));
  }
});

test('never shown as stopped while any room may still record: the new room\'s confirmed stop does not make the lesson read as stopped while the old room has not confirmed; once it has, it does', () => {
  const at = MOVE + 3 * MIN;
  const events = [...decided(true), ...inFirstRoom(), ...recordedInFirstRoom(), ...movedIn(),
    server('server.stop_requested', MOVE + 30 * SEC, { key: `migrate:${lesson.id}:${OLD}:stop`, reason: 'old_room', attempt: 1, targets: [OLD] }),
    recording(NEW, 'Recording', MOVE + MIN), recording(NEW, 'Stopped', MOVE + 2 * MIN)];
  const state = deriveLesson(lesson, events, at);
  assert.deepEqual([state.recording.status, state.recording.pending], ['RECORDING', 'STOP_REQUESTED']);
  assert.deepEqual(state.sessions.map(entry => [entry.id, entry.capture]), [[OLD, 'STOP_REQUESTED'], [NEW, 'STOPPED']]);
  assert.equal(deriveLesson(lesson, [...events, recording(OLD, 'Stopped', at)], at + SEC).recording.status, 'STOPPED');
});

test('a later room\'s refused check never makes an earlier, approved recording look unapproved, and stops nothing', () => {
  const events = [...decided(true), ...inFirstRoom(), ...recordedInFirstRoom(), recording(OLD, 'Stopped', MOVE - MIN), ...movedIn(), authorized(1, MOVE + MIN),
    decision(false, MOVE + MIN + SEC, { generation: 1, reason: 'CONSENT_EXPIRED', key: `decide:${lesson.id}:g1:${MOVE + MIN}` })];
  const state = deriveLesson(lesson, events, MOVE + 2 * MIN);
  assert.ok(!state.anomalies.some(entry => entry.code === 'UNAPPROVED_RECORDING_START'));
  assert.deepEqual(of(planActions(lesson, events, MOVE + 2 * MIN), 'STOP_RECORDING'), []);
});

test('each generation has its own check: the second room\'s check counts for nothing in the third; consent given between the moves is read by the third room\'s own check', () => {
  const second = MOVE + 5 * MIN;
  const events = [...decided(false), ...tutorOnlyInFirstRoom(), ...movedIn(), decision(true, MOVE + MIN, { generation: 1, key: `decide:${lesson.id}:g1:${MOVE}` }), consentChanged(MOVE + 2 * MIN),
    generation(2, second), room(NEWER, second + 20 * SEC, 2), joined(NEWER, TUTOR, second + 20 * SEC), joined(NEWER, STUDENT, second + 30 * SEC)];
  const planned = planActions(lesson, events, second + MIN);
  assert.deepEqual(starts(planned), []);
  assert.deepEqual(checks(planned), [[`decide:g2:${second}`, 2]]);
  assert.deepEqual(starts(planActions(lesson, [...events, madeCheck(of(planned, 'DECIDE_RECORDING')[0], second + MIN)], second + MIN + SEC)), [['start:g2:1', [NEWER]]]);
});

test('the pages and the overview read the current room\'s latest check: refused shows as not recorded in the new room, with the reason; passed shows as allowed', () => {
  const base = [...decided(false), ...tutorOnlyInFirstRoom(), ...movedIn()];
  const refused = deriveLesson(lesson, [...base, decision(false, MOVE + MIN, { generation: 1, reason: 'CONSENT_EXPIRED', key: `decide:${lesson.id}:g1:${MOVE}` })], MOVE + 2 * MIN);
  assert.deepEqual([refused.recording.status, refused.recording.reason, refused.roomRecording.status], ['BLOCKED', 'CONSENT_EXPIRED', 'RECHECK_REFUSED']);
  const passed = deriveLesson(lesson, [...base, decision(true, MOVE + MIN, { generation: 1, key: `decide:${lesson.id}:g1:${MOVE}` })], MOVE + 2 * MIN);
  assert.deepEqual([passed.recording.status, passed.roomRecording.status], ['NOT_REQUESTED', 'ALLOWED']);
});
