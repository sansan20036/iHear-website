import { NO_STORE_HEADERS } from "../../../../../lib/response-headers";
import { findSiteMediaImagePath } from "../../../../../lib/site-media-store";
import { readSiteMediaObject } from "../../../../../lib/site-media-storage";
import { isSiteMediaSlot } from "../../../../../lib/site-media-types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request, context: { params: Promise<{ slot: string }> }) {
  const { slot } = await context.params;
  if (!isSiteMediaSlot(slot)) return new Response(null, { status: 404, headers: NO_STORE_HEADERS });
  const parameters = new URL(request.url).searchParams;
  const width = Number(parameters.get("width"));
  if (![480, 800, 1200].includes(width)) return new Response(null, { status: 404, headers: NO_STORE_HEADERS });
  const storagePath = await findSiteMediaImagePath(slot, width);
  if (!storagePath) return new Response(null, { status: 404, headers: NO_STORE_HEADERS });
  const asset = parameters.get("asset");
  // Never cache newer bytes at an older image's URL. Error and legacy URLs stay
  // uncached; the metadata API always provides the current unique image URL.
  if (asset !== null && asset !== storagePath) return new Response(null, { status: 404, headers: NO_STORE_HEADERS });
  const cacheHeaders = asset === storagePath ? {
    "Cache-Control": "public, max-age=31536000, immutable",
    "Vercel-CDN-Cache-Control": "public, s-maxage=31536000",
  } : NO_STORE_HEADERS;
  const bytes = await readSiteMediaObject(storagePath);
  return new Response(new Uint8Array(bytes), { headers: {
    ...cacheHeaders, "Content-Type": "image/webp", "X-Content-Type-Options": "nosniff",
  } });
}
