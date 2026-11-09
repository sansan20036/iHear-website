import { NextResponse } from "next/server";

// @ts-ignore - auth.js is the existing Auth.js configuration.
import { auth } from "../../../../../auth.js";
import { isSameOrigin } from "../../../../../lib/admin-auth";
import { normalizeEmail } from "../../../../../lib/admins";
import { classroomProvider } from "../../../../../lib/classroom-provider";
import { classroomStatus } from "../../../../../lib/classroom-service";
import { classroomStore } from "../../../../../lib/classroom-store";
import { lessonDoorLimit } from "../../../../../lib/classroom-rate-limit";
import { withRateLimitHeaders } from "../../../../../lib/rate-limit";
import { NO_STORE_HEADERS } from "../../../../../lib/response-headers";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ lessonId: string }> };

// The recording state for the people in the room, read every 15 seconds by both pages: the
// student with the personal link, the tutor signed in. Same identity, roster and time-window
// check as entering; it never stores anything.
export async function POST(request: Request, context: Context) {
  if (!isSameOrigin(request)) return NextResponse.json({ error: "Cross-origin request blocked" }, { status: 403, headers: NO_STORE_HEADERS });
  const { lessonId } = await context.params;
  const body = await request.json().catch(() => ({}));
  const key = typeof body?.key === "string" ? body.key.slice(0, 200) : null;
  const session = await auth();
  const sessionEmail = normalizeEmail(session?.user?.email) || null;
  // A one-to-one lesson: 30 a minute per address (as before). A block's Lobby or room (P3-Multi):
  // 30 a minute per person and 400 for everyone behind one address.
  const decision = await lessonDoorLimit(request, { scope: "classroom-status", lessonId, person: key ?? sessionEmail, single: 30, perPerson: 30, perPlace: 400 });
  if (decision.limited) return decision.response;
  const respond = (result: unknown, status: number) => withRateLimitHeaders(NextResponse.json(result, { status, headers: NO_STORE_HEADERS }), decision);
  try {
    classroomProvider();
  } catch {
    return respond({ error: "The classroom is not available yet", code: "PROVIDER_UNAVAILABLE" }, 503);
  }
  try {
    const result = await classroomStatus({ store: classroomStore(), lessonId, key, sessionEmail, now: Date.now() });
    return respond(result.body, result.status);
  } catch {
    return respond({ error: "The classroom is temporarily unavailable" }, 503);
  }
}
