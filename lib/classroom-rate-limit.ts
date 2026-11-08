import { createHash } from "node:crypto";

import { classroomStore } from "./classroom-store";
import { clientIp, enforceRateLimit } from "./rate-limit";

// The limit for a lesson's door: a one-to-one lesson keeps its own (one allowance per address and
// lesson, as verified); only a block's Lobby or room, which many people share, counts per person.
export async function lessonDoorLimit(request: Request, { scope, lessonId, person, single, perPerson, perPlace }: {
  scope: string; lessonId: string; person: string | null; single: number; perPerson: number; perPlace: number;
}) {
  const lesson = await classroomStore().lesson(lessonId).catch(() => null);
  if (lesson?.blockId) return personAndPlaceLimit(request, { scope, place: lessonId, person, perPerson, perPlace });
  return enforceRateLimit(request, { scope, limit: single, windowSeconds: 60, identifier: `${clientIp(request)}:${lessonId}` });
}

// P3-Multi (2026-11-09): a whole class may reach the site from one network address (a school, a
// family's router), and in a block up to ten people share a room and many more the Lobby. So each
// person gets their own allowance per room (by the personal key or the sign-in, never stored as
// such: a short hash), and the address a larger one shared by everyone behind it.
export async function personAndPlaceLimit(request: Request, { scope, place, person, perPerson, perPlace }: {
  scope: string; place: string; person: string | null; perPerson: number; perPlace: number;
}) {
  const shared = await enforceRateLimit(request, { scope, limit: perPlace, windowSeconds: 60, identifier: `${clientIp(request)}:${place}` });
  if (shared.limited) return shared;
  const who = createHash("sha256").update(person || "anonymous").digest("hex").slice(0, 16);
  return enforceRateLimit(request, { scope: `${scope}-person`, limit: perPerson, windowSeconds: 60, identifier: `${clientIp(request)}:${place}:${who}` });
}
