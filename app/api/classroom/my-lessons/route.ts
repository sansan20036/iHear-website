import { NextResponse } from "next/server";

// @ts-ignore - auth.js is the existing Auth.js configuration.
import { auth } from "../../../../auth.js";
import { normalizeEmail } from "../../../../lib/admins";
import { myClassroomBlocks } from "../../../../lib/classroom-blocks";
import { classroomProvider } from "../../../../lib/classroom-provider";
import { myClassroomLessons } from "../../../../lib/classroom-service";
import { classroomStore } from "../../../../lib/classroom-store";
import { clientIp, enforceRateLimit, RATE_LIMIT_POLICIES, withRateLimitHeaders } from "../../../../lib/rate-limit";
import { NO_STORE_HEADERS } from "../../../../lib/response-headers";

export const dynamic = "force-dynamic";

// The signed-in tutor's own lessons, for /classroom. Codes and times only: never a session token,
// a session name, a personal link or anyone's email. Closed while the classroom is.
export async function GET(request: Request) {
  const decision = await enforceRateLimit(request, { ...RATE_LIMIT_POLICIES.auth, scope: "classroom-my-lessons", identifier: clientIp(request) });
  if (decision.limited) return decision.response;
  const respond = (body: unknown, status: number) => withRateLimitHeaders(NextResponse.json(body, { status, headers: NO_STORE_HEADERS }), decision);
  try {
    classroomProvider();
  } catch {
    return respond({ error: "The classroom is not available yet", code: "PROVIDER_UNAVAILABLE" }, 503);
  }
  const session = await auth();
  const email = normalizeEmail(session?.user?.email);
  if (!email) return respond({ error: "Sign in to see your lessons", code: "SIGN_IN_REQUIRED" }, 401);
  try {
    const lessons = await myClassroomLessons({ store: classroomStore(), email, now: Date.now() });
    // P3-Multi: the blocks this staff member is in (codes, times and their role only).
    const blocks = await myClassroomBlocks({ store: classroomStore(), email, now: Date.now() });
    // auth.js's session callback marks administrators (isAdmin); Auth.js's own types do not name it.
    const admin = (session?.user as { isAdmin?: boolean } | undefined)?.isAdmin === true;
    // Named only when there are some, so a one-to-one tutor's answer is exactly as before.
    return respond({ ok: true, admin, lessons, ...(blocks.length ? { blocks } : {}) }, 200);
  } catch {
    return respond({ error: "Your lessons are temporarily unavailable", code: "UNAVAILABLE" }, 503);
  }
}
