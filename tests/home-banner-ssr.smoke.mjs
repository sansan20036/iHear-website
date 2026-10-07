// Exercise the built Next server with real media APIs and a disposable local store.
// No database URLs, production mutations, build-time fixtures or application test hooks.
import { spawn } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';
import { encode } from 'next-auth/jwt';
import sharp from 'sharp';

const origin = 'http://localhost:3218';
const secret = 'cp3-isolated-browser-secret-never-use-in-production';
const evidenceRoot = path.resolve(process.env.IHEAR_CP3_EVIDENCE_DIR || 'output/playwright/cp3-home-focus');
await mkdir(evidenceRoot, { recursive: true });
const directory = await mkdtemp(path.join(evidenceRoot, 'isolated-store-'));
const storePath = path.join(directory, 'media-galleries.json');
const evidence = { origin, storeMode: 'file', isolatedDataDirectory: directory, cases: [], screenshots: [], layouts: [], status: 'running' };
evidence.buildId = (await readFile('.next/BUILD_ID', 'utf8')).trim();
const saveEvidence = () => writeFile(path.join(evidenceRoot, 'results.json'), JSON.stringify(evidence, null, 2));
const child = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '--hostname', 'localhost', '--port', '3218'], {
  env: { ...process.env, NODE_ENV: 'production', VERCEL: '', NETLIFY: '', CONTEXT: '', IHEAR_FORCE_FILE_STORE: '1', IHEAR_TEST_DATA_DIR: directory,
    DATABASE_URL: '', POSTGRES_URL: '', SUPABASE_URL: '', SUPABASE_SERVICE_ROLE_KEY: '', AUTH_SECRET: secret,
    AUTH_OWNER_EMAILS: 'cp3-test@example.com', AUTH_URL: origin, AUTH_TRUST_HOST: 'true' },
  windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
});
let logs = '', browser, context, page;
child.stdout.on('data', chunk => { logs += chunk; });
child.stderr.on('data', chunk => { logs += chunk; });
const text = (en = '', zhHant = '', zhHans = '') => ({ en, zhHant, zhHans });
const titles = text('Communities learning together', '一起學習的社群', '一起学习的社群');
const captions = text('A caption with its own purpose.', '照片有自己的說明。', '照片有自己的说明。');
const alt = text('Red, green and blue portrait', '紅綠藍直式照片', '红绿蓝直式照片');
const focus = target => (target || page).locator('[data-home-focus]');
const banner = target => (target || page).locator('[data-home-banner]');
const title = target => (target || page).locator('[data-home-banner-field="title"]');
const caption = target => (target || page).locator('[data-home-banner-field="caption"]');
const image = target => (target || page).locator('[data-home-banner-image]');
const hash = value => createHash('sha256').update(value).digest('hex');
let firstId, secondId, sourceBytes, storedImageBytes, firstImage;

async function runCase(name, fn) {
  const start = Date.now();
  try { await fn(); evidence.cases.push({ name, status: 'passed', milliseconds: Date.now() - start }); }
  catch (error) { evidence.cases.push({ name, status: 'failed', milliseconds: Date.now() - start, error: error.message }); throw error; }
  finally { await saveEvidence(); }
  console.log(`PASS ${name}`);
}
async function gallery() {
  const response = await context.request.get(`${origin}/api/media-galleries?admin=1`);
  expect(response.status()).toBe(200);
  return (await response.json()).items.find(item => item.id === 'home-banner');
}
async function mutation(body, multipart) {
  const current = await gallery();
  const payload = { operationId: randomUUID(), expectedVersion: current.version, ...body };
  const response = await context.request.post(`${origin}/api/media-galleries/home-banner`, {
    headers: { Origin: origin }, ...(multipart ? { multipart: { metadata: JSON.stringify(payload), file: { name: 'portrait.webp', mimeType: 'image/webp', buffer: sourceBytes } } } : { data: payload }),
  });
  expect(response.status(), await response.text()).toBe(200);
  return (await response.json()).item;
}
async function editItem(id, patch) {
  const item = (await gallery()).items.find(candidate => candidate.id === id);
  return mutation({ action: 'put', item: { ...item, ...patch } });
}
async function clearGallery() {
  for (const item of (await gallery()).items) await mutation({ action: 'remove', itemId: item.id });
}
async function addPhoto(titleValue, captionValue = captions) {
  const id = randomUUID();
  await mutation({ operationId: id, action: 'put', item: { id, kind: 'photo', hidden: false, title: titleValue, caption: captionValue }, alt }, true);
  return id;
}
async function homepage(headers = {}, search = '') {
  const response = await fetch(`${origin}/${search}`, { headers });
  const html = await response.text();
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('private, no-store, max-age=0');
  expect(response.headers.get('vercel-cdn-cache-control')).toBe('no-store');
  const matched = html.match(/<script\b[^>]*id="ihear-home-banner"[^>]*>([\s\S]*?)<\/script>/);
  expect(matched, 'public Banner snapshot is in initial HTML').not.toBeNull();
  const snapshot = JSON.parse(matched[1]);
  expect(snapshot.schemaVersion).toBe(1); expect(snapshot.galleryId).toBe('home-banner');
  return { response, html, snapshot };
}
async function snapshotFrom(target = page) { return JSON.parse(await target.locator('#ihear-home-banner').textContent()); }
async function screenshot(name, target = page, locator) {
  const file = path.join(evidenceRoot, name);
  await (locator || focus(target)).screenshot({ path: file });
  evidence.screenshots.push(file);
}
async function assertNoOverflow(target = page) {
  expect(await target.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no horizontal document overflow').toBe(true);
}
async function layout(state, width) {
  await page.setViewportSize({ width, height: 1000 });
  await page.goto(origin, { waitUntil: 'domcontentloaded' });
  await expect(focus()).toHaveAttribute('data-banner-state', state);
  await assertNoOverflow();
  const frame = await banner().boundingBox();
  const cards = await page.locator('[data-home-quick-cards]').boundingBox();
  const cardBoxes = await Promise.all(['announcements', 'calendar', 'tutors'].map(name => page.locator(`[data-home-${name}]`).boundingBox()));
  expect(cardBoxes.every(Boolean)).toBe(true);
  if (state === 'empty') {
    expect(frame).toBeNull();
    if (width >= 768) expect(Math.max(...cardBoxes.map(rect => rect.y)) - Math.min(...cardBoxes.map(rect => rect.y))).toBeLessThan(2);
    else expect(cardBoxes[1].y).toBeGreaterThan(cardBoxes[0].y + cardBoxes[0].height - 1);
  } else {
    expect(frame.width).toBeGreaterThan(0);
    if (width >= 1024) {
      expect(frame.height).toBeGreaterThanOrEqual(420);
      expect(cards.x - (frame.x + frame.width)).toBeCloseTo(24, 0);
      expect(frame.width / cards.width).toBeCloseTo(7 / 3, 2);
    } else expect(cards.y).toBeGreaterThanOrEqual(frame.y + frame.height - 1);
    if (state === 'ready' && width < 768) {
      const photo = await page.locator('.home-banner__image').boundingBox();
      const copy = await page.locator('.home-banner__copy').boundingBox();
      expect(photo.width / photo.height).toBeCloseTo(16 / 9, 2);
      expect(copy.y).toBeGreaterThanOrEqual(photo.y + photo.height - 1);
      expect(photo.height).toBeLessThan(420);
    }
  }
  evidence.layouts.push({ state, width, frame, cards, cardBoxes });
  await screenshot(`${state}-${width}.png`);
}

try {
  let ready = false;
  for (let i = 0; i < 120; i++) {
    if (child.exitCode !== null) throw new Error(`Test server exited: ${logs.slice(-2000)}`);
    try { if ((await fetch(`${origin}/api/media-galleries`)).ok) { ready = true; break; } } catch { /* process starting */ }
    await new Promise(resolve => { setTimeout(resolve, 500); });
  }
  if (!ready) throw new Error(`Isolated built server did not start: ${logs.slice(-2000)}`);
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({ viewport: { width: 1280, height: 1000 }, locale: 'en-US' });
  const token = await encode({ secret, salt: 'authjs.session-token', token: { name: 'CP3 test', email: 'cp3-test@example.com', sub: 'cp3-test' } });
  await context.addCookies([{ name: 'authjs.session-token', value: token, url: origin, httpOnly: true, sameSite: 'Lax' }]);
  const visitors = await browser.newContext({ viewport: { width: 1280, height: 1000 }, locale: 'en-US' });
  page = await visitors.newPage(); page.setDefaultTimeout(15_000);
  evidence.browser = browser.version();
  sourceBytes = await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="600" height="1000"><rect width="600" height="200" fill="#e02020"/><rect y="200" width="600" height="600" fill="#20c050"/><rect y="800" width="600" height="200" fill="#2050df"/></svg>')).webp().toBuffer();
  await writeFile(path.join(evidenceRoot, 'original-portrait.webp'), sourceBytes);

  await runCase('01 empty SSR expands named cards with no false empty messages or Banner preload', async () => {
    await clearGallery();
    const result = await homepage();
    expect(result.snapshot.state).toBe('empty'); expect(result.snapshot.items).toEqual([]);
    await page.goto(origin);
    await expect(focus()).toHaveAttribute('data-banner-state', 'empty');
    await expect(banner()).toBeHidden();
    await expect(page.locator('[data-home-announcements], [data-home-calendar], [data-home-tutors]')).toHaveCount(3);
      // CP5 resolves card data after SSR. The server response must still start
      // with loading placeholders, never a fabricated successful empty state.
      expect(result.html).toMatch(/data-home-announcements[^>]*data-home-card-state="loading"/);
      expect(result.html).toMatch(/data-home-calendar[^>]*data-home-card-state="loading"/);
    expect(await page.locator('link[rel="preload"][as="image"]').count()).toBe(0);
    await writeFile(path.join(evidenceRoot, 'empty-initial.html'), result.html);
  });

  await runCase('02 real photo upload appears on next request with matching SSR snapshot and immutable image', async () => {
    firstId = await addPhoto(titles);
    const result = await homepage();
    expect(result.snapshot.state).toBe('ready'); expect(result.snapshot.items.map(item => item.id)).toEqual([firstId]);
    expect(result.snapshot.version).toBe((await gallery()).version);
    await page.goto(origin);
    await expect(title()).toHaveText(titles.en); await expect(caption()).toHaveText(captions.en);
    await expect(image()).toHaveAttribute('alt', alt.en);
    await expect(image()).toHaveAttribute('loading', 'eager'); await expect(image()).toHaveAttribute('fetchpriority', 'high');
    expect(Number(await image().getAttribute('width'))).toBeGreaterThan(0);
    expect(Number(await image().getAttribute('height'))).toBeGreaterThan(0);
    expect(await image().evaluate(element => ({ fit: getComputedStyle(element).objectFit, position: getComputedStyle(element).objectPosition }))).toEqual({ fit: 'cover', position: '50% 50%' });
    firstImage = result.snapshot.items[0].image;
    expect(await image().getAttribute('src')).toBe(firstImage.src);
    const preloads = page.locator('link[rel="preload"][as="image"]');
    await expect(preloads).toHaveCount(1); await expect(preloads).toHaveAttribute('href', firstImage.src);
    const response = await fetch(`${origin}${firstImage.src}`);
    expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toMatch(/max-age=31536000.*immutable/);
    storedImageBytes = Buffer.from(await response.arrayBuffer());
    const metadata = await sharp(storedImageBytes).metadata(); expect(metadata.width / metadata.height).toBeCloseTo(0.6, 2);
    evidence.image = { src: firstImage.src, width: metadata.width, height: metadata.height, sha256: hash(storedImageBytes), cacheControl: response.headers.get('cache-control') };
    // Exercise the legacy client bootstrap with a valid custom hero: the normal
    // empty local media API would not expose a competing high-priority preload.
    let legacyLookups = 0;
    await page.route('**/api/site-media', route => {
      legacyLookups++;
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ version: 1, items: { 'home.hero': { ...firstImage, slot: 'home.hero' } } }) });
    });
    try {
      await page.reload();
      await page.evaluate(() => window.iHearInitialSiteMedia);
      expect(legacyLookups).toBeGreaterThan(0);
      await expect(page.locator('link[rel="preload"][as="image"][fetchpriority="high"]')).toHaveCount(1);
      expect(await snapshotFrom()).toEqual(result.snapshot); await expect(title()).toHaveText(titles.en);
      evidence.firstImagePriority = { legacyLookups, highPriorityImagePreloads: 1, testBoundary: 'Only client /api/site-media response contains custom home.hero; SSR gallery and uploaded bytes remain real.' };
    } finally { await page.unroute('**/api/site-media'); }
    await writeFile(path.join(evidenceRoot, 'ready-initial.html'), result.html);
  });

  await runCase('03 multi-photo ordering, title updates, hidden filtering and all-hidden empty apply without rebuild', async () => {
    secondId = await addPhoto(text('Second public photo', '第二張照片', '第二张照片'));
    expect((await homepage()).snapshot.items.map(item => item.id)).toEqual([firstId, secondId]);
    await mutation({ action: 'move', itemId: secondId, direction: -1 });
    expect((await homepage()).snapshot.items.map(item => item.id)).toEqual([secondId, firstId]);
    await editItem(secondId, { title: text('Updated after build') });
    await page.goto(origin); await expect(title()).toHaveText('Updated after build');
    await expect(image()).toHaveCount(1);
    await expect(page.locator('link[rel="preload"][as="image"]')).toHaveCount(1);
    expect((await snapshotFrom()).items).toHaveLength(2);
    await editItem(secondId, { hidden: true, title: text('HIDDEN_CP3_SECRET_TITLE'), caption: text('HIDDEN_CP3_SECRET_CAPTION') });
    let result = await homepage(); expect(result.snapshot.items.map(item => item.id)).toEqual([firstId]);
    for (const secretText of ['HIDDEN_CP3_SECRET_TITLE', 'HIDDEN_CP3_SECRET_CAPTION', secondId]) expect(result.html).not.toContain(secretText);
    for (const key of ['updatedBy', 'operations', 'fingerprint', 'altStates', 'storagePath', 'cp3-test@example.com']) expect(JSON.stringify(result.snapshot)).not.toContain(key);
    await page.goto(origin); await expect(title()).toHaveText(titles.en);
    const publicResponse = await fetch(`${origin}/api/media-galleries?gallery=home-banner`);
    expect(publicResponse.headers.get('cache-control')).toBe('private, no-store, max-age=0');
    expect(publicResponse.headers.get('vercel-cdn-cache-control')).toBe('no-store');
    expect((await publicResponse.json()).items[0].items.map(item => item.id)).toEqual([firstId]);
    await editItem(firstId, { hidden: true }); result = await homepage();
    expect(result.snapshot.state).toBe('empty'); expect(result.snapshot.items).toEqual([]);
    expect(result.html).not.toContain(firstImage.src);
    await editItem(firstId, { hidden: false });
    evidence.noRebuild = { serverStartedBeforeMutations: true, latestVersion: (await gallery()).version, hiddenAbsentFromHtmlSnapshotAndPreload: true };
  });

  await runCase('04 no-JavaScript server language, English fallback and empty titles remain accurate', async () => {
    for (const [cookie, locale, header] of [['en', 'en', 'zh-CN'], ['zhTW', 'zhHant', 'en-US'], ['zhCN', 'zhHans', 'en-US']]) {
      const noJs = await browser.newContext({ javaScriptEnabled: false, extraHTTPHeaders: { 'Accept-Language': header }, viewport: { width: 390, height: 900 } });
      await noJs.addCookies([{ name: 'ihear-lang', value: cookie, url: origin }]);
      const target = await noJs.newPage(); await target.goto(origin);
      await expect(title(target)).toHaveText(titles[locale]); await expect(caption(target)).toHaveText(captions[locale]);
      await expect(image(target)).toHaveAttribute('alt', alt[locale]);
      await expect(image(target)).toBeVisible(); await screenshot(`no-js-${locale}-390.png`, target);
      await noJs.close();
    }
    const response = await homepage({ 'Accept-Language': 'zh-Hant-TW,en;q=0.8' }); expect(response.html).toContain(titles.zhHant);
    await editItem(firstId, { title: text('English display fallback'), caption: text('English caption fallback') });
    const noJs = await browser.newContext({ javaScriptEnabled: false, locale: 'zh-TW' }); const target = await noJs.newPage();
    await target.goto(origin); await expect(title(target)).toHaveText('English display fallback'); await expect(caption(target)).toHaveText('English caption fallback');
    expect((await gallery()).items.find(item => item.id === firstId).title).toEqual(text('English display fallback'));
    await editItem(firstId, { title: text(), caption: captions }); await target.reload();
    expect(await title(target).innerText()).toBe(''); await expect(title(target)).toBeHidden();
    await noJs.close(); await editItem(firstId, { title: titles });
  });

  await runCase('05 saved browser locale paints dynamic title caption and alt before DOMContentLoaded', async () => {
    const saved = await browser.newContext({ locale: 'en-US', viewport: { width: 390, height: 900 } });
    await saved.addCookies([{ name: 'ihear-lang', value: 'en', url: origin }]);
    await saved.addInitScript(() => {
      localStorage.setItem('ihear-lang', 'zhTW'); window.cp3DOMContentLoaded = false;
      document.addEventListener('DOMContentLoaded', () => { window.cp3DOMContentLoaded = true; });
      function firstBannerFrame() {
        const title = document.querySelector('[data-home-banner-field="title"]');
        if (title) window.cp3FirstBannerFrame = { title: title.textContent, lang: document.documentElement.lang, readyState: document.readyState, domContentLoaded: window.cp3DOMContentLoaded };
        else requestAnimationFrame(firstBannerFrame);
      }
      requestAnimationFrame(firstBannerFrame);
    });
    let release; const held = new Promise(resolve => { release = resolve; });
    await saved.route('**/assets/site.js?*', async route => { await held; await route.continue(); });
    const target = await saved.newPage();
    try {
      await target.goto(origin, { waitUntil: 'commit' });
      await expect(title(target)).toHaveText(titles.zhHant);
      await expect(caption(target)).toHaveText(captions.zhHant); await expect(image(target)).toHaveAttribute('alt', alt.zhHant);
      expect(await target.evaluate(() => window.cp3DOMContentLoaded)).toBe(false);
      evidence.beforeDOMContentLoaded = { title: await title(target).innerText(), caption: await caption(target).innerText(), alt: await image(target).getAttribute('alt'), eventFired: false };
      await expect.poll(() => target.evaluate(() => window.cp3FirstBannerFrame?.title)).toBe(titles.zhHant);
      evidence.firstBannerAnimationFrame = await target.evaluate(() => window.cp3FirstBannerFrame);
      expect(evidence.firstBannerAnimationFrame.lang).toBe('zh-Hant'); expect(evidence.firstBannerAnimationFrame.domContentLoaded).toBe(false);
      await expect(target.locator('#navLinks')).toBeHidden();
      evidence.beforeDOMContentLoaded.unobscured = await title(target).evaluate(element => {
        const box = element.getBoundingClientRect();
        return !!document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)?.closest('[data-home-banner]');
      });
      expect(evidence.beforeDOMContentLoaded.unobscured).toBe(true);
      await screenshot('bootstrap-before-domcontentloaded-390.png', target);
    } finally { release(); await target.waitForLoadState('domcontentloaded').catch(() => undefined); await saved.close(); }
  });

  await runCase('06 HTML script-like text and JSON separators remain text with parseable snapshot and no CSP violation', async () => {
    const special = '</script><script>window.CP3_INJECTED=1</script> & " < > \u2028 middle \u2029 end';
    await editItem(firstId, { title: text(special), caption: text('Caption <img src=x onerror="window.CP3_INJECTED=2"> & "quoted"') });
    const result = await homepage(); expect(result.snapshot.items[0].title.en).toBe(special);
    const deployment = JSON.parse(await readFile('vercel.json', 'utf8'));
    const configuredPolicy = deployment.headers.find(rule => rule.source === '/(.*)').headers.find(header => header.key === 'Content-Security-Policy').value;
    evidence.csp = { localResponseHeader: result.response.headers.get('content-security-policy'), browserPolicySource: 'Exact existing vercel.json header added to the local document response by Playwright; no policy relaxation.', policy: configuredPolicy };
    const safe = await browser.newContext({ locale: 'en-US' });
    await safe.route(`${origin}/`, async route => {
      const response = await route.fetch();
      await route.fulfill({ response, headers: { ...response.headers(), 'content-security-policy': configuredPolicy } });
    });
    await safe.addInitScript(() => { window.cp3Csp = []; document.addEventListener('securitypolicyviolation', event => { window.cp3Csp.push({ directive: event.effectiveDirective, uri: event.blockedURI }); }); });
    const target = await safe.newPage(); await target.goto(origin);
    await expect(title(target)).toHaveText(special);
    expect(await title(target).locator('script,img').count()).toBe(0);
    expect(await target.evaluate(() => window.CP3_INJECTED)).toBeUndefined();
    expect(await snapshotFrom(target)).toEqual(result.snapshot);
    evidence.cspViolations = await target.evaluate(() => window.cp3Csp); expect(evidence.cspViolations).toEqual([]);
    await screenshot('special-characters.png', target); await safe.close();
    await editItem(firstId, { title: text('A long homepage banner title remains fully readable when its text wraps over several lines on a narrow phone screen.'), caption: captions });
  });

  await runCase('07 ready layout covers phones, tablets, desktop and both breakpoint boundaries', async () => {
    for (const width of [320, 390, 767, 768, 1023, 1024, 1280, 1440]) await layout('ready', width);
    // CP4 enhances the same SSR with hidden controls for a single public photo.
    // They must not expose an inactive action or appear in the initial HTML.
    await expect(banner().locator('button:visible')).toHaveCount(0);
    expect((await homepage()).html).not.toContain('data-home-banner-previous');
    const variedTitles = text('Short', '不同語言的長標題應維持文字區預留的高度，切換語言後下方內容不會突然上下移動。'.repeat(4).slice(0, 120), '简短标题');
    const variedCaptions = text('Short caption', '最長照片說明仍應完整顯示，保留所有文字並避免超出容器。'.repeat(20).slice(0, 300), '简短说明');
    await editItem(firstId, { title: variedTitles, caption: variedCaptions });
    evidence.languageGeometry = [];
    for (const width of [320, 390, 768, 1024]) {
      await page.setViewportSize({ width, height: 1000 }); await page.goto(origin);
      const before = await banner().boundingBox();
      const copyBefore = await page.locator('.home-banner__copy').boundingBox();
      for (const locale of ['zhHant', 'zhHans', 'en']) {
        // Use the same existing setter as the language buttons, including its
        // cookie/localStorage update and shared localized-content event.
        await page.evaluate(value => window.iHearSetLanguage({ en: 'en', zhHant: 'zhTW', zhHans: 'zhCN' }[value]), locale);
        await expect(title()).toHaveText(variedTitles[locale]);
        await expect(caption()).toHaveText(variedCaptions[locale]);
        const after = await banner().boundingBox();
        const copyAfter = await page.locator('.home-banner__copy').boundingBox();
        if (width < 768) {
          const photoBox = await page.locator('.home-banner__image').boundingBox();
          const titleBox = await title().boundingBox();
          expect(titleBox.y, 'mobile text starts directly below the image, with reserved space after it').toBeCloseTo(photoBox.y + photoBox.height + 16, 0);
        }
        evidence.languageGeometry.push({ width, locale, beforeBannerHeight: before.height, bannerHeight: after.height, beforeCopyHeight: copyBefore.height, copyHeight: copyAfter.height });
        for (const locator of [title(), caption()]) {
          const contentBox = await locator.boundingBox();
          expect(contentBox.y).toBeGreaterThanOrEqual(after.y - 1);
          expect(contentBox.y + contentBox.height, 'all visible text remains inside the Banner').toBeLessThanOrEqual(after.y + after.height + 1);
          expect(contentBox.x).toBeGreaterThanOrEqual(after.x - 1);
          expect(contentBox.x + contentBox.width).toBeLessThanOrEqual(after.x + after.width + 1);
        }
        const reserveBox = await page.locator('.home-banner__reserve').evaluate(element => {
          const rect = element.getBoundingClientRect(); return { x: rect.x, y: rect.y, right: rect.right, bottom: rect.bottom };
        });
        expect(reserveBox.x).toBeGreaterThanOrEqual(after.x - 1); expect(reserveBox.y).toBeGreaterThanOrEqual(after.y - 1);
        expect(reserveBox.right).toBeLessThanOrEqual(after.x + after.width + 1); expect(reserveBox.bottom).toBeLessThanOrEqual(after.y + after.height + 1);
        expect(after.height).toBeCloseTo(before.height, 0);
        expect(copyAfter.height).toBeCloseTo(copyBefore.height, 0);
        await assertNoOverflow();
        if (locale === 'zhHant' && [320, 1024].includes(width)) await screenshot(`longest-caption-${width}.png`);
      }
    }
    await editItem(firstId, { title: text('A long homepage banner title remains fully readable when its text wraps over several lines on a narrow phone screen.'), caption: captions });
  });

  await runCase('08 failed image retains Banner dimensions and readable alternative', async () => {
    await page.setViewportSize({ width: 390, height: 1000 });
    let release; const held = new Promise(resolve => { release = resolve; });
    await page.route('**/api/site-media/**/image?*', async route => { await held; await route.continue(); });
    try {
      await page.goto(origin, { waitUntil: 'domcontentloaded' });
      const pending = await page.locator('.home-banner__image').boundingBox();
      expect(await image().evaluate(element => element.complete)).toBe(false);
      release();
      await expect.poll(() => image().evaluate(element => element.complete && element.naturalWidth > 0)).toBe(true);
      const loaded = await page.locator('.home-banner__image').boundingBox();
      expect(loaded.height).toBeCloseTo(pending.height, 0); expect(loaded.width).toBeCloseTo(pending.width, 0);
      evidence.imageGeometry = { pending, loaded };
    } finally { release(); await page.unroute('**/api/site-media/**/image?*'); }
    const before = await page.locator('.home-banner__image').boundingBox();
    await page.route('**/api/site-media/**/image?*', route => route.abort('failed'));
    await page.reload();
    await expect.poll(() => image().evaluate(element => element.complete && element.naturalWidth === 0)).toBe(true);
    const after = await page.locator('.home-banner__image').boundingBox();
    expect(after.width).toBeCloseTo(before.width, 0); expect(after.height).toBeCloseTo(before.height, 0);
    expect((await image().getAttribute('alt')).length).toBeGreaterThan(0);
    await expect(page.locator('[data-home-banner-image-error]')).toBeVisible();
    await expect(title()).toBeVisible(); await screenshot('image-error-390.png');
    await page.unroute('**/api/site-media/**/image?*');
    const noJs = await browser.newContext({ javaScriptEnabled: false, locale: 'zh-TW', viewport: { width: 390, height: 1000 } });
    await noJs.route('**/api/site-media/**/image?*', route => route.abort('failed'));
    const target = await noJs.newPage();
    for (const width of [390, 1024]) {
      await target.setViewportSize({ width, height: 1000 }); await target.goto(origin);
      await expect(image(target)).toHaveAttribute('alt', alt.zhHant);
      expect(await image(target).evaluate(element => element.complete && element.naturalWidth === 0)).toBe(true);
      await expect(caption(target)).toHaveText(captions.zhHant);
      await screenshot(`image-error-no-js-${width}.png`, target);
    }
    await noJs.close();
  });

  await runCase('09 malformed isolated Banner store yields local error with no-JS retry and preserved page', async () => {
    const original = await readFile(storePath, 'utf8');
    try {
      await writeFile(storePath, '{invalid cp3 isolated test json', 'utf8');
      const result = await homepage({ Cookie: 'ihear-lang=zhTW' }, '?campaign=CP3&language=zhTW');
      expect(result.snapshot.state).toBe('error'); expect(result.snapshot.items).toEqual([]);
      await writeFile(path.join(evidenceRoot, 'error-initial.html'), result.html);
      const noJs = await browser.newContext({ javaScriptEnabled: false, locale: 'zh-TW', viewport: { width: 1024, height: 1000 } });
      await noJs.addCookies([{ name: 'ihear-lang', value: 'zhTW', url: origin }]);
      const target = await noJs.newPage(); await target.goto(`${origin}/?campaign=CP3&language=zhTW`);
      await expect(focus(target)).toHaveAttribute('data-banner-state', 'error');
      await expect(target.locator('main h1')).toBeVisible();
      const retry = target.locator('[data-home-banner-retry]'); await expect(retry).toBeVisible();
      expect(new URL(await retry.getAttribute('href'), origin).search).toBe('?campaign=CP3&language=zhTW');
      await screenshot('error-no-js-1024.png', target);
      await writeFile(storePath, original, 'utf8');
      await retry.click(); await expect(focus(target)).toHaveAttribute('data-banner-state', 'ready');
      await expect(caption(target)).toHaveText(captions.zhHant); await noJs.close();
      await writeFile(storePath, '{invalid cp3 isolated test json', 'utf8');
      for (const width of [320, 768, 1024, 1280]) await layout('error', width);
    } finally { await writeFile(storePath, original, 'utf8'); }
  });

  await runCase('10 shared controllers preserve SSR; Resources stays outside homepage loading dependency', async () => {
    const resourcePath = path.join(directory, 'resource-links.json');
    const originalResources = await readFile(resourcePath, 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    try {
      await writeFile(resourcePath, '{invalid isolated resources json');
      const resourceStatus = (await fetch(`${origin}/api/resources`)).status;
      expect(resourceStatus).toBe(400); // Existing Resource API maps SyntaxError to 400.
      const independentHome = await homepage(); expect(independentHome.snapshot.state).toBe('ready');
      evidence.resourceFailureIsolation = { actualResourceApiStatus: resourceStatus, homepageStatus: independentHome.response.status, bannerState: independentHome.snapshot.state };
    } finally { if (originalResources === null) await unlink(resourcePath); else await writeFile(resourcePath, originalResources); }
    let resourceRequests = 0;
    await page.route('**/api/resources', route => { resourceRequests++; return route.abort('timedout'); });
    await page.goto(origin); await expect(focus()).toHaveAttribute('data-banner-state', 'ready');
      await expect(page.locator('[data-home-announcements]')).toHaveAttribute('data-home-card-state', 'error');
      expect(resourceRequests).toBe(1); // CP5 owns one full snapshot, independent of Banner.
      const initialResourcesReads = resourceRequests;
    const before = await snapshotFrom();
    await banner().evaluate(element => { element.cp3OriginalNode = true; });
    await page.addScriptTag({ url: '/assets/resources.js' });
    expect(await banner().evaluate(element => element.cp3OriginalNode)).toBe(true);
      expect(await snapshotFrom()).toEqual(before); expect(resourceRequests).toBe(initialResourcesReads);
    await expect(page.locator('[data-media-gallery="tutoring"] .gallery-frame img')).toBeVisible();
    await expect(banner().locator('.gallery-frame,.gallery-controls')).toHaveCount(0);
    await page.unroute('**/api/resources');
    await page.goto(`${origin}/resources`);
    await expect(page.locator('[data-resource-topics] [data-resource-topic]').first()).toBeVisible();
    await page.goto(`${origin}/programs`);
    await expect(page.locator('[data-media-gallery="tutoring"] .gallery-frame img')).toBeVisible();
    evidence.controllerIsolation = { sameBannerNode: true, resourceRequestsOnHome: resourceRequests, resourcesPageAndLegacyGalleryRendered: true };
  });

  await runCase('11 homepage and admin central crops match desktop simulation and mobile ratio without changing source', async () => {
    const adminPage = await context.newPage();
    await adminPage.goto(`${origin}/admin/media?gallery=home-banner`);
    await expect(adminPage.locator('.admin-gallery-toolbar select')).toHaveValue('home-banner');
    await expect(adminPage.locator('.admin-gallery-toolbar select')).toBeEnabled();
    const preview = adminPage.locator('.admin-media-item').filter({ hasText: 'A long homepage banner title' }).locator('.admin-banner-preview');
    // Select by public item title, regardless of the earlier hidden item's position.
    await expect(preview).toHaveCount(1);
    const viewport = adminPage.getByLabel('Banner preview viewport', { exact: true });
    for (const [mode, width] of [['mobile', 390], ['desktop', 1024]]) {
      await viewport.selectOption(mode);
      const adminImage = preview.locator('.admin-banner-preview-image');
      const adminBox = await adminImage.boundingBox();
      await screenshot(`admin-crop-${mode}.png`, adminPage, preview);
      const visitor = await browser.newContext({ viewport: { width, height: 1000 }, locale: 'en-US' }); const target = await visitor.newPage();
      await target.goto(origin); await expect(image(target)).toBeVisible();
      const homeImage = target.locator('.home-banner__image'); const homeBox = await homeImage.boundingBox();
      expect(adminBox.width / adminBox.height).toBeCloseTo(homeBox.width / homeBox.height, 2);
      await screenshot(`homepage-crop-${mode}.png`, target, homeImage);
      evidence[`crop${mode}`] = { admin: adminBox, homepage: homeBox, simulatedViewport: width, objectFit: 'cover', objectPosition: '50% 50%' };
      for (const locator of [adminImage.locator('img'), image(target)]) {
        const pixels = await sharp(await locator.screenshot()).raw().toBuffer({ resolveWithObject: true });
        const offset = (Math.floor(pixels.info.height / 2) * pixels.info.width + Math.floor(pixels.info.width / 2)) * pixels.info.channels;
        const [red, green, blue] = pixels.data.subarray(offset, offset + 3); expect(green).toBeGreaterThan(red * 1.5); expect(green).toBeGreaterThan(blue * 1.5);
      }
      await visitor.close();
    }
    expect(hash(Buffer.from(await (await fetch(`${origin}${firstImage.src}`)).arrayBuffer()))).toBe(hash(storedImageBytes));
    await adminPage.close();
  });

  await runCase('12 clearing persists empty across requests and all responsive layouts with no automatic seed', async () => {
    await clearGallery();
    for (const width of [320, 390, 767, 768, 1023, 1024, 1280, 1440]) await layout('empty', width);
    expect((await homepage()).snapshot.items).toEqual([]);
    expect(JSON.parse(await readFile(storePath, 'utf8')).galleries['home-banner'].items).toEqual([]);
    evidence.finalBanner = await gallery();
    expect((await readFile('.next/BUILD_ID', 'utf8')).trim()).toBe(evidence.buildId);
  });
  evidence.status = 'passed'; evidence.summary = { passed: evidence.cases.length, failed: 0, skipped: 0, exitCode: 0 };
  console.log(`CP3 home focus smoke: ${evidence.cases.length} passed, 0 failed, 0 skipped. Evidence: ${evidenceRoot}`);
} catch (error) {
  evidence.status = 'failed'; evidence.summary = { passed: evidence.cases.filter(item => item.status === 'passed').length, failed: 1, skipped: 0, exitCode: 1 };
  if (page) {
    await writeFile(path.join(evidenceRoot, 'failure-page.txt'), await page.locator('body').innerText()).catch(() => undefined);
    await page.screenshot({ path: path.join(evidenceRoot, 'failure.png'), fullPage: true }).catch(() => undefined);
    await page.screenshot({ path: path.join(evidenceRoot, 'failure-viewport.png') }).catch(() => undefined);
    await focus().screenshot({ path: path.join(evidenceRoot, 'failure-focus.png') }).catch(() => undefined);
  }
  console.error(logs.slice(-4000)); throw error;
} finally {
  await saveEvidence(); await writeFile(path.join(evidenceRoot, 'server.log'), logs);
  await browser?.close(); child.kill();
}
