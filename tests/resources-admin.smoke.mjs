// Real built application, isolated local storage and a test-only Auth.js key.
// No production credentials or production writes are used by this test.
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';
import { encode } from 'next-auth/jwt';

const port = 3213;
const origin = `http://localhost:${port}`;
const secret = 'isolated-gallery-smoke-test-key-never-use-in-production';
await mkdir('output/playwright', { recursive: true });
const directory = await mkdtemp(path.resolve('output/playwright/resource-admin-'));
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

  await page.goto(origin + '/admin/resources');
  await expect(page.getByRole('heading', { name: '資源管理', exact: true })).toBeVisible();
  await expect(page.locator('.admin-resource-list article')).toHaveCount(3);
  const publicItems = async () => (await (await fetch(origin + '/api/resources')).json()).items;
  expect((await publicItems()).map(item => item.url)).toContain('https://forms.gle/FzayZzgAEiGHsA1b9');
  expect((await fetch(origin + '/api/resources?admin=1')).status).toBe(403);
  await page.getByRole('button', { name: '新增資源', exact: true }).click();
  const dialog = page.locator('.admin-resource-dialog');
  await dialog.getByLabel('English · 名稱', { exact: true }).fill('Test resource');
  await dialog.getByLabel('繁體中文 · 名稱', { exact: true }).fill('測試資源');
  await dialog.getByLabel('简体中文 · 名稱', { exact: true }).fill('测试资源');
  await dialog.getByLabel('HTTPS 連結', { exact: true }).fill('https://forms.gle/ouDos4WbYS6X2C3y6');
  await dialog.getByLabel('自動更新中文翻譯', { exact: true }).uncheck();
  for (const width of [320, 390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  }
  await page.setViewportSize({ width: 390, height: 900 });
  await dialog.getByRole('button', { name: '儲存草稿', exact: true }).click();
  await expect(dialog.getByRole('status')).toContainText('預覽已完成');
  await dialog.getByRole('button', { name: '儲存草稿', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect((await publicItems()).some(item => item.title.en === 'Test resource')).toBe(false);
  const row = page.locator('.admin-resource-list article').filter({ hasText: '測試資源' });
  await row.getByRole('button', { name: '發布', exact: true }).click();
  await expect(row.getByRole('button', { name: '隱藏', exact: true })).toBeVisible();
  expect((await publicItems()).some(item => item.title.en === 'Test resource')).toBe(true);
  await row.getByRole('button', { name: '編輯', exact: true }).click();
  await dialog.getByLabel('English · 名稱', { exact: true }).fill('Renamed resource');
  await dialog.getByLabel('顯示順序', { exact: true }).fill('0');
  await dialog.getByLabel('自動更新中文翻譯', { exact: true }).uncheck();
  await dialog.getByRole('button', { name: '儲存並發布', exact: true }).click();
  await expect(dialog.getByRole('status')).toContainText('預覽已完成');
  await expect(dialog.getByLabel('繁體中文 · 名稱', { exact: true })).toHaveValue('測試資源');
  await dialog.getByRole('button', { name: '儲存並發布', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect((await publicItems())[0].title.en).toBe('Renamed resource');
  const visitor = await browser.newContext({ viewport: { width: 320, height: 900 } });
  const visitorPage = await visitor.newPage();
  await visitorPage.goto(origin + '/resources#resources');
  await expect(visitorPage.locator('.resource-links-list li')).toHaveCount(4);
  await expect(visitorPage.locator('[data-resource-manage]')).toBeHidden();
  await expect(visitorPage.locator('.res-chips .chip')).toHaveCount(9);
  expect(await visitorPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.bringToFront();
  await row.getByRole('button', { name: '隱藏', exact: true }).click();
  await expect(row.getByRole('button', { name: '發布', exact: true })).toBeVisible();
  await visitorPage.bringToFront();
  await expect(visitorPage.locator('.resource-links-list li')).toHaveCount(3, { timeout: 20000 });
  await page.bringToFront();
  await row.getByRole('button', { name: '發布', exact: true }).click();
  await expect(row.getByRole('button', { name: '隱藏', exact: true })).toBeVisible();
  page.once('dialog', confirmation => confirmation.accept());
  await row.getByRole('button', { name: '移至回收區', exact: true }).click();
  await expect(row).toHaveCount(0);
  await page.goto(origin + '/admin/trash');
  const trashed = page.locator('article').filter({ hasText: '測試資源' });
  await expect(trashed).toBeVisible();
  await expect(trashed.getByRole('button', { name: '永久刪除' })).toHaveCount(0);
  await trashed.getByRole('button', { name: '復原', exact: true }).click();
  await expect(trashed).toHaveCount(0);
  expect((await publicItems())[0].title.en).toBe('Renamed resource');
  await page.goto(origin + '/admin/resources');
  await row.getByRole('button', { name: '編輯', exact: true }).click();
  const current = (await (await context.request.get(origin + '/api/resources?admin=1')).json()).items.find(item => item.title.en === 'Renamed resource');
  const response = await context.request.patch(origin + '/api/resources/' + current.id, { data: { ...current, sortOrder: 12 } });
  expect(response.status()).toBe(200);
  await dialog.getByLabel('自動更新中文翻譯', { exact: true }).uncheck();
  await dialog.getByRole('button', { name: '儲存並發布', exact: true }).click();
  await expect(dialog.getByRole('status')).toContainText('預覽已完成');
  await dialog.getByRole('button', { name: '儲存並發布', exact: true }).click();
  await expect(dialog.getByText('此資料已被其他管理員更新。您的草稿已保留，請關閉並重新讀取後再儲存。')).toBeVisible();
  await expect(dialog.getByLabel('English · 名稱', { exact: true })).toHaveValue('Renamed resource');
  await visitor.close();
  console.log('Resources smoke passed: three seeds, draft/publish, rename, manual translations, order, hide/live refresh, archive/restore, version conflict, visitor access, 320/390/1440px.');
} catch (error) {
  if (page) { console.error(await page.locator('body').innerText()); await page.screenshot({ path: 'output/playwright/resource-admin-failure.png', fullPage: true }); }
  console.error(logs.slice(-5000)); throw error;
} finally { await browser?.close(); child.kill(); }
