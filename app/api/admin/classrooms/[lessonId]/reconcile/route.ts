import { NextResponse } from "next/server";

import { authorizeAdminRequest } from "../../../../../../lib/admin-auth";
import { appendAdminActivity } from "../../../../../../lib/admin-store";
import { classroomDrive } from "../../../../../../lib/classroom-drive";
import { classroomProvider } from "../../../../../../lib/classroom-provider";
import { reconcileLessonNow } from "../../../../../../lib/classroom-service";
import { classroomStore } from "../../../../../../lib/classroom-store";
import { withRateLimitHeaders } from "../../../../../../lib/rate-limit";
import { NO_STORE_HEADERS } from "../../../../../../lib/response-headers";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ lessonId: string }> };

// "Check now" for one lesson: owners only, rate limited, recorded in the activity log.
export async function POST(request: Request, context: Context) {
  const access = await authorizeAdminRequest(request, { owner: true, mutation: true });
  if ("response" in access) return access.response;
  const respond = (body: unknown, status: number) => withRateLimitHeaders(NextResponse.json(body, { status, headers: NO_STORE_HEADERS }), access.decision!);
  const { lessonId } = await context.params;
  let provider;
  let drive;
  try {
    provider = classroomProvider();
    drive = classroomDrive();
  } catch {
    return respond({ error: "The classroom is not available yet", code: "PROVIDER_UNAVAILABLE" }, 503);
  }
  try {
    const result = await reconcileLessonNow({ store: classroomStore(), provider, drive, lessonId, now: Date.now() });
    if (result.status === 200) {
      await appendAdminActivity({
        actorEmail: access.principal.email, actorRole: access.principal.role,
        action: "classroom.reconciled", entityType: "classroom", entityId: lessonId,
        changedFields: [], entityStatus: "reconciled" in result.body && result.body.reconciled ? "reconciled" : "not-reachable", entityVersion: null,
      });
    }
    return respond(result.body, result.status);
  } catch {
    return respond({ error: "The check did not finish; it is safe to retry" }, 503);
  }
}
