// Pencil editing on the public Academy course pages, end to end: the built
// application behind the checked-in hosting headers, disposable local storage
// and test-only sessions. No production credentials, data or requests are used.
import { readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';
import { localContext, localDocument, noHorizontalOverflow, setSession, startAcademyServer } from './helpers/academy-smoke.mjs';

const secret = 'academy-inline-local-acceptance-only-not-production';
const owner = 'academy-owner@example.test', editor = 'academy-editor@example.test', outsider = 'signed-in-visitor@example.test';
const registry = JSON.parse(await readFile('data/academy-fields.json', 'utf8'));
const server = await startAcademyServer({ port: 3232, secret, owners: [owner], name: 'academy-inline' });
const { origin, directory } = server;
const foreignOrigin = 'http://localhost:3234';
const zhUrl = `${origin}/academy/courses/zh?entry=official`, enUrl = `${origin}/academy/courses?entry=official`;
const report = { startedAt: new Date().toISOString(), origin, productionVerified: false, checks: [], externalRequests: [], status: 'running' };
let browser, failure, foreign;

async function check(name, action) {
  try { await action(); report.checks.push({ name, status: 'passed' }); console.log(`PASS ${name}`); }
  catch (error) { report.checks.push({ name, status: 'failed', error: error.message }); throw error; }
}
const shot = (target, name, options = {}) => target.screenshot({ path: path.join(directory, `${name}.png`), ...options });
const published = async () => (await fetch(`${origin}/api/academy-content`)).json();
const context = options => localContext(browser, origin, { external: report.externalRequests, ...options });
const expectedRefusal = message => /Failed to load resource: the server responded with a status of (401|403)/.test(message);

function watchAdminRequests(page) {
  const requests = [];
  page.on('request', request => { const { pathname } = new URL(request.url()); if (/^\/(api\/)?admin/.test(pathname)) requests.push(pathname); });
  return requests;
}

// Every pencil stays inside the page width, is a comfortable touch target, and
// covers no visible text or image.
async function pencilLayout(page) {
  return page.evaluate(() => {
    const problems = [];
    const visible = rect => rect.width > 1 && rect.height > 1;
    const overlaps = (a, b) => a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1;
    const triggers = [...document.querySelectorAll('.academy-edit-trigger')].filter(node => !node.hidden);
    const covered = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!node.textContent.trim() || node.parentElement.closest('.academy-edit-trigger, .academy-admin-toolbar, noscript, script, style')) continue;
      // Text that is not rendered, such as a closed FAQ answer, cannot be covered.
      if (!node.parentElement.checkVisibility({ visibilityProperty: true, contentVisibilityAuto: true })) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      for (const rect of range.getClientRects()) if (visible(rect)) covered.push({ rect, what: node.textContent.trim().slice(0, 40) });
    }
    for (const image of document.querySelectorAll('img')) {
      const rect = image.getBoundingClientRect();
      if (visible(rect)) covered.push({ rect, what: `img ${image.getAttribute('src')}` });
    }
    for (const trigger of triggers) {
      const rect = trigger.getBoundingClientRect();
      const block = trigger.dataset.academyEditBlock;
      if (rect.left < -0.5 || rect.right > document.documentElement.clientWidth + 0.5) problems.push(`${block}: outside the page width`);
      if (rect.width < 44 || rect.height < 44) problems.push(`${block}: smaller than 44px`);
      for (const item of covered) if (overlaps(rect, item.rect)) problems.push(`${block}: covers "${item.what}"`);
    }
    return { count: triggers.length, problems };
  });
}

async function openPencil(page, block) {
  await page.locator(`[data-academy-edit-block="${block}"]`).click();
  const dialog = page.locator('#academy-content-editor');
  await expect(dialog).toHaveAttribute('data-ready', 'true', { timeout: 30000 });
  return { dialog, frame: page.frameLocator('.academy-editor-frame') };
}

async function publishInEditor(page, frame) {
  await frame.locator('[data-academy-editor-review]').click();
  await expect(frame.locator('.admin-academy-review')).toBeVisible();
  const reloaded = page.waitForEvent('load');
  await frame.locator('[data-academy-editor-publish]').click();
  await reloaded;
  await expect(page.locator('#academy-content-editor')).toHaveCount(0);
}

try {
  browser = await chromium.launch({ headless: true });
  const zhBlocks = registry.locales.zhHant.blocks, enBlocks = registry.locales.en.blocks;

  await check('visitors, signed-in non-administrators and expired sessions get no controls and send no admin requests', async () => {
    for (const [label, options] of [['anonymous', {}], ['non-administrator', { email: outsider, secret }], ['expired administrator', { email: owner, secret, maxAge: -60 }]]) {
      const visitorContext = await context(options);
      const page = await visitorContext.newPage();
      const adminRequests = watchAdminRequests(page);
      for (const url of [zhUrl, enUrl]) {
        for (const width of [320, 390, 1440]) {
          await page.setViewportSize({ width, height: 900 });
          const response = await page.goto(url);
          expect(response.status(), label).toBe(200);
          await page.waitForLoadState('networkidle');
          expect(await page.locator('body').getAttribute('data-academy-admin'), label).toBeNull();
          await expect(page.locator('.academy-edit-trigger, .academy-admin-toolbar, #academy-content-editor')).toHaveCount(0);
          expect(await noHorizontalOverflow(page), `${label} ${width}`).toBe(true);
          if (label === 'anonymous' && width !== 320) await shot(page, `visitor-${url === zhUrl ? 'zh' : 'en'}-${width}`);
        }
      }
      expect(adminRequests, label).toEqual([]);
      // The API refuses this browser regardless of what its page shows.
      const status = await page.evaluate(async () => {
        const current = await (await fetch('/api/academy-content')).json();
        return (await fetch('/api/academy-content', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ config: current.config, expectedVersion: current.recordVersion }) })).status;
      });
      expect(status, label).toBe(label === 'non-administrator' ? 403 : 401);
      await visitorContext.close();
    }
    expect((await published()).recordVersion).toBe(1);
  });

  const ownerContext = await context({ email: owner, secret });
  const page = await ownerContext.newPage();
  const consoleProblems = [];
  page.on('console', message => { if (message.type() === 'error' && !expectedRefusal(message.text())) consoleProblems.push(message.text()); });
  page.on('pageerror', error => consoleProblems.push(error.message));

  await check('an administrator sees a pencil on every editable section, covering nothing', async () => {
    for (const [url, blocks] of [[zhUrl, zhBlocks], [enUrl, enBlocks]]) {
      for (const width of [320, 390, 1440]) {
        await page.setViewportSize({ width, height: 900 });
        await page.goto(url);
        await expect(page.locator('body')).toHaveAttribute('data-academy-admin', 'available');
        await expect(page.locator('.academy-admin-toolbar')).toBeVisible();
        await expect(page.locator('.academy-edit-trigger')).toHaveCount(blocks.length);
        expect(await page.locator('.academy-edit-trigger').evaluateAll(nodes => nodes.map(node => node.dataset.academyEditBlock))).toEqual(blocks);
        const layout = await pencilLayout(page);
        expect(layout.problems, `${url} ${width}`).toEqual([]);
        expect(await noHorizontalOverflow(page), `${url} ${width}`).toBe(true);
      }
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(zhUrl);
    await shot(page, 'inline-zh-pencils');
    await page.locator('#pricing').scrollIntoViewIfNeeded();
    await shot(page, 'inline-zh-pricing-pencil');
    const toggle = page.locator('[data-academy-admin-toggle]');
    await toggle.click();
    await expect(page.locator('.academy-edit-trigger:visible')).toHaveCount(0);
    await toggle.click();
    await expect(page.locator('.academy-edit-trigger:visible')).toHaveCount(zhBlocks.length);
  });

  await check('pencil, editor, preview, publish: the page reloads with the saved text, which persists', async () => {
    await page.goto(zhUrl);
    const before = await page.locator('[data-academy-field="hero.cta"]').innerText();
    const { dialog, frame } = await openPencil(page, 'hero');
    await expect(frame.locator('h1')).toHaveText('編輯：首頁主視覺');
    await expect(frame.locator('[data-academy-editor-block]')).toHaveCount(1);
    await expect(frame.locator('[id^="content.en."], .admin-academy-prices')).toHaveCount(0);
    await shot(page, 'inline-editor-hero');
    await frame.locator('[id="content.zhHant.hero.cta"]').fill('立即預約諮詢');
    await frame.locator('[data-academy-editor-preview]').click();
    const preview = frame.frameLocator('.admin-academy-preview iframe');
    await expect(preview.locator('[data-academy-field="hero.cta"]')).toHaveText('立即預約諮詢');
    await expect(preview.locator('.academy-edit-trigger')).toHaveCount(0);
    await shot(page, 'inline-editor-preview');
    await frame.locator('[data-academy-preview-close]').click();
    // Until it is published, the draft exists only in the editor.
    await expect(page.locator('[data-academy-field="hero.cta"]')).toHaveText(before);
    expect((await published()).recordVersion).toBe(1);
    await expect(dialog).toBeVisible();
    await publishInEditor(page, frame);
    await expect(page.locator('[data-academy-field="hero.cta"]')).toHaveText('立即預約諮詢');
    await expect(page.locator('body')).toHaveAttribute('data-academy-version', '2');
    await page.reload();
    await expect(page.locator('[data-academy-field="hero.cta"]')).toHaveText('立即預約諮詢');
    await shot(page, 'inline-after-publish');
    // The central editor reads the same published content.
    const admin = await ownerContext.newPage();
    await admin.goto(`${origin}/admin/academy`);
    await admin.locator('details[data-academy-editor-block="hero"] summary').click();
    await expect(admin.locator('[id="content.zhHant.hero.cta"]')).toHaveValue('立即預約諮詢');
    await admin.locator('[id="content.zhHant.hero.cta"]').scrollIntoViewIfNeeded();
    await shot(admin, 'inline-admin-sync');
    await admin.close();
    const visitor = await context();
    const visitorPage = await visitor.newPage();
    await visitorPage.goto(zhUrl);
    await expect(visitorPage.locator('[data-academy-field="hero.cta"]')).toHaveText('立即預約諮詢');
    await visitorPage.goto(enUrl);
    await expect(visitorPage.locator('[data-academy-field="hero.cta"]')).toHaveText('Find your tutor');
    await visitor.close();
  });

  await check('the price pencil opens the complete price editor and every price on both pages follows', async () => {
    const { frame } = await openPencil(page, 'pricing.card');
    await expect(frame.locator('.admin-academy-price input')).toHaveCount(8);
    await expect(frame.locator('[id="pricing.rates.USD.60.highschool"]')).toHaveValue('34');
    await expect(frame.locator('[id="content.zhHant.pricing.card.tutor.college"]')).toHaveValue('大學生導師');
    await frame.locator('[id="pricing.rates.USD.60.highschool"]').fill('36');
    await expect(frame.locator('[data-academy-package="pricing.rates.USD.60.highschool"]')).toHaveText('US$324');
    await shot(page, 'inline-editor-pricing');
    await publishInEditor(page, frame);
    await expect(page.locator('body')).toHaveAttribute('data-academy-version', '3');
    await page.locator('input[name="currency"][value="USD"]').check({ force: true });
    await expect(page.locator('#price')).toHaveText('US$36');
    await expect(page.locator('[data-tutor-price="highschool"]')).toHaveText('US$36／堂');
    const zhFaq = page.locator('details[data-academy-pricing-faq]');
    await expect(zhFaq).toContainText('60 分鐘 NT$1,000／US$36');
    await expect(zhFaq).toContainText('60 分鐘 NT$9,000／US$324');
    // Opened directly: a click on the question could land on its ✎ button.
    await zhFaq.evaluate(node => { node.open = true; });
    await shot(zhFaq, 'inline-faq-prices');
    const { dialog: faqDialog, frame: faqFrame } = await openPencil(page, 'faq.item7');
    await expect(faqFrame.locator('[id="content.zhHant.faq.item7.answerLead"]')).toBeVisible();
    await expect(faqFrame.getByText('這一題的價格列表會依課程價格自動產生，請只修改列表前後的文字。', { exact: true })).toBeVisible();
    await shot(page, 'inline-editor-faq');
    await page.locator('[data-academy-editor-close]').click();
    await expect(faqDialog).toHaveCount(0);
    const visitor = await context();
    const visitorPage = await visitor.newPage();
    await visitorPage.goto(enUrl);
    await expect(visitorPage.locator('#price')).toHaveText('US$36');
    const enFaq = visitorPage.locator('details[data-academy-pricing-faq]');
    await expect(enFaq).toContainText('US$36 / NT$1,000 for 60 minutes');
    await expect(enFaq).toContainText('US$324 / NT$9,000 (60 minutes)');
    expect(await visitorPage.content()).not.toContain('US$34 / NT$1,000 for 60 minutes');
    await visitor.close();
  });

  await check('closing the editor with an unsaved draft asks first, and discarding saves nothing', async () => {
    const question = page.locator('[data-academy-field="faq.item1.question"]');
    const details = page.locator('details[data-academy-block="faq.item1"]');
    const { dialog, frame } = await openPencil(page, 'faq.item1');
    // The pencil inside a question opens the editor without opening the answer.
    expect(await details.evaluate(node => node.open)).toBe(false);
    await frame.locator('[id="content.zhHant.faq.item1.question"]').fill('新的問題？');
    await page.locator('[data-academy-editor-close]').click();
    await expect(frame.locator('#academy-close-title')).toBeVisible();
    await frame.locator('[data-academy-editor-keep]').click();
    await expect(frame.locator('[id="content.zhHant.faq.item1.question"]')).toHaveValue('新的問題？');
    await page.locator('#academy-content-editor').press('Escape');
    await expect(frame.locator('#academy-close-title')).toBeVisible();
    await frame.locator('[data-academy-editor-discard]').click();
    await expect(dialog).toHaveCount(0);
    await expect(page.locator('[data-academy-edit-block="faq.item1"]')).toBeFocused();
    await expect(question).not.toContainText('新的問題？');
    expect((await published()).recordVersion).toBe(3);
  });

  await check('an expired sign-in removes the pencils and offers to sign in again instead of opening the editor', async () => {
    await ownerContext.clearCookies();
    await setSession(ownerContext, origin, secret, owner, -60);
    await page.locator('[data-academy-edit-block="hero"]').click();
    const toolbar = page.locator('.academy-admin-toolbar');
    await expect(toolbar.locator('[data-academy-admin-note]')).toHaveText('登入已過期，請重新登入後再編輯。');
    await expect(toolbar.locator('[data-academy-admin-signin]')).toHaveAttribute('href', '/api/auth/signin?callbackUrl=%2Facademy%2Fcourses%2Fzh%3Fentry%3Dofficial');
    await expect(page.locator('#academy-content-editor')).toHaveCount(0);
    await expect(page.locator('.academy-edit-trigger')).toHaveCount(0);
    await shot(page, 'inline-expired-session');
    await ownerContext.clearCookies();
    await setSession(ownerContext, origin, secret, owner);
    await toolbar.locator('[data-academy-admin-retry]').click();
    await expect(page.locator('.academy-edit-trigger')).toHaveCount(zhBlocks.length);
    await expect(toolbar.locator('[data-academy-admin-note]')).toHaveText('管理員模式：點選 ✎ 即可編輯該區塊。');
  });

  await check('a revoked editor loses the pencils on the next check and on reload', async () => {
    const create = await ownerContext.request.post(`${origin}/api/admin/accounts`, { headers: { Origin: origin }, data: { email: editor } });
    expect(create.status()).toBe(201);
    const account = (await create.json()).account;
    const editorContext = await context({ email: editor, secret });
    const editorPage = await editorContext.newPage();
    await editorPage.goto(enUrl);
    await expect(editorPage.locator('.academy-edit-trigger')).toHaveCount(enBlocks.length);
    const revoke = await ownerContext.request.patch(`${origin}/api/admin/accounts/${encodeURIComponent(editor)}`, { headers: { Origin: origin }, data: { enabled: false, version: account.version } });
    expect(revoke.status()).toBe(200);
    await editorPage.locator('[data-academy-edit-block="hero"]').click();
    await expect(editorPage.locator('[data-academy-admin-note]')).toHaveText('This account does not have administrator access, so it cannot edit the course page.');
    await expect(editorPage.locator('#academy-content-editor')).toHaveCount(0);
    await expect(editorPage.locator('.academy-edit-trigger')).toHaveCount(0);
    await editorPage.reload();
    expect(await editorPage.locator('body').getAttribute('data-academy-admin')).toBeNull();
    await expect(editorPage.locator('.academy-edit-trigger, .academy-admin-toolbar')).toHaveCount(0);
    await editorContext.close();
  });

  await check('pencils and the editor work on a phone without covering text or widening the page', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(zhUrl);
    await expect(page.locator('.academy-edit-trigger')).toHaveCount(zhBlocks.length);
    expect((await pencilLayout(page)).problems).toEqual([]);
    await shot(page, 'inline-mobile-pencils');
    const { dialog } = await openPencil(page, 'pricing.card');
    const box = await dialog.boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(390);
    const frame = page.frames().find(item => new URL(item.url()).pathname === '/admin/academy');
    expect(await frame.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await shot(page, 'inline-mobile-editor');
    await page.locator('[data-academy-editor-close]').click();
    await expect(dialog).toHaveCount(0);
  });

  await check('another site cannot frame the editor', async () => {
    foreign = createServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end(`<!doctype html><title>Local cross-origin frame test</title><iframe title="Framed editor" src="${origin}/admin/academy?embed=1&amp;locale=en&amp;block=hero"></iframe>`);
    });
    await new Promise((resolve, reject) => { foreign.once('error', reject); foreign.listen(3234, 'localhost', resolve); });
    const framing = await browser.newContext();
    await framing.route('**/*', route => {
      const { origin: target } = new URL(route.request().url());
      return target === origin || target === foreignOrigin ? route.continue() : route.abort();
    });
    await setSession(framing, origin, secret, owner);
    const framingPage = await framing.newPage();
    const refusals = [];
    framingPage.on('console', message => { if (/frame-ancestors|X-Frame-Options/i.test(message.text())) refusals.push(message.text()); });
    await framingPage.goto(`${foreignOrigin}/`);
    await expect.poll(() => refusals.length, { timeout: 10000 }).toBeGreaterThan(0);
    const editorFrames = [];
    for (const item of framingPage.frames()) {
      if (item === framingPage.mainFrame()) continue;
      editorFrames.push(await item.evaluate(() => Boolean(document.querySelector('[data-academy-editor-review]'))).catch(() => false));
    }
    expect(editorFrames.every(rendered => rendered === false)).toBe(true);
    await framing.close();
  });

  await check('publications from the pencil are audited, and nothing external or unexpected happened', async () => {
    const document = await localDocument(directory);
    expect(document.activity.map(entry => [entry.entityVersion, entry.actorEmail, entry.changedFields])).toEqual([
      [2, owner, ['zhHant.hero.cta']], [3, owner, ['pricing.USD.60.highschool']],
    ]);
    expect(report.externalRequests).toEqual([]);
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
  if (foreign) await new Promise(resolve => { foreign.closeAllConnections(); foreign.close(resolve); });
  server.child.kill();
  console.log(`Academy pencil evidence: ${directory}`);
}
if (failure) throw failure;
