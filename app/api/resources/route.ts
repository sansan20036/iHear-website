import { NextResponse } from "next/server";
import { authorizeAdminRequest } from "../../../lib/admin-auth";
import { resourceApiError, resourceSaved, RESOURCE_HEADERS } from "../../../lib/resource-api";
import { createResource, listResources } from "../../../lib/resource-store";
import { parseResourceInput, publicResource } from "../../../lib/resource-types";
import { manualTranslationWrites, verifyTranslationReceipt } from "../../../lib/translation-core";
import { withRateLimitHeaders } from "../../../lib/rate-limit";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try {
    const params = new URL(request.url).searchParams;
    const archived = params.get("includeArchived") === "true";
    const admin = archived || params.get("admin") === "1";
    if (admin) { const access = await authorizeAdminRequest(request); if ("response" in access) return access.response; }
    const items = await listResources(archived ? "archived" : admin ? "active" : "public");
    return NextResponse.json({ items: admin ? items : items.map(publicResource) }, { headers: RESOURCE_HEADERS });
  } catch (error) { return resourceApiError(error); }
}
export async function POST(request: Request) {
  const access = await authorizeAdminRequest(request, { mutation: true });
  if ("response" in access) return access.response;
  try {
    const body = await request.json(), input = parseResourceInput(body);
    const fields = { title: input.title, description: input.description };
    const states = body.translationReceipt ? verifyTranslationReceipt({ receipt: body.translationReceipt, email: access.principal.email, resource: { type: "resource", scope: "", id: "__new__" }, fields }) : manualTranslationWrites(fields);
    const item = await createResource(input, access.principal.email, states);
    return withRateLimitHeaders(await resourceSaved(item, access.principal, "created", 201), access.decision!);
  } catch (error) { return withRateLimitHeaders(resourceApiError(error), access.decision!); }
}
