import { NextResponse } from "next/server";

import { authorizeAdminRequest } from "../../../../../lib/admin-auth";
import { appendAdminActivity } from "../../../../../lib/admin-store";
import { invalidateTeamProfiles, isValidTeamId, teamApiError } from "../../../../../lib/team-api";
import { restoreTeamProfile } from "../../../../../lib/team-store";
import { withRateLimitHeaders } from "../../../../../lib/rate-limit";

type Context = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: Context) {
  const access = await authorizeAdminRequest(request, { mutation: true });
  if ("response" in access) return access.response;
  const respond = <T extends Response>(response: T) => withRateLimitHeaders(response, access.decision!);
  try {
    const { id } = await context.params;
    if (!isValidTeamId(id)) return respond(NextResponse.json({ error: "Invalid profile id" }, { status: 400 }));
    const body = await request.json();
    const version = Number(body?.profileVersion);
    if (!Number.isInteger(version) || version < 1) {
      return respond(NextResponse.json({ error: "A valid profile version is required" }, { status: 400 }));
    }
    await restoreTeamProfile(id, version, access.principal.email);
    const revision = await invalidateTeamProfiles();
    await appendAdminActivity({
      actorEmail: access.principal.email, actorRole: access.principal.role,
      action: "team.restored", entityType: "team", entityId: id,
      changedFields: ["deletedAt", "deletedBy"], entityStatus: "restored", entityVersion: version + 1,
    });
    return respond(NextResponse.json({ ok: true, restoredId: id, revision }));
  } catch (error) {
    return respond(teamApiError(error));
  }
}
