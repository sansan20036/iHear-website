import { NextResponse } from "next/server";

import { authorizeAdminRequest } from "../../../../../lib/admin-auth";
import { appendAdminActivity } from "../../../../../lib/admin-store";
import { impactApiError, invalidateImpactMilestones, isValidImpactId } from "../../../../../lib/impact-api";
import { restoreImpactMilestone } from "../../../../../lib/impact-store";
import { withRateLimitHeaders } from "../../../../../lib/rate-limit";

type Context = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: Context) {
  const access = await authorizeAdminRequest(request, { mutation: true });
  if ("response" in access) return access.response;
  const respond = <T extends Response>(response: T) => withRateLimitHeaders(response, access.decision!);
  try {
    const { id } = await context.params;
    if (!isValidImpactId(id)) return respond(NextResponse.json({ error: "Invalid milestone id" }, { status: 400 }));
    const body = await request.json();
    const version = Number(body?.version);
    if (!Number.isInteger(version) || version < 1) {
      return respond(NextResponse.json({ error: "A valid version is required" }, { status: 400 }));
    }
    const milestone = await restoreImpactMilestone(id, version, access.principal.email);
    const revision = await invalidateImpactMilestones();
    await appendAdminActivity({
      actorEmail: access.principal.email, actorRole: access.principal.role,
      action: "impact.restored", entityType: "impact", entityId: id,
      changedFields: ["status", "archivedAt"], entityStatus: milestone.status, entityVersion: milestone.version,
    });
    return respond(NextResponse.json({ ok: true, milestone, revision }));
  } catch (error) {
    return respond(impactApiError(error));
  }
}
