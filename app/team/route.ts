import { NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { NO_STORE_HEADERS } from "../../lib/response-headers";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export async function GET(request: Request) {
  const html = await readFile(path.join(process.cwd(), ".private", "team.html"), "utf8");
  const response = new NextResponse(html, { headers: { ...NO_STORE_HEADERS, "Content-Type": "text/html; charset=utf-8" } });
  response.cookies.set("ihear-team-access", "", { httpOnly: true, secure: new URL(request.url).protocol === "https:", sameSite: "lax", path: "/", maxAge: 0 });
  return response;
}
