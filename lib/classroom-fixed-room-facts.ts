import type { ClassroomEvent, ClassroomLesson } from "./classroom-store";

// Classroom 3.0 round 3 (2026-11-21): what marks a lesson as a fixed room's lesson, read from the
// server's own record of it (the scheduling fact), never from its code or anything a page sends.
// Kept apart from lib/classroom-fixed-rooms.ts so the classroom service can read it without an
// import cycle.
export function fixedRoomOf(events: readonly ClassroomEvent[]): string | null {
  const scheduled = events.find((event) => event.source === "server" && event.type === "server.lesson_scheduled" && typeof event.fixedRoomId === "string");
  return scheduled ? String(scheduled.fixedRoomId) : null;
}

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
