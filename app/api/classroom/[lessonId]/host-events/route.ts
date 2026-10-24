import { NextResponse } from "next/server";

// @ts-ignore - auth.js is the existing Auth.js configuration.
import { auth } from "../../../../../auth.js";
import { isSameOrigin } from "../../../../../lib/admin-auth";
import { normalizeEmail } from "../../../../../lib/admins";
import { classroomDrive } from "../../../../../lib/classroom-drive";
import { classroomProvider } from "../../../../../lib/classroom-provider";
import { recordHostReport } from "../../../../../lib/classroom-service";
import { classroomStore } from "../../../../../lib/classroom-store";
import { NO_STORE_HEADERS } from "../../../../../lib/response-headers";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ lessonId: string }> };

// The tutor's browser reports its heartbeat and what the video SDK tells it. The report is
// stored before the answer; the answer says whether recording is still allowed, so the page can
// stop it at once when it is not.
export async function POST(request: Request, context: Context) {
  if (!isSameOrigin(request)) return NextResponse.json({ error: "Cross-origin request blocked" }, { status: 403, headers: NO_STORE_HEADERS });
  const { lessonId } = await context.params;
  const session = await auth();
  const sessionEmail = normalizeEmail(session?.user?.email);
  if (!sessionEmail) return NextResponse.json({ error: "Sign in required", code: "SIGN_IN_REQUIRED" }, { status: 401, headers: NO_STORE_HEADERS });
  let provider;
  let drive;
  try {
    provider = classroomProvider();
    drive = classroomDrive();
  } catch {
    return NextResponse.json({ error: "The classroom is not available yet", code: "PROVIDER_UNAVAILABLE" }, { status: 503, headers: NO_STORE_HEADERS });
  }
  const report = await request.json().catch(() => null);
  const result = await recordHostReport({ store: classroomStore(), provider, drive, lessonId, sessionEmail, report, now: Date.now() })
    .catch(() => ({ status: 503, body: { error: "Not stored, please retry" } }));
  return NextResponse.json(result.body, { status: result.status, headers: NO_STORE_HEADERS });
}
