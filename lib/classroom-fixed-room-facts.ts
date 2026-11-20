import type { ClassroomEvent } from "./classroom-store";

// Classroom 3.0 round 3 (2026-11-21): what marks a lesson as a fixed room's lesson, read from the
// server's own record of it (the scheduling fact), never from its code or anything a page sends.
// Kept apart from lib/classroom-fixed-rooms.ts so the classroom service can read it without an
// import cycle.
export function fixedRoomOf(events: readonly ClassroomEvent[]): string | null {
  const scheduled = events.find((event) => event.source === "server" && event.type === "server.lesson_scheduled" && typeof event.fixedRoomId === "string");
  return scheduled ? String(scheduled.fixedRoomId) : null;
}
