// CP6: committed 024 recovery rehearsal. Never reads .env or accepts a DB URL.
// The only write targets are two databases in this invocation's disposable PG17 container.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import postgres from 'postgres';
import { migrationChecksum } from './migration-checksum.mjs';

if (process.argv.length !== 2) throw new Error('Usage: node scripts/rehearse-home-focus-recovery.mjs (no database parameters accepted)');
const repository = process.cwd();
const runId = randomUUID();
const directory = path.join(repository, 'output/cp6-home-focus/recovery', runId);
const runnerDirectory = path.join(directory, 'runner');
const container = `ihear-cp6-recovery-${runId}`;
const image = 'postgres:17-alpine';
const password = randomUUID();
const connections = [];
const commands = [];
const checks = [];
const sha256 = value => createHash('sha256').update(value).digest('hex');
const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const hash = value => sha256(JSON.stringify(canonical(value)));
const equal = (left, right) => hash(left) === hash(right);
const save = (name, value) => writeFile(path.join(directory, `${name}.json`), `${JSON.stringify(value, null, 2)}\n`);
const redact = value => String(value || '').replaceAll(password, '<redacted>').replace(/postgres(?:ql)?:\/\/[^\s"']+/g, '<disposable-db-url>');
let started = false;
let passed = false;
let environment;
let backup;
let failure;

await mkdir(path.join(runnerDirectory, 'db/migrations'), { recursive: true });
function command(program, args, options = {}) {
  const result = spawnSync(program, args, { encoding: 'utf8', windowsHide: true, timeout: 60000, maxBuffer: 32 * 1024 * 1024, ...options });
  commands.push({ program: path.basename(program), args: args.map(redact), cwd: path.relative(repository, options.cwd || repository) || '.', exitCode: result.status,
    environment: options.env ? Object.fromEntries(['POSTGRES_URL', 'DATABASE_URL', 'POSTGRES_PASSWORD', 'POSTGRES_SSL', 'IHEAR_FORCE_FILE_STORE', 'NODE_ENV']
      .filter(name => Object.hasOwn(options.env, name)).map(name => [name, /URL|PASSWORD/.test(name) ? '<explicit disposable target/credential>' : options.env[name]])) : undefined,
    stdout: redact(result.stdout), stderr: redact(result.stderr), error: result.error?.code });
  if (result.status !== 0 || result.error) throw new Error(`${path.basename(program)} ${args[0]} failed (exit ${result.status}, ${result.error?.code || 'see commands.json'})`);
  return result.stdout.trim();
}
const docker = args => command('docker', args);
function check(name, result) {
  checks.push({ name, pass: Boolean(result) });
  if (!result) throw new Error(name);
}
function client(database, port) {
  const url = `postgres://postgres:${password}@127.0.0.1:${port}/${database}`;
  const sql = postgres(url, { ssl: false, max: 1, prepare: false, connect_timeout: 2, onnotice: () => {} });
  connections.push(sql);
  return { url, sql };
}
function isolatedEnv(url) {
  return { ...process.env, NODE_ENV: 'test', POSTGRES_URL: url, DATABASE_URL: url, POSTGRES_SSL: 'disable', IHEAR_FORCE_FILE_STORE: '0' };
}
function migrate(url) {
  const output = command(process.execPath, [path.join(repository, 'scripts/migrate-database.mjs')], { cwd: runnerDirectory, env: isolatedEnv(url) });
  const result = output.split(/\r?\n/).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } }).find(item => typeof item.connected === 'boolean');
  assert.equal(result?.connected, true);
  return result;
}

// Server JSON avoids JavaScript Date's millisecond truncation of ledger timestamps.
// Sort database ROW sets deterministically; never reorder arrays INSIDE JSONB values.
async function snapshot(sql) {
  return sql.begin('isolation level repeatable read read only', async tx => {
    const relations = await tx`SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relkind IN ('r','p') ORDER BY c.relname`;
    const tables = {};
    const rawRows = {};
    for (const { name } of relations) {
      assert.match(name, /^[a-z_][a-z0-9_]*$/);
      const rows = await tx.unsafe(`SELECT to_jsonb(t)::text AS value FROM public."${name}" t ORDER BY to_jsonb(t)::text COLLATE "C"`);
      rawRows[name] = rows.map(row => row.value);
      tables[name] = rawRows[name].map(value => JSON.parse(value));
    }
    const schema = {
      columns: Array.from(await tx`SELECT c.relname AS table_name,a.attname AS column_name,a.attnum,format_type(a.atttypid,a.atttypmod) AS type,
        a.attnotnull AS not_null,a.attidentity AS identity,a.attgenerated AS generated,pg_get_expr(d.adbin,d.adrelid) AS default_expression,
        col_description(c.oid,a.attnum) AS comment
        FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
        LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum
        WHERE n.nspname='public' AND c.relkind IN ('r','p') AND a.attnum>0 AND NOT a.attisdropped ORDER BY c.relname,a.attnum`),
      constraints: Array.from(await tx`SELECT c.relname AS table_name,p.conname AS name,p.contype AS type,pg_get_constraintdef(p.oid,true) AS definition,
        p.convalidated AS validated,p.condeferrable AS deferrable,p.condeferred AS deferred FROM pg_constraint p
        JOIN pg_class c ON c.oid=p.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='public' ORDER BY c.relname,p.conname`),
      indexes: Array.from(await tx`SELECT tablename,indexname,indexdef FROM pg_indexes WHERE schemaname='public' ORDER BY tablename,indexname`),
      relations: Array.from(await tx`SELECT c.relname AS name,c.relkind AS kind,c.relrowsecurity AS row_security,c.relforcerowsecurity AS force_row_security,
        obj_description(c.oid,'pg_class') AS comment FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='public' AND c.relkind IN ('r','p','S','v','m') ORDER BY c.relname`),
      triggers: Array.from(await tx`SELECT c.relname AS table_name,t.tgname AS name,t.tgenabled AS enabled,pg_get_triggerdef(t.oid) AS definition
        FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='public' AND NOT t.tgisinternal ORDER BY c.relname,t.tgname`),
      functions: Array.from(await tx`SELECT p.proname AS name,pg_get_function_identity_arguments(p.oid) AS arguments,pg_get_functiondef(p.oid) AS definition
        FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.prokind IN ('f','p') ORDER BY p.proname,arguments`),
      policies: Array.from(await tx`SELECT tablename,policyname,permissive,roles,cmd,qual,with_check FROM pg_policies WHERE schemaname='public' ORDER BY tablename,policyname`),
      sequences: Array.from(await tx`SELECT sequencename,data_type,start_value,min_value,max_value,increment_by,cycle,cache_size,last_value
        FROM pg_sequences WHERE schemaname='public' ORDER BY sequencename`),
    };
    // Raw canonical PostgreSQL JSON is also compared, so numeric values outside
    // JavaScript's safe integer range cannot silently compare equal after rounding.
    return { tables, rawRows, schema };
  });
}

async function rawConstraints(sql) {
  return Array.from(await sql`SELECT c.relname AS table_name,p.conname AS name,pg_get_constraintdef(p.oid,false) AS definition
    FROM pg_constraint p JOIN pg_class c ON c.oid=p.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' ORDER BY c.relname,p.conname`);
}

function compare(left, right) {
  return { equal: equal(left, right), beforeHash: hash(left), afterHash: hash(right),
    tables: [...new Set([...Object.keys(left.tables), ...Object.keys(right.tables)])].sort().map(name => ({ name, beforeCount: left.tables[name]?.length,
      afterCount: right.tables[name]?.length, equal: equal(left.tables[name] ?? null, right.tables[name] ?? null),
      exactServerJsonEqual: equal(left.rawRows[name] ?? null, right.rawRows[name] ?? null) })),
    schema: Object.keys(left.schema).map(name => ({ name, equal: equal(left.schema[name], right.schema[name]) })),
    method: 'Exact structural values; canonical object keys; row sets deterministically ordered; embedded arrays preserve order; server JSON preserves numeric values and timestamp microseconds; constraint definitions use PostgreSQL pretty deparser (raw definitions retained separately)' };
}

async function verifyDatabase(db, label, phase, baseline) {
  const before = await snapshot(db.sql);
  const args = [path.join(repository, 'scripts/verify-gallery-deployment.mjs'), '--phase', phase,
    '--snapshot-output', path.join(directory, `${label}-deployment.json`)];
  if (baseline) args.push('--baseline', path.join(directory, baseline));
  // Keep the working directory env-free while the verifier resolves its schema sources from its module location.
  command(process.execPath, args, { cwd: runnerDirectory, env: isolatedEnv(db.url) });
  const after = await snapshot(db.sql);
  const diff = compare(before, after);
  await save(`${label}-verifier-readonly`, diff);
  check(`${label}: deployment verification changes no rows or schema`, diff.equal);
}

async function seed(sql) {
  const localized = { en: 'Recovery fixture <&> 😃', zhHant: '備份復原原值', zhHans: '' };
  for (const [index, id] of ['tutoring', 'outreach', 'home', 'stories', 'impact'].entries()) {
    const items = [
      { id: `${id}-last-first`, kind: 'youtube', hidden: index === 1, videoId: 'LsQWwDBLKUc', caption: localized },
      { id: `${id}-first-last`, kind: 'photo', hidden: false, assetSlot: `recovery.${id}`, caption: localized, title: index === 2 ? null : { en: 'Optional title', zhHant: '', zhHans: '标题' }, fixtureMetadata: { arrayOrder: [3, 1, 2] } },
    ];
    await sql`UPDATE public.media_galleries SET version=${7 + index},items=${sql.json(items)},updated_by='recovery-test',updated_at='2026-10-01T12:34:56.123456Z' WHERE id=${id}`;
    await sql`INSERT INTO public.media_gallery_assets(slot,payload) VALUES (${`recovery.${id}`},${sql.json({ asset: { slot: `recovery.${id}`, alt: localized, variants: [{ width: 800, pixelWidth: 800, pixelHeight: 450, byteSize: 1234, mimeType: 'image/webp', url: '/fixture.webp', storagePath: 'fixture.webp' }], focalX: 50, focalY: 50, zoom: 100, recordVersion: 2 }, states: [] })})`;
    await sql`INSERT INTO public.media_gallery_operations(id,gallery_id,actor,fingerprint,created_at) VALUES (${randomUUID()},${id},'recovery-test','preserve-replay-history','2026-10-01T12:34:56.123456Z')`;
  }
  await sql`UPDATE public.resource_topics SET status='published',version=3,updated_by='recovery-test',updated_at='2026-10-01T12:34:56.654321Z' WHERE id='announcements'`;
  for (const [index, topic] of ['announcements', 'calendar', 'forms', 'articles'].entries()) {
    await sql`INSERT INTO public.resource_links(id,title,description,url,sort_order,status,version,created_by,updated_by,created_at,updated_at,category,topic_id,type)
      VALUES (${`recovery-${topic}`},${sql.json(localized)},${sql.json(localized)},'',${30 - index},${index === 1 ? 'draft' : 'published'},4,
      'recovery-test','recovery-test','2026-10-01T12:34:56.123456Z','2026-10-01T12:34:56.654321Z',${index === 3 ? 'article' : 'form'},${topic},'text')`;
  }
  await sql`UPDATE public.site_content_revisions SET revision=9007199254741001,updated_at='2026-10-01T12:34:56.123456Z' WHERE scope='impact'`;
}

try {
  const migrationFiles = (await readdir('db/migrations')).filter(name => /^\d+_.*\.sql$/.test(name)).sort();
  check('Exactly the accepted 24 migrations are present', migrationFiles.length === 24 && migrationFiles.at(-1) === '024_home_banner_gallery.sql');
  const migrationHashes = {};
  for (const name of migrationFiles) {
    const bytes = await readFile(path.join(repository, 'db/migrations', name));
    migrationHashes[name] = { bytes: sha256(bytes), checksum: migrationChecksum(bytes.toString('utf8')) };
    if (!name.startsWith('024_')) await writeFile(path.join(runnerDirectory, 'db/migrations', name), bytes);
  }
  await save('migration-hashes', migrationHashes);
  environment = { docker: JSON.parse(docker(['version', '--format', '{{json .}}'])), image: JSON.parse(docker(['image', 'inspect', '--format', '{{json .RepoDigests}}', image])), node: process.version,
    os: process.platform, isolation: 'Unique disposable container; no host volume; PostgreSQL published only on loopback; explicit generated URLs; no .env read' };
  started = true;
  command('docker', ['run', '--detach', '--rm', '--pull=never', '--name', container, '--label', 'ihear-test=cp6-recovery', '-p', '127.0.0.1::5432', '-e', 'POSTGRES_PASSWORD', image],
    { env: { ...process.env, POSTGRES_PASSWORD: password } });
  const [binding] = JSON.parse(docker(['inspect', '--format', '{{json (index .NetworkSettings.Ports "5432/tcp")}}', container]));
  check('PostgreSQL test port is loopback-only', binding.HostIp === '127.0.0.1' && /^\d+$/.test(binding.HostPort));
  const maintenance = client('postgres', binding.HostPort);
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    try { await maintenance.sql`SELECT 1`; ready = true; break; } catch { await new Promise(resolve => { setTimeout(resolve, 500); }); }
  }
  check('Disposable PostgreSQL accepts a real SQL connection', ready);
  [environment.server] = await maintenance.sql`SELECT version() AS version,current_setting('server_version_num')::integer AS version_number`;
  check('Actual PostgreSQL major version is 17', Math.floor(environment.server.version_number / 10000) === 17);
  environment.pgDump = docker(['exec', container, 'pg_dump', '--version']);
  environment.pgRestore = docker(['exec', container, 'pg_restore', '--version']);
  environment.psql = docker(['exec', container, 'psql', '--version']);
  await save('environment', environment);
  await maintenance.sql.unsafe('CREATE DATABASE cp6_upgrade');
  await maintenance.sql.unsafe('CREATE DATABASE cp6_restore TEMPLATE template0');
  const source = client('cp6_upgrade', binding.HostPort);
  const restored = client('cp6_restore', binding.HostPort);
  const baselineRunner = migrate(source.url);
  check('Actual runner creates the pre-upgrade 023 schema and ledger', baselineRunner.totalTracked === 23 && baselineRunner.applied.length === 23);
  await seed(source.sql);
  const before = await snapshot(source.sql);
  const beforeConstraintsRaw = await rawConstraints(source.sql);
  await save('before-023-constraints-raw', beforeConstraintsRaw);
  check('Fixture preserves a bigint revision beyond JavaScript safe integer range', before.rawRows.site_content_revisions.some(row => row.includes('9007199254741001')));
  await save('before-023', before);
  await verifyDatabase(source, 'before-023', 'pre-024');
  docker(['exec', container, 'pg_dump', '-U', 'postgres', '-d', 'cp6_upgrade', '--format=custom', '--schema=public', '--no-owner', '--no-acl', '--file=/tmp/cp6-pre024.dump']);
  docker(['cp', `${container}:/tmp/cp6-pre024.dump`, path.join(directory, 'pre024.dump')]);
  const archive = await readFile(path.join(directory, 'pre024.dump'));
  const toc = docker(['exec', container, 'pg_restore', '--list', '/tmp/cp6-pre024.dump']);
  await writeFile(path.join(directory, 'backup-toc.txt'), `${toc}\n`);
  backup = { format: 'PostgreSQL custom archive', scope: 'Complete public application schema (--schema=public), including all public tables', file: 'pre024.dump', bytes: archive.length, sha256: sha256(archive), transactionSnapshot: 'pg_dump consistent snapshot; all writers frozen for the full rehearsal',
    excludes: ['non-public managed schemas, including Supabase auth/storage', 'cluster roles/ownership and ACL restoration (--no-owner --no-acl)', 'external object-storage image bytes'], restoreTarget: 'Distinct empty cp6_restore database' };
  await save('backup', backup);
  check('Custom-format dump includes resources, revisions and migration ledger', ['resource_topics', 'site_content_revisions', 'schema_migrations', 'media_galleries'].every(name => toc.includes(`TABLE DATA public ${name}`)));
  check('Backup is read-only and no writes occurred before migration', equal(before, await snapshot(source.sql)));
  await writeFile(path.join(runnerDirectory, 'db/migrations/024_home_banner_gallery.sql'), await readFile('db/migrations/024_home_banner_gallery.sql'));
  const upgradeRunner = migrate(source.url);
  check('Actual runner commits only migration 024', upgradeRunner.totalTracked === 24 && equal(upgradeRunner.applied, ['024_home_banner_gallery.sql']));
  const upgraded = await snapshot(source.sql);
  await save('after-024-constraints-raw', await rawConstraints(source.sql));
  await save('after-024-committed', upgraded);
  check('Independent post-runner connection sees committed 024 ledger and Banner row', upgraded.tables.schema_migrations.some(row => row.version === '024') && upgraded.tables.media_galleries.some(row => row.id === 'home-banner'));
  const expected = structuredClone(upgraded);
  expected.tables.media_galleries = expected.tables.media_galleries.filter(row => row.id !== 'home-banner');
  expected.tables.schema_migrations = expected.tables.schema_migrations.filter(row => row.version !== '024');
  expected.rawRows.media_galleries = expected.rawRows.media_galleries.filter(row => JSON.parse(row).id !== 'home-banner');
  expected.rawRows.schema_migrations = expected.rawRows.schema_migrations.filter(row => JSON.parse(row).version !== '024');
  const beforeRevision = before.tables.site_content_revisions.find(row => row.scope === 'content');
  const afterRevision = upgraded.tables.site_content_revisions.find(row => row.scope === 'content');
  check('024 seed produces exactly the existing content revision increment', Number(afterRevision.revision) === Number(beforeRevision.revision) + 1);
  expected.tables.site_content_revisions = expected.tables.site_content_revisions.map(row => row.scope === 'content' ? beforeRevision : row);
  expected.rawRows.site_content_revisions = expected.rawRows.site_content_revisions.map(row => JSON.parse(row).scope === 'content'
    ? before.rawRows.site_content_revisions.find(item => JSON.parse(item).scope === 'content') : row);
  expected.schema.constraints = expected.schema.constraints.map(row => row.table_name === 'media_galleries' && row.name === 'media_galleries_id_check'
    ? before.schema.constraints.find(item => item.table_name === row.table_name && item.name === row.name) : row);
  const upgradeDiff = compare(before, expected);
  await save('upgrade-preservation', { ...upgradeDiff, allowedDifferences: ['one home-banner seed row', 'one 024 ledger row', 'expanded media_galleries_id_check', 'content revision +1 and its timestamp'], baselineRunner, upgradeRunner });
  check('All prior values and schema remain unchanged except the four explicit 024 effects', upgradeDiff.equal);
  await verifyDatabase(source, 'after-024', 'post-024', 'before-023-deployment.json');
  const [{ objects: restoreObjects }] = await restored.sql`SELECT
    (SELECT count(*) FROM pg_class WHERE relnamespace='public'::regnamespace)
    + (SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace) AS objects`;
  check('Distinct restore database has an empty public schema', Number(restoreObjects) === 0);
  // --schema=public archives include CREATE SCHEMA public. A template0 DB still
  // has an empty public schema: drop only that empty schema, without CASCADE.
  // Never apply this step to the source DB or to a pre-existing recovery target.
  docker(['exec', container, 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'cp6_restore', '-c', 'DROP SCHEMA public']);
  docker(['exec', container, 'pg_restore', '--exit-on-error', '--single-transaction', '--no-owner', '--no-acl', '-U', 'postgres', '--dbname=cp6_restore', '/tmp/cp6-pre024.dump']);
  const recovered = await snapshot(restored.sql);
  const restoredConstraintsRaw = await rawConstraints(restored.sql);
  await save('restored-023-constraints-raw', restoredConstraintsRaw);
  await save('constraint-deparser-comparison', {
    method: 'pg_get_constraintdef(oid,true) preserves AND/OR precedence while avoiding non-semantic parenthesis grouping introduced by pg_dump reparsing BETWEEN; no hand-written SQL normalization',
    prettyDefinitionsEqual: equal(before.schema.constraints, recovered.schema.constraints),
    rawDefinitionDifferences: beforeConstraintsRaw.flatMap(original => {
      const restored = restoredConstraintsRaw.find(row => row.table_name === original.table_name && row.name === original.name);
      return equal(original, restored) ? [] : [{ before: original, after: restored }];
    }),
  });
  await save('restored-023', recovered);
  const recoveryDiff = compare(before, recovered);
  await save('restore-diff', recoveryDiff);
  check('Restored database matches backup-time data, array order, constraints, revisions and migration ledger exactly', recoveryDiff.equal);
  check('Restore returns to 023 while original source remains committed at 024', !recovered.tables.schema_migrations.some(row => row.version === '024') && !recovered.tables.media_galleries.some(row => row.id === 'home-banner') && equal(upgraded, await snapshot(source.sql)));
  await verifyDatabase(restored, 'restored-023', 'pre-024', 'before-023-deployment.json');
  for (const [name, original] of Object.entries(migrationHashes)) {
    const bytes = await readFile(path.join(repository, 'db/migrations', name));
    check(`Migration bytes and checksum preserved: ${name}`, sha256(bytes) === original.bytes && migrationChecksum(bytes.toString('utf8')) === original.checksum);
  }
  passed = true;
} catch (error) {
  failure = redact(error?.message || error);
  process.exitCode = 1;
} finally {
  await Promise.allSettled(connections.map(sql => sql.end({ timeout: 2 })));
  if (started) {
    try {
      docker(['stop', '--time', '1', container]);
      const remaining = docker(['ps', '-a', '--filter', `name=^/${container}$`, '--format', '{{.ID}}']);
      check('Only this rehearsal container removed after connections close', remaining === '');
    } catch (error) { passed = false; failure = `${failure || ''} Cleanup: ${redact(error.message)}`; process.exitCode = 1; }
  }
  await save('commands', commands);
  const result = { status: passed ? 'PASS' : 'FAIL', runId, container, productionDatabaseContacted: false, applicationStoreImported: false, checks,
    passed: checks.filter(item => item.pass).length, failed: checks.filter(item => !item.pass).length, skipped: 0, exitCode: process.exitCode || 0,
    failure, backup, limitations: ['No production restore or connection switch', 'No exact older application compatibility claim', 'Managed non-public schemas, roles/ownership/ACL and external image-object storage require separate deployment controls'] };
  await save('report', result);
  console.log(JSON.stringify({ status: result.status, passed: result.passed, failed: result.failed, skipped: 0, exitCode: result.exitCode, report: path.relative(repository, path.join(directory, 'report.json')), failure }));
}
