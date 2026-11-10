// The privacy policy page in a real browser (2026-11-10), on the built site with local data only:
// phone and desktop widths, the three languages through the site's own language switch, the footer
// link on every page, no sideways scrolling, keyboard entry and text contrast. Read-only requests to
// 127.0.0.1; every other address is blocked.
import { execFileSync, spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from '@playwright/test';

const origin = 'http://127.0.0.1:3215';
const LANGUAGES = [['en', 'en', 'Privacy Policy'], ['zhTW', 'zh-Hant', '隱私權政策'], ['zhCN', 'zh-Hans', '隐私政策']];
const VIEWPORTS = [{ name: 'phone', width: 390, height: 844 }, { name: 'desktop', width: 1280, height: 900 }];

// WCAG contrast of an element's text against what is behind it, counting ancestor opacity.
function contrastOf(selector) {
  const element = document.querySelector(selector);
  if (!element) return null;
  const rgba = value => (value.match(/[\d.]+/g) || []).map(Number).concat([1]).slice(0, 4);
  let background = null;
  let opacity = 1;
  for (let node = element; node && node.nodeType === 1; node = node.parentElement) {
    const style = getComputedStyle(node);
    opacity *= Number(style.opacity);
    const color = rgba(style.backgroundColor);
    if (!background && color[3] > 0.99) background = color;
  }
  background ??= [255, 255, 255, 1];
  const text = rgba(getComputedStyle(element).color);
  const alpha = text[3] * opacity;
  const blended = text.slice(0, 3).map((value, index) => alpha * value + (1 - alpha) * background[index]);
  const luminance = channels => {
    const [r, g, b] = channels.map(value => { const c = value / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const [light, dark] = [luminance(blended), luminance(background.slice(0, 3))].sort((a, b) => b - a);
  return (light + 0.05) / (dark + 0.05);
}

await mkdir('output', { recursive: true });
// A default build leaves the draft out (fail closed): render the test fixture in an explicit local preview.
const privacyPreview = { IHEAR_PRIVACY_PREVIEW: '1', IHEAR_PRIVACY_SOURCES: 'tests/fixtures/privacy-policy' };
execFileSync(process.execPath, ['scripts/prepare-public.mjs'], { env: { ...process.env, ...privacyPreview, VERCEL: '', VERCEL_ENV: '' }, stdio: 'pipe' });
const data = await mkdtemp(path.resolve('output/privacy-smoke-'));
const child = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '--hostname', '127.0.0.1', '--port', '3215'], {
  env: { ...process.env, ...privacyPreview, NODE_ENV: 'production', VERCEL: '', VERCEL_ENV: '', NETLIFY: '', CONTEXT: '', POSTGRES_URL: '', DATABASE_URL: '', IHEAR_FORCE_FILE_STORE: '1', IHEAR_TEST_DATA_DIR: data },
  windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
});
let logs = '';
child.stdout.on('data', chunk => { logs += chunk; });
child.stderr.on('data', chunk => { logs += chunk; });
let browser;
const checks = [];
try {
  let ready = false;
  for (let attempt = 0; attempt < 60 && !ready; attempt++) {
    if (child.exitCode !== null) throw new Error(`Server exited: ${logs}`);
    try { ready = (await fetch(`${origin}/api/content/get?page=%2F`)).ok; } catch {}
    if (!ready) await new Promise(resolve => { setTimeout(resolve, 500); });
  }
  assert.ok(ready, 'Built server starts');
  browser = await chromium.launch({ headless: true });
  // The language the server renders and the one the page shows agree: on a first visit (from the
  // browser's language) and after a manual switch and a reload (from the saved choice).
  for (const [locale, expected] of [['en-US', 'en'], ['zh-TW', 'zh-Hant'], ['zh-CN', 'zh-Hans']]) {
    const context = await browser.newContext({ locale });
    await context.route('**/*', route => (new URL(route.request().url()).origin === origin ? route.continue() : route.abort()));
    const page = await context.newPage();
    let served = null;
    page.on('response', async response => { if (response.request().resourceType() === 'document' && new URL(response.url()).pathname === '/privacy') served = (await response.text()).match(/<html[^>]*\blang="([^"]+)"/)?.[1]; });
    await page.goto(`${origin}/privacy`, { waitUntil: 'networkidle' });
    assert.equal(served, expected, `${locale}: the server renders ${expected}`);
    assert.equal(await page.evaluate(() => document.documentElement.lang), expected, `${locale}: the page shows ${expected}`);
    for (const [button, chosen] of [['zhCN', 'zh-Hans'], ['en', 'en'], ['zhTW', 'zh-Hant']]) {
      await page.click(`#langSwitch [data-lang="${button}"]`);
      served = null;
      await page.reload({ waitUntil: 'networkidle' });
      assert.equal(served, chosen, `${locale} → ${button}: after a reload the server renders the chosen language`);
      assert.equal(await page.evaluate(() => document.documentElement.lang), chosen, `${locale} → ${button}: after a reload the page keeps the chosen language`);
      assert.equal((await context.cookies()).find(cookie => cookie.name === 'ihear-lang')?.value, button, `${locale} → ${button}: the choice is saved`);
    }
    await context.close();
  }
  for (const viewport of VIEWPORTS) {
    const context = await browser.newContext({ viewport, locale: 'en-US' });
    await context.route('**/*', route => (new URL(route.request().url()).origin === origin ? route.continue() : route.abort()));
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${origin}/privacy`, { waitUntil: 'networkidle' });

    // Keyboard: the first Tab reaches the skip link, which leads into the main content.
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement?.className), 'skip-link', `${viewport.name}: first Tab reaches the skip link`);
    await page.keyboard.press('Enter');
    assert.equal(new URL(page.url()).hash, '#main', `${viewport.name}: the skip link moves to the content`);

    for (const [button, lang, title] of LANGUAGES) {
      // On a phone the language switch lives in the menu: open it, choose, close it again.
      // The menu animates, so wait until it is fully open, and fully closed again afterwards.
      const languageButton = page.locator(`#langSwitch [data-lang="${button}"]`);
      const phone = viewport.name === 'phone';
      if (phone) { await page.click('#navToggle'); await languageButton.waitFor({ state: 'visible' }); }
      await languageButton.click();
      await page.waitForFunction(expected => document.documentElement.lang === expected, lang);
      if (phone) { await page.click('#navToggle'); await languageButton.waitFor({ state: 'hidden' }); }
      const visible = await page.$$eval('article.policy-body', articles => articles.filter(article => getComputedStyle(article).display !== 'none').map(article => article.lang));
      assert.deepEqual(visible, [lang], `${viewport.name}: only the ${lang} policy is shown`);
      const headings = await page.$$eval('h1', items => items.filter(item => item.offsetParent !== null).map(item => item.textContent.trim()));
      assert.deepEqual(headings, [title], `${viewport.name}: one visible h1 in ${lang}`);
      const notice = await page.$eval(`article[lang="${lang}"] .policy-draft-notice`, element => element.offsetParent !== null);
      assert.ok(notice, `${viewport.name}: the draft notice is visible in ${lang}`);
      const footer = page.locator('a.foot-privacy');
      await footer.scrollIntoViewIfNeeded();
      assert.ok(await footer.isVisible(), `${viewport.name}: the footer link is visible in ${lang}`);
      assert.equal((await footer.innerText()).trim(), title, `${viewport.name}: the footer link reads ${title}`);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `${viewport.name}: no sideways scrolling in ${lang}`);
      for (const selector of [`article[lang="${lang}"] .policy-draft-notice`, `article[lang="${lang}"] .policy-pending`, 'a.foot-privacy', `article[lang="${lang}"] h2`, `article[lang="${lang}"] p`]) {
        const ratio = await page.evaluate(contrastOf, selector);
        assert.ok(ratio >= 4.5, `${viewport.name} ${lang}: ${selector} contrast ${ratio?.toFixed(2)} is at least 4.5`);
        checks.push(ratio);
      }
    }
    // Wide tables scroll inside their own region on a phone, not the page.
    if (viewport.name === 'phone') {
      const scrolls = await page.$$eval('article[lang="zh-Hans"] .policy-table-wrap', wraps => wraps.map(wrap => wrap.scrollWidth > wrap.clientWidth && wrap.tabIndex === 0));
      assert.ok(scrolls.length >= 1 && scrolls.every(Boolean), 'Phone: each table scrolls within its keyboard-focusable region');
    }
    // The link from the home page footer, in the language the visitor chose.
    await page.goto(`${origin}/`, { waitUntil: 'networkidle' });
    const homeLink = page.locator('a.foot-privacy');
    await homeLink.scrollIntoViewIfNeeded();
    assert.ok(await homeLink.isVisible(), `${viewport.name}: the home page footer link is visible`);
    await Promise.all([page.waitForURL(`${origin}/privacy`), homeLink.click()]);
    assert.equal(await page.evaluate(() => document.documentElement.lang), 'zh-Hans', `${viewport.name}: the chosen language carries over`);
    assert.deepEqual(errors, [], `${viewport.name}: no script errors`);
    await context.close();
  }
  console.log(`Privacy page passed in a browser: server and page languages agree (3 browser languages, 9 switch-and-reload checks); phone and desktop, three languages, footer link, no sideways scrolling, keyboard skip link, ${checks.length} contrast checks (lowest ${Math.min(...checks).toFixed(2)}:1).`);
} catch (error) {
  console.error(logs.slice(-3000));
  throw error;
} finally {
  await browser?.close();
  child.kill();
  execFileSync(process.execPath, ['scripts/prepare-public.mjs'], { env: { ...process.env, IHEAR_PRIVACY_PREVIEW: '', IHEAR_PRIVACY_SOURCES: '' }, stdio: 'pipe' });
}
