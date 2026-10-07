import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { canonical, compareSnapshots, LEGACY_GALLERY_IDS, migrationManifest, parseArguments, reservedSlugContract, validateSnapshot } from '../scripts/verify-gallery-deployment.mjs';

let manifest;
beforeAll(async () => { manifest = await migrationManifest(); });
const encoded = records => records.map(record => canonical(record));
function snapshot(phase = 'pre-024') {
  const ids = phase === 'post-024' ? [...LEGACY_GALLERY_IDS, 'home-banner'] : LEGACY_GALLERY_IDS;
  const tables = {
    media_galleries: encoded(ids.map(id => ({ id, version: 2, items: id === 'home-banner' ? [] : [
      { id: `${id}-photo`, kind: 'photo', hidden: true, assetSlot: 'retained', title: null },
      { id: `${id}-video`, kind: 'youtube', hidden: false, videoId: 'LsQWwDBLKUc' },
    ], updated_by: 'fixture', updated_at: '2026-10-07T00:00:00Z' }))),
    media_gallery_assets: encoded([{ slot: 'retained', payload: { widths: [320, 640] } }]),
    media_gallery_operations: encoded([{ id: 'old-operation', gallery_id: 'home' }]),
    schema_migrations: encoded(manifest.filter(row => phase === 'post-024' || row.version !== '024').map(({ version, name, checksum }) => ({ version, name, checksum, applied_at: '2026-10-07T00:00:00Z' }))),
    site_content_revisions: [canonical({ scope: 'content', revision: 17, updated_at: 'old' }), '{"revision":9007199254741001,"scope":"impact","updated_at":"old"}'],
    resource_topics: encoded(['announcements', 'calendar'].map(id => ({ id, slug: id, status: 'draft' }))),
    resource_links: encoded([{ id: 'draft-resource', topic_id: 'announcements', status: 'draft' }]),
    localized_translation_states: encoded([{ resource_id: 'retained', source_hash: null }]),
  };
  const definitions = {
    media_galleries_id_check: `CHECK ((id = ANY (ARRAY[${ids.map(id => `'${id}'::text`).join(', ')}])))`,
    media_galleries_pkey: 'PRIMARY KEY (id)', media_galleries_version_check: 'CHECK ((version >= 0))',
    media_galleries_items_check: "CHECK (((jsonb_typeof(items) = 'array'::text) AND (jsonb_array_length(items) <= 20)))",
  };
  return {
    format: 'ihear-gallery-deployment-snapshot', formatVersion: 1, phase,
    connection: { transaction_read_only: 'on', transaction_isolation: 'repeatable read' }, manifest, tables,
    schema: {
      relations: Object.keys(tables).map(table_name => ({ table_name, rls: true, force_rls: false })),
      constraints: [
        ...Object.entries(definitions).map(([name, definition]) => ({ table_name: 'media_galleries', name, type: name.endsWith('pkey') ? 'p' : 'c', validated: true, definition })),
        { table_name: 'resource_topics', name: 'resource_topics_slug_key', type: 'u', validated: true, definition: 'UNIQUE (slug)' },
        { table_name: 'resource_links', name: 'resource_links_topic_fk', type: 'f', validated: true, definition: 'FOREIGN KEY (topic_id) REFERENCES resource_topics(id) ON UPDATE RESTRICT ON DELETE RESTRICT' },
      ],
      triggers: [{ table_name: 'resource_topics', name: 'resource_topics_guard', enabled: 'O', definition: 'actual guard' }],
    },
  };
}
function upgrade(before) {
  const next = structuredClone(before); next.phase = 'post-024';
  next.tables.media_galleries.push(canonical({ id: 'home-banner', version: 0, updated_by: '', updated_at: 'new', items: [{ id: 'initial-home-banner', kind: 'photo', hidden: false, assetSlot: 'home.hero', caption: { en: '', zhHant: '', zhHans: '' }, title: null }] }));
  const migration = manifest.find(row => row.version === '024');
  next.tables.schema_migrations.push(canonical({ version: migration.version, name: migration.name, checksum: migration.checksum, applied_at: 'new' }));
  next.tables.site_content_revisions[0] = canonical({ scope: 'content', revision: 18, updated_at: 'new' });
  next.schema.constraints.find(row => row.name === 'media_galleries_id_check').definition = snapshot('post-024').schema.constraints[0].definition;
  return next;
}
function editRow(data, table, index, fn) {
  const row = JSON.parse(data.tables[table][index]); fn(row); data.tables[table][index] = canonical(row);
}

describe('CP6 read-only deployment verifier', () => {
  it('requires an explicit phase and replaces incomplete positional application backups with a clear error', () => {
    expect(() => parseArguments([])).toThrow('Specify --phase');
    expect(() => parseArguments(['old-backup.json'])).toThrow('Legacy positional JSON backups');
    expect(() => parseArguments(['--phase', 'post-024', '--baseline', 'same.json', '--snapshot-output', 'same.json'])).toThrow('overwrite');
  });
  it('never loads repository .env or falls back to another database variable', () => {
    const env = { ...process.env }; delete env.IHEAR_CP6_NOT_CONFIGURED;
    const result = spawnSync(process.execPath, [path.resolve('scripts/verify-gallery-deployment.mjs'), '--phase', 'pre-024', '--database-env', 'IHEAR_CP6_NOT_CONFIGURED'], { encoding: 'utf8', env, windowsHide: true });
    expect(result.status).toBe(1); expect(result.stderr).toContain('never loads .env files');
    expect(result.stderr).not.toMatch(/postgres(?:ql)?:\/\//);
  });
  it('checks candidate reservation declarations without loading stores', async () => {
    expect((await reservedSlugContract()).reserved).toEqual(['announcements', 'calendar']);
  });
  it('accepts all five named galleries including video, draft system topics, and an empty post-024 Banner', () => {
    expect(validateSnapshot(snapshot(), manifest).migrationCount).toBe(23);
    const result = validateSnapshot(snapshot('post-024'), manifest);
    expect(result.galleries.find(row => row.id === 'home-banner').items).toBe(0);
    expect(result.topics.every(topic => topic.publicState === 'empty' && topic.validUnpublished)).toBe(true);
  });
  it('requires gallery identities rather than only matching a count', () => {
    const data = snapshot('post-024'); editRow(data, 'media_galleries', 0, row => { row.id = 'wrong'; });
    expect(() => validateSnapshot(data, manifest)).toThrow('tutoring');
  });
  it('does not retroactively reject an unchanged historical title above current input limits', () => {
    const data = snapshot(); editRow(data, 'media_galleries', 0, row => { row.items[0].title = { en: 'a'.repeat(121), zhHant: '', zhHans: '' }; });
    expect(() => validateSnapshot(data, manifest)).not.toThrow();
  });
  it.each(['checksum', 'name'])('blocks migration ledger %s mismatch', field => {
    const data = snapshot(); editRow(data, 'schema_migrations', 4, row => { row[field] = 'changed'; });
    expect(() => validateSnapshot(data, manifest)).toThrow('005');
  });
  it('blocks the wrong phase CHECK even when the correct number of rows is present', () => {
    const data = snapshot('post-024'); data.schema.constraints[0].definition = snapshot().schema.constraints[0].definition;
    expect(() => validateSnapshot(data, manifest)).toThrow('id_check');
  });
  it.each(['media_galleries_version_check', 'media_galleries_items_check', 'resource_topics_slug_key', 'resource_links_topic_fk'])('blocks missing required %s constraint', name => {
    const data = snapshot(); data.schema.constraints = data.schema.constraints.filter(row => row.name !== name);
    expect(() => validateSnapshot(data, manifest)).toThrow();
  });
  it('distinguishes a wrong fixed ID mapping from normal unpublished content', () => {
    const data = snapshot(); editRow(data, 'resource_topics', 1, row => { row.id = 'wrong-calendar'; });
    expect(() => validateSnapshot(data, manifest)).toThrow('mapping mismatch');
  });
  it('blocks duplicate slugs and missing parent IDs rather than treating them as empty', () => {
    const duplicate = snapshot(); editRow(duplicate, 'resource_topics', 1, row => { row.slug = 'announcements'; });
    expect(() => validateSnapshot(duplicate, manifest)).toThrow('Duplicate');
    const orphan = snapshot(); editRow(orphan, 'resource_links', 0, row => { row.topic_id = 'not-a-topic'; });
    expect(() => validateSnapshot(orphan, manifest)).toThrow('missing topic ID');
  });
  it('accepts only the four expected committed migration differences', () => {
    const before = snapshot(), after = upgrade(before);
    validateSnapshot(after, manifest);
    expect(compareSnapshots(before, after).allowedDifferences).toHaveLength(4);
  });
  it('detects changed legacy video, image metadata, array order and operation records', () => {
    const before = snapshot();
    for (const mutate of [
      after => editRow(after, 'media_galleries', 0, row => { row.items[1].videoId = 'changed'; }),
      after => editRow(after, 'media_galleries', 0, row => { row.items.reverse(); }),
      after => editRow(after, 'media_gallery_assets', 0, row => { row.payload.widths.reverse(); }),
      after => { after.tables.media_gallery_operations = []; },
    ]) {
      const after = upgrade(before); mutate(after); expect(() => compareSnapshots(before, after)).toThrow('Existing data changed');
    }
  });
  it('detects extra administrator writes/revision changes instead of restoring over them', () => {
    const before = snapshot(), after = upgrade(before);
    editRow(after, 'site_content_revisions', 0, row => { row.revision++; });
    expect(() => compareSnapshots(before, after)).toThrow('exactly one content revision');
  });
  it('keeps bigint digits exact and detects a one-unit difference above Number.MAX_SAFE_INTEGER', () => {
    const before = snapshot(), restored = structuredClone(before);
    restored.tables.site_content_revisions[1] = restored.tables.site_content_revisions[1].replace('9007199254741001', '9007199254741000');
    expect(() => compareSnapshots(before, restored)).toThrow('site_content_revisions');
  });
  it('requires a restored pre-024 database to exactly match the original pre-024 snapshot', () => {
    const before = snapshot(); expect(compareSnapshots(before, structuredClone(before)).allowedDifferences).toEqual([]);
    const restored = structuredClone(before); restored.schema.triggers[0].enabled = 'D';
    expect(() => compareSnapshots(before, restored)).toThrow('triggers changed');
  });
  it('accepts only identical server-deparsed CHECKs after pg_dump reparses BETWEEN grouping', () => {
    const before = snapshot();
    before.schema.constraints.push({ table_name: 'extra', name: 'range', definition: 'CHECK (((a >= 1) AND (a <= 10)) AND b)', normalized_definition: 'CHECK (a >= 1 AND a <= 10 AND b)' });
    const restored = structuredClone(before);
    restored.schema.constraints.at(-1).definition = 'CHECK ((a >= 1) AND (a <= 10) AND b)';
    expect(() => compareSnapshots(before, restored)).not.toThrow();
    restored.schema.constraints.at(-1).normalized_definition = 'CHECK ((a >= 1 OR a <= 10) AND b)';
    expect(() => compareSnapshots(before, restored)).toThrow('constraints');
  });
  it('permits repeat post-024 checks of administrator-cleared Banner without reseeding', () => {
    const empty = snapshot('post-024'); expect(compareSnapshots(empty, structuredClone(empty)).allowedDifferences).toEqual([]);
    expect(empty.tables.media_galleries.map(JSON.parse).find(row => row.id === 'home-banner').items).toEqual([]);
  });
});
