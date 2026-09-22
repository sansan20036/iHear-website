// Real built application, isolated local storage and a test-only Auth.js key.
// No production credentials or production writes are used by this test.
import { spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { mkdir, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';
import { encode } from 'next-auth/jwt';

const dev = process.argv.includes('--dev');
const port = 3213;
const origin = `http://localhost:${port}`;
const secret = 'isolated-gallery-smoke-test-key-never-use-in-production';
await mkdir('output/playwright', { recursive: true });
const directory = await mkdtemp(path.resolve('output/playwright/resource-admin-'));
const child = spawn(process.execPath, ['node_modules/next/dist/bin/next', dev ? 'dev' : 'start', '--hostname', 'localhost', '--port', String(port)], {
  env: { ...process.env, NODE_ENV: dev ? 'development' : 'production', VERCEL: '', NETLIFY: '', CONTEXT: '', IHEAR_FORCE_FILE_STORE: '1', IHEAR_TEST_DATA_DIR: directory, AUTH_SECRET: secret, TRANSLATION_RECEIPT_SECRET: 'isolated-resource-preview-test-key-never-use-in-production', AUTH_OWNER_EMAILS: 'media-test@example.com', AUTH_URL: origin, AUTH_TRUST_HOST: 'true' },
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
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await page.getByRole('button', { name: '新增資源', exact: true }).click();
  await dialog.getByLabel('所屬主題', { exact: true }).selectOption('articles');
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
  await expect(dialog.getByRole('button', { name: '確認儲存草稿', exact: true })).toHaveCount(0);
  await dialog.getByRole('button', { name: '下一步：預覽翻譯', exact: true }).click();
  await expect(dialog.getByRole('status')).toContainText('預覽已完成');
  expect((await (await context.request.get(origin + '/api/resources?admin=1')).json()).items).toHaveLength(3);
  await dialog.getByRole('button', { name: '確認儲存草稿', exact: true }).click();
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
  await dialog.getByRole('button', { name: '下一步：預覽翻譯', exact: true }).click();
  await expect(dialog.getByRole('status')).toContainText('預覽已完成');
  await expect(dialog.getByLabel('繁體中文 · 名稱', { exact: true })).toHaveValue('測試資源');
  page.once('dialog', confirmation => confirmation.dismiss());
  await dialog.getByRole('button', { name: '改為草稿並下架', exact: true }).click();
  expect((await publicItems()).some(item => item.title.en === 'Test resource')).toBe(true);
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: '儲存變更（維持發布）', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect((await publicItems())[0].title.en).toBe('Renamed resource');
  const visitor = await browser.newContext({ viewport: { width: 320, height: 900 } });
  const visitorPage = await visitor.newPage();
  await visitorPage.goto(origin + '/resources#resources');
  await expect(visitorPage.locator('[data-resource-topics] .resource-links-list li')).toHaveCount(4);
  await expect(visitorPage.locator('[data-resource-links] li')).toHaveCount(3);
  await expect(visitorPage.locator('[data-resource-articles] li')).toHaveCount(1);
  await expect(visitorPage.locator('[data-resource-manage]')).toBeHidden();
  await expect(visitorPage.locator('[data-resource-legacy-guides] li')).toHaveCount(9);
  expect(await visitorPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.bringToFront();
  page.once('dialog', confirmation => confirmation.accept());
  await row.getByRole('button', { name: '隱藏', exact: true }).click();
  await expect(row.getByRole('button', { name: '發布', exact: true })).toBeVisible();
  await visitorPage.bringToFront();
  await expect(visitorPage.locator('[data-resource-topics] .resource-links-list li')).toHaveCount(3, { timeout: 20000 });
  await expect(visitorPage.locator('[data-resource-articles]')).toBeHidden();
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
  expect((await publicItems())[0].category).toBe('article');
  await page.goto(origin + '/admin/resources');
  await row.getByRole('button', { name: '編輯', exact: true }).click();
  const current = (await (await context.request.get(origin + '/api/resources?admin=1')).json()).items.find(item => item.title.en === 'Renamed resource');
  const response = await context.request.patch(origin + '/api/resources/' + current.id, { data: { ...current, sortOrder: 12 } });
  expect(response.status()).toBe(200);
  await dialog.getByLabel('自動更新中文翻譯', { exact: true }).uncheck();
  await dialog.getByRole('button', { name: '下一步：預覽翻譯', exact: true }).click();
  await expect(dialog.getByRole('status')).toContainText('預覽已完成');
  await dialog.getByRole('button', { name: '儲存變更（維持發布）', exact: true }).click();
  await expect(dialog.getByText('此資料已被其他管理員更新。您的輸入已保留，請先取得此筆最新資料，再重新儲存。')).toBeVisible();
  await expect(dialog.getByLabel('English · 名稱', { exact: true })).toHaveValue('Renamed resource');
  await expect(dialog.getByRole('button', { name: '儲存變更（維持發布）', exact: true })).toBeDisabled();
  page.once('dialog', confirmation => confirmation.accept());
  await dialog.getByRole('button', { name: '取消', exact: true }).click();

  // A new resource with an expired receipt can retry without losing input.
  await page.getByRole('button', { name: '新增資源', exact: true }).click();
  await dialog.getByLabel('English · 名稱', { exact: true }).fill('Recovered preview');
  await dialog.getByLabel('繁體中文 · 名稱', { exact: true }).fill('過期後恢復');
  await dialog.getByLabel('简体中文 · 名稱', { exact: true }).fill('过期后恢复');
  await dialog.getByLabel('HTTPS 連結', { exact: true }).fill('http://example.org/resource');
  await dialog.getByLabel('自動更新中文翻譯', { exact: true }).uncheck();
  await dialog.getByRole('button', { name: '下一步：預覽翻譯', exact: true }).click();
  const alert = dialog.getByRole('alert');
  await expect(alert).toContainText('HTTPS 網址');
  await expect(alert).toBeFocused();
  expect(await alert.evaluate(el => { const r = el.getBoundingClientRect(), d = el.closest('dialog').getBoundingClientRect(); return r.top >= d.top && r.bottom <= d.bottom && r.bottom <= innerHeight; })).toBe(true);
  await expect(dialog.getByLabel('HTTPS 連結', { exact: true })).toHaveAttribute('aria-invalid', 'true');
  await expect(dialog.getByRole('status')).toHaveCount(0);
  await page.screenshot({ path: 'output/playwright/resources-url-error-fixed.png' });
  await dialog.getByLabel('HTTPS 連結', { exact: true }).fill('https://example.org/resource');
  await page.route('**/api/admin/translations/preview', async route => {
    const response = await route.fetch(), data = await response.json();
    const payload = JSON.parse(Buffer.from(data.receipt.split('.')[0], 'base64url').toString());
    payload.expiresAt = Date.now() - 1000;
    const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
    data.receipt = encoded + '.' + createHmac('sha256', 'isolated-resource-preview-test-key-never-use-in-production').update(encoded).digest('base64url');
    await route.fulfill({ response, json: data });
  }, { times: 1 });
  await dialog.getByRole('button', { name: '下一步：預覽翻譯', exact: true }).click();
  await expect(dialog.getByRole('status')).toContainText('預覽已完成');
  await dialog.getByRole('button', { name: '確認發布', exact: true }).click();
  await expect(alert).toContainText('翻譯預覽已過期或失效');
  await expect(dialog.getByRole('status')).toHaveCount(0);
  await expect(dialog.getByLabel('English · 名稱', { exact: true })).toHaveValue('Recovered preview');
  await expect(dialog.getByRole('button', { name: '下一步：預覽翻譯', exact: true })).toBeEnabled();
  await page.screenshot({ path: 'output/playwright/resources-expired-preview-fixed.png' });
  await dialog.getByRole('button', { name: '下一步：預覽翻譯', exact: true }).click();
  await expect(dialog.getByRole('status')).toContainText('預覽已完成');
  for (const width of [320, 390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    for (const button of await dialog.locator('.admin-actions button').all()) expect((await button.boundingBox()).height).toBeGreaterThanOrEqual(44);
  }
  await page.setViewportSize({ width: 390, height: 900 });
  await dialog.getByRole('button', { name: '確認發布', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const recovered = page.locator('.admin-resource-list article').filter({ hasText: '過期後恢復' });
  await recovered.getByRole('button', { name: '編輯', exact: true }).click();
  await dialog.getByLabel('自動更新中文翻譯', { exact: true }).uncheck();
  await dialog.getByRole('button', { name: '下一步：預覽翻譯', exact: true }).click();
  await expect(dialog.getByRole('status')).toContainText('預覽已完成');
  page.once('dialog', confirmation => confirmation.accept());
  await dialog.getByRole('button', { name: '改為草稿並下架', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect((await publicItems()).some(item => item.title.en === 'Recovered preview')).toBe(false);
  await expect(recovered.getByRole('button', { name: '發布', exact: true })).toBeVisible();
  await visitor.close();
  console.log('Resources smoke passed: two-step save, expired-preview recovery, visible/localized URL errors, cancel/confirm unpublish, draft/publish, manual Chinese, order, hide/live refresh, archive/restore, version conflict, visitor access, 320/390/1440px.');
} catch (error) {
  if (page) { console.error(await page.locator('body').innerText()); await page.screenshot({ path: 'output/playwright/resource-admin-failure.png', fullPage: true }); }
  console.error(logs.slice(-5000)); throw error;
} finally { await browser?.close(); child.kill(); }
