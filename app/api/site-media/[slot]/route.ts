import { NextResponse } from "next/server";

// @ts-ignore - auth.js is the existing Auth.js configuration.
import { auth } from "../../../../auth.js";
import { isAllowedAdmin, normalizeEmail } from "../../../../lib/admins";
import { invalidateSiteMedia, siteMediaApiError } from "../../../../lib/site-media-api";
import {
  MULTIPART_MAX_BYTES,
  processSiteMediaImage,
} from "../../../../lib/site-media-image";
import {
  deleteSiteMediaAsset,
  replaceSiteMediaAsset,
  updateSiteMediaAssetMetadata,
} from "../../../../lib/site-media-store";
import {
  removeSiteMediaObjects,
  uploadSiteMediaVariants,
} from "../../../../lib/site-media-storage";
import {
  isSiteMediaSlot,
  publicSiteMediaAsset,
  type SiteMediaAlt,
} from "../../../../lib/site-media-types";
import {
  enforceRateLimit,
  RATE_LIMIT_POLICIES,
  withRateLimitHeaders,
} from "../../../../lib/rate-limit";
import {
  manualTranslationWrites,
  TranslationReceiptError,
  verifyTranslationReceipt,
} from "../../../../lib/translation-core";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 15;

type RouteContext = { params: Promise<{ slot: string }> };

function isSameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try {
    return new URL(origin).origin === new URL(request.url).origin;
  } catch {
    return false;
  }
}

function parseVersion(value: FormDataEntryValue | unknown) {
  const text = typeof value === "string" ? value : "";
  if (!/^\d+$/.test(text)) return null;
  const version = Number(text);
  return Number.isSafeInteger(version) && version >= 0 ? version : null;
}

function parseFocal(value: FormDataEntryValue | unknown): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 100 ? parsed : null;
}

function parseZoom(value: FormDataEntryValue | unknown): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 100 && parsed <= 250 ? parsed : null;
}

function parseAlt(form: FormData): SiteMediaAlt | null {
  const values = {
    en: form.get("altEn"),
    zhHant: form.get("altZhHant"),
    zhHans: form.get("altZhHans"),
  };
  if (Object.values(values).some((value) => typeof value !== "string")) return null;
  const alt = {
    en: String(values.en).trim(),
    zhHant: String(values.zhHant).trim(),
    zhHans: String(values.zhHans).trim(),
  };
  return Object.values(alt).every((value) => value.length >= 2 && value.length <= 300)
    ? alt
    : null;
}

function parseAltObject(value: unknown): SiteMediaAlt | null {
  if (!value || typeof value !== "object") return null;
  const input = value as Record<string, unknown>;
  const alt = {
    en: typeof input.en === "string" ? input.en.trim() : "",
    zhHant: typeof input.zhHant === "string" ? input.zhHant.trim() : "",
    zhHans: typeof input.zhHans === "string" ? input.zhHans.trim() : "",
  };
  return Object.values(alt).every((item) => item.length >= 2 && item.length <= 300) ? alt : null;
}

async function authorized(request: Request, policy: typeof RATE_LIMIT_POLICIES.adminMutation | typeof RATE_LIMIT_POLICIES.mediaUpload) {
  if (!isSameOrigin(request)) {
    return { response: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  }
  const session = await auth();
  const email = normalizeEmail(session?.user?.email);
  if (!(await isAllowedAdmin(email))) {
    return { response: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  }
  const decision = await enforceRateLimit(request, { ...policy, identifier: email });
  if (decision.limited) return { response: decision.response };
  return { email, decision };
}

export async function POST(request: Request, context: RouteContext) {
  const access = await authorized(request, RATE_LIMIT_POLICIES.mediaUpload);
  if ("response" in access) return access.response;
  const respond = <T extends Response>(response: T) => withRateLimitHeaders(response, access.decision);
  const { slot } = await context.params;
  if (!isSiteMediaSlot(slot)) return respond(NextResponse.json({ error: "Unknown image slot" }, { status: 400 }));

  const contentLength = Number(request.headers.get("content-length") || 0);
  if (Number.isFinite(contentLength) && contentLength > MULTIPART_MAX_BYTES) {
    return respond(NextResponse.json({ error: "The upload payload is too large" }, { status: 413 }));
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return respond(NextResponse.json({ error: "Invalid multipart form" }, { status: 400 }));
  }

  const expectedVersion = parseVersion(form.get("expectedVersion"));
  if (form.get("expectedVersion") === null) {
    return respond(NextResponse.json({ error: "Reload the page before changing this image" }, { status: 428 }));
  }
  const alt = parseAlt(form);
  const focalX = parseFocal(form.get("focalX"));
  const focalY = parseFocal(form.get("focalY"));
  const zoom = parseZoom(form.get("zoom") ?? "100");
  const file = form.get("file");
  if (expectedVersion === null || !alt || focalX === null || focalY === null || zoom === null || !(file instanceof File)) {
    return respond(NextResponse.json({ error: "Invalid image upload fields" }, { status: 400 }));
  }

  let uploadedPaths: string[] = [];
  try {
    const avatar = slot.startsWith("team.") && slot.endsWith(".avatar");
    const processed = await processSiteMediaImage(file, { avatar });
    const variants = await uploadSiteMediaVariants(slot, processed);
    uploadedPaths = variants.map((variant) => variant.storagePath);
    let result;
    try {
      const receipt = typeof form.get("translationReceipt") === "string" ? String(form.get("translationReceipt")) : "";
      const fields = { alt };
      const translationStates = receipt
        ? verifyTranslationReceipt({ receipt, email: access.email, resource: { type: "media", scope: "", id: slot, version: expectedVersion }, fields })
        : manualTranslationWrites(fields);
      result = await replaceSiteMediaAsset({
        slot,
        alt,
        focalX: avatar ? 50 : focalX,
        focalY: avatar ? 50 : focalY,
        zoom: avatar ? 100 : zoom,
        expectedVersion,
        updatedBy: access.email,
        variants,
        translationStates,
      });
    } catch (error) {
      await removeSiteMediaObjects(uploadedPaths).catch((cleanupError) => {
        console.error("Could not clean up rejected site-media upload", cleanupError);
      });
      throw error;
    }

    if (result.previousStoragePaths.length) {
      await removeSiteMediaObjects(result.previousStoragePaths).catch((cleanupError) => {
        console.error("Could not remove previous site-media objects", cleanupError);
      });
    }
    const revision = await invalidateSiteMedia();
    return respond(NextResponse.json({
      ok: true,
      item: publicSiteMediaAsset(result.asset),
      revision,
    }));
  } catch (error) {
    if (error instanceof TranslationReceiptError) return respond(NextResponse.json({ error: error.message, code: error.code }, { status: 409 }));
    return respond(siteMediaApiError(error));
  }
}

export async function PATCH(request: Request, context: RouteContext) {
  const access = await authorized(request, RATE_LIMIT_POLICIES.adminMutation);
  if ("response" in access) return access.response;
  const respond = <T extends Response>(response: T) => withRateLimitHeaders(response, access.decision);
  const { slot } = await context.params;
  if (!isSiteMediaSlot(slot)) return respond(NextResponse.json({ error: "Unknown image slot" }, { status: 400 }));

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return respond(NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }));
  }
  const payload = body as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(payload, "expectedVersion")) {
    return respond(NextResponse.json({ error: "Reload the page before changing this image" }, { status: 428 }));
  }
  const expectedVersion = parseVersion(String(payload.expectedVersion));
  const alt = parseAltObject(payload.alt);
  const focalX = parseFocal(payload.focalX);
  const focalY = parseFocal(payload.focalY);
  const zoom = parseZoom(payload.zoom);
  if (expectedVersion === null || expectedVersion === 0 || !alt || focalX === null || focalY === null || zoom === null) {
    return respond(NextResponse.json({ error: "Invalid image settings" }, { status: 400 }));
  }

  try {
    const avatar = slot.startsWith("team.") && slot.endsWith(".avatar");
    const receipt = typeof payload.translationReceipt === "string" ? payload.translationReceipt : "";
    const fields = { alt };
    const translationStates = receipt
      ? verifyTranslationReceipt({ receipt, email: access.email, resource: { type: "media", scope: "", id: slot, version: expectedVersion }, fields })
      : manualTranslationWrites(fields);
    const asset = await updateSiteMediaAssetMetadata({
      slot,
      alt,
      focalX: avatar ? 50 : focalX,
      focalY: avatar ? 50 : focalY,
      zoom: avatar ? 100 : zoom,
      expectedVersion,
      updatedBy: access.email,
      translationStates,
    });
    const revision = await invalidateSiteMedia();
    return respond(NextResponse.json({ ok: true, item: publicSiteMediaAsset(asset), revision }));
  } catch (error) {
    if (error instanceof TranslationReceiptError) return respond(NextResponse.json({ error: error.message, code: error.code }, { status: 409 }));
    return respond(siteMediaApiError(error));
  }
}

export async function DELETE(request: Request, context: RouteContext) {
  const access = await authorized(request, RATE_LIMIT_POLICIES.adminMutation);
  if ("response" in access) return access.response;
  const respond = <T extends Response>(response: T) => withRateLimitHeaders(response, access.decision);
  const { slot } = await context.params;
  if (!isSiteMediaSlot(slot)) return respond(NextResponse.json({ error: "Unknown image slot" }, { status: 400 }));

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return respond(NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }));
  }
  const payload = body as { expectedVersion?: unknown };
  if (!Object.prototype.hasOwnProperty.call(payload, "expectedVersion")) {
    return respond(NextResponse.json({ error: "Reload the page before restoring this image" }, { status: 428 }));
  }
  const expectedVersion = parseVersion(String(payload.expectedVersion));
  if (expectedVersion === null || expectedVersion === 0) {
    return respond(NextResponse.json({ error: "Invalid image version" }, { status: 400 }));
  }

  try {
    const storagePaths = await deleteSiteMediaAsset(slot, expectedVersion);
    await removeSiteMediaObjects(storagePaths).catch((cleanupError) => {
      console.error("Could not remove restored site-media objects", cleanupError);
    });
    const revision = await invalidateSiteMedia();
    return respond(NextResponse.json({ ok: true, slot, revision }));
  } catch (error) {
    return respond(siteMediaApiError(error));
  }
}
