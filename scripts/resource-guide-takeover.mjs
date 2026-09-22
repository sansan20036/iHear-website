// Pure offline conversion used by the isolated rehearsal. No env or connections.
import assert from 'node:assert/strict';
import { migrateResourceDocument, validateResourceDocument } from '../lib/resource-topic-model.ts';

export const GUIDE_TAKEOVER_KEY = 'resource_guides_takeover_v1';
export const guideKeys = ['communication', 'classroom', 'family', 'hearing-loss', 'implant', 'hearing-aid', 'activities', 'tracking', 'handbook'];
const locales = ['en', 'zhHant', 'zhHans'];
const empty = () => ({ en: '', zhHant: '', zhHans: '' });
export function resourceDocumentFromTables(tables) {
  const states = (id, scope) => (tables.localized_translation_states || []).filter(row => row.resource_type === 'resource' && row.resource_scope === scope && row.resource_id === id)
    .map(row => ({ field: row.field_key, locale: row.locale, sourceHash: row.source_hash, origin: row.origin, glossaryVersion: row.glossary_version, updatedAt: new Date(row.updated_at).toISOString(), updatedBy: row.updated_by }));
  const common = row => ({ id: row.id, title: row.title, description: row.description, sortOrder: row.sort_order, status: row.status, version: row.version,
    createdAt: new Date(row.created_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString(), createdBy: row.created_by, updatedBy: row.updated_by,
    ...(row.archived_from_status ? { archivedFromStatus: row.archived_from_status } : {}) });
  const document = { items: tables.resource_links.map(row => ({ ...common(row), category: row.category, url: row.url, ...(row.topic_id ? { topicId: row.topic_id } : {}), ...(row.type ? { type: row.type } : {}), states: states(row.id, '') })) };
  if (tables.resource_topics) document.topics = tables.resource_topics.map(row => ({ ...common(row), slug: row.slug, states: states(row.id, 'topic') }));
  if (tables.site_settings?.some(row => row.key === GUIDE_TAKEOVER_KEY && row.value === 'complete')) document.legacyGuidesMigrated = true;
  return migrateResourceDocument(document);
}

export function planGuideTakeover(snapshot, catalog) {
  const { tables, createdAt } = snapshot;
  const content = key => Object.fromEntries(locales.map(locale => {
    const row = tables.localized_content_overrides.find(row => row.page === '/resources' && row.key === key && row.locale === locale);
    const legacy = locale === 'zhHant' ? tables.content_overrides?.find(row => row.page === '/resources' && row.key === key) : undefined;
    const fallback = catalog.slots.find(slot => slot.page === '/resources' && slot.key === key)?.values[locale];
    const value = row?.value ?? legacy?.value ?? fallback;
    assert.equal(typeof value, 'string', 'Missing source locale: ' + key + '/' + locale);
    return [locale, value];
  }));
  const states = (key, field) => ['zhHant', 'zhHans'].map(locale => {
    const state = tables.localized_translation_states.find(row => row.resource_type === 'content' && row.resource_scope === '/resources' && row.resource_id === key && row.field_key === 'value' && row.locale === locale);
    return { field, locale, sourceHash: state?.source_hash ?? null, origin: state?.origin || 'protected_legacy', glossaryVersion: state?.glossary_version || 'ihear-2026-08-v1', updatedAt: state ? new Date(state.updated_at).toISOString() : createdAt, updatedBy: state?.updated_by || 'guide-takeover-v1' };
  });
  const layout = tables.site_layout_configs.find(row => row.page === '/resources')?.config;
  const order = layout?.orders?.['resources.guides'] || guideKeys;
  assert.equal(order.length, 9, 'Guide order length'); assert.deepEqual([...order].sort(), [...guideKeys].sort(), 'Guide order membership');
  // The old layout model has section hiding, not per-guide hiding. Preserve its
  // group status on the topic; do not infer status from missing/empty translations.
  const hidden = layout?.hiddenSections?.some(key => ['resources', 'resources.guides', 'resource-guides'].includes(key)) || false;
  const metadata = { version: 1, createdAt, updatedAt: createdAt, createdBy: 'guide-takeover-v1', updatedBy: 'guide-takeover-v1' };
  const guides = guideKeys.map((key, n) => ({ ...metadata, id: 'guide-' + key, title: content('resources.res' + (n + 1)), description: empty(),
    sortOrder: (order.indexOf(key) + 1) * 10, status: 'published', category: 'form', url: '', topicId: 'guides', type: 'email_request', states: states('resources.res' + (n + 1), 'title') }));
  return { title: content('resources.res.heading'), description: content('resources.res.subtitle'), status: hidden ? 'draft' : 'published', states: [...states('resources.res.heading', 'title'), ...states('resources.res.subtitle', 'description')], guides };
}

export function applyGuideTakeover(source, plan) {
  const document = migrateResourceDocument(source);
  if (document.legacyGuidesMigrated === true) return document;
  const topic = document.topics.find(row => row.id === 'guides');
  assert.ok(topic && topic.version === 1 && topic.createdBy === 'migration-023' && topic.updatedBy === 'migration-023' && topic.status === 'draft', 'Guides placeholder was modified; stop for review');
  assert.ok(!document.items.some(row => row.topicId === 'guides' || plan.guides.some(guide => guide.id === row.id)), 'Guide import collision; stop for review');
  Object.assign(topic, { title: structuredClone(plan.title), description: structuredClone(plan.description), status: plan.status, states: structuredClone(plan.states), version: 2, updatedAt: plan.guides[0].updatedAt, updatedBy: 'guide-takeover-v1' });
  document.items.push(...structuredClone(plan.guides)); document.legacyGuidesMigrated = true;
  validateResourceDocument(document); return document;
}

const quote = value => "'" + String(value).replaceAll("'", "''") + "'";
export const sqlJson = value => quote(JSON.stringify(value)) + '::jsonb';
export function guideTakeoverSql(plan) {
  const rows = plan.guides.map(row => ({ id: row.id, title: row.title, description: row.description, sort_order: row.sortOrder, status: row.status, version: row.version,
    created_at: row.createdAt, updated_at: row.updatedAt, created_by: row.createdBy, updated_by: row.updatedBy, archived_from_status: null, category: row.category, url: row.url, topic_id: row.topicId, type: row.type }));
  const translation = (values, id, scope) => values.map(row => ({ resource_type: 'resource', resource_scope: scope, resource_id: id, field_key: row.field, locale: row.locale, source_hash: row.sourceHash, origin: row.origin, glossary_version: row.glossaryVersion, updated_at: row.updatedAt, updated_by: row.updatedBy }));
  const states = [...translation(plan.states, 'guides', 'topic'), ...plan.guides.flatMap(row => translation(row.states, row.id, ''))];
  return `DO $takeover$ BEGIN
    PERFORM pg_advisory_xact_lock(hashtext('ihear-guide-takeover-v1'));
    IF NOT EXISTS (SELECT 1 FROM site_settings WHERE key='${GUIDE_TAKEOVER_KEY}' AND value='complete') THEN
      IF NOT EXISTS (SELECT 1 FROM resource_topics WHERE id='guides' AND version=1 AND created_by='migration-023' AND updated_by='migration-023' AND status='draft')
        OR EXISTS (SELECT 1 FROM resource_links WHERE topic_id='guides' OR id IN (SELECT id FROM jsonb_populate_recordset(NULL::resource_links,${sqlJson(rows)})))
        THEN RAISE EXCEPTION 'Guides placeholder/import collision; stop for review'; END IF;
      UPDATE resource_topics SET title=${sqlJson(plan.title)},description=${sqlJson(plan.description)},status=${quote(plan.status)},version=2,updated_at=${quote(plan.guides[0].updatedAt)},updated_by='guide-takeover-v1' WHERE id='guides';
      INSERT INTO resource_links SELECT * FROM jsonb_populate_recordset(NULL::resource_links,${sqlJson(rows)});
      DELETE FROM localized_translation_states WHERE resource_type='resource' AND resource_scope='topic' AND resource_id='guides';
      INSERT INTO localized_translation_states SELECT * FROM jsonb_populate_recordset(NULL::localized_translation_states,${sqlJson(states)});
      INSERT INTO site_settings(key,value,updated_by) VALUES ('${GUIDE_TAKEOVER_KEY}','complete','guide-takeover-v1');
    END IF;
  END $takeover$;`;
}
