// The homepage calendar end to end: the built application behind the checked-in hosting
// headers, disposable local storage and test-only sessions. No production credentials, data
// or requests are used. HEADED=1 runs it in a visible browser, slowly.
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';
import { localContext, noHorizontalOverflow, startAcademyServer } from './helpers/academy-smoke.mjs';

const secret = 'home-calendar-local-acceptance-only-not-production';
const owner = 'calendar-owner@example.test', outsider = 'signed-in-visitor@example.test';
const server = await startAcademyServer({ port: 3260, secret, owners: [owner], name: 'home-calendar' });
const { origin, directory } = server;
const api = `${origin}/api/home-calendar`;
const report = { startedAt: new Date().toISOString(), origin, productionVerified: false, checks: [], externalRequests: [], status: 'running' };
const headed = process.env.HEADED === '1';
let browser, failure;

async function check(name, action) {
  try { await action(); report.checks.push({ name, status: 'passed' }); console.log(`PASS ${name}`); }
  catch (error) { report.checks.push({ name, status: 'failed', error: error.message }); throw error; }
}
const shot = (page, name, options = {}) => page.screenshot({ path: path.join(directory, `${name}.png`), ...options });
const published = async () => (await fetch(api)).json();
const context = options => localContext(browser, origin, { external: report.externalRequests, locale: 'zh-TW', timezoneId: 'Asia/Taipei', ...options });
const taipeiDate = offsetDays => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' })
  .format(new Date(Date.now() + offsetDays * 86_400_000));
const expectedRefusal = message => /Failed to load resource: the server responded with a status of (401|403|409)/.test(message);
const box = async (page, selector) => page.locator(selector).first().boundingBox();

async function home(page) {
  await page.goto(`${origin}/`);
  await expect(page.locator('[data-home-calendar] .home-calendar-grid')).toBeVisible();
}
async function adminPage(page) {
  await page.goto(`${origin}/admin/calendar`);
  await expect(page.locator('.admin-calendar h1')).toBeVisible();
  await expect(page.locator('.admin-page-head .admin-button.primary')).toBeEnabled();
}
async function fillEvent(page, values) {
  const form = page.locator('.admin-calendar-form');
  for (const [name, value] of Object.entries(values)) {
    if (name === 'allDay') await form.locator('[name="allDay"]').setChecked(value);
    else await form.locator(`[name="${name}"]`).fill(value);
  }
}

try {
  browser = await chromium.launch({ headless: !headed, slowMo: headed ? 350 : 0 });
  const visitorContext = await context();
  const visitor = await visitorContext.newPage();
  const consoleProblems = [];
  const watch = page => {
    page.on('console', message => { if (message.type() === 'error' && !expectedRefusal(message.text())) consoleProblems.push(message.text()); });
    page.on('pageerror', error => consoleProblems.push(error.message));
  };
  watch(visitor);

  await check('the calendar starts empty: version 1, no events, no editor identity', async () => {
    const initial = await published();
    expect(initial).toEqual({ config: { schemaVersion: 1, timeZone: 'Asia/Taipei', events: [] }, recordVersion: 1 });
  });

  await check('desktop (1440 px): the calendar sits to the right of the photo, empty, without admin controls', async () => {
    await visitor.setViewportSize({ width: 1440, height: 900 });
    await home(visitor);
    const photo = await box(visitor, '.hero-photo'), calendar = await box(visitor, '[data-home-calendar]');
    expect(calendar.x).toBeGreaterThanOrEqual(photo.x + photo.width - 1);
    expect(calendar.y).toBeLessThan(photo.y + photo.height);
    expect(calendar.y + calendar.height).toBeGreaterThan(photo.y);
    await expect(visitor.locator('[data-home-calendar] .home-calendar-title')).toHaveText('活動行事曆');
    await expect(visitor.locator('[data-home-calendar] .home-calendar-empty')).toHaveText('目前沒有活動。');
    await expect(visitor.locator(`[data-home-calendar] [data-date="${taipeiDate(0)}"]`)).toHaveAttribute('aria-current', 'date');
    await expect(visitor.locator('.home-calendar-admin')).toHaveCount(0);
    expect(await noHorizontalOverflow(visitor)).toBe(true);
    await shot(visitor, '01-home-desktop-empty', { clip: { x: 0, y: 0, width: 1440, height: 760 } });
  });

  await check('visitors, signed-in non-administrators and cross-site requests cannot save', async () => {
    const body = { config: (await published()).config, expectedVersion: 1 };
    expect((await visitorContext.request.post(api, { headers: { Origin: origin }, data: body })).status()).toBe(401);
    const outsiderContext = await context({ email: outsider, secret });
    expect((await outsiderContext.request.post(api, { headers: { Origin: origin }, data: body })).status()).toBe(403);
    await outsiderContext.close();
    const ownerRequest = await context({ email: owner, secret });
    expect((await ownerRequest.request.post(api, { headers: { Origin: 'https://evil.example' }, data: body })).status()).toBe(403);
    await ownerRequest.close();
    expect((await published()).recordVersion).toBe(1);
  });

  const ownerContext = await context({ email: owner, secret });
  const admin = await ownerContext.newPage();
  watch(admin);
  const date = taipeiDate(3);

  await check('the owner adds an event in /admin/calendar; an invalid time is caught before saving', async () => {
    await admin.setViewportSize({ width: 1280, height: 900 });
    await adminPage(admin);
    await expect(admin.locator('.admin-empty')).toBeVisible();
    await shot(admin, '02-admin-empty');
    await admin.locator('.admin-page-head .admin-button.primary').click();
    await fillEvent(admin, { title: '志工培訓說明會', date, startTime: '19:00', endTime: '18:00' });
    await admin.locator('.admin-calendar-form button[type="submit"]').click();
    await expect(admin.locator('.admin-calendar-problem')).toBeVisible();
    expect((await published()).recordVersion).toBe(1);
    await fillEvent(admin, { endTime: '20:30', description: '線上說明會，介紹志工培訓流程。\n歡迎家長一起參加。', linkUrl: 'https://example.org/join', linkLabel: '報名表單' });
    await shot(admin, '03-admin-form');
    await admin.locator('.admin-calendar-form button[type="submit"]').click();
    await expect(admin.locator('.admin-alert.success')).toBeVisible();
    await expect(admin.locator('[data-calendar-event] h3')).toHaveText('志工培訓說明會');
    const saved = await published();
    expect(saved.recordVersion).toBe(2);
    expect(saved.config.events).toEqual([expect.objectContaining({ title: '志工培訓說明會', date, startTime: '19:00', endTime: '20:30', link: { url: 'https://example.org/join', label: '報名表單' } })]);
    await shot(admin, '04-admin-saved');
  });

  await check('the homepage shows the saved event in Taipei time, with a dot on its day', async () => {
    await home(visitor);
    const item = visitor.locator('[data-home-calendar] [data-calendar-event]');
    await expect(item.locator('h3')).toHaveText('志工培訓說明會');
    await expect(item.locator('.home-calendar-event-when')).toContainText('19:00–20:30 台北時間');
    await expect(item.locator('.home-calendar-event-local')).toHaveCount(0);
    await expect(item.locator('a')).toHaveAttribute('href', 'https://example.org/join');
    await expect(item.locator('a')).toHaveAttribute('rel', 'noopener noreferrer');
    if (date.slice(0, 7) === taipeiDate(0).slice(0, 7)) await expect(visitor.locator(`[data-date="${date}"]`)).toHaveClass(/has-events/);
    await shot(visitor, '05-home-desktop-event', { clip: { x: 0, y: 0, width: 1440, height: 760 } });
  });

  await check('a visitor in New York also sees the local time; English labels follow the language switch', async () => {
    const usContext = await context({ locale: 'en-US', timezoneId: 'America/New_York' });
    const us = await usContext.newPage();
    watch(us);
    await us.setViewportSize({ width: 1440, height: 900 });
    await home(us);
    await expect(us.locator('[data-home-calendar] .home-calendar-title')).toHaveText('Event calendar');
    const local = us.locator('[data-home-calendar] .home-calendar-event-local');
    await expect(local).toContainText('Your time:');
    await expect(local).toContainText(/\(E[SD]T\)$/);
    await us.locator('#langSwitch button[data-lang="zhTW"]').click();
    await expect(us.locator('[data-home-calendar] .home-calendar-title')).toHaveText('活動行事曆');
    await expect(local).toContainText(/^你的當地時間：.*（E[SD]T）$/);
    await shot(us, '06-home-new-york', { clip: { x: 0, y: 0, width: 1440, height: 760 } });
    await usContext.close();
  });

  await check('an administrator sees "✎ 管理行事曆" on the homepage', async () => {
    const page = await ownerContext.newPage();
    watch(page);
    await home(page);
    await expect(page.locator('.home-calendar-admin')).toHaveAttribute('href', '/admin/calendar');
    await page.close();
  });

  await check('selecting a day lists only that day; an empty day says so', async () => {
    await home(visitor);
    const other = taipeiDate(1);
    if (other.slice(0, 7) === taipeiDate(0).slice(0, 7)) {
      await visitor.locator(`[data-date="${other}"]`).click();
      await expect(visitor.locator('[data-home-calendar] .home-calendar-empty')).toHaveText('這天沒有活動。');
      await visitor.locator(`[data-date="${other}"]`).click();
    }
    await visitor.locator('.home-calendar-nav button').last().click();
    await expect(visitor.locator('.home-calendar-today')).toBeVisible();
    await visitor.locator('.home-calendar-today').click();
    await expect(visitor.locator('.home-calendar-today')).toHaveCount(0);
  });

  await check('a save from a stale page is refused with a conflict and changes nothing', async () => {
    const stale = await ownerContext.newPage();
    watch(stale);
    await adminPage(stale);
    await admin.locator('[data-calendar-event] .admin-actions .admin-button').first().click();
    await fillEvent(admin, { title: '志工培訓說明會（更新）' });
    await admin.locator('.admin-calendar-form button[type="submit"]').click();
    await expect(admin.locator('.admin-alert.success')).toBeVisible();
    expect((await published()).recordVersion).toBe(3);
    await stale.locator('.admin-page-head .admin-button.primary').click();
    await fillEvent(stale, { title: '另一個活動', date, allDay: true });
    await stale.locator('.admin-calendar-form button[type="submit"]').click();
    await expect(stale.locator('.admin-alert[role="alert"]')).toContainText('其他管理員剛更新了行事曆');
    expect((await published()).recordVersion).toBe(3);
    await stale.close();
    await home(visitor);
    await expect(visitor.locator('[data-calendar-event] h3')).toHaveText('志工培訓說明會（更新）');
  });

  await check('medium (1100 px) and phone (390 px) layouts: the calendar moves below the photo, no sideways scrolling', async () => {
    await visitor.setViewportSize({ width: 1100, height: 900 });
    await home(visitor);
    let photo = await box(visitor, '.hero-photo'), calendar = await box(visitor, '[data-home-calendar]');
    expect(calendar.y).toBeGreaterThanOrEqual(photo.y + photo.height - 1);
    expect(await noHorizontalOverflow(visitor)).toBe(true);
    await visitor.locator('[data-home-calendar]').screenshot({ path: path.join(directory, '07-home-medium-calendar.png') });
    await visitor.setViewportSize({ width: 390, height: 844 });
    await home(visitor);
    photo = await box(visitor, '.hero-photo'); calendar = await box(visitor, '[data-home-calendar]');
    expect(calendar.y).toBeGreaterThanOrEqual(photo.y + photo.height - 1);
    expect(calendar.width).toBeLessThanOrEqual(390);
    expect(await noHorizontalOverflow(visitor)).toBe(true);
    await visitor.locator('[data-home-calendar]').scrollIntoViewIfNeeded();
    await visitor.locator('[data-home-calendar]').screenshot({ path: path.join(directory, '08-home-phone-calendar.png') });
    await admin.setViewportSize({ width: 390, height: 844 });
    await adminPage(admin);
    expect(await noHorizontalOverflow(admin)).toBe(true);
    await shot(admin, '09-admin-phone', { fullPage: true });
    await admin.setViewportSize({ width: 1280, height: 900 });
  });

  await check('the owner deletes the event after confirming; the homepage is empty again', async () => {
    await adminPage(admin);
    await admin.locator('[data-calendar-event] .admin-actions .admin-button').nth(1).click();
    await expect(admin.locator('.admin-calendar-confirm')).toBeVisible();
    await shot(admin, '10-admin-confirm-delete');
    await admin.locator('.admin-calendar-confirm .admin-button.danger').click();
    await expect(admin.locator('.admin-empty')).toBeVisible();
    expect(await published()).toMatchObject({ recordVersion: 4, config: { events: [] } });
    await visitor.setViewportSize({ width: 1440, height: 900 });
    await home(visitor);
    await expect(visitor.locator('[data-home-calendar] .home-calendar-empty')).toHaveText('目前沒有活動。');
  });

  await check('the audit log recorded created, updated and deleted; no browser errors; no outside requests', async () => {
    const { readFile } = await import('node:fs/promises');
    const stored = JSON.parse(await readFile(path.join(directory, 'home-calendar.json'), 'utf8'));
    expect(stored.activity.map(entry => entry.changedFields[0].split('.').pop())).toEqual(['created', 'updated', 'deleted']);
    expect(stored.activity.every(entry => entry.actorEmail === owner && entry.entityType === 'calendar')).toBe(true);
    // The homepage's existing video section requests YouTube thumbnails (i.ytimg.com); this test
    // blocks every outside request, so the browser logs each blocked one as ERR_FAILED. The
    // calendar itself must cause no outside request and no other error.
    const outside = new Set(report.externalRequests.map(url => new URL(url).host));
    expect([...outside].filter(host => host !== 'i.ytimg.com')).toEqual([]);
    const blocked = consoleProblems.filter(message => message === 'Failed to load resource: net::ERR_FAILED');
    expect(blocked.length).toBeLessThanOrEqual(report.externalRequests.length);
    expect(consoleProblems.filter(message => message !== 'Failed to load resource: net::ERR_FAILED')).toEqual([]);
  });
  report.status = 'passed';
} catch (error) {
  failure = error;
  report.status = 'failed';
} finally {
  report.finishedAt = new Date().toISOString();
  report.screenshots = directory;
  await writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2));
  await browser?.close();
  server.child.kill();
}
console.log(`${report.status.toUpperCase()}: ${report.checks.filter(item => item.status === 'passed').length}/${report.checks.length} checks; evidence in ${directory}`);
if (failure) { console.error(failure); process.exitCode = 1; }
