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
          "Cache-Control": "public, max-age=0, must-revalidate",
          "Vercel-CDN-Cache-Control": "public, s-maxage=1, stale-while-revalidate=59",
        },
      },
    );
  } catch (error) {
    return siteMediaApiError(error);
  }
}
