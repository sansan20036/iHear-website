import { NextResponse } from "next/server";
import { authorizeAdminRequest } from "../../../lib/admin-auth";
import { resourceApiError, resourceSaved, resourceReadAccess, publicResourceTopic, RESOURCE_HEADERS } from "../../../lib/resource-api";
import { createResource, listResourceSnapshot } from "../../../lib/resource-store";
import { publicResource, resourceId } from "../../../lib/resource-types";
import { parseResourceItemInput, resourceBody } from "../../../lib/resource-input";
import { manualTranslationWrites, verifyTranslationReceipt } from "../../../lib/translation-core";
import { withRateLimitHeaders } from "../../../lib/rate-limit";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try {
    const access = await resourceReadAccess(request); if ("response" in access) return access.response;
    const topicId = new URL(request.url).searchParams.get("topicId"); if (topicId !== null) resourceId(topicId);
    const data = await listResourceSnapshot(access.mode);
    if (!access.admin && data.guidesTakeover === "unavailable") return NextResponse.json({ error: "Resources are temporarily unavailable. Please try again." }, { status: 503, headers: RESOURCE_HEADERS });
    const items = topicId === null ? data.items : data.items.filter(item => item.topicId === topicId);
    const topics = topicId === null ? data.topics : data.topics.filter(topic => topic.id === topicId);
    return NextResponse.json({ items: access.admin ? items : items.map(publicResource), topics: access.admin ? topics : topics.map(publicResourceTopic), guidesTakeover: data.guidesTakeover }, { headers: RESOURCE_HEADERS });
  } catch (error) { return resourceApiError(error); }
}
export async function POST(request: Request) {
  const access = await authorizeAdminRequest(request, { mutation: true });
  if ("response" in access) return access.response;
  try {
    const body = resourceBody(await request.json()), input = parseResourceItemInput(body);
    const fields = { title: input.title, description: input.description };
    const states = body.translationReceipt ? verifyTranslationReceipt({ receipt: String(body.translationReceipt), email: access.principal.email, resource: { type: "resource", scope: "", id: "__new__" }, fields }) : manualTranslationWrites(fields);
    const item = await createResource(input, access.principal.email, states);
    return withRateLimitHeaders(await resourceSaved(item, access.principal, "created", 201), access.decision!);
  } catch (error) { return withRateLimitHeaders(resourceApiError(error), access.decision!); }
}
