import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

vi.mock("../lib/academy-content-store", () => ({ readAcademyContent: vi.fn() }));
vi.mock("../lib/admin-auth", () => ({ currentAdminPrincipal: vi.fn() }));

import { readAcademyContent } from "../lib/academy-content-store";
import { currentAdminPrincipal } from "../lib/admin-auth";
import { renderAcademyPage, serveAcademyPage } from "../lib/academy-content-page";
import { academyFields, academyPackagePrice, defaultAcademyContent } from "../lib/academy-content-types";
import { prepareAcademy } from "../scripts/prepare-academy.mjs";
import * as englishRoute from "../app/academy/courses/route";
import * as chineseRoute from "../app/academy/courses/zh/route";

const templates = {};
const decode = value => value
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  .replace(/&#(\d+);/g, (_whole, code) => String.fromCodePoint(Number(code))).replace(/&amp;/g, "&");
const withoutCode = html => html.replace(/<script\b[\s\S]*?<\/script>|<style\b[\s\S]*?<\/style>|<!--[\s\S]*?-->/gi, " ");
// Text as a reader sees it: tags separate words, whitespace runs collapse.
const visibleText = html => decode(withoutCode(html).replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
// Text inside one element, where adjacent inline elements join without a space.
const innerText = html => decode(html.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, ""));
const published = (config = defaultAcademyContent(), recordVersion = 1) => ({ config, recordVersion });
const pricingData = html => JSON.parse(/<script type="application\/json" id="academy-pricing-data">([\s\S]*?)<\/script>/.exec(html)[1]);
const faqAnswer = html => innerText(/<details\b[^>]*data-academy-pricing-faq[^>]*>[\s\S]*?<p\b[^>]*>([\s\S]*?)<\/p>/.exec(html)[1]);
const noscriptTable = html => /<noscript data-academy-generated="price-table">([\s\S]*?)<\/noscript>/.exec(html)?.[1];
const money = /(?:NT|US)\$\s*\d/;

// Exactly as published by the P0 price update (production a845762).
const P0 = {
  en: {
    options: ['data-tutor-price="highschool" data-academy-generated="option-price">US$34/session<', 'data-tutor-price="college" data-academy-generated="option-price">US$45/session<'],
    price: '<strong id="price" data-academy-generated="price"><span class="price-currency">US$</span>34</strong>',
    unit: '<span id="price-unit" data-academy-generated="price-unit">/ 60-minute session</span>',
    detail: ">One 60-minute session with a high-school tutor: US$34. The same rate applies to all available subjects, including SAT/PSAT.</p>",
    table: '<table class="price-table"><caption>One-on-one session prices (US$ / NT$)</caption><thead><tr><th scope="col">Option</th><th scope="col">High-school tutor</th><th scope="col">College tutor</th></tr></thead><tbody><tr><th scope="row">45 min<br>individual</th><td>US$25<br>NT$800</td><td>US$34<br>NT$1,000</td></tr><tr><th scope="row">60 min<br>individual</th><td>US$34<br>NT$1,000</td><td>US$45<br>NT$1,400</td></tr><tr><th scope="row">45 min<br>10 sessions, 10% off</th><td>US$225<br>NT$7,200</td><td>US$306<br>NT$9,000</td></tr><tr><th scope="row">60 min<br>10 sessions, 10% off</th><td>US$306<br>NT$9,000</td><td>US$405<br>NT$12,600</td></tr></tbody></table>',
    faq: "No. All available subjects, including SAT/PSAT, use the same one-on-one rates. High-school tutor: US$25 / NT$800 for 45 minutes, US$34 / NT$1,000 for 60 minutes. College tutor: US$34 / NT$1,000 for 45 minutes, US$45 / NT$1,400 for 60 minutes. Ten-session packages are 10% off: high-school tutor US$225 / NT$7,200 (45 minutes) or US$306 / NT$9,000 (60 minutes); college tutor US$306 / NT$9,000 (45 minutes) or US$405 / NT$12,600 (60 minutes). Subject and test-preparation availability depend on a qualified tutor match.",
  },
  zhHant: {
    options: ['data-tutor-price="highschool" data-academy-generated="option-price">NT$1,000／堂<', 'data-tutor-price="college" data-academy-generated="option-price">NT$1,400／堂<'],
    price: '<strong id="price" data-academy-generated="price"><span class="price-currency">NT$</span>1,000</strong>',
    unit: '<span id="price-unit" data-academy-generated="price-unit">/ 堂・60 分鐘</span>',
    detail: ">高中生導師的一對一課程，每堂 60 分鐘 NT$1,000。本頁各項英文學習服務皆適用相同費率。</p>",
    table: ' <table class="price-table"> <caption>一對一課程價格（新台幣／美元）</caption> <thead><tr><th scope="col">方案</th><th scope="col">高中生導師</th><th scope="col">大學生導師</th></tr></thead> <tbody> <tr><th scope="row">45 分鐘<br>單堂</th><td>NT$800<br>US$25</td><td>NT$1,000<br>US$34</td></tr> <tr><th scope="row">60 分鐘<br>單堂</th><td>NT$1,000<br>US$34</td><td>NT$1,400<br>US$45</td></tr> <tr><th scope="row">45 分鐘<br>十堂九折</th><td>NT$7,200<br>US$225</td><td>NT$9,000<br>US$306</td></tr> <tr><th scope="row">60 分鐘<br>十堂九折</th><td>NT$9,000<br>US$306</td><td>NT$12,600<br>US$405</td></tr> </tbody> </table> ',
    faq: "本頁各項英文學習服務皆適用相同費率，費用依上課時間與導師而定，皆為一對一課程。高中生導師：45 分鐘 NT$800／US$25、60 分鐘 NT$1,000／US$34；大學生導師：45 分鐘 NT$1,000／US$34、60 分鐘 NT$1,400／US$45。十堂方案為九折：高中生導師 45 分鐘 NT$7,200／US$225、60 分鐘 NT$9,000／US$306；大學生導師 45 分鐘 NT$9,000／US$306、60 分鐘 NT$12,600／US$405。小班教學或其他時長請另外諮詢。",
  },
};
const P0_AMOUNTS = ["NT$800", "NT$1,000", "NT$1,400", "NT$7,200", "NT$9,000", "NT$12,600", "US$25", "US$34", "US$45", "US$225", "US$306", "US$405"];

beforeAll(async () => {
  templates.en = await readFile("academy-site/index.html", "utf8");
  templates.zhHant = await readFile("academy-site/zh/index.html", "utf8");
});

describe("Academy course page rendering", () => {
  test.each(["en", "zhHant"])("%s: the P0 prices and default text render exactly as published", locale => {
    const html = renderAcademyPage(templates[locale], locale, published());
    expect(visibleText(html)).toBe(visibleText(templates[locale]));
    for (const option of P0[locale].options) expect(html).toContain(option);
    expect(html).toContain(P0[locale].price);
    expect(html).toContain(P0[locale].unit);
    expect(html).toContain(P0[locale].detail);
    expect(visibleText(noscriptTable(html))).toBe(visibleText(P0[locale].table));
    expect(faqAnswer(html)).toBe(P0[locale].faq);
    expect(html).toContain('<body id="academy" data-academy-version="1">');
    expect(html.match(/data-academy-field="/g)).toHaveLength(academyFields(locale).length);
  });

  test("the English no-JavaScript price table is byte-identical to P0", () => {
    expect(noscriptTable(renderAcademyPage(templates.en, "en", published()))).toBe(P0.en.table);
  });

  test.each(["en", "zhHant"])("%s: a price change reaches every price on the page and no old price remains", locale => {
    const config = defaultAcademyContent();
    config.pricing.rates = {
      TWD: { 45: { highschool: 810, college: 1010 }, 60: { highschool: 1020, college: 1410 } },
      USD: { 45: { highschool: 26, college: 35 }, 60: { highschool: 36, college: 47 } },
    };
    const html = renderAcademyPage(templates[locale], locale, published(config, 7));
    for (const amount of P0_AMOUNTS) expect(html).not.toContain(amount);
    const table = visibleText(noscriptTable(html));
    const faq = faqAnswer(html);
    for (const currency of ["TWD", "USD"]) {
      for (const duration of ["45", "60"]) {
        for (const tutor of ["highschool", "college"]) {
          const rate = config.pricing.rates[currency][duration][tutor];
          const symbol = currency === "TWD" ? "NT$" : "US$";
          for (const amount of [rate, academyPackagePrice(rate)]) {
            const text = symbol + amount.toLocaleString("en-US");
            expect(table).toContain(text);
            expect(faq).toContain(text);
          }
        }
      }
    }
    // The FAQ answer is the same sentence the price card's data produces.
    const data = pricingData(html);
    expect(data.version).toBe(7);
    expect(Object.keys(data.views)).toHaveLength(16);
    expect(data.views["TWD|60|college|package"]).toMatchObject({ symbol: "NT$", amount: "12,690" });
    expect(data.views["USD|45|highschool|package"]).toMatchObject({ symbol: "US$", amount: "234" });
    expect(data.options["USD|45"]).toEqual(locale === "en"
      ? { highschool: "US$26/session", college: "US$35/session" }
      : { highschool: "US$26／堂", college: "US$35／堂" });
    expect(html).toContain('<body id="academy" data-academy-version="7">');
  });

  test("each page shows its own language and the tutor names come from that page", () => {
    const config = defaultAcademyContent();
    config.content.en["hero.cta"] = "Meet a tutor";
    config.content.zhHant["hero.cta"] = "預約諮詢";
    config.content.en["pricing.card.tutor.highschool"] = "Senior-high tutor";
    config.content.zhHant["pricing.card.tutor.highschool"] = "高中導師";
    const en = renderAcademyPage(templates.en, "en", published(config));
    const zh = renderAcademyPage(templates.zhHant, "zhHant", published(config));
    expect(en).toContain(">Meet a tutor<");
    expect(en).not.toContain("預約諮詢");
    expect(zh).toContain(">預約諮詢<");
    expect(zh).not.toContain("Meet a tutor");
    expect(en).toContain("One 60-minute session with a senior-high tutor: US$34.");
    expect(faqAnswer(en)).toContain("Senior-high tutor: US$25 / NT$800 for 45 minutes");
    expect(faqAnswer(zh)).toContain("高中導師：45 分鐘 NT$800／US$25");
    expect(visibleText(noscriptTable(zh))).toContain("高中導師");
  });

  test("administrator text is shown as text and cannot become markup or close the data script", () => {
    const config = defaultAcademyContent();
    config.content.en["hero.lead"] = '<img src=x onerror="alert(1)"> & more\nSecond line';
    config.content.en["pricing.card.tutor.college"] = "</script><script>alert(1)</script>";
    const html = renderAcademyPage(templates.en, "en", published(config));
    expect(html).toContain('&lt;img src=x onerror="alert(1)"&gt; &amp; more<br>Second line');
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("<script>alert(1)");
    const script = /<script type="application\/json" id="academy-pricing-data">([\s\S]*?)<\/script>/.exec(html)[1];
    expect(script).not.toMatch(/[<>&]/);
    expect(pricingData(html).views["USD|60|college|single"].detail).toContain("</script><script>alert(1)</script>");
    expect(html.match(/<script\b/g)).toHaveLength(templates.en.match(/<script\b/g).length);
  });

  test.each(["en", "zhHant"])("%s: without published content no price is shown", locale => {
    const html = renderAcademyPage(templates[locale], locale, null);
    expect(withoutCode(html)).not.toMatch(money);
    expect(html).toContain('<body id="academy" data-academy-version="unavailable" data-academy-pricing="unavailable">');
    expect(html).toContain('<p class="academy-pricing-unavailable" role="status">');
    expect(html).toContain('<script type="application/json" id="academy-pricing-data">null</script>');
    expect(noscriptTable(html)).toBeUndefined();
    expect(faqAnswer(html)).not.toMatch(money);
  });

  test("a template must contain every registered field once and every generated slot", () => {
    const content = published();
    const missingField = templates.en.replace(/ data-academy-field="hero\.cta"/, "");
    expect(() => renderAcademyPage(missingField, "en", content)).toThrow(/missing editable fields/);
    const unknownField = templates.en.replace('data-academy-field="hero.cta"', 'data-academy-field="hero.other"');
    expect(() => renderAcademyPage(unknownField, "en", content)).toThrow(/Unexpected Academy field/);
    const repeated = templates.en.replace("</footer>", '<p data-academy-field="hero.cta">x</p></footer>');
    expect(() => renderAcademyPage(repeated, "en", content)).toThrow(/Unexpected Academy field/);
    const noFaqPrices = templates.en.replace(' data-academy-generated="faq-prices"', "");
    expect(() => renderAcademyPage(noFaqPrices, "en", content)).toThrow(/faq-prices/);
    const twoPrices = templates.en.replace("</footer>", '<strong id="price" data-academy-generated="price"></strong></footer>');
    expect(() => renderAcademyPage(twoPrices, "en", content)).toThrow(/price appears 2 times/);
  });

  test("a preview is marked so the page script never adds editing controls to it", () => {
    const html = renderAcademyPage(templates.zhHant, "zhHant", published(), { preview: true, administrator: true });
    expect(html.match(/<html data-academy-preview/g)).toHaveLength(1);
    expect(html).not.toContain("data-academy-admin");
    expect(renderAcademyPage(templates.zhHant, "zhHant", published())).not.toContain("data-academy-preview");
  });

  test("only an administrator page carries the editing mark, which holds no identity", () => {
    expect(renderAcademyPage(templates.en, "en", published())).not.toContain("data-academy-admin");
    expect(renderAcademyPage(templates.en, "en", published(), { administrator: true }))
      .toContain('<body id="academy" data-academy-version="1" data-academy-admin="available">');
  });
});

describe("Academy course page responses", () => {
  let root;
  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "ihear-academy-page-"));
    await cp("academy-site", path.join(root, "academy-site"), { recursive: true });
    await prepareAcademy(root, path.join(root, "public"));
  });
  beforeEach(() => { vi.mocked(currentAdminPrincipal).mockResolvedValue(null); });
  afterEach(() => { vi.restoreAllMocks(); vi.mocked(readAcademyContent).mockReset(); vi.mocked(currentAdminPrincipal).mockReset(); });
  afterAll(async () => { await rm(root, { recursive: true, force: true }); });

  test.each([["en", englishRoute], ["zhHant", chineseRoute]])("%s: the route renders the published content on every request", async (locale, route) => {
    expect(route).toMatchObject({ dynamic: "force-dynamic", runtime: "nodejs", revalidate: 0 });
    vi.spyOn(process, "cwd").mockReturnValue(root);
    const config = defaultAcademyContent();
    config.pricing.rates.USD["60"].highschool = 36;
    config.pricing.rates.TWD["60"].highschool = 1020;
    vi.mocked(readAcademyContent).mockResolvedValue({ config, recordVersion: 3, updatedAt: new Date(0).toISOString(), updatedBy: "editor@example.test" });
    const response = await route.GET();
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("private, no-store, max-age=0");
    expect(response.headers.get("vercel-cdn-cache-control")).toBe("no-store");
    const html = await response.text();
    expect(html).toContain(locale === "en" ? "US$36/session" : "NT$1,020／堂");
    expect(html).toContain('data-academy-version="3"');
    expect(html).not.toContain("editor@example.test");
    // Deployed pages load assets from the course folder.
    expect(html).toContain('src="/academy/courses/script.js?v=20261024-academy-cms-v2"');
    expect(readAcademyContent).toHaveBeenCalledTimes(1);
    expect(html).not.toContain("data-academy-admin");
  });

  test("an administrator receives the editing mark; a failed access check still serves visitors", async () => {
    vi.spyOn(process, "cwd").mockReturnValue(root);
    vi.mocked(readAcademyContent).mockResolvedValue({ config: defaultAcademyContent(), recordVersion: 2, updatedAt: new Date(0).toISOString(), updatedBy: "owner@example.test" });
    vi.mocked(currentAdminPrincipal).mockResolvedValueOnce({ email: "owner@example.test", role: "owner", source: "environment" });
    let response = await serveAcademyPage("en");
    let html = await response.text();
    expect(html).toContain('data-academy-version="2" data-academy-admin="available"');
    expect(html).not.toContain("owner@example.test");
    vi.mocked(currentAdminPrincipal).mockRejectedValueOnce(new Error("admin store unavailable"));
    response = await serveAcademyPage("en");
    expect(response.status).toBe(200);
    html = await response.text();
    expect(html).not.toContain("data-academy-admin");
    expect(html).toContain("US$34/session");
  });

  test("an unavailable store gives a 503 page with no prices", async () => {
    vi.spyOn(process, "cwd").mockReturnValue(root);
    vi.mocked(readAcademyContent).mockRejectedValue(new Error("connection refused at 10.0.0.1"));
    const response = await serveAcademyPage("zhHant");
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("private, no-store, max-age=0");
    const html = await response.text();
    expect(withoutCode(html)).not.toMatch(money);
    expect(html).toContain("課程費用暫時無法載入");
    expect(html).not.toContain("10.0.0.1");
  });

  test("a missing template gives a 503 without reading content", async () => {
    vi.spyOn(process, "cwd").mockReturnValue(path.join(root, "missing"));
    const response = await serveAcademyPage("en");
    expect(response.status).toBe(503);
    expect(await response.text()).toBe("The course page is temporarily unavailable. Please try again later.");
    expect(readAcademyContent).not.toHaveBeenCalled();
    expect(currentAdminPrincipal).not.toHaveBeenCalled();
  });
});
