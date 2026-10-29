// The homepage calendar across screen sizes and the full calendar page (/events) with its three
// layouts (Monthly, Agenda, Pinboard), on the built application with disposable local storage
// and a test-only owner session. No production credentials, data or requests are used.
// home-calendar.smoke.mjs (the accepted 12 checks) is left unchanged; this file adds to it.
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';
import { localContext, noHorizontalOverflow, startAcademyServer } from './helpers/academy-smoke.mjs';

const secret = 'home-calendar-views-local-only-not-production';
const owner = 'calendar-owner@example.test';
const server = await startAcademyServer({ port: 3262, secret, owners: [owner], name: 'home-calendar-views' });
const { origin, directory } = server;
const api = `${origin}/api/home-calendar`;
const report = { startedAt: new Date().toISOString(), origin, productionVerified: false, checks: [], layouts: [], externalRequests: [], status: 'running' };
let browser, failure;

async function check(name, action) {
  try { await action(); report.checks.push({ name, status: 'passed' }); console.log(`PASS ${name}`); }
  catch (error) { report.checks.push({ name, status: 'failed', error: error.message }); throw error; }
}
const shot = (page, name, options = {}) => page.screenshot({ path: path.join(directory, `${name}.png`), ...options });
const context = options => localContext(browser, origin, { external: report.externalRequests, locale: 'zh-TW', timezoneId: 'Asia/Taipei', ...options });
const taipeiDate = days => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(Date.now() + days * 86_400_000));
const boxes = page => page.evaluate(() => {
  const rect = selector => { const node = document.querySelector(selector); if (!node) return null; const r = node.getBoundingClientRect(); return { x: r.x, y: r.y + scrollY, width: r.width, height: r.height }; };
  return { text: rect('.hero-grid > div:first-child'), photo: rect('.hero-photo'), fc1: rect('.float-card.fc1'), fc2: rect('.float-card.fc2'), calendar: rect('[data-home-calendar]'), stats: rect('.stats-band'), hero: rect('.hero') };
});
// Any element of the hero's text column that reaches past the column (into the photo).
const textSpills = page => page.evaluate(() => {
  const column = document.querySelector('.hero-grid > div:first-child');
  const right = column.getBoundingClientRect().right;
  return [...column.querySelectorAll('h1, h1 *, p, a, span')].filter(node => node.getBoundingClientRect().right > right + 1).map(node => node.tagName.toLowerCase());
});
const overlap = (a, b) => Boolean(a && b) && a.x < b.x + b.width - 1 && b.x < a.x + a.width - 1 && a.y < b.y + b.height - 1 && b.y < a.y + a.height - 1;
const empty = text => text.includes('目前沒有活動');

try {
  browser = await chromium.launch({ headless: process.env.HEADED !== '1' });
  const visitorContext = await context();
  const visitor = await visitorContext.newPage();
  const problems = [];
  visitor.on('pageerror', error => problems.push(error.message));

  await check('the empty calendar page: all three layouts show the empty state, on a computer and a phone', async () => {
    for (const [width, height, label] of [[1440, 900, 'desktop'], [390, 844, 'phone']]) {
      await visitor.setViewportSize({ width, height });
      for (const view of ['monthly', 'agenda', 'pinboard']) {
        await visitor.goto(`${origin}/events?view=${view}`);
        const body = visitor.locator('[data-home-calendar-page] [data-calendar-layout]');
        await expect(body).toHaveAttribute('data-calendar-layout', view);
        await expect(visitor.locator(`[data-calendar-view="${view}"]`)).toHaveAttribute('aria-selected', 'true');
        expect(empty(await body.innerText())).toBe(true);
        expect(await noHorizontalOverflow(visitor)).toBe(true);
        await shot(visitor, `empty-${view}-${label}`, { fullPage: label === 'phone' });
      }
    }
  });

  const ownerContext = await context({ email: owner, secret });
  const events = [
    { id: 'event-0001', title: '志工培訓說明會', date: taipeiDate(2), startTime: '19:00', endTime: '20:30', description: '線上說明會，介紹志工培訓流程。\n歡迎家長一起參加。', link: { url: 'https://example.org/join', label: '報名表單' } },
    { id: 'event-0002', title: '期中家長座談', date: taipeiDate(5), startTime: null, endTime: null, description: '', link: null },
    { id: 'event-0003', title: '英文口說工作坊', date: taipeiDate(9), startTime: '10:00', endTime: '11:30', description: '分組練習日常對話，請先準備自我介紹。', link: { url: 'https://example.org/workshop', label: '' } },
    { id: 'event-0004', title: '線上讀書會', date: taipeiDate(9), startTime: '14:00', endTime: null, description: '', link: null },
    { id: 'event-0005', title: '上月成果分享會', date: taipeiDate(-7), startTime: '15:00', endTime: '16:00', description: '回顧上個月的輔導成果。', link: null },
  ];
  await check('the owner saves five events (four ahead, one past) through the existing API', async () => {
    const response = await ownerContext.request.post(api, { headers: { Origin: origin }, data: { config: { schemaVersion: 1, timeZone: 'Asia/Taipei', events }, expectedVersion: 1 } });
    expect(response.status()).toBe(200);
    expect((await (await fetch(api)).json()).config.events).toHaveLength(5);
  });

  await check('the homepage calendar links to the full calendar page', async () => {
    await visitor.setViewportSize({ width: 1440, height: 900 });
    await visitor.goto(`${origin}/`);
    const link = visitor.locator('[data-home-calendar] .home-calendar-all');
    await expect(link).toHaveText('查看所有活動 →');
    await link.click();
    await expect(visitor).toHaveURL(`${origin}/events`);
    await expect(visitor.locator('.home-calendar-page-title')).toHaveText('活動行事曆');
  });

  await check('Monthly: titles inside the days on a computer, dots and the day list on a phone', async () => {
    const target = events[0].date;
    await visitor.setViewportSize({ width: 1440, height: 900 });
    await visitor.goto(`${origin}/events?view=monthly`);
    if (target.slice(0, 7) !== taipeiDate(0).slice(0, 7)) await visitor.locator('.home-calendar-nav button').last().click();
    await expect(visitor.locator(`[data-date="${target}"] .home-calendar-chip`)).toContainText('志工培訓說明會');
    await expect(visitor.locator('.home-calendar-page .home-calendar-list [data-calendar-event]').first()).toBeVisible();
    await shot(visitor, 'with-events-monthly-desktop', { fullPage: true });
    await visitor.setViewportSize({ width: 390, height: 844 });
    await visitor.reload();
    if (target.slice(0, 7) !== taipeiDate(0).slice(0, 7)) await visitor.locator('.home-calendar-nav button').last().click();
    await expect(visitor.locator(`[data-date="${target}"] .home-calendar-chips`)).toBeHidden();
    await visitor.locator(`[data-date="${target}"]`).click();
    await expect(visitor.locator('.home-calendar-page .home-calendar-list h3')).toHaveText('志工培訓說明會');
    expect(await noHorizontalOverflow(visitor)).toBe(true);
    await shot(visitor, 'with-events-monthly-phone', { fullPage: true });
  });

  await check('Agenda: upcoming events by month with date badges; past events behind a button', async () => {
    await visitor.setViewportSize({ width: 1440, height: 900 });
    await visitor.goto(`${origin}/events?view=agenda`);
    const items = visitor.locator('.home-calendar-agenda-item');
    await expect(items).toHaveCount(4);
    await expect(items.first().locator('.home-calendar-agenda-title')).toHaveText('志工培訓說明會');
    await expect(items.first().locator('.home-calendar-event-when')).toHaveText('19:00–20:30 台北時間');
    await shot(visitor, 'with-events-agenda-desktop', { fullPage: true });
    await visitor.locator('.home-calendar-agenda .home-calendar-more').click();
    await expect(items).toHaveCount(5);
    await expect(visitor.locator('.home-calendar-agenda-section')).toHaveText('已過去的活動');
    await visitor.setViewportSize({ width: 390, height: 844 });
    await visitor.goto(`${origin}/events?view=agenda`);
    expect(await noHorizontalOverflow(visitor)).toBe(true);
    await shot(visitor, 'with-events-agenda-phone', { fullPage: true });
  });

  await check('Pinboard: one card per upcoming event, links open safely; one column on a phone', async () => {
    await visitor.setViewportSize({ width: 1440, height: 900 });
    await visitor.goto(`${origin}/events?view=pinboard`);
    const cards = visitor.locator('.home-calendar-card');
    await expect(cards).toHaveCount(4);
    const link = cards.first().locator('a');
    await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    await expect(link).toHaveText('報名表單');
    const [first, second] = [await cards.nth(0).boundingBox(), await cards.nth(1).boundingBox()];
    expect(second.x).toBeGreaterThan(first.x);
    await shot(visitor, 'with-events-pinboard-desktop', { fullPage: true });
    await visitor.setViewportSize({ width: 390, height: 844 });
    await visitor.goto(`${origin}/events?view=pinboard`);
    const [a, b] = [await cards.nth(0).boundingBox(), await cards.nth(1).boundingBox()];
    expect(b.y).toBeGreaterThan(a.y + a.height - 1);
    expect(await noHorizontalOverflow(visitor)).toBe(true);
    await shot(visitor, 'with-events-pinboard-phone', { fullPage: true });
  });

  await check('the chosen layout is remembered; a phone with no choice starts on Agenda; English labels follow the switch', async () => {
    await visitor.setViewportSize({ width: 1440, height: 900 });
    await visitor.goto(`${origin}/events`);
    await visitor.locator('[data-calendar-view="pinboard"]').click();
    await expect(visitor).toHaveURL(/view=pinboard/);
    await visitor.goto(`${origin}/events`);
    await expect(visitor.locator('[data-calendar-layout]')).toHaveAttribute('data-calendar-layout', 'pinboard');
    await visitor.locator('[data-calendar-view="pinboard"]').press('ArrowRight');
    await expect(visitor.locator('[data-calendar-layout]')).toHaveAttribute('data-calendar-layout', 'monthly');
    const phoneContext = await context({ viewport: { width: 390, height: 844 } });
    const phone = await phoneContext.newPage();
    await phone.goto(`${origin}/events`);
    await expect(phone.locator('[data-calendar-layout]')).toHaveAttribute('data-calendar-layout', 'agenda');
    await phoneContext.close();
    // The language buttons sit in the header at this width (on a phone they are inside the menu).
    await visitor.locator('#langSwitch button[data-lang="en"]').click();
    await expect(visitor.locator('[data-calendar-view="agenda"]')).toHaveText('Agenda');
    await expect(visitor.locator('.home-calendar-page-title')).toHaveText('Event calendar');
    await visitor.locator('#langSwitch button[data-lang="zhTW"]').click();
    await expect(visitor.locator('.home-calendar-page-title')).toHaveText('活動行事曆');
  });

  await check('homepage layout at eight sizes: three columns from 1280 px, the calendar below otherwise; no overlap, no sideways scroll, stats kept', async () => {
    const sizes = [[1920, 1080, 'desktop-1920'], [1440, 900, 'laptop-1440'], [1366, 768, 'laptop-1366'], [1280, 800, 'laptop-1280'],
      [1180, 820, 'tablet-landscape-1180'], [1024, 1366, 'tablet-portrait-1024'], [820, 1180, 'tablet-portrait-820'], [390, 844, 'phone-390']];
    for (const [width, height, label] of sizes) {
      await visitor.setViewportSize({ width, height });
      await visitor.goto(`${origin}/`);
      await expect(visitor.locator('[data-home-calendar] .home-calendar-grid')).toBeVisible();
      const b = await boxes(visitor);
      const threeColumns = b.calendar.x >= b.photo.x + b.photo.width - 1 && b.calendar.y < b.photo.y + b.photo.height;
      const row = { label, width, height, threeColumns, photoWidth: Math.round(b.photo.width), calendarWidth: Math.round(b.calendar.width), overflow: !(await noHorizontalOverflow(visitor)) };
      report.layouts.push(row);
      expect(threeColumns).toBe(width >= 1280);
      if (!threeColumns) expect(b.calendar.y).toBeGreaterThanOrEqual(b.photo.y + b.photo.height - 1);
      for (const [name, other] of [['photo', b.photo], ['stat card 1', b.fc1], ['stat card 2', b.fc2], ['text', b.text]]) {
        expect(overlap(b.calendar, other), `${label}: calendar overlaps the ${name}`).toBe(false);
      }
      expect(row.overflow, `${label}: sideways scroll`).toBe(false);
      expect(b.stats && b.stats.y >= b.hero.y + b.hero.height - 1, `${label}: the stats band stays below the hero`).toBe(true);
      if (width >= 1280) expect(row.photoWidth, `${label}: photo too small`).toBeGreaterThanOrEqual(400);
      expect(await textSpills(visitor), `${label}: the hero text runs out of its column`).toEqual([]);
      await shot(visitor, `home-${label}`, { clip: { x: 0, y: 0, width, height: Math.min(Math.ceil(b.stats.y + 140), 2600) } });
    }
  });

  await check('the English hero text also stays inside its column at the three-column sizes', async () => {
    const englishContext = await context({ locale: 'en-US' });
    const english = await englishContext.newPage();
    for (const width of [1280, 1366, 1440, 1920]) {
      await english.setViewportSize({ width, height: 900 });
      await english.goto(`${origin}/`);
      await expect(english.locator('[data-home-calendar] .home-calendar-title')).toHaveText('Event calendar');
      expect(await textSpills(english), `English ${width}: the hero text runs out of its column`).toEqual([]);
      if (width === 1440) await shot(english, 'home-laptop-1440-english', { clip: { x: 0, y: 0, width, height: 900 } });
    }
    await englishContext.close();
  });

  await check('no page errors and no outside requests other than the homepage video thumbnails', async () => {
    expect(problems).toEqual([]);
    expect([...new Set(report.externalRequests.map(url => new URL(url).host))].filter(host => host !== 'i.ytimg.com')).toEqual([]);
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
for (const row of report.layouts) console.log(`  ${row.label}: ${row.threeColumns ? '3 columns' : 'calendar below'}, photo ${row.photoWidth}px, calendar ${row.calendarWidth}px`);
if (failure) { console.error(failure); process.exitCode = 1; }
