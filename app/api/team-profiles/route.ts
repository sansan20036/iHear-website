import { NextResponse } from "next/server";

import { authorizeAdminRequest } from "../../../lib/admin-auth";
import { appendAdminActivity } from "../../../lib/admin-store";
import { invalidateTeamProfiles, teamApiError } from "../../../lib/team-api";
import {
  createTeamProfile,
  listAllTeamProfiles,
  listDeletedTeamProfiles,
  listPublishedTeamProfiles,
} from "../../../lib/team-store";
import {
  parseTeamProfileInput,
  publicTeamProfile,
  type TeamProfileInput,
} from "../../../lib/team-types";
import {
  enforceRateLimit,
  RATE_LIMIT_POLICIES,
  withRateLimitHeaders,
} from "../../../lib/rate-limit";
import {
  manualTranslationWrites,
  TranslationReceiptError,
  verifyTranslationReceipt,
} from "../../../lib/translation-core";

export const dynamic = "force-dynamic";

function grouped<T extends { section: "leader" | "tutor" }>(profiles: T[]) {
  return {
    leaders: profiles.filter((profile) => profile.section === "leader"),
    tutors: profiles.filter((profile) => profile.section === "tutor"),
  };
}

export async function GET(request: Request) {
  try {
    const includeDrafts = new URL(request.url).searchParams.get("includeDrafts") === "true";
    const includeDeleted = new URL(request.url).searchParams.get("includeDeleted") === "true";
    if (includeDrafts || includeDeleted) {
      const access = await authorizeAdminRequest(request);
      if ("response" in access) return access.response;
      const profiles = includeDeleted ? await listDeletedTeamProfiles() : await listAllTeamProfiles();
      return NextResponse.json(
        { ...grouped(profiles), people: [...new Map(profiles.map((profile) => [
          profile.personId,
          {
            id: profile.personId,
            name: profile.name,
            initials: profile.initials,
            personVersion: profile.personVersion,
            consentConfirmed: Boolean(profile.publicationConsentAt),
          },
        ])).values()], admin: true },
        {
          headers: {
            "Cache-Control": "private, no-store",
            "Vercel-CDN-Cache-Control": "no-store",
          },
        },
      );
    }

    const profiles = (await listPublishedTeamProfiles()).map(publicTeamProfile);
    return NextResponse.json(grouped(profiles), {
      headers: {
        "Cache-Control": "public, max-age=0, must-revalidate",
        "Vercel-CDN-Cache-Control": "public, s-maxage=1",
      },
    });
  } catch (error) {
    return teamApiError(error);
  }
}

export async function POST(request: Request) {
  const access = await authorizeAdminRequest(request, { mutation: true });
  if ("response" in access) return access.response;
  const decision = access.decision!;
  try {
    const body = await request.json();
    const input = parseTeamProfileInput(body) as TeamProfileInput;
    const fields = {
      role: input.role, schoolDisplay: input.schoolDisplay, languages: input.languages,
      strengths: input.strengths, summary: input.summary, bio: input.bio, hobbies: input.hobbies,
    };
    const receipt = typeof body?.translationReceipt === "string" ? body.translationReceipt : "";
    const translationStates = receipt
      ? verifyTranslationReceipt({ receipt, email: access.principal.email, resource: { type: "team", scope: "", id: "__new__" }, fields })
      : manualTranslationWrites(fields);
    const profile = await createTeamProfile(input, access.principal.email, translationStates);
    const revision = await invalidateTeamProfiles();
    await appendAdminActivity({
      actorEmail: access.principal.email, actorRole: access.principal.role,
      action: "team.created", entityType: "team", entityId: profile.id,
      changedFields: Object.keys(input), entityStatus: profile.status, entityVersion: profile.profileVersion,
    });
    return withRateLimitHeaders(
      NextResponse.json({ ok: true, profile, revision }, { status: 201 }),
      decision,
    );
  } catch (error) {
    if (error instanceof TranslationReceiptError) return withRateLimitHeaders(NextResponse.json({ error: error.message, code: error.code }, { status: 409 }), decision);
    return withRateLimitHeaders(teamApiError(error), decision);
  }
}
