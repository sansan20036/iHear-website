// P3-Multi (2026-11-09, 18.3, 18.4 and the task book's section 9): how a block room's recordings are
// named and filed in Drive, and the participant snapshot each recording keeps. Plain JavaScript,
// tested with node --test.
//
// Name: <students>_<tutors>_<YYYY-MM-DD>.<ext>, e.g. Alice_Emily, Alice_Emily-Jason,
// Alice-Ben_Emily, Alice-Ben-Chloe_Emily-Jason (section 9)
//   students, tutors  the confirmed English names (never guessed from an e-mail; a name holds no
//                     "-" or "_", checked when the block is made) of the people the recording
//                     actually covers, joined with "-"
//   date              the lesson's scheduled start as a calendar date in America/New_York (EST or
//                     EDT from the time zone data, never Taipei minus a fixed number of hours),
//                     not the day it was uploaded
// A later recording with the same name gets _P02, _P03, ... before the extension.
// A list too long for a name keeps the first names that fit, then "+N" for the others and "~" with a
// fingerprint of the whole list: stable (the same people give the same name) and traceable (the
// snapshot holds every name), so two different groups never share a name by truncation.
// Folders (section 9): <parent>/<students>/<tutors>/, the same two parts as the name.
import { createHash } from 'node:crypto';
import Core from '../apps-script/Core.js';
import { personConsentProblem, staffNoticeProblem } from './eligibility.mjs';

const NEW_YORK = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });
export function newYorkDate(at) {
  const parts = Object.fromEntries(NEW_YORK.formatToParts(new Date(at)).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export const NAME_LIMITS = Object.freeze({ students: 100, tutors: 60 });
// A name safe in a file name and unambiguous between "-" and "_": letters, spaces, . and '.
export const FILE_NAME_SAFE = /^[A-Za-z][A-Za-z .']{0,59}$/;

export function nameList(names, maxLength) {
  const clean = names.map(name => Core.cleanName(name, 40));
  if (!clean.length) return 'Unknown';
  const joined = clean.join('-');
  if (joined.length <= maxLength) return joined;
  const fingerprint = createHash('sha256').update(clean.join('|')).digest('hex').slice(0, 6);
  const kept = [];
  for (const name of clean) {
    const tail = `+${clean.length - kept.length - 1}~${fingerprint}`;
    if ([...kept, name].join('-').length + tail.length > maxLength) break;
    kept.push(name);
  }
  return `${kept.join('-')}+${clean.length - kept.length}~${fingerprint}`;
}

export function blockBaseName({ students, tutors, date }) {
  return `${nameList(students, NAME_LIMITS.students)}_${nameList(tutors, NAME_LIMITS.tutors)}_${Core.lessonDate(date)}`;
}

// The folders a block room's recording goes into, read back from its planned name (the student and
// tutor parts, which never contain "_").
export function blockFolderPath(plannedName) {
  const [students, tutors] = String(plannedName).split('_');
  return [students || 'Unknown', tutors || 'Unknown'];
}

const IN = new Set(['session.user_joined', 'host.user_added']);
const OUT = new Set(['session.user_left', 'host.user_removed']);
const TUTOR_ORDER = { lead_tutor: 0, co_tutor: 1 };
const byTime = (a, b) => a.occurredAt - b.occurredAt || String(a.key).localeCompare(String(b.key));

// 18.4: who a recording covers and the evidence for each of them.
// Coverage: each of the room's rows (members ever seated there) present at some moment between the
// recording's start and end, from the room's join and leave facts; someone with no such fact never
// came. Only a room with no join or leave fact at all (no webhooks, say) is read from the seats held
// now (basis "seat").
// Evidence, for each person covered: the member and room ids, the block and room roles, the times
// they came and went, the seat changes during the recording, and their own consent (a student) or
// notice (staff) as stored, with whether it was valid at the moment the recording first covered
// them and whether it was withdrawn while it did.
// Filing: eligible only with the room's own decision allowing the recording at its start, and every
// covered student's consent and every covered staff member's notice valid throughout their part.
// Anything else is a problem the filing holds the recording for (never uploaded).
export function recordingSnapshot({ lesson, block, events, record, generation = null, decision = null, withdrawnAt = null, consents = [], notices = [], lobbyEvents = [], policy = null }) {
  const start = Number(record.recordingStart ?? record.recordingEnd ?? 0);
  const end = Number(record.recordingEnd ?? start);
  const members = new Map((block?.members ?? []).map(member => [member.id, member]));
  const rows = lesson.participants.filter(entry => entry.memberId && members.has(entry.memberId));
  const facts = events.filter(event => event.lessonId === lesson.id && (IN.has(event.type) || OUT.has(event.type))).sort(byTime);
  const seatChanges = lobbyEvents.filter(event => event.type === 'server.seat_changed' && event.occurredAt >= start && event.occurredAt <= end).sort(byTime);
  // One entry per member (a member may have had more than one row id here, e.g. after a reissue).
  const byMember = new Map();
  for (const row of rows) {
    const entry = byMember.get(row.memberId) ?? { rows: [] };
    entry.rows.push(row);
    byMember.set(row.memberId, entry);
  }
  const people = [...byMember.entries()].map(([memberId, { rows: mine }]) => {
    const member = members.get(memberId);
    const ids = new Set(mine.map(row => row.id));
    const own = facts.filter(event => ids.has(String(event.participantId)));
    const intervals = [];
    let since = null;
    for (const event of own) {
      if (IN.has(event.type) && since == null) since = event.occurredAt;
      if (OUT.has(event.type) && since != null) { intervals.push([since, event.occurredAt]); since = null; }
    }
    if (since != null) intervals.push([since, Infinity]);
    const overlaps = intervals.filter(([from, to]) => from <= end && to >= start);
    const covered = facts.length ? overlaps.length > 0 : mine.some(row => row.active !== false);
    const coveredFrom = overlaps.length ? Math.max(start, Math.min(...overlaps.map(([from]) => from))) : covered ? start : null;
    const coveredTo = overlaps.length ? Math.min(end, Math.max(...overlaps.map(([, to]) => to))) : covered ? end : null;
    const staff = member.role !== 'student';
    let evidence = null;
    let problem = null;
    if (staff) {
      const notice = notices.find(item => item.personCode === member.code) ?? null;
      evidence = notice ? { kind: 'notice', version: notice.version, acknowledgedAt: notice.acknowledgedAt } : { kind: 'notice', missing: true };
      if (covered && policy) problem = staffNoticeProblem(notice, policy, coveredFrom ?? start);
    } else {
      const consent = consents.find(item => item.personCode === member.code) ?? null;
      evidence = consent
        ? { kind: 'consent', status: consent.status, version: consent.version, grantedAt: consent.grantedAt, withdrawnAt: consent.withdrawnAt, expiresAt: consent.expiresAt }
        : { kind: 'consent', missing: true };
      if (covered && policy) {
        problem = personConsentProblem(consent, policy, coveredFrom ?? start);
        // Withdrawn or expired while the recording still covered them.
        const lapse = [consent?.withdrawnAt, consent?.expiresAt].filter(at => at != null && at > (coveredFrom ?? start) && at <= (coveredTo ?? end));
        if (!problem && lapse.length) problem = consent?.withdrawnAt != null && lapse.includes(consent.withdrawnAt) ? 'CONSENT_WITHDRAWN_DURING' : 'CONSENT_EXPIRED_DURING';
      }
    }
    return {
      memberId, participantIds: [...ids], code: member.code, role: member.role, roomRoles: [...new Set(mine.map(row => row.role))],
      englishName: member.englishName, basis: facts.length ? 'presence' : 'seat', covered, coveredFrom, coveredTo,
      joins: own.filter(event => IN.has(event.type)).map(event => event.occurredAt),
      leaves: own.filter(event => OUT.has(event.type)).map(event => event.occurredAt),
      seatChanges: seatChanges.filter(event => event.memberId === memberId).map(event => ({ at: event.occurredAt, seat: event.seat ?? null, from: event.from ?? null, to: event.to ?? null })),
      evidence, problem,
    };
  });
  const byName = (a, b) => a.englishName.localeCompare(b.englishName) || a.code.localeCompare(b.code);
  const students = people.filter(entry => entry.covered && entry.role === 'student').sort(byName);
  const tutors = people.filter(entry => entry.covered && (entry.role === 'lead_tutor' || entry.role === 'co_tutor'))
    .sort((a, b) => TUTOR_ORDER[a.role] - TUTOR_ORDER[b.role] || byName(a, b));
  const problems = people.filter(entry => entry.covered && entry.problem).map(entry => ({ code: entry.problem, member: entry.code }));
  const decided = decision ? { key: decision.key ?? null, eligible: decision.eligible === true, reason: decision.reason ?? null, at: decision.occurredAt ?? null, beforeStart: decision.beforeStart === true } : null;
  if (!decided?.eligible) problems.unshift({ code: decided ? 'DECISION_NOT_ELIGIBLE' : 'NO_DECISION', member: null });
  return {
    blockId: block?.id ?? null, blockCode: block?.code ?? null, lessonId: lesson.id, roomLabel: lesson.roomLabel ?? null,
    providerSessionId: record.providerSessionId ?? null, generation, recordingId: record.providerFileId,
    recordingStart: Number.isFinite(start) ? start : null, recordingEnd: Number.isFinite(end) ? end : null,
    date: newYorkDate(lesson.startsAt),
    people,
    names: { students: students.map(entry => entry.englishName), tutors: tutors.map(entry => entry.englishName) },
    // Seat changes in the block while it recorded (who moved, into or out of which room).
    rosterChanges: seatChanges.map(event => ({ at: event.occurredAt, member: event.code ?? null, seat: event.seat ?? null, from: event.from ?? null, to: event.to ?? null })),
    decision: decided,
    stoppedAt: withdrawnAt,
    hold: record.hold ?? null,
    filing: { eligible: problems.length === 0, problems, policy: policy ? { consentVersion: policy.consentVersion, staffNoticeVersion: policy.staffNoticeVersion } : null },
  };
}
