import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import postgres from 'postgres';
import { migrationChecksum } from '../scripts/migration-checksum.mjs';

// Real PostgreSQL in a disposable container. Credentials and loopback binding
// originate here; no .env, configured database URL, or production data is read.
const container = `ihear-media-contract-${randomUUID()}`, password = randomUUID();
const evidenceDirectory = path.resolve('output/media-gallery-postgres', container);
const runnerDirectory = path.join(evidenceDirectory, 'runner');
const runnerPath = path.resolve('scripts/migrate-database.mjs');
const docker = args => {
  try {
    return execFileSync('docker', args, { encoding: 'utf8', windowsHide: true, timeout: 60000, maxBuffer: 10 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch (error) {
    // execFileSync's default message includes all arguments, including the
    // generated password. Never propagate that message or its raw cause.
    const detail = String(error.stderr || '').replaceAll(password, '[redacted]').trim();
    throw new Error(`Docker ${args[0]} failed (${error.code || error.status || 'unknown'}): ${detail || 'no diagnostic output'}`);
  }
};
const legacyIds = ['home', 'impact', 'outreach', 'stories', 'tutoring'];
const actor = 'media-contract-test@example.com';
const oldAssetSlot = `gallery.${randomUUID()}`;
const oldOperationId = randomUUID();
const caption = { en: 'Legacy caption', zhHant: '人工保留說明', zhHans: '人工保留说明' };
const title = { en: 'New title', zhHant: '橫幅標題', zhHans: '横幅标题' };
let started = false, db, upgradeDb, rollbackDb, url, upgradeUrl, rollbackUrl, store, before, after, constraintsBefore, constraintsAfter, historicalHashes, migration;
let ledgerBefore, ledgerAfter, revisionsBefore, revisionsAfter, server, upgradeResult;
const sha256 = value => createHash('sha256').update(value).digest('hex');
const delay = ms => new Promise(resolve => { setTimeout(resolve, ms); });

async function evidence(name, value) {
  await mkdir(evidenceDirectory, { recursive: true });
  await writeFile(path.join(evidenceDirectory, `${name}.json`), JSON.stringify(value, null, 2) + '\n');
}
async function copyMigration(file) {
  await mkdir(path.join(runnerDirectory, 'db/migrations'), { recursive: true });
  await writeFile(path.join(runnerDirectory, 'db/migrations', file), await readFile(path.join('db/migrations', file)));
}
function runMigrations(target) {
  // The real runner discovers migrations from this isolated cwd, which contains
  // no .env files. Both possible URL inputs are explicit disposable URLs.
  const result = spawnSync(process.execPath, [runnerPath], {
    cwd: runnerDirectory, encoding: 'utf8', windowsHide: true, timeout: 60000,
    env: { ...process.env, NODE_ENV: 'test', POSTGRES_URL: target, DATABASE_URL: target, POSTGRES_SSL: 'disable', IHEAR_FORCE_FILE_STORE: '0' },
  });
  const jsonLines = text => (text || '').split(/\r?\n/).flatMap(line => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
  const details = [...jsonLines(result.stdout), ...jsonLines(result.stderr)].find(value => typeof value.connected === 'boolean');
  if (result.error) throw new Error(`Migration runner could not execute: ${result.error.code}`);
  if (!details) throw new Error(`Migration runner produced no structured result (exit ${result.status})`);
  return { exitCode: result.status, ...details };
}
async function ledger(sql) {
  return Array.from(await sql`SELECT version,name,checksum,applied_at FROM public.schema_migrations ORDER BY version`);
}
async function revisions(sql) {
  return Array.from(await sql`SELECT * FROM public.site_content_revisions ORDER BY scope`);
}

async function migrationHashes() {
  const files = (await readdir('db/migrations')).filter(file => /^\d+_.*\.sql$/.test(file) && Number(file.slice(0, 3)) < 24).sort();
  return Object.fromEntries(await Promise.all(files.map(async file => {
    const bytes = await readFile(path.join('db/migrations', file));
    return [file, { bytes: sha256(bytes), checksum: migrationChecksum(bytes.toString('utf8')) }];
  })));
}
async function snapshot(sql, excludeBanner = true) {
  const [row] = await sql`SELECT jsonb_build_object(
    'galleries',(SELECT COALESCE(jsonb_agg(to_jsonb(g) ORDER BY id),'[]'::jsonb) FROM media_galleries g WHERE NOT ${excludeBanner} OR id <> 'home-banner'),
    'galleryAssets',(SELECT COALESCE(jsonb_agg(to_jsonb(a) ORDER BY slot),'[]'::jsonb) FROM media_gallery_assets a),
    'operations',(SELECT COALESCE(jsonb_agg(to_jsonb(o) ORDER BY id),'[]'::jsonb) FROM media_gallery_operations o),
    'siteMedia',(SELECT COALESCE(jsonb_agg(to_jsonb(a) ORDER BY slot),'[]'::jsonb) FROM site_media_assets a),
    'siteVariants',(SELECT COALESCE(jsonb_agg(to_jsonb(v) ORDER BY slot,width),'[]'::jsonb) FROM site_media_variants v),
    'translations',(SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY resource_type,resource_scope,resource_id,field_key,locale),'[]'::jsonb) FROM localized_translation_states t)
  ) AS value`;
  return row.value;
}
async function constraints(sql) {
  return Array.from(await sql`SELECT conname, pg_get_constraintdef(oid) AS definition
    FROM pg_constraint WHERE conrelid='public.media_galleries'::regclass ORDER BY conname`);
}
async function closeStoreClients() {
  for (const key of ['ihearGallerySql', 'ihearTranslationSql']) {
    if (globalThis[key]) await globalThis[key].end({ timeout: 1 });
    delete globalThis[key];
  }
  delete globalThis.ihearGallerySchema;
  delete globalThis.ihearGallerySchemaV2;
  delete globalThis.ihearTranslationSchemaReady;
}
const mutation = (id, expectedVersion, values = {}) => ({
  id, operationId: randomUUID(), actor, fingerprint: randomUUID(), expectedVersion,
  action: 'put', item: { id: randomUUID(), kind: 'youtube', hidden: false, videoId: 'LsQWwDBLKUc', caption }, ...values,
});

async function concurrentMutations(inputs, lock) {
  await store.listGalleries(); // Complete schema initialization before the barrier.
  const originalClient = globalThis.ihearGallerySql;
  const clients = inputs.map(() => postgres(url, { ssl: false, max: 1, prepare: false, onnotice: () => {} }));
  const blocker = postgres(url, { ssl: false, max: 1, prepare: false, onnotice: () => {} });
  let pending, observedWaiters;
  try {
    const pids = await Promise.all(clients.map(async client => (await client`SELECT pg_backend_pid() AS pid`)[0].pid));
    expect(new Set(pids).size).toBe(2);
    await blocker`BEGIN`;
    if (lock.galleryId) await blocker`SELECT id FROM media_galleries WHERE id=${lock.galleryId} FOR UPDATE`;
    else await blocker`SELECT pg_advisory_xact_lock(hashtext(${lock.operationId}))`;
    // Each async store invocation captures its own real postgres client in
    // ready() before yielding. Clients have max:1 and distinct verified PIDs;
    // no SQL/store function is mocked and no file-store path is used.
    pending = Promise.allSettled(inputs.map((input, index) => {
      globalThis.ihearGallerySql = clients[index];
      return store.mutateGallery(input);
    }));
    globalThis.ihearGallerySql = originalClient;
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      observedWaiters = Array.from(await db`SELECT pid, state, wait_event_type, wait_event, pg_blocking_pids(pid) AS blocking_pids
        FROM pg_stat_activity WHERE pid IN ${db(pids)} ORDER BY pid`);
      if (observedWaiters.length === 2 && observedWaiters.every(row => row.state === 'active' && row.wait_event_type === 'Lock')) break;
      await delay(50);
    }
    expect(observedWaiters).toHaveLength(2);
    expect(observedWaiters.every(row => row.state === 'active' && row.wait_event_type === 'Lock' && row.blocking_pids.length > 0)).toBe(true);
    await blocker`ROLLBACK`;
    return { outcomes: await pending, pids, observedWaiters };
  } finally {
    globalThis.ihearGallerySql = originalClient;
    await blocker`ROLLBACK`.catch(() => undefined);
    if (pending) await pending;
    await Promise.all([...clients, blocker].map(client => client.end({ timeout: 1 })));
  }
}

beforeAll(async () => {
  historicalHashes = await migrationHashes();
  migration = await readFile('db/migrations/024_home_banner_gallery.sql', 'utf8');
  started = true; // A timed-out run can still have created this unique container.
  docker(['run', '--detach', '--rm', '--pull=never', '--name', container, '--label', 'ihear-test=media-contract', '-p', '127.0.0.1::5432', '-e', `POSTGRES_PASSWORD=${password}`, 'postgres:17-alpine']);
  const binding = JSON.parse(docker(['inspect', '--format', '{{json (index .NetworkSettings.Ports "5432/tcp")}}', container]))[0];
  if (binding.HostIp !== '127.0.0.1' || !/^\d+$/.test(binding.HostPort)) throw new Error('Test PostgreSQL must bind only to loopback');
  url = `postgres://postgres:${password}@127.0.0.1:${binding.HostPort}/postgres`;
  upgradeUrl = `postgres://postgres:${password}@127.0.0.1:${binding.HostPort}/checkpoint019`;
  rollbackUrl = `postgres://postgres:${password}@127.0.0.1:${binding.HostPort}/checkpoint023`;
  db = postgres(url, { ssl: false, max: 1, connect_timeout: 2, onnotice: () => {} });
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    try { await db`SELECT 1`; ready = true; break; } catch { await new Promise(resolve => { setTimeout(resolve, 500); }); }
  }
  if (!ready) throw new Error('Disposable PostgreSQL did not become ready');
  [server] = await db`SELECT version() AS version, current_setting('server_version_num')::integer AS version_number, current_database() AS database`;
  expect(Math.floor(server.version_number / 10000)).toBe(17);
  const oldFiles = Object.keys(historicalHashes);
  for (const file of oldFiles.filter(file => Number(file.slice(0, 3)) <= 19)) await copyMigration(file);
  const baseline019 = runMigrations(url);
  expect(baseline019).toMatchObject({ exitCode: 0, connected: true, totalTracked: 19 });
  await db.unsafe('CREATE DATABASE checkpoint019 TEMPLATE postgres');
  for (const file of oldFiles.filter(file => Number(file.slice(0, 3)) > 19)) await copyMigration(file);
  const baseline023 = runMigrations(url);
  expect(baseline023).toMatchObject({ exitCode: 0, connected: true, totalTracked: 23 });
  upgradeDb = postgres(upgradeUrl, { ssl: false, max: 1, onnotice: () => {} });
  const asset = {
    asset: { slot: oldAssetSlot, alt: caption, focalX: 17, focalY: 63, zoom: 130, recordVersion: 4, updatedAt: '2025-01-02T03:04:05.000Z', updatedBy: actor,
      variants: [{ width: 800, pixelWidth: 800, pixelHeight: 450, byteSize: 9876, mimeType: 'image/webp', url: '/legacy.webp', storagePath: 'local/retained.webp' }] },
    states: [{ field: 'alt', locale: 'zhHant', sourceHash: null, origin: 'manual', glossaryVersion: 'test' }],
  };
  await db`INSERT INTO media_gallery_assets(slot,payload) VALUES (${oldAssetSlot},${db.json(asset)})`;
  await db`UPDATE media_galleries SET version=7, updated_by=${actor}, updated_at='2025-01-02T03:04:05Z',
    items=${db.json([{ id: 'retained-photo', kind: 'photo', hidden: false, assetSlot: oldAssetSlot, caption }, { id: 'retained-hidden-video', kind: 'youtube', hidden: true, videoId: 'LsQWwDBLKUc', caption }])} WHERE id='tutoring'`;
  await db`INSERT INTO media_gallery_operations(id,gallery_id,actor,fingerprint,created_at) VALUES (${oldOperationId},'tutoring',${actor},'retained-fingerprint','2025-01-02T03:04:05Z')`;
  await db`INSERT INTO localized_translation_states(resource_type,resource_scope,resource_id,field_key,locale,source_hash,origin,glossary_version,updated_by,updated_at)
    VALUES ('media','',${oldAssetSlot},'alt','zhHant',NULL,'manual','test',${actor},'2025-01-02T03:04:05Z')`;
  await db`INSERT INTO site_media_assets(slot,alt_en,alt_zh_hant,alt_zh_hans,focal_x,focal_y,zoom,record_version,created_by,updated_by,created_at,updated_at)
    VALUES ('home.hero',${caption.en},${caption.zhHant},${caption.zhHans},17,63,130,4,${actor},${actor},'2025-01-02T03:04:05Z','2025-01-02T03:04:05Z')`;
  await db`INSERT INTO site_media_variants(slot,width,pixel_width,pixel_height,byte_size,mime_type,public_url,storage_path)
    VALUES ('home.hero',800,800,450,9876,'image/webp','https://example.org/retained-hero.webp','retained-hero.webp')`;
  constraintsBefore = await constraints(db);
  before = await snapshot(db);
  ledgerBefore = await ledger(db);
  revisionsBefore = await revisions(db);
  await db.unsafe('CREATE DATABASE checkpoint023 TEMPLATE postgres');
  rollbackDb = postgres(rollbackUrl, { ssl: false, max: 1, onnotice: () => {} });
  await copyMigration('024_home_banner_gallery.sql');
  upgradeResult = runMigrations(url);
  expect(upgradeResult).toMatchObject({ exitCode: 0, connected: true, applied: ['024_home_banner_gallery.sql'], totalTracked: 24 });
  after = await snapshot(db);
  constraintsAfter = await constraints(db);
  ledgerAfter = await ledger(db);
  revisionsAfter = await revisions(db);
  await evidence('preservation', {
    database: 'disposable loopback-only Docker PostgreSQL', server, storeMode: 'PostgreSQL; file fallback disabled',
    historicalMigrations: historicalHashes, migration024: { bytes: sha256(await readFile('db/migrations/024_home_banner_gallery.sql')), checksum: migrationChecksum(migration) },
    runner: { entry: 'scripts/migrate-database.mjs', isolatedCwd: true, baseline019, baseline023, upgradeResult },
    constraintsBefore, constraintsAfter, before, after, ledgerBefore, ledgerAfter, revisionsBefore, revisionsAfter,
    expectedDifferences: ['new home-banner seed row', 'new 024 schema_migrations row', 'content revision +1 and its updated_at', 'ID CHECK adds home-banner'],
    beforeHash: sha256(JSON.stringify(before)), afterHash: sha256(JSON.stringify(after)),
    identical: JSON.stringify(before) === JSON.stringify(after),
  });
  vi.stubEnv('POSTGRES_URL', url); vi.stubEnv('DATABASE_URL', url); vi.stubEnv('POSTGRES_SSL', 'disable'); vi.stubEnv('IHEAR_FORCE_FILE_STORE', '0');
  store = await import('../lib/media-gallery-store');
}, 120000);

afterAll(async () => {
  await closeStoreClients();
  if (upgradeDb) await upgradeDb.end({ timeout: 1 });
  if (rollbackDb) await rollbackDb.end({ timeout: 1 });
  if (db) await db.end({ timeout: 1 });
  if (started) {
    try {
      docker(['stop', '--time', '1', container]);
    } catch (error) {
      if (!/No such container/i.test(error.message)) throw error;
    }
  }
  vi.unstubAllEnvs();
}, 30000);

test('migration preserves every legacy gallery field, asset, operation and translation state', async () => {
  expect(before.galleries.map(g => g.id)).toEqual(legacyIds);
  expect(after).toEqual(before);
  expect(before.galleryAssets).toHaveLength(1);
  expect(before.operations).toHaveLength(1);
  expect(before.siteMedia).toHaveLength(1); expect(before.siteVariants).toHaveLength(1);
  expect(before.translations.some(state => state.resource_id === oldAssetSlot && state.origin === 'manual')).toBe(true);
  expect(await migrationHashes()).toEqual(historicalHashes);
  expect(Object.keys(historicalHashes)).toHaveLength(23);
  expect(ledgerBefore).toHaveLength(23);
  expect(ledgerBefore.at(-1).version).toBe('023');
  expect(ledgerAfter.filter(row => row.version !== '024')).toEqual(ledgerBefore);
  expect(ledgerAfter.find(row => row.version === '024')).toMatchObject({ name: '024_home_banner_gallery.sql', checksum: migrationChecksum(migration) });
  expect(ledgerAfter).toHaveLength(24);
  expect(revisionsAfter.filter(row => row.scope !== 'content')).toEqual(revisionsBefore.filter(row => row.scope !== 'content'));
  expect(Number(revisionsAfter.find(row => row.scope === 'content').revision)).toBe(Number(revisionsBefore.find(row => row.scope === 'content').revision) + 1);
});

test('actual PostgreSQL CHECK changes only gallery IDs and retains all previous constraints', async () => {
  const oldCheck = constraintsBefore.find(row => row.conname === 'media_galleries_id_check');
  const newCheck = constraintsAfter.find(row => row.conname === 'media_galleries_id_check');
  expect(oldCheck).toBeDefined(); expect(newCheck).toBeDefined();
  for (const id of legacyIds) { expect(oldCheck.definition).toContain(`'${id}'::text`); expect(newCheck.definition).toContain(`'${id}'::text`); }
  expect(oldCheck.definition).not.toContain('home-banner');
  expect(newCheck.definition).toContain("'home-banner'::text");
  expect(constraintsAfter.filter(row => row.conname !== oldCheck.conname)).toEqual(constraintsBefore.filter(row => row.conname !== oldCheck.conname));
  // Exercise the actual expanded CHECK for all six IDs without persisting probe
  // writes or their existing statement-trigger revision increments.
  const probeRollback = new Error('Roll back successful allowed-ID probes');
  await expect(db.begin(async tx => {
    for (const id of [...legacyIds, 'home-banner']) expect(await tx`UPDATE media_galleries SET id=${id} WHERE id=${id} RETURNING id`).toHaveLength(1);
    throw probeRollback;
  })).rejects.toBe(probeRollback);
  await expect(db`INSERT INTO media_galleries(id) VALUES ('unknown-gallery')`).rejects.toMatchObject({ code: '23514' });
  await expect(db`UPDATE media_galleries SET version=-1 WHERE id='home-banner'`).rejects.toMatchObject({ code: '23514' });
  await expect(db`UPDATE media_galleries SET items='{}'::jsonb WHERE id='home-banner'`).rejects.toMatchObject({ code: '23514' });
  const [{ enabled }] = await db`SELECT relrowsecurity AS enabled FROM pg_class WHERE oid='public.media_galleries'::regclass`;
  expect(enabled).toBe(true);
});

test('seed references home.hero once and missing title reads as null without rewriting old JSONB', async () => {
  const persistedBefore = await snapshot(db, false);
  const galleries = await store.listGalleries();
  expect(galleries).toHaveLength(6);
  expect(galleries.find(g => g.id === 'home-banner')).toMatchObject({ version: 0, items: [{ id: 'initial-home-banner', kind: 'photo', hidden: false, assetSlot: 'home.hero', title: null }] });
  expect(galleries.filter(g => g.id !== 'home-banner').flatMap(g => g.items).every(item => item.title === null)).toBe(true);
  expect(await snapshot(db, false)).toEqual(persistedBefore);
  expect(before.galleries.flatMap(g => g.items).every(item => !Object.hasOwn(item, 'title'))).toBe(true);
});

test('a forced post-DDL failure rolls back the new CHECK, seed and all existing rows', async () => {
  const previousRows = await snapshot(rollbackDb, false);
  const previousConstraints = await constraints(rollbackDb);
  const previousLedger = await ledger(rollbackDb);
  const previousRevisions = await revisions(rollbackDb);
  // Fail at the real runner's last statement, after 024's DDL and seed executed.
  // The trigger lives only in the disposable 023 clone, not a migration file.
  await rollbackDb.unsafe(`CREATE FUNCTION reject_024_ledger() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.version='024' THEN RAISE EXCEPTION 'Injected 024 ledger failure'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER reject_024_ledger BEFORE INSERT ON schema_migrations FOR EACH ROW EXECUTE FUNCTION reject_024_ledger();`);
  const failed = runMigrations(rollbackUrl);
  expect(failed).toMatchObject({ exitCode: 1, connected: false, code: 'P0001', message: 'Injected 024 ledger failure' });
  const rolledBack = { rows: await snapshot(rollbackDb, false), constraints: await constraints(rollbackDb), ledger: await ledger(rollbackDb), revisions: await revisions(rollbackDb) };
  expect(rolledBack.constraints).toEqual(previousConstraints);
  expect(rolledBack.rows).toEqual(previousRows);
  expect(rolledBack.ledger).toEqual(previousLedger);
  expect(rolledBack.revisions).toEqual(previousRevisions);
  expect(rolledBack.ledger.some(row => row.version === '024')).toBe(false);
  expect(rolledBack.rows.galleries.some(row => row.id === 'home-banner')).toBe(false);
  expect(previousConstraints.find(row => row.conname === 'media_galleries_id_check').definition).not.toContain('home-banner');
  await rollbackDb.unsafe('DROP TRIGGER reject_024_ledger ON schema_migrations; DROP FUNCTION reject_024_ledger();');
  const retry = runMigrations(rollbackUrl);
  expect(retry).toMatchObject({ exitCode: 0, connected: true, applied: ['024_home_banner_gallery.sql'], totalTracked: 24 });
  expect(await snapshot(rollbackDb)).toEqual(previousRows);
  expect((await ledger(rollbackDb)).filter(row => row.version !== '024')).toEqual(previousLedger);
  await evidence('runner-rollback', {
    boundary: 'Actual runner transaction contains migration SQL and schema_migrations INSERT',
    before: { rows: previousRows, constraints: previousConstraints, ledger: previousLedger, revisions: previousRevisions },
    failure: failed, rolledBack, retry,
    committedRecovery: 'No down migration performed. Restore a verified pre-upgrade backup to a separate database or design a forward repair; preserve committed banner data.',
  });
}, 30000);

test('existing migration 019 database retries a failed local upgrade and preserves an empty banner on restart', async () => {
  const legacySnapshot = await snapshot(upgradeDb);
  const previousConstraints = await constraints(upgradeDb);
  expect((await constraints(upgradeDb)).find(row => row.conname === 'media_galleries_id_check').definition).not.toContain('home-banner');
  await upgradeDb.unsafe(`CREATE FUNCTION reject_banner_seed() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.id='home-banner' THEN RAISE EXCEPTION 'Injected seed failure'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER reject_banner_seed BEFORE INSERT ON media_galleries FOR EACH ROW EXECUTE FUNCTION reject_banner_seed();`);
  await closeStoreClients();
  vi.stubEnv('POSTGRES_URL', upgradeUrl); vi.stubEnv('DATABASE_URL', upgradeUrl); vi.resetModules();
  try {
    const localStore = await import('../lib/media-gallery-store');
    await expect(localStore.listGalleries()).rejects.toMatchObject({ code: 'P0001' });
    expect(await snapshot(upgradeDb, false)).toEqual(legacySnapshot);
    expect(await constraints(upgradeDb)).toEqual(previousConstraints);
    await upgradeDb.unsafe('DROP TRIGGER reject_banner_seed ON media_galleries; DROP FUNCTION reject_banner_seed();');
    expect((await localStore.listGalleries()).map(g => g.id).sort()).toEqual([...legacyIds, 'home-banner'].sort());
    expect(await snapshot(upgradeDb)).toEqual(legacySnapshot);
    await upgradeDb`UPDATE media_galleries SET items='[]'::jsonb,version=9,updated_by=${actor},updated_at='2025-02-03T04:05:06Z' WHERE id='home-banner'`;
    const cleared = await snapshot(upgradeDb, false);
    await closeStoreClients();
    expect((await localStore.listGalleries()).find(g => g.id === 'home-banner')).toMatchObject({ version: 9, items: [], updatedBy: actor });
    expect(await snapshot(upgradeDb, false)).toEqual(cleared);
  } finally {
    await closeStoreClients(); vi.stubEnv('POSTGRES_URL', url); vi.stubEnv('DATABASE_URL', url);
  }
});

test('PostgreSQL put, lost response replay, changed replay and concurrent version conflicts remain compatible', async () => {
  const body = mutation('home', 0);
  const saved = await store.mutateGallery(body);
  expect(saved.replayed).toBe(false); expect(saved.gallery.version).toBe(1);
  expect(saved.gallery.items.at(-1)).toMatchObject({ kind: 'youtube', title: null, caption });
  const replay = await store.mutateGallery(body);
  expect(replay.replayed).toBe(true);
  expect(replay.gallery).toMatchObject({ id: saved.gallery.id, version: saved.gallery.version, items: saved.gallery.items, updatedBy: saved.gallery.updatedBy });
  await expect(store.mutateGallery({ ...body, fingerprint: 'changed-payload' })).rejects.toMatchObject({ status: 409 });
  await expect(store.operationStatus(body.operationId, 'home', 'other@example.com')).rejects.toMatchObject({ status: 409 });
  const contenders = [mutation('stories', 0), mutation('stories', 0)];
  const conflict = await concurrentMutations(contenders, { galleryId: 'stories' });
  const { outcomes } = conflict;
  expect(outcomes.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  expect(outcomes.find(result => result.status === 'rejected').reason).toMatchObject({ status: 409 });
  const operations = await Promise.all(contenders.map(input => store.operationStatus(input.operationId, 'stories', actor)));
  expect(operations.filter(Boolean)).toHaveLength(1);
  const winnerIndex = outcomes.findIndex(result => result.status === 'fulfilled');
  const [persistedWinner] = await db`SELECT * FROM media_galleries WHERE id='stories'`;
  expect(persistedWinner.version).toBe(1);
  expect(persistedWinner.items.map(item => item.id)).toEqual(['initial-stories', contenders[winnerIndex].item.id]);
  expect(operations[winnerIndex]).toMatchObject({ galleryId: 'stories', actor, fingerprint: contenders[winnerIndex].fingerprint });
  expect(operations[1 - winnerIndex]).toBeNull();
  const duplicate = mutation('outreach', 0);
  const duplicateRun = await concurrentMutations([duplicate, duplicate], { operationId: duplicate.operationId });
  expect(duplicateRun.outcomes.every(result => result.status === 'fulfilled')).toBe(true);
  const duplicates = duplicateRun.outcomes.map(result => result.value);
  expect(duplicates.map(result => result.replayed).sort()).toEqual([false, true]);
  expect(duplicates.every(result => result.gallery.version === 1 && result.gallery.items.length === 2)).toBe(true);
  const duplicateOperations = Array.from(await db`SELECT * FROM media_gallery_operations WHERE id=${duplicate.operationId}`);
  expect(duplicateOperations).toHaveLength(1);
  const [persistedDuplicate] = await db`SELECT * FROM media_galleries WHERE id='outreach'`;
  expect(persistedDuplicate.version).toBe(1);
  expect(persistedDuplicate.items.filter(item => item.id === duplicate.item.id)).toHaveLength(1);

  // A failure after the gallery UPDATE must not leave an update without its
  // operation record. The identical request can then be retried safely.
  const rejected = mutation('stories', 1);
  const atomicBefore = { rows: await snapshot(db, false), revisions: await revisions(db) };
  await db.unsafe(`CREATE FUNCTION reject_gallery_operation() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'Injected operation log failure'; END $$;
    CREATE TRIGGER reject_gallery_operation BEFORE INSERT ON media_gallery_operations FOR EACH ROW EXECUTE FUNCTION reject_gallery_operation();`);
  await expect(store.mutateGallery(rejected)).rejects.toMatchObject({ code: 'P0001' });
  const atomicAfter = { rows: await snapshot(db, false), revisions: await revisions(db) };
  expect(atomicAfter).toEqual(atomicBefore);
  expect(await store.operationStatus(rejected.operationId, 'stories', actor)).toBeNull();
  await db.unsafe('DROP TRIGGER reject_gallery_operation ON media_gallery_operations; DROP FUNCTION reject_gallery_operation();');
  const retried = await store.mutateGallery(rejected);
  expect(retried).toMatchObject({ replayed: false, gallery: { version: 2 } });
  expect(await store.operationStatus(rejected.operationId, 'stories', actor)).toMatchObject({ fingerprint: rejected.fingerprint });
  await evidence('concurrency', {
    mode: 'Real PG store; two independent max:1 PostgreSQL clients with distinct backend PIDs and simultaneous database-lock waits',
    conflict: { pids: conflict.pids, observedWaiters: conflict.observedWaiters, outcomes: outcomes.map(result => result.status === 'fulfilled' ? { status: result.status, replayed: result.value.replayed } : { status: result.status, httpStatus: result.reason.status }), persistedWinner, operations },
    simultaneousRetry: { pids: duplicateRun.pids, observedWaiters: duplicateRun.observedWaiters, replayed: duplicates.map(result => result.replayed), persistedDuplicate, operations: duplicateOperations },
    operationLogRollback: { before: atomicBefore, after: atomicAfter, retryVersion: retried.gallery.version },
  });
}, 30000);

test('multilingual title, move and remove preserve retained assets and provenance', async () => {
  const input = mutation('tutoring', 7, { item: { id: randomUUID(), kind: 'photo', hidden: false, assetSlot: oldAssetSlot, caption, title } });
  const assetsBefore = await store.getGalleryAsset(oldAssetSlot);
  const saved = await store.mutateGallery(input);
  expect(saved.gallery.items.at(-1).title).toEqual(title);
  const moved = await store.mutateGallery(mutation('tutoring', 8, { action: 'move', item: undefined, itemId: input.item.id, direction: -1 }));
  expect(moved.gallery.items[1]).toMatchObject({ id: input.item.id, title });
  await expect(store.mutateGallery(mutation('tutoring', 8, { action: 'remove', item: undefined, itemId: input.item.id }))).rejects.toMatchObject({ status: 409 });
  const removed = await store.mutateGallery(mutation('tutoring', 9, { action: 'remove', item: undefined, itemId: input.item.id }));
  expect(removed.gallery.items).toHaveLength(2);
  expect(await store.getGalleryAsset(oldAssetSlot)).toEqual(assetsBefore);
  expect(await store.operationStatus(oldOperationId, 'tutoring', actor)).toEqual({ galleryId: 'tutoring', actor, fingerprint: 'retained-fingerprint' });
  const persisted = await snapshot(db);
  expect(persisted.galleryAssets).toEqual(before.galleryAssets);
  expect(persisted.translations).toEqual(before.translations);
});

test('legacy payload omission preserves a saved title and explicit null clears it in PostgreSQL', async () => {
  const item = { id: randomUUID(), kind: 'youtube', hidden: false, videoId: 'LsQWwDBLKUc', caption, title };
  await store.mutateGallery(mutation('impact', 0, { item }));
  const oldPayload = { ...item }; delete oldPayload.title;
  const retained = await store.mutateGallery(mutation('impact', 1, { item: oldPayload }));
  expect(retained.gallery.items[0].title).toEqual(title);
  const retainedRead = (await store.listGalleries()).find(gallery => gallery.id === 'impact');
  expect(retainedRead.items[0].title).toEqual(title);
  const [retainedRow] = await db`SELECT items FROM media_galleries WHERE id='impact'`;
  expect(retainedRow.items[0].title).toEqual(title);
  const cleared = await store.mutateGallery(mutation('impact', 2, { item: { ...oldPayload, title: null } }));
  expect(cleared.gallery.items[0].title).toBeNull();
  const [row] = await db`SELECT items FROM media_galleries WHERE id='impact'`;
  expect(row.items[0].title).toBeNull();
  expect((await store.listGalleries()).find(gallery => gallery.id === 'impact').items[0].title).toBeNull();
  const empty = { en: '', zhHant: '', zhHans: '' };
  await store.mutateGallery(mutation('impact', 3, { item: { ...oldPayload, title: empty } }));
  const emptyRead = (await store.listGalleries()).find(gallery => gallery.id === 'impact');
  expect(emptyRead.items[0].title).toEqual(empty);
  const [emptyRow] = await db`SELECT items FROM media_galleries WHERE id='impact'`;
  expect(emptyRow.items[0].title).toEqual(empty);
  await evidence('title-roundtrip', { omittedRetains: retainedRow.items[0].title, explicitNull: row.items[0].title, emptyStrings: emptyRow.items[0].title });
});

test('reapplying migration preserves an administrator-cleared banner and every saved field', async () => {
  await store.mutateGallery(mutation('home-banner', 0, { action: 'remove', item: undefined, itemId: 'initial-home-banner' }));
  const cleared = await snapshot(db, false);
  const clearedLedger = await ledger(db), clearedRevisions = await revisions(db);
  const reruns = [runMigrations(url), runMigrations(url)];
  for (const result of reruns) expect(result).toMatchObject({ exitCode: 0, connected: true, applied: [], totalTracked: 24 });
  await closeStoreClients();
  expect(await snapshot(db, false)).toEqual(cleared);
  expect((await store.listGalleries()).find(g => g.id === 'home-banner')).toMatchObject({ version: 1, items: [], updatedBy: actor });
  expect(await snapshot(db, false)).toEqual(cleared);
  expect(await ledger(db)).toEqual(clearedLedger);
  expect(await revisions(db)).toEqual(clearedRevisions);
  expect(await migrationHashes()).toEqual(historicalHashes);
  await evidence('empty-banner-restart', { before: cleared, after: await snapshot(db, false), ledgerUnchanged: true, revisionsUnchanged: true, runnerReruns: reruns });
}, 30000);
