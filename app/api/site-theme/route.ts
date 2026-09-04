import { NextResponse } from "next/server";

// @ts-ignore - auth.js is the existing Auth.js configuration.
import { auth } from "../../../auth.js";
import { isAllowedAdmin, normalizeEmail } from "../../../lib/admins";
import { invalidateSiteTheme, siteThemeApiError } from "../../../lib/site-theme-api";
import { readSiteTheme, updateSiteTheme } from "../../../lib/site-theme-store";
import { isSiteThemeId, publicSiteThemeSetting } from "../../../lib/site-theme-types";
import { enforceRateLimit, RATE_LIMIT_POLICIES, withRateLimitHeaders } from "../../../lib/rate-limit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function isSameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try {
    return new URL(origin).origin === new URL(request.url).origin;
  } catch {
    return false;
  }
}

export async function GET() {
  try {
    return NextResponse.json(
      { version: 1, ...publicSiteThemeSetting(await readSiteTheme()) },
      {
        headers: {
          "Cache-Control": "no-store",
          "Vercel-CDN-Cache-Control": "no-store",
        },
      },
    );
  } catch (error) {
    const response = siteThemeApiError(error);
    response.headers.set("Cache-Control", "no-store");
    response.headers.set("Vercel-CDN-Cache-Control", "no-store");
    return response;
  }
}

export async function POST(request: Request) {
  if (!isSameOrigin(request)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const session = await auth();
  const email = normalizeEmail(session?.user?.email);
  if (!(await isAllowedAdmin(email))) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const decision = await enforceRateLimit(request, {
    ...RATE_LIMIT_POLICIES.adminMutation,
    identifier: email,
  });
  if (decision.limited) return decision.response;
  const respond = <T extends Response>(response: T) => withRateLimitHeaders(response, decision);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return respond(NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }));
  }
  const payload = body as { theme?: unknown; expectedVersion?: unknown };
  if (!Object.prototype.hasOwnProperty.call(payload, "expectedVersion")) {
    return respond(NextResponse.json({ error: "Reload before changing the site theme" }, { status: 428 }));
  }
  const expectedVersion = Number(payload.expectedVersion);
  if (!isSiteThemeId(payload.theme) || !Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
    return respond(NextResponse.json({ error: "Invalid site theme fields" }, { status: 400 }));
  }

  try {
    const setting = await updateSiteTheme({ theme: payload.theme, expectedVersion, updatedBy: email });
    const revision = await invalidateSiteTheme();
    return respond(NextResponse.json({ ok: true, ...publicSiteThemeSetting(setting), revision }));
  } catch (error) {
    return respond(siteThemeApiError(error));
  }
}
