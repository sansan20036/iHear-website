import { createHash } from "node:crypto";

import { fixedRoomOf } from "./classroom-fixed-room-facts";
import { classroomStore } from "./classroom-store";
import { clientIp, enforceRateLimit, enforceRateLimits } from "./rate-limit";

// The limit for a lesson's door: a one-to-one lesson keeps its own (one allowance per address and
// lesson, as verified); a block's Lobby or room and a fixed room, which many people share, count per
// person. Round 17 (f1's finding F3, 2026-11-25): a fixed room's lesson carries no blockId (its
// schedule event names the room), so it counted ten joins a minute per address for the whole room.
const FIXED_ROOM_ADDRESS_FACTOR = 6;

export async function lessonDoorLimit(request: Request, { scope, lessonId, person, single, perPerson, perPlace }: {
  scope: string; lessonId: string; person: string | null; single: number; perPerson: number; perPlace: number;
}) {
  const store = classroomStore();
  const lesson = await store.lesson(lessonId).catch(() => null);
  if (lesson?.blockId) return personAndPlaceLimit(request, { scope, place: lessonId, person, perPerson, perPlace });
  // After the review: a fixed room names its lessons ROOM-… (lib/classroom-fixed-rooms.ts), so only those
  // read their events, to tell them from a one-to-one lesson an owner happened to code ROOM-…; events
  // that cannot be read count as the fixed room's (a class behind one address is not refused). A fixed
  // room holds at most ten people: its address allowance is six times the one-to-one one (join 60,
  // preview and status 180 a minute), not a block Lobby's, which bounds what random keys can write.
  if (lesson?.code?.startsWith("ROOM-")) {
    const events = await store.eventsFor([lessonId]).catch(() => null);
    if (events === null || fixedRoomOf(events) !== null) {
      return personAndPlaceLimit(request, { scope, place: lessonId, person, perPerson, perPlace: Math.min(perPlace, single * FIXED_ROOM_ADDRESS_FACTOR) });
    }
  }
  return enforceRateLimit(request, { scope, limit: single, windowSeconds: 60, identifier: `${clientIp(request)}:${lessonId}` });
}

// P3-Multi (2026-11-09): a whole class may reach the site from one network address (a school, a
// family's router), and in a block up to ten people share a room and many more the Lobby. So each
// person gets their own allowance per room (by the personal key or the sign-in, never stored as
// such: a short hash), and the address a larger one shared by everyone behind it.
export async function personAndPlaceLimit(request: Request, { scope, place, person, perPerson, perPlace }: {
  scope: string; place: string; person: string | null; perPerson: number; perPlace: number;
}) {
  const who = createHash("sha256").update(person || "anonymous").digest("hex").slice(0, 16);
  // Both counted in one statement (B4): one database call per request, not two.
  return enforceRateLimits(request, [
    { scope, limit: perPlace, windowSeconds: 60, identifier: `${clientIp(request)}:${place}` },
    { scope: `${scope}-person`, limit: perPerson, windowSeconds: 60, identifier: `${clientIp(request)}:${place}:${who}` },
  ]);
}
