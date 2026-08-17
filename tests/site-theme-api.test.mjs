import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("../auth.js", () => ({ auth: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("../lib/admins", () => ({
  normalizeEmail: vi.fn((value) => String(value || "").trim().toLowerCase()),
  isAllowedAdmin: vi.fn((email) => email === "admin@example.com"),
}));
vi.mock("../lib/live-revisions", () => ({ revisionAfterMutation: vi.fn() }));
vi.mock("../lib/rate-limit", () => ({
  RATE_LIMIT_POLICIES: { adminMutation: { scope: "admin-mutation", limit: 30, windowSeconds: 60 } },
  enforceRateLimit: vi.fn(),
  withRateLimitHeaders: vi.fn((response) => response),
}));
vi.mock("../lib/site-theme-store", () => {
  class SiteThemeConfigurationError extends Error {}
  class SiteThemeConflictError extends Error {}
  return {
    SiteThemeConfigurationError,
    SiteThemeConflictError,
    readSiteTheme: vi.fn(),
    updateSiteTheme: vi.fn(),
  };
});

import { revalidatePath } from "next/cache";
import { auth } from "../auth.js";
import { GET as bootstrap } from "../app/api/site-theme/bootstrap/route";
import { GET, POST } from "../app/api/site-theme/route";
import * as live from "../lib/live-revisions";
import { enforceRateLimit } from "../lib/rate-limit";
import * as store from "../lib/site-theme-store";

const setting = {
  theme: "ocean",
  recordVersion: 3,
  updatedAt: "2026-08-17T00:00:00.000Z",
  updatedBy: "admin@example.com",
};

function request(body, origin = "https://example.com") {
  return new Request("https://example.com/api/site-theme", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  auth.mockResolvedValue({ user: { email: "admin@example.com" } });
  enforceRateLimit.mockResolvedValue({ limited: false, result: { limit: 30, remaining: 29, resetAt: Date.now() + 60_000 } });
  store.readSiteTheme.mockResolvedValue(setting);
  store.updateSiteTheme.mockResolvedValue({ ...setting, theme: "sage", recordVersion: 4 });
  live.revisionAfterMutation.mockResolvedValue({ revision: "8", updatedAt: setting.updatedAt });
});

describe("site theme API", () => {
  test("GET is public, briefly cached, and hides the administrator", async () => {
    auth.mockResolvedValue(null);
    const response = await GET();
    expect(response.status).toBe(200);
    expect(response.headers.get("Vercel-CDN-Cache-Control")).toContain("s-maxage=1");
    expect(await response.json()).toEqual({ version: 1, theme: "ocean", recordVersion: 3, updatedAt: setting.updatedAt });
  });

  test("bootstrap is safe JavaScript with edge caching and no administrator data", async () => {
    const response = await bootstrap();
    const source = await response.text();
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("application/javascript");
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=0, must-revalidate");
    expect(response.headers.get("Vercel-CDN-Cache-Control")).toBe("public, s-maxage=60, stale-while-revalidate=300");
    expect(source).toContain('"theme":"ocean"');
    expect(source).toContain("__IHEAR_SITE_THEME__");
    expect(source).not.toContain("admin@example.com");
  });

  test("bootstrap failure preserves a valid last-known theme and otherwise falls back to warm", async () => {
    store.readSiteTheme.mockRejectedValueOnce(new Error("offline"));
    const response = await bootstrap();
    const source = await response.text();
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("application/javascript");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(source).toContain('localStorage.getItem("ihear:site-theme")');
    expect(source).toContain('if(!a.has(t))t="warm"');
  });

  test("POST enforces admin, same-origin, allowlist, and expectedVersion", async () => {
    auth.mockResolvedValue(null);
    expect((await POST(request({ theme: "sage", expectedVersion: 3 }))).status).toBe(403);
    auth.mockResolvedValue({ user: { email: "admin@example.com" } });
    expect((await POST(request({ theme: "sage", expectedVersion: 3 }, "https://evil.example"))).status).toBe(403);
    expect((await POST(request({ theme: "hotpink", expectedVersion: 3 }))).status).toBe(400);
    expect((await POST(request({ theme: "sage" }))).status).toBe(428);
    expect((await POST(request({ theme: "sage", expectedVersion: 0 }))).status).toBe(400);
  });

  test("POST publishes with optimistic locking, revision, and complete revalidation", async () => {
    const response = await POST(request({ theme: "sage", expectedVersion: 3 }));
    expect(response.status).toBe(200);
    expect(store.updateSiteTheme).toHaveBeenCalledWith({ theme: "sage", expectedVersion: 3, updatedBy: "admin@example.com" });
    expect(await response.json()).toMatchObject({ ok: true, theme: "sage", recordVersion: 4, revision: { revision: "8" } });
    for (const path of ["/", "/api/site-theme", "/api/site-theme/bootstrap", "/api/live-revisions"]) {
      expect(revalidatePath).toHaveBeenCalledWith(path);
    }
    expect(live.revisionAfterMutation).toHaveBeenCalledWith("theme");
  });

  test("POST returns 409, 429, and 503 without pretending to save", async () => {
    store.updateSiteTheme.mockRejectedValueOnce(new store.SiteThemeConflictError("conflict"));
    expect((await POST(request({ theme: "sage", expectedVersion: 3 }))).status).toBe(409);

    enforceRateLimit.mockResolvedValueOnce({ limited: true, response: new Response("limited", { status: 429 }) });
    expect((await POST(request({ theme: "sage", expectedVersion: 3 }))).status).toBe(429);

    enforceRateLimit.mockResolvedValue({ limited: false, result: { limit: 30, remaining: 29, resetAt: Date.now() + 60_000 } });
    store.updateSiteTheme.mockRejectedValueOnce(new store.SiteThemeConfigurationError("missing"));
    expect((await POST(request({ theme: "sage", expectedVersion: 3 }))).status).toBe(503);
  });
});

describe("theme palette contrast", () => {
  const backgrounds = ["#FAF7F2", "#FFFFFF", "#F0EAE1", "#F2F6FA", "#E5EEF8", "#F1F5F2", "#E2ECE4", "#F6F3F8", "#EDE7F2", "#F4F5F7", "#E8EAEF"];
  const rgb = (hex) => hex.match(/[0-9a-f]{2}/gi).map((part) => parseInt(part, 16) / 255);
  const luminance = (hex) => rgb(hex).map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
  const contrast = (left, right) => (Math.max(luminance(left), luminance(right)) + 0.05) / (Math.min(luminance(left), luminance(right)) + 0.05);

  test.each(backgrounds)("main text exceeds 10:1 on %s", (background) => expect(contrast("#1A2B4C", background)).toBeGreaterThanOrEqual(10));
  test.each(backgrounds)("functional orange remains AA on %s", (background) => expect(contrast("#A04E10", background)).toBeGreaterThanOrEqual(4.5));
});
