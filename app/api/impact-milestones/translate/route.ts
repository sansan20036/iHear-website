import { NextResponse } from "next/server";

import { authorizeAdminRequest } from "../../../../lib/admin-auth";
import {
  buildTranslationPreview,
  TranslationConfigurationError,
  TranslationIntegrityError,
} from "../../../../lib/translation-core";
import { withRateLimitHeaders } from "../../../../lib/rate-limit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 15;

function clean(value: unknown, maximum: number) {
  return typeof value === "string" ? value.trim().slice(0, maximum) : "";
}

export async function POST(request: Request) {
  const access = await authorizeAdminRequest(request, { translation: true });
  if ("response" in access) return access.response;
  const respond = <T extends Response>(response: T) => withRateLimitHeaders(response, access.decision!);
  try {
    const body = await request.json();
    if (body.sourceLocale !== "en") return respond(NextResponse.json({ error: "Automatic translation uses English as the source language" }, { status: 400 }));
    const title = clean(body.title, 200);
    const description = clean(body.description, 2_000);
    if (!title && !description) return respond(NextResponse.json({ error: "Nothing to translate" }, { status: 400 }));
    const fields = {
      title: { en: title || "—", zhHant: "", zhHans: "" },
      description: { en: description || "—", zhHant: "", zhHans: "" },
    };
    const preview = await buildTranslationPreview({
      email: access.principal.email,
      resource: { type: "impact", scope: "", id: "__new__" },
      fields,
      states: [],
      force: { title: ["zhHant", "zhHans"], description: ["zhHant", "zhHans"] },
    });
    const targets = Array.isArray(body.targetLocales) ? body.targetLocales : ["zhHant", "zhHans"];
    const translations = Object.fromEntries(targets.filter((locale: unknown) => locale === "zhHant" || locale === "zhHans").map((locale: "zhHant" | "zhHans") => [locale, {
      title: title ? preview.fields.title.value[locale] : "",
      description: description ? preview.fields.description.value[locale] : "",
    }]));
    return respond(NextResponse.json({ translations }, { headers: { "Cache-Control": "private, no-store" } }));
  } catch (error) {
    if (error instanceof TranslationConfigurationError) return respond(NextResponse.json({ error: error.message, code: error.code }, { status: 503 }));
    if (error instanceof TranslationIntegrityError) return respond(NextResponse.json({ error: error.message, code: error.code }, { status: 502 }));
    console.error("Impact translation failed", error);
    return respond(NextResponse.json({ error: "Translation service unavailable" }, { status: 502 }));
  }
}
