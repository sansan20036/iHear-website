import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";

// auth.js is intentionally kept at the project root for the existing Auth.js setup.
// @ts-ignore
import { auth } from "../../../../auth.js";
import { isAllowedAdmin, normalizeEmail } from "../../../../lib/admins";
import {
  CONTENT_LOCALES,
  type ContentLocale,
  ContentConflictError,
  publicContentStore,
  updateContentItem,
} from "../../../../lib/content-store";
import { revisionAfterMutation } from "../../../../lib/live-revisions";
import {
  enforceRateLimit,
  RATE_LIMIT_POLICIES,
  withRateLimitHeaders,
} from "../../../../lib/rate-limit";

export const dynamic = "force-dynamic";

function isValidPage(value: unknown) {
  return (
    typeof value === "string" &&
    value.startsWith("/") &&
    value.trim().length > 0 &&
    value.length <= 500
  );
}

function isValidKey(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 5000;
}

function isValidValue(value: unknown) {
  return typeof value === "string" && value.length <= 5000;
}

function isValidLocale(value: unknown): value is ContentLocale {
  return typeof value === "string" && CONTENT_LOCALES.includes(value as ContentLocale);
}

function isValidExpectedUpdatedAt(value: unknown) {
  return value === null || (typeof value === "string" && !Number.isNaN(Date.parse(value)));
}

export async function POST(request: Request) {
  const session = await auth();
  const email = normalizeEmail(session?.user?.email);

  if (!isAllowedAdmin(email)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const decision = await enforceRateLimit(request, {
    ...RATE_LIMIT_POLICIES.adminMutation,
    identifier: email,
  });
  if (decision.limited) return decision.response;
  const respond = <T extends Response>(response: T) => withRateLimitHeaders(response, decision);

  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return respond(NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }));
  }

  const payload = body as Partial<{
    page: string;
    key: string;
    locale: ContentLocale;
    value: string;
    expectedUpdatedAt: string | null;
  }>;

  if (!Object.prototype.hasOwnProperty.call(payload, "expectedUpdatedAt")) {
    return respond(NextResponse.json(
      { error: "Reload the page before editing this content" },
      { status: 428 },
    ));
  }

  if (
    !isValidPage(payload.page) ||
    !isValidKey(payload.key) ||
    !isValidLocale(payload.locale) ||
    !isValidValue(payload.value) ||
    !isValidExpectedUpdatedAt(payload.expectedUpdatedAt)
  ) {
    return respond(NextResponse.json(
      { error: "Expected JSON body with page, key, locale, and value" },
      { status: 400 },
    ));
  }

  try {
    const content = await updateContentItem({
      page: payload.page!.trim(),
      key: payload.key!.trim(),
      locale: payload.locale!,
      value: payload.value,
      updatedBy: email,
      expectedUpdatedAt: payload.expectedUpdatedAt!,
    });
    revalidatePath(payload.page!.trim());
    revalidatePath("/api/content/get");
    revalidatePath("/api/live-revisions");
    const revision = await revisionAfterMutation("content");

    return respond(NextResponse.json({
      ok: true,
      content: publicContentStore(content),
      revision,
    }));
  } catch (error) {
    if (error instanceof ContentConflictError) {
      return respond(NextResponse.json({ error: error.message }, { status: 409 }));
    }
    throw error;
  }
}
