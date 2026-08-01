import { NextResponse } from "next/server";

// @ts-ignore - auth.js is the existing Auth.js configuration.
import { auth } from "../../../../auth.js";
import { isAllowedAdmin, normalizeEmail } from "../../../../lib/admins";
import {
  invalidateTeamProfiles,
  isValidTeamId,
  teamApiError,
} from "../../../../lib/team-api";
import {
  deleteTeamProfile,
  updateTeamProfile,
} from "../../../../lib/team-store";
import {
  parseTeamProfileInput,
  type TeamProfileUpdateInput,
} from "../../../../lib/team-types";
import {
  enforceRateLimit,
  RATE_LIMIT_POLICIES,
  withRateLimitHeaders,
} from "../../../../lib/rate-limit";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };

async function adminEmail() {
  const session = await auth();
  const email = normalizeEmail(session?.user?.email);
  return isAllowedAdmin(email) ? email : "";
}

export async function PATCH(request: Request, context: Context) {
  const email = await adminEmail();
  if (!email) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const decision = await enforceRateLimit(request, {
    ...RATE_LIMIT_POLICIES.adminMutation,
    identifier: email,
  });
  if (decision.limited) return decision.response;
  const respond = <T extends Response>(response: T) => withRateLimitHeaders(response, decision);
  try {
    const { id } = await context.params;
    if (!isValidTeamId(id)) return respond(NextResponse.json({ error: "Invalid profile id" }, { status: 400 }));
    const input = parseTeamProfileInput(await request.json(), {
      requireVersion: true,
    }) as TeamProfileUpdateInput;
    const profile = await updateTeamProfile(id, input, email);
    const revision = await invalidateTeamProfiles();
    return respond(NextResponse.json({ ok: true, profile, revision }));
  } catch (error) {
    return respond(teamApiError(error));
  }
}

export async function DELETE(request: Request, context: Context) {
  const email = await adminEmail();
  if (!email) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const decision = await enforceRateLimit(request, {
    ...RATE_LIMIT_POLICIES.adminMutation,
    identifier: email,
  });
  if (decision.limited) return decision.response;
  const respond = <T extends Response>(response: T) => withRateLimitHeaders(response, decision);
  try {
    const { id } = await context.params;
    if (!isValidTeamId(id)) return respond(NextResponse.json({ error: "Invalid profile id" }, { status: 400 }));
    const body = await request.json().catch(() => ({}));
    const profileVersion = Number(body.profileVersion);
    if (!Number.isInteger(profileVersion) || profileVersion < 1) {
      return respond(NextResponse.json({ error: "A valid profile version is required" }, { status: 400 }));
    }
    const deletedId = await deleteTeamProfile(id, profileVersion);
    let revision;
    try {
      revision = await invalidateTeamProfiles();
    } catch (error) {
      console.error("Team profile was deleted, but cache invalidation failed", error);
    }
    return respond(NextResponse.json({ ok: true, deletedId, revision }));
  } catch (error) {
    return respond(teamApiError(error));
  }
}
