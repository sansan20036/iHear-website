import { shownNameIsSafe } from "./classroom-display-names";
import type { ClassroomEvent, ClassroomLesson } from "./classroom-store";

// Classroom 3.0 round 3 (2026-11-21): what marks a lesson as a fixed room's lesson, read from the
// server's own record of it (the scheduling fact), never from its code or anything a page sends.
// Kept apart from lib/classroom-fixed-rooms.ts so the classroom service can read it without an
// import cycle.
export function fixedRoomOf(events: readonly ClassroomEvent[]): string | null {
  const scheduled = events.find((event) => event.source === "server" && event.type === "server.lesson_scheduled" && typeof event.fixedRoomId === "string");
  return scheduled ? String(scheduled.fixedRoomId) : null;
}

// Gate B round 10 (2026-11-22): the name a student let in as themselves shows by in Zoom and on their
// page (one of this lesson only), never their code, which is their consent's. The latest given for
// this code in this lesson; none: the code itself (anyone let in with a code of their own).
export const PARTICIPANT_ALIAS = "server.participant_alias";
export function shownCodeOf(events: readonly ClassroomEvent[], code: string): string {
  const given = events.filter((event) => event.source === "server" && event.type === PARTICIPANT_ALIAS && event.participantCode === code && typeof event.alias === "string")
    .sort((a, b) => a.occurredAt - b.occurredAt || String(a.key).localeCompare(String(b.key))).at(-1);
  return given ? String(given.alias) : code;
}

// The user's decision (2026-11-24): in a fixed room Zoom shows the first name a person typed, as the
// server checked and shows it to the iHear teacher (a second "Kyle" as "Kyle B"), recorded when they
// are let in. Read back only when it is still a safe name (round 16: Chinese or English, the door's
// rule with the mark the server adds, lib/classroom-display-names.ts); otherwise none, and the page
// shows the code as before.
export const PARTICIPANT_DISPLAY_NAME = "server.participant_display_name";
export function displayNameOf(events: readonly ClassroomEvent[], code: string): string | null {
  const given = events.filter((event) => event.source === "server" && event.type === PARTICIPANT_DISPLAY_NAME && event.participantCode === code && typeof event.name === "string")
    .sort((a, b) => a.occurredAt - b.occurredAt || String(a.key).localeCompare(String(b.key))).at(-1);
  const name = given ? String(given.name).trim() : "";
  return shownNameIsSafe(name) ? name : null;
}

// A fixed room's lesson the server ended because its time was over (the user, 2026-11-24: at most 120
// minutes unless extended). Written on the lesson before it is cancelled, so a person's page is told
// "the time is up" rather than "cancelled".
export const LESSON_TIME_UP = "server.lesson_time_up";
export const timeUpOf = (events: readonly ClassroomEvent[]) => events.some((event) => event.source === "server" && event.type === LESSON_TIME_UP);

// The room's own recording switch as the lesson knows it (the iHear teacher's latest choice, written
// to the room's lesson): off unless turned on. The site's switch is checked apart.
// The copy a new lesson starts with (copied: true) gives way to the teacher's own choice made at the
// same moment.
export function roomRecordingOn(events: readonly ClassroomEvent[]) {
  const rank = (event: ClassroomEvent) => (event.copied === true ? 0 : 1);
  const last = events.filter((event) => event.source === "server" && event.type === "server.room_recording")
    .sort((a, b) => a.occurredAt - b.occurredAt || rank(a) - rank(b) || String(a.key).localeCompare(String(b.key))).at(-1);
  return last?.on === true;
}

// How many of the lesson's people are in it now, by Zoom's word (webhooks or the SDK), never a
// page's own word: the two-person condition for recording a fixed room.
const IN = new Set(["session.user_joined", "host.user_added"]);
const OUT = new Set(["session.user_left", "host.user_removed"]);
export function peoplePresent(lesson: Pick<ClassroomLesson, "id" | "participants">, events: readonly ClassroomEvent[]) {
  let count = 0;
  for (const person of lesson.participants.filter((entry) => entry.role === "student" && entry.active !== false)) {
    const last = events
      .filter((event) => event.lessonId === lesson.id && String(event.participantId) === person.id && (IN.has(String(event.type)) || OUT.has(String(event.type))))
      .sort((a, b) => a.occurredAt - b.occurredAt).at(-1);
    if (last && IN.has(String(last.type))) count += 1;
  }
  return count;
}
