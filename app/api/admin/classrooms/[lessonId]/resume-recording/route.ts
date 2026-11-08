import { NextResponse } from "next/server";

import { authorizeAdminRequest } from "../../../../../../lib/admin-auth";
import { appendAdminActivity } from "../../../../../../lib/admin-store";
import { classroomDrive } from "../../../../../../lib/classroom-drive";
import { classroomProvider } from "../../../../../../lib/classroom-provider";
import { authorizeRecordingResume } from "../../../../../../lib/classroom-service";
import { classroomStore } from "../../../../../../lib/classroom-store";
import { withRateLimitHeaders } from "../../../../../../lib/rate-limit";
import { NO_STORE_HEADERS } from "../../../../../../lib/response-headers";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ lessonId: string }> };

// An owner's authorization to record again in the lesson's current room, after the room moved
// during a recording (a link revoked or reissued). Owners only, from this site, rate limited as
// every admin change, recorded in the activity log (codes only). It never starts recording by
// itself: the server checks the lesson, the roster and every consent again first, and refuses
// for good after a withdrawal, an emergency stop or a cancellation.
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
    const result = await authorizeRecordingResume({ store: classroomStore(), provider, drive, lessonId, now: Date.now() });
    if (result.status === 200) {
      await appendAdminActivity({
        actorEmail: access.principal.email, actorRole: access.principal.role,
        action: "classroom.recording_resume_authorized", entityType: "classroom", entityId: lessonId,
        changedFields: [], entityStatus: `room-${"generation" in result.body ? result.body.generation : "?"}`, entityVersion: null,
      });
    }
    return respond(result.body, result.status);
  } catch {
    return respond({ error: "The authorization did not finish; it is safe to retry", code: "NOT_FINISHED" }, 503);
  }
}
