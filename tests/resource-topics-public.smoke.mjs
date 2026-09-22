// Checkpoints 4–5: public rendering, anchors and Email requests on isolated data.
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, expect as baseExpect } from '@playwright/test';
import { encode } from 'next-auth/jwt';
import { initialResourceTopics, validateResourceDocument } from '../lib/resource-topic-model.ts';
import { RESOURCE_SEEDS } from '../lib/resource-seed.ts';
import { resourceAnchorEmailTests } from './resource-anchor-email.smoke.mjs';
import { legacyResourceSnapshot } from './helpers/resource-public-snapshot.mjs';

const expect = baseExpect.configure({ timeout: 20000 });
// Optional exact group selection runs the same fixture and assertions in isolation.
const groupArg = process.argv.indexOf('--group');
const onlyGroup = groupArg < 0 ? null : process.argv[groupArg + 1];
if (groupArg >= 0 && !onlyGroup) throw new Error('--group requires a workflow name');
const dev = process.argv.includes('--dev'), origin = 'http://localhost:3215', secret = 'checkpoint-4-local-auth-only';
const referenceArg = process.argv.indexOf('--production-reference');
const referenceDir = referenceArg < 0 ? null : path.resolve(process.argv[referenceArg + 1]);
const reference = referenceDir ? JSON.parse(await readFile(path.join(referenceDir, 'production-resources.txt'), 'utf8')) : null;
await import('../scripts/prepare-public.mjs');
await mkdir('output/playwright', { recursive: true });
const directory = await mkdtemp(path.resolve('output/playwright/resource-public-'));
const l = (en, zhHant = '', zhHans = '') => ({ en, zhHant, zhHans });
const meta = { version: 1, createdAt: '2026-09-22T00:00:00.000Z', updatedAt: '2026-09-22T00:00:00.000Z', createdBy: 'fixture', updatedBy: 'fixture', states: [] };
const topic = (id, status, sortOrder) => ({ ...meta, id, slug: id.toLowerCase(), status, sortOrder, title: l(id), description: l('Topic ' + id) });
const item = (id, topicId, type, status = 'published', sortOrder = 1) => ({ ...meta, id, topicId, type, status, sortOrder, category: 'form', title: l(id, '繁體 ' + id, '简体 ' + id), description: l('English description ' + id), url: type === 'external_link' ? 'https://example.org/' + id : '' });
const doc = { schemaVersion: 2, topics: [...initialResourceTopics(), topic('topic-a', 'published', 1), topic('topic-b', 'published', 2), topic('PRIVATE-DRAFT-TOPIC', 'draft', 3), topic('PRIVATE-ARCHIVED-TOPIC', 'archived', 4), topic('EMPTY-PUBLISHED-TOPIC', 'published', 0)],
  items: [...(reference?.items || RESOURCE_SEEDS).map(record => ({ ...meta, ...record, topicId: record.category === 'article' ? 'articles' : 'forms', type: 'external_link', status: 'published' })),
    item('link-b', 'topic-a', 'external_link'), item('link-a', 'topic-a', 'external_link'), item('email-item', 'topic-b', 'email_request'), item('text-item', 'topic-b', 'text', 'published', 2),
    item('PRIVATE-DRAFT-ITEM', 'topic-a', 'text', 'draft'), item('PRIVATE-ARCHIVED-ITEM', 'topic-a', 'text', 'archived'), item('PRIVATE-PARENT-ITEM', 'PRIVATE-DRAFT-TOPIC', 'text') ] };
doc.items.find(r => r.id === 'text-item').title = l('<img src=x onerror=alert(1)> Plain text');
validateResourceDocument(doc);
await writeFile(path.join(directory, 'resource-links.json'), JSON.stringify(doc));
const child = spawn(process.execPath, ['node_modules/next/dist/bin/next', dev ? 'dev' : 'start', '--hostname', 'localhost', '--port', '3215'], {
 env: { ...process.env, NODE_ENV: dev ? 'development' : 'production', VERCEL: '', NETLIFY: '', CONTEXT: '', IHEAR_FORCE_FILE_STORE: '1', IHEAR_TEST_DATA_DIR: directory, POSTGRES_URL: '', DATABASE_URL: '', AUTH_SECRET: secret, AUTH_OWNER_EMAILS: 'checkpoint4@example.test', AUTH_URL: origin, AUTH_TRUST_HOST: 'true' }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
});
let browser, page, logs = '', passed = 0;
child.stdout.on('data', chunk => { logs = (logs + chunk).slice(-10000); }); child.stderr.on('data', chunk => { logs = (logs + chunk).slice(-10000); });
const pause = ms => new Promise(resolve => { setTimeout(resolve, ms); });
const step = async (name, action) => { if (onlyGroup && name !== onlyGroup) return; await action(); passed++; console.log(`PASS ${passed}: ${name}`); };
try {
 let ready = false;
 for (let n = 0; n < 180; n++) { if (child.exitCode !== null) throw new Error(logs); try { if ((await fetch(origin + '/api/resources')).ok) { ready = true; break; } } catch { /* booting */ } await pause(500); }
 if (!ready) throw new Error('Server unavailable: ' + logs);
 browser = await chromium.launch({ headless: true, args: process.platform === 'win32' ? ['--force-device-scale-factor=1'] : [] });
 const visitor = await browser.newContext({ viewport: { width: 1440, height: 1000 } }); page = await visitor.newPage(); page.setDefaultTimeout(20000);
 const requests = []; page.on('request', request => requests.push(request.url()));
 const errors = []; page.on('pageerror', error => errors.push(error.message));
 const catalog = page.locator('[data-resource-catalog]'), topics = page.locator('[data-resource-topic]');
 const row = id => page.locator(`[data-resource-item="${id}"]`);
 const language = async value => { await page.setViewportSize({ width: 1440, height: 1000 }); await page.locator(`#langSwitch button[data-lang="${value}"]`).click(); };
 const refresh = async () => { const response = page.waitForResponse(r => r.url() === origin + '/api/resources'); await page.evaluate(() => window.dispatchEvent(new Event('focus'))); await response; };
 const session = await encode({ secret, salt: 'authjs.session-token', token: { name: 'Local admin', email: 'checkpoint4@example.test', sub: 'checkpoint4' } });
 const admin = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
 await admin.addCookies([{ name: 'authjs.session-token', value: session, url: origin, httpOnly: true, sameSite: 'Lax' }]);
 const privateData = async () => (await (await admin.request.get(origin + '/api/resources?admin=1')).json());
 await step('Real public response excludes private topics/items, and HTML has no private payload', async () => {
   const response = await fetch(origin + '/api/resources'); const payload = await response.text();
   expect(response.status).toBe(200); expect(payload).not.toContain('PRIVATE-'); expect(payload).not.toContain('EMPTY-PUBLISHED'); expect(payload).not.toContain('createdBy');
   const html = await (await fetch(origin + '/resources')).text(); expect(html).not.toContain('PRIVATE-');
   await page.goto(origin + '/resources'); await expect(topics).toHaveCount(3); await language('en');
   expect(await page.locator('body').innerText()).not.toContain('PRIVATE-');
   expect(requests.some(url => /api\/(resources|resource-topics).*?(admin=|includeArchived)/.test(url))).toBe(false);
 });
 await step('Topics use numeric order; tied item orders use stable IDs', async () => {
   expect(await topics.evaluateAll(nodes => nodes.map(node => node.dataset.resourceTopic))).toEqual(['topic-a', 'topic-b', 'forms']);
   expect(await page.locator('[data-resource-topic="topic-a"] li').evaluateAll(nodes => nodes.map(node => node.dataset.resourceItem))).toEqual(['link-a', 'link-b']);
   await expect(page.locator('[data-resource-legacy-guides] li')).toHaveCount(9);
   await expect(page.locator('.res-chips')).toHaveCount(0);
 });
 await step('All types render safe titles/descriptions with Email request links', async () => {
   await expect(row('link-a').getByRole('link')).toHaveAttribute('href', 'https://example.org/link-a');
   await expect(row('link-a').getByRole('link')).toHaveAttribute('target', '_blank'); await expect(row('link-a').getByRole('link')).toHaveAttribute('rel', 'noopener noreferrer');
   await expect(row('email-item')).toContainText('Email request'); await expect(row('email-item').locator('a')).toHaveAttribute('href', 'mailto:ihearprogram@gmail.com?subject=' + encodeURIComponent('Resource guide request: email-item'));
   await expect(row('text-item').getByRole('heading')).toHaveText('<img src=x onerror=alert(1)> Plain text');
   await expect(row('text-item').locator('a,button,img')).toHaveCount(0);
 });
 await step('Three languages, independent English fallback and 320/390/1440px keyboard layouts', async () => {
   for (const [lang, name] of [['en', 'link-a'], ['zhTW', '繁體 link-a'], ['zhCN', '简体 link-a']]) {
     await language(lang); await expect(row('link-a').getByRole('link')).toContainText(name);
     await expect(row('link-a').locator('p')).toHaveText('English description link-a');
     for (const width of [320, 390, 1440]) {
       await page.setViewportSize({ width, height: 900 });
       expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
       const link = row('link-a').getByRole('link'); await link.focus(); await expect(link).toBeFocused(); await page.keyboard.press('Tab'); await expect(row('link-b').getByRole('link')).toBeFocused();
       await link.scrollIntoViewIfNeeded(); await page.screenshot({ path: `output/playwright/resources-public-${lang}-${width}.png` });
     }
   }
   await language('en');
 });
 await step('Unchanged refresh preserves keyboard focus; link activation opens the HTTPS destination', async () => {
   const link = row('link-a').getByRole('link'); await link.focus(); await refresh(); await expect(link).toBeFocused();
   await visitor.route('https://example.org/**', route => route.fulfill({ body: '<title>External destination</title>' }));
   const popupPromise = page.waitForEvent('popup'); await page.keyboard.press('Enter'); const popup = await popupPromise;
   await expect(popup).toHaveURL('https://example.org/link-a'); await popup.close(); await page.bringToFront();
 });
 await step('Admin sees per-topic entry and opens the correct filtered management list; visitors do not', async () => {
   await expect(catalog.locator('[data-resource-manage]')).toBeHidden();
   expect(await catalog.locator('.resource-topic-manage:visible').count()).toBe(0);
   const adminPage = await admin.newPage(); await adminPage.goto(origin + '/resources');
   const entry = adminPage.locator('[data-resource-topic="topic-b"] .resource-topic-manage'); await expect(entry).toBeVisible();
   await expect(entry).toHaveAttribute('href', '/admin/resources?topicId=topic-b'); await entry.click();
   await expect(adminPage.locator('.admin-resource-filters').getByLabel('所屬主題', { exact: true })).toHaveValue('topic-b');
   await expect(adminPage.locator('.admin-resource-list article')).toHaveCount(2); await adminPage.close();
 });
 await resourceAnchorEmailTests({ visitor, admin, origin, expect, step, topic, item, l });
 await step('Publishing state changes remove content, including items under newly hidden topics', async () => {
   const current = (await privateData()).topics.find(t => t.id === 'topic-a');
   expect((await admin.request.patch(origin + '/api/resource-topics/topic-a', { data: { version: current.version, status: 'draft' } })).status()).toBe(200);
   await refresh(); await expect(row('link-a')).toHaveCount(0); await expect(page.locator('[data-resource-topic="topic-a"]')).toHaveCount(0);
   const child = (await privateData()).items.find(r => r.id === 'link-a'); expect(child.status).toBe('published');
 });
 await step('Read failure clears last public snapshot and retry does not restore now-hidden records', async () => {
   await page.route('**/api/resources', route => route.fulfill({ status: 503, json: { error: 'unavailable' } }), { times: 1 });
   await refresh(); await expect(catalog.getByRole('status')).toHaveText('Resources could not be loaded.'); await expect(topics).toHaveCount(0);
   await catalog.getByRole('button', { name: 'Try again' }).click(); await expect(topics).toHaveCount(2); await expect(row('link-a')).toHaveCount(0);
 });
 await step('Malformed public payload and malicious/private rows fail closed without fallback seeds', async () => {
   // Deliberately incomplete envelope: keep this negative fixture outside the success builder.
   await page.route('**/api/resources', route => route.fulfill({ json: { items: RESOURCE_SEEDS } }), { times: 1 });
   await refresh(); await expect(topics).toHaveCount(0); await expect(catalog.getByRole('status')).toHaveText('Resources could not be loaded.');
   await page.route('**/api/resources', route => route.fulfill({ json: legacyResourceSnapshot({ topics: [topic('inject', 'published', 1), topic('PRIVATE-inject', 'draft', 2)], items: [{ ...item('unsafe', 'inject', 'external_link'), url: 'javascript:alert(1)' }, item('PRIVATE-row', 'inject', 'text', 'archived'), item('PRIVATE-parent', 'PRIVATE-inject', 'text')] }) }), { times: 1 });
   await refresh(); await expect(topics).toHaveCount(0); await expect(catalog.getByRole('status')).toHaveText('There are no published resources yet.');
   expect(await catalog.innerText()).not.toContain('PRIVATE-'); await refresh(); await expect(topics).toHaveCount(2);
 });
 if (referenceDir) await step('Read-only production reference: all five current forms and nine guide names match in three languages', async () => {
   const content = JSON.parse(await readFile(path.join(referenceDir, 'production-content.txt'), 'utf8'));
   const definitions = JSON.parse(await readFile('data/content-slots.json', 'utf8')).slots;
   for (const [lang, locale] of [['en', 'en'], ['zhTW', 'zhHant'], ['zhCN', 'zhHans']]) {
     await language(lang);
     for (const original of reference.items) {
       const node = row(original.id); await expect(node.getByRole('link')).toContainText(original.title[locale] || original.title.en);
       await expect(node.getByRole('link')).toHaveAttribute('href', original.url);
       await expect(node.locator('p')).toHaveText(original.description[locale] || original.description.en);
     }
     for (let n = 1; n <= 9; n++) {
       const key = 'resources.res' + n;
       const live = content.locales[locale].pages['/resources']?.[key] ?? definitions.find(slot => slot.page === '/resources' && slot.key === key).values[locale];
       await expect(page.locator(`[data-resource-legacy-guides] [data-editable-content="${key}"]`)).toHaveText(live);
     }
   }
 });
 expect(errors).toEqual([]);
 if (onlyGroup && passed === 0) throw new Error('No workflow matched --group');
 console.log(`Checkpoints 4–5: ${passed} public workflow groups passed; no production writes.`);
} catch (error) {
 if (page) { await page.screenshot({ path: 'output/playwright/resource-public-failure.png', fullPage: true }); console.error((await page.locator('body').innerText()).slice(-5500)); }
 console.error(logs.slice(-4000)); throw error;
} finally { await browser?.close(); child.kill(); }
