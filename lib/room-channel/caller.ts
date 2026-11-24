// Who is asking the room channel, and what its lesson's facts are (local integration only,
// 2026-11-23). Nothing here comes from the request body except the person's own key.
//
// The channel is offered in a fixed room's lesson only: never in a block, never in a one-to-one
// lesson. A person is the student whose personal key (the ticket their page got at the room's
// door) is on the lesson's list now. Taking a person out gives their place a new key that nobody
// holds (lib/classroom-service.ts: changeLessonAccess), so their old key stops matching here on
// the very next request.
//
// While the lesson is open, this answers as entering the classroom does (the same roster,
// identity and time-window rule: getJoinEligibility). After the lesson's end a person of that
// lesson may still read its whiteboard until it is deleted; the service refuses every write then.
//
// This is a copy of the classroom service's own check (admittedToLesson, which is not exported),
// kept equal to it by tests/room-channel-caller.test.mjs. It gives way to an exported function of
// the service when there is one.
import { hashKey } from "../classroom-block-rules";
import { displayNameOf, fixedRoomOf, shownCodeOf } from "../classroom-fixed-room-facts";
import { forRules } from "../classroom-service";
import type { ClassroomEvent, ClassroomLesson, ClassroomStore } from "../classroom-store";
// @ts-ignore - shared classroom logic, plain JavaScript tested with node --test.
import { getJoinEligibility } from "../../tools/recording-pathway/classroom/eligibility.mjs";
// @ts-ignore - the room channel's own rules, plain JavaScript tested with node --test.
import { lessonEnd } from "./retention.mjs";

export type RoomChannelCaller =
  | { ok: false; status: number; code: string }
  | { ok: true; who: { id: string; name: string; member: true }; lesson: RoomChannelLesson };
export type RoomChannelLesson = { id: string; roomId: string; scheduledEnd: number; endedAt: number | null; people: string[] };

const refuse = (status: number, code: string) => ({ ok: false as const, status, code });

// The places a removal left behind: a student taken out keeps a row on the list (with a key nobody
// holds), which is not a person in the lesson.
function leftBehind(events: readonly ClassroomEvent[]) {
  return new Set(events.filter((event) => event.source === "server" && event.type === "server.participant_rotated" && event.reason === "revoke_link").map((event) => String(event.to)));
}

// The lesson's end as the server recorded it, for a lesson ended before its planned end: the iHear
// teacher's "end lesson" is written under the room (server.room_lesson_ended). A lesson cancelled
// in another way has no moment on record: it counts as ended now.
async function recordedEnd(store: ClassroomStore, lesson: ClassroomLesson, roomId: string, now: number): Promise<number | null> {
  if (!lesson.cancelled) return null;
  const ended = (await store.eventsFor([roomId])).find((event) => event.source === "server" && event.type === "server.room_lesson_ended" && String(event.classLessonId) === lesson.id);
  return ended ? Math.min(ended.occurredAt, now) : now;
}

// The facts of a fixed room's lesson, or null when the lesson is not one (or does not exist).
export async function roomChannelLesson(store: ClassroomStore, lessonId: string, now: number): Promise<{ lesson: ClassroomLesson; events: ClassroomEvent[]; facts: RoomChannelLesson } | null> {
  const lesson = await store.lesson(lessonId);
  if (!lesson || lesson.blockId) return null;
  const events = await store.eventsFor([lesson.id]);
  const roomId = fixedRoomOf(events);
  if (!roomId) return null;
  const scheduledEnd = Date.parse(lesson.endsAt);
  const gone = leftBehind(events);
  // People are known to the channel by their place on the lesson's list (the participant id): it
  // is what Zoom carries for them too (the session token's user_key), so a page can tell whose
  // share stream belongs to the holder of the turn whatever name Zoom shows for them.
  const people = lesson.participants.filter((entry) => entry.role === "student" && entry.active !== false && !gone.has(entry.id)).map((entry) => entry.id);
  const endedAt = lessonEnd({ recordedEnd: await recordedEnd(store, lesson, roomId, now), scheduledEnd, now }) as number | null;
  return { lesson, events, facts: { id: lesson.id, roomId, scheduledEnd, endedAt, people } };
}

export async function roomChannelCaller({ store, lessonId, key, now }: { store: ClassroomStore; lessonId: string; key: string | null; now: number }): Promise<RoomChannelCaller> {
  const found = await roomChannelLesson(store, lessonId, now);
  // Not a fixed room's lesson, or no such lesson: the same answer, so nothing is told about either.
  if (!found) return refuse(404, "NOT_FOUND");
  const { lesson, events, facts } = found;
  const keyHash = key ? hashKey(key) : null;
  const participant = keyHash ? lesson.participants.find((entry) => entry.role === "student" && entry.active !== false && entry.joinKeyHash === keyHash) : undefined;
  if (!participant) return refuse(403, "NOT_IN_ROOM");
  if (facts.endedAt === null) {
    const decision = getJoinEligibility({ lesson: forRules(lesson, events), participantId: participant.id, identity: { verified: true, participantId: participant.id, method: "join_link" }, now });
    if (!decision.allowed) return refuse(403, String(decision.reason));
  }
  // name: what the room shows beside this person's messages: the name the server recorded when they
  // were let in, as Zoom shows it (the user's decisions of 2026-11-24: typed names, Chinese or
  // English, checked again when read); none recorded, the code the room shows for them.
  // (The integrator's line, round 16, with f1's leave.)
  return { ok: true, who: { id: participant.id, name: displayNameOf(events, participant.code) ?? shownCodeOf(events, participant.code), member: true }, lesson: facts };
}
