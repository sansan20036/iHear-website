// Event intake for the classroom (synthetic prototype).
//
// Inside a webhook request we only verify it and persist a minimized event, together with any
// follow-up jobs, in one transaction. The answer is 200 only after that commit; a storage
// failure or timeout answers 503 so Zoom retries (Zoom retries 5xx and timeouts three times,
// 5, 20 and 60 minutes apart, and never retries 4xx). Nothing is queued in memory: workers
// claim the stored jobs later under a lease, so a crash at any point loses nothing. Filing the
// recordings those jobs point to is in recording-filing.mjs.
//
// Payload field names follow Zoom's Video SDK webhook reference; check them field by field
// against real deliveries before relying on them.
//
// The store may be synchronous (the in-memory test fake) or asynchronous (PostgreSQL in the
// website); every call is awaited.
import { createHmac, timingSafeEqual } from 'node:crypto';
// A static import, so bundlers include P1's rules; Core.js stays a plain Apps Script file.
import Core from '../apps-script/Core.js';
import { blockBaseName, recordingSnapshot } from './block-naming.mjs';
import { defaultConsentPolicy, generationOfRoom } from './eligibility.mjs';
import { filingEvent, runsPast } from './recording-filing.mjs';
import { isFiledKind, LESSON_ID, neutralKind, validateRecordingFact } from './recording-adapter.mjs';

export { fileRecording, JOB_LEASE_MS, MAX_JOB_ATTEMPTS, processJobs, QUARANTINE_FOLDER } from './recording-filing.mjs';

export const MAX_REQUEST_AGE_MS = 5 * 60 * 1000;
export const STORE_BUDGET_MS = 2000;           // leaves room inside Zoom's 3-second limit
// Which recordings are filed is decided on the neutral kinds of recording-adapter.mjs: only the
// combined lesson video ('composite': Zoom's combined view, LCIC's mixed recording). Each
// vendor's own type names are mapped there. To check against real recordings of each.
const ZOOM = 'zoom-video-sdk';
const HELD_AT_ZOOM = ['AFTER_WITHDRAWAL', 'UNKNOWN_PARTICIPANT', 'NO_CONSENT', 'BEFORE_CONSENT', 'UNKNOWN_SESSION', 'PARTICIPANT_CONSENT_MISSING'];

const RECORDING_EVENTS = {
  'session.recording_started': 'Recording',
  'session.recording_resumed': 'Recording',
  'session.recording_paused': 'Paused',
  'session.recording_stopped': 'Stopped',
};
const toMs = value => (value == null || value === '' ? null : typeof value === 'number' ? value : Date.parse(value));
// A room name iHear gives its sessions (eligibility.mjs roomNameOf), lower-cased; null otherwise.
const ROOM_NAME = /^ihear-[a-z0-9-]{1,120}$/i;
export const roomName = value => (typeof value === 'string' && ROOM_NAME.test(value) ? value.toLowerCase() : null);
const headerOf = (headers, name) => headers[name] ?? headers[name.toLowerCase()];

export function signZoomRequest(secret, timestamp, rawBody) {
  return 'v0=' + createHmac('sha256', secret).update(`v0:${timestamp}:${rawBody}`).digest('hex');
}

export function verifyZoomRequest({ headers, rawBody, secret, now }) {
  const timestamp = Number(headerOf(headers, 'x-zm-request-timestamp'));
  if (!Number.isFinite(timestamp) || Math.abs(now - timestamp * 1000) > MAX_REQUEST_AGE_MS) return 'STALE_OR_MISSING_TIMESTAMP';
  const expected = Buffer.from(signZoomRequest(secret, timestamp, rawBody));
  const actual = Buffer.from(String(headerOf(headers, 'x-zm-signature') || ''));
  return expected.length === actual.length && timingSafeEqual(expected, actual) ? null : 'SIGNATURE_MISMATCH';
}

// Zoom's leave reasons are sentences; we keep a short code. The exact sentences are still to be
// checked against real deliveries.
export function leaveReasonCode(reason) {
  const text = String(reason || '');
  if (!text) return null;
  if (/network|disconnect|connection|timeout/i.test(text)) return 'DISCONNECTED';
  if (/remov/i.test(text)) return 'REMOVED';
  if (/end/i.test(text) && /host/i.test(text)) return 'HOST_ENDED';
  if (/left|leave/i.test(text)) return 'LEFT';
  return 'OTHER';
}

// Keeps only identifiers, times and codes. Names, IP addresses, devices, download URLs and the
// download token are dropped here, before anything is stored. Recording files leave as the
// Recording Adapter's neutral facts: the vendor named, each file's type as a neutral kind.
export function minimizeZoomEvent(event, receivedAt, { provider = ZOOM } = {}) {
  const object = event?.payload?.object ?? {};
  const user = object.user ?? {};
  const base = {
    source: 'zoom_webhook',
    type: event?.event,
    lessonId: object.session_key || null,
    providerSessionId: object.session_id || object.id || null,
    receivedAt,
    // The session's name tells which generation of the lesson's room this session is (G-5,
    // 2026-11-08). Only a name of the shape iHear gives its rooms (its tpc) is kept: any other
    // text a vendor sends there could be someone's, and is dropped like the rest.
    ...(roomName(object.session_name) ? { sessionName: roomName(object.session_name) } : {}),
  };
  let fact;
  switch (base.type) {
    case 'session.started':
      fact = { ...base, occurredAt: toMs(object.start_time) ?? event.event_ts };
      break;
    case 'session.ended':
      fact = { ...base, occurredAt: toMs(object.end_time) ?? event.event_ts };
      break;
    case 'session.user_joined':
    case 'session.user_left':
      fact = {
        ...base,
        participantId: user.user_key || null,
        participantUuid: user.participant_uuid || null,
        occurredAt: toMs(base.type === 'session.user_joined' ? user.join_time : user.leave_time) ?? event.event_ts,
      };
      if (base.type === 'session.user_left') fact.leaveReason = leaveReasonCode(user.leave_reason);
      break;
    case 'session.recording_completed': {
      const files = (object.recording_files || []).map(file => ({
        providerFileId: String(file.id),
        kind: neutralKind(provider, file.recording_type),
        extension: String(file.file_extension || file.file_type || '').toLowerCase(),
        size: Number(file.file_size) || 0,
        status: file.status || null,
        recordingStart: toMs(file.recording_start),
        recordingEnd: toMs(file.recording_end),
      }));
      const ends = files.map(file => file.recordingEnd).filter(value => value != null);
      fact = { ...base, provider, files, occurredAt: ends.length ? Math.max(...ends) : event.event_ts };
      break;
    }
    case 'session.alert':
      fact = { ...base, issues: (object.issues || []).map(String).sort(), occurredAt: event.event_ts };
      break;
    default:
      if (!RECORDING_EVENTS[base.type]) return null;
      fact = {
        ...base,
        status: RECORDING_EVENTS[base.type],
        occurredAt: toMs(RECORDING_EVENTS[base.type] === 'Recording' ? object.recording_file?.recording_start : object.recording_file?.recording_end) ?? event.event_ts,
      };
  }
  return { ...fact, key: dedupeKeyOf(fact) };
}

// Built from what the event means, not from its raw bytes: Zoom does not promise that a retried
// delivery is byte-for-byte identical. A REST reconciliation that reports the same fact gets
// the same key, so it is stored once.
export function dedupeKeyOf(event) {
  const session = event.providerSessionId || event.lessonId;
  switch (event.type) {
    case 'session.started':
    case 'session.ended':
      return `${event.type}:${session}`;
    case 'session.user_joined':
    case 'session.user_left':
      return `${event.type}:${session}:${event.participantUuid || event.participantId}:${event.occurredAt}`;
    case 'session.recording_completed':
      return `${event.type}:${session}:${event.files.map(file => file.providerFileId).sort().join(',')}`;
    case 'session.alert':
      return `${event.type}:${session}:${event.occurredAt}:${event.issues.join(',')}`;
    default:
      return `${event.type}:${session}:${event.occurredAt}`;
  }
}

export function isKeptRecording(file) {
  return isFiledKind(file.kind) && Core.extensionOf(`recording.${file.extension}`, null) !== null;
}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('store timeout')), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Stores facts another vendor's intake already verified and minimized (lcic-callback.mjs), with
// the same transaction, dedupe and follow-up jobs as Zoom's.
export function ingestFacts({ store, facts, budgetMs = STORE_BUDGET_MS }) {
  return persist(store, facts, budgetMs);
}

// What is kept of a refused recording fact: where it came from and why, never its files. Its key
// is the fact's, so the same notice delivered again is recorded once.
function refusalOf({ event, problems }) {
  const at = Number.isFinite(event?.receivedAt) ? event.receivedAt : Date.now();
  const session = typeof event?.providerSessionId === 'string' ? event.providerSessionId.slice(0, 200) : null;
  const lessonId = typeof event?.lessonId === 'string' && LESSON_ID.test(event.lessonId) ? event.lessonId : null;
  return {
    source: 'server',
    type: 'server.recording_refused',
    lessonId,
    providerSessionId: session,
    provider: typeof event?.provider === 'string' ? event.provider.slice(0, 40) : null,
    problems: problems.slice(0, 20).map(problem => problem.slice(0, 200)),
    occurredAt: at,
    receivedAt: at,
    key: `server.recording_refused:${String(event?.key ?? session ?? lessonId ?? at).slice(0, 500)}`,
  };
}

async function persist(store, events, budgetMs) {
  // Recording facts from any vendor's adapter must keep the Recording Adapter contract. A batch
  // holding one that does not is refused whole, before any of it is stored (422: retrying would
  // not change it). The refusal itself is recorded, so the overview raises it at once instead of
  // hours later as a missing file.
  const refused = events.filter(event => event?.type === 'session.recording_completed')
    .map(event => ({ event, problems: validateRecordingFact(event) }))
    .filter(entry => entry.problems.length);
  if (refused.length) {
    await withTimeout(store.transaction(async tx => {
      for (const entry of refused) await tx.insertEvent(refusalOf(entry));
    }), budgetMs).catch(() => undefined);
    return { status: 422, body: { error: 'recording facts break the Recording Adapter contract', problems: refused.flatMap(entry => entry.problems) } };
  }
  try {
    const stored = await withTimeout(store.transaction(async tx => {
      const results = [];
      for (const event of events) results.push(await storeEvent(tx, event));
      return results;
    }), budgetMs);
    return { status: 200, body: { stored: stored.filter(Boolean).length, duplicates: stored.filter(value => !value).length } };
  } catch {
    return { status: 503, body: { error: 'not stored, please retry' } };
  }
}

export async function ingestWebhook({ headers, rawBody, secret, now, store, budgetMs = STORE_BUDGET_MS }) {
  const problem = verifyZoomRequest({ headers, rawBody, secret, now });
  if (problem) return { status: 401, body: { error: problem } };
  let event;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return { status: 400, body: { error: 'invalid JSON' } };
  }
  if (event.event === 'endpoint.url_validation') return { status: 200, body: urlValidationAnswer(secret, event) };
  const fact = minimizeZoomEvent(event, now);
  if (!fact) return { status: 200, body: { ignored: event.event } };
  return persist(store, [fact], budgetMs);
}

// Zoom's endpoint check: the plainToken it sent, and its HMAC SHA-256 (hex) with the Secret Token.
function urlValidationAnswer(secret, event) {
  const plainToken = String(event.payload?.plainToken || '');
  return { plainToken, encryptedToken: createHmac('sha256', secret).update(plainToken).digest('hex') };
}

// While the classroom is closed (2026-11-10): Zoom saves an event subscription only after the
// endpoint answers its URL validation, and revalidates it every 72 hours (6 failures disable it),
// so a signed validation is answered with the Secret Token alone. Every other signed delivery is
// acknowledged and stored nowhere: no lesson runs, and sessions of the same Zoom account outside
// the site (local tests) must not reach the live database. A bad signature still answers 401.
export function answerWhileClosed({ headers, rawBody, secret, now }) {
  const problem = verifyZoomRequest({ headers, rawBody, secret, now });
  if (problem) return { status: 401, body: { error: problem } };
  let event;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return { status: 400, body: { error: 'invalid JSON' } };
  }
  if (event?.event === 'endpoint.url_validation') return { status: 200, body: urlValidationAnswer(secret, event) };
  return { status: 200, body: { ignored: String(event?.event ?? ''), closed: true } };
}

// A session id as a vendor gives it: Zoom's are base64 (letters, digits, + / =).
export const SESSION_ID = /^[A-Za-z0-9+/=_-]{1,100}$/;

// The tutor's browser relays Video SDK events (heartbeat, recording status, people joining or
// leaving, connection changes, and the id of the session it joined). The route has already
// checked the tutor's sign-in and lesson. Reports are self-reported, so they are kept with
// source host_sdk and the server's own clock wins when the browser's clock is far off. A session
// id is kept only as reported: nothing acts on it until the server has confirmed it with the
// vendor (lib/classroom-service.ts), so a page cannot point the server at another session.
// perTutor (P3-Multi): a block's room may have several tutors, so each one's latest heartbeat is kept.
export async function ingestHostReport({ report, lessonId, tutorId, now, store, budgetMs = STORE_BUDGET_MS, perTutor = false }) {
  const types = ['heartbeat', 'recording_status', 'user_added', 'user_removed', 'connection', 'participant_failover', 'session'];
  if (!types.includes(report?.type)) return { status: 400, body: { error: 'unknown report' } };
  if (report.type === 'session' && !SESSION_ID.test(String(report.sessionId ?? ''))) return { status: 400, body: { error: 'invalid session id' } };
  const reported = toMs(report.at);
  const occurredAt = reported != null && reported <= now && now - reported <= MAX_REQUEST_AGE_MS ? reported : now;
  const subject = ['user_added', 'user_removed', 'participant_failover'].includes(report.type) ? String(report.userKey || '') : tutorId;
  const fact = {
    source: 'host_sdk',
    type: `host.${report.type}`,
    lessonId,
    participantId: subject || null,
    occurredAt,
    receivedAt: now,
  };
  if (report.type === 'recording_status') fact.status = ['Recording', 'Paused', 'Stopped'].includes(report.status) ? report.status : 'Unknown';
  if (report.type === 'connection') fact.state = String(report.state || '');
  if (report.type === 'session') fact.reportedSessionId = String(report.sessionId);
  // Heartbeats are not history: only the latest one per lesson is kept. A session id is kept
  // once, however often the page reports it.
  fact.key = report.type === 'heartbeat'
    ? `host:host.heartbeat:${lessonId}${perTutor ? `:${tutorId}` : ''}`
    : report.type === 'session'
      ? `host:host.session:${lessonId}:${fact.reportedSessionId}`
      : `host:${fact.type}:${lessonId}:${occurredAt}:${fact.participantId || ''}:${fact.status || fact.state || ''}`;
  return persist(store, [fact], budgetMs);
}

// How long a finished lesson video waits for its session's other files (an audio track, a
// timeline) before it is reported without them, when the vendor is asked rather than notifying.
export const SIDE_FILE_GRACE_MS = 30 * 60_000;

// Which of one session's listed files can be reported as finished. All of them done is the clean
// case. Otherwise every lesson video of the session must be done and the last of them must have
// ended SIDE_FILE_GRACE_MS ago; then the files that are done are reported, so a side file that
// never finishes cannot hold the lesson back. A file that is not done is never reported.
function finishedFiles(recordings, observedAt, provider) {
  const done = recordings.filter(file => String(file.status || '').toLowerCase() === 'completed');
  if (!done.length || done.length === recordings.length) return done;
  const videos = recordings.filter(file => isFiledKind(neutralKind(provider, file.recording_type)));
  if (!videos.length || videos.some(file => !done.includes(file))) return [];
  const ends = videos.map(file => toMs(file.recording_end)).filter(Number.isFinite);
  return ends.length === videos.length && observedAt - Math.max(...ends) >= SIDE_FILE_GRACE_MS ? done : [];
}

// A REST reconciliation snapshot becomes the same kind of facts a webhook would have given,
// with the same keys, plus one api.snapshot fact saying who was present when we looked. The
// answer is in Zoom's REST shape (the synthetic stand-in imitates it); `provider` names the
// vendor, so its recording types map to the right neutral kinds. LCIC's DescribeRoom answer has
// no file size or status yet, so its recordings are not found this way (see the integration plan).
//
// `details` is null when the vendor would not describe the session (a past session it no longer
// shows, say): then nothing is said about the session or who was there, only its recordings.
// `sessions` lists the lesson's earlier sessions whose recordings were asked for too: a lesson
// can run in several sessions (everyone left and came back, or the session was ended after a
// withdrawal), and each session's recordings are its own facts.
export function normalizeApiSnapshot({ lessonId, providerSessionId, details, users = [], recordings = [], sessions = [], observedAt, provider = ZOOM }) {
  const name = roomName(details?.session_name) ? { sessionName: roomName(details.session_name) } : {};
  const base = { source: 'zoom_api', lessonId, providerSessionId, receivedAt: observedAt, ...name };
  const facts = [];
  const add = fact => facts.push({ ...fact, key: dedupeKeyOf(fact) });
  if (details?.start_time) add({ ...base, type: 'session.started', occurredAt: toMs(details.start_time) });
  if (details?.end_time) add({ ...base, type: 'session.ended', occurredAt: toMs(details.end_time) });
  for (const user of details ? users : []) {
    const who = { participantId: user.user_key || null, participantUuid: user.participant_uuid || null };
    if (user.join_time) add({ ...base, ...who, type: 'session.user_joined', occurredAt: toMs(user.join_time) });
    if (user.leave_time) add({ ...base, ...who, type: 'session.user_left', occurredAt: toMs(user.leave_time), leaveReason: leaveReasonCode(user.leave_reason) });
  }
  // Earlier sessions first (they are listed oldest first): P1 numbers a lesson's parts in the
  // order their facts arrive, so this keeps the parts in recording order.
  for (const session of [...sessions, { providerSessionId, recordings }]) {
    const files = finishedFiles(session.recordings ?? [], observedAt, provider);
    if (!files.length || !session.providerSessionId) continue;
    add(minimizeZoomEvent({ event: 'session.recording_completed', event_ts: observedAt, payload: { object: { session_id: session.providerSessionId, session_key: lessonId, recording_files: files } } }, observedAt, { provider }));
  }
  facts.forEach(fact => { fact.source = 'zoom_api'; });
  if (details) {
    add({
      ...base,
      type: 'api.snapshot',
      occurredAt: observedAt,
      live: !details.end_time,
      present: users.filter(user => user.join_time && !user.leave_time).map(user => user.user_key).filter(Boolean).sort(),
    });
  }
  return facts;
}

export async function ingestApiSnapshot({ snapshot, now, store, budgetMs = STORE_BUDGET_MS }) {
  return persist(store, normalizeApiSnapshot({ ...snapshot, observedAt: now }), budgetMs);
}

// Inside a transaction: the event, and for a finished recording one file record and one filing
// job per file. Records and jobs have fixed ids, so a retried webhook, a reconciliation and a
// late duplicate all land on the same rows.
export async function storeEvent(tx, event) {
  if (event.type === 'host.heartbeat') return tx.keepLatest(event);
  const inserted = await tx.insertEvent(event);
  if (inserted && event.type === 'session.recording_completed') await recordFiles(tx, event);
  return inserted;
}

// A recording is covered by the decision for its own room (the lesson's own for the first room,
// that room's check for a newer one, the latest of any room when Zoom did not name the room)
// made by the time the recording started (2026-11-08). Consent never reaches back: a decision made
// only after the recording began does not cover it (BEFORE_CONSENT, held at Zoom like any recording
// without consent). The tolerance allows only for the two clocks (Zoom's and ours) disagreeing.
export const CONSENT_CLOCK_TOLERANCE_MS = 10_000;
async function consentFor(tx, lessonId, generation, recordingStart) {
  const room = generation ?? undefined;
  const before = Number.isFinite(recordingStart) ? recordingStart + CONSENT_CLOCK_TOLERANCE_MS : undefined;
  if ((await tx.eligibility(lessonId, room, before))?.eligible === true) return null;
  if (before !== undefined && (await tx.eligibility(lessonId, room))?.eligible === true) return 'BEFORE_CONSENT';
  return 'NO_CONSENT';
}

async function recordFiles(tx, event) {
  const lesson = event.lessonId ? await tx.lesson(event.lessonId) : null;
  const generation = lesson ? generationOfRoom(lesson.id, event.sessionName) : null;
  const withdrawnAt = lesson ? await tx.withdrawalAt(lesson.id) : null;
  const unknownAt = lesson ? await tx.unknownJoinAt(lesson.id) : null;
  // Parts are numbered in recording order within one notice. A notice that arrives after a later
  // recording already has its numbers (Zoom retried it, say) keeps unique numbers, but the
  // overview flags the lesson so someone can check the order.
  const earlier = lesson ? (await tx.fileRecordsForLesson(lesson.id)).filter(entry => entry.plannedName && entry.recordingStart != null) : [];
  const files = [...event.files].sort((a, b) => (a.recordingStart ?? 0) - (b.recordingStart ?? 0) || a.providerFileId.localeCompare(b.providerFileId));
  for (const file of files) {
    if (await tx.fileRecord(file.providerFileId)) continue;
    const record = {
      ...file,
      provider: event.provider ?? null,
      lessonId: lesson ? lesson.id : null,
      providerSessionId: event.providerSessionId,
      status: 'PENDING',
      hold: null,
      plannedName: null,
      uploadSessionUri: null,
      driveFileId: null,
    };
    const consent = lesson && isKeptRecording(file) ? await consentFor(tx, lesson.id, generation, file.recordingStart) : null;
    if (!isKeptRecording(file)) record.status = 'SKIPPED';
    else if (!lesson) record.hold = 'UNKNOWN_SESSION';
    else if (consent) record.hold = consent;
    else if (withdrawnAt != null) record.hold = runsPast(file, withdrawnAt) ? 'AFTER_WITHDRAWAL' : 'CONSENT_WITHDRAWN';
    else if (runsPast(file, unknownAt)) record.hold = 'UNKNOWN_PARTICIPANT';
    if (record.status === 'SKIPPED') {
      await tx.insertFileRecord(record);
      continue;
    }
    const planned = lesson ? await planName(tx, lesson, record, generation) : null;
    record.plannedName = planned?.name ?? null;
    // P3-Multi (18.4): a block room's recording that covers anyone whose own consent (a student) or
    // notice (staff) was not valid for their part is held at Zoom, never uploaded.
    if (!record.hold && planned?.snapshot?.people.some(entry => entry.covered && entry.problem)) record.hold = 'PARTICIPANT_CONSENT_MISSING';
    await tx.insertFileRecord(record);
    // P3-Multi (18.4): each recording of a block's room keeps who it covers, with the decision
    // that covers it and the hold it got, under its own key (one per recording).
    if (planned?.snapshot) {
      await tx.insertEvent({ source: 'p1', type: 'p1.recording_snapshot', lessonId: lesson.id, providerFileId: record.providerFileId, occurredAt: event.receivedAt, receivedAt: event.receivedAt, key: `p1.recording_snapshot:${record.providerFileId}`, snapshot: { ...planned.snapshot, hold: record.hold ?? null } });
    }
    if (record.recordingStart != null && earlier.some(entry => entry.recordingStart > record.recordingStart)) {
      await tx.insertEvent({ source: 'p1', type: 'p1.part_order', lessonId: lesson.id, providerFileId: record.providerFileId, occurredAt: event.receivedAt, receivedAt: event.receivedAt, key: `p1.part_order:${record.providerFileId}` });
    }
    // Nothing recorded after a withdrawal or with someone unknown in the room, nothing without
    // consent and nothing from an unknown session is ever uploaded: it stays on hold at Zoom
    // until an administrator decides.
    if (HELD_AT_ZOOM.includes(record.hold)) {
      await tx.updateFileRecord(record.providerFileId, { status: 'HOLD' });
      await tx.insertEvent(filingEvent(record, 'HOLD', event.receivedAt));
      continue;
    }
    await tx.insertJob({ id: `file:${record.providerFileId}`, type: 'file_recording', lessonId: record.lessonId, providerFileId: record.providerFileId });
  }
}

// P1 naming rules, reused unchanged from Core.js: date, student codes, tutor code, part number.
// A block's room (P3-Multi) is named by the people the recording covers: see block-naming.mjs.
async function planName(tx, lesson, record, generation = null) {
  if (lesson.blockId) return planBlockName(tx, lesson, record, generation);
  const students = lesson.participants.filter(entry => entry.role === 'student').map(entry => Core.cleanName(entry.code, 20)).join('+');
  const tutor = lesson.participants.find(entry => entry.role === 'tutor');
  const base = Core.baseName(lesson.date, students, tutor.code);
  const planned = (await tx.fileRecordsForLesson(lesson.id)).map(entry => entry.plannedName).filter(Boolean);
  return { name: Core.fileName(base, Core.nextPart(planned, () => false, base, record.extension), record.extension) };
}

async function planBlockName(tx, lesson, record, generation) {
  const block = await tx.block(lesson.blockId);
  const events = await tx.eventsOf(lesson.id);
  const before = Number.isFinite(record.recordingStart) ? record.recordingStart + CONSENT_CLOCK_TOLERANCE_MS : undefined;
  const decision = await tx.eligibility(lesson.id, generation ?? undefined, before);
  const members = block?.members ?? [];
  const consents = await tx.consents(members.filter(member => member.role === 'student').map(member => member.code));
  const notices = await tx.notices(members.filter(member => member.role !== 'student').map(member => member.code));
  const lobbyEvents = block?.lobbyId ? await tx.eventsOf(block.lobbyId) : [];
  const snapshot = recordingSnapshot({ lesson, block, events, record, generation, decision, withdrawnAt: await tx.withdrawalAt(lesson.id), consents, notices, lobbyEvents, policy: defaultConsentPolicy() });
  const base = blockBaseName({ students: snapshot.names.students, tutors: snapshot.names.tutors, date: snapshot.date });
  // The first recording with these names gets the plain name; each later one the next part.
  const taken = (await tx.fileRecordsForLesson(lesson.id)).map(entry => entry.plannedName).filter(name => name === `${base}.${record.extension}` || String(name || '').startsWith(`${base}_P`));
  const name = taken.length ? Core.fileName(base, taken.length + 1, record.extension) : `${base}.${record.extension}`;
  return { name, snapshot };
}

