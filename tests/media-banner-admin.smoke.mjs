// Built Next.js application, real upload/gallery APIs, isolated file store only.
// Failure injection is limited to explicit 503/lost-response/image-error cases.
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';
import { encode } from 'next-auth/jwt';
import sharp from 'sharp';

const port = 3213;
const origin = `http://localhost:${port}`;
const secret = 'isolated-home-banner-browser-test-key-never-use-in-production';
const evidenceRoot = path.resolve('output/playwright/cp2-banner-admin');
await mkdir(evidenceRoot, { recursive: true });
const directory = await mkdtemp(path.join(evidenceRoot, 'isolated-store-'));
const results = [];
const evidence = { origin, storeMode: 'file', isolatedDataDirectory: directory, cases: results, screenshots: [], status: 'running' };
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const writeEvidence = () => writeFile(path.join(evidenceRoot, 'results.json'), JSON.stringify(evidence, null, 2));
const child = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '--hostname', 'localhost', '--port', String(port)], {
  env: {
    ...process.env, NODE_ENV: 'production', VERCEL: '', NETLIFY: '', CONTEXT: '',
    IHEAR_FORCE_FILE_STORE: '1', IHEAR_TEST_DATA_DIR: directory,
    POSTGRES_URL: '', DATABASE_URL: '', SUPABASE_URL: '', SUPABASE_SERVICE_ROLE_KEY: '',
    AUTH_SECRET: secret, AUTH_OWNER_EMAILS: 'banner-test@example.com', AUTH_URL: origin, AUTH_TRUST_HOST: 'true',
  },
  windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
});
let logs = '';
child.stdout.on('data', chunk => { logs += chunk; });
child.stderr.on('data', chunk => { logs += chunk; });
let browser, page, context;
let firstId, secondId, uploadedImage, uploadedBytes;
const emptyText = () => ({ en: '', zhHant: '', zhHans: '' });
const initialTitle = { en: 'Learning together across communities', zhHant: '一起跨越距離學習', zhHans: '一起跨越距离学习' };
const titleLabels = { en: 'Title English', zhHant: 'Title 繁體中文', zhHans: 'Title 简体中文' };
const select = () => page.locator('.admin-gallery-toolbar select');
const items = () => page.locator('.admin-media-item');
const draft = () => page.locator('.admin-media-draft');
const save = () => page.getByRole('button', { name: '儲存／重試未完成項目', exact: true });
const refresh = () => page.getByRole('button', { name: '重新讀取已儲存內容', exact: true });
const gallery = async (id = 'home-banner') => {
  const response = await context.request.get(`${origin}/api/media-galleries?admin=1`);
  expect(response.status()).toBe(200);
  const data = await response.json();
  return data.items.find(item => item.id === id);
};
const publicGallery = async () => {
  const response = await fetch(`${origin}/api/media-galleries?gallery=home-banner`);
  expect(response.status).toBe(200);
  return (await response.json()).items[0];
};
const post = (id, body) => context.request.post(`${origin}/api/media-galleries/${id}`, { headers: { Origin: origin }, data: body });
const settle = async () => { await expect(draft()).toHaveCount(0, { timeout: 30_000 }); await expect(select()).toBeEnabled(); };
const edit = async index => { await items().nth(index).getByRole('button', { name: '編輯／更換', exact: true }).click(); await expect(draft()).toHaveCount(1); };
const setTitle = async (values, scope = draft()) => {
  for (const [locale, value] of Object.entries(values)) await scope.getByLabel(titleLabels[locale], { exact: true }).fill(value);
};
async function screenshot(name) {
  const file = path.join(evidenceRoot, name);
  if (page.viewportSize().width <= 700) await expect.poll(() => page.locator('.admin-sidebar').evaluate(element => element.getBoundingClientRect().right)).toBeLessThanOrEqual(0);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: file, fullPage: true });
  evidence.screenshots.push(file);
}
async function runCase(name, fn) {
  const started = Date.now();
  try { await fn(); results.push({ name, status: 'passed', milliseconds: Date.now() - started }); }
  catch (error) { results.push({ name, status: 'failed', milliseconds: Date.now() - started, error: error.message }); throw error; }
  finally { await writeEvidence(); }
  console.log(`PASS ${name}`);
}
async function removeFirst() {
  const count = await items().count();
  await items().first().getByRole('button', { name: '移除', exact: true }).click();
  await page.getByRole('dialog', { name: '' }).filter({ has: page.getByRole('heading', { name: '移除此項目？' }) }).getByRole('button', { name: '移除', exact: true }).click();
  await expect(items()).toHaveCount(count - 1);
}
try {
  let started = false;
  for (let i = 0; i < 120; i++) {
    if (child.exitCode !== null) throw new Error(`Test server exited: ${logs.slice(-2500)}`);
    try { if ((await fetch(`${origin}/api/media-galleries`)).ok) { started = true; break; } } catch { /* local server starting */ }
    await new Promise(resolve => { setTimeout(resolve, 500); });
  }
  if (!started) throw new Error(`Test server did not start: ${logs.slice(-2500)}`);
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({ viewport: { width: 1280, height: 960 } });
  const token = await encode({ secret, salt: 'authjs.session-token', token: { name: 'Banner test', email: 'banner-test@example.com', sub: 'banner-test' } });
  await context.addCookies([{ name: 'authjs.session-token', value: token, url: origin, httpOnly: true, sameSite: 'Lax' }]);
  page = await context.newPage();
  page.setDefaultTimeout(15_000);
  await page.goto(`${origin}/admin/media?gallery=home-banner`);
  await expect(select()).toHaveValue('home-banner');
  await expect(select()).toBeEnabled();
  const initial = await gallery();
  evidence.initialBanner = initial;
  evidence.browser = await browser.version();

  // Portrait source: top red / center green / bottom blue. A wide central crop
  // visibly differs from the uncropped source, whose three bands remain intact.
  const source = await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="600" height="1000"><rect width="600" height="200" fill="#e02020"/><rect y="200" width="600" height="600" fill="#20c050"/><rect y="800" width="600" height="200" fill="#2050df"/></svg>')).png().toBuffer();
  await writeFile(path.join(evidenceRoot, 'uncropped-source.png'), source);

  await runCase('01 real photo uploads, multilingual title save and reload', async () => {
    while (await items().count()) await removeFirst();
    await expect(page.locator('.admin-empty')).toBeVisible();
    await page.getByLabel('新增照片', { exact: true }).setInputFiles([
      { name: 'center-crop-source.png', mimeType: 'image/png', buffer: source },
      { name: 'second-banner.png', mimeType: 'image/png', buffer: source },
    ]);
    await expect(draft()).toHaveCount(2);
    for (let i = 0; i < 2; i++) {
      const fields = draft().nth(i).locator('textarea:not([aria-label^="Title "])');
      await fields.nth(0).fill(`Red green blue portrait ${i + 1}`);
      await fields.nth(1).fill(`紅綠藍直式照片 ${i + 1}`);
      await fields.nth(2).fill(`红绿蓝直式照片 ${i + 1}`);
      await fields.nth(3).fill(`Caption ${i + 1}`);
      await fields.nth(4).fill(`照片說明 ${i + 1}`);
      await fields.nth(5).fill(`照片说明 ${i + 1}`);
    }
    await setTitle(initialTitle, draft().nth(0));
    await setTitle({ en: 'English only preview fallback', zhHant: '', zhHans: '' }, draft().nth(1));
    await expect(select()).toBeDisabled();
    await save().click(); await settle();
    let saved = await gallery();
    expect(saved.items).toHaveLength(2);
    [firstId, secondId] = saved.items.map(item => item.id);
    expect(saved.items[0].title).toEqual(initialTitle);
    expect(saved.items[1].title).toEqual({ en: 'English only preview fallback', zhHant: '', zhHans: '' });
    uploadedImage = saved.items[0].image;
    const image = await context.request.get(`${origin}${uploadedImage.src}`);
    expect(image.status()).toBe(200);
    uploadedBytes = await image.body();
    const metadata = await sharp(uploadedBytes).metadata();
    expect(metadata.width / metadata.height).toBeCloseTo(0.6, 2);
    const originalPixels = await sharp(uploadedBytes).raw().toBuffer({ resolveWithObject: true });
    for (const [fraction, channel] of [[0.1, 0], [0.5, 1], [0.9, 2]]) {
      const offset = (Math.floor(originalPixels.info.height * fraction) * originalPixels.info.width + Math.floor(originalPixels.info.width / 2)) * originalPixels.info.channels;
      const color = [...originalPixels.data.subarray(offset, offset + 3)];
      expect(color[channel]).toBeGreaterThan(Math.max(...color.filter((_, index) => index !== channel)) * 1.5);
    }
    await writeFile(path.join(evidenceRoot, 'uncropped-stored-variant.webp'), uploadedBytes);
    evidence.originalImage = { sourceSha256: digest(source), storedSha256: digest(uploadedBytes), width: metadata.width, height: metadata.height, image: uploadedImage };
    await page.reload(); await expect(select()).toHaveValue('home-banner'); await expect(items()).toHaveCount(2);
    saved = await gallery(); expect(saved.items[0].title).toEqual(initialTitle);
    expect(JSON.parse(await readFile(path.join(directory, 'media-galleries.json'), 'utf8')).galleries['home-banner'].items).toHaveLength(2);
  });

  await runCase('02 blank translations use English only for preview; single-locale edits preserve others', async () => {
    await page.getByLabel('Banner preview language', { exact: true }).selectOption('zhHant');
    await expect(items().nth(1).locator('.admin-banner-preview-title')).toHaveText('English only preview fallback');
    expect((await gallery()).items[1].title.zhHant).toBe('');
    expect((await gallery()).items[1].title.zhHans).toBe('');
    await edit(1);
    await expect(draft().getByLabel('Title 繁體中文', { exact: true })).toHaveValue('');
    await setTitle({ zhHant: '只新增繁體標題' });
    await save().click(); await settle();
    expect((await gallery()).items[1].title).toEqual({ en: 'English only preview fallback', zhHant: '只新增繁體標題', zhHans: '' });
    await page.reload(); await expect(items()).toHaveCount(2);
    expect((await gallery()).items[1].image).toBeDefined();
  });

  await runCase('03 explicit all-language clearing persists null; unchanged title is omitted from edit payload', async () => {
    await edit(0); await setTitle(emptyText()); await save().click(); await settle();
    expect((await gallery()).items[0].title).toBeNull();
    await page.reload(); await expect(items()).toHaveCount(2); await edit(0);
    for (const label of Object.values(titleLabels)) await expect(draft().getByLabel(label, { exact: true })).toHaveValue('');
    await setTitle(initialTitle); await save().click(); await settle();
    await edit(0);
    // The three alt fields precede the three caption fields; title has explicit labels.
    await draft().locator('textarea:not([aria-label^="Title "])').nth(4).fill('只有說明變更');
    const requestPromise = page.waitForRequest(request => request.url() === `${origin}/api/media-galleries/home-banner` && request.method() === 'POST');
    await save().click(); const request = await requestPromise; await settle();
    expect(Object.hasOwn(request.postDataJSON().item, 'title')).toBe(false);
    const saved = (await gallery()).items[0];
    expect(saved.title).toEqual(initialTitle); expect(saved.caption.zhHant).toBe('只有說明變更');
    expect(saved.image).toEqual(uploadedImage);
  });

  await runCase('04 reorder/hide preserves metadata; hidden photo editable and public filtering reversible', async () => {
    const before = await gallery();
    await items().first().getByRole('button', { name: '向後移動', exact: true }).click();
    await expect.poll(async () => (await gallery()).items[1].id).toBe(firstId);
    let saved = await gallery();
    expect(saved.items).toEqual([before.items[1], before.items[0]]);
    await items().last().getByRole('button', { name: '隱藏', exact: true }).click();
    await expect(items().last().getByRole('button', { name: '顯示', exact: true })).toBeVisible();
    saved = await gallery(); expect(saved.items[1]).toEqual({ ...before.items[0], hidden: true });
    expect((await publicGallery()).items.some(item => item.id === firstId)).toBe(false);
    await edit(1); await setTitle({ zhHans: '隐藏时仍能编辑' }); await save().click(); await settle();
    saved = await gallery();
    expect(saved.items[1].hidden).toBe(true);
    expect(saved.items[1].title).toEqual({ ...initialTitle, zhHans: '隐藏时仍能编辑' });
    expect(saved.items[1].image).toEqual(uploadedImage);
    await items().last().getByRole('button', { name: '顯示', exact: true }).click();
    await expect.poll(async () => (await publicGallery()).items.some(item => item.id === firstId)).toBe(true);
    evidence.metadataAfterReorderHidden = (await gallery()).items;
  });

  await runCase('05 503 keeps draft and reports failure; retry checks operationId then commits once', async () => {
    await edit(0); await setTitle({ en: 'Draft retained through service outage' });
    const before = await gallery(); let failedOperationId; let statusChecks = 0;
    const listener = request => { if (request.method() === 'GET' && request.url().includes('/api/media-galleries/home-banner?operationId=')) statusChecks++; };
    page.on('request', listener);
    let failOnce = true;
    await page.route('**/api/media-galleries/home-banner', async route => {
      if (failOnce && route.request().method() === 'POST') {
        failOnce = false; failedOperationId = route.request().postDataJSON().operationId;
        await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'CP2 simulated temporary save failure' }) });
      } else await route.continue();
    });
    await save().click();
    await expect(page.locator('.admin-alert.error')).toContainText('CP2 simulated temporary save failure');
    await expect(draft().getByLabel('Title English', { exact: true })).toHaveValue('Draft retained through service outage');
    await expect(page.locator('.admin-alert.success')).toHaveCount(0);
    expect(await gallery()).toEqual(before);
    await page.setViewportSize({ width: 320, height: 900 }); await screenshot('save-failure-320.png');
    await save().click(); await settle();
    expect(statusChecks).toBeGreaterThan(0);
    expect((await gallery()).version).toBe(before.version + 1);
    const status = await context.request.get(`${origin}/api/media-galleries/home-banner?operationId=${failedOperationId}`);
    expect((await status.json()).committed).toBe(true);
    page.off('request', listener); await page.unroute('**/api/media-galleries/home-banner');
    evidence.retry503 = { operationId: failedOperationId, statusChecks, beforeVersion: before.version, afterVersion: (await gallery()).version };
  });

  await runCase('06 lost committed response resolves through operationId without duplicate write', async () => {
    await edit(0); await setTitle({ zhHans: '回應遺失仍可確認儲存' });
    const before = await gallery(); let operationId;
    let dropOnce = true;
    await page.route('**/api/media-galleries/home-banner', async route => {
      if (dropOnce && route.request().method() === 'POST') {
        dropOnce = false; operationId = route.request().postDataJSON().operationId;
        const response = await route.fetch(); expect(response.status()).toBe(200); await route.abort('failed');
      } else await route.continue();
    });
    await save().click(); await expect(page.locator('.admin-alert.error')).toBeVisible();
    await expect(draft()).toHaveCount(1);
    await expect(page.locator('.admin-alert.success')).toHaveCount(0);
    expect((await gallery()).version).toBe(before.version + 1);
    await save().click(); await settle();
    expect((await gallery()).version).toBe(before.version + 1);
    expect((await gallery()).items[0].title.zhHans).toBe('回應遺失仍可確認儲存');
    await page.unroute('**/api/media-galleries/home-banner');
    evidence.lostResponse = { operationId, beforeVersion: before.version, afterVersion: (await gallery()).version };
  });

  await runCase('07 real concurrent write causes 409, keeps draft, blocks overwrite until refresh', async () => {
    await page.setViewportSize({ width: 390, height: 900 });
    await edit(0); await setTitle({ en: 'Draft retained through version conflict' });
    const before = await gallery();
    const concurrentItem = before.items[0];
    const response = await post('home-banner', { operationId: randomUUID(), expectedVersion: before.version, action: 'put', item: { ...concurrentItem, hidden: true, caption: { ...concurrentItem.caption, zhHant: '另一位管理員更新的照片說明' }, title: { ...concurrentItem.title, zhHant: '另一位管理員更新的繁體標題' } } });
    expect(response.status()).toBe(200);
    const secondResponse = await post('home-banner', { operationId: randomUUID(), expectedVersion: before.version + 1, action: 'put', item: { ...before.items[1], hidden: true } });
    expect(secondResponse.status()).toBe(200);
    const remote = await gallery();
    await save().click();
    await expect(page.locator('.admin-alert.error').first()).toContainText('草稿已保留');
    await expect(draft().getByLabel('Title English', { exact: true })).toHaveValue('Draft retained through version conflict');
    await expect(save()).toBeDisabled(); await expect(select()).toBeDisabled();
    expect(await gallery()).toEqual(remote);
    await screenshot('version-conflict-390.png');
    await refresh().click(); await expect(save()).toBeEnabled();
    await expect(draft().getByLabel('Title English', { exact: true })).toHaveValue('Draft retained through version conflict');
    await expect(draft().getByLabel('Title 繁體中文', { exact: true })).toHaveValue('另一位管理員更新的繁體標題');
    await save().click(); await settle();
    const after = await gallery();
    expect(after.items[0].title.en).toBe('Draft retained through version conflict');
    expect(after.items[0].title.zhHant).toBe(remote.items[0].title.zhHant);
    expect(after.items[0].title.zhHans).toBe(remote.items[0].title.zhHans);
    expect(after.items[0].image).toEqual(remote.items[0].image);
    expect(after.items[0].caption).toEqual(remote.items[0].caption);
    expect(after.items[0].hidden).toBe(remote.items[0].hidden);
    expect(after.items[1]).toEqual(remote.items[1]);
    evidence.conflict = { beforeVersion: before.version, remoteVersion: remote.version, finalVersion: after.version, sameItemUntouchedLocalesCaptionHiddenImagePreserved: true, otherConcurrentItemPreserved: true };
  });

  await runCase('08 photos-only Banner and original five-gallery/video compatibility', async () => {
    await expect(page.getByRole('button', { name: '新增 YouTube 影片', exact: true })).toHaveCount(0);
    const operationId = randomUUID(); const before = await gallery();
    const rejected = await post('home-banner', { operationId, expectedVersion: before.version, action: 'put', item: { id: operationId, kind: 'youtube', hidden: false, caption: emptyText(), url: 'https://youtu.be/LsQWwDBLKUc' } });
    expect(rejected.status()).toBe(400); expect((await rejected.json()).error).toContain('photos only');
    expect(await gallery()).toEqual(before);
    const unfiltered = await (await fetch(`${origin}/api/media-galleries`)).json();
    expect(unfiltered.items.map(item => item.id)).toEqual(['tutoring', 'outreach', 'home', 'stories', 'impact', 'home-banner']);
    expect(unfiltered.items.find(item => item.id === 'home').items[0].videoId).toBe('LsQWwDBLKUc');
    for (const id of ['tutoring', 'outreach', 'home', 'stories', 'impact']) {
      await select().selectOption(id); await expect(select()).toHaveValue(id);
      await expect(draft()).toHaveCount(0);
      await expect(page.getByRole('button', { name: '新增 YouTube 影片', exact: true })).toBeEnabled();
    }
    await page.getByRole('button', { name: '新增 YouTube 影片', exact: true }).click();
    await page.getByLabel('YouTube URL', { exact: true }).fill('https://youtu.be/LsQWwDBLKUc?si=cp2');
    await save().click(); await settle();
    expect((await gallery('impact')).items[0].videoId).toBe('LsQWwDBLKUc');
    await page.reload(); await expect(select()).toBeEnabled(); await select().selectOption('impact');
    await expect(items()).toHaveCount(1);
    await select().selectOption('home-banner'); await expect(items()).toHaveCount(2);
    expect((await context.request.get(`${origin}/api/media-galleries/home-banner`)).status()).toBe(400);
    expect((await context.request.get(`${origin}/api/media-galleries/home-banner?operationId=${operationId}`)).status()).toBe(200);
  });

  await runCase('09 title limits, desktop/narrow fields and centered preview; image error leaves original intact', async () => {
    await edit(0);
    const longTitle = 'A long homepage banner title remains fully readable when its text wraps over several lines on a narrow phone screen.';
    expect(longTitle.length).toBeLessThanOrEqual(120);
    await setTitle({ en: longTitle, zhHant: '', zhHans: '' });
    await page.getByLabel('Banner preview language', { exact: true }).selectOption('zhHans');
    await expect(draft().locator('.admin-banner-preview-title')).toHaveText(longTitle);
    const frame = draft().locator('.admin-banner-preview');
    for (const width of [1280, 320, 390]) {
      await page.setViewportSize({ width, height: 960 });
      await expect(draft().getByLabel('Title English', { exact: true })).toBeVisible();
      await expect(draft().getByLabel('Title 繁體中文', { exact: true })).toBeVisible();
      await expect(draft().getByLabel('Title 简体中文', { exact: true })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      const imageStyle = await frame.locator('img').evaluate(element => ({ fit: getComputedStyle(element).objectFit, position: getComputedStyle(element).objectPosition }));
      expect(imageStyle).toEqual({ fit: 'cover', position: '50% 50%' });
      const imageBox = await frame.locator('.admin-banner-preview-image').boundingBox();
      expect(imageBox.width / imageBox.height).toBeCloseTo(16 / 9, 2);
      await screenshot(`editor-${width}.png`);
      if (width <= 390) {
        const topPath = path.join(evidenceRoot, `editor-${width}-viewport-top.png`);
        await page.screenshot({ path: topPath }); evidence.screenshots.push(topPath);
        await draft().locator('.admin-banner-titles').scrollIntoViewIfNeeded();
        const titleBoxes = [];
        for (const label of Object.values(titleLabels)) {
          const box = await draft().getByLabel(label, { exact: true }).boundingBox();
          expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(width);
          expect(box.y).toBeGreaterThanOrEqual(0); expect(box.y + box.height).toBeLessThanOrEqual(960);
          titleBoxes.push(box);
        }
        const fieldsPath = path.join(evidenceRoot, `editor-${width}-viewport-fields.png`);
        await page.screenshot({ path: fieldsPath }); evidence.screenshots.push(fieldsPath);
        evidence[`viewport${width}`] = { titleBoxes, sidebar: await page.locator('.admin-sidebar').boundingBox(), horizontalOverflow: false };
      }
    }
    await frame.screenshot({ path: path.join(evidenceRoot, 'center-crop-preview.png') });
    evidence.screenshots.push(path.join(evidenceRoot, 'center-crop-preview.png'));
    const croppedPixels = await sharp(await frame.locator('img').screenshot()).raw().toBuffer({ resolveWithObject: true });
    for (const y of [5, Math.floor(croppedPixels.info.height / 2), croppedPixels.info.height - 6]) {
      const offset = (y * croppedPixels.info.width + Math.floor(croppedPixels.info.width / 2)) * croppedPixels.info.channels;
      const [red, green, blue] = croppedPixels.data.subarray(offset, offset + 3);
      expect(green).toBeGreaterThan(red * 2); expect(green).toBeGreaterThan(blue * 1.5);
    }
    const unchanged = await context.request.get(`${origin}${uploadedImage.src}`);
    expect(digest(await unchanged.body())).toBe(digest(uploadedBytes));
    // API and counter count trimmed JavaScript UTF-16 code units: 61 emoji = 122.
    await setTitle({ en: '😀'.repeat(61) }); await save().click();
    await expect(draft()).toHaveCount(1); await expect(draft().getByRole('status')).toContainText('120');
    await screenshot('title-limit-error-390.png');
    await setTitle({ en: longTitle }); await save().click(); await settle();
    expect((await gallery()).items[0].title).toEqual({ en: longTitle, zhHant: '', zhHans: '' });
    await page.route('**/api/site-media/**/image?*', route => route.abort('failed'));
    await page.reload(); await expect(items()).toHaveCount(2);
    await expect(items().first().locator('.admin-banner-preview')).toContainText(/無法|失敗|failed|unavailable/i);
    await screenshot('image-load-failure-390.png');
    await page.unroute('**/api/site-media/**/image?*');
    await page.reload(); await expect(items()).toHaveCount(2);
    evidence.originalImage.storedSha256AfterPreview = digest(await (await context.request.get(`${origin}${uploadedImage.src}`)).body());
    expect(evidence.originalImage.storedSha256AfterPreview).toBe(evidence.originalImage.storedSha256);
  });

  await runCase('10 deleted-draft recovery guard, remove to empty and no reseed or cross-gallery form leak', async () => {
    await edit(0); await setTitle({ en: 'Unsaved title for a remotely removed photo' });
    const before = await gallery();
    const removed = await post('home-banner', { operationId: randomUUID(), expectedVersion: before.version, action: 'remove', itemId: before.items[0].id });
    expect(removed.status()).toBe(200);
    await save().click(); await expect(page.locator('.admin-alert.error').first()).toContainText('草稿已保留');
    await refresh().click();
    await expect(draft().getByLabel('Title English', { exact: true })).toHaveValue('Unsaved title for a remotely removed photo');
    await expect(save()).toBeEnabled();
    let attemptedPosts = 0;
    const capture = request => { if (request.method() === 'POST' && request.url() === `${origin}/api/media-galleries/home-banner`) attemptedPosts++; };
    page.on('request', capture);
    await save().click();
    await expect(draft().getByRole('status')).toContainText(/移除|刪除|removed|deleted/);
    expect(attemptedPosts).toBe(0); page.off('request', capture);
    expect((await gallery()).items.some(item => item.id === before.items[0].id)).toBe(false);
    await screenshot('remotely-deleted-draft-390.png');
    await draft().getByRole('button', { name: '取消此草稿', exact: true }).click();
    await expect(draft()).toHaveCount(0);
    await refresh().click(); await expect(select()).toBeEnabled();
    while (await items().count()) await removeFirst();
    await expect(page.locator('.admin-empty')).toBeVisible();
    expect((await gallery()).items).toEqual([]);
    await page.reload(); await expect(select()).toBeEnabled(); await expect(items()).toHaveCount(0);
    await select().selectOption('home'); await expect(items()).toHaveCount(1);
    await select().selectOption('home-banner'); await expect(items()).toHaveCount(0);
    await expect(draft()).toHaveCount(0); await expect(page.locator('.admin-empty')).toBeVisible();
    expect((await publicGallery()).items).toEqual([]);
    await screenshot('empty-banner-390.png');
    const stored = JSON.parse(await readFile(path.join(directory, 'media-galleries.json'), 'utf8'));
    expect(stored.galleries['home-banner'].items).toEqual([]);
    evidence.finalBanner = stored.galleries['home-banner'];
    evidence.savedOperationCount = Object.keys(stored.operations).length;
    expect(Object.hasOwn(stored.assets, `gallery.${firstId}`)).toBe(true);
    expect(Object.hasOwn(stored.assets, `gallery.${secondId}`)).toBe(true);
  });
  evidence.status = 'passed'; evidence.summary = { passed: results.length, failed: 0, skipped: 0, exitCode: 0 };
  console.log(`Home Banner admin smoke: ${results.length} passed, 0 failed, 0 skipped. Evidence: ${evidenceRoot}`);
} catch (error) {
  evidence.status = 'failed'; evidence.summary = { passed: results.filter(item => item.status === 'passed').length, failed: 1, skipped: 0, exitCode: 1 };
  if (page) {
    await writeFile(path.join(evidenceRoot, 'failure-page.txt'), await page.locator('body').innerText()).catch(() => undefined);
    await screenshot('failure.png').catch(() => undefined);
  }
  console.error(logs.slice(-4000)); throw error;
} finally {
  await writeEvidence();
  await browser?.close(); child.kill();
}
