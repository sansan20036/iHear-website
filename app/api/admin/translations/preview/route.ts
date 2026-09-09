import { NextResponse } from "next/server";

import { inspectEnglishSource } from "../../../../../assets/text-language-guard";
import { authorizeAdminRequest } from "../../../../../lib/admin-auth";
import { contentSlot } from "../../../../../lib/content-catalog";
import {
  buildTranslationPreview,
  personNameContextTerms,
  TranslationConfigurationError,
  TranslationIntegrityError,
} from "../../../../../lib/translation-core";
import { readTranslationStates } from "../../../../../lib/translation-state";
import {
  TRANSLATION_RESOURCE_TYPES,
  type LocalizedTranslationField,
  type TranslationResource,
} from "../../../../../lib/translation-types";
import { withRateLimitHeaders } from "../../../../../lib/rate-limit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 15;

const FIELD_LIMITS: Record<Exclude<TranslationResource["type"], "content">, Record<string, number>> = {
  team: { role: 500, schoolDisplay: 300, languages: 500, strengths: 1_000, summary: 2_000, bio: 5_000, hobbies: 2_000 },
  impact: { title: 200, description: 2_000, countryNames: 500 },
  media: { alt: 300 },
};

function parseResource(value: unknown): TranslationResource | null {
  if (!value || typeof value !== "object") return null;
  const source = value as Record<string, unknown>;
  if (!TRANSLATION_RESOURCE_TYPES.includes(source.type as TranslationResource["type"])) return null;
  const scope = typeof source.scope === "string" ? source.scope : "";
  const id = typeof source.id === "string" ? source.id.trim() : "";
  const version = source.version == null || typeof source.version === "string" || typeof source.version === "number" ? source.version as TranslationResource["version"] : null;
  if (!id || id.length > 5_000 || scope.length > 500) return null;
  return { type: source.type as TranslationResource["type"], scope, id, version };
}

function maxLength(resource: TranslationResource, field: string) {
  if (resource.type === "content") return field === "value" ? contentSlot(resource.scope, resource.id)?.maxLength || 0 : 0;
  return FIELD_LIMITS[resource.type][field] || 0;
}

function parseFields(resource: TranslationResource, value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const fields: Record<string, LocalizedTranslationField> = {};
  for (const [field, candidate] of Object.entries(value as Record<string, unknown>)) {
    const limit = maxLength(resource, field);
    if (!limit || !candidate || typeof candidate !== "object") return null;
    const source = candidate as Record<string, unknown>;
    const parsed = {
      en: typeof source.en === "string" ? source.en.trim() : "",
      zhHant: typeof source.zhHant === "string" ? source.zhHant.trim() : "",
      zhHans: typeof source.zhHans === "string" ? source.zhHans.trim() : "",
    };
    if (!parsed.en || Object.values(parsed).some((item) => item.length > limit)) return null;
    fields[field] = parsed;
  }
  return Object.keys(fields).length && Object.keys(fields).length <= 12 ? fields : null;
}

function parseForce(fields: Record<string, LocalizedTranslationField>, value: unknown) {
  if (value == null) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const force: Record<string, Array<"zhHant" | "zhHans">> = {};
  for (const [field, locales] of Object.entries(value as Record<string, unknown>)) {
    if (!(field in fields) || !Array.isArray(locales) || locales.some((locale) => locale !== "zhHant" && locale !== "zhHans")) return null;
    force[field] = [...new Set(locales)] as Array<"zhHant" | "zhHans">;
  }
  return force;
}

export async function POST(request: Request) {
  const access = await authorizeAdminRequest(request, { translation: true });
  if ("response" in access) return access.response;
  const respond = <T extends Response>(response: T) => withRateLimitHeaders(response, access.decision!);
  let body: Record<string, unknown>;
  try { body = await request.json(); }
  catch { return respond(NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })); }
  const resource = parseResource(body.resource);
  if (!resource) return respond(NextResponse.json({ error: "Invalid translation resource" }, { status: 400 }));
  const fields = parseFields(resource, body.fields);
  if (!fields) return respond(NextResponse.json({ error: "Invalid translation fields" }, { status: 400 }));
  if (body.allowCjkEnglish !== true && Object.values(fields).some((field) => inspectEnglishSource(field.en).warning)) {
    return respond(NextResponse.json({ error: "Chinese content was detected in an English source field", code: "ENGLISH_SOURCE_CONTAINS_CJK" }, { status: 422 }));
  }
  const force = parseForce(fields, body.force);
  if (!force) return respond(NextResponse.json({ error: "Invalid force-translation fields" }, { status: 400 }));
  const refreshLegacy = parseForce(fields, body.refreshLegacy);
  if (!refreshLegacy) return respond(NextResponse.json({ error: "Invalid legacy-refresh fields" }, { status: 400 }));
  const manualEdits = parseForce(fields, body.manualEdits);
  if (!manualEdits) return respond(NextResponse.json({ error: "Invalid manual-translation fields" }, { status: 400 }));
  const contextTerms = Array.isArray(body.contextTerms)
    ? body.contextTerms.filter((term): term is string => typeof term === "string").slice(0, 100)
    : [];
  if (contextTerms.some((term) => term.length > 300)) return respond(NextResponse.json({ error: "Invalid protected term" }, { status: 400 }));
  const rawPersonNames = body.personNames;
  if (rawPersonNames != null && (
    !Array.isArray(rawPersonNames)
    || resource.type !== "team"
    || rawPersonNames.length > 12
    || rawPersonNames.some((name) => typeof name !== "string" || name.length > 300)
  )) return respond(NextResponse.json({ error: "Invalid protected person name" }, { status: 400 }));
  const personNames = (rawPersonNames || []) as string[];
  const protectedTerms = [...new Set([
    ...contextTerms,
    ...personNames.flatMap((name) => personNameContextTerms(name as string)),
  ])];

  try {
    const states = resource.id === "__new__" ? [] : await readTranslationStates(resource);
    const preview = await buildTranslationPreview({
      email: access.principal.email,
      resource,
      fields,
      states,
      force,
      refreshLegacy,
      manualEdits,
      autoTranslate: body.autoTranslate !== false,
      contextTerms: protectedTerms,
    });
    return respond(NextResponse.json(preview, { headers: { "Cache-Control": "private, no-store", "Vercel-CDN-Cache-Control": "no-store" } }));
  } catch (error) {
    if (error instanceof TranslationConfigurationError) return respond(NextResponse.json({ error: error.message, code: error.code }, { status: 503 }));
    if (error instanceof TranslationIntegrityError) return respond(NextResponse.json({ error: error.message, code: error.code }, { status: 502 }));
    const code = Number((error as { code?: unknown }).code);
    console.error("Google translation preview failed", error);
    return respond(NextResponse.json({ error: code === 8 || code === 429 ? "Translation limit reached; try again shortly" : "Translation service unavailable" }, { status: code === 8 || code === 429 ? 429 : 502 }));
  }
}
