import { NextResponse } from "next/server";

import { authorizeAdminRequest } from "../../../../../lib/admin-auth";
import { appendAdminActivity } from "../../../../../lib/admin-store";
import { PERSON_CODE, setSyntheticConsent } from "../../../../../lib/classroom-service";
import { classroomStore } from "../../../../../lib/classroom-store";
import { withRateLimitHeaders } from "../../../../../lib/rate-limit";
import { NO_STORE_HEADERS } from "../../../../../lib/response-headers";

export const dynamic = "force-dynamic";

// Synthetic consent for local development and tests only. The recording consent policy is
// still Justine's to decide, so this route refuses to work outside the synthetic setup.
export async function POST(request: Request) {
  const access = await authorizeAdminRequest(request, { owner: true, mutation: true });
  if ("response" in access) return access.response;
  const respond = (body: unknown, status: number) => withRateLimitHeaders(NextResponse.json(body, { status, headers: NO_STORE_HEADERS }), access.decision!);
  if (process.env.CLASSROOM_PROVIDER !== "synthetic" || process.env.VERCEL_ENV === "production") {
    return respond({ error: "Consent records wait for the approved consent policy", code: "POLICY_PENDING" }, 403);
  }
  const body = await request.json().catch(() => ({}));
  const personCode = typeof body?.personCode === "string" ? body.personCode.trim() : "";
  const role = body?.role === "tutor" ? "tutor" : "student";
  const status = body?.status === "withdrawn" ? "withdrawn" : "granted";
  if (!PERSON_CODE.test(personCode)) return respond({ error: "Use the person's code", issues: { personCode: "Invalid" } }, 400);
  await setSyntheticConsent({ store: classroomStore(), personCode, role, status, actor: access.principal.email, now: Date.now() });
  await appendAdminActivity({
    actorEmail: access.principal.email, actorRole: access.principal.role,
    action: role === "tutor" ? "classroom.synthetic_notice_set" : "classroom.synthetic_consent_set", entityType: "classroom", entityId: personCode,
    changedFields: ["status"], entityStatus: role === "tutor" ? "acknowledged" : status, entityVersion: null,
  });
  return respond({ ok: true, synthetic: true }, 200);
}
