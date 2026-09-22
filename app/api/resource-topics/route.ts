import { NextResponse } from "next/server";
import { authorizeAdminRequest } from "../../../lib/admin-auth";
import { resourceApiError, resourceSaved, resourceReadAccess, publicResourceTopic, RESOURCE_HEADERS } from "../../../lib/resource-api";
import { createResourceTopic, listResourceSnapshot } from "../../../lib/resource-store";
import { parseResourceTopicInput, resourceBody } from "../../../lib/resource-input";
import { manualTranslationWrites, verifyTranslationReceipt } from "../../../lib/translation-core";
import { withRateLimitHeaders } from "../../../lib/rate-limit";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try {
    const access = await resourceReadAccess(request); if ("response" in access) return access.response;
    const { topics } = await listResourceSnapshot(access.mode);
    return NextResponse.json({ topics: access.admin ? topics : topics.map(publicResourceTopic) }, { headers: RESOURCE_HEADERS });
  } catch (error) { return resourceApiError(error); }
}
export async function POST(request: Request) {
  const access = await authorizeAdminRequest(request, { mutation: true }); if ("response" in access) return access.response;
  try {
    const body = resourceBody(await request.json()), input = parseResourceTopicInput(body);
    const fields = { title: input.title, description: input.description };
    const states = body.translationReceipt ? verifyTranslationReceipt({ receipt: String(body.translationReceipt), email: access.principal.email, resource: { type: "resource", scope: "topic", id: "__new__" }, fields }) : manualTranslationWrites(fields);
    return withRateLimitHeaders(await resourceSaved(await createResourceTopic(input, access.principal.email, states), access.principal, "created", 201, "topic"), access.decision!);
  } catch (error) { return withRateLimitHeaders(resourceApiError(error), access.decision!); }
}
