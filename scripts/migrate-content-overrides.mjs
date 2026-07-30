import { readFile } from "node:fs/promises";
import path from "node:path";

import nextEnv from "@next/env";
import postgres from "postgres";

const { loadEnvConfig } = nextEnv;
loadEnvConfig(process.cwd());

const databaseUrl = process.env.POSTGRES_URL || process.env.DATABASE_URL;

if (!databaseUrl) {
  console.error("POSTGRES_URL or DATABASE_URL is not configured.");
  process.exit(1);
}

const sql = postgres(databaseUrl, {
  max: 1,
  prepare: false,
  ssl: process.env.POSTGRES_SSL === "disable" ? false : "require",
  connect_timeout: 10,
});

const migrationPath = path.join(process.cwd(), "db", "migrations", "004_content_overrides.sql");
const contentPath = path.join(process.cwd(), "content.json");

function validateEntry(page, key, value, updatedBy) {
  if (typeof page !== "string" || page.length < 1 || page.length > 500) {
    throw new Error(`Invalid content page: ${page}`);
  }
  if (typeof key !== "string" || key.length < 1 || key.length > 5000) {
    throw new Error(`Invalid content key on page ${page}`);
  }
  if (typeof value !== "string" || value.length > 5000) {
    throw new Error(`Invalid content value for ${page} / ${key}`);
  }
  if (typeof updatedBy !== "string" || updatedBy.length < 1 || updatedBy.length > 320) {
    throw new Error("content.json must contain a valid updatedBy email before migration.");
  }
}

try {
  const migrationSql = await readFile(migrationPath, "utf8");
  const raw = await readFile(contentPath, "utf8");
  const store = JSON.parse(raw);
  const updatedBy = store.updatedBy || "system-content-migration";
  const updatedAt = store.updatedAt || new Date().toISOString();
  const entries = [];
  let insertedRows = 0;

  for (const [page, pageContent] of Object.entries(store.pages || {})) {
    for (const [key, value] of Object.entries(pageContent || {})) {
      validateEntry(page, key, value, updatedBy);
      entries.push({ page, key, value });
    }
  }

  await sql.begin(async (transaction) => {
    await transaction.unsafe(migrationSql);

    for (const entry of entries) {
      const inserted = await transaction`
        INSERT INTO content_overrides (page, key, value, updated_at, updated_by)
        VALUES (${entry.page}, ${entry.key}, ${entry.value}, ${updatedAt}, ${updatedBy})
        ON CONFLICT (page, key) DO NOTHING
        RETURNING page
      `;
      insertedRows += inserted.length;
    }
  });

  const [result] = await sql`
    SELECT COUNT(*)::INTEGER AS count
    FROM content_overrides
  `;

  console.log(JSON.stringify({
    connected: true,
    table: "content_overrides",
    sourceEntries: entries.length,
    insertedRows,
    totalRows: Number(result.count),
  }));
} catch (error) {
  console.error(JSON.stringify({
    connected: false,
    code: error && error.code ? error.code : "",
    message: error && error.message ? error.message : "Content migration failed",
  }));
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 2 }).catch(() => undefined);
}
