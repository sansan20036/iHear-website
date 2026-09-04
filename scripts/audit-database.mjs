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
  "api_rate_limits",
  "admin_accounts",
  "admin_activity_log",
  "content_overrides",
  "localized_content_overrides",
  "localized_translation_states",
  "impact_milestone_settings",
  "impact_milestones",
  "schema_migrations",
  "site_content_revisions",
  "site_media_assets",
  "site_media_variants",
  "site_settings",
  "site_layout_configs",
  "team_people",
  "team_profiles",
];

const expectedConstraints = [
  "admin_accounts_actor_length",
  "admin_accounts_email_format",
  "admin_accounts_pkey",
  "admin_accounts_role_allowed",
  "admin_accounts_timestamp_order",
  "admin_accounts_version_positive",
  "admin_activity_log_actor_length",
  "admin_activity_log_changed_fields_bounded",
  "admin_activity_log_entity_id_check",
  "admin_activity_log_entity_type_check",
  "admin_activity_log_action_check",
  "admin_activity_log_actor_role_check",
  "admin_activity_log_pkey",
  "admin_activity_log_version_positive",
  "api_rate_limits_bucket_key_format",
  "api_rate_limits_pkey",
  "api_rate_limits_request_count_positive",
  "api_rate_limits_timestamp_order",
  "content_overrides_page_path",
  "content_overrides_pkey",
  "localized_content_overrides_pkey",
  "localized_translation_states_resource_type_check",
  "localized_translation_states_resource_scope_check",
  "localized_translation_states_resource_id_check",
  "localized_translation_states_field_key_check",
  "localized_translation_states_locale_check",
  "localized_translation_states_source_hash_check",
  "localized_translation_states_origin_check",
  "localized_translation_states_glossary_version_check",
  "localized_translation_states_updated_by_check",
  "localized_translation_states_pkey",
  "impact_milestones_actor_length",
  "impact_milestones_archive_state",
  "impact_milestones_archived_actor_state",
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
  "site_media_assets_actor_length",
  "site_media_assets_alt_length",
  "site_media_assets_focal_grid",
  "site_media_assets_pkey",
  "site_media_assets_slot_length",
  "site_media_assets_timestamp_order",
  "site_media_assets_version_positive",
  "site_media_variants_byte_size_range",
  "site_media_variants_dimensions_positive",
  "site_media_variants_mime_webp",
  "site_media_variants_pkey",
  "site_media_variants_public_url_https",
  "site_media_variants_slot_fkey",
  "site_media_variants_storage_path_length",
  "site_media_variants_storage_path_unique",
  "site_media_variants_width_allowed",
  "site_settings_actor_length",
  "site_settings_key_length",
  "site_settings_pkey",
  "site_settings_theme_allowed",
  "site_settings_value_length",
  "site_settings_version_positive",
  "site_layout_configs_actor_length",
  "site_layout_configs_object",
  "site_layout_configs_page_path",
  "site_layout_configs_pkey",
  "site_layout_configs_version_positive",
  "team_people_consent_pair",
  "team_people_pkey",
  "team_people_timestamp_order",
  "team_profiles_person_section_unique",
  "team_profiles_pkey",
  "team_profiles_public_visibility",
  "team_profiles_published_english",
  "team_profiles_timestamp_order",
  "team_profiles_deleted_state",
];

const expectedIndexes = [
  "admin_accounts_enabled_idx",
  "admin_activity_log_created_at_idx",
  "admin_activity_log_entity_idx",
  "api_rate_limits_updated_at_idx",
  "impact_milestones_unique_published_metrics_period",
  "localized_content_overrides_updated_at_idx",
  "localized_translation_states_updated_at_idx",
  "site_media_assets_updated_at_idx",
  "site_settings_updated_at_idx",
  "site_layout_configs_updated_at_idx",
  "team_profiles_public_order_idx",
  "team_profiles_deleted_at_idx",
];

const expectedTriggers = [
  "content_overrides_live_revision",
  "localized_content_overrides_live_revision",
  "impact_milestone_settings_live_revision",
  "impact_milestones_live_revision",
  "site_media_assets_live_revision",
  "site_settings_live_revision",
  "site_layout_configs_live_revision",
  "team_profiles_live_revision",
];

try {
  const tables = await sql`
    SELECT table_schema, table_name
    FROM information_schema.tables
    WHERE
      (table_schema = 'public' AND table_name IN (
        'api_rate_limits',
        'admin_accounts',
        'admin_activity_log',
        'impact_milestones',
        'impact_milestone_settings',
        'content_overrides',
        'localized_content_overrides',
        'localized_translation_states',
        'schema_migrations',
        'site_content_revisions',
        'site_media_assets',
        'site_media_variants',
        'site_settings',
        'site_layout_configs',
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
      AND relation.relname IN ('api_rate_limits', 'admin_accounts', 'admin_activity_log', 'impact_milestones', 'content_overrides', 'localized_content_overrides', 'localized_translation_states', 'site_content_revisions', 'site_media_assets', 'site_media_variants', 'site_settings', 'site_layout_configs', 'team_people', 'team_profiles')
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
      AND relation.relname IN ('api_rate_limits', 'admin_accounts', 'admin_activity_log', 'impact_milestones', 'localized_content_overrides', 'localized_translation_states', 'site_media_assets', 'site_media_variants', 'site_settings', 'site_layout_configs', 'team_people', 'team_profiles')
    ORDER BY index_relation.relname
  `;

  const policies = await sql`
    SELECT schemaname, tablename, policyname, roles, cmd
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename IN ('api_rate_limits', 'admin_accounts', 'admin_activity_log', 'impact_milestones', 'content_overrides', 'localized_content_overrides', 'localized_translation_states', 'site_content_revisions', 'site_media_assets', 'site_media_variants', 'site_settings', 'site_layout_configs', 'team_people', 'team_profiles')
    ORDER BY tablename, policyname
  `;

  const rowLevelSecurity = await sql`
    SELECT relation.relname AS table_name, relation.relrowsecurity AS enabled
    FROM pg_class AS relation
    JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = 'public'
      AND relation.relname IN (
        'api_rate_limits',
        'admin_accounts',
        'admin_activity_log',
        'impact_milestones',
        'impact_milestone_settings',
        'content_overrides',
        'localized_content_overrides',
        'localized_translation_states',
        'schema_migrations',
        'site_content_revisions',
        'site_media_assets',
        'site_media_variants',
        'site_settings',
        'site_layout_configs',
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

  const [invalidLocalizedContent] = await sql`
    SELECT
      COUNT(*) FILTER (WHERE left(page, 1) <> '/')::INTEGER AS invalid_page_path,
      COUNT(*) FILTER (WHERE locale NOT IN ('en', 'zhHant', 'zhHans'))::INTEGER AS invalid_locale,
      COUNT(*) FILTER (
        WHERE char_length(page) NOT BETWEEN 1 AND 500
          OR char_length(key) NOT BETWEEN 1 AND 5000
          OR char_length(value) > 5000
          OR char_length(updated_by) NOT BETWEEN 1 AND 320
      )::INTEGER AS invalid_content_length
    FROM localized_content_overrides
  `;

  const triggers = await sql`
    SELECT event_object_table AS table_name, trigger_name, action_timing, event_manipulation
    FROM information_schema.triggers
    WHERE trigger_schema = 'public'
      AND trigger_name IN (
        'content_overrides_live_revision',
        'localized_content_overrides_live_revision',
        'impact_milestone_settings_live_revision',
        'impact_milestones_live_revision',
        'site_media_assets_live_revision',
        'site_settings_live_revision',
        'site_layout_configs_live_revision',
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
      COUNT(*) FILTER (WHERE scope NOT IN ('content', 'impact', 'team', 'theme', 'layout'))::INTEGER AS invalid_scope,
      COUNT(*) FILTER (WHERE revision < 1)::INTEGER AS invalid_revision,
      (5 - COUNT(DISTINCT scope))::INTEGER AS missing_scope
    FROM site_content_revisions
  `;

  const [invalidRateLimits] = await sql`
    SELECT
      COUNT(*) FILTER (
        WHERE bucket_key !~ '^[0-9a-f]{64}$'
      )::INTEGER AS invalid_bucket_key,
      COUNT(*) FILTER (
        WHERE request_count < 1
      )::INTEGER AS invalid_request_count,
      COUNT(*) FILTER (
        WHERE updated_at < window_started_at
      )::INTEGER AS invalid_timestamp_order
    FROM api_rate_limits
  `;

  const [invalidSiteMedia] = await sql`
    SELECT
      (SELECT COUNT(*) FROM site_media_assets
        WHERE char_length(slot) NOT BETWEEN 1 AND 100
          OR char_length(alt_en) NOT BETWEEN 2 AND 300
          OR char_length(alt_zh_hant) NOT BETWEEN 2 AND 300
          OR char_length(alt_zh_hans) NOT BETWEEN 2 AND 300
          OR focal_x NOT IN (0, 50, 100)
          OR focal_y NOT IN (0, 50, 100)
          OR record_version < 1
          OR char_length(created_by) NOT BETWEEN 1 AND 320
          OR char_length(updated_by) NOT BETWEEN 1 AND 320
          OR updated_at < created_at
      )::INTEGER AS invalid_assets,
      (SELECT COUNT(*) FROM site_media_variants
        WHERE width NOT IN (480, 800, 1200)
          OR pixel_width < 1
          OR pixel_height < 1
          OR byte_size NOT BETWEEN 1 AND 1048576
          OR mime_type <> 'image/webp'
          OR public_url NOT LIKE 'https://%'
          OR char_length(storage_path) NOT BETWEEN 1 AND 500
      )::INTEGER AS invalid_variants,
      (SELECT COUNT(*) FROM site_media_assets AS asset
        WHERE (SELECT COUNT(*) FROM site_media_variants AS variant WHERE variant.slot = asset.slot) <> 3
      )::INTEGER AS incomplete_variant_sets
  `;

  const [invalidSiteSettings] = await sql`
    SELECT
      COUNT(*) FILTER (
        WHERE char_length(key) NOT BETWEEN 1 AND 100
          OR char_length(value) NOT BETWEEN 1 AND 500
          OR record_version < 1
          OR char_length(updated_by) NOT BETWEEN 1 AND 320
      )::INTEGER AS invalid_fields,
      COUNT(*) FILTER (
        WHERE key = 'site_theme' AND value NOT IN ('warm', 'ocean', 'sage', 'lavender', 'slate')
      )::INTEGER AS invalid_theme,
      (1 - COUNT(*) FILTER (WHERE key = 'site_theme'))::INTEGER AS missing_theme
    FROM site_settings
  `;

  const counts = await sql`
    SELECT 'api_rate_limits' AS table_name, COUNT(*)::INTEGER AS row_count
    FROM api_rate_limits
    UNION ALL
    SELECT 'admin_accounts', COUNT(*)::INTEGER
    FROM admin_accounts
    UNION ALL
    SELECT 'admin_activity_log', COUNT(*)::INTEGER
    FROM admin_activity_log
    UNION ALL
    SELECT 'impact_milestones', COUNT(*)::INTEGER
    FROM impact_milestones
    UNION ALL
    SELECT 'impact_milestone_settings', COUNT(*)::INTEGER
    FROM impact_milestone_settings
    UNION ALL
    SELECT 'content_overrides', COUNT(*)::INTEGER
    FROM content_overrides
    UNION ALL
    SELECT 'localized_content_overrides', COUNT(*)::INTEGER
    FROM localized_content_overrides
    UNION ALL
    SELECT 'localized_translation_states', COUNT(*)::INTEGER
    FROM localized_translation_states
    UNION ALL
    SELECT 'team_people', COUNT(*)::INTEGER
    FROM team_people
    UNION ALL
    SELECT 'team_profiles', COUNT(*)::INTEGER
    FROM team_profiles
    UNION ALL
    SELECT 'site_content_revisions', COUNT(*)::INTEGER
    FROM site_content_revisions
    UNION ALL
    SELECT 'site_media_assets', COUNT(*)::INTEGER
    FROM site_media_assets
    UNION ALL
    SELECT 'site_media_variants', COUNT(*)::INTEGER
    FROM site_media_variants
    UNION ALL
    SELECT 'site_settings', COUNT(*)::INTEGER
    FROM site_settings
    UNION ALL
    SELECT 'site_layout_configs', COUNT(*)::INTEGER
    FROM site_layout_configs
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
    ...Object.values(invalidLocalizedContent),
    ...Object.values(invalidTeam),
    ...Object.values(invalidRevisions),
    ...Object.values(invalidRateLimits),
    ...Object.values(invalidSiteMedia),
    ...Object.values(invalidSiteSettings),
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
    invalidLocalizedContent,
    invalidTeam,
    invalidRevisions,
    invalidRateLimits,
    invalidSiteMedia,
    invalidSiteSettings,
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
