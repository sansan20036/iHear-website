// CP5: real built homepage, disposable file store, real Resources mutations.
// Response-body gates and DOM faults control races at browser boundaries only.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';
import { encode } from 'next-auth/jwt';
import sharp from 'sharp';
import { initialResourceTopics, validateResourceDocument } from '../lib/resource-topic-model.ts';
import { RESOURCE_SEEDS } from '../lib/resource-seed.ts';

const origin = 'http://localhost:3222', secret = 'cp5-disposable-browser-secret';
const output = path.resolve('output/playwright/cp5-home-quick-cards');
await mkdir(output, { recursive: true });
// Windows/OneDrive can hold the target open during atomic rename. Keep this
// disposable mutable store in OS temp; all reviewable evidence stays in output.
const directory = await mkdtemp(path.join(tmpdir(), 'ihear-cp5-cards-'));
const localized = (en = '', zhHant = '', zhHans = '') => ({ en, zhHant, zhHans });
const meta = { version: 1, createdAt: '2026-10-07T00:00:00.000Z', updatedAt: '2026-10-07T00:00:00.000Z', createdBy: 'isolated-fixture', updatedBy: 'isolated-fixture', states: [] };
const fixtureItem = (id, topicId, sortOrder, type = 'text', status = 'published') => ({ ...meta, id, topicId, sortOrder, type, status, category: 'form', title: localized(id), description: localized(`Summary for ${id}`), url: type === 'external_link' ? 'https://example.org/isolated-resource' : '' });
const document = { schemaVersion: 2, legacyGuidesMigrated: false, topics: initialResourceTopics(), items: [
  ...RESOURCE_SEEDS.map(item => ({ ...meta, ...item, topicId: 'forms', type: 'external_link' })),
  fixtureItem('announcement-b', 'announcements', 10, 'email_request'), fixtureItem('announcement-a', 'announcements', 10, 'external_link'),
  fixtureItem('announcement-later', 'announcements', 30), fixtureItem('announcement-draft', 'announcements', 0, 'text', 'draft'),
  fixtureItem('calendar-b', 'calendar', 20), fixtureItem('calendar-a', 'calendar', 10),
] };
validateResourceDocument(document);
await writeFile(path.join(directory, 'resource-links.json'), JSON.stringify(document));
const results = { origin, storeMode: 'file', isolatedDataDirectory: directory, buildId: (await readFile('.next/BUILD_ID', 'utf8')).trim(), cases: [], screenshots: [], status: 'running' };
const save = () => writeFile(path.join(output, 'results.json'), JSON.stringify(results, null, 2));
const owners = Array.from({ length: 18 }, (_, index) => `cp5-case-${index + 1}@example.com`);
const child = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '--hostname', 'localhost', '--port', '3222'], {
  env: { ...process.env, NODE_ENV: 'production', VERCEL: '', NETLIFY: '', CONTEXT: '', IHEAR_FORCE_FILE_STORE: '1', IHEAR_TEST_DATA_DIR: directory,
    DATABASE_URL: '', POSTGRES_URL: '', SUPABASE_URL: '', SUPABASE_SERVICE_ROLE_KEY: '', AUTH_SECRET: secret,
    AUTH_OWNER_EMAILS: owners.join(','), AUTH_URL: origin, AUTH_TRUST_HOST: 'true' },
  windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
});
let logs = '', browser, admin, visitors, page, firstBanner, secondBanner;
child.stdout.on('data', chunk => { logs += chunk; }); child.stderr.on('data', chunk => { logs += chunk; });
const pause = ms => new Promise(resolve => { setTimeout(resolve, ms); });
const cards = () => page.locator('[data-home-quick-cards]');
const card = name => page.locator(`[data-home-${name}]`);
const title = name => card(name).locator('[data-home-card-title]');
const summary = name => card(name).locator('[data-home-card-summary]');
const link = name => card(name).locator('[data-home-card-link]');
const retry = name => card(name).locator('[data-home-card-retry]');
const banner = () => page.locator('[data-home-banner]');
const both = async state => { for (const name of ['announcements', 'calendar']) await expect(card(name)).toHaveAttribute('data-state', state); };
const calls = () => page.evaluate(() => window.__cp5.calls.length);
const signal = () => page.evaluate(() => { const channel = new BroadcastChannel('ihear-resources'); channel.postMessage('updated'); channel.close(); });
const refresh = () => page.evaluate(() => { void window.iHearHomeQuickCards.refresh(); });
const fresh = () => expect(cards()).toHaveAttribute('data-refresh-state', 'fresh');
const stale = () => expect(cards()).toHaveAttribute('data-refresh-state', 'stale');
const privateSnapshot = async () => {
  const response = await admin.request.get(`${origin}/api/resources?admin=1`); expect(response.status()).toBe(200); return response.json();
};
const publicSnapshot = async () => {
  const response = await admin.request.get(`${origin}/api/resources`); expect(response.status()).toBe(200);
  expect(response.headers()['cache-control']).toBe('no-store'); expect(response.headers()['vercel-cdn-cache-control']).toBe('no-store'); return response.json();
};
async function patchItem(id, patch) {
  const previous = (await privateSnapshot()).items.find(item => item.id === id);
  const response = await admin.request.patch(`${origin}/api/resources/${id}`, { headers: { Origin: origin }, data: { version: previous.version, ...patch } });
  expect(response.status(), await response.text()).toBe(200); return (await response.json()).item;
}
async function patchTopic(id, patch) {
  const previous = (await privateSnapshot()).topics.find(item => item.id === id);
  const response = await admin.request.patch(`${origin}/api/resource-topics/${id}`, { headers: { Origin: origin }, data: { version: previous.version, ...patch } });
  expect(response.status(), await response.text()).toBe(200); return (await response.json()).topic;
}
async function resetPublic() {
  for (const id of ['announcements', 'calendar']) await patchTopic(id, { status: 'published' });
  for (const item of document.items.filter(item => ['announcements', 'calendar'].includes(item.topicId))) {
    await patchItem(item.id, { title: item.title, description: item.description, topicId: item.topicId, sortOrder: item.sortOrder, status: item.status });
  }
}
async function run(name, fn) {
  const email = `cp5-case-${Number(name.slice(0, 2))}@example.com`;
  const token = await encode({ secret, salt: 'authjs.session-token', token: { name: 'CP5 isolated case', email, sub: email } });
  await admin.addCookies([{ name: 'authjs.session-token', value: token, url: origin, httpOnly: true, sameSite: 'Lax' }]);
  const started = Date.now();
  try { await fn(); results.cases.push({ name, status: 'passed', milliseconds: Date.now() - started }); console.log(`PASS ${name}`); }
  catch (error) { results.cases.push({ name, status: 'failed', milliseconds: Date.now() - started, error: error.stack }); throw error; }
  finally { await save(); }
}
async function newPage(options = {}) {
  await visitors?.close();
  visitors = await browser.newContext({ viewport: { width: 1280, height: 1000 }, locale: 'en-US', ...options });
  page = await visitors.newPage(); page.setDefaultTimeout(12_000);
  await page.addInitScript(() => {
    const nativeFetch = window.fetch.bind(window);
    const probe = window.__cp5 = { calls: [], active: 0, maximum: 0, holdBody: false, bodies: [], pageShows: [], errors: [], revisionCalls: 0 };
    addEventListener('pageshow', event => { probe.pageShows.push({ persisted: event.persisted }); });
    addEventListener('error', event => probe.errors.push(String(event.message)));
    window.fetch = async (input, options = {}) => {
      const url = new URL(typeof input === 'string' ? input : input.url, location.href);
      if (url.pathname === '/api/live-revisions') probe.revisionCalls++;
      if (url.pathname !== '/api/resources') return nativeFetch(input, options);
      const record = { url: url.href, time: Date.now(), cache: options.cache, aborted: false, finished: false };
      probe.calls.push(record); probe.active++; probe.maximum = Math.max(probe.maximum, probe.active);
      const finish = () => { if (!record.finished) { record.finished = true; probe.active--; } };
      options.signal?.addEventListener('abort', () => { record.aborted = true; finish(); }, { once: true });
      try {
        const response = await nativeFetch(input, options), json = response.json.bind(response); record.status = response.status;
        response.json = async () => {
          try {
            const value = await json(); record.response = value;
            if (probe.holdBody) return await new Promise(resolve => { probe.bodies.push({ resolve, value, record }); });
            return value;
          } finally { finish(); }
        };
        if (!response.ok) finish();
        return response;
      } catch (error) { record.error = String(error); finish(); throw error; }
    };
  });
}
async function open() { await page.goto(origin, { waitUntil: 'domcontentloaded' }); await expect(cards()).toHaveAttribute('data-cards-controller', 'ready'); }
async function screenshot(name) { const file = path.join(output, name); await page.locator('[data-home-focus]').screenshot({ path: file }); results.screenshots.push(file); }
async function responseWith(payload, status = 200) { await page.route('**/api/resources', route => route.fulfill({ status, contentType: 'application/json', body: typeof payload === 'string' ? payload : JSON.stringify(payload) })); }
async function removeRoute() { await page.unroute('**/api/resources'); }
function remappedSnapshot() {
  const topic = (id, slug) => ({ id, slug, title: localized(slug), description: localized(''), sortOrder: 1 });
  const item = (id, topicId, order, type = 'text') => ({ id, topicId, type, category: 'article', title: localized(id), description: localized(''), sortOrder: order, url: type === 'external_link' ? 'https://example.org/not-the-card-cta' : '' });
  return { guidesTakeover: 'legacy', topics: [topic('actual-topic-91', 'announcements'), topic('actual-topic-73', 'calendar')], items: [item('z-last', 'actual-topic-91', 20), item('b-tie', 'actual-topic-91', 1, 'email_request'), item('a-tie', 'actual-topic-91', 1, 'external_link'), item('calendar-first', 'actual-topic-73', 0)] };
}
async function seedBanner() {
  const current = async () => {
    const response = await admin.request.get(`${origin}/api/media-galleries?admin=1`);
    expect(response.status()).toBe(200); return (await response.json()).items.find(item => item.id === 'home-banner');
  };
  for (const item of (await current()).items) {
    const response = await admin.request.post(`${origin}/api/media-galleries/home-banner`, { headers: { Origin: origin }, data: { operationId: randomUUID(), expectedVersion: (await current()).version, action: 'remove', itemId: item.id } });
    expect(response.status(), await response.text()).toBe(200);
  }
  const bytes = await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="800" height="450"><rect width="800" height="450" fill="#157e72"/></svg>')).webp().toBuffer();
  for (const name of ['CP5 Banner first', 'CP5 Banner second']) {
    const response = await admin.request.get(`${origin}/api/media-galleries?admin=1`);
    const gallery = (await response.json()).items.find(item => item.id === 'home-banner'), id = randomUUID();
    const metadata = { operationId: id, expectedVersion: gallery.version, action: 'put', item: { id, kind: 'photo', hidden: false, title: localized(name), caption: localized('Banner remains independent.', '橫幅保持獨立。', '横幅保持独立。') }, alt: localized('Isolated green photo', '隔離測試綠色照片', '隔离测试绿色照片') };
    const saved = await admin.request.post(`${origin}/api/media-galleries/home-banner`, { headers: { Origin: origin }, multipart: { metadata: JSON.stringify(metadata), file: { name: 'cp5.webp', mimeType: 'image/webp', buffer: bytes } } });
    expect(saved.status(), await saved.text()).toBe(200); if (!firstBanner) firstBanner = id; else secondBanner = id;
  }
}

try {
  let ready = false;
  for (let index = 0; index < 100; index++) {
    if (child.exitCode !== null) throw new Error(`Server exited: ${logs.slice(-3000)}`);
    try { if ((await fetch(`${origin}/api/resources`)).ok) { ready = true; break; } } catch { /* startup */ }
    await pause(500);
  }
  if (!ready) throw new Error('Isolated production server did not start');
  browser = await chromium.launch({ headless: true, ignoreDefaultArgs: ['--disable-back-forward-cache'] }); results.browser = browser.version();
  admin = await browser.newContext();

  await run('01 one complete public request, loading without false empty, and no-JS basic links', async () => {
    const data = await publicSnapshot(); expect(data.guidesTakeover).toBe('legacy');
    expect(data.topics.some(topic => topic.slug === 'announcements')).toBe(false);
    await seedBanner(); await newPage(); await page.addInitScript(() => { window.__cp5.holdBody = true; });
    await open(); await expect.poll(() => page.evaluate(() => window.__cp5.bodies.length)).toBe(1);
    await both('loading'); expect(await calls()).toBe(1);
    expect(await page.evaluate(() => window.__cp5.calls[0].cache)).toBe('no-store');
    for (const name of ['announcements', 'calendar']) { await expect(card(name).locator('[data-home-card-skeleton]')).toBeVisible(); await expect(link(name)).toHaveAttribute('href', '/resources'); }
    await screenshot('loading-desktop.png');
    await page.evaluate(() => { window.__cp5.holdBody = false; const body = window.__cp5.bodies[0]; body.resolve(body.value); }); await both('empty'); await fresh();
    const noJs = await browser.newContext({ javaScriptEnabled: false, locale: 'zh-TW', viewport: { width: 390, height: 950 } });
    const target = await noJs.newPage(); await target.goto(origin);
    for (const name of ['announcements', 'calendar']) await expect(target.locator(`[data-home-${name}] [data-home-card-link]`)).toHaveAttribute('href', '/resources');
    const tutorLinks = await target.locator('[data-home-tutors] a').evaluateAll(nodes => nodes.map(node => node.getAttribute('href')));
    expect(tutorLinks.length).toBeGreaterThanOrEqual(2); expect(tutorLinks).not.toContain('#');
    const file = path.join(output, 'no-js-mobile.png'); await target.locator('[data-home-focus]').screenshot({ path: file }); results.screenshots.push(file); await noJs.close();
    results.initial = { publicRequests: 1, storedFalseMarker: true, projectedTakeover: data.guidesTakeover, tutorLinks };
  });

  await run('02 real publication maps fixed slugs, selects sortOrder then ID, and preserves category CTA', async () => {
    await resetPublic(); await newPage(); await open(); await both('ready'); await fresh();
    await expect(title('announcements')).toHaveText('announcement-a'); await expect(title('calendar')).toHaveText('calendar-a');
    await expect(link('announcements')).toHaveAttribute('href', '/resources#announcements'); await expect(link('calendar')).toHaveAttribute('href', '/resources#calendar');
    const publicData = await publicSnapshot(); expect(JSON.stringify(publicData)).not.toContain('announcement-draft'); expect(publicData.items.every(item => !('status' in item))).toBe(true);
    expect(await calls()).toBe(1); await screenshot('ready-desktop.png');
    for (const slug of ['announcements', 'calendar']) {
      await link(slug).click(); await expect(page).toHaveURL(`${origin}/resources#${slug}`);
      const destination = page.locator(`[data-resource-slug="${slug}"]`); await expect(destination).toBeVisible();
      await expect(destination.locator('h2')).toBeFocused(); await page.goBack(); await both('ready'); await fresh();
    }
    await patchItem('announcement-a', { description: localized('') }); await signal(); await expect(summary('announcements')).toBeHidden();
    expect(await card('announcements').innerText()).not.toContain('https://example.org');
    results.mapping = publicData.topics.filter(topic => ['announcements', 'calendar'].includes(topic.slug)).map(({ id, slug }) => ({ id, slug }));
  });

  await run('03 published moves and withdrawals replace cards; hidden topic and item become empty without writes', async () => {
    await resetPublic(); await newPage(); await open(); await both('ready');
    await patchItem('announcement-a', { status: 'draft' }); await signal(); await expect(title('announcements')).toHaveText('announcement-b');
    await patchItem('calendar-a', { topicId: 'announcements', sortOrder: 0 }); await signal(); await expect(title('announcements')).toHaveText('calendar-a'); await expect(title('calendar')).toHaveText('calendar-b');
    await patchTopic('announcements', { status: 'draft' }); await signal(); await expect(card('announcements')).toHaveAttribute('data-state', 'empty'); await expect(link('announcements')).toHaveAttribute('href', '/resources');
    expect(await card('announcements').textContent()).not.toContain('calendar-a'); await expect(card('calendar')).toHaveAttribute('data-state', 'ready');
    await patchItem('calendar-b', { status: 'draft' }); await signal(); await both('empty');
    const source = await privateSnapshot(); expect(source.topics.filter(topic => topic.slug === 'announcements')).toHaveLength(1); expect(source.topics.find(topic => topic.id === 'announcements').status).toBe('draft');
    await screenshot('empty-desktop.png');
  });

  await run('04 actual topic IDs, stable tied order, complete takeover, and valid omitted topics', async () => {
    const payload = remappedSnapshot(); await newPage(); await responseWith(payload); await open(); await both('ready');
    await expect(title('announcements')).toHaveText('a-tie'); await expect(card('announcements')).toHaveAttribute('data-topic-id', 'actual-topic-91');
    await expect(title('calendar')).toHaveText('calendar-first'); await expect(link('announcements')).toHaveAttribute('href', '/resources#announcements');
    await removeRoute(); await responseWith({ ...payload, guidesTakeover: 'complete' }); await refresh(); await fresh(); await both('ready');
    await removeRoute(); await responseWith({ items: [], topics: [], guidesTakeover: 'complete' }); await refresh(); await both('empty');
    results.remappedIds = { announcements: 'actual-topic-91', calendar: 'actual-topic-73', tiedWinner: 'a-tie', completeAccepted: true, omittedTopicsEmpty: true };
  });

  await run('05 invalid whole snapshots and 503 are errors with retry; false API value is distinct from stored false marker', async () => {
    const payload = remappedSnapshot();
    const faults = [
      { label: '503', status: 503, body: { error: 'offline' } }, { label: 'invalid-json', body: '{invalid' },
      { label: 'missing-takeover', body: { items: [], topics: [] } }, { label: 'boolean-false-api', body: { ...payload, guidesTakeover: false } },
      { label: 'duplicate-fixed-slug', body: { ...payload, topics: [...payload.topics, { ...payload.topics[0], id: 'another-topic' }] } },
      { label: 'dangling-item-topic', body: { ...payload, items: [{ ...payload.items[0], topicId: 'unknown-topic' }] } },
      { label: 'missing-language-field', body: { ...payload, items: [{ ...payload.items[0], title: { en: 'invalid' } }] } },
    ];
    for (const fault of faults) {
      await newPage(); await responseWith(fault.body, fault.status || 200); await open(); await both('error');
      for (const name of ['announcements', 'calendar']) { await expect(retry(name)).toBeVisible(); await expect(link(name)).toHaveAttribute('href', '/resources'); }
      await expect(page.locator('[data-home-tutors] a').first()).toBeVisible();
    }
    await screenshot('initial-error-desktop.png'); await removeRoute(); await responseWith(payload); await retry('announcements').click(); await both('ready'); await fresh();
    results.invalidResponses = faults.map(fault => fault.label);
  });

  await run('06 ready and empty survive failed background reads independently from operable Banner', async () => {
    await resetPublic(); await newPage(); await open(); await both('ready'); await fresh();
    await page.locator('[data-home-banner-next]').click(); await expect(banner()).toHaveAttribute('data-active-id', secondBanner);
    await responseWith({ error: 'isolated Resources outage' }, 503); await refresh(); await stale(); await both('ready');
    await expect(title('announcements')).toHaveText('announcement-a'); await expect(banner()).toHaveAttribute('data-active-id', secondBanner);
    await page.locator('[data-home-banner-next]').click(); await expect(banner()).toHaveAttribute('data-active-id', firstBanner);
    await removeRoute(); await responseWith({ items: [], topics: [], guidesTakeover: 'legacy' }); await refresh(); await both('empty');
    await removeRoute(); await responseWith('{invalid'); await refresh(); await stale(); await both('empty');
    expect(await cards().textContent()).not.toContain('announcement-a'); await page.setViewportSize({ width: 390, height: 1000 }); await screenshot('empty-stale-mobile.png');
    results.isolation = { readyRetainedOnFailure: true, emptyRetainedOnFailure: true, bannerInteractiveDuringFailure: true };
  });

  await run('07 notification during real body wait causes exactly one pending read without concurrent requests', async () => {
    await resetPublic(); await newPage(); await open(); await fresh();
    await page.evaluate(() => { window.__cp5.holdBody = true; }); const before = await calls(); await refresh();
    await expect.poll(() => page.evaluate(() => window.__cp5.bodies.length)).toBe(1);
    await patchItem('announcement-a', { title: localized('Newer than held response') });
    await page.evaluate(() => { for (let i = 0; i < 25; i++) void window.iHearHomeQuickCards.refresh(); }); await signal(); await pause(100); expect(await calls()).toBe(before + 1);
    await page.evaluate(() => { window.__cp5.holdBody = false; const body = window.__cp5.bodies[0]; body.resolve(body.value); });
    await expect(title('announcements')).toHaveText('Newer than held response'); await fresh(); expect(await calls()).toBe(before + 2);
    expect(await page.evaluate(() => window.__cp5.maximum)).toBe(1); results.pending = { denseSignals: 26, reads: 2, maximumInFlight: 1 };
  });

  await run('08 five-second body deadline recovers; late body and old cleanup cannot replace new empty or unlock request', async () => {
    await resetPublic(); await newPage(); await page.clock.install(); await open(); await fresh();
    await page.evaluate(() => { window.__cp5.holdBody = true; }); await refresh(); await expect.poll(() => page.evaluate(() => window.__cp5.bodies.length)).toBe(1);
    await page.clock.runFor(5100); await stale(); expect(await page.evaluate(() => window.__cp5.bodies[0].record.aborted)).toBe(true);
    await patchTopic('announcements', { status: 'draft' }); await patchTopic('calendar', { status: 'draft' });
    await refresh(); await expect.poll(() => page.evaluate(() => window.__cp5.bodies.length)).toBe(2); const before = await calls();
    await page.evaluate(() => { const old = window.__cp5.bodies[0]; old.resolve(old.value); }); await signal(); await pause(100); expect(await calls()).toBe(before);
    await page.evaluate(() => { window.__cp5.holdBody = false; const current = window.__cp5.bodies[1]; current.resolve(current.value); });
    await both('empty'); await fresh(); expect(await calls()).toBe(before + 1); expect(await cards().textContent()).not.toContain('announcement-a');
    results.timeout = { bodyIncluded: true, abortObserved: true, recovery: 'empty', oldFinallyKeptNewLock: true, lateBodyIgnored: true };
  });

  await run('09 ten-second initial loading ceiling cannot be extended by repeated lifecycle cancellation', async () => {
    await newPage(); await page.clock.install(); await page.addInitScript(() => { window.__cp5.holdBody = true; }); await open();
    await expect.poll(() => page.evaluate(() => window.__cp5.bodies.length)).toBe(1); await both('loading');
    for (let i = 0; i < 3; i++) {
      await page.clock.runFor(3100); await page.evaluate(() => { dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })); dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })); });
      await expect.poll(() => page.evaluate(() => window.__cp5.bodies.length)).toBe(i + 2);
    }
    await page.clock.runFor(800); await both('error'); await expect(retry('announcements')).toBeVisible();
    results.initialDeadline = { milliseconds: 10100, repeatedLifecycleRestarts: 3, skeletonStillVisible: false, syntheticEvents: true };
  });

  await run('10 cross-tab resource broadcast and structured content bridge work while revision responses stay fixed', async () => {
    await resetPublic(); await newPage(); await open(); await fresh();
    const revisionBefore = await (await admin.request.get(`${origin}/api/live-revisions`)).json();
    // Unlike media file writes, resourceSaved calls revisionAfterMutation even
    // in file mode. Freeze only this browser's revision responses to verify
    // direct notifications independently, while keeping real mutations intact.
    await page.route('**/api/live-revisions', route => route.fulfill({ json: revisionBefore }));
    const other = await visitors.newPage(); await other.goto(`${origin}/about`); await page.bringToFront();
    await patchItem('announcement-a', { title: localized('Cross-tab Resources update') });
    await other.evaluate(() => { const channel = new BroadcastChannel('ihear-resources'); channel.postMessage('updated'); channel.close(); }); await expect(title('announcements')).toHaveText('Cross-tab Resources update');
    await patchItem('announcement-a', { title: localized('Cross-tab structured content update') }); await other.evaluate(() => window.iHearLiveContent.announce('content', 'cp5-cross-tab')); await expect(title('announcements')).toHaveText('Cross-tab structured content update');
    await patchItem('announcement-a', { title: localized('Same-page content update') }); await page.evaluate(() => window.iHearLiveContent.announce('content', 'cp5-same-page')); await expect(title('announcements')).toHaveText('Same-page content update');
    const revisionAfter = await (await admin.request.get(`${origin}/api/live-revisions`)).json(); expect(Number(revisionAfter.revisions.content.revision)).toBe(Number(revisionBefore.revisions.content.revision) + 3);
    await other.close(); results.notifications = { stringBroadcast: true, crossTabContent: true, samePageContent: true, browserRevisionResponsesFixed: true, realFileStoreRevisionBefore: revisionBefore.revisions.content.revision, realFileStoreRevisionAfter: revisionAfter.revisions.content.revision };
  });

  await run('11 existing shared ten-second revision baseline plus one fifteen-second Resources timer', async () => {
    await resetPublic(); await newPage(); await page.clock.install(); let checks = 0, revision = 'baseline-a';
    await page.route('**/api/live-revisions', route => { checks++; return route.fulfill({ json: { version: 1, revisions: { content: { revision } } } }); });
    await open(); await fresh(); await expect.poll(() => checks).toBe(1); expect(await calls()).toBe(1);
    await page.clock.runFor(10000); await expect.poll(() => checks).toBe(2); expect(await calls()).toBe(1);
    await patchItem('announcement-a', { title: localized('Visible fifteen-second refresh') }); await page.clock.runFor(5000); await expect(title('announcements')).toHaveText('Visible fifteen-second refresh'); expect(await calls()).toBe(2);
    revision = 'baseline-b'; await page.clock.runFor(5000); await expect.poll(() => checks).toBe(3); await expect.poll(calls).toBe(3);
    await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')); }); const before = await calls(); await page.clock.runFor(30000); expect(await calls()).toBe(before);
    await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: false }); document.dispatchEvent(new Event('visibilitychange')); }); await expect.poll(calls).toBeGreaterThan(before); await fresh();
    const onlineBefore = await calls(); await page.evaluate(() => dispatchEvent(new Event('online'))); await expect.poll(calls).toBe(onlineBefore + 1); await fresh();
    results.polling = { firstBaselineDidNotReplaceInitialRead: true, revisionMilliseconds: 10000, resourcesMilliseconds: 15000, noHiddenPoll: true, visibilityAndOnlineCalibrate: true, visibilityBoundary: 'Synthetic document.hidden plus visibilitychange, actual shipped schedules.' };
  });

  await run('12 language at late response time, safe excerpts, long copy, keyboard focus and responsive cards', async () => {
    await resetPublic(); const special = '</script><img src=x onerror="window.__cp5Injected=1"> & quotes';
    // Keep the real translation guard: save English without translations first,
    // then make explicit manual Chinese edits with unchanged English. No cloud
    // translator, fabricated receipt or guard bypass is needed for local data.
    for (const [id, fields] of [
      ['announcement-a', { title: localized(special, '', '简体公告'), description: localized('English fallback description. '.repeat(15), '', '简体说明。'.repeat(60)) }],
      ['calendar-a', { title: localized('Calendar title '.repeat(13), '活動標題'.repeat(45), '活动标题'.repeat(45)), description: localized('Long summary '.repeat(30), '活動摘要'.repeat(120), '活动摘要'.repeat(120)) }],
    ]) {
      await patchItem(id, Object.fromEntries(Object.entries(fields).map(([field, value]) => [field, localized(value.en)])));
      await patchItem(id, fields);
    }
    await newPage(); await open(); await both('ready'); await fresh(); await link('calendar').focus();
    await page.evaluate(() => { window.__cp5.holdBody = true; }); await refresh(); await expect.poll(() => page.evaluate(() => window.__cp5.bodies.length)).toBe(1);
    await page.evaluate(() => window.iHearSetLanguage('zhTW')); await expect(link('calendar')).toBeFocused();
    await page.evaluate(() => { window.__cp5.holdBody = false; const held = window.__cp5.bodies[0]; held.resolve(held.value); }); await fresh();
    await expect(title('announcements')).toHaveText(special); await expect(title('calendar')).toHaveText('活動標題'.repeat(45)); await expect(link('calendar')).toBeFocused();
    expect(await page.evaluate(() => window.__cp5Injected)).toBeUndefined(); await expect(card('announcements').locator('img,script')).toHaveCount(0);
    const original = await privateSnapshot(); expect(original.items.find(item => item.id === 'announcement-a').title.zhHant).toBe('');
    const expectedCards = await publicSnapshot();
    const expectedBanner = (await (await admin.request.get(`${origin}/api/media-galleries?gallery_id=home-banner`)).json()).items[0].items.find(item => item.id === firstBanner);
    results.layouts = []; results.renderedLanguages = [];
    for (const [lang, htmlLang] of [['en', 'en'], ['zhTW', 'zh-Hant'], ['zhCN', 'zh-Hans']]) {
      await page.evaluate(value => window.iHearSetLanguage(value), lang); await expect(page.locator('html')).toHaveAttribute('lang', htmlLang);
      const locale = { en: 'en', zhTW: 'zhHant', zhCN: 'zhHans' }[lang];
      const translated = values => values[locale].trim() ? values[locale] : values.en;
      for (const [name, id] of [['announcements', 'announcement-a'], ['calendar', 'calendar-a']]) {
        const source = expectedCards.items.find(item => item.id === id);
        const description = Array.from(translated(source.description).replace(/\s+/g, ' ').trim());
        await expect(title(name)).toHaveText(translated(source.title));
        await expect(summary(name)).toHaveText(description.slice(0, 160).join('') + (description.length > 160 ? '…' : ''));
      }
      await expect(page.locator('[data-home-banner-field="caption"]')).toHaveText(translated(expectedBanner.caption));
      results.renderedLanguages.push({ locale, announcement: await title('announcements').textContent(), calendar: await title('calendar').textContent(), bannerCaption: await page.locator('[data-home-banner-field="caption"]').textContent() });
      for (const width of [320, 390, 767, 768, 1023, 1024, 1280]) {
        await page.setViewportSize({ width, height: 1000 });
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${lang}/${width} no horizontal overflow`).toBe(true);
        const boxes = await Promise.all(['announcements', 'calendar', 'tutors'].map(name => card(name).boundingBox()));
        for (const name of ['announcements', 'calendar']) { const outer = await card(name).boundingBox(), cta = await link(name).boundingBox(); expect(cta.y + cta.height).toBeLessThanOrEqual(outer.y + outer.height + 1); }
        results.layouts.push({ language: lang, width, boxes });
        if ([320, 768, 1024, 1280].includes(width)) await screenshot(`cards-${lang}-${width}.png`);
      }
    }
    await page.setViewportSize({ width: 1280, height: 1000 }); await link('announcements').focus(); await refresh(); await fresh(); await expect(link('announcements')).toBeFocused();
    await page.keyboard.press('Tab'); await expect(link('calendar')).toBeFocused();
    results.language = { missingTranslationNotWrittenBack: true, lateResponseUsesCurrentLanguage: true, safeText: true, screenReaderTested: false, keyboardAndSemanticsOnly: true };
  });

  await run('13 one card DOM rendering fault does not block sibling or retain withdrawn text', async () => {
    await resetPublic(); await newPage(); await open(); await both('ready'); await fresh();
    await page.evaluate(() => {
      const descriptor = Object.getOwnPropertyDescriptor(Node.prototype, 'textContent'); let fired = false;
      Object.defineProperty(Node.prototype, 'textContent', { ...descriptor, set(value) {
        if (!fired && this instanceof Element && this.matches('[data-home-announcements] [data-home-card-title]') && value === 'Replacement announcement') { fired = true; throw new Error('Isolated one-card DOM write failure'); }
        descriptor.set.call(this, value);
      } });
    });
    await patchItem('announcement-a', { title: localized('Replacement announcement') }); await patchItem('calendar-a', { title: localized('Sibling still updates') }); await signal();
    await expect(card('announcements')).toHaveAttribute('data-state', 'error'); await expect(title('calendar')).toHaveText('Sibling still updates');
    expect(await card('announcements').textContent()).not.toContain('announcement-a'); await expect(link('announcements')).toHaveAttribute('href', '/resources');
    await screenshot('one-card-error-desktop.png'); await retry('announcements').click(); await both('ready'); await expect(title('announcements')).toHaveText('Replacement announcement');
    results.renderIsolation = { fault: 'One native textContent write throws once, only in announcement title', siblingUpdated: true, oldTextRemoved: true, retryRecovered: true };
  });

  await run('14 suspended response and repeated return do not overwrite latest data or duplicate subscriptions', async () => {
    await resetPublic(); await newPage(); await open(); await fresh(); await page.evaluate(() => { window.__cp5.holdBody = true; }); await refresh();
    await expect.poll(() => page.evaluate(() => window.__cp5.bodies.length)).toBe(1);
    await page.evaluate(() => dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }))); expect(await page.evaluate(() => window.__cp5.bodies[0].record.aborted)).toBe(true);
    await patchItem('announcement-a', { title: localized('Accepted after return') }); await page.evaluate(() => dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
    await expect.poll(() => page.evaluate(() => window.__cp5.bodies.length)).toBe(2); const before = await calls();
    await page.evaluate(() => { const old = window.__cp5.bodies[0]; old.resolve(old.value); }); await signal(); await pause(100); expect(await calls()).toBe(before);
    await page.evaluate(() => { window.__cp5.holdBody = false; const current = window.__cp5.bodies[1]; current.resolve(current.value); }); await expect(title('announcements')).toHaveText('Accepted after return'); await fresh();
    for (let i = 0; i < 3; i++) { await page.evaluate(() => { dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })); dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })); }); await fresh(); }
    const settled = await calls(); await signal(); await expect.poll(calls).toBe(settled + 1); await fresh(); await pause(150); expect(await calls()).toBe(settled + 1);
    const src = await page.locator('script[src*="home-quick-cards"]').getAttribute('src'); expect(src).toBeTruthy();
    await page.addScriptTag({ url: src }); const duplicate = await calls(); await signal(); await expect.poll(calls).toBe(duplicate + 1); await fresh();
    results.lifecycle = { syntheticPersistedEvents: true, oldBodyIgnored: true, resumedLockPreserved: true, repeatedReturns: 3, duplicateScriptInitializationIgnored: true };
  });

  await run('15 actual Resources tutor destinations, compatible full catalog types, and reserved slug allocation', async () => {
    await resetPublic(); await newPage(); await open(); await both('ready');
    const tutorLinks = await card('tutors').locator('a').evaluateAll(nodes => nodes.map(node => ({ href: node.getAttribute('href'), name: node.textContent.trim() })));
    results.tutorDestinations = tutorLinks;
    for (const entry of tutorLinks) {
      const url = new URL(entry.href, origin); expect(url.origin).toBe(origin); expect(url.pathname).toBe('/resources');
      await page.goto(url.href); const fragment = decodeURIComponent(url.hash.slice(1));
      const target = page.locator(`[id="${fragment}"]`); await expect(target).toBeVisible(); expect(await target.textContent()).not.toBe('');
    }
    await page.goto(`${origin}/resources#announcements`); await expect(page.locator('[data-resource-item="announcement-a"] a')).toHaveAttribute('href', 'https://example.org/isolated-resource');
    await expect(page.locator('[data-resource-item="announcement-b"] a')).toHaveAttribute('href', /^mailto:ihearprogram@gmail\.com\?subject=/);
    await expect(page.locator('[data-resource-item="announcement-later"] a, [data-resource-item="announcement-later"] button')).toHaveCount(0);
    const prior = await privateSnapshot();
    for (const name of ['Announcements', 'Calendar']) {
      const response = await admin.request.post(`${origin}/api/resource-topics`, { headers: { Origin: origin }, data: { title: localized(name), status: 'draft' } });
      expect(response.status(), await response.text()).toBe(201); const created = (await response.json()).topic; expect(created.slug).not.toBe(name.toLowerCase());
    }
    const after = await privateSnapshot(); for (const slug of ['announcements', 'calendar']) expect(after.topics.find(topic => topic.slug === slug).id).toBe(prior.topics.find(topic => topic.slug === slug).id);
    results.slugs = { existingSeedIdsUnchanged: true, generalAllocationAvoidsFixedSlugs: true, productionMappingNotRead: true };
  });

  await run('16 real away/back navigation records actual BFCache outcome and refreshed data', async () => {
    await resetPublic(); await newPage(); await open(); await fresh(); await page.goto(`${origin}/about`);
    await patchItem('announcement-a', { title: localized('Updated while homepage was away') }); await page.goBack({ waitUntil: 'domcontentloaded' }); await expect(title('announcements')).toHaveText('Updated while homepage was away');
    const observations = await page.evaluate(() => ({ pageShows: window.__cp5.pageShows, navigation: performance.getEntriesByType('navigation').map(entry => ({ type: entry.type, notRestoredReasons: entry.notRestoredReasons?.toJSON?.() || null })) }));
    results.bfcache = { ...observations, actuallyHit: observations.pageShows.some(value => value.persisted), scope: 'Real away/back attempted; synthetic lifecycle cases are separate and do not prove BFCache restoration.' };
  });

  expect((await readFile('.next/BUILD_ID', 'utf8')).trim()).toBe(results.buildId);
  results.status = 'passed'; results.summary = { passed: results.cases.length, failed: 0, skipped: 0, exitCode: 0 }; console.log(`PASS ${results.cases.length}/${results.cases.length} CP5 production browser cases`);
} catch (error) {
  results.status = 'failed'; results.summary = { passed: results.cases.filter(value => value.status === 'passed').length, failed: 1, skipped: 0, exitCode: 1 }; results.error = error.stack;
  console.error(error); process.exitCode = 1;
  try {
    results.failureBrowser = await page?.evaluate(() => ({ url: location.href, probe: window.__cp5, cardStates: [...document.querySelectorAll('[data-home-announcements], [data-home-calendar]')].map(element => ({ ...element.dataset })), hidden: document.hidden }));
    await page?.screenshot({ path: path.join(output, 'failure.png'), fullPage: true });
  } catch { /* page may already be closed */ }
} finally {
  await save(); await writeFile(path.join(output, 'server.log'), logs); await visitors?.close(); await admin?.close(); await browser?.close(); child.kill();
}
