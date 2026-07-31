import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
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

function checksum(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

try {
  const impactMilestones = await sql`SELECT * FROM impact_milestones ORDER BY id`;
  const impactMilestoneSettings =
    await sql`SELECT * FROM impact_milestone_settings ORDER BY key`;
  const contentOverrides = await sql`SELECT * FROM content_overrides ORDER BY page, key`;
  const [teamTables] = await sql`
    SELECT
      to_regclass('public.team_people') IS NOT NULL AS people,
      to_regclass('public.team_profiles') IS NOT NULL AS profiles
  `;
  const hasTeamTables = Boolean(teamTables.people && teamTables.profiles);
  const teamPeople = hasTeamTables ? await sql`SELECT * FROM team_people ORDER BY id` : [];
  const teamProfiles = hasTeamTables ? await sql`SELECT * FROM team_profiles ORDER BY id` : [];
  const schemaMigrations = await sql`SELECT * FROM public.schema_migrations ORDER BY version`;
  const constraints = await sql`
    SELECT
      relation.relname AS table_name,
      con.conname AS constraint_name,
      pg_get_constraintdef(con.oid, true) AS definition
    FROM pg_constraint AS con
    JOIN pg_class AS relation ON relation.oid = con.conrelid
    JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = 'public'
      AND relation.relname IN (
        'api_rate_limits',
        'impact_milestones',
        'impact_milestone_settings',
        'content_overrides',
        'team_people',
        'team_profiles',
        'schema_migrations',
        'site_content_revisions'
      )
    ORDER BY relation.relname, con.conname
  `;
  const indexes = await sql`
    SELECT
      relation.relname AS table_name,
      index_relation.relname AS index_name,
      pg_get_indexdef(index_relation.oid) AS definition
    FROM pg_index AS idx
    JOIN pg_class AS relation ON relation.oid = idx.indrelid
    JOIN pg_class AS index_relation ON index_relation.oid = idx.indexrelid
    JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = 'public'
      AND relation.relname IN (
        'api_rate_limits',
        'impact_milestones',
        'impact_milestone_settings',
        'content_overrides',
        'team_people',
        'team_profiles',
        'schema_migrations',
        'site_content_revisions'
      )
    ORDER BY relation.relname, index_relation.relname
  `;

  const payload = {
    format: "ihear-postgres-backup",
    version: hasTeamTables ? 2 : 1,
    createdAt: new Date().toISOString(),
    tables: {
      impact_milestones: impactMilestones,
      impact_milestone_settings: impactMilestoneSettings,
      content_overrides: contentOverrides,
      ...(hasTeamTables ? { team_people: teamPeople, team_profiles: teamProfiles } : {}),
      schema_migrations: schemaMigrations,
    },
    schema: {
      constraints,
      indexes,
    },
  };
  const backup = {
    checksumAlgorithm: "sha256",
    checksum: checksum(payload),
    payload,
  };
  const timestamp = payload.createdAt.replace(/[-:.]/g, "").replace("Z", "Z");
  const backupDirectory = path.join(process.cwd(), "backups");
  const backupPath = path.join(backupDirectory, `ihear-baseline-${timestamp}.json`);

  await mkdir(backupDirectory, { recursive: true });
  await writeFile(backupPath, `${JSON.stringify(backup, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });

  console.log(JSON.stringify({
    created: true,
    path: path.relative(process.cwd(), backupPath),
    checksum: backup.checksum,
    rowCounts: {
      impact_milestones: impactMilestones.length,
      impact_milestone_settings: impactMilestoneSettings.length,
      content_overrides: contentOverrides.length,
      ...(hasTeamTables
        ? { team_people: teamPeople.length, team_profiles: teamProfiles.length }
        : {}),
      schema_migrations: schemaMigrations.length,
    },
  }));
} catch (error) {
  console.error(JSON.stringify({
    created: false,
    code: error && error.code ? error.code : "",
    message: error && error.message ? error.message : "Database backup failed",
  }));
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 2 }).catch(() => undefined);
}
