import { revalidatePath, revalidateTag } from "next/cache";
import { NextResponse } from "next/server";

import {
  TEAM_CACHE_TAG,
  TeamConfigurationError,
  TeamConflictError,
  TeamDuplicatePlacementError,
  TeamNotFoundError,
} from "./team-store";
import { TeamValidationError } from "./team-types";
import { revisionAfterMutation } from "./live-revisions";

export async function invalidateTeamProfiles() {
  revalidateTag(TEAM_CACHE_TAG, { expire: 0 });
  revalidatePath("/team");
  revalidatePath("/api/team-profiles");
  revalidatePath("/api/live-revisions");
  return revisionAfterMutation("team");
}

export function teamApiError(error: unknown) {
  if (error instanceof TeamValidationError) {
    return NextResponse.json({ error: "Validation failed", issues: error.issues }, { status: 400 });
  }
  if (error instanceof TeamNotFoundError) {
    return NextResponse.json({ error: error.message }, { status: 404 });
  }
  if (error instanceof TeamConflictError || error instanceof TeamDuplicatePlacementError) {
    return NextResponse.json({ error: error.message }, { status: 409 });
  }
  if (error instanceof TeamConfigurationError) {
    return NextResponse.json({ error: "Team persistence is not configured" }, { status: 503 });
  }
  if ((error as { code?: string; constraint_name?: string }).code === "23514") {
    return NextResponse.json(
      { error: "Validation failed", issues: { consentConfirmed: "Publication consent is required" } },
      { status: 400 },
    );
  }
  console.error("Team profiles API error", error);
  return NextResponse.json({ error: "Could not update team profiles" }, { status: 500 });
}

export function isValidTeamId(value: string) {
  return /^[a-zA-Z0-9-]{1,100}$/.test(value);
}
