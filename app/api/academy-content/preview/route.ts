import { academyAccessDenied, academyJson, academyNoStore, readAcademyRequestBody, validAcademyOrigin } from "../../../../lib/academy-api";
import { authorizeAdminRequest } from "../../../../lib/admin-auth";
import { readAcademyTemplate, renderAcademyPage } from "../../../../lib/academy-content-page";
import { ACADEMY_LOCALES, AcademyContentValidationError, parseAcademyContentConfig, type AcademyLocale } from "../../../../lib/academy-content-types";
import { withRateLimitHeaders } from "../../../../lib/rate-limit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Renders an unsaved draft with the published page renderer. Nothing is stored.
export async function POST(request: Request) {
  if (!validAcademyOrigin(request)) return academyJson({ error: "A same-origin request is required.", code: "ORIGIN_NOT_ALLOWED" }, 403);
  try {
    const access = await authorizeAdminRequest(request, { mutation: true });
    if ("response" in access) return await academyAccessDenied(access.response);
    const respond = (response: Response) => academyNoStore(withRateLimitHeaders(response, access.decision!));
    try {
      const body = await readAcademyRequestBody(request);
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new AcademyContentValidationError("Submit an Academy preview request.");
      const fields = body as Record<string, unknown>;
      if (Object.keys(fields).length !== 2 || !Object.hasOwn(fields, "config") || !ACADEMY_LOCALES.includes(fields.locale as AcademyLocale)) {
        throw new AcademyContentValidationError("The preview request contains unsupported fields.");
      }
      const locale = fields.locale as AcademyLocale;
      const config = parseAcademyContentConfig(fields.config);
      const html = renderAcademyPage(await readAcademyTemplate(locale), locale, { config, recordVersion: 0 }, { preview: true });
      return respond(academyJson({ ok: true, html }));
    } catch (error) {
      if (error instanceof AcademyContentValidationError) {
        return respond(academyJson({ error: error.message, code: "CONTENT_INVALID_INPUT", field: error.field, reason: error.code }, error.status));
      }
      return respond(academyJson({ error: "The preview is temporarily unavailable.", code: "PREVIEW_UNAVAILABLE" }, 503));
    }
  } catch {
    return academyJson({ error: "The preview is temporarily unavailable.", code: "PREVIEW_UNAVAILABLE" }, 503);
  }
}

function methodNotAllowed() {
  const response = academyJson({ error: "Method not allowed.", code: "METHOD_NOT_ALLOWED" }, 405);
  response.headers.set("Allow", "POST");
  return response;
}
export async function GET() { return methodNotAllowed(); }
export async function PUT() { return methodNotAllowed(); }
export async function PATCH() { return methodNotAllowed(); }
export async function DELETE() { return methodNotAllowed(); }
