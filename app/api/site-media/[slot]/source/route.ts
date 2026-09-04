import { NextResponse } from "next/server";

// @ts-ignore - auth.js is the existing Auth.js configuration.
import { auth } from "../../../../../auth.js";
import { isAllowedAdmin, normalizeEmail } from "../../../../../lib/admins";
import { siteMediaApiError } from "../../../../../lib/site-media-api";
import { listSiteMediaAssets } from "../../../../../lib/site-media-store";
import { readSiteMediaObject } from "../../../../../lib/site-media-storage";
import { isSiteMediaSlot } from "../../../../../lib/site-media-types";
import {
  enforceRateLimit,
  RATE_LIMIT_POLICIES,
  withRateLimitHeaders,
} from "../../../../../lib/rate-limit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type RouteContext = { params: Promise<{ slot: string }> };

function sameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try {
    return new URL(origin).origin === new URL(request.url).origin;
  } catch {
    return false;
  }
}

export async function GET(request: Request, context: RouteContext) {
  if (!sameOrigin(request)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const session = await auth();
  const email = normalizeEmail(session?.user?.email);
  if (!(await isAllowedAdmin(email))) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const decision = await enforceRateLimit(request, { ...RATE_LIMIT_POLICIES.adminMutation, identifier: email });
  if (decision.limited) return decision.response;
  const respond = <T extends Response>(response: T) => withRateLimitHeaders(response, decision);

  const { slot } = await context.params;
  if (!isSiteMediaSlot(slot) || !slot.startsWith("team.") || !slot.endsWith(".avatar")) {
    return respond(NextResponse.json({ error: "Unknown avatar slot" }, { status: 400 }));
  }
  const versionText = new URL(request.url).searchParams.get("expectedVersion") || "";
  if (!/^\d+$/.test(versionText)) {
    return respond(NextResponse.json({ error: "Reload the page before cropping this photo" }, { status: 428 }));
  }

  try {
    const asset = (await listSiteMediaAssets()).find((item) => item.slot === slot);
    if (!asset) return respond(NextResponse.json({ error: "Photo not found" }, { status: 404 }));
    if (asset.recordVersion !== Number(versionText)) {
      return respond(NextResponse.json({ error: "This photo was changed by another administrator" }, { status: 409 }));
    }
    const source = asset.variants.slice().sort((left, right) => right.pixelWidth - left.pixelWidth)[0];
    if (!source) return respond(NextResponse.json({ error: "Photo source not found" }, { status: 404 }));
    const buffer = await readSiteMediaObject(source.storagePath);
    return respond(new Response(buffer, {
      status: 200,
      headers: {
        "Content-Type": "image/webp",
        "Content-Length": String(buffer.byteLength),
        "Cache-Control": "private, no-store, max-age=0",
        "X-Content-Type-Options": "nosniff",
        "Cross-Origin-Resource-Policy": "same-origin",
      },
    }));
  } catch (error) {
    return respond(siteMediaApiError(error));
  }
}
