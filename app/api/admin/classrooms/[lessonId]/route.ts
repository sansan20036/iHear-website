import { NextResponse } from "next/server";

import { authorizeAdminRequest } from "../../../../../lib/admin-auth";
import { appendAdminActivity } from "../../../../../lib/admin-store";
import { classroomDrive } from "../../../../../lib/classroom-drive";
import { classroomProvider } from "../../../../../lib/classroom-provider";
import { changeLessonAccess, stopRecordingForCancelledLesson } from "../../../../../lib/classroom-service";
import { classroomStore } from "../../../../../lib/classroom-store";
import { withRateLimitHeaders } from "../../../../../lib/rate-limit";
import { NO_STORE_HEADERS } from "../../../../../lib/response-headers";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ lessonId: string }> };

const ACTIVITY: Record<string, { action: string; status: string; fields: string[] }> = {
  cancel: { action: "classroom.lesson_cancelled", status: "cancelled", fields: ["cancelled"] },
  revoke_link: { action: "classroom.student_link_revoked", status: "link-revoked", fields: ["studentLink"] },
  reissue_link: { action: "classroom.student_link_reissued", status: "link-reissued", fields: ["studentLink"] },
};

// Cancel a lesson, or revoke or reissue its student's personal link: owners only, from this site,
// rate limited, recorded in the activity log (codes only, never a key or its hash). A reissued
// link is in this answer only.
//
// A cancel then stops recording and ends the lesson's live sessions on the server (D-2): the
// cancellation is stored and the lesson's tick runs at once. If that part cannot run now (the
// provider is not configured, or it fails), the cancel still stands and the scheduled tick does
// it from the lesson's cancelled flag; the answer is the same either way.
export async function PATCH(request: Request, context: Context) {
  const access = await authorizeAdminRequest(request, { owner: true, mutation: true });
  if ("response" in access) return access.response;
  const respond = (body: unknown, status: number) => withRateLimitHeaders(NextResponse.json(body, { status, headers: NO_STORE_HEADERS }), access.decision!);
  const { lessonId } = await context.params;
  try {
    const input = await request.json().catch(() => ({}));
    const now = Date.now();
    const result = await changeLessonAccess({ store: classroomStore(), lessonId, action: input?.action, studentCode: input?.studentCode, now });
    if (input?.action === "cancel" && result.status === 200) {
      try {
        await stopRecordingForCancelledLesson({ store: classroomStore(), provider: classroomProvider(), drive: classroomDrive(), lessonId, now });
      } catch {
        // Left to the scheduled tick (see above).
      }
    }
    const logged = ACTIVITY[String(input?.action)];
    if (result.status === 200 && logged && (result.body as { changed?: boolean }).changed !== false) {
      await appendAdminActivity({
        actorEmail: access.principal.email, actorRole: access.principal.role,
        action: logged.action, entityType: "classroom", entityId: lessonId,
        changedFields: logged.fields, entityStatus: logged.status, entityVersion: null,
      });
    }
    return respond(result.body, result.status);
  } catch {
    return respond({ error: "The change did not finish; it is safe to retry" }, 503);
  }
}
