import { NextResponse } from "next/server";

// @ts-ignore - auth.js is the existing Auth.js configuration.
import { auth } from "../../../../auth.js";
import { isAllowedAdmin, normalizeEmail } from "../../../../lib/admins";
import { invalidateTeamProfiles, teamApiError } from "../../../../lib/team-api";
import { reorderTeamProfiles } from "../../../../lib/team-store";
import { TEAM_SECTIONS, type TeamSection } from "../../../../lib/team-types";

export const dynamic = "force-dynamic";

export async function PATCH(request: Request) {
  const session = await auth();
  const email = normalizeEmail(session?.user?.email);
  if (!isAllowedAdmin(email)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
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
      return NextResponse.json({ error: "Invalid reorder payload" }, { status: 400 });
    }
    await reorderTeamProfiles(section, ordered, email);
    invalidateTeamProfiles();
    return NextResponse.json({ ok: true });
  } catch (error) {
    return teamApiError(error);
  }
}
