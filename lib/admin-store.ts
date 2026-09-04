import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import postgres from "postgres";

export type StoredAdminAccount = {
  email: string;
  role: "editor";
  enabled: boolean;
  version: number;
  invitedBy: string;
  createdAt: string;
  updatedAt: string;
  updatedBy: string;
};

export type AdminActivity = {
  id: string;
  actorEmail: string;
  actorRole: "owner" | "editor";
  action: string;
  entityType: "team" | "impact" | "admin";
  entityId: string;
  changedFields: string[];
  entityStatus: string | null;
  entityVersion: number | null;
  createdAt: string;
};

type AdminFileStore = { accounts: StoredAdminAccount[]; activity: AdminActivity[] };

const databaseUrl = process.env.IHEAR_FORCE_FILE_STORE === "1"
  ? ""
  : process.env.POSTGRES_URL || process.env.DATABASE_URL || "";
const filePath = path.join(process.cwd(), "data", "admin-console.json");
const globalForAdminStore = globalThis as typeof globalThis & {
  ihearAdminSql?: ReturnType<typeof postgres>;
};
let fileQueue: Promise<unknown> = Promise.resolve();

function sqlClient() {
  if (!databaseUrl) return null;
  if (!globalForAdminStore.ihearAdminSql) {
    globalForAdminStore.ihearAdminSql = postgres(databaseUrl, {
      max: 2,
      prepare: false,
      ssl: process.env.POSTGRES_SSL === "disable" ? false : "require",
    });
  }
  return globalForAdminStore.ihearAdminSql;
}

function iso(value: Date | string) {
  return new Date(value).toISOString();
}

function fromAccountRow(row: Record<string, unknown>): StoredAdminAccount {
  return {
    email: String(row.email),
    role: "editor",
    enabled: Boolean(row.enabled),
    version: Number(row.version),
    invitedBy: String(row.invited_by),
    createdAt: iso(row.created_at as Date | string),
    updatedAt: iso(row.updated_at as Date | string),
    updatedBy: String(row.updated_by),
  };
}

function fromActivityRow(row: Record<string, unknown>): AdminActivity {
  return {
    id: String(row.id),
    actorEmail: String(row.actor_email),
    actorRole: row.actor_role as "owner" | "editor",
    action: String(row.action),
    entityType: row.entity_type as "team" | "impact" | "admin",
    entityId: String(row.entity_id),
    changedFields: Array.isArray(row.changed_fields) ? row.changed_fields.map(String) : [],
    entityStatus: row.entity_status == null ? null : String(row.entity_status),
    entityVersion: row.entity_version == null ? null : Number(row.entity_version),
    createdAt: iso(row.created_at as Date | string),
  };
}

async function readFileStore(): Promise<AdminFileStore> {
  try {
    const parsed = JSON.parse(await readFile(filePath, "utf8")) as Partial<AdminFileStore>;
    return {
      accounts: Array.isArray(parsed.accounts) ? parsed.accounts : [],
      activity: Array.isArray(parsed.activity) ? parsed.activity : [],
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { accounts: [], activity: [] };
    throw error;
  }
}

async function mutateFile<T>(callback: (store: AdminFileStore) => T | Promise<T>) {
  const operation = fileQueue.then(async () => {
    const store = await readFileStore();
    const result = await callback(store);
    await writeFile(filePath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
    return result;
  });
  fileQueue = operation.catch(() => undefined);
  return operation as Promise<T>;
}

export class AdminAccountConflictError extends Error {}
export class AdminAccountNotFoundError extends Error {}

export async function findAdminAccount(email: string) {
  const sql = sqlClient();
  if (sql) {
    const rows = await sql`SELECT * FROM public.admin_accounts WHERE email = ${email}`;
    return rows[0] ? fromAccountRow(rows[0]) : null;
  }
  return (await readFileStore()).accounts.find((item) => item.email === email) || null;
}

export async function listAdminAccounts() {
  const sql = sqlClient();
  if (sql) {
    return (await sql`SELECT * FROM public.admin_accounts ORDER BY email`).map(fromAccountRow);
  }
  return (await readFileStore()).accounts.slice().sort((a, b) => a.email.localeCompare(b.email));
}

export async function createAdminAccount(email: string, actor: string) {
  const sql = sqlClient();
  if (sql) {
    const rows = await sql`
      INSERT INTO public.admin_accounts (email, role, enabled, invited_by, updated_by)
      VALUES (${email}, 'editor', TRUE, ${actor}, ${actor})
      ON CONFLICT (email) DO NOTHING
      RETURNING *
    `;
    if (!rows[0]) throw new AdminAccountConflictError("This editor already exists");
    return fromAccountRow(rows[0]);
  }
  return mutateFile(async (store) => {
    if (store.accounts.some((item) => item.email === email)) {
      throw new AdminAccountConflictError("This editor already exists");
    }
    const now = new Date().toISOString();
    const account: StoredAdminAccount = {
      email, role: "editor", enabled: true, version: 1,
      invitedBy: actor, createdAt: now, updatedAt: now, updatedBy: actor,
    };
    store.accounts.push(account);
    return account;
  });
}

export async function updateAdminAccount(email: string, enabled: boolean, version: number, actor: string) {
  const sql = sqlClient();
  if (sql) {
    const rows = await sql`
      UPDATE public.admin_accounts
      SET enabled = ${enabled}, version = version + 1, updated_at = NOW(), updated_by = ${actor}
      WHERE email = ${email} AND version = ${version}
      RETURNING *
    `;
    if (rows[0]) return fromAccountRow(rows[0]);
    const exists = await sql`SELECT email FROM public.admin_accounts WHERE email = ${email}`;
    if (!exists[0]) throw new AdminAccountNotFoundError("Editor not found");
    throw new AdminAccountConflictError("Editor account changed in another tab");
  }
  return mutateFile(async (store) => {
    const account = store.accounts.find((item) => item.email === email);
    if (!account) throw new AdminAccountNotFoundError("Editor not found");
    if (account.version !== version) throw new AdminAccountConflictError("Editor account changed in another tab");
    account.enabled = enabled;
    account.version += 1;
    account.updatedAt = new Date().toISOString();
    account.updatedBy = actor;
    return { ...account };
  });
}

export async function appendAdminActivity(input: Omit<AdminActivity, "id" | "createdAt">) {
  const activity: AdminActivity = { ...input, id: randomUUID(), createdAt: new Date().toISOString() };
  const sql = sqlClient();
  if (sql) {
    await sql`
      INSERT INTO public.admin_activity_log (
        id, actor_email, actor_role, action, entity_type, entity_id,
        changed_fields, entity_status, entity_version, created_at
      ) VALUES (
        ${activity.id}, ${activity.actorEmail}, ${activity.actorRole}, ${activity.action},
        ${activity.entityType}, ${activity.entityId}, ${activity.changedFields},
        ${activity.entityStatus}, ${activity.entityVersion}, ${activity.createdAt}
      )
    `;
    return activity;
  }
  return mutateFile(async (store) => {
    store.activity.unshift(activity);
    store.activity = store.activity.slice(0, 1000);
    return activity;
  });
}

export async function listAdminActivity(limit = 50) {
  const safeLimit = Math.max(1, Math.min(200, Math.trunc(limit)));
  const sql = sqlClient();
  if (sql) {
    return (await sql.unsafe(
      "SELECT * FROM public.admin_activity_log ORDER BY created_at DESC LIMIT $1",
      [safeLimit],
    )).map(fromActivityRow);
  }
  return (await readFileStore()).activity.slice(0, safeLimit);
}
