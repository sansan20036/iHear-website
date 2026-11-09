// Where test consent may be recorded for TEST- codes (the consents route).
// - "trial": the local vendor trial (CLASSROOM_TRIAL_CONSENT=1), never in production.
// - "pilot": the closed adult pilot iHear approved on 2026-11-10, the only way in production: adult
//   testers' consent under "ihear-adult-pilot-consent-v1", only while CLASSROOM_PILOT_CONSENT=1 and
//   both policy versions in force are that version. Real students' lessons are never covered: the
//   route still takes TEST- codes only, and a real consent version replaces this one.
export const ADULT_PILOT_CONSENT_VERSION = "ihear-adult-pilot-consent-v1";

export type TestConsentMode = "trial" | "pilot";

export function testConsentMode(env: Record<string, string | undefined> = process.env): TestConsentMode | null {
  if (env.VERCEL_ENV === "production") {
    const pilot = env.CLASSROOM_PILOT_CONSENT === "1"
      && env.CLASSROOM_CONSENT_VERSION === ADULT_PILOT_CONSENT_VERSION
      && env.CLASSROOM_STAFF_NOTICE_VERSION === ADULT_PILOT_CONSENT_VERSION;
    return pilot ? "pilot" : null;
  }
  return env.CLASSROOM_TRIAL_CONSENT === "1" ? "trial" : null;
}
