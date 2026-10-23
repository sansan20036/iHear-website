import {
  ACADEMY_CURRENCIES,
  ACADEMY_DURATIONS,
  ACADEMY_LOCALES,
  ACADEMY_PRICE_LIMITS,
  ACADEMY_TUTORS,
  academyFields,
  normalizeAcademyText,
  type AcademyContentConfig,
  type AcademyCurrency,
  type AcademyDuration,
  type AcademyField,
  type AcademyLocale,
  type AcademyTutor,
  type AcademyValidationCode,
} from "../../../lib/academy-content-types";

// The editor keeps prices as typed strings so an incomplete entry is never
// silently turned into a number; the server parser remains the authority.
export type AcademyPriceDraft = { [C in AcademyCurrency]: { [D in AcademyDuration]: { [T in AcademyTutor]: string } } };
export type AcademyDraft = { prices: AcademyPriceDraft; content: Record<AcademyLocale, Record<string, string>> };

export function priceKey(currency: AcademyCurrency, duration: AcademyDuration, tutor: AcademyTutor) {
  return `pricing.rates.${currency}.${duration}.${tutor}`;
}

export function contentKey(locale: AcademyLocale, id: string) {
  return `content.${locale}.${id}`;
}

export function toAcademyDraft(config: AcademyContentConfig): AcademyDraft {
  const prices = {} as AcademyPriceDraft;
  for (const currency of ACADEMY_CURRENCIES) {
    prices[currency] = {} as AcademyPriceDraft[AcademyCurrency];
    for (const duration of ACADEMY_DURATIONS) {
      prices[currency][duration] = {} as AcademyPriceDraft[AcademyCurrency][AcademyDuration];
      for (const tutor of ACADEMY_TUTORS) prices[currency][duration][tutor] = String(config.pricing.rates[currency][duration][tutor]);
    }
  }
  return { prices, content: { zhHant: { ...config.content.zhHant }, en: { ...config.content.en } } };
}

export function parsedPrice(raw: string) {
  const value = raw.trim();
  return /^\d+$/.test(value) ? Number(value) : Number.NaN;
}

export function academyDraftConfig(draft: AcademyDraft) {
  const rates = {} as Record<string, Record<string, Record<string, number>>>;
  for (const currency of ACADEMY_CURRENCIES) {
    rates[currency] = {};
    for (const duration of ACADEMY_DURATIONS) {
      rates[currency][duration] = {};
      for (const tutor of ACADEMY_TUTORS) rates[currency][duration][tutor] = parsedPrice(draft.prices[currency][duration][tutor]);
    }
  }
  return { schemaVersion: 2, pricing: { rates }, content: { zhHant: { ...draft.content.zhHant }, en: { ...draft.content.en } } };
}

export function priceProblem(currency: AcademyCurrency, raw: string): AcademyValidationCode | null {
  const value = raw.trim();
  if (!value) return "required";
  if (!/^\d+$/.test(value)) return "price_not_whole";
  const amount = Number(value);
  const { min, max } = ACADEMY_PRICE_LIMITS[currency];
  return amount < min || amount > max ? "price_range" : null;
}

export function fieldProblem(field: AcademyField, raw: string): AcademyValidationCode | null {
  for (const character of raw) {
    const point = character.codePointAt(0)!;
    if (point === 0 || (point >= 0xd800 && point <= 0xdfff)) return "unsupported_character";
  }
  const value = normalizeAcademyText(raw);
  if (!value) return "required";
  if (field.kind === "single" && value.includes("\n")) return "single_line";
  return Array.from(value).length > field.maxLength ? "too_long" : null;
}

/** Every current problem in the draft, keyed like the server's error fields. */
export function academyDraftProblems(draft: AcademyDraft) {
  const problems = new Map<string, AcademyValidationCode>();
  for (const currency of ACADEMY_CURRENCIES) {
    for (const duration of ACADEMY_DURATIONS) {
      for (const tutor of ACADEMY_TUTORS) {
        const problem = priceProblem(currency, draft.prices[currency][duration][tutor]);
        if (problem) problems.set(priceKey(currency, duration, tutor), problem);
      }
    }
  }
  for (const locale of ACADEMY_LOCALES) {
    for (const field of academyFields(locale)) {
      const problem = fieldProblem(field, draft.content[locale][field.id] ?? "");
      if (problem) problems.set(contentKey(locale, field.id), problem);
    }
  }
  return problems;
}

export type AcademyPriceWarning = { key: string; kind: "duration" | "tutor" | "currency" };

/** Unusual but valid prices; the editor asks for a second look and never blocks them. */
export function academyPriceWarnings(draft: AcademyDraft): AcademyPriceWarning[] {
  const warnings: AcademyPriceWarning[] = [];
  const price = (currency: AcademyCurrency, duration: AcademyDuration, tutor: AcademyTutor) => parsedPrice(draft.prices[currency][duration][tutor]);
  for (const currency of ACADEMY_CURRENCIES) {
    for (const tutor of ACADEMY_TUTORS) {
      if (price(currency, "60", tutor) < price(currency, "45", tutor)) warnings.push({ key: priceKey(currency, "60", tutor), kind: "duration" });
    }
    for (const duration of ACADEMY_DURATIONS) {
      if (price(currency, duration, "college") < price(currency, duration, "highschool")) warnings.push({ key: priceKey(currency, duration, "college"), kind: "tutor" });
    }
  }
  for (const duration of ACADEMY_DURATIONS) {
    for (const tutor of ACADEMY_TUTORS) {
      // NT$ and US$ are set separately; a ratio far outside 20–45 is usually a typo.
      const ratio = price("TWD", duration, tutor) / price("USD", duration, tutor);
      if (Number.isFinite(ratio) && (ratio < 20 || ratio > 45)) warnings.push({ key: priceKey("USD", duration, tutor), kind: "currency" });
    }
  }
  return warnings;
}

export type AcademyChange =
  | { type: "price"; currency: AcademyCurrency; duration: AcademyDuration; tutor: AcademyTutor; before: number; after: number }
  | { type: "text"; locale: AcademyLocale; field: AcademyField; before: string; after: string };

export function academyDraftChanges(published: AcademyContentConfig, draft: AcademyDraft): AcademyChange[] {
  const changes: AcademyChange[] = [];
  for (const currency of ACADEMY_CURRENCIES) {
    for (const duration of ACADEMY_DURATIONS) {
      for (const tutor of ACADEMY_TUTORS) {
        const before = published.pricing.rates[currency][duration][tutor];
        const after = parsedPrice(draft.prices[currency][duration][tutor]);
        if (before !== after) changes.push({ type: "price", currency, duration, tutor, before, after });
      }
    }
  }
  for (const locale of ACADEMY_LOCALES) {
    for (const field of academyFields(locale)) {
      const before = published.content[locale][field.id];
      const after = normalizeAcademyText(draft.content[locale][field.id] ?? "");
      if (before !== after) changes.push({ type: "text", locale, field, before, after });
    }
  }
  return changes;
}
