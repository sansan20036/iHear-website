import { NextResponse } from "next/server";

import { currentAdminPrincipal } from "../../../../lib/admin-auth";
import { OWNER_ADMINS } from "../../../../lib/admins";

export const dynamic = "force-dynamic";

export async function GET() {
  const principal = await currentAdminPrincipal();
  if (!principal) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  return NextResponse.json(
    { ok: true, principal, owners: OWNER_ADMINS },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}
