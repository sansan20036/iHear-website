import { revalidatePath } from "next/cache";
import { NextResponse } from "next/server";

import { revisionAfterMutation } from "./live-revisions";
import { SiteMediaImageError } from "./site-media-errors";
import { SiteMediaConfigurationError, SiteMediaConflictError } from "./site-media-store";
import { SiteMediaStorageConfigurationError, SiteMediaStorageError } from "./site-media-storage";

export async function invalidateSiteMedia() {
  for (const path of ["/", "/api/site-media", "/api/live-revisions"]) {
    try {
      revalidatePath(path);
    } catch (error) {
      console.error(`Could not revalidate ${path}`, error);
    }
  }
  try {
    return await revisionAfterMutation("content");
  } catch (error) {
    console.error("Could not read site-media revision", error);
    return null;
  }
}

export function siteMediaApiError(error: unknown) {
  if (error instanceof SiteMediaImageError) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }
  if (error instanceof SiteMediaConflictError) {
    return NextResponse.json({ error: error.message }, { status: 409 });
  }
  if (error instanceof SiteMediaConfigurationError || error instanceof SiteMediaStorageConfigurationError) {
    return NextResponse.json({ error: error.message }, { status: 503 });
  }
  if (error instanceof SiteMediaStorageError) {
    console.error("Site media storage error", error);
    return NextResponse.json({ error: "Could not store the image" }, { status: 503 });
  }
  console.error("Site media API error", error);
  return NextResponse.json({ error: "Could not update the image" }, { status: 503 });
}
