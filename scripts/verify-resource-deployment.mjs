import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import nextEnv from '@next/env';
import postgres from 'postgres';
import { RESOURCE_SEEDS } from '../lib/resource-seed.ts';

nextEnv.loadEnvConfig(process.cwd());
if (!process.argv[2]) throw new Error('Pass the pre-deployment backup path');
const backup = JSON.parse(await readFile(process.argv[2], 'utf8'));
if (backup.checksum !== createHash('sha256').update(JSON.stringify(backup.payload)).digest('hex')) throw new Error('Backup checksum mismatch');
const keys = { media_galleries: ['id'], media_gallery_assets: ['slot'], media_gallery_operations: ['id'], impact_milestones: ['id'], impact_milestone_settings: ['key'], content_overrides: ['page','key'], localized_content_overrides: ['page','key','locale'], team_people: ['id'], team_profiles: ['id'], site_media_assets: ['slot'], site_media_variants: ['slot','width'], site_settings: ['key'], site_layout_configs: ['page'], admin_accounts: ['email'], admin_activity_log: ['id'], localized_translation_states: ['resource_type','resource_scope','resource_id','field_key','locale'], schema_migrations: ['version'], resource_links: ['id'] };
const canonical = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key,item[key]])) : item);
const databaseUrl = process.env.POSTGRES_URL || process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('Database is not configured');
const sql = postgres(databaseUrl, { max: 1, prepare: false, ssl: process.env.POSTGRES_SSL === 'disable' ? false : 'require' });
try {
  const results = [];
  for (const [table, fields] of Object.entries(keys)) {
    const before = backup.payload.tables[table];
    if (!before) continue;
    const rows = await sql`SELECT * FROM ${sql(table)}`;
    const key = row => JSON.stringify(fields.map(field => row[field]));
    const previousKeys = new Set(before.map(key));
    const additions = rows.filter(row => !previousKeys.has(key(row)));
    if (additions.some(row => !(table === 'schema_migrations' && ['020', '021'].includes(row.version)) && !(table === 'localized_translation_states' && row.resource_type === 'resource' && RESOURCE_SEEDS.some(seed => seed.id === row.resource_id)))) throw new Error(`Unexpected new data in ${table}; review concurrent edits without restoring over them`);
    const after = rows.filter(row => previousKeys.has(key(row)));
    const sorted = items => [...items].sort((a,b) => key(a).localeCompare(key(b)));
    const normalizedBefore = table === 'resource_links' ? before.map(row => ({ ...row, category: row.category || 'form' })) : before;
    if (canonical(sorted(normalizedBefore)) !== canonical(sorted(after))) throw new Error(`Existing data changed: ${table}; review concurrent edits without restoring over them`);
    results.push({ table, preservedRows: before.length, additions: additions.length });
  }
  const resources = await sql`SELECT * FROM resource_links ORDER BY sort_order, id`;
  if (!backup.payload.tables.resource_links) {
    if (resources.length !== RESOURCE_SEEDS.length) throw new Error('Unexpected initial resource count');
    for (const seed of RESOURCE_SEEDS) {
      const row = resources.find(item => item.id === seed.id);
      if (!row || row.url !== seed.url || row.status !== 'published' || row.sort_order !== seed.sortOrder || canonical(row.title) !== canonical(seed.title) || canonical(row.description) !== canonical(seed.description)) throw new Error('Resource seed mismatch: ' + seed.id);
    }
  }
  const migration = await sql`SELECT version FROM schema_migrations WHERE version='020'`;
  if (!migration.length) throw new Error('Resource migration is not recorded');
  console.log(JSON.stringify({ verified: true, tables: results, resources: resources.length }));
} finally { await sql.end({ timeout: 2 }); }
