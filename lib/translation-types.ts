export const TRANSLATION_LOCALES = ["zhHant", "zhHans"] as const;
export const TRANSLATION_ORIGINS = ["machine", "manual", "protected_legacy"] as const;
export const TRANSLATION_RESOURCE_TYPES = ["content", "team", "impact", "media"] as const;

export type TranslationLocale = (typeof TRANSLATION_LOCALES)[number];
export type TranslationOrigin = (typeof TRANSLATION_ORIGINS)[number];
export type TranslationResourceType = (typeof TRANSLATION_RESOURCE_TYPES)[number];

export type TranslationResource = {
  type: TranslationResourceType;
  scope: string;
  id: string;
  version?: number | string | null;
};

export type TranslationState = {
  field: string;
  locale: TranslationLocale;
  sourceHash: string | null;
  origin: TranslationOrigin;
  glossaryVersion: string;
  updatedAt?: string;
  updatedBy?: string;
};

export type LocalizedTranslationField = {
  en: string;
  zhHant: string;
  zhHans: string;
};

export type TranslationStateWrite = Omit<TranslationState, "updatedAt" | "updatedBy">;
