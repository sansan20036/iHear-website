import { NextResponse } from "next/server";

// @ts-ignore - auth.js is the existing Auth.js configuration.
import { auth } from "../../../auth.js";
import { isAllowedAdmin, normalizeEmail } from "../../../lib/admins";
import { impactApiError, invalidateImpactMilestones } from "../../../lib/impact-api";
import {
  createImpactMilestone,
  listAllImpactMilestones,
  listPublishedImpactMilestones,
} from "../../../lib/impact-store";
import {
  parseImpactMilestoneInput,
  publicImpactMilestone,
  type ImpactMilestoneInput,
} from "../../../lib/impact-types";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const includeDrafts = new URL(request.url).searchParams.get("includeDrafts") === "true";

    if (includeDrafts) {
      const session = await auth();
      const email = normalizeEmail(session?.user?.email);
      if (!isAllowedAdmin(email)) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
      }
      const milestones = await listAllImpactMilestones();
      return NextResponse.json(
        { milestones, admin: true },
        {
          headers: {
            "Cache-Control": "private, no-store",
            "Vercel-CDN-Cache-Control": "no-store",
          },
        },
      );
    }

    const milestones = (await listPublishedImpactMilestones()).map(publicImpactMilestone);
    return NextResponse.json(
      { milestones },
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

export async function POST(request: Request) {
  const session = await auth();
  const email = normalizeEmail(session?.user?.email);
  if (!isAllowedAdmin(email)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const body = await request.json();
    const input = parseImpactMilestoneInput(body) as ImpactMilestoneInput;
    const milestone = await createImpactMilestone(input, email);
    invalidateImpactMilestones();
    return NextResponse.json({ ok: true, milestone }, { status: 201 });
  } catch (error) {
    return impactApiError(error);
  }
}
