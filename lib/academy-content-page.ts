import { readFile } from "node:fs/promises";
import path from "node:path";

import { currentAdminPrincipal } from "./admin-auth";
import { readAcademyContent } from "./academy-content-store";
import {
  academyFields,
  academyTutorNames,
  type AcademyContentConfig,
  type AcademyLocale,
} from "./academy-content-types";
import {
  ACADEMY_DEFAULT_SELECTION,
  academyFaqPrices,
  academyOptionPrice,
  academyPriceLookups,
  academyPriceTable,
  academyPriceView,
} from "./academy-pricing-text";
import { NO_STORE_HEADERS } from "./response-headers";

export type AcademyPublished = { config: AcademyContentConfig; recordVersion: number };

const escapeText = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const textHtml = (value: string) => value.split("\n").map(escapeText).join("<br>");
// Administrator-authored text may appear inside the embedded data; it must not
// be able to close the script element or form an HTML entity.
const scriptJson = (value: unknown) => JSON.stringify(value)
  .replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026")
  .replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");

const FIELD_PATTERN = /(<([a-z][a-z0-9]*)\b[^>]*\bdata-academy-field="([^"]+)"[^>]*>)((?:[^<]|<br\s*\/?>)*)(<\/\2\s*>)/gi;

function replaceExactly(html: string, pattern: RegExp, expected: number, name: string, replacer: (...match: string[]) => string) {
  let count = 0;
  const result = html.replace(pattern, (...match) => { count++; return replacer(...(match as string[])); });
  if (count !== expected) throw new Error(`Academy template slot ${name} appears ${count} times`);
  return result;
}

const UNAVAILABLE: Record<AcademyLocale, string> = {
  zhHant: "課程費用暫時無法載入，請稍後重試，或聯繫 iHear 團隊確認。",
  en: "Current lesson prices are temporarily unavailable. Please try again later or contact the iHear team.",
};

/**
 * Renders a course-page template with published content. Without published
 * content the page keeps its template text but shows no prices at all: a
 * default or previous price is never presented as current. `administrator`
 * only marks the page so its script offers editing; it grants nothing.
 */
export function renderAcademyPage(template: string, locale: AcademyLocale, published: AcademyPublished | null, options: { preview?: boolean; administrator?: boolean } = {}) {
  const config = published?.config ?? null;
  const content = config?.content[locale];
  const expected = new Set(academyFields(locale).map(field => field.id));
  const seen = new Set<string>();
  let html = template.replace(FIELD_PATTERN, (whole, opening: string, _tag: string, id: string, _old: string, closing: string) => {
    if (!expected.has(id) || seen.has(id)) throw new Error(`Unexpected Academy field ${id}`);
    seen.add(id);
    if (!content) return whole;
    return opening + textHtml(content[id]) + closing;
  });
  if (seen.size !== expected.size) throw new Error("The Academy template is missing editable fields");

  const selection = ACADEMY_DEFAULT_SELECTION[locale];
  const names = config ? academyTutorNames(config, locale) : null;
  const rates = config?.pricing.rates ?? null;
  const unavailable = escapeText(UNAVAILABLE[locale]);

  html = replaceExactly(html, /(<span class="option-price" data-tutor-price="(highschool|college)" data-academy-generated="option-price">)[^<]*(<\/span>)/g, 2, "option-price",
    (_whole, opening, tutor, closing) => opening + (rates ? escapeText(academyOptionPrice(locale, rates, selection.currency, selection.duration, tutor as "highschool" | "college")) : "") + closing);
  const view = names && rates ? academyPriceView(locale, names, rates, selection.currency, selection.duration, selection.tutor, selection.plan) : null;
  html = replaceExactly(html, /(<strong id="price" data-academy-generated="price">)[\s\S]*?(<\/strong>)/g, 1, "price",
    (_whole, opening, closing) => opening + (view ? `<span class="price-currency">${escapeText(view.symbol)}</span>${escapeText(view.amount)}` : "") + closing);
  html = replaceExactly(html, /(<span id="price-unit" data-academy-generated="price-unit">)[^<]*(<\/span>)/g, 1, "price-unit",
    (_whole, opening, closing) => opening + (view ? escapeText(view.unit) : "") + closing);
  html = replaceExactly(html, /(<p\b[^>]*\bdata-academy-generated="price-detail"[^>]*>)[^<]*(<\/p>)/g, 1, "price-detail",
    (_whole, opening, closing) => opening + (view ? escapeText(view.detail) : "") + closing);
  html = replaceExactly(html, /(<noscript data-academy-generated="price-table">)[\s\S]*?(<\/noscript>)/g, 1, "price-table", (_whole, opening, closing) => {
    if (!names || !rates) return `<p class="academy-pricing-unavailable" role="status">${unavailable}</p>`;
    const table = academyPriceTable(locale, names, rates);
    const rows = table.rows.map(row => `<tr><th scope="row">${row.label.map(escapeText).join("<br>")}</th>${(["highschool", "college"] as const).map(tutor => `<td>${row.cells[tutor].map(escapeText).join("<br>")}</td>`).join("")}</tr>`).join("");
    return `${opening}<table class="price-table"><caption>${escapeText(table.caption)}</caption><thead><tr><th scope="col">${escapeText(table.option)}</th><th scope="col">${escapeText(table.tutors.highschool)}</th><th scope="col">${escapeText(table.tutors.college)}</th></tr></thead><tbody>${rows}</tbody></table>${closing}`;
  });
  html = replaceExactly(html, /(<span data-academy-generated="faq-prices">)[^<]*(<\/span>)/g, 1, "faq-prices",
    (_whole, opening, closing) => opening + (names && rates ? escapeText(academyFaqPrices(locale, names, rates)) : unavailable) + closing);
  const data = names && rates && published
    ? { version: published.recordVersion, defaults: selection, ...academyPriceLookups(locale, names, rates) }
    : null;
  html = replaceExactly(html, /<script type="application\/json" id="academy-pricing-data">null<\/script>/g, 1, "pricing-data",
    () => `<script type="application/json" id="academy-pricing-data">${scriptJson(data)}</script>`);
  const version = published && Number.isSafeInteger(published.recordVersion) && published.recordVersion >= 1 ? String(published.recordVersion) : "unavailable";
  const marks = (config ? "" : ' data-academy-pricing="unavailable"') + (options.administrator && !options.preview ? ' data-academy-admin="available"' : "");
  html = replaceExactly(html, /<body id="academy" data-academy-version="unavailable">/g, 1, "body",
    () => `<body id="academy" data-academy-version="${version}"${marks}>`);
  if (options.preview) html = replaceExactly(html, /<html\b/g, 1, "html", () => "<html data-academy-preview");
  return html;
}

export function academyTemplatePath(locale: AcademyLocale) {
  return path.join(process.cwd(), ".private", "academy", locale === "zhHant" ? "zh/index.html" : "index.html");
}

export async function readAcademyTemplate(locale: AcademyLocale) {
  return readFile(academyTemplatePath(locale), "utf8");
}

const PAGE_UNAVAILABLE: Record<AcademyLocale, string> = {
  zhHant: "課程頁面暫時無法載入，請稍後重試。",
  en: "The course page is temporarily unavailable. Please try again later.",
};

export async function serveAcademyPage(locale: AcademyLocale): Promise<Response> {
  const headers = { ...NO_STORE_HEADERS, "Content-Type": "text/html; charset=utf-8" };
  let template: string;
  try { template = await readAcademyTemplate(locale); }
  catch { return new Response(PAGE_UNAVAILABLE[locale], { status: 503, headers }); }
  // One uncached read supplies every price and every text on this response; a
  // failed read never falls back to template defaults or a previous read. The
  // administrator check only adds the editing mark and never blocks visitors.
  const [record, principal] = await Promise.all([
    readAcademyContent().catch(() => null),
    currentAdminPrincipal().catch(() => null),
  ]);
  const published: AcademyPublished | null = record ? { config: record.config, recordVersion: record.recordVersion } : null;
  try {
    return new Response(renderAcademyPage(template, locale, published, { administrator: Boolean(principal) }), { status: published ? 200 : 503, headers });
  } catch {
    return new Response(PAGE_UNAVAILABLE[locale], { status: 503, headers });
  }
}
