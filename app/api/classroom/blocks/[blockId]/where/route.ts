import { NextResponse } from "next/server";

// @ts-ignore - auth.js is the existing Auth.js configuration.
import { auth } from "../../../../../../auth.js";
import { isSameOrigin } from "../../../../../../lib/admin-auth";
import { normalizeEmail } from "../../../../../../lib/admins";
import { blockWhere } from "../../../../../../lib/classroom-blocks";
import { classroomStore } from "../../../../../../lib/classroom-store";
import { personAndPlaceLimit } from "../../../../../../lib/classroom-rate-limit";
import { withRateLimitHeaders } from "../../../../../../lib/rate-limit";
import { NO_STORE_HEADERS } from "../../../../../../lib/response-headers";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ blockId: string }> };

// P3-Multi: where this member of the block belongs now (the Lobby, their room, a visit) and their
// state. Only their own place is ever named. A student by the personal link, staff by sign-in.
export async function POST(request: Request, context: Context) {
  if (!isSameOrigin(request)) return NextResponse.json({ error: "Cross-origin request blocked" }, { status: 403, headers: NO_STORE_HEADERS });
  const { blockId } = await context.params;
  const body = await request.json().catch(() => ({}));
  const session = await auth();
  const key = typeof body?.key === "string" ? body.key.slice(0, 200) : null;
  const sessionEmail = normalizeEmail(session?.user?.email) || null;
  // Each person their own allowance; a larger one for everyone behind one address (a class).
  const decision = await personAndPlaceLimit(request, { scope: "classroom-block-where", place: blockId, person: key ?? sessionEmail, perPerson: 60, perPlace: 1200 });
  if (decision.limited) return decision.response;
  const respond = (result: unknown, status: number) => withRateLimitHeaders(NextResponse.json(result, { status, headers: NO_STORE_HEADERS }), decision);
  try {
    const result = await blockWhere({
      store: classroomStore(), blockId,
      key,
      sessionEmail,
      report: body?.report ?? null, since: body?.since, now: Date.now(),
    });
    return respond(result.body, result.status);
  } catch {
    return respond({ error: "The classroom is temporarily unavailable" }, 503);
  }
}
