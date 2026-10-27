import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readdir, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import postgres from 'postgres';

// This test creates its own localhost-only disposable PostgreSQL at the current schema. It never
// loads .env, uses an inherited database URL, or connects to a hosted database.
const container = `ihear-database-audit-${randomUUID()}`;
const password = 'isolated-audit-test-only';
const docker = args => execFileSync('docker', args, { encoding: 'utf8', windowsHide: true, timeout: 60000, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
let started = false, port, workspace, sql;
const databaseUrl = () => `postgres://postgres:${password}@127.0.0.1:${port}/postgres`;

// A project script, run from a folder that holds only db/migrations (no .env files), with a minimal
// environment that holds only the disposable database URL. Returns its last JSON result.
function run(script) {
  const result = spawnSync(process.execPath, [path.resolve('scripts', script)], {
    cwd: workspace, encoding: 'utf8', windowsHide: true, timeout: 120000,
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: os.tmpdir(), TMP: os.tmpdir(), POSTGRES_URL: databaseUrl(), DATABASE_URL: '', POSTGRES_SSL: 'disable' },
  });
  const start = result.stdout.lastIndexOf('{\n  "connected"');
  if (start < 0) throw new Error(`${script} printed no result: ${result.stderr}`);
  return JSON.parse(result.stdout.slice(start));
}
const auditMedia = () => run('audit-database.mjs').invalidSiteMedia;

// An image as the site stores it: the asset row, then one variant per width.
async function image(slot, widths) {
  await sql`INSERT INTO site_media_assets (slot, alt_en, alt_zh_hant, alt_zh_hans, focal_x, focal_y, created_by, updated_by)
    VALUES (${slot}, 'Alt text', '替代文字', '替代文字', 50, 50, 'owner@example.test', 'owner@example.test')`;
  for (const width of widths) {
    await sql`INSERT INTO site_media_variants (slot, width, pixel_width, pixel_height, byte_size, mime_type, public_url, storage_path)
      VALUES (${slot}, ${width}, ${width}, ${width}, 1000, 'image/webp', ${`https://storage.example.test/${slot}/${width}.webp`}, ${`site-media/${slot}/${width}.webp`})`;
  }
}

beforeAll(async () => {
  docker(['run', '--detach', '--pull=never', '--name', container, '--label', 'ihear-test=database-audit', '-p', '127.0.0.1::5432', '-e', `POSTGRES_PASSWORD=${password}`, 'postgres:17-alpine']);
  started = true;
  port = docker(['port', container, '5432/tcp']).match(/^127\.0\.0\.1:(\d+)$/)?.[1];
  if (!port) throw new Error('Expected a localhost-only PostgreSQL port');
  sql = postgres(databaseUrl(), { ssl: false, max: 1, prepare: false, connect_timeout: 2, onnotice: () => {} });
  let ready = false;
  for (let attempt = 0; attempt < 60 && !ready; attempt++) {
    try { await sql`SELECT 1`; ready = true; } catch { await new Promise(resolve => { setTimeout(resolve, 300); }); }
  }
  if (!ready) throw new Error('Disposable PostgreSQL did not become ready');
  workspace = await mkdtemp(path.join(os.tmpdir(), 'ihear-database-audit-'));
  await mkdir(path.join(workspace, 'db', 'migrations'), { recursive: true });
  for (const file of (await readdir('db/migrations')).filter(name => /^\d+_[a-z0-9_]+\.sql$/i.test(name))) {
    await copyFile(path.join('db', 'migrations', file), path.join(workspace, 'db', 'migrations', file));
  }
  const migrated = spawnSync(process.execPath, [path.resolve('scripts/migrate-database.mjs')], {
    cwd: workspace, encoding: 'utf8', windowsHide: true, timeout: 120000,
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: os.tmpdir(), TMP: os.tmpdir(), POSTGRES_URL: databaseUrl(), DATABASE_URL: '', POSTGRES_SSL: 'disable' },
  });
  if (migrated.status !== 0) throw new Error(`Migration runner failed: ${migrated.stderr}`);
}, 180000);

afterAll(async () => {
  await sql?.end({ timeout: 2 });
  if (started) docker(['rm', '--force', '--volumes', container]);
  if (workspace && (await realpath(workspace)).startsWith(await realpath(os.tmpdir()))) await rm(workspace, { recursive: true, force: true });
}, 30000);

describe('the database audit of site images in a disposable PostgreSQL', { timeout: 60_000 }, () => {
  test('images with exactly the widths the site generates pass, team avatars included', async () => {
    await image('home.hero', [480, 800, 1200]);
    await image(`gallery.${randomUUID()}`, [480, 800, 1200]);
    await image('team.zoe-lu.avatar', [480, 800]);
    await image('team.example-person.avatar', [480, 800]);
    expect(auditMedia()).toEqual({ invalid_assets: 0, invalid_variants: 0, incomplete_variant_sets: 0 });
  });

  // Each on top of the correct images above, one at a time.
  test.each([
    ['an image without its 1200 width', 'services.tutoring', [480, 800]],
    ['an avatar without its 800 width', 'team.daniel-hollis.avatar', [480]],
    ['an avatar with two widths, but not 480 and 800', 'team.howard-ren.avatar', [480, 1200]],
    ['an avatar with a 1200 width the site never makes', 'team.second-person.avatar', [480, 800, 1200]],
    ['an image with no files at all', 'services.outreach', []],
  ])('%s is reported', async (_name, slot, widths) => {
    await image(slot, widths);
    try {
      expect(auditMedia().incomplete_variant_sets).toBe(1);
    } finally {
      await sql`DELETE FROM site_media_assets WHERE slot = ${slot}`;
    }
  });
});
