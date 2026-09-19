export const productionOrigin = "https://www.ihearus.org";
export const publicPages = ["/", "/about", "/programs", "/impact", "/team", "/submit-bio", "/stories", "/get-involved", "/academy", "/donate", "/resources", "/faq", "/contact"];
const publicApis = new Set([
  "/api/auth/session", "/api/health", "/api/content/get", "/api/team-profiles",
  "/api/impact-milestones", "/api/site-media", "/api/site-metrics", "/api/resources",
  "/api/site-theme", "/api/site-theme/bootstrap", "/api/live-revisions",
  "/api/site-layout", "/api/site-layout/bootstrap", "/api/media-galleries",
]);

// Fail closed: even a GET to an administrative endpoint is outside this inspection.
export function readOnlyDecision({ url, method, navigation = false }) {
  const target = new URL(url);
  if (!["GET", "HEAD"].includes(method)) return "non-read-method";
  if (target.protocol !== "https:" || target.username || target.password) return "unsafe-url";
  if (navigation && (target.origin !== productionOrigin || !publicPages.includes(target.pathname))) return "non-public-navigation";
  if (target.origin === productionOrigin) {
    if (target.pathname.startsWith("/api/")) {
      const publicImage = /^\/api\/site-media\/[A-Za-z0-9._-]+\/image$/.test(target.pathname);
      if (!publicApis.has(target.pathname) && !publicImage) return "non-public-api";
      if (target.searchParams.has("admin") || target.searchParams.has("includeDrafts")) return "administrative-query";
    } else if (!publicPages.includes(target.pathname) && !target.pathname.startsWith("/assets/") && !target.pathname.startsWith("/_next/") && target.pathname !== "/favicon.ico") {
      return "non-public-path";
    }
  }
  return null;
}

export async function installReadOnlyGuard(context, blocked) {
  await context.route("**/*", async route => {
    const request = route.request();
    const reason = readOnlyDecision({ url: request.url(), method: request.method(), navigation: request.isNavigationRequest() });
    if (reason) {
      // No request bodies, cookies or query values are copied into reports.
      const url = new URL(request.url());
      blocked.push({ method: request.method(), url: `${url.origin}${url.pathname}`, reason });
      await route.abort("blockedbyclient");
    } else {
      await route.continue();
    }
  });
  await context.routeWebSocket("**/*", socket => {
    blocked.push({ reason: "websocket" });
    socket.close();
  });
}
