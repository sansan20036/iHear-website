import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import postgres from "postgres";

import type { AdminActivity } from "./admin-store";
import {
  ACADEMY_CONTENT_KEY,
  ACADEMY_CURRENCIES,
  ACADEMY_DURATIONS,
  ACADEMY_LOCALES,
  ACADEMY_MAX_RECORD_VERSION,
  ACADEMY_TUTORS,
  AcademyContentValidationError,
  academyCharacterCount,
  academyField,
  defaultAcademyContent,
  parseAcademyContentConfig,
  readStoredAcademyContent,
  type AcademyContentConfig,
  type AcademyContentRecord,
} from "./academy-content-types";

export class AcademyContentUnavailableError extends Error {
  constructor() {
    super("Academy content is temporarily unavailable.");
    this.name = "AcademyContentUnavailableError";
  }
}

export class AcademyContentConflictError extends Error {
  constructor() {
    super("Another administrator published newer Academy content. Reload it before saving.");
    this.name = "AcademyContentConflictError";
  }
}

type ContentRow = { value: string; record_version: number; updated_at: Date | string; updated_by: string };
type LocalDocument = { record: AcademyContentRecord; activity: AdminActivity[] };
type UpdateInput = { config: AcademyContentConfig; expectedVersion: number; updatedBy: string; updatedByRole: "owner" | "editor" };
// admin_activity_log.changed_fields holds at most 80 entries (migration 015).
const MAX_CHANGED_FIELDS = 80;
const databaseUrl = process.env.IHEAR_FORCE_FILE_STORE === "1" ? "" : process.env.POSTGRES_URL || process.env.DATABASE_URL || "";
const hosted = Boolean(process.env.VERCEL || process.env.NETLIFY || process.env.CONTEXT);
const localPath = path.join(process.env.IHEAR_TEST_DATA_DIR || path.join(process.cwd(), "data"), "academy-content.json");
const globalForContent = globalThis as typeof globalThis & {
  ihearAcademyContentSql?: ReturnType<typeof postgres>;
  ihearAcademyContentQueues?: Map<string, Promise<unknown>>;
};

function sqlClient() {
  if (!databaseUrl) return null;
  if (!globalForContent.ihearAcademyContentSql) {
    globalForContent.ihearAcademyContentSql = postgres(databaseUrl, {
      max: 2, prepare: false,
      ssl: process.env.POSTGRES_SSL === "disable" ? false : "require",
      connect_timeout: 5, idle_timeout: 20,
    });
  }
  return globalForContent.ihearAcademyContentSql;
}

function validVersion(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= ACADEMY_MAX_RECORD_VERSION;
}

function storedRecord(value: unknown): AcademyContentRecord {
  try {
    if (!value || typeof value !== "object") throw new Error();
    const record = value as AcademyContentRecord;
    if (!validVersion(record.recordVersion) || typeof record.updatedAt !== "string"
      || !Number.isFinite(Date.parse(record.updatedAt)) || typeof record.updatedBy !== "string"
      || !record.updatedBy.trim() || academyCharacterCount(record.updatedBy) > 320) throw new Error();
    return {
      config: readStoredAcademyContent(record.config), recordVersion: record.recordVersion,
      updatedAt: new Date(record.updatedAt).toISOString(), updatedBy: record.updatedBy,
    };
  } catch {
    throw new AcademyContentUnavailableError();
  }
}

function fromRow(row: ContentRow | undefined) {
  if (!row) throw new AcademyContentUnavailableError();
  try {
    return storedRecord({ config: JSON.parse(row.value), recordVersion: row.record_version, updatedAt: new Date(row.updated_at).toISOString(), updatedBy: row.updated_by });
  } catch {
    throw new AcademyContentUnavailableError();
  }
}

function defaultLocalDocument(): LocalDocument {
  return {
    record: { config: parseAcademyContentConfig(defaultAcademyContent()), recordVersion: 1, updatedAt: new Date(0).toISOString(), updatedBy: "local-seed" },
    activity: [],
  };
}

async function readLocalDocument(): Promise<LocalDocument> {
  // A hosted deployment never shows seed content when persistence or its row is absent.
  if (hosted) throw new AcademyContentUnavailableError();
  try {
    const document = JSON.parse(await readFile(localPath, "utf8")) as LocalDocument;
    if (!Array.isArray(document.activity)) throw new AcademyContentUnavailableError();
    return { record: storedRecord(document.record), activity: document.activity };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return defaultLocalDocument();
    throw new AcademyContentUnavailableError();
  }
}

export async function readAcademyContent(): Promise<AcademyContentRecord> {
  try {
    const sql = sqlClient();
    if (!sql) return (await readLocalDocument()).record;
    const [row] = await sql<ContentRow[]>`
      SELECT value, record_version, updated_at, updated_by
      FROM public.site_settings WHERE key = ${ACADEMY_CONTENT_KEY}
    `;
    return fromRow(row);
  } catch {
    throw new AcademyContentUnavailableError();
  }
}

/** Changed field names for the audit log, bounded to the column's 80 entries. */
export function academyChangedFields(previous: AcademyContentConfig, next: AcademyContentConfig) {
  const fields: string[] = [];
  const blocks = new Set<string>();
  for (const currency of ACADEMY_CURRENCIES) {
    for (const duration of ACADEMY_DURATIONS) {
      for (const tutor of ACADEMY_TUTORS) {
        if (previous.pricing.rates[currency][duration][tutor] !== next.pricing.rates[currency][duration][tutor]) {
          fields.push(`pricing.${currency}.${duration}.${tutor}`);
          blocks.add("pricing.rates");
        }
      }
    }
  }
  for (const locale of ACADEMY_LOCALES) {
    for (const [id, value] of Object.entries(next.content[locale])) {
      if (previous.content[locale][id] === value) continue;
      fields.push(`${locale}.${id}`);
      blocks.add(`${locale}.${academyField(locale, id)?.block ?? id}`);
    }
  }
  if (fields.length <= MAX_CHANGED_FIELDS) return fields;
  // A large edit is recorded by block (for example "zhHant.faq.item7").
  const grouped = [...blocks];
  return grouped.length <= MAX_CHANGED_FIELDS ? grouped : [...grouped.slice(0, MAX_CHANGED_FIELDS - 1), `+${grouped.length - MAX_CHANGED_FIELDS + 1} more blocks`];
}

function activity(input: UpdateInput, previous: AcademyContentRecord, next: AcademyContentRecord): AdminActivity {
  return {
    id: randomUUID(), actorEmail: input.updatedBy, actorRole: input.updatedByRole,
    action: "academy.content.updated", entityType: "academy", entityId: ACADEMY_CONTENT_KEY,
    changedFields: academyChangedFields(previous.config, next.config), entityStatus: "published",
    entityVersion: next.recordVersion, createdAt: next.updatedAt,
  };
}

async function withLocalLock<T>(operation: () => Promise<T>): Promise<T> {
  await mkdir(path.dirname(localPath), { recursive: true });
  const lockPath = `${localPath}.lock`;
  let lock: Awaited<ReturnType<typeof open>> | undefined;
  // The queue serializes requests in this process; the exclusive file protects
  // a second local preview process. A stale lock fails closed, never overwrites.
  for (let attempt = 0; attempt < 100; attempt++) {
    try { lock = await open(lockPath, "wx"); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      await delay(20);
    }
  }
  if (!lock) throw new AcademyContentUnavailableError();
  try { return await operation(); }
  finally { await lock.close(); await unlink(lockPath); }
}

async function updateLocal(input: UpdateInput) {
  if (hosted) throw new AcademyContentUnavailableError();
  const queues = globalForContent.ihearAcademyContentQueues ??= new Map();
  const previous = queues.get(localPath) || Promise.resolve();
  const operation = previous.catch(() => undefined).then(() => withLocalLock(async () => {
    const document = await readLocalDocument();
    if (document.record.recordVersion !== input.expectedVersion) throw new AcademyContentConflictError();
    if (document.record.recordVersion === ACADEMY_MAX_RECORD_VERSION) throw new AcademyContentUnavailableError();
    const next: AcademyContentRecord = {
      config: input.config, recordVersion: document.record.recordVersion + 1,
      updatedAt: new Date().toISOString(), updatedBy: input.updatedBy,
    };
    const updated = { record: next, activity: [...document.activity, activity(input, document.record, next)] };
    const temporary = `${localPath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(updated), { encoding: "utf8", flag: "wx" });
      await rename(temporary, localPath);
    } finally { await unlink(temporary).catch(() => undefined); }
    return next;
  }));
  queues.set(localPath, operation);
  try { return await operation; }
  finally { if (queues.get(localPath) === operation) queues.delete(localPath); }
}

export async function updateAcademyContent(input: UpdateInput): Promise<AcademyContentRecord> {
  const config = parseAcademyContentConfig(input.config);
  if (!validVersion(input.expectedVersion)) throw new AcademyContentValidationError("Reload the current Academy content before saving.", "expectedVersion");
  if (typeof input.updatedBy !== "string" || !input.updatedBy.trim() || academyCharacterCount(input.updatedBy, "updatedBy") > 320
    || (input.updatedByRole !== "owner" && input.updatedByRole !== "editor")) {
    throw new AcademyContentValidationError("An effective administrator identity is required.", "updatedBy");
  }
  const write = { ...input, config };
  try {
    const sql = sqlClient();
    if (!sql) return await updateLocal(write);
    return await sql.begin(async transaction => {
      const [before] = await transaction<ContentRow[]>`
        SELECT value, record_version, updated_at, updated_by
        FROM public.site_settings WHERE key = ${ACADEMY_CONTENT_KEY} FOR UPDATE
      `;
      const previous = fromRow(before);
      if (previous.recordVersion === ACADEMY_MAX_RECORD_VERSION) throw new AcademyContentUnavailableError();
      const [row] = await transaction<ContentRow[]>`
        UPDATE public.site_settings
        SET value = ${JSON.stringify(config)}, record_version = record_version + 1,
            updated_at = clock_timestamp(), updated_by = ${input.updatedBy}
        WHERE key = ${ACADEMY_CONTENT_KEY} AND record_version = ${input.expectedVersion}
        RETURNING value, record_version, updated_at, updated_by
      `;
      // This throw must stay inside the transaction: the settings statement
      // trigger runs even for zero affected rows and its revision must roll back.
      if (!row) throw new AcademyContentConflictError();
      const next = fromRow(row);
      const entry = activity(write, previous, next);
      await transaction`
        INSERT INTO public.admin_activity_log
          (id, actor_email, actor_role, action, entity_type, entity_id, changed_fields, entity_status, entity_version, created_at)
        VALUES (${entry.id}, ${entry.actorEmail}, ${entry.actorRole}, ${entry.action}, ${entry.entityType},
          ${entry.entityId}, ${entry.changedFields}, ${entry.entityStatus}, ${entry.entityVersion}, ${entry.createdAt})
      `;
      return next;
    });
  } catch (error) {
    if (error instanceof AcademyContentConflictError || error instanceof AcademyContentValidationError) throw error;
    throw new AcademyContentUnavailableError();
  }
}
