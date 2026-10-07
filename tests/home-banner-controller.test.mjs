import { readFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { afterAll, afterEach, beforeAll, expect, test } from 'vitest';
import { renderHomeBanner } from '../lib/home-banner-render';

// Execute the actual browser controller and SSR markup with controlled network,
// clock and image decoding. The production-build smoke covers the real server;
// these tests deliberately order otherwise nondeterministic race outcomes.
let browser;
const contexts = [];
beforeAll(async () => { browser = await chromium.launch({ headless: true }); });
afterEach(async () => { await Promise.all(contexts.splice(0).map(context => context.close())); });
afterAll(async () => { await browser?.close(); });

const translations = (en = '', zhHant = '', zhHans = '') => ({ en, zhHant, zhHans });
const photo = (id, version = 1) => ({
  id, kind: 'photo', hidden: false, assetSlot: `gallery.${id}`,
  title: translations(`Title ${id}`, `標題 ${id}`, `标题 ${id}`), caption: translations(`Caption ${id}`),
  image: {
    slot: `gallery.${id}`, alt: translations(`Alt ${id}`), focalX: 50, focalY: 50, zoom: 100,
    recordVersion: version, updatedAt: '2026-10-07T00:00:00.000Z',
    src: `/test-image/${id}.webp?v=${version}`, srcSet: `/test-image/${id}.webp?v=${version} 1200w`,
    variants: [{ width: 1200, pixelWidth: 1200, pixelHeight: 800, byteSize: 100, mimeType: 'image/webp', url: `/test-image/${id}.webp?v=${version}` }],
  },
});
const gallery = (version, ids = ['a', 'b']) => ({
  id: 'home-banner', version, updatedAt: '2026-10-07T00:00:00.000Z',
  items: ids.map(id => typeof id === 'string' ? photo(id) : id),
});
const snapshot = value => ({ schemaVersion: 1, galleryId: 'home-banner', state: value.items.length ? 'ready' : 'empty', version: value.version, updatedAt: value.updatedAt, items: value.items });

async function fixture(initial = snapshot(gallery(1)), { live = false, bootstrap = false } = {}) {
  const source = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const section = source.match(/<section class="home-focus"[\s\S]*?<\/section>/)?.[0];
  if (!section) throw new Error('Missing actual homepage focus source');
  const bootstrapSource = bootstrap ? await readFile(new URL('../assets/content-bootstrap.js', import.meta.url), 'utf8') : '';
  const published = JSON.stringify({ page: '/', slots: [], store: { locales: {} } });
  const bootstrapHead = bootstrap ? `<script id="ihear-published-content" type="application/json">${published}</script><script>${bootstrapSource}</script>` : '';
  const html = renderHomeBanner(`<!doctype html><html lang="en"><head>${bootstrapHead}</head><body>${section}</body></html>`, initial, 'en', new Request('http://cp4.test/?retained=1'));
  const context = await browser.newContext(); contexts.push(context);
  const page = await context.newPage();
  await page.route('http://cp4.test/', route => route.fulfill({ status: 200, contentType: 'text/html', body: html }));
  await page.route('**/test-image/**', route => route.fulfill({ status: 200, contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nGsAAAAASUVORK5CYII=', 'base64') }));
  await page.addInitScript(() => {
    window.__requests = []; window.__decodes = []; window.__delayDecode = false;
    window.__registrations = []; window.__refreshes = [];
    window.iHearLiveContent = { register(scope, handler) {
      const registration = { scope, handler, active: true }; window.__registrations.push(registration);
      return () => { registration.active = false; };
    } };
    window.fetch = (url, options) => new Promise((resolve, reject) => {
      const request = { url, options, resolve, reject, aborted: false };
      request.body = new Promise((resolveBody, rejectBody) => { request.resolveBody = resolveBody; request.rejectBody = rejectBody; });
      // Intentionally noncooperative: the generation guard must reject late
      // results even if a transport/response body resolves after AbortSignal.
      options?.signal?.addEventListener('abort', () => { request.aborted = true; });
      window.__requests.push(request);
    });
    HTMLImageElement.prototype.decode = function () {
      if (!window.__delayDecode) return Promise.resolve();
      return new Promise((resolve, reject) => { window.__decodes.push({ image: this, resolve, reject, src: this.src }); });
    };
  });
  await page.goto('http://cp4.test/');
  await page.clock.install({ time: 1000 });
  await page.clock.pauseAt(2000);
  await page.evaluate(() => { window.__ssrImage = document.querySelector('[data-home-banner-image]'); });
  if (live) await page.addScriptTag({ content: await readFile(new URL('../assets/live-content.js', import.meta.url), 'utf8') });
  await page.addScriptTag({ content: await readFile(new URL('../assets/home-banner.js', import.meta.url), 'utf8') });
  await expect.poll(() => page.evaluate(() => window.__requests.length)).toBe(1);
  return page;
}

async function respond(page, index, value, status = 200) {
  await page.evaluate(({ index, value, status }) => {
    const request = window.__requests[index];
    request.resolve({ ok: status >= 200 && status < 300, status, json: () => request.body });
    request.resolveBody(value);
  }, { index, value, status });
  await page.evaluate(async () => { await Promise.resolve(); await Promise.resolve(); });
}
async function accept(page, index, value) { await respond(page, index, { items: [value] }); }
async function refresh(page) { await page.evaluate(() => { void window.iHearHomeBanner.refresh(); }); }
async function state(page) {
  return page.evaluate(() => {
    const root = document.querySelector('[data-home-banner]');
    return {
      state: document.querySelector('[data-home-focus]').dataset.bannerState,
      active: root.dataset.activeId, version: root.dataset.galleryVersion, refresh: root.dataset.refreshState,
      hidden: root.hidden, text: root.textContent,
      image: root.querySelector('[data-home-banner-image]')?.getAttribute('src') || null,
      imageState: root.dataset.imageState,
      title: root.querySelector('[data-home-banner-field="title"]')?.textContent || '',
      requests: window.__requests.length,
    };
  });
}

test('adopts SSR image without replacing it and keeps it when initial calibration fails', async () => {
  const page = await fixture();
  expect(await page.evaluate(() => window.__ssrImage === document.querySelector('[data-home-banner-image]'))).toBe(true);
  expect(await page.evaluate(() => window.__requests[0].url)).toBe('/api/media-galleries?gallery_id=home-banner');
  await respond(page, 0, { error: 'unavailable' }, 503);
  await expect.poll(async () => (await state(page)).refresh).toBe('stale');
  expect(await state(page)).toMatchObject({ state: 'ready', active: 'a', title: 'Title a', version: '1' });
  expect(await page.evaluate(() => window.__ssrImage === document.querySelector('[data-home-banner-image]'))).toBe(true);
});

test('coalesces all in-flight signals into one trailing read instead of losing the newer update', async () => {
  const page = await fixture();
  await page.evaluate(() => { for (let i = 0; i < 20; i++) void window.iHearHomeBanner.refresh(); });
  expect((await state(page)).requests).toBe(1);
  await accept(page, 0, gallery(2));
  await expect.poll(async () => (await state(page)).requests).toBe(2);
  await accept(page, 1, gallery(3, ['b', 'c']));
  await expect.poll(async () => (await state(page)).version).toBe('3');
  expect(await state(page)).toMatchObject({ active: 'b', title: 'Title b', requests: 2 });
});

test('body read is part of five-second deadline; late body/finally cannot clear a newer request', async () => {
  const page = await fixture();
  await page.evaluate(() => { const r = window.__requests[0]; r.resolve({ ok: true, json: () => r.body }); });
  await page.clock.runFor(4999);
  expect((await state(page)).refresh).toBe('refreshing');
  await page.clock.runFor(1);
  await expect.poll(async () => (await state(page)).refresh).toBe('stale');
  expect(await page.evaluate(() => window.__requests[0].aborted)).toBe(true);
  await refresh(page);
  await expect.poll(async () => (await state(page)).requests).toBe(2);
  await page.evaluate(value => window.__requests[0].resolveBody(value), { items: [gallery(99, ['obsolete'])] });
  await refresh(page);
  expect((await state(page)).requests).toBe(2);
  await accept(page, 1, gallery(3, ['current']));
  await expect.poll(async () => (await state(page)).requests).toBe(3);
  await accept(page, 2, gallery(4, ['current']));
  await expect.poll(async () => (await state(page)).version).toBe('4');
  expect((await state(page)).text).not.toContain('obsolete');
});

test('confirmed empty keeps its version and cannot be resurrected by old data or a later failure', async () => {
  const page = await fixture();
  await accept(page, 0, gallery(7, []));
  await expect.poll(async () => (await state(page)).state).toBe('empty');
  await refresh(page); await accept(page, 1, gallery(6));
  expect(await state(page)).toMatchObject({ state: 'empty', version: '7', hidden: true, image: null });
  await refresh(page); await respond(page, 2, { error: 'offline' }, 503);
  expect(await state(page)).toMatchObject({ state: 'empty', version: '7', hidden: true, image: null, refresh: 'stale' });
});

test.each([
  ['missing envelope', {}], ['empty envelope', { items: [] }],
  ['wrong gallery', { items: [{ ...gallery(2), id: 'home' }] }],
  ['invalid version', { items: [{ ...gallery(2), version: '2' }] }],
  ['missing image', { items: [gallery(2, [{ ...photo('a'), image: undefined }])] }],
  ['unsafe URL', { items: [gallery(2, [{ ...photo('a'), image: { ...photo('a').image, src: 'javascript:alert(1)' } }])] }],
])('invalid response %s is failure, never successful empty', async (_name, response) => {
  const page = await fixture(); await respond(page, 0, response);
  await expect.poll(async () => (await state(page)).refresh).toBe('stale');
  expect(await state(page)).toMatchObject({ state: 'ready', version: '1', active: 'a' });
});

test('old pending image decoding cannot revive an item removed by an accepted empty snapshot', async () => {
  const page = await fixture();
  await page.evaluate(() => { window.__delayDecode = true; });
  await accept(page, 0, gallery(2, ['replacement']));
  await expect.poll(() => page.evaluate(() => window.__decodes.length)).toBe(1);
  expect((await state(page)).text).not.toContain('Title a');
  expect((await state(page)).image).not.toContain('/a.webp');
  await refresh(page); await accept(page, 1, gallery(3, []));
  expect(await state(page)).toMatchObject({ state: 'empty', version: '3', image: null });
  await page.evaluate(() => window.__decodes[0].resolve());
  expect(await state(page)).toMatchObject({ state: 'empty', version: '3', image: null });
});

test('failed replacement decode keeps newly accepted item and never returns to the withdrawn item', async () => {
  const page = await fixture(); await page.evaluate(() => { window.__delayDecode = true; });
  await accept(page, 0, gallery(2, ['replacement']));
  await expect.poll(() => page.evaluate(() => window.__decodes.length)).toBe(1);
  await page.evaluate(() => window.__decodes[0].reject(new Error('deliberate decode failure')));
  await expect.poll(async () => (await state(page)).imageState).toBe('error');
  expect(await state(page)).toMatchObject({ state: 'ready', active: 'replacement', title: 'Title replacement', version: '2' });
  expect((await state(page)).text).not.toContain('Title a');
});

test('same-window BroadcastChannel updated signal works with no shared revision increment', async () => {
  const page = await fixture(); await accept(page, 0, gallery(1));
  await page.evaluate(() => { const sender = new BroadcastChannel('ihear-media-galleries'); sender.postMessage('updated'); sender.close(); });
  await expect.poll(async () => (await state(page)).requests).toBe(2);
  await accept(page, 1, gallery(2, ['from-notification']));
  expect(await state(page)).toMatchObject({ version: '2', active: 'from-notification' });
  await page.clock.runFor(15000);
  await expect.poll(async () => (await state(page)).requests).toBe(3);
});

test('late response uses current language and unchanged refresh retains the active ID', async () => {
  const page = await fixture();
  await page.evaluate(() => { document.documentElement.lang = 'zh-Hant'; window.dispatchEvent(new CustomEvent('ihear:language', { detail: { locale: 'zhHant' } })); });
  await accept(page, 0, gallery(2, ['a', 'b']));
  await expect.poll(async () => (await state(page)).title).toBe('標題 a');
  await page.locator('[data-home-banner-next]').click();
  await expect.poll(async () => (await state(page)).active).toBe('b');
  await refresh(page); await accept(page, 1, gallery(3, ['b', 'a']));
  expect(await state(page)).toMatchObject({ active: 'b', title: '標題 b', version: '3' });
});

test('same gallery version accepts a newer independently versioned image without resetting selection', async () => {
  const page = await fixture(); await accept(page, 0, gallery(1));
  await page.locator('[data-home-banner-next]').click();
  await refresh(page); await accept(page, 1, gallery(1, [photo('a'), photo('b', 2)]));
  await expect.poll(async () => (await state(page)).image).toBe('/test-image/b.webp?v=2');
  expect(await state(page)).toMatchObject({ version: '1', active: 'b', title: 'Title b' });
});

test('an old selection decode cannot change the current selection or report its image failure', async () => {
  const page = await fixture(snapshot(gallery(1, ['a', 'b', 'c']))); await accept(page, 0, gallery(1, ['a', 'b', 'c']));
  await page.evaluate(() => { window.__delayDecode = true; });
  await page.locator('[data-home-banner-next]').click();
  await expect.poll(() => page.evaluate(() => window.__decodes.length)).toBe(1);
  await page.locator('[data-home-banner-next]').click();
  await expect.poll(() => page.evaluate(() => window.__decodes.length)).toBe(2);
  await page.evaluate(() => window.__decodes[1].resolve());
  await expect.poll(async () => (await state(page)).imageState).toBe('ready');
  await page.evaluate(() => window.__decodes[0].reject(new Error('old b failed after c decoded')));
  expect(await state(page)).toMatchObject({ active: 'c', title: 'Title c', imageState: 'ready', image: '/test-image/c.webp?v=1' });
});

test('JSON parse failure retains last success and permits a subsequent successful request', async () => {
  const page = await fixture();
  await page.evaluate(() => { const r = window.__requests[0]; r.resolve({ ok: true, json: () => Promise.reject(new SyntaxError('invalid JSON')) }); });
  await expect.poll(async () => (await state(page)).refresh).toBe('stale');
  expect(await state(page)).toMatchObject({ active: 'a', version: '1' });
  await refresh(page); await accept(page, 1, gallery(2, ['recovered']));
  expect(await state(page)).toMatchObject({ active: 'recovered', version: '2', refresh: 'fresh' });
});

test('error seed retains native retry after a failure, then its retry recovers to ready', async () => {
  const page = await fixture({ schemaVersion: 1, galleryId: 'home-banner', state: 'error', version: null, updatedAt: null, items: [] });
  const retry = page.locator('[data-home-banner-retry]');
  expect(await retry.getAttribute('href')).toBe('/?retained=1');
  await respond(page, 0, {}, 503);
  expect((await state(page)).state).toBe('error');
  await retry.click();
  await expect.poll(async () => (await state(page)).requests).toBe(2);
  await accept(page, 1, gallery(8, ['recovered']));
  expect(await state(page)).toMatchObject({ state: 'ready', active: 'recovered', version: '8' });
});

test('repeated pagehide/pageshow simulation invalidates old lifecycle results and never duplicates subscriptions', async () => {
  const page = await fixture();
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
  expect(await page.evaluate(() => window.__requests[0].aborted)).toBe(true);
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
  await expect.poll(async () => (await state(page)).requests).toBe(2);
  await accept(page, 1, gallery(4, ['resumed']));
  await accept(page, 0, gallery(99, ['obsolete']));
  expect(await state(page)).toMatchObject({ active: 'resumed', version: '4' });
  for (let cycle = 0; cycle < 3; cycle++) {
    await page.evaluate(() => {
      window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
      window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
    });
    await expect.poll(async () => (await state(page)).requests).toBe(cycle + 3);
    await accept(page, cycle + 2, gallery(4, ['resumed']));
  }
  expect(await page.evaluate(() => window.__registrations.filter(record => record.active).length)).toBe(1);
  await page.clock.runFor(15000);
  expect((await state(page)).requests).toBe(6);
  await accept(page, 5, gallery(4, ['resumed']));
  const script = await readFile(new URL('../assets/home-banner.js', import.meta.url), 'utf8');
  await page.addScriptTag({ content: script });
  expect((await state(page)).requests).toBe(6);
  expect(await page.locator('[data-home-banner-next]').count()).toBe(1);
  await page.evaluate(() => window.iHearHomeBanner.destroy());
  expect(await page.evaluate(() => window.__registrations.filter(record => record.active).length)).toBe(0);
  await page.clock.runFor(30000);
  expect((await state(page)).requests).toBe(6);
});

test('hidden page stops direct polling and returning visible immediately calibrates once', async () => {
  const page = await fixture(); await accept(page, 0, gallery(1));
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')); });
  await page.clock.runFor(45000);
  expect((await state(page)).requests).toBe(1);
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: false }); document.dispatchEvent(new Event('visibilitychange')); });
  await expect.poll(async () => (await state(page)).requests).toBe(2);
  await accept(page, 1, gallery(2));
  await page.clock.runFor(15000);
  expect((await state(page)).requests).toBe(3);
});

test('real shared revision first read only baselines; ten-second change and same-page announce refresh Banner', async () => {
  const page = await fixture(snapshot(gallery(1)), { live: true });
  await page.clock.runFor(1);
  await expect.poll(() => page.evaluate(() => window.__requests.length)).toBe(2);
  expect(await page.evaluate(() => window.__requests[1].url)).toBe('/api/live-revisions');
  const revision = number => ({ version: 1, revisions: Object.fromEntries(['content', 'impact', 'team', 'theme', 'layout'].map(scope => [scope, { revision: String(number), updatedAt: '2026-10-07T00:00:00Z' }])) });
  await accept(page, 0, gallery(2)); await respond(page, 1, revision(1));
  expect((await state(page)).requests).toBe(2);
  await page.clock.runFor(9999);
  expect((await state(page)).requests).toBe(2);
  await page.clock.runFor(1);
  expect(await page.evaluate(() => window.__requests.map(request => request.url))).toEqual([
    '/api/media-galleries?gallery_id=home-banner', '/api/live-revisions', '/api/live-revisions',
  ]);
  await respond(page, 2, revision(2));
  await expect.poll(async () => (await state(page)).requests).toBe(4);
  await accept(page, 3, gallery(3));
  await page.evaluate(() => window.iHearLiveContent.announce('content', { revision: '3' }));
  await expect.poll(async () => (await state(page)).requests).toBe(5);
  await accept(page, 4, gallery(4));
  expect((await state(page)).version).toBe('4');
});

test('manual status relocalizes with controls and background reconciliation does not repeat the announcement', async () => {
  const page = await fixture(); await accept(page, 0, gallery(1));
  await page.locator('[data-home-banner-next]').click();
  expect(await page.locator('[data-home-banner-status]').textContent()).toBe('Photo 2 of 2');
  await page.evaluate(() => {
    window.iHearPublishedContent = { valueFor(source, locale) {
      const key = source.dataset.homeBannerLabel;
      const copy = {
        zhHant: { changed: '第 {current} 張，共 {total} 張', next: '下一張照片' },
        zhHans: { changed: '第 {current} 张，共 {total} 张', next: '下一张照片' },
      };
      return copy[locale]?.[key];
    } };
    document.documentElement.lang = 'zh-Hant';
    window.dispatchEvent(new CustomEvent('ihear:language', { detail: { locale: 'zhHant' } }));
  });
  expect(await page.locator('[data-home-banner-status]').textContent()).toBe('第 2 張，共 2 張');
  expect(await page.locator('[data-home-banner-next]').getAttribute('aria-label')).toBe('下一張照片');
  await page.evaluate(() => { document.documentElement.lang = 'zh-Hans'; window.dispatchEvent(new CustomEvent('ihear:language', { detail: { locale: 'zhHans' } })); });
  expect(await page.locator('[data-home-banner-status]').textContent()).toBe('第 2 张，共 2 张');
  await refresh(page); await accept(page, 1, gallery(2, ['b', 'c', 'a']));
  expect(await page.locator('[data-home-banner-status]').textContent()).toBe('');
  expect(await state(page)).toMatchObject({ active: 'b', title: '标题 b' });
});

test('reordering retains focused controls; removal repairs focus only inside the affected Banner', async () => {
  const page = await fixture(); await accept(page, 0, gallery(1));
  await page.locator('[data-home-banner-dot][data-id="b"]').focus();
  await refresh(page); await accept(page, 1, gallery(2, ['b', 'a']));
  expect(await page.evaluate(() => document.activeElement.dataset.id)).toBe('b');
  await refresh(page); await accept(page, 2, gallery(3, ['a']));
  expect(await page.evaluate(() => document.activeElement.matches('[data-home-banner]'))).toBe(true);
  await refresh(page); await accept(page, 3, gallery(4, []));
  expect(await page.evaluate(() => document.activeElement.matches('[data-home-announcements] [data-home-card-link]'))).toBe(true);
  expect(await page.evaluate(() => document.activeElement.getAttribute('href'))).toBe('/resources');
  await page.locator('[data-home-calendar] a').focus();
  await refresh(page); await accept(page, 4, gallery(5, ['new']));
  expect(await page.evaluate(() => document.activeElement.matches('[data-home-calendar] [data-home-card-link]'))).toBe(true);
  expect(await page.evaluate(() => document.activeElement.getAttribute('href'))).toBe('/resources');
});

test('destroy, bootstrap language change, and reinitialize cannot revive original SSR or lose active ID', async () => {
  const page = await fixture(snapshot(gallery(1)), { bootstrap: true }); await accept(page, 0, gallery(5, ['c', 'd']));
  await page.locator('[data-home-banner-next]').click();
  expect((await state(page)).active).toBe('d');
  await page.evaluate(() => window.iHearHomeBanner.destroy());
  await page.evaluate(() => { document.documentElement.lang = 'zh-Hant'; window.dispatchEvent(new CustomEvent('ihear:language', { detail: { locale: 'zhHant' } })); });
  expect((await state(page)).title).toBe('標題 d');
  await page.addScriptTag({ content: await readFile(new URL('../assets/home-banner.js', import.meta.url), 'utf8') });
  await expect.poll(async () => (await state(page)).requests).toBe(2);
  expect(await state(page)).toMatchObject({ active: 'd', version: '5', title: '標題 d' });
  await accept(page, 1, gallery(5, ['c', 'd']));
  expect((await state(page)).active).toBe('d');
});
