import type { LocalizedTranslationField, TranslationState } from "./translation-types";
import type { ResourceLink } from "./resource-types";

export const RESOURCE_ITEM_TYPES = ["external_link", "email_request", "text"] as const;
export const RESOURCE_STATUSES = ["draft", "published", "archived"] as const;
export type ResourceItemType = (typeof RESOURCE_ITEM_TYPES)[number];
export type ResourceStatus = (typeof RESOURCE_STATUSES)[number];
export type ResourcePublicationStatus = Exclude<ResourceStatus, "archived">;
export const RESOURCE_TOPIC_SCHEMA_VERSION = 2;

export type ResourceTopic = {
  id: string;
  title: LocalizedTranslationField;
  description: LocalizedTranslationField;
  slug: string;
  sortOrder: number;
  status: ResourceStatus;
  version: number;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  updatedBy: string;
  archivedFromStatus?: ResourcePublicationStatus;
};
export type ResourceTopicInput = Pick<ResourceTopic, "title" | "slug"> & Partial<Pick<ResourceTopic, "description" | "sortOrder">> & { status?: ResourcePublicationStatus };
// Separate canonical model: the existing HTTP input and output contract is not
// expanded in this checkpoint. Empty URL is the persisted non-link sentinel.
export type ResourceItem = ResourceLink & { topicId: string; type: ResourceItemType };
export type StoredResourceItem = ResourceItem & { states: TranslationState[] };
export type StoredResourceTopic = ResourceTopic & { states: TranslationState[] };
export type ResourceFileDocument = {
  schemaVersion: 2;
  topics: StoredResourceTopic[];
  items: StoredResourceItem[];
  [key: string]: unknown;
};

export const legacyResourceTopicId = (category: ResourceLink["category"]) => category === "article" ? "articles" : "forms";
export const restoredResourceStatus = (record: { archivedFromStatus?: ResourcePublicationStatus | null }): ResourcePublicationStatus => record.archivedFromStatus ?? "draft";

const emptyLocalized = () => ({ en: "", zhHant: "", zhHans: "" });
export function resourceTopicDefaults(input: ResourceTopicInput) {
  return { ...input, description: input.description ?? emptyLocalized(), sortOrder: input.sortOrder ?? 0, status: input.status ?? "draft" };
}
const initialTopics = [
  ["forms", "Forms & useful links", "表單／常用連結", "表单／常用链接", "resource-links", "published"],
  ["guides", "Guides for families & educators", "家庭與教育工作者指南", "家庭与教育工作者指南", "resource-guides", "draft"],
  ["articles", "Articles", "文章", "文章", "resource-articles", "published"],
  ["journal-club", "Journal Club", "文獻研讀會", "文献研读会", "journal-club", "draft"],
  ["guest-speakers", "Guest Speakers", "受邀講者", "受邀讲者", "guest-speakers", "draft"],
  ["calendar", "Calendar", "行事曆", "日历", "calendar", "draft"],
  ["announcements", "Announcements", "公告", "公告", "announcements", "draft"],
] as const;
export function initialResourceTopics(): StoredResourceTopic[] {
  return initialTopics.map(([id, en, zhHant, zhHans, slug, status], index) => ({
    id, title: { en, zhHant, zhHans }, description: emptyLocalized(), slug, status, sortOrder: (index + 1) * 10,
    version: 1, createdAt: "2026-09-21T00:00:00.000Z", updatedAt: "2026-09-21T00:00:00.000Z", createdBy: "migration-023", updatedBy: "migration-023",
    states: (["zhHant", "zhHans"] as const).map(locale => ({ field: "title", locale, sourceHash: null, origin: "manual", glossaryVersion: "ihear-2026-08-v1", updatedAt: "2026-09-21T00:00:00.000Z", updatedBy: "migration-023" })),
  }));
}

function requireValid(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Invalid resource document: ${message}`);
}
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
const length = (value: string) => Array.from(value).length;
function localized(value: unknown, maximum: number, required: boolean) {
  return record(value) && ["en", "zhHant", "zhHans"].every(locale => typeof value[locale] === "string" && length(value[locale]) <= maximum)
    && (!required || (value.en as string).trim().length > 0);
}
function validateCommon(value: Record<string, unknown>) {
  requireValid(typeof value.id === "string" && /^[a-zA-Z0-9-]{1,80}$/.test(value.id), "ID");
  requireValid(localized(value.title, 200, true) && localized(value.description, 2000, false), "three-language text");
  requireValid(Number.isSafeInteger(value.sortOrder) && Number(value.sortOrder) >= 0 && Number(value.sortOrder) <= 1_000_000, "order");
  requireValid(RESOURCE_STATUSES.includes(value.status as ResourceStatus), "status");
  requireValid(Number.isSafeInteger(value.version) && Number(value.version) >= 1, "version");
  for (const key of ["createdAt", "updatedAt"]) requireValid(typeof value[key] === "string" && Number.isFinite(Date.parse(value[key])), key);
  for (const key of ["createdBy", "updatedBy"]) requireValid(typeof value[key] === "string" && length(value[key].trim()) >= 1 && length(value[key].trim()) <= 320, key);
  requireValid(value.archivedFromStatus == null || value.archivedFromStatus === "draft" || value.archivedFromStatus === "published", "archive origin");
  requireValid(Array.isArray(value.states), "translation states");
}

/** Validate the complete file as a unit: equivalent FK/unique/check invariants. */
export function validateResourceDocument(value: unknown): asserts value is ResourceFileDocument {
  requireValid(record(value) && value.schemaVersion === RESOURCE_TOPIC_SCHEMA_VERSION && Array.isArray(value.topics) && Array.isArray(value.items), "schema version/collections");
  const topics = new Map<string, Record<string, unknown>>(), slugs = new Set<string>(), ids = new Set<string>();
  for (const topic of value.topics) {
    requireValid(record(topic), "topic"); validateCommon(topic);
    const id = topic.id as string;
    requireValid(!topics.has(id), "duplicate topic ID");
    requireValid(typeof topic.slug === "string" && topic.slug.length <= 120 && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(topic.slug), "slug");
    requireValid(!slugs.has(topic.slug), "duplicate slug (including archived topics)");
    topics.set(id, topic); slugs.add(topic.slug);
  }
  for (const item of value.items) {
    requireValid(record(item), "item"); validateCommon(item);
    requireValid(!ids.has(item.id as string), "duplicate item ID"); ids.add(item.id as string);
    requireValid(item.category === "form" || item.category === "article", "legacy category");
    const topic = topics.get(item.topicId as string);
    requireValid(topic && topic.status !== "archived", "missing or archived topic reference");
    requireValid(RESOURCE_ITEM_TYPES.includes(item.type as ResourceItemType), "explicit item type");
    requireValid(typeof item.url === "string", "URL");
    if (item.type === "external_link") {
      requireValid(length(item.url) <= 2048 && /^https:\/\/[^/?#@\s\\]+([/?#][^\s\\]*)?$/.test(item.url), "HTTPS URL without credentials");
    } else requireValid(item.url === "", "non-link URL must be empty");
  }
}

/** Pure, repeatable upgrade. Does not read env, connect to a database or write files. */
export function migrateResourceDocument(source: unknown): ResourceFileDocument {
  requireValid(record(source) && Array.isArray(source.items), "legacy collection");
  requireValid(source.schemaVersion === undefined || source.schemaVersion === 1 || source.schemaVersion === 2, "unsupported schema version");
  const copy = structuredClone(source);
  requireValid(copy.topics === undefined || Array.isArray(copy.topics), "topics collection");
  const topics = (copy.topics ?? []) as StoredResourceTopic[];
  for (const seed of initialResourceTopics()) if (!topics.some(topic => topic.id === seed.id)) topics.push(seed);
  const items = (copy.items as Record<string, unknown>[]).map(item => {
    requireValid(record(item), "legacy item");
    const category = item.category === undefined ? "form" : item.category;
    return { ...item, category, topicId: item.topicId ?? legacyResourceTopicId(category as ResourceLink["category"]), type: item.type === undefined ? "external_link" : item.type,
      status: item.status === undefined ? "draft" : item.status, states: item.states ?? [] };
  });
  const result = { ...copy, schemaVersion: RESOURCE_TOPIC_SCHEMA_VERSION, topics, items };
  validateResourceDocument(result);
  return result;
}
