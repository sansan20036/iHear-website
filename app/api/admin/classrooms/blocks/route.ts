import { NextResponse } from "next/server";

import { authorizeAdminRequest } from "../../../../../lib/admin-auth";
import { appendAdminActivity } from "../../../../../lib/admin-store";
import { createClassroomBlock, listClassroomBlocks } from "../../../../../lib/classroom-blocks";
import { ClassroomInputError } from "../../../../../lib/classroom-service";
import { ClassroomLessonConflictError, classroomStore } from "../../../../../lib/classroom-store";
import { withRateLimitHeaders } from "../../../../../lib/rate-limit";
import { NO_STORE_HEADERS } from "../../../../../lib/response-headers";

export const dynamic = "force-dynamic";

// P3-Multi (2026-11-09): the blocks (班次) around now, for owners. Codes and times only.
export async function GET(request: Request) {
  const access = await authorizeAdminRequest(request, { owner: true });
  if ("response" in access) return access.response;
  try {
    return NextResponse.json({ ok: true, blocks: await listClassroomBlocks({ store: classroomStore(), now: Date.now() }) }, { headers: NO_STORE_HEADERS });
  } catch {
    return NextResponse.json({ error: "The blocks are temporarily unavailable" }, { status: 503, headers: NO_STORE_HEADERS });
  }
}

// An owner adds a block: its Lobby, rooms, people (with their confirmed English names) and first
// seats. The students' personal links are in this answer only.
export async function POST(request: Request) {
  const access = await authorizeAdminRequest(request, { owner: true, mutation: true });
  if ("response" in access) return access.response;
  const respond = (body: unknown, status: number) => withRateLimitHeaders(NextResponse.json(body, { status, headers: NO_STORE_HEADERS }), access.decision!);
  try {
    const input = await request.json().catch(() => ({}));
    const created = await createClassroomBlock({ store: classroomStore(), input, actor: access.principal.email, now: Date.now() });
    await appendAdminActivity({
      actorEmail: access.principal.email, actorRole: access.principal.role,
      action: "classroom.block_created", entityType: "classroom", entityId: created.block.blockId,
      changedFields: ["code", "startsAt", "endsAt", "rooms", "members"], entityStatus: "scheduled", entityVersion: null,
    });
    return respond({ ok: true, ...created }, 201);
  } catch (error) {
    if (error instanceof ClassroomInputError) return respond({ error: error.message, issues: error.issues }, 400);
    if (error instanceof ClassroomLessonConflictError) return respond({ error: error.message }, 409);
    return respond({ error: "Could not add the block" }, 500);
  }
}
