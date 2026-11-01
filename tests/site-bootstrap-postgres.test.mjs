import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import postgres from "postgres";

// Public pages read the theme and layout themselves now. A localhost-only disposable PostgreSQL,
// as in home-calendar-postgres.test.mjs: it never loads .env, uses an inherited database URL, or
// connects to a hosted database. The site metrics are not part of this check.
vi.mock("../lib/impact-store", () => ({ getCurrentSiteMetrics: vi.fn(async () => null) }));

const container = `ihear-site-bootstrap-${randomUUID()}`;
const password = "isolated-site-bootstrap-test-only";
const docker = (args) => execFileSync("docker", args, { encoding: "utf8", windowsHide: true, timeout: 60000, stdio: ["pipe", "pipe", "pipe"] }).trim();
let started = false, port, workspace, sql, modules;
const databaseUrl = (database) => `postgres://postgres:${password}@127.0.0.1:${port}/${database}`;
const template = `<!DOCTYPE html>
<html data-theme="warm" lang="en">
<head>
<script data-site-theme-init>/* init */</script>
<script src="/api/site-theme/bootstrap" data-site-theme-bootstrap></script>
<script src="/api/site-layout/bootstrap?page=%2F" data-site-layout-bootstrap></script>
<meta charset="UTF-8">
<title>iHear</title>
<link rel="stylesheet" href="/assets/site.css?v=1">
</head>
<body><section data-layout-section="home.video"><p>Video</p></section></body>
</html>
`;
async function render() {
  const cwd = vi.spyOn(process, "cwd").mockReturnValue(workspace);
  try { return await modules.page.servePublicPage(new Request("https://example.com/"), "/"); } finally { cwd.mockRestore(); }
}
const inline = (html, name) => new RegExp(`<script data-site-${name}-bootstrap>([\\s\\S]*?)</script>`).exec(html)?.[1];

beforeAll(async () => {
  docker(["run", "--detach", "--pull=never", "--name", container, "--label", "ihear-test=site-bootstrap", "-p", "127.0.0.1::5432", "-e", `POSTGRES_PASSWORD=${password}`, "postgres:17-alpine"]);
  started = true;
  port = docker(["port", container, "5432/tcp"]).match(/^127\.0\.0\.1:(\d+)$/)?.[1];
  if (!port) throw new Error("Expected a localhost-only PostgreSQL port");
  const root = postgres(databaseUrl("postgres"), { ssl: false, max: 1, prepare: false, connect_timeout: 2, onnotice: () => {} });
  let ready = false;
  for (let attempt = 0; attempt < 60 && !ready; attempt++) {
    try { await root`SELECT 1`; ready = true; } catch { await new Promise((resolve) => { setTimeout(resolve, 300); }); }
  }
  if (!ready) throw new Error("Disposable PostgreSQL did not become ready");
  await root.unsafe("CREATE DATABASE production_like");
  await root.end({ timeout: 2 });
  // Every migration, run from a folder that holds nothing else, so no .env can be loaded.
  workspace = await mkdtemp(path.join(os.tmpdir(), "ihear-site-bootstrap-"));
  await mkdir(path.join(workspace, "db", "migrations"), { recursive: true });
  for (const file of (await readdir("db/migrations")).filter((name) => /^\d+_[a-z0-9_]+\.sql$/i.test(name))) {
    await copyFile(path.join("db", "migrations", file), path.join(workspace, "db", "migrations", file));
  }
  const result = spawnSync(process.execPath, [path.resolve("scripts/migrate-database.mjs")], {
    cwd: workspace, encoding: "utf8", windowsHide: true, timeout: 120000,
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: os.tmpdir(), TMP: os.tmpdir(), POSTGRES_URL: databaseUrl("production_like"), DATABASE_URL: "", POSTGRES_SSL: "disable" },
  });
  if (result.status !== 0) throw new Error(`Migration runner failed: ${result.stderr}`);
  await mkdir(path.join(workspace, ".private"));
  await writeFile(path.join(workspace, ".private", "index.html"), template);
  sql = postgres(databaseUrl("production_like"), { ssl: false, max: 2, prepare: false, connect_timeout: 2, onnotice: () => {} });
  vi.stubEnv("POSTGRES_URL", databaseUrl("production_like"));
  vi.stubEnv("DATABASE_URL", "");
  vi.stubEnv("POSTGRES_SSL", "disable");
  vi.stubEnv("IHEAR_FORCE_FILE_STORE", "");
  vi.resetModules();
  modules = {
    page: await import("../lib/public-page"),
    bootstrap: await import("../lib/site-bootstrap"),
    theme: await import("../lib/site-theme-store"),
    layout: await import("../lib/site-layout"),
    themeRoute: await import("../app/api/site-theme/bootstrap/route"),
    layoutRoute: await import("../app/api/site-layout/bootstrap/route"),
  };
}, 180000);

afterAll(async () => {
  for (const name of ["ihearSiteThemeSql", "ihearLayoutSql", "ihearContentSql"]) await globalThis[name]?.end({ timeout: 2 });
  await sql?.end({ timeout: 2 });
  vi.unstubAllEnvs();
  if (started) docker(["rm", "--force", "--volumes", container]);
  if (workspace && (await realpath(workspace)).startsWith(await realpath(os.tmpdir()))) await rm(workspace, { recursive: true, force: true });
}, 30000);

describe("public pages carry the stored theme and layout (disposable PostgreSQL)", { timeout: 60_000 }, () => {
  test("the inline scripts hold the saved theme and layout, as the routes do, and no editor", async () => {
    await modules.theme.updateSiteTheme({ theme: "lavender", expectedVersion: 1, updatedBy: "owner@example.com" });
    await modules.layout.updateSiteLayout("/", { hiddenSections: ["home.video"], orders: {}, links: {} }, 1, "owner@example.com");
    const response = await render();
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).not.toContain('src="/api/site-theme/bootstrap"');
    expect(html).not.toContain('src="/api/site-layout/bootstrap');
    expect(inline(html, "theme")).toContain('"theme":"lavender","recordVersion":2');
    expect(inline(html, "layout")).toContain('"hiddenSections":["home.video"]');
    expect(inline(html, "theme")).toBe(await (await modules.themeRoute.GET()).text());
    expect(inline(html, "layout")).toBe(await (await modules.layoutRoute.GET(new Request("https://example.com/api/site-layout/bootstrap?page=%2F"))).text());
    expect(html).not.toContain("owner@example.com");
    expect(html).not.toContain("migration-012");
  });

  test("without the theme row or the layout table the page still renders, with the routes' fallbacks", async () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    await sql`DELETE FROM public.site_settings WHERE key = 'site_theme'`;
    await sql`ALTER TABLE public.site_layout_configs RENAME TO site_layout_configs_moved`;
    try {
      const response = await render();
      const html = await response.text();
      expect(response.status).toBe(200);
      expect(inline(html, "theme")).toBe(modules.bootstrap.themeFallbackScript());
      expect(inline(html, "layout")).toBe(modules.bootstrap.layoutBootstrapScript("/", []));
    } finally {
      await sql`ALTER TABLE public.site_layout_configs_moved RENAME TO site_layout_configs`;
      quiet.mockRestore();
    }
  });
});
