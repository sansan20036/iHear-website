// Synthetic tests for entering a classroom and for whether a lesson may be recorded. Entering
// never depends on recording consent; recording depends on the consent of the whole roster.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  buildSessionTokenClaims,
  checkJoinedParticipant,
  getJoinEligibility,
  getRecordingEligibility,
  issueJoinToken,
  roomNameOf,
  TOKEN_LIFETIME_S,
} from '../classroom/eligibility.mjs';

const START = Date.parse('2026-11-03T02:00:00Z');
const MIN = 60_000;
const SECRET = 'synthetic-sdk-secret-not-real';
const POLICY = { consentVersion: '2026-11', staffNoticeVersion: '2026-11' };
const lesson = {
  id: 'L-TEST-001',
  code: 'TEST-L001',
  date: '2026-11-03',
  startsAt: '2026-11-03T02:00:00Z',
  endsAt: '2026-11-03T03:00:00Z',
  participants: [
    { id: 'P-TEST-T01', code: 'TEST-T01', role: 'tutor' },
    { id: 'P-TEST-S01', code: 'TEST-S01', role: 'student' },
    { id: 'P-TEST-S02', code: 'TEST-S02', role: 'student' },
  ],
};
const tutor = { verified: true, participantId: 'P-TEST-T01', method: 'staff_login' };
const student = id => ({ verified: true, participantId: id, method: 'join_link' });
const granted = id => ({ participantId: id, status: 'granted', version: POLICY.consentVersion, grantedAt: START - 86_400_000 });
const notice = { participantId: 'P-TEST-T01', version: POLICY.staffNoticeVersion, acknowledgedAt: START - 86_400_000 };
const issue = (participantId, identity, now = START, target = lesson) =>
  issueJoinToken({ lesson: target, participantId, identity, now, appKey: 'synthetic-app-key', secret: SECRET });

test('a student whose parents did not agree to recording still enters the classroom', () => {
  const recording = getRecordingEligibility({ lesson, consents: [granted('P-TEST-S02')], notices: [notice], policy: POLICY, now: START });
  assert.equal(recording.eligible, false);
  const entry = issue('P-TEST-S01', student('P-TEST-S01'));
  assert.equal(entry.decision.allowed, true);
  assert.ok(entry.token);
  // Entering is decided without any consent data at all.
  assert.equal(getJoinEligibility.length, 1);
  assert.deepEqual(Object.keys(getJoinEligibility({ lesson, participantId: 'P-TEST-S01', identity: student('P-TEST-S01'), now: START })), ['allowed', 'reason', 'role']);
});

test('unknown identity, a name not on the roster, the wrong time, a missing or cancelled lesson and errors get no token', () => {
  const broken = { ...lesson, get participants() { throw new Error('synthetic failure'); } };
  const cases = [
    ['IDENTITY_UNVERIFIED', issue('P-TEST-S01', null)],
    ['IDENTITY_UNVERIFIED', issue('P-TEST-S01', { verified: false, participantId: 'P-TEST-S01', method: 'join_link' })],
    ['IDENTITY_UNVERIFIED', issue('P-TEST-S01', student('P-TEST-S02'))],
    ['IDENTITY_UNVERIFIED', issue('P-TEST-T01', { verified: true, participantId: 'P-TEST-T01', method: 'join_link' })],
    ['NOT_ON_ROSTER', issue('P-TEST-S99', student('P-TEST-S99'))],
    ['OUTSIDE_JOIN_WINDOW', issue('P-TEST-S01', student('P-TEST-S01'), START - 16 * MIN)],
    ['OUTSIDE_JOIN_WINDOW', issue('P-TEST-S01', student('P-TEST-S01'), START + 76 * MIN)],
    ['LESSON_NOT_FOUND', issue('P-TEST-S01', student('P-TEST-S01'), START, null)],
    ['LESSON_CANCELLED', issue('P-TEST-S01', student('P-TEST-S01'), START, { ...lesson, cancelled: true })],
    ['CHECK_FAILED', issue('P-TEST-S01', student('P-TEST-S01'), START, broken)],
  ];
  for (const [reason, result] of cases) {
    assert.deepEqual(result.decision, { allowed: false, reason });
    assert.equal(result.token, null);
    assert.equal(result.record, null);
  }
  assert.equal(issue('P-TEST-S01', student('P-TEST-S01'), START - 15 * MIN).decision.allowed, true);
  assert.equal(issue('P-TEST-T01', tutor, START + 75 * MIN).decision.allowed, true);
});

test('one student without valid consent, or a tutor without the notice, means the whole lesson is not recorded', () => {
  const all = [granted('P-TEST-S01'), granted('P-TEST-S02')];
  const check = (consents, notices = [notice]) => getRecordingEligibility({ lesson, consents, notices, policy: POLICY, now: START });
  const cases = [
    ['CONSENT_MISSING', check([granted('P-TEST-S01')])],
    ['CONSENT_WITHDRAWN', check([granted('P-TEST-S01'), { ...granted('P-TEST-S02'), status: 'withdrawn', withdrawnAt: START - MIN }])],
    ['CONSENT_WITHDRAWN', check([granted('P-TEST-S01'), { ...granted('P-TEST-S02'), withdrawnAt: START - MIN }])],
    ['CONSENT_EXPIRED', check([granted('P-TEST-S01'), { ...granted('P-TEST-S02'), expiresAt: START - MIN }])],
    ['CONSENT_VERSION_MISMATCH', check([granted('P-TEST-S01'), { ...granted('P-TEST-S02'), version: '2026-09' }])],
    ['CONSENT_MISSING', check([granted('P-TEST-S01'), { ...granted('P-TEST-S02'), status: 'pending' }])],
    ['STAFF_NOTICE_MISSING', check(all, [])],
    ['STAFF_NOTICE_MISSING', check(all, [{ ...notice, version: '2026-09' }])],
    ['CHECK_FAILED', check(null)],
    ['LESSON_NOT_FOUND', getRecordingEligibility({ lesson: null, consents: all, notices: [notice], policy: POLICY, now: START })],
  ];
  for (const [reason, result] of cases) {
    assert.equal(result.eligible, false, reason);
    assert.equal(result.reason, reason);
  }
  // Counts only, never which student.
  const two = check([]);
  assert.equal(two.count, 2);
  assert.doesNotMatch(JSON.stringify(two), /P-TEST|TEST-S/);
  // Not being recorded never affects entering.
  for (const id of ['P-TEST-S01', 'P-TEST-S02']) assert.equal(issue(id, student(id)).decision.allowed, true);
});

test('recording is allowed only when every student consented and the tutor acknowledged the notice', () => {
  const result = getRecordingEligibility({ lesson, consents: [granted('P-TEST-S01'), granted('P-TEST-S02')], notices: [notice], policy: POLICY, now: START });
  assert.deepEqual(result, { eligible: true, reason: 'ALL_CONSENTED', consentVersion: '2026-11' });
  const later = getRecordingEligibility({ lesson, consents: [granted('P-TEST-S01'), { ...granted('P-TEST-S02'), withdrawnAt: START + 30 * MIN }], notices: [notice], policy: POLICY, now: START + 31 * MIN });
  assert.equal(later.reason, 'CONSENT_WITHDRAWN');
});

test('session tokens carry our own identifiers, last 30 minutes and record one combined video', () => {
  const tutorToken = issue('P-TEST-T01', tutor);
  const [header, payload, signature] = tutorToken.token.split('.');
  assert.ok(signature);
  assert.deepEqual(JSON.parse(Buffer.from(header, 'base64url')), { alg: 'HS256', typ: 'JWT' });
  const claims = JSON.parse(Buffer.from(payload, 'base64url'));
  assert.equal(claims.role_type, 1);
  assert.equal(claims.tpc, roomNameOf('L-TEST-001'));
  assert.equal(claims.tpc, 'ihear-l-test-001');
  assert.equal(claims.session_key, 'L-TEST-001');
  assert.equal(claims.user_key, 'P-TEST-T01');
  assert.equal(claims.exp - claims.iat, TOKEN_LIFETIME_S);
  assert.equal(TOKEN_LIFETIME_S, 1800);
  assert.equal(claims.cloud_recording_option, 0);
  const studentClaims = buildSessionTokenClaims({ lesson, participant: lesson.participants[1], appKey: 'synthetic-app-key', now: START });
  assert.equal(studentClaims.role_type, 0);
  assert.equal('cloud_recording_option' in studentClaims, false);
  // What is stored is the hash and the expiry, never the token itself.
  assert.equal(tutorToken.record.tokenHash, createHash('sha256').update(tutorToken.token).digest('hex'));
  assert.equal(tutorToken.record.expiresAt - tutorToken.record.issuedAt, 1_800_000);
  assert.equal(JSON.stringify(tutorToken.record).includes(tutorToken.token), false);
  // No names in the token: Zoom only ever sees our codes.
  assert.deepEqual(Object.keys(claims).sort(), ['app_key', 'cloud_recording_option', 'exp', 'iat', 'role_type', 'session_key', 'tpc', 'user_key', 'version']);
});

test('identifiers longer than Zoom accepts are refused', () => {
  const long = { ...lesson, id: `L-${'X'.repeat(35)}` };
  assert.throws(() => buildSessionTokenClaims({ lesson: long, participant: lesson.participants[0], appKey: 'k', now: START }), /36/);
});

test('someone in the room without a token we issued is unknown: removed, and recording stopped if it runs', () => {
  const issued = [issue('P-TEST-T01', tutor).record, issue('P-TEST-S01', student('P-TEST-S01')).record];
  assert.deepEqual(checkJoinedParticipant({ lesson, userKey: 'P-TEST-S01', joinedAt: START + MIN, tokenRecords: issued }), { ok: true, participantId: 'P-TEST-S01' });
  for (const [userKey, joinedAt] of [['P-TEST-X99', START + MIN], ['P-TEST-S02', START + MIN], ['P-TEST-S01', START + 40 * MIN]]) {
    const result = checkJoinedParticipant({ lesson, userKey, joinedAt, tokenRecords: issued });
    assert.equal(result.ok, false, userKey);
    assert.equal(result.code, 'UNKNOWN_PARTICIPANT');
    assert.deepEqual(result.actions, ['REMOVE_USER', 'STOP_RECORDING_IF_ACTIVE']);
  }
});
