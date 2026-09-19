import { NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { NO_STORE_HEADERS } from "../../lib/response-headers";
import { publicContentStore, readContentStore } from "../../lib/content-store";
import { renderPageContent, requestContentLocale } from "../../lib/render-page-content";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export async function GET(request: Request) {
  const locale = requestContentLocale(request);
  const [template, content] = await Promise.all([
    readFile(path.join(process.cwd(), ".private", "team.html"), "utf8"),
    readContentStore("/team").then(publicContentStore).catch(() => null),
  ]);
  // Do not pass off the historical template as current data during an outage.
  if (!content) {
    const message = locale === "en" ? "Team information is temporarily unavailable. Please try again." : locale === "zhHant" ? "團隊資料暫時無法載入，請稍後重試。" : "团队资料暂时无法加载，请稍后重试。";
    const retry = locale === "en" ? "Try again" : "重試 / 重试";
    return new NextResponse(`<!doctype html><html lang="${locale === "en" ? "en" : locale === "zhHant" ? "zh-Hant" : "zh-Hans"}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>iHear Team</title></head><body><main><h1>iHear Team</h1><p>${message}</p><a href="/team">${retry}</a></main></body></html>`, { status: 503, headers: { ...NO_STORE_HEADERS, "Content-Type": "text/html; charset=utf-8", "Retry-After": "5" } });
  }
  const html = renderPageContent(template, "/team", content, locale);
  const response = new NextResponse(html, { headers: { ...NO_STORE_HEADERS, "Content-Type": "text/html; charset=utf-8" } });
  response.cookies.set("ihear-team-access", "", { httpOnly: true, secure: new URL(request.url).protocol === "https:", sameSite: "lax", path: "/", maxAge: 0 });
  return response;
}
