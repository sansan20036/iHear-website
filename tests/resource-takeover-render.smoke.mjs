// Checkpoint 6: actual public scripts, captured data, all traffic intercepted.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { guidesTakeoverState } from '../lib/resource-guides-takeover.ts';
import { resourceDocumentFromTables } from '../scripts/resource-guide-takeover.mjs';
import { resourcePublicSnapshot } from './helpers/resource-public-snapshot.mjs';
const directory = path.resolve(process.argv[2] || '');
if (!process.argv[2]) throw new Error('Usage: node tests/resource-takeover-render.smoke.mjs <rehearsal-directory>');
const fixture = JSON.parse(await readFile(path.join(directory, 'resource-links.json'), 'utf8'));
assert.equal(fixture.legacyGuidesMigrated, true);
const before = JSON.parse(await readFile(path.join(directory, 'before-migration.json'), 'utf8'));
const pre = resourceDocumentFromTables(before);
const sources = Object.fromEntries(await Promise.all(['resources.html', 'assets/site.js', 'assets/resources.js', 'assets/site.css'].map(async name => [name, await readFile(name, 'utf8')])));
const overrides = before.localized_content_overrides.filter(row => row.page === '/resources');
function responseFor(doc) {
  const guidesTakeover = guidesTakeoverState(doc.legacyGuidesMigrated, doc.topics, doc.items);
  if (guidesTakeover === 'unavailable') return { status: 503, json: { error: 'Resources are temporarily unavailable. Please try again.' } };
  const topics = doc.topics.filter(t => t.status === 'published');
  const items = doc.items.filter(i => i.status === 'published' && topics.some(t => t.id === i.topicId));
  return { status: 200, json: resourcePublicSnapshot({ guidesTakeover,
    topics: topics.filter(t => items.some(i => i.topicId === t.id)).map(({ id, title, description, slug, sortOrder }) => ({ id, title, description, slug, sortOrder })),
    items: items.map(({ id, category, topicId, type, title, description, url, sortOrder }) => ({ id, category, topicId, type, title, description, url, sortOrder })),
  }) };
}
const report = { status: 'RUNNING', scope: 'Current HTML/site.js/resources.js + migrated public projection, not a live API server; real API tested separately', productionAccess: false, checks: [] };
let browser, page, current, release;
const legacy = '[data-resource-legacy-guides] li', migrated = '[data-resource-topic="guides"] li';
async function counts() { return { legacyDOM: await page.locator(legacy).count(), legacyVisible: await page.locator(legacy + ':visible').count(), newGuides: await page.locator(migrated).count() }; }
const check = async (name, fn) => { try { await fn(); report.checks.push({ name, result: 'PASS', counts: await counts() }); } catch (e) { report.checks.push({ name, result: 'FAIL', error: e.message }); throw e; } };
async function load(response) {
  current = response; await page.goto('http://checkpoint6.invalid/resources');
  await page.waitForFunction(() => !/Loading|載入中|加载中/.test(document.querySelector('[data-resource-status]').textContent) && !!window.iHearSetLanguage);
}
async function refresh() {
  const response = page.waitForResponse(r => r.url().endsWith('/api/resources'));
  await page.evaluate(() => window.dispatchEvent(new Event('focus'))); await response;
  await page.evaluate(() => new Promise(resolve => { requestAnimationFrame(() => requestAnimationFrame(resolve)); }));
}
try {
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addInitScript(values => {
    window.iHearPublishedContent = { valueFor: (element, locale) => values.find(row => row.key === element.dataset.editableContent && row.locale === locale)?.value };
  }, overrides);
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== 'http://checkpoint6.invalid') return route.abort();
    if (url.pathname === '/resources') return route.fulfill({ contentType: 'text/html', body: sources['resources.html'].replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace('</head>', '<link rel="stylesheet" href="/assets/site.css"></head>').replace('</body>', '<script src="/assets/site.js"></script><script src="/assets/resources.js"></script></body>') });
    if (url.pathname === '/api/resources') { if (release) await release; return route.fulfill(current); }
    const key = url.pathname.slice(1);
    if (sources[key]) return route.fulfill({ contentType: key.endsWith('.css') ? 'text/css' : 'application/javascript', body: sources[key] });
    return route.abort();
  });
  page = await context.newPage(); const errors = []; page.on('pageerror', e => errors.push(e.message));
  await check('Pending state exposes neither system', async () => {
    let resolve; release = new Promise(done => { resolve = done; }); current = responseFor(pre);
    await page.goto('http://checkpoint6.invalid/resources');
    assert.equal((await counts()).legacyVisible, 0); assert.equal((await counts()).newGuides, 0);
    resolve(); release = null; await page.locator(legacy + ':visible').first().waitFor();
  });
  for (const [label, doc, selector] of [['pre', pre, legacy], ['post', fixture, migrated]]) {
    await load(responseFor(doc));
    for (const [language, locale] of [['en', 'en'], ['zhTW', 'zhHant'], ['zhCN', 'zhHans']]) await check(`${label}: nine Guides exactly once, ${locale} text/order/mailto`, async () => {
      await page.evaluate(language => window.iHearSetLanguage(language, { force: true }), language);
      const expected = fixture.items.filter(i => i.topicId === 'guides').sort((a, b) => a.sortOrder - b.sortOrder);
      assert.deepEqual(await page.locator(selector + ' h3').allTextContents(), expected.map(i => i.title[locale] || i.title.en));
      assert.deepEqual(await counts(), label === 'pre' ? { legacyDOM: 9, legacyVisible: 9, newGuides: 0 } : { legacyDOM: 0, legacyVisible: 0, newGuides: 9 });
      if (label === 'post') for (const item of expected) {
        const prefix = locale === 'en' ? 'Resource guide request: ' : '索取指南：';
        assert.equal(await page.locator(`[data-resource-item="${item.id}"] h3 a`).getAttribute('href'), 'mailto:ihearprogram@gmail.com?subject=' + encodeURIComponent(prefix + (item.title[locale] || item.title.en)));
      }
    });
    await refresh();
    await writeFile(path.join(directory, `takeover-${label}-dom.html`), await page.content());
    await writeFile(path.join(directory, `takeover-${label}-payload.json`), JSON.stringify(responseFor(doc).json, null, 2));
  }
  await check('Background failure never restores legacy', async () => {
    current = { status: 503, json: { error: 'unavailable' } }; await refresh(); await page.locator('[data-resource-retry]:visible').waitFor();
    assert.deepEqual(await counts(), { legacyDOM: 0, legacyVisible: 0, newGuides: 0 });
  });
  await check('Stale pre-takeover response cannot resurrect legacy', async () => {
    current = responseFor(pre); await refresh(); await page.locator('[data-resource-retry]:visible').waitFor();
    assert.deepEqual(await counts(), { legacyDOM: 0, legacyVisible: 0, newGuides: 0 });
  });
  const hidden = structuredClone(fixture); hidden.topics.find(t => t.id === 'guides').status = 'draft';
  const archived = structuredClone(fixture); archived.items.filter(i => i.topicId === 'guides').forEach(i => { i.status = 'archived'; });
  for (const [name, doc] of [['hidden Topic', hidden], ['archived Items', archived]]) await check(`${name} never revives legacy`, async () => {
    await load(responseFor(doc)); assert.deepEqual(await counts(), { legacyDOM: 0, legacyVisible: 0, newGuides: 0 });
  });
  const missingMarker = responseFor(fixture); delete missingMarker.json.guidesTakeover;
  const contradictory = responseFor(fixture); contradictory.json.guidesTakeover = 'legacy';
  const duplicates = responseFor(fixture); duplicates.json.items.push(duplicates.json.items.find(i => i.topicId === 'guides'));
  for (const [name, response] of [
    ['missing stored marker', responseFor({ ...fixture, legacyGuidesMigrated: undefined })],
    ['invalid stored marker', responseFor({ ...fixture, legacyGuidesMigrated: 'bad' })],
    ['partial data', responseFor({ ...fixture, items: fixture.items.filter(i => i.id !== 'guide-communication') })],
    ['missing response state', missingMarker], ['contradictory response', contradictory], ['duplicate response IDs', duplicates],
  ]) await check(`${name}: safe failure, no double rendering`, async () => {
    await load(response); assert.equal((await counts()).legacyVisible, 0); assert.equal((await counts()).newGuides, 0);
    assert.equal(await page.locator('[data-resource-retry]').isVisible(), true);
  });
  await check('Read-only rollback snapshot restores previous Forms and Guides', async () => {
    await load(responseFor(pre)); assert.equal((await counts()).legacyVisible, 9);
    const links = await page.locator('[data-resource-item] h3 a').evaluateAll(nodes => nodes.map(a => a.getAttribute('href')).sort());
    assert.deepEqual(links, before.resource_links.filter(i => i.status === 'published').map(i => i.url).sort());
  });
  await check('Re-enable upgraded snapshot: new Guides only', async () => {
    await load(responseFor(fixture)); assert.deepEqual(await counts(), { legacyDOM: 0, legacyVisible: 0, newGuides: 9 });
  });
  if (process.argv.includes('--recovery')) {
    const recovered = resourceDocumentFromTables(JSON.parse(await readFile(path.join(directory, 'recovery-after.json'), 'utf8')));
    await check('Recovered database public projection retains added item and hidden Guide state', async () => {
      await load(responseFor(recovered));
      assert.deepEqual(await counts(), { legacyDOM: 0, legacyVisible: 0, newGuides: 0 });
      assert.equal(await page.locator('[data-resource-item="recovery-added-item"]').count(), 1);
      assert.equal(await page.locator('[data-resource-topic="recovery-added-topic"]').count(), 1);
      assert.equal(await page.locator('[data-resource-item="guide-communication"]').count(), 0);
    });
  }
  assert.deepEqual(errors, []);
  await mkdir('output/playwright', { recursive: true }); report.screenshot = `output/playwright/checkpoint-6-${path.basename(directory)}-takeover.png`;
  await page.screenshot({ path: report.screenshot, fullPage: true }); report.status = 'PASS';
} catch (error) { report.status = 'STOP'; report.failure = error.stack; process.exitCode = 1; }
finally {
  await browser?.close(); await writeFile(path.join(directory, 'takeover-render-report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ status: report.status, checks: report.checks.length, failure: report.failure, report: path.join(directory, 'takeover-render-report.json') }));
}
