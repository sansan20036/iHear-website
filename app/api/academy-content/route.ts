import { academyAccessDenied, academyJson, academyNoStore, readAcademyRequestBody, validAcademyOrigin } from "../../../lib/academy-api";
import { authorizeAdminRequest } from "../../../lib/admin-auth";
import {
  AcademyContentValidationError,
  parseAcademyContentConfig,
  publicAcademyContent,
} from "../../../lib/academy-content-types";
import {
  AcademyContentConflictError,
  readAcademyContent,
  updateAcademyContent,
} from "../../../lib/academy-content-store";
import { withRateLimitHeaders } from "../../../lib/rate-limit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function apiError(error: unknown) {
  if (error instanceof AcademyContentValidationError) {
    return academyJson({ error: error.message, code: "CONTENT_INVALID_INPUT", field: error.field, reason: error.code }, error.status);
  }
  if (error instanceof AcademyContentConflictError) {
    return academyJson({ error: error.message, code: "CONTENT_VERSION_CONFLICT" }, 409);
  }
  // Configuration, malformed persisted state and storage failures share a safe
  // unavailable response. Neither credentials nor audit identity reach clients.
  return academyJson({ error: "Academy content is temporarily unavailable.", code: "CONTENT_UNAVAILABLE" }, 503);
}

export async function GET() {
  try { return academyJson(publicAcademyContent(await readAcademyContent())); }
  catch (error) { return apiError(error); }
}

export async function POST(request: Request) {
  if (!validAcademyOrigin(request)) return academyJson({ error: "A same-origin request is required.", code: "ORIGIN_NOT_ALLOWED" }, 403);
  try {
    // The effective principal is resolved again on every write, including a
    // revoked database editor; no identity or role is accepted from the body.
    const access = await authorizeAdminRequest(request, { mutation: true });
    if ("response" in access) return await academyAccessDenied(access.response);
    const respond = (response: Response) => academyNoStore(withRateLimitHeaders(response, access.decision!));
    try {
      const body = await readAcademyRequestBody(request);
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new AcademyContentValidationError("Submit an Academy content object.");
      const fields = body as Record<string, unknown>;
      if (!Object.hasOwn(fields, "expectedVersion")) {
        return respond(academyJson({ error: "Reload Academy content before saving.", code: "CONTENT_VERSION_REQUIRED" }, 428));
      }
      if (Object.keys(fields).length !== 2 || !Object.hasOwn(fields, "config")) throw new AcademyContentValidationError("The request contains unsupported fields.");
      if (typeof fields.expectedVersion !== "number" || !Number.isSafeInteger(fields.expectedVersion)
        || fields.expectedVersion < 1 || fields.expectedVersion > 2_147_483_647) {
        throw new AcademyContentValidationError("Reload the current Academy content before saving.", "expectedVersion");
      }
      const config = parseAcademyContentConfig(fields.config);
      const record = await updateAcademyContent({
        config, expectedVersion: fields.expectedVersion, updatedBy: access.principal.email,
        updatedByRole: access.principal.role,
      });
      return respond(academyJson({ ok: true, ...publicAcademyContent(record) }));
    } catch (error) { return respond(apiError(error)); }
  } catch (error) { return apiError(error); }
}

export async function HEAD() {
  const response = await GET();
  return new Response(null, { status: response.status, headers: response.headers });
}

function methodNotAllowed() {
  const response = academyJson({ error: "Method not allowed.", code: "METHOD_NOT_ALLOWED" }, 405);
  response.headers.set("Allow", "GET, HEAD, POST");
  return response;
}
export async function PUT() { return methodNotAllowed(); }
export async function PATCH() { return methodNotAllowed(); }
export async function DELETE() { return methodNotAllowed(); }
export async function OPTIONS() { return methodNotAllowed(); }
