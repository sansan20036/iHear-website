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
  const [localizedTable] = await client`
    SELECT to_regclass('public.localized_content_overrides') IS NOT NULL AS available
  `;
  const localizedContent = localizedTable.available
    ? await client`SELECT COUNT(*)::INTEGER AS count FROM localized_content_overrides`
    : [{ count: 0 }];
  const [teamTables] = await client`
    SELECT
      to_regclass('public.team_people') IS NOT NULL AS people,
      to_regclass('public.team_profiles') IS NOT NULL AS profiles
  `;
  const teamPeople = teamTables.people
    ? await client`SELECT COUNT(*)::INTEGER AS count FROM team_people`
    : [{ count: 0 }];
  const teamProfiles = teamTables.profiles
    ? await client`SELECT COUNT(*)::INTEGER AS count FROM team_profiles`
    : [{ count: 0 }];
  const [mediaTables] = await client`
    SELECT
      to_regclass('public.site_media_assets') IS NOT NULL AS assets,
      to_regclass('public.site_media_variants') IS NOT NULL AS variants
  `;
  const siteMediaAssets = mediaTables.assets
    ? await client`SELECT COUNT(*)::INTEGER AS count FROM site_media_assets`
    : [{ count: 0 }];
  const siteMediaVariants = mediaTables.variants
    ? await client`SELECT COUNT(*)::INTEGER AS count FROM site_media_variants`
    : [{ count: 0 }];
  return {
    impact_milestones: Number(impact[0].count),
    impact_milestone_settings: Number(settings[0].count),
    content_overrides: Number(content[0].count),
    localized_content_overrides: Number(localizedContent[0].count),
    team_people: Number(teamPeople[0].count),
    team_profiles: Number(teamProfiles[0].count),
    site_media_assets: Number(siteMediaAssets[0].count),
    site_media_variants: Number(siteMediaVariants[0].count),
  };
}

async function currentRevisions(client) {
  const [table] = await client`
    SELECT to_regclass('public.site_content_revisions') IS NOT NULL AS available
  `;
  if (!table.available) return null;
  const rows = await client`
    SELECT scope, revision::TEXT AS revision
    FROM site_content_revisions
    ORDER BY scope
  `;
  return Object.fromEntries(rows.map((row) => [row.scope, row.revision]));
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
  if (
    backup.payload?.format !== "ihear-postgres-backup" ||
    ![1, 2, 3, 4].includes(backup.payload?.version)
  ) {
    throw new Error("Unsupported backup format.");
  }
  if (backup.checksum !== checksum(backup.payload)) {
    throw new Error("Backup checksum does not match; the file may be damaged or modified.");
  }

  const tables = backup.payload.tables || {};
  const impactMilestones = tables.impact_milestones;
  const impactMilestoneSettings = tables.impact_milestone_settings;
  const contentOverrides = tables.content_overrides;
  const localizedContentOverrides = backup.payload.version >= 3
    ? tables.localized_content_overrides
    : [];
  const schemaMigrations = tables.schema_migrations;
  const teamPeople = backup.payload.version >= 2 ? tables.team_people : [];
  const teamProfiles = backup.payload.version >= 2 ? tables.team_profiles : [];
  const siteMediaAssets = backup.payload.version >= 4 ? tables.site_media_assets : [];
  const siteMediaVariants = backup.payload.version >= 4 ? tables.site_media_variants : [];

  if (
    !Array.isArray(impactMilestones) ||
    !Array.isArray(impactMilestoneSettings) ||
    !Array.isArray(contentOverrides) ||
    !Array.isArray(localizedContentOverrides) ||
    !Array.isArray(schemaMigrations) ||
    !Array.isArray(teamPeople) ||
    !Array.isArray(teamProfiles) ||
    !Array.isArray(siteMediaAssets) ||
    !Array.isArray(siteMediaVariants)
  ) {
    throw new Error("Backup is missing one or more required tables.");
  }

  assertUnique(impactMilestones, (row) => row.id, "impact_milestones");
  assertUnique(impactMilestoneSettings, (row) => row.key, "impact_milestone_settings");
  assertUnique(contentOverrides, (row) => `${row.page}\u0000${row.key}`, "content_overrides");
  assertUnique(
    localizedContentOverrides,
    (row) => `${row.page}\u0000${row.key}\u0000${row.locale}`,
    "localized_content_overrides",
  );
  assertUnique(schemaMigrations, (row) => row.version, "schema_migrations");
  assertUnique(teamPeople, (row) => row.id, "team_people");
  assertUnique(teamProfiles, (row) => row.id, "team_profiles");
  assertUnique(siteMediaAssets, (row) => row.slot, "site_media_assets");
  assertUnique(siteMediaVariants, (row) => `${row.slot}\u0000${row.width}`, "site_media_variants");
  assertUnique(siteMediaVariants, (row) => row.storage_path, "site_media_variants.storage_path");

  const countsBefore = await currentCounts(sql);
  const revisionsBefore = await currentRevisions(sql);
  const rollbackMarker = "IHEAR_BACKUP_VERIFICATION_ROLLBACK";
  let triggerRevisionCheck = revisionsBefore ? "pending" : "not-applicable";

  try {
    await sql.begin(async (transaction) => {
      const transactionRevisionsBefore = await currentRevisions(transaction);
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

      for (const row of localizedContentOverrides) {
        await transaction`
          INSERT INTO localized_content_overrides (page, key, locale, value, updated_at, updated_by)
          VALUES (${row.page}, ${row.key}, ${row.locale}, ${row.value}, ${row.updated_at}, ${row.updated_by})
          ON CONFLICT (page, key, locale) DO UPDATE SET
            value = EXCLUDED.value,
            updated_at = EXCLUDED.updated_at,
            updated_by = EXCLUDED.updated_by
        `;
      }

      for (const row of teamPeople) {
        await transaction`
          INSERT INTO team_people (
            id, name, initials, publication_consent_at, publication_consent_by,
            version, created_at, updated_at, created_by, updated_by
          ) VALUES (
            ${row.id}, ${row.name}, ${row.initials}, ${row.publication_consent_at},
            ${row.publication_consent_by}, ${row.version}, ${row.created_at},
            ${row.updated_at}, ${row.created_by}, ${row.updated_by}
          )
          ON CONFLICT (id) DO UPDATE SET
            name = EXCLUDED.name,
            initials = EXCLUDED.initials,
            publication_consent_at = EXCLUDED.publication_consent_at,
            publication_consent_by = EXCLUDED.publication_consent_by,
            version = EXCLUDED.version,
            created_at = EXCLUDED.created_at,
            updated_at = EXCLUDED.updated_at,
            created_by = EXCLUDED.created_by,
            updated_by = EXCLUDED.updated_by
        `;
      }

      for (const row of teamProfiles) {
        await transaction`
          INSERT INTO team_profiles (
            id, person_id, section, status, sort_order, school, grade, show_school, show_grade,
            role_en, role_zh_hant, role_zh_hans,
            school_display_en, school_display_zh_hant, school_display_zh_hans,
            languages_en, languages_zh_hant, languages_zh_hans,
            strengths_en, strengths_zh_hant, strengths_zh_hans,
            summary_en, summary_zh_hant, summary_zh_hans,
            bio_en, bio_zh_hant, bio_zh_hans,
            hobbies_en, hobbies_zh_hant, hobbies_zh_hans,
            version, created_at, updated_at, created_by, updated_by
          ) VALUES (
            ${row.id}, ${row.person_id}, ${row.section}, ${row.status}, ${row.sort_order},
            ${row.school}, ${row.grade}, ${row.show_school}, ${row.show_grade},
            ${row.role_en}, ${row.role_zh_hant}, ${row.role_zh_hans},
            ${row.school_display_en}, ${row.school_display_zh_hant}, ${row.school_display_zh_hans},
            ${row.languages_en}, ${row.languages_zh_hant}, ${row.languages_zh_hans},
            ${row.strengths_en}, ${row.strengths_zh_hant}, ${row.strengths_zh_hans},
            ${row.summary_en}, ${row.summary_zh_hant}, ${row.summary_zh_hans},
            ${row.bio_en}, ${row.bio_zh_hant}, ${row.bio_zh_hans},
            ${row.hobbies_en}, ${row.hobbies_zh_hant}, ${row.hobbies_zh_hans},
            ${row.version}, ${row.created_at}, ${row.updated_at}, ${row.created_by}, ${row.updated_by}
          )
          ON CONFLICT (id) DO UPDATE SET
            person_id = EXCLUDED.person_id,
            section = EXCLUDED.section,
            status = EXCLUDED.status,
            sort_order = EXCLUDED.sort_order,
            school = EXCLUDED.school,
            grade = EXCLUDED.grade,
            show_school = EXCLUDED.show_school,
            show_grade = EXCLUDED.show_grade,
            role_en = EXCLUDED.role_en,
            role_zh_hant = EXCLUDED.role_zh_hant,
            role_zh_hans = EXCLUDED.role_zh_hans,
            school_display_en = EXCLUDED.school_display_en,
            school_display_zh_hant = EXCLUDED.school_display_zh_hant,
            school_display_zh_hans = EXCLUDED.school_display_zh_hans,
            languages_en = EXCLUDED.languages_en,
            languages_zh_hant = EXCLUDED.languages_zh_hant,
            languages_zh_hans = EXCLUDED.languages_zh_hans,
            strengths_en = EXCLUDED.strengths_en,
            strengths_zh_hant = EXCLUDED.strengths_zh_hant,
            strengths_zh_hans = EXCLUDED.strengths_zh_hans,
            summary_en = EXCLUDED.summary_en,
            summary_zh_hant = EXCLUDED.summary_zh_hant,
            summary_zh_hans = EXCLUDED.summary_zh_hans,
            bio_en = EXCLUDED.bio_en,
            bio_zh_hant = EXCLUDED.bio_zh_hant,
            bio_zh_hans = EXCLUDED.bio_zh_hans,
            hobbies_en = EXCLUDED.hobbies_en,
            hobbies_zh_hant = EXCLUDED.hobbies_zh_hant,
            hobbies_zh_hans = EXCLUDED.hobbies_zh_hans,
            version = EXCLUDED.version,
            created_at = EXCLUDED.created_at,
            updated_at = EXCLUDED.updated_at,
            created_by = EXCLUDED.created_by,
            updated_by = EXCLUDED.updated_by
        `;
      }

      if (teamPeople.length) {
        const restored = await transaction`
          SELECT id, name, initials, publication_consent_at, publication_consent_by, version
          FROM team_people WHERE id IN ${transaction(teamPeople.map((row) => row.id))}
        `;
        const byId = new Map(restored.map((row) => [row.id, row]));
        for (const row of teamPeople) {
          const value = byId.get(row.id);
          if (
            !value ||
            value.name !== row.name ||
            value.initials !== row.initials ||
            Number(value.version) !== Number(row.version) ||
            String(value.publication_consent_by || "") !== String(row.publication_consent_by || "")
          ) {
            throw new Error(`Team person did not round-trip: ${row.id}`);
          }
        }
      }

      if (teamProfiles.length) {
        const restored = await transaction`
          SELECT * FROM team_profiles
          WHERE id IN ${transaction(teamProfiles.map((row) => row.id))}
        `;
        const byId = new Map(restored.map((row) => [row.id, row]));
        const fields = [
          "person_id", "section", "status", "sort_order", "school", "grade",
          "show_school", "show_grade", "role_en", "role_zh_hant", "role_zh_hans",
          "school_display_en", "school_display_zh_hant", "school_display_zh_hans",
          "languages_en", "languages_zh_hant", "languages_zh_hans",
          "strengths_en", "strengths_zh_hant", "strengths_zh_hans",
          "summary_en", "summary_zh_hant", "summary_zh_hans",
          "bio_en", "bio_zh_hant", "bio_zh_hans",
          "hobbies_en", "hobbies_zh_hant", "hobbies_zh_hans", "version",
        ];
        for (const row of teamProfiles) {
          const value = byId.get(row.id);
          if (!value || fields.some((field) => String(value[field]) !== String(row[field]))) {
            throw new Error(`Team profile did not round-trip: ${row.id}`);
          }
        }
      }

      for (const row of siteMediaAssets) {
        await transaction`
          INSERT INTO site_media_assets (
            slot, alt_en, alt_zh_hant, alt_zh_hans, focal_x, focal_y,
            record_version, created_at, created_by, updated_at, updated_by
          ) VALUES (
            ${row.slot}, ${row.alt_en}, ${row.alt_zh_hant}, ${row.alt_zh_hans},
            ${row.focal_x}, ${row.focal_y}, ${row.record_version}, ${row.created_at},
            ${row.created_by}, ${row.updated_at}, ${row.updated_by}
          )
          ON CONFLICT (slot) DO UPDATE SET
            alt_en = EXCLUDED.alt_en,
            alt_zh_hant = EXCLUDED.alt_zh_hant,
            alt_zh_hans = EXCLUDED.alt_zh_hans,
            focal_x = EXCLUDED.focal_x,
            focal_y = EXCLUDED.focal_y,
            record_version = EXCLUDED.record_version,
            created_at = EXCLUDED.created_at,
            created_by = EXCLUDED.created_by,
            updated_at = EXCLUDED.updated_at,
            updated_by = EXCLUDED.updated_by
        `;
      }

      for (const row of siteMediaVariants) {
        await transaction`
          INSERT INTO site_media_variants (
            slot, width, pixel_width, pixel_height, byte_size, mime_type,
            public_url, storage_path
          ) VALUES (
            ${row.slot}, ${row.width}, ${row.pixel_width}, ${row.pixel_height},
            ${row.byte_size}, ${row.mime_type}, ${row.public_url}, ${row.storage_path}
          )
          ON CONFLICT (slot, width) DO UPDATE SET
            pixel_width = EXCLUDED.pixel_width,
            pixel_height = EXCLUDED.pixel_height,
            byte_size = EXCLUDED.byte_size,
            mime_type = EXCLUDED.mime_type,
            public_url = EXCLUDED.public_url,
            storage_path = EXCLUDED.storage_path
        `;
      }

      if (siteMediaAssets.length) {
        const restored = await transaction`
          SELECT slot, alt_en, alt_zh_hant, alt_zh_hans, focal_x, focal_y, record_version
          FROM site_media_assets
          WHERE slot IN ${transaction(siteMediaAssets.map((row) => row.slot))}
        `;
        const bySlot = new Map(restored.map((row) => [row.slot, row]));
        for (const row of siteMediaAssets) {
          const value = bySlot.get(row.slot);
          if (
            !value || value.alt_en !== row.alt_en || value.alt_zh_hant !== row.alt_zh_hant
            || value.alt_zh_hans !== row.alt_zh_hans
            || Number(value.focal_x) !== Number(row.focal_x)
            || Number(value.focal_y) !== Number(row.focal_y)
            || Number(value.record_version) !== Number(row.record_version)
          ) {
            throw new Error(`Site media asset did not round-trip: ${row.slot}`);
          }
        }
      }

      const restoredCounts = await currentCounts(transaction);
      for (const [tableName, expectedRows] of Object.entries({
        impact_milestones: impactMilestones.length,
        impact_milestone_settings: impactMilestoneSettings.length,
        content_overrides: contentOverrides.length,
        ...(backup.payload.version >= 3
          ? { localized_content_overrides: localizedContentOverrides.length }
          : {}),
        ...(backup.payload.version >= 2
          ? { team_people: teamPeople.length, team_profiles: teamProfiles.length }
          : {}),
        ...(backup.payload.version >= 4
          ? {
              site_media_assets: siteMediaAssets.length,
              site_media_variants: siteMediaVariants.length,
            }
          : {}),
      })) {
        if (restoredCounts[tableName] < expectedRows) {
          throw new Error(`Restore verification produced too few rows for ${tableName}.`);
        }
      }

      if (transactionRevisionsBefore) {
        const transactionRevisionsAfter = await currentRevisions(transaction);
        const expectedScopes = [
          ...(impactMilestones.length || impactMilestoneSettings.length ? ["impact"] : []),
          ...(contentOverrides.length || localizedContentOverrides.length || siteMediaAssets.length
            ? ["content"]
            : []),
          ...(teamPeople.length || teamProfiles.length ? ["team"] : []),
        ];
        for (const scope of expectedScopes) {
          if (
            !transactionRevisionsAfter?.[scope] ||
            BigInt(transactionRevisionsAfter[scope]) <= BigInt(transactionRevisionsBefore[scope])
          ) {
            throw new Error(`Restore did not advance the ${scope} live revision.`);
          }
        }
        triggerRevisionCheck = "passed-and-rolled-back";
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
  const revisionsAfter = await currentRevisions(sql);
  if (JSON.stringify(revisionsBefore) !== JSON.stringify(revisionsAfter)) {
    throw new Error("Live revisions changed after rollback verification.");
  }

  console.log(JSON.stringify({
    verified: true,
    path: path.relative(process.cwd(), backupPath),
    checksum: backup.checksum,
    restoreSimulation: "passed-and-rolled-back",
    databaseUnchanged: true,
    triggerRevisionCheck,
    rowCounts: {
      impact_milestones: impactMilestones.length,
      impact_milestone_settings: impactMilestoneSettings.length,
      content_overrides: contentOverrides.length,
      localized_content_overrides: localizedContentOverrides.length,
      team_people: teamPeople.length,
      team_profiles: teamProfiles.length,
      site_media_assets: siteMediaAssets.length,
      site_media_variants: siteMediaVariants.length,
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
