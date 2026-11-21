import { NextResponse } from "next/server";

import { isSameOrigin } from "../../../../../../lib/admin-auth";
import { fixedRoomsEnabled, requestEntry } from "../../../../../../lib/classroom-fixed-rooms";
import { classroomStore } from "../../../../../../lib/classroom-store";
import { clientIp, enforceRateLimit, withRateLimitHeaders } from "../../../../../../lib/rate-limit";
import { NO_STORE_HEADERS } from "../../../../../../lib/response-headers";

export const dynamic = "force-dynamic";

// Classroom 3.0 round 3 (2026-11-21): a person asks to come into a fixed room with its link (the key
// from behind #, sent in the body) and a first name, and waits for the iHear teacher
// (lib/classroom-fixed-rooms.ts). Same origin only; limited per address. 404 while switched off.
export async function POST(request: Request, context: { params: Promise<{ roomId: string }> }) {
  if (!fixedRoomsEnabled()) return NextResponse.json({ error: "Not found" }, { status: 404, headers: NO_STORE_HEADERS });
  if (!isSameOrigin(request)) return NextResponse.json({ error: "Cross-origin request blocked" }, { status: 403, headers: NO_STORE_HEADERS });
  const decision = await enforceRateLimit(request, { scope: "classroom-room-door", limit: 40, windowSeconds: 60, identifier: clientIp(request) });
  if (decision.limited) return decision.response;
  const { roomId } = await context.params;
  const body = await request.json().catch(() => ({}));
  try {
    const result = await requestEntry({
      store: classroomStore(), roomId,
      key: typeof body?.key === "string" ? body.key.slice(0, 200) : null,
      name: typeof body?.name === "string" ? body.name.slice(0, 200) : null,
      // Gate B (round 10): a student's own pass instead of the room's link (answered only while the
      // site may record fixed rooms; otherwise the same as no room).
      pass: typeof body?.pass === "string" ? body.pass.slice(0, 200) : null,
      now: Date.now(),
    });
    return withRateLimitHeaders(NextResponse.json(result.body, { status: result.status, headers: NO_STORE_HEADERS }), decision);
  } catch {
    return withRateLimitHeaders(NextResponse.json({ error: "The classroom is temporarily unavailable" }, { status: 503, headers: NO_STORE_HEADERS }), decision);
  }
}
