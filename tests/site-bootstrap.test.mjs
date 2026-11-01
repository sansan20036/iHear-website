import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("../lib/site-theme-store", () => ({ readSiteTheme: vi.fn() }));
vi.mock("../lib/site-layout", async (importOriginal) => ({ ...(await importOriginal()), readSiteLayouts: vi.fn() }));
vi.mock("../lib/content-store", async (importOriginal) => ({ ...(await importOriginal()), readContentStore: vi.fn() }));
vi.mock("../lib/impact-store", () => ({ getCurrentSiteMetrics: vi.fn() }));

import { GET as layoutRoute } from "../app/api/site-layout/bootstrap/route";
import { GET as themeRoute } from "../app/api/site-theme/bootstrap/route";
import { readContentStore } from "../lib/content-store";
import { getCurrentSiteMetrics } from "../lib/impact-store";
import { PUBLIC_PAGES, servePublicPage } from "../lib/public-page";
import { renderPageContent } from "../lib/render-page-content";
import { inlineSiteBootstraps, layoutBootstrapScript, scriptJson, templateLayoutPage, themeBootstrapScript, themeFallbackScript } from "../lib/site-bootstrap";
import { isLayoutPage, readSiteLayouts } from "../lib/site-layout";
import { readSiteTheme } from "../lib/site-theme-store";

const theme = { theme: "ocean", recordVersion: 4, updatedAt: "2026-10-30T00:00:00.000Z", updatedBy: "owner@example.com" };
const layouts = [
  { page: "/__global__", config: { hiddenSections: [], orders: {}, links: {} }, recordVersion: 1, updatedAt: "" },
  { page: "/", config: { hiddenSections: ["home.stats"], orders: {}, links: {} }, recordVersion: 3, updatedAt: "2026-10-30T00:00:00.000Z" },
];
const store = { version: 3, updatedAt: "", updatedBy: "editor@example.com", locales: Object.fromEntries(["en", "zhHant", "zhHans"].map((locale) => [locale, { pages: {}, itemUpdatedAt: {} }])) };
const template = (page) => `<!DOCTYPE html>
<html data-theme="warm" lang="en">
<head>
<script data-site-theme-init>/* init */</script>
<script src="/api/site-theme/bootstrap" data-site-theme-bootstrap></script>
<script src="/api/site-layout/bootstrap?page=${encodeURIComponent(page)}" data-site-layout-bootstrap></script>
<meta charset="UTF-8">
<title>iHear</title>
<link rel="stylesheet" href="/assets/theme.css?v=1">
<link rel="stylesheet" href="/assets/site.css?v=1">
</head>
<body><section data-layout-section="home.stats"><p>Numbers</p></section></body>
</html>
`;
let directory;
const head = (html) => html.slice(0, html.indexOf("</head>"));

beforeEach(() => {
  vi.clearAllMocks();
  directory = mkdtempSync(path.join(os.tmpdir(), "ihear-bootstrap-"));
  mkdirSync(path.join(directory, ".private"));
  for (const page of PUBLIC_PAGES) writeFileSync(path.join(directory, ".private", page === "/" ? "index.html" : `${page.slice(1)}.html`), template(page));
  vi.spyOn(process, "cwd").mockReturnValue(directory);
  vi.spyOn(console, "error").mockImplementation(() => {});
  readSiteTheme.mockResolvedValue(theme);
  readSiteLayouts.mockResolvedValue(layouts);
  readContentStore.mockResolvedValue(store);
  getCurrentSiteMetrics.mockResolvedValue(null);
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(directory, { recursive: true, force: true });
});

describe("public pages carry the theme and layout scripts inline", () => {
  test("the scripts are the routes' text, in the tags' place, without administrator data", async () => {
    const response = await servePublicPage(new Request("https://example.com/"), "/");
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store, max-age=0");
    expect(html).not.toContain('src="/api/site-theme/bootstrap"');
    expect(html).not.toContain('src="/api/site-layout/bootstrap');
    const inlineTheme = /<script data-site-theme-bootstrap>([\s\S]*?)<\/script>/.exec(html)[1];
    const inlineLayout = /<script data-site-layout-bootstrap>([\s\S]*?)<\/script>/.exec(html)[1];
    expect(inlineTheme).toBe(await (await themeRoute()).text());
    expect(inlineLayout).toBe(await (await layoutRoute(new Request("https://example.com/api/site-layout/bootstrap?page=%2F"))).text());
    expect(inlineTheme).toContain('"theme":"ocean"');
    expect(inlineLayout).toContain('"hiddenSections":["home.stats"]');
    expect(html).not.toContain("owner@example.com");
    expect(html).not.toContain("editor@example.com");
    // The order the build checks: theme init, theme script, layout script, then the stylesheets.
    const at = (needle) => html.indexOf(needle);
    expect(at("data-site-theme-init")).toBeLessThan(at("<script data-site-theme-bootstrap>"));
    expect(at("<script data-site-theme-bootstrap>")).toBeLessThan(at("<script data-site-layout-bootstrap>"));
    expect(at("<script data-site-layout-bootstrap>")).toBeLessThan(at("/assets/theme.css"));
  });

  test("every public page gets the layout script the route would serve for it", async () => {
    for (const page of PUBLIC_PAGES) {
      const html = await (await servePublicPage(new Request(`https://example.com${page}`), page)).text();
      const inline = /<script data-site-layout-bootstrap>([\s\S]*?)<\/script>/.exec(html)?.[1];
      expect(inline, page).toBe(await (await layoutRoute(new Request(`https://example.com/api/site-layout/bootstrap?page=${encodeURIComponent(page)}`))).text());
      expect(readSiteLayouts).toHaveBeenLastCalledWith(isLayoutPage(page) ? page : "/");
    }
  });

  test("an unreadable theme or layout keeps the page and falls back as the routes do", async () => {
    readSiteTheme.mockRejectedValue(new Error("database offline"));
    readSiteLayouts.mockRejectedValue(new Error("database offline"));
    const response = await servePublicPage(new Request("https://example.com/"), "/");
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).toContain(`<script data-site-theme-bootstrap>${themeFallbackScript()}</script>`);
    expect(html).toContain(`<script data-site-layout-bootstrap>${layoutBootstrapScript("/", [])}</script>`);
  });

  test("an unreadable page still answers 503 with no stale template text", async () => {
    readContentStore.mockRejectedValue(new Error("database offline"));
    const response = await servePublicPage(new Request("https://example.com/"), "/");
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("data-site-layout-bootstrap");
  });
});

describe("inline script safety", () => {
  test("script delimiters and line separators in the data cannot end or break the script", () => {
    const hostile = [{ page: "/", config: { hiddenSections: [], orders: {}, links: { "x": "</script><script>alert(1)</script>\u2028<!--" } }, recordVersion: 2, updatedAt: "" }];
    const script = layoutBootstrapScript("/", hostile);
    expect(script).not.toMatch(/<\/script/i);
    expect(script).not.toContain("<!--");
    expect(script).not.toContain("\u2028");
    expect(JSON.parse(scriptJson(hostile[0].config.links).replace(/\\u003c/g, "<"))).toEqual(hostile[0].config.links);
    expect(themeBootstrapScript({ theme: "ocean", recordVersion: 1, updatedAt: "</script>" })).not.toMatch(/<\/script/i);
  });

  test("scripts are inserted literally, whatever $ sequences they contain", () => {
    const html = inlineSiteBootstraps(template("/"), { theme: "a$&b$'c$`d$$e", layout: "f$1g" });
    expect(html).toContain("<script data-site-theme-bootstrap>a$&b$'c$`d$$e</script>");
    expect(html).toContain("<script data-site-layout-bootstrap>f$1g</script>");
  });

  test("a template without the tags, or a null script, is left alone", () => {
    expect(inlineSiteBootstraps("<head></head>", { theme: "x", layout: "y" })).toBe("<head></head>");
    expect(templateLayoutPage("<head></head>")).toBeNull();
    expect(templateLayoutPage(template("/about"))).toBe("/about");
    const html = inlineSiteBootstraps(template("/"), { theme: null, layout: null });
    expect(html).toBe(template("/"));
  });
});

describe("published content sits at the end of <head>", () => {
  test("stylesheets and scripts come first; the content and its script last, preloaded at the top", () => {
    const html = renderPageContent(template("/"), "/", store, "en", null);
    const top = head(html);
    const at = (needle) => top.indexOf(needle);
    expect(top.match(/id="ihear-published-content"/g)).toHaveLength(1);
    expect(top.match(/<script src="\/assets\/content-bootstrap\.js[^"]*"><\/script>/g)).toHaveLength(1);
    expect(top).toMatch(/^<!DOCTYPE html>\s*<html[^>]*>\s*<head>\n<link rel="preload" href="\/assets\/content-bootstrap\.js\?v=[^"]+" as="script">/);
    expect(at("/assets/site.css")).toBeLessThan(at('<script id="ihear-published-content"'));
    expect(at('<script id="ihear-published-content"')).toBeLessThan(at('<script src="/assets/content-bootstrap.js'));
    expect(html.indexOf('<script src="/assets/content-bootstrap.js')).toBeLessThan(html.indexOf("</head>"));
    expect(html.indexOf("</head>")).toBeLessThan(html.indexOf("<body"));
  });
});
