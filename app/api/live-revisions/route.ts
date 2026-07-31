import { NextResponse } from "next/server";

import { getLiveRevisions } from "../../../lib/live-revisions";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json(
      { version: 1, revisions: await getLiveRevisions() },
      {
        headers: {
          "Cache-Control": "public, max-age=0, must-revalidate",
          "Vercel-CDN-Cache-Control": "public, max-age=3",
        },
      },
    );
  } catch (error) {
    console.error("Live revisions API error", error);
    return NextResponse.json(
      { error: "Could not load live revisions" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
