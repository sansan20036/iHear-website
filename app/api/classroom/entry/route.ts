import { NextResponse } from "next/server";

// @ts-ignore - auth.js is the existing Auth.js configuration.
import { auth } from "../../../../auth.js";
import { normalizeEmail } from "../../../../lib/admins";
import { CLASSROOM_ENTRY_RELEASED, classroomEntryAccess } from "../../../../lib/classroom-entry";
import { classroomProvider } from "../../../../lib/classroom-provider";
import { myClassroomLessons } from "../../../../lib/classroom-service";
import { classroomStore } from "../../../../lib/classroom-store";
import { clientIp, enforceRateLimit, RATE_LIMIT_POLICIES, withRateLimitHeaders } from "../../../../lib/rate-limit";
import { NO_STORE_HEADERS } from "../../../../lib/response-headers";

export const dynamic = "force-dynamic";

// Whether the online classroom is open to everyone yet, and if not, whether this person may
// preview its entries (D2, 2026-11-07). Only the server decides: an administrator, or the tutor
// of a lesson in the coming two weeks while the classroom is available. The answer is three
// yes-or-no values and nothing about the person or their lessons.
export async function GET(request: Request) {
  const decision = await enforceRateLimit(request, { ...RATE_LIMIT_POLICIES.auth, scope: "classroom-entry", identifier: clientIp(request) });
  if (decision.limited) return decision.response;
  const session = await auth();
  const email = normalizeEmail(session?.user?.email) || null;
  // auth.js's session callback marks administrators (isAdmin); Auth.js's own types do not name it.
  const isAdmin = (session?.user as { isAdmin?: unknown } | undefined)?.isAdmin === true;
  const access = await classroomEntryAccess({
    released: CLASSROOM_ENTRY_RELEASED,
    email,
    isAdmin,
    isTutor: async tutorEmail => {
      // Throws while the classroom is closed: then no tutor previews it.
      classroomProvider();
      return (await myClassroomLessons({ store: classroomStore(), email: tutorEmail, now: Date.now() })).length > 0;
    },
  });
  return withRateLimitHeaders(NextResponse.json(access, { status: 200, headers: NO_STORE_HEADERS }), decision);
}
