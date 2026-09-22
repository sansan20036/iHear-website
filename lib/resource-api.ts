import { NextResponse } from "next/server";
import { appendAdminActivity } from "./admin-store";
import { revisionAfterMutation } from "./live-revisions";
import { ResourceError } from "./resource-types";
import type { ResourceItem, ResourceTopic } from "./resource-topic-model";
import { authorizeAdminRequest } from "./admin-auth";
import { TranslationReceiptError } from "./translation-core";
import type { AdminPrincipal } from "./admins";

export const RESOURCE_HEADERS = { "Cache-Control": "no-store", "Vercel-CDN-Cache-Control": "no-store" };
export function resourceApiError(error: unknown) {
  if (error instanceof TranslationReceiptError) return NextResponse.json({ error: error.message, code: "TRANSLATION_PREVIEW_REQUIRED" }, { status: 409, headers: RESOURCE_HEADERS });
  if (error instanceof ResourceError) return NextResponse.json({ error: error.message, code: error.code || (error.status === 409 ? "RESOURCE_VERSION_CONFLICT" : undefined) }, { status: error.status, headers: RESOURCE_HEADERS });
  if (error instanceof SyntaxError) return NextResponse.json({ error: "Invalid JSON" }, { status: 400, headers: RESOURCE_HEADERS });
  const databaseCode = (error as { code?: string })?.code;
  if (databaseCode === "23505") return NextResponse.json({ error: "Resource identifier is already in use; retry", code: "RESOURCE_UNIQUE_CONFLICT" }, { status: 409, headers: RESOURCE_HEADERS });
  if (databaseCode === "23503" || databaseCode === "23514" || databaseCode === "23502") return NextResponse.json({ error: "Resource data violates a storage constraint", code: "INVALID_RESOURCE_DATA" }, { status: 400, headers: RESOURCE_HEADERS });
  if (databaseCode === "42P01" || databaseCode === "42703") return NextResponse.json({ error: "Resource schema is not ready", code: "RESOURCE_SCHEMA_NOT_READY" }, { status: 503, headers: RESOURCE_HEADERS });
  console.error("Resource operation failed", error);
  return NextResponse.json({ error: "Resource operation failed" }, { status: 500, headers: RESOURCE_HEADERS });
}
export function publicResourceTopic(topic: ResourceTopic) {
  return { id: topic.id, title: topic.title, description: topic.description, slug: topic.slug, sortOrder: topic.sortOrder };
}
export async function resourceReadAccess(request: Request) {
  const params = new URL(request.url).searchParams;
  const archived = params.get("includeArchived") === "true", admin = archived || params.get("admin") === "1";
  if (admin) {
    const access = await authorizeAdminRequest(request);
    if ("response" in access) return access;
  }
  return { admin, mode: archived ? "archived" as const : admin ? "active" as const : "public" as const };
}
export async function resourceSaved(item: ResourceItem | ResourceTopic, principal: AdminPrincipal, action: string, status = 200, kind: "item" | "topic" = "item") {
  const revision = await revisionAfterMutation("content");
  await appendAdminActivity({ actorEmail: principal.email, actorRole: principal.role, action: `resource.${kind === "topic" ? "topic." : ""}${action}`, entityType: "resource", entityId: item.id, changedFields: action === "updated" || action === "created" ? kind === "topic" ? ["title", "description", "slug", "sortOrder", "status"] : ["category", "topicId", "type", "title", "description", "url", "sortOrder", "status"] : ["status"], entityStatus: item.status, entityVersion: item.version });
  return NextResponse.json({ ok: true, [kind]: item, revision }, { status, headers: RESOURCE_HEADERS });
}
