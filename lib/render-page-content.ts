import catalog from "../data/content-slots.json";
import type { ContentLocale, PublicContentStore } from "./content-store";
import { renderMetrics, type PublicMetrics } from "./render-metrics";

export function requestContentLocale(request: Request): ContentLocale {
  const saved = /(?:^|;\s*)ihear-lang=(en|zhTW|zhCN)(?:;|$)/.exec(request.headers.get("cookie") || "")?.[1];
  if (saved) return saved === "zhTW" ? "zhHant" : saved === "zhCN" ? "zhHans" : "en";
  const language = (request.headers.get("accept-language") || "en").split(",")[0].split(";")[0];
  return /^zh/i.test(language) ? (/tw|hk|mo|hant/i.test(language) ? "zhHant" : "zhHans") : "en";
}

const escapeText = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Render text-only catalog slots; leave markup, links and images untouched. */
export function renderPageContent(html: string, page: string, store: PublicContentStore, locale: ContentLocale, metrics?: PublicMetrics | null) {
  const metricResult = metrics !== undefined ? renderMetrics(html, metrics, locale) : { html, metricText: {} };
  html = metricResult.html;
  const slots = catalog.slots.filter(slot => slot.page === page || slot.page === "/__global__");
  const definitions = new Map(slots.map(slot => [`${slot.page}\0${slot.key}`, slot]));
  const rendered = html.replace(/(<([a-z][a-z0-9]*)\b[^>]*\bdata-editable-content="([^"]+)"[^>]*>)([^<]*)(<\/\2\s*>)/gi,
    (whole, opening: string, _tag: string, key: string, _old: string, closing: string) => {
      const scope = /\bdata-editable-page="([^"]+)"/.exec(opening)?.[1] || page;
      const value = store.locales[locale]?.pages[scope]?.[key] ?? definitions.get(`${scope}\0${key}`)?.values[locale];
      return value == null ? whole : opening + escapeText(value) + closing;
    });
  // Escape script delimiters, including administrator-authored text. Only the
  // public store is embedded; no editor identities or database credentials.
  const payload = JSON.stringify({ page, store, slots, metrics, metricText: metricResult.metricText }).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
  return rendered.replace(/<html\b([^>]*?)\blang="[^"]*"/i, `<html$1lang="${locale === "en" ? "en" : locale === "zhHant" ? "zh-Hant" : "zh-Hans"}"`)
    .replace(/<head([^>]*)>/i, opening => `${opening}\n<script id="ihear-published-content" type="application/json">${payload}</script>\n<script src="/assets/content-bootstrap.js?v=20260920-v2"></script>`);
}
