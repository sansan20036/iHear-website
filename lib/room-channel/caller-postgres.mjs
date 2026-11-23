// Who is asking the room channel, answered by ONE read-only statement (a study for the user's
// decision of 2026-11-24 on the cost of checking a person on every request; not used by the route
// unless ROOM_CHANNEL_CALLER=sql is set, which no environment sets).
//
// The rule is caller.ts's, unchanged: on EVERY request the person's own ticket must be on the
// lesson's list now, so a person taken out is refused on the very next request. Only the way of
// asking differs: caller.ts reads the lesson, its list and all its events through the classroom
// store (three statements, and the events grow with the lesson); this asks the three tables once,
// for exactly what the rule needs. tests/room-channel/postgres.test.mjs holds the two equal.
//
// It reads classroom_lessons, classroom_participants and classroom_events by their columns as
// migrations 028 to 030 define them, and writes nothing. If it is adopted, it belongs in the
// classroom store as a read function (its owner's word, 2026-11-24); here it is kept beside the
// room channel only for the comparison.
import { JOIN_WINDOW_BEFORE_MS } from '../../tools/recording-pathway/classroom/eligibility.mjs';
import { lessonEnd } from './retention.mjs';
import { newsFragments, newsFrom } from './store-postgres.mjs';

const refuse = (status, code) => ({ ok: false, status, code });

// The lesson's facts as the rule needs them, as one value (NULL when there is no such lesson).
const lessonFacts = (sql, lessonId, keyHash) => sql`(
  SELECT jsonb_build_object(
    'cancelled', l.cancelled,
    'block', l.block_id IS NOT NULL,
    'startsAt', round(extract(epoch FROM l.starts_at) * 1000),
    'endsAt', round(extract(epoch FROM l.ends_at) * 1000),
    'roomId', room.id,
    'me', (SELECT jsonb_build_object('id', p.participant_id, 'code', p.code) FROM public.classroom_participants p
           WHERE p.lesson_id = l.id AND p.role = 'student' AND p.active AND p.join_key_hash = ${keyHash} LIMIT 1),
    'students', (SELECT coalesce(jsonb_agg(p.participant_id), '[]'::jsonb) FROM public.classroom_participants p
                 WHERE p.lesson_id = l.id AND p.role = 'student' AND p.active),
    'leftBehind', (SELECT coalesce(jsonb_agg(e.data->>'to'), '[]'::jsonb) FROM public.classroom_events e
                   WHERE e.lesson_id = l.id AND e.type = 'server.participant_rotated' AND e.source = 'server' AND e.data->>'reason' = 'revoke_link'),
    'aliases', (SELECT coalesce(jsonb_agg(jsonb_build_object('code', e.data->'participantCode', 'alias', e.data->'alias', 'at', e.data->'occurredAt', 'key', e.key)), '[]'::jsonb) FROM public.classroom_events e
                WHERE e.lesson_id = l.id AND e.type = 'server.participant_alias' AND e.source = 'server'),
    'recordedEnd', CASE WHEN l.cancelled AND room.id IS NOT NULL THEN (
        SELECT e.data->'occurredAt' FROM public.classroom_events e
        WHERE e.lesson_id = room.id AND e.type = 'server.room_lesson_ended' AND e.source = 'server' AND e.data->>'classLessonId' = l.id LIMIT 1) END)
  FROM public.classroom_lessons l
  LEFT JOIN LATERAL (
    SELECT e.data->>'fixedRoomId' AS id FROM public.classroom_events e
    WHERE e.lesson_id = l.id AND e.type = 'server.lesson_scheduled' AND e.source = 'server' AND jsonb_typeof(e.data->'fixedRoomId') = 'string' LIMIT 1) room ON TRUE
  WHERE l.id = ${lessonId})`;

// The same decision as caller.ts makes, from the facts above.
function decide(facts, lessonId, now) {
  // Not a fixed room's lesson, or no such lesson: the same answer, so nothing is told about either.
  if (!facts || facts.block || !facts.roomId) return refuse(404, 'NOT_FOUND');
  if (!facts.me) return refuse(403, 'NOT_IN_ROOM');
  const scheduledEnd = Number(facts.endsAt);
  const recordedEnd = facts.cancelled ? (typeof facts.recordedEnd === 'number' ? Math.min(facts.recordedEnd, now) : now) : null;
  const endedAt = lessonEnd({ recordedEnd, scheduledEnd, now });
  // While the lesson is open the door's own time rule holds (the list and the ticket were asked above).
  if (endedAt === null && !(now >= Number(facts.startsAt) - JOIN_WINDOW_BEFORE_MS)) return refuse(403, 'OUTSIDE_JOIN_WINDOW');
  const gone = new Set(facts.leftBehind);
  const people = facts.students.filter(id => !gone.has(id));
  // The name the room shows for this person: the latest given for their code in this lesson, else the code.
  const given = facts.aliases.filter(entry => entry.code === facts.me.code && typeof entry.alias === 'string')
    .sort((a, b) => a.at - b.at || String(a.key).localeCompare(String(b.key))).at(-1);
  return { ok: true, who: { id: facts.me.id, name: given ? String(given.alias) : facts.me.code, member: true }, lesson: { id: lessonId, roomId: facts.roomId, scheduledEnd, endedAt, people } };
}

export function createPostgresCaller(sql) {
  const calls = { statements: 0 };
  // Who is asking: one statement.
  async function who({ lessonId, keyHash, now }) {
    calls.statements += 1;
    const [found] = await sql`SELECT ${lessonFacts(sql, lessonId, keyHash ?? '')} AS facts`;
    return decide(found.facts, lessonId, now);
  }
  // Who is asking and what is new for them, in the same statement (a request that sends nothing).
  // What is new is handed over only to a person the rule lets in.
  async function look({ lessonId, keyHash, cursors, now }) {
    calls.statements += 1;
    const { board, chat, turn } = newsFragments(sql, lessonId, cursors);
    const [found] = await sql`SELECT ${lessonFacts(sql, lessonId, keyHash ?? '')} AS facts, ${board} AS board, ${chat} AS chat, ${turn} AS turn`;
    const caller = decide(found.facts, lessonId, now);
    return { caller, seen: caller.ok ? newsFrom(found, cursors) : null };
  }
  return { who, look, calls };
}
