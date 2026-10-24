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

export function roomNameOf(lessonId) {
  return `ihear-${String(lessonId).toLowerCase()}`;
}

export function getJoinEligibility({ lesson, participantId, identity, now }) {
  try {
    if (!lesson) return deny('LESSON_NOT_FOUND');
    if (lesson.cancelled) return deny('LESSON_CANCELLED');
    const participant = lesson.participants.find(entry => entry.id === participantId);
    if (!participant) return deny('NOT_ON_ROSTER');
    if (!identityMatches(identity, participant)) return deny('IDENTITY_UNVERIFIED');
    if (participant.role === 'observer') return deny('OBSERVER_NOT_ENABLED');
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
  if (participant.role === 'tutor') return identity.method === 'staff_login';
  return identity.method === 'join_link' || identity.method === 'account';
}

function deny(reason) {
  return { allowed: false, reason };
}

export function getRecordingEligibility({ lesson, consents, notices, policy, now }) {
  try {
    if (!lesson || lesson.cancelled) return refuse(['LESSON_NOT_FOUND']);
    const students = lesson.participants.filter(entry => entry.role === 'student');
    const tutor = lesson.participants.find(entry => entry.role === 'tutor');
    if (!tutor || !students.length) return refuse(['ROSTER_INCOMPLETE']);
    const problems = students
      .map(student => consentProblem(consents.find(record => record.participantId === student.id), policy, now))
      .filter(Boolean);
    const notice = notices.find(record => record.participantId === tutor.id);
    if (!notice || notice.version !== policy.staffNoticeVersion || !(toMs(notice.acknowledgedAt) <= now)) {
      problems.push('STAFF_NOTICE_MISSING');
    }
    if (problems.length) return refuse(problems);
    return { eligible: true, reason: 'ALL_CONSENTED', consentVersion: policy.consentVersion };
  } catch {
    return refuse(['CHECK_FAILED']);
  }
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
export function buildSessionTokenClaims({ lesson, participant, appKey, now }) {
  if (String(lesson.id).length > 36 || String(participant.id).length > 36) throw new Error('identifier longer than 36 characters');
  const iat = Math.floor(now / 1000);
  const claims = {
    app_key: appKey,
    role_type: participant.role === 'tutor' ? 1 : 0,
    tpc: roomNameOf(lesson.id),
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
