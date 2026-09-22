import assert from "node:assert/strict";

const normalize = value => value.replace(/\s+/g, " ").trim();
const localized = (value, locale) => value?.[locale]?.trim() ? value[locale] : value?.en || "";
const ordered = rows => rows.slice().sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id));
const subjects = { en: "Resource guide request: ", zhHant: "索取指南：", zhHans: "索取指南：" };

// Independent inspection expectations, not the application renderer. Never click
// external or mailto links: production inspection must remain read-only.
export function assertResourceRendering(data, rendered, locale = "en") {
  assert.ok(Object.hasOwn(subjects, locale), "Supported inspection locale");
  assert.ok(Array.isArray(data.topics) && Array.isArray(data.items), "Resources collection contract");
  assert.ok(["legacy", "complete"].includes(data.guidesTakeover), "Explicit Guides takeover state");
  assert.equal(new Set(data.topics.map(topic => topic.id)).size, data.topics.length, "Unique Topic IDs");
  assert.equal(new Set(data.items.map(item => item.id)).size, data.items.length, "Unique Item IDs");
  const topics = ordered(data.topics);
  const topicIds = new Set(topics.map(topic => topic.id));
  for (const record of [...topics, ...data.items]) {
    assert.ok(record.status === undefined || record.status === "published", "No unpublished records in public data");
  }
  for (const item of data.items) assert.ok(topicIds.has(item.topicId), "Every Item has a public Topic");
  for (const topic of topics) assert.ok(data.items.some(item => item.topicId === topic.id), "No empty public Topics");
  assert.deepEqual(rendered.topicIds, topics.map(topic => topic.id), "Topic order and visibility");
  const items = topics.flatMap(topic => ordered(data.items.filter(item => item.topicId === topic.id)));
  assert.deepEqual(rendered.rows.map(row => row.id), items.map(item => item.id), "All Items render exactly once in order, including text");
  if (data.guidesTakeover === "complete") assert.equal(rendered.legacyGuides, 0, "No legacy Guides after takeover");

  for (const [index, item] of items.entries()) {
    const row = rendered.rows[index];
    assert.equal(row.topicId, item.topicId, "Item parent");
    assert.equal(row.type, item.type, "Item type");
    const title = normalize(localized(item.title, locale));
    assert.ok(title, "Nonempty Item name");
    assert.equal(normalize(row.description), normalize(localized(item.description, locale)), "Localized description/fallback");
    if (item.type === "text") {
      assert.equal(row.links.length, 0, "Text Items must not become links");
      assert.equal(normalize(row.title), title, "Text Item name");
      continue;
    }
    assert.ok(["external_link", "email_request"].includes(item.type), "Known Resource Item type");
    assert.equal(row.links.length, 1, "Linked Items have exactly one link");
    const link = row.links[0];
    if (item.type === "external_link") {
      const url = new URL(item.url);
      assert.equal(url.protocol, "https:", "External link uses HTTPS");
      assert.ok(!url.username && !url.password, "No URL credentials");
      assert.equal(link.href, url.href, "External destination preserved");
      assert.equal(link.target, "_blank", "External link opens a new tab");
      const rel = link.rel.split(/\s+/);
      assert.ok(rel.includes("noopener") && rel.includes("noreferrer"), "Safe external link relation");
      assert.ok(normalize(row.title).startsWith(title), "External Item name precedes new-tab hint");
    } else {
      const subject = subjects[locale] + localized(item.title, locale);
      assert.equal(link.href, "mailto:ihearprogram@gmail.com?subject=" + encodeURIComponent(subject), "Email recipient and exactly-once subject encoding");
      assert.equal(link.target, "", "Email does not open an external browser tab");
      assert.equal(normalize(row.title), title, "Email Item name");
    }
  }
}
