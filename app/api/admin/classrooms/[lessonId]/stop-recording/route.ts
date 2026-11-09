import { NextResponse } from "next/server";

import { authorizeAdminRequest } from "../../../../../../lib/admin-auth";
import { appendAdminActivity } from "../../../../../../lib/admin-store";
import { classroomDrive } from "../../../../../../lib/classroom-drive";
import { classroomProvider } from "../../../../../../lib/classroom-provider";
import { emergencyStopRecording } from "../../../../../../lib/classroom-service";
import { classroomStore } from "../../../../../../lib/classroom-store";
import { withRateLimitHeaders } from "../../../../../../lib/rate-limit";
import { NO_STORE_HEADERS } from "../../../../../../lib/response-headers";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ lessonId: string }> };

// The emergency stop for one lesson: owners only, rate limited, recorded in the activity log.
// The lesson is never recorded again, and the stop goes to the provider at once.
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
    const result = await emergencyStopRecording({ store: classroomStore(), provider, drive, lessonId, now: Date.now() });
    if (result.status === 200) {
      await appendAdminActivity({
        actorEmail: access.principal.email, actorRole: access.principal.role,
        action: "classroom.emergency_stop", entityType: "classroom", entityId: lessonId,
        changedFields: [], entityStatus: "stopRequested" in result.body && result.body.stopRequested ? "stop-requested" : "no-recording-running", entityVersion: null,
      });
    }
    return respond(result.body, result.status);
  } catch {
    // The stop is stored before anything else, so a retry repeats nothing that was done.
    return respond({ error: "The emergency stop did not finish; press it again", code: "STOP_NOT_FINISHED" }, 503);
  }
}
