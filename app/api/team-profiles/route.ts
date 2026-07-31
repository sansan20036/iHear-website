import { NextResponse } from "next/server";

// @ts-ignore - auth.js is the existing Auth.js configuration.
import { auth } from "../../../auth.js";
import { isAllowedAdmin, normalizeEmail } from "../../../lib/admins";
import { invalidateTeamProfiles, teamApiError } from "../../../lib/team-api";
import {
  createTeamProfile,
  listAllTeamProfiles,
  listPublishedTeamProfiles,
} from "../../../lib/team-store";
import {
  parseTeamProfileInput,
  publicTeamProfile,
  type TeamProfileInput,
} from "../../../lib/team-types";

export const dynamic = "force-dynamic";

function grouped(profiles: ReturnType<typeof publicTeamProfile>[]) {
  return {
    leaders: profiles.filter((profile) => profile.section === "leader"),
    tutors: profiles.filter((profile) => profile.section === "tutor"),
  };
}

export async function GET(request: Request) {
  try {
    const includeDrafts = new URL(request.url).searchParams.get("includeDrafts") === "true";
    if (includeDrafts) {
      const session = await auth();
      const email = normalizeEmail(session?.user?.email);
      if (!isAllowedAdmin(email)) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
      }
      const profiles = await listAllTeamProfiles();
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
  const session = await auth();
  const email = normalizeEmail(session?.user?.email);
  if (!isAllowedAdmin(email)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  try {
    const input = parseTeamProfileInput(await request.json()) as TeamProfileInput;
    const profile = await createTeamProfile(input, email);
    const revision = await invalidateTeamProfiles();
    return NextResponse.json({ ok: true, profile, revision }, { status: 201 });
  } catch (error) {
    return teamApiError(error);
  }
}
