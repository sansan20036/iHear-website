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
import { OPERATION, OPERATION_EVENT } from './operations.mjs';
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
  // P3-Multi (18.1): a block's Lobby and rooms still live this long after the scheduled end (when
  // the join window has closed) are ended by the server's own schedule, whoever is signed in.
  blockCleanupMs: 15 * 60_000,
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
  'server.consent_changed', 'server.recording_resume_authorized', 'server.recording_eligibility', 'server.consent_withdrawn', 'server.emergency_stop', 'server.lesson_cancelled', 'session.started', 'session.user_joined', 'host.user_added',
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

// The room's host for the rules (P3-Multi, 2026-11-09): a room may have several tutors (a lead
// and co-tutors, each a host). Present beats absent, Zoom's word beats an inference; with nobody
// present, one who left beats one who never came. With one tutor, that tutor, as before.
export function hostOf(attendance) {
  const tutors = attendance.filter(entry => entry.role === 'tutor');
  return tutors.find(entry => entry.status === 'PRESENT' && entry.basis === 'confirmed')
    ?? tutors.find(entry => entry.status === 'PRESENT')
    ?? tutors.find(entry => entry.status !== 'NOT_JOINED' && entry.status !== 'LEFT')
    ?? tutors.find(entry => entry.status !== 'NOT_JOINED')
    ?? tutors[0];
}

function analyze(lesson, events, now) {
  const start = toMs(lesson.startsAt);
  const end = toMs(lesson.endsAt);
  // The room's roster as it is now. P3-Multi (2026-11-09): an observer (a manager's visit, a tutor
  // waiting in the Lobby) and a seat given up (moved to another room, visit over) are people who
  // may be there, not strangers, but are not counted for attendance.
  const people = new Map(lesson.participants.filter(entry => entry.role !== 'observer' && entry.active !== false).map(entry => [entry.id, { ...entry, facts: [] }]));
  const others = new Set(lesson.participants.filter(entry => entry.role === 'observer' || entry.active === false).map(entry => entry.id));
  const tutor = [...people.values()].find(entry => entry.role === 'tutor');
  // A report from the tutor's page belongs to the tutor who sent it (a room may have several).
  const reporter = event => (event.participantId && people.get(String(event.participantId))?.role === 'tutor' ? people.get(String(event.participantId)) : tutor);
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
    // Every recording decision with the room generation it was made for (0: the lesson's own),
    // and the owners' authorizations to record again in a newer room (2026-11-08, room moves).
    decisions: [], resumes: [],
    // Recording actions carried out under a claim (G1, 2026-11-09), by action key.
    operations: new Map(),
  };
  const lessonEvents = ordered(events.filter(entry => entry.lessonId === lesson.id), now);
  // A reissued link gives the student a new participant id (D-4). Facts about the old id from
  // before the change are the same student's; after it, the old id is not on the roster.
  const rotated = new Map(lessonEvents.filter(event => event.type === 'server.participant_rotated').map(event => [String(event.from), { to: String(event.to), at: event.occurredAt }]));
  const resolve = (participantId, at) => {
    if (!participantId) return { person: null, former: false };
    if (people.has(participantId)) return { person: people.get(participantId), former: false };
    if (others.has(participantId)) return { person: null, former: false, known: true };
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
    const { person, former, known } = resolve(event.participantId, at);
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
        else if (!known) f.unknown.push({ at, userKey: event.participantId || 'unknown', sessionId: sid, former });
        if (trusted) {
          trusted.present.set(person ? person.id : String(event.participantId || 'unknown'), { in: true, at, legit: Boolean(person || known) });
          if (!person && !known) trusted.suspects.push({ at, userKey: event.participantId || 'unknown', former });
        }
        break;
      case 'session.user_left':
      case 'host.user_removed':
        if (person) person.facts.push({ kind: 'left', at, source: event.source, reason: event.leaveReason ?? null });
        if (trusted) trusted.present.set(person ? person.id : String(event.participantId || 'unknown'), { in: false, at, legit: Boolean(person || known) });
        break;
      case 'server.room_generation':
        f.generations.push({ generation: Number(event.generation) || 0, at });
        break;
      case 'host.heartbeat': {
        const host = reporter(event);
        if (host) host.facts.push({ kind: 'present', at, source: event.source, heartbeat: true });
        break;
      }
      case 'host.connection': {
        const host = reporter(event);
        if (host && event.state === 'Reconnecting') host.facts.push({ kind: 'reconnecting', at, source: event.source });
        else if (host && event.state === 'Connected') host.facts.push({ kind: 'present', at, source: event.source, heartbeat: true });
        else if (host) host.facts.push({ kind: 'left', at, source: event.source, reason: event.state === 'Fail' ? 'DISCONNECTED' : 'LEFT' });
        break;
      }
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
        // Each file keeps the session it was recorded in, so a lesson that moved rooms can tell
        // which room's recording each file is.
        for (const file of event.files) f.completed.set(file.providerFileId, { ...file, sessionId: sid });
        f.completedAt = latest(f.completedAt, at);
        break;
      case 'session.alert':
        f.alerts.push({ at, issues: event.issues });
        break;
      case 'server.recording_eligibility':
        f.decisions.push({ eligible: event.eligible === true, reason: event.reason, count: event.count ?? 0, at, generation: Number(event.generation) || 0 });
        break;
      case OPERATION_EVENT:
        f.operations.set(String(event.operation), event);
        break;
      case 'server.recording_resume_authorized':
        f.resumes.push({ generation: Number(event.generation) || 0, at });
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
        f.startRequests.push({ attempt: event.attempt, at, key: String(event.key ?? ''), generation: Number(event.generation) || 0 });
        break;
      case 'server.start_response':
        f.startResponses.push({ attempt: event.attempt, ok: event.ok === true, at, targets: targetsOf(event), key: String(event.key ?? ''), generation: Number(event.generation) || 0 });
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
  // A start whose answer was lost, or whose executor stopped, and that Zoom has not been seen to do
  // or refuse yet (G1): recording may be on in its session.
  f.unresolvedStarts = [...f.operations.values()].filter(op => op.action === 'START_RECORDING'
    && ['IN_FLIGHT', 'UNCERTAIN', 'UNKNOWN'].includes(op.state) && !f.performed.has(String(op.operation)));
  decideRoomRecording(f);
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
    // Each session's own recording, as far as Zoom has confirmed it: STOPPED only on Zoom's word
    // (or its end of the session); a stop that was only asked for stays STOP_REQUESTED.
    sessions: [...f.known.values()].map(entry => ({ id: entry.id, generation: entry.generation, live: entry.endedAt == null, endedAt: entry.endedAt, capture: sessionCapture(f, entry) })),
    // Recording in the current room after a move (null before any move).
    roomRecording: roomRecordingOf(f, { phase, now, endStopAt: end + TIMING.lessonEndStopMs }),
    anomalies,
    dataState: { value: errors ? 'ANOMALY' : quiet || waiting || inferred || overdue ? 'DELAYED' : 'REALTIME', lastConfirmedAt: f.lastConfirmedAt },
  };
  return { state, facts: f };
}

// Recording after the room moved (2026-11-08). The lesson's own decision (generation 0) is made
// before it starts, as always. Once the room has a newer generation (a link revoked or
// reissued), that decision alone no longer starts anything there:
//   A  nothing was recorded before the move: the server checks again, for the current room,
//      the lesson, the roster as it is now and each consent (not withdrawn, not expired, the
//      current version, the tutor's notice). Only if that check passes does the usual start
//      follow, in this room.
//   B  something was recorded before the move: nothing starts in the new room on its own. An
//      owner has to authorize recording in this room; then the same check runs, from the time
//      of that authorization, and only then may it start (and only once every older room's
//      recording is confirmed stopped). The authorization never stands in for anyone's consent.
// The room's check goes by the consents as they are at that moment (2026-11-08, second rule set):
// consent that is valid now counts, whether it was there when the lesson started or was given
// after the move, and the check runs again after every later consent or notice change. Consent
// never reaches back: a recording is covered only by a check made before it started (filing
// holds anything else). A withdrawal, an emergency stop, a cancellation or the lesson's end is
// never undone by a move.
function decideRoomRecording(f) {
  const latestOf = list => list.reduce((best, entry) => (!best || entry.at >= best.at ? entry : best), null);
  const g = f.currentGeneration;
  f.baseDecision = latestOf(f.decisions.filter(entry => entry.generation === 0));
  f.recordedBefore = g > 0 && (f.recording.some(fact => fact.status === 'Recording' && fact.at < f.rotatedAt)
    || f.startResponses.some(response => response.ok && response.at < f.rotatedAt));
  f.resumeAt = g > 0 ? latestOf(f.resumes.filter(entry => entry.generation === g && entry.at >= f.rotatedAt))?.at ?? null : null;
  // From when the current room's check counts: from the move (A) or the owner's authorization
  // (B), and from each consent or notice change after that. Null: no check is due (yet).
  const opens = g > 0 ? (f.recordedBefore ? (f.resumeAt == null ? null : Math.max(f.rotatedAt, f.resumeAt)) : f.rotatedAt) : null;
  f.recheckFrom = opens == null ? null : Math.max(opens, f.consentChangedAt != null && f.consentChangedAt >= opens ? f.consentChangedAt : opens);
  f.roomDecision = f.recheckFrom == null ? null : latestOf(f.decisions.filter(entry => entry.generation === g && entry.at >= f.recheckFrom));
  // What the overview and the other rules go by: the current room's latest check after a move,
  // the lesson's own decision before any.
  const roomLatest = g > 0 ? latestOf(f.decisions.filter(entry => entry.generation === g && entry.at >= f.rotatedAt)) : null;
  f.eligibility = roomLatest ?? f.baseDecision;
}

// The decision that covered a moment in a generation of the room: the lesson's own for the first
// room; for a newer one, the latest check for it made by then (a check never reaches back).
function decisionFor(f, generation, at) {
  if (!generation) return f.baseDecision;
  return f.decisions.filter(entry => entry.generation === generation && entry.at <= at + TIMING.clockSkewMs)
    .reduce((best, entry) => (!best || entry.at >= best.at ? entry : best), null);
}

// The generation the room had at a moment (0 before any move).
function generationAt(f, at) {
  return f.generations.filter(entry => entry.at <= at).reduce((top, entry) => Math.max(top, entry.generation), 0);
}

// The current generation's room the lesson is in now: the newest live session named as that
// generation (or, with no name from Zoom, one that started after the move).
function currentRoom(f) {
  const g = f.currentGeneration;
  return liveSessions(f).filter(entry => (entry.generation != null ? entry.generation === g : entry.startedAt != null && f.rotatedAt != null && entry.startedAt >= f.rotatedAt)).at(-1) ?? null;
}

// Where recording stands in the current room after a move, for the overview and the owner's
// authorization (null before any move).
function roomRecordingOf(f, { phase, now, endStopAt }) {
  const g = f.currentGeneration;
  if (!g) return null;
  const room = currentRoom(f);
  const oldCapturing = liveSessions(f).some(entry => entry !== room && captureOnIn(f, entry));
  const base = { generation: g, rule: f.recordedBefore ? 'AUTHORIZATION_REQUIRED' : 'RECHECK', authorizedAt: f.resumeAt, recheck: f.roomDecision ? { eligible: f.roomDecision.eligible, reason: f.roomDecision.reason, at: f.roomDecision.at } : null, oldRoomStillRecording: oldCapturing };
  const blocked = f.emergency ? 'EMERGENCY_STOP' : (f.cancellation || f.cancelledFlag) ? 'LESSON_CANCELLED' : f.withdrawal ? 'CONSENT_WITHDRAWN'
    : now >= endStopAt || phase.value === 'ENDED' ? 'LESSON_OVER' : null;
  if (blocked) return { ...base, status: 'BLOCKED', reason: blocked, canAuthorize: false };
  if (f.recordedBefore && f.resumeAt == null) return { ...base, status: 'WAITING_FOR_AUTHORIZATION', reason: null, canAuthorize: !oldCapturing && phase.value === 'LIVE' };
  if (!f.roomDecision) return { ...base, status: 'RECHECK_PENDING', reason: null, canAuthorize: false };
  if (!f.roomDecision.eligible) return { ...base, status: 'RECHECK_REFUSED', reason: f.roomDecision.reason, canAuthorize: f.recordedBefore && !oldCapturing && phase.value === 'LIVE' };
  return { ...base, status: 'ALLOWED', reason: null, canAuthorize: false, sessionId: room?.id ?? null };
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
// The tutor's page reports the room it is in. After a move that is the new room, so its report
// says nothing about an older room's recording (2026-11-08): it counts for a session only when
// that session is of the generation the room had at the time of the report.
function sessionFacts(f, entry) {
  return f.recording.filter(fact => fact.sessionId === entry.id
    || (fact.sessionId == null && (entry.generation == null || generationAt(f, fact.at) === entry.generation)));
}

function captureOnIn(f, entry) {
  const endedAfter = at => entry.endedAt != null && entry.endedAt >= at;
  // A start to this session whose outcome is not known (G1): Zoom may be recording there.
  const pending = (f.unresolvedStarts ?? []).find(op => (op.params?.targets ?? []).includes(entry.id));
  if (pending && !endedAfter(pending.since)) {
    const after = sessionFacts(f, entry).filter(fact => fact.at >= pending.since).pop();
    if (!after || after.status === 'Recording') return true;
  }
  const facts = sessionFacts(f, entry);
  const last = facts[facts.length - 1];
  if (last) return last.status === 'Recording' && !endedAfter(last.at);
  const accepted = f.startResponses.filter(response => response.ok && (!response.targets || !response.targets.length || response.targets.includes(entry.id))).pop();
  return !!accepted && !endedAfter(accepted.at);
}

// Capture may still be running: Zoom last said "recording" (or accepted a start and has not
// answered since), and no session end came after that; or any one known session may still be
// recording, whatever the others say (a newer room's stop never counts for an older one).
function captureMayBeOn(f) {
  if ([...f.known.values()].some(entry => captureOnIn(f, entry))) return true;
  const last = f.recording[f.recording.length - 1];
  const endedAfter = at => f.lastSessionEnd != null && f.lastSessionEnd >= at;
  if (last) return last.status === 'Recording' && !endedAfter(last.at);
  const accepted = f.startResponses.filter(response => response.ok).pop();
  return !!accepted && !endedAfter(accepted.at);
}

// One session's recording, as far as it is known:
//   NONE            nothing was ever recorded or accepted there
//   RECORDING       may be recording (Zoom said so, or accepted a start), no stop asked for since
//   STOP_REQUESTED  may still be recording; the server asked for a stop, Zoom has not confirmed
//   PAUSED          Zoom said paused
//   STOPPED         Zoom said the recording stopped
//   ENDED           Zoom said the session ended after it recorded (so recording ended with it)
function sessionCapture(f, entry) {
  const facts = sessionFacts(f, entry);
  const accepted = f.startResponses.some(response => response.ok && (!response.targets || !response.targets.length || response.targets.includes(entry.id)));
  // A start whose outcome is not known (G1) makes it possibly recording, never NONE.
  if (!facts.length && !accepted && !captureOnIn(f, entry)) return 'NONE';
  if (captureOnIn(f, entry)) {
    const since = facts.length ? facts[facts.length - 1].at : 0;
    const asked = f.stopAttempts.some(attempt => attempt.targets?.length !== 0 && reached(attempt, entry.id) && attempt.at >= since - TIMING.clockSkewMs);
    return asked ? 'STOP_REQUESTED' : 'RECORDING';
  }
  const last = facts[facts.length - 1];
  if (last?.status === 'Paused' && entry.endedAt == null) return 'PAUSED';
  if (last?.status === 'Stopped') return 'STOPPED';
  // Never STOPPED without Zoom's word.
  return entry.endedAt != null ? 'ENDED' : 'RECORDING';
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
  // After a move, a start in the current room has requests of its own (its generation); while
  // the newest of them is later than the last recording fact, they say where recording stands.
  const roomRequests = f.currentGeneration ? f.startRequests.filter(request => request.generation === f.currentGeneration) : [];
  // A start for the current room whose outcome is not known (G1) and is newer than the last fact.
  const unresolved = (f.unresolvedStarts ?? []).filter(op => (Number(op.params?.generation) || 0) === f.currentGeneration && (!last || op.since > last.at));
  const roomStartPending = unresolved.length > 0 || (roomRequests.length > 0 && (!last || Math.max(...roomRequests.map(request => request.at)) > last.at));
  // Completed only when nothing may still be recording (another room's file may come first).
  if (f.completed.size && !roomStartPending && !captureMayBeOn(f)) return { status: 'COMPLETED', basis: 'confirmed', since: f.completedAt, source: 'zoom' };
  // Requested, with its outcome unknown: never "not requested", "blocked" or "stopped" meanwhile.
  if (unresolved.length) {
    return { status: 'START_REQUESTED', basis: 'requested', since: Math.min(...unresolved.map(op => op.since)), outcome: unresolved.some(op => op.state === 'UNKNOWN') ? 'UNKNOWN' : 'UNCERTAIN' };
  }
  if (last && !roomStartPending) {
    // The last word is about one session; another may still be recording (an older room whose
    // stop Zoom has not confirmed). Then the lesson is not shown as stopped (2026-11-08).
    if (last.status !== 'Recording') {
      const stillOn = [...f.known.values()].filter(entry => captureOnIn(f, entry));
      if (stillOn.length) {
        const seen = stillOn.flatMap(entry => sessionFacts(f, entry).filter(fact => fact.status === 'Recording'));
        const since = seen.length ? Math.max(...seen.map(fact => fact.at)) : last.at;
        const stopAsked = f.stopAttempts.some(attempt => attempt.targets?.length !== 0 && stillOn.some(entry => reached(attempt, entry.id)) && attempt.at >= since - TIMING.clockSkewMs);
        return { status: 'RECORDING', basis: seen.length ? 'confirmed' : 'requested', since, source: seen.length ? seen[seen.length - 1].source : 'server', lateConfirmation: false, pending: stopAsked ? 'STOP_REQUESTED' : null };
      }
    }
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
  // The current room's own attempts after a move; before any move, all of them.
  const requests = f.currentGeneration ? roomRequests : f.startRequests;
  const responses = f.currentGeneration ? f.startResponses.filter(entry => entry.generation === f.currentGeneration) : f.startResponses;
  if (!requests.length) return { status: 'NOT_REQUESTED', basis: 'confirmed', since: null };
  const attempt = Math.max(...requests.map(request => request.attempt));
  const request = requests.find(entry => entry.attempt === attempt);
  const response = responses.find(entry => entry.attempt === attempt);
  if (response && !response.ok) {
    if (responses.filter(entry => !entry.ok).length >= TIMING.maxStartAttempts) {
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
      // Which session (and so which generation of the room) the file was recorded in.
      sessionId: file.sessionId ?? null,
      generation: file.sessionId ? f.known.get(file.sessionId)?.generation ?? null : null,
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

// Starts seen one session at a time (a fact that names no session counts with the generation
// the room had then), so that one room's recording never hides another room's start.
function roomStartTransitions(f) {
  const starts = [];
  const previous = new Map();
  for (const entry of f.recording) {
    const room = entry.sessionId ?? `generation:${generationAt(f, entry.at)}`;
    if (entry.status === 'Recording' && previous.get(room) !== 'Recording') starts.push(entry);
    previous.set(room, entry.status);
  }
  return starts;
}

function anomaliesOf({ f, phase, attendance, recording, filing, start, end, now }) {
  const list = [];
  const add = (code, severity, since, extra = {}) => list.push({ code, severity, since, ...extra });
  const tutor = hostOf(attendance);
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
  // it without our approval, or any start once the lesson may not be recorded. Each start is
  // judged by the decision that covered its own room at that moment, so a later room's refused
  // check never makes an earlier, approved recording look unapproved.
  const roomOf = entry => (entry.sessionId ? f.known.get(entry.sessionId)?.generation : null) ?? generationAt(f, entry.at);
  const unapproved = startTransitions(f).find(entry =>
    !f.startRequests.some(request => request.at <= entry.at + TIMING.clockSkewMs)
    || decisionFor(f, roomOf(entry), entry.at)?.eligible !== true
    || (f.withdrawal && entry.at > f.withdrawal.at + TIMING.clockSkewMs)
    || (f.emergency && entry.at > f.emergency.at + TIMING.clockSkewMs)
    || (f.cancellation && entry.at > f.cancellation.at + TIMING.clockSkewMs));
  // After a move, a recording that starts in any room (the new one or an old one) needs a start
  // the server sent for the generation the room had then; the earlier generation's start does
  // not cover it (2026-11-08). Seen per session, so another room's recording does not hide it.
  // A start in a room the lesson had already left (an older generation) is never approved.
  const inRoom = roomStartTransitions(f).find(entry => {
    const g = roomOf(entry);
    if (g < generationAt(f, entry.at)) return true;
    return g > 0 && !f.startRequests.some(request => request.generation === g && request.at <= entry.at + TIMING.clockSkewMs);
  });
  if (unapproved || inRoom) {
    add('UNAPPROVED_RECORDING_START', 'error', Math.min(unapproved?.at ?? Infinity, inRoom?.at ?? Infinity), inRoom ? { roomGeneration: roomOf(inRoom) } : {});
  }
  // An older room's recording the server asked to stop, still not confirmed 30 seconds later:
  // it stays an error until Zoom says it stopped or the session ended, and is never shown as a
  // safe stop meanwhile (the tick asks again, then ends the room, then keeps asking for the end).
  const stuck = oldRooms(f).filter(room => captureOnIn(f, room.entry)
    && f.stopAttempts.some(attempt => (attempt.reason === 'old_room' || attempt.reason === 'old_room_suspect') && attempt.targets?.length !== 0 && reached(attempt, room.entry.id) && now - attempt.at >= TIMING.stopRetryMs));
  if (stuck.length) {
    const first = Math.min(...stuck.map(room => f.stopAttempts.filter(attempt => reached(attempt, room.entry.id)).reduce((low, attempt) => Math.min(low, attempt.at), Infinity)));
    add('OLD_ROOM_STOP_UNCONFIRMED', 'error', first + TIMING.stopRetryMs, { count: stuck.length });
  }
  // A start whose answer was lost and whose outcome Zoom's state could not tell (G1): it is never
  // sent again blindly; it stays an error until Zoom's notice or answer settles it.
  const unknownStarts = (f.unresolvedStarts ?? []).filter(op => op.state === 'UNKNOWN');
  if (unknownStarts.length) add('RECORDING_ACTION_UNKNOWN', 'error', Math.min(...unknownStarts.map(op => op.updatedAt)), { count: unknownStarts.length });
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
  const wanted = new Set();
  // Each key once per plan (two rules may want the same action), never again once performed.
  const want = (key, type, extra = {}) => {
    if (f.performed.has(key) || wanted.has(key)) return;
    wanted.add(key);
    actions.push({ key, type, lessonId: id, ...extra });
  };
  // Recording is decided before it could start, and decided again after every consent or notice
  // change, before the lesson and during it alike (G2, 2026-11-09: one rule for a lesson that never
  // moved and for a moved room; consent completed during class allows recording from then on,
  // pending iHear's confirmation of this as its policy). A moved room's checks are its own
  // (planRoomStart). Every start checks once more just before Zoom is asked, and that check is the
  // decision that covers the recording: consent never reaches back to anything recorded before it.
  if (state.phase.value !== 'ENDED' && now >= toMs(lesson.startsAt) - TIMING.waitingFromMs) {
    if (!f.baseDecision) want(`decide:${id}`, 'DECIDE_RECORDING');
    else if (!f.currentGeneration && f.consentChangedAt != null && f.consentChangedAt >= f.baseDecision.at) {
      want(`decide:${id}:${f.consentChangedAt}`, 'DECIDE_RECORDING');
    }
  }
  const tutor = hostOf(state.attendance);
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
  if (f.currentGeneration) planRoomStart({ lesson, f, state, want, now, endStopAt, cancelled });
  else if (f.eligibility?.eligible === true && !f.withdrawal && !f.emergency && !cancelled && now < endStopAt
    && live && tutor?.status === 'PRESENT' && tutor.basis === 'confirmed' && studentHere) {
    const attempt = f.startRequests.length ? Math.max(...f.startRequests.map(request => request.attempt)) : 0;
    const response = f.startResponses.find(entry => entry.attempt === attempt);
    // A start goes to the session the lesson is in now: the newest one Zoom has not said is over.
    const newest = liveSessions(f).at(-1);
    const startIn = { targets: newest ? [newest.id] : [] };
    // The first start: nothing asked yet; or (G2, 2026-11-09, one rule with a moved room) the server
    // never started anything here and nothing records now, as after a recording no start of ours
    // covered was stopped before the consent was complete. A recording the server started and that
    // stopped is never started again in the same room.
    const neverStarted = !f.startRequests.length && !f.unresolvedStarts.length && !liveSessions(f).some(entry => captureOnIn(f, entry));
    if (recording.status === 'NOT_REQUESTED' || (neverStarted && !captureMayBeOn(f))) want(`start:${id}:1`, 'START_RECORDING', { attempt: 1, ...startIn });
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
    // A recording no start of ours covers after a move is its own episode, with keys of its own.
    const restart = trigger.at == null || trigger.episode ? null : startTransitions(f).filter(entry => entry.at > trigger.at).pop();
    const round = trigger.episode ? `:e${trigger.at}` : restart ? `:r${restart.at}` : '';
    const since = restart ? restart.at : trigger.at;
    const prefix = `stop:${id}:${trigger.reason}${round}:`;
    // Someone unknown is a reason to stop only the sessions they are in (or every one, when the
    // fact does not say which); such an episode stops only its own session; the other triggers
    // stop every capturing session.
    const scoped = trigger.sessionId
      ? capturing.filter(entry => entry.id === trigger.sessionId)
      : trigger.reason === 'unknown_participant'
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
  if (lesson.blockId && now >= toMs(lesson.endsAt) + TIMING.blockCleanupMs && liveNow.length) {
    want(`end:${id}:block_over`, 'END_SESSION', { reason: 'block_over', targets: liveNow.map(entry => entry.id) });
  }
  // The tutor has gone: stop recording after 5 minutes and end the session after 15. Not in a
  // block's Lobby (P3-Multi): its manager leaving to visit a room is normal, and the Lobby is
  // never recorded.
  if (lesson.roomKind !== 'lobby' && tutor?.status === 'LEFT' && tutor.basis === 'confirmed' && live) {
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
      const reason = room.suspect ? 'old_room_suspect' : 'old_room';
      const recordingThere = captureOnIn(f, room.entry);
      // The stop is asked again after 30 seconds, and a recording that starts there again later
      // gets a round of its own (2026-11-08); it is never taken as stopped without Zoom's word.
      const restartedAt = roomStartTransitions(f).filter(entry => entry.sessionId === sid && entry.at > f.rotatedAt).pop()?.at;
      const firstStop = f.stopAttempts.find(attempt => attempt.key === `migrate:${id}:${sid}:stop`);
      const stopKey = restartedAt != null && firstStop && restartedAt > firstStop.at ? `migrate:${id}:${sid}:stop:r${restartedAt}` : `migrate:${id}:${sid}:stop`;
      const sent = f.stopAttempts.find(attempt => attempt.key === stopKey);
      if (recordingThere && !protectedIds.has(sid)) {
        want(stopKey, 'STOP_RECORDING', { reason, attempt: 1, channels: ['rest'], targets: [sid] });
        if (sent && now >= sent.at + TIMING.stopRetryMs) want(`${stopKey}:2`, 'STOP_RECORDING', { reason, attempt: 2, channels: ['rest'], targets: [sid] });
      }
      // One end per room: another rule may already have asked (that request is then retried until
      // Zoom confirms, as for every old room, endsAwaited).
      if (endingIds.has(sid) || f.endAttempts.some(attempt => attempt.targets?.length !== 0 && reached(attempt, sid))) continue;
      // With a stranger in it, the legitimate people get a minute from the change to move, then
      // the room is ended (at once, for a stranger who comes later). Otherwise it is ended as soon
      // as everyone legitimate has moved, or after the longer grace. A recording there that Zoom
      // has not confirmed stopped a minute after the stop was asked for ends the room at once.
      const stopOverdue = recordingThere && sent && now >= sent.at + TIMING.endSessionMs;
      const due = stopOverdue || (room.suspect ? now >= f.rotatedAt + TIMING.oldRoomSuspectEndMs : room.movedAll || now >= f.rotatedAt + TIMING.oldRoomEndMs);
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
  // G1: a start whose outcome is not known is settled by asking Zoom's state, never by sending it
  // again: as soon as its answer was lost or its executor's lease ran out, and again a while after
  // Zoom's state could not be told. Its key carries the claim's version, so each look is new.
  for (const op of f.unresolvedStarts) {
    const due = op.state === 'UNCERTAIN' || (op.state === 'IN_FLIGHT' && !(op.leaseUntil > now))
      || (op.state === 'UNKNOWN' && now >= op.updatedAt + OPERATION.unknownRetryMs);
    if (due) want(`resolve:${op.operation}:${op.version}`, 'RESOLVE_OPERATION', { operation: op.operation });
  }
  for (const anomaly of state.anomalies) if (anomaly.severity === 'error') want(`notify:${id}:${anomaly.code}`, 'NOTIFY_ADMIN', { code: anomaly.code });
  return actions;
}

// Recording in the current room after a move (see decideRoomRecording): first the check for this
// room, then the start, which goes to this room's session only. Every condition is checked here
// again whatever the overview or an authorization said:
//   this room's check passed, with consent as it was at that check (in case B, made after the
//   owner's word; the word itself is no consent);
//   no withdrawal, no emergency stop, not cancelled, not past its end, the lesson live;
//   the tutor and a student confirmed in this very session, and nobody there who should not be;
//   no older room that may still be recording; nothing recording here already.
// Each try has its own key under this generation: start:<lesson>:g<n>:<attempt>.
function planRoomStart({ lesson, f, state, want, now, endStopAt, cancelled }) {
  const id = lesson.id;
  const g = f.currentGeneration;
  // The room's own check decides (consent as it is now); the lesson's first decision does not.
  const blocked = f.withdrawal || f.emergency || cancelled || now >= endStopAt || state.phase.value === 'ENDED';
  if (blocked) return;
  if (f.recheckFrom != null && !f.roomDecision) want(`decide:${id}:g${g}:${f.recheckFrom}`, 'DECIDE_RECORDING', { generation: g });
  if (f.roomDecision?.eligible !== true || state.phase.value !== 'LIVE') return;
  const room = currentRoom(f);
  if (!room) return;
  const inside = participantId => room.present.get(participantId)?.in === true;
  const tutorIn = lesson.participants.some(entry => entry.role === 'tutor' && entry.active !== false && inside(entry.id));
  const studentIn = lesson.participants.some(entry => entry.role === 'student' && entry.active !== false && inside(entry.id));
  const stranger = [...room.present.values()].some(presence => presence.in && !presence.legit);
  const olderRecording = liveSessions(f).some(entry => entry !== room && captureOnIn(f, entry));
  if (!tutorIn || !studentIn || stranger || olderRecording || captureOnIn(f, room)) return;
  const prefix = `start:${id}:g${g}:`;
  const tries = f.startRequests.filter(request => request.key.startsWith(prefix));
  const startIn = { generation: g, targets: [room.id] };
  if (!tries.length) {
    want(`${prefix}1`, 'START_RECORDING', { attempt: 1, ...startIn });
    return;
  }
  const attempt = Math.max(...tries.map(request => request.attempt));
  const response = f.startResponses.find(entry => entry.key === `${prefix}${attempt}:response`);
  if (response && !response.ok && attempt < TIMING.maxStartAttempts && now >= response.at + TIMING.startRetryDelaysMs[attempt - 1]) {
    want(`${prefix}${attempt + 1}`, 'START_RECORDING', { attempt: attempt + 1, ...startIn });
  }
}

// The key under which a lesson's cancellation is stored, by P3's cancel and by the tick alike.
export const cancellationKey = lessonId => `server.lesson_cancelled:${lessonId}`;

function stopTrigger(state, f) {
  if (f.emergency) return { reason: 'emergency_stop', at: f.emergency.at };
  if (f.cancellation) return { reason: 'lesson_cancelled', at: f.cancellation.at };
  if (f.cancelledFlag) return { reason: 'lesson_cancelled', at: null };
  if (f.withdrawal) return { reason: 'consent_withdrawn', at: f.withdrawal.at };
  if (f.unknown.length) return { reason: 'unknown_participant', at: f.unknown[0].at };
  // After a move, a recording running now that no start of ours for its room covers is stopped,
  // even when the lesson may be recorded (2026-11-08): the move asked for a new check, or an
  // owner's word. Only that session, and each such recording in its own round.
  const rogue = rogueRoomCapture(f);
  if (rogue) return { reason: 'unapproved_start', at: rogue.at, sessionId: rogue.sessionId, episode: true };
  const unapproved = state.anomalies.find(entry => entry.code === 'UNAPPROVED_RECORDING_START');
  if (unapproved && f.eligibility?.eligible !== true) return { reason: 'unapproved_start', at: unapproved.since };
  return null;
}

// A recording running now, after a move, in a session whose latest start no start of ours for
// that room covers: one in an older room that started (or resumed) after the room moved on, or
// one in a newer room without our start for that generation. Null when there is none.
function rogueRoomCapture(f) {
  if (!f.currentGeneration) return null;
  const starts = roomStartTransitions(f);
  for (const entry of liveSessions(f)) {
    if (!captureOnIn(f, entry)) continue;
    const own = starts.filter(start => start.sessionId === entry.id
      || (start.sessionId == null && (entry.generation == null || generationAt(f, start.at) === entry.generation)));
    const lastStart = own[own.length - 1];
    // Known to be recording only from a start Zoom accepted: that start was ours.
    if (!lastStart) continue;
    const g = entry.generation ?? generationAt(f, lastStart.at);
    const movedOn = g < generationAt(f, lastStart.at);
    const covered = !movedOn && (g === 0 || f.startRequests.some(request => request.generation === g && request.at <= lastStart.at + TIMING.clockSkewMs));
    if (!covered) return { at: lastStart.at, sessionId: entry.id };
  }
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
  const tutor = hostOf(state.attendance);
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
