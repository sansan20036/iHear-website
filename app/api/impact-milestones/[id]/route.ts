import { NextResponse } from "next/server";

// @ts-ignore - auth.js is the existing Auth.js configuration.
import { auth } from "../../../../auth.js";
import { isAllowedAdmin, normalizeEmail } from "../../../../lib/admins";
import {
  impactApiError,
  invalidateImpactMilestones,
  isValidImpactId,
} from "../../../../lib/impact-api";
import {
  deleteImpactMilestone,
  updateImpactMilestone,
} from "../../../../lib/impact-store";
import {
  parseImpactMilestoneInput,
  type ImpactMilestoneUpdateInput,
} from "../../../../lib/impact-types";
import {
  enforceRateLimit,
  RATE_LIMIT_POLICIES,
  withRateLimitHeaders,
} from "../../../../lib/rate-limit";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

async function authorizedEmail() {
  const session = await auth();
  const email = normalizeEmail(session?.user?.email);
  return isAllowedAdmin(email) ? email : "";
}

export async function PATCH(request: Request, context: RouteContext) {
  const email = await authorizedEmail();
  if (!email) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const decision = await enforceRateLimit(request, {
    ...RATE_LIMIT_POLICIES.adminMutation,
    identifier: email,
  });
  if (decision.limited) return decision.response;
  const respond = <T extends Response>(response: T) => withRateLimitHeaders(response, decision);

  try {
    const { id } = await context.params;
    if (!isValidImpactId(id)) {
      return respond(NextResponse.json({ error: "Invalid milestone id" }, { status: 400 }));
    }
    const body = await request.json();
    const input = parseImpactMilestoneInput(body, {
      requireVersion: true,
    }) as ImpactMilestoneUpdateInput;
    const milestone = await updateImpactMilestone(id, input, email);
    const revision = await invalidateImpactMilestones();
    return respond(NextResponse.json({ ok: true, milestone, revision }));
  } catch (error) {
    return respond(impactApiError(error));
  }
}

export async function DELETE(request: Request, context: RouteContext) {
  const email = await authorizedEmail();
  if (!email) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const decision = await enforceRateLimit(request, {
    ...RATE_LIMIT_POLICIES.adminMutation,
    identifier: email,
  });
  if (decision.limited) return decision.response;
  const respond = <T extends Response>(response: T) => withRateLimitHeaders(response, decision);

  try {
    const { id } = await context.params;
    if (!isValidImpactId(id)) {
      return respond(NextResponse.json({ error: "Invalid milestone id" }, { status: 400 }));
    }
    const body = await request.json().catch(() => ({}));
    const version = Number(body.version);
    if (!Number.isInteger(version) || version < 1) {
      return respond(NextResponse.json({ error: "A valid version is required" }, { status: 400 }));
    }
    const deletedId = await deleteImpactMilestone(id, version);
    const revision = await invalidateImpactMilestones();
    return respond(NextResponse.json({ ok: true, deletedId, revision }));
  } catch (error) {
    return respond(impactApiError(error));
  }
}
