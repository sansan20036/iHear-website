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
import { generationOfRoom } from './eligibility.mjs';
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
  // Recording stops this long after the lesson's scheduled end (a grace for the last words), and
  // never starts after it.
  lessonEndStopMs: 5 * 60_000,
  overrunAfterMs: 15 * 60_000,
  fileOverdueWarnMs: 30 * 60_000,
  fileOverdueErrorMs: 6 * 60 * 60_000,
  filingOverdueMs: 60 * 60_000,
  filingStuckMs: 6 * 60 * 60_000,
  qualityAlertMs: 10 * 60_000,
  reconcileEveryMs: 60_000,
  clockSkewMs: 2 * 60_000,
  // A session end Zoom has not confirmed is asked for again after these waits (G-2), then left
  // to the administrator (the anomaly stays until Zoom says the session ended).
  endRetryMs: [2 * 60_000, 5 * 60_000, 10 * 60_000, 30 * 60_000],
  // An older generation of the room (D-5): ended once everyone legitimate has moved to the new
  // one, or after this long; sooner when someone who may not be there is in it.
  oldRoomEndMs: 3 * 60_000,
  oldRoomSuspectEndMs: 60_000,
});

// Facts from these sources name a real vendor session; others only report one.
const TRUSTED_SESSION_SOURCES = new Set(['zoom_webhook', 'zoom_api']);
// Ends the server asks for again until Zoom confirms the session ended, whatever the recording.
const END_UNTIL_ENDED = new Set(['lesson_cancelled', 'old_room', 'old_room_suspect', 'tutor_absent']);

// What the vendor itself reports confirms; a vendor's callback ranks with Zoom's webhook.
const CONFIRMING_SOURCES = new Set(['zoom_webhook', 'lcic_callback', 'zoom_api', 'host_sdk']);
const SOURCE_RANK = { zoom_webhook: 0, lcic_callback: 0, zoom_api: 1, host_sdk: 2, server: 3, p1: 4 };
const TYPE_ORDER = [
  'server.participant_rotated', 'server.room_generation',
  'server.consent_changed', 'server.recording_eligibility', 'server.consent_withdrawn', 'server.emergency_stop', 'server.lesson_cancelled', 'session.started', 'session.user_joined', 'host.user_added',
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
    endRequests: [], eligibility: null, consentChangedAt: null, withdrawal: null, emergency: null, unknown: [], joinBlocked: 0, alerts: [], completed: new Map(),
    completedAt: null, filings: new Map(), partOrderAt: null, refusedAt: null, sessionRejectedAt: null, lastSnapshotAt: null, snapshotPresent: new Set(), performed: new Set(),
    // Cancelled: the lesson's own flag, and the recorded cancellation (with its time) once stored.
    cancelledFlag: lesson.cancelled === true, cancellation: null,
    // The vendor sessions this lesson is known to have run in (trusted facts only), by id: when
    // each became known, its name and generation, whether it ended, and who is in it (G-1/G-3/G-5).
    known: new Map(),
    // The room's generations (D-1) and the server's stop and end requests with their targets.
    generations: [], stopAttempts: [], endAttempts: [],
  };
  const lessonEvents = ordered(events.filter(entry => entry.lessonId === lesson.id), now);
  // A reissued link gives the student a new participant id (D-4). Facts about the old id from
  // before the change are the same student's; after it, the old id is not on the roster.
  const rotated = new Map(lessonEvents.filter(event => event.type === 'server.participant_rotated').map(event => [String(event.from), { to: String(event.to), at: event.occurredAt }]));
  const resolve = (participantId, at) => {
    if (!participantId) return { person: null, former: false };
    if (people.has(participantId)) return { person: people.get(participantId), former: false };
    let id = participantId, change = rotated.get(id), changedAt = change?.at;
    if (!change) return { person: null, former: false };
    if (at > changedAt) return { person: null, former: true };
    for (let hops = 0; change && hops < 20; hops += 1) { id = change.to; change = rotated.get(id); }
    return { person: people.get(id) ?? null, former: false };
  };
  const session = id => {
    const key = id || 'session';
    if (!f.sessions.has(key)) f.sessions.set(key, { startedAt: null, endedAt: null });
    return f.sessions.get(key);
  };
  const knownSession = id => {
    if (!f.known.has(id)) f.known.set(id, { id, knownAt: null, startedAt: null, endedAt: null, name: null, generation: null, present: new Map(), suspects: [] });
    return f.known.get(id);
  };
  for (const event of lessonEvents) {
    const at = event.occurredAt;
    if (CONFIRMING_SOURCES.has(event.source)) f.lastConfirmedAt = latest(f.lastConfirmedAt, at);
    if (event.source === 'server' && event.key) f.performed.add(event.key);
    const { person, former } = resolve(event.participantId, at);
    const sid = typeof event.providerSessionId === 'string' && event.providerSessionId ? event.providerSessionId : null;
    const trusted = sid && (TRUSTED_SESSION_SOURCES.has(event.source) || event.type === 'server.session_verified') ? knownSession(sid) : null;
    if (trusted) {
      trusted.knownAt = earliest(trusted.knownAt, event.receivedAt ?? at);
      if (typeof event.sessionName === 'string' && event.sessionName) trusted.name = event.sessionName;
    }
    switch (event.type) {
      case 'session.started':
        session(event.providerSessionId).startedAt = earliest(session(event.providerSessionId).startedAt, at);
        if (trusted) trusted.startedAt = earliest(trusted.startedAt, at);
        break;
      case 'session.ended':
        session(event.providerSessionId).endedAt = earliest(session(event.providerSessionId).endedAt, at);
        if (trusted) trusted.endedAt = earliest(trusted.endedAt, at);
        break;
      case 'server.session_verified':
        if (trusted && event.ended === true) trusted.endedAt = earliest(trusted.endedAt, at);
        break;
      case 'session.user_joined':
      case 'host.user_added':
        if (person) person.facts.push({ kind: 'present', at, source: event.source, join: true });
        else f.unknown.push({ at, userKey: event.participantId || 'unknown', sessionId: sid, former });
        if (trusted) {
          trusted.present.set(person ? person.id : String(event.participantId || 'unknown'), { in: true, at, legit: Boolean(person) });
          if (!person) trusted.suspects.push({ at, userKey: event.participantId || 'unknown', former });
        }
        break;
      case 'session.user_left':
      case 'host.user_removed':
        if (person) person.facts.push({ kind: 'left', at, source: event.source, reason: event.leaveReason ?? null });
        if (trusted) trusted.present.set(person ? person.id : String(event.participantId || 'unknown'), { in: false, at, legit: Boolean(person) });
        break;
      case 'server.room_generation':
        f.generations.push({ generation: Number(event.generation) || 0, at });
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
        // Zoom's own answer that the session is over confirms an end (G-2).
        if (trusted && event.live === false) trusted.endedAt = earliest(trusted.endedAt, at);
        break;
      case 'session.recording_started':
      case 'session.recording_resumed':
      case 'session.recording_paused':
      case 'session.recording_stopped':
      case 'host.recording_status':
        if (['Recording', 'Paused', 'Stopped'].includes(event.status)) {
          // Which session it is about, when the fact says (the tutor's page usually does not).
          f.recording.push({ status: event.status, at, source: event.source, receivedAt: event.receivedAt ?? at, sessionId: sid });
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
      case 'server.consent_changed':
        f.consentChangedAt = latest(f.consentChangedAt, at);
        break;
      case 'server.consent_withdrawn':
        if (!f.withdrawal) f.withdrawal = { at };
        break;
      // An administrator pressed the emergency stop: the lesson is never recorded again.
      case 'server.emergency_stop':
        if (!f.emergency) f.emergency = { at };
        break;
      // The lesson was cancelled (P3's cancel, or the tick noticing the lesson's flag): the
      // lesson is never recorded again, and any recording is stopped like an emergency stop.
      case 'server.lesson_cancelled':
        if (!f.cancellation) f.cancellation = { at };
        break;
      case 'server.start_requested':
        f.startRequests.push({ attempt: event.attempt, at });
        break;
      case 'server.start_response':
        f.startResponses.push({ attempt: event.attempt, ok: event.ok === true, at, targets: targetsOf(event) });
        break;
      case 'server.stop_requested':
        f.stopRequests.push({ reason: event.reason, attempt: event.attempt, at });
        f.stopAttempts.push({ key: String(event.key), reason: event.reason, at, targets: targetsOf(event) });
        break;
      case 'server.session_end_requested':
        f.endRequests.push({ reason: event.reason, at });
        f.endAttempts.push({ key: String(event.key), reason: event.reason, at, targets: targetsOf(event) });
        break;
      case 'server.join_blocked':
        f.joinBlocked += 1;
        break;
      case 'p1.filing': {
        // A resumed filing is simply pending again. Where a copy went (its name, folder, size,
        // checksum and Drive id) comes with the final outcome and is kept with it.
        const placed = event.driveFileId ? { name: event.name ?? null, folder: event.folder ?? null, size: event.size ?? null, md5: event.md5 ?? null, driveFileId: event.driveFileId, destination: event.destination ?? null } : {};
        f.filings.set(event.providerFileId, { status: event.status === 'RESUMED' ? 'PENDING' : event.status, reason: event.reason ?? null, at, ...placed });
        break;
      }
      case 'p1.part_order':
        f.partOrderAt = earliest(f.partOrderAt, at);
        break;
      case 'server.recording_refused':
        f.refusedAt = earliest(f.refusedAt, at);
        break;
      case 'server.session_rejected':
        f.sessionRejectedAt = earliest(f.sessionRejectedAt, at);
        break;
      default:
        break;
    }
  }
  // The room's current generation, and each known session's (from its name; null when Zoom did
  // not give one, or it is not a name of this lesson's room).
  const newest = f.generations.reduce((best, entry) => (!best || entry.generation > best.generation ? entry : best), null);
  f.currentGeneration = newest?.generation ?? 0;
  f.rotatedAt = newest?.at ?? null;
  for (const entry of f.known.values()) entry.generation = generationOfRoom(lesson.id, entry.name);
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
    emergency: f.emergency ? { at: f.emergency.at, stopState: emergencyStopState(f) } : null,
    // `at` is null while the cancellation is only the lesson's flag, not yet recorded.
    cancellation: f.cancellation || f.cancelledFlag ? { at: f.cancellation?.at ?? null, stopState: emergencyStopState(f) } : null,
    // The room's generation, and the vendor sessions known from trusted facts (ids, names and
    // whether Zoom says they ended); never anyone's name.
    generation: f.currentGeneration,
    sessions: [...f.known.values()].map(entry => ({ id: entry.id, generation: entry.generation, live: entry.endedAt == null, endedAt: entry.endedAt })),
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

// The sessions a server request named: its own list, or (for facts written before requests
// named their sessions) the session the fact itself carries; null when it says neither.
function targetsOf(event) {
  if (Array.isArray(event.targets)) return event.targets.map(String);
  return typeof event.providerSessionId === 'string' && event.providerSessionId ? [event.providerSessionId] : null;
}

// A request reached a session when it named it; a request that named nothing (older facts) is
// taken to have reached every session.
const reached = (attempt, sessionId) => attempt.targets == null || attempt.targets.includes(sessionId);

// The lesson's sessions Zoom has not said are over, oldest first.
function liveSessions(f) {
  return [...f.known.values()].filter(entry => entry.endedAt == null).sort((a, b) => (a.knownAt ?? 0) - (b.knownAt ?? 0) || a.id.localeCompare(b.id));
}

// Capture may be running in this session: its own recording facts, plus those that name no
// session (the tutor's page), say "recording" last, and the session has not ended since; or,
// with no such fact, Zoom accepted a start for it (or for no named session) (G-3).
function captureOnIn(f, entry) {
  const endedAfter = at => entry.endedAt != null && entry.endedAt >= at;
  const facts = f.recording.filter(fact => fact.sessionId == null || fact.sessionId === entry.id);
  const last = facts[facts.length - 1];
  if (last) return last.status === 'Recording' && !endedAfter(last.at);
  const accepted = f.startResponses.filter(response => response.ok && (!response.targets || !response.targets.length || response.targets.includes(entry.id))).pop();
  return !!accepted && !endedAfter(accepted.at);
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

// After an emergency stop, what is known, never more:
//   CONFIRMED           Zoom said the recording stopped (or the session ended) — a confirmation
//   WAITING             recording may still be on: the stop is asked for, Zoom has not confirmed
//   NO_RECORDING_KNOWN  nothing was known to be recording; that is not a confirmation either
function emergencyStopState(f) {
  const last = f.recording[f.recording.length - 1];
  const anyCapture = Boolean(last) || f.startResponses.some(response => response.ok);
  if (captureMayBeOn(f) || last?.status === 'Paused') return 'WAITING';
  return anyCapture ? 'CONFIRMED' : 'NO_RECORDING_KNOWN';
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
  if (f.emergency) return { status: 'BLOCKED', basis: 'confirmed', since: f.emergency.at, reason: 'EMERGENCY_STOP' };
  if (f.cancellation || f.cancelledFlag) return { status: 'BLOCKED', basis: 'confirmed', since: f.cancellation?.at ?? null, reason: 'LESSON_CANCELLED' };
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
  if (!kept.length) return { status: 'NONE', files: 0, stored: 0, items: [] };
  const entries = kept.map(file => f.filings.get(file.providerFileId) ?? { status: 'PENDING' });
  const statuses = entries.map(entry => entry.status);
  const stored = statuses.filter(status => status === 'STORED').length;
  let status = 'PENDING';
  if (statuses.includes('FAILED')) status = 'FAILED';
  else if (statuses.includes('BLOCKED')) status = 'BLOCKED';
  else if (stored === kept.length) status = 'STORED';
  else if (!statuses.includes('PENDING')) status = 'HELD';
  // Each kept file and what became of it, oldest recording first.
  const items = kept
    .map((file, index) => ({ file, entry: entries[index] }))
    .sort((a, b) => (a.file.recordingStart ?? 0) - (b.file.recordingStart ?? 0))
    .map(({ file, entry }) => ({
      extension: file.extension ?? null,
      recordingStart: file.recordingStart ?? null,
      recordingEnd: file.recordingEnd ?? null,
      status: entry.status,
      reason: entry.reason ?? null,
      at: entry.at ?? null,
      name: entry.name ?? null,
      folder: entry.folder ?? null,
      size: entry.size ?? file.size ?? null,
      md5: entry.md5 ?? null,
      driveFileId: entry.driveFileId ?? null,
      destination: entry.destination ?? null,
    }));
  const filing = { status, files: kept.length, stored, basis: status === 'PENDING' ? 'requested' : 'confirmed', items };
  // Why filing is paused (Drive full, access revoked...) or failed for good (the file is gone, or
  // not the size the vendor said), and since when.
  if (status === 'BLOCKED' || status === 'FAILED') {
    const first = entries.filter(entry => entry.status === status).sort((a, b) => a.at - b.at)[0];
    Object.assign(filing, { reason: first.reason, since: first.at });
  }
  return filing;
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
    || (f.withdrawal && entry.at > f.withdrawal.at + TIMING.clockSkewMs)
    || (f.emergency && entry.at > f.emergency.at + TIMING.clockSkewMs)
    || (f.cancellation && entry.at > f.cancellation.at + TIMING.clockSkewMs));
  if (unapproved) add('UNAPPROVED_RECORDING_START', 'error', unapproved.at);
  // A stop that ended the session and still was not confirmed a minute later.
  const unconfirmedAfterEnd = reason => {
    const endRequest = f.endRequests.find(request => reason == null || request.reason === reason);
    return endRequest && captureMayBeOn(f) && now - endRequest.at >= TIMING.endConfirmMs ? endRequest.at + TIMING.endConfirmMs : null;
  };
  if (f.withdrawal) {
    add('CONSENT_WITHDRAWN', 'warning', f.withdrawal.at);
    const since = unconfirmedAfterEnd(null);
    if (since != null) add('WITHDRAWAL_STOP_UNCONFIRMED', 'error', since);
  }
  if (f.emergency) {
    add('EMERGENCY_STOP', 'warning', f.emergency.at);
    const since = unconfirmedAfterEnd('emergency_stop');
    if (since != null) add('EMERGENCY_STOP_UNCONFIRMED', 'error', since);
  }
  if (f.cancellation) {
    add('LESSON_CANCELLED', 'warning', f.cancellation.at);
    const since = unconfirmedAfterEnd('lesson_cancelled');
    if (since != null) add('LESSON_CANCELLED_STOP_UNCONFIRMED', 'error', since);
  }
  const lessonEndUnconfirmed = unconfirmedAfterEnd('lesson_end');
  if (lessonEndUnconfirmed != null) add('LESSON_END_STOP_UNCONFIRMED', 'error', lessonEndUnconfirmed);
  // A session the server asked Zoom to end and Zoom has not said is over, a minute after the
  // last request (G-2). Requested is never ended.
  // A session that may still be recording is already raised by its stop's own anomaly
  // (WITHDRAWAL_/EMERGENCY_/LESSON_CANCELLED_/LESSON_END_STOP_UNCONFIRMED), so it is not raised twice.
  const unended = endsAwaited(f).filter(item => now - item.lastAt >= TIMING.endConfirmMs
    && (item.attempts.some(attempt => END_UNTIL_ENDED.has(attempt.reason)) || f.cancellation || !captureOnIn(f, f.known.get(item.sessionId))));
  if (unended.length) add('SESSION_END_UNCONFIRMED', 'error', Math.min(...unended.map(item => item.firstAt + TIMING.endConfirmMs)), { count: unended.length });
  // Someone not on the roster (or on an old link) is in an older generation of the room (D-5).
  const occupied = oldRooms(f).filter(room => room.suspect);
  if (occupied.length) add('OLD_ROOM_SUSPECT', 'error', Math.min(...occupied.map(room => room.suspectSince)), { count: occupied.length });
  const waitingSince = fileWaitSince(f, phase);
  if (waitingSince != null) {
    const waited = now - waitingSince;
    if (waited >= TIMING.fileOverdueErrorMs) add('FILE_OVERDUE', 'error', waitingSince + TIMING.fileOverdueErrorMs);
    else if (waited >= TIMING.fileOverdueWarnMs) add('FILE_OVERDUE', 'warning', waitingSince + TIMING.fileOverdueWarnMs);
  }
  if (filing.status === 'FAILED') add('FILING_FAILED', 'error', f.completedAt);
  if (filing.status === 'BLOCKED') add('FILING_BLOCKED', 'error', filing.since, { reason: filing.reason });
  // Still not in Drive long after Zoom delivered it: the worker may not be running at all.
  if (filing.status === 'PENDING' && f.completedAt != null && now - f.completedAt >= TIMING.filingOverdueMs) {
    add('FILING_DELAYED', now - f.completedAt >= TIMING.filingStuckMs ? 'error' : 'warning', f.completedAt + TIMING.filingOverdueMs);
  }
  if (f.partOrderAt != null) add('PART_OUT_OF_ORDER', 'warning', f.partOrderAt);
  // The vendor's notice broke the Recording Adapter contract, so its recordings never reached P1.
  if (f.refusedAt != null) add('RECORDING_REFUSED', 'error', f.refusedAt);
  // The tutor's page reported a session the vendor does not know as this lesson's: it is never
  // used, and recording cannot be controlled until a confirmed session is known.
  if (f.sessionRejectedAt != null) add('SESSION_REJECTED', 'error', f.sessionRejectedAt);
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

// Ends that still matter: a live session that an end request reached, when the end is wanted
// whatever the recording (a cancelled lesson, an old room, an absent tutor) or the session may
// still be recording. Each with the first and last request and how many were sent (G-2).
function endsAwaited(f) {
  const items = [];
  const old = new Set(oldRooms(f).map(room => room.entry.id));
  for (const entry of liveSessions(f)) {
    // A cancelled lesson's sessions and an older generation's room are ended whatever the
    // recording; otherwise an end matters while the session may still be recording.
    const anyway = Boolean(f.cancellation) || old.has(entry.id);
    const attempts = f.endAttempts.filter(attempt => attempt.targets?.length !== 0 && reached(attempt, entry.id)
      && (END_UNTIL_ENDED.has(attempt.reason) || anyway || captureOnIn(f, entry)));
    if (!attempts.length) continue;
    items.push({ sessionId: entry.id, firstAt: attempts[0].at, lastAt: attempts[attempts.length - 1].at, attempts });
  }
  return items;
}

// The live sessions of an older generation of the room (D-5): which may hold someone who should
// not be there (not on the roster, or a reissued link's old id), since when, and whether everyone
// legitimate in it is already in a newer generation's session.
function oldRooms(f) {
  if (!f.currentGeneration || f.rotatedAt == null) return [];
  const live = liveSessions(f);
  const newerThan = entry => other => other !== entry
    && (other.generation != null && entry.generation != null ? other.generation > entry.generation : (other.startedAt ?? Infinity) > (entry.startedAt ?? -Infinity));
  return live
    .filter(entry => (entry.generation != null ? entry.generation < f.currentGeneration : entry.startedAt != null && entry.startedAt < f.rotatedAt))
    .map(entry => {
      const inside = [...entry.present.entries()].filter(([, presence]) => presence.in);
      const strangers = inside.filter(([, presence]) => !presence.legit);
      const legitimate = inside.filter(([, presence]) => presence.legit).map(([id]) => id);
      const newer = live.filter(newerThan(entry));
      return {
        entry,
        suspect: strangers.length > 0,
        suspectSince: strangers.length ? Math.min(...strangers.map(([, presence]) => presence.at)) : null,
        movedAll: legitimate.every(id => newer.some(other => other.present.get(id)?.in)),
      };
    });
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
  // Recording is decided before it could start. Consent or the tutor's notice entered while
  // nobody is in the room yet still counts, so a change then is decided again; once the lesson
  // is live the decision stands, and consent completed during class never starts a recording.
  if (state.phase.value !== 'ENDED' && now >= toMs(lesson.startsAt) - TIMING.waitingFromMs) {
    if (!f.eligibility) want(`decide:${id}`, 'DECIDE_RECORDING');
    else if (state.phase.value === 'WAITING' && f.consentChangedAt != null && f.consentChangedAt >= f.eligibility.at) {
      want(`decide:${id}:${f.consentChangedAt}`, 'DECIDE_RECORDING');
    }
  }
  const tutor = state.attendance.find(entry => entry.role === 'tutor');
  const live = state.phase.value === 'LIVE';
  const recording = state.recording;
  // Start only when the whole roster consented, nobody withdrew, nobody pressed the emergency
  // stop, the lesson is not past its end, the session is live, and both the tutor (the host) and
  // a student are confirmed in the room.
  const studentHere = state.attendance.some(entry => entry.role === 'student' && entry.status === 'PRESENT' && entry.basis === 'confirmed');
  const endStopAt = toMs(lesson.endsAt) + TIMING.lessonEndStopMs;
  // A cancelled lesson whose cancellation is not stored yet (the request that cancelled it
  // failed to store it, or another path set the flag): store it now, with the time it was found.
  // Its key is the one P3's cancel uses, so it is stored once whichever comes first.
  if (f.cancelledFlag && !f.cancellation) want(cancellationKey(id), 'RECORD_CANCELLATION');
  const cancelled = Boolean(f.cancellation || f.cancelledFlag);
  if (f.eligibility?.eligible === true && !f.withdrawal && !f.emergency && !cancelled && now < endStopAt
    && live && tutor?.status === 'PRESENT' && tutor.basis === 'confirmed' && studentHere) {
    const attempt = f.startRequests.length ? Math.max(...f.startRequests.map(request => request.attempt)) : 0;
    const response = f.startResponses.find(entry => entry.attempt === attempt);
    // A start goes to the session the lesson is in now: the newest one Zoom has not said is over.
    const newest = liveSessions(f).at(-1);
    const startIn = { targets: newest ? [newest.id] : [] };
    if (recording.status === 'NOT_REQUESTED') want(`start:${id}:1`, 'START_RECORDING', { attempt: 1, ...startIn });
    else if (recording.status === 'START_REQUESTED' && response && !response.ok && attempt < TIMING.maxStartAttempts
      && now >= response.at + TIMING.startRetryDelaysMs[attempt - 1]) want(`start:${id}:${attempt + 1}`, 'START_RECORDING', { attempt: attempt + 1, ...startIn });
    else if (recording.status === 'FAILED' && recording.reason === 'START_UNCONFIRMED' && f.startResponses.filter(entry => entry.ok).length === 1) {
      want(`start:${id}:${attempt + 1}`, 'START_RECORDING', { attempt: attempt + 1, ...startIn });
    }
  }
  // Protection first: consent withdrawn, an unknown person in the room, or recording we never
  // approved for a lesson that may not be recorded. Stop through both channels at once, again
  // after 30 seconds, and end the session after 60 seconds if Zoom still has not confirmed.
  // The sessions requests go to (G-1/G-3): every live session that may be recording, never just
  // the newest. With no session known at all the request still goes out, naming none, so the
  // attempt is on record (Zoom's adapter answers 409) and the session gets its own round once known.
  const liveNow = liveSessions(f);
  const capturing = liveNow.filter(entry => captureOnIn(f, entry));
  const trigger = stopTrigger(state, f);
  // Sessions the protective round below already stops, or asks to end in this plan, so no other
  // rule asks twice.
  const protectedIds = new Set();
  const endingIds = new Set();
  if (trigger && captureMayBeOn(f)) {
    const channels = ['rest', 'host'];
    // A recording that starts again after the stop (Zoom's automatic recording, the host, a
    // late start) is a new round with its own keys and times, so it is stopped again too. The
    // first round keeps the keys it always had.
    const restart = trigger.at == null ? null : startTransitions(f).filter(entry => entry.at > trigger.at).pop();
    const round = restart ? `:r${restart.at}` : '';
    const since = restart ? restart.at : trigger.at;
    const prefix = `stop:${id}:${trigger.reason}${round}:`;
    // Someone unknown is a reason to stop only the sessions they are in (or every one, when the
    // fact does not say which); the other triggers stop every capturing session.
    const scoped = trigger.reason === 'unknown_participant'
      ? capturing.filter(entry => f.unknown.some(stranger => stranger.sessionId == null || stranger.sessionId === entry.id))
      : capturing;
    const targets = scoped.map(entry => entry.id);
    for (const sid of targets) protectedIds.add(sid);
    if (targets.length || !liveNow.length) {
      want(`${prefix}1`, 'STOP_RECORDING', { reason: trigger.reason, attempt: 1, channels, targets });
      // Retries and the session end are timed from the trigger; a cancellation that is only the
      // lesson's flag gets the first stop now and the rest once it is stored (same tick). A
      // cancelled lesson's sessions are ended by their own rule below (D-2).
      if (since != null && now >= since + TIMING.stopRetryMs) want(`${prefix}2`, 'STOP_RECORDING', { reason: trigger.reason, attempt: 2, channels, targets });
      if (since != null && now >= since + TIMING.endSessionMs && trigger.reason !== 'lesson_cancelled') {
        want(`end:${id}:${trigger.reason}${round}`, 'END_SESSION', { reason: trigger.reason, targets });
        for (const sid of targets) endingIds.add(sid);
      }
    }
    // A capturing session this round's first stop did not reach, because it went out before the
    // session was known (G-1): its own stop now, again after 30 seconds, and its end after 60,
    // timed from when it became known. Until the round's first stop has gone out, that stop
    // covers every capturing session itself.
    const roundStarted = f.performed.has(`${prefix}1`);
    for (const entry of roundStarted ? scoped : []) {
      if (f.stopAttempts.some(attempt => (attempt.key === `${prefix}1` || attempt.key === `${prefix}2`) && attempt.targets?.length !== 0 && reached(attempt, entry.id))) continue;
      const from = Math.max(since ?? 0, entry.knownAt ?? 0);
      const own = { reason: trigger.reason, channels, targets: [entry.id] };
      want(`${prefix}1@${entry.id}`, 'STOP_RECORDING', { ...own, attempt: 1 });
      if (now >= from + TIMING.stopRetryMs) want(`${prefix}2@${entry.id}`, 'STOP_RECORDING', { ...own, attempt: 2 });
      if (now >= from + TIMING.endSessionMs && trigger.reason !== 'lesson_cancelled') {
        want(`end:${id}:${trigger.reason}${round}@${entry.id}`, 'END_SESSION', { reason: trigger.reason, targets: [entry.id] });
        endingIds.add(entry.id);
      }
    }
  }
  // D-2 (G-4): a cancelled lesson's live sessions are all ended, each in its own right: at once
  // when nothing may be recording in it, otherwise once Zoom confirms the stop or 60 seconds
  // after the stop was asked for, whichever is first. With no session known but something
  // possibly recording, the end is still asked for at 60 seconds, naming none.
  if (f.cancellation) {
    for (const entry of liveNow) {
      // Already asked to end (by another rule, now or before): that request is retried until Zoom
      // confirms, as every end of a cancelled lesson is (endsAwaited).
      if (endingIds.has(entry.id) || f.endAttempts.some(attempt => attempt.targets?.length !== 0 && reached(attempt, entry.id))) continue;
      const from = Math.max(f.cancellation.at, entry.knownAt ?? 0);
      if (!captureOnIn(f, entry) || now >= from + TIMING.endSessionMs) {
        want(`end:${id}:lesson_cancelled@${entry.id}`, 'END_SESSION', { reason: 'lesson_cancelled', targets: [entry.id] });
      }
    }
    if (!liveNow.length && captureMayBeOn(f) && now >= f.cancellation.at + TIMING.endSessionMs) {
      want(`end:${id}:lesson_cancelled`, 'END_SESSION', { reason: 'lesson_cancelled', targets: [] });
    }
  }
  // The lesson is over: stop recording once its scheduled end and the grace have passed, again
  // after 30 seconds, and end the session after 60 seconds if Zoom still has not confirmed.
  const capturingIds = capturing.map(entry => entry.id);
  if (!trigger && now >= endStopAt && captureMayBeOn(f) && (capturingIds.length || !liveNow.length)) {
    want(`stop:${id}:lesson_end:1`, 'STOP_RECORDING', { reason: 'lesson_end', attempt: 1, channels: ['rest'], targets: capturingIds });
    if (now >= endStopAt + TIMING.stopRetryMs) want(`stop:${id}:lesson_end:2`, 'STOP_RECORDING', { reason: 'lesson_end', attempt: 2, channels: ['rest'], targets: capturingIds });
    if (now >= endStopAt + TIMING.endSessionMs) want(`end:${id}:lesson_end`, 'END_SESSION', { reason: 'lesson_end', targets: capturingIds });
  }
  // The tutor has gone: stop recording after 5 minutes and end the session after 15.
  if (tutor?.status === 'LEFT' && tutor.basis === 'confirmed' && live) {
    if (captureMayBeOn(f) && now - tutor.since >= TIMING.tutorAbsentStopMs) {
      want(`stop:${id}:tutor_absent:${tutor.since}`, 'STOP_RECORDING', { reason: 'tutor_absent', attempt: 1, channels: ['rest'], targets: capturingIds });
    }
    if (now - tutor.since >= TIMING.tutorAbsentEndMs) want(`end:${id}:tutor_absent:${tutor.since}`, 'END_SESSION', { reason: 'tutor_absent', targets: liveNow.map(entry => entry.id) });
  }
  // D-5: an older generation of the room is cleaned up. Nothing there is recorded any more: a
  // recording in it is stopped at once (the lesson goes on in the new room). The room is ended
  // once everyone legitimate has moved to the new one, or after a grace; when someone who should
  // not be there is in it, after a minute at the latest. A cancelled lesson's rooms are all ended
  // by D-2 above.
  if (!f.cancellation && !f.cancelledFlag) {
    for (const room of oldRooms(f)) {
      const sid = room.entry.id;
      if (captureOnIn(f, room.entry) && !protectedIds.has(sid)) {
        want(`migrate:${id}:${sid}:stop`, 'STOP_RECORDING', { reason: room.suspect ? 'old_room_suspect' : 'old_room', attempt: 1, channels: ['rest'], targets: [sid] });
      }
      // One end per room: another rule may already have asked (that request is then retried until
      // Zoom confirms, as for every old room, endsAwaited).
      if (endingIds.has(sid) || f.endAttempts.some(attempt => attempt.targets?.length !== 0 && reached(attempt, sid))) continue;
      // With a stranger in it, the legitimate people get a minute from the change to move, then
      // the room is ended (at once, for a stranger who comes later). Otherwise it is ended as soon
      // as everyone legitimate has moved, or after the longer grace.
      const due = room.suspect ? now >= f.rotatedAt + TIMING.oldRoomSuspectEndMs : room.movedAll || now >= f.rotatedAt + TIMING.oldRoomEndMs;
      if (due) {
        want(`migrate:${id}:${sid}:end`, 'END_SESSION', { reason: room.suspect ? 'old_room_suspect' : 'old_room', targets: [sid] });
      }
    }
  }
  // G-2: an end Zoom has not confirmed is asked for again after 2, 5, 10 and 30 minutes, each
  // try under its own key; after that the anomaly stays for the administrator.
  for (const item of endsAwaited(f)) {
    const base = item.attempts.find(attempt => !/:retry\d+(@[^:]*)?$/.test(attempt.key));
    if (!base) continue;
    const tries = item.attempts.filter(attempt => attempt.key.startsWith(`${base.key}:retry`)).length;
    if (tries >= TIMING.endRetryMs.length || now < item.lastAt + TIMING.endRetryMs[tries]) continue;
    // A request that named this session alone keeps its key; one that named several gets a key
    // per session, so each is asked again in its own right.
    const own = base.targets?.length === 1 ? '' : `@${item.sessionId}`;
    want(`${base.key}:retry${tries + 1}${own}`, 'END_SESSION', { reason: base.reason, targets: [item.sessionId] });
  }
  for (const entry of f.unknown) want(`remove:${id}:${entry.userKey}:${entry.at}`, 'REMOVE_USER', { userKey: entry.userKey });
  for (const anomaly of state.anomalies) if (anomaly.severity === 'error') want(`notify:${id}:${anomaly.code}`, 'NOTIFY_ADMIN', { code: anomaly.code });
  return actions;
}

// The key under which a lesson's cancellation is stored, by P3's cancel and by the tick alike.
export const cancellationKey = lessonId => `server.lesson_cancelled:${lessonId}`;

function stopTrigger(state, f) {
  if (f.emergency) return { reason: 'emergency_stop', at: f.emergency.at };
  if (f.cancellation) return { reason: 'lesson_cancelled', at: f.cancellation.at };
  if (f.cancelledFlag) return { reason: 'lesson_cancelled', at: null };
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
  // A protective or end-of-lesson stop Zoom has not confirmed yet is checked first.
  const protectiveStop = f.withdrawal || f.emergency || f.cancellation || f.stopRequests.some(request => request.reason === 'lesson_end');
  if (protectiveStop && f.stopRequests.length && captureMayBeOn(f)) return { reason: 'stop_unconfirmed', priority: 0, waitingSince: f.stopRequests[0].at };
  // A session the server asked to end and Zoom has not said is over (G-2): Zoom's answer is the
  // only confirmation that counts, so it is asked.
  const awaited = endsAwaited(f);
  if (awaited.length) return { reason: 'end_unconfirmed', priority: 0, waitingSince: Math.min(...awaited.map(item => item.firstAt)) };
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
