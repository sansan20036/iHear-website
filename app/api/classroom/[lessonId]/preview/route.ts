import { NextResponse } from "next/server";

// @ts-ignore - auth.js is the existing Auth.js configuration.
import { auth } from "../../../../../auth.js";
import { isSameOrigin } from "../../../../../lib/admin-auth";
import { normalizeEmail } from "../../../../../lib/admins";
import { classroomPreview } from "../../../../../lib/classroom-preview";
import { classroomProvider } from "../../../../../lib/classroom-provider";
import { classroomStore } from "../../../../../lib/classroom-store";
import { lessonDoorLimit } from "../../../../../lib/classroom-rate-limit";
import { withRateLimitHeaders } from "../../../../../lib/rate-limit";
import { NO_STORE_HEADERS } from "../../../../../lib/response-headers";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ lessonId: string }> };

// The pre-class screen (2026-11-13): which lesson this is, when, as whom, and whether its door is
// open, for the student with the personal link or the lesson's tutor signed in. The same identity
// check as entering, without the time window; it only reads: no token, nothing sent to the video
// service, nothing stored. The key comes in the body, never in the address.
export async function POST(request: Request, context: Context) {
  if (!isSameOrigin(request)) return NextResponse.json({ error: "Cross-origin request blocked" }, { status: 403, headers: NO_STORE_HEADERS });
  const { lessonId } = await context.params;
  const body = await request.json().catch(() => ({}));
  const key = typeof body?.key === "string" ? body.key.slice(0, 200) : null;
  const session = await auth();
  const sessionEmail = normalizeEmail(session?.user?.email) || null;
  // As the status check: 30 a minute per address and lesson.
  const decision = await lessonDoorLimit(request, { scope: "classroom-preview", lessonId, person: key ?? sessionEmail, single: 30, perPerson: 30, perPlace: 400 });
  if (decision.limited) return decision.response;
  const respond = (result: unknown, status: number) => withRateLimitHeaders(NextResponse.json(result, { status, headers: NO_STORE_HEADERS }), decision);
  try {
    classroomProvider();
  } catch {
    return respond({ error: "The classroom is not available yet", code: "PROVIDER_UNAVAILABLE" }, 503);
  }
  try {
    const result = await classroomPreview({ store: classroomStore(), lessonId, key, sessionEmail, now: Date.now() });
    return respond(result.body, result.status);
  } catch {
    return respond({ error: "The classroom is temporarily unavailable" }, 503);
  }
}
