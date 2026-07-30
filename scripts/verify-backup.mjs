import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
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

function assertUnique(rows, makeKey, tableName) {
  const keys = new Set();
  for (const row of rows) {
    const key = makeKey(row);
    if (keys.has(key)) throw new Error(`Duplicate key in backup table ${tableName}: ${key}`);
    keys.add(key);
  }
}

async function resolveBackupPath() {
  if (process.argv[2]) return path.resolve(process.cwd(), process.argv[2]);

  const backupDirectory = path.join(process.cwd(), "backups");
  const backups = (await readdir(backupDirectory))
    .filter((fileName) => /^ihear-baseline-.*\.json$/i.test(fileName))
    .sort((left, right) => right.localeCompare(left));

  if (!backups[0]) throw new Error("No baseline backup was found.");
  return path.join(backupDirectory, backups[0]);
}

async function currentCounts(client) {
  const impact = await client`SELECT COUNT(*)::INTEGER AS count FROM impact_milestones`;
  const settings =
    await client`SELECT COUNT(*)::INTEGER AS count FROM impact_milestone_settings`;
  const content = await client`SELECT COUNT(*)::INTEGER AS count FROM content_overrides`;
  return {
    impact_milestones: Number(impact[0].count),
    impact_milestone_settings: Number(settings[0].count),
    content_overrides: Number(content[0].count),
  };
}

function countryFields(row) {
  const legacyPublishedMetrics =
    row.kind === "metrics" && row.status === "published" && row.countries == null;
  return {
    countries: legacyPublishedMetrics ? 4 : Number(row.countries || 0),
    country_names_zh_hant:
      row.country_names_zh_hant ??
      (legacyPublishedMetrics ? "臺灣 · 中國 · 美國 · 加拿大" : ""),
    country_names_zh_hans:
      row.country_names_zh_hans ??
      (legacyPublishedMetrics ? "台湾 · 中国 · 美国 · 加拿大" : ""),
    country_names_en:
      row.country_names_en ??
      (legacyPublishedMetrics ? "Taiwan · China · United States · Canada" : ""),
  };
}

try {
  const backupPath = await resolveBackupPath();
  const backup = JSON.parse(await readFile(backupPath, "utf8"));

  if (backup.checksumAlgorithm !== "sha256") {
    throw new Error("Unsupported backup checksum algorithm.");
  }
  if (backup.payload?.format !== "ihear-postgres-backup" || backup.payload?.version !== 1) {
    throw new Error("Unsupported backup format.");
  }
  if (backup.checksum !== checksum(backup.payload)) {
    throw new Error("Backup checksum does not match; the file may be damaged or modified.");
  }

  const tables = backup.payload.tables || {};
  const impactMilestones = tables.impact_milestones;
  const impactMilestoneSettings = tables.impact_milestone_settings;
  const contentOverrides = tables.content_overrides;
  const schemaMigrations = tables.schema_migrations;

  if (
    !Array.isArray(impactMilestones) ||
    !Array.isArray(impactMilestoneSettings) ||
    !Array.isArray(contentOverrides) ||
    !Array.isArray(schemaMigrations)
  ) {
    throw new Error("Backup is missing one or more required tables.");
  }

  assertUnique(impactMilestones, (row) => row.id, "impact_milestones");
  assertUnique(impactMilestoneSettings, (row) => row.key, "impact_milestone_settings");
  assertUnique(contentOverrides, (row) => `${row.page}\u0000${row.key}`, "content_overrides");
  assertUnique(schemaMigrations, (row) => row.version, "schema_migrations");

  const countsBefore = await currentCounts(sql);
  const rollbackMarker = "IHEAR_BACKUP_VERIFICATION_ROLLBACK";

  try {
    await sql.begin(async (transaction) => {
      for (const row of impactMilestoneSettings) {
        await transaction`
          INSERT INTO impact_milestone_settings (key, value, updated_at)
          VALUES (${row.key}, ${row.value}, ${row.updated_at})
          ON CONFLICT (key) DO UPDATE SET
            value = EXCLUDED.value,
            updated_at = EXCLUDED.updated_at
        `;
      }

      for (const row of impactMilestones) {
        const countries = countryFields(row);
        await transaction`
          INSERT INTO impact_milestones (
            id, kind, period, volunteers, volunteers_plus, students, students_plus,
            sessions, sessions_plus, countries, country_names_zh_hant,
            country_names_zh_hans, country_names_en, title_zh_hant, title_zh_hans, title_en,
            description_zh_hant, description_zh_hans, description_en,
            status, sort_order, version, created_at, updated_at,
            created_by, updated_by, archived_at
          ) VALUES (
            ${row.id}, ${row.kind}, ${row.period}, ${row.volunteers}, ${row.volunteers_plus},
            ${row.students}, ${row.students_plus}, ${row.sessions}, ${row.sessions_plus},
            ${countries.countries}, ${countries.country_names_zh_hant},
            ${countries.country_names_zh_hans}, ${countries.country_names_en},
            ${row.title_zh_hant}, ${row.title_zh_hans}, ${row.title_en},
            ${row.description_zh_hant}, ${row.description_zh_hans}, ${row.description_en},
            ${row.status}, ${row.sort_order}, ${row.version}, ${row.created_at}, ${row.updated_at},
            ${row.created_by}, ${row.updated_by}, ${row.archived_at}
          )
          ON CONFLICT (id) DO UPDATE SET
            kind = EXCLUDED.kind,
            period = EXCLUDED.period,
            volunteers = EXCLUDED.volunteers,
            volunteers_plus = EXCLUDED.volunteers_plus,
            students = EXCLUDED.students,
            students_plus = EXCLUDED.students_plus,
            sessions = EXCLUDED.sessions,
            sessions_plus = EXCLUDED.sessions_plus,
            countries = EXCLUDED.countries,
            country_names_zh_hant = EXCLUDED.country_names_zh_hant,
            country_names_zh_hans = EXCLUDED.country_names_zh_hans,
            country_names_en = EXCLUDED.country_names_en,
            title_zh_hant = EXCLUDED.title_zh_hant,
            title_zh_hans = EXCLUDED.title_zh_hans,
            title_en = EXCLUDED.title_en,
            description_zh_hant = EXCLUDED.description_zh_hant,
            description_zh_hans = EXCLUDED.description_zh_hans,
            description_en = EXCLUDED.description_en,
            status = EXCLUDED.status,
            sort_order = EXCLUDED.sort_order,
            version = EXCLUDED.version,
            created_at = EXCLUDED.created_at,
            updated_at = EXCLUDED.updated_at,
            created_by = EXCLUDED.created_by,
            updated_by = EXCLUDED.updated_by,
            archived_at = EXCLUDED.archived_at
        `;
      }

      const restoredImpact = impactMilestones.length
        ? await transaction`
            SELECT
              id,
              countries,
              country_names_zh_hant,
              country_names_zh_hans,
              country_names_en
            FROM impact_milestones
            WHERE id IN ${transaction(impactMilestones.map((row) => row.id))}
          `
        : [];
      const restoredImpactById = new Map(restoredImpact.map((row) => [row.id, row]));
      for (const row of impactMilestones) {
        const expected = countryFields(row);
        const restored = restoredImpactById.get(row.id);
        if (
          !restored ||
          Number(restored.countries) !== expected.countries ||
          restored.country_names_zh_hant !== expected.country_names_zh_hant ||
          restored.country_names_zh_hans !== expected.country_names_zh_hans ||
          restored.country_names_en !== expected.country_names_en
        ) {
          throw new Error(`Country fields did not round-trip for impact milestone ${row.id}.`);
        }
      }

      for (const row of contentOverrides) {
        await transaction`
          INSERT INTO content_overrides (page, key, value, updated_at, updated_by)
          VALUES (${row.page}, ${row.key}, ${row.value}, ${row.updated_at}, ${row.updated_by})
          ON CONFLICT (page, key) DO UPDATE SET
            value = EXCLUDED.value,
            updated_at = EXCLUDED.updated_at,
            updated_by = EXCLUDED.updated_by
        `;
      }

      const restoredCounts = await currentCounts(transaction);
      for (const [tableName, expectedRows] of Object.entries({
        impact_milestones: impactMilestones.length,
        impact_milestone_settings: impactMilestoneSettings.length,
        content_overrides: contentOverrides.length,
      })) {
        if (restoredCounts[tableName] < expectedRows) {
          throw new Error(`Restore verification produced too few rows for ${tableName}.`);
        }
      }

      throw new Error(rollbackMarker);
    });
  } catch (error) {
    if (error.message !== rollbackMarker) throw error;
  }

  const countsAfter = await currentCounts(sql);
  if (JSON.stringify(countsBefore) !== JSON.stringify(countsAfter)) {
    throw new Error("Database row counts changed after rollback verification.");
  }

  console.log(JSON.stringify({
    verified: true,
    path: path.relative(process.cwd(), backupPath),
    checksum: backup.checksum,
    restoreSimulation: "passed-and-rolled-back",
    databaseUnchanged: true,
    rowCounts: {
      impact_milestones: impactMilestones.length,
      impact_milestone_settings: impactMilestoneSettings.length,
      content_overrides: contentOverrides.length,
      schema_migrations: schemaMigrations.length,
    },
  }));
} catch (error) {
  console.error(JSON.stringify({
    verified: false,
    code: error && error.code ? error.code : "",
    message: error && error.message ? error.message : "Backup verification failed",
  }));
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 2 }).catch(() => undefined);
}
