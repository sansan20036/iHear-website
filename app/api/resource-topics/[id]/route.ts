import { NextResponse } from "next/server";
import { authorizeAdminRequest } from "../../../../lib/admin-auth";
import { resourceApiError, resourceSaved, resourceReadAccess, publicResourceTopic, RESOURCE_HEADERS } from "../../../../lib/resource-api";
import { archiveResourceTopic, getResourceTopic, updateResourceTopic, listResourceSnapshot } from "../../../../lib/resource-store";
import { parseResourceTopicInput, resourceBody } from "../../../../lib/resource-input";
import { ResourceError, resourceId, resourceVersion } from "../../../../lib/resource-types";
import { manualTranslationUpdateWrites, verifyTranslationReceipt } from "../../../../lib/translation-core";
import { withRateLimitHeaders } from "../../../../lib/rate-limit";
type Context = { params: Promise<{ id: string }> };
export async function GET(request: Request, context: Context) {
  try {
    const access = await resourceReadAccess(request); if ("response" in access) return access.response;
    const id = resourceId((await context.params).id);
    if (access.admin) return NextResponse.json({ topic: await getResourceTopic(id) }, { headers: RESOURCE_HEADERS });
    const topic = (await listResourceSnapshot()).topics.find(topic => topic.id === id);
    if (!topic) throw new ResourceError("Topic not found", 404);
    return NextResponse.json({ topic: publicResourceTopic(topic) }, { headers: RESOURCE_HEADERS });
  } catch (error) { return resourceApiError(error); }
}
export async function PATCH(request: Request, context: Context) {
  const access = await authorizeAdminRequest(request, { mutation: true }); if ("response" in access) return access.response;
  try {
    const id = resourceId((await context.params).id), body = resourceBody(await request.json()), version = resourceVersion(body.version);
    const previous = await getResourceTopic(id);
    if (previous.version !== version) throw new ResourceError("Topic has changed; reload before saving", 409);
    const input = parseResourceTopicInput(body, previous), fields = { title: input.title, description: input.description };
    const states = body.translationReceipt ? verifyTranslationReceipt({ receipt: String(body.translationReceipt), email: access.principal.email, resource: { type: "resource", scope: "topic", id, version }, fields }) : manualTranslationUpdateWrites(fields, { title: previous.title, description: previous.description });
    return withRateLimitHeaders(await resourceSaved(await updateResourceTopic(id, version, input, access.principal.email, states), access.principal, "updated", 200, "topic"), access.decision!);
  } catch (error) { return withRateLimitHeaders(resourceApiError(error), access.decision!); }
}
export async function DELETE(request: Request, context: Context) {
  const access = await authorizeAdminRequest(request, { mutation: true }); if ("response" in access) return access.response;
  try {
    const id = resourceId((await context.params).id), body = resourceBody(await request.json());
    if (body.permanent) throw new ResourceError("Permanent deletion is not supported");
    return withRateLimitHeaders(await resourceSaved(await archiveResourceTopic(id, resourceVersion(body.version), access.principal.email), access.principal, "archived", 200, "topic"), access.decision!);
  } catch (error) { return withRateLimitHeaders(resourceApiError(error), access.decision!); }
}
