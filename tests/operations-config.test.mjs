import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const read = async (path) => (await readFile(new URL(`../${path}`, import.meta.url), "utf8")).replace(/\r\n?/g, "\n");

describe("production operations configuration", () => {
  it("permits same-origin Academy embedding only on the exact editor route", async () => {
    const { headers: rules } = JSON.parse(await read("vercel.json"));
    expect(rules.map(rule => rule.source)).toEqual(["/(.*)", "/admin/media", "/admin/academy", "/classroom/:lessonId"]);
    const headerMap = rule => Object.fromEntries(rule.headers.map(header => [header.key.toLowerCase(), header.value]));
    const defaults = headerMap(rules[0]);
    expect(defaults["x-frame-options"]).toBe("DENY");
    expect(defaults["content-security-policy"]).toContain("frame-ancestors 'none';");
    const media = headerMap(rules[1]);
    const academy = headerMap(rules[2]);
    expect(Object.keys(academy).sort()).toEqual(["content-security-policy", "x-frame-options"]);
    expect(academy).toEqual(media);
    expect(academy["x-frame-options"]).toBe("SAMEORIGIN");
    expect(academy["content-security-policy"]).toBe(defaults["content-security-policy"].replace("frame-ancestors 'none';", "frame-ancestors 'self';"));
    // The exact-route exception cannot enable framing on other admin or public pages.
    for (const route of ["/", "/academy/courses", "/academy/courses/zh", "/admin", "/admin/academy/other", "/admin/accounts", "/api/auth/signin"]) {
      expect(rules.slice(1).some(rule => rule.source === route)).toBe(false);
    }
  });

  // Vercel applies a later matching rule's header over an earlier one (seen live on /admin/media,
  // 2026-10-30), so only the classroom page gets camera, microphone and screen sharing, for itself
  // and Tencent's classroom frame; every other page keeps them off, and nothing may frame it.
  it("allows camera, microphone and the two classroom vendors only on the classroom page", async () => {
    const { headers: rules } = JSON.parse(await read("vercel.json"));
    const headerMap = rule => Object.fromEntries(rule.headers.map(header => [header.key.toLowerCase(), header.value]));
    const defaults = headerMap(rules[0]);
    expect(defaults["permissions-policy"]).toBe("camera=(), microphone=(), geolocation=(), payment=()");
    const others = rules.slice(0, -1).map(headerMap);
    expect(others.every(rule => !/camera=\(self|tencentclass|zoom\.us/.test(`${rule["permissions-policy"] ?? ""} ${rule["content-security-policy"] ?? ""}`))).toBe(true);
    const classroom = rules.at(-1);
    expect(classroom.source).toBe("/classroom/:lessonId");
    const room = headerMap(classroom);
    expect(Object.keys(room).sort()).toEqual(["content-security-policy", "permissions-policy"]);
    const tencent = '"https://www.tencentclass.com"';
    for (const feature of ["camera", "microphone", "display-capture", "fullscreen", "clipboard-read", "clipboard-write"]) {
      expect(room["permissions-policy"]).toContain(`${feature}=(self ${tencent})`);
    }
    expect(room["permissions-policy"]).toContain("geolocation=(), payment=()");
    const csp = Object.fromEntries(room["content-security-policy"].split("; ").map(part => [part.split(" ")[0], part]));
    expect(csp["frame-ancestors"]).toBe("frame-ancestors 'none'");
    expect(csp["frame-src"]).toBe("frame-src 'self' https://www.tencentclass.com");
    // Zoom's whiteboard loads its script and stylesheet from the account's regional Zoom host (seen in
    // the real trial: https://<region>.zoom.us/web_client_whiteboard/...), so Zoom's own domains are allowed.
    expect(csp["script-src"]).toBe("script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' blob: https://source.zoom.us https://*.zoom.us");
    expect(csp["worker-src"]).toBe("worker-src 'self' blob: https://source.zoom.us https://*.zoom.us");
    expect(csp["style-src"]).toBe("style-src 'self' 'unsafe-inline' https://*.zoom.us");
    expect(csp["font-src"]).toBe("font-src 'self' data: https://*.zoom.us");
    // Joining first calls https://zoom.us/wc/lsdk, which *.zoom.us does not cover (seen with the real package);
    // the whiteboard then fetches blob: addresses the page made itself (seen in the real trial).
    expect(csp["connect-src"]).toBe("connect-src 'self' blob: https://zoom.us https://*.zoom.us wss://*.zoom.us");
    expect(csp["media-src"]).toBe("media-src 'self' blob: mediastream:");
  });

  it("does not bypass current-data page routes with legacy static HTML rewrites", async () => {
    const vercel = JSON.parse(await read("vercel.json"));
    expect((vercel.rewrites || []).filter(rule => /\.html(?:$|\?)/.test(rule.destination))).toEqual([]);
    const nextConfig = (await import("../next.config.mjs")).default;
    // Course pages are request-time routes that read the published Academy
    // content; no rewrite may serve their template HTML directly.
    expect(nextConfig.rewrites ? await nextConfig.rewrites() : []).toEqual([]);
    expect(nextConfig.outputFileTracingIncludes["/academy/courses"]).toEqual(["./.private/academy/index.html"]);
    expect(nextConfig.outputFileTracingIncludes["/academy/courses/zh"]).toEqual(["./.private/academy/zh/index.html"]);
    expect(nextConfig.outputFileTracingIncludes["/api/academy-content/preview"]).toEqual(["./.private/academy/index.html", "./.private/academy/zh/index.html"]);
    const redirects = await nextConfig.redirects();
    expect(redirects).toContainEqual({ source: "/about.html", destination: "/about", permanent: true });
    expect(redirects).toContainEqual({ source: "/academy/en", destination: "/academy/courses?entry=official", permanent: false });
    expect(redirects).toContainEqual({ source: "/academy/courses/index.html", destination: "/academy/courses?entry=official", permanent: true });
    expect(redirects).toContainEqual({ source: "/academy/courses/zh/index.html", destination: "/academy/courses/zh?entry=official", permanent: true });
    expect(redirects.some(rule => rule.source === "/academy/courses" || rule.source === "/academy/courses/zh")).toBe(false);
  });
  it("makes the database audit look up every table it expects", async () => {
    const audit = await read("scripts/audit-database.mjs");
    const query = audit.match(/const tables = await sql`([\s\S]*?)`;/)?.[1] ?? "";
    // A second, hand-kept list once left out resource_links, so the audit could never report healthy.
    expect(query).toContain("table_name IN ${sql(expectedTables)}");
    expect(audit.match(/const expectedTables = \[([\s\S]*?)\];/)?.[1]).toContain('"resource_links"');
  });

  it("audits each image's widths against the ones the site generates for its slot", async () => {
    const audit = await read("scripts/audit-database.mjs");
    const storage = await read("lib/site-media-storage.ts");
    // Team avatars are stored at 480 and 800 only; requiring three variants once flagged every one of them.
    expect(storage).toContain('return slot.startsWith("team.") && slot.endsWith(".avatar")\n    ? [480, 800]\n    : [480, 800, 1200];');
    expect(audit).toContain("WHEN starts_with(asset.slot, 'team.') AND right(asset.slot, 7) = '.avatar' THEN ARRAY[480, 800]");
    expect(audit).toContain("ELSE ARRAY[480, 800, 1200]");
    expect(audit).not.toContain("WHERE variant.slot = asset.slot) <> 3");
  });

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
    expect(verifier).toContain("[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]");
    expect(backup).toContain("resource_links: resourceLinks");
    expect(verifier).toContain('required.push("resource_links")');
    expect(restoreVerifier).toContain("INSERT INTO resource_links");
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
    expect(packageJson).toContain('"@img/sharp-libvips-linux-x64": "1.3.4"');
    expect(packageJson).toContain('"@img/sharp-linux-x64": "0.35.5"');
    expect(packageJson).toContain('"@img/sharp-wasm32": "0.35.5"');
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

  // D1 (2026-11-07): migration 028's nine classroom tables in every backup, restore and audit path,
  // checked only once 028 is recorded; the daily backup's classroom part stays off until iHear
  // confirms encryption, access and retention (H8). Run for real in tests/classroom-postgres.test.mjs.
  it("keeps the classroom tables recoverable once 028 is applied, with the daily part off until H8", async () => {
    const tables = await read("scripts/classroom-backup-tables.mjs");
    const backup = await read("scripts/backup-database.mjs");
    const verifier = await read("scripts/verify-backup-file.mjs");
    const restore = await read("scripts/verify-backup.mjs");
    const audit = await read("scripts/audit-database.mjs");
    const drill = await read(".github/workflows/monthly-restore-drill.yml");
    const daily = await read(".github/workflows/daily-application-backup.yml");
    const migration = await read("db/migrations/028_classroom_mvp.sql");
    const names = ["classroom_lessons", "classroom_participants", "classroom_consents", "classroom_staff_notices", "classroom_join_tokens",
      "classroom_events", "classroom_jobs", "classroom_recording_files", "classroom_anomalies"];
    for (const name of names) {
      expect(migration).toContain(`CREATE TABLE IF NOT EXISTS public.${name} (`);
      expect(migration).toContain(`ALTER TABLE public.${name} ENABLE ROW LEVEL SECURITY;`);
      expect(tables).toContain(`name: "${name}"`);
      expect(drill).toContain(`to_regclass('public.${name}')`);
    }
    for (const script of [backup, verifier, restore, audit]) expect(script).toContain('from "./classroom-backup-tables.mjs"');
    expect(backup).toContain('process.env.BACKUP_INCLUDE_CLASSROOM === "1"');
    expect(daily).not.toContain("BACKUP_INCLUDE_CLASSROOM");
    expect(verifier).toContain("validateClassroomBackup(tables)");
    expect(verifier).toContain('backup.payload.version >= 11 ? "028"');
    expect(restore).toContain("validateClassroomBackup(tables)");
    expect(audit).toContain('migration.version === CLASSROOM_MIGRATION');
    expect(drill).toContain("WHERE version = '028'");
    expect(drill).toContain("Row level security is off on a restored classroom table");
    expect(drill).toContain("restored_classroom_row_counts");
  });

  // H8 is not confirmed by iHear (2026-11-07). Option 乙 (leave the classroom rows out of the full
  // dumps) is researched only, in the PostgreSQL tests; the schedules stay as they are, so applying
  // 028 on the live database stays blocked. Changing this test is part of that separate approval.
  it("leaves the weekly and monthly full dumps unchanged until iHear confirms H8, so 028 stays blocked", async () => {
    for (const file of [".github/workflows/weekly-postgres-backup.yml", ".github/workflows/monthly-restore-drill.yml"]) {
      const dumps = (await read(file)).split(/\r?\n/).filter(line => line.includes("pg_dump"));
      expect(dumps, file).toHaveLength(1);
      expect(dumps[0], file).toContain("--schema=public --exclude-table-data=public.api_rate_limits");
      expect(dumps[0], file).not.toMatch(/classroom/);
    }
    expect(await read(".github/workflows/daily-application-backup.yml")).not.toContain("BACKUP_INCLUDE_CLASSROOM");
  });
});
