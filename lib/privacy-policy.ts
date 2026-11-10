import policyState from "../data/privacy-policy.json";

// The privacy policy (2026-11-10): a draft until iHear approves it (data/privacy-policy.json and
// scripts/privacy-policy.mjs). Fail closed: a draft is served only in an explicit local preview
// (IHEAR_PRIVACY_PREVIEW=1) where no hosting platform's marker is set. A Vercel preview or
// production, an unknown host, or a missing setting answers 404 for /privacy until the approved
// policy is deployed. The same rule decides the build output (privacyPolicyShown); a test keeps the
// two lists of markers equal.
export const PRIVACY_POLICY_APPROVED: boolean = policyState.status === "approved";

export const HOSTING_MARKERS = ["VERCEL", "VERCEL_ENV", "VERCEL_URL", "NETLIFY", "CONTEXT", "AWS_LAMBDA_FUNCTION_NAME", "AWS_EXECUTION_ENV", "K_SERVICE", "FUNCTION_TARGET", "RENDER", "FLY_APP_NAME", "RAILWAY_ENVIRONMENT", "DYNO", "WEBSITE_SITE_NAME", "CF_PAGES"];

export function privacyPolicyAvailable(env: Record<string, string | undefined> = process.env) {
  if (PRIVACY_POLICY_APPROVED) return true;
  return env.IHEAR_PRIVACY_PREVIEW === "1" && !HOSTING_MARKERS.some((name) => Boolean(env[name]));
}
