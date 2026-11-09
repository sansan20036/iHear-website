import { NextResponse } from "next/server";

// @ts-ignore - auth.js is the existing Auth.js configuration.
import { auth } from "../auth.js";
import { normalizeEmail, resolveAdminPrincipal, type AdminPrincipal } from "./admins";
import { enforceRateLimit, RATE_LIMIT_POLICIES, type RateLimitDecision, type RateLimitPolicy } from "./rate-limit";

export function isSameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try {
    return new URL(origin).origin === new URL(request.url).origin;
  } catch {
    return false;
  }
}

export async function currentAdminPrincipal() {
  const session = await auth();
  return resolveAdminPrincipal(normalizeEmail(session?.user?.email));
}

export async function authorizeAdminRequest(
  request: Request,
  // `rateLimit` gives a request its own allowance in place of the shared admin one (the same
  // sign-in, owner and same-origin checks still apply); only for background work such as the
  // classroom overview's tick, never for a change a person makes.
  options: { owner?: boolean; mutation?: boolean; upload?: boolean; translation?: boolean; rateLimit?: RateLimitPolicy } = {},
): Promise<
  | { principal: AdminPrincipal; decision?: RateLimitDecision }
  | { response: NextResponse }
> {
  const principal = await currentAdminPrincipal();
  if (!principal) return { response: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  if (options.owner && principal.role !== "owner") {
    return { response: NextResponse.json({ error: "Owner access is required" }, { status: 403 }) };
  }
  if (options.mutation || options.upload || options.translation) {
    if (!isSameOrigin(request)) {
      return { response: NextResponse.json({ error: "Cross-origin request blocked" }, { status: 403 }) };
    }
    const policy: RateLimitPolicy = options.rateLimit
      ? options.rateLimit
      : options.upload
        ? RATE_LIMIT_POLICIES.mediaUpload
        : options.translation
          ? RATE_LIMIT_POLICIES.translation
          : RATE_LIMIT_POLICIES.adminMutation;
    const decision = await enforceRateLimit(request, { ...policy, identifier: principal.email });
    if (decision.limited) return { response: decision.response };
    return { principal, decision };
  }
  return { principal };
}
