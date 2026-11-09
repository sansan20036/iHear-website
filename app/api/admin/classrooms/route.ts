import { NextResponse } from "next/server";

import { authorizeAdminRequest } from "../../../../lib/admin-auth";
import { appendAdminActivity } from "../../../../lib/admin-store";
import { testConsentMode } from "../../../../lib/classroom-consent-gate";
import { classroomProvider } from "../../../../lib/classroom-provider";
import { ClassroomInputError, classroomOverview, createClassroomLesson } from "../../../../lib/classroom-service";
import { ClassroomLessonConflictError, classroomStore } from "../../../../lib/classroom-store";
import { withRateLimitHeaders } from "../../../../lib/rate-limit";
import { NO_STORE_HEADERS } from "../../../../lib/response-headers";

export const dynamic = "force-dynamic";

// Which provider the classroom runs on, so the overview can say when it shows synthetic data.
function providerMode() {
  try {
    return classroomProvider().name;
  } catch {
    return null;
  }
}

// The live classroom overview: owners only, codes only, never cached.
export async function GET(request: Request) {
  const access = await authorizeAdminRequest(request, { owner: true });
  if ("response" in access) return access.response;
  try {
    const overview = await classroomOverview({ store: classroomStore(), now: Date.now() });
    // Test consent for TEST- codes (consents route): a local vendor trial, or in production the
    // closed adult pilot only (lib/classroom-consent-gate.ts).
    const trialConsent = testConsentMode() !== null;
    return NextResponse.json({ mode: providerMode(), trialConsent, ...overview }, { headers: NO_STORE_HEADERS });
  } catch {
    return NextResponse.json({ error: "The classroom overview is temporarily unavailable" }, { status: 503, headers: NO_STORE_HEADERS });
  }
}

// Adds a one-to-one lesson. The student's personal link is in this answer only.
export async function POST(request: Request) {
  const access = await authorizeAdminRequest(request, { owner: true, mutation: true });
  if ("response" in access) return access.response;
  const respond = (body: unknown, status: number) => withRateLimitHeaders(NextResponse.json(body, { status, headers: NO_STORE_HEADERS }), access.decision!);
  try {
    const input = await request.json().catch(() => ({}));
    const { lesson, studentLink } = await createClassroomLesson({ store: classroomStore(), input, actor: access.principal.email, now: Date.now() });
    await appendAdminActivity({
      actorEmail: access.principal.email, actorRole: access.principal.role,
      action: "classroom.lesson_created", entityType: "classroom", entityId: lesson.id,
      changedFields: ["code", "startsAt", "endsAt", "participants"], entityStatus: "scheduled", entityVersion: null,
    });
    return respond({ ok: true, lesson: { lessonId: lesson.id, code: lesson.code, startsAt: lesson.startsAt, endsAt: lesson.endsAt }, studentLink }, 201);
  } catch (error) {
    if (error instanceof ClassroomInputError) return respond({ error: error.message, issues: error.issues }, 400);
    if (error instanceof ClassroomLessonConflictError) return respond({ error: error.message }, 409);
    return respond({ error: "Could not add the lesson" }, 500);
  }
}
