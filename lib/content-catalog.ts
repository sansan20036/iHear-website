import catalog from "../data/content-slots.json";

export type ContentSlot = {
  page: string;
  key: string;
  mode: "singleline" | "multiline";
  maxLength: number;
  values: { en: string; zhHant: string; zhHans: string };
};

const slots = (catalog.slots as ContentSlot[]);
const byIdentity = new Map(slots.map((slot) => [`${slot.page}\u0000${slot.key}`, slot]));

export function contentSlot(page: string, key: string) {
  return byIdentity.get(`${page}\u0000${key}`) || null;
}

export function isCatalogContent(page: string, key: string) {
  return byIdentity.has(`${page}\u0000${key}`);
}

export function validateCatalogValue(page: string, key: string, value: string) {
  const slot = contentSlot(page, key);
  if (!slot || !value.trim() || value.length > slot.maxLength) return false;
  return slot.mode !== "singleline" || !/[\r\n]/.test(value);
}

export const CONTENT_GLOBAL_PAGE = "/__global__";
