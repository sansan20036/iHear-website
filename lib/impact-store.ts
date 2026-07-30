import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { unstable_cache } from "next/cache";
import postgres from "postgres";

import { IMPACT_MILESTONE_SEED } from "./impact-seed";
import type {
  ImpactMilestone,
  ImpactMilestoneInput,
  ImpactMilestoneUpdateInput,
  ImpactStatus,
} from "./impact-types";

export const IMPACT_CACHE_TAG = "journey-timeline-v2";

export class ImpactNotFoundError extends Error {
  constructor() {
    super("Impact milestone not found");
    this.name = "ImpactNotFoundError";
  }
}

export class ImpactConflictError extends Error {
  constructor(message = "This milestone was updated by someone else") {
    super(message);
    this.name = "ImpactConflictError";
  }
}

export class ImpactConfigurationError extends Error {
  constructor() {
    super("POSTGRES_URL or DATABASE_URL is required for production persistence");
    this.name = "ImpactConfigurationError";
  }
}

type ImpactFileStore = {
  version: number;
  milestones: ImpactMilestone[];
};

type ImpactRow = {
  id: string;
  kind: "event" | "metrics";
  period: string;
  volunteers: number;
  volunteers_plus: boolean;
  students: number;
  students_plus: boolean;
  sessions: number;
  sessions_plus: boolean;
  title_zh_hant: string;
  title_zh_hans: string;
  title_en: string;
  description_zh_hant: string;
  description_zh_hans: string;
  description_en: string;
  status: ImpactStatus;
  sort_order: number;
  version: number;
  created_at: Date | string;
  updated_at: Date | string;
  created_by: string;
  updated_by: string;
  archived_at: Date | string | null;
};

const filePath = path.join(process.cwd(), "data", "impact-milestones.json");
const databaseUrl = process.env.POSTGRES_URL || process.env.DATABASE_URL || "";
const isHostedProduction =
  process.env.NODE_ENV === "production" &&
  Boolean(process.env.VERCEL || process.env.NETLIFY || process.env.CONTEXT);

const globalForImpact = globalThis as typeof globalThis & {
  ihearImpactSql?: ReturnType<typeof postgres>;
  ihearImpactSchemaV3Ready?: Promise<void>;
};

let fileMutationQueue: Promise<unknown> = Promise.resolve();

function cloneSeed() {
  return JSON.parse(JSON.stringify(IMPACT_MILESTONE_SEED)) as ImpactMilestone[];
}

function iso(value: Date | string | null | undefined) {
  if (!value) return undefined;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function fromRow(row: ImpactRow): ImpactMilestone {
  return {
    id: row.id,
    kind: row.kind,
    period: row.period,
    volunteers: Number(row.volunteers),
    volunteersPlus: Boolean(row.volunteers_plus),
    students: Number(row.students),
    studentsPlus: Boolean(row.students_plus),
    sessions: Number(row.sessions),
    sessionsPlus: Boolean(row.sessions_plus),
    title: {
      zhHant: row.title_zh_hant,
      zhHans: row.title_zh_hans,
      en: row.title_en,
    },
    description: {
      zhHant: row.description_zh_hant,
      zhHans: row.description_zh_hans,
      en: row.description_en,
    },
    status: row.status,
    sortOrder: Number(row.sort_order),
    version: Number(row.version),
    createdAt: iso(row.created_at)!,
    updatedAt: iso(row.updated_at)!,
    createdBy: row.created_by,
    updatedBy: row.updated_by,
    archivedAt: iso(row.archived_at),
  };
}

function sqlClient() {
  if (!databaseUrl) return null;
  if (!globalForImpact.ihearImpactSql) {
    globalForImpact.ihearImpactSql = postgres(databaseUrl, {
      max: 2,
      prepare: false,
      ssl: process.env.POSTGRES_SSL === "disable" ? false : "require",
    });
  }
  return globalForImpact.ihearImpactSql;
}

async function ensurePostgresSchema() {
  const sql = sqlClient();
  if (!sql) return;
  if (!globalForImpact.ihearImpactSchemaV3Ready) {
    globalForImpact.ihearImpactSchemaV3Ready = (async () => {
      await sql`
        CREATE TABLE IF NOT EXISTS impact_milestones (
          id TEXT PRIMARY KEY,
          kind TEXT NOT NULL DEFAULT 'metrics',
          period CHAR(7) NOT NULL,
          volunteers INTEGER NOT NULL CHECK (volunteers >= 0),
          volunteers_plus BOOLEAN NOT NULL DEFAULT FALSE,
          students INTEGER NOT NULL CHECK (students >= 0),
          students_plus BOOLEAN NOT NULL DEFAULT FALSE,
          sessions INTEGER NOT NULL CHECK (sessions >= 0),
          sessions_plus BOOLEAN NOT NULL DEFAULT FALSE,
          title_zh_hant TEXT NOT NULL DEFAULT '',
          title_zh_hans TEXT NOT NULL DEFAULT '',
          title_en TEXT NOT NULL DEFAULT '',
          description_zh_hant TEXT NOT NULL DEFAULT '',
          description_zh_hans TEXT NOT NULL DEFAULT '',
          description_en TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL CHECK (status IN ('draft', 'published', 'archived')),
          sort_order INTEGER NOT NULL,
          version INTEGER NOT NULL DEFAULT 1,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          created_by TEXT NOT NULL,
          updated_by TEXT NOT NULL,
          archived_at TIMESTAMPTZ
        )
      `;
      await sql`ALTER TABLE impact_milestones ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'metrics'`;
      await sql`ALTER TABLE impact_milestones ADD COLUMN IF NOT EXISTS title_zh_hant TEXT NOT NULL DEFAULT ''`;
      await sql`ALTER TABLE impact_milestones ADD COLUMN IF NOT EXISTS title_zh_hans TEXT NOT NULL DEFAULT ''`;
      await sql`ALTER TABLE impact_milestones ADD COLUMN IF NOT EXISTS title_en TEXT NOT NULL DEFAULT ''`;
      await sql`
        CREATE INDEX IF NOT EXISTS impact_milestones_public_idx
        ON impact_milestones (status, sort_order, period)
      `;
      await sql`DROP INDEX IF EXISTS impact_milestones_period_idx`;

      await sql`
        CREATE TABLE IF NOT EXISTS impact_milestone_settings (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `;

      const seedMarkers = await sql<{ value: string }[]>`
        SELECT value FROM impact_milestone_settings WHERE key = 'initial_seed_v2'
      `;
      if (!seedMarkers[0]) {
        const countRows = await sql<{ count: number }[]>`
          SELECT COUNT(*)::INTEGER AS count FROM impact_milestones
        `;
        if (Number(countRows[0]?.count || 0) === 0) {
          for (const item of IMPACT_MILESTONE_SEED) {
            await sql`
              INSERT INTO impact_milestones (
                id, kind, period, volunteers, volunteers_plus, students, students_plus,
                sessions, sessions_plus, title_zh_hant, title_zh_hans, title_en,
                description_zh_hant, description_zh_hans, description_en,
                status, sort_order, version, created_at, updated_at,
                created_by, updated_by
              ) VALUES (
                ${item.id}, ${item.kind}, ${item.period}, ${item.volunteers}, ${item.volunteersPlus},
                ${item.students}, ${item.studentsPlus}, ${item.sessions}, ${item.sessionsPlus},
                ${item.title.zhHant}, ${item.title.zhHans}, ${item.title.en},
                ${item.description.zhHant}, ${item.description.zhHans}, ${item.description.en},
                ${item.status}, ${item.sortOrder}, ${item.version}, ${item.createdAt},
                ${item.updatedAt}, ${item.createdBy}, ${item.updatedBy}
              )
            `;
          }
        }
        await sql`
          INSERT INTO impact_milestone_settings (key, value)
          VALUES ('initial_seed_v2', 'complete')
          ON CONFLICT (key) DO NOTHING
        `;
      }
    })();
  }
  await globalForImpact.ihearImpactSchemaV3Ready;
}

async function readFileStore(): Promise<ImpactFileStore> {
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<ImpactFileStore>;
    const milestones = Array.isArray(parsed.milestones)
      ? parsed.milestones.map((item) => ({
          ...item,
          kind: item.kind || "metrics",
          title: item.title || { zhHant: "", zhHans: "", en: "" },
        }))
      : cloneSeed();
    return {
      version: Number(parsed.version || 1),
      milestones,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { version: 1, milestones: cloneSeed() };
    }
    throw error;
  }
}

async function writeFileStore(store: ImpactFileStore) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
}

async function withFileMutation<T>(callback: () => Promise<T>) {
  const operation = fileMutationQueue.then(callback, callback);
  fileMutationQueue = operation.then(
    () => undefined,
    () => undefined,
  );
  return operation;
}

function assertPersistenceAvailable() {
  if (!databaseUrl && isHostedProduction) throw new ImpactConfigurationError();
}

async function listPublishedUncached() {
  assertPersistenceAvailable();
  const sql = sqlClient();
  if (sql) {
    await ensurePostgresSchema();
    const rows = await sql<ImpactRow[]>`
      SELECT * FROM impact_milestones
      WHERE status = 'published'
      ORDER BY sort_order ASC, period ASC
    `;
    return rows.map(fromRow);
  }
  const store = await readFileStore();
  return store.milestones
    .filter((item) => item.status === "published")
    .sort((a, b) => a.sortOrder - b.sortOrder || a.period.localeCompare(b.period));
}

const listPublishedCached = unstable_cache(
  listPublishedUncached,
  [IMPACT_CACHE_TAG],
  { tags: [IMPACT_CACHE_TAG], revalidate: 86_400 },
);

export async function listPublishedImpactMilestones() {
  return listPublishedCached();
}

export async function listAllImpactMilestones() {
  assertPersistenceAvailable();
  const sql = sqlClient();
  if (sql) {
    await ensurePostgresSchema();
    const rows = await sql<ImpactRow[]>`
      SELECT * FROM impact_milestones
      ORDER BY sort_order ASC, period ASC
    `;
    return rows.map(fromRow);
  }
  const store = await readFileStore();
  return [...store.milestones].sort(
    (a, b) => a.sortOrder - b.sortOrder || a.period.localeCompare(b.period),
  );
}

export async function createImpactMilestone(input: ImpactMilestoneInput, email: string) {
  assertPersistenceAvailable();
  const sql = sqlClient();
  const id = randomUUID();
  const now = new Date().toISOString();

  if (sql) {
    await ensurePostgresSchema();
    try {
      const rows = await sql<ImpactRow[]>`
        INSERT INTO impact_milestones (
          id, kind, period, volunteers, volunteers_plus, students, students_plus,
          sessions, sessions_plus, title_zh_hant, title_zh_hans, title_en,
          description_zh_hant, description_zh_hans, description_en,
          status, sort_order, version, created_at, updated_at,
          created_by, updated_by, archived_at
        ) VALUES (
          ${id}, ${input.kind}, ${input.period}, ${input.volunteers}, ${input.volunteersPlus},
          ${input.students}, ${input.studentsPlus}, ${input.sessions}, ${input.sessionsPlus},
          ${input.title.zhHant}, ${input.title.zhHans}, ${input.title.en},
          ${input.description.zhHant}, ${input.description.zhHans}, ${input.description.en},
          ${input.status}, ${input.sortOrder}, 1, ${now}, ${now}, ${email}, ${email},
          ${input.status === "archived" ? now : null}
        ) RETURNING *
      `;
      return fromRow(rows[0]);
    } catch (error) {
      throw error;
    }
  }

  return withFileMutation(async () => {
    const store = await readFileStore();
    const milestone: ImpactMilestone = {
      id,
      ...input,
      version: 1,
      createdAt: now,
      updatedAt: now,
      createdBy: email,
      updatedBy: email,
      archivedAt: input.status === "archived" ? now : undefined,
    };
    store.version += 1;
    store.milestones.push(milestone);
    await writeFileStore(store);
    return milestone;
  });
}

export async function updateImpactMilestone(
  id: string,
  input: ImpactMilestoneUpdateInput,
  email: string,
) {
  assertPersistenceAvailable();
  const sql = sqlClient();
  const now = new Date().toISOString();

  if (sql) {
    await ensurePostgresSchema();
    try {
      const rows = await sql<ImpactRow[]>`
        UPDATE impact_milestones SET
          kind = ${input.kind},
          period = ${input.period},
          volunteers = ${input.volunteers},
          volunteers_plus = ${input.volunteersPlus},
          students = ${input.students},
          students_plus = ${input.studentsPlus},
          sessions = ${input.sessions},
          sessions_plus = ${input.sessionsPlus},
          title_zh_hant = ${input.title.zhHant},
          title_zh_hans = ${input.title.zhHans},
          title_en = ${input.title.en},
          description_zh_hant = ${input.description.zhHant},
          description_zh_hans = ${input.description.zhHans},
          description_en = ${input.description.en},
          status = ${input.status},
          sort_order = ${input.sortOrder},
          version = version + 1,
          updated_at = ${now},
          updated_by = ${email},
          archived_at = ${input.status === "archived" ? now : null}
        WHERE id = ${id} AND version = ${input.version}
        RETURNING *
      `;
      if (rows[0]) return fromRow(rows[0]);
      const existing = await sql<{ id: string }[]>`SELECT id FROM impact_milestones WHERE id = ${id}`;
      if (!existing[0]) throw new ImpactNotFoundError();
      throw new ImpactConflictError();
    } catch (error) {
      throw error;
    }
  }

  return withFileMutation(async () => {
    const store = await readFileStore();
    const index = store.milestones.findIndex((item) => item.id === id);
    if (index < 0) throw new ImpactNotFoundError();
    if (store.milestones[index].version !== input.version) throw new ImpactConflictError();
    const updated: ImpactMilestone = {
      ...store.milestones[index],
      ...input,
      version: input.version + 1,
      updatedAt: now,
      updatedBy: email,
      archivedAt: input.status === "archived" ? now : undefined,
    };
    store.version += 1;
    store.milestones[index] = updated;
    await writeFileStore(store);
    return updated;
  });
}

export async function deleteImpactMilestone(id: string, version: number) {
  assertPersistenceAvailable();
  const sql = sqlClient();

  if (sql) {
    await ensurePostgresSchema();
    const deleted = await sql<{ id: string }[]>`
      DELETE FROM impact_milestones
      WHERE id = ${id} AND version = ${version}
      RETURNING id
    `;
    if (deleted[0]) return deleted[0].id;
    const existing = await sql<{ id: string }[]>`SELECT id FROM impact_milestones WHERE id = ${id}`;
    if (!existing[0]) throw new ImpactNotFoundError();
    throw new ImpactConflictError();
  }

  return withFileMutation(async () => {
    const store = await readFileStore();
    const index = store.milestones.findIndex((item) => item.id === id);
    if (index < 0) throw new ImpactNotFoundError();
    if (store.milestones[index].version !== version) throw new ImpactConflictError();
    store.version += 1;
    store.milestones.splice(index, 1);
    await writeFileStore(store);
    return id;
  });
}
