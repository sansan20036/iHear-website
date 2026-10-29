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
import { filingEvent, runsPast } from './recording-filing.mjs';

export { fileRecording, JOB_LEASE_MS, MAX_JOB_ATTEMPTS, processJobs, QUARANTINE_FOLDER } from './recording-filing.mjs';

export const MAX_REQUEST_AGE_MS = 5 * 60 * 1000;
export const STORE_BUDGET_MS = 2000;           // leaves room inside Zoom's 3-second limit
// Only the combined lesson video is filed: Zoom's combined view, and LCIC's mixed recording (one
// file per class). To check against real recordings of each.
export const KEPT_RECORDING_TYPES = ['shared_screen_with_speaker_view', 'lcic_mixed'];
const HELD_AT_ZOOM = ['AFTER_WITHDRAWAL', 'UNKNOWN_PARTICIPANT', 'NO_CONSENT', 'UNKNOWN_SESSION'];

const RECORDING_EVENTS = {
  'session.recording_started': 'Recording',
  'session.recording_resumed': 'Recording',
  'session.recording_paused': 'Paused',
  'session.recording_stopped': 'Stopped',
};
const toMs = value => (value == null || value === '' ? null : typeof value === 'number' ? value : Date.parse(value));
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
// download token are dropped here, before anything is stored.
export function minimizeZoomEvent(event, receivedAt) {
  const object = event?.payload?.object ?? {};
  const user = object.user ?? {};
  const base = {
    source: 'zoom_webhook',
    type: event?.event,
    lessonId: object.session_key || null,
    providerSessionId: object.session_id || object.id || null,
    receivedAt,
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
        kind: file.recording_type || null,
        extension: String(file.file_extension || file.file_type || '').toLowerCase(),
        size: Number(file.file_size) || 0,
        status: file.status || null,
        recordingStart: toMs(file.recording_start),
        recordingEnd: toMs(file.recording_end),
      }));
      const ends = files.map(file => file.recordingEnd).filter(value => value != null);
      fact = { ...base, files, occurredAt: ends.length ? Math.max(...ends) : event.event_ts };
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
  return KEPT_RECORDING_TYPES.includes(file.kind) && Core.extensionOf(`recording.${file.extension}`, null) !== null;
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

async function persist(store, events, budgetMs) {
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
  if (event.event === 'endpoint.url_validation') {
    const plainToken = String(event.payload?.plainToken || '');
    return { status: 200, body: { plainToken, encryptedToken: createHmac('sha256', secret).update(plainToken).digest('hex') } };
  }
  const fact = minimizeZoomEvent(event, now);
  if (!fact) return { status: 200, body: { ignored: event.event } };
  return persist(store, [fact], budgetMs);
}

// The tutor's browser relays Video SDK events (heartbeat, recording status, people joining or
// leaving, connection changes). The route has already checked the tutor's sign-in and lesson.
// Reports are self-reported, so they are kept with source host_sdk and the server's own clock
// wins when the browser's clock is far off.
export async function ingestHostReport({ report, lessonId, tutorId, now, store, budgetMs = STORE_BUDGET_MS }) {
  const types = ['heartbeat', 'recording_status', 'user_added', 'user_removed', 'connection', 'participant_failover'];
  if (!types.includes(report?.type)) return { status: 400, body: { error: 'unknown report' } };
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
  // Heartbeats are not history: only the latest one per lesson is kept.
  fact.key = report.type === 'heartbeat'
    ? `host:host.heartbeat:${lessonId}`
    : `host:${fact.type}:${lessonId}:${occurredAt}:${fact.participantId || ''}:${fact.status || fact.state || ''}`;
  return persist(store, [fact], budgetMs);
}

// A REST reconciliation snapshot becomes the same kind of facts a webhook would have given,
// with the same keys, plus one api.snapshot fact saying who was present when we looked.
export function normalizeApiSnapshot({ lessonId, providerSessionId, details, users = [], recordings = [], observedAt }) {
  const base = { source: 'zoom_api', lessonId, providerSessionId, receivedAt: observedAt };
  const facts = [];
  const add = fact => facts.push({ ...fact, key: dedupeKeyOf(fact) });
  if (details?.start_time) add({ ...base, type: 'session.started', occurredAt: toMs(details.start_time) });
  if (details?.end_time) add({ ...base, type: 'session.ended', occurredAt: toMs(details.end_time) });
  for (const user of users) {
    const who = { participantId: user.user_key || null, participantUuid: user.participant_uuid || null };
    if (user.join_time) add({ ...base, ...who, type: 'session.user_joined', occurredAt: toMs(user.join_time) });
    if (user.leave_time) add({ ...base, ...who, type: 'session.user_left', occurredAt: toMs(user.leave_time), leaveReason: leaveReasonCode(user.leave_reason) });
  }
  const files = recordings.filter(file => String(file.status || '').toLowerCase() === 'completed');
  if (files.length && files.length === recordings.length) {
    add(minimizeZoomEvent({ event: 'session.recording_completed', event_ts: observedAt, payload: { object: { session_id: providerSessionId, session_key: lessonId, recording_files: files } } }, observedAt));
  }
  facts.forEach(fact => { fact.source = 'zoom_api'; });
  add({
    ...base,
    type: 'api.snapshot',
    occurredAt: observedAt,
    live: !details?.end_time,
    present: users.filter(user => user.join_time && !user.leave_time).map(user => user.user_key).filter(Boolean).sort(),
  });
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

async function recordFiles(tx, event) {
  const lesson = event.lessonId ? await tx.lesson(event.lessonId) : null;
  const eligible = lesson ? (await tx.eligibility(lesson.id))?.eligible === true : false;
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
      lessonId: lesson ? lesson.id : null,
      providerSessionId: event.providerSessionId,
      status: 'PENDING',
      hold: null,
      plannedName: null,
      uploadSessionUri: null,
      driveFileId: null,
    };
    if (!isKeptRecording(file)) record.status = 'SKIPPED';
    else if (!lesson) record.hold = 'UNKNOWN_SESSION';
    else if (!eligible) record.hold = 'NO_CONSENT';
    else if (withdrawnAt != null) record.hold = runsPast(file, withdrawnAt) ? 'AFTER_WITHDRAWAL' : 'CONSENT_WITHDRAWN';
    else if (runsPast(file, unknownAt)) record.hold = 'UNKNOWN_PARTICIPANT';
    if (record.status === 'SKIPPED') {
      await tx.insertFileRecord(record);
      continue;
    }
    record.plannedName = lesson ? await planName(tx, lesson, record) : null;
    await tx.insertFileRecord(record);
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
async function planName(tx, lesson, record) {
  const students = lesson.participants.filter(entry => entry.role === 'student').map(entry => Core.cleanName(entry.code, 20)).join('+');
  const tutor = lesson.participants.find(entry => entry.role === 'tutor');
  const base = Core.baseName(lesson.date, students, tutor.code);
  const planned = (await tx.fileRecordsForLesson(lesson.id)).map(entry => entry.plannedName).filter(Boolean);
  return Core.fileName(base, Core.nextPart(planned, () => false, base, record.extension), record.extension);
}

