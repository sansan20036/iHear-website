// Checkpoint 6: read-only consistent production snapshot, never a migration runner.
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import nextEnv from '@next/env';
import postgres from 'postgres';

nextEnv.loadEnvConfig(process.cwd());
const url = process.env.POSTGRES_URL || process.env.DATABASE_URL;
if (!url) throw new Error('Database configuration missing');
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sql = postgres(url, { max: 1, prepare: false, ssl: process.env.POSTGRES_SSL === 'disable' ? false : 'require', connect_timeout: 10,
  connection: { default_transaction_read_only: 'on', application_name: 'ihear-checkpoint6-readonly-backup' } });
try {
  const payload = await sql.begin('isolation level repeatable read read only', async tx => {
    const [mode] = await tx`SHOW transaction_read_only`;
    if (mode.transaction_read_only !== 'on') throw new Error('Read-only protection missing');
    const names = await tx`SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY table_name`;
    const tables = {};
    for (const { table_name: name } of names) tables[name] = await tx`SELECT * FROM public.${tx(name)} ORDER BY to_jsonb(${tx(name)})::text`;
    for (const name of ['resource_links', 'localized_content_overrides', 'localized_translation_states', 'site_layout_configs', 'schema_migrations']) {
      if (!tables[name]) throw new Error('Required snapshot table missing: ' + name);
    }
    const columns = await tx`SELECT table_name,column_name,data_type,udt_name,is_nullable,column_default FROM information_schema.columns WHERE table_schema='public' ORDER BY table_name,ordinal_position`;
    const constraints = await tx`SELECT c.relname AS table_name,con.conname,pg_get_constraintdef(con.oid) AS definition FROM pg_constraint con JOIN pg_class c ON c.oid=con.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' ORDER BY c.relname,con.conname`;
    return { format: 'ihear-resource-rehearsal-snapshot', version: 1, createdAt: new Date().toISOString(), readOnly: true, tables, columns, constraints };
  });
  const output = path.join('backups', 'resource-rehearsal-' + payload.createdAt.replace(/[:.]/g, '-') + '.json');
  await mkdir('backups', { recursive: true });
  const checksum = hash(payload);
  await writeFile(output, JSON.stringify({ checksumAlgorithm: 'sha256', checksum, payload }, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ path: output, checksum, createdAt: payload.createdAt, readOnly: true, rowCounts: Object.fromEntries(Object.entries(payload.tables).map(([name, rows]) => [name, rows.length])) }));
} catch (error) {
  // Connection errors may contain credentials; output only the error class/code.
  console.error(JSON.stringify({ snapshotFailed: true, code: error.code || error.name })); process.exitCode = 1;
} finally { await sql.end({ timeout: 5 }); }
