import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import postgres from "postgres";

export type ContentPages = Record<string, Record<string, string>>;

export type ContentStore = {
  version: 2;
  updatedAt: string;
  updatedBy?: string;
  pages: ContentPages;
  itemUpdatedAt: ContentPages;
};

export type PublicContentStore = Omit<ContentStore, "updatedBy">;

type ContentOverrideRow = {
  page: string;
  key: string;
  value: string;
  updated_at: Date | string;
  updated_by: string;
};

export class ContentConfigurationError extends Error {
  constructor() {
    super("POSTGRES_URL or DATABASE_URL is required for production content persistence");
    this.name = "ContentConfigurationError";
  }
}

export class ContentConflictError extends Error {
  constructor() {
    super("This content was changed by another administrator");
    this.name = "ContentConflictError";
  }
}

const contentPath = path.join(process.cwd(), "content.json");
const databaseUrl = process.env.POSTGRES_URL || process.env.DATABASE_URL || "";
const isHostedProduction =
  process.env.NODE_ENV === "production" &&
  Boolean(process.env.VERCEL || process.env.NETLIFY || process.env.CONTEXT);

const globalForContent = globalThis as typeof globalThis & {
  ihearContentSql?: ReturnType<typeof postgres>;
  ihearContentSchemaReady?: Promise<void>;
};

let fileMutationQueue: Promise<unknown> = Promise.resolve();

function emptyStore(): ContentStore {
  return {
    version: 2,
    updatedAt: "",
    pages: {},
    itemUpdatedAt: {},
  };
}

function normalizeStore(value: unknown): ContentStore {
  const store = value && typeof value === "object" ? (value as Partial<ContentStore>) : {};
  const pages = store.pages && typeof store.pages === "object" ? store.pages : {};

  return {
    version: 2,
    updatedAt: typeof store.updatedAt === "string" ? store.updatedAt : "",
    updatedBy: typeof store.updatedBy === "string" ? store.updatedBy : undefined,
    pages,
    itemUpdatedAt:
      store.itemUpdatedAt && typeof store.itemUpdatedAt === "object"
        ? store.itemUpdatedAt
        : {},
  };
}

function sqlClient() {
  if (!databaseUrl) return null;
  if (!globalForContent.ihearContentSql) {
    globalForContent.ihearContentSql = postgres(databaseUrl, {
      max: 2,
      prepare: false,
      ssl: process.env.POSTGRES_SSL === "disable" ? false : "require",
    });
  }
  return globalForContent.ihearContentSql;
}

async function ensurePostgresSchema() {
  const sql = sqlClient();
  if (!sql) return;

  if (!globalForContent.ihearContentSchemaReady) {
    globalForContent.ihearContentSchemaReady = (async () => {
      await sql`
        CREATE TABLE IF NOT EXISTS content_overrides (
          page TEXT NOT NULL CHECK (char_length(page) BETWEEN 1 AND 500),
          key TEXT NOT NULL CHECK (char_length(key) BETWEEN 1 AND 5000),
          value TEXT NOT NULL CHECK (char_length(value) <= 5000),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_by TEXT NOT NULL CHECK (char_length(updated_by) BETWEEN 1 AND 320),
          PRIMARY KEY (page, key)
        )
      `;
      await sql`
        CREATE INDEX IF NOT EXISTS content_overrides_updated_at_idx
        ON content_overrides (updated_at DESC)
      `;
      await sql`ALTER TABLE content_overrides ENABLE ROW LEVEL SECURITY`;
    })();
  }

  await globalForContent.ihearContentSchemaReady;
}

function assertPersistenceAvailable() {
  if (!databaseUrl && isHostedProduction) throw new ContentConfigurationError();
}

function fromRows(rows: ContentOverrideRow[]): ContentStore {
  const store = emptyStore();
  let latest: ContentOverrideRow | undefined;

  for (const row of rows) {
    store.pages[row.page] ??= {};
    store.pages[row.page][row.key] = row.value;
    store.itemUpdatedAt[row.page] ??= {};
    store.itemUpdatedAt[row.page][row.key] = new Date(row.updated_at).toISOString();

    if (!latest || new Date(row.updated_at).getTime() > new Date(latest.updated_at).getTime()) {
      latest = row;
    }
  }

  if (latest) {
    store.updatedAt = new Date(latest.updated_at).toISOString();
    store.updatedBy = latest.updated_by;
  }

  return store;
}

async function readFileStore() {
  try {
    const raw = await readFile(contentPath, "utf8");
    return normalizeStore(JSON.parse(raw));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return emptyStore();
    throw error;
  }
}

async function writeFileStore(store: ContentStore) {
  await writeFile(contentPath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
}

async function withFileMutation<T>(callback: () => Promise<T>) {
  const operation = fileMutationQueue.then(callback, callback);
  fileMutationQueue = operation.then(
    () => undefined,
    () => undefined,
  );
  return operation;
}

async function readContentStoreUncached() {
  assertPersistenceAvailable();
  const sql = sqlClient();

  if (sql) {
    await ensurePostgresSchema();
    const rows = await sql<ContentOverrideRow[]>`
      SELECT page, key, value, updated_at, updated_by
      FROM content_overrides
      ORDER BY page ASC, key ASC
    `;
    return fromRows(rows);
  }

  return readFileStore();
}

export async function readContentStore() {
  // The public API already has a one-second Vercel edge cache. Keeping a
  // second, long-lived Next data cache here can return stale content from a
  // different function instance after an administrator saves an override.
  return readContentStoreUncached();
}

export function publicContentStore(store: ContentStore): PublicContentStore {
  const { updatedBy: _updatedBy, ...publicStore } = store;
  return publicStore;
}

export async function updateContentItem(params: {
  page: string;
  key: string;
  value: string;
  updatedBy: string;
  expectedUpdatedAt: string | null;
}) {
  assertPersistenceAvailable();
  const sql = sqlClient();

  if (sql) {
    await ensurePostgresSchema();
    const changed = params.expectedUpdatedAt === null
      ? await sql<ContentOverrideRow[]>`
          INSERT INTO content_overrides (page, key, value, updated_at, updated_by)
          VALUES (${params.page}, ${params.key}, ${params.value}, NOW(), ${params.updatedBy})
          ON CONFLICT (page, key) DO NOTHING
          RETURNING page, key, value, updated_at, updated_by
        `
      : await sql<ContentOverrideRow[]>`
          UPDATE content_overrides
          SET value = ${params.value}, updated_at = NOW(), updated_by = ${params.updatedBy}
          WHERE page = ${params.page}
            AND key = ${params.key}
            AND updated_at = ${params.expectedUpdatedAt}::timestamptz
          RETURNING page, key, value, updated_at, updated_by
        `;
    if (!changed.length) throw new ContentConflictError();
    return readContentStoreUncached();
  }

  return withFileMutation(async () => {
    const store = await readFileStore();
    const pageContent = store.pages[params.page] ?? {};
    const pageMetadata = store.itemUpdatedAt[params.page] ?? {};
    const currentUpdatedAt = pageMetadata[params.key] ?? null;

    if (currentUpdatedAt !== params.expectedUpdatedAt) throw new ContentConflictError();

    pageContent[params.key] = params.value;
    store.pages[params.page] = pageContent;
    const updatedAt = new Date().toISOString();
    pageMetadata[params.key] = updatedAt;
    store.itemUpdatedAt[params.page] = pageMetadata;
    store.updatedAt = updatedAt;
    store.updatedBy = params.updatedBy;

    await writeFileStore(store);
    return store;
  });
}
