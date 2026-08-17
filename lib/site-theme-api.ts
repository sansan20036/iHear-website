import { revalidatePath } from "next/cache";
import { NextResponse } from "next/server";

import { revisionAfterMutation } from "./live-revisions";
import { SiteThemeConfigurationError, SiteThemeConflictError } from "./site-theme-store";

export async function invalidateSiteTheme() {
  for (const path of ["/", "/api/site-theme", "/api/site-theme/bootstrap", "/api/live-revisions"]) {
    try {
      revalidatePath(path);
    } catch (error) {
      console.error(`Could not revalidate ${path}`, error);
    }
  }
  try {
    return await revisionAfterMutation("theme");
  } catch (error) {
    console.error("Could not read site-theme revision", error);
    return null;
  }
}

export function siteThemeApiError(error: unknown) {
  if (error instanceof SiteThemeConflictError) {
    return NextResponse.json({ error: error.message }, { status: 409 });
  }
  if (error instanceof SiteThemeConfigurationError) {
    return NextResponse.json({ error: error.message }, { status: 503 });
  }
  console.error("Site theme API error", error);
  return NextResponse.json({ error: "Could not update the site theme" }, { status: 503 });
}
