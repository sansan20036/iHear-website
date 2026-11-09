import { NextResponse } from "next/server";

// @ts-ignore - auth.js is the existing Auth.js configuration.
import { auth } from "../../../../../../auth.js";
import { isSameOrigin } from "../../../../../../lib/admin-auth";
import { appendAdminActivity } from "../../../../../../lib/admin-store";
import { normalizeEmail, resolveAdminPrincipal } from "../../../../../../lib/admins";
import { blockManageView, manageBlock } from "../../../../../../lib/classroom-blocks";
import { classroomDrive } from "../../../../../../lib/classroom-drive";
import { classroomProvider } from "../../../../../../lib/classroom-provider";
import { classroomStore } from "../../../../../../lib/classroom-store";
import { enforceRateLimit, RATE_LIMIT_POLICIES, withRateLimitHeaders } from "../../../../../../lib/rate-limit";
import { NO_STORE_HEADERS } from "../../../../../../lib/response-headers";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ blockId: string }> };

// Who is asking, from the sign-in, on every request (18.1): the block decides whether this e-mail
// is its manager; a site owner may run any block. A sign-in that ended runs nothing.
async function principal() {
  const session = await auth();
  const email = normalizeEmail(session?.user?.email) || null;
  const admin = email ? await resolveAdminPrincipal(email) : null;
  return { email, owner: admin?.role === "owner", admin };
}

// The manager's view of the block (the manage page refreshes it every few seconds).
export async function GET(request: Request, context: Context) {
  const { blockId } = await context.params;
  const who = await principal();
  if (!who.email) return NextResponse.json({ error: "Sign in", code: "SIGN_IN_REQUIRED" }, { status: 401, headers: NO_STORE_HEADERS });
  const decision = await enforceRateLimit(request, { scope: "classroom-block-view", limit: 60, windowSeconds: 60, identifier: `${who.email}:${blockId}` });
  if (decision.limited) return decision.response;
  try {
    const result = await blockManageView({ store: classroomStore(), blockId, principal: who, now: Date.now() });
    return withRateLimitHeaders(NextResponse.json(result.body, { status: result.status, headers: NO_STORE_HEADERS }), decision);
  } catch {
    return NextResponse.json({ error: "The block is temporarily unavailable" }, { status: 503, headers: NO_STORE_HEADERS });
  }
}

// One change to the block by its manager or an owner, checked again on the server (manageBlock).
export async function POST(request: Request, context: Context) {
  if (!isSameOrigin(request)) return NextResponse.json({ error: "Cross-origin request blocked" }, { status: 403, headers: NO_STORE_HEADERS });
  const { blockId } = await context.params;
  const who = await principal();
  if (!who.email) return NextResponse.json({ error: "Sign in", code: "SIGN_IN_REQUIRED" }, { status: 401, headers: NO_STORE_HEADERS });
  const decision = await enforceRateLimit(request, { ...RATE_LIMIT_POLICIES.adminMutation, scope: "classroom-block-manage", identifier: `${who.email}:${blockId}` });
  if (decision.limited) return decision.response;
  const respond = (body: unknown, status: number) => withRateLimitHeaders(NextResponse.json(body, { status, headers: NO_STORE_HEADERS }), decision);
  let provider;
  try {
    provider = classroomProvider();
  } catch {
    return respond({ error: "The classroom is not available yet", code: "PROVIDER_UNAVAILABLE" }, 503);
  }
  try {
    const body = await request.json().catch(() => ({}));
    const { action, ...input } = (body ?? {}) as Record<string, unknown>;
    const result = await manageBlock({ store: classroomStore(), provider, drive: classroomDrive(), blockId, principal: who, action, input, now: Date.now() });
    if (result.status === 200 && who.owner && who.admin) {
      await appendAdminActivity({
        actorEmail: who.admin.email, actorRole: who.admin.role, action: `classroom.block_${String(action)}`, entityType: "classroom", entityId: blockId,
        changedFields: Object.keys(input).filter((field) => field !== "version"), entityStatus: "updated", entityVersion: null,
      });
    }
    return respond(result.body, result.status);
  } catch {
    return respond({ error: "The block is temporarily unavailable" }, 503);
  }
}
