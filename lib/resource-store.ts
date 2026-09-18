import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile, unlink } from "node:fs/promises";
import path from "node:path";
import postgres from "postgres";
import { RESOURCE_SEEDS } from "./resource-seed";
import { ResourceError, type ResourceInput, type ResourceLink } from "./resource-types";
import { manualTranslationWrites } from "./translation-core";
import { upsertTranslationStatesInTransaction } from "./translation-state";
import type { TranslationState, TranslationStateWrite } from "./translation-types";

type StoredResource = ResourceLink & { states: TranslationState[] };
const databaseUrl = process.env.IHEAR_FORCE_FILE_STORE === "1" ? "" : process.env.POSTGRES_URL || process.env.DATABASE_URL || "";
const filePath = path.join(process.env.IHEAR_TEST_DATA_DIR || path.join(process.cwd(), "data"), "resource-links.json");
const sql = databaseUrl ? postgres(databaseUrl, { max: 2, prepare: false, ssl: process.env.POSTGRES_SSL === "disable" ? false : "require" }) : null;
let fileQueue: Promise<unknown> = Promise.resolve();

function fromRow(row: any): ResourceLink {
  return { id: row.id, title: row.title, description: row.description, url: row.url, sortOrder: row.sort_order, status: row.status,
    version: row.version, createdAt: new Date(row.created_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString(),
    createdBy: row.created_by, updatedBy: row.updated_by, archivedFromStatus: row.archived_from_status || undefined };
}
async function readItems(): Promise<StoredResource[]> {
  if (process.env.NODE_ENV === "production" && (process.env.VERCEL || process.env.NETLIFY || process.env.CONTEXT) && process.env.IHEAR_FORCE_FILE_STORE !== "1") throw new ResourceError("Resource persistence is not configured", 503);
  try { return JSON.parse(await readFile(filePath, "utf8")).items; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return RESOURCE_SEEDS.map(item => ({ ...structuredClone(item), states: manualTranslationWrites({ title: item.title, description: item.description }) }));
  }
}
function stripStates(item: StoredResource): ResourceLink { const { states: _states, ...record } = item; return record; }
export async function listResources(mode: "public" | "active" | "archived" = "public") {
  const items = sql ? (await sql`SELECT * FROM resource_links ORDER BY sort_order, id`).map(fromRow) : (await readItems()).map(stripStates);
  return items.filter(item => mode === "public" ? item.status === "published" : mode === "archived" ? item.status === "archived" : item.status !== "archived")
    .sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id));
}
export async function getResource(id: string) {
  const item = sql ? (await sql`SELECT * FROM resource_links WHERE id=${id}`).map(fromRow)[0] : (await readItems()).map(stripStates).find(item => item.id === id);
  if (!item) throw new ResourceError("Resource not found", 404);
  return item;
}
export async function readResourceFileStates(id: string) { return (await readItems()).find(item => item.id === id)?.states || []; }

async function mutate(id: string, version: number | null, actor: string, changes: (previous?: ResourceLink) => ResourceLink, states: TranslationStateWrite[] = []) {
  if (sql) return sql.begin(async tx => {
    const rows = await tx`SELECT * FROM resource_links WHERE id=${id} FOR UPDATE`;
    const previous = rows[0] ? fromRow(rows[0]) : undefined;
    if (version !== null && !previous) throw new ResourceError("Resource not found", 404);
    if (previous && previous.version !== version) throw new ResourceError("Resource has changed; reload before saving", 409);
    const item = changes(previous);
    await tx`INSERT INTO resource_links (id,title,description,url,sort_order,status,version,created_at,updated_at,created_by,updated_by,archived_from_status)
      VALUES (${id},${tx.json(item.title)},${tx.json(item.description)},${item.url},${item.sortOrder},${item.status},${item.version},${item.createdAt},${item.updatedAt},${item.createdBy},${actor},${item.archivedFromStatus || null})
      ON CONFLICT (id) DO UPDATE SET title=EXCLUDED.title,description=EXCLUDED.description,url=EXCLUDED.url,sort_order=EXCLUDED.sort_order,status=EXCLUDED.status,version=EXCLUDED.version,updated_at=EXCLUDED.updated_at,updated_by=EXCLUDED.updated_by,archived_from_status=EXCLUDED.archived_from_status`;
    await upsertTranslationStatesInTransaction(tx, { type: "resource", scope: "", id }, states, actor);
    return item;
  });
  const operation = fileQueue.then(async () => {
    const items = await readItems();
    const previous = items.find(item => item.id === id);
    if (version !== null && !previous) throw new ResourceError("Resource not found", 404);
    if (previous && previous.version !== version) throw new ResourceError("Resource has changed; reload before saving", 409);
    const item = changes(previous ? stripStates(previous) : undefined);
    const merged = [...(previous?.states || [])];
    for (const state of states) {
      const index = merged.findIndex(current => current.field === state.field && current.locale === state.locale);
      const next = { ...state, updatedAt: item.updatedAt, updatedBy: actor };
      if (index < 0) merged.push(next); else merged[index] = next;
    }
    const record = { ...item, states: merged };
    if (previous) items[items.indexOf(previous)] = record; else items.push(record);
    await mkdir(path.dirname(filePath), { recursive: true });
    const temporary = `${filePath}.${randomUUID()}.tmp`;
    try { await writeFile(temporary, JSON.stringify({ items }), "utf8"); await rename(temporary, filePath); }
    finally { await unlink(temporary).catch(() => undefined); }
    return item;
  });
  fileQueue = operation.catch(() => undefined);
  return operation;
}
export function createResource(input: ResourceInput, actor: string, states: TranslationStateWrite[]) {
  const id = randomUUID(), now = new Date().toISOString();
  return mutate(id, null, actor, () => ({ ...input, id, version: 1, createdAt: now, updatedAt: now, createdBy: actor, updatedBy: actor }), states);
}
export function updateResource(id: string, version: number, input: ResourceInput, actor: string, states: TranslationStateWrite[]) {
  return mutate(id, version, actor, previous => {
    if (previous!.status === "archived") throw new ResourceError("Restore the resource before editing", 409);
    return { ...previous!, ...input, version: version + 1, updatedAt: new Date().toISOString(), updatedBy: actor };
  }, states);
}
export function archiveResource(id: string, version: number, actor: string, restore = false) {
  return mutate(id, version, actor, previous => {
    if ((previous!.status === "archived") !== restore) throw new ResourceError("Resource status has changed", 409);
    return { ...previous!, status: restore ? previous!.archivedFromStatus || "draft" : "archived", archivedFromStatus: restore ? undefined : previous!.status as "draft" | "published", version: version + 1, updatedAt: new Date().toISOString(), updatedBy: actor };
  });
}
