// CP4 acceptance against a real production build and a disposable file store.
// Network/decode ordering controls below wrap browser boundaries only: the
// shipped controller, shared revision code, DOM and real admin API remain real.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';
import { encode } from 'next-auth/jwt';
import sharp from 'sharp';

const origin = 'http://localhost:3220';
const secret = 'cp4-disposable-browser-secret';
const testOwners = ['cp4-test@example.com', ...Array.from({ length: 16 }, (_, index) => `cp4-case-${index + 1}@example.com`)];
const output = path.resolve(process.env.IHEAR_CP4_EVIDENCE_DIR || 'output/playwright/cp4-home-banner');
await mkdir(output, { recursive: true });
const directory = await mkdtemp(path.join(output, 'isolated-store-'));
const results = { origin, storeMode: 'file', isolatedDataDirectory: directory, buildId: (await readFile('.next/BUILD_ID', 'utf8')).trim(), cases: [], screenshots: [], status: 'running' };
const save = () => writeFile(path.join(output, 'results.json'), JSON.stringify(results, null, 2));
const child = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '--hostname', 'localhost', '--port', '3220'], {
  env: { ...process.env, NODE_ENV: 'production', VERCEL: '', NETLIFY: '', CONTEXT: '', IHEAR_FORCE_FILE_STORE: '1', IHEAR_TEST_DATA_DIR: directory,
    DATABASE_URL: '', POSTGRES_URL: '', SUPABASE_URL: '', SUPABASE_SERVICE_ROLE_KEY: '', AUTH_SECRET: secret,
    AUTH_OWNER_EMAILS: testOwners.join(','), AUTH_URL: origin, AUTH_TRUST_HOST: 'true' },
  windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
});
let logs = '', browser, admin, visitors, page, bytes;
child.stdout.on('data', chunk => { logs += chunk; }); child.stderr.on('data', chunk => { logs += chunk; });
const pause = ms => new Promise(resolve => { setTimeout(resolve, ms); });
const text = (en = '', zhHant = '', zhHans = '') => ({ en, zhHant, zhHans });
const oneTitle = text('First learning story', '第一個學習故事', '第一个学习故事');
const twoTitle = text('Second learning story', '第二個學習故事', '第二个学习故事');
const threeTitle = text('Third learning story', '第三個學習故事', '第三个学习故事');
const focus = () => page.locator('[data-home-focus]');
const banner = () => page.locator('[data-home-banner]');
const title = () => page.locator('[data-home-banner-field="title"]');
const previous = () => page.locator('[data-home-banner-previous]');
const next = () => page.locator('[data-home-banner-next]');
const dots = () => page.locator('[data-home-banner-dot]');
const counter = () => page.locator('[data-home-banner-counter]');
const filtered = url => { const u = new URL(url); return u.pathname === '/api/media-galleries' && u.searchParams.get('gallery_id') === 'home-banner'; };
let firstId, secondId, thirdId;

async function run(name, fn) {
  const started = Date.now();
  // Each case has an independent local test actor and rate-limit bucket. Keep
  // the production 30-mutation/minute and 30-upload/10-minute policies intact.
  const email = `cp4-case-${Number(name.slice(0, 2))}@example.com`;
  const token = await encode({ secret, salt: 'authjs.session-token', token: { name: 'CP4 isolated case', email, sub: email } });
  await admin.addCookies([{ name: 'authjs.session-token', value: token, url: origin, httpOnly: true, sameSite: 'Lax' }]);
  try { await fn(); results.cases.push({ name, status: 'passed', milliseconds: Date.now() - started }); console.log(`PASS ${name}`); }
  catch (error) { results.cases.push({ name, status: 'failed', milliseconds: Date.now() - started, error: error.stack }); throw error; }
  finally { await save(); }
}
async function gallery() {
  const response = await admin.request.get(`${origin}/api/media-galleries?admin=1`);
  expect(response.status()).toBe(200); return (await response.json()).items.find(value => value.id === 'home-banner');
}
async function publicData() {
  const response = await admin.request.get(`${origin}/api/media-galleries?gallery_id=home-banner`);
  expect(response.status()).toBe(200); return response.json();
}
async function mutate(body, upload = false) {
  const payload = { operationId: randomUUID(), expectedVersion: (await gallery()).version, ...body };
  const response = await admin.request.post(`${origin}/api/media-galleries/home-banner`, {
    headers: { Origin: origin }, ...(upload ? { multipart: { metadata: JSON.stringify(payload), file: { name: 'cp4.webp', mimeType: 'image/webp', buffer: bytes } } } : { data: payload }),
  });
  expect(response.status(), await response.text()).toBe(200); return (await response.json()).item;
}
async function edit(id, patch) { return mutate({ action: 'put', item: { ...(await gallery()).items.find(value => value.id === id), ...patch } }); }
async function clear() { for (const item of (await gallery()).items) await mutate({ action: 'remove', itemId: item.id }); }
async function add(value, caption = text('A short caption.', '簡短的說明。', '简短的说明。')) {
  const id = randomUUID();
  await mutate({ operationId: id, action: 'put', item: { id, kind: 'photo', hidden: false, title: value, caption }, alt: text('Central crop test photo', '中央裁切測試照片', '中央裁切测试照片') }, true);
  return id;
}
async function seed(count = 3) {
  await clear(); firstId = await add(oneTitle);
  secondId = count > 1 ? await add(twoTitle) : null;
  thirdId = count > 2 ? await add(threeTitle) : null;
}
async function screen(name) { const file = path.join(output, name); await focus().screenshot({ path: file }); results.screenshots.push(file); }
async function active(id) { await expect(banner()).toHaveAttribute('data-active-id', id); }
async function state(value) { await expect(focus()).toHaveAttribute('data-banner-state', value); }
async function signal() {
  await page.evaluate(() => {
    const channel = new BroadcastChannel('ihear-media-galleries'); channel.postMessage('updated'); channel.close();
  });
}
async function refresh() { await page.evaluate(() => { void window.iHearHomeBanner.refresh(); }); }
async function fresh() { await expect(banner()).toHaveAttribute('data-refresh-state', 'fresh'); }
async function newPage(options = {}) {
  await visitors?.close();
  visitors = await browser.newContext({ viewport: { width: 1280, height: 1000 }, locale: 'en-US', ...options });
  page = await visitors.newPage(); page.setDefaultTimeout(12_000);
  await page.addInitScript(() => {
    const nativeFetch = window.fetch.bind(window);
    const nativeDecode = HTMLImageElement.prototype.decode;
    const probe = window.__cp4 = { calls: [], active: 0, maximum: 0, holdBody: false, bodies: [], holdDecode: false, decodes: [], pageShows: [], errors: [] };
    addEventListener('pageshow', event => { probe.pageShows.push({ persisted: event.persisted, time: performance.now() }); });
    addEventListener('error', event => probe.errors.push(String(event.message)));
    window.fetch = async (input, options = {}) => {
      const url = new URL(typeof input === 'string' ? input : input.url, location.href);
      if (url.pathname !== '/api/media-galleries' || url.searchParams.get('gallery_id') !== 'home-banner') return nativeFetch(input, options);
      const record = { time: Date.now(), url: url.href, aborted: false, finished: false };
      probe.calls.push(record); probe.active++; probe.maximum = Math.max(probe.maximum, probe.active);
      const finish = () => { if (!record.finished) { record.finished = true; probe.active--; } };
      options.signal?.addEventListener('abort', () => { record.aborted = true; finish(); }, { once: true });
      try {
        const response = await nativeFetch(input, options);
        const json = response.json.bind(response);
        response.json = async () => {
          try {
            const value = await json();
            if (probe.holdBody) return await new Promise(resolve => { probe.bodies.push({ resolve, value, record }); });
            return value;
          } finally { finish(); }
        };
        if (!response.ok) finish();
        return response;
      } catch (error) { finish(); throw error; }
    };
    HTMLImageElement.prototype.decode = function () {
      if (!probe.holdDecode) return nativeDecode.call(this);
      const image = this;
      return new Promise((resolve, reject) => { probe.decodes.push({ image, resolve, reject, src: image.src }); });
    };
  });
  return page;
}
async function open() {
  await page.goto(origin, { waitUntil: 'domcontentloaded' });
  await expect(banner()).toHaveAttribute('data-banner-controller', 'ready');
  await fresh();
}
async function synthetic(payload) {
  await page.route('**/api/media-galleries?*', route => filtered(route.request().url()) ? route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(payload) }) : route.continue());
}
async function removeRoutes() { await page.unroute('**/api/media-galleries?*'); }
function versioned(payload, version, items = payload.items[0].items) {
  const value = structuredClone(payload); value.items[0].version = version; value.items[0].items = structuredClone(items); return value;
}

try {
  let ready = false;
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error(`Server exited: ${logs.slice(-3000)}`);
    try { if ((await fetch(`${origin}/api/media-galleries`)).ok) { ready = true; break; } } catch { /* startup */ }
    await pause(500);
  }
  if (!ready) throw new Error('Isolated production server did not start');
  browser = await chromium.launch({ headless: true, ignoreDefaultArgs: ['--disable-back-forward-cache'] });
  results.browser = browser.version();
  admin = await browser.newContext();
  const token = await encode({ secret, salt: 'authjs.session-token', token: { name: 'CP4 test', email: 'cp4-test@example.com', sub: 'cp4-test' } });
  await admin.addCookies([{ name: 'authjs.session-token', value: token, url: origin, httpOnly: true, sameSite: 'Lax' }]);
  bytes = await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="600" height="1000"><rect width="600" height="200" fill="#ea4444"/><rect y="200" width="600" height="600" fill="#20a478"/><rect y="800" width="600" height="200" fill="#416fd4"/></svg>')).webp().toBuffer();

  await run('01 SSR DOM survives takeover and failed first calibration; no-JS controls stay absent', async () => {
    await seed(1); await newPage();
    await page.addInitScript(() => {
      new MutationObserver(() => {
        const image = document.querySelector('[data-home-banner-image]');
        if (image && !window.__firstBannerImage) window.__firstBannerImage = image;
      }).observe(document, { childList: true, subtree: true });
    });
    await page.route('**/api/media-galleries?*', route => filtered(route.request().url()) ? route.fulfill({ status: 503, body: 'unavailable' }) : route.continue());
    await page.goto(origin); await state('ready'); await active(firstId);
    await expect(banner()).toHaveAttribute('data-refresh-state', 'stale');
    await expect(title()).toHaveText(oneTitle.en);
    expect(await page.evaluate(() => window.__firstBannerImage === document.querySelector('[data-home-banner-image]'))).toBe(true);
    expect(await page.evaluate(() => window.__cp4.calls.length)).toBe(1);
    await expect(next()).toBeHidden(); await screen('ssr-calibration-failure-desktop.png');
    const noJs = await browser.newContext({ javaScriptEnabled: false, locale: 'zh-TW' });
    const target = await noJs.newPage(); await target.goto(origin);
    await expect(target.locator('[data-home-banner-field="title"]')).toHaveText(oneTitle.zhHant);
    await expect(target.locator('[data-home-banner-next]')).toBeHidden(); await noJs.close();
  });

  await run('02 real file-store 0 to 1 to many to 1 to 0 updates without rebuilding or reseeding', async () => {
    await clear(); await newPage(); await open(); await state('empty'); await expect(banner()).toBeHidden();
    firstId = await add(oneTitle); await signal(); await active(firstId); await state('ready'); await fresh(); await expect(next()).toBeHidden();
    secondId = await add(twoTitle); thirdId = await add(threeTitle); await signal(); await expect(dots()).toHaveCount(3); await expect(next()).toBeVisible();
    await edit(secondId, { hidden: true }); await edit(thirdId, { hidden: true }); await signal(); await expect(next()).toBeHidden(); await active(firstId);
    await edit(firstId, { hidden: true }); await signal(); await state('empty'); await expect(banner()).toBeHidden();
    expect(await banner().textContent()).not.toContain(oneTitle.en);
    const accepted = Number(await banner().getAttribute('data-gallery-version'));
    await page.reload(); await state('empty'); expect(Number(await banner().getAttribute('data-gallery-version'))).toBe(accepted);
    await screen('empty-desktop.png'); results.transitions = ['empty', 'one', 'three', 'one', 'empty'];
  });

  await run('03 arrows dots keyboard touch loop with focus and reduced motion; no autoplay', async () => {
    await seed(); await newPage({ hasTouch: true, reducedMotion: 'reduce' }); await open(); await active(firstId);
    await previous().click(); await active(thirdId); await expect(previous()).toBeFocused();
    await next().click(); await active(firstId); await expect(next()).toBeFocused();
    await dots().nth(1).click(); await active(secondId); await expect(dots().nth(1)).toHaveAttribute('aria-current', 'true');
    await dots().nth(1).press('ArrowRight'); await active(thirdId);
    await dots().nth(2).press('ArrowRight'); await active(firstId);
    await page.locator('.nav-logo').focus(); await page.keyboard.press('ArrowRight'); await active(firstId);
    await previous().focus(); await page.keyboard.press('Tab'); await expect(dots().first()).toBeFocused();
    await page.keyboard.press('Shift+Tab'); await expect(previous()).toBeFocused();
    await page.setViewportSize({ width: 390, height: 900 });
    const box = await page.locator('.home-banner__image').boundingBox();
    const client = await visitors.newCDPSession(page);
    const touch = async (points, cancel = false) => {
      await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: points[0][0], y: points[0][1] }] });
      for (const [x, y] of points.slice(1)) await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y }] });
      await client.send('Input.dispatchTouchEvent', { type: cancel ? 'touchCancel' : 'touchEnd', touchPoints: [] });
    };
    // Start below the overlay controls: touching the controls themselves must
    // retain native button/scroll behavior rather than initiating a swipe.
    await touch([[box.x + 270, box.y + 120], [box.x + 160, box.y + 124], [box.x + 60, box.y + 126]]); await active(secondId);
    await touch([[box.x + 60, box.y + 120], [box.x + 170, box.y + 122], [box.x + 270, box.y + 125]]); await active(firstId);
    await touch([[box.x + 120, box.y + 120]]); await active(firstId);
    await touch([[box.x + 260, box.y + 120], [box.x + 150, box.y + 124]], true); await active(firstId);
    await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: box.x + 100, y: box.y + 120 }, { x: box.x + 220, y: box.y + 120 }] });
    await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: box.x + 80, y: box.y + 120 }, { x: box.x + 240, y: box.y + 120 }] });
    await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await active(firstId);
    await client.send('Emulation.setPageScaleFactor', { pageScaleFactor: 1 });
    const beforeScroll = await page.evaluate(() => scrollY);
    await touch([[box.x + 170, box.y + 120], [box.x + 174, box.y + 80], [box.x + 176, box.y + 30]]); await active(firstId);
    expect(await page.evaluate(() => scrollY)).toBeGreaterThan(beforeScroll);
    await page.evaluate(() => scrollTo(0, 0));
    await page.evaluate(() => window.iHearSetLanguage('zhTW')); await expect(next()).toHaveAccessibleName(/下一/);
    await expect(page.locator('[data-home-banner-status]')).toContainText('照片');
    await page.evaluate(() => window.iHearSetLanguage('zhCN')); await expect(previous()).toHaveAccessibleName(/上一/);
    await expect(page.locator('[data-home-banner-status]')).toContainText('照片');
    const announcement = await page.locator('[data-home-banner-status]').textContent(); await signal(); await fresh();
    expect(await page.locator('[data-home-banner-status]').textContent()).toBe(announcement);
    expect(await page.locator('[data-home-banner-image]').evaluate(element => getComputedStyle(element).transitionDuration)).toMatch(/^0s/);
    await screen('manual-mobile-reduced-motion.png');
    results.interactions = { nativeTouchViaCDP: true, verticalScrollPreserved: true, keyboardScope: 'Banner only', screenReaderTested: false, reducedMotion: true };
  });

  await run('04 reorder preserves active ID and focus; removal selects new first and removes old content', async () => {
    await seed(); await newPage(); await open(); await dots().nth(1).click(); await active(secondId); await next().focus();
    await mutate({ action: 'move', itemId: secondId, direction: -1 }); await signal(); await fresh(); await active(secondId); await expect(next()).toBeFocused();
    await expect(counter()).toContainText('1'); await expect(dots().first()).toHaveAttribute('data-id', secondId);
    await mutate({ action: 'remove', itemId: secondId }); await signal(); await active(firstId); await expect(title()).toHaveText(oneTitle.en);
    await expect(dots()).toHaveCount(2); expect(await banner().textContent()).not.toContain(twoTitle.en);
    await expect(next()).toBeFocused();
    const node = await page.locator('[data-home-banner-image]').elementHandle();
    await signal(); await fresh(); expect(await page.locator('[data-home-banner-image]').evaluate((value, old) => value === old, node)).toBe(true);
    await page.locator(`[data-home-banner-dot][data-id="${thirdId}"]`).click(); await active(thirdId);
    await edit(thirdId, { hidden: true }); await signal(); await active(firstId); await expect(banner()).toBeFocused();
    await edit(firstId, { hidden: true }); await signal(); await state('empty'); await expect(page.locator('[data-home-announcements] a')).toBeFocused();
  });

  await run('05 in-flight notification burst is coalesced into exactly one follow-up read', async () => {
    await seed(1); await newPage(); await open();
    const captured = await publicData(); const held = []; let calls = 0;
    await page.route('**/api/media-galleries?*', route => {
      if (!filtered(route.request().url())) return route.continue();
      calls++; if (calls === 1) { held.push(route); return; } return route.continue();
    });
    await refresh(); await expect.poll(() => held.length).toBe(1);
    await edit(firstId, { title: text('Update after snapshot read') });
    await page.evaluate(() => new Promise(resolve => {
      const receipt = new BroadcastChannel('ihear-media-galleries'); let received = 0;
      receipt.onmessage = () => { if (++received === 30) { receipt.close(); resolve(); } };
      const publisher = new BroadcastChannel('ihear-media-galleries'); for (let i = 0; i < 30; i++) publisher.postMessage('updated'); publisher.close();
    }));
    expect(calls).toBe(1);
    await held[0].fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(captured) });
    await expect(title()).toHaveText('Update after snapshot read'); await fresh();
    expect(calls).toBe(2); expect(await page.evaluate(() => window.__cp4.maximum)).toBe(1);
    results.coalescing = { signals: 30, reads: calls, maxInFlight: 1, mutationAfterFirstSnapshot: true };
  });

  await run('06 lower gallery versions cannot undo newer ready or confirmed empty', async () => {
    await seed(1); await newPage(); await open(); const original = await publicData();
    const newer = versioned(original, 1000); newer.items[0].items[0].title = text('Accepted version 1000');
    await synthetic(newer); await refresh(); await expect(title()).toHaveText('Accepted version 1000');
    await removeRoutes(); await synthetic(versioned(original, 999)); await refresh(); await expect(banner()).toHaveAttribute('data-refresh-state', 'stale');
    await expect(title()).toHaveText('Accepted version 1000'); await expect(banner()).toHaveAttribute('data-gallery-version', '1000');
    await removeRoutes(); await synthetic(versioned(original, 1001, [])); await refresh(); await state('empty');
    await removeRoutes(); await synthetic(versioned(original, 1000)); await refresh(); await expect(banner()).toHaveAttribute('data-refresh-state', 'stale'); await state('empty');
    await expect(banner()).toHaveAttribute('data-gallery-version', '1001'); expect(await banner().textContent()).not.toContain(oneTitle.en);
    results.versionGuard = { acceptedReady: 1000, rejectedReady: 999, acceptedEmpty: 1001, rejectedResurrection: 1000 };
  });

  await run('07 five-second body deadline aborts and permits retry; late body/finally cannot unlock newer request', async () => {
    await seed(1); await newPage(); await open();
    await page.evaluate(() => { window.__cp4.holdBody = true; });
    const started = Date.now(); await refresh(); await expect.poll(() => page.evaluate(() => window.__cp4.bodies.length)).toBe(1);
    await expect(banner()).toHaveAttribute('data-refresh-state', 'stale', { timeout: 7000 });
    const elapsed = Date.now() - started; expect(elapsed).toBeGreaterThanOrEqual(4700); expect(elapsed).toBeLessThan(6500);
    await expect(title()).toHaveText(oneTitle.en);
    expect(await page.evaluate(() => window.__cp4.bodies[0].record.aborted)).toBe(true);
    await edit(firstId, { title: text('Successful retry after body deadline') });
    await refresh(); await expect.poll(() => page.evaluate(() => window.__cp4.bodies.length)).toBe(2);
    const callsBefore = await page.evaluate(() => window.__cp4.calls.length);
    await page.evaluate(() => { const body = window.__cp4.bodies[0]; body.resolve(body.value); });
    await signal(); await pause(100); expect(await page.evaluate(() => window.__cp4.calls.length)).toBe(callsBefore);
    await page.evaluate(() => { window.__cp4.holdBody = false; const body = window.__cp4.bodies[1]; body.resolve(body.value); });
    await expect(title()).toHaveText('Successful retry after body deadline'); await fresh();
    expect(await page.evaluate(() => window.__cp4.calls.length)).toBe(callsBefore + 1);
    results.bodyDeadline = { elapsedMs: elapsed, abortSignalObserved: true, lateBodyIgnored: true, oldFinallyKeptNewLock: true, transportBoundary: 'Native HTTP response; test wrapper deliberately delays json() completion past abort.' };
  });

  await run('08 delayed old image decode cannot restore removed item or resurrect confirmed empty', async () => {
    await seed(); await newPage(); await open();
    await page.evaluate(() => { window.__cp4.holdDecode = true; });
    await next().click(); await expect.poll(() => page.evaluate(() => window.__cp4.decodes.length)).toBeGreaterThan(0);
    await mutate({ action: 'remove', itemId: secondId }); await signal(); await fresh();
    await active(firstId); expect(await banner().textContent()).not.toContain(twoTitle.en);
    await clear(); await signal(); await state('empty');
    await page.evaluate(() => { window.__cp4.holdDecode = false; window.__cp4.decodes.forEach(entry => entry.resolve()); });
    await pause(100); await state('empty'); await expect(banner()).toBeHidden();
    expect(await banner().textContent()).not.toMatch(/First learning story|Second learning story|Third learning story/);
    firstId = await add(text('Same item, replacement image versions')); await signal(); await active(firstId); await fresh();
    await expect(banner()).toHaveAttribute('data-image-state', 'ready');
    const decodeStart = await page.evaluate(() => { window.__cp4.holdDecode = true; return window.__cp4.decodes.length; });
    const replacePhoto = async () => {
      const item = (await gallery()).items.find(value => value.id === firstId);
      await mutate({ action: 'put', item, alt: item.image.alt }, true); await signal();
    };
    await replacePhoto(); await expect.poll(() => page.evaluate(() => window.__cp4.decodes.length)).toBe(decodeStart + 1); await fresh();
    const middleImage = (await publicData()).items[0].items[0].image;
    await replacePhoto(); await expect.poll(() => page.evaluate(() => window.__cp4.decodes.length)).toBe(decodeStart + 2); await fresh();
    const latestImage = (await publicData()).items[0].items[0].image;
    // Gallery uploads create new immutable operation-derived asset slots,
    // each at recordVersion 1. Compare the actual identity tuple, not a
    // fictional globally increasing image version across different assets.
    expect(latestImage.slot).not.toBe(middleImage.slot); expect(latestImage.src).not.toBe(middleImage.src);
    expect(latestImage.recordVersion).toBe(1); expect(middleImage.recordVersion).toBe(1);
    const latestSource = await page.locator('[data-home-banner-image]').getAttribute('src');
    await page.evaluate(index => { window.__cp4.holdDecode = false; window.__cp4.decodes[index + 1].resolve(); }, decodeStart);
    await expect(banner()).toHaveAttribute('data-image-state', 'ready');
    await page.evaluate(index => window.__cp4.decodes[index].reject(new Error('Late failure for previous image version')), decodeStart);
    await pause(50); await expect(banner()).toHaveAttribute('data-image-state', 'ready'); await active(firstId);
    await expect(page.locator('[data-home-banner-image]')).toHaveAttribute('src', latestSource);
    results.decodeRace = { removedBeforeDecodeResolved: true, emptyBeforeDecodeResolved: true, resurrected: false, sameItemImageVersions: { middle: { slot: middleImage.slot, src: middleImage.src, recordVersion: middleImage.recordVersion }, latest: { slot: latestImage.slot, src: latestImage.src, recordVersion: latestImage.recordVersion }, lateOldFailureIgnored: true } };
  });

  await run('09 malformed and failed refreshes retain last success; replacement image failure never shows removed content', async () => {
    await seed(1); await newPage(); await open(); const original = await publicData();
    const faults = [
      { status: 503, body: 'offline' }, { status: 200, body: '{invalid' },
      { status: 200, body: JSON.stringify({ items: [] }) },
      { status: 200, body: JSON.stringify({ items: [{ ...original.items[0], id: 'new-gallery' }] }) },
      { status: 200, body: JSON.stringify({ items: [{ ...original.items[0], version: undefined }] }) },
    ];
    for (const fault of faults) {
      await removeRoutes(); await page.route('**/api/media-galleries?*', route => filtered(route.request().url()) ? route.fulfill({ ...fault, contentType: 'application/json' }) : route.continue());
      await refresh(); await expect(banner()).toHaveAttribute('data-refresh-state', 'stale'); await active(firstId); await expect(title()).toHaveText(oneTitle.en);
    }
    await removeRoutes(); secondId = await add(twoTitle); thirdId = await add(threeTitle); await edit(firstId, { hidden: true });
    await page.route('**/api/site-media/*/image?*', route => route.abort());
    await signal(); await active(secondId); await expect(title()).toHaveText(twoTitle.en);
    await expect(page.locator('[data-home-banner-image-error]')).toBeVisible(); expect(await banner().textContent()).not.toContain(oneTitle.en);
    await expect(next()).toBeVisible(); await page.evaluate(() => window.iHearSetLanguage('zhTW'));
    results.imageFailureLayouts = [];
    for (const width of [390, 1024]) {
      await page.setViewportSize({ width, height: 1000 });
      const textRect = await page.locator('[data-home-banner-image-error]').evaluate(element => {
        const range = document.createRange(); range.selectNodeContents(element); const rect = range.getBoundingClientRect();
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, text: element.textContent };
      });
      const controls = await page.locator('.home-banner__controls').boundingBox();
      const overlap = textRect.x < controls.x + controls.width && textRect.x + textRect.width > controls.x && textRect.y < controls.y + controls.height && textRect.y + textRect.height > controls.y;
      results.imageFailureLayouts.push({ width, textRect, controls, overlap }); await screen(`replacement-image-failure-${width}.png`);
    }
    for (const value of results.imageFailureLayouts) expect(value.overlap, `localized image error text avoids controls at ${value.width}px`).toBe(false);
    await clear(); await signal(); await state('empty'); await removeRoutes();
    await page.route('**/api/media-galleries?*', route => filtered(route.request().url()) ? route.fulfill({ status: 503, body: 'offline' }) : route.continue());
    await refresh(); await expect(banner()).toHaveAttribute('data-refresh-state', 'stale'); await state('empty'); await expect(banner()).toBeHidden();
    results.invalidResponses = { cases: faults.length, failedReadyRetained: true, failedEmptyRetained: true, removedContentNotUsedForImageFallback: true };
  });

  await run('10 actual cross-tab media/content notifications and same-page bridge refresh file-store; resource notifications ignored', async () => {
    await seed(1); await newPage(); await open();
    const revisionBefore = await (await admin.request.get(`${origin}/api/live-revisions`)).json();
    const other = await visitors.newPage(); await other.goto(`${origin}/about`); await page.bringToFront();
    await edit(firstId, { title: text('Cross-tab media update') });
    await other.evaluate(() => { const channel = new BroadcastChannel('ihear-media-galleries'); channel.postMessage('updated'); channel.close(); });
    await expect(title()).toHaveText('Cross-tab media update');
    await edit(firstId, { title: text('Structured content update') });
    await other.evaluate(() => window.iHearLiveContent.announce('content', 'cp4-structured-revision'));
    await expect(title()).toHaveText('Structured content update');
    await edit(firstId, { title: text('Same-page content update') });
    await page.evaluate(() => window.iHearLiveContent.announce('content', 'cp4-same-page'));
    await expect(title()).toHaveText('Same-page content update');
    const before = await page.evaluate(() => window.__cp4.calls.length);
    await other.evaluate(() => { const channel = new BroadcastChannel('ihear-resources'); channel.postMessage('updated'); channel.close(); });
    await pause(200); expect(await page.evaluate(() => window.__cp4.calls.length)).toBe(before);
    const revisionAfter = await (await admin.request.get(`${origin}/api/live-revisions`)).json();
    expect(revisionAfter.revisions.content.revision).toBe(revisionBefore.revisions.content.revision);
    await other.close(); results.notifications = { mediaStringBroadcast: true, structuredContentBroadcast: true, samePageContentAnnounce: true, samePageMediaBroadcast: true, resourcesNotBannerRevision: true, fileStoreContentRevisionUnchanged: true };
  });

  await run('11 shared first baseline plus existing ten-second revision check and fifteen-second direct refresh remain distinct', async () => {
    await seed(); await newPage(); await page.clock.install();
    let checks = 0, revision = 'baseline-a';
    await page.route('**/api/live-revisions', route => { checks++; return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ version: 1, revisions: { content: { revision } } }) }); });
    await open(); await expect.poll(() => checks).toBe(1); await next().click(); await active(secondId);
    const initial = await page.evaluate(() => window.__cp4.calls.length); expect(initial).toBe(1);
    await edit(secondId, { title: text('Visible at shared revision tick') }); revision = 'baseline-b';
    await page.clock.runFor(10_050); await expect(title()).toHaveText('Visible at shared revision tick'); await fresh(); expect(checks).toBe(2);
    const afterShared = await page.evaluate(() => window.__cp4.calls.length); expect(afterShared).toBe(initial + 1);
    await edit(secondId, { title: text('Visible at direct fifteen-second tick') });
    await page.clock.runFor(5000); await expect(title()).toHaveText('Visible at direct fifteen-second tick'); await fresh();
    const afterDirect = await page.evaluate(() => window.__cp4.calls.length); expect(afterDirect).toBe(afterShared + 1); expect(checks).toBe(2); await active(secondId);
    results.polling = { scheduler: 'Playwright browser clock drives actual production timers; requests and store mutations remain real.', firstRevisionOnlyBaseline: true, initialCalibrationReads: initial, revisionReadsAt10Seconds: checks, directReadsAt15Seconds: afterDirect - afterShared, noAutomaticSlideChangeAcross15Seconds: true };
  });

  await run('12 visibility online focus and repeated lifecycle returns coalesce without duplicate listeners', async () => {
    await seed(1); await newPage(); await page.clock.install(); await open();
    await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange')); });
    const hiddenCalls = await page.evaluate(() => window.__cp4.calls.length);
    await page.clock.runFor(30_000); expect(await page.evaluate(() => window.__cp4.calls.length)).toBe(hiddenCalls);
    await edit(firstId, { title: text('Visible again after hidden pause') });
    await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => false }); document.dispatchEvent(new Event('visibilitychange')); });
    await expect(title()).toHaveText('Visible again after hidden pause'); await fresh();
    await edit(firstId, { title: text('Online event update') }); await page.evaluate(() => dispatchEvent(new Event('online'))); await expect(title()).toHaveText('Online event update');
    await edit(firstId, { title: text('Focus event update') }); await page.evaluate(() => dispatchEvent(new Event('focus'))); await expect(title()).toHaveText('Focus event update'); await fresh();
    const script = await page.locator('script[src*="/home-banner.js"]').getAttribute('src');
    await page.addScriptTag({ url: script });
    for (let i = 0; i < 3; i++) {
      await page.evaluate(() => dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
      await page.evaluate(() => dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }))); await fresh();
    }
    const before = await page.evaluate(() => window.__cp4.calls.length); await signal(); await fresh();
    expect(await page.evaluate(() => window.__cp4.calls.length)).toBe(before + 1);
    expect(await page.evaluate(() => window.__cp4.maximum)).toBe(1);
    results.lifecycleSimulation = { visibilityPropertyAndEventSimulated: true, pageTransitionEventsSimulated: true, repeatedReturns: 3, listenersDoNotMultiply: true, hiddenDirectTimerPaused: true };
  });

  await run('13 late data renders current language; long mixed slides keep responsive geometry and focus', async () => {
    await seed();
    await edit(thirdId, { title: text('Long English title '.repeat(6), '長標題'.repeat(40), '长标题'.repeat(40)), caption: text('A long caption that wraps safely. '.repeat(8), '完整保留所有說明文字。'.repeat(25), '完整保留所有说明文字。'.repeat(25)) });
    await newPage(); await open();
    const held = []; await page.route('**/api/media-galleries?*', route => { if (filtered(route.request().url())) { held.push(route); return; } return route.continue(); });
    await refresh(); await expect.poll(() => held.length).toBe(1);
    await next().focus(); await page.evaluate(() => window.iHearSetLanguage('zhTW')); await expect(next()).toBeFocused();
    await held[0].fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(await publicData()) });
    await fresh(); await expect(title()).toHaveText(oneTitle.zhHant); await expect(next()).toHaveAccessibleName(/下一/);
    await removeRoutes(); results.geometry = [];
    for (const width of [320, 390, 768, 1024, 1280]) {
      await page.setViewportSize({ width, height: 1000 });
      const sizes = [];
      for (const language of ['en', 'zhTW', 'zhCN']) {
        await page.evaluate(value => window.iHearSetLanguage(value), language);
        for (const id of [firstId, secondId, thirdId]) {
          await page.locator(`[data-home-banner-dot][data-id="${id}"]`).click(); await active(id);
          const box = await banner().boundingBox(); sizes.push({ language, id, height: box.height });
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
          const copy = await page.locator('.home-banner__copy').boundingBox(); const label = await title().boundingBox();
          expect(label.y + label.height).toBeLessThanOrEqual(copy.y + copy.height + 1);
        }
      }
      expect(Math.max(...sizes.map(value => value.height)) - Math.min(...sizes.map(value => value.height))).toBeLessThanOrEqual(1);
      results.geometry.push({ width, sizes }); await screen(`carousel-long-${width}.png`);
    }
    await page.route('**/api/media-galleries?*', route => filtered(route.request().url()) ? route.fulfill({ status: 503, body: 'isolated refresh failure' }) : route.continue());
    await refresh(); await expect(banner()).toHaveAttribute('data-refresh-state', 'stale');
    results.staleOverlay = [];
    for (const width of [320, 390, 768, 1024, 1280]) {
      await page.setViewportSize({ width, height: 1000 });
      const notice = await page.locator('.home-banner__refresh').boundingBox();
      const heading = await title().boundingBox();
      const intersects = (a, b) => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
      expect(intersects(notice, heading), `stale notice does not obscure long title at ${width}px`).toBe(false);
      for (const control of [previous(), next()]) expect(intersects(notice, await control.boundingBox()), `retry notice does not cover arrow at ${width}px`).toBe(false);
      results.staleOverlay.push({ width, notice, heading });
      if ([320, 1024].includes(width)) await screen(`stale-long-${width}.png`);
    }
  });

  await run('14 real navigation attempts BFCache restore and records persisted truthfully', async () => {
    await seed(1); await newPage(); await open();
    await edit(firstId, { title: text('Fresh before back navigation') }); await signal(); await expect(title()).toHaveText('Fresh before back navigation');
    await page.goto(`${origin}/about`); await edit(firstId, { title: text('Updated while homepage was away') }); await page.goBack({ waitUntil: 'domcontentloaded' });
    await expect(title()).toHaveText('Updated while homepage was away');
    const observations = await page.evaluate(() => ({ pageShows: window.__cp4.pageShows, navigation: performance.getEntriesByType('navigation').map(entry => ({ type: entry.type, notRestoredReasons: entry.notRestoredReasons?.toJSON?.() || null })) }));
    results.bfcache = { ...observations, actuallyHit: observations.pageShows.some(value => value.persisted), scope: 'A real away/back navigation was attempted. Only pageshow.persisted=true qualifies as actual BFCache restoration; synthetic case 12 is separate.' };
  });

  await run('15 initial SSR error retains native retry and recovers through the controller without page navigation', async () => {
    await seed(1); await newPage();
    const store = path.join(directory, 'media-galleries.json'); const original = await readFile(store, 'utf8');
    try {
      await writeFile(store, '{invalid isolated test data'); await page.goto(`${origin}/?cp4-retry=retained`);
      await state('error'); await expect(banner()).toHaveAttribute('data-refresh-state', 'stale');
      await expect(page.locator('[data-home-banner-retry]')).toHaveAttribute('href', '/?cp4-retry=retained');
      expect((await banner().boundingBox()).height).toBeGreaterThanOrEqual(420);
      await screen('initial-error-retry.png');
    } finally { await writeFile(store, original); }
    await page.evaluate(() => { window.__cp4SameDocument = true; });
    await page.locator('[data-home-banner-retry]').click(); await state('ready'); await active(firstId);
    expect(await page.evaluate(() => window.__cp4SameDocument)).toBe(true);
    results.retry = { initialErrorFromIsolatedStoreOnly: true, nativeHrefPreserved: true, manualRetryRecoveredWithoutNavigation: true };
  });

  await run('16 old page lifecycle body completion cannot restore earlier content or release resumed request', async () => {
    await seed(1); await newPage(); await open();
    await page.evaluate(() => { window.__cp4.holdBody = true; }); await refresh();
    await expect.poll(() => page.evaluate(() => window.__cp4.bodies.length)).toBe(1);
    await page.evaluate(() => dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
    expect(await page.evaluate(() => window.__cp4.bodies[0].record.aborted)).toBe(true);
    await edit(firstId, { title: text('Accepted after lifecycle return') });
    await page.evaluate(() => dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
    await expect.poll(() => page.evaluate(() => window.__cp4.bodies.length)).toBe(2);
    const calls = await page.evaluate(() => window.__cp4.calls.length);
    await page.evaluate(() => { const body = window.__cp4.bodies[0]; body.resolve(body.value); });
    await signal(); await pause(100); expect(await page.evaluate(() => window.__cp4.calls.length)).toBe(calls);
    await page.evaluate(() => { window.__cp4.holdBody = false; const body = window.__cp4.bodies[1]; body.resolve(body.value); });
    await expect(title()).toHaveText('Accepted after lifecycle return'); await fresh();
    expect(await page.evaluate(() => window.__cp4.calls.length)).toBe(calls + 1);
    results.lifecycleRace = { oldRequestAborted: true, lateCompletionIgnored: true, resumedLockPreserved: true, boundary: 'Synthetic pagehide/pageshow plus deliberately late real-response body completion.' };
  });

  expect((await readFile('.next/BUILD_ID', 'utf8')).trim()).toBe(results.buildId);
  results.status = 'passed'; results.summary = { passed: results.cases.length, failed: 0, skipped: 0, exitCode: 0 };
  console.log(`PASS ${results.cases.length}/${results.cases.length} CP4 production browser cases`);
} catch (error) {
  results.status = 'failed'; results.summary = { passed: results.cases.filter(value => value.status === 'passed').length, failed: 1, skipped: 0, exitCode: 1 };
  results.error = error.stack; console.error(error); process.exitCode = 1;
  try { if (page) await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }); } catch { /* browser may already be closed */ }
} finally {
  await save(); await writeFile(path.join(output, 'server.log'), logs);
  await visitors?.close(); await admin?.close(); await browser?.close(); child.kill();
}
