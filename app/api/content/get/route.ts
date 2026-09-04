import { NextResponse } from "next/server";

import { publicContentStore, readContentStore } from "../../../../lib/content-store";

export const dynamic = "force-dynamic";

export async function GET(request: Request = new Request("http://localhost/api/content/get")) {
  const requestedPage = new URL(request.url).searchParams.get("page")?.trim();
  const page = requestedPage && requestedPage.startsWith("/") && requestedPage.length <= 500 ? requestedPage : undefined;
  const content = publicContentStore(await readContentStore(page));

  return NextResponse.json(content, {
    headers: {
      "Cache-Control": "public, max-age=0, must-revalidate",
      "Vercel-CDN-Cache-Control": "public, s-maxage=1",
    },
  });
}
