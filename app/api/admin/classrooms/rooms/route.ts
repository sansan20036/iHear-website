import { NextResponse } from "next/server";

import { authorizeAdminRequest } from "../../../../../lib/admin-auth";
import { appendAdminActivity } from "../../../../../lib/admin-store";
import { classroomDrive } from "../../../../../lib/classroom-drive";
import { FIXED_ROOM_BULK_ACTIONS, fixedRoomsEnabled, fixedRoomsView, manageFixedRoom, manageFixedRoomsBulk } from "../../../../../lib/classroom-fixed-rooms";
import { classroomProvider } from "../../../../../lib/classroom-provider";
import { classroomStore } from "../../../../../lib/classroom-store";
import { withRateLimitHeaders } from "../../../../../lib/rate-limit";
import { NO_STORE_HEADERS } from "../../../../../lib/response-headers";

export const dynamic = "force-dynamic";

const notFound = () => NextResponse.json({ error: "Not found" }, { status: 404, headers: NO_STORE_HEADERS });

// Classroom 3.0 round 3 (2026-11-21): the fixed rooms, for owners (the iHear teacher): each room, its
// lesson now, who waits and who was let in. Names only; never a link's key or a person's ticket.
export async function GET(request: Request) {
  if (!fixedRoomsEnabled()) return notFound();
  const access = await authorizeAdminRequest(request, { owner: true });
  if ("response" in access) return access.response;
  try {
    return NextResponse.json({ ok: true, rooms: await fixedRoomsView({ store: classroomStore(), now: Date.now() }) }, { headers: NO_STORE_HEADERS });
  } catch {
    return NextResponse.json({ error: "The rooms are temporarily unavailable" }, { status: 503, headers: NO_STORE_HEADERS });
  }
}

// One change by an owner: make a room, replace its link (each link is in that answer only), let a
// waiting person in or not, take a person out, end the room's lesson. Checked again on the server.
// Many rooms at once (make them, give every link once more, every recording switch) go the same way:
// the links are in the answer only, never in the activity record, which keeps the names of the
// fields that were sent and nothing of the answer.
export async function POST(request: Request) {
  if (!fixedRoomsEnabled()) return notFound();
  const access = await authorizeAdminRequest(request, { owner: true, mutation: true });
  if ("response" in access) return access.response;
  const respond = (body: unknown, status: number) => withRateLimitHeaders(NextResponse.json(body, { status, headers: NO_STORE_HEADERS }), access.decision!);
  let provider;
  try {
    provider = classroomProvider();
  } catch {
    return respond({ error: "The classroom is not available yet", code: "PROVIDER_UNAVAILABLE" }, 503);
  }
  try {
    const body = await request.json().catch(() => ({}));
    const { action, ...input } = (body ?? {}) as Record<string, unknown>;
    const principal = { email: access.principal.email, owner: true };
    const result = (FIXED_ROOM_BULK_ACTIONS as readonly string[]).includes(String(action))
      ? await manageFixedRoomsBulk({ store: classroomStore(), principal, action, input, now: Date.now() })
      : await manageFixedRoom({ store: classroomStore(), provider, drive: classroomDrive(), principal, action, input, now: Date.now() });
    if (result.status === 200 || result.status === 201) {
      await appendAdminActivity({
        actorEmail: access.principal.email, actorRole: access.principal.role, action: `classroom.fixed_room_${String(action)}`, entityType: "classroom",
        entityId: String((result.body as { room?: { id?: string } }).room?.id ?? input.room ?? ""), changedFields: Object.keys(input), entityStatus: "updated", entityVersion: null,
      });
    }
    return respond(result.body, result.status);
  } catch {
    return respond({ error: "The rooms are temporarily unavailable" }, 503);
  }
}
