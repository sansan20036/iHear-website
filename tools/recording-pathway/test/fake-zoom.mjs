// Closed-loop synthetic run of several concurrent classrooms against a simulated Zoom.
//
// For every room the simulated Zoom keeps what is "really" happening (who is in the room,
// whether recording is on, which files exist) and turns it into the webhooks, host-SDK reports
// and REST snapshots Zoom would send, with the delays, losses and duplicates a scenario asks
// for. Our side runs as designed: signed webhook intake with persistence, the planner and its
// actions, reconciliation within an API budget, filing to a fake Drive, and the dashboard.
//
// This checks our logic end to end with synthetic data. It says nothing about Zoom's real
// behaviour, delays, how many recordings it can run at once, or cost: those need the real
// account tests, which are not authorised yet.
import { getRecordingEligibility, roomNameOf } from '../classroom/eligibility.mjs';
import { ingestApiSnapshot, ingestHostReport, ingestWebhook, processJobs, fileRecording, signZoomRequest, storeEvent } from '../classroom/webhook-ingest.mjs';
import { dueReconciliations, planActions } from '../classroom/lesson-state.mjs';
import { buildDashboard } from '../classroom/live-dashboard.mjs';
import { createClassroomStore, createDrive, syntheticDownload } from './fake-classroom-store.mjs';

export const SECRET = 'synthetic-webhook-secret-not-real';
export const POLICY = { consentVersion: '2026-11', staffNoticeVersion: '2026-11' };
export const LESSON_START = Date.parse('2026-11-03T02:00:00Z');   // 10:00 in Taipei
export const MIN = 60_000;
export const ROOT_FOLDER = 'root:[測試] iHear 錄影存放區';
// Planted in the simulated Zoom payloads. None of them may ever be stored or shown.
export const PLANTED = ['Synthetic Display Name', '203.0.113.', 'Synthetic Device', 'synthetic-download-token-not-real', 'example.invalid'];

const DEFAULTS = {
  consent: true,
  tutorJoinAt: -3 * MIN,
  studentJoinAt: 1 * MIN,
  studentLeaveAt: 60 * MIN,
  tutorLeaveAt: 60.5 * MIN,
  startBehaviour: 'ok',
  webhookDelayMs: 2_000,
  delays: {},
  lose: [],
  duplicate: false,
  processingDelayMs: 10 * MIN,
  ignoreStops: 0,
  rejoinAfterEndMs: null,
};

export const SCENARIOS = {
  normal: {},
  no_consent: { consent: false },
  start_api_error: { startBehaviour: 'api_error' },
  late_webhooks: { webhookDelayMs: 4 * MIN, lose: ['session.ended'], processingDelayMs: 40 * MIN },
  tutor_shutdown: { tutorShutdownAt: 30 * MIN },
  consent_withdrawn: { withdrawalAt: 20 * MIN, ignoreStops: 2, rejoinAfterEndMs: 30_000 },
  unknown_participant: { unknownJoinAt: 10 * MIN, joinBlockedAt: 2 * MIN },
  everyone_drops: { everyoneDropsAt: 40 * MIN },
  // Every webhook three times with different bytes, and the joins arriving after the leaves.
  duplicates_out_of_order: { duplicate: true, delays: { 'session.user_joined': 70 * MIN } },
  zoom_auto_recording: { consent: false, autoRecording: true },
};

// How each scenario must end on the dashboard, whether it runs alone or with others.
export const EXPECTED_FINAL = {
  normal: { group: 'ENDED', recording: 'COMPLETED', filing: 'STORED', anomalies: [] },
  no_consent: { group: 'ENDED', recording: 'BLOCKED', filing: 'NONE', anomalies: [] },
  start_api_error: { group: 'ANOMALY', recording: 'FAILED', filing: 'NONE', anomalies: ['RECORDING_FAILED'] },
  late_webhooks: { group: 'ENDED', recording: 'COMPLETED', filing: 'STORED', anomalies: [] },
  tutor_shutdown: { group: 'ENDED', recording: 'COMPLETED', filing: 'STORED', anomalies: [] },
  consent_withdrawn: { group: 'ENDED', recording: 'COMPLETED', filing: 'HELD', anomalies: ['CONSENT_WITHDRAWN'] },
  unknown_participant: { group: 'ANOMALY', recording: 'COMPLETED', filing: 'HELD', anomalies: ['UNKNOWN_PARTICIPANT', 'JOIN_BLOCKED'] },
  everyone_drops: { group: 'ENDED', recording: 'COMPLETED', filing: 'STORED', anomalies: [] },
  duplicates_out_of_order: { group: 'ENDED', recording: 'COMPLETED', filing: 'STORED', anomalies: [] },
  zoom_auto_recording: { group: 'ANOMALY', recording: 'COMPLETED', filing: 'HELD', anomalies: ['UNAPPROVED_RECORDING_START'] },
};

export function cardsByCode(dashboard) {
  const found = new Map();
  for (const [group, cards] of Object.entries(dashboard.groups)) for (const card of cards) found.set(card.lessonCode, { group, card });
  return found;
}

const iso = value => new Date(value).toISOString();
const LEAVE_TEXT = { DISCONNECTED: 'disconnected because of a network error', LEFT: 'left the session', HOST_ENDED: 'the host ended the session', REMOVED: 'removed by the host' };

export function makeLesson(index) {
  const n = String(index + 1).padStart(3, '0');
  return {
    id: `L-TEST-${n}`,
    code: `TEST-L${n}`,
    date: '2026-11-03',
    startsAt: iso(LESSON_START),
    endsAt: iso(LESSON_START + 60 * MIN),
    participants: [
      { id: `P-TEST-T${n}`, code: `TEST-T${n}`, role: 'tutor' },
      { id: `P-TEST-S${n}`, code: `TEST-S${n}`, role: 'student' },
    ],
  };
}

// Reverses key order and changes spacing: the same delivery, different bytes.
function reshuffled(value) {
  if (Array.isArray(value)) return value.map(reshuffled);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).reverse().map(([key, entry]) => [key, reshuffled(entry)]));
  return value;
}

export async function runSimulation({ scenarios, indexes, until = LESSON_START + 8 * 60 * MIN, checkpoints = [], heavyBudget = 20, databaseOutage = null }) {
  const lessons = scenarios.map((_, position) => makeLesson(indexes ? indexes[position] : position));
  const store = createClassroomStore({ lessons });
  const drive = createDrive();
  const sim = { store, drive, zoomQueue: [], deliveries: [], stats: { webhooks: 0, retriedDeliveries: 0, lostAfterRetries: 0, rejected: 0, actions: {}, actionWriteFailures: 0, reconciliations: 0, heavyByMinute: new Map() } };
  const rooms = lessons.map((lesson, position) => createRoom(sim, lesson, { ...DEFAULTS, ...SCENARIOS[scenarios[position]], name: scenarios[position] }));
  const lastReconciledAt = new Map();
  const snapshots = [];
  const pending = [...checkpoints].sort((a, b) => a - b);
  let t = LESSON_START - 20 * MIN;
  while (t <= until) {
    // During an outage every write fails: webhooks get 503, host reports are lost, and the
    // server's own writes fail and are tried again later.
    if (databaseOutage) store.faults.failTransactions = t >= databaseOutage.from && t < databaseOutage.to ? Infinity : 0;
    await runDue(sim.zoomQueue, t);
    await deliverDue(sim, t);
    for (const room of rooms) heartbeat(sim, room, t);
    const eventsByLesson = new Map(lessons.map(lesson => [lesson.id, store.eventsFor(lesson.id)]));
    for (const room of rooms) {
      for (const action of planActions(room.lesson, eventsByLesson.get(room.lesson.id), t)) await perform(sim, room, action, t);
    }
    for (const due of dueReconciliations(lessons, eventsByLesson, t, { lastReconciledAt, heavyBudget })) {
      const room = rooms.find(entry => entry.lesson.id === due.lessonId);
      const result = await ingestApiSnapshot({ snapshot: snapshotOf(room, t), now: t, store });
      if (result.status === 200) lastReconciledAt.set(due.lessonId, t);
      sim.stats.reconciliations += 1;
      const minute = Math.floor(t / MIN);
      sim.stats.heavyByMinute.set(minute, (sim.stats.heavyByMinute.get(minute) ?? 0) + due.heavyCalls);
    }
    await processJobs({
      store,
      now: t,
      workerId: 'worker-1',
      handlers: {
        file_recording: ({ job, leaseVersion, now }) => fileRecording({ store, drive, download: syntheticDownload, job, leaseVersion, now, rootFolderId: ROOT_FOLDER }),
        delete_vendor_copy: ({ job, leaseVersion }) => {
          const room = rooms.find(entry => entry.lesson.id === job.lessonId);
          const file = room.files.find(entry => entry.payload.id === job.providerFileId);
          if (file) file.deletedAtZoom = true;
          store.completeJob({ jobId: job.id, leaseVersion });
          return { status: 'VENDOR_COPY_DELETED' };
        },
      },
    });
    while (pending.length && pending[0] <= t) {
      const at = pending.shift();
      snapshots.push({ at, dashboard: buildDashboard({ lessons, events: store.events(), now: t }) });
    }
    t += t < LESSON_START + 80 * MIN ? 5_000 : 60_000;
  }
  const final = buildDashboard({ lessons, events: store.events(), now: until });
  const maxHeavyPerMinute = Math.max(0, ...sim.stats.heavyByMinute.values());
  return { lessons, rooms, store, drive, snapshots, final, stats: { ...sim.stats, heavyByMinute: undefined, maxHeavyPerMinute } };
}

function createRoom(sim, lesson, scenario) {
  const room = {
    lesson,
    scenario,
    tutor: lesson.participants.find(entry => entry.role === 'tutor').id,
    student: lesson.participants.find(entry => entry.role === 'student').id,
    session: null,
    sessions: 0,
    present: new Map(),
    tutorOnline: true,
    lastHeartbeat: -Infinity,
    recording: null,
    segments: 0,
    files: [],
    stopsIgnored: 0,
  };
  const at = offset => LESSON_START + offset;
  schedule(sim, at(scenario.tutorJoinAt), () => join(sim, room, room.tutor, at(scenario.tutorJoinAt)));
  schedule(sim, at(scenario.studentJoinAt), () => join(sim, room, room.student, at(scenario.studentJoinAt)));
  schedule(sim, at(scenario.studentLeaveAt), () => leave(sim, room, room.student, at(scenario.studentLeaveAt), 'LEFT'));
  schedule(sim, at(scenario.tutorLeaveAt), () => leave(sim, room, room.tutor, at(scenario.tutorLeaveAt), 'LEFT'));
  if (scenario.tutorShutdownAt != null) {
    // The computer is switched off: no goodbye, no more host reports; Zoom drops the tutor
    // when the connection has been gone for two minutes.
    schedule(sim, at(scenario.tutorShutdownAt), () => { room.tutorOnline = false; });
    schedule(sim, at(scenario.tutorShutdownAt) + 2 * MIN, () => leave(sim, room, room.tutor, at(scenario.tutorShutdownAt) + 2 * MIN, 'DISCONNECTED'));
  }
  if (scenario.everyoneDropsAt != null) {
    schedule(sim, at(scenario.everyoneDropsAt), () => { room.tutorOnline = false; });
    for (const id of [room.student, room.tutor]) {
      schedule(sim, at(scenario.everyoneDropsAt) + 2 * MIN, () => leave(sim, room, id, at(scenario.everyoneDropsAt) + 2 * MIN, 'DISCONNECTED'));
    }
  }
  if (scenario.withdrawalAt != null) {
    schedule(sim, at(scenario.withdrawalAt), () => serverFact(sim, room, 'server.consent_withdrawn', at(scenario.withdrawalAt), { participantId: room.student }, 'withdrawal'));
  }
  if (scenario.joinBlockedAt != null) {
    schedule(sim, at(scenario.joinBlockedAt), () => serverFact(sim, room, 'server.join_blocked', at(scenario.joinBlockedAt), { reason: 'IDENTITY_UNVERIFIED' }, 'blocked-1'));
  }
  if (scenario.unknownJoinAt != null) {
    schedule(sim, at(scenario.unknownJoinAt), () => join(sim, room, 'P-TEST-X99', at(scenario.unknownJoinAt)));
  }
  return room;
}

function schedule(sim, at, run) {
  sim.zoomQueue.push({ at, run, order: sim.zoomQueue.length });
}

async function runDue(queue, t) {
  for (;;) {
    queue.sort((a, b) => a.at - b.at || a.order - b.order);
    if (!queue.length || queue[0].at > t) return;
    await queue.shift().run();
  }
}

async function serverFact(sim, room, type, at, fields, keySuffix) {
  await sim.store.transaction(tx => storeEvent(tx, { source: 'server', type, lessonId: room.lesson.id, occurredAt: at, receivedAt: at, key: `${type}:${room.lesson.id}:${keySuffix}`, ...fields }));
}

function startSession(sim, room, at) {
  room.sessions += 1;
  room.session = { id: `sess-${room.lesson.id}-${room.sessions}`, startedAt: at, endedAt: null, ending: false, users: [] };
  webhook(sim, room, 'session.started', at, { start_time: iso(at) });
}

function join(sim, room, id, at) {
  if (!room.session || room.session.endedAt != null) startSession(sim, room, at);
  if (room.present.has(id)) return;
  const uuid = `uuid-${id}-${room.session.id}`;
  room.present.set(id, { uuid, since: at });
  room.session.users.push({ id, uuid, join: at, leave: null, reason: null });
  if (id === room.tutor) room.tutorOnline = true;
  webhook(sim, room, 'session.user_joined', at, { user: userPayload(id, uuid, { join_time: iso(at) }) });
  if (id !== room.tutor) hostReport(sim, room, at, { type: 'user_added', userKey: id });
  // The account-level automatic recording switch, left on by mistake: Zoom records as soon as
  // the session starts, without anyone asking.
  if (room.scenario.autoRecording && room.session.users.length === 1) schedule(sim, at + 3_000, () => recordingOn(sim, room, at + 3_000));
}

function leave(sim, room, id, at, reason) {
  if (!room.present.has(id) || !room.session) return;
  room.present.delete(id);
  const user = room.session.users.find(entry => entry.id === id && entry.leave == null);
  Object.assign(user, { leave: at, reason });
  webhook(sim, room, 'session.user_left', at, { user: userPayload(id, user.uuid, { leave_time: iso(at), leave_reason: LEAVE_TEXT[reason] }) });
  if (id !== room.tutor) hostReport(sim, room, at, { type: 'user_removed', userKey: id });
  if (id === room.tutor && room.tutorOnline) hostReport(sim, room, at, { type: 'connection', state: 'Closed' }, { force: true });
  // Zoom ends a session when its last user leaves.
  if (!room.present.size && !room.session.ending) endSession(sim, room, at);
}

function endSession(sim, room, at) {
  const session = room.session;
  if (!session || session.endedAt != null || session.ending) return;
  session.ending = true;
  if (room.recording) recordingOff(sim, room, at, { withSession: true });
  for (const id of [...room.present.keys()]) leave(sim, room, id, at, 'HOST_ENDED');
  session.endedAt = at;
  webhook(sim, room, 'session.ended', at, { start_time: iso(session.startedAt), end_time: iso(at) });
}

function recordingOn(sim, room, at) {
  if (!room.session || room.session.endedAt != null || room.recording) return;
  room.recording = { since: at, sessionId: room.session.id };
  webhook(sim, room, 'session.recording_started', at, { start_time: iso(room.session.startedAt), recording_file: { recording_start: iso(at) } });
  hostReport(sim, room, at, { type: 'recording_status', status: 'Recording' });
}

function recordingOff(sim, room, at, { withSession = false } = {}) {
  if (!room.recording) return;
  const segment = { start: room.recording.since, end: at, sessionId: room.recording.sessionId, index: ++room.segments };
  room.recording = null;
  // Whether Zoom also sends recording_stopped when the session ends is not documented; this
  // simulation sends it only for an explicit stop, so the session-end case stays inferred.
  if (!withSession) {
    webhook(sim, room, 'session.recording_stopped', at, { recording_file: { recording_end: iso(at) } });
    hostReport(sim, room, at, { type: 'recording_status', status: 'Stopped' });
  }
  const base = `${room.lesson.id}-seg${segment.index}`;
  const fileOf = (suffix, type, extension, size) => ({
    id: `${base}-${suffix}`,
    recording_start: iso(segment.start),
    recording_end: iso(segment.end),
    file_name: 'Synthetic Display Name recording',
    file_path: '/synthetic/path',
    file_type: extension,
    file_size: size,
    file_extension: extension,
    download_url: 'https://example.invalid/synthetic/download',
    status: 'completed',
    recording_type: type,
  });
  const payloads = [fileOf('video', 'shared_screen_with_speaker_view', 'MP4', 64), fileOf('audio', 'audio_only', 'M4A', 32)];
  const readyAt = at + room.scenario.processingDelayMs;
  for (const payload of payloads) room.files.push({ payload, sessionId: segment.sessionId, readyAt });
  schedule(sim, readyAt, () => {
    const session = { id: segment.sessionId };
    webhook(sim, room, 'session.recording_completed', readyAt, { recording_files: payloads }, session);
  });
}

function userPayload(id, uuid, times) {
  return { id: '16778240', name: 'Synthetic Display Name', participant_uuid: uuid, user_key: id, phone_number: '+886-2-0000-0000', ...times };
}

function webhook(sim, room, type, at, object, session = room.session) {
  const scenario = room.scenario;
  if (scenario.lose.includes(type)) return;
  const body = {
    event: type,
    event_ts: at,
    payload: {
      account_id: 'synthetic-account',
      object: { id: session.id, session_id: session.id, session_name: roomNameOf(room.lesson.id), session_key: room.lesson.id, ...object },
    },
  };
  if (type === 'session.recording_completed') body.download_token = 'synthetic-download-token-not-real';
  const deliverAt = at + (scenario.delays[type] ?? scenario.webhookDelayMs);
  sim.deliveries.push({ at: deliverAt, kind: 'webhook', body, attempt: 0, reshuffle: false });
  if (scenario.duplicate) {
    sim.deliveries.push({ at: deliverAt + 5 * MIN, kind: 'webhook', body, attempt: 0, reshuffle: true });
    sim.deliveries.push({ at: deliverAt + 25 * MIN, kind: 'webhook', body, attempt: 0, reshuffle: true });
  }
}

function hostReport(sim, room, at, report, { force = false } = {}) {
  if (!force && (!room.present.has(room.tutor) || !room.tutorOnline)) return;
  sim.deliveries.push({ at: at + 1_000, kind: 'host', room, report: { ...report, at } });
}

function heartbeat(sim, room, t) {
  if (!room.present.has(room.tutor) || !room.tutorOnline) return;
  if (t - room.lastHeartbeat < (room.recording ? 10_000 : 30_000)) return;
  room.lastHeartbeat = t;
  hostReport(sim, room, t, { type: 'heartbeat' });
}

const ZOOM_RETRY_MS = [5 * MIN, 20 * MIN, 60 * MIN];

async function deliverDue(sim, t) {
  for (;;) {
    sim.deliveries.sort((a, b) => a.at - b.at);
    if (!sim.deliveries.length || sim.deliveries[0].at > t) return;
    const delivery = sim.deliveries.shift();
    if (delivery.kind === 'host') {
      const result = await ingestHostReport({ report: delivery.report, lessonId: delivery.room.lesson.id, tutorId: delivery.room.tutor, now: delivery.at, store: sim.store });
      if (result.status !== 200) sim.stats.actionWriteFailures += 1;
      continue;
    }
    const raw = delivery.reshuffle ? JSON.stringify(reshuffled(delivery.body), null, 1) : JSON.stringify(delivery.body);
    const timestamp = Math.floor(delivery.at / 1000);
    const headers = { 'x-zm-request-timestamp': String(timestamp), 'x-zm-signature': signZoomRequest(SECRET, timestamp, raw) };
    const result = await ingestWebhook({ headers, rawBody: raw, secret: SECRET, now: delivery.at, store: sim.store });
    sim.stats.webhooks += 1;
    if (result.status === 401) sim.stats.rejected += 1;
    // Zoom retries 5xx three times, 5, 20 and 60 minutes apart, then gives up.
    if (result.status >= 500) {
      if (delivery.attempt < ZOOM_RETRY_MS.length) {
        sim.deliveries.push({ ...delivery, at: delivery.at + ZOOM_RETRY_MS[delivery.attempt], attempt: delivery.attempt + 1 });
        sim.stats.retriedDeliveries += 1;
      } else {
        sim.stats.lostAfterRetries += 1;
      }
    }
  }
}

async function perform(sim, room, action, t) {
  const { lesson, scenario } = room;
  const write = (type, fields = {}, key = action.key) =>
    sim.store.transaction(tx => storeEvent(tx, { source: 'server', type, lessonId: lesson.id, occurredAt: t, receivedAt: t, key, ...fields }));
  try {
    switch (action.type) {
      case 'DECIDE_RECORDING': {
        const consents = scenario.consent ? [{ participantId: room.student, status: 'granted', version: POLICY.consentVersion, grantedAt: t - 86_400_000 }] : [];
        const notices = [{ participantId: room.tutor, version: POLICY.staffNoticeVersion, acknowledgedAt: t - 86_400_000 }];
        const decision = getRecordingEligibility({ lesson, consents, notices, policy: POLICY, now: t });
        await write('server.recording_eligibility', { eligible: decision.eligible, reason: decision.reason, count: decision.count ?? 0 });
        break;
      }
      case 'START_RECORDING': {
        // The request and Zoom's answer to it are stored together; 202 only means "accepted".
        const ok = scenario.startBehaviour !== 'api_error';
        await sim.store.transaction(tx => {
          storeEvent(tx, { source: 'server', type: 'server.start_requested', lessonId: lesson.id, occurredAt: t, receivedAt: t, key: action.key, attempt: action.attempt });
          storeEvent(tx, { source: 'server', type: 'server.start_response', lessonId: lesson.id, occurredAt: t, receivedAt: t, key: `${action.key}:response`, attempt: action.attempt, ok, httpStatus: ok ? 202 : 500 });
        });
        if (ok && scenario.startBehaviour !== 'silent') schedule(sim, t + 2_000, () => recordingOn(sim, room, t + 2_000));
        break;
      }
      case 'STOP_RECORDING':
        await write('server.stop_requested', { reason: action.reason, attempt: action.attempt, channels: action.channels });
        if (room.stopsIgnored < scenario.ignoreStops) room.stopsIgnored += 1;
        else schedule(sim, t + 2_000, () => recordingOff(sim, room, t + 2_000));
        break;
      case 'END_SESSION': {
        await write('server.session_end_requested', { reason: action.reason });
        const people = [...room.present.keys()].filter(id => lesson.participants.some(entry => entry.id === id));
        schedule(sim, t + 1_000, () => endSession(sim, room, t + 1_000));
        if (scenario.rejoinAfterEndMs != null) {
          for (const id of people) schedule(sim, t + 1_000 + scenario.rejoinAfterEndMs, () => join(sim, room, id, t + 1_000 + scenario.rejoinAfterEndMs));
        }
        break;
      }
      case 'REMOVE_USER':
        await write('server.remove_requested', { userKey: action.userKey });
        schedule(sim, t + 1_000, () => leave(sim, room, action.userKey, t + 1_000, 'REMOVED'));
        break;
      case 'NOTIFY_ADMIN':
        await write('server.admin_notified', { code: action.code });
        break;
      default:
        throw new Error(`unknown action ${action.type}`);
    }
    sim.stats.actions[action.type] = (sim.stats.actions[action.type] ?? 0) + 1;
  } catch {
    // The database refused the write: nothing was done, and the planner proposes the action again.
    sim.stats.actionWriteFailures += 1;
  }
}

// What Zoom's REST API would answer about the room's latest session: details, users with join
// and leave times (plus the personal fields Zoom includes, which our side must drop), and the
// recordings that have finished processing.
function snapshotOf(room, t) {
  const session = room.session;
  if (!session) return { lessonId: room.lesson.id, providerSessionId: null, details: null, users: [], recordings: [] };
  return {
    lessonId: room.lesson.id,
    providerSessionId: session.id,
    details: { start_time: iso(session.startedAt), ...(session.endedAt != null ? { end_time: iso(session.endedAt) } : {}) },
    users: session.users.map(user => ({
      user_key: user.id,
      participant_uuid: user.uuid,
      join_time: iso(user.join),
      ...(user.leave != null ? { leave_time: iso(user.leave), leave_reason: LEAVE_TEXT[user.reason] } : {}),
      name: 'Synthetic Display Name',
      ip_address: '203.0.113.7',
      device: 'Synthetic Device',
    })),
    recordings: room.files.filter(file => file.sessionId === session.id && file.readyAt <= t && !file.deletedAtZoom).map(file => file.payload),
  };
}
