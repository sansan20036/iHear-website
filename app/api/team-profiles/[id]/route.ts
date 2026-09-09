import { NextResponse } from "next/server";

import { authorizeAdminRequest } from "../../../../lib/admin-auth";
import { appendAdminActivity } from "../../../../lib/admin-store";
import {
  invalidateTeamProfiles,
  isValidTeamId,
  teamApiError,
} from "../../../../lib/team-api";
import {
  deleteTeamProfile,
  trashTeamProfile,
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
import {
  TranslationReceiptError,
  verifyTranslationReceipt,
} from "../../../../lib/translation-core";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, context: Context) {
  const access = await authorizeAdminRequest(request, { mutation: true });
  if ("response" in access) return access.response;
  const decision = access.decision!;
  const respond = <T extends Response>(response: T) => withRateLimitHeaders(response, decision);
  try {
    const { id } = await context.params;
    if (!isValidTeamId(id)) return respond(NextResponse.json({ error: "Invalid profile id" }, { status: 400 }));
    const body = await request.json();
    const input = parseTeamProfileInput(body, {
      requireVersion: true,
    }) as TeamProfileUpdateInput;
    const fields = {
      role: input.role, schoolDisplay: input.schoolDisplay, languages: input.languages,
      strengths: input.strengths, summary: input.summary, bio: input.bio, hobbies: input.hobbies,
    };
    const receipt = typeof body?.translationReceipt === "string" ? body.translationReceipt : "";
    const translationStates = receipt
      ? verifyTranslationReceipt({ receipt, email: access.principal.email, resource: { type: "team", scope: "", id, version: input.profileVersion }, fields })
      : undefined;
    const profile = await updateTeamProfile(id, input, access.principal.email, translationStates);
    const revision = await invalidateTeamProfiles();
    await appendAdminActivity({
      actorEmail: access.principal.email, actorRole: access.principal.role,
      action: "team.updated", entityType: "team", entityId: id,
      changedFields: Object.keys(input).filter((key) => !key.endsWith("Version")),
      entityStatus: profile.status, entityVersion: profile.profileVersion,
    });
    return respond(NextResponse.json({ ok: true, profile, revision }));
  } catch (error) {
    if (error instanceof TranslationReceiptError) return respond(NextResponse.json({ error: error.message, code: error.code }, { status: 409 }));
    return respond(teamApiError(error));
  }
}

export async function DELETE(request: Request, context: Context) {
  const body = await request.json().catch(() => ({}));
  const permanent = body?.permanent === true;
  const access = await authorizeAdminRequest(request, { mutation: true, owner: permanent });
  if ("response" in access) return access.response;
  const decision = access.decision!;
  const respond = <T extends Response>(response: T) => withRateLimitHeaders(response, decision);
  try {
    const { id } = await context.params;
    if (!isValidTeamId(id)) return respond(NextResponse.json({ error: "Invalid profile id" }, { status: 400 }));
    const profileVersion = Number(body.profileVersion);
    if (!Number.isInteger(profileVersion) || profileVersion < 1) {
      return respond(NextResponse.json({ error: "A valid profile version is required" }, { status: 400 }));
    }
    const deletedId = permanent
      ? await deleteTeamProfile(id, profileVersion)
      : await trashTeamProfile(id, profileVersion, access.principal.email);
    let revision;
    try {
      revision = await invalidateTeamProfiles();
    } catch (error) {
      console.error("Team profile changed, but cache invalidation failed", error);
    }
    await appendAdminActivity({
      actorEmail: access.principal.email, actorRole: access.principal.role,
      action: permanent ? "team.deleted_permanently" : "team.trashed",
      entityType: "team", entityId: id, changedFields: permanent ? [] : ["deletedAt", "deletedBy"],
      entityStatus: permanent ? "deleted" : "trash", entityVersion: permanent ? null : profileVersion + 1,
    });
    return respond(NextResponse.json({ ok: true, deletedId, revision }));
  } catch (error) {
    return respond(teamApiError(error));
  }
}
