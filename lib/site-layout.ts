import postgres from "postgres";
import catalog from "../data/layout-slots.json";

export type LayoutConfig = { hiddenSections: string[]; orders: Record<string, string[]>; links: Record<string, string> };
export type LayoutRecord = { page: string; config: LayoutConfig; recordVersion: number; updatedAt: string };
export type LayoutUpdate = { page: string; config: LayoutConfig; expectedVersion: number };
type Row = { page: string; config: unknown; record_version: number; updated_at: Date | string };

const databaseUrl = process.env.IHEAR_FORCE_FILE_STORE === "1"
  ? ""
  : process.env.POSTGRES_URL || process.env.DATABASE_URL || "";
const globalForLayout = globalThis as typeof globalThis & { ihearLayoutSql?: ReturnType<typeof postgres>; ihearFallbackLayouts?: Map<string, LayoutRecord> };
const emptyConfig = (): LayoutConfig => ({ hiddenSections: [], orders: {}, links: {} });
export function isLayoutPage(page: string) { return page === "/__global__" || catalog.sections.some((item) => item.page === page) || catalog.groups.some((item) => item.page === page) || catalog.links.some((item) => item.page === page); }

function sqlClient() {
  if (!databaseUrl) return null;
  globalForLayout.ihearLayoutSql ??= postgres(databaseUrl, { max: 2, prepare: false, ssl: process.env.POSTGRES_SSL === "disable" ? false : "require" });
  return globalForLayout.ihearLayoutSql;
}
function allowedFor(page: string) {
  return {
    sections: new Set(catalog.sections.filter((item) => item.page === page).map((item) => item.key)),
    groups: new Map(catalog.groups.filter((item) => item.page === page).map((item) => [item.key, item.items.map((entry) => typeof entry === "string" ? entry : entry.id)])),
    links: new Set(catalog.links.filter((item) => item.page === page).map((item) => item.key)),
  };
}
function validHref(value: string) { return /^\/(?!\/)[^\s]*$/.test(value) || /^https:\/\/[^\s]+$/i.test(value) || /^mailto:[^\s]+$/i.test(value); }
export function validateLayoutConfig(page: string, value: unknown): LayoutConfig | null {
  if (!value || typeof value !== "object") return null;
  const source = value as Partial<LayoutConfig>, allowed = allowedFor(page);
  if (!Array.isArray(source.hiddenSections) || !source.orders || typeof source.orders !== "object" || !source.links || typeof source.links !== "object") return null;
  if (source.hiddenSections.some((key) => typeof key !== "string" || !allowed.sections.has(key))) return null;
  for (const [key, order] of Object.entries(source.orders)) {
    const expected = allowed.groups.get(key);
    if (!expected || !Array.isArray(order) || order.length !== expected.length || new Set(order).size !== expected.length || order.some((item) => !expected.includes(item))) return null;
  }
  for (const [key, href] of Object.entries(source.links)) if (!allowed.links.has(key) || typeof href !== "string" || href.length > 1000 || (href !== "" && !validHref(href))) return null;
  return { hiddenSections: [...new Set(source.hiddenSections)], orders: source.orders, links: source.links };
}
function normalize(row: Row): LayoutRecord {
  return { page: row.page, config: validateLayoutConfig(row.page, row.config) || emptyConfig(), recordVersion: Number(row.record_version), updatedAt: new Date(row.updated_at).toISOString() };
}
function fallback() { globalForLayout.ihearFallbackLayouts ??= new Map(); return globalForLayout.ihearFallbackLayouts; }
export async function readSiteLayouts(page: string) {
  const sql = sqlClient();
  if (!sql) return ["/__global__", page].map((key) => fallback().get(key) || { page: key, config: emptyConfig(), recordVersion: 1, updatedAt: "" });
  const rows = await sql<Row[]>`SELECT page, config, record_version, updated_at FROM public.site_layout_configs WHERE page IN ('/__global__', ${page}) ORDER BY page`;
  const byPage = new Map(rows.map((row) => [row.page, normalize(row)]));
  return ["/__global__", page].map((key) => byPage.get(key) || { page: key, config: emptyConfig(), recordVersion: 1, updatedAt: "" });
}
export async function updateSiteLayouts(updates: LayoutUpdate[], updatedBy: string) {
  if (!updates.length || new Set(updates.map((update) => update.page)).size !== updates.length) throw new Error("invalid");
  const sql = sqlClient();
  if (!sql) {
    const current = updates.map((update) => fallback().get(update.page) || { page: update.page, config: emptyConfig(), recordVersion: 1, updatedAt: "" });
    if (updates.some((update, index) => current[index].recordVersion !== update.expectedVersion)) throw new Error("conflict");
    const updatedAt = new Date().toISOString();
    const records = updates.map((update, index) => ({ page: update.page, config: update.config, recordVersion: current[index].recordVersion + 1, updatedAt }));
    for (const record of records) fallback().set(record.page, record);
    return records;
  }
  return sql.begin(async (transaction) => {
    const ordered = [...updates].sort((left, right) => left.page.localeCompare(right.page));
    const currentByPage = new Map<string, LayoutRecord>();
    for (const update of ordered) {
      await transaction`SELECT pg_advisory_xact_lock(hashtext(${`site_layout_configs:${update.page}`}))`;
      const rows = await transaction<Row[]>`SELECT page, config, record_version, updated_at FROM public.site_layout_configs WHERE page=${update.page} FOR UPDATE`;
      currentByPage.set(update.page, rows[0] ? normalize(rows[0]) : { page: update.page, config: emptyConfig(), recordVersion: 1, updatedAt: "" });
    }
    if (updates.some((update) => currentByPage.get(update.page)?.recordVersion !== update.expectedVersion)) throw new Error("conflict");
    const batch = ordered.map((update) => ({
      page: update.page,
      config: update.config,
      recordVersion: (currentByPage.get(update.page)?.recordVersion || 1) + 1,
      updatedBy,
    }));
    const rows = await transaction<Row[]>`
      INSERT INTO public.site_layout_configs (page, config, record_version, updated_at, updated_by)
      SELECT item.page, item.config, item."recordVersion", NOW(), item."updatedBy"
      FROM jsonb_to_recordset(${transaction.json(batch)}::jsonb)
        AS item(page TEXT, config JSONB, "recordVersion" INTEGER, "updatedBy" TEXT)
      ON CONFLICT (page) DO UPDATE SET config=EXCLUDED.config, record_version=EXCLUDED.record_version, updated_at=NOW(), updated_by=EXCLUDED.updated_by
      RETURNING page, config, record_version, updated_at
    `;
    const saved = new Map(rows.map((row) => [row.page, normalize(row)]));
    return updates.map((update) => saved.get(update.page)!);
  });
}

export async function updateSiteLayout(page: string, config: LayoutConfig, expectedVersion: number, updatedBy: string) {
  return (await updateSiteLayouts([{ page, config, expectedVersion }], updatedBy))[0];
}
