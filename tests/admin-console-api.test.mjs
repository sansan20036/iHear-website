import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("../auth.js", () => ({ auth: vi.fn() }));
vi.mock("../lib/admin-store", () => ({
  findAdminAccount: vi.fn(),
  listAdminAccounts: vi.fn(),
  createAdminAccount: vi.fn(),
  updateAdminAccount: vi.fn(),
  appendAdminActivity: vi.fn(),
  listAdminActivity: vi.fn(),
  AdminAccountConflictError: class AdminAccountConflictError extends Error {},
  AdminAccountNotFoundError: class AdminAccountNotFoundError extends Error {},
}));
vi.mock("../lib/rate-limit", () => ({
  RATE_LIMIT_POLICIES: {
    adminMutation: { scope: "admin-mutation", limit: 30, windowSeconds: 60 },
    mediaUpload: { scope: "media-upload", limit: 10, windowSeconds: 600 },
  },
  enforceRateLimit: vi.fn(),
  withRateLimitHeaders: vi.fn((response) => response),
}));

import { auth } from "../auth.js";
import { authorizeAdminRequest, currentAdminPrincipal, isSameOrigin } from "../lib/admin-auth";
import * as store from "../lib/admin-store";
import { enforceRateLimit } from "../lib/rate-limit";
import { GET as getAccounts, POST as addAccount } from "../app/api/admin/accounts/route";

const owner = "sansan20036@gmail.com";
const editor = "teacher@example.org";

beforeEach(() => {
  vi.clearAllMocks();
  auth.mockResolvedValue({ user: { email: owner } });
  store.findAdminAccount.mockResolvedValue(null);
  store.listAdminAccounts.mockResolvedValue([]);
  store.appendAdminActivity.mockResolvedValue(undefined);
  enforceRateLimit.mockResolvedValue({
    limited: false,
    result: { allowed: true, limit: 30, remaining: 29, retryAfter: 60, resetAt: new Date().toISOString() },
  });
});

describe("admin roles and request protection", () => {
  test("resolves fixed environment owners without a database account", async () => {
    await expect(currentAdminPrincipal()).resolves.toMatchObject({ email: owner, role: "owner", source: "environment" });
    expect(store.findAdminAccount).not.toHaveBeenCalled();
  });

  test("accepts enabled editors and rejects disabled editors", async () => {
    auth.mockResolvedValue({ user: { email: editor } });
    store.findAdminAccount.mockResolvedValue({ email: editor, enabled: true });
    await expect(currentAdminPrincipal()).resolves.toMatchObject({ email: editor, role: "editor" });
    store.findAdminAccount.mockResolvedValue({ email: editor, enabled: false });
    await expect(currentAdminPrincipal()).resolves.toBeNull();
  });

  test("blocks cross-origin mutations before rate limiting", async () => {
    const request = new Request("http://localhost/api/admin/accounts", { method: "POST", headers: { origin: "https://evil.example" } });
    expect(isSameOrigin(request)).toBe(false);
    const access = await authorizeAdminRequest(request, { mutation: true });
    expect("response" in access && access.response.status).toBe(403);
    expect(enforceRateLimit).not.toHaveBeenCalled();
  });

  test("only owners can list and create editor accounts", async () => {
    expect((await getAccounts(new Request("http://localhost/api/admin/accounts"))).status).toBe(200);
    store.createAdminAccount.mockResolvedValue({ email: editor, enabled: true, version: 1 });
    const created = await addAccount(new Request("http://localhost/api/admin/accounts", {
      method: "POST", headers: { "content-type": "application/json", origin: "http://localhost" },
      body: JSON.stringify({ email: editor }),
    }));
    expect(created.status).toBe(201);
    expect(store.createAdminAccount).toHaveBeenCalledWith(editor, owner);

    auth.mockResolvedValue({ user: { email: editor } });
    store.findAdminAccount.mockResolvedValue({ email: editor, enabled: true });
    expect((await getAccounts(new Request("http://localhost/api/admin/accounts"))).status).toBe(403);
  });
});
