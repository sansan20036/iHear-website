import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile, unlink } from "node:fs/promises";
import path from "node:path";
import postgres from "postgres";
import { RESOURCE_SEEDS } from "./resource-seed";
import { GUIDE_TAKEOVER_SETTING, guidesTakeoverState } from "./resource-guides-takeover";
import { ResourceError, type ResourceInput } from "./resource-types";
import { allocateResourceSlug, type ResourceItemInput, type ResourceTopicWrite } from "./resource-input";
import { manualTranslationWrites } from "./translation-core";
import { upsertTranslationStatesInTransaction } from "./translation-state";
import type { TranslationState, TranslationStateWrite } from "./translation-types";
import { legacyResourceTopicId, migrateResourceDocument, restoredResourceStatus, validateResourceDocument, type ResourceFileDocument, type ResourceItem, type ResourceTopic } from "./resource-topic-model";

const databaseUrl = process.env.IHEAR_FORCE_FILE_STORE === "1" ? "" : process.env.POSTGRES_URL || process.env.DATABASE_URL || "";
const filePath = path.join(process.env.IHEAR_TEST_DATA_DIR || path.join(process.cwd(), "data"), "resource-links.json");
const sql = databaseUrl ? postgres(databaseUrl, { max: 2, prepare: false, ssl: process.env.POSTGRES_SSL === "disable" ? false : "require" }) : null;
let fileQueue: Promise<unknown> = Promise.resolve();
type ListMode = "public" | "active" | "archived";
function metadata(row: any) {
  return { id: row.id, title: row.title, description: row.description, sortOrder: row.sort_order, status: row.status,
    version: row.version, createdAt: new Date(row.created_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString(),
    createdBy: row.created_by, updatedBy: row.updated_by, archivedFromStatus: row.archived_from_status || undefined };
}
function itemFromRow(row: any): ResourceItem { return { ...metadata(row), category: row.category, url: row.url, topicId: row.topic_id, type: row.type }; }
function topicFromRow(row: any): ResourceTopic { return { ...metadata(row), slug: row.slug }; }
function stripStates<T extends { states: TranslationState[] }>(value: T): Omit<T, "states"> { const { states: _states, ...record } = value; return record; }
function order<T extends { sortOrder: number; id: string }>(items: T[]) { return items.sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id)); }

async function readDocument(): Promise<ResourceFileDocument> {
  if (process.env.NODE_ENV === "production" && (process.env.VERCEL || process.env.NETLIFY || process.env.CONTEXT) && process.env.IHEAR_FORCE_FILE_STORE !== "1") throw new ResourceError("Resource persistence is not configured", 503);
  try { return migrateResourceDocument(JSON.parse(await readFile(filePath, "utf8"))); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return migrateResourceDocument({ items: RESOURCE_SEEDS.map(item => ({ ...structuredClone(item), states: manualTranslationWrites({ title: item.title, description: item.description }) })) });
  }
}
async function fileMutation<T>(change: (document: ResourceFileDocument) => T): Promise<T> {
  const operation = fileQueue.then(async () => {
    const document = await readDocument(), result = change(document);
    validateResourceDocument(document);
    await mkdir(path.dirname(filePath), { recursive: true });
    const temporary = `${filePath}.${randomUUID()}.tmp`;
    try { await writeFile(temporary, JSON.stringify(document), "utf8"); await rename(temporary, filePath); }
    finally { await unlink(temporary).catch(() => undefined); }
    return result;
  });
  fileQueue = operation.catch(() => undefined);
  return operation;
}
function mergeStates(previous: TranslationState[], writes: TranslationStateWrite[], actor: string, now: string) {
  const merged = [...previous];
  for (const state of writes) {
    const index = merged.findIndex(current => current.field === state.field && current.locale === state.locale);
    const next = { ...state, updatedAt: now, updatedBy: actor };
    if (index < 0) merged.push(next); else merged[index] = next;
  }
  return merged;
}
function checkVersion(previous: { version: number } | undefined, version: number | null) {
  if (version !== null && !previous) throw new ResourceError("Resource not found", 404);
  if (previous && previous.version !== version) throw new ResourceError("Resource has changed; reload before saving", 409);
}
function requireTopic(topic: { status: string } | undefined) {
  if (!topic) throw new ResourceError("Topic not found", 400, "RESOURCE_TOPIC_NOT_FOUND");
  if (topic.status === "archived") throw new ResourceError("Restore the topic before assigning resources", 409, "RESOURCE_TOPIC_ARCHIVED");
}

// Return both arrays from one snapshot; public reads never mix parent versions.
export async function listResourceSnapshot(mode: ListMode = "public") {
  if (sql) return sql.begin("isolation level repeatable read read only", async tx => {
    if (mode === "public") {
      const [marker] = await tx`SELECT value FROM site_settings WHERE key=${GUIDE_TAKEOVER_SETTING}`;
      const allTopics = await tx<{ id: string }[]>`SELECT id FROM resource_topics`;
      const allItems = await tx<{ id: string; topicId: string; type: string }[]>`SELECT id, topic_id AS "topicId", type FROM resource_links`;
      const guidesTakeover = guidesTakeoverState(marker?.value, allTopics, allItems);
      const topics = (await tx`SELECT t.* FROM resource_topics t WHERE t.status='published'
        AND EXISTS (SELECT 1 FROM resource_links r WHERE r.topic_id=t.id AND r.status='published') ORDER BY t.sort_order,t.id`).map(topicFromRow);
      const items = (await tx`SELECT r.* FROM resource_links r JOIN resource_topics t ON t.id=r.topic_id
        WHERE r.status='published' AND t.status='published' ORDER BY r.sort_order,r.id`).map(itemFromRow);
      return { topics, items, guidesTakeover };
    }
    const topics = (mode === "archived" ? await tx`SELECT * FROM resource_topics WHERE status='archived' ORDER BY sort_order,id` : await tx`SELECT * FROM resource_topics WHERE status<>'archived' ORDER BY sort_order,id`).map(topicFromRow);
    const items = (mode === "archived" ? await tx`SELECT * FROM resource_links WHERE status='archived' ORDER BY sort_order,id` : await tx`SELECT * FROM resource_links WHERE status<>'archived' ORDER BY sort_order,id`).map(itemFromRow);
    return { topics, items, guidesTakeover: undefined };
  });
  const document = await readDocument();
  const accepts = (record: { status: string }) => mode === "public" ? record.status === "published" : mode === "archived" ? record.status === "archived" : record.status !== "archived";
  let topics = document.topics.filter(accepts).map(stripStates);
  const ids = new Set(topics.map(topic => topic.id));
  const items = document.items.filter(item => accepts(item) && (mode !== "public" || ids.has(item.topicId))).map(stripStates);
  if (mode === "public") topics = topics.filter(topic => items.some(item => item.topicId === topic.id));
  return { topics: order(topics), items: order(items), guidesTakeover: mode === "public" ? guidesTakeoverState(document.legacyGuidesMigrated, document.topics, document.items) : undefined };
}
export async function listResources(mode: ListMode = "public") { return (await listResourceSnapshot(mode)).items; }
export async function getResource(id: string): Promise<ResourceItem> {
  const item = sql ? (await sql`SELECT * FROM resource_links WHERE id=${id}`).map(itemFromRow)[0] : (await readDocument()).items.map(stripStates).find(item => item.id === id);
  if (!item) throw new ResourceError("Resource not found", 404);
  return item;
}
export async function getResourceTopic(id: string): Promise<ResourceTopic> {
  const topic = sql ? (await sql`SELECT * FROM resource_topics WHERE id=${id}`).map(topicFromRow)[0] : (await readDocument()).topics.map(stripStates).find(topic => topic.id === id);
  if (!topic) throw new ResourceError("Topic not found", 404);
  return topic;
}
export async function readResourceFileStates(id: string, scope = "") {
  const document = await readDocument();
  if (scope !== "" && scope !== "topic") throw new ResourceError("Invalid resource translation scope");
  return (scope === "topic" ? document.topics : document.items).find(item => item.id === id)?.states || [];
}

async function mutateItem(id: string, version: number | null, actor: string, change: (previous?: ResourceItem) => ResourceItem, writes: TranslationStateWrite[] = []) {
  if (sql) return sql.begin(async tx => {
    const [row] = await tx`SELECT * FROM resource_links WHERE id=${id} FOR UPDATE`;
    const previous = row ? itemFromRow(row) : undefined;
    checkVersion(previous, version);
    const item = change(previous);
    const [topic] = await tx`SELECT status FROM resource_topics WHERE id=${item.topicId} FOR UPDATE`;
    requireTopic(topic as { status: string } | undefined);
    const [saved] = await tx`INSERT INTO resource_links (id,category,topic_id,type,title,description,url,sort_order,status,version,created_at,updated_at,created_by,updated_by,archived_from_status)
      VALUES (${id},${item.category},${item.topicId},${item.type},${tx.json(item.title)},${tx.json(item.description)},${item.url},${item.sortOrder},${item.status},${item.version},${item.createdAt},${item.updatedAt},${item.createdBy},${actor},${item.archivedFromStatus || null})
      ON CONFLICT (id) DO UPDATE SET category=EXCLUDED.category,topic_id=EXCLUDED.topic_id,type=EXCLUDED.type,title=EXCLUDED.title,description=EXCLUDED.description,url=EXCLUDED.url,sort_order=EXCLUDED.sort_order,status=EXCLUDED.status,version=EXCLUDED.version,updated_at=EXCLUDED.updated_at,updated_by=EXCLUDED.updated_by,archived_from_status=EXCLUDED.archived_from_status RETURNING *`;
    await upsertTranslationStatesInTransaction(tx, { type: "resource", scope: "", id }, writes, actor);
    return itemFromRow(saved);
  });
  return fileMutation(document => {
    const index = document.items.findIndex(item => item.id === id), previous = document.items[index];
    checkVersion(previous, version);
    const item = change(previous ? stripStates(previous) : undefined);
    requireTopic(document.topics.find(topic => topic.id === item.topicId));
    const record = { ...previous, ...item, states: mergeStates(previous?.states || [], writes, actor, item.updatedAt) };
    if (index < 0) document.items.push(record); else document.items[index] = record;
    return item;
  });
}
function canonicalInput(input: ResourceInput & Partial<Pick<ResourceItem, "topicId" | "type">>, previous?: ResourceItem) {
  const legacyMove = previous && previous.category !== input.category && previous.topicId === legacyResourceTopicId(previous.category);
  const topicId = legacyMove && (input.topicId === undefined || input.topicId === previous.topicId)
    ? legacyResourceTopicId(input.category) : input.topicId ?? previous?.topicId ?? legacyResourceTopicId(input.category);
  return { ...input, topicId, type: input.type ?? previous?.type ?? "external_link" as const };
}
export function createResource(input: ResourceInput | ResourceItemInput, actor: string, writes: TranslationStateWrite[]) {
  const id = randomUUID(), now = new Date().toISOString();
  return mutateItem(id, null, actor, () => ({ ...canonicalInput(input), id, version: 1, createdAt: now, updatedAt: now, createdBy: actor, updatedBy: actor }), writes);
}
export function updateResource(id: string, version: number, input: ResourceInput | ResourceItemInput, actor: string, writes: TranslationStateWrite[]) {
  return mutateItem(id, version, actor, previous => {
    if (previous!.status === "archived") throw new ResourceError("Restore the resource before editing", 409, "RESOURCE_ARCHIVED");
    return { ...previous!, ...canonicalInput(input, previous), version: version + 1, updatedAt: new Date().toISOString(), updatedBy: actor };
  }, writes);
}
function archiveChange<T extends ResourceItem | ResourceTopic>(previous: T, version: number, actor: string, restore: boolean): T {
  if ((previous.status === "archived") !== restore) throw new ResourceError("Resource status has changed", 409, "RESOURCE_STATUS_CONFLICT");
  return { ...previous, status: restore ? restoredResourceStatus(previous) : "archived", archivedFromStatus: restore ? undefined : previous.status as "draft" | "published", version: version + 1, updatedAt: new Date().toISOString(), updatedBy: actor };
}
export function archiveResource(id: string, version: number, actor: string, restore = false) {
  return mutateItem(id, version, actor, previous => archiveChange(previous!, version, actor, restore));
}

async function mutateTopic(id: string, version: number | null, actor: string, change: (previous: ResourceTopic | undefined, occupied: string[]) => ResourceTopic, writes: TranslationStateWrite[] = []) {
  if (sql) return sql.begin(async tx => {
    if (version === null) await tx`SELECT pg_advisory_xact_lock(hashtext('ihear-resource-topic-slug'))`;
    const [row] = await tx`SELECT * FROM resource_topics WHERE id=${id} FOR UPDATE`;
    const previous = row ? topicFromRow(row) : undefined;
    checkVersion(previous, version);
    const occupied = version === null ? (await tx`SELECT slug FROM resource_topics`).map(row => row.slug as string) : [];
    const topic = change(previous, occupied);
    if (topic.status === "archived") {
      const [reference] = await tx`SELECT id FROM resource_links WHERE topic_id=${id} LIMIT 1`;
      if (reference) throw new ResourceError("Move all items, including archived items, before archiving this topic", 409, "RESOURCE_TOPIC_NOT_EMPTY");
    }
    const [saved] = await tx`INSERT INTO resource_topics (id,title,description,slug,sort_order,status,version,created_at,updated_at,created_by,updated_by,archived_from_status)
      VALUES (${id},${tx.json(topic.title)},${tx.json(topic.description)},${topic.slug},${topic.sortOrder},${topic.status},${topic.version},${topic.createdAt},${topic.updatedAt},${topic.createdBy},${actor},${topic.archivedFromStatus || null})
      ON CONFLICT(id) DO UPDATE SET title=EXCLUDED.title,description=EXCLUDED.description,sort_order=EXCLUDED.sort_order,status=EXCLUDED.status,version=EXCLUDED.version,updated_at=EXCLUDED.updated_at,updated_by=EXCLUDED.updated_by,archived_from_status=EXCLUDED.archived_from_status RETURNING *`;
    await upsertTranslationStatesInTransaction(tx, { type: "resource", scope: "topic", id }, writes, actor);
    return topicFromRow(saved);
  });
  return fileMutation(document => {
    const index = document.topics.findIndex(topic => topic.id === id), previous = document.topics[index];
    checkVersion(previous, version);
    const topic = change(previous ? stripStates(previous) : undefined, document.topics.map(topic => topic.slug));
    if (previous && topic.slug !== previous.slug) throw new ResourceError("Topic slug cannot be changed", 400, "RESOURCE_SLUG_IMMUTABLE");
    if (topic.status === "archived" && document.items.some(item => item.topicId === id)) throw new ResourceError("Move all items, including archived items, before archiving this topic", 409, "RESOURCE_TOPIC_NOT_EMPTY");
    const record = { ...previous, ...topic, states: mergeStates(previous?.states || [], writes, actor, topic.updatedAt) };
    if (index < 0) document.topics.push(record); else document.topics[index] = record;
    return topic;
  });
}
export function createResourceTopic(input: ResourceTopicWrite, actor: string, writes: TranslationStateWrite[]) {
  const id = randomUUID(), now = new Date().toISOString();
  return mutateTopic(id, null, actor, (_previous, occupied) => ({ ...input, id, slug: allocateResourceSlug(input.title.en, id, occupied), version: 1, createdAt: now, updatedAt: now, createdBy: actor, updatedBy: actor }), writes);
}
export function updateResourceTopic(id: string, version: number, input: ResourceTopicWrite, actor: string, writes: TranslationStateWrite[]) {
  return mutateTopic(id, version, actor, previous => {
    if (previous!.status === "archived") throw new ResourceError("Restore the topic before editing", 409, "RESOURCE_ARCHIVED");
    return { ...previous!, ...input, version: version + 1, updatedAt: new Date().toISOString(), updatedBy: actor };
  }, writes);
}
export function archiveResourceTopic(id: string, version: number, actor: string, restore = false) {
  return mutateTopic(id, version, actor, previous => archiveChange(previous!, version, actor, restore));
}
