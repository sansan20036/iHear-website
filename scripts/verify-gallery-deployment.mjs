import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { migrationChecksum } from './migration-checksum.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const LEGACY_GALLERY_IDS = ['tutoring', 'outreach', 'home', 'stories', 'impact'];
export const REQUIRED_TOPIC_SLUGS = { announcements: 'announcements', calendar: 'calendar' };
const requiredTables = ['media_galleries', 'media_gallery_assets', 'media_gallery_operations', 'schema_migrations', 'site_content_revisions', 'resource_topics', 'resource_links', 'localized_translation_states'];
export const canonical = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const hash = value => createHash('sha256').update(canonical(value)).digest('hex');
const sortedRows = rows => [...rows].sort((a, b) => canonical(a).localeCompare(canonical(b)));
const same = (a, b) => canonical(a) === canonical(b);
function requireValue(condition, message) { if (!condition) throw new Error(message); }
const compact = value => value.replace(/\s+/g, '');

export function parseArguments(argv) {
  const options = { phase: '', baseline: '', snapshotOutput: '', databaseEnv: 'POSTGRES_URL' };
  const keys = { '--phase': 'phase', '--baseline': 'baseline', '--snapshot-output': 'snapshotOutput', '--database-env': 'databaseEnv' };
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--help') return { help: true };
    const key = keys[argv[index]];
    requireValue(key && argv[index + 1] && !argv[index + 1].startsWith('--'), 'Use --phase pre-024|post-024 [--baseline snapshot.json] [--snapshot-output snapshot.json] [--database-env POSTGRES_URL]. Legacy positional JSON backups omit topics/revisions; create a new read-only snapshot and a native PostgreSQL dump instead.');
    options[key] = argv[++index];
  }
  requireValue(['pre-024', 'post-024'].includes(options.phase), 'Specify --phase pre-024 or post-024 explicitly.');
  requireValue(/^[A-Z][A-Z0-9_]*$/.test(options.databaseEnv), 'Invalid database environment-variable name.');
  if (options.baseline && options.snapshotOutput) requireValue(path.resolve(options.baseline) !== path.resolve(options.snapshotOutput), 'Do not overwrite the baseline snapshot.');
  return options;
}

export async function migrationManifest() {
  const directory = path.join(root, 'db/migrations');
  const files = (await readdir(directory)).filter(name => /^\d+_[a-z0-9_]+\.sql$/i.test(name)).sort();
  return Promise.all(files.map(async name => {
    const bytes = await readFile(path.join(directory, name));
    return { version: name.split('_')[0], name, checksum: migrationChecksum(bytes.toString('utf8')), sha256: createHash('sha256').update(bytes).digest('hex') };
  }));
}

// Inspect the reservation declaration without importing application modules,
// which could initialize stores. Model tests exercise its actual allocation behavior.
export async function reservedSlugContract() {
  const source = await readFile(path.join(root, 'lib/resource-input.ts'), 'utf8');
  const declaration = source.match(/const reservedSlugs\s*=\s*new Set\(\[([^\]]+)\]\)/);
  requireValue(declaration, 'Cannot verify the resource slug reservation declaration.');
  const declared = [...declaration[1].matchAll(/["']([^"']+)["']/g)].map(match => match[1]);
  for (const slug of Object.keys(REQUIRED_TOPIC_SLUGS)) requireValue(declared.includes(slug), `Allocator no longer reserves system slug ${slug}.`);
  return { reserved: Object.keys(REQUIRED_TOPIC_SLUGS), source: 'lib/resource-input.ts', check: 'declared reservation set; behavioral tests are separate' };
}

export async function readSnapshot(sql, phase, manifest) {
  return sql.begin('isolation level repeatable read read only', async tx => {
    // Fail closed rather than silently compare rows filtered by an RLS policy.
    await tx`SET LOCAL row_security = off`;
    const [connection] = await tx`SELECT current_setting('server_version') AS server_version,
      current_setting('transaction_read_only') AS transaction_read_only,
      current_setting('transaction_isolation') AS transaction_isolation`;
    const relations = Array.from(await tx`SELECT c.relname AS table_name, c.relrowsecurity AS rls, c.relforcerowsecurity AS force_rls
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relkind IN ('r','p') ORDER BY c.relname`);
    const tables = {};
    for (const { table_name: name } of relations) {
      const identifier = 'public."' + name.replaceAll('"', '""') + '"';
      // Retain exact JSON text, including bigint/numeric values exceeding JS's
      // safe integer range. PostgreSQL canonicalizes JSONB keys but preserves arrays.
      const result = await tx.unsafe(`SELECT to_jsonb(t)::text AS value FROM ${identifier} t ORDER BY to_jsonb(t)::text COLLATE "C"`);
      tables[name] = result.map(row => row.value);
    }
    const constraints = Array.from(await tx`SELECT c.relname AS table_name, con.conname AS name,
      con.contype AS type, con.convalidated AS validated, pg_get_constraintdef(con.oid) AS definition,
      pg_get_constraintdef(con.oid, true) AS normalized_definition
      FROM pg_constraint con JOIN pg_class c ON c.oid=con.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' ORDER BY c.relname, con.conname`);
    const triggers = Array.from(await tx`SELECT c.relname AS table_name, t.tgname AS name, t.tgenabled AS enabled,
      pg_get_triggerdef(t.oid) AS definition FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
      JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND NOT t.tgisinternal ORDER BY c.relname,t.tgname`);
    return { format: 'ihear-gallery-deployment-snapshot', formatVersion: 1, phase, capturedAt: new Date().toISOString(), connection,
      manifest, tables, schema: { relations, constraints, triggers } };
  });
}

function rows(snapshot, table) {
  const values = snapshot.tables[table];
  requireValue(Array.isArray(values), `Missing required table: ${table}.`);
  return values.map(value => JSON.parse(value));
}

export function validateSnapshot(snapshot, manifest) {
  requireValue(snapshot.format === 'ihear-gallery-deployment-snapshot' && snapshot.formatVersion === 1, 'Unsupported snapshot format. Application JSON backups cannot substitute for this full read-only snapshot.');
  requireValue(['pre-024', 'post-024'].includes(snapshot.phase), 'Invalid snapshot phase.');
  requireValue(snapshot.connection.transaction_read_only === 'on' && snapshot.connection.transaction_isolation === 'repeatable read', 'Snapshot is not a repeatable-read read-only transaction.');
  for (const table of requiredTables) rows(snapshot, table);
  const expected = manifest.filter(item => snapshot.phase === 'post-024' || item.version !== '024');
  requireValue(manifest.length === 24 && manifest.at(-1).version === '024', 'Candidate migration set is no longer CP6 001–024; review the release plan.');
  const ledger = rows(snapshot, 'schema_migrations');
  requireValue(ledger.length === expected.length, `Expected the ${snapshot.phase === 'pre-024' ? '001–023' : '001–024'} migration ledger; found ${ledger.length} rows. Do not start the application to repair it.`);
  for (const migration of expected) {
    const found = ledger.filter(row => row.version === migration.version);
    requireValue(found.length === 1 && found[0].name === migration.name && found[0].checksum.trim() === migration.checksum, `Migration ${migration.version} is missing or its recorded name/checksum differs from the candidate.`);
  }
  const constraints = snapshot.schema.constraints;
  const constraint = (table, name) => constraints.find(row => row.table_name === table && row.name === name && row.validated);
  const ids = snapshot.phase === 'post-024' ? [...LEGACY_GALLERY_IDS, 'home-banner'] : LEGACY_GALLERY_IDS;
  const idCheck = constraint('media_galleries', 'media_galleries_id_check');
  const expectedIdCheck = `CHECK ((id = ANY (ARRAY[${ids.map(id => `'${id}'::text`).join(', ')}])))`;
  requireValue(idCheck?.type === 'c' && compact(idCheck.definition) === compact(expectedIdCheck), `Unexpected media_galleries_id_check for ${snapshot.phase}; inspect the recorded definition before migration.`);
  for (const [name, definition] of Object.entries({
    media_galleries_pkey: 'PRIMARY KEY (id)',
    media_galleries_version_check: 'CHECK ((version >= 0))',
    media_galleries_items_check: "CHECK (((jsonb_typeof(items) = 'array'::text) AND (jsonb_array_length(items) <= 20)))",
  })) requireValue(compact(constraint('media_galleries', name)?.definition || '') === compact(definition), `Required gallery constraint changed or missing: ${name}.`);
  for (const table of ['media_galleries', 'media_gallery_assets', 'media_gallery_operations', 'resource_topics', 'resource_links', 'schema_migrations']) {
    requireValue(snapshot.schema.relations.find(row => row.table_name === table)?.rls, `RLS is not enabled on ${table}.`);
  }
  requireValue(constraint('resource_topics', 'resource_topics_slug_key')?.definition === 'UNIQUE (slug)', 'Topic slug uniqueness constraint is missing or changed.');
  requireValue(constraint('resource_links', 'resource_links_topic_fk')?.definition === 'FOREIGN KEY (topic_id) REFERENCES resource_topics(id) ON UPDATE RESTRICT ON DELETE RESTRICT', 'Resource topic relationship constraint is missing or changed.');
  requireValue(snapshot.schema.triggers.some(row => row.table_name === 'resource_topics' && row.name === 'resource_topics_guard' && ['O', 'A'].includes(row.enabled)), 'Permanent topic slug guard is missing or disabled.');
  const galleries = rows(snapshot, 'media_galleries');
  for (const id of ids) requireValue(galleries.filter(row => row.id === id).length === 1, `Required gallery missing or duplicated: ${id}. No automatic seeding is performed.`);
  for (const gallery of galleries) {
    requireValue(ids.includes(gallery.id), `Unexpected gallery identity: ${gallery.id}.`);
    requireValue(Number.isSafeInteger(gallery.version) && gallery.version >= 0 && Array.isArray(gallery.items) && gallery.items.length <= 20, `Invalid gallery data: ${gallery.id}.`);
    for (const item of gallery.items) {
      requireValue(item && typeof item.id === 'string' && ['photo', 'youtube'].includes(item.kind), `Invalid media item in ${gallery.id}.`);
      requireValue(gallery.id !== 'home-banner' || item.kind === 'photo', 'Banner contains a video; do not publish this data.');
      // Unchanged historical titles may exceed today's write limit. Preservation
      // checks compare them exactly instead of retroactively enforcing a new limit.
      requireValue(item.title == null || (typeof item.title === 'object' && ['en', 'zhHant', 'zhHans'].every(locale => typeof item.title[locale] === 'string')), `Invalid nullable multilingual title in ${gallery.id}.`);
    }
  }
  const topics = rows(snapshot, 'resource_topics');
  requireValue(new Set(topics.map(row => row.id)).size === topics.length && new Set(topics.map(row => row.slug)).size === topics.length, 'Duplicate topic ID or slug.');
  const links = rows(snapshot, 'resource_links');
  requireValue(links.every(item => topics.some(topic => topic.id === item.topic_id)), 'Resource item references a missing topic ID.');
  const mappings = [];
  for (const [slug, expectedId] of Object.entries(REQUIRED_TOPIC_SLUGS)) {
    const topic = topics.find(row => row.slug === slug);
    requireValue(topic?.id === expectedId, `System topic mapping mismatch: slug ${slug} must retain seeded ID ${expectedId}; do not rename, republish or seed automatically.`);
    requireValue(['draft', 'published', 'archived'].includes(topic.status), `Invalid topic status: ${slug}.`);
    const publicItems = topic.status === 'published' ? links.filter(item => item.topic_id === topic.id && item.status === 'published').length : 0;
    mappings.push({ id: topic.id, slug: topic.slug, status: topic.status, publicItems, publicState: publicItems ? 'ready' : 'empty', validUnpublished: topic.status !== 'published' });
  }
  return { migrationCount: ledger.length, idCheck: idCheck.definition, galleries: galleries.map(row => ({ id: row.id, version: row.version, items: row.items.length })), topics: mappings };
}

export function compareSnapshots(before, after) {
  const upgrade = before.phase === 'pre-024' && after.phase === 'post-024';
  requireValue(upgrade || before.phase === after.phase, 'Cannot compare a post-upgrade baseline against a pre-upgrade database. Use the pre-upgrade backup snapshot for restoration.');
  requireValue(same(Object.keys(before.tables).sort(), Object.keys(after.tables).sort()), 'Public table set changed.');
  const differences = [];
  const bannerExisted = rows(before, 'media_galleries').some(row => row.id === 'home-banner');
  for (const table of Object.keys(before.tables)) {
    let prior = before.tables[table], current = after.tables[table];
    if (upgrade && table === 'media_galleries' && !bannerExisted) {
      const banner = rows(after, table).find(row => row.id === 'home-banner');
      const seed = { id: 'initial-home-banner', kind: 'photo', hidden: false, assetSlot: 'home.hero', caption: { en: '', zhHant: '', zhHans: '' }, title: null };
      requireValue(banner && banner.version === 0 && banner.updated_by === '' && same(banner.items, [seed]), 'Unexpected Banner row during migration; review concurrent writes before restoring anything.');
      current = current.filter(value => JSON.parse(value).id !== 'home-banner');
      differences.push('media_galleries: one initial home-banner row');
    }
    if (upgrade && table === 'schema_migrations') { current = current.filter(value => JSON.parse(value).version !== '024'); differences.push('schema_migrations: one committed 024 row'); }
    if (upgrade && table === 'site_content_revisions') {
      const previous = rows(before, table).find(row => row.scope === 'content');
      const next = rows(after, table).find(row => row.scope === 'content');
      const revision = value => BigInt(value.match(/"revision"\s*:\s*(\d+)/)?.[1] ?? '-1');
      const previousText = prior.find(value => JSON.parse(value).scope === 'content');
      const nextText = current.find(value => JSON.parse(value).scope === 'content');
      requireValue(previous && next && revision(nextText) === revision(previousText) + 1n, 'Expected exactly one content revision increment from migration 024; review concurrent writes.');
      const omitRevision = value => { const result = JSON.parse(value); delete result.revision; delete result.updated_at; return result; };
      requireValue(same(omitRevision(previousText), omitRevision(nextText)), 'Unexpected content revision metadata change.');
      prior = prior.filter(value => JSON.parse(value).scope !== 'content'); current = current.filter(value => JSON.parse(value).scope !== 'content');
      differences.push('site_content_revisions: content +1 and its updated_at (statement trigger)');
    }
    requireValue(same(sortedRows(prior), sortedRows(current)), `Existing data changed in ${table}; stop and review administrator/traffic writes. Never overwrite them automatically.`);
  }
  // pg_dump can flatten redundant AND nodes created by BETWEEN expansion.
  // PostgreSQL's pretty deparser normalizes that representation while retaining
  // meaningful AND/OR grouping. Keep raw definitions in the evidence snapshot.
  const cleanSchema = snapshot => ({ ...snapshot.schema, constraints: snapshot.schema.constraints
    .filter(row => !upgrade || !(row.table_name === 'media_galleries' && row.name === 'media_galleries_id_check'))
    .map(row => ({ ...row, definition: row.normalized_definition ?? row.definition })) });
  requireValue(same(cleanSchema(before), cleanSchema(after)), 'Unapproved constraints, RLS or triggers changed.');
  if (upgrade) differences.push('media_galleries_id_check: adds home-banner');
  return { comparedTables: Object.keys(before.tables).length, exactArrayOrder: true, allowedDifferences: differences };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) { console.log('Read-only CP6 verification. --phase pre-024|post-024 [--database-env POSTGRES_URL] [--baseline snapshot.json] [--snapshot-output snapshot.json]. Explicit environment only; no .env loading, application startup, migration or seed.'); return; }
  const databaseUrl = process.env[options.databaseEnv];
  requireValue(databaseUrl, `Set ${options.databaseEnv} explicitly. This verifier never loads .env files or falls back to a different connection.`);
  const manifest = await migrationManifest();
  const reservation = await reservedSlugContract();
  let baseline;
  if (options.baseline) {
    const document = JSON.parse(await readFile(options.baseline, 'utf8'));
    requireValue(document.checksum === hash(document.payload), 'Baseline snapshot checksum mismatch.');
    validateSnapshot(document.payload, manifest);
    baseline = document.payload;
  }
  const sql = postgres(databaseUrl, { max: 1, prepare: false, ssl: process.env.POSTGRES_SSL === 'disable' ? false : 'require', connect_timeout: 10,
    connection: { default_transaction_read_only: 'on', statement_timeout: 15000, application_name: 'ihear-cp6-readonly-verifier' } });
  try {
    const snapshot = await readSnapshot(sql, options.phase, manifest);
    const contract = validateSnapshot(snapshot, manifest);
    const preservation = baseline ? compareSnapshots(baseline, snapshot) : null;
    if (options.snapshotOutput) {
      await mkdir(path.dirname(path.resolve(options.snapshotOutput)), { recursive: true });
      await writeFile(options.snapshotOutput, JSON.stringify({ checksumAlgorithm: 'sha256-canonical-json', checksum: hash(snapshot), payload: snapshot }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    }
    console.log(JSON.stringify({ verified: true, phase: options.phase, connection: snapshot.connection, ...contract, reservation, preservation,
      snapshotOutput: options.snapshotOutput || null, snapshotChecksum: hash(snapshot), databaseWrites: false }));
  } finally { await sql.end({ timeout: 2 }); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    const message = error?.code ? `Database/filesystem operation failed (${error.code}); verify the explicit target, permissions and schema.` : String(error.message || 'Verification failed').replace(/postgres(?:ql)?:\/\/\S+/gi, '[redacted database URL]');
    console.error(JSON.stringify({ verified: false, code: error?.code || '', message, databaseWrites: false })); process.exitCode = 1;
  });
}
