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

  it("scrubs sensitive request and user fields before Sentry sends events", async () => {
    const config = await read("sentry.server.config.ts");
    for (const field of [
      "event.user.email",
      "event.user.ip_address",
      "event.request.cookies",
      "event.request.query_string",
      "event.request.headers.authorization",
      "event.request.headers.cookie",
    ]) {
      expect(config).toContain(`delete ${field}`);
    }
    expect(config).toContain("sendDefaultPii: false");
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
  });
});
