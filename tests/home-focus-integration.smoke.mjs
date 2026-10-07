// CP6 joins the shipped Banner and Resources controllers on one production page.
// All writes use real admin APIs in a disposable OS-temp store. Deliberate
// transport/decode gates are browser-boundary race controls, never mock stores.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium, firefox, webkit, expect as baseExpect } from '@playwright/test';
import { encode } from 'next-auth/jwt';
import sharp from 'sharp';
import { initialResourceTopics, validateResourceDocument } from '../lib/resource-topic-model.ts';
import { RESOURCE_SEEDS } from '../lib/resource-seed.ts';

const expect = baseExpect.configure({ timeout: 12000 });
const origin = 'http://localhost:3224', secret = 'cp6-disposable-local-auth';
const stage = process.env.IHEAR_CP6_BROWSER_STAGE === 'preliminary' ? 'preliminary' : 'final';
const output = path.resolve('output/cp6-home-focus', stage === 'preliminary' ? 'preliminary' : ''), pictures = path.resolve('output/playwright/cp6-home-focus', stage === 'preliminary' ? 'preliminary' : '');
await mkdir(output, { recursive: true }); await mkdir(pictures, { recursive: true });
const directory = await mkdtemp(path.join(os.tmpdir(), 'ihear-cp6-browser-'));
const l = (en = '', zhHant = '', zhHans = '') => ({ en, zhHant, zhHans });
const meta = { version: 1, createdAt: '2026-10-08T00:00:00.000Z', updatedAt: '2026-10-08T00:00:00.000Z', createdBy: 'isolated-fixture', updatedBy: 'isolated-fixture', states: [] };
const record = (id, topicId) => ({ ...meta, id, topicId, type: 'text', category: 'article', status: 'published', sortOrder: 10, title: l(`Initial ${id}`), description: l(`Summary for ${id}`), url: '' });
const document = { schemaVersion: 2, legacyGuidesMigrated: false, topics: initialResourceTopics(), items: [
  ...RESOURCE_SEEDS.map(item => ({ ...meta, ...item, topicId: 'forms', type: 'external_link' })), record('cp6-announcement', 'announcements'), record('cp6-calendar', 'calendar'),
] };
validateResourceDocument(document); await writeFile(path.join(directory, 'resource-links.json'), JSON.stringify(document));
const engineInfo = JSON.parse(await readFile('node_modules/playwright-core/browsers.json', 'utf8'));
const evidence = { stage, startedAt: new Date().toISOString(), origin, node: process.version, os: { platform: os.platform(), release: os.release(), architecture: os.arch() }, playwright: JSON.parse(await readFile('node_modules/playwright/package.json', 'utf8')).version,
  buildId: (await readFile('.next/BUILD_ID', 'utf8')).trim(), storeMode: 'file', isolatedDataDirectory: directory, groups: [], engines: [], screenshots: [], measurements: [], status: 'running',
  screenReader: { tested: false, scope: 'Keyboard, accessible names and semantic assertions only. No actual screen-reader interaction is claimed.' } };
const save = () => writeFile(path.join(output, 'browser-results.json'), JSON.stringify(evidence, null, 2));
const owners = Array.from({ length: 12 }, (_, index) => `cp6-browser-${index + 1}@example.test`);
const server = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '--hostname', 'localhost', '--port', '3224'], {
  env: { ...process.env, NODE_ENV: 'production', VERCEL: '', NETLIFY: '', CONTEXT: '', IHEAR_FORCE_FILE_STORE: '1', IHEAR_TEST_DATA_DIR: directory,
    POSTGRES_URL: '', DATABASE_URL: '', SUPABASE_URL: '', SUPABASE_SERVICE_ROLE_KEY: '', AUTH_SECRET: secret, AUTH_OWNER_EMAILS: owners.join(','), AUTH_URL: origin, AUTH_TRUST_HOST: 'true' },
  windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '', browser, admin, visitors, page, bytes, photos = [], groupNumber = 0;
server.stdout.on('data', chunk => { serverLog += chunk; }); server.stderr.on('data', chunk => { serverLog += chunk; });
const pause = ms => new Promise(resolve => { setTimeout(resolve, ms); });
const banner = () => page.locator('[data-home-banner]');
const focus = () => page.locator('[data-home-focus]');
const cards = () => page.locator('[data-home-quick-cards]');
const card = name => page.locator(`[data-home-${name}]`);
const title = name => card(name).locator('[data-home-card-title]');
const link = name => card(name).locator('[data-home-card-link]');
const next = () => page.locator('[data-home-banner-next]');
const refresh = async (kind = 'both') => page.evaluate(value => {
  if (value !== 'resources') void window.iHearHomeBanner.refresh();
  if (value !== 'media') void window.iHearHomeQuickCards.refresh();
}, kind);
const notify = async (kind = 'both') => page.evaluate(value => {
  for (const channelName of value === 'media' ? ['ihear-media-galleries'] : value === 'resources' ? ['ihear-resources'] : ['ihear-media-galleries', 'ihear-resources']) {
    const channel = new BroadcastChannel(channelName); channel.postMessage('updated'); channel.close();
  }
}, kind);
const fresh = async () => { await expect(banner()).toHaveAttribute('data-refresh-state', 'fresh'); await expect(cards()).toHaveAttribute('data-refresh-state', 'fresh'); };
const cardState = async value => { for (const name of ['announcements', 'calendar']) await expect(card(name)).toHaveAttribute('data-state', value); };
const active = id => expect(banner()).toHaveAttribute('data-active-id', id);
async function actor() {
  const email = owners[groupNumber++];
  const token = await encode({ secret, salt: 'authjs.session-token', token: { name: 'CP6 local fixture author', email, sub: email } });
  await admin.addCookies([{ name: 'authjs.session-token', value: token, url: origin, httpOnly: true, sameSite: 'Lax' }]);
}
async function group(name, fn) {
  await actor(); const started = Date.now();
  try { await fn(); evidence.groups.push({ name, status: 'passed', milliseconds: Date.now() - started }); console.log(`PASS ${name}`); }
  catch (error) { evidence.groups.push({ name, status: 'failed', milliseconds: Date.now() - started, error: error.stack }); throw error; }
  finally { await save(); }
}
async function privateResources() {
  const response = await admin.request.get(`${origin}/api/resources?admin=1`); expect(response.status()).toBe(200); return response.json();
}
async function patchResource(id, patch) {
  const item = (await privateResources()).items.find(value => value.id === id);
  const response = await admin.request.patch(`${origin}/api/resources/${id}`, { headers: { Origin: origin }, data: { version: item.version, ...patch } });
  expect(response.status(), await response.text()).toBe(200); return (await response.json()).item;
}
async function resetResources() {
  for (const name of ['announcements', 'calendar']) {
    const topic = (await privateResources()).topics.find(value => value.id === name);
    const response = await admin.request.patch(`${origin}/api/resource-topics/${name}`, { headers: { Origin: origin }, data: { version: topic.version, status: 'published' } });
    expect(response.status(), await response.text()).toBe(200);
  }
  for (const item of document.items.filter(value => value.id.startsWith('cp6-'))) await patchResource(item.id, { topicId: item.topicId, status: 'published', title: item.title, description: item.description });
}
async function gallery() {
  const response = await admin.request.get(`${origin}/api/media-galleries?admin=1`); expect(response.status()).toBe(200);
  return (await response.json()).items.find(value => value.id === 'home-banner');
}
async function mutate(body, upload = false) {
  const payload = { operationId: randomUUID(), expectedVersion: (await gallery()).version, ...body };
  const response = await admin.request.post(`${origin}/api/media-galleries/home-banner`, { headers: { Origin: origin },
    ...(upload ? { multipart: { metadata: JSON.stringify(payload), file: { name: 'cp6.webp', mimeType: 'image/webp', buffer: bytes } } } : { data: payload }) });
  expect(response.status(), await response.text()).toBe(200); return (await response.json()).item;
}
async function editPhoto(id, patch) { return mutate({ action: 'put', item: { ...(await gallery()).items.find(value => value.id === id), ...patch } }); }
async function clearBanner() { for (const item of (await gallery()).items) await mutate({ action: 'remove', itemId: item.id }); }
async function addPhoto(name) {
  const id = randomUUID(); await mutate({ operationId: id, action: 'put', item: { id, kind: 'photo', hidden: false, title: l(name, `${name} 繁體`, `${name} 简体`), caption: l('Independent photo caption.', '獨立照片說明。', '独立照片说明。') }, alt: l('Green isolated photo', '綠色隔離測試照片', '绿色隔离测试照片') }, true); return id;
}
async function seedBanner(count = 2) { await clearBanner(); photos = []; for (let index = 0; index < count; index++) photos.push(await addPhoto(`CP6 photo ${index + 1}`)); }
async function newPage(options = {}, engine = browser) {
  await visitors?.close(); visitors = await engine.newContext({ locale: 'en-US', viewport: { width: 1024, height: 950 }, ...options }); page = await visitors.newPage(); page.setDefaultTimeout(15000);
  await page.addInitScript(() => {
    const nativeFetch = window.fetch.bind(window), nativeDecode = HTMLImageElement.prototype.decode;
    const nativeInterval = window.setInterval.bind(window), nativeClearInterval = window.clearInterval.bind(window);
    const probe = window.__cp6 = { phase: 'first-screen', phaseMarkers: [{ name: 'first-screen', start: 0 }], shifts: [], performanceSupported: PerformanceObserver.supportedEntryTypes?.includes('layout-shift') || false,
      media: { calls: [], active: 0, maximum: 0, hold: false, bodies: [] }, resources: { calls: [], active: 0, maximum: 0, hold: false, bodies: [] },
      holdDecode: false, decodes: [], intervals: {}, events: [], errors: [], globalActive: 0, globalMaximum: 0 };
    if (probe.performanceSupported) new PerformanceObserver(list => {
      for (const entry of list.getEntries()) probe.shifts.push({ startTime: entry.startTime, value: entry.value, hadRecentInput: entry.hadRecentInput, phase: probe.phaseMarkers.findLast(marker => marker.start <= entry.startTime)?.name || 'first-screen',
        sources: entry.sources?.map(source => ({ node: source.node?.id || source.node?.getAttribute?.('data-home-card-title') || source.node?.className || source.node?.tagName || null,
          previousRect: source.previousRect.toJSON(), currentRect: source.currentRect.toJSON() })) || [] });
    }).observe({ type: 'layout-shift', buffered: true });
    window.setInterval = (fn, delay, ...args) => {
      const id = nativeInterval(fn, delay, ...args), stack = new Error().stack || '';
      probe.intervals[id] = { delay, owner: stack.includes('home-quick-cards.js') ? 'resources' : stack.includes('home-banner.js') ? 'media' : 'other' }; return id;
    };
    window.clearInterval = id => { delete probe.intervals[id]; nativeClearInterval(id); };
    for (const name of ['pageshow', 'pagehide', 'online', 'offline']) addEventListener(name, event => probe.events.push({ type: name, persisted: 'persisted' in event ? event.persisted : null, time: performance.now() }));
    document.addEventListener('visibilitychange', () => probe.events.push({ type: 'visibilitychange', hidden: document.hidden, time: performance.now() }));
    addEventListener('error', event => probe.errors.push(event.message));
    window.fetch = async (input, options = {}) => {
      const url = new URL(typeof input === 'string' ? input : input.url, location.href);
      const kind = url.pathname === '/api/resources' ? 'resources' : url.pathname === '/api/media-galleries' && url.searchParams.get('gallery_id') === 'home-banner' ? 'media' : null;
      if (!kind) return nativeFetch(input, options);
      const state = probe[kind], call = { start: performance.now(), aborted: false, finished: false }; state.calls.push(call); state.active++; state.maximum = Math.max(state.maximum, state.active); probe.globalActive++; probe.globalMaximum = Math.max(probe.globalMaximum, probe.globalActive);
      const finish = () => { if (!call.finished) { call.finished = true; state.active--; probe.globalActive--; } };
      options.signal?.addEventListener('abort', () => { call.aborted = true; finish(); }, { once: true });
      try {
        const response = await nativeFetch(input, options); call.status = response.status; const json = response.json.bind(response);
        response.json = async () => { try { const value = await json(); if (state.hold) return await new Promise(resolve => { state.bodies.push({ resolve, value, call }); }); return value; } finally { finish(); } };
        if (!response.ok) finish(); return response;
      } catch (error) { call.error = String(error); finish(); throw error; }
    };
    HTMLImageElement.prototype.decode = function () {
      if (!probe.holdDecode) return nativeDecode.call(this);
      return new Promise((resolve, reject) => { probe.decodes.push({ resolve, reject, source: this.src }); });
    };
  });
}
async function open() { await page.goto(origin, { waitUntil: 'domcontentloaded' }); await expect(cards()).toHaveAttribute('data-cards-controller', 'ready'); await expect(banner()).toHaveAttribute('data-banner-controller', 'ready'); }
async function phase(name) { await page.evaluate(value => { window.__cp6.phase = value; window.__cp6.phaseMarkers.push({ name: value, start: performance.now() }); }, name); }
async function screen(name) { const file = path.join(pictures, name); await focus().screenshot({ path: file }); evidence.screenshots.push(file); }
function cls(entries) {
  const eligible = entries.filter(entry => !entry.hadRecentInput).sort((a, b) => a.startTime - b.startTime);
  const windows = []; let current;
  for (const entry of eligible) {
    if (!current || entry.startTime - current.last >= 1000 || entry.startTime - current.start >= 5000) {
      current = { start: entry.startTime, last: entry.startTime, score: 0, entries: 0 }; windows.push(current);
    }
    current.last = entry.startTime; current.score += entry.value; current.entries++;
  }
  return { value: Math.max(0, ...windows.map(window => window.score)), sessionWindows: windows };
}
async function measure(name) {
  await page.evaluate(() => new Promise(resolve => { requestAnimationFrame(() => requestAnimationFrame(resolve)); }));
  const data = await page.evaluate(() => ({ supported: window.__cp6.performanceSupported, entries: window.__cp6.shifts, phaseMarkers: window.__cp6.phaseMarkers, width: innerWidth, height: innerHeight }));
  const phases = [...new Set(data.phaseMarkers.map(marker => marker.name))].map(value => {
    const entries = data.entries.filter(entry => entry.phase === value);
    return { phase: value, entryCount: entries.length, recentInputEntryCount: entries.filter(entry => entry.hadRecentInput).length, eligibleShiftSum: entries.filter(entry => !entry.hadRecentInput).reduce((sum, entry) => sum + entry.value, 0) };
  });
  evidence.measurements.push({ name, ...data, cls: data.supported ? cls(data.entries) : null, phases, method: 'CLS = maximum session-window score: gaps < 1,000ms, duration < 5,000ms, excluding only hadRecentInput per the metric. All raw entries, including intended state-transition shifts, remain recorded. Phase sums are not called CLS.' });
}
async function snapshot() {
  const response = await fetch(origin), html = await response.text(); expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('private, no-store, max-age=0'); expect(response.headers.get('vercel-cdn-cache-control')).toBe('no-store');
  const match = html.match(/<script\b[^>]*id="ihear-home-banner"[^>]*>([\s\S]*?)<\/script>/); expect(match).not.toBeNull(); return { html, value: JSON.parse(match[1]) };
}
async function release(kind) { await page.evaluate(value => { const state = window.__cp6[value]; state.hold = false; state.bodies.forEach(body => body.resolve(body.value)); }, kind); }
async function held(kind, count = 1) { await expect.poll(() => page.evaluate(value => window.__cp6[value].bodies.length, kind)).toBe(count); }

try {
  let ready = false;
  for (let i = 0; i < 100; i++) { if (server.exitCode !== null) throw new Error(serverLog); try { if ((await fetch(`${origin}/api/resources`)).ok) { ready = true; break; } } catch { /* startup */ } await pause(500); }
  if (!ready) throw new Error('Local production server did not start');
  browser = await chromium.launch({ headless: true, ignoreDefaultArgs: ['--disable-back-forward-cache'] });
  evidence.engines.push({ name: 'chromium', version: browser.version(), revision: engineInfo.browsers.find(value => value.name === 'chromium').revision, coverage: 'Six joined scenarios plus CLS/keyboard/touch/layout and real navigation.' });
  admin = await browser.newContext(); bytes = await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="800" height="1000"><rect width="800" height="1000" fill="#167d70"/><rect y="200" width="800" height="600" fill="#27a99a"/></svg>')).webp().toBuffer();

  await group('01 admin API writes reach open homepage and new SSR; first screen and card-arrival layout shifts', async () => {
    await resetResources(); await seedBanner(); await newPage(); await page.addInitScript(() => { window.__cp6.resources.hold = true; }); await open(); await held('resources');
    await expect(focus()).toHaveAttribute('data-banner-state', 'ready'); await cardState('loading'); await pause(800); await measure('1024 initial SSR and loading cards');
    await phase('resources-arrival'); await release('resources'); await cardState('ready'); await fresh(); await pause(800); await measure('1024 Resources arrival');
    await editPhoto(photos[0], { title: l('Updated through real admin API', '後台更新繁體橫幅', '后台更新简体横幅') });
    await patchResource('cp6-announcement', { title: l('Admin announcement update') }); await patchResource('cp6-calendar', { title: l('Admin calendar update') });
    await phase('admin-updates'); await notify(); await expect(page.locator('[data-home-banner-field="title"]')).toHaveText('Updated through real admin API');
    await expect(title('announcements')).toHaveText('Admin announcement update'); await expect(title('calendar')).toHaveText('Admin calendar update'); await fresh();
    const freshSSR = await snapshot(); expect(freshSSR.value.items[0].title.en).toBe('Updated through real admin API'); expect(freshSSR.value.version).toBe((await gallery()).version);
    await writeFile(path.join(output, 'browser-new-request.html'), freshSSR.html); await screen('integrated-ready-1024.png');
    const noJs = await browser.newContext({ javaScriptEnabled: false, locale: 'zh-TW', viewport: { width: 390, height: 950 } }); const target = await noJs.newPage(); await target.goto(origin);
    await expect(target.locator('[data-home-banner-field="title"]')).toHaveText('後台更新繁體橫幅'); await expect(target.locator('[data-home-banner-next]')).toBeHidden();
    for (const name of ['announcements', 'calendar']) await expect(target.locator(`[data-home-${name}] [data-home-card-link]`)).toHaveAttribute('href', '/resources');
    const file = path.join(pictures, 'integrated-no-js-390.png'); await target.locator('[data-home-focus]').screenshot({ path: file }); evidence.screenshots.push(file); await noJs.close();
    evidence.adminToPublic = { realAdminApiDifferentContext: true, notificationBoundary: 'Normal same-origin BroadcastChannel updated signals, emitted after real admin writes.', newSSRVersion: freshSSR.value.version, noRebuild: true };
  });

  await group('02 withdrawal, empty and legitimate republish never revive a removed delayed-decode photo', async () => {
    await newPage({ viewport: { width: 390, height: 950 } }); await open(); await fresh();
    await page.evaluate(() => { window.__cp6.holdDecode = true; }); await next().click(); await active(photos[1]); await expect.poll(() => page.evaluate(() => window.__cp6.decodes.length)).toBeGreaterThan(0); await pause(650);
    await phase('withdrawal'); await editPhoto(photos[1], { hidden: true }); await patchResource('cp6-announcement', { status: 'draft' }); await patchResource('cp6-calendar', { topicId: 'forms' }); await notify();
    await active(photos[0]); await cardState('empty'); expect(await banner().textContent()).not.toContain('CP6 photo 2'); await fresh();
    await phase('ready-to-empty'); await clearBanner(); await notify('media'); await expect(focus()).toHaveAttribute('data-banner-state', 'empty'); await expect(banner()).toBeHidden();
    await page.evaluate(() => { window.__cp6.holdDecode = false; window.__cp6.decodes.forEach(value => value.resolve()); }); await pause(700);
    await expect(banner()).toBeHidden(); expect(await banner().textContent()).not.toContain('CP6 photo 2'); await screen('integrated-empty-390.png'); await measure('390 withdrawal and ready to empty including designed reflow');
    await phase('empty-to-ready'); photos = [await addPhoto('Legitimate restored content')]; await patchResource('cp6-announcement', { status: 'published' }); await patchResource('cp6-calendar', { topicId: 'calendar' }); await notify();
    await active(photos[0]); await cardState('ready'); await fresh(); await pause(700); await measure('390 legitimate empty to ready including designed reflow');
    evidence.withdrawal = { hiddenAndRemovedPhotoGoneBeforeDecodeRelease: true, oldDecodeDidNotRevive: true, publicResourcesDraftAndMoveEmpty: true, newAuthorizedPhotoAndRepublishedResourcesRestored: true };
  });

  await group('03 Resources and Banner failures remain independent and recover through their own refresh paths', async () => {
    await seedBanner(); await newPage(); await open(); await fresh();
    await page.route('**/api/resources', route => route.fulfill({ status: 503, json: { error: 'isolated unavailable Guides/resource snapshot' } }));
    await refresh('resources'); await expect(cards()).toHaveAttribute('data-refresh-state', 'stale'); await cardState('ready'); await next().click(); await active(photos[1]);
    await expect(card('tutors').locator('a')).toHaveCount(2); await page.unroute('**/api/resources');
    await page.evaluate(() => { window.__cp6.media.hold = true; }); await refresh('media'); await held('media');
    await patchResource('cp6-announcement', { title: l('Resources update during Banner wait') }); await notify('resources'); await expect(title('announcements')).toHaveText('Resources update during Banner wait');
    await expect(banner()).toHaveAttribute('data-refresh-state', 'stale', { timeout: 8000 }); expect(await page.evaluate(() => window.__cp6.media.bodies[0].call.aborted)).toBe(true);
    await active(photos[1]); await release('media'); await refresh(); await fresh(); await active(photos[1]);
    evidence.failureIsolation = { resource503KeptBannerOperable: true, mediaBodyFiveSecondAbortObserved: true, resourcesUpdatedDuringMediaWait: true, moduleMaximumInFlight: await page.evaluate(() => ({ media: window.__cp6.media.maximum, resources: window.__cp6.resources.maximum, combined: window.__cp6.globalMaximum })) };
    await newPage({ viewport: { width: 320, height: 950 } }); await page.route('**/api/resources', route => route.fulfill({ status: 503, json: { error: 'initial outage' } })); await open(); await cardState('error'); await expect(focus()).toHaveAttribute('data-banner-state', 'ready');
    await screen('integrated-error-320.png'); await page.unroute('**/api/resources'); await card('announcements').locator('[data-home-card-retry]').click(); await cardState('ready'); await expect(link('announcements')).toBeFocused();
  });

  await group('04 slow simultaneous reads, reorder, locale and CTA focus preserve valid selection and independent trailing refresh', async () => {
    await resetResources(); await seedBanner(3); await newPage(); await open(); await fresh(); await next().click(); await active(photos[1]); await link('announcements').focus();
    await page.evaluate(() => { window.__cp6.media.hold = true; window.__cp6.resources.hold = true; }); await refresh(); await held('media'); await held('resources');
    await mutate({ action: 'move', itemId: photos[1], direction: -1 }); await editPhoto(photos[1], { title: l('Long English banner title '.repeat(4).trim(), '繁體橫幅長標題'.repeat(12), '简体横幅长标题'.repeat(12)) });
    await patchResource('cp6-announcement', { title: l('Announcement title '.repeat(9).trim()), description: l('Long English resource summary. '.repeat(15).trim()) });
    await patchResource('cp6-announcement', { title: l('Announcement title '.repeat(9).trim(), '繁體公告標題'.repeat(20), '简体公告标题'.repeat(20)), description: l('Long English resource summary. '.repeat(15).trim(), '繁體摘要。'.repeat(70), '简体摘要。'.repeat(70)) });
    await page.evaluate(() => window.iHearSetLanguage('zhCN')); await notify();
    const counts = await page.evaluate(() => ({ media: window.__cp6.media.calls.length, resources: window.__cp6.resources.calls.length }));
    await release('media'); await release('resources'); await expect(title('announcements')).toHaveText('简体公告标题'.repeat(20)); await fresh(); await active(photos[1]); await expect(link('announcements')).toBeFocused();
    expect(await page.evaluate(() => ({ media: window.__cp6.media.calls.length, resources: window.__cp6.resources.calls.length }))).toEqual({ media: counts.media + 1, resources: counts.resources + 1 });
    const concurrency = await page.evaluate(() => ({ media: window.__cp6.media.maximum, resources: window.__cp6.resources.maximum, combined: window.__cp6.globalMaximum })); expect(concurrency.media).toBe(1); expect(concurrency.resources).toBe(1); expect(concurrency.combined).toBe(2);
    await pause(700); await phase('language-switch'); await page.evaluate(() => window.iHearSetLanguage('zhTW')); await expect(title('announcements')).toHaveText('繁體公告標題'.repeat(20)); await active(photos[1]); await expect(link('announcements')).toBeFocused(); await pause(700); await measure('1024 long copy and programmatic language switch');
    evidence.layouts = [];
    for (const [width, lang] of [[320, 'en'], [390, 'zhTW'], [768, 'zhCN'], [1024, 'en']]) {
      await phase(`viewport-${width}`); await page.setViewportSize({ width, height: 1000 }); await page.evaluate(value => window.iHearSetLanguage(value), lang);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await active(photos[1]); const frame = await banner().boundingBox(), quick = await cards().boundingBox();
      if (width >= 1024) { expect(frame.width / quick.width).toBeCloseTo(7 / 3, 2); expect(quick.x - frame.x - frame.width).toBeCloseTo(24, 0); }
      else expect(quick.y).toBeGreaterThanOrEqual(frame.y + frame.height - 1);
      evidence.layouts.push({ width, language: lang, banner: frame, cards: quick }); await screen(`integrated-long-${width}-${lang}.png`);
    }
    await next().focus(); await next().press('ArrowRight'); await active(photos[0]); await expect(next()).toBeFocused(); await expect(next()).toHaveAccessibleName('Next photo');
    await link('announcements').focus(); await page.keyboard.press('Tab'); await expect(link('calendar')).toBeFocused();
    expect(await focus().locator('[hidden] a:visible, [hidden] button:visible').count()).toBe(0);
    evidence.interactionDuringUpdate = { activeIdPreserved: true, focusPreserved: true, responseUsesCurrentLanguage: true, twoIndependentInFlightsAndOneTrailingEach: concurrency, keyboardNamesAndOrder: true };
  });

  await group('05 visibility, real offline-online and actual history return calibrate without duplicate schedules', async () => {
    await resetResources(); await newPage(); await open(); await fresh();
    const other = await visitors.newPage(); await other.goto(`${origin}/about`); await other.bringToFront(); const actuallyHidden = await page.evaluate(() => document.hidden);
    if (!actuallyHidden) await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')); });
    expect(await page.evaluate(() => Object.values(window.__cp6.intervals).filter(value => value.delay === 15000 && value.owner !== 'other').length)).toBe(0);
    await patchResource('cp6-calendar', { title: l('Calendar updated while hidden') });
    if (!actuallyHidden) await page.evaluate(() => { delete document.hidden; document.dispatchEvent(new Event('visibilitychange')); });
    await page.bringToFront(); await expect(title('calendar')).toHaveText('Calendar updated while hidden'); await fresh(); await other.close();
    await visitors.setOffline(true); await expect.poll(() => page.evaluate(() => navigator.onLine)).toBe(false); await refresh(); await expect(cards()).toHaveAttribute('data-refresh-state', 'stale');
    await patchResource('cp6-announcement', { title: l('Updated while browser offline') }); await visitors.setOffline(false); await expect(title('announcements')).toHaveText('Updated while browser offline'); await fresh();
    expect(await page.evaluate(() => Object.values(window.__cp6.intervals).filter(value => value.delay === 15000 && value.owner !== 'other').length)).toBe(2);
    const beforeNavigationEvents = await page.evaluate(() => window.__cp6.events);
    await page.goto(`${origin}/about`); await patchResource('cp6-calendar', { title: l('Updated during real navigation') }); await page.goBack({ waitUntil: 'domcontentloaded' }); await expect(title('calendar')).toHaveText('Updated during real navigation'); await fresh();
    const observations = await page.evaluate(() => ({ events: window.__cp6.events, intervalCount: Object.values(window.__cp6.intervals).filter(value => value.delay === 15000 && value.owner !== 'other').length, allIntervals: window.__cp6.intervals,
      navigation: performance.getEntriesByType('navigation').map(entry => ({ type: entry.type, notRestoredReasons: entry.notRestoredReasons?.toJSON?.() || null })) }));
    expect(observations.intervalCount).toBe(2);
    evidence.lifecycle = { visibility: actuallyHidden ? 'Real tab visibility change' : 'Headless tab remained visible; document.hidden/visibilitychange boundary simulated explicitly', beforeNavigationEvents, offlineOnlineViaBrowserContext: true, ...observations,
      actualBFCacheHit: observations.events.some(event => event.type === 'pageshow' && event.persisted), bfcacheLaunch: { ignoredDefaultArgument: '--disable-back-forward-cache', actualCacheAndApiPreserved: true }, syntheticBFCacheNotRun: true };
  });

  await group('06 confirmed resource destinations, legacy video, native touch scrolling and reduced motion remain usable', async () => {
    await newPage({ viewport: { width: 390, height: 950 }, hasTouch: true, reducedMotion: 'reduce' }); await open(); await fresh();
    const startId = await banner().getAttribute('data-active-id'), frame = await page.locator('.home-banner__image').boundingBox();
    const client = await visitors.newCDPSession(page);
    const gesture = async points => {
      await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: points[0][0], y: points[0][1] }] });
      for (const [x, y] of points.slice(1)) await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y }] });
      await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    };
    await gesture([[frame.x + 270, frame.y + 120], [frame.x + 170, frame.y + 121], [frame.x + 75, frame.y + 123]]); await expect(banner()).not.toHaveAttribute('data-active-id', startId);
    const afterHorizontal = await banner().getAttribute('data-active-id'); await gesture([[frame.x + 160, frame.y + 140], [frame.x + 164, frame.y + 70], [frame.x + 164, frame.y + 20]]); await active(afterHorizontal); expect(await page.evaluate(() => scrollY)).toBeGreaterThan(0);
    expect(await page.locator('[data-home-banner-image]').evaluate(element => getComputedStyle(element).transitionDuration)).toBe('0s'); await page.evaluate(() => scrollTo(0, 0)); await screen('integrated-touch-reduced-390.png');
    for (const slug of ['announcements', 'calendar']) { await link(slug).click(); await expect(page).toHaveURL(`${origin}/resources#${slug}`); await expect(page.locator(`[data-resource-slug="${slug}"] h2`)).toBeFocused(); await page.goBack(); await fresh(); }
    for (const hook of ['forms', 'materials']) {
      const href = await page.locator(`[data-home-tutor-${hook}]`).getAttribute('href'); await page.goto(origin + href); const target = new URL(origin + href).hash.slice(1); await expect(page.locator(`[id="${target}"]`)).toBeVisible(); await page.goBack(); await fresh();
    }
    await page.goto(`${origin}/stories`); const legacy = page.locator('[data-media-gallery="stories"]'); await expect(legacy.locator('.gallery-video-cover')).toBeVisible();
    await expect(legacy.locator('a[href="https://www.youtube.com/watch?v=LsQWwDBLKUc"]')).toBeVisible();
    const all = await (await admin.request.get(`${origin}/api/media-galleries`)).json(); expect(all.items.some(gallery => gallery.id === 'stories' && gallery.items.some(item => item.kind === 'youtube'))).toBe(true);
    evidence.legacyAndInput = { resourceCategoryAnchors: true, tutorFormsAndGuides: true, videoKind: 'youtube', legacyGallery: 'stories', playbackNotClaimed: 'Verified cover and unchanged YouTube destination; no external video playback assertion.', realCDPTouch: true, verticalScrollRetained: true, reducedMotion: true };
  });

  for (const [name, engineType] of [['firefox', firefox], ['webkit', webkit]]) {
    const configured = engineInfo.browsers.find(value => value.name === name), executable = engineType.executablePath();
    if (!existsSync(executable)) { evidence.engines.push({ name, revision: configured.revision, status: 'blocked', reason: 'Project-matched executable missing', executable }); continue; }
    let engine;
    try { engine = await engineType.launch({ headless: true }); }
    catch (error) { evidence.engines.push({ name, revision: configured.revision, status: 'blocked', reason: String(error) }); continue; }
    evidence.engines.push({ name, version: engine.version(), revision: configured.revision, status: 'running', scope: 'Limited engine check; Playwright WebKit is not actual Safari/iPhone.' });
    try {
      await group(`${name} limited initial operation, real update/withdraw/restore, and failure isolation`, async () => {
        await resetResources(); await seedBanner(); await newPage({ viewport: { width: 1024, height: 950 } }, engine); await open(); await fresh(); await cardState('ready');
        await next().focus(); await next().press('Enter'); await active(photos[1]); await expect(next()).toBeFocused();
        await editPhoto(photos[1], { title: l(`${name} actual API update`) }); await patchResource('cp6-announcement', { title: l(`${name} announcement update`) }); await notify(); await expect(page.locator('[data-home-banner-field="title"]')).toHaveText(`${name} actual API update`); await expect(title('announcements')).toHaveText(`${name} announcement update`);
        await editPhoto(photos[1], { hidden: true }); await patchResource('cp6-announcement', { status: 'draft' }); await notify(); await active(photos[0]); await expect(card('announcements')).toHaveAttribute('data-state', 'empty');
        await editPhoto(photos[1], { hidden: false }); await patchResource('cp6-announcement', { status: 'published' }); await notify(); await cardState('ready'); await expect(page.locator('[data-home-banner-dot]')).toHaveCount(2);
        await page.route('**/api/resources', route => route.fulfill({ status: 503, json: { error: 'engine isolated outage' } })); await refresh('resources'); await expect(cards()).toHaveAttribute('data-refresh-state', 'stale'); await next().click(); await active(photos[1]); await expect(card('tutors').locator('a')).toHaveCount(2);
        await page.unroute('**/api/resources'); await refresh('resources'); await fresh(); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); await screen(`${name}-ready-1024.png`);
      });
      evidence.engines.find(value => value.name === name).status = 'passed';
    } finally { await visitors?.close(); visitors = null; await engine.close(); }
  }
  expect((await readFile('.next/BUILD_ID', 'utf8')).trim()).toBe(evidence.buildId);
  evidence.status = evidence.engines.some(value => value.status === 'blocked') ? 'passed-with-environment-blockers' : 'passed';
  evidence.summary = { passed: evidence.groups.filter(value => value.status === 'passed').length, failed: 0, skipped: evidence.engines.filter(value => value.status === 'blocked').length, exitCode: 0 };
  evidence.finishedAt = new Date().toISOString(); console.log(`PASS ${evidence.summary.passed} CP6 integration groups; ${evidence.summary.skipped} engine environment blockers`);
} catch (error) {
  evidence.status = 'failed'; evidence.summary = { passed: evidence.groups.filter(value => value.status === 'passed').length, failed: 1, skipped: 0, exitCode: 1 }; evidence.error = error.stack; console.error(error); process.exitCode = 1;
  try { evidence.failureBrowser = await page.evaluate(() => ({ url: location.href, probe: window.__cp6, hidden: document.hidden })); await page.screenshot({ path: path.join(pictures, 'failure.png'), fullPage: true }); } catch { /* browser may already be closed */ }
} finally {
  await save(); await writeFile(path.join(output, 'browser-server.log'), serverLog); await visitors?.close(); await admin?.close(); await browser?.close(); server.kill();
}
