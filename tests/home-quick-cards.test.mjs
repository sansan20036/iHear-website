import { readFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { afterAll, afterEach, beforeAll, expect, test } from 'vitest';
import { guidesTakeoverState } from '../lib/resource-guides-takeover';
import { initialResourceTopics, validateResourceDocument } from '../lib/resource-topic-model';
import { publicResource } from '../lib/resource-types';

// Run the actual controller against the actual homepage card source. A real
// browser with controlled network/body completion and clock makes the races
// deterministic; the production smoke separately exercises the built server.
let browser;
const contexts = [];
beforeAll(async () => { browser = await chromium.launch({ headless: true }); });
afterEach(async () => { await Promise.all(contexts.splice(0).map(context => context.close())); });
afterAll(async () => { await browser?.close(); });

const localized = (en = '', zhHant = '', zhHans = '') => ({ en, zhHant, zhHans });
const topic = (id, slug) => ({ id, slug, title: localized(`Topic ${slug}`), description: localized(), sortOrder: 0 });
const item = (id, topicId, sortOrder = 0, extra = {}) => ({ id, topicId, sortOrder, category: 'form', type: 'text', url: '', title: localized(`Title ${id}`, `標題 ${id}`, `标题 ${id}`), description: localized(`Description ${id}`), ...extra });
const data = (items = [item('first-announcement', 'news-id'), item('first-event', 'events-id')], topics = [topic('news-id', 'announcements'), topic('events-id', 'calendar')], guidesTakeover = 'legacy') => ({ topics, items, guidesTakeover });
const empty = () => data([], []);

async function fixture({ live = false } = {}) {
  const source = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const section = source.match(/<section class="home-focus"[\s\S]*?<\/section>/)?.[0];
  if (!section?.includes('data-home-cards-labels')) throw new Error('Missing actual CP5 homepage card source');
  const context = await browser.newContext(); contexts.push(context);
  const page = await context.newPage();
  await page.route('http://cp5.test/', route => route.fulfill({ status: 200, contentType: 'text/html', body: `<!doctype html><html lang="en"><head></head><body>${section}</body></html>` }));
  await page.addInitScript(() => {
    window.__requests = []; window.__registrations = [];
    window.iHearLiveContent = { register(scope, handler) {
      const registration = { scope, handler, active: true }; window.__registrations.push(registration);
      return () => { registration.active = false; };
    } };
    window.fetch = (url, options) => new Promise((resolve, reject) => {
      const request = { url, options, resolve, reject, aborted: false };
      request.body = new Promise((resolveBody, rejectBody) => { request.resolveBody = resolveBody; request.rejectBody = rejectBody; });
      // Deliberately let aborted transports/bodies resolve late. An AbortSignal
      // alone cannot prove that a stale callback is unable to paint/clear locks.
      options?.signal?.addEventListener('abort', () => { request.aborted = true; });
      window.__requests.push(request);
    });
  });
  await page.goto('http://cp5.test/');
  await page.clock.install({ time: 1000 }); await page.clock.pauseAt(2000);
  await page.evaluate(() => {
    window.__bannerBefore = document.querySelector('[data-home-banner]').outerHTML;
    window.__focusStateBefore = document.querySelector('[data-home-focus]').dataset.bannerState;
    window.__originalLinks = [...document.querySelectorAll('[data-home-card-link]')];
  });
  if (live) await page.addScriptTag({ content: await readFile(new URL('../assets/live-content.js', import.meta.url), 'utf8') });
  await page.addScriptTag({ content: await readFile(new URL('../assets/home-quick-cards.js', import.meta.url), 'utf8') });
  await expect.poll(() => count(page)).toBe(1);
  return page;
}
async function count(page) { return page.evaluate(() => window.__requests.length); }
async function respond(page, index, value, status = 200) {
  await page.evaluate(({ index, value, status }) => {
    const request = window.__requests[index];
    request.resolve({ ok: status >= 200 && status < 300, status, json: () => request.body });
    request.resolveBody(value);
  }, { index, value, status });
  await page.evaluate(async () => { await Promise.resolve(); await Promise.resolve(); });
}
async function refresh(page) { await page.evaluate(() => { void window.iHearHomeQuickCards.refresh(); }); }
async function state(page, slug = 'announcements') {
  return page.evaluate(slug => {
    const card = document.querySelector(`[data-home-${slug}]`), part = key => card.querySelector(`[data-home-card-${key}]`);
    return { state: card.dataset.state, refresh: card.dataset.refreshState, id: card.dataset.itemId, topicId: card.dataset.topicId,
      title: part('title').textContent, titleLang: part('title').lang, summary: part('summary').textContent,
      href: part('link').getAttribute('href'), status: part('status').textContent,
      retryHidden: part('retry').hidden, skeletonHidden: part('skeleton').hidden };
  }, slug);
}

test('one independent read starts both cards loading with usable basic links and leaves Banner/tutors intact', async () => {
  const page = await fixture();
  expect(await page.evaluate(() => window.__requests.map(request => request.url))).toEqual(['/api/resources']);
  for (const slug of ['announcements', 'calendar']) expect(await state(page, slug)).toMatchObject({ state: 'loading', href: '/resources', skeletonHidden: false });
  expect(await page.evaluate(() => window.__registrations.filter(record => record.active).map(record => record.scope))).toEqual(['content']);
  await respond(page, 0, {}, 503);
  expect(await state(page)).toMatchObject({ state: 'error', href: '/resources', retryHidden: false, skeletonHidden: true });
  expect(await page.evaluate(() => document.querySelector('[data-home-banner]').outerHTML === window.__bannerBefore)).toBe(true);
  expect(await page.evaluate(() => document.querySelector('[data-home-focus]').dataset.bannerState === window.__focusStateBefore)).toBe(true);
  expect(await page.locator('[data-home-tutors] a').evaluateAll(links => links.map(link => link.getAttribute('href')))).toEqual(['/resources#resource-links', '/resources#resource-guides']);
});

test('projects real topic IDs from fixed slugs, selects sortOrder then ID, and never changes the CTA to an item destination', async () => {
  const page = await fixture();
  await respond(page, 0, data([
    item('z-later', 'news-id', 0), item('a-earlier', 'news-id', 0, { type: 'external_link', url: 'https://example.org/resource', description: localized() }),
    item('chronologically-old-but-first', 'events-id', 0, { type: 'email_request' }), item('recent-but-later', 'events-id', 1),
  ]));
  expect(await state(page)).toMatchObject({ state: 'ready', id: 'a-earlier', topicId: 'news-id', href: '/resources#announcements', summary: '' });
  expect(await state(page, 'calendar')).toMatchObject({ state: 'ready', id: 'chronologically-old-but-first', topicId: 'events-id', href: '/resources#calendar' });
  expect(await page.evaluate(() => window.__originalLinks.every((link, index) => link === document.querySelectorAll('[data-home-card-link]')[index]))).toBe(true);
});

test('preserves readable historical Unicode URLs allowed by the real store validator and public projection', async () => {
  const topics = initialResourceTopics(), storedTopic = topics.find(value => value.id === 'announcements');
  storedTopic.status = 'published';
  // Stored/SQL limits count Unicode code points; an existing public URL can
  // exceed 2048 UTF-16 code units without exceeding that contract. The current
  // writer's normalized URL limits must not tighten historical read semantics.
  const url = 'https://example.org/' + '😀'.repeat(1100);
  const stored = { ...storedTopic, id: 'unicode-link', category: 'form', topicId: storedTopic.id, type: 'external_link', url };
  expect(() => validateResourceDocument({ schemaVersion: 2, topics, items: [stored] })).not.toThrow();
  const projected = publicResource(stored);
  expect(projected.url).toBe(url); expect(url.length).toBeGreaterThan(2048); expect(Array.from(url).length).toBeLessThan(2048);
  const page = await fixture();
  await respond(page, 0, data([projected], [topic(storedTopic.id, storedTopic.slug)]));
  expect(await state(page)).toMatchObject({ state: 'ready', id: 'unicode-link', href: '/resources#announcements', refresh: 'fresh' });
  await refresh(page);
  await respond(page, 1, data([{ ...projected, url: 'https://example.org/' + '😀'.repeat(2049) }], [topic(storedTopic.id, storedTopic.slug)]));
  expect(await state(page)).toMatchObject({ state: 'ready', id: 'unicode-link', refresh: 'stale' });
});

test('missing public topic or a legal empty topic projects empty independently of the other card', async () => {
  const page = await fixture();
  await respond(page, 0, data([item('event', 'custom-calendar')], [topic('custom-calendar', 'calendar')]));
  expect(await state(page)).toMatchObject({ state: 'empty', href: '/resources', retryHidden: true });
  expect(await state(page, 'calendar')).toMatchObject({ state: 'ready', id: 'event' });
  await refresh(page); await respond(page, 1, data([], [topic('custom-calendar', 'calendar')]));
  expect(await state(page, 'calendar')).toMatchObject({ state: 'empty', href: '/resources' });
});

test('persisted false Guides marker is legal legacy, while public response still requires its string enum', async () => {
  expect(guidesTakeoverState(false, [], [])).toBe('legacy');
  const page = await fixture(); await respond(page, 0, empty());
  expect(await state(page)).toMatchObject({ state: 'empty', refresh: 'fresh' });
  await refresh(page); await respond(page, 1, { ...empty(), guidesTakeover: false });
  expect(await state(page)).toMatchObject({ state: 'empty', refresh: 'stale' });
});

test.each([
  ['missing guidesTakeover', value => { delete value.guidesTakeover; }],
  ['unavailable guide state', value => { value.guidesTakeover = 'unavailable'; }],
  ['missing items', value => { delete value.items; }],
  ['duplicate fixed slug', value => { value.topics.push(topic('duplicate-news', 'announcements')); }],
  ['duplicate topic ID', value => { value.topics.push(topic('news-id', 'another-slug')); }],
  ['duplicate item ID', value => { value.items.push({ ...value.items[0] }); }],
  ['slug mistakenly used as topic ID', value => { value.items[0].topicId = 'announcements'; }],
  ['missing locale', value => { delete value.items[0].title.zhHans; }],
  ['invalid order', value => { value.items[0].sortOrder = -1; }],
  ['bad item type', value => { value.items[0].type = 'video'; }],
  ['invalid external destination', value => { Object.assign(value.items[0], { type: 'external_link', url: 'javascript:alert(1)' }); }],
])('invalid full snapshot: %s errors both initial cards rather than falsely reporting empty', async (_name, change) => {
  const page = await fixture(), payload = data(); change(payload);
  await respond(page, 0, payload);
  for (const slug of ['announcements', 'calendar']) expect(await state(page, slug)).toMatchObject({ state: 'error', retryHidden: false, href: '/resources', title: '' });
});

test('completed Guides takeover does not regress to legacy or restore withdrawn cards', async () => {
  const page = await fixture(); await respond(page, 0, { ...empty(), guidesTakeover: 'complete' });
  await refresh(page); await respond(page, 1, data());
  expect(await state(page)).toMatchObject({ state: 'empty', refresh: 'stale', title: '' });
});

test('background errors preserve last success, but accepted moves/removal clear old data and empty stays empty after failure', async () => {
  const page = await fixture(); await respond(page, 0, data());
  await refresh(page); await respond(page, 1, {}, 503);
  expect(await state(page)).toMatchObject({ state: 'ready', refresh: 'stale', id: 'first-announcement' });
  await refresh(page); await respond(page, 2, data([item('first-announcement', 'events-id')]));
  expect(await state(page)).toMatchObject({ state: 'empty', title: '', href: '/resources' });
  expect(await state(page, 'calendar')).toMatchObject({ id: 'first-announcement' });
  await refresh(page); await respond(page, 3, empty());
  await refresh(page); await respond(page, 4, {}, 503);
  for (const slug of ['announcements', 'calendar']) expect(await state(page, slug)).toMatchObject({ state: 'empty', refresh: 'stale', title: '', href: '/resources' });
});

test('signals during a snapshot/body read coalesce to exactly one trailing request', async () => {
  const page = await fixture();
  await page.evaluate(() => { const request = window.__requests[0]; request.resolve({ ok: true, json: () => request.body }); for (let index = 0; index < 25; index++) void window.iHearHomeQuickCards.refresh(); });
  expect(await count(page)).toBe(1);
  await respond(page, 0, data());
  await expect.poll(() => count(page)).toBe(2);
  await respond(page, 1, empty());
  expect(await count(page)).toBe(2); expect((await state(page)).state).toBe('empty');
});

test('five-second body deadline aborts and late result/finally cannot overwrite data or clear the next request lock', async () => {
  const page = await fixture();
  await page.evaluate(() => { const request = window.__requests[0]; request.resolve({ ok: true, json: () => request.body }); });
  await page.clock.runFor(4999); expect((await state(page)).state).toBe('loading');
  await page.clock.runFor(1); await expect.poll(async () => (await state(page)).state).toBe('error');
  expect(await page.evaluate(() => window.__requests[0].aborted)).toBe(true);
  await refresh(page); expect(await count(page)).toBe(2);
  await respond(page, 0, data());
  await refresh(page); expect(await count(page)).toBe(2);
  await respond(page, 1, empty()); await expect.poll(() => count(page)).toBe(3);
  await respond(page, 2, empty());
  expect(await state(page)).toMatchObject({ state: 'empty', title: '', refresh: 'fresh' });
});

test('initial ten-second cap is not extended by repeated lifecycle cancellation or retries', async () => {
  const page = await fixture();
  for (let cycle = 0; cycle < 2; cycle++) {
    await page.clock.runFor(4000);
    await page.evaluate(() => { window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })); window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })); });
    await expect.poll(() => count(page)).toBe(cycle + 2);
  }
  expect((await state(page)).state).toBe('loading');
  await page.clock.runFor(2000);
  expect(await state(page)).toMatchObject({ state: 'error', skeletonHidden: true, retryHidden: false });
  await refresh(page); expect((await state(page)).state).toBe('error');
  await respond(page, 2, empty()); await expect.poll(() => count(page)).toBe(4);
  await respond(page, 3, empty()); expect((await state(page)).state).toBe('empty');
});

test('JSON failure is immediately retryable and recovery restores focus to the retained basic link', async () => {
  const page = await fixture();
  await page.evaluate(() => window.__requests[0].resolve({ ok: true, json: () => Promise.reject(new SyntaxError('malformed JSON')) }));
  await expect.poll(async () => (await state(page)).state).toBe('error');
  const retry = page.locator('[data-home-announcements] [data-home-card-retry]');
  await retry.click(); await expect.poll(() => count(page)).toBe(2);
  await respond(page, 1, data());
  expect(await page.evaluate(() => document.activeElement === document.querySelector('[data-home-announcements] [data-home-card-link]'))).toBe(true);
});

test('one card renderer failure cannot keep a withdrawn title or break the successful sibling', async () => {
  const page = await fixture(); await respond(page, 0, data());
  await page.evaluate(() => {
    const title = document.querySelector('[data-home-announcements] [data-home-card-title]');
    const descriptor = Object.getOwnPropertyDescriptor(Node.prototype, 'textContent');
    Object.defineProperty(title, 'textContent', { configurable: true, get() { return descriptor.get.call(this); }, set() { throw new Error('single card render failure'); } });
  });
  await refresh(page); await respond(page, 1, data([item('replacement', 'news-id'), item('changed-event', 'events-id')]));
  expect(await state(page)).toMatchObject({ state: 'error', title: '', href: '/resources', retryHidden: false });
  expect(await state(page, 'calendar')).toMatchObject({ state: 'ready', id: 'changed-event', title: 'Title changed-event' });
  await page.evaluate(() => { delete document.querySelector('[data-home-announcements] [data-home-card-title]').textContent; });
  await refresh(page); await respond(page, 2, empty()); expect((await state(page)).state).toBe('empty');
});

test('projection failure before replacement assignment cannot resurrect retained old data on later request failure or language repaint', async () => {
  const page = await fixture(); await respond(page, 0, data());
  await page.evaluate(() => {
    const compare = String.prototype.localeCompare;
    let failOnce = true;
    String.prototype.localeCompare = function (...args) {
      if (failOnce) { failOnce = false; throw new Error('single card projection failure'); }
      return compare.apply(this, args);
    };
  });
  await refresh(page);
  await respond(page, 1, data([item('new-a', 'news-id'), item('new-b', 'news-id'), item('new-event', 'events-id')]));
  expect(await state(page)).toMatchObject({ state: 'error', title: '', href: '/resources' });
  expect(await state(page, 'calendar')).toMatchObject({ state: 'ready', id: 'new-event' });
  await refresh(page); await respond(page, 2, {}, 503);
  await page.evaluate(() => { document.documentElement.lang = 'zh-Hant'; window.dispatchEvent(new CustomEvent('ihear:language')); });
  expect(await state(page)).toMatchObject({ state: 'error', title: '', href: '/resources' });
  expect(await state(page, 'calendar')).toMatchObject({ state: 'ready', id: 'new-event', title: '標題 new-event', refresh: 'stale' });
  await refresh(page); await respond(page, 3, empty());
  expect(await state(page)).toMatchObject({ state: 'empty', title: '', refresh: 'fresh' });
});

test('late response renders current language, falls back for display only and safely excerpts code points', async () => {
  const page = await fixture();
  const payload = data([item('literal', 'news-id', 0, { title: localized('<script>literal</script>', '繁體標題'), description: localized('😀'.repeat(170)) })]);
  await page.evaluate(() => { document.documentElement.lang = 'zh-Hans'; window.dispatchEvent(new CustomEvent('ihear:language')); });
  await respond(page, 0, payload);
  expect(await state(page)).toMatchObject({ title: '<script>literal</script>', titleLang: 'en', summary: '😀'.repeat(160) + '…' });
  expect(await page.locator('[data-home-card-title] script').count()).toBe(0);
  await page.locator('[data-home-announcements] [data-home-card-link]').focus();
  await page.evaluate(() => { document.documentElement.lang = 'zh-Hant'; window.dispatchEvent(new CustomEvent('ihear:language')); });
  expect(await state(page)).toMatchObject({ title: '繁體標題', titleLang: 'zh-Hant' });
  expect(await page.evaluate(() => document.activeElement === window.__originalLinks[0])).toBe(true);
  expect(payload.items[0].title.zhHans).toBe('');
});

test('direct Resources string notification and visible fifteen-second poll work without a shared revision change', async () => {
  const page = await fixture(); await respond(page, 0, data());
  await page.evaluate(() => { const channel = new BroadcastChannel('ihear-resources'); channel.postMessage('updated'); channel.close(); });
  await expect.poll(() => count(page)).toBe(2); await respond(page, 1, empty());
  await page.clock.runFor(15000); await expect.poll(() => count(page)).toBe(3);
  await respond(page, 2, data()); expect((await state(page)).state).toBe('ready');
});

test('hidden page pauses polling; visibility, online and focus all use the one request owner', async () => {
  const page = await fixture(); await respond(page, 0, data());
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')); });
  await page.clock.runFor(45000); expect(await count(page)).toBe(1);
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: false }); document.dispatchEvent(new Event('visibilitychange')); window.dispatchEvent(new Event('online')); window.dispatchEvent(new Event('focus')); });
  await expect.poll(() => count(page)).toBe(2);
  await respond(page, 1, empty()); await expect.poll(() => count(page)).toBe(3);
  await respond(page, 2, empty()); expect(await count(page)).toBe(3);
});

test('synthetic page lifecycle invalidates late data, preserves one subscription, and repeated script execution is inert', async () => {
  const page = await fixture();
  await page.evaluate(() => { window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })); window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })); });
  await expect.poll(() => count(page)).toBe(2);
  await respond(page, 1, empty()); await respond(page, 0, data());
  expect((await state(page)).state).toBe('empty');
  expect(await page.evaluate(() => window.__requests[0].aborted)).toBe(true);
  for (let cycle = 0; cycle < 3; cycle++) {
    await page.evaluate(() => { window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })); window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })); });
    await expect.poll(() => count(page)).toBe(cycle + 3); await respond(page, cycle + 2, empty());
  }
  expect(await page.evaluate(() => window.__registrations.filter(record => record.active).length)).toBe(1);
  await page.addScriptTag({ content: await readFile(new URL('../assets/home-quick-cards.js', import.meta.url), 'utf8') });
  expect(await count(page)).toBe(5);
  await page.clock.runFor(15000); expect(await count(page)).toBe(6); await respond(page, 5, empty());
  await page.evaluate(() => window.iHearHomeQuickCards.destroy());
  expect(await page.evaluate(() => window.__registrations.filter(record => record.active).length)).toBe(0);
  await page.clock.runFor(45000); expect(await count(page)).toBe(6);
});

test('real shared revision baselines separately, polls at ten seconds and bridges same-page structured announcements', async () => {
  const page = await fixture({ live: true }); await page.clock.runFor(1);
  await expect.poll(() => count(page)).toBe(2);
  const revisions = value => ({ version: 1, revisions: { content: { revision: value } } });
  expect(await page.evaluate(() => window.__requests[1].url)).toBe('/api/live-revisions');
  await respond(page, 0, data()); await respond(page, 1, revisions('one'));
  expect(await count(page)).toBe(2);
  await page.clock.runFor(9999); expect(await count(page)).toBe(2);
  await page.clock.runFor(1); expect(await count(page)).toBe(3);
  await respond(page, 2, revisions('two')); await expect.poll(() => count(page)).toBe(4);
  await respond(page, 3, empty());
  await page.evaluate(() => window.iHearLiveContent.announce('content', { revision: 'three' }));
  await expect.poll(() => count(page)).toBe(5); await respond(page, 4, data());
  expect((await state(page)).state).toBe('ready');
});
