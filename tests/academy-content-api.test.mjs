import { afterAll, beforeEach, describe, expect, test, vi } from "vitest";
import { readFile } from "node:fs/promises";

vi.mock("../auth.js", () => ({ auth: vi.fn() }));
vi.mock("../lib/admin-store", () => ({ findAdminAccount: vi.fn() }));
vi.mock("../lib/rate-limit", async original => ({ ...await original(), enforceRateLimit: vi.fn() }));
vi.mock("../lib/academy-content-store", () => ({
  readAcademyContent: vi.fn(), updateAcademyContent: vi.fn(),
  AcademyContentConflictError: class AcademyContentConflictError extends Error {},
}));
vi.mock("../lib/academy-content-page", async original => ({ ...await original(), readAcademyTemplate: vi.fn() }));

import { auth } from "../auth.js";
import { findAdminAccount } from "../lib/admin-store";
import { enforceRateLimit, rateLimitExceededResponse } from "../lib/rate-limit";
import { ACADEMY_CONTENT_MAX_BODY_BYTES, defaultAcademyContent } from "../lib/academy-content-types";
import * as store from "../lib/academy-content-store";

// The owner list is read when lib/admins loads, so every module that imports it loads after this.
vi.stubEnv("AUTH_OWNER_EMAILS", "owner@example.com");
const { GET, POST, HEAD, PUT, PATCH, DELETE, OPTIONS } = await import("../app/api/academy-content/route");
const preview = await import("../app/api/academy-content/preview/route");
const { readAcademyTemplate } = await import("../lib/academy-content-page");
const me = await import("../app/api/admin/me/route");
afterAll(() => { vi.unstubAllEnvs(); });

const ORIGIN = "https://www.ihearus.org";
const config = defaultAcademyContent();
const record = { config, recordVersion: 2, updatedBy: "private@example.com", updatedAt: "2026-10-24T00:00:00.000Z" };
function request(body = { config, expectedVersion: 2 }, options = {}) {
  const headers = { Origin: ORIGIN, "Content-Type": "application/json", ...options.headers };
  if (options.omitOrigin) delete headers.Origin;
  return new Request(`${ORIGIN}${options.path ?? "/api/academy-content"}`, { method: "POST", headers, body: options.raw ?? JSON.stringify(body) });
}
const previewRequest = (body = { config, locale: "zhHant" }, options = {}) => request(body, { ...options, path: "/api/academy-content/preview" });
function noStore(response) {
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("vercel-cdn-cache-control")).toBe("no-store");
}
beforeEach(() => {
  vi.clearAllMocks();
  auth.mockResolvedValue({ user: { email: "owner@example.com", isAdmin: true } });
  findAdminAccount.mockResolvedValue(null);
  enforceRateLimit.mockResolvedValue({ limited: false, result: { allowed: true, limit: 30, remaining: 29, retryAfter: 60, resetAt: "2026-10-24T00:01:00.000Z" } });
  store.readAcademyContent.mockResolvedValue(record);
  store.updateAcademyContent.mockImplementation(async input => ({ ...record, config: input.config, recordVersion: input.expectedVersion + 1, updatedBy: input.updatedBy }));
  readAcademyTemplate.mockImplementation(locale => readFile(locale === "en" ? "academy-site/index.html" : "academy-site/zh/index.html", "utf8"));
});

describe("Academy content API", () => {
  test("public GET hides all identity and audit fields without resolving a session", async () => {
    auth.mockResolvedValue(null);
    const response = await GET();
    expect(response.status).toBe(200); noStore(response);
    expect(await response.json()).toEqual({ config, recordVersion: 2 });
    expect(auth).not.toHaveBeenCalled();
    expect(findAdminAccount).not.toHaveBeenCalled();
  });

  test("owner saves use the effective server identity and the optimistic version", async () => {
    const response = await POST(request());
    expect(response.status).toBe(200); noStore(response);
    expect(await response.json()).toEqual({ ok: true, config, recordVersion: 3 });
    expect(store.updateAcademyContent).toHaveBeenCalledWith({ config, expectedVersion: 2, updatedBy: "owner@example.com", updatedByRole: "owner" });
    expect(findAdminAccount).not.toHaveBeenCalled();
    expect(enforceRateLimit).toHaveBeenCalledWith(expect.any(Request), expect.objectContaining({ scope: "admin-mutation", identifier: "owner@example.com" }));
    expect(response.headers.get("ratelimit-limit")).toBe("30");
  });

  test("an enabled editor may save, and revocation applies on the next request despite an old session flag", async () => {
    auth.mockResolvedValue({ user: { email: "editor@example.com", isAdmin: true, adminRole: "editor" } });
    findAdminAccount.mockResolvedValue({ enabled: true });
    expect((await POST(request())).status).toBe(200);
    expect(store.updateAcademyContent).toHaveBeenCalledWith(expect.objectContaining({ updatedBy: "editor@example.com", updatedByRole: "editor" }));
    findAdminAccount.mockResolvedValue({ enabled: false });
    const response = await POST(request());
    expect(response.status).toBe(403); noStore(response);
    expect(await response.json()).toMatchObject({ code: "FORBIDDEN" });
    expect(store.updateAcademyContent).toHaveBeenCalledTimes(1);
  });

  test.each([
    ["no session (never signed in or expired)", null, 401, "SIGN_IN_REQUIRED"],
    ["a session without an email", { user: { name: "No email", isAdmin: true } }, 401, "SIGN_IN_REQUIRED"],
    ["a signed-in non-administrator with a forged admin flag", { user: { email: "visitor@example.com", isAdmin: true, adminRole: "owner" } }, 403, "FORBIDDEN"],
  ])("rejects %s with an explicit reason", async (_name, session, status, code) => {
    auth.mockResolvedValue(session);
    const response = await POST(request());
    expect(response.status).toBe(status); noStore(response);
    expect(await response.json()).toMatchObject({ code });
    expect(store.updateAcademyContent).not.toHaveBeenCalled();
  });

  test("an identity in the request body is never used", async () => {
    auth.mockResolvedValue({ user: { email: "visitor@example.com" } });
    const response = await POST(request({ config, expectedVersion: 2, updatedBy: "owner@example.com" }));
    expect(response.status).toBe(403);
    expect(store.updateAcademyContent).not.toHaveBeenCalled();
  });

  test.each(["https://evil.example", "null", "https://www.ihearus.org.evil.example", "https://www.ihearus.org/path", "https://user@www.ihearus.org", "http://www.ihearus.org", "invalid"])("rejects Origin %s before auth and body processing", async origin => {
    const req = request(undefined, { headers: { Origin: origin } });
    const response = await POST(req);
    expect(response.status).toBe(403); noStore(response);
    expect(await response.json()).toMatchObject({ code: "ORIGIN_NOT_ALLOWED" });
    expect(auth).not.toHaveBeenCalled();
    expect(req.bodyUsed).toBe(false);
  });

  test("requires Origin and does not accept a forged forwarding host", async () => {
    expect((await POST(request(undefined, { omitOrigin: true }))).status).toBe(403);
    expect((await POST(request(undefined, { headers: { Origin: "https://evil.example", "x-forwarded-host": "evil.example" } }))).status).toBe(403);
    expect(store.updateAcademyContent).not.toHaveBeenCalled();
  });

  test("honors rate limiting before parsing malformed bodies", async () => {
    enforceRateLimit.mockResolvedValueOnce({ limited: true, response: rateLimitExceededResponse({ allowed: false, limit: 30, remaining: 0, retryAfter: 17, resetAt: "2026-10-24T00:01:00.000Z" }) });
    const req = request(undefined, { raw: "not JSON" });
    const response = await POST(req);
    expect(response.status).toBe(429); noStore(response);
    expect(response.headers.get("retry-after")).toBe("17");
    expect(req.bodyUsed).toBe(false);
    expect(store.updateAcademyContent).not.toHaveBeenCalled();
  });

  test.each([
    [{ config }, 428, "CONTENT_VERSION_REQUIRED"],
    [{ config, expectedVersion: "2" }, 400, "CONTENT_INVALID_INPUT"],
    [{ config, expectedVersion: 0 }, 400, "CONTENT_INVALID_INPUT"],
    [{ config, expectedVersion: 2.5 }, 400, "CONTENT_INVALID_INPUT"],
    [{ config, expectedVersion: 2, updatedByRole: "owner" }, 400, "CONTENT_INVALID_INPUT"],
    [{ config: { ...config, schemaVersion: 1 }, expectedVersion: 2 }, 400, "CONTENT_INVALID_INPUT"],
    [{ config: { pricing: config.pricing }, expectedVersion: 2 }, 400, "CONTENT_INVALID_INPUT"],
    [null, 400, "CONTENT_INVALID_INPUT"],
    [[config, 2], 400, "CONTENT_INVALID_INPUT"],
  ])("rejects malformed or unauthorized payload fields (%#)", async (body, status, code) => {
    const response = await POST(request(body));
    expect(response.status).toBe(status); noStore(response);
    expect(await response.json()).toMatchObject({ code });
    expect(store.updateAcademyContent).not.toHaveBeenCalled();
  });

  test.each([
    ["a negative price", draft => { draft.pricing.rates.TWD["45"].highschool = -800; }, "pricing.rates.TWD.45.highschool", "price_range"],
    ["a decimal price", draft => { draft.pricing.rates.USD["60"].college = 44.5; }, "pricing.rates.USD.60.college", "price_not_whole"],
    ["a price typed as text", draft => { draft.pricing.rates.USD["45"].college = "34"; }, "pricing.rates.USD.45.college", "price_not_whole"],
    ["an empty heading", draft => { draft.content.zhHant["hero.titleLead"] = " "; }, "content.zhHant.hero.titleLead", "required"],
    ["Simplified Chinese page text", draft => { draft.content.zhHans = draft.content.zhHant; }, "content.zhHans", "unsupported_field"],
  ])("rejects %s, names the field and stores nothing", async (_name, change, field, reason) => {
    const draft = structuredClone(config);
    change(draft);
    const response = await POST(request({ config: draft, expectedVersion: 2 }));
    expect(response.status).toBe(400); noStore(response);
    expect(await response.json()).toMatchObject({ code: "CONTENT_INVALID_INPUT", field, reason });
    expect(store.updateAcademyContent).not.toHaveBeenCalled();
  });

  test("markup in page text is accepted as plain text", async () => {
    const draft = structuredClone(config);
    draft.content.en["hero.cta"] = "<b>Find</b> your tutor";
    const response = await POST(request({ config: draft, expectedVersion: 2 }));
    expect(response.status).toBe(200);
    expect(store.updateAcademyContent.mock.calls[0][0].config.content.en["hero.cta"]).toBe("<b>Find</b> your tutor");
  });

  test("limits actual bytes regardless of Content-Length", async () => {
    const req = request(undefined, { raw: '"' + "😀".repeat(70_000) + '"', headers: { "Content-Length": "1" } });
    const response = await POST(req);
    expect(response.status).toBe(413); noStore(response);
    expect(store.updateAcademyContent).not.toHaveBeenCalled();
  });

  test("rejects a declared oversized body without reading it", async () => {
    const req = request(undefined, { headers: { "Content-Length": String(ACADEMY_CONTENT_MAX_BODY_BYTES + 1) } });
    const response = await POST(req);
    expect(response.status).toBe(413);
    expect(req.bodyUsed).toBe(false);
  });

  test("stops reading a chunked body at the byte limit", async () => {
    let reads = 0;
    const cancel = vi.fn();
    const stream = new ReadableStream({ pull(controller) { reads++; controller.enqueue(new Uint8Array(ACADEMY_CONTENT_MAX_BODY_BYTES + 1)); }, cancel }, { highWaterMark: 0 });
    const req = new Request(`${ORIGIN}/api/academy-content`, { method: "POST", headers: { Origin: ORIGIN, "Content-Type": "application/json" }, body: stream, duplex: "half" });
    const response = await POST(req);
    expect(response.status).toBe(413); noStore(response);
    expect(reads).toBe(1);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  test("returns unavailable without revealing internal connection details", async () => {
    store.readAcademyContent.mockRejectedValueOnce(new Error("postgres://secret@example.com/private"));
    const response = await GET();
    expect(response.status).toBe(503); noStore(response);
    const body = await response.json();
    expect(body.code).toBe("CONTENT_UNAVAILABLE");
    expect(JSON.stringify(body)).not.toMatch(/secret|postgres|private@example/);
  });

  test("a version conflict is explicit and is not retried", async () => {
    store.updateAcademyContent.mockRejectedValueOnce(new store.AcademyContentConflictError("Reload current content."));
    const response = await POST(request());
    expect(response.status).toBe(409); noStore(response);
    expect(await response.json()).toMatchObject({ code: "CONTENT_VERSION_CONFLICT" });
    expect(store.updateAcademyContent).toHaveBeenCalledTimes(1);
  });

  test("auth or storage failures and non-JSON input never report success", async () => {
    auth.mockRejectedValueOnce(new Error("auth storage unavailable"));
    let response = await POST(request()); expect(response.status).toBe(503); noStore(response);
    response = await POST(request(undefined, { raw: "{" })); expect(response.status).toBe(400); noStore(response);
    response = await POST(request(undefined, { raw: new Uint8Array([0x7b, 0xff, 0x7d]) })); expect(response.status).toBe(400);
    response = await POST(request(undefined, { headers: { "Content-Type": "text/plain" } })); expect(response.status).toBe(415); noStore(response);
    store.updateAcademyContent.mockRejectedValueOnce(new Error("audit storage failed"));
    response = await POST(request()); expect(response.status).toBe(503); noStore(response);
    expect(await response.json()).toEqual({ error: "Academy content is temporarily unavailable.", code: "CONTENT_UNAVAILABLE" });
  });

  test.each([PUT, PATCH, DELETE, OPTIONS])("unsupported methods are uncached and cannot mutate", async method => {
    const response = await method(); expect(response.status).toBe(405); noStore(response);
    expect(response.headers.get("allow")).toBe("GET, HEAD, POST");
    expect(store.updateAcademyContent).not.toHaveBeenCalled();
  });

  test("HEAD has no body and preserves availability and cache headers", async () => {
    const response = await HEAD(); expect(response.status).toBe(200); noStore(response);
    expect(await response.text()).toBe("");
  });
});

describe("Academy preview API", () => {
  test("renders an unsaved draft with the page renderer and stores nothing", async () => {
    const draft = structuredClone(config);
    draft.pricing.rates.TWD["60"].highschool = 1050;
    draft.content.zhHant["hero.cta"] = "預覽中的按鈕";
    const response = await preview.POST(previewRequest({ config: draft, locale: "zhHant" }));
    expect(response.status).toBe(200); noStore(response);
    const { ok, html } = await response.json();
    expect(ok).toBe(true);
    expect(html).toMatch(/^<!DOCTYPE html>\s*<html data-academy-preview/i);
    expect(html).toContain(">預覽中的按鈕<");
    expect(html).toContain("NT$1,050／堂");
    expect(html).toContain("十堂方案為九折：高中生導師 45 分鐘 NT$7,200／US$225、60 分鐘 NT$9,450／US$306");
    expect(store.updateAcademyContent).not.toHaveBeenCalled();
    expect(store.readAcademyContent).not.toHaveBeenCalled();
  });

  test.each([
    ["no session", null, 401, "SIGN_IN_REQUIRED"],
    ["a non-administrator", { user: { email: "visitor@example.com", isAdmin: true } }, 403, "FORBIDDEN"],
  ])("rejects %s", async (_name, session, status, code) => {
    auth.mockResolvedValue(session);
    const response = await preview.POST(previewRequest());
    expect(response.status).toBe(status); noStore(response);
    expect(await response.json()).toMatchObject({ code });
    expect(readAcademyTemplate).not.toHaveBeenCalled();
  });

  test("requires a same-origin request", async () => {
    const response = await preview.POST(previewRequest(undefined, { headers: { Origin: "https://evil.example" } }));
    expect(response.status).toBe(403);
    expect(auth).not.toHaveBeenCalled();
  });

  test.each([
    [{ config, locale: "zhHans" }],
    [{ config, locale: "en", extra: true }],
    [{ config: { ...config, schemaVersion: 1 }, locale: "en" }],
  ])("rejects an unsupported preview request (%#)", async body => {
    const response = await preview.POST(previewRequest(body));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "CONTENT_INVALID_INPUT" });
  });

  test("an unreadable template is reported as unavailable", async () => {
    readAcademyTemplate.mockRejectedValueOnce(new Error("ENOENT C:\\private\\path"));
    const response = await preview.POST(previewRequest());
    expect(response.status).toBe(503);
    expect(JSON.stringify(await response.json())).not.toContain("private");
  });

  test.each([preview.GET, preview.PUT, preview.PATCH, preview.DELETE])("only POST is supported", async method => {
    const response = await method(); expect(response.status).toBe(405); noStore(response);
    expect(response.headers.get("allow")).toBe("POST");
  });
});

describe("Administrator access check", () => {
  function privateNoStore(response) {
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("vercel-cdn-cache-control")).toBe("no-store");
  }

  test("confirms owners and enabled editors, and applies revocation immediately", async () => {
    let response = await me.GET();
    expect(response.status).toBe(200); privateNoStore(response);
    expect(await response.json()).toMatchObject({ ok: true, principal: { email: "owner@example.com", role: "owner" } });
    auth.mockResolvedValue({ user: { email: "Editor@Example.com", isAdmin: true } });
    findAdminAccount.mockResolvedValue({ email: "editor@example.com", enabled: true });
    expect(await (await me.GET()).json()).toMatchObject({ ok: true, principal: { email: "editor@example.com", role: "editor" } });
    findAdminAccount.mockResolvedValue({ email: "editor@example.com", enabled: false });
    response = await me.GET();
    expect(response.status).toBe(403); privateNoStore(response);
    expect(await response.json()).toEqual({ error: "Forbidden", code: "FORBIDDEN" });
  });

  test.each([null, { user: { name: "No email" } }, { user: { email: "  " } }])("reports a missing or expired sign-in as 401 (%#)", async session => {
    auth.mockResolvedValue(session);
    const response = await me.GET();
    expect(response.status).toBe(401); privateNoStore(response);
    expect(await response.json()).toEqual({ error: "Sign in required", code: "SIGN_IN_REQUIRED" });
    expect(findAdminAccount).not.toHaveBeenCalled();
  });

  test("a failed check exposes no internal details and is never cached", async () => {
    auth.mockRejectedValueOnce(new Error("postgres://private-secret@example.test/auth"));
    let response = await me.GET();
    expect(response.status).toBe(503); privateNoStore(response);
    expect(await response.json()).toEqual({ error: "Administrator access is temporarily unavailable." });
    auth.mockResolvedValue({ user: { email: "editor@example.com" } });
    findAdminAccount.mockRejectedValueOnce(new Error("connection refused"));
    response = await me.GET();
    expect(response.status).toBe(503); privateNoStore(response);
  });
});
