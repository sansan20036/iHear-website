// The classroom pages' language (D2, 2026-11-07): English, Traditional or Simplified Chinese, by the
// same rule as the site's own pages (lib/render-page-content.ts): the visitor's saved choice
// ("ihear-lang"), and otherwise the browser's language.
export type ClassroomLocale = "en" | "zhHant" | "zhHans";

export const CLASSROOM_LOCALES: ClassroomLocale[] = ["en", "zhHant", "zhHans"];
export const LOCALE_NAMES: Record<ClassroomLocale, string> = { en: "English", zhHant: "繁體中文", zhHans: "简体中文" };

export function classroomLocaleOf(stored: string | null | undefined, browserLanguage: string | null | undefined): ClassroomLocale {
  if (stored === "en") return "en";
  if (stored === "zhTW") return "zhHant";
  if (stored === "zhCN") return "zhHans";
  const language = String(browserLanguage || "en");
  if (!/^zh/i.test(language)) return "en";
  return /tw|hk|mo|hant/i.test(language) ? "zhHant" : "zhHans";
}

export const htmlLangOf = (locale: ClassroomLocale) => (locale === "en" ? "en" : locale === "zhHant" ? "zh-Hant" : "zh-Hans");
export const intlLocaleOf = (locale: ClassroomLocale) => (locale === "en" ? "en-GB" : locale === "zhHant" ? "zh-TW" : "zh-CN");

// In the browser: the saved choice, if storage can be read, then the browser's language.
export function browserClassroomLocale(): ClassroomLocale {
  let stored: string | null = null;
  try {
    stored = localStorage.getItem("ihear-lang");
  } catch {
    // Storage can be blocked; the browser's language decides.
  }
  return classroomLocaleOf(stored, navigator.language);
}
