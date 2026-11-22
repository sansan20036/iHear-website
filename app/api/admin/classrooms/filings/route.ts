import { NextResponse } from "next/server";

import { authorizeAdminRequest } from "../../../../../lib/admin-auth";
import { appendAdminActivity } from "../../../../../lib/admin-store";
import { listBlockFilings, retryBlockFiling } from "../../../../../lib/classroom-blocks";
import { classroomDrive } from "../../../../../lib/classroom-drive";
import { previewRetention, retentionActivityStatus, retentionConfigured, runRetention } from "../../../../../lib/classroom-retention";
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
  let retention = false;
  try {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    // Gate B (round 10): the recordings' retention, off unless the site sets a period (iHear's
    // decision): until then its actions are unknown here, as before. A preview changes nothing; an
    // apply deletes exactly the plan previewed (its digest). Round 12: only the kinds of recording the
    // site names; applying only by a person the site names, a permanent deletion only with
    // permanent: true; the activity record says whether every copy, some or none were deleted.
    retention = retentionConfigured() && (body.action === "retention_preview" || body.action === "retention_apply");
    if (retention && body.action === "retention_preview") {
      const preview = await previewRetention({ store: classroomStore(), now: Date.now(), actor: access.principal.email });
      return respond(preview.body, preview.status);
    }
    if (retention && body.action === "retention_apply") {
      const applied = await runRetention({ store: classroomStore(), drive: classroomDrive(), now: Date.now(), actor: access.principal.email, confirm: body.confirm, permanent: body.permanent === true });
      if (applied.status === 200) {
        const outcomes = ((applied.body as { results?: { outcome: string; note?: string }[] }).results ?? []);
        const recorded = await appendAdminActivity({
          actorEmail: access.principal.email, actorRole: access.principal.role, action: "classroom.recording_retention", entityType: "classroom",
          entityId: String((applied.body as { digest?: string }).digest ?? ""), changedFields: ["recordings"], entityStatus: retentionActivityStatus(outcomes), entityVersion: null,
        }).then(() => true, () => false);
        if (!recorded) return respond({ ...(applied.body as Record<string, unknown>), activity: "not_recorded" }, applied.status);
      }
      return respond(applied.body, applied.status);
    }
    if (body.action !== "retry") return respond({ error: retentionConfigured() ? "Use action: retry, retention_preview or retention_apply" : "Use action: retry", code: "INVALID_ACTION" }, 400);
    const result = await retryBlockFiling({ store: classroomStore(), providerFileId: body.recording, actor: access.principal.email, reason: body.reason, now: Date.now() });
    if (result.status === 200) {
      await appendAdminActivity({
        actorEmail: access.principal.email, actorRole: access.principal.role, action: "classroom.filing_retry", entityType: "classroom",
        entityId: String(body.recording), changedFields: ["filing"], entityStatus: "requeued", entityVersion: null,
      });
    }
    return respond(result.body, result.status);
  } catch {
    // An apply never throws for one copy's trouble (each is said in its answer); this is the store or
    // Drive unavailable before anything was deleted.
    return respond({ error: retention ? "The retention could not be read; nothing more was deleted" : "The filing could not be retried" }, 503);
  }
}
