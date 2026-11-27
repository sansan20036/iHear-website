import { NextResponse } from "next/server";

import { isSameOrigin } from "../../../../../../../lib/admin-auth";
import { fixedRoomsEnabled, roomDoorInfo } from "../../../../../../../lib/classroom-fixed-rooms";
import { classroomStore } from "../../../../../../../lib/classroom-store";
import { clientIp, enforceRateLimit, withRateLimitHeaders } from "../../../../../../../lib/rate-limit";
import { NO_STORE_HEADERS } from "../../../../../../../lib/response-headers";

export const dynamic = "force-dynamic";

// Round 18l (the user, 2026-11-28: the entry page as the concept image): what a fixed room's door shows
// before a name is typed, the room's name and whether its lessons are recorded, to someone holding the
// room's current link (the key from behind #, sent in the body; lib/classroom-fixed-rooms.ts
// roomDoorInfo). Same origin only; limited per address, as the door itself. 404 while switched off.
export async function POST(request: Request, context: { params: Promise<{ roomId: string }> }) {
  if (!fixedRoomsEnabled()) return NextResponse.json({ error: "Not found" }, { status: 404, headers: NO_STORE_HEADERS });
  if (!isSameOrigin(request)) return NextResponse.json({ error: "Cross-origin request blocked" }, { status: 403, headers: NO_STORE_HEADERS });
  const decision = await enforceRateLimit(request, { scope: "classroom-room-door-info", limit: 40, windowSeconds: 60, identifier: clientIp(request) });
  if (decision.limited) return decision.response;
  const { roomId } = await context.params;
  const body = await request.json().catch(() => ({}));
  try {
    const result = await roomDoorInfo({ store: classroomStore(), roomId, key: typeof body?.key === "string" ? body.key.slice(0, 200) : null });
    return withRateLimitHeaders(NextResponse.json(result.body, { status: result.status, headers: NO_STORE_HEADERS }), decision);
  } catch {
    return withRateLimitHeaders(NextResponse.json({ error: "The classroom is temporarily unavailable" }, { status: 503, headers: NO_STORE_HEADERS }), decision);
  }
}
