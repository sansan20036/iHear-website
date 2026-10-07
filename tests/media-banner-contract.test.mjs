import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import sharp from 'sharp';

vi.mock('../lib/admin-auth', () => ({
  authorizeAdminRequest: vi.fn(async () => ({ principal: { email: 'banner@example.com', role: 'editor' } })),
  isSameOrigin: request => !request.headers.get('origin') || request.headers.get('origin') === new URL(request.url).origin,
}));
vi.mock('../lib/rate-limit', async original => ({ ...await original(), enforceRateLimit: vi.fn(async () => ({ limited: false })) }));
vi.mock('../lib/site-media-store', () => ({ listSiteMediaAssets: vi.fn(async () => []) }));

const legacyIds = ['tutoring', 'outreach', 'home', 'stories', 'impact'];
const caption = { en: 'Existing caption', zhHant: '原有說明', zhHans: '原有说明' };
const title = { en: 'Classroom news', zhHant: '教室新消息', zhHans: '教室新消息' };
const context = id => ({ params: Promise.resolve({ id }) });
let root, dataFile, cwd, store, types, getPublic, post, getStatus, auth, siteMedia;

function legacyStore() {
  return {
    galleries: Object.fromEntries(legacyIds.map(id => [id, {
      id, version: 7, updatedAt: '2026-01-02T03:04:05.000Z', updatedBy: 'legacy@example.com',
      items: id === 'impact' ? [] : [{
        id: `legacy-${id}`, hidden: id === 'stories', caption: { ...caption },
        ...(id === 'tutoring' || id === 'outreach'
          ? { kind: 'photo', assetSlot: `services.${id}` }
          : { kind: 'youtube', videoId: 'LsQWwDBLKUc' }),
      }],
    }])),
    assets: { 'legacy-unreferenced-asset': { marker: 'retain historical immutable asset data' } },
    operations: {
      'c2754398-49dc-4f41-a3a2-ddc68bc6e538': {
        galleryId: 'home', actor: 'legacy@example.com', fingerprint: 'legacy-replay-fingerprint',
      },
    },
  };
}
const readSaved = async () => JSON.parse(await readFile(dataFile, 'utf8'));
const readGallery = async id => (await store.listGalleries()).find(gallery => gallery.id === id);
const publicRequest = query => new Request(`https://example.com/api/media-galleries${query || ''}`);
const mutationRequest = (id, body) => new Request(`https://example.com/api/media-galleries/${id}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', origin: 'https://example.com' }, body: JSON.stringify(body),
});
const mutate = (id, body) => post(mutationRequest(id, body), context(id));
function videoBody(version, extra = {}) {
  const operationId = randomUUID();
  return {
    operationId, expectedVersion: version, action: 'put',
    item: { id: operationId, kind: 'youtube', hidden: false, caption: { ...caption }, url: 'https://youtu.be/LsQWwDBLKUc?t=30', ...extra },
  };
}
function editPhoto(gallery, extra = {}) {
  const photo = gallery.items[0];
  return {
    operationId: randomUUID(), expectedVersion: gallery.version, action: 'put',
    item: { id: photo.id, kind: 'photo', hidden: photo.hidden, caption: photo.caption, ...extra },
  };
}
async function seedBanner(items) {
  const existing = legacyStore();
  existing.galleries['home-banner'] = { id: 'home-banner', version: 0, items, updatedAt: '', updatedBy: '' };
  await writeFile(dataFile, JSON.stringify(existing), 'utf8');
  return readGallery('home-banner');
}

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'ihear-banner-contract-'));
  await mkdir(path.join(root, 'data'));
  dataFile = path.join(root, 'data', 'media-galleries.json');
  vi.stubEnv('IHEAR_FORCE_FILE_STORE', '1');
  vi.stubEnv('IHEAR_TEST_DATA_DIR', path.join(root, 'data'));
  vi.stubEnv('AUTH_SECRET', 'isolated-banner-contract-key');
  cwd = vi.spyOn(process, 'cwd').mockReturnValue(root);
  ({ GET: getPublic } = await import('../app/api/media-galleries/route'));
  ({ POST: post, GET: getStatus } = await import('../app/api/media-galleries/[id]/route'));
  store = await import('../lib/media-gallery-store');
  types = await import('../lib/media-gallery-types');
  auth = await import('../lib/admin-auth');
  siteMedia = await import('../lib/site-media-store');
});
beforeEach(async () => {
  vi.clearAllMocks();
  auth.authorizeAdminRequest.mockResolvedValue({ principal: { email: 'banner@example.com', role: 'editor' } });
  siteMedia.listSiteMediaAssets.mockResolvedValue([]);
  await writeFile(dataFile, JSON.stringify(legacyStore()), 'utf8');
});
afterAll(async () => {
  cwd?.mockRestore();
  vi.unstubAllEnvs();
  if (!root) return;
  const resolved = await realpath(root);
  const temporaryRoot = await realpath(tmpdir());
  if (resolved !== path.resolve(root) || path.dirname(resolved) !== temporaryRoot || !path.basename(resolved).startsWith('ihear-banner-contract-')) {
    throw new Error('Refusing to remove an unexpected fixture directory');
  }
  await rm(resolved, { recursive: true });
});

describe('one-time file store upgrade', () => {
  test('retains all old IDs, values, versions, assets and replay records while persisting only the missing banner seed', async () => {
    const before = legacyStore();
    const result = await store.listGalleries();
    expect(types.GALLERY_IDS).toEqual([...legacyIds, 'home-banner']);
    expect(result.map(gallery => gallery.id)).toEqual([...legacyIds, 'home-banner']);
    for (const id of legacyIds) {
      expect(result.find(gallery => gallery.id === id)).toEqual({
        ...before.galleries[id], items: before.galleries[id].items.map(item => ({ ...item, title: null })),
      });
    }
    const saved = await readSaved();
    for (const id of legacyIds) expect(saved.galleries[id]).toEqual(before.galleries[id]);
    expect(saved.assets).toEqual(before.assets);
    expect(saved.operations).toEqual(before.operations);
    expect(saved.galleries['home-banner']).toEqual(expect.objectContaining({
      id: 'home-banner', version: 0,
      items: [expect.objectContaining({ kind: 'photo', hidden: false, assetSlot: 'home.hero', title: null })],
    }));
    const persisted = await readFile(dataFile, 'utf8');
    await store.listGalleries();
    expect(await readFile(dataFile, 'utf8')).toBe(persisted);
  });

  test('an administrator can clear the seeded banner and it remains empty across reads and a module reload', async () => {
    const banner = await readGallery('home-banner');
    const body = { operationId: randomUUID(), expectedVersion: banner.version, action: 'remove', itemId: banner.items[0].id };
    expect((await mutate('home-banner', body)).status).toBe(200);
    const saved = await readFile(dataFile, 'utf8');
    expect((await readGallery('home-banner')).items).toEqual([]);
    expect((await (await getPublic(publicRequest('?gallery=home-banner'))).json()).items[0].items).toEqual([]);
    vi.resetModules();
    const reloadedStore = await import('../lib/media-gallery-store');
    expect((await reloadedStore.listGalleries()).find(gallery => gallery.id === 'home-banner').items).toEqual([]);
    expect(await readFile(dataFile, 'utf8')).toBe(saved);
  });

  test('a pre-existing empty banner is not reinitialized even at version zero', async () => {
    const existing = legacyStore();
    existing.galleries['home-banner'] = { id: 'home-banner', version: 0, items: [], updatedAt: '', updatedBy: '' };
    await writeFile(dataFile, JSON.stringify(existing), 'utf8');
    const before = await readFile(dataFile, 'utf8');
    expect((await readGallery('home-banner')).items).toEqual([]);
    expect(await readFile(dataFile, 'utf8')).toBe(before);
  });
});

describe('public gallery API compatibility', () => {
  test('unfiltered GET keeps its envelope and five existing galleries, adding nullable titles and the sixth gallery', async () => {
    const response = await getPublic(publicRequest());
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store, max-age=0');
    expect(response.headers.get('Vercel-CDN-Cache-Control')).toBe('no-store');
    const result = await response.json();
    expect(Object.keys(result)).toEqual(['items']);
    expect(result.items.map(gallery => gallery.id)).toEqual([...legacyIds, 'home-banner']);
    expect(result.items.find(gallery => gallery.id === 'home').items[0]).toMatchObject({ kind: 'youtube', videoId: 'LsQWwDBLKUc', caption, title: null });
    expect(result.items.find(gallery => gallery.id === 'tutoring').items[0].image.src).toContain('tutoring-student');
    expect(result.items.find(gallery => gallery.id === 'stories').items).toEqual([]);
    expect(result.items.every(gallery => !('updatedBy' in gallery))).toBe(true);
    expect(result.items.flatMap(gallery => gallery.items).every(item => !('altStates' in item))).toBe(true);
  });

  test.each(['?gallery=home-banner', '?gallery_id=home-banner', '?gallery=home-banner&gallery_id=home-banner'])('supports validated filter %s', async query => {
    const response = await getPublic(publicRequest(query));
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.items.map(gallery => gallery.id)).toEqual(['home-banner']);
    expect(result.items[0].items[0]).toMatchObject({ title: null, assetSlot: 'home.hero', image: { src: '/assets/images/hero-classroom-1200.webp' } });
    expect(siteMedia.listSiteMediaAssets).toHaveBeenCalledOnce();
  });

  test.each([
    '?gallery=unknown', '?gallery=', '?gallery_id=', '?gallery=home-banner&gallery_id=home',
    '?gallery=home-banner&gallery=home-banner', '?gallery_id=home&gallery_id=home', '?gallery_id=unknown',
  ])('rejects invalid or ambiguous filter %s', async query => {
    const response = await getPublic(publicRequest(query));
    expect(response.status).toBe(400);
    expect(response.headers.get('Cache-Control')).toContain('no-store');
  });

  test('filtered admin GET requires authorization and retains hidden items only for authorized administrators', async () => {
    auth.authorizeAdminRequest.mockResolvedValueOnce({ response: new Response(null, { status: 403 }) });
    expect((await getPublic(publicRequest('?admin=1&gallery=stories'))).status).toBe(403);
    const admin = await (await getPublic(publicRequest('?admin=1&gallery=stories'))).json();
    expect(admin.items[0].items).toHaveLength(1);
    const publicResult = await (await getPublic(publicRequest('?gallery=stories'))).json();
    expect(publicResult.items[0].items).toEqual([]);
  });

  test('home.hero resolves the current custom asset and keeps private storage metadata out of public output', async () => {
    siteMedia.listSiteMediaAssets.mockResolvedValue([{
      slot: 'home.hero', alt: { en: 'Custom classroom', zhHant: '自訂教室', zhHans: '自定义教室' },
      focalX: 37, focalY: 62, zoom: 110, recordVersion: 4, updatedBy: 'private@example.com', updatedAt: '2026-01-02T03:04:05.000Z',
      variants: [{ width: 1200, pixelWidth: 1200, pixelHeight: 675, byteSize: 1234, mimeType: 'image/webp', url: '/old/url', storagePath: 'local:uploads/site-media/custom.webp' }],
    }]);
    const result = await (await getPublic(publicRequest('?gallery=home-banner'))).json();
    const image = result.items[0].items[0].image;
    expect(image).toMatchObject({ slot: 'home.hero', focalX: 37, focalY: 62, zoom: 110, recordVersion: 4, alt: { en: 'Custom classroom' } });
    expect(image.src).toContain('/api/site-media/home.hero/image?width=1200&v=4&asset=');
    expect(image).not.toHaveProperty('updatedBy');
    expect(image.variants[0]).not.toHaveProperty('storagePath');
  });
});

describe('nullable multilingual titles and mutation compatibility', () => {
  test('an old video payload still saves, replays, and reports operation status with a null title', async () => {
    const body = videoBody(7);
    const first = await mutate('home', body);
    expect(first.status).toBe(200);
    const added = (await first.json()).item.items.find(item => item.id === body.item.id);
    expect(added).toMatchObject({ kind: 'youtube', videoId: 'LsQWwDBLKUc', title: null, caption });
    const replay = await (await mutate('home', body)).json();
    expect(replay.replayed).toBe(true);
    expect(replay.item.items.filter(item => item.id === body.item.id)).toHaveLength(1);
    const status = await getStatus(new Request(`https://example.com/api/media-galleries/home?operationId=${body.operationId}`), context('home'));
    expect((await status.json()).committed).toBe(true);
  });

  test('title edits preserve legacy captions and photo references; omission preserves title and null explicitly clears it', async () => {
    const original = await readGallery('home-banner');
    const set = await mutate('home-banner', editPhoto(original, { title }));
    expect(set.status).toBe(200);
    expect((await set.json()).item.items[0]).toMatchObject({ title, assetSlot: 'home.hero', caption: original.items[0].caption });
    const omission = await mutate('home-banner', editPhoto(await readGallery('home-banner'), { hidden: true }));
    expect(omission.status).toBe(200);
    expect((await omission.json()).item.items[0]).toMatchObject({ title, hidden: true });
    expect((await (await getPublic(publicRequest('?gallery=home-banner'))).json()).items[0].items).toEqual([]);
    const clear = await mutate('home-banner', editPhoto(await readGallery('home-banner'), { title: null, hidden: false }));
    expect(clear.status).toBe(200);
    expect((await clear.json()).item.items[0].title).toBeNull();
  });

  test('the old caption-only photo payload upgrades missing title to null without altering the image reference', async () => {
    const body = editPhoto(await readGallery('tutoring'), { caption: { ...caption, en: 'Updated existing caption' } });
    const result = await mutate('tutoring', body);
    expect(result.status).toBe(200);
    expect((await result.json()).item.items[0]).toMatchObject({ assetSlot: 'services.tutoring', title: null, caption: { en: 'Updated existing caption' } });
  });

  test.each(legacyIds)('new titled videos remain supported in legacy gallery %s', async id => {
    const body = videoBody(7, { title });
    const result = await mutate(id, body);
    expect(result.status).toBe(200);
    const item = (await result.json()).item.items.find(item => item.id === body.item.id);
    expect(item).toMatchObject({ title, kind: 'youtube', caption });
  });

  test('new Banner videos and video edits are rejected without altering stored items or operations', async () => {
    await readGallery('home-banner');
    const before = await readFile(dataFile, 'utf8');
    const body = videoBody(0, { title });
    const rejected = await mutate('home-banner', body);
    expect(rejected.status).toBe(400);
    expect((await rejected.json()).error).toBe('Home Banner supports photos only');
    expect(await readFile(dataFile, 'utf8')).toBe(before);
    const legacyVideo = { id: 'legacy-banner-video', kind: 'youtube', hidden: false, caption, title, videoId: 'LsQWwDBLKUc' };
    const gallery = await seedBanner([legacyVideo]);
    const edit = videoBody(gallery.version, { ...legacyVideo, hidden: true });
    expect((await mutate('home-banner', edit)).status).toBe(400);
    expect((await readGallery('home-banner')).items).toEqual([legacyVideo]);
    const remove = { operationId: randomUUID(), expectedVersion: gallery.version, action: 'remove', itemId: legacyVideo.id };
    expect((await mutate('home-banner', remove)).status).toBe(200);
    expect((await readGallery('home-banner')).items).toEqual([]);
  });

  test('a previously committed Banner video operation still replays and exposes operation status', async () => {
    const body = videoBody(0, { title });
    const existing = legacyStore();
    existing.galleries['home-banner'] = {
      id: 'home-banner', version: 1, updatedAt: '2026-01-02T03:04:05.000Z', updatedBy: 'banner@example.com',
      items: [{ id: body.item.id, kind: 'youtube', hidden: false, caption, title, videoId: 'LsQWwDBLKUc' }],
    };
    existing.operations[body.operationId] = {
      galleryId: 'home-banner', actor: 'banner@example.com', fingerprint: createHash('sha256').update(JSON.stringify(body)).update('').digest('hex'),
    };
    await writeFile(dataFile, JSON.stringify(existing), 'utf8');
    const before = await readFile(dataFile, 'utf8');
    const replay = await mutate('home-banner', body);
    expect(replay.status).toBe(200);
    expect((await replay.json()).replayed).toBe(true);
    const status = await getStatus(new Request(`https://example.com/api/media-galleries/home-banner?operationId=${body.operationId}`), context('home-banner'));
    expect((await status.json()).committed).toBe(true);
    expect(await readFile(dataFile, 'utf8')).toBe(before);
  });

  test('a Banner photo upload round-trips title and hiding preserves immutable image metadata', async () => {
    const operationId = randomUUID();
    const alt = { en: 'Students at a classroom event', zhHant: '學生在教室參與活動', zhHans: '学生在教室参与活动' };
    const body = { operationId, expectedVersion: 0, action: 'put', alt, item: { id: operationId, kind: 'photo', hidden: false, caption, title } };
    const bytes = await sharp({ create: { width: 160, height: 90, channels: 3, background: '#d8c2ff' } }).webp().toBuffer();
    const form = new FormData();
    form.set('metadata', JSON.stringify(body));
    form.set('file', new File([bytes], 'banner.webp', { type: 'image/webp' }));
    const upload = new Request('https://example.com/api/media-galleries/home-banner', { method: 'POST', headers: { origin: 'https://example.com' }, body: form });
    const result = await post(upload, context('home-banner'));
    expect(result.status).toBe(200);
    const added = (await result.json()).item.items.find(item => item.id === operationId);
    expect(added).toMatchObject({ title, kind: 'photo', caption, image: { alt } });
    const immutableAsset = await store.getGalleryAsset(added.assetSlot);
    const hidden = { operationId: randomUUID(), expectedVersion: 1, action: 'put', item: { id: added.id, kind: 'photo', hidden: true, caption } };
    expect((await mutate('home-banner', hidden)).status).toBe(200);
    expect(await store.getGalleryAsset(added.assetSlot)).toEqual(immutableAsset);
    const admin = await (await getPublic(publicRequest('?admin=1&gallery=home-banner'))).json();
    expect(admin.items[0].items.find(item => item.id === added.id)).toMatchObject({ title, hidden: true, assetSlot: added.assetSlot, image: added.image });
    const visible = await (await getPublic(publicRequest('?gallery=home-banner'))).json();
    expect(visible.items[0].items.some(item => item.id === added.id)).toBe(false);
    const restored = { ...hidden, operationId: randomUUID(), expectedVersion: 2, item: { ...hidden.item, hidden: false } };
    expect((await mutate('home-banner', restored)).status).toBe(200);
    const publicAgain = await (await getPublic(publicRequest('?gallery=home-banner'))).json();
    expect(publicAgain.items[0].items.find(item => item.id === added.id)).toMatchObject({ title, hidden: false, assetSlot: added.assetSlot, image: added.image });
    expect(await store.getGalleryAsset(added.assetSlot)).toEqual(immutableAsset);
  });

  test.each(['en', 'zhHant', 'zhHans'])('title limit accepts 120 and rejects 121 UTF-16 code units in %s without changing caption limits', async locale => {
    expect(types.GALLERY_TITLE_LIMIT).toBe(120);
    const captionAtLimit = { ...caption, en: 'c'.repeat(300) };
    const valid = { ...title, [locale]: 'x'.repeat(120) };
    expect((await mutate('home-banner', editPhoto(await readGallery('home-banner'), { title: valid, caption: captionAtLimit }))).status).toBe(200);
    const saved = await readGallery('home-banner');
    expect(saved.items[0]).toMatchObject({ title: valid, caption: captionAtLimit });
    expect((await mutate('home-banner', editPhoto(saved, { title: { ...valid, [locale]: 'x'.repeat(121) } }))).status).toBe(400);
    expect(await readGallery('home-banner')).toEqual(saved);
    expect((await mutate('home-banner', editPhoto(saved, { title: { ...valid, [locale]: '😀'.repeat(60) } }))).status).toBe(200);
    const emojiSaved = await readGallery('home-banner');
    expect((await mutate('home-banner', editPhoto(emojiSaved, { title: { ...valid, [locale]: '😀'.repeat(61) } }))).status).toBe(400);
  });

  test('empty locale values remain empty; editing one language preserves the other two and explicit null clears the whole title', async () => {
    const partial = { en: 'English fallback', zhHant: '', zhHans: '' };
    expect((await mutate('home-banner', editPhoto(await readGallery('home-banner'), { title: partial }))).status).toBe(200);
    const publicResult = await (await getPublic(publicRequest('?gallery=home-banner'))).json();
    expect(publicResult.items[0].items[0].title).toEqual(partial);
    const edited = { ...partial, zhHant: '僅編輯繁體中文' };
    expect((await mutate('home-banner', editPhoto(await readGallery('home-banner'), { title: edited }))).status).toBe(200);
    expect((await readGallery('home-banner')).items[0].title).toEqual(edited);
    expect((await mutate('home-banner', editPhoto(await readGallery('home-banner'), { title: types.emptyCaption() }))).status).toBe(200);
    expect((await readGallery('home-banner')).items[0].title).toEqual(types.emptyCaption());
    expect((await mutate('home-banner', editPhoto(await readGallery('home-banner'), { title: null }))).status).toBe(200);
    expect((await readGallery('home-banner')).items[0].title).toBeNull();
  });

  test('omission and unrelated language edits preserve legacy titles over 120 characters; changed long titles are rejected', async () => {
    const oldTitle = { en: 'x'.repeat(300), zhHant: '保留原有文字', zhHans: '保持原有文字' };
    await seedBanner([{ id: 'legacy-long-title', kind: 'photo', hidden: false, caption, title: oldTitle, assetSlot: 'home.hero' }]);
    expect((await mutate('home-banner', editPhoto(await readGallery('home-banner'), { hidden: true }))).status).toBe(200);
    expect((await readGallery('home-banner')).items[0].title).toEqual(oldTitle);
    const edited = { ...oldTitle, zhHant: '修改繁體中文' };
    expect((await mutate('home-banner', editPhoto(await readGallery('home-banner'), { title: edited }))).status).toBe(200);
    expect((await readGallery('home-banner')).items[0]).toMatchObject({ title: edited, caption, assetSlot: 'home.hero' });
    const before = await readFile(dataFile, 'utf8');
    expect((await mutate('home-banner', editPhoto(await readGallery('home-banner'), { title: { ...edited, en: 'y'.repeat(121) } }))).status).toBe(400);
    expect(await readFile(dataFile, 'utf8')).toBe(before);
  });

  test.each([
    'a string', 42, [], { en: 'English only' }, { ...title, zhHans: 42 }, { ...title, zhHant: null }, { ...title, en: 'x'.repeat(121) },
  ])('rejects malformed title %j before mutation', async invalidTitle => {
    const banner = await readGallery('home-banner');
    const before = await readFile(dataFile, 'utf8');
    const body = editPhoto(banner, { title: invalidTitle });
    expect((await mutate('home-banner', body)).status).toBe(400);
    expect(await readFile(dataFile, 'utf8')).toBe(before);
    expect(await store.operationStatus(body.operationId, 'home-banner', 'banner@example.com')).toBeNull();
  });

  test('concurrent banner edits retain version conflicts and operation fingerprint protection', async () => {
    const banner = await readGallery('home-banner');
    const bodies = [editPhoto(banner, { title }), editPhoto(banner, { title: null, hidden: true })];
    const responses = await Promise.all(bodies.map(body => mutate('home-banner', body)));
    expect(responses.map(response => response.status).sort()).toEqual([200, 409]);
    const winner = bodies[responses.findIndex(response => response.status === 200)];
    expect((await readGallery('home-banner')).items).toHaveLength(1);
    expect((await readGallery('home-banner')).items[0]).toMatchObject({ title: winner.item.title, hidden: winner.item.hidden });
    const replay = await (await mutate('home-banner', winner)).json();
    expect(replay.replayed).toBe(true);
    const changed = structuredClone(winner);
    changed.item.title = { ...title, en: 'Changed operation payload' };
    expect((await mutate('home-banner', changed)).status).toBe(409);
  });

  test('banner reorder and removal preserve item titles, versions, and all unrelated legacy data', async () => {
    const original = legacyStore();
    const banner = await readGallery('home-banner');
    const secondPhoto = { id: 'second-photo', kind: 'photo', hidden: false, caption, title, assetSlot: 'services.tutoring' };
    await seedBanner([...banner.items, secondPhoto]);
    const move = { operationId: randomUUID(), expectedVersion: 0, action: 'move', itemId: secondPhoto.id, direction: -1 };
    const moved = await mutate('home-banner', move);
    expect(moved.status).toBe(200);
    expect((await moved.json()).item.items[0]).toMatchObject(secondPhoto);
    const remove = { operationId: randomUUID(), expectedVersion: 1, action: 'remove', itemId: secondPhoto.id };
    expect((await mutate('home-banner', remove)).status).toBe(200);
    const saved = await readSaved();
    expect(saved.galleries['home-banner'].version).toBe(2);
    expect(saved.galleries['home-banner'].items).toHaveLength(1);
    for (const id of legacyIds) expect(saved.galleries[id]).toEqual(original.galleries[id]);
    expect(saved.assets).toEqual(original.assets);
    expect(saved.operations['c2754398-49dc-4f41-a3a2-ddc68bc6e538']).toEqual(original.operations['c2754398-49dc-4f41-a3a2-ddc68bc6e538']);
  });
});
