import { NextResponse } from "next/server";
import { authorizeAdminRequest } from "../../../../../lib/admin-auth";
import { appendAdminActivity } from "../../../../../lib/admin-store";
import { invalidateTeamProfiles, isValidTeamId, teamApiError } from "../../../../../lib/team-api";
import { setTeamProfileVisibility } from "../../../../../lib/team-store";
import { withRateLimitHeaders } from "../../../../../lib/rate-limit";

export const dynamic = "force-dynamic";

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const access = await authorizeAdminRequest(request, { mutation: true });
  if ("response" in access) return access.response;
  const respond = <T extends Response>(response: T) => withRateLimitHeaders(response, access.decision!);
  try {
    const { id } = await context.params;
    const body = await request.json().catch(() => null);
    if (!isValidTeamId(id) || typeof body?.isHidden !== "boolean" || !Number.isInteger(body?.profileVersion) || body.profileVersion < 1) {
      return respond(NextResponse.json({ error: "A valid profile id, isHidden boolean and profileVersion are required" }, { status: 400 }));
    }
    const profile = await setTeamProfileVisibility(id, body.isHidden, body.profileVersion, access.principal.email);
    const revision = await invalidateTeamProfiles();
    await appendAdminActivity({ actorEmail: access.principal.email, actorRole: access.principal.role,
      action: body.isHidden ? "team.hidden" : "team.shown", entityType: "team", entityId: id,
      changedFields: ["isHidden"], entityStatus: profile.status, entityVersion: profile.profileVersion });
    return respond(NextResponse.json({ ok: true, profile, revision }));
  } catch (error) { return respond(teamApiError(error)); }
}
