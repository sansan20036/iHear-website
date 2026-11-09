import { NextResponse } from "next/server";

import { authorizeAdminRequest } from "../../../../../lib/admin-auth";
import { appendAdminActivity } from "../../../../../lib/admin-store";
import { listBlockFilings, retryBlockFiling } from "../../../../../lib/classroom-blocks";
import { classroomStore } from "../../../../../lib/classroom-store";
import { withRateLimitHeaders } from "../../../../../lib/rate-limit";
import { NO_STORE_HEADERS } from "../../../../../lib/response-headers";

export const dynamic = "force-dynamic";

// P3-Multi (18.5): the block recordings and their filing, newest New York date first. Owners only.
export async function GET(request: Request) {
  const access = await authorizeAdminRequest(request, { owner: true });
  if ("response" in access) return access.response;
  try {
    return NextResponse.json({ ok: true, filings: await listBlockFilings({ store: classroomStore(), now: Date.now() }) }, { headers: NO_STORE_HEADERS });
  } catch {
    return NextResponse.json({ error: "The filings are temporarily unavailable" }, { status: 503, headers: NO_STORE_HEADERS });
  }
}

// An owner retries a failed filing, with a reason; only a failed one that is not held.
export async function POST(request: Request) {
  const access = await authorizeAdminRequest(request, { owner: true, mutation: true });
  if ("response" in access) return access.response;
  const respond = (body: unknown, status: number) => withRateLimitHeaders(NextResponse.json(body, { status, headers: NO_STORE_HEADERS }), access.decision!);
  try {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    if (body.action !== "retry") return respond({ error: "Use action: retry", code: "INVALID_ACTION" }, 400);
    const result = await retryBlockFiling({ store: classroomStore(), providerFileId: body.recording, actor: access.principal.email, reason: body.reason, now: Date.now() });
    if (result.status === 200) {
      await appendAdminActivity({
        actorEmail: access.principal.email, actorRole: access.principal.role, action: "classroom.filing_retry", entityType: "classroom",
        entityId: String(body.recording), changedFields: ["filing"], entityStatus: "requeued", entityVersion: null,
      });
    }
    return respond(result.body, result.status);
  } catch {
    return respond({ error: "The filing could not be retried" }, 503);
  }
}
