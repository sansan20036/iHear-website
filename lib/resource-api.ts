import { NextResponse } from "next/server";
import { appendAdminActivity } from "./admin-store";
import { revisionAfterMutation } from "./live-revisions";
import { ResourceError, type ResourceLink } from "./resource-types";
import { TranslationReceiptError } from "./translation-core";
import type { AdminPrincipal } from "./admins";

export const RESOURCE_HEADERS = { "Cache-Control": "no-store", "Vercel-CDN-Cache-Control": "no-store" };
export function resourceApiError(error: unknown) {
  if (error instanceof TranslationReceiptError) return NextResponse.json({ error: error.message, code: "TRANSLATION_PREVIEW_REQUIRED" }, { status: 409, headers: RESOURCE_HEADERS });
  if (error instanceof ResourceError) return NextResponse.json({ error: error.message, code: error.code || (error.status === 409 ? "RESOURCE_VERSION_CONFLICT" : undefined) }, { status: error.status, headers: RESOURCE_HEADERS });
  if (error instanceof SyntaxError) return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  console.error("Resource operation failed", error);
  return NextResponse.json({ error: "Resource operation failed" }, { status: 500, headers: RESOURCE_HEADERS });
}
export async function resourceSaved(item: ResourceLink, principal: AdminPrincipal, action: string, status = 200) {
  const revision = await revisionAfterMutation("content");
  await appendAdminActivity({ actorEmail: principal.email, actorRole: principal.role, action: `resource.${action}`, entityType: "resource", entityId: item.id, changedFields: action === "updated" || action === "created" ? ["category", "title", "description", "url", "sortOrder", "status"] : ["status"], entityStatus: item.status, entityVersion: item.version });
  return NextResponse.json({ ok: true, item, revision }, { status, headers: RESOURCE_HEADERS });
}
