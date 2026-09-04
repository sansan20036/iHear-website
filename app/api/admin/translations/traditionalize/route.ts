import { NextResponse } from "next/server";
import OpenCC from "opencc-js";

import { authorizeAdminRequest } from "../../../../../lib/admin-auth";
import { withRateLimitHeaders } from "../../../../../lib/rate-limit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const toTaiwanTraditional = OpenCC.Converter({ from: "cn", to: "twp" });

export async function POST(request: Request) {
  const access = await authorizeAdminRequest(request, { mutation: true });
  if ("response" in access) return access.response;
  const respond = <T extends Response>(response: T) => withRateLimitHeaders(response, access.decision!);
  let body: unknown;
  try { body = await request.json(); }
  catch { return respond(NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })); }
  const value = typeof (body as { value?: unknown })?.value === "string" ? (body as { value: string }).value : "";
  if (!value.trim() || value.length > 5_000) return respond(NextResponse.json({ error: "Invalid Chinese text" }, { status: 400 }));
  return respond(NextResponse.json({ value: toTaiwanTraditional(value) }, { headers: { "Cache-Control": "private, no-store" } }));
}
