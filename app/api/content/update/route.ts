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
  updateContentItems,
} from "../../../../lib/content-store";
import { isCatalogContent, validateCatalogValue } from "../../../../lib/content-catalog";
import { revisionAfterMutation } from "../../../../lib/live-revisions";
import {
  manualTranslationWrites,
  TranslationReceiptError,
  verifyTranslationReceipt,
} from "../../../../lib/translation-core";
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

function isSameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try { return new URL(origin).origin === new URL(request.url).origin; } catch { return false; }
}

export async function POST(request: Request) {
  if (!isSameOrigin(request)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const session = await auth();
  const email = normalizeEmail(session?.user?.email);

  if (!(await isAllowedAdmin(email))) {
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
    values: Record<ContentLocale, string>;
    expectedUpdatedAtByLocale: Record<ContentLocale, string | null>;
    translationReceipt: string;
  }>;

  if (payload.values && payload.expectedUpdatedAtByLocale) {
    if (!isValidPage(payload.page) || !isValidKey(payload.key) || !isCatalogContent(payload.page!, payload.key!)) {
      return respond(NextResponse.json({ error: "Unknown content slot" }, { status: 400 }));
    }
    const valid = CONTENT_LOCALES.every((locale) =>
      typeof payload.values?.[locale] === "string" &&
      validateCatalogValue(payload.page!, payload.key!, payload.values[locale]) &&
      isValidExpectedUpdatedAt(payload.expectedUpdatedAtByLocale?.[locale])
    );
    if (!valid) return respond(NextResponse.json({ error: "Invalid localized content fields" }, { status: 400 }));
    try {
      const localizedFields = { value: payload.values };
      const translationStates = payload.translationReceipt
        ? verifyTranslationReceipt({
            receipt: payload.translationReceipt,
            email,
            resource: {
              type: "content",
              scope: payload.page!,
              id: payload.key!,
              version: payload.expectedUpdatedAtByLocale.en,
            },
            fields: localizedFields,
          })
        : manualTranslationWrites(localizedFields);
      const content = await updateContentItems({
        page: payload.page!, key: payload.key!, values: payload.values,
        expectedUpdatedAt: payload.expectedUpdatedAtByLocale,
        updatedBy: email,
        translationStates,
      });
      revalidatePath(payload.page! === "/__global__" ? "/" : payload.page!);
      revalidatePath("/api/content/get");
      revalidatePath("/api/live-revisions");
      const revision = await revisionAfterMutation("content");
      return respond(NextResponse.json({ ok: true, content: publicContentStore(content), revision }));
    } catch (error) {
      if (error instanceof TranslationReceiptError) return respond(NextResponse.json({ error: error.message, code: error.code }, { status: 409 }));
      if (error instanceof ContentConflictError) return respond(NextResponse.json({ error: error.message }, { status: 409 }));
      throw error;
    }
  }

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
