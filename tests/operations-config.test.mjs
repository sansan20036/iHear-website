import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

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
});
