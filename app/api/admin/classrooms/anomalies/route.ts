import { NextResponse } from "next/server";

import { authorizeAdminRequest } from "../../../../../lib/admin-auth";
import { appendAdminActivity } from "../../../../../lib/admin-store";
import { classroomStore } from "../../../../../lib/classroom-store";
import { withRateLimitHeaders } from "../../../../../lib/rate-limit";
import { NO_STORE_HEADERS } from "../../../../../lib/response-headers";

export const dynamic = "force-dynamic";

// Manual handling of an anomaly: who looked at it, when, and what they did. The note is kept
// short and should hold codes and actions, never names.
export async function POST(request: Request) {
  const access = await authorizeAdminRequest(request, { owner: true, mutation: true });
  if ("response" in access) return access.response;
  const respond = (body: unknown, status: number) => withRateLimitHeaders(NextResponse.json(body, { status, headers: NO_STORE_HEADERS }), access.decision!);
  const body = await request.json().catch(() => ({}));
  const lessonId = typeof body?.lessonId === "string" ? body.lessonId : "";
  const code = typeof body?.code === "string" ? body.code : "";
  const note = typeof body?.note === "string" ? body.note.trim() : "";
  if (!/^[A-Za-z0-9-]{1,36}$/.test(lessonId) || !/^[A-Z_]{3,60}$/.test(code)) return respond({ error: "Unknown anomaly" }, 400);
  if (!note || note.length > 500) return respond({ error: "Describe what was done (up to 500 characters)", issues: { note: "Required" } }, 400);
  try {
    const anomaly = await classroomStore().acknowledgeAnomaly({ lessonId, code, actor: access.principal.email, note, now: Date.now() });
    if (!anomaly) return respond({ error: "Unknown anomaly" }, 404);
    await appendAdminActivity({
      actorEmail: access.principal.email, actorRole: access.principal.role,
      action: "classroom.anomaly_handled", entityType: "classroom", entityId: `${lessonId}:${code}`,
      changedFields: ["acknowledgedBy", "note"], entityStatus: anomaly.resolvedAt ? "resolved" : "open", entityVersion: null,
    });
    return respond({ ok: true }, 200);
  } catch {
    return respond({ error: "Could not record the handling; it is safe to retry" }, 503);
  }
}
