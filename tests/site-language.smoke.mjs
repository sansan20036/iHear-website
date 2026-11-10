// The site's language choice in a real browser (2026-11-10), on the built site with local data only.
// The order (assets/site.js initialLanguage): 1. the visitor's choice in localStorage; 2. the
// ihear-lang cookie (what the server renders); 3. the browser's language. A saved choice is never
// replaced by the browser's language. Checked on three pages, three browser languages, every storage
// state (nothing, cookie only, localStorage only, both, both differing, an invalid value), a reload,
// and every manual switch. Read-only requests to 127.0.0.1; every other address is blocked.
import { spawn, execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from '@playwright/test';

const origin = 'http://127.0.0.1:3223';
const PAGES = ['/', '/faq', '/privacy'];
const ATTR = { en: 'en', zhTW: 'zh-Hant', zhCN: 'zh-Hans' };
const browserDefault = locale => (/^zh/i.test(locale) ? (/tw|hk|mo|hant/i.test(locale) ? 'zhTW' : 'zhCN') : 'en');
const previewEnv = { IHEAR_PRIVACY_PREVIEW: '1', IHEAR_PRIVACY_SOURCES: 'tests/fixtures/privacy-policy', VERCEL: '', VERCEL_ENV: '', NETLIFY: '', CONTEXT: '' };

await mkdir('output', { recursive: true });
execFileSync(process.execPath, ['scripts/prepare-public.mjs'], { env: { ...process.env, ...previewEnv }, stdio: 'pipe' });
const data = await mkdtemp(path.resolve('output/site-language-'));
const child = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '--hostname', '127.0.0.1', '--port', '3223'], {
  env: { ...process.env, ...previewEnv, NODE_ENV: 'production', POSTGRES_URL: '', DATABASE_URL: '', IHEAR_FORCE_FILE_STORE: '1', IHEAR_TEST_DATA_DIR: data },
  windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
});
let logs = '';
child.stdout.on('data', chunk => { logs += chunk; });
child.stderr.on('data', chunk => { logs += chunk; });
let browser;
let checks = 0;
try {
  let ready = false;
  for (let attempt = 0; attempt < 60 && !ready; attempt++) {
    if (child.exitCode !== null) throw new Error(`Server exited: ${logs}`);
    try { ready = (await fetch(`${origin}/api/content/get?page=%2F`)).ok; } catch {}
    if (!ready) await new Promise(resolve => { setTimeout(resolve, 500); });
  }
  assert.ok(ready, 'Built server starts');
  browser = await chromium.launch({ headless: true });

  // Opens a page with the given saved state; returns what the server rendered and what the page shows.
  async function visit({ locale, cookie, storage, page: route }) {
    const context = await browser.newContext({ locale, viewport: { width: 1280, height: 900 } });
    await context.route('**/*', request => (new URL(request.request().url()).origin === origin ? request.continue() : request.abort()));
    if (cookie) await context.addCookies([{ name: 'ihear-lang', value: cookie, url: origin }]);
    if (storage) await context.addInitScript(value => { try { if (!sessionStorage.getItem('seeded')) { localStorage.setItem('ihear-lang', value); sessionStorage.setItem('seeded', '1'); } } catch {} }, storage);
    const page = await context.newPage();
    const served = [];
    page.on('response', async response => {
      if (response.request().resourceType() === 'document' && new URL(response.url()).pathname === route) served.push((await response.text()).match(/<html[^>]*\blang="([^"]+)"/)?.[1]);
    });
    await page.goto(origin + route, { waitUntil: 'networkidle' });
    const state = async () => ({
      served: served.at(-1),
      shown: await page.evaluate(() => document.documentElement.lang),
      cookie: (await context.cookies()).find(item => item.name === 'ihear-lang')?.value ?? null,
      storage: await page.evaluate(() => { try { return localStorage.getItem('ihear-lang'); } catch { return 'blocked'; } }),
    });
    return { context, page, state };
  }

  for (const route of PAGES) {
    for (const locale of ['en-US', 'zh-TW', 'zh-CN']) {
      const fallback = browserDefault(locale);
      const cases = [
        ['nothing saved', {}, fallback],
        ...Object.keys(ATTR).map(language => [`cookie ${language} only`, { cookie: language }, language]),
        ...Object.keys(ATTR).map(language => [`localStorage ${language} only`, { storage: language }, language]),
        ['both zhTW', { cookie: 'zhTW', storage: 'zhTW' }, 'zhTW'],
        ['both differ (localStorage zhTW, cookie zhCN)', { cookie: 'zhCN', storage: 'zhTW' }, 'zhTW'],
        ['invalid cookie', { cookie: 'xx' }, fallback],
        ['invalid localStorage, cookie en', { cookie: 'en', storage: 'xx' }, 'en'],
      ];
      for (const [name, saved, expected] of cases) {
        const { context, page, state } = await visit({ locale, route, page: route, ...saved });
        const first = await state();
        const label = `${route} ${locale} ${name}`;
        assert.equal(first.shown, ATTR[expected], `${label}: shows ${ATTR[expected]} (got ${first.shown})`);
        assert.equal(first.cookie, expected, `${label}: the cookie keeps the language shown`);
        if (saved.cookie && ATTR[saved.cookie] && !saved.storage) assert.equal(first.served, ATTR[saved.cookie], `${label}: the server renders the cookie's language`);
        if (saved.storage) assert.equal(first.storage, saved.storage, `${label}: a saved choice is left as it is`);
        // A reload changes nothing.
        await page.reload({ waitUntil: 'networkidle' });
        const again = await state();
        assert.equal(again.shown, ATTR[expected], `${label}: same language after a reload`);
        assert.equal(again.served, ATTR[expected], `${label}: after a reload the server renders it too`);
        checks += 2;
        await context.close();
      }
      // Every manual switch is kept through a reload, and the browser's language never takes over.
      const { context, page, state } = await visit({ locale, route, page: route });
      let current = fallback;
      let stored = null;
      for (const button of ['zhCN', 'en', 'zhTW', 'zhCN']) {
        await page.click(`#langSwitch [data-lang="${button}"]`);
        // Pressing the language already in use changes nothing (site.js setLanguage); the cookie
        // already holds it, and the cookie now outranks the browser's language.
        if (button !== current) stored = button;
        current = button;
        await page.reload({ waitUntil: 'networkidle' });
        const now = await state();
        assert.deepEqual([now.served, now.shown, now.cookie, now.storage], [ATTR[button], ATTR[button], button, stored], `${route} ${locale}: switching to ${button} is kept`);
        checks += 1;
      }
      // The choice (zhCN) survives losing localStorage: the cookie still holds it and is not overwritten.
      await page.evaluate(() => localStorage.removeItem('ihear-lang'));
      await page.reload({ waitUntil: 'networkidle' });
      const afterStorageLoss = await state();
      assert.deepEqual([afterStorageLoss.shown, afterStorageLoss.cookie], ['zh-Hans', 'zhCN'], `${route} ${locale}: a lost localStorage keeps the chosen language`);
      // And it survives losing the cookie once localStorage holds it again.
      await page.click('#langSwitch [data-lang="zhTW"]');
      await context.clearCookies({ name: 'ihear-lang' });
      await page.reload({ waitUntil: 'networkidle' });
      const afterCookieLoss = await state();
      assert.deepEqual([afterCookieLoss.shown, afterCookieLoss.cookie, afterCookieLoss.storage], ['zh-Hant', 'zhTW', 'zhTW'], `${route} ${locale}: a lost cookie is restored from the saved choice`);
      checks += 2;
      await context.close();
    }
  }
  console.log(`Site language passed: ${checks} checks on ${PAGES.length} pages × 3 browser languages — every storage state, reloads and manual switches; a saved choice is never replaced by the browser's language.`);
} catch (error) {
  console.error(logs.slice(-3000));
  throw error;
} finally {
  await browser?.close();
  child.kill();
  // Back to the default (fail-closed) local pages.
  execFileSync(process.execPath, ['scripts/prepare-public.mjs'], { env: { ...process.env, IHEAR_PRIVACY_PREVIEW: '', IHEAR_PRIVACY_SOURCES: '' }, stdio: 'pipe' });
}
