import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const read = async (path) => (await readFile(new URL(`../${path}`, import.meta.url), "utf8")).replace(/\r\n?/g, "\n");

describe("production operations configuration", () => {
  it("keeps health checks uncached and responses free of database details", async () => {
    const route = await read("app/api/health/route.ts");
    expect(route).toContain('"Vercel-CDN-Cache-Control": "no-store"');
    expect(route).toContain('"Cache-Control": "private, no-store, max-age=0"');
    expect(route).not.toContain("databaseUrl");
    expect(route).not.toContain("POSTGRES_URL");
  });

  it("uses Vercel logs without requiring a paid error-monitoring SDK", async () => {
    const packageJson = await read("package.json");
    const runbook = await read("docs/operations.md");
    expect(packageJson).not.toContain("@sentry/nextjs");
    expect(runbook).toContain("Vercel Runtime Logs");
    expect(runbook).not.toContain("SENTRY_DSN");
  });

  it("uploads only encrypted daily and weekly backup payloads", async () => {
    for (const workflowPath of [
      ".github/workflows/daily-application-backup.yml",
      ".github/workflows/weekly-postgres-backup.yml",
    ]) {
      const workflow = await read(workflowPath);
      expect(workflow).toContain("permissions:\n  contents: read");
      expect(workflow).toContain("openssl enc -aes-256-cbc");
      expect(workflow).toMatch(/path: \|\r?\n\s+[^\n]*\*\.enc\r?\n\s+[^\n]*SHA256SUMS/);
      expect(workflow).not.toMatch(/path: \|[\s\S]{0,160}\.(json|dump)(?:\r?\n|$)/);
    }
  });

  it("pins the backup installer to the Node and npm versions used by the lockfile", async () => {
    const workflow = await read(".github/workflows/daily-application-backup.yml");
    expect(workflow).toContain("actions/checkout@v7");
    expect(workflow).toContain("actions/setup-node@v7");
    expect(workflow).toContain("node-version: 24.11.1");
    expect(workflow).toContain("npm install --global npm@11.6.2");
    expect(workflow).toContain("actions/upload-artifact@v7");
  });

  it("keeps routine backup reads separate from restore writes", async () => {
    const daily = await read(".github/workflows/daily-application-backup.yml");
    const weekly = await read(".github/workflows/weekly-postgres-backup.yml");
    const drill = await read(".github/workflows/monthly-restore-drill.yml");

    expect(daily).toContain("npm run db:verify-backup-file");
    expect(daily).not.toContain("npm run db:verify-backup\n");
    expect(weekly).toContain("pg_dump");
    expect(drill).toContain("pg_restore --host=127.0.0.1 --port=55432");
    expect(drill).toContain("--clean --if-exists --exit-on-error");
    expect(drill).not.toMatch(/pg_restore[^\n]*BACKUP_DATABASE_URL/);
    expect(drill).toContain("services:\n      restore-postgres:");
    expect(weekly).toContain("retention-days: 90");
    expect(drill).toContain("retention-days: 90");
  });

  it("monitors Production externally and manages a single recoverable incident", async () => {
    const workflow = await read(".github/workflows/production-uptime.yml");
    expect(workflow).toContain('cron: "17 * * * *"');
    expect(workflow).toContain("https://www.ihearus.org/api/health");
    expect(workflow).toContain("https://www.ihearus.org/");
    expect(workflow).toContain("issues: write");
    expect(workflow).toContain("for attempt in 1 2 3");
    expect(workflow).toContain('gh issue create --title "Production uptime alert"');
    expect(workflow).toContain('gh issue close "$issue_number" --reason completed');
  });

  it("keeps Hero media recoverable and deploys its self-hosted compressor", async () => {
    const backup = await read("scripts/backup-database.mjs");
    const verifier = await read("scripts/verify-backup-file.mjs");
    const restoreVerifier = await read("scripts/verify-backup.mjs");
    const drill = await read(".github/workflows/monthly-restore-drill.yml");
    const migration = await read("db/migrations/011_site_media_assets.sql");
    const publicBuild = await read("scripts/prepare-public.mjs");
    const ci = await read(".github/workflows/ci.yml");
    const mediaApi = await read("lib/site-media-api.ts");
    const nextConfig = await read("next.config.mjs");
    const packageJson = await read("package.json");

    expect(backup).toContain("site_media_assets: siteMediaAssets");
    expect(backup).toContain("site_media_variants: siteMediaVariants");
    expect(verifier).toContain("[1, 2, 3, 4, 5, 6, 7, 8, 9]");
    expect(verifier).toContain('backup.payload.version >= 4 ? "011"');
    expect(restoreVerifier).toContain("site_media_assets: siteMediaAssets.length");
    expect(restoreVerifier).toContain("INSERT INTO site_media_variants");
    expect(drill).toContain("to_regclass('public.site_media_assets')");
    expect(drill).toContain("version = '011'");
    expect(migration).toContain("ENABLE ROW LEVEL SECURITY");
    expect(migration).toContain("site_media_assets_live_revision");
    expect(publicBuild).toContain('"browser-image-compression.js"');
    expect(publicBuild).toContain('"selfie_segmentation.tflite"');
    expect(publicBuild).toContain("avatar-background-removal.js");
    expect(ci).toContain("Verify sharp on Linux");
    expect(ci).toContain(".webp().toBuffer()");
    expect(ci).toContain("test -s public/assets/vendor/browser-image-compression.js");
    expect(ci).toContain("test -s public/assets/vendor/avatar-segmentation/selfie_segmentation.tflite");
    expect(mediaApi).toContain('from "./site-media-errors"');
    expect(mediaApi).not.toContain('from "./site-media-image"');
    expect(nextConfig).toContain('"/api/site-media/[slot]": ["./node_modules/@img/**/*"]');
    expect(packageJson).toContain('"@img/sharp-libvips-linux-x64": "1.3.2"');
    expect(packageJson).toContain('"@img/sharp-linux-x64": "0.35.3"');
    expect(packageJson).toContain('"@img/sharp-wasm32": "0.35.3"');
  });

  it("keeps the site theme accessible, recoverable, and flash-free on every page", async () => {
    const migration = await read("db/migrations/012_site_theme.sql");
    const backup = await read("scripts/backup-database.mjs");
    const verifier = await read("scripts/verify-backup-file.mjs");
    const restore = await read("scripts/verify-backup.mjs");
    const audit = await read("scripts/audit-database.mjs");
    const build = await read("scripts/prepare-public.mjs");
    const layout = await read("app/layout.tsx");
    const headers = await read("vercel.json");
    const workflow = await read(".github/workflows/monthly-restore-drill.yml");

    expect(migration).toContain("CREATE TABLE IF NOT EXISTS public.site_settings");
    expect(migration).toContain("site_settings_theme_allowed");
    expect(migration).toContain("site_settings_live_revision");
    expect(backup).toContain("site_settings: siteSettings");
    expect(verifier).toContain('backup.payload.version >= 5 ? "012"');
    expect(restore).toContain("INSERT INTO site_settings");
    expect(audit).toContain('"site_settings_live_revision"');
    expect(audit).toContain("('content', 'impact', 'team', 'theme', 'layout')");
    expect(workflow).toContain("version = '012'");
    expect(workflow).toContain("site_settings");
    expect(build).toContain("verifyThemeBuild");
    expect(build).toContain("Prepared ${htmlFiles.length} HTML pages");
    expect(layout).toContain('data-theme="warm"');
    expect(layout).toContain('src="/api/site-theme/bootstrap"');
    expect(headers).toContain("form-action 'self' https://accounts.google.com;");
    expect(headers).toContain("script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' blob:");
  });

  it("keeps semantic content and controlled layout configuration recoverable and flash-free", async () => {
    const seed = await read("db/migrations/013_content_slots_seed.sql");
    const migration = await read("db/migrations/014_site_layout_configs.sql");
    const backup = await read("scripts/backup-database.mjs");
    const verifier = await read("scripts/verify-backup-file.mjs");
    const restore = await read("scripts/verify-backup.mjs");
    const audit = await read("scripts/audit-database.mjs");
    const build = await read("scripts/prepare-public.mjs");
    const workflow = await read(".github/workflows/monthly-restore-drill.yml");

    expect(seed).toContain("localized_content_overrides");
    expect(seed).toContain("ON CONFLICT (page,key,locale) DO NOTHING");
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS public.site_layout_configs");
    expect(migration).toContain("site_layout_configs_live_revision");
    expect(backup).toContain("site_layout_configs: siteLayoutConfigs");
    expect(verifier).toContain('backup.payload.version >= 6 ? "014"');
    expect(restore).toContain("INSERT INTO site_layout_configs");
    expect(audit).toContain('"site_layout_configs_live_revision"');
    expect(workflow).toContain("version = '014'");
    expect(build).toContain("layoutBootstrapScript");
    expect(build).toContain("content-slots.json");
  });

  it("keeps the admin console server-owned, recoverable, and auditable", async () => {
    const migration = await read("db/migrations/015_admin_console.sql");
    const backup = await read("scripts/backup-database.mjs");
    const verifier = await read("scripts/verify-backup-file.mjs");
    const restore = await read("scripts/verify-backup.mjs");
    const audit = await read("scripts/audit-database.mjs");

    expect(migration).toContain("CREATE TABLE IF NOT EXISTS public.admin_accounts");
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS public.admin_activity_log");
    expect(migration).toContain("deleted_at TIMESTAMPTZ");
    expect(migration).toContain("archived_from_status TEXT");
    expect(backup).toContain("admin_accounts: adminAccounts");
    expect(backup).toContain("admin_activity_log: adminActivityLog");
    expect(verifier).toContain('backup.payload.version >= 7 ? "015"');
    expect(restore).toContain("INSERT INTO admin_accounts");
    expect(restore).toContain("INSERT INTO admin_activity_log");
    expect(audit).toContain('"admin_accounts"');
    expect(audit).toContain('"admin_activity_log"');
  });

  it("keeps translation provenance migrated, private, backed up, and auditable", async () => {
    const migration = await read("db/migrations/017_translation_workflow.sql");
    const backup = await read("scripts/backup-database.mjs");
    const verifier = await read("scripts/verify-backup-file.mjs");
    const restore = await read("scripts/verify-backup.mjs");
    const audit = await read("scripts/audit-database.mjs");

    expect(migration).toContain("CREATE TABLE IF NOT EXISTS public.localized_translation_states");
    expect(migration).toContain("protected_legacy");
    expect(migration).toContain("ENABLE ROW LEVEL SECURITY");
    expect(backup).toContain("localized_translation_states: localizedTranslationStates");
    expect(verifier).toContain('backup.payload.version >= 8 ? "017"');
    expect(restore).toContain("INSERT INTO localized_translation_states");
    expect(audit).toContain('"localized_translation_states"');
  });

  it("uses short-lived local ADC and never configures a service-account private key", async () => {
    const core = await read("lib/translation-core.ts");
    const configure = await read("scripts/configure-google-translation.mjs");
    const example = await read(".env.example");
    expect(core).toContain('mode: "local-adc"');
    expect(core).toContain("Long-lived Google service-account keys are not supported");
    expect(configure).toContain("--impersonate-service-account=");
    expect(configure).toContain("--account=");
    expect(configure).toContain("GOOGLE_CLOUD_LOCAL_ADC");
    expect(configure).not.toContain("credential.private_key");
    expect(example).toContain("GOOGLE_CLOUD_LOCAL_ADC=");
    expect(example).not.toContain("GOOGLE_CLOUD_PRIVATE_KEY=");
  });
});
