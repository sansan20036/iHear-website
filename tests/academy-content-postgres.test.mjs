import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import postgres from 'postgres';
import { ACADEMY_CONTENT_KEY, P0_ACADEMY_RATES, defaultAcademyContent, readStoredAcademyContent } from '../lib/academy-content-types';
import { migrationChecksum } from '../scripts/migration-checksum.mjs';

// This test creates its own localhost-only disposable PostgreSQL. It never loads
// .env, uses an inherited database URL, or connects to a hosted database.
const container = `ihear-academy-content-${randomUUID()}`;
const password = 'isolated-academy-test-only';
const docker = args => execFileSync('docker', args, { encoding: 'utf8', windowsHide: true, timeout: 60000, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
const migrations = (await readdir('db/migrations')).filter(file => /^\d+_[a-z0-9_]+\.sql$/i.test(file)).sort();
let started = false, port, workspace, sql, store;
const clients = [];
const databaseUrl = database => `postgres://postgres:${password}@127.0.0.1:${port}/${database}`;
function connect(database) {
  const client = postgres(databaseUrl(database), { ssl: false, max: 3, prepare: false, connect_timeout: 2, onnotice: () => {} });
  clients.push(client);
  return client;
}

// A copy of db/migrations up to a version, in a folder with no .env files.
async function migrationFolder(last) {
  const folder = path.join(workspace, `through-${last}`);
  await mkdir(path.join(folder, 'db', 'migrations'), { recursive: true });
  for (const file of migrations.filter(name => name.split('_', 1)[0] <= last)) {
    await copyFile(path.join('db', 'migrations', file), path.join(folder, 'db', 'migrations', file));
  }
  return folder;
}

// The project's own migration runner, with a minimal environment that holds
// only the disposable database URL.
function migrate(database, folder) {
  const result = spawnSync(process.execPath, [path.resolve('scripts/migrate-database.mjs')], {
    cwd: folder, encoding: 'utf8', windowsHide: true, timeout: 120000,
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: os.tmpdir(), TMP: os.tmpdir(), POSTGRES_URL: databaseUrl(database), DATABASE_URL: '', POSTGRES_SSL: 'disable' },
  });
  if (result.status !== 0) throw new Error(`Migration runner failed: ${result.stderr}`);
  return JSON.parse(result.stdout.trim().split('\n').pop());
}

const settings = async (client, key = ACADEMY_CONTENT_KEY) => (await client`SELECT * FROM site_settings WHERE key = ${key}`)[0];
const themeRevision = async client => (await client`SELECT revision::text AS revision FROM site_content_revisions WHERE scope = 'theme'`)[0].revision;
const auditCount = async client => Number((await client`SELECT count(*) AS count FROM admin_activity_log WHERE entity_type = 'academy'`)[0].count);
const snapshot = async client => ({
  settings: await client`SELECT * FROM site_settings WHERE key NOT LIKE 'academy_%' ORDER BY key`,
  accounts: await client`SELECT * FROM admin_accounts ORDER BY email`,
  activity: await client`SELECT * FROM admin_activity_log ORDER BY id`,
});

beforeAll(async () => {
  docker(['run', '--detach', '--pull=never', '--name', container, '--label', 'ihear-test=academy-content', '-p', '127.0.0.1::5432', '-e', `POSTGRES_PASSWORD=${password}`, 'postgres:17-alpine']);
  started = true;
  port = docker(['port', container, '5432/tcp']).match(/^127\.0\.0\.1:(\d+)$/)?.[1];
  if (!port) throw new Error('Expected a localhost-only PostgreSQL port');
  const root = connect('postgres');
  let ready = false;
  for (let attempt = 0; attempt < 60 && !ready; attempt++) {
    try { await root`SELECT 1`; ready = true; } catch { await new Promise(resolve => { setTimeout(resolve, 300); }); }
  }
  if (!ready) throw new Error('Disposable PostgreSQL did not become ready');
  for (const database of ['production_like', 'edited_v1']) await root.unsafe(`CREATE DATABASE ${database}`);
  workspace = await mkdtemp(path.join(os.tmpdir(), 'ihear-academy-migrations-'));
  sql = connect('production_like');
}, 120000);

afterAll(async () => {
  await globalThis.ihearAcademyContentSql?.end({ timeout: 2 });
  for (const client of clients) await client.end({ timeout: 2 });
  vi.unstubAllEnvs();
  if (started) docker(['rm', '--force', '--volumes', container]);
  if (workspace && (await realpath(workspace)).startsWith(await realpath(os.tmpdir()))) await rm(workspace, { recursive: true, force: true });
}, 30000);

// These tests run the real migration runner as separate processes (up to three per
// test); give them room on a busy machine or a slower CI runner.
describe('Academy content migrations in a disposable PostgreSQL', { timeout: 60_000 }, () => {
  test('a database at the production schema (023) gains 025 and 026 with existing data preserved', async () => {
    expect(migrate('production_like', await migrationFolder('023')).applied.at(-1)).toBe('023_resource_topics.sql');
    // Existing administrator data and settings, as an operating site has them.
    await sql`UPDATE site_settings SET value = 'ocean', record_version = 2, updated_by = 'owner@example.test' WHERE key = 'site_theme'`;
    await sql`INSERT INTO admin_accounts (email, invited_by, updated_by) VALUES ('editor@example.test', 'owner@example.test', 'owner@example.test')`;
    await sql`INSERT INTO admin_activity_log (id, actor_email, actor_role, action, entity_type, entity_id, changed_fields) VALUES
      (${randomUUID()}, 'owner@example.test', 'owner', 'team.updated', 'team', 'person-1', ARRAY['name']),
      (${randomUUID()}, 'editor@example.test', 'editor', 'resource.updated', 'resource', 'guide-1', ARRAY['title'])`;
    const before = await snapshot(sql);

    const run = migrate('production_like', await migrationFolder('999'));
    expect(run.applied).toEqual(['025_academy_pricing.sql', '026_academy_content_v2.sql']);
    for (const file of run.applied) {
      const [recorded] = await sql`SELECT name, checksum FROM schema_migrations WHERE version = ${file.slice(0, 3)}`;
      expect(recorded).toEqual({ name: file, checksum: migrationChecksum(await readFile(`db/migrations/${file}`, 'utf8')) });
    }
    expect(await snapshot(sql)).toEqual(before);

    // 026 seeds exactly the P0 prices and the template text; 025's untouched seed
    // with its superseded prices is removed and can never be shown.
    const row = await settings(sql);
    expect(row).toMatchObject({ record_version: 1, updated_by: 'migration-026' });
    expect(JSON.parse(row.value)).toEqual(defaultAcademyContent());
    expect(readStoredAcademyContent(JSON.parse(row.value)).pricing.rates).toEqual(P0_ACADEMY_RATES);
    expect(await settings(sql, 'academy_pricing_v1')).toBeUndefined();

    const repeat = migrate('production_like', await migrationFolder('999'));
    expect(repeat.applied).toEqual([]);
    expect(await settings(sql)).toEqual(row);
  });

  test('an environment that edited the 025 prices keeps that row and still gets the P0 prices', async () => {
    const edited = connect('edited_v1');
    migrate('edited_v1', await migrationFolder('025'));
    const original = await settings(edited, 'academy_pricing_v1');
    expect(original).toMatchObject({ record_version: 1, updated_by: 'migration-025' });
    const changed = JSON.parse(original.value);
    changed.en.tiers[0].singlePrice = 46;
    await edited`UPDATE site_settings SET value = ${JSON.stringify(changed)}, record_version = 2, updated_by = 'editor@example.test' WHERE key = 'academy_pricing_v1'`;
    const kept = await settings(edited, 'academy_pricing_v1');

    expect(migrate('edited_v1', await migrationFolder('999')).applied).toEqual(['026_academy_content_v2.sql']);
    // Never converted automatically: superseded prices must not replace P0 prices.
    expect(await settings(edited, 'academy_pricing_v1')).toEqual(kept);
    expect(JSON.parse((await settings(edited)).value).pricing.rates).toEqual(P0_ACADEMY_RATES);
  });

  test('rerunning 026 never replaces published content, its version, or fires the revision trigger', async () => {
    const published = defaultAcademyContent();
    published.pricing.rates.TWD['60'].college = 1500;
    await sql`UPDATE site_settings SET value = ${JSON.stringify(published)}, record_version = 5, updated_by = 'owner@example.test' WHERE key = ${ACADEMY_CONTENT_KEY}`;
    const before = await settings(sql), revision = await themeRevision(sql);
    const text = await readFile('db/migrations/026_academy_content_v2.sql', 'utf8');
    await sql.begin(transaction => transaction.unsafe(text));
    expect(await settings(sql)).toEqual(before);
    expect(await themeRevision(sql)).toBe(revision);
  });

  test('limits: 60,000 characters for the Academy content only; activity accepts the academy type', async () => {
    const rollback = Symbol('rollback');
    try {
      await sql.begin(async transaction => {
        await transaction`UPDATE site_settings SET value = ${'😀'.repeat(60000)} WHERE key = ${ACADEMY_CONTENT_KEY}`;
        expect((await transaction`SELECT char_length(value)::integer AS chars, octet_length(value)::integer AS bytes FROM site_settings WHERE key = ${ACADEMY_CONTENT_KEY}`)[0]).toEqual({ chars: 60000, bytes: 240000 });
        throw rollback;
      });
    } catch (error) { if (error !== rollback) throw error; }
    await expect(sql`UPDATE site_settings SET value = ${'界'.repeat(60001)} WHERE key = ${ACADEMY_CONTENT_KEY}`).rejects.toMatchObject({ code: '23514' });
    await expect(sql`UPDATE site_settings SET value = ${'界'.repeat(501)} WHERE key = 'site_theme'`).rejects.toMatchObject({ code: '23514' });
    await expect(sql`INSERT INTO site_settings (key, value, updated_by) VALUES ('other_setting', ${'x'.repeat(501)}, 'test')`).rejects.toMatchObject({ code: '23514' });
    await expect(sql`INSERT INTO admin_activity_log (id, actor_email, actor_role, action, entity_type, entity_id) VALUES (${randomUUID()}, 'a@example.test', 'owner', 'x', 'unknown', 'x')`).rejects.toMatchObject({ code: '23514' });
  });
});

describe('Academy content store transactions in a disposable PostgreSQL', () => {
  beforeAll(async () => {
    vi.stubEnv('POSTGRES_URL', databaseUrl('production_like')); vi.stubEnv('DATABASE_URL', ''); vi.stubEnv('POSTGRES_SSL', 'disable');
    vi.stubEnv('IHEAR_FORCE_FILE_STORE', ''); vi.stubEnv('VERCEL', '1');
    vi.resetModules();
    store = await import('../lib/academy-content-store');
  });

  test('reads the published row with its version', async () => {
    const record = await store.readAcademyContent();
    expect(record.recordVersion).toBe(5);
    expect(record.config.pricing.rates.TWD['60'].college).toBe(1500);
  });

  test('concurrent saves have exactly one winner; the loser leaves no audit or revision', async () => {
    const before = await store.readAcademyContent();
    const audits = await auditCount(sql), revision = BigInt(await themeRevision(sql));
    const configs = [36, 37].map(price => { const config = structuredClone(before.config); config.pricing.rates.USD['60'].highschool = price; return config; });
    const results = await Promise.allSettled(configs.map(config => store.updateAcademyContent({ config, expectedVersion: before.recordVersion, updatedBy: 'editor@example.test', updatedByRole: 'editor' })));
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find(result => result.status === 'rejected').reason).toBeInstanceOf(store.AcademyContentConflictError);
    const after = await store.readAcademyContent();
    expect(after.recordVersion).toBe(before.recordVersion + 1);
    expect(after.config).toEqual(results.find(result => result.status === 'fulfilled').value.config);
    expect(await auditCount(sql)).toBe(audits + 1);
    expect(BigInt(await themeRevision(sql))).toBe(revision + 1n);
    const [entry] = await sql`SELECT * FROM admin_activity_log WHERE entity_type = 'academy' ORDER BY created_at DESC LIMIT 1`;
    expect(entry).toMatchObject({ actor_email: 'editor@example.test', actor_role: 'editor', action: 'academy.content.updated', entity_id: ACADEMY_CONTENT_KEY, entity_status: 'published', entity_version: after.recordVersion, changed_fields: ['pricing.USD.60.highschool'] });
  });

  test('a stale version changes nothing', async () => {
    const before = await settings(sql), audits = await auditCount(sql), revision = await themeRevision(sql);
    const config = readStoredAcademyContent(JSON.parse(before.value));
    config.content.en['hero.cta'] = 'Stale edit';
    await expect(store.updateAcademyContent({ config, expectedVersion: before.record_version - 1, updatedBy: 'owner@example.test', updatedByRole: 'owner' })).rejects.toBeInstanceOf(store.AcademyContentConflictError);
    expect(await settings(sql)).toEqual(before);
    expect(await auditCount(sql)).toBe(audits);
    expect(await themeRevision(sql)).toBe(revision);
  });

  test('an audit failure rolls back the content and the revision together', async () => {
    const before = await settings(sql), revision = await themeRevision(sql);
    await sql.unsafe("CREATE FUNCTION public.academy_test_reject_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'isolated audit failure'; END $$; CREATE TRIGGER academy_test_reject_audit BEFORE INSERT ON admin_activity_log FOR EACH ROW EXECUTE FUNCTION public.academy_test_reject_audit();");
    try {
      const config = readStoredAcademyContent(JSON.parse(before.value));
      config.content.zhHant['hero.cta'] = '不應保存';
      await expect(store.updateAcademyContent({ config, expectedVersion: before.record_version, updatedBy: 'editor@example.test', updatedByRole: 'editor' })).rejects.toBeInstanceOf(store.AcademyContentUnavailableError);
      expect(await settings(sql)).toEqual(before);
      expect(await themeRevision(sql)).toBe(revision);
    } finally {
      await sql.unsafe('DROP TRIGGER academy_test_reject_audit ON admin_activity_log; DROP FUNCTION public.academy_test_reject_audit();');
    }
  });

  test('Unicode text round-trips exactly through PostgreSQL', async () => {
    const before = await store.readAcademyContent();
    const config = structuredClone(before.config);
    config.content.zhHant['hero.lead'] = '從一句對話開始 😀\n第二行「引號」& <b>';
    config.content.en['faq.item7.answerNote'] = 'Tutor match — “quoted” 👩‍🏫';
    const saved = await store.updateAcademyContent({ config, expectedVersion: before.recordVersion, updatedBy: 'owner@example.test', updatedByRole: 'owner' });
    expect((await store.readAcademyContent()).config).toEqual(saved.config);
    expect(saved.config.content.zhHant['hero.lead']).toBe('從一句對話開始 😀\n第二行「引號」& <b>');
  });

  test('an invalid or missing hosted row never falls back to defaults', async () => {
    const before = await settings(sql);
    try {
      await sql`UPDATE site_settings SET value = '{}' WHERE key = ${ACADEMY_CONTENT_KEY}`;
      await expect(store.readAcademyContent()).rejects.toBeInstanceOf(store.AcademyContentUnavailableError);
      await sql`DELETE FROM site_settings WHERE key = ${ACADEMY_CONTENT_KEY}`;
      await expect(store.readAcademyContent()).rejects.toBeInstanceOf(store.AcademyContentUnavailableError);
      await expect(store.updateAcademyContent({ config: defaultAcademyContent(), expectedVersion: 1, updatedBy: 'owner@example.test', updatedByRole: 'owner' })).rejects.toBeInstanceOf(store.AcademyContentUnavailableError);
      expect(await settings(sql)).toBeUndefined();
    } finally {
      await sql`INSERT INTO site_settings (key, value, record_version, updated_at, updated_by) VALUES (${before.key}, ${before.value}, ${before.record_version}, ${before.updated_at}, ${before.updated_by}) ON CONFLICT (key) DO UPDATE SET value = excluded.value, record_version = excluded.record_version`;
    }
    expect(await settings(sql)).toEqual(before);
  });
});
