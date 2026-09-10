import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, rename, writeFile, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { youtubeVideoId } from '../assets/youtube.js';
vi.mock('node:fs/promises', async original => { const fs = await original(); return { ...fs, rename: vi.fn(fs.rename), writeFile: vi.fn(fs.writeFile), mkdir: vi.fn(fs.mkdir), rmdir: vi.fn(fs.rmdir) }; });

vi.mock('../lib/admin-auth', () => ({
  authorizeAdminRequest: vi.fn(async () => ({ principal: { email: 'gallery@example.com', role: 'editor' } })),
  isSameOrigin: request => !request.headers.get('origin') || request.headers.get('origin') === new URL(request.url).origin,
}));
vi.mock('../lib/rate-limit', async original => ({ ...await original(), enforceRateLimit: vi.fn(async () => ({ limited: false })) }));
vi.mock('../lib/site-media-store', () => ({ listSiteMediaAssets: vi.fn(async () => []) }));

let root, cwd, post, getStatus, getPublic, store, auth, rate, bytes;
const context = id => ({ params: Promise.resolve({ id }) });
const captions = { en: '', zhHant: '', zhHans: '' };
const alt = { en: 'A volunteer at an event', zhHant: '參加活動的志工', zhHans: '参加活动的志工' };
const videoBody = (version, operationId = randomUUID()) => ({ operationId, expectedVersion: version, action: 'put', item: { id: operationId, kind: 'youtube', hidden: false, caption: captions, url: 'https://youtu.be/LsQWwDBLKUc?si=tracking&t=42' } });
const jsonRequest = (id, body, origin = 'https://example.com') => new Request(`https://example.com/api/media-galleries/${id}`, { method: 'POST', headers: { 'Content-Type': 'application/json', origin }, body: JSON.stringify(body) });
const uploadBody = (version, operationId = randomUUID()) => ({ operationId, expectedVersion: version, action: 'put', alt, item: { id: operationId, kind: 'photo', hidden: false, caption: captions } });
function uploadRequest(id, body) {
  const form = new FormData(); form.set('metadata', JSON.stringify(body)); form.set('file', new File([bytes], 'photo.webp', { type: 'image/webp' }));
  return new Request(`https://example.com/api/media-galleries/${id}`, { method: 'POST', headers: { origin: 'https://example.com' }, body: form });
}
beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'ihear-gallery-test-')); await mkdir(path.join(root, 'data'));
  vi.stubEnv('IHEAR_FORCE_FILE_STORE', '1');
  vi.stubEnv('AUTH_SECRET', 'isolated-gallery-unit-test-key');
  cwd = vi.spyOn(process, 'cwd').mockReturnValue(root);
  ({ POST: post, GET: getStatus } = await import('../app/api/media-galleries/[id]/route'));
  ({ GET: getPublic } = await import('../app/api/media-galleries/route'));
  store = await import('../lib/media-gallery-store');
  auth = await import('../lib/admin-auth'); rate = await import('../lib/rate-limit');
  bytes = await sharp({ create: { width: 90, height: 160, channels: 3, background: '#ded0ff' } }).webp().toBuffer();
});
afterAll(() => { cwd.mockRestore(); vi.unstubAllEnvs(); });
beforeEach(() => { vi.clearAllMocks(); auth.authorizeAdminRequest.mockResolvedValue({ principal: { email: 'gallery@example.com', role: 'editor' } }); });

describe('YouTube URL boundaries', () => {
  test.each(['https://youtu.be/LsQWwDBLKUc?si=abc&t=2#x','https://www.youtube.com/watch?v=LsQWwDBLKUc&list=ignored','https://m.youtube.com/shorts/LsQWwDBLKUc?feature=share','https://youtube.com/live/LsQWwDBLKUc','https://www.youtube-nocookie.com/embed/LsQWwDBLKUc'])('extracts only the video ID: %s', url => expect(youtubeVideoId(url)).toBe('LsQWwDBLKUc'));
  test.each(['https://youtube.com.evil.test/watch?v=LsQWwDBLKUc','https://youtube.com@evil.test/watch?v=LsQWwDBLKUc','https://youtu.be/short','https://youtu.be/LsQWwDBLKUcX','https://youtu.be/LsQWwDBLKU!','https://youtu.be/LsQWwDBLKUc/extra','javascript:alert(1)','<iframe src="https://youtu.be/LsQWwDBLKUc"></iframe>'])('rejects unsafe/invalid input: %s', url => expect(youtubeVideoId(url)).toBeNull());
});
test('initial references preserve existing content; empty impact is empty', async () => {
  const result = await (await getPublic(new Request('https://example.com/api/media-galleries'))).json();
  expect(result.items).toHaveLength(5);
  expect(result.items.find(g => g.id === 'tutoring').items[0].image.src).toContain('tutoring-student');
  expect(result.items.find(g => g.id === 'impact').items).toEqual([]);
  expect(result.items.every(g => !('updatedBy' in g))).toBe(true);
});
test('authorization and cross-origin protection apply before writes', async () => {
  auth.authorizeAdminRequest.mockResolvedValueOnce({ response: new Response(null, { status: 403 }) });
  expect((await post(jsonRequest('home', videoBody(0)), context('home'))).status).toBe(403);
  expect((await post(jsonRequest('home', videoBody(0), 'https://evil.test'), context('home'))).status).toBe(403);
});
test('lost-response replay is idempotent and a changed payload is rejected', async () => {
  const body = videoBody(0);
  const first = await post(jsonRequest('home', body), context('home')); expect(first.status).toBe(200);
  const replay = await (await post(jsonRequest('home', body), context('home'))).json(); expect(replay.replayed).toBe(true); expect(replay.item.items).toHaveLength(2);
  const status = await (await getStatus(new Request(`https://example.com/api/media-galleries/home?operationId=${body.operationId}`), context('home'))).json(); expect(status.committed).toBe(true);
  const changed = structuredClone(body); changed.item.hidden = true;
  expect((await post(jsonRequest('home', changed), context('home'))).status).toBe(409);
});
test('two concurrent editors cannot overwrite each other', async () => {
  const results = await Promise.all([videoBody(0), videoBody(0)].map(body => post(jsonRequest('stories', body), context('stories'))));
  expect(results.map(r => r.status).sort()).toEqual([200,409]);
  expect((await store.listGalleries()).find(g => g.id === 'stories').items).toHaveLength(2);
});
test('20 sequential photos succeed, use the gallery quota, and reject the 21st', async () => {
  for (let version = 0; version < 20; version++) {
    const result = await post(uploadRequest('impact', uploadBody(version)), context('impact'));
    expect(result.status, JSON.stringify(await result.clone().json())).toBe(200);
  }
  expect(rate.enforceRateLimit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ scope: 'gallery-upload', limit: 30, windowSeconds: 600 }));
  expect((await post(uploadRequest('impact', uploadBody(20)), context('impact'))).status).toBe(400);
  expect((await store.listGalleries()).find(g => g.id === 'impact').items).toHaveLength(20);
}, 30_000);
test('replacement uses new immutable files and removal retains the saved assets', async () => {
  const body = uploadBody(0); const result = await (await post(uploadRequest('outreach', body), context('outreach'))).json();
  const photo = result.item.items[1]; const old = await store.getGalleryAsset(photo.assetSlot);
  const replacement = uploadBody(1); replacement.item.id = photo.id;
  const updated = await (await post(uploadRequest('outreach', replacement), context('outreach'))).json();
  expect(updated.item.items[1].image.src).not.toBe(photo.image.src);
  const remove = { operationId: randomUUID(), expectedVersion: 2, action: 'remove', itemId: photo.id };
  expect((await post(jsonRequest('outreach', remove), context('outreach'))).status).toBe(200);
  expect(await store.getGalleryAsset(photo.assetSlot)).toEqual(old);
  for (const variant of old.asset.variants) expect((await readFile(path.join(root, 'public', variant.storagePath.slice(6)))).length).toBeGreaterThan(0);
});
test('hidden media is excluded publicly, captions and manual Chinese are preserved', async () => {
  const gallery = (await store.listGalleries()).find(g => g.id === 'impact');
  const photo = gallery.items[0];
  const body = { operationId: randomUUID(), expectedVersion: gallery.version, action: 'put', item: { ...photo, hidden: true } };
  expect((await post(jsonRequest('impact', body), context('impact'))).status).toBe(200);
  const publicResult = await (await getPublic(new Request('https://example.com/api/media-galleries'))).json();
  expect(publicResult.items.find(g => g.id === 'impact').items.some(i => i.id === photo.id)).toBe(false);
  const adminResult = await (await getPublic(new Request('https://example.com/api/media-galleries?admin=1'))).json();
  expect(adminResult.items.find(g => g.id === 'impact').items).toHaveLength(20);
  const asset = await store.getGalleryAsset(photo.assetSlot); expect(asset.asset.alt).toEqual(alt); expect(asset.states.every(s => s.origin === 'manual')).toBe(true);
});
test('invalid fields fail before storage and operation IDs cannot leak between admins', async () => {
  const body = uploadBody(0); body.alt = { en: 'Photo', zhHant: '', zhHans: '' };
  expect((await post(uploadRequest('tutoring', body), context('tutoring'))).status).toBe(400);
  expect(await store.operationStatus(body.operationId, 'tutoring', 'gallery@example.com')).toBeNull();
  const saved = JSON.parse(await readFile(path.join(root, 'data/media-galleries.json'), 'utf8'));
  const id = Object.keys(saved.operations)[0];
  await expect(store.operationStatus(id, saved.operations[id].galleryId, 'other@example.com')).rejects.toMatchObject({ status: 409 });
  expect((await readdir(path.join(root, 'data'))).filter(f => f.endsWith('.tmp') || f.endsWith('.lock'))).toEqual([]);
});

test('editing a photo preserves machine provenance and rejects unpreviewed English changes', async () => {
  const { buildTranslationPreview } = await import('../lib/translation-core');
  const body = uploadBody(0);
  const preview = await buildTranslationPreview({ email: 'gallery@example.com', resource: { type: 'media', scope: '', id: `gallery.${body.operationId}`, version: 0 }, fields: { alt: { en: 'A volunteer at an event', zhHant: '', zhHans: '' } }, states: [], translate: async () => ['志工參與活動'] });
  body.alt = preview.fields.alt.value; body.translationReceipt = preview.receipt;
  const saved = await (await post(uploadRequest('tutoring', body), context('tutoring'))).json();
  expect(saved.ok).toBe(true);
  const item = saved.item.items[1]; expect(item.altStates.every(s => s.origin === 'machine')).toBe(true);
  const edit = { operationId: randomUUID(), expectedVersion: 1, action: 'put', item: { id: item.id, kind: 'photo', hidden: false, caption: captions }, alt: { ...body.alt, zhHant: '手動修正的志工描述' } };
  const updated = await (await post(jsonRequest('tutoring', edit), context('tutoring'))).json();
  expect(updated.ok).toBe(true);
  const states = updated.item.items[1].altStates;
  expect(states.find(s => s.locale === 'zhHant').origin).toBe('manual');
  expect(states.find(s => s.locale === 'zhHans').origin).toBe('machine');
  const invalid = { ...edit, operationId: randomUUID(), expectedVersion: 2, alt: { ...edit.alt, en: 'A different activity' } };
  expect((await post(jsonRequest('tutoring', invalid), context('tutoring'))).status).toBe(409);
  const publicResult = await (await getPublic(new Request('https://example.com/api/media-galleries'))).json();
  expect(publicResult.items.flatMap(g => g.items).every(i => !('altStates' in i))).toBe(true);
});

test('a temporary Windows destination lock is retried without losing saved data', async () => {
  const before = (await store.listGalleries()).find(g => g.id === 'home');
  rename.mockRejectedValueOnce(Object.assign(new Error('File temporarily in use'), { code: 'EPERM' }));
  const response = await post(jsonRequest('home', videoBody(before.version)), context('home'));
  expect(response.status).toBe(200);
  const after = (await store.listGalleries()).find(g => g.id === 'home');
  expect(after.items.slice(0, before.items.length)).toEqual(before.items);
  expect(after.items).toHaveLength(before.items.length + 1);
  expect(rename.mock.calls.length).toBeGreaterThanOrEqual(2);
});

async function storedPhotoFiles() {
  return (await readdir(path.join(root, 'public/uploads/site-media'), { recursive: true })).filter(file => file.endsWith('.webp')).sort();
}

test.each(['rename', 'temporary write', 'lock creation'])('failed local %s cleans new photos and retries the same operation safely', async stage => {
  const fs = await vi.importActual('node:fs/promises');
  const before = (await store.listGalleries()).find(g => g.id === 'home');
  const filesBefore = await storedPhotoFiles();
  const body = uploadBody(before.version);
  const error = Object.assign(new Error('Injected local persistence failure'), { code: stage === 'lock creation' ? 'EACCES' : 'ENOSPC' });
  if (stage === 'rename') rename.mockRejectedValueOnce(error);
  if (stage === 'temporary write') writeFile.mockImplementation((file, ...args) => String(file).endsWith('.tmp') ? Promise.reject(error) : fs.writeFile(file, ...args));
  if (stage === 'lock creation') mkdir.mockImplementation((file, ...args) => String(file).endsWith('.lock') ? Promise.reject(error) : fs.mkdir(file, ...args));
  try {
    expect((await post(uploadRequest('home', body), context('home'))).status).toBe(503);
    expect(await storedPhotoFiles()).toEqual(filesBefore);
    expect((await store.listGalleries()).find(g => g.id === 'home')).toEqual(before);
    expect(await store.operationStatus(body.operationId, 'home', 'gallery@example.com')).toBeNull();
    expect((await readdir(path.join(root, 'data'))).filter(f => f.endsWith('.tmp') || f.endsWith('.lock'))).toEqual([]);
  } finally {
    rename.mockImplementation(fs.rename); writeFile.mockImplementation(fs.writeFile); mkdir.mockImplementation(fs.mkdir);
  }
  const retry = await (await post(uploadRequest('home', body), context('home'))).json();
  expect(retry.ok).toBe(true);
  expect(retry.item.items.filter(item => item.id === body.operationId)).toHaveLength(1);
  expect(await storedPhotoFiles()).toHaveLength(filesBefore.length + 3);
});

test('lock cleanup failure after a successful commit preserves photos and permits replay', async () => {
  const fs = await vi.importActual('node:fs/promises');
  const before = (await store.listGalleries()).find(g => g.id === 'home');
  const filesBefore = await storedPhotoFiles();
  const body = uploadBody(before.version);
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  rmdir.mockRejectedValueOnce(Object.assign(new Error('Injected cleanup failure'), { code: 'EBUSY' }));
  try {
    expect((await post(uploadRequest('home', body), context('home'))).status).toBe(503);
    expect(await store.operationStatus(body.operationId, 'home', 'gallery@example.com')).not.toBeNull();
    const committedFiles = await storedPhotoFiles();
    expect(committedFiles).toHaveLength(filesBefore.length + 3);
    const replay = await (await post(uploadRequest('home', body), context('home'))).json();
    expect(replay.replayed).toBe(true);
    expect(replay.item.items.filter(item => item.id === body.operationId)).toHaveLength(1);
    expect(await storedPhotoFiles()).toEqual(committedFiles);
  } finally {
    log.mockRestore();
    await fs.rmdir(path.join(root, 'data/media-galleries.json.lock'));
  }
});

test('an unknown commit outcome retains saved photos until operation replay confirms success', async () => {
  const before = (await store.listGalleries()).find(g => g.id === 'home');
  const filesBefore = await storedPhotoFiles();
  const body = uploadBody(before.version);
  const mutate = store.mutateGallery;
  const spy = vi.spyOn(store, 'mutateGallery').mockImplementationOnce(async input => {
    await mutate(input);
    throw Object.assign(new Error('Response lost after commit'), { code: 'ETIMEDOUT' });
  });
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    expect((await post(uploadRequest('home', body), context('home'))).status).toBe(503);
    expect(await storedPhotoFiles()).toHaveLength(filesBefore.length + 3);
    const replay = await (await post(uploadRequest('home', body), context('home'))).json();
    expect(replay.replayed).toBe(true);
    expect(replay.item.items.filter(item => item.id === body.operationId)).toHaveLength(1);
    expect(await storedPhotoFiles()).toHaveLength(filesBefore.length + 3);
  } finally { spy.mockRestore(); log.mockRestore(); }
});

test('a known database constraint rejection cleans only the rejected upload', async () => {
  const before = (await store.listGalleries()).find(g => g.id === 'home');
  const filesBefore = await storedPhotoFiles();
  const body = uploadBody(before.version);
  const spy = vi.spyOn(store, 'mutateGallery').mockRejectedValueOnce(Object.assign(new Error('Injected foreign-key failure'), { code: '23503' }));
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    expect((await post(uploadRequest('home', body), context('home'))).status).toBe(503);
    expect(await storedPhotoFiles()).toEqual(filesBefore);
    expect(await store.operationStatus(body.operationId, 'home', 'gallery@example.com')).toBeNull();
  } finally { spy.mockRestore(); log.mockRestore(); }
});
