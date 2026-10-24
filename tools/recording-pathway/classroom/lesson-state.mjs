// Live state of one lesson, derived from its stored events (synthetic prototype).
//
// A lesson's state is a pure function of its events and the current time. Events are sorted by
// when they happened, so the same events give the same state whatever order they arrived in,
// and an event delivered twice changes nothing. Every fact shown carries its basis:
//   confirmed  Zoom said so: a signed webhook, a REST snapshot, or the host's Video SDK
//   requested  we asked Zoom and are still waiting for its answer
//   inferred   worked out from silence or a timeout; shown as 推測, never as confirmed
// "Recording", "stopped", "completed" and "filed" only ever come from a confirmation.
// The thresholds are defaults to agree with Justine, not measured Zoom behaviour.
import { isKeptRecording } from './webhook-ingest.mjs';

export const TIMING = Object.freeze({
  waitingFromMs: 15 * 60_000,
  lateAfterMs: 5 * 60_000,
  absentAfterMs: 10 * 60_000,
  startReconcileMs: 60_000,
  startConfirmMs: 2 * 60_000,
  startRetryDelaysMs: [10_000, 30_000],   // three attempts in about a minute
  maxStartAttempts: 3,
  stopRetryMs: 30_000,
  endSessionMs: 60_000,
  endConfirmMs: 60_000,
  heartbeatTimeoutMs: 60_000,
  realtimeWindowMs: 90_000,
  staleAfterMs: 5 * 60_000,
  tutorAbsentStopMs: 5 * 60_000,
  tutorAbsentEndMs: 15 * 60_000,
  overrunAfterMs: 15 * 60_000,
  fileOverdueWarnMs: 30 * 60_000,
  fileOverdueErrorMs: 6 * 60 * 60_000,
  filingOverdueMs: 60 * 60_000,
  qualityAlertMs: 10 * 60_000,
  reconcileEveryMs: 60_000,
  clockSkewMs: 2 * 60_000,
});

const CONFIRMING_SOURCES = new Set(['zoom_webhook', 'zoom_api', 'host_sdk']);
const SOURCE_RANK = { zoom_webhook: 0, zoom_api: 1, host_sdk: 2, server: 3, p1: 4 };
const TYPE_ORDER = [
  'server.recording_eligibility', 'server.consent_withdrawn', 'session.started', 'session.user_joined', 'host.user_added',
  'host.heartbeat', 'host.connection', 'api.snapshot', 'server.start_requested', 'server.start_response',
  'session.recording_started', 'session.recording_resumed', 'host.recording_status', 'session.recording_paused',
  'server.stop_requested', 'session.recording_stopped', 'host.participant_failover', 'session.user_left', 'host.user_removed',
  'server.remove_requested', 'server.session_end_requested', 'session.ended', 'session.recording_completed', 'p1.filing',
];
const rank = type => (TYPE_ORDER.indexOf(type) + 1 || TYPE_ORDER.length + 1);
const toMs = value => (typeof value === 'number' ? value : Date.parse(value));
const earliest = (a, b) => (a == null ? b : Math.min(a, b));
const latest = (a, b) => (a == null ? b : Math.max(a, b));

// One copy per key (the same choice whatever the arrival order), only what had arrived by now,
// sorted by when it happened.
function ordered(events, now) {
  const byKey = new Map();
  for (const event of events) {
    if ((event.receivedAt ?? event.occurredAt) > now) continue;
    const key = event.key || JSON.stringify(event);
    const kept = byKey.get(key);
    if (!kept || preferred(event, kept)) byKey.set(key, event);
  }
  return [...byKey.values()].sort((a, b) =>
    a.occurredAt - b.occurredAt || rank(a.type) - rank(b.type) || (SOURCE_RANK[a.source] ?? 9) - (SOURCE_RANK[b.source] ?? 9)
    || String(a.key).localeCompare(String(b.key)));
}

function preferred(a, b) {
  const bySource = (SOURCE_RANK[a.source] ?? 9) - (SOURCE_RANK[b.source] ?? 9);
  return bySource ? bySource < 0 : JSON.stringify(a) < JSON.stringify(b);
}

function analyze(lesson, events, now) {
  const start = toMs(lesson.startsAt);
  const end = toMs(lesson.endsAt);
  const people = new Map(lesson.participants.filter(entry => entry.role !== 'observer').map(entry => [entry.id, { ...entry, facts: [] }]));
  const tutor = [...people.values()].find(entry => entry.role === 'tutor');
  const f = {
    sessions: new Map(), lastConfirmedAt: null, recording: [], startRequests: [], startResponses: [], stopRequests: [],
    endRequests: [], eligibility: null, withdrawal: null, unknown: [], joinBlocked: 0, alerts: [], completed: new Map(),
    completedAt: null, filings: new Map(), lastSnapshotAt: null, snapshotPresent: new Set(), performed: new Set(),
  };
  const session = id => {
    const key = id || 'session';
    if (!f.sessions.has(key)) f.sessions.set(key, { startedAt: null, endedAt: null });
    return f.sessions.get(key);
  };
  for (const event of ordered(events.filter(entry => entry.lessonId === lesson.id), now)) {
    const at = event.occurredAt;
    if (CONFIRMING_SOURCES.has(event.source)) f.lastConfirmedAt = latest(f.lastConfirmedAt, at);
    if (event.source === 'server' && event.key) f.performed.add(event.key);
    const person = event.participantId ? people.get(event.participantId) : null;
    switch (event.type) {
      case 'session.started':
        session(event.providerSessionId).startedAt = earliest(session(event.providerSessionId).startedAt, at);
        break;
      case 'session.ended':
        session(event.providerSessionId).endedAt = earliest(session(event.providerSessionId).endedAt, at);
        break;
      case 'session.user_joined':
      case 'host.user_added':
        if (person) person.facts.push({ kind: 'present', at, source: event.source, join: true });
        else f.unknown.push({ at, userKey: event.participantId || 'unknown' });
        break;
      case 'session.user_left':
      case 'host.user_removed':
        if (person) person.facts.push({ kind: 'left', at, source: event.source, reason: event.leaveReason ?? null });
        break;
      case 'host.heartbeat':
        if (tutor) tutor.facts.push({ kind: 'present', at, source: event.source, heartbeat: true });
        break;
      case 'host.connection':
        if (tutor && event.state === 'Reconnecting') tutor.facts.push({ kind: 'reconnecting', at, source: event.source });
        else if (tutor && event.state === 'Connected') tutor.facts.push({ kind: 'present', at, source: event.source, heartbeat: true });
        else if (tutor) tutor.facts.push({ kind: 'left', at, source: event.source, reason: event.state === 'Fail' ? 'DISCONNECTED' : 'LEFT' });
        break;
      case 'host.participant_failover':
        if (person) person.facts.push({ kind: 'reconnecting', at, source: event.source });
        break;
      case 'api.snapshot':
        f.lastSnapshotAt = at;
        f.snapshotPresent = new Set(event.present);
        if (event.live) for (const id of event.present) people.get(id)?.facts.push({ kind: 'present', at, source: event.source });
        break;
      case 'session.recording_started':
      case 'session.recording_resumed':
      case 'session.recording_paused':
      case 'session.recording_stopped':
      case 'host.recording_status':
        if (['Recording', 'Paused', 'Stopped'].includes(event.status)) {
          f.recording.push({ status: event.status, at, source: event.source, receivedAt: event.receivedAt ?? at });
        }
        break;
      case 'session.recording_completed':
        for (const file of event.files) f.completed.set(file.providerFileId, file);
        f.completedAt = latest(f.completedAt, at);
        break;
      case 'session.alert':
        f.alerts.push({ at, issues: event.issues });
        break;
      case 'server.recording_eligibility':
        f.eligibility = { eligible: event.eligible === true, reason: event.reason, count: event.count ?? 0, at };
        break;
      case 'server.consent_withdrawn':
        if (!f.withdrawal) f.withdrawal = { at };
        break;
      case 'server.start_requested':
        f.startRequests.push({ attempt: event.attempt, at });
        break;
      case 'server.start_response':
        f.startResponses.push({ attempt: event.attempt, ok: event.ok === true, at });
        break;
      case 'server.stop_requested':
        f.stopRequests.push({ reason: event.reason, attempt: event.attempt, at });
        break;
      case 'server.session_end_requested':
        f.endRequests.push({ reason: event.reason, at });
        break;
      case 'server.join_blocked':
        f.joinBlocked += 1;
        break;
      case 'p1.filing':
        f.filings.set(event.providerFileId, { status: event.status, at });
        break;
      default:
        break;
    }
  }
  const sessions = [...f.sessions.values()];
  f.lastSessionEnd = sessions.reduce((value, entry) => (entry.endedAt == null ? value : latest(value, entry.endedAt)), null);
  const phase = phaseOf({ f, sessions, people, start, now });
  const startTimes = [
    ...sessions.map(entry => entry.startedAt).filter(value => value != null),
    ...[...people.values()].flatMap(person => person.facts.filter(fact => fact.kind === 'present').map(fact => fact.at)),
  ];
  const attendance = [...people.values()].map(person => presenceOf(person, { f, phase, start, now }));
  const recording = recordingOf(f, phase, now);
  const filing = filingOf(f);
  const anomalies = anomaliesOf({ f, phase, attendance, recording, filing, start, end, now });
  const errors = anomalies.some(entry => entry.severity === 'error');
  const inferred = phase.basis === 'inferred' || recording.basis === 'inferred'
    || attendance.some(entry => entry.basis === 'inferred' && entry.status !== 'NOT_JOINED');
  const quiet = phase.value === 'LIVE' && (f.lastConfirmedAt == null || now - f.lastConfirmedAt > TIMING.realtimeWindowMs);
  const waiting = recording.basis === 'requested' && now - recording.since > TIMING.startReconcileMs;
  const overdue = anomalies.some(entry => ['FILE_OVERDUE', 'STALE_DATA', 'HOST_SIGNAL_LOST'].includes(entry.code));
  const state = {
    lessonId: lesson.id,
    code: lesson.code,
    scheduledStart: start,
    scheduledEnd: end,
    actualStart: startTimes.length ? Math.min(...startTimes) : null,
    phase,
    attendance,
    recording,
    filing,
    withdrawal: f.withdrawal ? { at: f.withdrawal.at, captureStopped: !captureMayBeOn(f) } : null,
    anomalies,
    dataState: { value: errors ? 'ANOMALY' : quiet || waiting || inferred || overdue ? 'DELAYED' : 'REALTIME', lastConfirmedAt: f.lastConfirmedAt },
  };
  return { state, facts: f };
}

function lastFact(person) {
  return person.facts[person.facts.length - 1];
}

function phaseOf({ f, sessions, people, start, now }) {
  const presence = [...people.values()].flatMap(person => person.facts.filter(fact => fact.kind === 'present').map(fact => fact.at));
  const latestPresence = presence.length ? Math.max(...presence) : null;
  const open = sessions.filter(entry => entry.startedAt != null && entry.endedAt == null);
  const someoneCame = presence.length > 0 || sessions.some(entry => entry.startedAt != null);
  // After we end a session the class carries on in a new one, so presence after the last end
  // means the lesson is live again even if the new session's start webhook is late.
  const ended = f.lastSessionEnd != null && !open.length && !(latestPresence != null && latestPresence > f.lastSessionEnd);
  if (ended) return { value: 'ENDED', basis: 'confirmed', since: f.lastSessionEnd };
  if (someoneCame) {
    const joined = [...people.values()].filter(person => person.facts.some(fact => fact.kind === 'present'));
    // Zoom ends a session when its last user leaves; until it says so, that end is inferred.
    if (joined.length && joined.every(person => lastFact(person).kind === 'left')) {
      return { value: 'ENDED', basis: 'inferred', since: Math.max(...joined.map(person => lastFact(person).at)) };
    }
    const started = [...sessions.map(entry => entry.startedAt).filter(value => value != null), ...presence];
    return { value: 'LIVE', basis: 'confirmed', since: Math.min(...started) };
  }
  return { value: 'WAITING', basis: now < start ? 'confirmed' : 'inferred', since: null };
}

function presenceOf(person, { f, phase, start, now }) {
  // Lateness only from a real join time; a heartbeat or a snapshot says nothing about when someone came.
  const firstJoin = person.facts.find(fact => fact.join);
  const last = lastFact(person);
  const base = { participantId: person.id, code: person.code, role: person.role, late: firstJoin ? firstJoin.at > start + TIMING.lateAfterMs : false };
  if (!last) {
    // Absence is only confirmed before the lesson starts, or by a REST snapshot that lists who
    // is in the room. Otherwise it may just be a late webhook.
    const confirmed = (phase.value === 'WAITING' && now < start) || (f.lastSnapshotAt != null && f.lastSnapshotAt >= start && !f.snapshotPresent.has(person.id));
    return { ...base, status: 'NOT_JOINED', basis: confirmed ? 'confirmed' : 'inferred', since: null, leaveReason: null };
  }
  if (phase.value === 'ENDED' && last.kind !== 'left') return { ...base, status: 'LEFT', basis: 'inferred', since: phase.since, leaveReason: null };
  if (last.kind === 'left') {
    // The host's report of a leave carries no reason; Zoom's webhook for the same leave does.
    const reason = last.reason ?? person.facts.filter(fact => fact.kind === 'left' && fact.reason && Math.abs(fact.at - last.at) <= TIMING.clockSkewMs).pop()?.reason ?? null;
    return { ...base, status: 'LEFT', basis: 'confirmed', since: last.at, leaveReason: reason, source: last.source };
  }
  if (last.kind === 'reconnecting') return { ...base, status: 'RECONNECTING', basis: 'confirmed', since: last.at, source: last.source };
  // A computer switched off never says goodbye: when the tutor's heartbeat goes quiet, the tutor
  // is "possibly offline" until Zoom confirms the leave. If Zoom still lists the tutor (it keeps
  // a dropped connection for about two minutes), the tutor shows as present with the host's
  // signal marked as lost.
  if (person.role === 'tutor' && phase.value === 'LIVE' && person.facts.some(fact => fact.heartbeat)) {
    const lastSeen = Math.max(...person.facts.filter(fact => fact.kind === 'present').map(fact => fact.at));
    const lastBeat = Math.max(...person.facts.filter(fact => fact.heartbeat).map(fact => fact.at));
    if (now - lastSeen > TIMING.heartbeatTimeoutMs) return { ...base, status: 'POSSIBLY_OFFLINE', basis: 'inferred', since: lastSeen, source: last.source };
    if (now - lastBeat > TIMING.heartbeatTimeoutMs) return { ...base, status: 'PRESENT', basis: 'confirmed', since: last.at, source: last.source, signalLostSince: lastBeat };
  }
  return { ...base, status: 'PRESENT', basis: 'confirmed', since: last.at, source: last.source };
}

// Capture may still be running: Zoom last said "recording" (or accepted a start and has not
// answered since), and no session end came after that.
function captureMayBeOn(f) {
  const last = f.recording[f.recording.length - 1];
  const endedAfter = at => f.lastSessionEnd != null && f.lastSessionEnd >= at;
  if (last) return last.status === 'Recording' && !endedAfter(last.at);
  const accepted = f.startResponses.filter(response => response.ok).pop();
  return !!accepted && !endedAfter(accepted.at);
}

function recordingOf(f, phase, now) {
  const last = f.recording[f.recording.length - 1];
  if (f.completed.size) return { status: 'COMPLETED', basis: 'confirmed', since: f.completedAt, source: 'zoom' };
  if (last) {
    // The session is over (confirmed, or everyone has left) but Zoom never said the recording
    // stopped: it almost certainly did, and that is still a guess.
    const endedAt = f.lastSessionEnd != null && f.lastSessionEnd >= last.at ? f.lastSessionEnd
      : phase.value === 'ENDED' && phase.since >= last.at ? phase.since : null;
    if (last.status !== 'Stopped' && endedAt != null) {
      return { status: 'POSSIBLY_STOPPED', basis: 'inferred', since: endedAt, reason: 'SESSION_ENDED' };
    }
    const shared = { basis: 'confirmed', since: last.at, source: last.source, lateConfirmation: last.receivedAt - last.at > TIMING.startReconcileMs };
    if (last.status === 'Recording') {
      const stopAsked = f.stopRequests.some(request => request.at >= last.at - TIMING.clockSkewMs);
      return { status: 'RECORDING', ...shared, pending: stopAsked ? 'STOP_REQUESTED' : null };
    }
    return { status: last.status === 'Paused' ? 'PAUSED' : 'STOPPED', ...shared };
  }
  if (!f.eligibility) return { status: 'NOT_REQUESTED', basis: 'confirmed', since: null };
  if (!f.eligibility.eligible) return { status: 'BLOCKED', basis: 'confirmed', since: f.eligibility.at, reason: f.eligibility.reason };
  if (f.withdrawal) return { status: 'BLOCKED', basis: 'confirmed', since: f.withdrawal.at, reason: 'CONSENT_WITHDRAWN' };
  if (!f.startRequests.length) return { status: 'NOT_REQUESTED', basis: 'confirmed', since: null };
  const attempt = Math.max(...f.startRequests.map(request => request.attempt));
  const request = f.startRequests.find(entry => entry.attempt === attempt);
  const response = f.startResponses.find(entry => entry.attempt === attempt);
  if (response && !response.ok) {
    if (f.startResponses.filter(entry => !entry.ok).length >= TIMING.maxStartAttempts) {
      return { status: 'FAILED', basis: 'confirmed', since: response.at, reason: 'START_API_ERROR' };
    }
    return { status: 'START_REQUESTED', basis: 'requested', since: request.at, retrying: true };
  }
  // Zoom accepted the request (202) but never confirmed: that is a guess that it failed.
  if (response && now - response.at >= TIMING.startConfirmMs) {
    return { status: 'FAILED', basis: 'inferred', since: response.at + TIMING.startConfirmMs, reason: 'START_UNCONFIRMED' };
  }
  return { status: 'START_REQUESTED', basis: 'requested', since: request.at };
}

function filingOf(f) {
  const kept = [...f.completed.values()].filter(isKeptRecording);
  if (!kept.length) return { status: 'NONE', files: 0, stored: 0 };
  const statuses = kept.map(file => f.filings.get(file.providerFileId)?.status ?? 'PENDING');
  const stored = statuses.filter(status => status === 'STORED').length;
  let status = 'PENDING';
  if (statuses.includes('FAILED')) status = 'FAILED';
  else if (stored === kept.length) status = 'STORED';
  else if (!statuses.includes('PENDING')) status = 'HELD';
  return { status, files: kept.length, stored, basis: status === 'PENDING' ? 'requested' : 'confirmed' };
}

// When the recording should be on its way from Zoom's cloud.
function fileWaitSince(f, phase) {
  const transitions = f.recording;
  if (!transitions.some(entry => entry.status === 'Recording') || f.completed.size) return null;
  const last = transitions[transitions.length - 1];
  if (last.status === 'Stopped') return last.at;
  if (f.lastSessionEnd != null && f.lastSessionEnd >= last.at) return f.lastSessionEnd;
  return phase.value === 'ENDED' ? phase.since : null;
}

function startTransitions(f) {
  const starts = [];
  let previous = null;
  for (const entry of f.recording) {
    if (entry.status === 'Recording' && previous !== 'Recording') starts.push(entry);
    previous = entry.status;
  }
  return starts;
}

function anomaliesOf({ f, phase, attendance, recording, filing, start, end, now }) {
  const list = [];
  const add = (code, severity, since, extra = {}) => list.push({ code, severity, since, ...extra });
  const tutor = attendance.find(entry => entry.role === 'tutor');
  if (phase.value !== 'ENDED' && now >= start + TIMING.absentAfterMs) {
    if (tutor?.status === 'NOT_JOINED') add('TUTOR_ABSENT', 'error', start + TIMING.absentAfterMs);
    const absent = attendance.filter(entry => entry.role === 'student' && entry.status === 'NOT_JOINED').length;
    if (absent) add('STUDENT_ABSENT', 'warning', start + TIMING.absentAfterMs, { count: absent });
  }
  if (recording.status === 'FAILED') add(recording.reason === 'START_UNCONFIRMED' ? 'START_UNCONFIRMED' : 'RECORDING_FAILED', 'error', recording.since);
  const last = f.recording[f.recording.length - 1];
  if (last?.status === 'Stopped' && phase.value === 'LIVE' && !f.stopRequests.some(request => request.at <= last.at + TIMING.clockSkewMs)) {
    add('RECORDING_STOPPED_UNEXPECTEDLY', 'error', last.at);
  }
  // Recording we never started: Zoom's account-level automatic recording, or the host starting
  // it without our approval, or any start once the lesson may not be recorded.
  const unapproved = startTransitions(f).find(entry =>
    !f.startRequests.some(request => request.at <= entry.at + TIMING.clockSkewMs)
    || f.eligibility?.eligible !== true
    || (f.withdrawal && entry.at > f.withdrawal.at + TIMING.clockSkewMs));
  if (unapproved) add('UNAPPROVED_RECORDING_START', 'error', unapproved.at);
  if (f.withdrawal) {
    add('CONSENT_WITHDRAWN', 'warning', f.withdrawal.at);
    const endRequest = f.endRequests[0];
    if (endRequest && captureMayBeOn(f) && now - endRequest.at >= TIMING.endConfirmMs) {
      add('WITHDRAWAL_STOP_UNCONFIRMED', 'error', endRequest.at + TIMING.endConfirmMs);
    }
  }
  const waitingSince = fileWaitSince(f, phase);
  if (waitingSince != null) {
    const waited = now - waitingSince;
    if (waited >= TIMING.fileOverdueErrorMs) add('FILE_OVERDUE', 'error', waitingSince + TIMING.fileOverdueErrorMs);
    else if (waited >= TIMING.fileOverdueWarnMs) add('FILE_OVERDUE', 'warning', waitingSince + TIMING.fileOverdueWarnMs);
  }
  if (filing.status === 'FAILED') add('FILING_FAILED', 'error', f.completedAt);
  if (f.unknown.length) add('UNKNOWN_PARTICIPANT', 'error', f.unknown[0].at, { count: f.unknown.length });
  if (phase.value === 'LIVE' && (f.lastConfirmedAt == null || now - f.lastConfirmedAt > TIMING.staleAfterMs)) {
    add('STALE_DATA', 'warning', f.lastConfirmedAt ?? phase.since);
  }
  if (tutor?.signalLostSince != null) add('HOST_SIGNAL_LOST', 'warning', tutor.signalLostSince);
  const alert = f.alerts.filter(entry => now - entry.at <= TIMING.qualityAlertMs).pop();
  if (alert) add('QUALITY_ALERT', 'warning', alert.at, { issues: alert.issues.length });
  if (phase.value === 'LIVE' && now > end + TIMING.overrunAfterMs) add('OVERRUN', 'warning', end + TIMING.overrunAfterMs);
  if (f.joinBlocked) add('JOIN_BLOCKED', 'warning', null, { count: f.joinBlocked });
  return list;
}

export function deriveLesson(lesson, events, now) {
  return analyze(lesson, events, now).state;
}

// What the server should do next. Every action has a fixed key, and the server stores the key
// with the event it writes when it acts, so running the planner again never repeats an action.
export function planActions(lesson, events, now) {
  const { state, facts: f } = analyze(lesson, events, now);
  const id = lesson.id;
  const actions = [];
  const want = (key, type, extra = {}) => {
    if (!f.performed.has(key)) actions.push({ key, type, lessonId: id, ...extra });
  };
  if (!f.eligibility && state.phase.value !== 'ENDED' && now >= toMs(lesson.startsAt) - TIMING.waitingFromMs) want(`decide:${id}`, 'DECIDE_RECORDING');
  const tutor = state.attendance.find(entry => entry.role === 'tutor');
  const live = state.phase.value === 'LIVE';
  const recording = state.recording;
  // Start only when the whole roster consented, nobody withdrew, the session is live, and both
  // the tutor (the host) and a student are confirmed in the room.
  const studentHere = state.attendance.some(entry => entry.role === 'student' && entry.status === 'PRESENT' && entry.basis === 'confirmed');
  if (f.eligibility?.eligible === true && !f.withdrawal && live && tutor?.status === 'PRESENT' && tutor.basis === 'confirmed' && studentHere) {
    const attempt = f.startRequests.length ? Math.max(...f.startRequests.map(request => request.attempt)) : 0;
    const response = f.startResponses.find(entry => entry.attempt === attempt);
    if (recording.status === 'NOT_REQUESTED') want(`start:${id}:1`, 'START_RECORDING', { attempt: 1 });
    else if (recording.status === 'START_REQUESTED' && response && !response.ok && attempt < TIMING.maxStartAttempts
      && now >= response.at + TIMING.startRetryDelaysMs[attempt - 1]) want(`start:${id}:${attempt + 1}`, 'START_RECORDING', { attempt: attempt + 1 });
    else if (recording.status === 'FAILED' && recording.reason === 'START_UNCONFIRMED' && f.startResponses.filter(entry => entry.ok).length === 1) {
      want(`start:${id}:${attempt + 1}`, 'START_RECORDING', { attempt: attempt + 1 });
    }
  }
  // Protection first: consent withdrawn, an unknown person in the room, or recording we never
  // approved for a lesson that may not be recorded. Stop through both channels at once, again
  // after 30 seconds, and end the session after 60 seconds if Zoom still has not confirmed.
  const trigger = stopTrigger(state, f);
  if (trigger && captureMayBeOn(f)) {
    const channels = ['rest', 'host'];
    want(`stop:${id}:${trigger.reason}:1`, 'STOP_RECORDING', { reason: trigger.reason, attempt: 1, channels });
    if (now >= trigger.at + TIMING.stopRetryMs) want(`stop:${id}:${trigger.reason}:2`, 'STOP_RECORDING', { reason: trigger.reason, attempt: 2, channels });
    if (now >= trigger.at + TIMING.endSessionMs) want(`end:${id}:${trigger.reason}`, 'END_SESSION', { reason: trigger.reason });
  }
  // The tutor has gone: stop recording after 5 minutes and end the session after 15.
  if (tutor?.status === 'LEFT' && tutor.basis === 'confirmed' && live) {
    if (captureMayBeOn(f) && now - tutor.since >= TIMING.tutorAbsentStopMs) {
      want(`stop:${id}:tutor_absent:${tutor.since}`, 'STOP_RECORDING', { reason: 'tutor_absent', attempt: 1, channels: ['rest'] });
    }
    if (now - tutor.since >= TIMING.tutorAbsentEndMs) want(`end:${id}:tutor_absent:${tutor.since}`, 'END_SESSION', { reason: 'tutor_absent' });
  }
  for (const entry of f.unknown) want(`remove:${id}:${entry.userKey}:${entry.at}`, 'REMOVE_USER', { userKey: entry.userKey });
  for (const anomaly of state.anomalies) if (anomaly.severity === 'error') want(`notify:${id}:${anomaly.code}`, 'NOTIFY_ADMIN', { code: anomaly.code });
  return actions;
}

function stopTrigger(state, f) {
  if (f.withdrawal) return { reason: 'consent_withdrawn', at: f.withdrawal.at };
  if (f.unknown.length) return { reason: 'unknown_participant', at: f.unknown[0].at };
  const unapproved = state.anomalies.find(entry => entry.code === 'UNAPPROVED_RECORDING_START');
  if (unapproved && f.eligibility?.eligible !== true) return { reason: 'unapproved_start', at: unapproved.since };
  return null;
}

// Which lessons to check against Zoom's REST API now, most urgent first, within a call budget.
// Each check costs two HEAVY calls (session details and users) and one LIGHT call (recordings).
export function dueReconciliations(lessons, eventsByLesson, now, { lastReconciledAt = new Map(), heavyBudget = 20 } = {}) {
  const due = [];
  for (const lesson of lessons) {
    const last = lastReconciledAt.get(lesson.id) ?? -Infinity;
    if (now - last < TIMING.reconcileEveryMs) continue;
    const { state, facts } = analyze(lesson, eventsByLesson.get(lesson.id) || [], now);
    const reason = reconcileReason(lesson, state, facts, now, last);
    if (reason) due.push({ lessonId: lesson.id, ...reason });
  }
  due.sort((a, b) => a.priority - b.priority || a.waitingSince - b.waitingSince);
  const picked = [];
  for (const item of due) {
    if ((picked.length + 1) * 2 > heavyBudget) break;
    picked.push({ ...item, heavyCalls: 2, lightCalls: 1 });
  }
  return picked;
}

function reconcileReason(lesson, state, f, now, last) {
  const tutor = state.attendance.find(entry => entry.role === 'tutor');
  if (f.withdrawal && f.stopRequests.length && captureMayBeOn(f)) return { reason: 'stop_unconfirmed', priority: 0, waitingSince: f.stopRequests[0].at };
  if (state.recording.status === 'START_REQUESTED' && now - state.recording.since >= TIMING.startReconcileMs) {
    return { reason: 'start_unconfirmed', priority: 1, waitingSince: state.recording.since };
  }
  if (tutor?.status === 'POSSIBLY_OFFLINE') return { reason: 'host_signal_lost', priority: 1, waitingSince: tutor.since };
  if (tutor?.signalLostSince != null) return { reason: 'host_signal_lost', priority: 1, waitingSince: tutor.signalLostSince };
  if (state.phase.value === 'ENDED' && state.phase.basis === 'inferred') return { reason: 'end_unconfirmed', priority: 2, waitingSince: state.phase.since };
  if (state.phase.value === 'LIVE' && (f.lastConfirmedAt == null || now - f.lastConfirmedAt > TIMING.staleAfterMs)) {
    return { reason: 'stale', priority: 2, waitingSince: f.lastConfirmedAt ?? state.phase.since };
  }
  if (state.phase.value !== 'ENDED' && now > toMs(lesson.endsAt) + TIMING.overrunAfterMs) return { reason: 'overrun', priority: 3, waitingSince: toMs(lesson.endsAt) };
  // Waiting for the recording file: check at 30 minutes, then every 30 minutes up to 6 hours.
  const waitingSince = fileWaitSince(f, state.phase);
  if (waitingSince != null) {
    const waited = now - waitingSince;
    const slot = waitingSince + Math.floor(waited / TIMING.fileOverdueWarnMs) * TIMING.fileOverdueWarnMs;
    if (waited >= TIMING.fileOverdueWarnMs && waited <= TIMING.fileOverdueErrorMs && last < slot) {
      return { reason: 'file_overdue', priority: 4, waitingSince };
    }
  }
  if (f.completed.size && state.filing.status === 'PENDING' && now - f.completedAt >= TIMING.filingOverdueMs) {
    return { reason: 'filing_overdue', priority: 5, waitingSince: f.completedAt };
  }
  return null;
}
