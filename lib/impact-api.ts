import { revalidatePath, revalidateTag } from "next/cache";
import { NextResponse } from "next/server";

import {
  ImpactConfigurationError,
  ImpactConflictError,
  ImpactNotFoundError,
  IMPACT_CACHE_TAG,
} from "./impact-store";
import { ImpactValidationError } from "./impact-types";

export function invalidateImpactMilestones() {
  revalidateTag(IMPACT_CACHE_TAG, { expire: 0 });
  revalidatePath("/about");
  revalidatePath("/api/impact-milestones");
}

export function impactApiError(error: unknown) {
  if (error instanceof ImpactValidationError) {
    return NextResponse.json(
      { error: "Validation failed", issues: error.issues },
      { status: 400 },
    );
  }
  if (error instanceof ImpactNotFoundError) {
    return NextResponse.json({ error: error.message }, { status: 404 });
  }
  if (error instanceof ImpactConflictError) {
    return NextResponse.json({ error: error.message }, { status: 409 });
  }
  if (error instanceof ImpactConfigurationError) {
    return NextResponse.json(
      { error: "Impact data persistence is not configured" },
      { status: 503 },
    );
  }

  console.error("Impact milestones API error", error);
  return NextResponse.json({ error: "Could not update impact milestones" }, { status: 500 });
}

export function isValidImpactId(value: string) {
  return /^[a-zA-Z0-9-]{1,80}$/.test(value);
}
