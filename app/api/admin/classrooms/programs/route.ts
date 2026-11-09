import { NextResponse } from "next/server";

import { authorizeAdminRequest } from "../../../../../lib/admin-auth";
import { appendAdminActivity } from "../../../../../lib/admin-store";
import { createClassroomCourse, createClassroomProgram, listClassroomPrograms, updateClassroomCourse, updateClassroomProgram } from "../../../../../lib/classroom-programs";
import { ClassroomInputError } from "../../../../../lib/classroom-service";
import { ClassroomLessonConflictError, classroomStore } from "../../../../../lib/classroom-store";
import { withRateLimitHeaders } from "../../../../../lib/rate-limit";
import { NO_STORE_HEADERS } from "../../../../../lib/response-headers";

export const dynamic = "force-dynamic";

// P3-Multi (draft 030): programs and their courses. Owners only; every change is logged.
export async function GET(request: Request) {
  const access = await authorizeAdminRequest(request, { owner: true });
  if ("response" in access) return access.response;
  try {
    return NextResponse.json({ ok: true, ...(await listClassroomPrograms({ store: classroomStore(), now: Date.now() })) }, { headers: NO_STORE_HEADERS });
  } catch {
    return NextResponse.json({ error: "The programs are temporarily unavailable" }, { status: 503, headers: NO_STORE_HEADERS });
  }
}

const ACTIONS = ["create_program", "update_program", "create_course", "update_course"] as const;

export async function POST(request: Request) {
  const access = await authorizeAdminRequest(request, { owner: true, mutation: true });
  if ("response" in access) return access.response;
  const respond = (body: unknown, status: number) => withRateLimitHeaders(NextResponse.json(body, { status, headers: NO_STORE_HEADERS }), access.decision!);
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const action = body.action as (typeof ACTIONS)[number];
  if (!ACTIONS.includes(action)) return respond({ error: `Use action: ${ACTIONS.join(", ")}`, code: "INVALID_ACTION" }, 400);
  const input = (body.input && typeof body.input === "object" ? body.input : {}) as Record<string, unknown>;
  const store = classroomStore();
  const now = Date.now();
  try {
    const result = action === "create_program" ? await createClassroomProgram({ store, input, actor: access.principal.email, now })
      : action === "update_program" ? await updateClassroomProgram({ store, id: body.id, input, now })
        : action === "create_course" ? await createClassroomCourse({ store, input, actor: access.principal.email, now })
          : await updateClassroomCourse({ store, id: body.id, input, now });
    if (!result) return respond({ error: "Not found", code: "NOT_FOUND" }, 404);
    await appendAdminActivity({
      actorEmail: access.principal.email, actorRole: access.principal.role, action: `classroom.${action}`, entityType: "classroom",
      entityId: result.id, changedFields: Object.keys(input).slice(0, 10), entityStatus: "cancelled" in result && result.cancelled ? "cancelled" : "archived" in result && result.archived ? "archived" : "active", entityVersion: null,
    });
    return respond({ ok: true, item: result }, 200);
  } catch (error) {
    if (error instanceof ClassroomInputError) return respond({ error: error.message, code: "INVALID", issues: error.issues }, 400);
    if (error instanceof ClassroomLessonConflictError) return respond({ error: error.message, code: "CONFLICT" }, 409);
    return respond({ error: "The change could not be saved" }, 503);
  }
}
