import { NextResponse } from "next/server";

import { authorizeAdminRequest } from "../../../../lib/admin-auth";
import { listAdminActivity } from "../../../../lib/admin-store";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const access = await authorizeAdminRequest(request, { owner: true });
  if ("response" in access) return access.response;
  const limit = Number(new URL(request.url).searchParams.get("limit") || 50);
  return NextResponse.json({ activity: await listAdminActivity(limit) }, {
    headers: { "Cache-Control": "private, no-store" },
  });
}
