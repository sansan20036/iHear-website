import { NextResponse } from "next/server";

import { authorizeAdminRequest } from "../../../../lib/admin-auth";
import { appendAdminActivity } from "../../../../lib/admin-store";
import { invalidateTeamProfiles, teamApiError } from "../../../../lib/team-api";
import { reorderTeamProfiles } from "../../../../lib/team-store";
import { TEAM_SECTIONS, type TeamSection } from "../../../../lib/team-types";
import {
  enforceRateLimit,
  RATE_LIMIT_POLICIES,
  withRateLimitHeaders,
} from "../../../../lib/rate-limit";

export const dynamic = "force-dynamic";

export async function PATCH(request: Request) {
  const access = await authorizeAdminRequest(request, { mutation: true });
  if ("response" in access) return access.response;
  const decision = access.decision!;
  const respond = <T extends Response>(response: T) => withRateLimitHeaders(response, decision);
  try {
    const body = await request.json();
    const section = body.section as TeamSection;
    const ordered = Array.isArray(body.ordered)
      ? body.ordered.map((item: unknown) => {
          const source = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
          return { id: String(source.id || ""), version: Number(source.version) };
        })
      : [];
    if (
      !TEAM_SECTIONS.includes(section) ||
      ordered.some((item: { id: string; version: number }) =>
        !/^[a-zA-Z0-9-]{1,100}$/.test(item.id) || !Number.isInteger(item.version) || item.version < 1
      )
    ) {
      return respond(NextResponse.json({ error: "Invalid reorder payload" }, { status: 400 }));
    }
    await reorderTeamProfiles(section, ordered, access.principal.email);
    const revision = await invalidateTeamProfiles();
    await appendAdminActivity({
      actorEmail: access.principal.email, actorRole: access.principal.role,
      action: "team.reordered", entityType: "team", entityId: section,
      changedFields: ["sortOrder"], entityStatus: section, entityVersion: null,
    });
    return respond(NextResponse.json({ ok: true, revision }));
  } catch (error) {
    return respond(teamApiError(error));
  }
}
