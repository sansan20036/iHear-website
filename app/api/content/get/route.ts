import { NextResponse } from "next/server";

import { publicContentStore, readContentStore } from "../../../../lib/content-store";

export const dynamic = "force-dynamic";

export async function GET() {
  const content = publicContentStore(await readContentStore());

  return NextResponse.json(content, {
    headers: {
      "Cache-Control": "public, max-age=0, must-revalidate",
      "Vercel-CDN-Cache-Control": "public, s-maxage=1",
    },
  });
}
