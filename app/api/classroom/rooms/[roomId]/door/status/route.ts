import { NextResponse } from "next/server";

import { isSameOrigin } from "../../../../../../../lib/admin-auth";
import { fixedRoomsEnabled, requestStatus } from "../../../../../../../lib/classroom-fixed-rooms";
import { classroomStore } from "../../../../../../../lib/classroom-store";
import { clientIp, enforceRateLimit, withRateLimitHeaders } from "../../../../../../../lib/rate-limit";
import { NO_STORE_HEADERS } from "../../../../../../../lib/response-headers";

export const dynamic = "force-dynamic";

// Classroom 3.0 round 3: where a person's request to come into a fixed room stands, asked by their
// own page with its ticket (in the body, never in an address). Changes nothing. Same origin only;
// asked every few seconds while waiting, so limited generously per address. 404 while switched off.
export async function POST(request: Request, context: { params: Promise<{ roomId: string }> }) {
  if (!fixedRoomsEnabled()) return NextResponse.json({ error: "Not found" }, { status: 404, headers: NO_STORE_HEADERS });
  if (!isSameOrigin(request)) return NextResponse.json({ error: "Cross-origin request blocked" }, { status: 403, headers: NO_STORE_HEADERS });
  const decision = await enforceRateLimit(request, { scope: "classroom-room-status", limit: 600, windowSeconds: 60, identifier: clientIp(request) });
  if (decision.limited) return decision.response;
  const { roomId } = await context.params;
  const body = await request.json().catch(() => ({}));
  try {
    const result = await requestStatus({
      store: classroomStore(), roomId,
      requestId: typeof body?.requestId === "string" ? body.requestId.slice(0, 64) : null,
      ticket: typeof body?.ticket === "string" ? body.ticket.slice(0, 200) : null,
      now: Date.now(),
    });
    return withRateLimitHeaders(NextResponse.json(result.body, { status: result.status, headers: NO_STORE_HEADERS }), decision);
  } catch {
    return withRateLimitHeaders(NextResponse.json({ error: "The classroom is temporarily unavailable" }, { status: 503, headers: NO_STORE_HEADERS }), decision);
  }
}
