import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import postgres from 'postgres';
import { HOME_CALENDAR_KEY, emptyHomeCalendar } from '../lib/home-calendar-types';
import { migrationChecksum } from '../scripts/migration-checksum.mjs';

// A localhost-only disposable PostgreSQL, as in academy-content-postgres.test.mjs. It never
// loads .env, uses an inherited database URL, or connects to a hosted database.
const container = `ihear-home-calendar-${randomUUID()}`;
const password = 'isolated-calendar-test-only';
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
async function migrationFolder(last) {
  const folder = path.join(workspace, `through-${last}`);
  await mkdir(path.join(folder, 'db', 'migrations'), { recursive: true });
  for (const file of migrations.filter(name => name.split('_', 1)[0] <= last)) {
    await copyFile(path.join('db', 'migrations', file), path.join(folder, 'db', 'migrations', file));
  }
  return folder;
}
function migrate(database, folder) {
  const result = spawnSync(process.execPath, [path.resolve('scripts/migrate-database.mjs')], {
    cwd: folder, encoding: 'utf8', windowsHide: true, timeout: 120000,
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: os.tmpdir(), TMP: os.tmpdir(), POSTGRES_URL: databaseUrl(database), DATABASE_URL: '', POSTGRES_SSL: 'disable' },
  });
  if (result.status !== 0) throw new Error(`Migration runner failed: ${result.stderr}`);
  return JSON.parse(result.stdout.trim().split('\n').pop());
}
const calendarRow = async () => (await sql`SELECT * FROM site_settings WHERE key = ${HOME_CALENDAR_KEY}`)[0];
const calendarAudits = async () => Number((await sql`SELECT count(*) AS count FROM admin_activity_log WHERE entity_type = 'calendar'`)[0].count);
const otherState = async () => ({
  settings: await sql`SELECT * FROM site_settings WHERE key <> ${HOME_CALENDAR_KEY} ORDER BY key`,
  activity: await sql`SELECT * FROM admin_activity_log ORDER BY id`,
  revisions: await sql`SELECT scope, revision::text AS revision FROM site_content_revisions ORDER BY scope`,
});

beforeAll(async () => {
  docker(['run', '--detach', '--pull=never', '--name', container, '--label', 'ihear-test=home-calendar', '-p', '127.0.0.1::5432', '-e', `POSTGRES_PASSWORD=${password}`, 'postgres:17-alpine']);
  started = true;
  port = docker(['port', container, '5432/tcp']).match(/^127\.0\.0\.1:(\d+)$/)?.[1];
  if (!port) throw new Error('Expected a localhost-only PostgreSQL port');
  const root = connect('postgres');
  let ready = false;
  for (let attempt = 0; attempt < 60 && !ready; attempt++) {
    try { await root`SELECT 1`; ready = true; } catch { await new Promise(resolve => { setTimeout(resolve, 300); }); }
  }
  if (!ready) throw new Error('Disposable PostgreSQL did not become ready');
  await root.unsafe('CREATE DATABASE production_like');
  workspace = await mkdtemp(path.join(os.tmpdir(), 'ihear-calendar-migrations-'));
  sql = connect('production_like');
}, 120000);

afterAll(async () => {
  await globalThis.ihearHomeCalendarSql?.end({ timeout: 2 });
  for (const client of clients) await client.end({ timeout: 2 });
  vi.unstubAllEnvs();
  if (started) docker(['rm', '--force', '--volumes', container]);
  if (workspace && (await realpath(workspace)).startsWith(await realpath(os.tmpdir()))) await rm(workspace, { recursive: true, force: true });
}, 30000);

describe('migration 027 in a disposable PostgreSQL', { timeout: 60_000 }, () => {
  test('a database at the live schema (026) gains 027: an empty calendar, nothing else changed', async () => {
    expect(migrate('production_like', await migrationFolder('026')).applied.at(-1)).toBe('026_academy_content_v2.sql');
    await sql`UPDATE site_settings SET value = 'ocean', record_version = 2, updated_by = 'owner@example.test' WHERE key = 'site_theme'`;
    await sql`INSERT INTO admin_activity_log (id, actor_email, actor_role, action, entity_type, entity_id, changed_fields)
      VALUES (${randomUUID()}, 'owner@example.test', 'owner', 'academy.content.updated', 'academy', 'academy_content_v2', ARRAY['pricing.rates'])`;
    const before = await otherState();

    const run = migrate('production_like', await migrationFolder('999'));
    expect(run.applied).toEqual(['027_home_calendar.sql']);
    const [recorded] = await sql`SELECT name, checksum FROM schema_migrations WHERE version = '027'`;
    expect(recorded).toEqual({ name: '027_home_calendar.sql', checksum: migrationChecksum(await readFile('db/migrations/027_home_calendar.sql', 'utf8')) });
    const row = await calendarRow();
    expect(row).toMatchObject({ record_version: 1, updated_by: 'migration-027' });
    expect(JSON.parse(row.value)).toEqual(emptyHomeCalendar());
    const after = await otherState();
    expect(after.settings).toEqual(before.settings);
    expect(after.activity).toEqual(before.activity);
  });

  test('rerunning 027 never replaces saved events or their version, and fires no revision', async () => {
    await sql`UPDATE site_settings SET value = ${JSON.stringify({ ...emptyHomeCalendar(), events: [{ id: 'event-0001', title: 'Kept', date: '2026-11-05', startTime: null, endTime: null, description: '', link: null }] })},
      record_version = 7, updated_by = 'owner@example.test' WHERE key = ${HOME_CALENDAR_KEY}`;
    const saved = await calendarRow();
    const revisions = (await otherState()).revisions;
    await sql.unsafe(await readFile('db/migrations/027_home_calendar.sql', 'utf8'));
    expect(await calendarRow()).toEqual(saved);
    expect((await otherState()).revisions).toEqual(revisions);
    expect(migrate('production_like', await migrationFolder('999')).applied).toEqual([]);
  });

  test('limits: the calendar holds 400,000 characters, other keys still 500; "calendar" is an activity type', async () => {
    await sql.begin(async transaction => {
      await transaction`UPDATE site_settings SET value = ${'x'.repeat(400_000)} WHERE key = ${HOME_CALENDAR_KEY}`;
      await transaction`SELECT 1/0`;
    }).catch(error => { expect(String(error.message)).toMatch(/division by zero/); });
    await expect(sql`UPDATE site_settings SET value = ${'x'.repeat(400_001)} WHERE key = ${HOME_CALENDAR_KEY}`).rejects.toMatchObject({ constraint_name: 'site_settings_value_length' });
    // site_theme has its own allowed values, so the generic 500-character limit is checked on a new key.
    await expect(sql`INSERT INTO site_settings (key, value, record_version, updated_by) VALUES ('limit_probe', ${'x'.repeat(501)}, 1, 'test')`).rejects.toMatchObject({ constraint_name: 'site_settings_value_length' });
    await sql`INSERT INTO admin_activity_log (id, actor_email, actor_role, action, entity_type, entity_id) VALUES (${randomUUID()}, 'a@example.test', 'owner', 'x', 'calendar', 'x')`;
    await expect(sql`INSERT INTO admin_activity_log (id, actor_email, actor_role, action, entity_type, entity_id) VALUES (${randomUUID()}, 'a@example.test', 'owner', 'x', 'unknown', 'x')`).rejects.toMatchObject({ constraint_name: 'admin_activity_log_entity_type_check' });
  });
});

describe('calendar store transactions in a disposable PostgreSQL', { timeout: 60_000 }, () => {
  beforeAll(async () => {
    await sql`UPDATE site_settings SET value = ${JSON.stringify(emptyHomeCalendar())}, record_version = 1, updated_by = 'migration-027' WHERE key = ${HOME_CALENDAR_KEY}`;
    await sql`DELETE FROM admin_activity_log WHERE entity_type = 'calendar'`;
    vi.stubEnv('POSTGRES_URL', databaseUrl('production_like')); vi.stubEnv('DATABASE_URL', ''); vi.stubEnv('POSTGRES_SSL', 'disable');
    vi.stubEnv('IHEAR_FORCE_FILE_STORE', ''); vi.stubEnv('VERCEL', '1');
    vi.resetModules();
    store = await import('../lib/home-calendar-store');
  });
  const event = id => ({ id, title: `Event ${id}`, date: '2026-11-05', startTime: '19:00', endTime: null, description: '', link: null });
  const save = (events, expectedVersion) => store.updateHomeCalendar({ config: { ...emptyHomeCalendar(), events }, expectedVersion, updatedBy: 'owner@example.test', updatedByRole: 'owner' });

  test('reads the seeded empty calendar; a save increments the version and writes one audit entry', async () => {
    expect(await store.readHomeCalendar()).toMatchObject({ recordVersion: 1, config: emptyHomeCalendar() });
    expect(await save([event('event-0001')], 1)).toMatchObject({ recordVersion: 2, updatedBy: 'owner@example.test' });
    const [audit] = await sql`SELECT action, entity_type, entity_id, changed_fields, entity_version FROM admin_activity_log WHERE entity_type = 'calendar'`;
    expect(audit).toEqual({ action: 'calendar.events.updated', entity_type: 'calendar', entity_id: HOME_CALENDAR_KEY, changed_fields: ['events.event-0001.created'], entity_version: 2 });
  });

  test('concurrent saves at one version: exactly one wins; the loser leaves no audit entry', async () => {
    const audits = await calendarAudits();
    const results = await Promise.allSettled([save([event('event-0002')], 2), save([event('event-0003')], 2)]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find(result => result.status === 'rejected').reason).toBeInstanceOf(store.HomeCalendarConflictError);
    expect((await calendarRow()).record_version).toBe(3);
    expect(await calendarAudits()).toBe(audits + 1);
  });

  test('a stale save changes nothing', async () => {
    const before = await calendarRow();
    await expect(save([], 1)).rejects.toBeInstanceOf(store.HomeCalendarConflictError);
    expect(await calendarRow()).toEqual(before);
  });
});
