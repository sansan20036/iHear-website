import { NextResponse } from "next/server";

// @ts-ignore - auth.js is the existing Auth.js configuration.
import { auth } from "../../../../../auth.js";
import { isSameOrigin } from "../../../../../lib/admin-auth";
import { normalizeEmail } from "../../../../../lib/admins";
import { classroomProvider } from "../../../../../lib/classroom-provider";
import { joinClassroom } from "../../../../../lib/classroom-service";
import { classroomStore } from "../../../../../lib/classroom-store";
import { clientIp, enforceRateLimit, RATE_LIMIT_POLICIES, withRateLimitHeaders } from "../../../../../lib/rate-limit";
import { NO_STORE_HEADERS } from "../../../../../lib/response-headers";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ lessonId: string }> };

// Entering a classroom: a student with a personal link, or the lesson's tutor signed in. The
// check is about identity, the roster and the time window only; recording consent never decides
// who may attend.
export async function POST(request: Request, context: Context) {
  if (!isSameOrigin(request)) return NextResponse.json({ error: "Cross-origin request blocked" }, { status: 403, headers: NO_STORE_HEADERS });
  const { lessonId } = await context.params;
  const decision = await enforceRateLimit(request, { ...RATE_LIMIT_POLICIES.auth, scope: "classroom-join", identifier: `${clientIp(request)}:${lessonId}` });
  if (decision.limited) return decision.response;
  const respond = (body: unknown, status: number) => withRateLimitHeaders(NextResponse.json(body, { status, headers: NO_STORE_HEADERS }), decision);
  let provider;
  try {
    provider = classroomProvider();
  } catch {
    return respond({ error: "The classroom is not available yet", code: "PROVIDER_UNAVAILABLE" }, 503);
  }
  try {
    const body = await request.json().catch(() => ({}));
    const session = await auth();
    const result = await joinClassroom({
      store: classroomStore(),
      provider,
      lessonId,
      key: typeof body?.key === "string" ? body.key.slice(0, 200) : null,
      sessionEmail: normalizeEmail(session?.user?.email) || null,
      now: Date.now(),
    });
    return respond(result.body, result.status);
  } catch {
    return respond({ error: "The classroom is temporarily unavailable" }, 503);
  }
}
