import { authorizeAdminRequest } from "../../../../lib/admin-auth";
import { resourceApiError, resourceSaved } from "../../../../lib/resource-api";
import { archiveResource, getResource, updateResource } from "../../../../lib/resource-store";
import { parseResourceInput, ResourceError, resourceId, resourceVersion } from "../../../../lib/resource-types";
import { manualTranslationUpdateWrites, verifyTranslationReceipt } from "../../../../lib/translation-core";
import { withRateLimitHeaders } from "../../../../lib/rate-limit";
type Context = { params: Promise<{ id: string }> };
export async function PATCH(request: Request, context: Context) {
  const access = await authorizeAdminRequest(request, { mutation: true });
  if ("response" in access) return access.response;
  try {
    const id = resourceId((await context.params).id), body = await request.json();
    const version = resourceVersion(body.version), input = parseResourceInput(body);
    const previous = await getResource(id);
    if (previous.version !== version) throw new ResourceError("Resource has changed; reload before saving", 409);
    const fields = { title: input.title, description: input.description };
    const states = body.translationReceipt ? verifyTranslationReceipt({ receipt: body.translationReceipt, email: access.principal.email, resource: { type: "resource", scope: "", id, version }, fields }) : manualTranslationUpdateWrites(fields, { title: previous.title, description: previous.description });
    const item = await updateResource(id, version, input, access.principal.email, states);
    return withRateLimitHeaders(await resourceSaved(item, access.principal, "updated"), access.decision!);
  } catch (error) { return withRateLimitHeaders(resourceApiError(error), access.decision!); }
}
export async function DELETE(request: Request, context: Context) {
  const access = await authorizeAdminRequest(request, { mutation: true });
  if ("response" in access) return access.response;
  try {
    const id = resourceId((await context.params).id), body = await request.json();
    if (body.permanent) throw new ResourceError("Permanent deletion is not supported");
    return withRateLimitHeaders(await resourceSaved(await archiveResource(id, resourceVersion(body.version), access.principal.email), access.principal, "archived"), access.decision!);
  } catch (error) { return withRateLimitHeaders(resourceApiError(error), access.decision!); }
}
