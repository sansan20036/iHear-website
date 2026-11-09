import { NextResponse } from "next/server";

import { authorizeAdminRequest } from "../../../../../lib/admin-auth";
import { appendAdminActivity } from "../../../../../lib/admin-store";
import { applyScheduleImport, parseCsv, planScheduleImport, ScheduleFormatError, type ImportInput } from "../../../../../lib/classroom-schedule-import";
import { classroomStore } from "../../../../../lib/classroom-store";
import { withRateLimitHeaders } from "../../../../../lib/rate-limit";
import { NO_STORE_HEADERS } from "../../../../../lib/response-headers";

export const dynamic = "force-dynamic";

// P3-Multi §10: a schedule (CSV) and iHear's people directory (CSV) into one course's blocks.
// "preview" changes nothing; "apply" needs the preview's planHash and makes the new blocks only.
// Owners only. Google Sheets is read the same way once iHear approves access (not connected).
// Nothing here opens a Zoom session or records.
export async function POST(request: Request) {
  const access = await authorizeAdminRequest(request, { owner: true, mutation: true });
  if ("response" in access) return access.response;
  const respond = (body: unknown, status: number) => withRateLimitHeaders(NextResponse.json(body, { status, headers: NO_STORE_HEADERS }), access.decision!);
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  if (body.action !== "preview" && body.action !== "apply") return respond({ error: "Use action: preview or apply", code: "INVALID_ACTION" }, 400);
  let input: ImportInput;
  try {
    input = {
      courseId: body.course, timeZone: body.timeZone, manager: body.manager,
      schedule: parseCsv(String(body.schedule ?? "")), directory: parseCsv(String(body.directory ?? "")),
      mapping: body.mapping && typeof body.mapping === "object" ? body.mapping as ImportInput["mapping"] : undefined,
    };
  } catch (error) {
    if (error instanceof ScheduleFormatError) return respond({ error: error.message, code: error.code }, 400);
    return respond({ error: "The schedule could not be read", code: "UNREADABLE" }, 400);
  }
  const store = classroomStore();
  const now = Date.now();
  try {
    if (body.action === "preview") return respond({ ok: true, plan: await planScheduleImport({ store, input, now }) }, 200);
    const result = await applyScheduleImport({ store, input, planHash: body.planHash, actor: access.principal.email, now });
    const created = (result.body as { created?: unknown[] }).created ?? [];
    if (created.length) {
      await appendAdminActivity({
        actorEmail: access.principal.email, actorRole: access.principal.role, action: "classroom.schedule_import", entityType: "classroom",
        entityId: String(body.course ?? ""), changedFields: ["blocks"], entityStatus: `created:${created.length}`, entityVersion: null,
      });
    }
    return respond(result.body, result.status);
  } catch {
    return respond({ error: "The import could not be completed" }, 503);
  }
}
