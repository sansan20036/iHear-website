import type { LocalizedTranslationField } from "./translation-types";

export type ResourceInput = {
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
  constructor(message: string, public status = 400) { super(message); }
}
export function resourceId(value: string) {
  if (!/^[a-zA-Z0-9-]{1,80}$/.test(value)) throw new ResourceError("Invalid resource ID");
  return value;
}
export function resourceVersion(value: unknown) {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new ResourceError("A current version is required");
  return Number(value);
}
export function parseResourceInput(value: unknown): ResourceInput {
  if (!value || typeof value !== "object") throw new ResourceError("Invalid resource");
  const body = value as Record<string, unknown>;
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
  if (typeof body.url !== "string" || body.url.length > 2048) throw new ResourceError("Invalid HTTPS URL");
  let url: URL;
  try { url = new URL(body.url.trim()); } catch { throw new ResourceError("Invalid HTTPS URL"); }
  if (url.protocol !== "https:" || url.username || url.password) throw new ResourceError("Only HTTPS links without credentials are allowed");
  if (!Number.isSafeInteger(body.sortOrder) || Number(body.sortOrder) < 0 || Number(body.sortOrder) > 1_000_000) throw new ResourceError("Invalid display order");
  if (body.status !== "draft" && body.status !== "published") throw new ResourceError("Invalid resource status");
  return { title, description, url: url.href, sortOrder: Number(body.sortOrder), status: body.status };
}
export function publicResource(item: ResourceLink) {
  return { id: item.id, title: item.title, description: item.description, url: item.url, sortOrder: item.sortOrder };
}
