import { NextResponse } from "next/server";

import { readContentStore } from "../../../../lib/content-store";

export const dynamic = "force-dynamic";

export async function GET() {
  const content = await readContentStore();

  return NextResponse.json(content, {
    headers: {
      "Cache-Control": "no-store",
    },
  });
}
