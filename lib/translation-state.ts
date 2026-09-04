import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import postgres from "postgres";

import type { TranslationResource, TranslationState, TranslationStateWrite } from "./translation-types";

const databaseUrl = process.env.IHEAR_FORCE_FILE_STORE === "1" ? "" : process.env.POSTGRES_URL || process.env.DATABASE_URL || "";
const filePath = path.join(process.cwd(), "data", "translation-states.json");
const globalForTranslation = globalThis as typeof globalThis & {
  ihearTranslationSql?: ReturnType<typeof postgres>;
  ihearTranslationSchemaReady?: Promise<void>;
};
let fileQueue: Promise<unknown> = Promise.resolve();

type StoredState = TranslationState & { resource: TranslationResource };

function sqlClient() {
  if (!databaseUrl) return null;
  if (!globalForTranslation.ihearTranslationSql) globalForTranslation.ihearTranslationSql = postgres(databaseUrl, { max: 2, prepare: false, ssl: process.env.POSTGRES_SSL === "disable" ? false : "require" });
  return globalForTranslation.ihearTranslationSql;
}

export async function ensureTranslationSchema(client: any = sqlClient()) {
  if (!client) return;
  if (client === sqlClient() && globalForTranslation.ihearTranslationSchemaReady) return globalForTranslation.ihearTranslationSchemaReady;
  const work = (async () => {
    await client`
      CREATE TABLE IF NOT EXISTS public.localized_translation_states (
        resource_type TEXT NOT NULL CHECK (resource_type IN ('content','team','impact','media')),
        resource_scope TEXT NOT NULL DEFAULT '' CHECK (char_length(resource_scope) <= 500),
        resource_id TEXT NOT NULL CHECK (char_length(resource_id) BETWEEN 1 AND 5000),
        field_key TEXT NOT NULL CHECK (char_length(field_key) BETWEEN 1 AND 100),
        locale TEXT NOT NULL CHECK (locale IN ('zhHant','zhHans')),
        source_hash TEXT CHECK (source_hash IS NULL OR source_hash ~ '^[0-9a-f]{64}$'),
        origin TEXT NOT NULL CHECK (origin IN ('machine','manual','protected_legacy')),
        glossary_version TEXT NOT NULL CHECK (char_length(glossary_version) BETWEEN 1 AND 100),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_by TEXT NOT NULL CHECK (char_length(updated_by) BETWEEN 1 AND 320),
        PRIMARY KEY (resource_type, resource_scope, resource_id, field_key, locale)
      )
    `;
    await client`ALTER TABLE public.localized_translation_states ENABLE ROW LEVEL SECURITY`;
  })();
  if (client === sqlClient()) globalForTranslation.ihearTranslationSchemaReady = work;
  return work;
}

async function readFileStates(): Promise<StoredState[]> {
  try { const parsed = JSON.parse(await readFile(filePath, "utf8")); return Array.isArray(parsed) ? parsed : []; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}

function resourceKey(resource: TranslationResource) {
  return `${resource.type}\u0000${resource.scope}\u0000${resource.id}`;
}

export async function readTranslationStates(resource: TranslationResource): Promise<TranslationState[]> {
  const sql = sqlClient();
  if (!sql) return (await readFileStates()).filter((item) => resourceKey(item.resource) === resourceKey(resource)).map(({ resource: _resource, ...state }) => state);
  await ensureTranslationSchema();
  const rows = await sql<any[]>`
    SELECT field_key, locale, source_hash, origin, glossary_version, updated_at, updated_by
    FROM public.localized_translation_states
    WHERE resource_type=${resource.type} AND resource_scope=${resource.scope} AND resource_id=${resource.id}
  `;
  return rows.map((row) => ({ field: row.field_key, locale: row.locale, sourceHash: row.source_hash, origin: row.origin, glossaryVersion: row.glossary_version, updatedAt: new Date(row.updated_at).toISOString(), updatedBy: row.updated_by }));
}

export async function upsertTranslationStatesInTransaction(client: any, resource: TranslationResource, writes: TranslationStateWrite[], updatedBy: string) {
  if (!writes.length) return;
  await ensureTranslationSchema(client);
  for (const state of writes) {
    await client`
      INSERT INTO public.localized_translation_states (
        resource_type, resource_scope, resource_id, field_key, locale, source_hash,
        origin, glossary_version, updated_at, updated_by
      ) VALUES (
        ${resource.type}, ${resource.scope}, ${resource.id}, ${state.field}, ${state.locale},
        ${state.sourceHash}, ${state.origin}, ${state.glossaryVersion}, NOW(), ${updatedBy}
      )
      ON CONFLICT (resource_type, resource_scope, resource_id, field_key, locale) DO UPDATE SET
        source_hash=EXCLUDED.source_hash, origin=EXCLUDED.origin,
        glossary_version=EXCLUDED.glossary_version, updated_at=NOW(), updated_by=EXCLUDED.updated_by
    `;
  }
}

export async function saveTranslationStates(resource: TranslationResource, writes: TranslationStateWrite[], updatedBy: string) {
  if (!writes.length) return;
  const sql = sqlClient();
  if (sql) {
    await sql.begin(async (tx) => upsertTranslationStatesInTransaction(tx, resource, writes, updatedBy));
    return;
  }
  const operation = fileQueue.then(async () => {
    const items = await readFileStates();
    const now = new Date().toISOString();
    for (const write of writes) {
      const index = items.findIndex((item) => resourceKey(item.resource) === resourceKey(resource) && item.field === write.field && item.locale === write.locale);
      const next: StoredState = { resource, ...write, updatedAt: now, updatedBy };
      if (index >= 0) items[index] = next; else items.push(next);
    }
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, `${JSON.stringify(items, null, 2)}\n`, "utf8");
  });
  fileQueue = operation.catch(() => undefined);
  return operation;
}
