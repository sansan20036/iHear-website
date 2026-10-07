// Bounded CP7 merge acceptance: Academy's standalone routes and the existing
// CMS homepage share a production build, but keep their distinct locale models.
// All store writes stay in an OS-temp fixture; no remote requests are forwarded.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium, expect as baseExpect } from '@playwright/test';
import { initialGallery } from '../lib/media-gallery-types.ts';
import { initialResourceTopics, validateResourceDocument } from '../lib/resource-topic-model.ts';
import { RESOURCE_SEEDS } from '../lib/resource-seed.ts';

const expect = baseExpect.configure({ timeout: 12000 });
const origin = 'http://localhost:3228';
const output = path.resolve('output/cp7-academy-home');
const pictures = path.resolve('output/playwright/cp7-academy-home');
await mkdir(output, { recursive: true }); await mkdir(pictures, { recursive: true });
const directory = await mkdtemp(path.join(os.tmpdir(), 'ihear-academy-home-'));
const l = (en, zhHant = '', zhHans = '') => ({ en, zhHant, zhHans });
const hiddenText = 'CP7_HIDDEN_SENTINEL', privateText = 'CP7_PRIVATE_OPERATION_SENTINEL';
const firstId = 'cp7-public-first', secondId = 'cp7-public-second';
const gallery = { ...initialGallery('home-banner'), version: 7, updatedAt: '2026-10-08T00:00:00.000Z', updatedBy: privateText,
  items: [
    { id: firstId, kind: 'photo', assetSlot: 'home.hero', hidden: false, title: l('Merged homepage first photo', '整合首頁第一張照片', '整合首页第一张照片'), caption: l('Current public photo caption.', '目前公開照片說明。', '目前公开照片说明。') },
    { id: 'cp7-hidden', kind: 'photo', assetSlot: 'home.hero', hidden: true, title: l(hiddenText), caption: l(hiddenText) },
    { id: secondId, kind: 'photo', assetSlot: 'home.hero', hidden: false, title: l('Merged homepage second photo', '整合首頁第二張照片', '整合首页第二张照片'), caption: l('Another public photo caption.', '另一張公開照片說明。', '另一张公开照片说明。') },
  ] };
await writeFile(path.join(directory, 'media-galleries.json'), JSON.stringify({ galleries: { 'home-banner': gallery }, assets: {}, operations: {
  '718c3f93-d732-4bc4-a37d-6caa27b11a37': { galleryId: 'home-banner', actor: privateText, fingerprint: privateText },
} }));
const meta = { version: 1, createdAt: '2026-10-08T00:00:00.000Z', updatedAt: '2026-10-08T00:00:00.000Z', createdBy: 'isolated-fixture', updatedBy: 'isolated-fixture', states: [] };
const resourceDocument = { schemaVersion: 2, legacyGuidesMigrated: false,
  topics: initialResourceTopics().map(topic => ['announcements', 'calendar'].includes(topic.slug) ? { ...topic, status: 'published' } : topic),
  items: [...RESOURCE_SEEDS.map(item => ({ ...meta, ...item, topicId: 'forms', type: 'external_link' })), ...['announcements', 'calendar'].map((topicId, index) => ({ ...meta, id: `cp7-resource-${index}`, topicId, type: 'text', category: 'article', status: 'published', sortOrder: 10,
    title: l(index ? 'Calendar fixture' : 'Announcement fixture', index ? '日曆測試資料' : '公告測試資料', index ? '日历测试资料' : '公告测试资料'), description: l('A public summary.', '公開摘要。', '公开摘要。'), url: '' }))] };
validateResourceDocument(resourceDocument); await writeFile(path.join(directory, 'resource-links.json'), JSON.stringify(resourceDocument));
const catalog = JSON.parse(await readFile('data/content-slots.json', 'utf8'));
const slot = (key, locale) => catalog.slots.find(value => value.page === '/academy' && value.key === key)?.values[locale];
const evidence = { startedAt: new Date().toISOString(), buildId: (await readFile('.next/BUILD_ID', 'utf8')).trim(), origin, storeMode: 'file', isolatedDataDirectory: directory,
  node: process.version, playwright: JSON.parse(await readFile('node_modules/playwright/package.json', 'utf8')).version, groups: [], screenshots: [], localAssets: [], normalizedHomeNavigations: [], blockedOrigins: [], pageErrors: [], localFailures: [], status: 'running',
  boundaries: ['Standalone catalog is English and Traditional Chinese only; the CMS overview remains three-language.',
    'The unchanged https://www.ihearus.org/ target=_blank return link is intercepted at the browser boundary and redirected to this local origin. This is not a production navigation or CDN test.',
    'No email draft is opened or sent, no external form is submitted, and YouTube playback is not exercised.',
    'Existing CP6 integration provides race, failure, BFCache and broader engine evidence. This suite adds only merge-specific route, locale, shared-controller and asset checks.'] };
const save = () => writeFile(path.join(output, 'results.json'), JSON.stringify(evidence, null, 2));
const env = { ...process.env };
// Blank connection/storage credentials even when inherited from a shell; setting
// them explicitly also prevents Next's dotenv loader from filling these names.
const blankNames = new Set(['POSTGRES_URL', 'DATABASE_URL', 'POSTGRES_URL_NON_POOLING', 'POSTGRES_PRISMA_URL', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_STORAGE_BUCKET', 'SUPABASE_ANON_KEY', 'NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'BLOB_READ_WRITE_TOKEN', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'PGHOST', 'PGPORT', 'PGDATABASE', 'PGUSER', 'PGPASSWORD', 'IHEAR_AUTO_BOOTSTRAP_DB']);
for (const name of Object.keys(env)) if (/(?:DATABASE|POSTGRES|SUPABASE|STORAGE|BLOB_|^PG(?:HOST|PORT|DATABASE|USER|PASSWORD)$)/i.test(name)) blankNames.add(name);
for (const name of blankNames) env[name] = '';
evidence.clearedEnvironmentNames = [...blankNames].sort();
Object.assign(env, { NODE_ENV: 'production', VERCEL: '', NETLIFY: '', CONTEXT: '', IHEAR_FORCE_FILE_STORE: '1', IHEAR_TEST_DATA_DIR: directory,
  AUTH_SECRET: 'cp7-academy-local-test-secret-only', AUTH_URL: origin, AUTH_TRUST_HOST: 'true' });
const server = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '--hostname', 'localhost', '--port', '3228'], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let logs = '', browser;
server.stdout.on('data', value => { logs += value; }); server.stderr.on('data', value => { logs += value; });
const pause = ms => new Promise(resolve => { setTimeout(resolve, ms); });
const contexts = [];
async function context(options = {}) {
  const value = await browser.newContext({ locale: 'en-US', viewport: { width: 1280, height: 950 }, ...options }); contexts.push(value);
  await value.route('**/*', route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin === origin) return route.continue();
    if (url.href === 'https://www.ihearus.org/' && request.isNavigationRequest() && request.method() === 'GET') {
      evidence.normalizedHomeNavigations.push({ source: url.href, destination: origin + '/', method: 'browser interception; original link unchanged' });
      return route.fulfill({ status: 302, headers: { location: origin + '/' }, body: '' });
    }
    if (!['http:', 'https:'].includes(url.protocol)) return route.continue();
    if (!evidence.blockedOrigins.includes(url.origin)) evidence.blockedOrigins.push(url.origin);
    return route.abort('blockedbyclient');
  });
  value.on('page', page => {
    page.on('pageerror', error => { evidence.pageErrors.push({ page: page.url(), message: error.message }); });
    page.on('response', response => {
      const url = new URL(response.url());
      if (url.origin !== origin) return;
      if (response.status() >= 400) evidence.localFailures.push({ url: url.pathname, status: response.status() });
      if (url.pathname.startsWith('/academy/courses/') && /\.(?:css|js|jpg|png|woff2)$/.test(url.pathname)) {
        const key = url.pathname;
        if (!evidence.localAssets.some(value => value.path === key)) evidence.localAssets.push({ path: key, status: response.status(), contentType: response.headers()['content-type'] });
      }
    });
  });
  return value;
}
async function group(name, fn) {
  const start = Date.now();
  try { await fn(); evidence.groups.push({ name, status: 'passed', milliseconds: Date.now() - start }); console.log(`PASS ${name}`); }
  catch (error) { evidence.groups.push({ name, status: 'failed', milliseconds: Date.now() - start, error: error.stack }); throw error; }
  finally { await save(); }
}
async function homeReady(page, locale = 'en') {
  await expect(page.locator('[data-home-banner]')).toHaveAttribute('data-banner-controller', 'ready');
  await expect(page.locator('[data-home-banner]')).toHaveAttribute('data-refresh-state', 'fresh');
  await expect(page.locator('[data-home-quick-cards]')).toHaveAttribute('data-cards-controller', 'ready');
  await expect(page.locator('[data-home-quick-cards]')).toHaveAttribute('data-refresh-state', 'fresh');
  await expect(page.locator('html')).toHaveAttribute('lang', locale === 'en' ? 'en' : locale === 'zhHant' ? 'zh-Hant' : 'zh-Hans');
  for (const [index, name] of ['announcements', 'calendar'].entries()) {
    await expect(page.locator(`[data-home-${name}]`)).toHaveAttribute('data-state', 'ready');
    await expect(page.locator(`[data-home-${name}] [data-home-card-title]`)).toHaveText(resourceDocument.items.find(value => value.id === `cp7-resource-${index}`).title[locale]);
  }
  await expect(page.locator('[data-home-banner-dot]')).toHaveCount(2);
}
async function slide(page) {
  await page.locator('[data-home-banner-next]').click(); await expect(page.locator('[data-home-banner]')).toHaveAttribute('data-active-id', secondId);
  await page.locator('[data-home-banner-previous]').click(); await expect(page.locator('[data-home-banner]')).toHaveAttribute('data-active-id', firstId);
}
async function screen(page, name) {
  await page.evaluate(() => scrollTo({ top: 0, behavior: 'instant' })); await page.evaluate(() => document.fonts.ready);
  // aria-expanded changes before the drawer's 220ms close animation ends.
  // Capture its settled state, without changing the product's motion settings.
  if (await page.locator('#navToggle').isVisible() && await page.locator('#navToggle').getAttribute('aria-expanded') === 'false') {
    await expect(page.locator('#navLinks')).toBeHidden();
  }
  await page.evaluate(async () => {
    await new Promise(resolve => { requestAnimationFrame(() => requestAnimationFrame(resolve)); });
    await Promise.allSettled(document.getAnimations().filter(animation => animation.playState === 'running' && Number.isFinite(animation.effect?.getComputedTiming().endTime)).map(animation => animation.finished));
  });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  const file = path.join(pictures, name); await page.screenshot({ path: file }); evidence.screenshots.push(file);
}
async function returnHome(page, owner, locale) {
  const link = page.locator('#purpose a[href="https://www.ihearus.org/"]');
  await expect(link).toHaveAttribute('target', '_blank');
  const [popup] = await Promise.all([owner.waitForEvent('page'), link.click()]);
  await popup.waitForURL(origin + '/'); await homeReady(popup, locale); await slide(popup); return popup;
}
async function checkCatalog(page, lang) {
  await expect(page.locator('html')).toHaveAttribute('lang', lang);
  await expect(page.locator('h1')).toBeVisible(); await expect(page.locator('#price')).toHaveText('$35');
  assert.deepEqual(await page.locator('header .language-switch a').evaluateAll(nodes => nodes.map(node => node.lang)), ['en', 'zh-Hant']);
  await expect(page.locator('[data-home-focus]')).toHaveCount(0);
  assert.deepEqual(await page.evaluate(() => ({ banner: typeof window.iHearHomeBanner, cards: typeof window.iHearHomeQuickCards })), { banner: 'undefined', cards: 'undefined' });
  const mail = await page.locator('#start .inquiry a[href^="mailto:"]').getAttribute('href');
  const url = new URL(mail); assert.equal(url.pathname, 'ihearprogram@gmail.com'); assert.ok(url.searchParams.get('subject')); assert.ok(url.searchParams.get('body'));
  await page.locator('input[name="tutor"][value="college"]').check();
  await page.locator('input[name="plan"][value="package"]').check(); await expect(page.locator('#price')).toHaveText('$380');
  await expect(page.locator('#price-detail')).toContainText(lang === 'en' ? 'college' : '大學生');
  await page.locator('#faq summary').first().click(); await expect(page.locator('#faq details').first()).toHaveAttribute('open', '');
}
try {
  let ready = false;
  for (let i = 0; i < 100; i++) { if (server.exitCode !== null) throw new Error(logs); try { if ((await fetch(origin + '/api/resources')).ok) { ready = true; break; } } catch {} await pause(250); }
  assert.ok(ready, 'Production build starts with isolated file stores');
  browser = await chromium.launch({ headless: true }); evidence.chromium = browser.version();
  await group('01 merged SSR and public projections; no-JavaScript Academy overview in three catalog locales', async () => {
    const response = await fetch(origin), html = await response.text(); assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'private, no-store, max-age=0'); assert.equal(response.headers.get('vercel-cdn-cache-control'), 'no-store');
    const snapshot = JSON.parse(html.match(/id="ihear-home-banner"[^>]*>([\s\S]*?)<\/script>/)[1]);
    assert.equal(snapshot.state, 'ready'); assert.equal(snapshot.version, 7); assert.deepEqual(snapshot.items.map(item => item.id), [firstId, secondId]);
    const api = await (await fetch(origin + '/api/media-galleries?gallery_id=home-banner')).json();
    assert.deepEqual(api.items[0].items.map(item => item.id), [firstId, secondId]);
    for (const text of [hiddenText, privateText, 'cp7-hidden']) { assert.ok(!html.includes(text)); assert.ok(!JSON.stringify(api).includes(text)); }
    await writeFile(path.join(output, 'home-ssr.html'), html);
    const published = await (await fetch(origin + '/api/content/get?page=%2Facademy')).json();
    evidence.overviewLocales = [];
    for (const [locale, language] of [['en', 'en-US'], ['zhHant', 'zh-TW'], ['zhHans', 'zh-CN']]) {
      const owner = await context({ javaScriptEnabled: false, locale: language }); const page = await owner.newPage(); await page.goto(origin + '/academy');
      await expect(page.locator('html')).toHaveAttribute('lang', locale === 'en' ? 'en' : locale === 'zhHant' ? 'zh-Hant' : 'zh-Hans');
      const renderedSources = {};
      for (const key of ['academy.acad.heading', 'academy.acad.courses']) {
        // The public content API exposes overrides, not resolved catalog defaults.
        // An absent page/key is legal. SSR resolves it using the catalog, while
        // the embedded public store must remain exactly equal to that API read.
        const override = published.locales[locale].pages['/academy']?.[key];
        const expected = override ?? slot(key, locale);
        assert.equal(typeof expected, 'string');
        await expect(page.locator(`[data-editable-content="${key}"]`)).toHaveText(expected);
        renderedSources[key] = override == null ? 'catalog fallback' : 'published override';
      }
      await expect(page.locator('[data-layout-link="academy.acad.courses.href"]')).toHaveAttribute('href', '/academy/courses/zh?entry=official');
      const embedded = JSON.parse(await page.locator('#ihear-published-content').textContent()); assert.deepEqual(embedded.store.locales, published.locales);
      evidence.overviewLocales.push({ locale, ssrMatchesResolvedContent: true, embeddedStoreMatchesPublicAPI: true, renderedSources, javaScript: false }); await owner.close();
    }
    evidence.publicProjection = { version: snapshot.version, publicIds: snapshot.items.map(item => item.id), hiddenAndOperationMetadataAbsent: true, requestTimeHtml: true };
  });
  await group('02 desktop homepage to three-language overview and Traditional Chinese catalog, then homepage popup', async () => {
    const owner = await context(); const page = await owner.newPage(); await page.goto(origin); await homeReady(page); await slide(page);
    await page.locator('[data-editable-content="site.footer.prog4"]').click(); await expect(page).toHaveURL(origin + '/academy#academy');
    for (const [key, locale] of [['en', 'en'], ['zhTW', 'zhHant'], ['zhCN', 'zhHans']]) {
      await page.locator(`#langSwitch [data-lang="${key}"]`).click(); await expect(page.locator('#academy-h')).toHaveText(slot('academy.acad.heading', locale));
      await expect(page.locator('[data-editable-content="academy.acad.courses"]')).toHaveText(slot('academy.acad.courses', locale));
    }
    await screen(page, 'overview-1280-zhHans.png');
    await page.locator('[data-layout-link="academy.acad.courses.href"]').click(); await expect(page).toHaveURL(origin + '/academy/courses/zh?entry=official');
    await checkCatalog(page, 'zh-Hant'); await screen(page, 'courses-1280-zhHant.png');
    const popup = await returnHome(page, owner, 'zhHans'); await screen(popup, 'homepage-return-1280-zhHans.png'); await owner.close();
  });
  await group('03 mobile language drawer, overview entry and English catalog switch retain independent locales on return', async () => {
    const owner = await context({ locale: 'zh-TW', viewport: { width: 390, height: 950 }, hasTouch: true }); const page = await owner.newPage(); await page.goto(origin); await homeReady(page, 'zhHant');
    await page.locator('[data-editable-content="site.footer.prog4"]').click(); await expect(page).toHaveURL(origin + '/academy#academy');
    await page.locator('#navToggle').click(); await expect(page.locator('#navToggle')).toHaveAttribute('aria-expanded', 'true');
    await page.locator('#langSwitch [data-lang="en"]').click(); await page.keyboard.press('Escape'); await expect(page.locator('#navToggle')).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('#academy-h')).toHaveText(slot('academy.acad.heading', 'en')); await screen(page, 'overview-390-en.png');
    await page.locator('[data-layout-link="academy.acad.courses.href"]').click(); await expect(page).toHaveURL(origin + '/academy/courses/zh?entry=official');
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh-Hant');
    await page.locator('header .language-switch a[lang="en"]').click(); await expect(page).toHaveURL(origin + '/academy/courses?entry=official');
    await checkCatalog(page, 'en'); await screen(page, 'courses-390-en.png');
    const popup = await returnHome(page, owner, 'en'); await screen(popup, 'homepage-return-390-en.png'); await owner.close();
  });
  await group('04 shared Resources classification and legacy video survive Academy routes and local asset loading', async () => {
    const owner = await context({ viewport: { width: 1024, height: 950 } }); const page = await owner.newPage(); await page.goto(origin); await homeReady(page);
    await page.locator('[data-home-announcements] [data-home-card-link]').click(); await expect(page).toHaveURL(origin + '/resources#announcements');
    await expect(page.locator('[data-resource-slug="announcements"] h2')).toBeFocused(); await expect(page.locator('[data-resource-slug="announcements"]')).toContainText('Announcement fixture');
    await page.goto(origin + '/stories'); const legacy = page.locator('[data-media-gallery="stories"]'); await expect(legacy.locator('.gallery-video-cover')).toBeVisible();
    await expect(legacy.locator('a[href="https://www.youtube.com/watch?v=LsQWwDBLKUc"]')).toBeVisible();
    const all = await (await fetch(origin + '/api/media-galleries')).json(); assert.ok(all.items.some(value => value.id === 'stories' && value.items.some(item => item.kind === 'youtube')));
    for (const name of ['style.css', 'self-hosted-fonts.css', 'script.js', 'logo.png', 'classroom.jpg']) assert.ok(evidence.localAssets.some(value => value.path === '/academy/courses/' + name && value.status === 200 && !/html/i.test(value.contentType || '')), `Loaded Academy asset: ${name}`);
    assert.ok(evidence.localAssets.some(value => value.path.endsWith('.woff2') && value.status === 200));
    assert.deepEqual(evidence.pageErrors, []); assert.deepEqual(evidence.localFailures, []);
    evidence.sharedRegression = { classificationAnchor: true, unchangedYoutubeDestination: true, playbackTested: false, localAssetsAreNotHtml: true, screenReaderTested: false }; await owner.close();
  });
  evidence.status = 'passed'; evidence.exitCode = 0; console.log(`Academy/home integration: ${evidence.groups.length} groups passed, 0 failed, 0 skipped; ${evidence.screenshots.length} screenshots.`);
} catch (error) { evidence.status = 'failed'; evidence.exitCode = 1; evidence.error = error.stack; console.error(error); process.exitCode = 1; }
finally { evidence.finishedAt = new Date().toISOString(); for (const owner of contexts) await owner.close().catch(() => {}); await browser?.close(); server.kill(); await save(); await writeFile(path.join(output, 'server.log'), logs); }
