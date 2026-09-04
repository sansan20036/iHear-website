import { NextResponse } from "next/server";

import { authorizeAdminRequest } from "../../../../../lib/admin-auth";
import {
  AdminAccountConflictError,
  AdminAccountNotFoundError,
  appendAdminActivity,
  updateAdminAccount,
} from "../../../../../lib/admin-store";
import { isOwnerAdmin, normalizeEmail } from "../../../../../lib/admins";
import { withRateLimitHeaders } from "../../../../../lib/rate-limit";

type Context = { params: Promise<{ email: string }> };

export async function PATCH(request: Request, context: Context) {
  const access = await authorizeAdminRequest(request, { owner: true, mutation: true });
  if ("response" in access) return access.response;
  const respond = <T extends Response>(response: T) => withRateLimitHeaders(response, access.decision!);
  try {
    const email = normalizeEmail(decodeURIComponent((await context.params).email));
    if (!email || isOwnerAdmin(email)) {
      return respond(NextResponse.json({ error: "Fixed owners cannot be changed here" }, { status: 400 }));
    }
    const body = await request.json();
    if (typeof body?.enabled !== "boolean" || !Number.isInteger(body?.version) || body.version < 1) {
      return respond(NextResponse.json({ error: "Invalid editor update" }, { status: 400 }));
    }
    const account = await updateAdminAccount(email, body.enabled, body.version, access.principal.email);
    await appendAdminActivity({
      actorEmail: access.principal.email, actorRole: access.principal.role,
      action: body.enabled ? "admin.editor_enabled" : "admin.editor_disabled",
      entityType: "admin", entityId: email, changedFields: ["enabled"],
      entityStatus: body.enabled ? "enabled" : "disabled", entityVersion: account.version,
    });
    return respond(NextResponse.json({ ok: true, account }));
  } catch (error) {
    if (error instanceof AdminAccountNotFoundError) {
      return respond(NextResponse.json({ error: error.message }, { status: 404 }));
    }
    if (error instanceof AdminAccountConflictError) {
      return respond(NextResponse.json({ error: error.message }, { status: 409 }));
    }
    return respond(NextResponse.json({ error: "Could not update the editor" }, { status: 500 }));
  }
}
