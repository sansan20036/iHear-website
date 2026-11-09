// Local dry run with synthetic data: a cloud-recording "completed" webhook goes through every step
// the automatic pathway needs before anything touches Google Drive. Steps: signature and freshness
// check, lesson lookup, consent, the P1 naming rules (Core.js, reused unchanged) and the
// duplicate guard. No network and no credentials: the Drive step only prints what it would do.
// The payload is shaped like Zoom's session.recording_completed; field names must be checked
// against Zoom's reference before a real integration.
// This script only demonstrates the naming. In the design, the duplicate guard is the database's
// unique key and webhooks are answered only after their event is stored: see
// ../classroom/webhook-ingest.mjs and its tests, not the in-memory set used here.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Core = require('../apps-script/Core.js');

const SECRET = 'synthetic-webhook-secret-not-real';
const MAX_AGE_MS = 5 * 60 * 1000;
const DEST = '[測試] iHear 錄影存放區';

// Our own schedule decides what a session is: one session per classroom (tutor + students).
const lessons = {
  'sess-TEST-001': { date: '2026-11-03', tutor: '陳小老師', students: ['測試學生甲'] },
  'sess-TEST-002': { date: '2026-11-03', tutor: '林小老師', students: ['測試學生乙', '測試學生丙'] },
};
const roster = [
  { name: '測試學生甲', code: 'TEST-S01', consent: '已同意' },
  { name: '測試學生乙', code: 'TEST-S02', consent: '已同意' },
  { name: '測試學生丙', code: 'TEST-S03', consent: '' },
];
const stored = new Set();          // recording file ids already handled (webhooks are retried)
const planned = new Map();         // destination names already planned, per lesson base name

function sign(timestamp, rawBody) {
  return 'v0=' + createHmac('sha256', SECRET).update(`v0:${timestamp}:${rawBody}`).digest('hex');
}

function verify(headers, rawBody, now) {
  const timestamp = Number(headers['x-zm-request-timestamp']);
  if (!Number.isFinite(timestamp) || Math.abs(now - timestamp * 1000) > MAX_AGE_MS) return 'stale or missing timestamp';
  const expected = Buffer.from(sign(timestamp, rawBody));
  const actual = Buffer.from(String(headers['x-zm-signature'] || ''));
  return expected.length === actual.length && timingSafeEqual(expected, actual) ? null : 'signature mismatch';
}

function handle(headers, rawBody, now) {
  const problem = verify(headers, rawBody, now);
  if (problem) return [{ status: 'REJECTED', reason: problem }];
  const event = JSON.parse(rawBody);
  if (event.event !== 'session.recording_completed') return [{ status: 'IGNORED', reason: event.event }];
  const session = event.payload.object;
  const lesson = lessons[session.session_id];
  if (!lesson) return [{ status: 'HOLD', reason: 'unknown session: nothing is stored, the admin is notified' }];
  const missing = lesson.students.filter(student => !Core.hasConsent(roster, student));
  if (missing.length) return [{ status: 'NO_CONSENT', reason: `${missing.length} student(s) without consent: moved to _待確認, admin notified` }];
  const label = lesson.students.map(student => Core.studentLabel(student, roster, 'code')).join('+');
  const base = Core.baseName(lesson.date, label, lesson.tutor);
  const names = planned.get(base) || [];
  return session.recording_files.map(file => {
    if (stored.has(file.id)) return { status: 'DUPLICATE', reason: `file ${file.id} already handled` };
    const extension = Core.extensionOf(`recording.${String(file.file_extension).toLowerCase()}`, file.mime_type);
    if (!extension || file.recording_type !== 'shared_screen_with_speaker_view') return { status: 'SKIPPED', reason: `${file.recording_type} (${file.file_extension}) is not kept` };
    const part = Core.nextPart(names, () => false, base, extension);
    const name = Core.fileName(base, part, extension);
    names.push(name);
    planned.set(base, names);
    stored.add(file.id);
    return { status: 'STORED', reason: `would upload to ${DEST}/${Core.monthlyFolderName(lesson.date)}/${name}` };
  });
}

function webhook(sessionId, files, { tamper = false, ageMs = 0 } = {}) {
  const now = Date.now();
  const timestamp = Math.floor((now - ageMs) / 1000);
  const body = JSON.stringify({ event: 'session.recording_completed', event_ts: now, payload: { object: { session_id: sessionId, session_name: 'synthetic', recording_files: files } } });
  const headers = { 'x-zm-request-timestamp': String(timestamp), 'x-zm-signature': sign(timestamp, body) };
  return [headers, tamper ? body.replace('synthetic', 'tampered') : body, now];
}

const video = (id, start) => ({ id, recording_type: 'shared_screen_with_speaker_view', file_extension: 'MP4', mime_type: 'video/mp4', recording_start: start, download_url: 'https://example.invalid/synthetic' });
const audio = id => ({ id, recording_type: 'audio_only', file_extension: 'M4A', mime_type: 'audio/mp4', download_url: 'https://example.invalid/synthetic' });

const cases = [
  ['1 one lesson, paused once: two video segments and an audio file', webhook('sess-TEST-001', [video('f1', '10:00'), video('f2', '10:31'), audio('f3')]), ['STORED', 'STORED', 'SKIPPED']],
  ['2 the same webhook again (retry)', webhook('sess-TEST-001', [video('f1', '10:00'), video('f2', '10:31')]), ['DUPLICATE', 'DUPLICATE']],
  ['3 body changed after signing', webhook('sess-TEST-001', [video('f9', '11:00')], { tamper: true }), ['REJECTED']],
  ['4 replayed 10 minutes later', webhook('sess-TEST-001', [video('f8', '11:00')], { ageMs: 10 * 60 * 1000 }), ['REJECTED']],
  ['5 group lesson, one student without consent', webhook('sess-TEST-002', [video('g1', '14:00')]), ['NO_CONSENT']],
  ['6 session not on our schedule', webhook('sess-UNKNOWN', [video('u1', '15:00')]), ['HOLD']],
];

let failures = 0;
for (const [name, args, expected] of cases) {
  const results = handle(...args);
  const ok = JSON.stringify(results.map(result => result.status)) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  for (const result of results) console.log(`        ${result.status.padEnd(10)} ${result.reason}`);
}
console.log(failures ? `DRY RUN: FAIL (${failures})` : 'DRY RUN: PASS (all six cases)');
process.exitCode = failures ? 1 : 0;
