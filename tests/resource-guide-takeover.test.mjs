import { beforeAll, afterAll, expect, test, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { guidesTakeoverState, migratedGuideIds } from '../lib/resource-guides-takeover.ts';
import { initialResourceTopics } from '../lib/resource-topic-model.ts';
import { loadResourceApi, request } from './helpers/resource-api-contract.mjs';

const seedTopics = initialResourceTopics();
const post = { schemaVersion: 2, legacyGuidesMigrated: true,
  topics: seedTopics.map(topic => topic.id === 'guides' ? { ...topic, status: 'published' } : topic),
  items: migratedGuideIds.map((id, index) => ({ id, category: 'form', topicId: 'guides', type: 'email_request', url: '', title: { en: `Guide ${index}`, zhHant: `指南繁 ${index}`, zhHans: `指南简 ${index}` }, description: { en: '', zhHant: '', zhHans: '' }, sortOrder: index * 10, status: 'published', version: 1, createdAt: seedTopics[0].createdAt, updatedAt: seedTopics[0].updatedAt, createdBy: 'test', updatedBy: 'test', states: [] })) };
const pre = { ...post, legacyGuidesMigrated: undefined, topics: initialResourceTopics(), items: post.items.filter(item => !migratedGuideIds.includes(item.id)) };
let directory, api;
beforeAll(async () => {
  await mkdir('output/checkpoint-6-tests', { recursive: true });
  directory = await mkdtemp(path.resolve('output/checkpoint-6-tests/takeover-'));
  vi.stubEnv('IHEAR_FORCE_FILE_STORE', '1'); vi.stubEnv('IHEAR_TEST_DATA_DIR', directory);
  vi.stubEnv('POSTGRES_URL', ''); vi.stubEnv('DATABASE_URL', '');
  api = await loadResourceApi();
});
afterAll(() => vi.unstubAllEnvs());
const get = async doc => {
  const serialized = JSON.stringify(doc);
  const file = path.join(directory, 'resource-links.json');
  await writeFile(file, serialized);
  const response = await api.items.GET(request('resources'));
  expect(await readFile(file, 'utf8')).toBe(serialized);
  return { status: response.status, body: await response.json() };
};
test('pre-takeover read explicitly selects legacy without writing data', async () => {
  const result = await get(pre); expect(result.status).toBe(200); expect(result.body.guidesTakeover).toBe('legacy');
});
test('complete marker returns exactly nine migrated email requests', async () => {
  const result = await get(post); expect(result.status).toBe(200); expect(result.body.guidesTakeover).toBe('complete');
  const guides = result.body.items.filter(i => i.topicId === 'guides'); expect(guides).toHaveLength(9);
  expect(guides.every(i => i.type === 'email_request')).toBe(true);
  for (const guide of guides) expect(guide.title).toEqual(post.items.find(i => i.id === guide.id).title);
});
test('hidden/archived migrated records keep takeover complete without exposing their content', async () => {
  for (const status of ['draft', 'archived']) {
    const doc = structuredClone(post); doc.topics.find(t => t.id === 'guides').status = 'draft';
    doc.items.filter(i => i.topicId === 'guides').forEach(i => { i.status = status; if (status === 'archived') i.archivedFromStatus = 'published'; });
    const result = await get(doc); expect(result.status).toBe(200); expect(result.body.guidesTakeover).toBe('complete');
    expect(result.body.items.some(i => i.topicId === 'guides')).toBe(false);
  }
});
test('missing, corrupt or partial marker/data fails closed', async () => {
  for (const marker of [undefined, false, 'invalid', null]) {
    const result = await get({ ...post, legacyGuidesMigrated: marker });
    expect(result.status).toBe(503); expect(result.body.items).toBeUndefined();
  }
  const result = await get({ ...post, items: post.items.filter(i => i.id !== 'guide-communication') });
  expect(result.status).toBe(503);
});
test('SQL and file marker representations agree; duplicate IDs and missing parents are invalid', () => {
  expect(guidesTakeoverState('complete', post.topics, post.items)).toBe('complete');
  expect(guidesTakeoverState(true, post.topics, post.items)).toBe('complete');
  expect(guidesTakeoverState(true, post.topics, [...post.items, post.items.find(i => i.id === 'guide-communication')])).toBe('unavailable');
  expect(guidesTakeoverState(true, post.topics.filter(t => t.id !== 'guides'), post.items)).toBe('unavailable');
});
