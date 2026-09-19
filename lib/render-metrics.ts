import type { publicImpactMilestone } from "./impact-types";
import type { ContentLocale } from "./content-store";
export type PublicMetrics = ReturnType<typeof publicImpactMilestone>;
export type MetricText = Record<string, Record<ContentLocale, string>>;
const escapeText = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function renderMetrics(html: string, metrics: PublicMetrics | null, locale: ContentLocale) {
  const metricText: MetricText = {};
  let index = 0;
  html = html.replace(/(<([a-z][a-z0-9]*)\b[^>]*\b(data-site-metric-(?:value|plus|asof|country-names)|data-latest-impact-(?:label|period|headline|description|link))(?:="([^"]*)")?[^>]*>)([^<]*)(<\/\2\s*>)/gi,
    (_whole, opening: string, _tag: string, attribute: string, field: string, _old: string, closing: string) => {
      const id = String(index++);
      const counted = /\bdata-count=/.test(opening);
      const values = {} as Record<ContentLocale, string>;
      for (const language of ["en", "zhHant", "zhHans"] as const) {
        const number = (key: string, plus = true) => {
          if (!metrics) return "—";
          const record = metrics as unknown as Record<string, unknown>;
          return Number(record[key] || 0).toLocaleString("en-US") + (plus && record[`${key}Plus`] ? "+" : "");
        };
        const period = !metrics ? "" : language === "en"
          ? new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${metrics.period}-01T00:00:00Z`))
          : `${metrics.period.slice(0, 4)} 年 ${Number(metrics.period.slice(5))} 月`;
        const localized = (text: PublicMetrics["description"] | undefined) => text?.[language] || text?.en || text?.zhHant || text?.zhHans || "";
        const labels = language === "en" ? ["volunteers", "students", "sessions"] : language === "zhHant" ? ["位志工", "位學生", "堂課"] : ["位志愿者", "位学生", "节课"];
        values[language] = attribute === "data-site-metric-value" ? number(field, !counted)
          : attribute === "data-site-metric-plus" ? (metrics && (metrics as unknown as Record<string, unknown>)[`${field}Plus`] ? "+" : "")
          : attribute === "data-site-metric-asof" ? (metrics ? `${language === "en" ? "as of " : "截至 "}${period}` : "")
          : attribute === "data-site-metric-country-names" ? localized(metrics?.countryNames)
          : attribute === "data-latest-impact-period" ? period
          : attribute === "data-latest-impact-headline" ? (metrics ? ["volunteers", "students", "sessions"].map((key, i) => `${number(key)} ${labels[i]}`).join(" · ") : "")
          : attribute === "data-latest-impact-description" ? localized(metrics?.description)
          : attribute === "data-latest-impact-label" ? (language === "en" ? "Latest impact" : "最新成果")
          : language === "en" ? "View our journey →" : language === "zhHant" ? "查看我們的歷程 →" : "查看我们的历程 →";
      }
      metricText[id] = values;
      opening = opening.slice(0, -1) + ` data-published-metric="${id}">`;
      if (counted) opening = opening.replace(/data-count="[^"]*"/, `data-count="${metrics ? Number((metrics as unknown as Record<string, unknown>)[field] || 0) : 0}"`);
      if (attribute === "data-latest-impact-period") opening = opening.replace(/datetime="[^"]*"/, `datetime="${metrics?.period || ""}"`);
      return opening + escapeText(values[locale]) + closing;
    });
  if (!metrics) html = html.replace(/(<[^>]+\bdata-latest-impact(?=[\s>])[^>]*)(>)/g, "$1 hidden$2");
  return { html, metricText };
}
