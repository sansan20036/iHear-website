import { NextResponse } from "next/server";

// @ts-ignore - auth.js is the existing Auth.js configuration.
import { auth } from "../../../../auth.js";
import { normalizeEmail, OWNER_ADMINS, resolveAdminPrincipal } from "../../../../lib/admins";

export const dynamic = "force-dynamic";

// Administrator pages check access here, so every answer, including a denial,
// must stay private and uncached.
const headers = {
  "Cache-Control": "private, no-store",
  "Vercel-CDN-Cache-Control": "no-store",
};

export async function GET() {
  try {
    // As in the admin layout: no session (never signed in or expired) differs
    // from a signed-in account without a current administrator role.
    const email = normalizeEmail((await auth())?.user?.email);
    if (!email) return NextResponse.json({ error: "Sign in required", code: "SIGN_IN_REQUIRED" }, { status: 401, headers });
    const principal = await resolveAdminPrincipal(email);
    if (!principal) return NextResponse.json({ error: "Forbidden", code: "FORBIDDEN" }, { status: 403, headers });
    return NextResponse.json({ ok: true, principal, owners: OWNER_ADMINS }, { headers });
  } catch {
    return NextResponse.json({ error: "Administrator access is temporarily unavailable." }, { status: 503, headers });
  }
}
