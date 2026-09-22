import type { LocalizedTranslationField } from "./translation-types";
import type { ResourceItem } from "./resource-topic-model";

export type ResourceInput = {
  category: "form" | "article";
  title: LocalizedTranslationField;
  description: LocalizedTranslationField;
  url: string;
  sortOrder: number;
  status: "draft" | "published";
};
export type ResourceLink = Omit<ResourceInput, "status"> & {
  id: string;
  status: "draft" | "published" | "archived";
  version: number;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  updatedBy: string;
  archivedFromStatus?: "draft" | "published";
};
export class ResourceError extends Error {
  constructor(message: string, public status = 400, public code?: string) { super(message); }
}
export function isResourceUrl(value: string) {
  try {
    const url = new URL(value.trim());
    return value.length <= 2048 && url.protocol === "https:" && !url.username && !url.password;
  } catch { return false; }
}
export function resourceId(value: string) {
  if (!/^[a-zA-Z0-9-]{1,80}$/.test(value)) throw new ResourceError("Invalid resource ID");
  return value;
}
export function resourceVersion(value: unknown) {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new ResourceError("A current version is required");
  return Number(value);
}
export function parseResourceInput(value: unknown, defaultCategory: ResourceInput["category"] = "form"): ResourceInput {
  if (!value || typeof value !== "object") throw new ResourceError("Invalid resource");
  const body = value as Record<string, unknown>;
  const category = body.category === undefined ? defaultCategory : body.category;
  if (category !== "form" && category !== "article") throw new ResourceError("Invalid resource category");
  function localized(field: string, limit: number) {
    const source = body[field];
    if (!source || typeof source !== "object") throw new ResourceError(`Invalid ${field}`);
    const result = { en: "", zhHant: "", zhHans: "" };
    for (const locale of ["en", "zhHant", "zhHans"] as const) {
      const text = (source as Record<string, unknown>)[locale];
      if (typeof text !== "string" || text.trim().length > limit) throw new ResourceError(`Invalid ${field}.${locale}`);
      result[locale] = text.trim();
    }
    return result;
  }
  const title = localized("title", 200);
  const description = localized("description", 2000);
  if (!title.en) throw new ResourceError("English name is required");
  if (typeof body.url !== "string" || !isResourceUrl(body.url)) throw new ResourceError("Only valid HTTPS links without credentials are allowed", 400, "INVALID_RESOURCE_URL");
  const url = new URL(body.url.trim());
  if (!Number.isSafeInteger(body.sortOrder) || Number(body.sortOrder) < 0 || Number(body.sortOrder) > 1_000_000) throw new ResourceError("Invalid display order");
  if (body.status !== "draft" && body.status !== "published") throw new ResourceError("Invalid resource status");
  return { category, title, description, url: url.href, sortOrder: Number(body.sortOrder), status: body.status };
}
export function publicResource(item: ResourceItem) {
  return { id: item.id, category: item.category, topicId: item.topicId, type: item.type, title: item.title, description: item.description, url: item.url, sortOrder: item.sortOrder };
}
