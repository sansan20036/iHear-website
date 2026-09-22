import { isResourceUrl, ResourceError, resourceId, type ResourceInput } from "./resource-types";
import { legacyResourceTopicId, RESOURCE_ITEM_TYPES, type ResourceItem, type ResourceItemType, type ResourceTopic, type ResourcePublicationStatus } from "./resource-topic-model";
import type { LocalizedTranslationField } from "./translation-types";

export type ResourceItemInput = ResourceInput & { topicId: string; type: ResourceItemType };
export type ResourceTopicWrite = Pick<ResourceTopic, "title" | "description" | "sortOrder"> & { status: ResourcePublicationStatus };
export function resourceBody(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ResourceError("Invalid JSON object");
  return value as Record<string, unknown>;
}
const empty = () => ({ en: "", zhHant: "", zhHans: "" });
function localized(value: unknown, limit: number, required: boolean): LocalizedTranslationField {
  const source = resourceBody(value), result = empty();
  for (const locale of ["en", "zhHant", "zhHans"] as const) {
    if (typeof source[locale] !== "string" || Array.from(source[locale].trim()).length > limit) throw new ResourceError(`Invalid text.${locale}`);
    result[locale] = source[locale].trim();
  }
  if (required && !result.en) throw new ResourceError("English name is required");
  return result;
}
function common(body: Record<string, unknown>, previous?: ResourceTopicWrite): ResourceTopicWrite {
  const status = body.status === undefined ? previous?.status ?? "draft" : body.status;
  if (status !== "draft" && status !== "published") throw new ResourceError("Use archive/restore endpoints for archived records");
  const sortOrder = body.sortOrder === undefined ? previous?.sortOrder ?? 0 : body.sortOrder;
  if (!Number.isSafeInteger(sortOrder) || Number(sortOrder) < 0 || Number(sortOrder) > 1_000_000) throw new ResourceError("Invalid display order");
  return {
    title: localized(body.title === undefined ? previous?.title : body.title, 200, true),
    description: localized(body.description === undefined ? previous?.description ?? empty() : body.description, 2000, false),
    sortOrder: Number(sortOrder), status,
  };
}
export function parseResourceTopicInput(value: unknown, previous?: ResourceTopic): ResourceTopicWrite {
  const body = resourceBody(value);
  if (body.slug !== undefined && (!previous || body.slug !== previous.slug)) throw new ResourceError("Topic slug is generated on creation and cannot be changed", 400, "RESOURCE_SLUG_IMMUTABLE");
  if (previous?.status === "archived") throw new ResourceError("Restore the topic before editing", 409, "RESOURCE_ARCHIVED");
  return common(body, previous as ResourceTopicWrite | undefined);
}
export function parseResourceItemInput(value: unknown, previous?: ResourceItem): ResourceItemInput {
  const body = resourceBody(value);
  if (previous?.status === "archived") throw new ResourceError("Restore the resource before editing", 409, "RESOURCE_ARCHIVED");
  const category = body.category === undefined ? previous?.category ?? "form" : body.category;
  if (category !== "form" && category !== "article") throw new ResourceError("Invalid resource category");
  const type = body.type === undefined ? previous?.type ?? "external_link" : body.type;
  if (!RESOURCE_ITEM_TYPES.includes(type as ResourceItemType)) throw new ResourceError("Invalid resource type", 400, "INVALID_RESOURCE_TYPE");
  const legacyMove = previous && previous.category !== category && previous.topicId === legacyResourceTopicId(previous.category);
  const topicId = legacyMove && (body.topicId === undefined || body.topicId === previous.topicId)
    ? legacyResourceTopicId(category)
    : body.topicId === undefined ? previous?.topicId ?? legacyResourceTopicId(category) : body.topicId;
  if (typeof topicId !== "string") throw new ResourceError("A valid topicId is required");
  resourceId(topicId);
  let url = body.url === undefined ? (type === "external_link" ? previous?.url : "") : body.url;
  if (type === "external_link") {
    if (typeof url !== "string" || !isResourceUrl(url) || !/^https:\/\/[^/?#@\s\\]+([/?#][^\s\\]*)?$/.test(url.trim())) throw new ResourceError("Only valid HTTPS links without credentials are allowed", 400, "INVALID_RESOURCE_URL");
    const normalizedUrl = new URL(url.trim()).href;
    if (normalizedUrl.length > 2048) throw new ResourceError("URL is too long", 400, "INVALID_RESOURCE_URL");
    url = normalizedUrl;
  } else if (url !== "") throw new ResourceError("Email and text resources must not contain a URL", 400, "INVALID_RESOURCE_URL");
  return { ...common(body, previous as ResourceItemInput | undefined), category, topicId, type: type as ResourceItemType, url: url as string };
}

// Reserve existing page IDs even when their topic is absent. No DOM/UI behavior
// lives here; these rules only allocate stable, database-unique identifiers.
const reservedSlugs = new Set(["resources", "main", "nav", "navtoggle", "navlinks", "langswitch", "resource-links", "resource-guides", "resource-articles", "resource-links-heading", "resource-articles-heading", "res-h"]);
export function allocateResourceSlug(english: string, id: string, occupied: Iterable<string>) {
  const base = english.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 120).replace(/-+$/g, "") || `topic-${id}`;
  const used = new Set([...reservedSlugs, ...occupied]);
  for (let suffix = 1; ; suffix++) {
    const tail = suffix === 1 ? "" : `-${suffix}`;
    const candidate = base.slice(0, 120 - tail.length).replace(/-+$/g, "") + tail;
    if (!used.has(candidate)) return candidate;
  }
}
