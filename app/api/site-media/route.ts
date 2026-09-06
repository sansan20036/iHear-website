import { NextResponse } from "next/server";

import { siteMediaApiError } from "../../../lib/site-media-api";
import { listSiteMediaAssets } from "../../../lib/site-media-store";
import { publicSiteMediaAsset } from "../../../lib/site-media-types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  try {
    const assets = await listSiteMediaAssets();
    return NextResponse.json(
      {
        version: 1,
        items: Object.fromEntries(assets.map((asset) => [asset.slot, publicSiteMediaAsset(asset)])),
      },
      {
        headers: {
          // This endpoint is the source of truth immediately after an upload or
          // delete. A stale CDN response can otherwise undo a successful
          // optimistic update in the browser.
          "Cache-Control": "private, no-store, max-age=0",
          "Vercel-CDN-Cache-Control": "no-store",
        },
      },
    );
  } catch (error) {
    return siteMediaApiError(error);
  }
}
