import { NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { NO_STORE_HEADERS } from "./response-headers";
import { publicContentStore, readContentStore } from "./content-store";
import { logDatabaseModeOnce } from "./database-mode";
import { renderPageContent, requestContentLocale } from "./render-page-content";
import { getCurrentSiteMetrics } from "./impact-store";
import { publicImpactMilestone } from "./impact-types";
import { inlineSiteBootstraps, readLayoutBootstrap, readThemeBootstrap, templateLayoutPage } from "./site-bootstrap";

export const PUBLIC_PAGES = ["/", "/about", "/programs", "/impact", "/team", "/submit-bio", "/stories", "/get-involved", "/academy", "/donate", "/resources", "/faq", "/contact", "/events"];

export async function servePublicPage(request: Request, page: string) {
  if (!PUBLIC_PAGES.includes(page)) return new NextResponse("Not found", { status: 404 });
  // One fixed word per instance in the runtime log, so a release can confirm the connection mode.
  logDatabaseModeOnce();
  const locale = requestContentLocale(request);
  try {
    const [template, content, metrics, themeScript, layoutScript] = await Promise.all([
      readFile(path.join(process.cwd(), ".private", page === "/" ? "index.html" : `${page.slice(1)}.html`), "utf8"),
      readContentStore(page).then(publicContentStore),
      page === "/" ? getCurrentSiteMetrics().then(value => value ? publicImpactMilestone(value) : null) : Promise.resolve(undefined),
      // Read with the content and written into the page, so the first paint waits for no further
      // request. Neither read throws: each falls back exactly as its bootstrap route does.
      readThemeBootstrap(),
      readLayoutBootstrap(page),
    ]);
    const html = inlineSiteBootstraps(renderPageContent(template, page, content, locale, metrics), {
      theme: themeScript,
      // Only when the template's tag asks for this page; any other tag keeps loading from the route.
      layout: templateLayoutPage(template) === page ? layoutScript : null,
    });
    return new NextResponse(html, { headers: { ...NO_STORE_HEADERS, "Content-Type": "text/html; charset=utf-8" } });
  } catch {
    // An unavailable data source must not expose old template text as current.
    const message = locale === "en" ? "Page information is temporarily unavailable. Please try again." : locale === "zhHant" ? "頁面資料暫時無法載入，請稍後重試。" : "页面资料暂时无法加载，请稍后重试。";
    const retry = locale === "en" ? "Try again" : locale === "zhHant" ? "重試" : "重试";
    return new NextResponse(`<!doctype html><html lang="${locale === "en" ? "en" : locale === "zhHant" ? "zh-Hant" : "zh-Hans"}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>iHear</title></head><body><main><h1>iHear</h1><p>${message}</p><a href="${page}">${retry}</a></main></body></html>`, { status: 503, headers: { ...NO_STORE_HEADERS, "Content-Type": "text/html; charset=utf-8", "Retry-After": "5" } });
  }
}
