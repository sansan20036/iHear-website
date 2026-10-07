import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('node:fs/promises', () => ({ readFile: vi.fn() }));
vi.mock('../lib/media-gallery-store', () => ({ listGalleries: vi.fn(), getGalleryAssets: vi.fn() }));
vi.mock('../lib/site-media-store', () => ({ listSiteMediaAssets: vi.fn() }));
vi.mock('../lib/content-store', () => ({ readContentStore: vi.fn(), publicContentStore: value => value }));
vi.mock('../lib/impact-store', () => ({ getCurrentSiteMetrics: vi.fn() }));
vi.mock('../lib/resource-store', () => ({ listResources: vi.fn(() => { throw new Error('Resources must not be part of homepage SSR'); }) }));

import { readFile } from 'node:fs/promises';
import { listGalleries, getGalleryAssets } from '../lib/media-gallery-store';
import { listSiteMediaAssets } from '../lib/site-media-store';
import { readContentStore } from '../lib/content-store';
import { getCurrentSiteMetrics } from '../lib/impact-store';
import { loadHomeBanner, HOME_BANNER_DEADLINE_MS } from '../lib/home-banner';
import { renderHomeBanner, homeBannerText, HOME_BANNER_IMAGE_SIZES } from '../lib/home-banner-render';
import { servePublicPage } from '../lib/public-page';

const words = (en = '', zhHant = '', zhHans = '') => ({ en, zhHant, zhHans });
const item = (id = 'first', extras = {}) => ({
  id, kind: 'photo', hidden: false, assetSlot: 'home.hero', title: words('English title', '繁體標題', '简体标题'), caption: words('English caption', '繁體說明', '简体说明'),
  image: {
    slot: 'home.hero', alt: words('English alt', '繁體替代文字', '简体替代文字'), focalX: 22, focalY: 77, zoom: 140, recordVersion: 3, updatedAt: '2026-10-07T00:00:00.000Z',
    src: `/assets/${id}.webp`, srcSet: `/assets/${id}.webp 800w`,
    variants: [{ width: 800, pixelWidth: 800, pixelHeight: 600, byteSize: 1234, mimeType: 'image/webp', url: `/assets/${id}.webp` }],
  }, ...extras,
});
const gallery = (items = [item()], extras = {}) => ({ id: 'home-banner', version: 5, updatedAt: '2026-10-07T00:00:00.000Z', items, ...extras });
const template = `<html lang="en"><head></head><body><main><section class="home-focus" data-home-focus data-banner-state="error"><div class="home-banner" data-home-banner><!-- home-banner:start --><div class="home-banner__error"><p data-editable-content="home.focus.banner.error">Featured photos could not be loaded.</p><a href="/" data-home-banner-retry data-editable-content="home.focus.banner.retry">Try again</a></div><!-- home-banner:end --></div><div data-home-quick-cards><article data-home-announcements></article><article data-home-calendar></article><article data-home-tutors></article></div><template data-home-banner-image-error-template><span data-editable-content="home.focus.banner.image.error">This photo could not be displayed.</span></template></section><h1>Original homepage introduction</h1></main></body></html>`;
const request = (query = '', headers = {}) => new Request(`https://example.com/${query}`, { headers });
const parseSnapshot = html => JSON.parse(/<script id="ihear-home-banner" type="application\/json">([\s\S]*?)<\/script>/.exec(html)[1]);
const render = async (data, locale = 'en', input = request()) => renderHomeBanner(template, await loadHomeBanner(async () => data), locale, input);

beforeEach(() => {
  vi.clearAllMocks();
  readFile.mockResolvedValue(template);
  readContentStore.mockResolvedValue({ version: 3, updatedAt: '', locales: Object.fromEntries(['en', 'zhHant', 'zhHans'].map(locale => [locale, { pages: {}, itemUpdatedAt: {} }])) });
  getCurrentSiteMetrics.mockResolvedValue(null);
  listGalleries.mockResolvedValue([gallery([])]);
  getGalleryAssets.mockResolvedValue([]);
  listSiteMediaAssets.mockResolvedValue([]);
});
afterEach(() => { vi.useRealTimers(); });

describe('request-time public Banner snapshot', () => {
  test.each([
    ['zero', [], 'empty'],
    ['one', [item()], 'ready'],
    ['several', [item('second'), item('first')], 'ready'],
    ['all hidden', [item('secret', { hidden: true })], 'empty'],
  ])('%s preserves public order, version and explicit state', async (_name, items, state) => {
    const snapshot = await loadHomeBanner(async () => gallery(items));
    expect(snapshot.state).toBe(state);
    expect(snapshot.version).toBe(5);
    expect(snapshot.items.map(photo => photo.id)).toEqual(items.filter(photo => !photo.hidden).map(photo => photo.id));
    expect(snapshot.galleryId).toBe('home-banner');
    expect(snapshot.schemaVersion).toBe(1);
  });

  test('uses the existing projection and home.hero resolver from one gallery read', async () => {
    listGalleries.mockResolvedValue([{ ...gallery([item('public'), item('private', { hidden: true })]), updatedBy: 'private-actor@example.com' }, { id: 'home', items: [{ malformed: true }] }]);
    const result = await loadHomeBanner();
    expect(listGalleries).toHaveBeenCalledTimes(1);
    expect(result.state).toBe('ready');
    expect(result.items.map(photo => photo.id)).toEqual(['public']);
    expect(result.items[0].image.src).toBe('/assets/images/hero-classroom-1200.webp');
    expect(result.items[0].image.focalX).toBe(50);
    expect(JSON.stringify(result)).not.toContain('private-actor');
  });

  test('empty and all-hidden do not resolve hero assets or create replacement items', async () => {
    for (const items of [[], [item('private', { hidden: true })]]) {
      listGalleries.mockResolvedValue([gallery(items)]);
      const result = await loadHomeBanner();
      expect(result.state).toBe('empty');
      expect(result.items).toEqual([]);
    }
    expect(listSiteMediaAssets).not.toHaveBeenCalled();
    expect(getGalleryAssets).toHaveBeenCalledWith([]);
  });

  test('allowlists gallery, item, image and variant metadata without mutation', async () => {
    const original = gallery([item('public', { operationId: 'secret-operation', altStates: [{ reviewedBy: 'secret-reviewer' }] })], { updatedBy: 'secret-admin', operations: ['secret-operation'] });
    original.items[0].image.updatedBy = 'secret-image-actor';
    original.items[0].image.variants[0].storagePath = 'secret-storage-path';
    const saved = structuredClone(original);
    const result = await loadHomeBanner(async () => original);
    const encoded = JSON.stringify(result);
    expect(encoded).not.toContain('secret');
    expect(result.items[0].image).toMatchObject({ focalX: 22, focalY: 77, zoom: 140, recordVersion: 3 });
    expect(result.items[0].image.variants[0]).toEqual({ width: 800, pixelWidth: 800, pixelHeight: 600, byteSize: 1234, mimeType: 'image/webp', url: '/assets/public.webp' });
    expect(original).toEqual(saved);
  });

  test.each([
    ['absent gallery', undefined], ['wrong gallery', gallery([], { id: 'home' })], ['missing version', gallery([], { version: undefined })],
    ['negative version', gallery([], { version: -1 })], ['noninteger version', gallery([], { version: 1.5 })],
    ['invalid timestamp', gallery([], { updatedAt: null })], ['nonarray items', gallery(null)],
    ['visible video', gallery([{ ...item(), kind: 'youtube', videoId: 'LsQWwDBLKUc' }])],
    ['missing image', gallery([item('first', { image: undefined })])], ['partial title object', gallery([item('first', { title: { en: 'Title' } })])],
    ['individual locale null', gallery([item('first', { title: words('Title', null, '') })])],
    ['missing caption', gallery([item('first', { caption: undefined })])], ['invalid hidden', gallery([item('first', { hidden: 'false' })])],
  ])('%s becomes error, never a successful empty snapshot', async (_name, data) => {
    expect(await loadHomeBanner(async () => data)).toEqual({ schemaVersion: 1, galleryId: 'home-banner', state: 'error', version: null, updatedAt: null, items: [] });
  });

  test.each(['javascript:alert(1)', '//other.example/image.webp', '/\\other.example/image.webp', '/bad\nimage.webp', 'https://other.example/image.webp'])('rejects an unsafe image source %s', async url => {
    const data = gallery();
    data.items[0].image.src = url;
    expect((await loadHomeBanner(async () => data)).state).toBe('error');
  });

  test('rejects invalid responsive sources, missing dimensions and mismatched image slots', async () => {
    for (const edit of [image => image.srcSet = '/fine.webp 800w, javascript:alert(1) 1200w', image => image.variants[0].pixelHeight = 0, image => image.slot = 'services.tutoring', image => image.zoom = 251]) {
      const data = gallery(); edit(data.items[0].image);
      expect((await loadHomeBanner(async () => data)).state).toBe('error');
    }
  });

  test('failure resolves an isolated error and cleans its timer', async () => {
    vi.useFakeTimers();
    expect((await loadHomeBanner(async () => { throw new Error('private database credentials'); })).state).toBe('error');
    expect(vi.getTimerCount()).toBe(0);
  });

  test.each(['resolve', 'reject'])('one-second deadline handles late %s without claiming cancellation', async outcome => {
    vi.useFakeTimers();
    let finish;
    const read = new Promise((resolve, reject) => { finish = outcome === 'resolve' ? resolve : reject; });
    const result = loadHomeBanner(() => read);
    let settled = false; result.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(HOME_BANNER_DEADLINE_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect((await result).state).toBe('error');
    finish(outcome === 'resolve' ? gallery() : new Error('late read failure'));
    await Promise.resolve(); await Promise.resolve();
    expect((await result).state).toBe('error');
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('safe initial HTML and language presentation', () => {
  test('only the first sorted visible image renders and preloads from the same snapshot', async () => {
    const html = await render(gallery([item('hidden-secret', { hidden: true }), item('second'), item('first')]));
    const snapshot = parseSnapshot(html);
    expect(snapshot.items.map(photo => photo.id)).toEqual(['second', 'first']);
    expect(html).not.toContain('hidden-secret');
    expect(html.match(/<img /g)).toHaveLength(1);
    expect(html.match(/rel="preload"/g)).toHaveLength(1);
    expect(html).toContain('src="/assets/second.webp"');
    expect(html).toContain('href="/assets/second.webp"');
    expect(html).toContain(`sizes="${HOME_BANNER_IMAGE_SIZES}"`);
    expect(html).toContain('width="800" height="600"');
    expect(html).toContain('fetchpriority="high" loading="eager"');
    expect(html).not.toContain('data-media-gallery');
    expect(html).not.toContain('data-resources');
  });

  test.each([['en', 'English title', 'English caption', 'en'], ['zhHant', '繁體標題', '繁體說明', 'zh-Hant'], ['zhHans', '简体标题', '简体说明', 'zh-Hans']])('%s has readable initial title and caption without JavaScript', async (locale, title, caption, lang) => {
    const html = await render(gallery(), locale);
    expect(html).toContain(`data-home-banner-field="title" lang="${lang}">${title}</h3>`);
    expect(html).toContain(`data-home-banner-field="caption" lang="${lang}">${caption}</p>`);
    expect(html).toContain(`alt="${locale === 'en' ? 'English alt' : locale === 'zhHant' ? '繁體替代文字' : '简体替代文字'}" lang="${lang}"`);
  });

  test('missing translations fall back for display without writing to the snapshot', async () => {
    const original = gallery([item('first', { title: words('English fallback'), caption: words('English explanation') })]);
    const html = await render(original, 'zhHant');
    expect(html).toContain('data-home-banner-field="title" lang="en">English fallback</h3>');
    expect(parseSnapshot(html).items[0].title).toEqual(words('English fallback'));
    expect(original.items[0].title.zhHant).toBe('');
  });

  test.each([null, words(), words('  ', '\n', '\t')])('all-empty titles stay empty, while captions retain their purpose', async title => {
    const html = await render(gallery([item('first', { title })]));
    expect(html).toContain('data-home-banner-field="title" lang="en" hidden></h3>');
    expect(html).toContain('data-home-banner-field="caption" lang="en">English caption</p>');
  });

  test('empty text in every language hides the entire text plate, preserving alt', async () => {
    const html = await render(gallery([item('first', { title: null, caption: words() })]));
    expect(html).toContain('class="home-banner__copy" hidden');
    expect(html).toContain('alt="English alt"');
  });

  test('legacy longer titles are not truncated and all languages reserve text height', async () => {
    const long = '長標題'.repeat(150);
    const html = await render(gallery([item('first', { title: words('Short English', long, '短标题') })]));
    expect(parseSnapshot(html).items[0].title.zhHant).toBe(long);
    expect(html).toContain('class="home-banner__reserve" aria-hidden="true"');
    expect(html).toContain(long);
  });

  test('all public slides reserve their three-language text before controller takeover without rendering extra images', async () => {
    const html = await render(gallery([
      item('first', { title: null, caption: words() }),
      item('later', { title: words('Later English', '後續長標題', '后续长标题'), caption: words('Later explanation') }),
      item('secret', { hidden: true, title: words('Never reserve this hidden title') }),
    ]));
    const reserve = html.split('class="home-banner__reserve" aria-hidden="true">')[1].split('<!-- home-banner:end -->')[0];
    expect(reserve.match(/class="home-banner__text"/g)).toHaveLength(6);
    expect(reserve).toContain('Later English');
    expect(reserve).toContain('後續長標題');
    expect(reserve).toContain('后续长标题');
    expect(html).not.toContain('Never reserve this hidden title');
    expect(html).not.toContain('class="home-banner__copy" hidden');
    expect(html).toContain('class="home-banner__text" hidden><h3 data-home-banner-field="title"');
    expect(html.match(/<img /g)).toHaveLength(1);
    expect(html.match(/data-home-banner-field="title"/g)).toHaveLength(1);
  });

  test('text, attributes and inline JSON safely round-trip markup, delimiters and Unicode separators', async () => {
    const unusual = `A & B "quotes" 'apostrophes' </script><img src=x onerror=alert(1)> $& \u2028 \u2029`;
    const data = gallery([item('first', { title: words(unusual) })]);
    data.items[0].image.alt.en = unusual;
    data.items[0].image.src = '/assets/image.webp?quoted="yes"&single=\'ok\'';
    const html = await render(data);
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;/script&gt;&lt;img src=x onerror=alert(1)&gt; $&');
    expect(html).toContain('alt="A &amp; B &quot;quotes&quot; &#39;apostrophes&#39;');
    expect(html).toContain('src="/assets/image.webp?quoted=&quot;yes&quot;&amp;single=&#39;ok&#39;"');
    expect(parseSnapshot(html).items[0].title.en).toBe(unusual);
    expect(html).toContain('\\u003c/script>');
    expect(html).toContain('\\u2028');
  });

  test('empty removes Banner content and preload while retaining named card containers', async () => {
    const html = await render(gallery([]));
    expect(html).toContain('data-banner-state="empty"');
    expect(html).toContain('data-home-banner hidden');
    expect(html).not.toContain('class="home-banner__error"');
    expect(html).not.toContain('rel="preload"');
    for (const hook of ['announcements', 'calendar', 'tutors']) expect(html).toContain(`data-home-${hook}`);
  });

  test('error keeps a same-origin no-JavaScript retry preserving query parameters', async () => {
    const html = await render(null, 'zhHant', request('?campaign=launch&lang=zhTW&next=%2Fteam'));
    expect(html).toContain('data-banner-state="error"');
    expect(html).toContain('class="home-banner__error"');
    expect(html).toContain('href="/?campaign=launch&amp;lang=zhTW&amp;next=%2Fteam" data-home-banner-retry');
    expect(html).not.toContain('rel="preload"');
    expect(html).not.toContain('data-home-banner hidden');
  });

  test('whitespace fallback is blank instead of an invented title', () => {
    expect(homeBannerText(words('   '), 'zhHant')).toBe('');
    expect(homeBannerText(null, 'en')).toBe('');
  });
});

describe('actual homepage response integration', () => {
  test('fresh requests see versions, sorting, hidden and empty without a build', async () => {
    const changes = [[item('a'), item('b')], [item('b'), item('a')], [item('b', { hidden: true }), item('a')], []];
    for (let version = 0; version < changes.length; version++) {
      listGalleries.mockResolvedValue([gallery(changes[version], { version })]);
      const response = await servePublicPage(request(), '/');
      const html = await response.text(), seed = parseSnapshot(html);
      expect(response.status).toBe(200);
      expect(seed.version).toBe(version);
      expect(seed.items.map(photo => photo.id)).toEqual(changes[version].filter(photo => !photo.hidden).map(photo => photo.id));
      expect(response.headers.get('cache-control')).toBe('private, no-store, max-age=0');
      expect(response.headers.get('vercel-cdn-cache-control')).toBe('no-store');
      expect(html).toContain('Original homepage introduction');
      expect(html.indexOf('id="ihear-home-banner"')).toBeLessThan(html.indexOf('src="/assets/content-bootstrap.js'));
    }
    expect(listGalleries).toHaveBeenCalledTimes(changes.length);
  });

  test.each(['rejection', 'invalid data', 'timeout'])('Banner %s does not turn the homepage into 503', async failure => {
    vi.useFakeTimers();
    if (failure === 'rejection') listGalleries.mockRejectedValue(new Error('private credentials'));
    else if (failure === 'invalid data') listGalleries.mockResolvedValue([gallery([], { version: 'invalid' })]);
    else listGalleries.mockReturnValue(new Promise(() => {}));
    const pending = servePublicPage(request('?campaign=keep', { cookie: 'ihear-lang=zhTW' }), '/');
    await vi.advanceTimersByTimeAsync(HOME_BANNER_DEADLINE_MS);
    const response = await pending, html = await response.text();
    expect(response.status).toBe(200);
    expect(html).toContain('data-banner-state="error"');
    expect(html).toContain('Original homepage introduction');
    expect(html).toContain('href="/?campaign=keep"');
    expect(html).toContain('lang="zh-Hant"');
    expect(html).not.toContain('private credentials');
    expect(vi.getTimerCount()).toBe(0);
  });

  test('non-homepage requests do not read Banner data', async () => {
    const response = await servePublicPage(request(), '/about');
    expect(response.status).toBe(200);
    expect(listGalleries).not.toHaveBeenCalled();
    expect(await response.text()).not.toContain('id="ihear-home-banner"');
  });

  test.each([['ihear-lang=zhTW', 'en', 'zh-Hant'], ['ihear-lang=zhCN', 'zh-TW', 'zh-Hans'], ['', 'zh-TW', 'zh-Hant'], ['', 'zh-CN', 'zh-Hans'], ['', 'en-US', 'en']])('SSR retains cookie and Accept-Language priority: %s / %s', async (cookie, acceptLanguage, lang) => {
    listGalleries.mockResolvedValue([gallery([item()])]);
    const response = await servePublicPage(request('?lang=ignored', { cookie, 'accept-language': acceptLanguage }), '/');
    expect(await response.text()).toContain(`<html lang="${lang}">`);
  });
});
