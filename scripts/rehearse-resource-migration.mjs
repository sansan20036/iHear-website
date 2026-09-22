// No .env / production connection. All SQL runs in a unique networkless container.
import { readFileSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { migrationChecksum } from './migration-checksum.mjs';
import { compareRestoredTable, timestampMicroseconds } from './restore-comparison.mjs';
import { resourceDocumentFromTables, planGuideTakeover, applyGuideTakeover, guideTakeoverSql, sqlJson, GUIDE_TAKEOVER_KEY } from './resource-guide-takeover.mjs';

const input = process.argv[2];
const allowMigration = process.argv[3] === '--allow-migration';
if (!input || (process.argv.length !== 3 && !(process.argv.length === 4 && allowMigration))) throw new Error('Usage: node scripts/rehearse-resource-migration.mjs <snapshot.json> [--allow-migration (only after review)]');
const backup = JSON.parse(readFileSync(input, 'utf8'));
const sha = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
if (backup.checksum !== sha(backup.payload) || backup.payload.format !== 'ihear-resource-rehearsal-snapshot' || !backup.payload.readOnly) throw new Error('Invalid snapshot');
const source = backup.payload;
const directory = path.resolve('output/checkpoint-6/' + randomUUID()); mkdirSync(directory, { recursive: true });
const report = { backup: path.basename(input), checksum: backup.checksum, createdAt: source.createdAt, productionWrites: false, isolation: 'Docker network none; no port mapping; no host volumes', checks: [], status: 'RUNNING' };
report.protectedSources = Object.fromEntries(['db/migrations/023_resource_topics.sql', 'scripts/resource-guide-takeover.mjs'].map(file => [file, createHash('sha256').update(readFileSync(file)).digest('hex')]));
const save = (name, value) => writeFileSync(path.join(directory, name), JSON.stringify(value, null, 2) + '\n');
const canonical = (value, key = '') => {
  if (Array.isArray(value)) {
    const values = value.map(item => canonical(item));
    return ['', 'topics', 'items', 'states'].includes(key) ? values.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) : values;
  }
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k], k)]));
  if (typeof value === 'string' && /(_at|At)$/.test(key)) return timestampMicroseconds(value);
  return value;
};
const equal = (a, b) => sha(canonical(a)) === sha(canonical(b));
function check(name, ok) { report.checks.push({ name, result: ok ? 'PASS' : 'FAIL' }); if (!ok) throw new Error(name); }
const container = 'ihear-resource-rehearsal-' + randomUUID(); let started = false;
const docker = (args, stdin) => execFileSync('docker', args, { input: stdin, encoding: 'utf8', windowsHide: true, timeout: 60000, maxBuffer: 32 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] });
function sql(query, database = 'postgres') {
  try { return docker(['exec', '-i', container, 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', database], query).trim(); }
  catch (error) { save('sql-failure.json', { stderr: error.stderr?.toString(), stdout: error.stdout?.toString() }); throw new Error('Isolated PostgreSQL SQL failed; stop and review'); }
}
const tableNames = Object.keys(source.tables);
const table = (name, database = 'postgres') => JSON.parse(sql(`SELECT COALESCE(json_agg(t),'[]') FROM public.${name} t`, database));
const tables = (database = 'postgres') => Object.fromEntries([...tableNames, 'resource_topics'].map(name => [name, table(name, database)]));
const migration = readFileSync('db/migrations/023_resource_topics.sql', 'utf8');
try {
  check('Snapshot is pre-023, contains current Forms/Articles and 27 guide locale values', !source.tables.resource_topics && source.tables.schema_migrations.length === 22 && source.tables.localized_content_overrides.filter(row => row.page === '/resources' && /^resources\.res[1-9]$/.test(row.key)).length === 27);
  for (const recorded of source.tables.schema_migrations) check('Recorded migration checksum ' + recorded.version, migrationChecksum(readFileSync(path.join('db/migrations', recorded.name), 'utf8')) === recorded.checksum.trim());
  docker(['run', '--detach', '--rm', '--pull=never', '--network', 'none', '--name', container, '--label', 'ihear-test=resource-rehearsal', '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', 'postgres:17-alpine']); started = true;
  let ready = false; for (let n = 0; n < 60; n++) { try { sql('SELECT 1'); ready = true; break; } catch { await new Promise(resolve => { setTimeout(resolve, 500); }); } }
  check('Isolated PostgreSQL ready', ready);
  for (const name of readdirSync('db/migrations').filter(name => /^\d+_.*\.sql$/.test(name) && Number(name.slice(0, 3)) < 23).sort()) sql('BEGIN; ' + readFileSync(path.join('db/migrations', name), 'utf8') + ' COMMIT;');
  sql('CREATE TABLE schema_migrations(version TEXT PRIMARY KEY,name TEXT NOT NULL,checksum CHAR(64) NOT NULL,applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())');
  for (const name of tableNames) if (!/^[a-z_]+$/.test(name)) throw new Error('Unexpected table identifier');
  sql('BEGIN; SET LOCAL session_replication_role=replica; TRUNCATE ' + tableNames.join(',') + ' CASCADE; ' + tableNames.map(name => `INSERT INTO ${name} SELECT * FROM jsonb_populate_recordset(NULL::${name},${sqlJson(source.tables[name])});`).join('\n') + ' COMMIT;');
  for (const name of tableNames) {
    const raw = sql(`SELECT COALESCE(json_agg(t),'[]') FROM public.${name} t`);
    writeFileSync(path.join(directory, name + '.restored.raw.json'), raw + '\n');
    const comparison = compareRestoredTable(name, source.tables[name], JSON.parse(raw), source);
    save(name + '.restore-diff.json', comparison);
    check('Exact isolated restore: ' + name, comparison.pass);
  }
  if (!allowMigration) {
    report.status = 'RESTORE_VALIDATED_AWAITING_REVIEW';
  } else {
  save('before-migration.json', source.tables);
  sql('CREATE DATABASE before_migration TEMPLATE postgres');
  sql('BEGIN; ' + migration + ' COMMIT;');
  const after023 = tables(); save('after-023.json', after023);
  save('schema-after-023.json', {
    columns: JSON.parse(sql("SELECT json_agg(t) FROM (SELECT table_name,column_name,data_type,is_nullable,column_default FROM information_schema.columns WHERE table_schema='public' AND table_name IN ('resource_topics','resource_links') ORDER BY table_name,ordinal_position) t")),
    constraints: JSON.parse(sql("SELECT json_agg(t) FROM (SELECT c.relname AS table_name,con.conname,pg_get_constraintdef(con.oid) AS definition FROM pg_constraint con JOIN pg_class c ON c.oid=con.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname IN ('resource_topics','resource_links') ORDER BY c.relname,con.conname) t")),
    indexes: JSON.parse(sql("SELECT json_agg(t) FROM (SELECT tablename,indexname,indexdef FROM pg_indexes WHERE schemaname='public' AND tablename IN ('resource_topics','resource_links') ORDER BY tablename,indexname) t")),
  });
  const stripNew = rows => rows.map(({ topic_id: _topic, type: _type, ...row }) => row);
  check('023 preserves every legacy resource field', equal(stripNew(after023.resource_links), source.tables.resource_links));
  check('023 assigns category/topic/type exactly', after023.resource_links.every(row => row.topic_id === (row.category === 'article' ? 'articles' : 'forms') && row.type === 'external_link'));
  check('023 preserves all legacy translation states', equal(after023.localized_translation_states.filter(row => !(row.resource_type === 'resource' && row.resource_scope === 'topic')), source.tables.localized_translation_states));
  const plan = planGuideTakeover(source, JSON.parse(readFileSync('data/content-slots.json', 'utf8')));
  const local023 = resourceDocumentFromTables(source.tables), expected = applyGuideTakeover(local023, plan);
  save('guide-plan.json', plan); save('resource-links.json', expected);
  sql('BEGIN; ' + guideTakeoverSql(plan) + ' COMMIT;');
  const after = tables(), sqlDocument = resourceDocumentFromTables(after);
  save('after-takeover.json', after); save('postgres-resource-document.json', sqlDocument);
  // Seed creation times are backend-specific; compare source/new item history and
  // all topic content/state/version, preserving the DB seed history separately.
  const comparable = document => ({ ...document, topics: document.topics.map(({ createdAt: _created, updatedAt: _updated, ...topic }) => ({ ...topic, states: topic.states.map(({ updatedAt: _at, ...state }) => state) })) });
  check('PostgreSQL and file mode semantic/history parity', equal(comparable(sqlDocument), comparable(expected)));
  report.guideDiff = plan.guides.map((guide, n) => {
    const actual = sqlDocument.items.find(row => row.id === guide.id);
    const entry = { id: guide.id, sourceKey: 'resources.res' + (n + 1), count: sqlDocument.items.filter(row => row.id === guide.id).length, localesPreserved: equal(actual?.title, guide.title), sortOrder: actual?.sortOrder, expectedSortOrder: guide.sortOrder, status: actual?.status, type: actual?.type, translationsPreserved: equal(actual?.states, guide.states) };
    check('Guide exact reconciliation: ' + guide.id, entry.count === 1 && entry.localesPreserved && entry.sortOrder === guide.sortOrder && entry.status === guide.status && entry.type === 'email_request' && entry.translationsPreserved);
    return entry;
  });
  save('guide-comparison.json', report.guideDiff);
  save('guide-field-comparison.json', plan.guides.map(expected => ({ id: expected.id, expected, actual: sqlDocument.items.find(row => row.id === expected.id) })));
  check('Legacy Forms/Articles unchanged after takeover', equal(after.resource_links.filter(row => source.tables.resource_links.some(old => old.id === row.id)).map(({ topic_id: _topic, type: _type, ...row }) => row), source.tables.resource_links));
  for (const name of tableNames.filter(name => !['resource_links', 'localized_translation_states', 'site_settings', 'site_content_revisions'].includes(name))) check('Unrelated table unchanged: ' + name, equal(source.tables[name], after[name]));
  check('Legacy translation rows remain intact', source.tables.localized_translation_states.every(row => after.localized_translation_states.some(current => equal(row, current))));
  report.counts = { before: { forms: source.tables.resource_links.filter(row => row.category === 'form').length, articles: source.tables.resource_links.filter(row => row.category === 'article').length, guides: 9 }, after: { items: after.resource_links.length, topics: after.resource_topics.length, guideItems: after.resource_links.filter(row => row.topic_id === 'guides').length } };
  report.resourceDiff = source.tables.resource_links.map(row => ({ id: row.id, originalFieldsUnchanged: true, addedTopicId: row.category === 'article' ? 'articles' : 'forms', addedType: 'external_link', status: row.status, sortOrder: row.sort_order }));
  save('after-takeover.json', after);
  save('row-counts-before-after.json', Object.keys(after).map(name => ({ table: name, before: source.tables[name]?.length ?? 0, after: after[name].length })));
  const resourceState = (database = 'postgres') => { const value = tables(database); return { topics: value.resource_topics, items: value.resource_links, states: value.localized_translation_states, settings: value.site_settings }; };
  const baseline = resourceState(); sql('BEGIN; ' + migration + guideTakeoverSql(plan) + ' COMMIT;'); sql('BEGIN; ' + migration + guideTakeoverSql(plan) + ' COMMIT;');
  save('idempotency-before.json', baseline); save('idempotency-after.json', resourceState());
  check('Repeated 023 and takeover preserve all records and states', equal(resourceState(), baseline));
  check('Repeated file migration preserves all records and states', equal(applyGuideTakeover(expected, plan), expected));
  // All synthetic administrator edits occur on a separate disposable clone.
  // Keep the primary restored/migrated nine Guides untouched for reconciliation.
  sql('CREATE DATABASE admin_simulation TEMPLATE postgres');
  const simulationSql = query => sql(query, 'admin_simulation');
  simulationSql("UPDATE resource_links SET title=jsonb_set(title,'{zhHant}','\"演練人工修改\"'),status='draft',sort_order=777,version=version+1 WHERE id='guide-communication'; UPDATE resource_topics SET status='draft',version=version+1 WHERE id='guides'; UPDATE localized_translation_states SET origin='manual' WHERE resource_type='resource' AND resource_id='guide-communication';");
  const edited = resourceState('admin_simulation'); simulationSql('BEGIN; ' + migration + guideTakeoverSql(plan) + ' COMMIT;');
  save('admin-edits-before-rerun.json', edited); save('admin-edits-after-rerun.json', resourceState('admin_simulation'));
  check('Rerun does not overwrite subsequent administrator edits', equal(resourceState('admin_simulation'), edited));
  const editedFile = resourceDocumentFromTables(tables('admin_simulation')); check('File rerun preserves subsequent administrator edits', equal(applyGuideTakeover(editedFile, plan), editedFile));
  // Stop before recovery if the actual public scripts fail against this fresh fixture.
  const browserOutput = execFileSync(process.execPath, ['tests/resource-takeover-render.smoke.mjs', directory], { encoding: 'utf8', windowsHide: true, timeout: 60000 });
  save('public-render-command.json', { output: browserOutput });
  check('Public takeover rendering passes all scenarios', JSON.parse(readFileSync(path.join(directory, 'takeover-render-report.json'), 'utf8')).status === 'PASS');
  simulationSql(`INSERT INTO resource_topics(id,title,slug,status,created_by,updated_by) VALUES ('recovery-added-topic','{"en":"Recovery topic","zhHant":"復原主題","zhHans":"复原主题"}','recovery-added-topic','published','recovery-test','recovery-test');
    INSERT INTO resource_links(id,category,title,description,url,status,created_by,updated_by,topic_id,type) VALUES ('recovery-added-item','form','{"en":"Recovery item","zhHant":"復原項目","zhHans":"复原项目"}','{"en":"","zhHant":"","zhHans":""}','','published','recovery-test','recovery-test','recovery-added-topic','text');`);
  const recoveryBefore = tables('admin_simulation'); save('recovery-before.json', recoveryBefore);
  simulationSql("BEGIN; UPDATE resource_links SET title=jsonb_set(title,'{en}','\"UNCOMMITTED\"') WHERE id='recovery-added-item'; ROLLBACK;");
  check('Transaction rollback preserves new Topic/Item and administrator edits', equal(table('resource_links', 'admin_simulation'), recoveryBefore.resource_links));
  const dump = docker(['exec', container, 'pg_dump', '-U', 'postgres', '-d', 'admin_simulation', '--no-owner', '--no-privileges']);
  writeFileSync(path.join(directory, 'recovery-upgraded.sql'), dump);
  sql('CREATE DATABASE recovery_restore'); sql(dump, 'recovery_restore');
  const recoveryAfter = tables('recovery_restore'); save('recovery-after.json', recoveryAfter);
  const recoveryDiff = Object.keys(recoveryBefore).map(name => ({ table: name, beforeCount: recoveryBefore[name].length, afterCount: recoveryAfter[name].length, exactValuesPreserved: equal(recoveryBefore[name], recoveryAfter[name]) }));
  save('recovery-diff.json', recoveryDiff);
  check('pg_dump and independent database restore preserve every table', recoveryDiff.every(row => row.exactValuesPreserved));
  check('Post-migration created Topic and Item survive recovery', recoveryAfter.resource_topics.some(t => t.id === 'recovery-added-topic') && recoveryAfter.resource_links.some(i => i.id === 'recovery-added-item' && i.topic_id === 'recovery-added-topic'));
  const recoveredFile = resourceDocumentFromTables(recoveryAfter);
  save('rollback-retained-resource-links.json', recoveredFile);
  check('Recovered file representation preserves all added records and manual edits', equal(recoveredFile, resourceDocumentFromTables(recoveryBefore)));
  const recoveredBrowserOutput = execFileSync(process.execPath, ['tests/resource-takeover-render.smoke.mjs', directory, '--recovery'], { encoding: 'utf8', windowsHide: true, timeout: 60000 });
  save('recovery-public-render-command.json', { output: recoveredBrowserOutput });
  check('Recovered public presentation preserves additions and hiding without legacy duplication', JSON.parse(readFileSync(path.join(directory, 'takeover-render-report.json'), 'utf8')).status === 'PASS');
  save('rollback-simulation-results.json', { status: 'PASS', strategy: 'Retain upgraded database; emergency read-only pre-migration snapshot presentation; resume upgraded snapshot. No down migration or old writable application.', sqlTransactionRollback: true, pgDumpRestore: true, newTopicAndItemRetained: true, allTablesRetained: true, publicPresentationEvidence: 'takeover-render-report.json', limitations: 'Presentation switching is tested with intercepted local browser responses; production routing and old application binaries are not exercised.' });
  check('Primary migrated Guides remain unchanged by simulations', equal(resourceState(), baseline));
  const rejects = query => { try { sql('BEGIN; ' + query + ' ROLLBACK;'); return false; } catch { return true; } };
  check('FK rejects missing parent', rejects("UPDATE resource_links SET topic_id='not-a-topic' WHERE id='guide-communication';"));
  check('FK rejects deleting occupied parent', rejects("DELETE FROM resource_topics WHERE id='guides';"));
  check('Archival refuses occupied topic', rejects("UPDATE resource_topics SET status='archived' WHERE id='guides';"));
  for (const status of ['published', 'draft']) {
    const result = sql(`BEGIN; UPDATE resource_links SET status='${status}' WHERE id='guide-communication'; UPDATE resource_links SET status='archived' WHERE id='guide-communication'; SELECT archived_from_status FROM resource_links WHERE id='guide-communication'; UPDATE resource_links SET status=archived_from_status WHERE id='guide-communication'; SELECT status FROM resource_links WHERE id='guide-communication'; ROLLBACK;`);
    check('Archive/restore retains ' + status, result === status + '\n' + status);
  }
  const hiddenSource = structuredClone(source); hiddenSource.tables.site_layout_configs.push({ page: '/resources', config: { hiddenSections: ['resources.guides'], orders: { 'resources.guides': [...plan.guides].reverse().map(row => row.id.slice(6)) }, links: {} } });
  const hiddenPlan = planGuideTakeover(hiddenSource, JSON.parse(readFileSync('data/content-slots.json', 'utf8')));
  check('Hidden legacy section maps to draft topic and reversed order is retained', hiddenPlan.status === 'draft' && hiddenPlan.guides[0].sortOrder === 90 && hiddenPlan.guides[8].sortOrder === 10);
  check('Source snapshot unchanged', backup.checksum === sha(JSON.parse(readFileSync(input, 'utf8')).payload));
  check('Migration 023 and Guide migration source files unchanged', Object.entries(report.protectedSources).every(([file, hash]) => createHash('sha256').update(readFileSync(file)).digest('hex') === hash));
  check('Persistent takeover marker survives hiding and restore', table('site_settings').some(row => row.key === GUIDE_TAKEOVER_KEY && row.value === 'complete'));
  report.status = 'PASS';
  }
} catch (error) { report.status = 'STOP'; report.failure = error.message; process.exitCode = 1; }
finally { if (started) docker(['stop', '--time', '1', container]); save('report.json', report); console.log(JSON.stringify({ status: report.status, report: path.join(directory, 'report.json'), passed: report.checks.filter(row => row.result === 'PASS').length, failure: report.failure })); }
