import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import nextEnv from '@next/env';
import postgres from 'postgres';

nextEnv.loadEnvConfig(process.cwd());
if (!process.argv[2]) throw new Error('Pass the pre-deployment backup path.');
const backup = JSON.parse(await readFile(process.argv[2], 'utf8'));
if (backup.checksum !== createHash('sha256').update(JSON.stringify(backup.payload)).digest('hex')) throw new Error('Backup checksum mismatch');
const orders = {
  impact_milestones: 'id', impact_milestone_settings: 'key', content_overrides: 'page,key', localized_content_overrides: 'page,key,locale',
  team_people: 'id', team_profiles: 'id', site_media_assets: 'slot', site_media_variants: 'slot,width', site_settings: 'key',
  site_layout_configs: 'page', admin_accounts: 'email', admin_activity_log: 'created_at,id',
  localized_translation_states: 'resource_type,resource_scope,resource_id,field_key,locale', schema_migrations: 'version',
};
const canonical = value => JSON.stringify(value, function (_key, item) {
  return item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item;
});
const databaseUrl = process.env.POSTGRES_URL || process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('Database is not configured');
const sql = postgres(databaseUrl, { max: 1, prepare: false, ssl: process.env.POSTGRES_SSL === 'disable' ? false : 'require', connect_timeout: 10 });
try {
  const preserved = [];
  for (const [name, order] of Object.entries(orders)) {
    const before = backup.payload.tables[name];
    if (!before) continue;
    const rows = await sql.unsafe(`SELECT * FROM public.${name} ORDER BY ${order}`);
    const after = name === 'schema_migrations' ? rows.filter(row => before.some(old => old.version === row.version)) : rows;
    if (canonical(before) !== canonical(after)) throw new Error(`Existing data changed: ${name}. Do not restore automatically; review concurrent administrator edits.`);
    preserved.push({ table: name, rows: before.length });
  }
  const galleries = await sql`SELECT id,version,jsonb_array_length(items) AS items FROM public.media_galleries ORDER BY id`;
  if (galleries.length !== 5) throw new Error('Expected five gallery areas');
  const migration = await sql`SELECT version FROM public.schema_migrations WHERE version='019'`;
  if (!migration.length) throw new Error('Gallery migration is not recorded');
  console.log(JSON.stringify({ verified: true, preserved, galleries }));
} finally { await sql.end({ timeout: 2 }); }
