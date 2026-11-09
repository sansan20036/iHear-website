import { NextResponse } from "next/server";

import { authorizeAdminRequest } from "../../../../../lib/admin-auth";
import { appendAdminActivity } from "../../../../../lib/admin-store";
import { ADULT_PILOT_CONSENT_VERSION, testConsentMode } from "../../../../../lib/classroom-consent-gate";
import { PERSON_CODE, setSyntheticConsent } from "../../../../../lib/classroom-service";
import { classroomStore } from "../../../../../lib/classroom-store";
import { withRateLimitHeaders } from "../../../../../lib/rate-limit";
import { NO_STORE_HEADERS } from "../../../../../lib/response-headers";

export const dynamic = "force-dynamic";

// Synthetic consent for local development and tests only. The recording consent policy is
// still Justine's to decide, so this route refuses to work outside the synthetic setup, except
// in a vendor trial (CLASSROOM_TRIAL_CONSENT=1, never in production) and then only for TEST-
// codes: the adult testers' recording steps can run, a real student's consent never can.
// In production only the closed adult pilot iHear approved on 2026-11-10 (lib/classroom-consent-gate.ts):
// TEST- codes, each tester's explicit consent recorded by the owner under the pilot version.
const TRIAL_CODE = /^TEST-/;

export async function POST(request: Request) {
  const access = await authorizeAdminRequest(request, { owner: true, mutation: true });
  if ("response" in access) return access.response;
  const respond = (body: unknown, status: number) => withRateLimitHeaders(NextResponse.json(body, { status, headers: NO_STORE_HEADERS }), access.decision!);
  const synthetic = process.env.CLASSROOM_PROVIDER === "synthetic";
  const production = process.env.VERCEL_ENV === "production";
  const pending = () => respond({ error: "Consent records wait for the approved consent policy", code: "POLICY_PENDING" }, 403);
  const mode = synthetic ? (production ? null : "synthetic") : testConsentMode();
  if (!mode) return pending();
  const body = await request.json().catch(() => ({}));
  const personCode = typeof body?.personCode === "string" ? body.personCode.trim() : "";
  const role = body?.role === "tutor" ? "tutor" : "student";
  const status = body?.status === "withdrawn" ? "withdrawn" : "granted";
  if (!PERSON_CODE.test(personCode)) return respond({ error: "Use the person's code", issues: { personCode: "Invalid" } }, 400);
  if (mode !== "synthetic" && !TRIAL_CODE.test(personCode)) return pending();
  const pilot = mode === "pilot";
  await setSyntheticConsent({ store: classroomStore(), personCode, role, status, actor: access.principal.email, now: Date.now(), synthetic: !pilot });
  await appendAdminActivity({
    actorEmail: access.principal.email, actorRole: access.principal.role,
    action: `classroom.${pilot ? "pilot" : "synthetic"}_${role === "tutor" ? "notice" : "consent"}_set`, entityType: "classroom", entityId: personCode,
    changedFields: ["status"], entityStatus: role === "tutor" ? "acknowledged" : status, entityVersion: null,
  });
  return respond(pilot ? { ok: true, synthetic: false, version: ADULT_PILOT_CONSENT_VERSION } : { ok: true, synthetic: true }, 200);
}
