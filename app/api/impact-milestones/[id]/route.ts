import { NextResponse } from "next/server";

import { authorizeAdminRequest } from "../../../../lib/admin-auth";
import { appendAdminActivity } from "../../../../lib/admin-store";
import {
  impactApiError,
  invalidateImpactMilestones,
  isValidImpactId,
} from "../../../../lib/impact-api";
import {
  deleteImpactMilestone,
  trashImpactMilestone,
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
import {
  manualTranslationWrites,
  TranslationReceiptError,
  verifyTranslationReceipt,
} from "../../../../lib/translation-core";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, context: RouteContext) {
  const access = await authorizeAdminRequest(request, { mutation: true });
  if ("response" in access) return access.response;
  const decision = access.decision!;
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
    const fields = { title: input.title, description: input.description, countryNames: input.countryNames };
    const receipt = typeof body?.translationReceipt === "string" ? body.translationReceipt : "";
    const translationStates = receipt
      ? verifyTranslationReceipt({ receipt, email: access.principal.email, resource: { type: "impact", scope: "", id, version: input.version }, fields })
      : manualTranslationWrites(fields);
    const milestone = await updateImpactMilestone(id, input, access.principal.email, translationStates);
    const revision = await invalidateImpactMilestones();
    await appendAdminActivity({
      actorEmail: access.principal.email, actorRole: access.principal.role,
      action: "impact.updated", entityType: "impact", entityId: id,
      changedFields: Object.keys(input).filter((key) => key !== "version"),
      entityStatus: milestone.status, entityVersion: milestone.version,
    });
    return respond(NextResponse.json({ ok: true, milestone, revision }));
  } catch (error) {
    if (error instanceof TranslationReceiptError) return respond(NextResponse.json({ error: error.message, code: error.code }, { status: 409 }));
    return respond(impactApiError(error));
  }
}

export async function DELETE(request: Request, context: RouteContext) {
  const body = await request.json().catch(() => ({}));
  const permanent = body?.permanent === true;
  const access = await authorizeAdminRequest(request, { mutation: true, owner: permanent });
  if ("response" in access) return access.response;
  const decision = access.decision!;
  const respond = <T extends Response>(response: T) => withRateLimitHeaders(response, decision);

  try {
    const { id } = await context.params;
    if (!isValidImpactId(id)) {
      return respond(NextResponse.json({ error: "Invalid milestone id" }, { status: 400 }));
    }
    const version = Number(body.version);
    if (!Number.isInteger(version) || version < 1) {
      return respond(NextResponse.json({ error: "A valid version is required" }, { status: 400 }));
    }
    const result = permanent
      ? await deleteImpactMilestone(id, version)
      : await trashImpactMilestone(id, version, access.principal.email);
    const revision = await invalidateImpactMilestones();
    await appendAdminActivity({
      actorEmail: access.principal.email, actorRole: access.principal.role,
      action: permanent ? "impact.deleted_permanently" : "impact.trashed",
      entityType: "impact", entityId: id, changedFields: permanent ? [] : ["status", "archivedAt"],
      entityStatus: permanent ? "deleted" : "archived",
      entityVersion: permanent ? null : (typeof result === "string" ? version : result.version),
    });
    return respond(NextResponse.json({ ok: true, deletedId: id, milestone: typeof result === "string" ? undefined : result, revision }));
  } catch (error) {
    return respond(impactApiError(error));
  }
}
