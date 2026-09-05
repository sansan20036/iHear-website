import { readFile } from "node:fs/promises";
import path from "node:path";

import nextEnv from "@next/env";
import postgres from "postgres";

const { loadEnvConfig } = nextEnv;
loadEnvConfig(process.cwd());

const backupArgument = process.argv[2];
if (!backupArgument) throw new Error("Pass the pre-deployment backup path.");
const backupPath = path.resolve(process.cwd(), backupArgument);
const backup = JSON.parse(await readFile(backupPath, "utf8"));
const baseline = backup.payload?.tables;
if (!baseline) throw new Error("The backup does not contain table data.");

const databaseUrl = process.env.POSTGRES_URL || process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("POSTGRES_URL or DATABASE_URL is not configured.");
const sql = postgres(databaseUrl, {
  max: 1,
  prepare: false,
  ssl: process.env.POSTGRES_SSL === "disable" ? false : "require",
  connect_timeout: 10,
});

const preservedLegacyTargets = [
  ["/__global__", "shared.prog.subtitle", "en", "/", "i18n:prog_sub"],
  ["/team", "team.roster.title", "en", "/team", "i18n:roster_h"],
  ["/team", "team.roster.subtitle", "en", "/team", "i18n:roster_sub"],
  ["/team", "team.team.intro", "en", "/team", "i18n:team_intro"],
];
const targetIds = new Set(preservedLegacyTargets.map(([page, key, locale]) => `${page}\0${key}\0${locale}`));

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function sortObject(value) {
  if (Array.isArray(value)) return value.map(sortObject);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, sortObject(value[key])]),
  );
}

function canonical(value) {
  return JSON.stringify(sortObject(plain(value)));
}

function withoutFields(rows, fields) {
  return rows.map((row) => Object.fromEntries(
    Object.entries(row).filter(([key]) => !fields.includes(key)),
  ));
}

function assertSame(name, before, after) {
  if (canonical(before) !== canonical(after)) {
    throw new Error(`${name} changed after the preservation migration.`);
  }
}

try {
  const current = {
    impact_milestones: await sql`SELECT * FROM impact_milestones ORDER BY id`,
    impact_milestone_settings: await sql`SELECT * FROM impact_milestone_settings ORDER BY key`,
    content_overrides: await sql`SELECT * FROM content_overrides ORDER BY page, key`,
    localized_content_overrides: await sql`SELECT * FROM localized_content_overrides ORDER BY page, key, locale`,
    team_people: await sql`SELECT * FROM team_people ORDER BY id`,
    team_profiles: await sql`SELECT * FROM team_profiles ORDER BY id`,
    site_media_assets: await sql`SELECT * FROM site_media_assets ORDER BY slot`,
    site_media_variants: await sql`SELECT * FROM site_media_variants ORDER BY slot, width`,
    site_settings: await sql`SELECT * FROM site_settings ORDER BY key`,
    site_layout_configs: await sql`SELECT * FROM site_layout_configs ORDER BY page`,
    schema_migrations: await sql`SELECT * FROM schema_migrations ORDER BY version`,
  };

  assertSame("impact_milestones", baseline.impact_milestones, current.impact_milestones);
  assertSame("impact_milestone_settings", baseline.impact_milestone_settings, current.impact_milestone_settings);
  assertSame("content_overrides", baseline.content_overrides, current.content_overrides);
  assertSame("team_people", baseline.team_people, current.team_people);
  assertSame(
    "team_profiles",
    baseline.team_profiles,
    withoutFields(current.team_profiles, ["deleted_at", "deleted_by"]),
  );
  assertSame(
    "site_media_assets",
    baseline.site_media_assets,
    withoutFields(current.site_media_assets, ["zoom"]),
  );
  assertSame("site_media_variants", baseline.site_media_variants, current.site_media_variants);
  assertSame("site_settings", baseline.site_settings, current.site_settings);
  assertSame("site_layout_configs", baseline.site_layout_configs, current.site_layout_configs);

  const beforeLocalized = baseline.localized_content_overrides.filter(
    (row) => !targetIds.has(`${row.page}\0${row.key}\0${row.locale}`),
  );
  const afterLocalized = current.localized_content_overrides.filter(
    (row) => !targetIds.has(`${row.page}\0${row.key}\0${row.locale}`),
  );
  assertSame("non-migrated localized_content_overrides", beforeLocalized, afterLocalized);

  const preserved = preservedLegacyTargets.map(([targetPage, targetKey, locale, sourcePage, sourceKey]) => {
    const target = current.localized_content_overrides.find(
      (row) => row.page === targetPage && row.key === targetKey && row.locale === locale,
    );
    const source = current.localized_content_overrides.find(
      (row) => row.page === sourcePage && row.key === sourceKey && row.locale === locale,
    );
    return {
      page: targetPage,
      key: targetKey,
      matchesLegacy: Boolean(target && source && target.value === source.value),
      updatedBy: target?.updated_by || "",
    };
  });
  if (preserved.some((item) => !item.matchesLegacy)) {
    throw new Error("A guarded semantic slot does not match its preserved legacy value.");
  }

  const baselineVersions = new Set(baseline.schema_migrations.map((row) => row.version));
  assertSame(
    "previous schema_migrations",
    baseline.schema_migrations,
    current.schema_migrations.filter((row) => baselineVersions.has(row.version)),
  );
  const newMigrations = current.schema_migrations
    .filter((row) => !baselineVersions.has(row.version))
    .map((row) => row.name);

  console.log(JSON.stringify({
    preserved: true,
    backup: path.relative(process.cwd(), backupPath),
    unchanged: [
      "team_people",
      "team_profiles",
      "impact_milestones",
      "site_media_assets",
      "site_media_variants",
      "site_settings",
      "site_layout_configs",
      "all non-migrated content",
    ],
    preservedLegacy: preserved,
    newMigrations,
  }));
} finally {
  await sql.end({ timeout: 2 }).catch(() => undefined);
}
