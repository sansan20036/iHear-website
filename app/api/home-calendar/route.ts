import { academyAccessDenied, academyJson, academyNoStore, validAcademyOrigin } from "../../../lib/academy-api";
import { authorizeAdminRequest } from "../../../lib/admin-auth";
import { HomeCalendarConflictError, readHomeCalendar, updateHomeCalendar } from "../../../lib/home-calendar-store";
import {
  HOME_CALENDAR_MAX_BODY_BYTES,
  HomeCalendarValidationError,
  parseHomeCalendarConfig,
  publicHomeCalendar,
} from "../../../lib/home-calendar-types";
import { withRateLimitHeaders } from "../../../lib/rate-limit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function apiError(error: unknown) {
  if (error instanceof HomeCalendarValidationError) {
    return academyJson({ error: error.message, code: "CALENDAR_INVALID_INPUT", field: error.field, reason: error.code }, error.status);
  }
  if (error instanceof HomeCalendarConflictError) {
    return academyJson({ error: error.message, code: "CALENDAR_VERSION_CONFLICT" }, 409);
  }
  // Configuration, malformed stored data and storage failures share one safe answer.
  return academyJson({ error: "The calendar is temporarily unavailable.", code: "CALENDAR_UNAVAILABLE" }, 503);
}

async function readBody(request: Request): Promise<unknown> {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?\s*$/i.test(request.headers.get("content-type") || "")) {
    throw new HomeCalendarValidationError("Submit the calendar as JSON.", "config", "invalid_request", 415);
  }
  const declared = request.headers.get("content-length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > HOME_CALENDAR_MAX_BODY_BYTES)) {
    throw new HomeCalendarValidationError("The calendar request is too large.", "config", "too_large", 413);
  }
  if (!request.body) throw new HomeCalendarValidationError("Submit the calendar as JSON.");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > HOME_CALENDAR_MAX_BODY_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new HomeCalendarValidationError("The calendar request is too large.", "config", "too_large", 413);
      }
      chunks.push(chunk.value);
    }
    const data = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data));
  } catch (error) {
    if (error instanceof HomeCalendarValidationError) throw error;
    throw new HomeCalendarValidationError("Submit valid UTF-8 JSON.");
  } finally { reader.releaseLock(); }
}

export async function GET() {
  try { return academyJson(publicHomeCalendar(await readHomeCalendar())); }
  catch (error) { return apiError(error); }
}

export async function POST(request: Request) {
  if (!validAcademyOrigin(request)) return academyJson({ error: "A same-origin request is required.", code: "ORIGIN_NOT_ALLOWED" }, 403);
  try {
    // The administrator is resolved again on every save (a disabled editor loses access at
    // once); no identity or role is read from the body.
    const access = await authorizeAdminRequest(request, { mutation: true });
    if ("response" in access) return await academyAccessDenied(access.response);
    const respond = (response: Response) => academyNoStore(withRateLimitHeaders(response, access.decision!));
    try {
      const body = await readBody(request);
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new HomeCalendarValidationError("Submit a calendar object.");
      const fields = body as Record<string, unknown>;
      if (!Object.hasOwn(fields, "expectedVersion")) {
        return respond(academyJson({ error: "Reload the calendar before saving.", code: "CALENDAR_VERSION_REQUIRED" }, 428));
      }
      if (Object.keys(fields).length !== 2 || !Object.hasOwn(fields, "config")) throw new HomeCalendarValidationError("The request contains unsupported fields.");
      if (typeof fields.expectedVersion !== "number" || !Number.isSafeInteger(fields.expectedVersion)
        || fields.expectedVersion < 1 || fields.expectedVersion > 2_147_483_647) {
        throw new HomeCalendarValidationError("Reload the calendar before saving.", "expectedVersion");
      }
      const record = await updateHomeCalendar({
        config: parseHomeCalendarConfig(fields.config), expectedVersion: fields.expectedVersion,
        updatedBy: access.principal.email, updatedByRole: access.principal.role,
      });
      return respond(academyJson({ ok: true, ...publicHomeCalendar(record) }));
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
