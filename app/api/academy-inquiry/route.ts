import { NextResponse } from "next/server";

import {
  ACADEMY_INQUIRY_RATE_LIMIT,
  AcademyInquiryError,
  academyInquiryOriginAllowed,
  readAcademyInquiryBody,
  sendAcademyInquiry,
  validateAcademyInquiry,
} from "../../../lib/academy-inquiry";
import { enforceRateLimit, withRateLimitHeaders } from "../../../lib/rate-limit";
import { NO_STORE_HEADERS } from "../../../lib/response-headers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function json(body: object, status = 200) {
  return NextResponse.json(body, { status, headers: NO_STORE_HEADERS });
}

export async function POST(request: Request) {
  if (!academyInquiryOriginAllowed(request)) {
    return json({ code: "ORIGIN_NOT_ALLOWED" }, 403);
  }
  const decision = await enforceRateLimit(request, ACADEMY_INQUIRY_RATE_LIMIT);
  if (decision.limited) {
    if (decision.response.status === 429) return decision.response;
    return json({ code: "EMAIL_UNAVAILABLE" }, 503);
  }
  const respond = (body: object, status = 200) => withRateLimitHeaders(json(body, status), decision);
  try {
    const inquiry = validateAcademyInquiry(await readAcademyInquiryBody(request));
    await sendAcademyInquiry(inquiry);
    return respond({ ok: true });
  } catch (error) {
    if (error instanceof AcademyInquiryError) return respond({ code: error.code }, error.status);
    return respond({ code: "DELIVERY_UNCONFIRMED" }, 502);
  }
}
