// Classroom 2.0 (2026-11-12) in a browser: the room's new layout with the synthetic provider (no Zoom,
// no camera, no request beyond this computer), for a tutor and a student on a computer (1440 and
// 1280 px), a tablet (768) and a phone (390 and 320). It checks what the layout promises: no sideways
// scrolling, the toolbar in sight without scrolling, the title on one line, a name on every button,
// the material first and not covered; the keyboard (toolbar arrows, the menu, panels, Escape); who may
// do what (only the tutor lowers hands or shares); the short raised-hand notice; the row of people on
// phones. It proves our page, not Zoom: how Zoom's own video behaves in this layout needs a real
// session. ROOM2_SOFT=1 records layout problems instead of stopping (for a first look at all sizes).
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, devices, expect } from '@playwright/test';
import { localContext, startAcademyServer } from './helpers/academy-smoke.mjs';

const secret = 'classroom-room2-local-only-not-production';
const owner = 'room2-owner@example.test', tutor = 'room2-tutor@example.test';
Object.assign(process.env, {
  CLASSROOM_PROVIDER: 'synthetic', CLASSROOM_DRIVE: 'local', CLASSROOM_WEBHOOK_SECRET: 'classroom-room2-webhook-local-only',
  CLASSROOM_SYNTHETIC_SECRET: 'classroom-room2-token-local-only', VERCEL_ENV: '',
});
const soft = process.env.ROOM2_SOFT === '1';
const server = await startAcademyServer({ port: 3248, secret, owners: [owner], name: 'classroom-room2' });
const { origin, directory } = server;
const shots = process.env.ROOM2_SHOTS || path.join(directory, 'shots');
await mkdir(shots, { recursive: true });
const report = { startedAt: new Date().toISOString(), origin, synthetic: true, zoomVerified: false, soft, checks: [], layouts: [], layoutProblems: [], externalRequests: [], pageProblems: [] };
let browser, failure;

async function check(name, action) {
  try { await action(); report.checks.push({ name, status: 'passed' }); console.log(`PASS ${name}`); }
  catch (error) { report.checks.push({ name, status: 'failed', error: error.message }); throw error; }
}
// The three kinds of device the room tells apart (lib/classroom-capabilities), as Playwright plays them.
const DEVICES = {
  computer: { label: 'computer', sizes: [[1440, 900], [1280, 800]], options: {} },
  tablet: { label: 'tablet', sizes: [[768, 1024]], options: { userAgent: devices['iPad (gen 7)'].userAgent, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } },
  phone: { label: 'phone', sizes: [[390, 844], [320, 640]], options: { userAgent: devices['iPhone 13'].userAgent, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } },
};
const context = (device, size, email) => localContext(browser, origin, { external: report.externalRequests, secret, email, locale: 'zh-TW', viewport: { width: size[0], height: size[1] }, ...device.options });
function watch(page, who) {
  page.on('console', message => { if (message.type() === 'error') report.pageProblems.push(`${who}: ${message.text()}`); });
  page.on('pageerror', error => report.pageProblems.push(`${who}: ${error.message}`));
  return page;
}
const shot = (page, name) => page.screenshot({ path: path.join(shots, `${name}.png`) });

// What the layout promises, measured in the page at the top of it (no scrolling).
async function measure(page) {
  await page.evaluate(() => window.scrollTo(0, 0));
  return page.evaluate(() => {
    const box = element => {
      if (!element) return null;
      const style = getComputedStyle(element), rect = element.getBoundingClientRect();
      if (style.display === 'none' || style.visibility === 'hidden' || rect.width === 0 || rect.height === 0) return null;
      return { top: Math.round(rect.top), bottom: Math.round(rect.bottom), left: Math.round(rect.left), right: Math.round(rect.right), width: Math.round(rect.width), height: Math.round(rect.height) };
    };
    const title = document.querySelector('.room2-top h1');
    const buttons = [...document.querySelectorAll('button')].filter(button => box(button));
    const room = document.querySelector('.room2');
    return {
      mode: room?.dataset.mode, panel: room?.dataset.panel, focus: room?.dataset.focus, device: room?.dataset.device,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      sideways: document.documentElement.scrollWidth > window.innerWidth,
      titleLines: title ? Math.round(title.getBoundingClientRect().height / parseFloat(getComputedStyle(title).lineHeight)) : 0,
      unnamed: buttons.filter(button => !(button.getAttribute('aria-label') || button.textContent.trim())).map(button => button.className),
      smallTargets: buttons.filter(button => { const rect = button.getBoundingClientRect(); return button.closest('.room2-bar') && (rect.width < 40 || rect.height < 40); }).length,
      bar: box(document.querySelector('.room2-bar')), stage: box(document.querySelector('.room2-stage')), videos: box(document.querySelector('.room2-videos')),
      panelBox: box(document.querySelector('.room2-panel')), menu: box(document.querySelector('.room2-menu')),
      tiles: [...document.querySelectorAll('.classroom-media-tile')].filter(tile => box(tile)).length,
      offStrip: document.querySelector('.room2-more-chip')?.textContent ?? '',
    };
  });
}
// The promises for one layout; a problem stops the run (or, with ROOM2_SOFT=1, is listed).
async function layout(page, name, { material = false } = {}) {
  const m = await measure(page);
  report.layouts.push({ name, ...m });
  await shot(page, name);
  const problems = [];
  if (m.sideways) problems.push('scrolls sideways');
  if (m.titleLines !== 1) problems.push(`title on ${m.titleLines} lines`);
  if (m.unnamed.length) problems.push(`buttons without a name: ${m.unnamed.join(', ')}`);
  if (!m.bar || m.bar.top < 0 || m.bar.bottom > m.viewport.height + 1) problems.push(`toolbar not in sight: ${JSON.stringify(m.bar)}`);
  if (m.smallTargets) problems.push(`${m.smallTargets} toolbar buttons smaller than 40px`);
  if (material && m.stage) {
    if (m.viewport.width >= 1024 && m.focus !== 'on' && m.videos && !(m.videos.left >= m.stage.right - 1 && m.stage.width / m.viewport.width >= 0.6)) problems.push(`stage not first and large: ${JSON.stringify({ stage: m.stage, videos: m.videos })}`);
    if (m.viewport.width < 1024 && m.videos && m.videos.top < m.stage.top) problems.push('people above the material');
    if (m.panelBox && m.viewport.width <= 600) {
      const seen = Math.min(m.panelBox.top, m.stage.bottom) - m.stage.top;
      if (seen / m.stage.height < 0.6) problems.push(`the sheet covers the material (${Math.round(100 * seen / m.stage.height)}% seen)`);
    }
    if (m.stage.bottom > m.viewport.height) problems.push(`the material goes below the screen (${m.stage.bottom} > ${m.viewport.height})`);
  }
  if (problems.length) {
    report.layoutProblems.push({ name, problems });
    console.log(`LAYOUT ${name}: ${problems.join('; ')}`);
    if (!soft) throw new Error(`${name}: ${problems.join('; ')}`);
  }
  return m;
}
const simulate = async (page, scenario) => {
  const panel = page.locator('details.classroom-room-simulator');
  if (!(await panel.evaluate(element => element.open))) await panel.locator('summary').click();
  await page.getByRole('button', { name: scenario, exact: true }).click();
};
async function enter(page, address) {
  await page.goto(address);
  await page.getByRole('button', { name: '進入教室' }).click();
  await expect(page.locator('.room2-top .classroom-room-connection')).toHaveText('已連線');
}

try {
  browser = await chromium.launch({ headless: process.env.IHEAR_HEADED !== '1' });
  const start = new Date(Date.now() + 8 * 3600_000 + 5 * 60_000);
  const lesson = { code: 'TEST-R2', date: start.toISOString().slice(0, 10), time: start.toISOString().slice(11, 16), minutes: 60, tutorCode: 'TEST-RT1', tutorEmail: tutor, studentCode: 'TEST-RS1' };
  const ownerContext = await context(DEVICES.computer, [1280, 900], owner);
  const admin = watch(await ownerContext.newPage(), 'owner');

  await check('an owner adds a one-to-one test lesson through the admin API; the student gets a personal link', async () => {
    await admin.goto(`${origin}/admin/classrooms`);
    const added = await admin.evaluate(async body => {
      const response = await fetch('/api/admin/classrooms', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      return { status: response.status, body: await response.json() };
    }, lesson);
    expect(added.status).toBe(201);
    lesson.id = added.body.lesson.lessonId;
    lesson.link = new URL(added.body.studentLink, origin).href;
    expect(lesson.link).toMatch(/\/classroom\/L-[0-9a-f]{32}#k=/);
  });

  // ---------- A student on a computer ----------
  await check('student, computer: the people fill the stage; a shared screen takes the stage with the people beside it; chat opens beside them', async () => {
    const page = watch(await (await context(DEVICES.computer, [1440, 900])).newPage(), 'student-computer');
    await enter(page, lesson.link);
    await page.getByRole('button', { name: /^攝影機：/ }).click();
    await simulate(page, '對方進入');
    await expect(page.locator('.room2')).toHaveAttribute('data-mode', 'people');
    await layout(page, 'student-1440-people');
    // A student has no share or whiteboard buttons, and raises a hand from the toolbar.
    await expect(page.locator('[data-tool="share"], [data-tool="whiteboard"]')).toHaveCount(0);
    await expect(page.getByRole('button', { name: '舉手', exact: true })).toBeVisible();
    await simulate(page, '對方分享畫面');
    await expect(page.locator('.room2')).toHaveAttribute('data-mode', 'share');
    await expect(page.locator('.room2-stage-label')).toHaveText('分享的畫面');
    for (const size of DEVICES.computer.sizes) {
      await page.setViewportSize({ width: size[0], height: size[1] });
      await layout(page, `student-${size[0]}-share`, { material: true });
    }
    await page.getByRole('button', { name: /^聊天/ }).click();
    await expect(page.getByRole('tab', { name: '聊天' })).toBeFocused();
    await page.getByLabel('訊息').fill('TEST: 老師好');
    await page.getByRole('button', { name: '送出', exact: true }).click();
    await simulate(page, '對方傳來一則訊息');
    await layout(page, 'student-1280-share-chat', { material: true });
    // The participants: their states, and no button to lower anyone's hand (only the tutor may).
    await page.getByRole('tab', { name: '參與者' }).click();
    const list = page.locator('#classroom-people');
    await expect(list.locator('[data-person-row]')).toHaveCount(2);
    await expect(list).toContainText('學生 TEST-RS1（你）');
    await expect(list.getByRole('button')).toHaveCount(0);
    await page.getByRole('button', { name: '舉手', exact: true }).click();
    await expect(list.locator('[data-person-row="self"]')).toContainText('舉手中');
    await expect(page.locator('.room2-notice')).toHaveCount(0);
    await layout(page, 'student-1280-share-people', { material: true });
    await page.getByRole('button', { name: '放下手', exact: true }).click();
    // English, in the same room.
    await page.getByRole('button', { name: 'English' }).click();
    await expect(page.locator('.room2-top h1')).toHaveText('iHear Classroom');
    await layout(page, 'student-1280-share-people-en', { material: true });
    await page.getByRole('button', { name: '繁體中文' }).click();
    await page.context().close();
  });

  // ---------- A tutor on a computer ----------
  let tutorPage;
  await check('tutor, computer: share and whiteboard take the stage; focus mode; the More menu and panels by keyboard', async () => {
    tutorPage = watch(await (await context(DEVICES.computer, [1440, 900], tutor)).newPage(), 'tutor-computer');
    const page = tutorPage;
    await enter(page, `${origin}/classroom/${lesson.id}`);
    for (const name of [/^麥克風：/, /^攝影機：/]) await page.getByRole('button', { name }).click();
    await simulate(page, '對方進入');
    await layout(page, 'tutor-1440-people');
    const share = page.locator('[data-tool="share"]');
    await expect(share).toHaveAccessibleName('分享畫面（教材）');
    await share.click();
    await expect(share).toHaveAttribute('aria-pressed', 'true');
    await expect(share).toHaveAccessibleName('停止分享畫面');
    await expect(page.locator('.room2-stage-label')).toHaveText('你正在分享畫面');
    await layout(page, 'tutor-1440-share', { material: true });
    await share.click();
    const board = page.locator('[data-tool="whiteboard"]');
    await expect(board).toHaveAccessibleName('開啟白板');
    await board.click();
    await expect(page.locator('.room2')).toHaveAttribute('data-mode', 'board');
    await expect(board).toHaveAccessibleName('關閉白板');
    await layout(page, 'tutor-1440-whiteboard', { material: true });
    // Focus mode from the stage, and Escape leaves it.
    await page.locator('.room2-stage-tool', { hasText: '專注模式' }).click();
    await expect(page.locator('.room2')).toHaveAttribute('data-focus', 'on');
    await layout(page, 'tutor-1440-whiteboard-focus', { material: true });
    await page.keyboard.press('Escape');
    await expect(page.locator('.room2')).toHaveAttribute('data-focus', 'off');
    // The toolbar: arrow keys move along it.
    const mic = page.getByRole('button', { name: /^麥克風：/ });
    await mic.focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('button', { name: /^攝影機：/ })).toBeFocused();
    await page.keyboard.press('End');
    await expect(page.getByRole('button', { name: '離開教室' })).toBeFocused();
    // The More menu: opens on the keyboard, arrows move, Escape closes it and gives the focus back.
    const more = page.getByRole('button', { name: '更多', exact: true });
    await more.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('menuitem', { name: '課堂資訊' })).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(page.getByRole('menuitemcheckbox', { name: '專注模式' })).toBeFocused();
    await layout(page, 'tutor-1440-whiteboard-menu', { material: true });
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menu')).toHaveCount(0);
    await expect(more).toBeFocused();
    // A panel opened from the toolbar takes the focus; Escape closes it and gives the focus back.
    const chat = page.getByRole('button', { name: /^聊天/ });
    await chat.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('tab', { name: '聊天' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.locator('.room2-panel')).toBeHidden();
    await expect(chat).toBeFocused();
    await board.click();
  });

  await check('tutor, computer: a raised hand is told for a few seconds, then kept by the counts and the list, where only the tutor lowers it', async () => {
    const page = tutorPage;
    await simulate(page, '5 位測試學生進入');
    await expect(page.locator('.classroom-media-tile')).toHaveCount(7);
    await expect(page.locator('[data-headcount]')).toHaveCount(0);
    await simulate(page, '學生舉手');
    const notice = page.locator('.room2-notice');
    await expect(notice).toContainText('學生 舉手了');
    await expect(page.locator('.classroom-media-tile.remote[data-person="remote"]')).toContainText('舉手中');
    await layout(page, 'tutor-1440-group-hand');
    await expect(notice).toHaveCount(0, { timeout: 8000 });
    await expect(page.locator('[data-hands-chip]')).toContainText('1 位舉手');
    await page.locator('[data-hands-chip]').click();
    const hands = page.locator('.classroom-room-hands');
    await expect(hands.getByRole('button', { name: '放下學生的手', exact: true })).toBeVisible();
    await layout(page, 'tutor-1440-group-people-panel');
    await hands.getByRole('button', { name: '放下學生的手', exact: true }).click();
    await expect(page.locator('[data-hands-chip]')).toHaveCount(0);
    // Enlarging a person is on this page only, and a tile says who is talking.
    const tile = page.locator('.classroom-media-tile[data-person="TEST-S03"]');
    await tile.hover();
    await tile.getByRole('button', { name: '放大 學生 TEST-S03' }).click();
    await expect(tile).toHaveAttribute('data-spotlight', '');
    await simulate(page, '對方說話');
    await expect(page.locator('.classroom-media-tile[data-person="remote"]')).toHaveAttribute('data-speaking', '');
    await page.getByRole('button', { name: /^關閉參與者/ }).click();
    await layout(page, 'tutor-1440-group-spotlight');
    await tile.getByRole('button', { name: '取消放大 學生 TEST-S03' }).click();
    await page.context().close();
  });

  // ---------- Tablet and phone ----------
  for (const [kind, role] of [['tablet', 'student'], ['tablet', 'tutor'], ['phone', 'student'], ['phone', 'tutor']]) {
    await check(`${role}, ${kind}: the material first, the people in a row, the panel without hiding the material, the toolbar in reach`, async () => {
      const device = DEVICES[kind];
      const page = watch(await (await context(device, device.sizes[0], role === 'tutor' ? tutor : undefined)).newPage(), `${role}-${kind}`);
      await enter(page, role === 'tutor' ? `${origin}/classroom/${lesson.id}` : lesson.link);
      await expect(page.locator('.room2')).toHaveAttribute('data-device', kind);
      await page.getByRole('button', { name: /^攝影機：/ }).click();
      await simulate(page, '對方進入');
      await layout(page, `${role}-${device.sizes[0][0]}-people`);
      // Phones and tablets cannot share a screen: no share button in the toolbar.
      await expect(page.locator('.room2-bar [data-tool="share"]')).toHaveCount(0);
      await simulate(page, role === 'tutor' ? '對方開啟白板' : '對方分享畫面');
      await simulate(page, '5 位測試學生進入');
      for (const size of device.sizes) {
        await page.setViewportSize({ width: size[0], height: size[1] });
        const m = await layout(page, `${role}-${size[0]}-${role === 'tutor' ? 'whiteboard' : 'share'}-group`, { material: true });
        if (kind === 'phone') expect(m.offStrip).toMatch(/^另 \d+ 位$/);
      }
      await page.getByRole('button', { name: /^聊天/ }).click();
      for (const size of device.sizes) {
        await page.setViewportSize({ width: size[0], height: size[1] });
        await layout(page, `${role}-${size[0]}-chat`, { material: true });
      }
      await page.getByRole('button', { name: '關閉聊天', exact: true }).click();
      if (role === 'student') {
        await page.getByRole('button', { name: '舉手', exact: true }).click();
        await expect(page.getByRole('button', { name: '放下手', exact: true })).toHaveAttribute('aria-pressed', 'true');
      }
      await page.getByRole('button', { name: '更多', exact: true }).click();
      await layout(page, `${role}-${device.sizes.at(-1)[0]}-menu`, { material: true });
      await page.keyboard.press('Escape');
      await page.context().close();
    });
  }

  await check('no request left this computer and no page reported an error', async () => {
    expect(report.externalRequests).toEqual([]);
    expect(report.pageProblems).toEqual([]);
  });
  report.status = report.layoutProblems.length ? 'passed with layout problems listed (soft run)' : 'passed';
} catch (error) {
  failure = error;
  report.status = 'failed';
  report.error = error.message;
} finally {
  report.finishedAt = new Date().toISOString();
  await writeFile(path.join(shots, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  await browser?.close();
  server.child.kill();
  console.log(`Report and screenshots: ${shots}`);
}
if (failure) throw failure;
