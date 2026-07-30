import { NextResponse } from "next/server";

// @ts-ignore - auth.js is the existing Auth.js configuration.
import { auth } from "../../../../auth.js";
import { isAllowedAdmin, normalizeEmail } from "../../../../lib/admins";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const LOCALES = ["zhHant", "zhHans", "en"] as const;
type Locale = (typeof LOCALES)[number];
type Translation = { title: string; description: string };

function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && LOCALES.includes(value as Locale);
}

function cleanText(value: unknown, max: number) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function outputText(response: unknown) {
  if (!response || typeof response !== "object") return "";
  const body = response as {
    output_text?: unknown;
    output?: Array<{ content?: Array<{ type?: string; text?: unknown }> }>;
  };
  if (typeof body.output_text === "string") return body.output_text;
  return (body.output || [])
    .flatMap((item) => item.content || [])
    .filter((item) => item.type === "output_text" && typeof item.text === "string")
    .map((item) => item.text as string)
    .join("");
}

function parseTranslations(text: string, targets: Locale[]) {
  const normalized = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  const parsed = JSON.parse(normalized) as Record<string, Partial<Translation>>;
  const translations: Partial<Record<Locale, Translation>> = {};
  for (const locale of targets) {
    const candidate = parsed[locale];
    if (!candidate || typeof candidate !== "object") throw new Error(`Missing ${locale} translation`);
    translations[locale] = {
      title: cleanText(candidate.title, 200),
      description: cleanText(candidate.description, 2_000),
    };
  }
  return translations;
}

export async function POST(request: Request) {
  const session = await auth();
  const email = normalizeEmail(session?.user?.email);
  if (!isAllowedAdmin(email)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "Automatic translation is not configured", code: "TRANSLATION_NOT_CONFIGURED" },
      { status: 503 },
    );
  }

  try {
    const body = (await request.json()) as Record<string, unknown>;
    if (!isLocale(body.sourceLocale)) {
      return NextResponse.json({ error: "Invalid source locale" }, { status: 400 });
    }

    const sourceLocale = body.sourceLocale;
    const title = cleanText(body.title, 200);
    const description = cleanText(body.description, 2_000);
    if (!title && !description) {
      return NextResponse.json({ error: "Nothing to translate" }, { status: 400 });
    }

    const requestedTargets = Array.isArray(body.targetLocales)
      ? body.targetLocales.filter(isLocale)
      : LOCALES.filter((locale) => locale !== sourceLocale);
    const targetLocales = [...new Set(requestedTargets)].filter((locale) => locale !== sourceLocale);
    if (!targetLocales.length) {
      return NextResponse.json({ translations: {} });
    }

    const localeGuide: Record<Locale, string> = {
      zhHant: "Traditional Chinese using natural Taiwan wording",
      zhHans: "Simplified Chinese using natural Mainland Chinese wording",
      en: "clear, natural English for a nonprofit website",
    };
    const targetGuide = targetLocales.map((locale) => `${locale}: ${localeGuide[locale]}`).join("; ");
    const translationSchema = {
      type: "object",
      properties: Object.fromEntries(
        targetLocales.map((locale) => [
          locale,
          {
            type: "object",
            properties: {
              title: { type: "string" },
              description: { type: "string" },
            },
            required: ["title", "description"],
            additionalProperties: false,
          },
        ]),
      ),
      required: targetLocales,
      additionalProperties: false,
    };
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: process.env.OPENAI_TRANSLATION_MODEL || "gpt-5.6-luna",
        reasoning: { effort: "none" },
        store: false,
        max_output_tokens: 1_200,
        text: {
          format: {
            type: "json_schema",
            name: "timeline_translations",
            strict: true,
            schema: translationSchema,
          },
        },
        instructions: [
          "Translate an iHear nonprofit journey timeline entry.",
          "Preserve all names, dates, numbers, symbols, acronyms, and organization names exactly.",
          "Do not add claims or commentary. Keep the title concise and preserve the source tone.",
          `Target language guidance: ${targetGuide}.`,
          "Return JSON only. Use each requested locale as a top-level key, with title and description string fields.",
        ].join(" "),
        input: JSON.stringify({ sourceLocale, targetLocales, title, description }),
      }),
    });

    const responseBody = await response.json().catch(() => null);
    if (!response.ok) {
      console.error("OpenAI translation request failed", response.status, responseBody);
      return NextResponse.json(
        { error: response.status === 429 ? "Translation limit reached; try again shortly" : "Translation service unavailable" },
        { status: response.status === 429 ? 429 : 502 },
      );
    }

    const translations = parseTranslations(outputText(responseBody), targetLocales);
    return NextResponse.json(
      { translations },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    console.error("Timeline translation failed", error);
    return NextResponse.json({ error: "Could not translate this content" }, { status: 502 });
  }
}
