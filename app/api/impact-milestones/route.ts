import { NextResponse } from "next/server";

import { authorizeAdminRequest } from "../../../lib/admin-auth";
import { appendAdminActivity } from "../../../lib/admin-store";
import { impactApiError, invalidateImpactMilestones } from "../../../lib/impact-api";
import {
  createImpactMilestone,
  listActiveImpactMilestones,
  listArchivedImpactMilestones,
  listPublishedImpactMilestones,
} from "../../../lib/impact-store";
import {
  parseImpactMilestoneInput,
  publicImpactMilestone,
  type ImpactMilestoneInput,
} from "../../../lib/impact-types";
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

export async function GET(request: Request) {
  try {
    const params = new URL(request.url).searchParams;
    const includeDrafts = params.get("includeDrafts") === "true";
    const includeArchived = params.get("includeArchived") === "true";

    if (includeDrafts || includeArchived) {
      const access = await authorizeAdminRequest(request);
      if ("response" in access) return access.response;
      const milestones = includeArchived
        ? await listArchivedImpactMilestones()
        : await listActiveImpactMilestones();
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
  const access = await authorizeAdminRequest(request, { mutation: true });
  if ("response" in access) return access.response;
  const decision = access.decision!;

  try {
    const body = await request.json();
    const input = parseImpactMilestoneInput(body) as ImpactMilestoneInput;
    const fields = { title: input.title, description: input.description, countryNames: input.countryNames };
    const receipt = typeof body?.translationReceipt === "string" ? body.translationReceipt : "";
    const translationStates = receipt
      ? verifyTranslationReceipt({ receipt, email: access.principal.email, resource: { type: "impact", scope: "", id: "__new__" }, fields })
      : manualTranslationWrites(fields);
    const milestone = await createImpactMilestone(input, access.principal.email, translationStates);
    const revision = await invalidateImpactMilestones();
    await appendAdminActivity({
      actorEmail: access.principal.email, actorRole: access.principal.role,
      action: "impact.created", entityType: "impact", entityId: milestone.id,
      changedFields: Object.keys(input), entityStatus: milestone.status, entityVersion: milestone.version,
    });
    return withRateLimitHeaders(
      NextResponse.json({ ok: true, milestone, revision }, { status: 201 }),
      decision,
    );
  } catch (error) {
    if (error instanceof TranslationReceiptError) return withRateLimitHeaders(NextResponse.json({ error: error.message, code: error.code }, { status: 409 }), decision);
    return withRateLimitHeaders(impactApiError(error), decision);
  }
}
