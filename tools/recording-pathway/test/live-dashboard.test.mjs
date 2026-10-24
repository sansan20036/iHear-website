// Synthetic tests for the live classroom overview: lesson state from events, what the server
// does next, reconciliation, the dashboard cards and who may see them. The concurrent runs use
// the simulated Zoom in fake-zoom.mjs: they check our logic for 2, 5 and 10 rooms at once and
// do not show how many recordings real Zoom can run at the same time.
import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveLesson, dueReconciliations, planActions, TIMING } from '../classroom/lesson-state.mjs';
import { buildDashboard, canObserve, canViewDashboard, dashboardAccess, DASHBOARD_HEADERS, lessonCard } from '../classroom/live-dashboard.mjs';
import { dedupeKeyOf, minimizeZoomEvent, normalizeApiSnapshot } from '../classroom/webhook-ingest.mjs';
import { cardsByCode, EXPECTED_FINAL, LESSON_START, makeLesson, MIN, PLANTED, runSimulation, SCENARIOS } from './fake-zoom.mjs';

const T = LESSON_START;
const SEC = 1000;
const lesson = makeLesson(0);
const TUTOR = lesson.participants[0].id;
const STUDENT = lesson.participants[1].id;
const iso = value => new Date(value).toISOString();

function fact(type, at, fields = {}, source = 'zoom_webhook') {
  const event = { type, source, lessonId: lesson.id, providerSessionId: 'sess-1', occurredAt: at, receivedAt: at, ...fields };
  return { ...event, key: fields.key ?? (source === 'server' ? `${type}:${at}` : `${dedupeKeyOf(event)}:${source}`) };
}
const eligibility = (eligible = true) => fact('server.recording_eligibility', T - 15 * MIN, { eligible, reason: eligible ? 'ALL_CONSENTED' : 'CONSENT_MISSING', key: `decide:${lesson.id}` }, 'server');
const started = (at = T - 3 * MIN, session = 'sess-1') => fact('session.started', at, { providerSessionId: session });
const joinedFact = (who, at, uuid, session = 'sess-1') => fact('session.user_joined', at, { participantId: who, participantUuid: uuid, providerSessionId: session });
const leftFact = (who, at, reason, uuid) => fact('session.user_left', at, { participantId: who, participantUuid: uuid, leaveReason: reason });
const beat = at => fact('host.heartbeat', at, { participantId: TUTOR, key: `host:host.heartbeat:${lesson.id}` }, 'host_sdk');
const recording = (status, at, source = 'zoom_webhook', fields = {}) => (source === 'host_sdk'
  ? fact('host.recording_status', at, { status, participantId: TUTOR, ...fields }, 'host_sdk')
  : fact({ Recording: 'session.recording_started', Paused: 'session.recording_paused', Stopped: 'session.recording_stopped' }[status], at, { status, ...fields }));
const endedFact = (at, session = 'sess-1') => fact('session.ended', at, { providerSessionId: session });
const videoFile = { providerFileId: 'f-video', kind: 'shared_screen_with_speaker_view', extension: 'mp4', size: 64, status: 'completed', recordingStart: T + MIN, recordingEnd: T + 60 * MIN };
const completedFact = at => fact('session.recording_completed', at, { files: [videoFile] });
const filed = (status, at) => fact('p1.filing', at, { providerFileId: 'f-video', status, key: `p1.filing:f-video:${status}` }, 'p1');
function asked(attempt, at, ok = true) {
  return [
    fact('server.start_requested', at, { attempt, key: `start:${lesson.id}:${attempt}` }, 'server'),
    fact('server.start_response', at, { attempt, ok, key: `start:${lesson.id}:${attempt}:response` }, 'server'),
  ];
}
// The server event written when the server carries out an action, under the action's key.
function done(action, at) {
  const type = {
    START_RECORDING: 'server.start_requested',
    STOP_RECORDING: 'server.stop_requested',
    END_SESSION: 'server.session_end_requested',
    REMOVE_USER: 'server.remove_requested',
    NOTIFY_ADMIN: 'server.admin_notified',
  }[action.type];
  return fact(type, at, { key: action.key, attempt: action.attempt, reason: action.reason }, 'server');
}
const base = () => [eligibility(), started(), joinedFact(TUTOR, T - 3 * MIN, 'u-t'), joinedFact(STUDENT, T + MIN, 'u-s')];
const recordingLesson = () => [...base(), ...asked(1, T + MIN + 5 * SEC), recording('Recording', T + MIN + 7 * SEC)];
const types = actions => actions.map(action => action.type);
const codes = state => state.anomalies.map(entry => entry.code);

function seeded(seed) {
  let value = seed >>> 0;
  return () => {
    value = (value + 0x6d2b79f5) >>> 0;
    let x = Math.imul(value ^ (value >>> 15), 1 | value);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffled(list, random) {
  const copy = [...list];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

const EXPECTED = EXPECTED_FINAL;
const RUNS = {
  2: ['normal', 'consent_withdrawn'],
  5: ['normal', 'no_consent', 'late_webhooks', 'tutor_shutdown', 'consent_withdrawn'],
  10: Object.keys(SCENARIOS),
};

test('2, 5 and 10 concurrent lessons each end in their own expected state, as if each ran alone', async () => {
  for (const [size, scenarios] of Object.entries(RUNS)) {
    const run = await runSimulation({ scenarios });
    const cards = cardsByCode(run.final);
    assert.equal(cards.size, Number(size));
    for (const [index, name] of scenarios.entries()) {
      const { group, card } = cards.get(makeLesson(index).code);
      const expected = EXPECTED[name];
      assert.deepEqual(
        { group, recording: card.recording.status, filing: card.filing.status, anomalies: card.anomalies.map(entry => entry.code) },
        expected,
        `${size} rooms, ${name}`,
      );
      // Same lesson alone: the same final card. Concurrency changes nothing for any room.
      const alone = await runSimulation({ scenarios: [name], indexes: [index] });
      assert.deepEqual(cardsByCode(alone.final).get(card.lessonCode).card, card, `${name} alone vs with ${size} rooms`);
    }
    // Every stored recording has exactly one copy in Drive.
    const stored = run.store.fileRecords().filter(record => record.status === 'STORED' || record.status === 'QUARANTINED');
    for (const record of stored) assert.equal(run.drive.activeFiles().filter(file => file.appProperties.providerFileId === record.providerFileId).length, 1);
    assert.equal(run.drive.activeFiles().length, stored.length);
    assert.ok(run.stats.maxHeavyPerMinute <= 20, `REST budget: ${run.stats.maxHeavyPerMinute} heavy calls per minute`);
  }
});

test('a database outage answers 503, Zoom retries, and nothing is lost or filed twice', async () => {
  const run = await runSimulation({ scenarios: Object.keys(SCENARIOS), databaseOutage: { from: T + 59.5 * MIN, to: T + 61 * MIN } });
  assert.ok(run.stats.retriedDeliveries > 0, 'some deliveries were retried');
  assert.ok(run.store.counters.failedTransactions > 0);
  assert.equal(run.stats.lostAfterRetries, 0);
  const cards = cardsByCode(run.final);
  for (const [index, name] of Object.keys(SCENARIOS).entries()) {
    const { group, card } = cards.get(makeLesson(index).code);
    assert.deepEqual({ group, recording: card.recording.status, filing: card.filing.status }, { group: EXPECTED[name].group, recording: EXPECTED[name].recording, filing: EXPECTED[name].filing }, name);
  }
  const keys = run.store.events().map(event => event.key);
  assert.equal(new Set(keys).size, keys.length);
  assert.equal(run.store.events().filter(event => event.type === 'p1.filing' && event.status === 'STORED').length, run.drive.activeFiles().filter(file => run.drive.folderName(file.parentId) !== '_待確認').length);
});

test('an accepted start request (202) is only "start requested"; Zoom has to confirm recording', () => {
  const events = [...base(), beat(T + MIN + 5 * SEC), ...asked(1, T + MIN + 5 * SEC)];
  const waiting = deriveLesson(lesson, events, T + MIN + 10 * SEC);
  assert.deepEqual([waiting.recording.status, waiting.recording.basis], ['START_REQUESTED', 'requested']);
  assert.equal(lessonCard(waiting, T + MIN + 10 * SEC).recording.label, '已送出錄影啟動請求');
  assert.equal(types(planActions(lesson, events, T + MIN + 10 * SEC)).includes('START_RECORDING'), false);
  const byHost = deriveLesson(lesson, [...events, recording('Recording', T + MIN + 7 * SEC, 'host_sdk')], T + MIN + 10 * SEC);
  assert.deepEqual([byHost.recording.status, byHost.recording.basis, byHost.recording.source], ['RECORDING', 'confirmed', 'host_sdk']);
  const byWebhook = deriveLesson(lesson, [...events, recording('Recording', T + MIN + 7 * SEC)], T + MIN + 10 * SEC);
  assert.equal(byWebhook.recording.source, 'zoom_webhook');
});

test('no confirmation within two minutes is a presumed failure; a late confirmation turns it back', () => {
  const events = [...base(), ...asked(1, T + MIN + 5 * SEC)];
  const now = T + 3 * MIN + 5 * SEC;
  const failed = deriveLesson(lesson, [...events, beat(now - 5 * SEC)], now);
  assert.deepEqual([failed.recording.status, failed.recording.basis, failed.recording.reason], ['FAILED', 'inferred', 'START_UNCONFIRMED']);
  assert.equal(lessonCard(failed, now).recording.label, '錄影失敗（推測）');
  assert.deepEqual(codes(failed), ['START_UNCONFIRMED']);
  assert.equal(failed.dataState.value, 'ANOMALY');
  const retry = planActions(lesson, [...events, beat(now - 5 * SEC)], now).find(action => action.type === 'START_RECORDING');
  assert.deepEqual([retry.attempt, retry.key], [2, `start:${lesson.id}:2`]);
  // The webhook for the first request finally arrives.
  const late = recording('Recording', T + MIN + 7 * SEC, 'zoom_webhook', { receivedAt: T + 3 * MIN + 30 * SEC });
  const fixed = deriveLesson(lesson, [...events, beat(now), late], T + 3 * MIN + 35 * SEC);
  assert.deepEqual([fixed.recording.status, fixed.recording.lateConfirmation], ['RECORDING', true]);
  assert.equal(lessonCard(fixed, T + 3 * MIN + 35 * SEC).recording.label, '錄影中（延遲確認）');
  assert.deepEqual(codes(fixed), []);
});

test('three API errors in a row are a recording failure, with retries spaced 10 and 30 seconds', () => {
  const t1 = T + MIN + 5 * SEC;
  const after = (events, now) => planActions(lesson, [...events, beat(now)], now).filter(action => action.type === 'START_RECORDING');
  const first = [...base(), ...asked(1, t1, false)];
  assert.deepEqual(after(first, t1 + 9 * SEC), []);
  assert.equal(after(first, t1 + 10 * SEC)[0].attempt, 2);
  assert.equal(lessonCard(deriveLesson(lesson, [...first, beat(t1)], t1 + SEC), t1 + SEC).recording.label, '已送出錄影啟動請求（重試中）');
  const second = [...first, ...asked(2, t1 + 10 * SEC, false)];
  assert.deepEqual(after(second, t1 + 39 * SEC), []);
  assert.equal(after(second, t1 + 40 * SEC)[0].attempt, 3);
  const third = [...second, ...asked(3, t1 + 40 * SEC, false)];
  const state = deriveLesson(lesson, [...third, beat(t1 + 41 * SEC)], t1 + 41 * SEC);
  assert.deepEqual([state.recording.status, state.recording.basis, state.recording.reason], ['FAILED', 'confirmed', 'START_API_ERROR']);
  assert.deepEqual(codes(state), ['RECORDING_FAILED']);
  assert.deepEqual(after(third, t1 + 5 * MIN), []);
});

test('lateness comes only from a real join time, not from a heartbeat or a snapshot', () => {
  // The join webhook is late; until it arrives only the heartbeat says the tutor is there.
  const early = [eligibility(), started(), joinedFact(STUDENT, T + MIN, 'u-s'), beat(T + 30 * MIN)];
  assert.equal(deriveLesson(lesson, early, T + 30 * MIN).attendance[0].late, false);
  const joinedLate = [...early, joinedFact(TUTOR, T + 8 * MIN, 'u-t')];
  assert.equal(deriveLesson(lesson, joinedLate, T + 30 * MIN).attendance[0].late, true);
  assert.equal(lessonCard(deriveLesson(lesson, joinedLate, T + 30 * MIN), T + 30 * MIN).tutor.label, '在線，遲到');
});

test('an event delivered twice counts once', () => {
  const blocked = fact('server.join_blocked', T + 2 * MIN, { reason: 'IDENTITY_UNVERIFIED', key: 'blocked:1' }, 'server');
  const events = [...recordingLesson(), beat(T + 5 * MIN), blocked];
  const once = deriveLesson(lesson, events, T + 5 * MIN);
  const twice = deriveLesson(lesson, [...events, ...events.map(event => ({ ...event }))], T + 5 * MIN);
  assert.deepEqual(twice, once);
  assert.equal(once.anomalies.find(entry => entry.code === 'JOIN_BLOCKED').count, 1);
});

test('the same events in any of 50 arrival orders give the same state', () => {
  const events = [
    ...recordingLesson(),
    fact('host.connection', T + 20 * MIN, { participantId: TUTOR, state: 'Reconnecting' }, 'host_sdk'),
    fact('host.connection', T + 20 * MIN + 20 * SEC, { participantId: TUTOR, state: 'Connected' }, 'host_sdk'),
    fact('host.participant_failover', T + 30 * MIN, { participantId: STUDENT }, 'host_sdk'),
    joinedFact(STUDENT, T + 31 * MIN, 'u-s2'),
    fact('session.alert', T + 31 * MIN, { issues: ['call reconnection'] }),
    recording('Stopped', T + 60 * MIN),
    leftFact(STUDENT, T + 60 * MIN + 10 * SEC, 'LEFT', 'u-s2'),
    leftFact(TUTOR, T + 60 * MIN + 20 * SEC, 'LEFT', 'u-t'),
    endedFact(T + 60 * MIN + 20 * SEC),
    completedFact(T + 75 * MIN),
    filed('STORED', T + 76 * MIN),
    beat(T + 60 * MIN),
  ];
  for (const now of [T + 25 * MIN, T + 61 * MIN, T + 80 * MIN]) {
    const expected = deriveLesson(lesson, events, now);
    const random = seeded(20261103);
    for (let i = 0; i < 50; i++) assert.deepEqual(deriveLesson(lesson, shuffled(events, random), now), expected);
  }
});

test('a lost session.ended is first inferred from everyone leaving, then confirmed by reconciliation', () => {
  const events = [...recordingLesson(), beat(T + 60 * MIN), leftFact(STUDENT, T + 60 * MIN, 'LEFT', 'u-s'), leftFact(TUTOR, T + 60 * MIN + 30 * SEC, 'LEFT', 'u-t')];
  const now = T + 61 * MIN;
  const inferred = deriveLesson(lesson, events, now);
  assert.deepEqual([inferred.phase.value, inferred.phase.basis], ['ENDED', 'inferred']);
  assert.deepEqual([inferred.recording.status, inferred.recording.basis], ['POSSIBLY_STOPPED', 'inferred']);
  assert.equal(inferred.dataState.value, 'DELAYED');
  assert.equal(lessonCard(inferred, now).phase.label, '已結束（推測）');
  assert.equal(dueReconciliations([lesson], new Map([[lesson.id, events]]), now)[0].reason, 'end_unconfirmed');
  const snapshot = normalizeApiSnapshot({
    lessonId: lesson.id, providerSessionId: 'sess-1', observedAt: now,
    details: { start_time: iso(T - 3 * MIN), end_time: iso(T + 60 * MIN + 30 * SEC) },
    users: [{ user_key: TUTOR, participant_uuid: 'u-t', join_time: iso(T - 3 * MIN), leave_time: iso(T + 60 * MIN + 30 * SEC) }],
  });
  const confirmed = deriveLesson(lesson, [...events, ...snapshot], now);
  assert.deepEqual([confirmed.phase.value, confirmed.phase.basis], ['ENDED', 'confirmed']);
  assert.equal(confirmed.recording.status, 'POSSIBLY_STOPPED');
});

test('a late recording file: a warning at 30 minutes, an error at 6 hours, then completed and filed', () => {
  const events = [
    ...recordingLesson(),
    recording('Stopped', T + 60 * MIN),
    leftFact(STUDENT, T + 60 * MIN + 10 * SEC, 'LEFT', 'u-s'),
    leftFact(TUTOR, T + 60 * MIN + 20 * SEC, 'LEFT', 'u-t'),
    endedFact(T + 60 * MIN + 20 * SEC),
  ];
  const at = minutes => deriveLesson(lesson, events, T + 60 * MIN + minutes * MIN);
  assert.equal(lessonCard(at(29), T + 89 * MIN).recording.label, '已停止，等待錄影檔');
  assert.deepEqual(codes(at(29)), []);
  assert.deepEqual(at(30).anomalies.map(entry => [entry.code, entry.severity]), [['FILE_OVERDUE', 'warning']]);
  assert.equal(at(30).dataState.value, 'DELAYED');
  assert.deepEqual(at(360).anomalies.map(entry => [entry.code, entry.severity]), [['FILE_OVERDUE', 'error']]);
  assert.equal(at(360).dataState.value, 'ANOMALY');
  // Reconciliation looks for the file at 30 minutes, then every 30 minutes.
  const byLesson = new Map([[lesson.id, events]]);
  assert.equal(dueReconciliations([lesson], byLesson, T + 90 * MIN)[0].reason, 'file_overdue');
  assert.deepEqual(dueReconciliations([lesson], byLesson, T + 91 * MIN, { lastReconciledAt: new Map([[lesson.id, T + 90 * MIN]]) }), []);
  assert.equal(dueReconciliations([lesson], byLesson, T + 120 * MIN, { lastReconciledAt: new Map([[lesson.id, T + 90 * MIN]]) })[0].reason, 'file_overdue');
  const arrived = deriveLesson(lesson, [...events, completedFact(T + 7 * 60 * MIN)], T + 7 * 60 * MIN);
  assert.deepEqual([arrived.recording.status, arrived.filing.status, codes(arrived)], ['COMPLETED', 'PENDING', []]);
  assert.equal(lessonCard(arrived, T + 7 * 60 * MIN).filing.label, '歸檔中');
  const stored = deriveLesson(lesson, [...events, completedFact(T + 7 * 60 * MIN), filed('STORED', T + 7 * 60 * MIN + MIN)], T + 7 * 60 * MIN + MIN);
  assert.equal(lessonCard(stored, T + 7 * 60 * MIN + MIN).filing.label, '已歸檔');
  assert.equal(stored.dataState.value, 'REALTIME');
});

test('a tutor whose computer is switched off: possibly offline, confirmed gone, recording stopped, session ended, filed', () => {
  let events = [...recordingLesson(), beat(T + 29 * MIN + 50 * SEC)];
  const tutorAt = now => deriveLesson(lesson, events, now).attendance.find(entry => entry.role === 'tutor');
  assert.equal(tutorAt(T + 30 * MIN + 30 * SEC).status, 'PRESENT');
  const quiet = deriveLesson(lesson, events, T + 31 * MIN);
  assert.deepEqual([tutorAt(T + 31 * MIN).status, tutorAt(T + 31 * MIN).basis], ['POSSIBLY_OFFLINE', 'inferred']);
  assert.equal(lessonCard(quiet, T + 31 * MIN).tutor.label, '可能離線（推測）');
  assert.equal(quiet.dataState.value, 'DELAYED');
  assert.equal(dueReconciliations([lesson], new Map([[lesson.id, events]]), T + 31 * MIN)[0].reason, 'host_signal_lost');
  // A REST snapshot still lists the tutor (Zoom keeps a dropped connection for about two
  // minutes): present, as Zoom says, but the host's own signal is reported lost.
  const listed = normalizeApiSnapshot({
    lessonId: lesson.id, providerSessionId: 'sess-1', observedAt: T + 30 * MIN + 55 * SEC, details: { start_time: iso(T - 3 * MIN) },
    users: [{ user_key: TUTOR, participant_uuid: 'u-t', join_time: iso(T - 3 * MIN) }, { user_key: STUDENT, participant_uuid: 'u-s', join_time: iso(T + MIN) }],
  });
  const stillListed = deriveLesson(lesson, [...events, ...listed], T + 31 * MIN);
  assert.deepEqual([stillListed.attendance[0].status, stillListed.attendance[0].basis], ['PRESENT', 'confirmed']);
  assert.deepEqual(stillListed.anomalies.map(entry => [entry.code, entry.severity]), [['HOST_SIGNAL_LOST', 'warning']]);
  assert.equal(stillListed.dataState.value, 'DELAYED');
  // Zoom drops the tutor after two minutes without a connection.
  events = [...events, leftFact(TUTOR, T + 32 * MIN, 'DISCONNECTED', 'u-t')];
  const gone = deriveLesson(lesson, events, T + 32 * MIN + 5 * SEC);
  assert.deepEqual([gone.attendance[0].status, gone.attendance[0].basis], ['LEFT', 'confirmed']);
  assert.equal(lessonCard(gone, T + 32 * MIN + 5 * SEC).tutor.label, '已離開（斷線）');
  assert.deepEqual(types(planActions(lesson, events, T + 36 * MIN + 59 * SEC)), []);
  const stop = planActions(lesson, events, T + 37 * MIN).find(action => action.type === 'STOP_RECORDING');
  assert.equal(stop.reason, 'tutor_absent');
  events = [...events, done(stop, T + 37 * MIN), recording('Stopped', T + 37 * MIN + 2 * SEC)];
  assert.equal(deriveLesson(lesson, events, T + 38 * MIN).recording.status, 'STOPPED');
  const end = planActions(lesson, events, T + 47 * MIN).find(action => action.type === 'END_SESSION');
  assert.equal(end.reason, 'tutor_absent');
  events = [...events, done(end, T + 47 * MIN), leftFact(STUDENT, T + 47 * MIN + SEC, 'HOST_ENDED', 'u-s'), endedFact(T + 47 * MIN + SEC)];
  const ended = deriveLesson(lesson, events, T + 48 * MIN);
  assert.deepEqual([ended.phase.value, ended.phase.basis], ['ENDED', 'confirmed']);
  events = [...events, completedFact(T + 57 * MIN), filed('STORED', T + 58 * MIN)];
  const finished = deriveLesson(lesson, events, T + 58 * MIN);
  assert.deepEqual([finished.recording.status, finished.filing.status, finished.dataState.value], ['COMPLETED', 'STORED', 'REALTIME']);
});

test('inference is never shown as confirmation, on any card of the concurrent runs', async () => {
  const checkpoints = Array.from({ length: 60 }, (_, index) => T - 10 * MIN + index * 2.5 * MIN);
  const run = await runSimulation({ scenarios: Object.keys(SCENARIOS), checkpoints });
  const storedFor = new Set(run.store.events().filter(event => event.type === 'p1.filing' && event.status === 'STORED').map(event => event.lessonId));
  let cards = 0;
  for (const { dashboard } of run.snapshots) {
    for (const card of Object.values(dashboard.groups).flat()) {
      cards += 1;
      const { recording: rec, phase } = card;
      if (['RECORDING', 'PAUSED', 'STOPPED', 'COMPLETED'].includes(rec.status)) assert.equal(rec.basis, 'confirmed', `${card.lessonCode} ${rec.status}`);
      if (rec.basis === 'inferred') assert.match(rec.label, /（推測）/);
      if (rec.status === 'POSSIBLY_STOPPED') assert.equal(rec.basis, 'inferred');
      if (phase.basis === 'inferred') assert.match(phase.label, /（推測）/);
      for (const person of [card.tutor, ...card.students]) {
        if (person.status === 'POSSIBLY_OFFLINE') assert.equal(person.basis, 'inferred');
        if (person.basis === 'inferred' && person.status !== 'NOT_JOINED') assert.match(person.label, /推測/);
      }
      if (card.filing.status === 'STORED') assert.ok(storedFor.has(`L-TEST-${card.lessonCode.slice(-3)}`));
    }
  }
  assert.equal(cards, 600);
});

test('realtime turns to delayed when confirmations stop, and an error-level anomaly puts the lesson under 異常', () => {
  const events = [eligibility(false), started(), joinedFact(TUTOR, T - 3 * MIN, 'u-t'), joinedFact(STUDENT, T + MIN, 'u-s'), beat(T + 10 * MIN)];
  assert.equal(deriveLesson(lesson, events, T + 10 * MIN + 30 * SEC).dataState.value, 'REALTIME');
  assert.equal(deriveLesson(lesson, events, T + 10 * MIN + 91 * SEC).dataState.value, 'DELAYED');
  const unknown = joinedFact('P-TEST-X99', T + 10 * MIN, 'u-x');
  const dashboard = buildDashboard({ lessons: [lesson], events: [...events, unknown], now: T + 10 * MIN + 10 * SEC });
  assert.deepEqual(dashboard.counts, { ANOMALY: 1, LIVE: 0, WAITING: 0, ENDED: 0 });
  const [card] = dashboard.groups.ANOMALY;
  assert.deepEqual([card.phase.value, card.dataState.value, card.dataState.label], ['LIVE', 'ANOMALY', '異常']);
});

test('recording we never started is an anomaly, and is stopped when the lesson may not be recorded', () => {
  const auto = recording('Recording', T - 3 * MIN + 3 * SEC);
  const blocked = [eligibility(false), started(), joinedFact(TUTOR, T - 3 * MIN, 'u-t'), beat(T - 2 * MIN), auto];
  const state = deriveLesson(lesson, blocked, T - 2 * MIN);
  assert.deepEqual(codes(state), ['UNAPPROVED_RECORDING_START']);
  const stop = planActions(lesson, blocked, T - 2 * MIN).find(action => action.type === 'STOP_RECORDING');
  assert.deepEqual([stop.reason, stop.channels], ['unapproved_start', ['rest', 'host']]);
  // With consent in place a start nobody asked for is still flagged, but not stopped.
  const allowed = [eligibility(true), started(), joinedFact(TUTOR, T - 3 * MIN, 'u-t'), beat(T - 2 * MIN), auto];
  assert.deepEqual(codes(deriveLesson(lesson, allowed, T - 2 * MIN)), ['UNAPPROVED_RECORDING_START']);
  assert.deepEqual(types(planActions(lesson, allowed, T - 2 * MIN)), ['NOTIFY_ADMIN']);
});

test('without consent the lesson runs normally and recording is never requested', () => {
  const events = [eligibility(false), started(), joinedFact(TUTOR, T - 3 * MIN, 'u-t'), joinedFact(STUDENT, T + MIN, 'u-s'), beat(T + 5 * MIN)];
  const state = deriveLesson(lesson, events, T + 5 * MIN);
  assert.deepEqual([state.phase.value, state.recording.status, codes(state)], ['LIVE', 'BLOCKED', []]);
  assert.equal(lessonCard(state, T + 5 * MIN).recording.label, '不錄影（同意條件不符）');
  assert.deepEqual(state.attendance.map(entry => entry.status), ['PRESENT', 'PRESENT']);
  assert.deepEqual(planActions(lesson, events, T + 5 * MIN), []);
});

test('consent withdrawn mid-lesson: two stop channels at once, again at 30 s, the session ended at 60 s, nothing restarted', () => {
  const W = T + 20 * MIN;
  const withdrawn = fact('server.consent_withdrawn', W, { participantId: STUDENT, key: 'withdrawn' }, 'server');
  let events = [...recordingLesson(), beat(W), withdrawn];
  const first = planActions(lesson, events, W);
  assert.deepEqual(first.map(action => [action.type, action.attempt, action.channels]), [['STOP_RECORDING', 1, ['rest', 'host']]]);
  events = [...events, done(first[0], W)];
  assert.equal(lessonCard(deriveLesson(lesson, events, W + 10 * SEC), W + 10 * SEC).recording.label, '錄影中（已送出停止請求）');
  assert.deepEqual(types(planActions(lesson, [...events, beat(W + 29 * SEC)], W + 29 * SEC)), []);
  const second = planActions(lesson, [...events, beat(W + 30 * SEC)], W + 30 * SEC);
  assert.deepEqual(second.map(action => [action.type, action.attempt]), [['STOP_RECORDING', 2]]);
  events = [...events, done(second[0], W + 30 * SEC)];
  const end = planActions(lesson, [...events, beat(W + 60 * SEC)], W + 60 * SEC);
  assert.deepEqual(types(end), ['END_SESSION']);
  events = [...events, done(end[0], W + 60 * SEC)];
  // Still no confirmation a minute after asking Zoom to end the session.
  const unconfirmed = deriveLesson(lesson, [...events, beat(W + 120 * SEC)], W + 120 * SEC);
  assert.ok(codes(unconfirmed).includes('WITHDRAWAL_STOP_UNCONFIRMED'));
  assert.deepEqual(types(planActions(lesson, [...events, beat(W + 120 * SEC)], W + 120 * SEC)), ['NOTIFY_ADMIN']);
  // Zoom confirms the end; the class carries on in a new, unrecorded session.
  events = [...events, leftFact(STUDENT, W + 61 * SEC, 'HOST_ENDED', 'u-s'), leftFact(TUTOR, W + 61 * SEC, 'HOST_ENDED', 'u-t'), endedFact(W + 61 * SEC)];
  const over = deriveLesson(lesson, events, W + 125 * SEC);
  assert.equal(codes(over).includes('WITHDRAWAL_STOP_UNCONFIRMED'), false);
  assert.deepEqual([over.recording.status, over.withdrawal.captureStopped], ['POSSIBLY_STOPPED', true]);
  events = [...events, started(W + 91 * SEC, 'sess-2'), joinedFact(TUTOR, W + 91 * SEC, 'u-t2', 'sess-2'), joinedFact(STUDENT, W + 92 * SEC, 'u-s2', 'sess-2'), beat(W + 3 * MIN)];
  const resumed = deriveLesson(lesson, events, W + 3 * MIN);
  assert.equal(resumed.phase.value, 'LIVE');
  assert.equal(types(planActions(lesson, events, W + 3 * MIN)).includes('START_RECORDING'), false);
  // If Zoom had confirmed the first stop, nothing more would have been sent.
  const quick = [...recordingLesson(), beat(W), withdrawn, done(first[0], W), recording('Stopped', W + 3 * SEC)];
  assert.deepEqual(types(planActions(lesson, [...quick, beat(W + 2 * MIN)], W + 2 * MIN)), []);
  assert.equal(deriveLesson(lesson, quick, W + 2 * MIN).recording.status, 'STOPPED');
});

test('an unknown person in the room is flagged, removed, and the recording is stopped', () => {
  const events = [...recordingLesson(), beat(T + 10 * MIN), joinedFact('P-TEST-X99', T + 10 * MIN, 'u-x')];
  const state = deriveLesson(lesson, events, T + 10 * MIN);
  assert.deepEqual(state.anomalies.find(entry => entry.code === 'UNKNOWN_PARTICIPANT'), { code: 'UNKNOWN_PARTICIPANT', severity: 'error', since: T + 10 * MIN, count: 1 });
  assert.equal(state.attendance.length, 2, 'only roster members get a row');
  const actions = planActions(lesson, events, T + 10 * MIN);
  assert.deepEqual(actions.map(action => [action.type, action.reason ?? action.userKey ?? action.code]), [
    ['STOP_RECORDING', 'unknown_participant'],
    ['REMOVE_USER', 'P-TEST-X99'],
    ['NOTIFY_ADMIN', 'UNKNOWN_PARTICIPANT'],
  ]);
});

test('the dashboard shows codes only: nothing planted in Zoom payloads gets through', async () => {
  const payload = {
    event: 'session.user_joined',
    event_ts: T + MIN,
    payload: { object: { session_id: 'sess-1', session_key: lesson.id, user: { name: 'Synthetic Display Name', user_key: STUDENT, participant_uuid: 'u-s', join_time: iso(T + MIN), phone_number: '+886-2-0000-0000' } } },
  };
  const snapshot = normalizeApiSnapshot({
    lessonId: lesson.id, providerSessionId: 'sess-1', observedAt: T + 2 * MIN, details: { start_time: iso(T - 3 * MIN) },
    users: [{ user_key: TUTOR, participant_uuid: 'u-t', join_time: iso(T - 3 * MIN), name: 'Synthetic Display Name', ip_address: '203.0.113.7', device: 'Synthetic Device' }],
  });
  const dashboard = buildDashboard({ lessons: [lesson], events: [eligibility(), minimizeZoomEvent(payload, T + MIN), ...snapshot], now: T + 2 * MIN });
  const text = JSON.stringify(dashboard);
  for (const planted of [...PLANTED, '+886-2']) assert.equal(text.includes(planted), false, planted);
  assert.match(text, /TEST-S001/);
  const run = await runSimulation({ scenarios: Object.keys(SCENARIOS) });
  const everything = JSON.stringify([run.final, run.store.events(), run.store.fileRecords(), run.store.jobs(), run.drive.activeFiles()]);
  for (const planted of PLANTED) assert.equal(everything.includes(planted), false, planted);
});

test('only owners may see the overview, answers are never cached, and observing stays switched off', () => {
  assert.deepEqual(dashboardAccess({ email: '', principal: null }), { status: 401, code: 'SIGN_IN_REQUIRED' });
  assert.deepEqual(dashboardAccess({ email: 'editor@example.org', principal: { email: 'editor@example.org', role: 'editor', source: 'database' } }), { status: 403, code: 'FORBIDDEN' });
  assert.deepEqual(dashboardAccess({ email: 'signed-in@example.org', principal: null }), { status: 403, code: 'FORBIDDEN' });
  const owner = { email: 'owner@example.org', role: 'owner', source: 'environment' };
  assert.deepEqual(dashboardAccess({ email: owner.email, principal: owner }), { status: 200, code: 'OK' });
  assert.equal(canViewDashboard(owner), true);
  assert.deepEqual(DASHBOARD_HEADERS, { 'Cache-Control': 'private, no-store', 'Vercel-CDN-Cache-Control': 'no-store' });
  assert.equal(canObserve({ ...owner, permissions: ['classroom.observe'] }), false, 'the feature is off');
  assert.equal(canObserve(owner, { observe: true }), false, 'needs its own permission');
  assert.equal(canObserve({ ...owner, role: 'editor', permissions: ['classroom.observe'] }, { observe: true }), false);
  assert.equal(canObserve({ ...owner, permissions: ['classroom.observe'] }, { observe: true }), true, 'the later design, not enabled in the MVP');
});

test('reconciliation stays within its REST budget and takes the most urgent lessons first', () => {
  const lessons = Array.from({ length: 12 }, (_, index) => makeLesson(index));
  const byLesson = new Map();
  for (const entry of lessons) {
    const id = entry.id;
    const [tutor, student] = entry.participants.map(person => person.id);
    byLesson.set(id, [
      { type: 'server.recording_eligibility', source: 'server', lessonId: id, occurredAt: T - 15 * MIN, eligible: true, key: `decide:${id}` },
      { type: 'session.started', source: 'zoom_webhook', lessonId: id, providerSessionId: id, occurredAt: T - 3 * MIN, key: `s:${id}` },
      { type: 'session.user_joined', source: 'zoom_webhook', lessonId: id, participantId: tutor, participantUuid: `${id}-t`, occurredAt: T - 3 * MIN, key: `jt:${id}` },
      { type: 'session.user_joined', source: 'zoom_webhook', lessonId: id, participantId: student, participantUuid: `${id}-s`, occurredAt: T + MIN, key: `js:${id}` },
    ]);
  }
  // Lesson 12: a stop after a withdrawal not confirmed yet. Lesson 11: a start not confirmed.
  byLesson.get(lessons[11].id).push(
    { type: 'session.recording_started', source: 'zoom_webhook', lessonId: lessons[11].id, status: 'Recording', occurredAt: T + 2 * MIN, key: 'r12' },
    { type: 'server.start_requested', source: 'server', lessonId: lessons[11].id, attempt: 1, occurredAt: T + 2 * MIN - SEC, key: 'start12' },
    { type: 'server.consent_withdrawn', source: 'server', lessonId: lessons[11].id, occurredAt: T + 9 * MIN, key: 'w12' },
    { type: 'server.stop_requested', source: 'server', lessonId: lessons[11].id, attempt: 1, occurredAt: T + 9 * MIN, key: 'stop12' },
  );
  byLesson.get(lessons[10].id).push(
    { type: 'server.start_requested', source: 'server', lessonId: lessons[10].id, attempt: 1, occurredAt: T + 9 * MIN, key: 'start11' },
    { type: 'server.start_response', source: 'server', lessonId: lessons[10].id, attempt: 1, ok: true, occurredAt: T + 9 * MIN, key: 'resp11' },
  );
  const now = T + 10 * MIN + 5 * SEC;   // everything else: nothing heard for over five minutes
  const picked = dueReconciliations(lessons, byLesson, now, { heavyBudget: 20 });
  assert.equal(picked.length, 10);
  assert.deepEqual(picked.slice(0, 2).map(item => item.reason), ['stop_unconfirmed', 'start_unconfirmed']);
  assert.ok(picked.slice(2).every(item => item.reason === 'stale'));
  assert.equal(picked.reduce((sum, item) => sum + item.heavyCalls, 0), 20);
  const recent = new Map(lessons.map(entry => [entry.id, now - 30 * SEC]));
  assert.deepEqual(dueReconciliations(lessons, byLesson, now, { lastReconciledAt: recent }), []);
  assert.equal(TIMING.reconcileEveryMs, 60_000);
});

test('with nothing heard for five minutes the data is marked stale and checked against the API', () => {
  const events = [eligibility(false), started(), joinedFact(TUTOR, T - 3 * MIN, 'u-t'), joinedFact(STUDENT, T + MIN, 'u-s')];
  const now = T + 7 * MIN;
  const state = deriveLesson(lesson, events, now);
  assert.deepEqual(state.anomalies.map(entry => [entry.code, entry.severity]), [['STALE_DATA', 'warning']]);
  assert.equal(state.dataState.value, 'DELAYED');
  assert.equal(lessonCard(state, now).dataState.ageSeconds, 6 * 60);
  assert.equal(dueReconciliations([lesson], new Map([[lesson.id, events]]), now)[0].reason, 'stale');
});
