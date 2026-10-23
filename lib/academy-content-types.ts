import registry from "../data/academy-fields.json" with { type: "json" };

// One published document holds every editable Academy course-page value: the
// single-session prices and the English and Traditional Chinese page text.
export const ACADEMY_CONTENT_KEY = "academy_content_v2";
export const ACADEMY_CONTENT_MAX_CHARACTERS = 60_000;
export const ACADEMY_CONTENT_MAX_BODY_BYTES = 262_144;
export const ACADEMY_MAX_RECORD_VERSION = 2_147_483_647;

export const ACADEMY_LOCALES = ["zhHant", "en"] as const;
export type AcademyLocale = (typeof ACADEMY_LOCALES)[number];
export const ACADEMY_CURRENCIES = ["TWD", "USD"] as const;
export type AcademyCurrency = (typeof ACADEMY_CURRENCIES)[number];
export const ACADEMY_DURATIONS = ["45", "60"] as const;
export type AcademyDuration = (typeof ACADEMY_DURATIONS)[number];
export const ACADEMY_TUTORS = ["highschool", "college"] as const;
export type AcademyTutor = (typeof ACADEMY_TUTORS)[number];
export const ACADEMY_PLANS = ["single", "package"] as const;
export type AcademyPlan = (typeof ACADEMY_PLANS)[number];

// Prices are whole currency units. NT$ and US$ are set separately (never
// converted). A ten-session package is ten single sessions at 90%, which is a
// whole number for every whole-number price, so no rounding is ever needed.
export const ACADEMY_PACKAGE_SESSIONS = 10;
export const ACADEMY_PACKAGE_PERCENT = 90;
export const ACADEMY_PRICE_LIMITS: Record<AcademyCurrency, { min: number; max: number }> = {
  TWD: { min: 1, max: 100_000 },
  USD: { min: 1, max: 5_000 },
};

export type AcademyRates = { [C in AcademyCurrency]: { [D in AcademyDuration]: { [T in AcademyTutor]: number } } };
export type AcademyContentConfig = {
  schemaVersion: 2;
  pricing: { rates: AcademyRates };
  content: { [L in AcademyLocale]: Record<string, string> };
};
export type AcademyContentRecord = {
  config: AcademyContentConfig;
  recordVersion: number;
  updatedAt: string;
  updatedBy: string;
};

export type AcademyField = {
  id: string;
  block: string;
  tag: string;
  kind: "single" | "multiline";
  maxLength: number;
  default: string;
};
type FieldRegistry = { version: number; locales: Record<AcademyLocale, { blocks: string[]; fields: AcademyField[] }> };
const fieldRegistry = registry as FieldRegistry;
const fieldMaps = new Map(ACADEMY_LOCALES.map(locale => [locale, new Map(fieldRegistry.locales[locale].fields.map(field => [field.id, field]))]));

export function academyFields(locale: AcademyLocale): readonly AcademyField[] {
  return fieldRegistry.locales[locale].fields;
}
export function academyBlocks(locale: AcademyLocale): readonly string[] {
  return fieldRegistry.locales[locale].blocks;
}
export function academyField(locale: AcademyLocale, id: string): AcademyField | undefined {
  return fieldMaps.get(locale)!.get(id);
}

// The prices confirmed by the Academy team and published on 2026-10-23 (P0).
export const P0_ACADEMY_RATES: AcademyRates = {
  TWD: { "45": { highschool: 800, college: 1000 }, "60": { highschool: 1000, college: 1400 } },
  USD: { "45": { highschool: 25, college: 34 }, "60": { highschool: 34, college: 45 } },
};

export function academyPackagePrice(rate: number) {
  return (rate * ACADEMY_PACKAGE_SESSIONS * ACADEMY_PACKAGE_PERCENT) / 100;
}
export function academyPackageSaving(rate: number) {
  return rate * ACADEMY_PACKAGE_SESSIONS - academyPackagePrice(rate);
}

function cloneRates(rates: AcademyRates): AcademyRates {
  return JSON.parse(JSON.stringify(rates)) as AcademyRates;
}

export function defaultAcademyContent(): AcademyContentConfig {
  const content = {} as AcademyContentConfig["content"];
  for (const locale of ACADEMY_LOCALES) {
    content[locale] = Object.fromEntries(academyFields(locale).map(field => [field.id, field.default]));
  }
  return { schemaVersion: 2, pricing: { rates: cloneRates(P0_ACADEMY_RATES) }, content };
}

export type AcademyValidationCode =
  | "invalid_request" | "unsupported_field" | "missing_field" | "not_text" | "required" | "too_long"
  | "single_line" | "unsupported_character" | "price_not_whole" | "price_range" | "too_large";

export class AcademyContentValidationError extends Error {
  readonly field: string;
  readonly code: AcademyValidationCode;
  readonly status: number;
  constructor(message: string, field = "config", code: AcademyValidationCode = "invalid_request", status = 400) {
    super(message);
    this.name = "AcademyContentValidationError";
    this.field = field;
    this.code = code;
    this.status = status;
  }
}

function invalid(field: string, code: AcademyValidationCode, message: string): never {
  throw new AcademyContentValidationError(message, field, code);
}

// PostgreSQL UTF-8 char_length counts Unicode scalar values, not UTF-16 units.
// NUL and lone surrogates cannot make a lossless round trip through that store.
export function academyCharacterCount(value: string, field = "config") {
  let count = 0;
  for (const character of value) {
    const point = character.codePointAt(0)!;
    if (point === 0 || (point >= 0xd800 && point <= 0xdfff)) invalid(field, "unsupported_character", "Text contains an unsupported character.");
    count++;
  }
  return count;
}

function exactObject(value: unknown, keys: readonly string[], field: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(field, "invalid_request", "Expected a settings object.");
  const result = value as Record<string, unknown>;
  for (const key of Object.keys(result)) if (!keys.includes(key)) invalid(`${field}.${key}`, "unsupported_field", "Settings contain an unsupported field.");
  for (const key of keys) if (!Object.hasOwn(result, key)) invalid(`${field}.${key}`, "missing_field", "Settings are missing a field.");
  return result;
}

export function normalizeAcademyText(value: string) {
  return value.replace(/\r\n?/g, "\n").split("\n").map(line => line.replace(/[ \t ]+$/u, "")).join("\n").trim();
}

function text(value: unknown, definition: AcademyField, field: string) {
  if (typeof value !== "string") invalid(field, "not_text", "Enter text for this field.");
  // Validate before normalizing so unsupported characters cannot be silently removed.
  academyCharacterCount(value, field);
  const result = normalizeAcademyText(value);
  if (!result) invalid(field, "required", "This text cannot be empty.");
  if (definition.kind === "single" && result.includes("\n")) invalid(field, "single_line", "Keep this text on one line.");
  if (academyCharacterCount(result, field) > definition.maxLength) invalid(field, "too_long", `Use at most ${definition.maxLength} characters.`);
  return result;
}

function price(value: unknown, currency: AcademyCurrency, field: string) {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) {
    invalid(field, "price_not_whole", "Enter a whole-number price without decimals.");
  }
  const { min, max } = ACADEMY_PRICE_LIMITS[currency];
  if (value < min || value > max) invalid(field, "price_range", `Enter a price from ${min} to ${max}.`);
  return value;
}

function rates(value: unknown): AcademyRates {
  const root = exactObject(value, ACADEMY_CURRENCIES, "pricing.rates");
  const result = {} as AcademyRates;
  for (const currency of ACADEMY_CURRENCIES) {
    const byDuration = exactObject(root[currency], ACADEMY_DURATIONS, `pricing.rates.${currency}`);
    result[currency] = {} as AcademyRates[AcademyCurrency];
    for (const duration of ACADEMY_DURATIONS) {
      const byTutor = exactObject(byDuration[duration], ACADEMY_TUTORS, `pricing.rates.${currency}.${duration}`);
      result[currency][duration] = {} as AcademyRates[AcademyCurrency][AcademyDuration];
      for (const tutor of ACADEMY_TUTORS) {
        result[currency][duration][tutor] = price(byTutor[tutor], currency, `pricing.rates.${currency}.${duration}.${tutor}`);
      }
    }
  }
  return result;
}

function localeContent(value: unknown, locale: AcademyLocale, strict: boolean) {
  const field = `content.${locale}`;
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(field, "invalid_request", "Expected page text.");
  const stored = value as Record<string, unknown>;
  const definitions = academyFields(locale);
  if (strict) exactObject(stored, definitions.map(definition => definition.id), field);
  // Reading published data tolerates fields added to the templates later (their
  // defaults apply) and fields that were removed; every present value must be valid.
  return Object.fromEntries(definitions.map(definition => [
    definition.id,
    Object.hasOwn(stored, definition.id) ? text(stored[definition.id], definition, `${field}.${definition.id}`) : definition.default,
  ]));
}

function parse(value: unknown, strict: boolean): AcademyContentConfig {
  const root = exactObject(value, ["schemaVersion", "pricing", "content"], "config");
  if (root.schemaVersion !== 2) invalid("schemaVersion", "invalid_request", "Unsupported Academy content version.");
  const pricing = exactObject(root.pricing, ["rates"], "pricing");
  const content = exactObject(root.content, ACADEMY_LOCALES, "content");
  const config: AcademyContentConfig = {
    schemaVersion: 2,
    pricing: { rates: rates(pricing.rates) },
    content: {
      zhHant: localeContent(content.zhHant, "zhHant", strict),
      en: localeContent(content.en, "en", strict),
    },
  };
  if (academyCharacterCount(JSON.stringify(config)) > ACADEMY_CONTENT_MAX_CHARACTERS) {
    invalid("config", "too_large", "The complete Academy content exceeds the storage limit.");
  }
  return config;
}

/** Validates a complete document submitted for publication. */
export function parseAcademyContentConfig(value: unknown): AcademyContentConfig {
  return parse(value, true);
}

/** Validates a published document, filling fields the templates gained later. */
export function readStoredAcademyContent(value: unknown): AcademyContentConfig {
  return parse(value, false);
}

export function publicAcademyContent(record: Pick<AcademyContentRecord, "config" | "recordVersion">) {
  return { config: record.config, recordVersion: record.recordVersion };
}

export function academyTutorNames(config: AcademyContentConfig, locale: AcademyLocale): Record<AcademyTutor, string> {
  return {
    highschool: config.content[locale]["pricing.card.tutor.highschool"],
    college: config.content[locale]["pricing.card.tutor.college"],
  };
}
