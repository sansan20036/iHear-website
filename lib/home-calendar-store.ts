import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import postgres from "postgres";

import type { AdminActivity } from "./admin-store";
import {
  HOME_CALENDAR_KEY,
  HOME_CALENDAR_MAX_RECORD_VERSION,
  HomeCalendarValidationError,
  emptyHomeCalendar,
  homeCalendarChangedFields,
  homeCalendarCharacterCount,
  parseHomeCalendarConfig,
  type HomeCalendarConfig,
  type HomeCalendarRecord,
} from "./home-calendar-types";

// The same storage pattern as the Academy content (lib/academy-content-store.ts): one
// site_settings row with a record version, an optimistic version check on every save,
// and the audit entry written in the same transaction.

export class HomeCalendarUnavailableError extends Error {
  constructor() {
    super("The calendar is temporarily unavailable.");
    this.name = "HomeCalendarUnavailableError";
  }
}

export class HomeCalendarConflictError extends Error {
  constructor() {
    super("Another administrator saved the calendar. Reload it before saving.");
    this.name = "HomeCalendarConflictError";
  }
}

type CalendarRow = { value: string; record_version: number; updated_at: Date | string; updated_by: string };
type LocalDocument = { record: HomeCalendarRecord; activity: AdminActivity[] };
type UpdateInput = { config: HomeCalendarConfig; expectedVersion: number; updatedBy: string; updatedByRole: "owner" | "editor" };
const databaseUrl = process.env.IHEAR_FORCE_FILE_STORE === "1" ? "" : process.env.POSTGRES_URL || process.env.DATABASE_URL || "";
const hosted = Boolean(process.env.VERCEL || process.env.NETLIFY || process.env.CONTEXT);
const localPath = path.join(process.env.IHEAR_TEST_DATA_DIR || path.join(process.cwd(), "data"), "home-calendar.json");
const globalForCalendar = globalThis as typeof globalThis & {
  ihearHomeCalendarSql?: ReturnType<typeof postgres>;
  ihearHomeCalendarQueues?: Map<string, Promise<unknown>>;
};

function sqlClient() {
  if (!databaseUrl) return null;
  if (!globalForCalendar.ihearHomeCalendarSql) {
    globalForCalendar.ihearHomeCalendarSql = postgres(databaseUrl, {
      max: 2, prepare: false,
      ssl: process.env.POSTGRES_SSL === "disable" ? false : "require",
      connect_timeout: 5, idle_timeout: 20,
    });
  }
  return globalForCalendar.ihearHomeCalendarSql;
}

function validVersion(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= HOME_CALENDAR_MAX_RECORD_VERSION;
}

function storedRecord(value: unknown): HomeCalendarRecord {
  try {
    if (!value || typeof value !== "object") throw new Error();
    const record = value as HomeCalendarRecord;
    if (!validVersion(record.recordVersion) || typeof record.updatedAt !== "string"
      || !Number.isFinite(Date.parse(record.updatedAt)) || typeof record.updatedBy !== "string"
      || !record.updatedBy.trim() || homeCalendarCharacterCount(record.updatedBy) > 320) throw new Error();
    return {
      config: parseHomeCalendarConfig(record.config), recordVersion: record.recordVersion,
      updatedAt: new Date(record.updatedAt).toISOString(), updatedBy: record.updatedBy,
    };
  } catch {
    throw new HomeCalendarUnavailableError();
  }
}

function fromRow(row: CalendarRow | undefined) {
  if (!row) throw new HomeCalendarUnavailableError();
  try {
    return storedRecord({ config: JSON.parse(row.value), recordVersion: row.record_version, updatedAt: new Date(row.updated_at).toISOString(), updatedBy: row.updated_by });
  } catch {
    throw new HomeCalendarUnavailableError();
  }
}

function defaultLocalDocument(): LocalDocument {
  return { record: { config: emptyHomeCalendar(), recordVersion: 1, updatedAt: new Date(0).toISOString(), updatedBy: "local-seed" }, activity: [] };
}

async function readLocalDocument(): Promise<LocalDocument> {
  // A hosted deployment without its database row reports unavailable, never an empty calendar.
  if (hosted) throw new HomeCalendarUnavailableError();
  try {
    const document = JSON.parse(await readFile(localPath, "utf8")) as LocalDocument;
    if (!Array.isArray(document.activity)) throw new HomeCalendarUnavailableError();
    return { record: storedRecord(document.record), activity: document.activity };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return defaultLocalDocument();
    throw new HomeCalendarUnavailableError();
  }
}

export async function readHomeCalendar(): Promise<HomeCalendarRecord> {
  try {
    const sql = sqlClient();
    if (!sql) return (await readLocalDocument()).record;
    const [row] = await sql<CalendarRow[]>`
      SELECT value, record_version, updated_at, updated_by
      FROM public.site_settings WHERE key = ${HOME_CALENDAR_KEY}
    `;
    return fromRow(row);
  } catch {
    throw new HomeCalendarUnavailableError();
  }
}

function activity(input: UpdateInput, previous: HomeCalendarRecord, next: HomeCalendarRecord): AdminActivity {
  return {
    id: randomUUID(), actorEmail: input.updatedBy, actorRole: input.updatedByRole,
    action: "calendar.events.updated", entityType: "calendar", entityId: HOME_CALENDAR_KEY,
    changedFields: homeCalendarChangedFields(previous.config, next.config), entityStatus: "published",
    entityVersion: next.recordVersion, createdAt: next.updatedAt,
  };
}

async function withLocalLock<T>(operation: () => Promise<T>): Promise<T> {
  await mkdir(path.dirname(localPath), { recursive: true });
  const lockPath = `${localPath}.lock`;
  let lock: Awaited<ReturnType<typeof open>> | undefined;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { lock = await open(lockPath, "wx"); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      await delay(20);
    }
  }
  if (!lock) throw new HomeCalendarUnavailableError();
  try { return await operation(); }
  finally { await lock.close(); await unlink(lockPath); }
}

async function updateLocal(input: UpdateInput) {
  if (hosted) throw new HomeCalendarUnavailableError();
  const queues = globalForCalendar.ihearHomeCalendarQueues ??= new Map();
  const previous = queues.get(localPath) || Promise.resolve();
  const operation = previous.catch(() => undefined).then(() => withLocalLock(async () => {
    const document = await readLocalDocument();
    if (document.record.recordVersion !== input.expectedVersion) throw new HomeCalendarConflictError();
    if (document.record.recordVersion === HOME_CALENDAR_MAX_RECORD_VERSION) throw new HomeCalendarUnavailableError();
    const next: HomeCalendarRecord = {
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

export async function updateHomeCalendar(input: UpdateInput): Promise<HomeCalendarRecord> {
  const config = parseHomeCalendarConfig(input.config);
  if (!validVersion(input.expectedVersion)) throw new HomeCalendarValidationError("Reload the calendar before saving.", "expectedVersion");
  if (typeof input.updatedBy !== "string" || !input.updatedBy.trim() || homeCalendarCharacterCount(input.updatedBy) > 320
    || (input.updatedByRole !== "owner" && input.updatedByRole !== "editor")) {
    throw new HomeCalendarValidationError("An effective administrator identity is required.", "updatedBy");
  }
  const write = { ...input, config };
  try {
    const sql = sqlClient();
    if (!sql) return await updateLocal(write);
    return await sql.begin(async transaction => {
      const [before] = await transaction<CalendarRow[]>`
        SELECT value, record_version, updated_at, updated_by
        FROM public.site_settings WHERE key = ${HOME_CALENDAR_KEY} FOR UPDATE
      `;
      const previous = fromRow(before);
      if (previous.recordVersion === HOME_CALENDAR_MAX_RECORD_VERSION) throw new HomeCalendarUnavailableError();
      const [row] = await transaction<CalendarRow[]>`
        UPDATE public.site_settings
        SET value = ${JSON.stringify(config)}, record_version = record_version + 1,
            updated_at = clock_timestamp(), updated_by = ${input.updatedBy}
        WHERE key = ${HOME_CALENDAR_KEY} AND record_version = ${input.expectedVersion}
        RETURNING value, record_version, updated_at, updated_by
      `;
      // Inside the transaction, so the settings statement trigger's revision rolls back too.
      if (!row) throw new HomeCalendarConflictError();
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
    if (error instanceof HomeCalendarConflictError || error instanceof HomeCalendarValidationError) throw error;
    throw new HomeCalendarUnavailableError();
  }
}
