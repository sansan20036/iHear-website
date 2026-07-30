import { NextResponse } from "next/server";

import { impactApiError } from "../../../lib/impact-api";
import { getCurrentSiteMetrics } from "../../../lib/impact-store";
import { publicImpactMilestone } from "../../../lib/impact-types";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const milestone = await getCurrentSiteMetrics();
    return NextResponse.json(
      {
        metrics: milestone ? publicImpactMilestone(milestone) : null,
      },
      {
        headers: {
          "Cache-Control": "public, max-age=0, must-revalidate",
          "Vercel-CDN-Cache-Control": "public, s-maxage=1",
        },
      },
    );
  } catch (error) {
    return impactApiError(error);
  }
}
