// Real built application, isolated local storage and a test-only Auth.js key.
// No production credentials or production writes are used by this test.
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';
import { encode } from 'next-auth/jwt';
import sharp from 'sharp';

const port = 3212;
const origin = `http://localhost:${port}`;
const secret = 'isolated-gallery-smoke-test-key-never-use-in-production';
await mkdir('output/playwright', { recursive: true });
const directory = await mkdtemp(path.resolve('output/playwright/gallery-admin-'));
const child = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '--hostname', 'localhost', '--port', String(port)], {
  env: { ...process.env, NODE_ENV: 'production', VERCEL: '', NETLIFY: '', CONTEXT: '', IHEAR_FORCE_FILE_STORE: '1', IHEAR_TEST_DATA_DIR: directory, AUTH_SECRET: secret, AUTH_OWNER_EMAILS: 'media-test@example.com', AUTH_URL: origin, AUTH_TRUST_HOST: 'true' },
  windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
});
let logs = ''; child.stdout.on('data', chunk => { logs += chunk; }); child.stderr.on('data', chunk => { logs += chunk; });
let browser, page;
try {
  let started = false;
  for (let i = 0; i < 120; i++) {
    if (child.exitCode !== null) throw new Error(`Test server exited: ${logs}`);
    try { if ((await fetch(`${origin}/api/media-galleries`)).ok) { started = true; break; } } catch { /* server starting */ }
    await new Promise(resolve => { setTimeout(resolve, 500); });
  }
  if (!started) throw new Error(`Test server did not start: ${logs}`);
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 390, height: 900 } });
  const token = await encode({ secret, salt: 'authjs.session-token', token: { name: 'Media test', email: 'media-test@example.com', sub: 'media-test' } });
  await context.addCookies([{ name: 'authjs.session-token', value: token, url: origin, httpOnly: true, sameSite: 'Lax' }]);
  page = await context.newPage();
  page.on('response', async response => { if (response.url().includes('/api/media-galleries') && response.status() >= 400) console.error('Gallery test response:', response.status(), await response.text()); });
  await page.goto(`${origin}/admin/media`);
  await expect(page.getByRole('heading', { name: '媒體展示', exact: true })).toBeVisible();
  await page.getByRole('combobox').selectOption('impact');
  await page.getByRole('button', { name: '新增 YouTube 影片', exact: true }).click();
  await page.getByLabel('YouTube URL').fill('https://youtu.be/LsQWwDBLKUc?si=phone-sharing&t=99');
  await page.getByRole('button', { name: '儲存／重試未完成項目', exact: true }).click();
  await expect(page.locator('.admin-media-item')).toHaveCount(1);
  await page.reload(); await page.getByRole('combobox').selectOption('impact');
  await expect(page.locator('.admin-media-item')).toHaveCount(1);

  // Multi-file selection uses the actual compressor, upload route, transaction and image route.
  const png = await sharp({ create: { width: 180, height: 320, channels: 3, background: '#9cb5d4' } }).png().toBuffer();
  await page.getByLabel('新增照片', { exact: true }).setInputFiles([
    { name: 'portrait.png', mimeType: 'image/png', buffer: png }, { name: 'portrait-2.png', mimeType: 'image/png', buffer: png },
  ]);
  const drafts = page.locator('.admin-media-draft');
  for (let i = 0; i < 2; i++) {
    const fields = drafts.nth(i).locator('textarea');
    await fields.nth(0).fill(`Volunteer photo ${i + 1}`); await fields.nth(1).fill(`志工活動照片 ${i + 1}`); await fields.nth(2).fill(`志工活动照片 ${i + 1}`);
  }
  // Simulate a lost response after the server commits the first photo.
  let dropOnce = true;
  await page.route('**/api/media-galleries/impact', async route => {
    if (dropOnce && route.request().method() === 'POST' && route.request().headers()['content-type']?.includes('multipart')) {
      dropOnce = false; await route.fetch(); await route.abort('failed');
    } else await route.continue();
  });
  const save = page.getByRole('button', { name: '儲存／重試未完成項目', exact: true });
  await save.click(); await expect(save).toBeEnabled();
  await save.click();
  await expect(page.locator('.admin-media-item')).toHaveCount(3, { timeout: 30_000 });
  const saved = await (await context.request.get(`${origin}/api/media-galleries?admin=1`)).json();
  const impact = saved.items.find(g => g.id === 'impact');
  expect(impact.items).toHaveLength(3); expect(impact.items[0].videoId).toBe('LsQWwDBLKUc');
  const image = await context.request.get(`${origin}${impact.items[1].image.src}`);
  expect(image.status()).toBe(200); expect(image.headers()['cache-control']).toContain('immutable');
  expect((await sharp(await image.body()).metadata()).height).toBeGreaterThan(180);

  const first = page.locator('.admin-media-item').first();
  await first.getByRole('button', { name: '隱藏', exact: true }).click();
  await expect(first.getByRole('button', { name: '顯示', exact: true })).toBeVisible();
  let published = await (await fetch(`${origin}/api/media-galleries`)).json();
  expect(published.items.find(g => g.id === 'impact').items).toHaveLength(2);
  await first.getByRole('button', { name: '顯示', exact: true }).click();
  await first.getByRole('button', { name: '向後移動', exact: true }).click();
  await expect(page.locator('.admin-media-item').first()).toContainText('照片');
  await page.locator('.admin-media-item').last().getByRole('button', { name: '移除', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '移除', exact: true }).click();
  await expect(page.locator('.admin-media-item')).toHaveCount(2);
  for (const width of [320, 390, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await page.screenshot({ path: 'output/playwright/gallery-admin-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 900 });
  await expect.poll(() => page.locator('.admin-sidebar').evaluate(el => el.getBoundingClientRect().right)).toBeLessThanOrEqual(0);
  await page.screenshot({ path: 'output/playwright/gallery-admin-mobile.png', fullPage: true });
  published = await (await fetch(`${origin}/api/media-galleries`)).json();
  expect(published.items.find(g => g.id === 'impact').items).toHaveLength(2);
  console.log('Media admin smoke passed: YouTube, multi-upload, lost response/retry, immutable image, hide/show, reorder/remove, mobile layout.');
} catch (error) {
  if (page) {
    console.error(await page.locator('body').innerText());
    await page.screenshot({ path: 'output/playwright/gallery-admin-failure.png', fullPage: true });
  }
  console.error(logs.slice(-5000)); throw error;
} finally {
  await browser?.close();
  child.kill();
}
