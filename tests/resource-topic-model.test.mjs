import { afterEach, describe, expect, test, vi } from "vitest";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { migrateResourceDocument, validateResourceDocument, restoredResourceStatus, resourceTopicDefaults } from "../lib/resource-topic-model";
import { RESOURCE_SEEDS } from "../lib/resource-seed";
import { parseResourceInput } from "../lib/resource-types";

const legacy = () => ({ extraMetadata: { preserve: true }, items: RESOURCE_SEEDS.map(item => ({ ...structuredClone(item), states: [{ field: "title", locale: "zhHant", origin: "manual", sourceHash: null, glossaryVersion: "test" }] })) });
let directory;
afterEach(async () => {
  vi.unstubAllEnvs(); vi.resetModules();
  if (directory) { await rm(directory, { recursive: true, force: true }); directory = undefined; }
});

test("legacy migration is pure, defaults explicit type/reference, and preserves every old field and translation", () => {
  const source = legacy(), before = structuredClone(source);
  source.items[1].category = "article"; before.items[1].category = "article";
  const doc = migrateResourceDocument(source);
  expect(source).toEqual(before);
  expect(doc.topics).toHaveLength(7);
  expect(doc.items.map(item => item.topicId)).toEqual(["forms", "articles", "forms"]);
  doc.items.forEach((item, i) => expect(item).toEqual({ ...before.items[i], topicId: i === 1 ? "articles" : "forms", type: "external_link" }));
  expect(doc.extraMetadata).toEqual(source.extraMetadata);
  expect(doc.topics.filter(t => t.status === "published").map(t => t.id)).toEqual(["forms", "articles"]);
});

test("rerun preserves administrator edits, moved items, archive metadata and translation locks", () => {
  const doc = migrateResourceDocument(legacy());
  doc.topics[0].title.zhHant = "管理員已改名"; doc.topics[0].status = "draft"; doc.topics[0].version = 9;
  doc.topics[3].status = "archived"; doc.topics[3].archivedFromStatus = "published";
  doc.items[0].topicId = "calendar"; doc.items[0].type = "text"; doc.items[0].url = "";
  doc.items[1].status = "archived"; doc.items[1].archivedFromStatus = "published";
  expect(migrateResourceDocument(doc)).toEqual(doc);
  expect(restoredResourceStatus(doc.items[1])).toBe("published");
  expect(restoredResourceStatus({})).toBe("draft");
});

test("legacy missing category/status/type defaults do not infer item type from its URL", () => {
  const source = legacy(); delete source.items[0].category; delete source.items[0].status;
  expect(migrateResourceDocument(source).items[0]).toMatchObject({ category: "form", status: "draft", type: "external_link", topicId: "forms" });
  source.items[0].url = "";
  expect(() => migrateResourceDocument(source)).toThrow("HTTPS URL");
});

test("new topic input defaults to draft, zero order and empty three-language introduction", () => {
  expect(resourceTopicDefaults({ title: { en: "Topic", zhHant: "", zhHans: "" }, slug: "topic" })).toMatchObject({
    status: "draft", sortOrder: 0, description: { en: "", zhHant: "", zhHans: "" },
  });
  expect(resourceTopicDefaults({ title: { en: "Topic", zhHant: "", zhHans: "" }, slug: "topic", status: undefined }).status).toBe("draft");
});

describe("whole-document data constraints", () => {
  test.each([
    ["duplicate topic ID", doc => doc.topics.push(structuredClone(doc.topics[0]))],
    ["duplicate slug", doc => { doc.topics[1].slug = doc.topics[0].slug; }],
    ["invalid slug", doc => { doc.topics[1].slug = "Journal Club"; }],
    ["missing FK", doc => { doc.items[0].topicId = "missing"; }],
    ["archived topic with references", doc => { doc.topics[0].status = "archived"; }],
    ["duplicate item ID", doc => doc.items.push(structuredClone(doc.items[0]))],
    ["unknown type", doc => { doc.items[0].type = "file"; }],
    ["missing type", doc => { delete doc.items[0].type; }],
    ["email with URL", doc => { doc.items[0].type = "email_request"; }],
    ["text with URL", doc => { doc.items[0].type = "text"; }],
    ["insecure URL", doc => { doc.items[0].url = "http://example.com"; }],
    ["credential URL", doc => { doc.items[0].url = "https://user:pass@example.com"; }],
    ["empty English", doc => { doc.topics[0].title.en = " "; }],
    ["missing locale", doc => { delete doc.topics[0].title.zhHans; }],
    ["invalid status", doc => { doc.topics[0].status = "hidden"; }],
    ["invalid archive origin", doc => { doc.items[0].archivedFromStatus = "archived"; }],
    ["negative order", doc => { doc.topics[0].sortOrder = -1; }],
    ["zero version", doc => { doc.items[0].version = 0; }],
    ["future schema", doc => { doc.schemaVersion = 99; }],
  ])("rejects %s", (_name, change) => {
    const doc = migrateResourceDocument(legacy()); change(doc);
    expect(() => validateResourceDocument(doc)).toThrow();
  });
  test.each(["email_request", "text"])("accepts explicit %s with an empty URL", type => {
    const doc = migrateResourceDocument(legacy()); Object.assign(doc.items[0], { type, url: "" });
    expect(() => validateResourceDocument(doc)).not.toThrow();
  });
});

test("the existing file store preserves topics/schema/metadata across legacy create, edit, archive and restore", async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "ihear-topics-model-"));
  vi.stubEnv("IHEAR_FORCE_FILE_STORE", "1"); vi.stubEnv("IHEAR_TEST_DATA_DIR", directory);
  const file = path.join(directory, "resource-links.json"), doc = migrateResourceDocument(legacy());
  doc.topics[0].title.zhHant = "保留人工修改"; doc.topics[0].version = 8;
  doc.items[0].topicId = "calendar";
  await writeFile(file, JSON.stringify(doc));
  const store = await import("../lib/resource-store");
  let saved = await store.updateResource(doc.items[0].id, 1, parseResourceInput({ ...doc.items[0], category: "article", title: { ...doc.items[0].title, en: "Changed" } }), "tester", []);
  expect(saved).toMatchObject({ topicId: "calendar", type: "external_link" }); // Checkpoint 2 adds these fields to the API/store contract.
  saved = await store.archiveResource(saved.id, saved.version, "tester");
  saved = await store.archiveResource(saved.id, saved.version, "tester", true);
  expect(saved.status).toBe("published");
  const created = await store.createResource({ ...RESOURCE_SEEDS[0], category: "article", status: "draft" }, "tester", []);
  const fileAfter = JSON.parse(await readFile(file, "utf8"));
  expect(fileAfter.topics).toEqual(doc.topics); expect(fileAfter.extraMetadata).toEqual(doc.extraMetadata);
  expect(fileAfter.items.find(item => item.id === saved.id)).toMatchObject({ topicId: "calendar", type: "external_link", states: doc.items[0].states });
  expect(fileAfter.items.find(item => item.id === created.id)).toMatchObject({ topicId: "articles", type: "external_link" });
  let prior = fileAfter.items[1];
  prior = await store.updateResource(prior.id, prior.version, parseResourceInput({ ...prior, category: "article" }), "tester", []);
  expect(JSON.parse(await readFile(file, "utf8")).items[1].topicId).toBe("articles");
  await store.updateResource(prior.id, prior.version, parseResourceInput({ ...prior, category: "form" }), "tester", []);
  expect(JSON.parse(await readFile(file, "utf8")).items[1].topicId).toBe("forms");
});

test("offline file migration defaults to dry run and never overwrites source or destination", async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "ihear-topics-cli-"));
  const input = path.join(directory, "old.json"), output = path.join(directory, "new.json");
  const original = JSON.stringify(legacy()); await writeFile(input, original);
  const run = args => execFileSync(process.execPath, ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", "--experimental-strip-types", "scripts/migrate-resource-file.mjs", "--input", input, ...args], { encoding: "utf8", windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  expect(JSON.parse(run([])).dryRun).toBe(true);
  expect(JSON.parse(run(["--output", output])).dryRun).toBe(false);
  expect(() => run(["--output", output])).toThrow();
  expect(() => run(["--output", input])).toThrow();
  expect(await readFile(input, "utf8")).toBe(original);
  expect(JSON.parse(await readFile(output, "utf8"))).toEqual(migrateResourceDocument(legacy()));
});
