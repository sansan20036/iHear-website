import { handlers } from "../../../../auth.js";
import {
  enforceRateLimit,
  RATE_LIMIT_POLICIES,
  withRateLimitHeaders,
} from "../../../../lib/rate-limit";

export const GET = handlers.GET;

export async function POST(request, context) {
  const decision = await enforceRateLimit(request, RATE_LIMIT_POLICIES.auth);
  if (decision.limited) return decision.response;
  return withRateLimitHeaders(await handlers.POST(request, context), decision);
}
