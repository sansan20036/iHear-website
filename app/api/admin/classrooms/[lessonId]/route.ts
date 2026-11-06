import { NextResponse } from "next/server";

import { authorizeAdminRequest } from "../../../../../lib/admin-auth";
import { appendAdminActivity } from "../../../../../lib/admin-store";
import { changeLessonAccess } from "../../../../../lib/classroom-service";
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
export async function PATCH(request: Request, context: Context) {
  const access = await authorizeAdminRequest(request, { owner: true, mutation: true });
  if ("response" in access) return access.response;
  const respond = (body: unknown, status: number) => withRateLimitHeaders(NextResponse.json(body, { status, headers: NO_STORE_HEADERS }), access.decision!);
  const { lessonId } = await context.params;
  try {
    const input = await request.json().catch(() => ({}));
    const result = await changeLessonAccess({ store: classroomStore(), lessonId, action: input?.action, studentCode: input?.studentCode });
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
