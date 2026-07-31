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

const expectedTables = [
  "content_overrides",
  "impact_milestone_settings",
  "impact_milestones",
  "schema_migrations",
  "site_content_revisions",
  "team_people",
  "team_profiles",
];

const expectedConstraints = [
  "content_overrides_page_path",
  "content_overrides_pkey",
  "impact_milestones_actor_length",
  "impact_milestones_archive_state",
  "impact_milestones_countries_range",
  "impact_milestones_country_names_length",
  "impact_milestones_description_length",
  "impact_milestones_event_metrics_shape",
  "impact_milestones_id_length",
  "impact_milestones_kind_allowed",
  "impact_milestones_metrics_title_shape",
  "impact_milestones_period_format",
  "impact_milestones_pkey",
  "impact_milestones_published_locales_complete",
  "impact_milestones_sessions_nonnegative",
  "impact_milestones_sort_order_range",
  "impact_milestones_status_allowed",
  "impact_milestones_students_nonnegative",
  "impact_milestones_timestamp_order",
  "impact_milestones_title_length",
  "impact_milestones_version_positive",
  "impact_milestones_volunteers_nonnegative",
  "site_content_revisions_pkey",
  "site_content_revisions_revision",
  "site_content_revisions_scope",
  "team_people_consent_pair",
  "team_people_pkey",
  "team_people_timestamp_order",
  "team_profiles_person_section_unique",
  "team_profiles_pkey",
  "team_profiles_public_visibility",
  "team_profiles_published_english",
  "team_profiles_timestamp_order",
];

const expectedIndexes = [
  "impact_milestones_unique_published_metrics_period",
  "team_profiles_public_order_idx",
];

const expectedTriggers = [
  "content_overrides_live_revision",
  "impact_milestone_settings_live_revision",
  "impact_milestones_live_revision",
  "team_people_live_revision",
  "team_profiles_live_revision",
];

try {
  const tables = await sql`
    SELECT table_schema, table_name
    FROM information_schema.tables
    WHERE
      (table_schema = 'public' AND table_name IN (
        'impact_milestones',
        'impact_milestone_settings',
        'content_overrides',
        'schema_migrations',
        'site_content_revisions',
        'team_people',
        'team_profiles'
      ))
      OR (table_schema = 'supabase_migrations' AND table_name = 'schema_migrations')
    ORDER BY table_schema, table_name
  `;

  const constraints = await sql`
    SELECT
      namespace.nspname AS schema_name,
      relation.relname AS table_name,
      con.conname AS constraint_name,
      con.contype AS constraint_type,
      pg_get_constraintdef(con.oid, true) AS definition
    FROM pg_constraint AS con
    JOIN pg_class AS relation ON relation.oid = con.conrelid
    JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = 'public'
      AND relation.relname IN ('impact_milestones', 'content_overrides', 'site_content_revisions', 'team_people', 'team_profiles')
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
      AND relation.relname IN ('impact_milestones', 'team_people', 'team_profiles')
    ORDER BY index_relation.relname
  `;

  const policies = await sql`
    SELECT schemaname, tablename, policyname, roles, cmd
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename IN ('impact_milestones', 'content_overrides', 'site_content_revisions', 'team_people', 'team_profiles')
    ORDER BY tablename, policyname
  `;

  const rowLevelSecurity = await sql`
    SELECT relation.relname AS table_name, relation.relrowsecurity AS enabled
    FROM pg_class AS relation
    JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = 'public'
      AND relation.relname IN (
        'impact_milestones',
        'impact_milestone_settings',
        'content_overrides',
        'schema_migrations',
        'site_content_revisions',
        'team_people',
        'team_profiles'
      )
    ORDER BY relation.relname
  `;

  const [invalid] = await sql`
    SELECT
      COUNT(*) FILTER (
        WHERE period !~ '^[0-9]{4}-(0[1-9]|1[0-2])$'
      )::INTEGER AS invalid_period,
      COUNT(*) FILTER (
        WHERE kind NOT IN ('event', 'metrics')
      )::INTEGER AS invalid_kind,
      COUNT(*) FILTER (
        WHERE status NOT IN ('draft', 'published', 'archived')
      )::INTEGER AS invalid_status,
      COUNT(*) FILTER (WHERE version < 1)::INTEGER AS invalid_version,
      COUNT(*) FILTER (WHERE sort_order < 0)::INTEGER AS invalid_sort_order,
      COUNT(*) FILTER (
        WHERE volunteers < 0 OR students < 0 OR sessions < 0
          OR countries < 0 OR countries > 250
      )::INTEGER AS invalid_metrics,
      COUNT(*) FILTER (
        WHERE kind = 'event' AND (
          volunteers <> 0 OR volunteers_plus OR
          students <> 0 OR students_plus OR
          sessions <> 0 OR sessions_plus OR
          countries <> 0 OR
          country_names_zh_hant <> '' OR
          country_names_zh_hans <> '' OR
          country_names_en <> ''
        )
      )::INTEGER AS invalid_event_metrics,
      COUNT(*) FILTER (
        WHERE kind = 'metrics' AND (
          title_zh_hant <> '' OR title_zh_hans <> '' OR title_en <> ''
        )
      )::INTEGER AS invalid_metrics_titles,
      COUNT(*) FILTER (
        WHERE char_length(id) NOT BETWEEN 1 AND 200
      )::INTEGER AS invalid_id,
      COUNT(*) FILTER (
        WHERE char_length(title_zh_hant) > 200
          OR char_length(title_zh_hans) > 200
          OR char_length(title_en) > 200
      )::INTEGER AS invalid_title_length,
      COUNT(*) FILTER (
        WHERE char_length(description_zh_hant) > 2000
          OR char_length(description_zh_hans) > 2000
          OR char_length(description_en) > 2000
      )::INTEGER AS invalid_description_length,
      COUNT(*) FILTER (
        WHERE char_length(country_names_zh_hant) > 500
          OR char_length(country_names_zh_hans) > 500
          OR char_length(country_names_en) > 500
      )::INTEGER AS invalid_country_names_length,
      COUNT(*) FILTER (
        WHERE char_length(created_by) NOT BETWEEN 1 AND 320
          OR char_length(updated_by) NOT BETWEEN 1 AND 320
      )::INTEGER AS invalid_actor_length,
      COUNT(*) FILTER (
        WHERE (status = 'archived') <> (archived_at IS NOT NULL)
      )::INTEGER AS invalid_archive_state,
      COUNT(*) FILTER (
        WHERE updated_at < created_at
      )::INTEGER AS invalid_timestamp_order,
      COUNT(*) FILTER (
        WHERE status = 'published' AND (
          description_zh_hant = ''
          OR description_zh_hans = ''
          OR description_en = ''
          OR (
            kind = 'event' AND (
              title_zh_hant = '' OR title_zh_hans = '' OR title_en = ''
            )
          )
          OR (
            kind = 'metrics' AND (
              countries NOT BETWEEN 1 AND 250
              OR country_names_zh_hant = ''
              OR country_names_zh_hans = ''
              OR country_names_en = ''
            )
          )
        )
      )::INTEGER AS invalid_published_locales
    FROM impact_milestones
  `;

  const [invalidContent] = await sql`
    SELECT
      COUNT(*) FILTER (
        WHERE left(page, 1) <> '/'
      )::INTEGER AS invalid_page_path,
      COUNT(*) FILTER (
        WHERE char_length(page) NOT BETWEEN 1 AND 500
          OR char_length(key) NOT BETWEEN 1 AND 5000
          OR char_length(value) > 5000
          OR char_length(updated_by) NOT BETWEEN 1 AND 320
      )::INTEGER AS invalid_content_length
    FROM content_overrides
  `;

  const triggers = await sql`
    SELECT event_object_table AS table_name, trigger_name, action_timing, event_manipulation
    FROM information_schema.triggers
    WHERE trigger_schema = 'public'
      AND trigger_name IN (
        'content_overrides_live_revision',
        'impact_milestone_settings_live_revision',
        'impact_milestones_live_revision',
        'team_people_live_revision',
        'team_profiles_live_revision'
      )
    ORDER BY trigger_name, event_manipulation
  `;

  const [liveRevisionFunction] = await sql`
    SELECT
      routine.prosecdef AS security_definer,
      COALESCE(array_to_string(routine.proconfig, ','), '') AS configuration,
      EXISTS (
        SELECT 1
        FROM aclexplode(COALESCE(routine.proacl, acldefault('f', routine.proowner))) AS privilege
        WHERE privilege.grantee = 0 AND privilege.privilege_type = 'EXECUTE'
      ) AS public_can_execute
    FROM pg_proc AS routine
    JOIN pg_namespace AS namespace ON namespace.oid = routine.pronamespace
    WHERE namespace.nspname = 'public'
      AND routine.proname = 'bump_site_content_revision'
    LIMIT 1
  `;

  const [invalidTeam] = await sql`
    SELECT
      (SELECT COUNT(*) FROM team_people
        WHERE version < 1
          OR char_length(name) NOT BETWEEN 1 AND 160
          OR char_length(initials) NOT BETWEEN 1 AND 8
          OR ((publication_consent_at IS NULL) <> (publication_consent_by IS NULL))
          OR updated_at < created_at
      )::INTEGER AS invalid_people,
      (SELECT COUNT(*) FROM team_profiles
        WHERE section NOT IN ('leader', 'tutor')
          OR status NOT IN ('draft', 'published')
          OR version < 1
          OR sort_order NOT BETWEEN 0 AND 1000000
          OR (show_school AND school = '')
          OR (show_grade AND grade = '')
          OR updated_at < created_at
      )::INTEGER AS invalid_profiles,
      (SELECT COUNT(*) FROM team_profiles AS profile
        JOIN team_people AS person ON person.id = profile.person_id
        WHERE profile.status = 'published' AND (
          person.publication_consent_at IS NULL
          OR person.publication_consent_by IS NULL
          OR profile.role_en = ''
          OR profile.bio_en = ''
          OR (profile.section = 'tutor' AND profile.summary_en = '')
        )
      )::INTEGER AS invalid_published_profiles,
      (SELECT COUNT(*) FROM (
        SELECT person_id, section FROM team_profiles
        GROUP BY person_id, section HAVING COUNT(*) > 1
      ) AS duplicate)::INTEGER AS duplicate_placements
  `;

  const [invalidRevisions] = await sql`
    SELECT
      COUNT(*) FILTER (WHERE scope NOT IN ('content', 'impact', 'team'))::INTEGER AS invalid_scope,
      COUNT(*) FILTER (WHERE revision < 1)::INTEGER AS invalid_revision,
      (3 - COUNT(DISTINCT scope))::INTEGER AS missing_scope
    FROM site_content_revisions
  `;

  const counts = await sql`
    SELECT 'impact_milestones' AS table_name, COUNT(*)::INTEGER AS row_count
    FROM impact_milestones
    UNION ALL
    SELECT 'impact_milestone_settings', COUNT(*)::INTEGER
    FROM impact_milestone_settings
    UNION ALL
    SELECT 'content_overrides', COUNT(*)::INTEGER
    FROM content_overrides
    UNION ALL
    SELECT 'team_people', COUNT(*)::INTEGER
    FROM team_people
    UNION ALL
    SELECT 'team_profiles', COUNT(*)::INTEGER
    FROM team_profiles
    UNION ALL
    SELECT 'site_content_revisions', COUNT(*)::INTEGER
    FROM site_content_revisions
    ORDER BY table_name
  `;

  const migrationTableExists = tables.some(
    (table) => table.table_schema === "public" && table.table_name === "schema_migrations",
  );
  const trackedMigrations = migrationTableExists
    ? await sql`
        SELECT version, name, checksum, applied_at
        FROM public.schema_migrations
        ORDER BY version
      `
    : [];
  const localMigrationFiles = (await readdir(path.join(process.cwd(), "db", "migrations")))
    .filter((fileName) => /^\d+_[a-z0-9_]+\.sql$/i.test(fileName))
    .sort((left, right) => left.localeCompare(right));
  const migrationIssues = [];

  for (const fileName of localMigrationFiles) {
    const version = fileName.split("_", 1)[0];
    const contents = await readFile(
      path.join(process.cwd(), "db", "migrations", fileName),
      "utf8",
    );
    const expectedChecksum = migrationChecksum(contents);
    const tracked = trackedMigrations.find((migration) => migration.version === version);

    if (!tracked) {
      migrationIssues.push(`${fileName}: not tracked`);
    } else if (tracked.name !== fileName || tracked.checksum.trim() !== expectedChecksum) {
      migrationIssues.push(`${fileName}: checksum or name mismatch`);
    }
  }

  for (const tracked of trackedMigrations) {
    if (!localMigrationFiles.includes(tracked.name)) {
      migrationIssues.push(`${tracked.name}: tracked file is missing locally`);
    }
  }

  const tableNames = tables
    .filter((table) => table.table_schema === "public")
    .map((table) => table.table_name);
  const constraintNames = constraints.map((constraint) => constraint.constraint_name);
  const indexNames = indexes.map((index) => index.index_name);
  const missingTables = expectedTables.filter((table) => !tableNames.includes(table));
  const missingConstraints = expectedConstraints.filter(
    (constraint) => !constraintNames.includes(constraint),
  );
  const missingIndexes = expectedIndexes.filter((index) => !indexNames.includes(index));
  const triggerNames = [...new Set(triggers.map((trigger) => trigger.trigger_name))];
  const missingTriggers = expectedTriggers.filter((trigger) => !triggerNames.includes(trigger));
  const incompleteTriggers = expectedTriggers.filter((triggerName) => {
    const events = new Set(
      triggers
        .filter((trigger) => trigger.trigger_name === triggerName)
        .map((trigger) => trigger.event_manipulation),
    );
    return !["INSERT", "UPDATE", "DELETE"].every((event) => events.has(event));
  });
  const functionIssues = [];
  if (!liveRevisionFunction) functionIssues.push("bump_site_content_revision: missing");
  else {
    if (!liveRevisionFunction.security_definer) {
      functionIssues.push("bump_site_content_revision: SECURITY DEFINER is required");
    }
    if (!String(liveRevisionFunction.configuration).includes("search_path=public, pg_temp")) {
      functionIssues.push("bump_site_content_revision: hardened search_path is missing");
    }
    if (liveRevisionFunction.public_can_execute) {
      functionIssues.push("bump_site_content_revision: PUBLIC must not have EXECUTE");
    }
  }
  const invalidCounts = [
    ...Object.values(invalid),
    ...Object.values(invalidContent),
    ...Object.values(invalidTeam),
    ...Object.values(invalidRevisions),
  ].map(Number);
  const disabledRls = rowLevelSecurity
    .filter((table) => !table.enabled)
    .map((table) => table.table_name);
  const healthy =
    missingTables.length === 0 &&
    missingConstraints.length === 0 &&
    missingIndexes.length === 0 &&
    missingTriggers.length === 0 &&
    incompleteTriggers.length === 0 &&
    functionIssues.length === 0 &&
    invalidCounts.every((count) => count === 0) &&
    migrationIssues.length === 0 &&
    disabledRls.length === 0;

  console.log(JSON.stringify({
    connected: true,
    healthy,
    tables,
    rowCounts: counts,
    rowLevelSecurity,
    constraints,
    indexes,
    policies,
    triggers,
    liveRevisionFunction,
    trackedMigrations,
    invalidData: invalid,
    invalidContent,
    invalidTeam,
    invalidRevisions,
    issues: {
      missingTables,
      missingConstraints,
      missingIndexes,
      missingTriggers,
      incompleteTriggers,
      functionIssues,
      disabledRls,
      migrationIssues,
    },
  }, null, 2));

  if (!healthy) process.exitCode = 1;
} catch (error) {
  console.error(JSON.stringify({
    connected: false,
    code: error && error.code ? error.code : "",
    message: error && error.message ? error.message : "Database audit failed",
  }));
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 2 }).catch(() => undefined);
}
