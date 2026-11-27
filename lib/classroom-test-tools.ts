// Round 18f (the sixth real-Zoom sitting, 2026-11-27): tools for the online test site only. They show on
// the test site's own address (*.vercel.app) or on this computer, never on the live site's domain.
export function testToolsAllowed(): boolean {
  if (typeof window === "undefined") return false;
  const host = window.location.hostname;
  return host.endsWith(".vercel.app") || host === "localhost" || host === "127.0.0.1";
}
