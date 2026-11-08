// Synthetic tests for stopping a cancelled lesson's recording on the server (2026-11-08, the
// P1+P3 integration worktree). The rules only: nothing here says how real Zoom behaves, and
// "requested" is never "stopped" until Zoom says so.
import test from 'node:test';
import assert from 'node:assert/strict';
import { cancellationKey, deriveLesson, planActions } from '../classroom/lesson-state.mjs';
import { lessonCard } from '../classroom/live-dashboard.mjs';
import { dedupeKeyOf } from '../classroom/webhook-ingest.mjs';
import { LESSON_START, makeLesson, MIN } from './fake-zoom.mjs';

const T = LESSON_START;
const SEC = 1000;
const lesson = makeLesson(0);
const cancelledLesson = { ...lesson, cancelled: true };
const TUTOR = lesson.participants[0].id;
const STUDENT = lesson.participants[1].id;

function fact(type, at, fields = {}, source = 'zoom_webhook') {
  const event = { type, source, lessonId: lesson.id, providerSessionId: 'sess-1', occurredAt: at, receivedAt: at, ...fields };
  return { ...event, key: fields.key ?? (source === 'server' ? `${type}:${at}` : `${dedupeKeyOf(event)}:${source}`) };
}
const eligibility = () => fact('server.recording_eligibility', T - 15 * MIN, { eligible: true, reason: 'ALL_CONSENTED', key: `decide:${lesson.id}` }, 'server');
const joined = (who, at, uuid) => fact('session.user_joined', at, { participantId: who, participantUuid: uuid });
const asked = (attempt, at) => [
  fact('server.start_requested', at, { attempt, key: `start:${lesson.id}:${attempt}` }, 'server'),
  fact('server.start_response', at, { attempt, ok: true, key: `start:${lesson.id}:${attempt}:response` }, 'server'),
];
const status = (value, at) => fact({ Recording: 'session.recording_started', Stopped: 'session.recording_stopped' }[value], at, { status: value });
const cancellation = at => fact('server.lesson_cancelled', at, { key: cancellationKey(lesson.id) }, 'server');
const done = (action, at) => fact({
  START_RECORDING: 'server.start_requested', STOP_RECORDING: 'server.stop_requested', END_SESSION: 'server.session_end_requested',
  NOTIFY_ADMIN: 'server.admin_notified', RECORD_CANCELLATION: 'server.lesson_cancelled', DECIDE_RECORDING: 'server.recording_eligibility', REMOVE_USER: 'server.remove_requested',
}[action.type], at, { key: action.key, attempt: action.attempt, reason: action.reason, channels: action.channels }, 'server');
const recordingLesson = () => [
  eligibility(), fact('session.started', T - 3 * MIN), joined(TUTOR, T - 3 * MIN, 'u-t'), joined(STUDENT, T + MIN, 'u-s'),
  ...asked(1, T + MIN + 5 * SEC), status('Recording', T + MIN + 7 * SEC),
];
const beats = (from, to) => {
  const list = [];
  for (let at = from; at <= to; at += 30 * SEC) list.push(fact('host.heartbeat', at, { participantId: TUTOR, key: `beat:${at}` }, 'host_sdk'));
  return list;
};
const of = (actions, type) => actions.filter(action => action.type === type);
const codes = state => state.anomalies.map(entry => entry.code);
// The server's loop: plan at each time and write what the server did, under each action's key.
function serve(target, events, times) {
  const all = [...events];
  for (const at of times) for (const action of planActions(target, all, at)) all.push(done(action, at));
  return all;
}
const sentKeys = events => events.filter(event => event.source === 'server' && /^(stop|end):/.test(event.key)).map(event => event.key);

test('cancelled while recording: stop on both channels at once, again at 30 s, end the session at 60 s; each once', () => {
  const at = T + 20 * MIN;
  const times = [at, at + 10 * SEC, at + 30 * SEC, at + 45 * SEC, at + 60 * SEC, at + 90 * SEC];
  const events = serve(cancelledLesson, [...recordingLesson(), ...beats(T, T + 25 * MIN), cancellation(at)], times);
  assert.deepEqual(sentKeys(events), [`stop:${lesson.id}:lesson_cancelled:1`, `stop:${lesson.id}:lesson_cancelled:2`, `end:${lesson.id}:lesson_cancelled`]);
  const first = events.find(event => event.key === `stop:${lesson.id}:lesson_cancelled:1`);
  assert.deepEqual(first.channels, ['rest', 'host']);
  assert.equal(first.occurredAt, at, 'the first stop goes out in the same tick as the cancellation');
  // Planning again changes nothing: every action has a fixed key.
  assert.deepEqual(of(planActions(cancelledLesson, events, at + 5 * MIN), 'STOP_RECORDING'), []);
  assert.deepEqual(of(planActions(cancelledLesson, events, at + 5 * MIN), 'END_SESSION'), []);
});

test('Zoom never confirms: the stop is not trusted and becomes an error a minute after the session end request', () => {
  const at = T + 20 * MIN;
  const events = serve(cancelledLesson, [...recordingLesson(), ...beats(T, T + 25 * MIN), cancellation(at)], [at, at + 30 * SEC, at + 60 * SEC]);
  const state = deriveLesson(cancelledLesson, events, at + 2 * MIN + 1);
  assert.equal(state.anomalies.find(entry => entry.code === 'LESSON_CANCELLED')?.severity, 'warning');
  assert.equal(state.anomalies.find(entry => entry.code === 'LESSON_CANCELLED_STOP_UNCONFIRMED')?.severity, 'error');
  assert.equal(state.cancellation.stopState, 'WAITING');
  assert.notEqual(state.recording.status, 'STOPPED');
  assert.equal(lessonCard(state, at + 2 * MIN).cancellation.stopLabel, '已送出停止請求，等待視訊服務確認（尚未確認停止）');
  // The administrator is notified of the error once.
  const notices = of(planActions(cancelledLesson, events, at + 2 * MIN + 1), 'NOTIFY_ADMIN').map(action => action.code);
  assert.ok(notices.includes('LESSON_CANCELLED_STOP_UNCONFIRMED'));
});

test('Zoom confirms the stop: nothing more is sent, nothing flagged, and the card says the video service confirmed it', () => {
  const at = T + 20 * MIN;
  let events = serve(cancelledLesson, [...recordingLesson(), ...beats(T, T + 25 * MIN), cancellation(at)], [at]);
  events = [...events, status('Stopped', at + 4 * SEC)];
  for (const time of [at + 30 * SEC, at + 60 * SEC, at + 5 * MIN]) {
    const actions = planActions(cancelledLesson, events, time);
    assert.deepEqual([...of(actions, 'STOP_RECORDING'), ...of(actions, 'END_SESSION')], []);
  }
  const state = deriveLesson(cancelledLesson, events, at + 5 * MIN);
  assert.equal(state.cancellation.stopState, 'CONFIRMED');
  assert.ok(!codes(state).some(code => /UNCONFIRMED/.test(code)));
  assert.equal(lessonCard(state, at + 5 * MIN).cancellation.stopLabel, '視訊服務已確認錄影停止');
});

test('cancelled before recording started: no start is ever sent, even with consent and both people confirmed in the room', () => {
  const events = [eligibility(), cancellation(T - 10 * MIN), fact('session.started', T - 3 * MIN), joined(TUTOR, T - 3 * MIN, 'u-t'), joined(STUDENT, T, 'u-s'), ...beats(T - 3 * MIN, T + 30 * MIN)];
  for (const at of [T, T + MIN, T + 10 * MIN, T + 30 * MIN]) assert.deepEqual(of(planActions(cancelledLesson, events, at), 'START_RECORDING'), [], `at +${(at - T) / MIN} min`);
  const state = deriveLesson(cancelledLesson, events, T + MIN);
  assert.deepEqual([state.recording.status, state.recording.reason], ['BLOCKED', 'LESSON_CANCELLED']);
  assert.equal(state.cancellation.stopState, 'NO_RECORDING_KNOWN');
  assert.equal(lessonCard(state, T + MIN).recording.label, '課程已取消，這堂課不再錄影');
  // Nothing was recording, so no stop is sent either.
  assert.deepEqual(of(planActions(cancelledLesson, events, T + MIN), 'STOP_RECORDING'), []);
  // The same lesson, not cancelled, would start.
  assert.equal(of(planActions(lesson, events.filter(event => event.type !== 'server.lesson_cancelled'), T + MIN), 'START_RECORDING').length, 1);
});

test('the cancelled flag without a stored cancellation (the cancel request failed part-way): the tick stores it and stops at once, then times the retries from it', () => {
  const found = T + 20 * MIN;
  const before = [...recordingLesson(), ...beats(T, T + 25 * MIN)];
  const first = planActions(cancelledLesson, before, found);
  assert.deepEqual(of(first, 'RECORD_CANCELLATION').map(action => action.key), [cancellationKey(lesson.id)]);
  assert.deepEqual(of(first, 'STOP_RECORDING').map(action => [action.key, action.channels]), [[`stop:${lesson.id}:lesson_cancelled:1`, ['rest', 'host']]]);
  assert.deepEqual(of(first, 'START_RECORDING'), []);
  // No retry or session end before the cancellation is stored: they are timed from it.
  assert.deepEqual([...of(first, 'END_SESSION'), ...of(first, 'STOP_RECORDING').filter(action => action.attempt === 2)], []);
  const events = serve(cancelledLesson, before, [found, found + 30 * SEC, found + 60 * SEC]);
  assert.equal(events.filter(event => event.type === 'server.lesson_cancelled').length, 1);
  assert.deepEqual(sentKeys(events), [`stop:${lesson.id}:lesson_cancelled:1`, `stop:${lesson.id}:lesson_cancelled:2`, `end:${lesson.id}:lesson_cancelled`]);
});

test('P3 stored the cancellation and the tick also sees the flag: the cancellation and the first stop are each stored once', () => {
  const at = T + 20 * MIN;
  const events = serve(cancelledLesson, [...recordingLesson(), cancellation(at)], [at, at + 5 * SEC, at + 10 * SEC]);
  assert.equal(events.filter(event => event.type === 'server.lesson_cancelled').length, 1);
  assert.equal(events.filter(event => event.key === `stop:${lesson.id}:lesson_cancelled:1`).length, 1);
});

test('a recording that starts again after the cancellation is flagged as unapproved and stopped again, in its own round', () => {
  const at = T + 20 * MIN;
  let events = serve(cancelledLesson, [...recordingLesson(), ...beats(T, T + 40 * MIN), cancellation(at)], [at]);
  events = [...events, status('Stopped', at + 4 * SEC)];
  // Zoom's automatic recording, or the host, starts it again five minutes later.
  const again = at + 5 * MIN;
  events = [...events, status('Recording', again)];
  const state = deriveLesson(cancelledLesson, events, again + SEC);
  assert.ok(codes(state).includes('UNAPPROVED_RECORDING_START'));
  events = serve(cancelledLesson, events, [again + SEC, again + 31 * SEC, again + 61 * SEC]);
  assert.deepEqual(sentKeys(events), [
    `stop:${lesson.id}:lesson_cancelled:1`,
    `stop:${lesson.id}:lesson_cancelled:r${again}:1`, `stop:${lesson.id}:lesson_cancelled:r${again}:2`, `end:${lesson.id}:lesson_cancelled:r${again}`,
  ]);
  // The server itself never asked for a start after the cancellation.
  assert.equal(events.filter(event => event.type === 'server.start_requested' && event.occurredAt > at).length, 0);
});

test('the same events in any order give the same plan', () => {
  const at = T + 20 * MIN;
  const events = [...recordingLesson(), ...beats(T, T + 25 * MIN), cancellation(at)];
  const expected = JSON.stringify(planActions(cancelledLesson, events, at + 61 * SEC));
  for (let seed = 1; seed <= 20; seed += 1) {
    const shuffled = [...events].sort((a, b) => ((a.occurredAt * 31 + seed * 7919) % 97) - ((b.occurredAt * 31 + seed * 7919) % 97) || String(a.key).localeCompare(String(b.key)));
    assert.equal(JSON.stringify(planActions(cancelledLesson, shuffled, at + 61 * SEC)), expected, `seed ${seed}`);
  }
});

test('an emergency stop and a cancellation together: one protective sequence, the emergency one, and still no start', () => {
  const at = T + 20 * MIN;
  const emergency = fact('server.emergency_stop', at - 10 * SEC, { key: `server.emergency_stop:${lesson.id}` }, 'server');
  const events = serve(cancelledLesson, [...recordingLesson(), ...beats(T, T + 25 * MIN), emergency, cancellation(at)], [at, at + 30 * SEC, at + 60 * SEC]);
  assert.deepEqual(sentKeys(events), [`stop:${lesson.id}:emergency_stop:1`, `stop:${lesson.id}:emergency_stop:2`, `end:${lesson.id}:emergency_stop`]);
  assert.deepEqual(of(planActions(cancelledLesson, events, at + 2 * MIN), 'START_RECORDING'), []);
});
