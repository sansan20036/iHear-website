import { NextResponse } from "next/server";

// @ts-ignore - auth.js is the existing Auth.js configuration.
import { auth } from "../auth.js";
import { ACADEMY_CONTENT_MAX_BODY_BYTES, AcademyContentValidationError } from "./academy-content-types";
import { normalizeEmail } from "./admins";

export function academyNoStore<T extends Response>(response: T) {
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("Vercel-CDN-Cache-Control", "no-store");
  return response;
}

export function academyJson(body: object, status = 200) {
  return academyNoStore(NextResponse.json(body, { status }));
}

/** Writes require an explicit Origin header that matches this site exactly. */
export function validAcademyOrigin(request: Request) {
  const raw = request.headers.get("origin");
  if (!raw || raw === "null") return false;
  try {
    const origin = new URL(raw);
    return raw === origin.origin && ["https:", "http:"].includes(origin.protocol)
      && origin.origin === new URL(request.url).origin;
  } catch { return false; }
}

/**
 * Turns the shared admin authorization failure into an explicit reason:
 * 401 when no Google session exists (never signed in or expired), 403 when a
 * signed-in account has no current administrator role. Other failures (for
 * example rate limiting) pass through unchanged.
 */
export async function academyAccessDenied(response: Response) {
  if (response.status !== 403) return academyNoStore(response);
  let signedIn = false;
  try { signedIn = Boolean(normalizeEmail((await auth())?.user?.email)); } catch { /* treated as signed out */ }
  return signedIn
    ? academyJson({ error: "Administrator access is required.", code: "FORBIDDEN" }, 403)
    : academyJson({ error: "Sign in again to continue.", code: "SIGN_IN_REQUIRED" }, 401);
}

export async function readAcademyRequestBody(request: Request): Promise<unknown> {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?\s*$/i.test(request.headers.get("content-type") || "")) {
    throw new AcademyContentValidationError("Submit JSON Academy content.", "config", "invalid_request", 415);
  }
  const declared = request.headers.get("content-length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > ACADEMY_CONTENT_MAX_BODY_BYTES)) {
    throw new AcademyContentValidationError("The Academy request is too large.", "config", "too_large", 413);
  }
  if (!request.body) throw new AcademyContentValidationError("Submit JSON Academy content.");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > ACADEMY_CONTENT_MAX_BODY_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new AcademyContentValidationError("The Academy request is too large.", "config", "too_large", 413);
      }
      chunks.push(chunk.value);
    }
    const data = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data));
  } catch (error) {
    if (error instanceof AcademyContentValidationError) throw error;
    throw new AcademyContentValidationError("Submit valid UTF-8 JSON Academy content.");
  } finally { reader.releaseLock(); }
}
