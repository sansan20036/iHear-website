// Who may enter a classroom, and whether a lesson may be recorded. These are two separate
// questions on purpose:
//   getJoinEligibility       lesson, identity, roster and time window. Never consent: a student
//                            whose parents did not agree to recording still attends the lesson.
//   getRecordingEligibility  consent for the whole roster. If anyone's consent is missing, the
//                            whole lesson is not recorded, and the lesson itself is unaffected.
// Both fail closed: missing data or any error answers "no". Synthetic prototype only; the real
// token secret comes from the server environment once credentials are approved.
import { createHash, createHmac } from 'node:crypto';

export const JOIN_WINDOW_BEFORE_MS = 15 * 60 * 1000;
export const JOIN_WINDOW_AFTER_MS = 15 * 60 * 1000;
// Zoom requires exp to be between 1800 seconds and 48 hours after iat; we use the shortest.
export const TOKEN_LIFETIME_S = 1800;

const toMs = value => (typeof value === 'number' ? value : Date.parse(value));

// The Video SDK session name (the token's tpc) of a lesson's room. Generation 0 is the name every
// lesson has always had; each later generation (D-1, 2026-11-08: a new room after a link is
// revoked or reissued) gets "-g<n>". A session already running keeps its name: a new generation
// only changes where new tokens lead.
export function roomNameOf(lessonId, generation = 0) {
  const base = `ihear-${String(lessonId).toLowerCase()}`;
  return generation > 0 ? `${base}-g${generation}` : base;
}

// Which generation of this lesson's room a session name is, or null when it is not this
// lesson's (or not a name we issue). Zoom lower-cases the name.
export function generationOfRoom(lessonId, name) {
  if (typeof name !== 'string' || !name) return null;
  const base = roomNameOf(lessonId);
  const value = name.toLowerCase();
  if (value === base) return 0;
  const suffix = value.startsWith(`${base}-g`) ? value.slice(base.length + 2) : null;
  return suffix && /^[1-9]\d{0,5}$/.test(suffix) ? Number(suffix) : null;
}

export function getJoinEligibility({ lesson, participantId, identity, now }) {
  try {
    if (!lesson) return deny('LESSON_NOT_FOUND');
    if (lesson.cancelled) return deny('LESSON_CANCELLED');
    // P3-Multi: a seat given up (moved, visit over) is no longer this room's roster.
    const participant = lesson.participants.find(entry => entry.id === participantId && entry.active !== false);
    if (!participant) return deny('NOT_ON_ROSTER');
    if (!identityMatches(identity, participant)) return deny('IDENTITY_UNVERIFIED');
    // Observers only in a block's Lobby and rooms (P3-Multi), never in a one-to-one lesson.
    if (participant.role === 'observer' && lesson.observersEnabled !== true) return deny('OBSERVER_NOT_ENABLED');
    const opens = toMs(lesson.startsAt) - JOIN_WINDOW_BEFORE_MS;
    const closes = toMs(lesson.endsAt) + JOIN_WINDOW_AFTER_MS;
    if (!(now >= opens && now <= closes)) return deny('OUTSIDE_JOIN_WINDOW');
    return { allowed: true, reason: 'ALLOWED', role: participant.role };
  } catch {
    return deny('CHECK_FAILED');
  }
}

// Tutors prove who they are with their website sign-in. How students prove it (a personal
// join link or an account) is still Justine's decision, so either verified method is accepted.
function identityMatches(identity, participant) {
  if (!identity || identity.verified !== true || identity.participantId !== participant.id) return false;
  if (participant.role === 'tutor' || participant.role === 'observer') return identity.method === 'staff_login';
  return identity.method === 'join_link' || identity.method === 'account';
}

function deny(reason) {
  return { allowed: false, reason };
}

export function getRecordingEligibility({ lesson, consents, notices, policy, now }) {
  try {
    if (!lesson || lesson.cancelled) return refuse(['LESSON_NOT_FOUND']);
    // P3-Multi: a block's Lobby is never recorded, nor a room while its block is Classroom Only.
    if (lesson.recordingDisabled === true) return refuse(['RECORDING_DISABLED']);
    // The room's roster as it is now: seats given up do not count (P3-Multi).
    const roster = lesson.participants.filter(entry => entry.active !== false);
    const students = roster.filter(entry => entry.role === 'student');
    const tutor = roster.find(entry => entry.role === 'tutor');
    if (!tutor || !students.length) return refuse(['ROSTER_INCOMPLETE']);
    const problems = students
      .map(student => consentProblem(consents.find(record => record.participantId === student.id), policy, now))
      .filter(Boolean);
    // Every staff member in the room acknowledges the notice: each tutor (lead and co-tutors) and
    // each observer (P3-Multi). A one-to-one lesson has its one tutor, as before.
    for (const staff of roster.filter(entry => entry.role === 'tutor' || entry.role === 'observer')) {
      const notice = notices.find(record => record.participantId === staff.id);
      if (staffNoticeProblem(notice, policy, now)) { problems.push('STAFF_NOTICE_MISSING'); break; }
    }
    if (problems.length) return refuse(problems);
    return { eligible: true, reason: 'ALL_CONSENTED', consentVersion: policy.consentVersion };
  } catch {
    return refuse(['CHECK_FAILED']);
  }
}

// One person's consent or one staff member's notice, as the whole-room rule reads it (P3-Multi
// uses these before letting someone into a room that may record).
export function personConsentProblem(record, policy, now) {
  return consentProblem(record, policy, now);
}
export function staffNoticeProblem(notice, policy, now) {
  return !notice || notice.version !== policy.staffNoticeVersion || !(toMs(notice.acknowledgedAt) <= now) ? 'STAFF_NOTICE_MISSING' : null;
}

function consentProblem(record, policy, now) {
  if (!record) return 'CONSENT_MISSING';
  if (record.status === 'withdrawn' || (record.withdrawnAt != null && toMs(record.withdrawnAt) <= now)) return 'CONSENT_WITHDRAWN';
  if (record.status !== 'granted') return 'CONSENT_MISSING';
  if (record.expiresAt != null && toMs(record.expiresAt) <= now) return 'CONSENT_EXPIRED';
  if (record.version !== policy.consentVersion) return 'CONSENT_VERSION_MISMATCH';
  return null;
}

// Counts only: the result may end up on the dashboard, which never says which student it is.
function refuse(problems) {
  return { eligible: false, reason: problems[0], reasons: [...new Set(problems)], count: problems.length };
}

// Video SDK session token claims. Our own identifiers go into the token so that every Zoom
// event can be matched to the roster without names: session_key = lessonId, user_key =
// participantId (both at most 36 characters). cloud_recording_option 0 is the default single
// combined video; 1 would give a file per person and needs Zoom to enable it.
export function buildSessionTokenClaims({ lesson, participant, appKey, now, generation = 0 }) {
  if (String(lesson.id).length > 36 || String(participant.id).length > 36) throw new Error('identifier longer than 36 characters');
  const iat = Math.floor(now / 1000);
  const claims = {
    app_key: appKey,
    role_type: participant.role === 'tutor' ? 1 : 0,
    tpc: roomNameOf(lesson.id, generation),
    version: 1,
    session_key: lesson.id,
    user_key: participant.id,
    iat,
    exp: iat + TOKEN_LIFETIME_S,
  };
  if (claims.role_type === 1) claims.cloud_recording_option = 0;
  return claims;
}

export function signSessionToken(claims, secret) {
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const body = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(claims)}`;
  return `${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`;
}

// Issues a token only after the join check passes. What gets stored is the token's hash and
// expiry, never the token itself.
export function issueJoinToken({ lesson, participantId, identity, now, appKey, secret }) {
  const decision = getJoinEligibility({ lesson, participantId, identity, now });
  if (!decision.allowed) return { decision, token: null, record: null };
  const participant = lesson.participants.find(entry => entry.id === participantId);
  const claims = buildSessionTokenClaims({ lesson, participant, appKey, now });
  const token = signSessionToken(claims, secret);
  const record = {
    lessonId: lesson.id,
    participantId,
    tokenHash: createHash('sha256').update(token).digest('hex'),
    issuedAt: claims.iat * 1000,
    expiresAt: claims.exp * 1000,
  };
  return { decision, token, record };
}

// Second line of defence inside the room: a user_key nobody was given a token for.
export function checkJoinedParticipant({ lesson, userKey, joinedAt, tokenRecords }) {
  const participant = lesson.participants.find(entry => entry.id === userKey);
  const issued = tokenRecords.some(record =>
    record.lessonId === lesson.id && record.participantId === userKey && record.issuedAt <= joinedAt && record.expiresAt >= joinedAt);
  if (participant && issued) return { ok: true, participantId: userKey };
  return { ok: false, code: 'UNKNOWN_PARTICIPANT', actions: ['REMOVE_USER', 'STOP_RECORDING_IF_ACTIVE'] };
}
