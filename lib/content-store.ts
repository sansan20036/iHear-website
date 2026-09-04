import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import postgres from "postgres";

import { saveTranslationStates, upsertTranslationStatesInTransaction } from "./translation-state";
import type { TranslationStateWrite } from "./translation-types";

export const CONTENT_LOCALES = ["en", "zhHant", "zhHans"] as const;
export type ContentLocale = (typeof CONTENT_LOCALES)[number];
export type ContentPages = Record<string, Record<string, string>>;

export type LocaleContentStore = {
  pages: ContentPages;
  itemUpdatedAt: ContentPages;
};

export type ContentStore = {
  version: 3;
  updatedAt: string;
  updatedBy?: string;
  locales: Record<ContentLocale, LocaleContentStore>;
};

export type PublicContentStore = Omit<ContentStore, "updatedBy">;

type ContentOverrideRow = {
  page: string;
  key: string;
  locale?: ContentLocale;
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
const databaseUrl = process.env.IHEAR_FORCE_FILE_STORE === "1"
  ? ""
  : process.env.POSTGRES_URL || process.env.DATABASE_URL || "";
const isHostedProduction =
  process.env.NODE_ENV === "production" &&
  Boolean(process.env.VERCEL || process.env.NETLIFY || process.env.CONTEXT);

const globalForContent = globalThis as typeof globalThis & {
  ihearContentSql?: ReturnType<typeof postgres>;
  ihearContentSchemaReady?: Promise<void>;
};

let fileMutationQueue: Promise<unknown> = Promise.resolve();

function emptyLocaleStore(): LocaleContentStore {
  return { pages: {}, itemUpdatedAt: {} };
}

function emptyStore(): ContentStore {
  return {
    version: 3,
    updatedAt: "",
    locales: {
      en: emptyLocaleStore(),
      zhHant: emptyLocaleStore(),
      zhHans: emptyLocaleStore(),
    },
  };
}

function normalizePages(value: unknown): ContentPages {
  return value && typeof value === "object" ? (value as ContentPages) : {};
}

function normalizeLocaleStore(value: unknown): LocaleContentStore {
  const store = value && typeof value === "object" ? value as Partial<LocaleContentStore> : {};
  return {
    pages: normalizePages(store.pages),
    itemUpdatedAt: normalizePages(store.itemUpdatedAt),
  };
}

function normalizeStore(value: unknown): ContentStore {
  const source = value && typeof value === "object"
    ? value as Partial<ContentStore> & { pages?: ContentPages; itemUpdatedAt?: ContentPages }
    : {};
  const normalized = emptyStore();
  normalized.updatedAt = typeof source.updatedAt === "string" ? source.updatedAt : "";
  normalized.updatedBy = typeof source.updatedBy === "string" ? source.updatedBy : undefined;

  if (source.version === 3 && source.locales && typeof source.locales === "object") {
    for (const locale of CONTENT_LOCALES) {
      normalized.locales[locale] = normalizeLocaleStore(source.locales[locale]);
    }
  } else {
    // Version 1/2 had no locale dimension. The known legacy data is Traditional Chinese.
    normalized.locales.zhHant = {
      pages: normalizePages(source.pages),
      itemUpdatedAt: normalizePages(source.itemUpdatedAt),
    };
  }
  return normalized;
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
        CREATE TABLE IF NOT EXISTS localized_content_overrides (
          page TEXT NOT NULL CHECK (char_length(page) BETWEEN 1 AND 500),
          key TEXT NOT NULL CHECK (char_length(key) BETWEEN 1 AND 5000),
          locale TEXT NOT NULL CHECK (locale IN ('en', 'zhHant', 'zhHans')),
          value TEXT NOT NULL CHECK (char_length(value) <= 5000),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_by TEXT NOT NULL CHECK (char_length(updated_by) BETWEEN 1 AND 320),
          PRIMARY KEY (page, key, locale)
        )
      `;
      await sql`
        INSERT INTO localized_content_overrides (page, key, locale, value, updated_at, updated_by)
        SELECT page, key, 'zhHant', value, updated_at, updated_by
        FROM content_overrides
        ON CONFLICT (page, key, locale) DO NOTHING
      `;
      await sql`CREATE INDEX IF NOT EXISTS localized_content_overrides_updated_at_idx ON localized_content_overrides (updated_at DESC)`;
      await sql`ALTER TABLE content_overrides ENABLE ROW LEVEL SECURITY`;
      await sql`ALTER TABLE localized_content_overrides ENABLE ROW LEVEL SECURITY`;
    })();
  }
  await globalForContent.ihearContentSchemaReady;
}

function assertPersistenceAvailable() {
  if (!databaseUrl && isHostedProduction) throw new ContentConfigurationError();
}

function addRow(store: ContentStore, row: ContentOverrideRow, fallbackLocale?: ContentLocale) {
  const locale = row.locale || fallbackLocale;
  if (!locale || !CONTENT_LOCALES.includes(locale)) return;
  const localeStore = store.locales[locale];
  localeStore.pages[row.page] ??= {};
  localeStore.itemUpdatedAt[row.page] ??= {};
  localeStore.pages[row.page][row.key] = row.value;
  localeStore.itemUpdatedAt[row.page][row.key] = new Date(row.updated_at).toISOString();
}

function fromRows(localizedRows: ContentOverrideRow[], legacyRows: ContentOverrideRow[]): ContentStore {
  const store = emptyStore();
  const localizedKeys = new Set(localizedRows.map((row) => `${row.page}\u0000${row.key}\u0000${row.locale}`));
  const allRows: ContentOverrideRow[] = [];

  for (const row of legacyRows) {
    if (!localizedKeys.has(`${row.page}\u0000${row.key}\u0000zhHant`)) {
      addRow(store, row, "zhHant");
      allRows.push(row);
    }
  }
  for (const row of localizedRows) {
    addRow(store, row);
    allRows.push(row);
  }

  const latest = allRows.sort((left, right) =>
    new Date(right.updated_at).getTime() - new Date(left.updated_at).getTime()
  )[0];
  if (latest) {
    store.updatedAt = new Date(latest.updated_at).toISOString();
    store.updatedBy = latest.updated_by;
  }
  return store;
}

async function readFileStore() {
  try {
    return normalizeStore(JSON.parse(await readFile(contentPath, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyStore();
    throw error;
  }
}

async function writeFileStore(store: ContentStore) {
  await writeFile(contentPath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
}

async function withFileMutation<T>(callback: () => Promise<T>) {
  const operation = fileMutationQueue.then(callback, callback);
  fileMutationQueue = operation.then(() => undefined, () => undefined);
  return operation;
}

async function readContentStoreUncached(page?: string) {
  assertPersistenceAvailable();
  const sql = sqlClient();
  if (!sql) return readFileStore();

  await ensurePostgresSchema();
  const [localizedRows, legacyRows] = page ? await Promise.all([
    sql<ContentOverrideRow[]>`
      SELECT page, key, locale, value, updated_at, updated_by
      FROM localized_content_overrides
      WHERE page IN (${page}, '/__global__')
      ORDER BY page ASC, key ASC, locale ASC
    `,
    sql<ContentOverrideRow[]>`
      SELECT page, key, value, updated_at, updated_by
      FROM content_overrides
      WHERE page IN (${page}, '/__global__')
      ORDER BY page ASC, key ASC
    `,
  ]) : await Promise.all([
    sql<ContentOverrideRow[]>`
      SELECT page, key, locale, value, updated_at, updated_by
      FROM localized_content_overrides
      ORDER BY page ASC, key ASC, locale ASC
    `,
    sql<ContentOverrideRow[]>`
      SELECT page, key, value, updated_at, updated_by
      FROM content_overrides
      ORDER BY page ASC, key ASC
    `,
  ]);
  return fromRows(localizedRows, legacyRows);
}

export async function readContentStore(page?: string) {
  const store = await readContentStoreUncached(page);
  if (!page || sqlClient()) return store;
  for (const locale of CONTENT_LOCALES) {
    const pages = store.locales[locale].pages;
    const metadata = store.locales[locale].itemUpdatedAt;
    store.locales[locale].pages = Object.fromEntries(Object.entries(pages).filter(([key]) => key === page || key === "/__global__"));
    store.locales[locale].itemUpdatedAt = Object.fromEntries(Object.entries(metadata).filter(([key]) => key === page || key === "/__global__"));
  }
  return store;
}

export function publicContentStore(store: ContentStore): PublicContentStore {
  const { updatedBy: _updatedBy, ...publicStore } = store;
  return publicStore;
}

export async function updateContentItem(params: {
  page: string;
  key: string;
  locale: ContentLocale;
  value: string;
  updatedBy: string;
  expectedUpdatedAt: string | null;
}) {
  assertPersistenceAvailable();
  const sql = sqlClient();

  if (sql) {
    await ensurePostgresSchema();
    await sql.begin(async (transaction) => {
      const changed = params.expectedUpdatedAt === null
        ? await transaction<ContentOverrideRow[]>`
            INSERT INTO localized_content_overrides (page, key, locale, value, updated_at, updated_by)
            VALUES (${params.page}, ${params.key}, ${params.locale}, ${params.value}, NOW(), ${params.updatedBy})
            ON CONFLICT (page, key, locale) DO NOTHING
            RETURNING page, key, locale, value, updated_at, updated_by
          `
        : await transaction<ContentOverrideRow[]>`
            UPDATE localized_content_overrides
            SET value = ${params.value}, updated_at = NOW(), updated_by = ${params.updatedBy}
            WHERE page = ${params.page}
              AND key = ${params.key}
              AND locale = ${params.locale}
              AND updated_at = ${params.expectedUpdatedAt}::timestamptz
            RETURNING page, key, locale, value, updated_at, updated_by
          `;
      if (!changed.length) throw new ContentConflictError();

      if (params.locale === "zhHant") {
        await transaction`
          INSERT INTO content_overrides (page, key, value, updated_at, updated_by)
          VALUES (${params.page}, ${params.key}, ${params.value}, ${changed[0].updated_at}, ${params.updatedBy})
          ON CONFLICT (page, key) DO UPDATE
          SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by
        `;
      }
    });
    return readContentStoreUncached();
  }

  return withFileMutation(async () => {
    const store = await readFileStore();
    const localeStore = store.locales[params.locale];
    const pageContent = localeStore.pages[params.page] ?? {};
    const pageMetadata = localeStore.itemUpdatedAt[params.page] ?? {};
    const currentUpdatedAt = pageMetadata[params.key] ?? null;
    if (currentUpdatedAt !== params.expectedUpdatedAt) throw new ContentConflictError();

    const updatedAt = new Date().toISOString();
    pageContent[params.key] = params.value;
    pageMetadata[params.key] = updatedAt;
    localeStore.pages[params.page] = pageContent;
    localeStore.itemUpdatedAt[params.page] = pageMetadata;
    store.updatedAt = updatedAt;
    store.updatedBy = params.updatedBy;
    await writeFileStore(store);
    return store;
  });
}

export async function updateContentItems(params: {
  page: string;
  key: string;
  values: Record<ContentLocale, string>;
  updatedBy: string;
  expectedUpdatedAt: Record<ContentLocale, string | null>;
  translationStates?: TranslationStateWrite[];
}) {
  assertPersistenceAvailable();
  const sql = sqlClient();
  if (sql) {
    await ensurePostgresSchema();
    await sql.begin(async (transaction) => {
      const current = await transaction<ContentOverrideRow[]>`
        SELECT page, key, locale, value, updated_at, updated_by
        FROM localized_content_overrides
        WHERE page = ${params.page} AND key = ${params.key}
        FOR UPDATE
      `;
      const byLocale = new Map(current.map((row) => [row.locale, new Date(row.updated_at).toISOString()]));
      for (const locale of CONTENT_LOCALES) {
        if ((byLocale.get(locale) || null) !== params.expectedUpdatedAt[locale]) throw new ContentConflictError();
      }
      const changedAt = new Date();
      await transaction`
        INSERT INTO localized_content_overrides (page, key, locale, value, updated_at, updated_by)
        VALUES
          (${params.page}, ${params.key}, 'en', ${params.values.en}, ${changedAt}, ${params.updatedBy}),
          (${params.page}, ${params.key}, 'zhHant', ${params.values.zhHant}, ${changedAt}, ${params.updatedBy}),
          (${params.page}, ${params.key}, 'zhHans', ${params.values.zhHans}, ${changedAt}, ${params.updatedBy})
        ON CONFLICT (page, key, locale) DO UPDATE SET
          value = EXCLUDED.value, updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by
      `;
      await upsertTranslationStatesInTransaction(
        transaction,
        { type: "content", scope: params.page, id: params.key },
        params.translationStates || [],
        params.updatedBy,
      );
    });
    return readContentStoreUncached(params.page);
  }
  return withFileMutation(async () => {
    const store = await readFileStore();
    for (const locale of CONTENT_LOCALES) {
      const current = store.locales[locale].itemUpdatedAt[params.page]?.[params.key] || null;
      if (current !== params.expectedUpdatedAt[locale]) throw new ContentConflictError();
    }
    const updatedAt = new Date().toISOString();
    for (const locale of CONTENT_LOCALES) {
      store.locales[locale].pages[params.page] ??= {};
      store.locales[locale].itemUpdatedAt[params.page] ??= {};
      store.locales[locale].pages[params.page][params.key] = params.values[locale];
      store.locales[locale].itemUpdatedAt[params.page][params.key] = updatedAt;
    }
    store.updatedAt = updatedAt;
    store.updatedBy = params.updatedBy;
    await writeFileStore(store);
    await saveTranslationStates(
      { type: "content", scope: params.page, id: params.key },
      params.translationStates || [],
      params.updatedBy,
    );
    return store;
  });
}
