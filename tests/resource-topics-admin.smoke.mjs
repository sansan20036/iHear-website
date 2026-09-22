// Checkpoint 3: real Admin UI and API against a fresh, isolated file store.
// --dev avoids requiring a production build during this checkpoint.
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import { chromium, expect as baseExpect } from '@playwright/test';
import { encode } from 'next-auth/jwt';

const dev = process.argv.includes('--dev');
const expect = baseExpect.configure({ timeout: dev ? 20000 : 5000 });
const origin = 'http://localhost:3214', secret = 'checkpoint-3-local-auth-only';
await mkdir('output/playwright', { recursive: true });
const directory = await mkdtemp(path.resolve('output/playwright/resource-topics-admin-'));
const child = spawn(process.execPath, ['node_modules/next/dist/bin/next', dev ? 'dev' : 'start', '--hostname', 'localhost', '--port', '3214'], {
  env: { ...process.env, NODE_ENV: dev ? 'development' : 'production', VERCEL: '', NETLIFY: '', CONTEXT: '', IHEAR_FORCE_FILE_STORE: '1', IHEAR_TEST_DATA_DIR: directory,
    POSTGRES_URL: '', DATABASE_URL: '', AUTH_SECRET: secret, TRANSLATION_RECEIPT_SECRET: 'checkpoint-3-local-preview-only', AUTH_OWNER_EMAILS: 'checkpoint3@example.test', AUTH_URL: origin, AUTH_TRUST_HOST: 'true' },
  windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
});
let logs = '', browser, page, passed = 0;
child.stdout.on('data', chunk => { logs = (logs + chunk).slice(-12000); }); child.stderr.on('data', chunk => { logs = (logs + chunk).slice(-12000); });
const pause = ms => new Promise(resolve => { setTimeout(resolve, ms); });
const step = async (name, action) => { await action(); passed++; console.log(`PASS ${passed}: ${name}`); };
try {
  let ready = false;
  for (let i = 0; i < 180; i++) {
    if (child.exitCode !== null) throw new Error(`Server exited: ${logs}`);
    try { if ((await fetch(origin + '/api/resources')).ok) { ready = true; break; } } catch { /* booting */ }
    await pause(500);
  }
  if (!ready) throw new Error(`Server did not start: ${logs}`);
  browser = await chromium.launch({ headless: true, args: process.platform === 'win32' ? ['--force-device-scale-factor=1'] : [] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const token = await encode({ secret, salt: 'authjs.session-token', token: { name: 'Checkpoint 3 Admin', email: 'checkpoint3@example.test', sub: 'checkpoint3' } });
  await context.addCookies([{ name: 'authjs.session-token', value: token, url: origin, httpOnly: true, sameSite: 'Lax' }]);
  page = await context.newPage(); page.setDefaultTimeout(20000);
  let lastMutation = 0;
  await page.route(/\/api\/(resources|resource-topics)(\/[^?]*)?$/, async route => {
    if (route.request().method() !== 'GET') {
      await pause(Math.max(0, 2500 - (Date.now() - lastMutation))); lastMutation = Date.now();
    }
    await route.fallback();
  });
  const pageErrors = []; page.on('pageerror', error => pageErrors.push(error.message));
  const dialog = page.locator('.admin-resource-dialog');
  const rows = page.locator('.admin-resource-list article');
  const row = name => rows.filter({ has: page.getByRole('heading', { name, exact: true }) });
  const button = name => page.getByRole('button', { name, exact: true });
  const statusFilter = () => page.getByLabel('狀態篩選', { exact: true });
  const topicFilter = () => page.locator('.admin-resource-filters').getByLabel('所屬主題', { exact: true });
  const snapshot = async (archived = false) => {
    const response = await context.request.get(origin + '/api/resources?' + (archived ? 'includeArchived=true' : 'admin=1'));
    expect(response.ok()).toBe(true); return response.json();
  };
  const topics = async () => { await button('主題管理').click(); await expect(button('新增主題')).toBeEnabled(); };
  const items = async () => { await button('項目管理').click(); await topicFilter().selectOption(''); await expect(button('新增資源')).toBeEnabled(); };
  const reload = async () => { await button('重新讀取已儲存資料').click(); await expect(button('重新讀取已儲存資料')).toBeEnabled(); };
  const accept = () => page.once('dialog', d => d.accept());
  const fields = async (name, chinese = name) => {
    await dialog.getByLabel('English · 名稱', { exact: true }).fill(name);
    await dialog.getByLabel('繁體中文 · 名稱', { exact: true }).fill(chinese);
    await dialog.getByLabel('简体中文 · 名稱', { exact: true }).fill(chinese);
    await dialog.getByLabel('English · 用途說明（選填）', { exact: true }).fill('Description for ' + name);
    await dialog.getByLabel('繁體中文 · 用途說明（選填）', { exact: true }).fill('人工繁體介紹');
    await dialog.getByLabel('简体中文 · 用途說明（選填）', { exact: true }).fill('人工简体介绍');
  };
  let lastPreview = 0;
  const preview = async () => {
    // Respect the application's real 15 previews/minute limit; do not disable it.
    await pause(Math.max(0, 4200 - (Date.now() - lastPreview)));
    await dialog.getByLabel('自動更新中文翻譯', { exact: true }).uncheck();
    await dialog.getByRole('button', { name: '下一步：預覽翻譯', exact: true }).click(); lastPreview = Date.now();
    await expect(dialog.getByRole('status')).toContainText('預覽已完成');
  };
  const save = async (name = '確認儲存草稿') => {
    await preview(); await dialog.getByRole('button', { name, exact: true }).click(); await expect(dialog).toHaveCount(0); await expect(button('重新讀取已儲存資料')).toBeEnabled();
  };
  let topicA, topicB, link;
  await step('Anonymous admin data is denied; management page requires login', async () => {
    expect((await fetch(origin + '/api/resources?admin=1')).status).toBe(403);
    const visitor = await browser.newContext(); const visitorPage = await visitor.newPage();
    await visitorPage.goto(origin + '/admin/resources'); await expect(visitorPage).not.toHaveURL(/\/admin\/resources$/); await visitor.close();
  });
  await step('Topic list includes drafts; new topic defaults to draft and keeps three languages', async () => {
    await page.goto(origin + '/admin/resources'); await topics();
    await expect(row('文獻研讀會')).toContainText('草稿／隱藏');
    await button('新增主題').click(); await fields('Reading Group', '讀書主題');
    await dialog.getByLabel('顯示順序', { exact: true }).fill('3'); await save();
    topicA = (await snapshot()).topics.find(t => t.title.en === 'Reading Group');
    expect(topicA).toMatchObject({ status: 'draft', sortOrder: 3, description: { en: 'Description for Reading Group', zhHant: '人工繁體介紹', zhHans: '人工简体介绍' } });
    await statusFilter().selectOption('draft'); await expect(row('讀書主題')).toBeVisible();
  });
  await step('Topic publish/edit/order preserves manual Chinese and stable slug', async () => {
    await row('讀書主題').getByRole('button', { name: '發布', exact: true }).click();
    await expect(row('讀書主題')).toHaveCount(0); await statusFilter().selectOption('published');
    await row('讀書主題').getByRole('button', { name: '編輯', exact: true }).click();
    await dialog.getByLabel('English · 名稱', { exact: true }).fill('Renamed Reading Group');
    await dialog.getByLabel('顯示順序', { exact: true }).fill('1');
    await preview(); await expect(dialog.getByLabel('繁體中文 · 名稱', { exact: true })).toHaveValue('讀書主題');
    await dialog.getByRole('button', { name: '儲存變更（維持發布）', exact: true }).click(); await expect(dialog).toHaveCount(0);
    const latest = (await snapshot()).topics.find(t => t.id === topicA.id);
    expect(latest).toMatchObject({ status: 'published', sortOrder: 1, slug: topicA.slug, title: { en: 'Renamed Reading Group', zhHant: '讀書主題' } });
    await expect(rows.first().getByRole('heading')).toHaveText('讀書主題');
  });
  await step('Hide topic preserves content; unpublished topic can be edited and published again', async () => {
    accept(); await row('讀書主題').getByRole('button', { name: '隱藏', exact: true }).click(); await expect(row('讀書主題')).toHaveCount(0);
    await statusFilter().selectOption('draft'); await expect(row('讀書主題')).toBeVisible();
    await row('讀書主題').getByRole('button', { name: '發布', exact: true }).click(); await expect(row('讀書主題')).toHaveCount(0);
    await statusFilter().selectOption('active'); await button('新增主題').click(); await fields('Second Topic', '第二主題'); await save('確認發布');
    topicB = (await snapshot()).topics.find(t => t.title.en === 'Second Topic');
  });
  await step('Add all three item types without requiring links for email/text', async () => {
    await items();
    for (const [type, name, chinese] of [['external_link', 'Web link', '外部測試'], ['email_request', 'Email guide', '索取指南'], ['text', 'Notice', '公告內容']]) {
      await button('新增資源').click(); await dialog.getByLabel('所屬主題', { exact: true }).selectOption(topicA.id);
      await dialog.getByLabel('項目種類', { exact: true }).selectOption(type); await fields(name, chinese);
      if (type === 'external_link') await dialog.getByLabel('HTTPS 連結', { exact: true }).fill('https://example.org/resource');
      else await expect(dialog.getByLabel('HTTPS 連結', { exact: true })).toHaveCount(0);
      await save(type === 'email_request' ? '確認儲存草稿' : '確認發布');
      const item = (await snapshot()).items.find(r => r.title.en === name);
      expect(item).toMatchObject({ topicId: topicA.id, type, url: type === 'external_link' ? 'https://example.org/resource' : '' });
      if (type === 'external_link') link = item;
    }
  });
  await step('Item edit moves topic and keeps descriptions/manual translations; parent hiding leaves item published', async () => {
    await row('外部測試').getByRole('button', { name: '編輯', exact: true }).click();
    await dialog.getByLabel('所屬主題', { exact: true }).selectOption(topicB.id);
    await dialog.getByLabel('English · 名稱', { exact: true }).fill('Moved web link'); await dialog.getByLabel('顯示順序', { exact: true }).fill('0');
    await save('儲存變更（維持發布）');
    const moved = (await snapshot()).items.find(r => r.id === link.id);
    expect(moved).toMatchObject({ topicId: topicB.id, sortOrder: 0, title: { zhHant: '外部測試' }, description: link.description });
    await topics(); accept(); await row('第二主題').getByRole('button', { name: '隱藏', exact: true }).click();
    await expect(row('第二主題')).toContainText('草稿／隱藏'); await items();
    await expect(row('外部測試')).toContainText('單獨發布項目，訪客仍看不到');
    expect((await snapshot()).items.find(r => r.id === link.id).status).toBe('published');
  });
  await step('Topic archive with active or archived item references gives actionable guidance', async () => {
    await topics(); accept(); await row('第二主題').getByRole('button', { name: '移至回收區', exact: true }).click();
    await expect(page.locator('.admin-resources').getByRole('alert')).toContainText('此主題仍有項目引用');
    await items(); accept(); await row('外部測試').getByRole('button', { name: '移至回收區', exact: true }).click(); await expect(row('外部測試')).toHaveCount(0);
    await topics(); accept(); await row('第二主題').getByRole('button', { name: '移至回收區', exact: true }).click();
    await expect(page.locator('.admin-resources').getByRole('alert')).toContainText('回收區項目需先復原再移動');
    await expect(row('第二主題')).toBeVisible();
  });
  await step('Published item restores published; draft item restores draft in the resource page', async () => {
    await items(); await statusFilter().selectOption('archived'); await expect(row('外部測試')).toBeVisible();
    await row('外部測試').getByRole('button', { name: '復原', exact: true }).click(); await expect(row('外部測試')).toHaveCount(0);
    expect((await snapshot()).items.find(r => r.id === link.id).status).toBe('published');
    await statusFilter().selectOption('draft'); accept(); await row('索取指南').getByRole('button', { name: '移至回收區', exact: true }).click(); await expect(row('索取指南')).toHaveCount(0);
    await statusFilter().selectOption('archived'); await row('索取指南').getByRole('button', { name: '復原', exact: true }).click(); await expect(row('索取指南')).toHaveCount(0);
    await statusFilter().selectOption('draft'); await expect(row('索取指南')).toBeVisible();
  });
  await step('Move remaining reference, archive/restore draft and published topics', async () => {
    await statusFilter().selectOption('active'); await row('外部測試').getByRole('button', { name: '編輯', exact: true }).click();
    await dialog.getByLabel('所屬主題', { exact: true }).selectOption(topicA.id); await save('儲存變更（維持發布）');
    await topics();
    for (const original of ['draft', 'published']) {
      if (original === 'published') { await row('第二主題').getByRole('button', { name: '發布', exact: true }).click(); await expect(row('第二主題').getByRole('button', { name: '隱藏', exact: true })).toBeVisible(); }
      accept(); await row('第二主題').getByRole('button', { name: '移至回收區', exact: true }).click(); await expect(row('第二主題')).toHaveCount(0);
      await statusFilter().selectOption('archived'); await row('第二主題').getByRole('button', { name: '復原', exact: true }).click(); await expect(row('第二主題')).toHaveCount(0);
      expect((await snapshot()).topics.find(t => t.id === topicB.id).status).toBe(original);
      await statusFilter().selectOption('active');
    }
  });
  await step('Item 409 keeps input; latest-record fetch requires confirmation and permits retry', async () => {
    await items(); await row('外部測試').getByRole('button', { name: '編輯', exact: true }).click();
    await dialog.getByLabel('English · 名稱', { exact: true }).fill('Unsaved conflict text'); await preview();
    const current = (await snapshot()).items.find(r => r.id === link.id);
    expect((await context.request.patch(origin + '/api/resources/' + link.id, { data: { version: current.version, sortOrder: 9 } })).status()).toBe(200);
    await dialog.getByRole('button', { name: '儲存變更（維持發布）', exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText('您的輸入已保留'); await expect(dialog.getByLabel('English · 名稱', { exact: true })).toHaveValue('Unsaved conflict text');
    await expect(dialog.getByRole('button', { name: '儲存變更（維持發布）', exact: true })).toBeDisabled();
    page.once('dialog', d => d.dismiss()); await dialog.getByRole('button', { name: '取得此筆最新資料', exact: true }).click();
    await expect(dialog.getByLabel('English · 名稱', { exact: true })).toHaveValue('Unsaved conflict text');
    accept(); await dialog.getByRole('button', { name: '取得此筆最新資料', exact: true }).click();
    await expect(dialog.getByLabel('顯示順序', { exact: true })).toHaveValue('9');
    await expect(dialog.getByLabel('English · 名稱', { exact: true })).toHaveValue('Moved web link');
    await dialog.getByLabel('顯示順序', { exact: true }).fill('8'); await save('儲存變更（維持發布）');
  });
  await step('Topic 409 also keeps input and can reload latest; cancel retains server data', async () => {
    await topics(); await row('第二主題').getByRole('button', { name: '編輯', exact: true }).click();
    await dialog.getByLabel('顯示順序', { exact: true }).fill('777'); await preview();
    const current = (await snapshot()).topics.find(t => t.id === topicB.id);
    expect((await context.request.patch(origin + '/api/resource-topics/' + topicB.id, { data: { version: current.version, sortOrder: 15 } })).status()).toBe(200);
    await dialog.getByRole('button', { name: '儲存變更（維持發布）', exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText('您的輸入已保留'); await expect(dialog.getByLabel('顯示順序', { exact: true })).toHaveValue('777');
    accept(); await dialog.getByRole('button', { name: '取得此筆最新資料', exact: true }).click(); await expect(dialog.getByLabel('顯示順序', { exact: true })).toHaveValue('15');
    await dialog.getByRole('button', { name: '取消', exact: true }).click(); await expect(dialog).toHaveCount(0);
  });
  await step('Load failure is understandable and retry recovers', async () => {
    await page.route('**/api/resources?admin=1', route => route.fulfill({ status: 503, json: { error: 'internal detail' } }), { times: 1 });
    await reload(); await expect(page.locator('.admin-resources').getByRole('alert')).toContainText('無法載入已儲存資料'); await expect(rows).toHaveCount(0);
    await reload(); await expect(page.locator('.admin-resources').getByRole('alert')).toHaveCount(0); await expect(row('第二主題')).toBeVisible();
  });
  await step('Failed save keeps input; duplicate submits are prevented while a request is pending', async () => {
    await items(); await button('新增資源').click(); await dialog.getByLabel('項目種類', { exact: true }).selectOption('text'); await fields('Single save', '只存一次'); await preview();
    let calls = 0, release; const gate = new Promise(resolve => { release = resolve; });
    await page.route('**/api/resources', async route => {
      if (route.request().method() !== 'POST') return route.continue();
      calls++; await gate; await route.fulfill({ status: 500, json: { error: 'internal detail' } });
    }, { times: 1 });
    await dialog.getByRole('button', { name: '確認儲存草稿', exact: true }).click();
    await expect(dialog.getByRole('button', { name: '確認儲存草稿', exact: true })).toBeDisabled();
    await page.keyboard.press('Enter'); expect(calls).toBe(1); release();
    await expect(dialog.getByRole('alert')).toContainText('儲存失敗'); await expect(dialog.getByLabel('English · 名稱', { exact: true })).toHaveValue('Single save');
    await dialog.getByRole('button', { name: '確認儲存草稿', exact: true }).click(); await expect(dialog).toHaveCount(0);
    expect((await snapshot()).items.filter(item => item.title.en === 'Single save')).toHaveLength(1);
  });
  await step('HTTPS validation, type switching, keyboard cancel and 320/390/1440px layouts', async () => {
    await button('新增資源').click(); await fields('Invalid URL', '網址測試');
    await dialog.getByLabel('HTTPS 連結', { exact: true }).fill('http://example.org');
    await dialog.getByRole('button', { name: '下一步：預覽翻譯', exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText('HTTPS'); await expect(dialog.getByRole('alert')).toBeFocused();
    await dialog.getByLabel('項目種類', { exact: true }).selectOption('email_request'); await expect(dialog.getByLabel('HTTPS 連結', { exact: true })).toHaveCount(0);
    for (const width of [320, 390, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      if (width <= 900) await expect.poll(async () => (await page.locator('.admin-sidebar').boundingBox()).x + (await page.locator('.admin-sidebar').boundingBox()).width).toBeLessThanOrEqual(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      expect(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
      for (const control of await dialog.locator('.admin-actions button').all()) expect((await control.boundingBox()).height).toBeGreaterThanOrEqual(44);
      await page.screenshot({ path: `output/playwright/resource-topics-editor-${width}.png` });
    }
    accept(); await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0); await expect(button('新增資源')).toBeFocused();
    for (const width of [320, 390, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      if (width <= 900) await expect.poll(async () => (await page.locator('.admin-sidebar').boundingBox()).x + (await page.locator('.admin-sidebar').boundingBox()).width).toBeLessThanOrEqual(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: `output/playwright/resource-topics-list-${width}.png` });
    }
  });
  await step('English and Simplified Chinese topic/item controls remain usable', async () => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.locator('.admin-languages').getByRole('button', { name: 'EN', exact: true }).click();
    await button('Topics').click(); await button('Add topic').click(); await expect(dialog.getByLabel('English · Name', { exact: true })).toBeVisible();
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.locator('.admin-languages').getByRole('button', { name: '简', exact: true }).click();
    await button('项目管理').click(); await button('新增资源').click(); await expect(dialog.getByLabel('项目种类', { exact: true })).toBeVisible();
    await dialog.getByRole('button', { name: '取消', exact: true }).click();
    await page.locator('.admin-languages').getByRole('button', { name: '繁', exact: true }).click();
    expect(pageErrors).toEqual([]);
  });
  await step('320px topic creation and 390px item creation/save are operable, not just within viewport bounds', async () => {
    await page.setViewportSize({ width: 320, height: 900 }); await topics(); await button('新增主題').click();
    await fields('Mobile Topic', '手機主題'); await save('確認發布');
    const mobileTopic = (await snapshot()).topics.find(t => t.title.en === 'Mobile Topic');
    await expect(row('手機主題')).toBeVisible();
    await page.setViewportSize({ width: 390, height: 900 }); await items(); await button('新增資源').click();
    await dialog.getByLabel('所屬主題', { exact: true }).selectOption(mobileTopic.id);
    await dialog.getByLabel('項目種類', { exact: true }).selectOption('text'); await fields('Mobile Item', '手機資源');
    await save(); await expect(row('手機資源')).toBeVisible();
    await page.screenshot({ path: 'output/playwright/resource-topics-mobile-saved.png' });
    expect(pageErrors).toEqual([]);
  });
  await step('Cross-tab refresh updates saved lists without replacing another open editor draft', async () => {
    const other = await context.newPage(); await other.goto(origin + '/admin/resources');
    const otherRow = other.locator('.admin-resource-list article').filter({ has: other.getByRole('heading', { name: '手機資源', exact: true }) });
    await expect(otherRow).toBeVisible();
    await row('手機資源').getByRole('button', { name: '發布', exact: true }).click();
    await expect(otherRow.getByRole('button', { name: '隱藏', exact: true })).toBeVisible();
    await otherRow.getByRole('button', { name: '編輯', exact: true }).click();
    const otherDialog = other.locator('.admin-resource-dialog');
    await otherDialog.getByLabel('English · 名稱', { exact: true }).fill('Unsaved other tab input');
    const refreshed = other.waitForResponse(response => response.url().endsWith('/api/resources?admin=1') && response.ok());
    accept(); await row('手機資源').getByRole('button', { name: '隱藏', exact: true }).click(); await refreshed;
    await expect(otherDialog.getByLabel('English · 名稱', { exact: true })).toHaveValue('Unsaved other tab input');
    other.once('dialog', confirmation => confirmation.accept()); await otherDialog.getByRole('button', { name: '取消', exact: true }).click();
    await expect(otherRow.getByRole('button', { name: '發布', exact: true })).toBeVisible();
    await other.close();
  });
  console.log(`Checkpoint 3: ${passed} admin workflow checks passed. Only isolated test data was written.`);
} catch (error) {
  if (page) { console.error(await page.locator('body').innerText()); await page.screenshot({ path: 'output/playwright/resource-topics-admin-failure.png', fullPage: true }); }
  console.error(logs.slice(-5000)); throw error;
} finally { await browser?.close(); child.kill(); }
