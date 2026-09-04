import { NextResponse } from "next/server";

import { authorizeAdminRequest } from "../../../../lib/admin-auth";
import {
  AdminAccountConflictError,
  appendAdminActivity,
  createAdminAccount,
  listAdminAccounts,
} from "../../../../lib/admin-store";
import { isOwnerAdmin, normalizeEmail, OWNER_ADMINS } from "../../../../lib/admins";
import { withRateLimitHeaders } from "../../../../lib/rate-limit";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const access = await authorizeAdminRequest(request, { owner: true });
  if ("response" in access) return access.response;
  return NextResponse.json({ owners: OWNER_ADMINS, editors: await listAdminAccounts() }, {
    headers: { "Cache-Control": "private, no-store" },
  });
}

export async function POST(request: Request) {
  const access = await authorizeAdminRequest(request, { owner: true, mutation: true });
  if ("response" in access) return access.response;
  const respond = <T extends Response>(response: T) => withRateLimitHeaders(response, access.decision!);
  try {
    const body = await request.json();
    const email = normalizeEmail(body?.email);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 320) {
      return respond(NextResponse.json({ error: "Please enter a valid email address" }, { status: 400 }));
    }
    if (isOwnerAdmin(email)) {
      return respond(NextResponse.json({ error: "This account is already a fixed owner" }, { status: 409 }));
    }
    const account = await createAdminAccount(email, access.principal.email);
    await appendAdminActivity({
      actorEmail: access.principal.email, actorRole: access.principal.role,
      action: "admin.editor_added", entityType: "admin", entityId: email,
      changedFields: ["email", "enabled"], entityStatus: "enabled", entityVersion: account.version,
    });
    return respond(NextResponse.json({ ok: true, account }, { status: 201 }));
  } catch (error) {
    if (error instanceof AdminAccountConflictError) {
      return respond(NextResponse.json({ error: error.message }, { status: 409 }));
    }
    return respond(NextResponse.json({ error: "Could not add the editor" }, { status: 500 }));
  }
}
