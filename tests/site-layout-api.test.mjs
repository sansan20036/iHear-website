import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("../auth.js", () => ({ auth: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("../lib/admins", () => ({ normalizeEmail: vi.fn((value) => String(value || "").toLowerCase()), isAllowedAdmin: vi.fn((email) => email === "admin@example.com") }));
vi.mock("../lib/live-revisions", () => ({ revisionAfterMutation: vi.fn() }));
vi.mock("../lib/rate-limit", () => ({ RATE_LIMIT_POLICIES: { adminMutation: { scope: "admin-mutation", limit: 30, windowSeconds: 60 } }, enforceRateLimit: vi.fn(), withRateLimitHeaders: vi.fn((response) => response) }));
vi.mock("../lib/site-layout", () => ({
  isLayoutPage: vi.fn((page) => ["/", "/__global__"].includes(page)),
  validateLayoutConfig: vi.fn((_page, config) => config?.hiddenSections && Object.values(config.links || {}).every((href) => href === "" || href.startsWith("/") || href.startsWith("https://") || href.startsWith("mailto:")) ? config : null),
  readSiteLayouts: vi.fn(), updateSiteLayout: vi.fn(), updateSiteLayouts: vi.fn(),
}));

import { revalidatePath } from "next/cache";
import { auth } from "../auth.js";
import { GET as bootstrap } from "../app/api/site-layout/bootstrap/route";
import { GET, POST } from "../app/api/site-layout/route";
import * as live from "../lib/live-revisions";
import { enforceRateLimit } from "../lib/rate-limit";
import * as store from "../lib/site-layout";

const config = { hiddenSections: ["home.video"], orders: { "home.cards": ["b", "a"] }, links: { "site.cta.href": "https://example.com" } };
const records = [{ page: "/__global__", config: { hiddenSections: [], orders: {}, links: {} }, recordVersion: 1, updatedAt: "" }, { page: "/", config, recordVersion: 3, updatedAt: "2026-08-23T00:00:00.000Z" }];
function request(body, origin = "https://example.com") { return new Request("https://example.com/api/site-layout", { method: "POST", headers: { "Content-Type": "application/json", Origin: origin }, body: JSON.stringify(body) }); }

beforeEach(() => {
  vi.clearAllMocks(); auth.mockResolvedValue({ user: { email: "admin@example.com" } });
  enforceRateLimit.mockResolvedValue({ limited: false, result: { limit: 30, remaining: 29 } });
  store.readSiteLayouts.mockResolvedValue(records); store.updateSiteLayout.mockResolvedValue({ ...records[1], recordVersion: 4 });
  store.updateSiteLayouts.mockResolvedValue([{ ...records[0], recordVersion: 2 }, { ...records[1], recordVersion: 4 }]);
  live.revisionAfterMutation.mockResolvedValue({ revision: "9", updatedAt: records[1].updatedAt });
});

describe("site layout API", () => {
  test("GET and bootstrap are public, uncached, and bootstrap hides before paint", async () => {
    const response = await GET(new Request("https://example.com/api/site-layout?page=/"));
    expect(response.status).toBe(200); expect(response.headers.get("Cache-Control")).toBe("no-store");
    const script = await (await bootstrap(new Request("https://example.com/api/site-layout/bootstrap?page=/"))).text();
    expect(script).toContain("ihear-layout-bootstrap-style"); expect(script).toContain("home.video"); expect(script).toContain("display:none!important");
  });
  test("POST enforces origin, admin, allowlist, and optimistic version", async () => {
    expect((await POST(request({ page: "/", config, expectedVersion: 3 }, "https://evil.example"))).status).toBe(403);
    auth.mockResolvedValue(null); expect((await POST(request({ page: "/", config, expectedVersion: 3 }))).status).toBe(403);
    auth.mockResolvedValue({ user: { email: "admin@example.com" } });
    expect((await POST(request({ page: "/unknown", config, expectedVersion: 3 }))).status).toBe(400);
  });
  test("POST publishes and announces layout revision", async () => {
    const response = await POST(request({ page: "/", config, expectedVersion: 3 }));
    expect(response.status).toBe(200); expect(store.updateSiteLayout).toHaveBeenCalledWith("/", config, 3, "admin@example.com");
    expect(live.revisionAfterMutation).toHaveBeenCalledWith("layout");
    expect(revalidatePath).toHaveBeenCalledWith("/api/site-layout/bootstrap");
  });
  test("POST publishes page and global scopes atomically with one revision", async () => {
    const updates = [
      { page: "/__global__", config: records[0].config, expectedVersion: 1 },
      { page: "/", config, expectedVersion: 3 },
    ];
    const response = await POST(request({ updates }));
    expect(response.status).toBe(200);
    expect(store.updateSiteLayouts).toHaveBeenCalledWith(updates, "admin@example.com");
    expect(store.updateSiteLayout).not.toHaveBeenCalled();
    expect(live.revisionAfterMutation).toHaveBeenCalledTimes(1);
    const result = await response.json();
    expect(result.records).toHaveLength(2); expect(result.record).toBeUndefined();
  });
  test("POST rejects duplicate scopes and invalid URLs before writing", async () => {
    const duplicate = { updates: [{ page: "/", config, expectedVersion: 3 }, { page: "/", config, expectedVersion: 3 }] };
    expect((await POST(request(duplicate))).status).toBe(400);
    const unsafe = { ...config, links: { "site.cta.href": "javascript:alert(1)" } };
    expect((await POST(request({ updates: [{ page: "/", config: unsafe, expectedVersion: 3 }] }))).status).toBe(400);
    expect(store.updateSiteLayouts).not.toHaveBeenCalled();
  });
  test("POST returns 409 on a stale version", async () => {
    store.updateSiteLayout.mockRejectedValueOnce(new Error("conflict"));
    expect((await POST(request({ page: "/", config, expectedVersion: 3 }))).status).toBe(409);
  });
  test("batch conflict returns 409 without announcing a revision", async () => {
    store.updateSiteLayouts.mockRejectedValueOnce(new Error("conflict"));
    const response = await POST(request({ updates: [
      { page: "/__global__", config: records[0].config, expectedVersion: 1 },
      { page: "/", config, expectedVersion: 3 },
    ] }));
    expect(response.status).toBe(409); expect(live.revisionAfterMutation).not.toHaveBeenCalled();
  });
});
