import { NextResponse } from "next/server";

// @ts-ignore - auth.js is the existing Auth.js configuration.
import { auth } from "../../../../../auth.js";
import { isSameOrigin } from "../../../../../lib/admin-auth";
import { normalizeEmail } from "../../../../../lib/admins";
import { classroomProvider } from "../../../../../lib/classroom-provider";
import { joinClassroom } from "../../../../../lib/classroom-service";
import { classroomStore } from "../../../../../lib/classroom-store";
import { lessonDoorLimit } from "../../../../../lib/classroom-rate-limit";
import { RATE_LIMIT_POLICIES, withRateLimitHeaders } from "../../../../../lib/rate-limit";
import { NO_STORE_HEADERS } from "../../../../../lib/response-headers";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ lessonId: string }> };

// Entering a classroom: a student with a personal link, or the lesson's tutor signed in. The
// check is about identity, the roster and the time window only; recording consent never decides
// who may attend.
export async function POST(request: Request, context: Context) {
  if (!isSameOrigin(request)) return NextResponse.json({ error: "Cross-origin request blocked" }, { status: 403, headers: NO_STORE_HEADERS });
  const { lessonId } = await context.params;
  const body = await request.json().catch(() => ({}));
  const key = typeof body?.key === "string" ? body.key.slice(0, 200) : null;
  const session = await auth();
  const sessionEmail = normalizeEmail(session?.user?.email) || null;
  // A one-to-one lesson: ten a minute per address (the auth allowance, as before). A block's Lobby
  // or room (P3-Multi): ten a minute per person and 200 for everyone behind one address, so a class
  // entering together is never refused.
  const decision = await lessonDoorLimit(request, { scope: "classroom-join", lessonId, person: key ?? sessionEmail, single: RATE_LIMIT_POLICIES.auth.limit, perPerson: RATE_LIMIT_POLICIES.auth.limit, perPlace: 200 });
  if (decision.limited) return decision.response;
  const respond = (result: unknown, status: number) => withRateLimitHeaders(NextResponse.json(result, { status, headers: NO_STORE_HEADERS }), decision);
  let provider;
  try {
    provider = classroomProvider();
  } catch {
    return respond({ error: "The classroom is not available yet", code: "PROVIDER_UNAVAILABLE" }, 503);
  }
  try {
    const result = await joinClassroom({ store: classroomStore(), provider, lessonId, key, sessionEmail, now: Date.now() });
    return respond(result.body, result.status);
  } catch {
    return respond({ error: "The classroom is temporarily unavailable" }, 503);
  }
}
