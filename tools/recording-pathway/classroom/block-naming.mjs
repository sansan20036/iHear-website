// P3-Multi (2026-11-09, 18.3 and 18.4): how a block room's recordings are named in Drive, and the
// participant snapshot each recording keeps. Plain JavaScript, tested with node --test.
//
// Name (the teacher's format): <students>_<tutors>_<YYYY-MM-DD>.<ext>
//   students, tutors  the English names (as confirmed for the member, never guessed from an e-mail)
//                     of the people the recording actually covers, joined with "+"
//   date              the lesson's scheduled start as a calendar date in America/New_York (EST or
//                     EDT, from the time zone data; never Taipei minus a fixed number of hours),
//                     not the day it was uploaded
// A second recording of the same room and names gets _P02, _P03, ... before the extension.
// A list too long for a file name keeps the first names that fit, then "+N" for the others and a
// fingerprint of the whole list: stable (the same people give the same name) and traceable (the
// snapshot holds every name), so two different groups never share a name by truncation.
import { createHash } from 'node:crypto';
import Core from '../apps-script/Core.js';

const NEW_YORK = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });
export function newYorkDate(at) {
  const parts = Object.fromEntries(NEW_YORK.formatToParts(new Date(at)).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export const NAME_LIMITS = Object.freeze({ students: 100, tutors: 60 });

export function nameList(names, maxLength) {
  const clean = names.map(name => Core.cleanName(name, 40));
  if (!clean.length) return 'Unknown';
  const joined = clean.join('+');
  if (joined.length <= maxLength) return joined;
  const fingerprint = createHash('sha256').update(clean.join('|')).digest('hex').slice(0, 6);
  const kept = [];
  for (const name of clean) {
    const tail = `+${clean.length - kept.length - 1}~${fingerprint}`;
    if ([...kept, name].join('+').length + tail.length > maxLength) break;
    kept.push(name);
  }
  return `${kept.join('+')}+${clean.length - kept.length}~${fingerprint}`;
}

export function blockBaseName({ students, tutors, date }) {
  return `${nameList(students, NAME_LIMITS.students)}_${nameList(tutors, NAME_LIMITS.tutors)}_${Core.lessonDate(date)}`;
}

// The room's folder inside the New York month's folder: the date and the room's lesson code
// (<block code>-<room label>), so a block's rooms never share a folder.
export const blockFolderName = lesson => `${newYorkDate(lesson.startsAt)}_${lesson.code}`;
export const blockFolderPath = lesson => [Core.monthlyFolderName(newYorkDate(lesson.startsAt)), blockFolderName(lesson)];

const IN = new Set(['session.user_joined', 'host.user_added']);
const OUT = new Set(['session.user_left', 'host.user_removed']);
const TUTOR_ORDER = { lead_tutor: 0, co_tutor: 1 };

// Who the recording covers: each of the room's rows (members who were ever seated there) present
// at some moment between the recording's start and end, from the room's join and leave facts.
// Someone with no such fact never came. Only a room with no join or leave fact at all (no
// webhooks, say) is read from the seats held now (basis "seat").
export function recordingSnapshot({ lesson, block, events, record, generation = null, decision = null, withdrawnAt = null }) {
  const start = Number(record.recordingStart ?? record.recordingEnd ?? 0);
  const end = Number(record.recordingEnd ?? start);
  const members = new Map((block?.members ?? []).map(member => [member.id, member]));
  const rows = lesson.participants.filter(entry => entry.memberId && members.has(entry.memberId));
  const facts = events.filter(event => event.lessonId === lesson.id && (IN.has(event.type) || OUT.has(event.type)))
    .sort((a, b) => a.occurredAt - b.occurredAt || String(a.key).localeCompare(String(b.key)));
  const people = rows.map(row => {
    const member = members.get(row.memberId);
    const mine = facts.filter(event => String(event.participantId) === row.id);
    const intervals = [];
    let since = null;
    for (const event of mine) {
      if (IN.has(event.type) && since == null) since = event.occurredAt;
      if (OUT.has(event.type) && since != null) { intervals.push([since, event.occurredAt]); since = null; }
    }
    if (since != null) intervals.push([since, Infinity]);
    const covered = facts.length ? intervals.some(([from, to]) => from <= end && to >= start) : row.active !== false;
    return {
      memberId: member.id, code: member.code, role: member.role, englishName: member.englishName,
      basis: facts.length ? 'presence' : 'seat', covered,
      joins: mine.filter(event => IN.has(event.type)).map(event => event.occurredAt),
      leaves: mine.filter(event => OUT.has(event.type)).map(event => event.occurredAt),
    };
  });
  const byName = (a, b) => a.englishName.localeCompare(b.englishName) || a.code.localeCompare(b.code);
  const students = people.filter(entry => entry.covered && entry.role === 'student').sort(byName);
  const tutors = people.filter(entry => entry.covered && (entry.role === 'lead_tutor' || entry.role === 'co_tutor'))
    .sort((a, b) => TUTOR_ORDER[a.role] - TUTOR_ORDER[b.role] || byName(a, b));
  return {
    blockId: block?.id ?? null, blockCode: block?.code ?? null, lessonId: lesson.id, roomLabel: lesson.roomLabel ?? null,
    providerSessionId: record.providerSessionId ?? null, generation, recordingId: record.providerFileId,
    recordingStart: Number.isFinite(start) ? start : null, recordingEnd: Number.isFinite(end) ? end : null,
    date: newYorkDate(lesson.startsAt),
    people,
    names: { students: students.map(entry => entry.englishName), tutors: tutors.map(entry => entry.englishName) },
    // The decision that covers the recording (made by its start, 10 s tolerance) and anything
    // after it that ends recording (a withdrawal, an emergency stop, a cancellation).
    decision: decision ? { key: decision.key ?? null, eligible: decision.eligible === true, reason: decision.reason ?? null, at: decision.occurredAt ?? null, beforeStart: decision.beforeStart === true } : null,
    stoppedAt: withdrawnAt,
    hold: record.hold ?? null,
  };
}
