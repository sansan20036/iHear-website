// Restore diagnostics ONLY. Does not read .env or contain a 023/takeover execution path.
import { readFileSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { migrationChecksum } from './migration-checksum.mjs';
import { compareRestoredTable } from './restore-comparison.mjs';

const input = process.argv[2], mode = process.argv[3] || '--diagnose';
if (!input || !['--diagnose', '--validate-restore'].includes(mode)) throw new Error('Usage: node scripts/investigate-resource-restore.mjs <snapshot.json> --diagnose | --validate-restore <proof-directory>');
const hash = value => createHash('sha256').update(value).digest('hex');
const original = readFileSync(input, 'utf8'), backup = JSON.parse(original), source = backup.payload;
if (hash(JSON.stringify(source)) !== backup.checksum || source.format !== 'ihear-resource-rehearsal-snapshot' || source.tables.resource_topics || !source.readOnly) throw new Error('Invalid pre-023 snapshot');
if (mode === '--validate-restore') {
  const evidence = JSON.parse(readFileSync(path.join(process.argv[4] || '', 'report.json'), 'utf8'));
  const rawDiff = readFileSync(path.join(process.argv[4] || '', 'site_content_revisions.diff.json'), 'utf8');
  if (evidence.status !== 'REPRESENTATION_ONLY' || evidence.sourceChecksum !== backup.checksum || evidence.artifactSha256['site_content_revisions.diff.json'] !== hash(rawDiff) || !JSON.parse(rawDiff).representationOnly) throw new Error('Verified matching diagnostic proof required');
}
const directory = path.resolve('output/checkpoint-6-restore/' + randomUUID()); mkdirSync(directory, { recursive: true });
const write = (name, value) => writeFileSync(path.join(directory, name), JSON.stringify(value, null, 2) + '\n');
const report = { mode, source: path.basename(input), sourceChecksum: backup.checksum, sourceFileSha256: hash(original), status: 'RUNNING', productionAccess: false, migration023Executed: false, guidesTakeoverExecuted: false, checks: [] };
const container = 'ihear-restore-diagnostic-' + randomUUID(); let started = false;
const docker = (args, stdin) => execFileSync('docker', args, { input: stdin, encoding: 'utf8', windowsHide: true, timeout: 60000, maxBuffer: 32 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] });
const sql = query => docker(['exec', '-i', container, 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres'], query).trim();
const quote = value => "'" + String(value).replaceAll("'", "''") + "'";
const json = value => quote(JSON.stringify(value)) + '::jsonb';
function check(name, ok) { report.checks.push({ name, pass: ok }); if (!ok) throw new Error(name); }
try {
  for (const recorded of source.tables.schema_migrations) {
    check('Migration version within 001–022: ' + recorded.version, Number(recorded.version) >= 1 && Number(recorded.version) <= 22);
    check('Recorded migration checksum: ' + recorded.version, migrationChecksum(readFileSync(path.join('db/migrations', recorded.name), 'utf8')) === recorded.checksum.trim());
  }
  docker(['run', '--detach', '--rm', '--pull=never', '--network', 'none', '--name', container, '--label', 'ihear-test=restore-diagnostic', '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', 'postgres:17-alpine']); started = true;
  let ready = false; for (let n = 0; n < 60; n++) { try { sql('SELECT 1'); ready = true; break; } catch { await new Promise(resolve => { setTimeout(resolve, 500); }); } }
  check('Isolated PostgreSQL ready', ready);
  for (const name of readdirSync('db/migrations').filter(name => /^\d+_.*\.sql$/.test(name) && Number(name.slice(0, 3)) < 23).sort()) sql('BEGIN; ' + readFileSync(path.join('db/migrations', name), 'utf8') + ' COMMIT;');
  sql('CREATE TABLE schema_migrations(version TEXT PRIMARY KEY,name TEXT NOT NULL,checksum CHAR(64) NOT NULL,applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())');
  const names = Object.keys(source.tables); for (const name of names) check('Safe table identifier: ' + name, /^[a-z_]+$/.test(name));
  sql('BEGIN; SET LOCAL session_replication_role=replica; TRUNCATE ' + names.join(',') + ' CASCADE; ' + names.map(name => `INSERT INTO ${name} SELECT * FROM jsonb_populate_recordset(NULL::${name},${json(source.tables[name])});`).join('\n') + ' COMMIT;');
  // Persist the failing output before any comparison or cleanup, including the
  // exact JSON tokens emitted by PostgreSQL, not just JSON.parse's interpretation.
  const raw = sql("SELECT COALESCE(json_agg(t ORDER BY scope),'[]') FROM site_content_revisions t");
  writeFileSync(path.join(directory, 'site_content_revisions.actual.raw.json'), raw + '\n');
  const before = source.tables.site_content_revisions, after = JSON.parse(raw);
  write('site_content_revisions.before.json', before); write('site_content_revisions.actual.parsed.json', after);
  const proof = JSON.parse(sql(`WITH expected AS (SELECT * FROM jsonb_populate_recordset(NULL::site_content_revisions,${json(before)}))
    SELECT json_agg(json_build_object('scope',COALESCE(e.scope,a.scope),'missingBefore',e.scope IS NULL,'missingAfter',a.scope IS NULL,
      'revisionEqual',e.revision IS NOT DISTINCT FROM a.revision,'timestampEqual',e.updated_at IS NOT DISTINCT FROM a.updated_at,
      'expectedRevisionExact',e.revision::text,'actualRevisionExact',a.revision::text,
      'expectedTimestampUTC',to_char(e.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      'actualTimestampUTC',to_char(a.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      'expectedEpochMicroseconds',(extract(epoch FROM e.updated_at)*1000000)::numeric(30,0)::text,
      'actualEpochMicroseconds',(extract(epoch FROM a.updated_at)*1000000)::numeric(30,0)::text) ORDER BY COALESCE(e.scope,a.scope))
    FROM expected e FULL OUTER JOIN site_content_revisions a USING(scope)`));
  write('site_content_revisions.sql-proof.json', proof);
  const describe = (row, field) => ({ present: Object.hasOwn(row, field), value: row[field] === undefined ? '<undefined>' : row[field], runtimeType: row[field] === null ? 'null' : typeof row[field], serialized: JSON.stringify(row[field]) ?? '<undefined/not serialized>', serializedType: row[field] === null ? 'null' : typeof row[field], emptyString: row[field] === '' });
  const duplicates = rows => rows.filter((r, i) => rows.findIndex(other => other.scope === r.scope) !== i).map(r => r.scope);
  const diff = { table: 'site_content_revisions', primaryKey: ['scope'], rowCountBefore: before.length, rowCountAfter: after.length,
    missingKeys: before.filter(row => !after.some(actual => actual.scope === row.scope)).map(row => row.scope), extraKeys: after.filter(row => !before.some(old => old.scope === row.scope)).map(row => row.scope),
    duplicateKeysBefore: duplicates(before), duplicateKeysAfter: duplicates(after), rowOrderBefore: before.map(r => r.scope), rowOrderAfter: after.map(r => r.scope),
    rows: before.map(old => {
      const actual = after.find(row => row.scope === old.scope) || {}, evidence = proof.find(row => row.scope === old.scope);
      return { key: { scope: old.scope }, revisionIdentifier: evidence?.actualRevisionExact, before: old, after: actual, objectKeysBefore: Object.keys(old), objectKeysAfter: Object.keys(actual),
        fields: [...new Set([...Object.keys(old), ...Object.keys(actual)])].map(field => ({ field, databaseType: source.columns.find(c => c.table_name === 'site_content_revisions' && c.column_name === field)?.data_type,
          before: describe(old, field), after: describe(actual, field), serializedEqual: JSON.stringify(old[field]) === JSON.stringify(actual[field]),
          databaseValueEqual: field === 'revision' ? evidence?.revisionEqual : field === 'updated_at' ? evidence?.timestampEqual : old[field] === actual[field] })), sqlEvidence: evidence };
    }) };
  diff.representationOnly = before.length === after.length && !diff.missingKeys.length && !diff.extraKeys.length && !diff.duplicateKeysBefore.length && !diff.duplicateKeysAfter.length && diff.rows.every(row => row.fields.every(field => field.databaseValueEqual));
  diff.onlyNumericStringNumberDifference = diff.rows.every(row => row.fields.every(field => field.serializedEqual || (field.field === 'revision' && field.databaseValueEqual)));
  diff.timestampRepresentationDifference = diff.rows.some(row => row.fields.some(field => field.field === 'updated_at' && !field.serializedEqual));
  diff.nullUndefinedEmptyStringDifference = diff.rows.some(row => row.fields.some(field => !field.serializedEqual && [field.before, field.after].some(value => ['null', 'undefined'].includes(value.runtimeType) || value.emptyString)));
  diff.objectKeyOrderDifference = diff.rows.some(row => JSON.stringify(row.objectKeysBefore) !== JSON.stringify(row.objectKeysAfter));
  diff.rowOrderDifference = JSON.stringify(diff.rowOrderBefore) !== JSON.stringify(diff.rowOrderAfter);
  write('site_content_revisions.diff.json', diff);
  check('All differences explained by SQL-proven representation changes', diff.representationOnly);
  if (mode === '--validate-restore') {
    report.tableComparisons = [];
    for (const name of names) {
      const rawTable = sql(`SELECT COALESCE(json_agg(t),'[]') FROM public.${name} t`);
      writeFileSync(path.join(directory, name + '.restored.raw.json'), rawTable + '\n');
      const bigints = source.columns.filter(column => column.table_name === name && column.udt_name === 'int8');
      // Capture exact bigint decimal tokens as strings BEFORE JSON.parse, so
      // values beyond 2^53 cannot round silently. The raw transport is kept too.
      const expression = bigints.length ? 'to_jsonb(t) || jsonb_build_object(' + bigints.flatMap(column => [quote(column.column_name), `t.${column.column_name}::text`]).join(',') + ')::jsonb' : 'to_jsonb(t)';
      const lossless = JSON.parse(sql(`SELECT COALESCE(json_agg(${expression}),'[]') FROM public.${name} t`));
      write(name + '.restored.lossless.json', lossless);
      const comparison = compareRestoredTable(name, source.tables[name], lossless, source);
      write(name + '.comparison.json', comparison); report.tableComparisons.push(comparison);
      check('Complete restore equality: ' + name, comparison.pass);
    }
  }
  check('Source backup bytes unchanged', hash(readFileSync(input, 'utf8')) === report.sourceFileSha256);
  check('023 not applied', sql("SELECT to_regclass('public.resource_topics') IS NULL") === 't');
  report.status = mode === '--diagnose' ? 'REPRESENTATION_ONLY' : 'RESTORE_VALIDATED_AWAITING_REVIEW'; report.diff = 'site_content_revisions.diff.json';
} catch (error) { report.status = 'STOP'; report.failure = error instanceof Error && !('stderr' in error) ? error.message : 'Isolated restore command failed'; process.exitCode = 1; }
finally {
  if (started) { docker(['stop', '--time', '1', container]); report.containerRemoved = true; }
  const files = readdirSync(directory); report.artifactSha256 = Object.fromEntries(files.map(name => [name, hash(readFileSync(path.join(directory, name)))]));
  write('report.json', report); console.log(JSON.stringify({ status: report.status, directory, failure: report.failure }));
}
