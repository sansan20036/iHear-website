import { authorizeAdminRequest } from "../../../../../lib/admin-auth";
import { resourceApiError, resourceSaved } from "../../../../../lib/resource-api";
import { archiveResourceTopic } from "../../../../../lib/resource-store";
import { resourceBody } from "../../../../../lib/resource-input";
import { resourceId, resourceVersion } from "../../../../../lib/resource-types";
import { withRateLimitHeaders } from "../../../../../lib/rate-limit";
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const access = await authorizeAdminRequest(request, { mutation: true }); if ("response" in access) return access.response;
  try {
    const id = resourceId((await context.params).id), body = resourceBody(await request.json());
    return withRateLimitHeaders(await resourceSaved(await archiveResourceTopic(id, resourceVersion(body.version), access.principal.email, true), access.principal, "restored", 200, "topic"), access.decision!);
  } catch (error) { return withRateLimitHeaders(resourceApiError(error), access.decision!); }
}
