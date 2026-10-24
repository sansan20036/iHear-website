import { NextResponse } from "next/server";

import { authorizeAdminRequest } from "../../../../../lib/admin-auth";
import { classroomDrive } from "../../../../../lib/classroom-drive";
import { classroomProvider } from "../../../../../lib/classroom-provider";
import { runClassroomTick } from "../../../../../lib/classroom-service";
import { classroomStore } from "../../../../../lib/classroom-store";
import { withRateLimitHeaders } from "../../../../../lib/rate-limit";
import { NO_STORE_HEADERS } from "../../../../../lib/response-headers";

export const dynamic = "force-dynamic";

// The open overview asks the server to do its periodic work: the same tick the tutor's
// heartbeat and the cron run. It decides from stored facts only; the overview has no controls.
export async function POST(request: Request) {
  const access = await authorizeAdminRequest(request, { owner: true, mutation: true });
  if ("response" in access) return access.response;
  const respond = (body: unknown, status: number) => withRateLimitHeaders(NextResponse.json(body, { status, headers: NO_STORE_HEADERS }), access.decision!);
  let provider;
  let drive;
  try {
    provider = classroomProvider();
    drive = classroomDrive();
  } catch {
    return respond({ error: "The classroom is not available yet", code: "PROVIDER_UNAVAILABLE" }, 503);
  }
  try {
    return respond({ ok: true, ...(await runClassroomTick({ store: classroomStore(), provider, drive, now: Date.now(), workerId: `admin-${access.principal.email}` })) }, 200);
  } catch {
    return respond({ error: "The classroom tick did not finish; it is safe to retry" }, 503);
  }
}
