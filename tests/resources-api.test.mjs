import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

vi.mock("../auth.js", () => ({ auth: vi.fn() }));
vi.mock("../lib/admin-store", () => ({ findAdminAccount: vi.fn(), appendAdminActivity: vi.fn() }));
vi.mock("../lib/live-revisions", () => ({ revisionAfterMutation: vi.fn(async () => ({ revision: "2", updatedAt: new Date().toISOString() })) }));
vi.mock("../lib/rate-limit", () => ({ RATE_LIMIT_POLICIES: { adminMutation: {}, translation: {} }, enforceRateLimit: vi.fn(async () => ({ limited: false })), withRateLimitHeaders: response => response }));
import { auth } from "../auth.js";
import { enforceRateLimit } from "../lib/rate-limit";
let directory, collection, single, restore, translations, store;
const owner = "sansan20036@gmail.com";
const request = (method = "GET", body, query = "", origin = "https://resources.test") => new Request(`https://resources.test/api/resources${query}`, { method, headers: { origin, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
const context = id => ({ params: Promise.resolve({ id }) });
const input = () => ({ title: { en: "Example form", zhHant: "範例表單", zhHans: "范例表单" }, description: { en: "", zhHant: "", zhHans: "" }, url: "https://forms.gle/example", sortOrder: 5, status: "draft" });
beforeAll(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "ihear-resource-tests-"));
  vi.stubEnv("IHEAR_FORCE_FILE_STORE", "1"); vi.stubEnv("IHEAR_TEST_DATA_DIR", directory); vi.stubEnv("AUTH_SECRET", "resource-test-secret");
  collection = await import("../app/api/resources/route"); single = await import("../app/api/resources/[id]/route"); restore = await import("../app/api/resources/[id]/restore/route");
  translations = await import("../app/api/admin/translations/preview/route"); store = await import("../lib/resource-store");
});
beforeEach(() => { auth.mockResolvedValue({ user: { email: owner } }); });
afterAll(async () => { vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true }); });

test("the three public seeds use the verified URLs without admin metadata", async () => {
  auth.mockResolvedValue(null);
  const response = await collection.GET(request()); const { items } = await response.json();
  expect(items.map(item => item.url)).toEqual(["https://forms.gle/ouDos4WbYS6X2C3y6", "https://forms.gle/FzayZzgAEiGHsA1b9", "https://forms.gle/r4XamySbXCDWHvAA8"]);
  expect(items[0]).not.toHaveProperty("updatedBy"); expect(response.headers.get("cache-control")).toBe("no-store");
});
test("anonymous management, cross-origin writes and rate-limited writes are rejected", async () => {
  auth.mockResolvedValue(null);
  expect((await collection.GET(request("GET", null, "?admin=1"))).status).toBe(403);
  expect((await collection.GET(request("GET", null, "?includeArchived=true"))).status).toBe(403);
  expect((await collection.POST(request("POST", input()))).status).toBe(403);
  auth.mockResolvedValue({ user: { email: owner } });
  expect((await collection.POST(request("POST", input(), "", "https://evil.test"))).status).toBe(403);
  enforceRateLimit.mockResolvedValueOnce({ limited: true, response: new Response(null, { status: 429 }) });
  expect((await collection.POST(request("POST", input()))).status).toBe(429);
});
test("draft, publish, sort, hide, archive and restore preserve the original form URL", async () => {
  const created = await collection.POST(request("POST", input())); expect(created.status).toBe(201);
  let { item } = await created.json();
  expect((await (await collection.GET(request())).json()).items.some(row => row.id === item.id)).toBe(false);
  let response = await single.PATCH(request("PATCH", { ...item, status: "published" }), context(item.id)); expect(response.status).toBe(200); item = (await response.json()).item;
  expect((await (await collection.GET(request())).json()).items[0].id).toBe(item.id);
  response = await single.PATCH(request("PATCH", { ...item, status: "draft" }), context(item.id)); item = (await response.json()).item;
  response = await single.DELETE(request("DELETE", { version: item.version }), context(item.id)); expect(response.status).toBe(200); item = (await response.json()).item;
  expect((await (await collection.GET(request("GET", null, "?includeArchived=true"))).json()).items.some(row => row.id === item.id)).toBe(true);
  expect((await single.DELETE(request("DELETE", { version: item.version, permanent: true }), context(item.id))).status).toBe(400);
  response = await restore.POST(request("POST", { version: item.version }), context(item.id)); expect(response.status).toBe(200); item = (await response.json()).item;
  expect(item.status).toBe("draft"); expect(item.url).toBe(input().url);
});
test("invalid URLs, empty names and invalid ordering are rejected", async () => {
  for (const url of ["javascript:alert(1)", "data:text/html,test", "http://example.org", "https://user:secret@example.org", "<iframe>"]) {
    const response = await collection.POST(request("POST", { ...input(), url }));
    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe("INVALID_RESOURCE_URL");
  }
  expect((await collection.POST(request("POST", { ...input(), title: { en: "", zhHant: "", zhHans: "" } }))).status).toBe(400);
  expect((await collection.POST(request("POST", { ...input(), sortOrder: 1.5 }))).status).toBe(400);
});

test("expired previews are recoverable and distinct from version conflicts", async () => {
  const { item } = await (await collection.POST(request("POST", input()))).json();
  for (const id of ["__new__", item.id]) {
    const body = id === "__new__" ? input() : item;
    const generate = async () => (await translations.POST(request("POST", { resource: { type: "resource", scope: "", id, ...(id === "__new__" ? {} : { version: item.version }) }, fields: { title: body.title }, autoTranslate: false }))).json();
    const save = receipt => id === "__new__" ? collection.POST(request("POST", { ...body, translationReceipt: receipt })) : single.PATCH(request("PATCH", { ...body, translationReceipt: receipt }), context(id));
    const preview = await generate();
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 16 * 60 * 1000);
    try {
      const expired = await save(preview.receipt);
      expect(expired.status).toBe(409);
      expect((await expired.json()).code).toBe("TRANSLATION_PREVIEW_REQUIRED");
    } finally { clock.mockRestore(); }
    const fresh = await generate();
    expect((await save(fresh.receipt)).status).toBe(id === "__new__" ? 201 : 200);
  }
  const conflict = await single.PATCH(request("PATCH", item), context(item.id));
  expect(conflict.status).toBe(409);
  expect((await conflict.json()).code).toBe("RESOURCE_VERSION_CONFLICT");
});
test("concurrent updates accept one version and retain its translation states atomically", async () => {
  const { item } = await (await collection.POST(request("POST", input()))).json();
  const results = await Promise.all(["甲", "乙"].map(name => single.PATCH(request("PATCH", { ...item, title: { ...item.title, zhHant: name } }), context(item.id))));
  expect(results.map(result => result.status).sort()).toEqual([200, 409]);
  const saved = await store.getResource(item.id); expect(saved.version).toBe(2);
  const states = await store.readResourceFileStates(item.id); expect(states.find(state => state.locale === "zhHant" && state.field === "title").origin).toBe("manual");
});
test("English edits require a fresh preview and preserve manual Chinese", async () => {
  const { item } = await (await collection.POST(request("POST", input()))).json();
  const title = { ...item.title, en: "Updated form name" };
  expect((await single.PATCH(request("PATCH", { ...item, title }), context(item.id))).status).toBe(409);
  const previewResponse = await translations.POST(request("POST", { resource: { type: "resource", scope: "", id: item.id, version: item.version }, fields: { title }, autoTranslate: false }));
  expect(previewResponse.status).toBe(200); const preview = await previewResponse.json();
  expect(preview.fields.title.value.zhHant).toBe(item.title.zhHant);
  const saved = await single.PATCH(request("PATCH", { ...item, title: preview.fields.title.value, translationReceipt: preview.receipt }), context(item.id));
  expect(saved.status).toBe(200); expect((await saved.json()).item.title.zhHant).toBe(item.title.zhHant);
});
test("missing Chinese stays empty in persistence for display-only fallback", async () => {
  const { item } = await (await collection.POST(request("POST", { ...input(), title: { en: "English only", zhHant: "", zhHans: "" }, status: "published" }))).json();
  expect((await store.getResource(item.id)).title.zhHant).toBe("");
  expect(await store.readResourceFileStates(item.id)).toEqual([]);
});

test("articles retain category across legacy edits, archive and restore", async () => {
  const response = await collection.POST(request("POST", { ...input(), category: "article" }));
  expect(response.status).toBe(201);
  let { item } = await response.json();
  expect(item.category).toBe("article");
  expect((await (await collection.GET(request())).json()).items.some(row => row.id === item.id)).toBe(false);
  const legacy = { ...item };
  delete legacy.category;
  item = (await (await single.PATCH(request("PATCH", { ...legacy, status: "published" }), context(item.id))).json()).item;
  expect(item.category).toBe("article");
  expect((await (await collection.GET(request())).json()).items.find(row => row.id === item.id).category).toBe("article");
  item = (await (await single.DELETE(request("DELETE", { version: item.version }), context(item.id))).json()).item;
  item = (await (await restore.POST(request("POST", { version: item.version }), context(item.id))).json()).item;
  expect(item.category).toBe("article");
  expect(item.status).toBe("published");
  item = (await (await single.PATCH(request("PATCH", { ...item, category: "form" }), context(item.id))).json()).item;
  expect(item.category).toBe("form");
});

test("new legacy clients default to forms and unsupported categories are rejected", async () => {
  const { item } = await (await collection.POST(request("POST", input()))).json();
  expect(item.category).toBe("form");
  for (const category of [null, "video", "", {}, 1]) {
    expect((await collection.POST(request("POST", { ...input(), category }))).status).toBe(400);
  }
});
