// Synthetic tests for the recording controls added on 2026-11-08: recording stops on its own when
// the lesson is over, an administrator's emergency stop, and what the overview card shows of
// them and of each filed recording. Our rules only: nothing here says how real Zoom behaves.
import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveLesson, planActions, TIMING } from '../classroom/lesson-state.mjs';
import { lessonCard } from '../classroom/live-dashboard.mjs';
import { dedupeKeyOf } from '../classroom/webhook-ingest.mjs';
import { LESSON_START, makeLesson, MIN } from './fake-zoom.mjs';

const T = LESSON_START;
const SEC = 1000;
const lesson = makeLesson(0);
const END = Date.parse(lesson.endsAt);
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
const status = (value, at) => fact(
  { Recording: 'session.recording_started', Stopped: 'session.recording_stopped' }[value], at, { status: value },
);
const emergency = at => fact('server.emergency_stop', at, { key: `server.emergency_stop:${lesson.id}` }, 'server');
// The server event written when the server carries out an action, under the action's key.
const done = (action, at) => fact({
  START_RECORDING: 'server.start_requested', STOP_RECORDING: 'server.stop_requested', END_SESSION: 'server.session_end_requested', NOTIFY_ADMIN: 'server.admin_notified',
}[action.type], at, { key: action.key, attempt: action.attempt, reason: action.reason, channels: action.channels }, 'server');
// Both people in, Zoom confirmed recording a minute into the lesson, the tutor's page keeps beating.
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
// Runs the server's loop: plan at each time, and write what the server did.
function serve(events, times) {
  const all = [...events];
  for (const at of times) for (const action of planActions(lesson, all, at)) all.push(done(action, at));
  return all;
}

// --- The lesson is over -----------------------------------------------------------------------

test('class over: recording is not stopped at the scheduled end but after the grace, on the REST channel', () => {
  const events = [...recordingLesson(), ...beats(T, END + 10 * MIN)];
  const stopAt = END + TIMING.lessonEndStopMs;
  assert.equal(TIMING.lessonEndStopMs, 5 * MIN);
  assert.deepEqual(of(planActions(lesson, events, END + MIN), 'STOP_RECORDING'), [], 'one minute over: still recording');
  assert.deepEqual(of(planActions(lesson, events, stopAt - SEC), 'STOP_RECORDING'), []);
  const stops = of(planActions(lesson, events, stopAt), 'STOP_RECORDING');
  assert.deepEqual(stops.map(action => [action.reason, action.attempt, action.channels]), [['lesson_end', 1, ['rest']]]);
  assert.equal(deriveLesson(lesson, events, stopAt).recording.status, 'RECORDING');
});

test('class over and Zoom does not confirm: again at 30 s, the session is ended at 60 s, then flagged', () => {
  const stopAt = END + TIMING.lessonEndStopMs;
  const timeline = [stopAt, stopAt + 30 * SEC, stopAt + 60 * SEC];
  const events = serve([...recordingLesson(), ...beats(T, stopAt + 3 * MIN)], timeline);
  const actions = events.filter(event => event.source === 'server' && /^(stop|end):/.test(event.key)).map(event => event.key);
  assert.deepEqual(actions, [`stop:${lesson.id}:lesson_end:1`, `stop:${lesson.id}:lesson_end:2`, `end:${lesson.id}:lesson_end`]);
  // A minute after the end request, still no word from Zoom: an error the overview raises.
  assert.ok(!codes(deriveLesson(lesson, events, stopAt + 60 * SEC + 59 * SEC)).includes('LESSON_END_STOP_UNCONFIRMED'));
  const state = deriveLesson(lesson, events, stopAt + 2 * MIN);
  assert.ok(codes(state).includes('LESSON_END_STOP_UNCONFIRMED'));
  assert.equal(state.anomalies.find(entry => entry.code === 'LESSON_END_STOP_UNCONFIRMED').severity, 'error');
});

test('class over and Zoom confirms the stop: nothing more is sent, nothing is flagged', () => {
  const stopAt = END + TIMING.lessonEndStopMs;
  let events = serve([...recordingLesson(), ...beats(T, stopAt + 3 * MIN)], [stopAt]);
  events = [...events, status('Stopped', stopAt + 5 * SEC)];
  for (const at of [stopAt + 30 * SEC, stopAt + 60 * SEC, stopAt + 5 * MIN]) {
    assert.deepEqual(of(planActions(lesson, events, at), 'STOP_RECORDING').concat(of(planActions(lesson, events, at), 'END_SESSION')), []);
  }
  const state = deriveLesson(lesson, events, stopAt + 5 * MIN);
  assert.equal(state.recording.status, 'STOPPED');
  assert.ok(!codes(state).some(code => /UNCONFIRMED|UNEXPECTEDLY/.test(code)));
});

test('class over after everyone left and the session ended: no stop is sent to a finished session', () => {
  const events = [...recordingLesson(), status('Stopped', END - MIN), fact('session.ended', END - 30 * SEC)];
  assert.deepEqual(of(planActions(lesson, events, END + 10 * MIN), 'STOP_RECORDING'), []);
  assert.deepEqual(of(planActions(lesson, events, END + 10 * MIN), 'END_SESSION'), []);
});

test('a lesson still running past its end never starts a recording, even with consent and both people in', () => {
  const late = [eligibility(), fact('session.started', END + MIN), joined(TUTOR, END + MIN, 'u-t'), joined(STUDENT, END + MIN, 'u-s'), ...beats(END + MIN, END + 20 * MIN)];
  for (const at of [END + TIMING.lessonEndStopMs, END + 10 * MIN, END + 20 * MIN]) assert.deepEqual(of(planActions(lesson, late, at), 'START_RECORDING'), []);
  // Before the cut-off the same lesson would start.
  const early = [eligibility(), fact('session.started', END - 10 * MIN), joined(TUTOR, END - 10 * MIN, 'u-t'), joined(STUDENT, END - 10 * MIN, 'u-s'), ...beats(END - 10 * MIN, END)];
  assert.equal(of(planActions(lesson, early, END - 5 * MIN), 'START_RECORDING').length, 1);
});

// --- The emergency stop -----------------------------------------------------------------------

test('emergency stop while recording: stop on both channels at once, again at 30 s, end the session at 60 s', () => {
  const pressed = T + 20 * MIN;
  const events = serve([...recordingLesson(), ...beats(T, T + 25 * MIN), emergency(pressed)], [pressed, pressed + 30 * SEC, pressed + 60 * SEC]);
  const sent = events.filter(event => event.source === 'server' && /^(stop|end):/.test(event.key));
  assert.deepEqual(sent.map(event => event.key), [`stop:${lesson.id}:emergency_stop:1`, `stop:${lesson.id}:emergency_stop:2`, `end:${lesson.id}:emergency_stop`]);
  assert.deepEqual(sent[0].channels, ['rest', 'host']);
  const state = deriveLesson(lesson, events, pressed + 2 * MIN + 1);
  assert.ok(codes(state).includes('EMERGENCY_STOP'));
  assert.equal(state.anomalies.find(entry => entry.code === 'EMERGENCY_STOP').severity, 'warning');
  // Zoom never confirmed: the stop is not trusted, it is an error to handle.
  assert.equal(state.anomalies.find(entry => entry.code === 'EMERGENCY_STOP_UNCONFIRMED')?.severity, 'error');
  // Requested twice and the session ended on request, but nothing confirmed: never shown as stopped.
  assert.deepEqual(state.emergency, { at: pressed, stopState: 'WAITING' });
  assert.match(lessonCard(state, pressed + 2 * MIN + 1).emergency.stopLabel, /尚未確認停止/);
});

test('emergency stop confirmed by Zoom: the card says so, and the lesson is never recorded again', () => {
  const pressed = T + 20 * MIN;
  let events = serve([...recordingLesson(), ...beats(T, T + 40 * MIN), emergency(pressed)], [pressed]);
  events = [...events, status('Stopped', pressed + 3 * SEC)];
  for (const at of [pressed + 30 * SEC, pressed + 2 * MIN, pressed + 10 * MIN]) {
    const actions = planActions(lesson, events, at);
    assert.deepEqual([...of(actions, 'START_RECORDING'), ...of(actions, 'STOP_RECORDING'), ...of(actions, 'END_SESSION')], [], `${(at - pressed) / SEC} s after`);
  }
  const state = deriveLesson(lesson, events, pressed + 10 * MIN);
  assert.equal(state.recording.status, 'STOPPED');
  assert.ok(!codes(state).includes('EMERGENCY_STOP_UNCONFIRMED'));
  const card = lessonCard(state, pressed + 10 * MIN);
  assert.deepEqual(card.emergency, { pressedAt: new Date(pressed).toISOString(), stopState: 'CONFIRMED', stopLabel: '視訊服務已確認錄影停止', available: false });
  // The moment before Zoom's word, the same lesson only waits.
  const before = lessonCard(deriveLesson(lesson, events.filter(event => event.type !== 'session.recording_stopped'), pressed + 2 * SEC), pressed + 2 * SEC);
  assert.equal(before.emergency.stopState, 'WAITING');
});

test('emergency stop before anything was recorded: no start ever, the card says why, and a start anyway is flagged', () => {
  const pressed = T - 5 * MIN;
  const before = [eligibility(), fact('session.started', T - 3 * MIN), joined(TUTOR, T - 3 * MIN, 'u-t'), joined(STUDENT, T + MIN, 'u-s'), ...beats(T - 3 * MIN, T + 30 * MIN), emergency(pressed)];
  for (const at of [T + MIN + 10 * SEC, T + 10 * MIN, T + 30 * MIN]) assert.deepEqual(of(planActions(lesson, before, at), 'START_RECORDING'), []);
  const state = deriveLesson(lesson, before, T + 10 * MIN);
  assert.deepEqual([state.recording.status, state.recording.reason], ['BLOCKED', 'EMERGENCY_STOP']);
  assert.equal(lessonCard(state, T + 10 * MIN).recording.label, '已緊急停止，這堂課不再錄影');
  // Nothing was recording, and that is said as such: not as the video service's confirmation.
  const { emergency: pressedCard } = lessonCard(state, T + 10 * MIN);
  assert.equal(pressedCard.stopState, 'NO_RECORDING_KNOWN');
  assert.match(pressedCard.stopLabel, /這不是視訊服務的確認/);
  // Someone starts recording in Zoom anyway: flagged, and the protective stop goes out.
  const started = [...before, status('Recording', T + 12 * MIN)];
  assert.ok(codes(deriveLesson(lesson, started, T + 12 * MIN)).includes('UNAPPROVED_RECORDING_START'));
  assert.equal(of(planActions(lesson, started, T + 12 * MIN), 'STOP_RECORDING')[0]?.reason, 'emergency_stop');
});

test('the emergency stop is offered while recording could run or start, and not once the lesson is over and quiet', () => {
  const waiting = deriveLesson(lesson, [eligibility()], T - 10 * MIN);
  assert.equal(lessonCard(waiting, T - 10 * MIN).emergency.available, true);
  const live = deriveLesson(lesson, [...recordingLesson(), ...beats(T, T + 5 * MIN)], T + 5 * MIN);
  assert.equal(lessonCard(live, T + 5 * MIN).emergency.available, true);
  const over = deriveLesson(lesson, [...recordingLesson(), status('Stopped', END - MIN), fact('session.ended', END - 30 * SEC)], END + MIN);
  assert.equal(lessonCard(over, END + MIN).emergency.available, false);
});

// --- What the overview shows of each recording -----------------------------------------------

test('each kept recording is listed with P1\'s name, folder, size and Drive checksum; a vendor\'s name or link never is', () => {
  const video = { providerFileId: 'f-video', kind: 'composite', extension: 'mp4', size: 4096, status: 'completed', recordingStart: T + MIN, recordingEnd: END };
  const events = [
    ...recordingLesson(), status('Stopped', END), fact('session.ended', END + SEC),
    fact('session.recording_completed', END + 10 * MIN, { files: [video], download_url: 'https://example.invalid/vendor-link' }),
    fact('p1.filing', END + 11 * MIN, {
      providerFileId: 'f-video', status: 'STORED', key: 'p1.filing:f-video:STORED',
      name: '2026-11-03_TEST-S01_TEST-T01_P01.mp4', folder: '[iHear] 11.2026.Zoom Recordings / 2026-11-03_TEST-L001', size: 4096, md5: 'd41d8cd98f00b204e9800998ecf8427e', driveFileId: 'drive-file-1',
      destination: 'google',
    }, 'p1'),
  ];
  const card = lessonCard(deriveLesson(lesson, events, END + 12 * MIN), END + 12 * MIN);
  assert.equal(card.filing.status, 'STORED');
  assert.deepEqual(card.filing.items, [{
    // Which room the file was recorded in: none known here (the lesson never moved rooms).
    generation: null,
    extension: 'mp4', recordingStart: new Date(T + MIN).toISOString(), recordingEnd: new Date(END).toISOString(),
    status: 'STORED', destination: 'google', label: '已存入 Google Drive', reason: null, reasonLabel: null, at: new Date(END + 11 * MIN).toISOString(),
    name: '2026-11-03_TEST-S01_TEST-T01_P01.mp4', folder: '[iHear] 11.2026.Zoom Recordings / 2026-11-03_TEST-L001', size: 4096,
    md5: 'd41d8cd98f00b204e9800998ecf8427e', driveFileId: 'drive-file-1',
  }]);
  assert.doesNotMatch(JSON.stringify(card), /example\.invalid|vendor-link/);
  // A copy in the local stand-in (synthetic tests) never reads as Google Drive.
  const local = events.map(event => (event.type === 'p1.filing' ? { ...event, destination: 'local' } : event));
  const localItem = lessonCard(deriveLesson(lesson, local, END + 12 * MIN), END + 12 * MIN).filing.items[0];
  assert.deepEqual([localItem.destination, localItem.label], ['local', '已存入本機模擬 Drive（合成測試，不是 Google Drive）']);
  assert.doesNotMatch(localItem.label, /^已存入 Google Drive/);
  // Still on its way: listed as waiting, with Zoom's size and no name yet.
  const waiting = lessonCard(deriveLesson(lesson, events.slice(0, -1), END + 10 * MIN + SEC), END + 10 * MIN + SEC);
  assert.deepEqual(waiting.filing.items.map(item => [item.status, item.label, item.name, item.size]), [['PENDING', '等待歸檔', null, 4096]]);
});
