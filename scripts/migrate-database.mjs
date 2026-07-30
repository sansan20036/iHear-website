import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import nextEnv from "@next/env";
import postgres from "postgres";
import { migrationChecksum } from "./migration-checksum.mjs";

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

const migrationsDirectory = path.join(process.cwd(), "db", "migrations");

function migrationVersion(fileName) {
  return fileName.split("_", 1)[0];
}

try {
  await sql`
    CREATE TABLE IF NOT EXISTS public.schema_migrations (
      version TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      checksum CHAR(64) NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`ALTER TABLE public.schema_migrations ENABLE ROW LEVEL SECURITY`;
  await sql`SELECT pg_advisory_lock(hashtext('ihear-schema-migrations'))`;

  const fileNames = (await readdir(migrationsDirectory))
    .filter((fileName) => /^\d+_[a-z0-9_]+\.sql$/i.test(fileName))
    .sort((left, right) => left.localeCompare(right));
  const applied = [];
  const skipped = [];

  for (const fileName of fileNames) {
    const version = migrationVersion(fileName);
    const contents = await readFile(path.join(migrationsDirectory, fileName), "utf8");
    const fileChecksum = migrationChecksum(contents);
    const [existing] = await sql`
      SELECT version, name, checksum
      FROM public.schema_migrations
      WHERE version = ${version}
    `;

    if (existing) {
      if (existing.name !== fileName || existing.checksum.trim() !== fileChecksum) {
        throw new Error(
          `Migration ${version} differs from the recorded file; create a new migration instead of editing history.`,
        );
      }
      skipped.push(fileName);
      continue;
    }

    await sql.begin(async (transaction) => {
      await transaction.unsafe(contents);
      await transaction`
        INSERT INTO public.schema_migrations (version, name, checksum)
        VALUES (${version}, ${fileName}, ${fileChecksum})
      `;
    });
    applied.push(fileName);
  }

  console.log(JSON.stringify({
    connected: true,
    applied,
    skipped,
    totalTracked: applied.length + skipped.length,
  }));
} catch (error) {
  console.error(JSON.stringify({
    connected: false,
    code: error && error.code ? error.code : "",
    message: error && error.message ? error.message : "Database migration failed",
  }));
  process.exitCode = 1;
} finally {
  await sql`SELECT pg_advisory_unlock(hashtext('ihear-schema-migrations'))`.catch(() => undefined);
  await sql.end({ timeout: 2 }).catch(() => undefined);
}
