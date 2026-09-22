import { beforeEach, expect, test, vi } from "vitest";

vi.mock("../../auth.js", () => ({ auth: vi.fn() }));
vi.mock("../../lib/admin-store", () => ({ findAdminAccount: vi.fn(), appendAdminActivity: vi.fn() }));
vi.mock("../../lib/live-revisions", () => ({ revisionAfterMutation: vi.fn(async () => ({ revision: "test-revision", updatedAt: new Date().toISOString() })) }));
vi.mock("../../lib/rate-limit", () => ({ RATE_LIMIT_POLICIES: { adminMutation: {}, translation: {} }, enforceRateLimit: vi.fn(), withRateLimitHeaders: response => response }));
import { auth } from "../../auth.js";
import { findAdminAccount, appendAdminActivity } from "../../lib/admin-store";
import { enforceRateLimit } from "../../lib/rate-limit";

export const owner = "resource-owner@example.test";
export const localized = (en = "Example", zhHant = "", zhHans = "") => ({ en, zhHant, zhHans });
export const request = (path, method = "GET", body, origin = "https://resource.test") => new Request(`https://resource.test/api/${path}`, {
  method, headers: { origin, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
export const context = id => ({ params: Promise.resolve({ id }) });
export async function loadResourceApi() {
  return {
    topics: await import("../../app/api/resource-topics/route"), topic: await import("../../app/api/resource-topics/[id]/route"), topicRestore: await import("../../app/api/resource-topics/[id]/restore/route"),
    items: await import("../../app/api/resources/route"), item: await import("../../app/api/resources/[id]/route"), itemRestore: await import("../../app/api/resources/[id]/restore/route"),
    preview: await import("../../app/api/admin/translations/preview/route"), store: await import("../../lib/resource-store"), translations: await import("../../lib/translation-state"),
  };
}
export function resourceApiContract(getApi) {
  beforeEach(() => {
    vi.clearAllMocks();
    auth.mockResolvedValue({ user: { email: owner } }); findAdminAccount.mockResolvedValue(null);
    enforceRateLimit.mockResolvedValue({ limited: false });
  });
  const createTopic = async (name = "Contract topic", fields = {}) => {
    const response = await getApi().topics.POST(request("resource-topics", "POST", { title: localized(name), ...fields }));
    const body = await response.json(); expect(response.status, JSON.stringify(body)).toBe(201); return body.topic;
  };
  const createItem = async (topic, type = "external_link", fields = {}) => {
    const response = await getApi().items.POST(request("resources", "POST", { title: localized("Contract item"), topicId: topic.id, type, ...(type === "external_link" ? { url: "https://example.org/resource?x=1#part" } : {}), ...fields }));
    const body = await response.json(); expect(response.status, JSON.stringify(body)).toBe(201); return body.item;
  };
  const patchTopic = async (topic, fields) => {
    const response = await getApi().topic.PATCH(request("resource-topics", "PATCH", { version: topic.version, ...fields }), context(topic.id));
    const body = await response.json(); expect(response.status, JSON.stringify(body)).toBe(200); return body.topic;
  };
  const patchItem = async (item, fields) => {
    const response = await getApi().item.PATCH(request("resources", "PATCH", { version: item.version, ...fields }), context(item.id));
    const body = await response.json(); expect(response.status, JSON.stringify(body)).toBe(200); return body.item;
  };
  const operations = [
    ["topics", "GET", "resource-topics?admin=1"], ["topics", "GET", "resource-topics?includeArchived=true"], ["topic", "GET", "resource-topics/forms?admin=1"],
    ["items", "GET", "resources?admin=1"], ["items", "GET", "resources?includeArchived=true"], ["item", "GET", "resources/any?admin=1"],
    ["topics", "POST", "resource-topics"], ["topic", "PATCH", "resource-topics/forms"], ["topic", "DELETE", "resource-topics/forms"], ["topicRestore", "POST", "resource-topics/forms/restore"],
    ["items", "POST", "resources"], ["item", "PATCH", "resources/any"], ["item", "DELETE", "resources/any"], ["itemRestore", "POST", "resources/any/restore"],
  ];
  test.each(operations)("%s %s blocks anonymous and non-admin callers (%s)", async (route, method, path) => {
    for (const user of [null, { email: "outsider@example.test", isAdmin: true }, { email: "disabled@example.test" }]) {
      auth.mockResolvedValue(user ? { user } : null);
      findAdminAccount.mockResolvedValue({ enabled: false });
      expect((await getApi()[route][method](request(path, method, method === "GET" ? undefined : {}), context("forms"))).status).toBe(403);
    }
    expect(appendAdminActivity).not.toHaveBeenCalled();
  });
  test.each(operations.filter(([, method]) => method !== "GET"))("%s %s enforces same-origin and rate limits (%s)", async (route, method, path) => {
    expect((await getApi()[route][method](request(path, method, {}, "https://other.test"), context("forms"))).status).toBe(403);
    enforceRateLimit.mockResolvedValue({ limited: true, response: new Response("rate limited", { status: 429, headers: { "Retry-After": "12" } }) });
    const response = await getApi()[route][method](request(path, method, {}), context("forms"));
    expect(response.status).toBe(429); expect(response.headers.get("Retry-After")).toBe("12");
    expect(appendAdminActivity).not.toHaveBeenCalled();
  });

  test("enabled editors can create topics and items; actor/audit/revision come from the authenticated principal", async () => {
    auth.mockResolvedValue({ user: { email: "editor@example.test" } }); findAdminAccount.mockResolvedValue({ enabled: true });
    const topic = await createTopic("Editor topic", { createdBy: "forged", version: 99 });
    const item = await createItem(topic, "text", { updatedBy: "forged" });
    expect(topic).toMatchObject({ status: "draft", version: 1, createdBy: "editor@example.test", updatedBy: "editor@example.test" });
    expect(item.createdBy).toBe("editor@example.test");
    expect(appendAdminActivity).toHaveBeenCalledWith(expect.objectContaining({ actorEmail: "editor@example.test", actorRole: "editor", action: "resource.topic.created", entityId: topic.id }));
    const response = await getApi().item.PATCH(request("resources", "PATCH", { version: item.version, sortOrder: 6 }), context(item.id));
    expect((await response.json()).revision.revision).toBe("test-revision");
  });

  test("published parent and child are both required on collection and single-record public reads", async () => {
    let topic = await createTopic("Visibility topic"), item = await createItem(topic, "text", { status: "published" });
    const visible = async () => (await (await getApi().items.GET(request(`resources?topicId=${topic.id}`))).json());
    expect((await visible()).items).toEqual([]);
    expect((await getApi().item.GET(request("resources"), context(item.id))).status).toBe(404);
    expect((await getApi().topic.GET(request("resource-topics"), context(topic.id))).status).toBe(404);
    topic = await patchTopic(topic, { status: "published" });
    const data = await visible(); expect(data.items.map(r => r.id)).toEqual([item.id]); expect(data.topics.map(r => r.id)).toEqual([topic.id]);
    for (const value of [data.items[0], data.topics[0]]) for (const key of ["version", "status", "createdBy", "updatedBy", "createdAt", "updatedAt", "archivedFromStatus", "states"]) expect(value).not.toHaveProperty(key);
    expect(data.items[0]).toMatchObject({ type: "text", topicId: topic.id, url: "" });
    expect(data.topics[0].slug).toBe(topic.slug);
    expect((await getApi().item.GET(request("resources"), context(item.id))).status).toBe(200);
    expect((await getApi().topic.GET(request("resource-topics"), context(topic.id))).status).toBe(200);
    const before = await getApi().store.getResource(item.id);
    topic = await patchTopic(topic, { status: "draft" });
    expect(await getApi().store.getResource(item.id)).toEqual(before);
    expect((await visible()).items).toEqual([]);
    topic = await patchTopic(topic, { status: "published" });
    item = await patchItem(item, { status: "draft" });
    expect((await visible()).topics).toEqual([]); // Empty published topics stay private.
    const headers = (await getApi().items.GET(request("resources"))).headers;
    expect(headers.get("cache-control")).toBe("no-store"); expect(headers.get("vercel-cdn-cache-control")).toBe("no-store");
  });

  test.each([
    ["topic", "draft"], ["topic", "archived"], ["item", "draft"], ["item", "archived"],
  ])("%s %s single reads stay private but remain accessible to verified administrators", async (entity, status) => {
    const api = getApi(), path = entity === "topic" ? "resource-topics" : "resources";
    const topic = await createTopic(`Private read ${entity} ${status}`, { status: entity === "item" ? "published" : "draft" });
    let record = entity === "topic" ? topic : await createItem(topic, "text");
    if (status === "archived") {
      const response = await api[entity].DELETE(request(path, "DELETE", { version: record.version }), context(record.id));
      expect(response.status).toBe(200); record = (await response.json())[entity];
    }
    auth.mockResolvedValue(null);
    expect((await api[entity].GET(request(`${path}/${record.id}`), context(record.id))).status).toBe(404);
    for (const flag of ["admin=1", "includeArchived=true"]) {
      expect((await api[entity].GET(request(`${path}/${record.id}?${flag}`), context(record.id))).status).toBe(403);
    }
    for (const email of [owner, "editor@example.test"]) {
      auth.mockResolvedValue({ user: { email } }); findAdminAccount.mockResolvedValue({ enabled: true });
      // Authentication alone must not turn the public endpoint into an admin read.
      expect((await api[entity].GET(request(`${path}/${record.id}`), context(record.id))).status).toBe(404);
      for (const flag of ["admin=1", "includeArchived=true"]) {
        const response = await api[entity].GET(request(`${path}/${record.id}?${flag}`), context(record.id));
        expect(response.status).toBe(200);
        expect((await response.json())[entity]).toMatchObject({ id: record.id, status, version: record.version });
      }
    }
    // Use the fetched version just as the future editor will: edit drafts or restore archived records.
    const fetched = await api[entity].GET(request(`${path}/${record.id}?admin=1`), context(record.id));
    const saved = (await fetched.json())[entity];
    const managed = status === "draft"
      ? await api[entity].PATCH(request(path, "PATCH", { version: saved.version, sortOrder: 23 }), context(saved.id))
      : await api[`${entity}Restore`].POST(request(`${path}/${saved.id}/restore`, "POST", { version: saved.version }), context(saved.id));
    expect(managed.status).toBe(200);
    expect((await managed.json())[entity]).toMatchObject({ id: saved.id, status: "draft", version: saved.version + 1 });
  });

  test.each([
    ["topic", "draft"], ["topic", "published"], ["item", "draft"], ["item", "published"],
  ])("%s restores its original %s status and clears archive provenance", async (entity, originalStatus) => {
    const api = getApi(), path = entity === "topic" ? "resource-topics" : "resources";
    const topic = await createTopic(`Restore origin ${entity} ${originalStatus}`, { status: entity === "topic" ? originalStatus : "published" });
    const original = entity === "topic" ? topic : await createItem(topic, "text", { status: originalStatus });
    const archiveResponse = await api[entity].DELETE(request(path, "DELETE", { version: original.version }), context(original.id));
    expect(archiveResponse.status).toBe(200);
    const archived = (await archiveResponse.json())[entity];
    expect(archived).toMatchObject({ status: "archived", archivedFromStatus: originalStatus, version: original.version + 1 });
    const restoreResponse = await api[`${entity}Restore`].POST(request(`${path}/${original.id}/restore`, "POST", { version: archived.version }), context(original.id));
    expect(restoreResponse.status).toBe(200);
    const restored = (await restoreResponse.json())[entity];
    expect(restored).toMatchObject({ status: originalStatus, version: archived.version + 1 });
    expect(restored).not.toHaveProperty("archivedFromStatus");
    const persisted = await api.store[entity === "topic" ? "getResourceTopic" : "getResource"](original.id);
    expect(persisted).toEqual(restored);
  });

  test.each(["external_link", "email_request", "text"])("%s creates, edits, hides, archives and restores without implicit publication", async type => {
    const topic = await createTopic(`Lifecycle ${type}`, { status: "published" });
    let item = await createItem(topic, type);
    expect(item.status).toBe("draft");
    item = await patchItem(item, { status: "published", sortOrder: 17 });
    item = await patchItem(item, { status: "draft" });
    const archivedResponse = await getApi().item.DELETE(request("resources", "DELETE", { version: item.version }), context(item.id));
    expect(archivedResponse.status).toBe(200); item = (await archivedResponse.json()).item;
    expect(item).toMatchObject({ status: "archived", archivedFromStatus: "draft", type, sortOrder: 17 });
    expect((await getApi().item.GET(request("resources"), context(item.id))).status).toBe(404);
    expect((await getApi().item.PATCH(request("resources", "PATCH", { version: item.version, status: "published" }), context(item.id))).status).toBe(409);
    expect((await (await getApi().items.GET(request("resources?includeArchived=true"))).json()).items.some(r => r.id === item.id)).toBe(true);
    const restoredResponse = await getApi().itemRestore.POST(request("resources", "POST", { version: item.version }), context(item.id));
    expect(restoredResponse.status).toBe(200); item = (await restoredResponse.json()).item;
    expect(item.status).toBe("draft"); expect(item).not.toHaveProperty("archivedFromStatus");
    expect(item.url).toBe(type === "external_link" ? "https://example.org/resource?x=1#part" : "");
  });

  test("topic archive includes draft and archived references; moving items leaves translations/order intact", async () => {
    let from = await createTopic("Move from", { status: "published" }); const to = await createTopic("Move to");
    let item = await createItem(from, "external_link", { title: localized("Move item", "人工中文", "人工中文"), sortOrder: 45, status: "published" });
    const statesBefore = await getApi().translations.readTranslationStates({ type: "resource", scope: "", id: item.id });
    let response = await getApi().topic.DELETE(request("resource-topics", "DELETE", { version: from.version }), context(from.id));
    expect(response.status).toBe(409); expect((await response.json()).code).toBe("RESOURCE_TOPIC_NOT_EMPTY");
    response = await getApi().item.DELETE(request("resources", "DELETE", { version: item.version }), context(item.id)); item = (await response.json()).item;
    expect((await getApi().topic.DELETE(request("resource-topics", "DELETE", { version: from.version }), context(from.id))).status).toBe(409);
    response = await getApi().itemRestore.POST(request("resources", "POST", { version: item.version }), context(item.id)); item = (await response.json()).item;
    expect(item.status).toBe("published");
    const before = item; item = await patchItem(item, { topicId: to.id });
    for (const key of ["title", "description", "url", "status", "sortOrder", "createdBy", "createdAt", "type"]) expect(item[key]).toEqual(before[key]);
    expect(await getApi().translations.readTranslationStates({ type: "resource", scope: "", id: item.id })).toEqual(statesBefore);
    expect((await getApi().item.GET(request("resources"), context(item.id))).status).toBe(404);
    response = await getApi().topic.DELETE(request("resource-topics", "DELETE", { version: from.version }), context(from.id)); expect(response.status).toBe(200); from = (await response.json()).topic;
    expect(from).toMatchObject({ status: "archived", archivedFromStatus: "published" });
    expect((await getApi().topic.GET(request("resource-topics"), context(from.id))).status).toBe(404);
    expect((await (await getApi().topics.GET(request("resource-topics?includeArchived=true"))).json()).topics.some(t => t.id === from.id)).toBe(true);
    expect((await getApi().item.PATCH(request("resources", "PATCH", { version: item.version, topicId: from.id }), context(item.id))).status).toBe(409);
    response = await getApi().topicRestore.POST(request("resource-topics", "POST", { version: from.version }), context(from.id)); expect(response.status).toBe(200);
    expect((await response.json()).topic).toMatchObject({ status: "published", slug: from.slug });
  });

  test("type changes clear obsolete URLs and never infer a type from a blank URL", async () => {
    const topic = await createTopic("Type changes"); let item = await createItem(topic);
    expect((await getApi().item.PATCH(request("resources", "PATCH", { version: item.version, url: "" }), context(item.id))).status).toBe(400);
    item = await patchItem(item, { type: "email_request" }); expect(item.url).toBe("");
    item = await patchItem(item, { type: "text" }); expect(item.url).toBe("");
    expect((await getApi().item.PATCH(request("resources", "PATCH", { version: item.version, type: "external_link" }), context(item.id))).status).toBe(400);
    item = await patchItem(item, { type: "external_link", url: "https://example.com/" }); expect(item.url).toBe("https://example.com/");
    for (const type of ["", "file", null, {}, 1]) expect((await getApi().items.POST(request("resources", "POST", { title: localized(), type, topicId: topic.id, url: "https://example.com" }))).status).toBe(400);
    for (const type of ["email_request", "text"]) expect((await getApi().items.POST(request("resources", "POST", { title: localized(), type, topicId: topic.id, url: "https://example.com" }))).status).toBe(400);
  });

  test("legacy category round-trips follow built-in topics but preserve explicit custom moves", async () => {
    const response = await getApi().items.POST(request("resources", "POST", { title: localized("Legacy article"), category: "article", url: "https://example.org" }));
    expect(response.status).toBe(201); let item = (await response.json()).item;
    expect(item).toMatchObject({ category: "article", topicId: "articles", type: "external_link", status: "draft" });
    item = await patchItem(item, { ...item, category: "form" });
    expect(item).toMatchObject({ category: "form", topicId: "forms" });
    const custom = await createTopic("Legacy custom move"); item = await patchItem(item, { topicId: custom.id });
    item = await patchItem(item, { ...item, category: "article" });
    expect(item).toMatchObject({ category: "article", topicId: custom.id });
  });

  test("slug allocation is concurrent-safe, reserves archived slugs, and never changes on rename", async () => {
    const topics = await Promise.all(Array.from({ length: 4 }, () => createTopic("Concurrent Slug")));
    expect(topics.map(t => t.slug).sort()).toEqual(["concurrent-slug", "concurrent-slug-2", "concurrent-slug-3", "concurrent-slug-4"]);
    let topic = topics[0]; const slug = topic.slug;
    topic = await patchTopic(topic, { title: localized("Renamed heading") }); expect(topic.slug).toBe(slug);
    expect((await getApi().topic.PATCH(request("resource-topics", "PATCH", { version: topic.version, slug: "replacement" }), context(topic.id))).status).toBe(400);
    expect((await getApi().topics.POST(request("resource-topics", "POST", { title: localized(), slug: "manual" }))).status).toBe(400);
    await getApi().topic.DELETE(request("resource-topics", "DELETE", { version: topic.version }), context(topic.id));
    expect((await createTopic("Concurrent Slug")).slug).toBe("concurrent-slug-5");
    expect((await createTopic("Main")).slug).toBe("main-2");
    expect((await createTopic("Café & Talks! 2026")).slug).toBe("cafe-talks-2026");
    const fallback = await createTopic("!!!"); expect(fallback.slug).toBe(`topic-${fallback.id}`);
    const long = await createTopic("A".repeat(200)); const long2 = await createTopic("A".repeat(200));
    expect(long.slug).toHaveLength(120); expect(long2.slug).toHaveLength(120); expect(long2.slug.endsWith("-2")).toBe(true);
  });

  test("concurrent topic/item updates accept exactly one version and reject stale archive/restore", async () => {
    let topic = await createTopic("Version race"), item = await createItem(topic, "text");
    for (const [route, record] of [[getApi().topic, topic], [getApi().item, item]]) {
      const results = await Promise.all([7, 8].map(sortOrder => route.PATCH(request("resources", "PATCH", { version: record.version, sortOrder }), context(record.id))));
      expect(results.map(r => r.status).sort()).toEqual([200, 409]);
      expect((await route.DELETE(request("resources", "DELETE", { version: record.version }), context(record.id))).status).toBe(409);
    }
    item = await getApi().store.getResource(item.id);
    const response = await getApi().item.DELETE(request("resources", "DELETE", { version: item.version }), context(item.id));
    expect(response.status).toBe(200);
    expect((await getApi().itemRestore.POST(request("resources", "POST", { version: item.version }), context(item.id))).status).toBe(409);
    const archived = (await response.json()).item;
    const competing = await Promise.all([1, 2].map(() => getApi().itemRestore.POST(request("resources", "POST", { version: archived.version }), context(item.id))));
    expect(competing.map(r => r.status).sort()).toEqual([200, 409]);
  });

  test("topic translations use their own scope, protect manual Chinese, and invalidate stale/cross-scope receipts", async () => {
    let topic = await createTopic("Translation topic", { title: localized("Translation topic", "人工主題", "人工主题") });
    const resource = { type: "resource", scope: "topic", id: topic.id, version: topic.version };
    const original = await getApi().translations.readTranslationStates(resource);
    expect(original.find(s => s.field === "title" && s.locale === "zhHant").origin).toBe("manual");
    const title = { ...topic.title, en: "Updated translation topic" };
    let response = await getApi().topic.PATCH(request("resource-topics", "PATCH", { version: topic.version, title }), context(topic.id));
    expect(response.status).toBe(409); expect((await response.json()).code).toBe("TRANSLATION_PREVIEW_REQUIRED");
    response = await getApi().preview.POST(request("admin/translations/preview", "POST", { resource, fields: { title }, autoTranslate: false }));
    expect(response.status).toBe(200); const preview = await response.json();
    expect(preview.fields.title.value.zhHant).toBe("人工主題");
    expect((await getApi().translations.readTranslationStates({ ...resource, scope: "" }))).toEqual([]);
    topic = await patchTopic(topic, { title: preview.fields.title.value, translationReceipt: preview.receipt });
    expect(topic.title.zhHant).toBe("人工主題");
    expect((await getApi().topic.PATCH(request("resource-topics", "PATCH", { version: topic.version, title, translationReceipt: preview.receipt }), context(topic.id))).status).toBe(409);
    expect((await getApi().items.POST(request("resources", "POST", { title, type: "text", topicId: topic.id, translationReceipt: preview.receipt }))).status).toBe(409);
    const empty = await createTopic("English fallback"); expect(empty.title.zhHant).toBe("");
    expect(await getApi().translations.readTranslationStates({ type: "resource", scope: "topic", id: empty.id })).toEqual([]);
    expect((await getApi().preview.POST(request("admin/translations/preview", "POST", { resource: { ...resource, scope: "arbitrary" }, fields: { title }, autoTranslate: false }))).status).toBe(400);
  });

  test("invalid bodies/versions/statuses/references/URLs and permanent deletion are rejected", async () => {
    const api = getApi(); const topic = await createTopic("Validation topic"), item = await createItem(topic);
    for (const body of [null, [], "bad"]) {
      expect((await api.topics.POST(request("resource-topics", "POST", body))).status).toBe(400);
      expect((await api.items.POST(request("resources", "POST", body))).status).toBe(400);
    }
    for (const status of ["hidden", "archived", "", null]) {
      expect((await api.topic.PATCH(request("resource-topics", "PATCH", { version: topic.version, status }), context(topic.id))).status).toBe(400);
      expect((await api.item.PATCH(request("resources", "PATCH", { version: item.version, status }), context(item.id))).status).toBe(400);
    }
    for (const version of [undefined, 0, -1, 1.5, "1", null]) expect((await api.topic.PATCH(request("resource-topics", "PATCH", { version, sortOrder: 9 }), context(topic.id))).status).toBe(400);
    for (const topicId of ["missing-topic", "", null, "../bad"]) expect((await api.item.PATCH(request("resources", "PATCH", { version: item.version, topicId }), context(item.id))).status).toBe(400);
    for (const url of ["javascript:alert(1)", "http://example.org", "https://user:pass@example.org", "<iframe>", "https://", "https://example.org\\x"]) expect((await api.item.PATCH(request("resources", "PATCH", { version: item.version, url }), context(item.id))).status).toBe(400);
    for (const [route, record] of [[api.topic, topic], [api.item, item]]) expect((await route.DELETE(request("resources", "DELETE", { version: record.version, permanent: true }), context(record.id))).status).toBe(400);
    expect((await api.topics.POST(new Request("https://resource.test/api/resource-topics", { method: "POST", body: "{" }))).status).toBe(400);
    expect((await api.topic.PATCH(request("resource-topics", "PATCH", { version: 1 }), context("does-not-exist"))).status).toBe(404);
    expect((await api.item.PATCH(request("resources", "PATCH", { version: 1 }), context("does-not-exist"))).status).toBe(404);
  });
}
