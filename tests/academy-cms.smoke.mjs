// The Academy content editor at /admin/academy, end to end: the built application
// behind the checked-in hosting headers, disposable local storage and test-only
// sessions. No production credentials, data or requests are used.
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';
import { localContext, localDocument, noHorizontalOverflow, setSession, startAcademyServer } from './helpers/academy-smoke.mjs';

const secret = 'academy-cms-local-acceptance-only-not-production';
const owner = 'academy-owner@example.test', editor = 'academy-editor@example.test', outsider = 'signed-in-visitor@example.test';
const server = await startAcademyServer({ port: 3230, secret, owners: [owner], name: 'academy-cms' });
const { origin, directory } = server;
const api = `${origin}/api/academy-content`;
const report = { startedAt: new Date().toISOString(), origin, productionVerified: false, checks: [], externalRequests: [], signInPageRequests: [], status: 'running' };
let browser, failure;

async function check(name, action) {
  try { await action(); report.checks.push({ name, status: 'passed' }); console.log(`PASS ${name}`); }
  catch (error) { report.checks.push({ name, status: 'failed', error: error.message }); throw error; }
}
const shot = (page, name, options = {}) => page.screenshot({ path: path.join(directory, `${name}.png`), ...options });
const published = async () => (await fetch(api)).json();
const post = (context, data, headers = { Origin: origin }) => context.request.post(api, { headers, data });
const field = (page, key) => page.locator(`[id="${key}"]`);
const P0 = { TWD: { 45: ['800', '1000'], 60: ['1000', '1400'] }, USD: { 45: ['25', '34'], 60: ['34', '45'] } };
const context = options => localContext(browser, origin, { external: report.externalRequests, ...options });
// Console noise the browser itself writes for an expected refused response.
const expectedRefusal = message => /Failed to load resource: the server responded with a status of (401|403|409)/.test(message);

async function openBlock(page, block) {
  const details = page.locator(`details[data-academy-editor-block="${block}"]`);
  if (!(await details.evaluate(node => node.open))) await details.locator('summary').click();
  return details;
}
async function waitForEditor(page) {
  await expect(page.locator('[data-academy-editor-review]')).toBeVisible();
  await expect(page.getByText('正在載入已發布內容…', { exact: true })).toHaveCount(0);
}
async function publishReviewed(page) {
  await page.locator('[data-academy-editor-review]').click();
  await expect(page.locator('.admin-academy-review')).toBeVisible();
  await page.locator('[data-academy-editor-publish]').click();
}

try {
  browser = await chromium.launch({ headless: true });
  const ownerContext = await context({ email: owner, secret });
  const page = await ownerContext.newPage();
  const consoleProblems = [];
  page.on('console', message => { if (message.type() === 'error' && !expectedRefusal(message.text())) consoleProblems.push(message.text()); });
  page.on('pageerror', error => consoleProblems.push(error.message));

  await check('anonymous, expired, non-administrator and cross-site requests are refused', async () => {
    const initial = await published();
    expect(Object.keys(initial).sort()).toEqual(['config', 'recordVersion']);
    expect(initial.recordVersion).toBe(1);
    expect(JSON.stringify(initial)).not.toMatch(/@example\.test/);
    const body = { config: initial.config, expectedVersion: 1 };
    // These contexts reach the existing Auth.js sign-in page, which requests its
    // provider logo from authjs.dev; that request is blocked and recorded separately.
    const anonymous = await context({ external: report.signInPageRequests });
    let response = await post(anonymous, body);
    expect(response.status()).toBe(401); expect((await response.json()).code).toBe('SIGN_IN_REQUIRED');
    response = await anonymous.request.post(`${api}/preview`, { headers: { Origin: origin }, data: { config: initial.config, locale: 'en' } });
    expect(response.status()).toBe(401);
    const expired = await context({ email: owner, secret, maxAge: -60, external: report.signInPageRequests });
    response = await post(expired, body);
    expect(response.status()).toBe(401); expect((await response.json()).code).toBe('SIGN_IN_REQUIRED');
    const visitor = await context({ email: outsider, secret });
    response = await post(visitor, body);
    expect(response.status()).toBe(403); expect((await response.json()).code).toBe('FORBIDDEN');
    response = await post(ownerContext, body, {});
    expect(response.status()).toBe(403); expect((await response.json()).code).toBe('ORIGIN_NOT_ALLOWED');
    response = await post(ownerContext, body, { Origin: 'https://attacker.example' });
    expect(response.status()).toBe(403);
    // The editor page itself follows the existing admin login.
    const anonymousPage = await anonymous.newPage();
    await anonymousPage.goto(`${origin}/admin/academy`);
    expect(new URL(anonymousPage.url()).pathname).toBe('/api/auth/signin');
    const expiredPage = await expired.newPage();
    await expiredPage.goto(`${origin}/admin/academy`);
    expect(new URL(expiredPage.url()).pathname).toBe('/api/auth/signin');
    const visitorPage = await visitor.newPage();
    await visitorPage.goto(`${origin}/admin/academy`);
    expect(new URL(visitorPage.url())).toMatchObject({ pathname: '/auth-error', search: '?error=AccessDenied' });
    await shot(visitorPage, 'visitor-access-denied');
    expect((await published()).recordVersion).toBe(1);
    await Promise.all([anonymous.close(), expired.close(), visitor.close()]);
  });

  await check('the editor loads the eight published P0 prices with computed ten-session prices', async () => {
    await page.goto(`${origin}/admin/academy`);
    await waitForEditor(page);
    for (const [currency, durations] of Object.entries(P0)) {
      for (const [duration, [highschool, college]] of Object.entries(durations)) {
        await expect(field(page, `pricing.rates.${currency}.${duration}.highschool`)).toHaveValue(highschool);
        await expect(field(page, `pricing.rates.${currency}.${duration}.college`)).toHaveValue(college);
      }
    }
    for (const [key, text] of [['TWD.45.highschool', 'NT$7,200'], ['TWD.45.college', 'NT$9,000'], ['TWD.60.highschool', 'NT$9,000'], ['TWD.60.college', 'NT$12,600'],
      ['USD.45.highschool', 'US$225'], ['USD.45.college', 'US$306'], ['USD.60.highschool', 'US$306'], ['USD.60.college', 'US$405']]) {
      await expect(page.locator(`[data-academy-package="pricing.rates.${key}"]`)).toHaveText(text);
    }
    await expect(page.locator('[data-academy-editor-review]')).toBeDisabled();
    await expect(page.locator('.admin-academy-actions [role="status"]')).toHaveText('所有內容皆已發布');
    await shot(page, 'admin-desktop', { fullPage: true });
  });

  await check('prices and text are validated as they are typed; an invalid draft cannot be published', async () => {
    const price = field(page, 'pricing.rates.TWD.45.highschool');
    const error = page.locator('[id="pricing.rates.TWD.45.highschool-error"]');
    for (const [value, message] of [['-800', '請輸入整數金額'], ['12.5', '請輸入整數金額'], ['1,000', '請輸入整數金額'], ['八百', '請輸入整數金額'],
      ['0', '請輸入 1–100,000 之間的金額。'], ['100001', '請輸入 1–100,000 之間的金額。'], ['', '此欄位不能空白。']]) {
      await price.fill(value);
      await expect(error).toContainText(message);
      await expect(price).toHaveAttribute('aria-invalid', 'true');
      await expect(page.locator('[data-academy-package="pricing.rates.TWD.45.highschool"]')).toHaveText('—');
    }
    await page.locator('[data-academy-editor-review]').click();
    await expect(page.locator('.admin-academy-review')).toBeHidden();
    await expect(price).toBeFocused();
    await shot(page, 'admin-validation');
    await price.fill('800');
    await expect(error).toHaveCount(0);
    await field(page, 'pricing.rates.USD.60.college').fill('30');
    await expect(page.locator('[id="pricing.rates.USD.60.college-warning"]')).toContainText('大學生導師的價格低於高中生導師');
    await field(page, 'pricing.rates.USD.60.college').fill('45');
    await openBlock(page, 'hero');
    const cta = field(page, 'content.zhHant.hero.cta');
    await cta.fill('');
    await expect(page.locator('[id="content.zhHant.hero.cta-error"]')).toHaveText('此欄位不能空白。');
    await cta.fill('字'.repeat(201));
    await expect(page.locator('[id="content.zhHant.hero.cta-error"]')).toHaveText('請在 200 字以內。');
    await expect(page.locator('[id="content.zhHant.hero.cta-count"]')).toHaveText('201/200 字');
    await cta.fill('詢問適合的課程');
    await expect(page.locator('[data-academy-editor-review]')).toBeDisabled();
  });

  await check('a preview renders the unsaved draft with the page renderer and saves nothing', async () => {
    await field(page, 'pricing.rates.TWD.45.highschool').fill('850');
    await expect(page.locator('[data-academy-package="pricing.rates.TWD.45.highschool"]')).toHaveText('NT$7,650');
    await openBlock(page, 'hero');
    await field(page, 'content.zhHant.hero.cta').fill('預約免費諮詢');
    await page.getByRole('tab', { name: '英文頁面', exact: true }).click();
    await openBlock(page, 'hero');
    await field(page, 'content.en.hero.cta').fill('Book a free consultation');
    await page.locator('[data-academy-editor-preview]').click();
    const dialog = page.locator('.admin-academy-preview');
    await expect(dialog).toBeVisible();
    const preview = page.frameLocator('.admin-academy-preview iframe');
    await expect(preview.locator('[data-academy-field="hero.cta"]')).toHaveText('Book a free consultation');
    await expect(preview.locator('[data-academy-generated="faq-prices"]')).toContainText('US$25 / NT$850 for 45 minutes');
    await expect(preview.locator('[data-academy-generated="faq-prices"]')).toContainText('US$225 / NT$7,650 (45 minutes)');
    // The page script runs inside the preview under the editor's content policy.
    await preview.locator('input[name="currency"][value="TWD"]').check({ force: true });
    await preview.locator('input[name="duration"][value="45"]').check({ force: true });
    await expect(preview.locator('#price')).toHaveText('NT$850');
    await expect(preview.locator('.academy-edit-trigger, .academy-admin-toolbar')).toHaveCount(0);
    await shot(page, 'admin-preview-en');
    await dialog.getByRole('button', { name: '繁體中文頁面', exact: true }).click();
    await expect(preview.locator('[data-academy-field="hero.cta"]')).toHaveText('預約免費諮詢');
    await expect(preview.locator('[data-academy-generated="faq-prices"]')).toContainText('高中生導師：45 分鐘 NT$850／US$25');
    await page.locator('[data-academy-preview-close]').click();
    await expect(dialog).toBeHidden();
    const current = await published();
    expect(current.recordVersion).toBe(1);
    expect(current.config.pricing.rates.TWD['45'].highschool).toBe(800);
    expect(current.config.content.en['hero.cta']).not.toBe('Book a free consultation');
  });

  await check('the review lists every change, and a second publish click cannot send a second save', async () => {
    await page.locator('[data-academy-editor-review]').click();
    const review = page.locator('.admin-academy-review');
    await expect(review).toBeVisible();
    for (const text of ['NT$800 → NT$850', 'NT$7,200 → NT$7,650', '預約免費諮詢', 'Book a free consultation']) await expect(review).toContainText(text);
    await shot(page, 'admin-review');
    let posts = 0, release;
    const gate = new Promise(resolve => { release = resolve; });
    await page.route('**/api/academy-content', async route => {
      if (route.request().method() === 'POST') { posts++; await gate; }
      await route.continue();
    });
    const publish = page.locator('[data-academy-editor-publish]');
    await publish.click();
    await expect(publish).toBeDisabled();
    await expect(publish).toHaveText('發布中…');
    await publish.dispatchEvent('click');
    await page.locator('form.admin-form').evaluate(form => form.requestSubmit());
    release();
    await expect(page.locator('[data-academy-editor-saved]')).toHaveText('已發布。重新整理課程頁即可看到更新。');
    await page.unroute('**/api/academy-content');
    expect(posts).toBe(1);
    const saved = await published();
    expect(saved.recordVersion).toBe(2);
    expect(saved.config.pricing.rates.TWD['45'].highschool).toBe(850);
    expect(saved.config.content.zhHant['hero.cta']).toBe('預約免費諮詢');
    expect(saved.config.content.en['hero.cta']).toBe('Book a free consultation');
    const document = await localDocument(directory);
    expect(document.activity).toHaveLength(1);
    expect(document.activity[0]).toMatchObject({ actorEmail: owner, actorRole: 'owner', action: 'academy.content.updated', entityType: 'academy', entityVersion: 2,
      changedFields: ['pricing.TWD.45.highschool', 'zhHant.hero.cta', 'en.hero.cta'] });
  });

  await check('visitors see the published prices and text everywhere, with JavaScript on and off', async () => {
    const visitor = await context();
    const visitorPage = await visitor.newPage();
    const adminRequests = [];
    visitorPage.on('request', request => { const { pathname } = new URL(request.url()); if (/^\/(api\/)?admin/.test(pathname)) adminRequests.push(pathname); });
    let response = await visitorPage.goto(`${origin}/academy/courses/zh?entry=official`);
    expect(response.status()).toBe(200);
    expect(response.headers()['cache-control']).toContain('no-store');
    await expect(visitorPage.locator('body')).toHaveAttribute('data-academy-version', '2');
    await expect(visitorPage.locator('[data-academy-field="hero.cta"]')).toHaveText('預約免費諮詢');
    await visitorPage.locator('input[name="duration"][value="45"]').check({ force: true });
    await expect(visitorPage.locator('#price')).toHaveText('NT$850');
    await visitorPage.locator('input[name="plan"][value="package"]').check({ force: true });
    await expect(visitorPage.locator('#price')).toHaveText('NT$7,650');
    const zhFaq = visitorPage.locator('details[data-academy-pricing-faq]');
    await zhFaq.locator('summary').click();
    await expect(zhFaq).toContainText('高中生導師：45 分鐘 NT$850／US$25');
    await expect(zhFaq).toContainText('十堂方案為九折：高中生導師 45 分鐘 NT$7,650／US$225');
    expect(await visitorPage.content()).not.toMatch(/NT\$800|NT\$7,200/);
    // The sticky site header would otherwise cover the top of the section.
    await shot(visitorPage.locator('#pricing'), 'visitor-after-admin-publish', { style: 'header { visibility: hidden; }' });
    response = await visitorPage.goto(`${origin}/academy/courses?entry=official`);
    expect(response.status()).toBe(200);
    await expect(visitorPage.locator('[data-academy-field="hero.cta"]')).toHaveText('Book a free consultation');
    expect(await visitorPage.content()).not.toMatch(/預約免費諮詢|NT\$800|NT\$7,200/);
    const enFaq = visitorPage.locator('details[data-academy-pricing-faq]');
    await enFaq.locator('summary').click();
    await expect(enFaq).toContainText('US$25 / NT$850 for 45 minutes');
    await expect(enFaq).toContainText('high-school tutor US$225 / NT$7,650 (45 minutes)');
    await expect(visitorPage.locator('.academy-edit-trigger, .academy-admin-toolbar')).toHaveCount(0);
    expect(adminRequests).toEqual([]);
    const noJs = await context({ javaScriptEnabled: false });
    const staticPage = await noJs.newPage();
    await staticPage.goto(`${origin}/academy/courses/zh?entry=official`);
    const table = staticPage.locator('table.price-table');
    await expect(table).toBeVisible();
    await expect(table).toContainText('NT$850');
    await expect(table).toContainText('NT$7,650');
    expect(await staticPage.content()).not.toMatch(/NT\$800|NT\$7,200/);
    await Promise.all([visitor.close(), noJs.close()]);
  });

  await check('unsaved changes are protected from reloads, navigation and closing the tab', async () => {
    const price = field(page, 'pricing.rates.USD.45.highschool');
    const status = page.locator('.admin-academy-actions [role="status"]');
    const unloadBlocked = () => page.evaluate(() => { const event = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented; });
    expect(await unloadBlocked()).toBe(false);
    await price.fill('26');
    await expect(status).toHaveText('尚有未發布的變更');
    expect(await unloadBlocked()).toBe(true);
    await page.locator('[data-academy-editor-reload]').click();
    const reload = page.locator('dialog:has(#academy-reload-title)');
    await expect(reload).toBeVisible();
    await reload.getByRole('button', { name: '繼續編輯', exact: true }).click();
    await expect(price).toHaveValue('26');
    await page.locator('.admin-sidebar nav button', { hasText: '總覽' }).click();
    const leave = page.locator('dialog:has(#admin-confirm-title)');
    await expect(leave).toBeVisible();
    await leave.getByRole('button', { name: '繼續編輯', exact: true }).click();
    expect(new URL(page.url()).pathname).toBe('/admin/academy');
    await page.locator('[data-academy-editor-reload]').click();
    await page.locator('[data-academy-editor-reload-confirm]').click();
    await expect(price).toHaveValue('25');
    await expect(status).toHaveText('所有內容皆已發布');
    expect(await unloadBlocked()).toBe(false);
  });

  const create = await ownerContext.request.post(`${origin}/api/admin/accounts`, { headers: { Origin: origin }, data: { email: editor } });
  expect(create.status()).toBe(201);
  const editorAccount = (await create.json()).account;
  const editorContext = await context({ email: editor, secret });
  const editorPage = await editorContext.newPage();
  editorPage.on('pageerror', error => consoleProblems.push(error.message));

  await check('a stale draft is refused with a conflict, keeps the draft, and publishes after reloading', async () => {
    await editorPage.goto(`${origin}/admin/academy`);
    await waitForEditor(editorPage);
    await field(page, 'pricing.rates.USD.60.college').fill('46');
    await publishReviewed(page);
    await expect(page.locator('[data-academy-editor-saved]')).toBeVisible();
    expect((await published()).recordVersion).toBe(3);
    await field(editorPage, 'pricing.rates.USD.45.highschool').fill('27');
    await publishReviewed(editorPage);
    await expect(editorPage.locator('#academy-content-error')).toContainText('另一位管理員已發布較新的版本');
    await expect(field(editorPage, 'pricing.rates.USD.45.highschool')).toHaveValue('27');
    await expect(editorPage.locator('[data-academy-editor-review]')).toBeDisabled();
    let current = await published();
    expect(current.recordVersion).toBe(3);
    expect(current.config.pricing.rates.USD['45'].highschool).toBe(25);
    await shot(editorPage, 'admin-conflict');
    await editorPage.locator('[data-academy-editor-reload]').click();
    await editorPage.locator('[data-academy-editor-reload-confirm]').click();
    await expect(field(editorPage, 'pricing.rates.USD.60.college')).toHaveValue('46');
    await field(editorPage, 'pricing.rates.USD.45.highschool').fill('27');
    await publishReviewed(editorPage);
    await expect(editorPage.locator('[data-academy-editor-saved]')).toBeVisible();
    current = await published();
    expect(current.recordVersion).toBe(4);
    expect(current.config.pricing.rates.USD['45']).toEqual({ highschool: 27, college: 34 });
    expect(current.config.pricing.rates.USD['60'].college).toBe(46);
  });

  await check('an expired sign-in or revoked access is reported, keeps the draft, and never pretends to save', async () => {
    await editorContext.clearCookies();
    await setSession(editorContext, origin, secret, editor, -60);
    await field(editorPage, 'pricing.rates.USD.45.college').fill('35');
    await publishReviewed(editorPage);
    const access = editorPage.locator('[data-academy-editor-access]');
    await expect(access).toHaveAttribute('data-academy-editor-access', 'signin');
    await expect(access).toContainText('登入已過期');
    await expect(access.getByRole('link', { name: '在新分頁重新登入' })).toHaveAttribute('href', '/api/auth/signin?callbackUrl=%2Fadmin%2Facademy');
    await expect(editorPage.locator('[data-academy-editor-saved]')).toHaveCount(0);
    await expect(field(editorPage, 'pricing.rates.USD.45.college')).toHaveValue('35');
    await shot(editorPage, 'admin-expired-session');
    expect((await published()).recordVersion).toBe(4);
    await editorPage.locator('[data-academy-editor-access-retry]').click();
    await expect(access).toHaveAttribute('data-academy-editor-access', 'signin');
    await editorContext.clearCookies();
    await setSession(editorContext, origin, secret, editor);
    await editorPage.locator('[data-academy-editor-access-retry]').click();
    await expect(access).toHaveCount(0);
    await publishReviewed(editorPage);
    await expect(editorPage.locator('[data-academy-editor-saved]')).toBeVisible();
    expect((await published()).recordVersion).toBe(5);

    const revoke = await ownerContext.request.patch(`${origin}/api/admin/accounts/${encodeURIComponent(editor)}`, { headers: { Origin: origin }, data: { enabled: false, version: editorAccount.version } });
    expect(revoke.status()).toBe(200);
    await field(editorPage, 'pricing.rates.USD.45.college').fill('36');
    await publishReviewed(editorPage);
    await expect(access).toHaveAttribute('data-academy-editor-access', 'forbidden');
    await expect(access).toContainText('這個帳號目前沒有管理權限');
    await expect(field(editorPage, 'pricing.rates.USD.45.college')).toHaveValue('36');
    await shot(editorPage, 'admin-forbidden');
    const current = await published();
    expect(current.recordVersion).toBe(5);
    expect(current.config.pricing.rates.USD['45'].college).toBe(35);
    await editorPage.goto(`${origin}/admin/academy`);
    expect(new URL(editorPage.url()).pathname).toBe('/auth-error');
  });

  await check('every publication is in the audit log and failed attempts add nothing', async () => {
    const document = await localDocument(directory);
    expect(document.activity.map(entry => [entry.entityVersion, entry.actorEmail, entry.actorRole])).toEqual([
      [2, owner, 'owner'], [3, owner, 'owner'], [4, editor, 'editor'], [5, editor, 'editor'],
    ]);
    expect(document.activity.map(entry => entry.changedFields)).toEqual([
      ['pricing.TWD.45.highschool', 'zhHant.hero.cta', 'en.hero.cta'], ['pricing.USD.60.college'], ['pricing.USD.45.highschool'], ['pricing.USD.45.college'],
    ]);
  });

  await check('the editor fits phone screens and offers an English interface', async () => {
    for (const width of [320, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`${origin}/admin/academy`);
      await waitForEditor(page);
      expect(await noHorizontalOverflow(page)).toBe(true);
      if (width === 390) await shot(page, 'admin-mobile', { fullPage: true });
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.getByRole('button', { name: 'EN', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Academy course pages', level: 1 })).toBeVisible();
    await expect(page.getByText('Lesson prices', { exact: true })).toBeVisible();
    await expect(page.locator('[data-academy-package="pricing.rates.TWD.45.highschool"]')).toHaveText('NT$7,650');
    await shot(page, 'admin-english');
  });

  await check('no external request, page error or content-policy violation occurred', async () => {
    expect(report.externalRequests).toEqual([]);
    expect(new Set(report.signInPageRequests)).toEqual(new Set(['https://authjs.dev/img/providers/google.svg']));
    expect(consoleProblems).toEqual([]);
  });
  report.status = 'passed';
} catch (error) {
  failure = error;
  report.status = 'failed';
  console.error(server.logs().slice(-4000));
} finally {
  report.finishedAt = new Date().toISOString();
  await writeFile(path.join(directory, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  await browser?.close();
  server.child.kill();
  console.log(`Academy editor evidence: ${directory}`);
}
if (failure) throw failure;
