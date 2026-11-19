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
    // Reading the material (2026-11-19: on a laptop the student could not read the tutor's slides):
    // the people go to a narrow column, the material can be enlarged and scrolled, and shown alone
    // full screen.
    await page.setViewportSize({ width: 1366, height: 768 });
    const room = page.locator('.room2');
    await expect(room).toHaveAttribute('data-reading', 'on');
    const widths = await page.evaluate(() => ({ stage: document.querySelector('.room2-stage').getBoundingClientRect().width, videos: document.querySelector('.room2-videos').getBoundingClientRect().width, view: window.innerWidth }));
    expect(widths.videos).toBeLessThanOrEqual(200);
    expect(widths.stage / widths.view).toBeGreaterThan(0.75);
    const zoom = page.locator('.room2-zoom');
    await expect(zoom).toHaveAttribute('data-share-zoom-level', '100');
    await expect(zoom.getByRole('button', { name: '符合畫面' })).toHaveAttribute('aria-pressed', 'true');
    await zoom.getByRole('button', { name: '放大' }).click();
    await zoom.getByRole('button', { name: '放大' }).click();
    await expect(zoom).toHaveAttribute('data-share-zoom-level', '150');
    await expect(room).toHaveAttribute('data-share-zoom', 'zoomed');
    await layout(page, 'student-1366-share-zoomed', { material: true });
    await zoom.getByRole('button', { name: '縮小' }).click();
    await expect(zoom).toHaveAttribute('data-share-zoom-level', '125');
    await zoom.getByRole('button', { name: '125%' }).click();
    await expect(zoom).toHaveAttribute('data-share-zoom-level', '100');
    await expect(room).toHaveAttribute('data-share-zoom', 'fit');
    const stageFull = page.locator('[data-stage-fullscreen]');
    await expect(stageFull).toHaveAccessibleName('全螢幕檢視教材');
    await stageFull.click();
    await expect(stageFull).toHaveAttribute('aria-pressed', 'true');
    expect(await page.evaluate(() => document.fullscreenElement?.classList.contains('room2-stage'))).toBe(true);
    await page.keyboard.press('Escape');
    await page.evaluate(() => document.fullscreenElement && document.exitFullscreen());
    await expect(stageFull).toHaveAttribute('aria-pressed', 'false');
    await zoom.getByRole('button', { name: '放大' }).click();
    await expect(zoom).toHaveAttribute('data-share-zoom-level', '125');
    // Stopped, then shared again (2026-11-18): the people take the stage back, then the material,
    // at "fit to screen" again (2026-11-19).
    await simulate(page, '對方停止分享');
    await expect(page.locator('.room2')).toHaveAttribute('data-mode', 'people');
    await expect(page.locator('.room2')).toHaveAttribute('data-reading', 'off');
    await expect(page.locator('.room2-zoom')).toHaveCount(0);
    await expect(page.locator('.room2-stage-label')).toHaveText('視訊');
    await simulate(page, '對方分享畫面');
    await expect(page.locator('.room2')).toHaveAttribute('data-mode', 'share');
    await expect(page.locator('.room2-zoom')).toHaveAttribute('data-share-zoom-level', '100');
    await expect(page.locator('.room2-stage-label')).toHaveText('分享的畫面');
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

  // One page per person and lesson (2026-11-19): on production the tutor was in one lesson up to
  // three times at once. A second tab with the same link waits and says so; "Continue in this tab"
  // takes the lesson over and the first tab leaves the room; the first can take it back.
  await check('one page per person: a second tab waits and says so; continuing there makes the first tab leave; the same person elsewhere is said', async () => {
    const shared = await context(DEVICES.computer, [1280, 800]);
    const first = watch(await shared.newPage(), 'student-tab-1');
    await enter(first, lesson.link);
    const second = watch(await shared.newPage(), 'student-tab-2');
    await second.goto(lesson.link);
    await second.getByRole('button', { name: '進入教室' }).click();
    const otherTab = second.getByRole('alert').filter({ hasText: '這堂課已在本瀏覽器的另一個分頁開啟' });
    await expect(otherTab).toBeVisible();
    await expect(first.locator('.room2-top .classroom-room-connection')).toHaveText('已連線');
    await second.getByRole('button', { name: '在這個分頁繼續' }).click();
    await expect(second.locator('.room2-top .classroom-room-connection')).toHaveText('已連線');
    await expect(first.getByRole('alert').filter({ hasText: '你已改在另一個分頁上課，這個分頁已離開教室。' })).toBeVisible();
    await expect(first.locator('.room2')).toHaveCount(0);
    // The first takes it back the same way; the second leaves.
    await first.getByRole('button', { name: '在這個分頁繼續' }).click();
    await expect(first.locator('.room2-top .classroom-room-connection')).toHaveText('已連線');
    await expect(second.getByRole('alert').filter({ hasText: '你已改在另一個分頁上課' })).toBeVisible();
    // Leaving lets another tab in without taking over.
    await first.getByRole('button', { name: '離開教室' }).first().click();
    await second.getByRole('button', { name: '在這個分頁繼續' }).click();
    await expect(second.locator('.room2-top .classroom-room-connection')).toHaveText('已連線');
    // The same person in the room from another device: said in the room, and gone when that ends.
    await simulate(second, '你也在另一處進入');
    const elsewhere = second.locator('[data-elsewhere]');
    await expect(elsewhere).toHaveText('你也在另一個裝置或視窗進入了這堂課。請關閉那裡的教室，只保留這一個，否則對方可能看不到你的畫面或聽不到你的聲音。');
    await layout(second, 'student-1280-elsewhere');
    await simulate(second, '另一處已離開');
    await expect(elsewhere).toHaveCount(0);
    await shared.close();
  });

  // After a reconnect (2026-11-20): joining again starts with the camera and microphone off (Zoom's
  // client is released and a new one joins). The one-to-one room said nothing, and with the
  // automatic reconnect the failure shows for a few seconds only. Now it says what is off and turns
  // it on again with one press, never by itself.
  await check('after a reconnect the room says the camera and microphone are off; one press turns on again what was on, never by itself', async () => {
    // A lesson of its own: a one-to-one lesson allows 10 joins a minute from one address, and every
    // page of this run shares the same address (it joins 6 times here).
    const own = { code: 'TEST-R2J', date: lesson.date, time: lesson.time, minutes: lesson.minutes, tutorCode: 'TEST-RT2', tutorEmail: 'room2-tutor2@example.test', studentCode: 'TEST-RS2' };
    const added = await admin.evaluate(async body => {
      const response = await fetch('/api/admin/classrooms', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      return { status: response.status, body: await response.json() };
    }, own);
    expect(added.status).toBe(201);
    const page = watch(await (await context(DEVICES.computer, [1280, 800])).newPage(), 'student-rejoin');
    await enter(page, new URL(added.body.studentLink, origin).href);
    const pill = page.locator('.room2-top .classroom-room-connection');
    const camera = page.getByRole('button', { name: /^攝影機：/ }), microphone = page.getByRole('button', { name: /^麥克風：/ });
    const offer = page.locator('[data-rejoin-devices]');
    const failedAlert = page.getByRole('alert').filter({ hasText: '視訊無法連線' });
    const pressed = async (cameraOn, microphoneOn) => {
      await expect(camera).toHaveAttribute('aria-pressed', String(cameraOn));
      await expect(microphone).toHaveAttribute('aria-pressed', String(microphoneOn));
    };
    await camera.click();
    await microphone.click();
    await pressed(true, true);

    // 1. Zoom gives up and the page joins again by itself (after 3 s): both came back off, and it says so.
    await simulate(page, '連線失敗');
    await expect(failedAlert).toBeVisible();
    await expect(offer).toHaveCount(0);
    await expect(pill).toHaveText('已連線', { timeout: 10_000 });
    await pressed(false, false);
    await expect(offer).toHaveAttribute('data-rejoin-devices', 'microphone camera');
    await expect(offer).toHaveAttribute('role', 'status');
    await expect(offer.locator('p')).toHaveText('剛才重新連線，你的攝影機和麥克風都關掉了，對方看不到也聽不到你。要重新開啟嗎？');
    await layout(page, 'student-1280-rejoin-offer');
    await page.setViewportSize({ width: 320, height: 640 });
    await layout(page, 'student-320-rejoin-offer');
    await page.setViewportSize({ width: 1280, height: 800 });
    // Nothing turns on by itself while the offer waits.
    await page.waitForTimeout(1500);
    await pressed(false, false);
    await offer.getByRole('button', { name: '重新開啟', exact: true }).click();
    await pressed(true, true);
    await expect(offer).toHaveCount(0);

    // 2. "Connect again" pressed at once, with only the camera on before: only the camera is offered; "Not now" leaves it off.
    await microphone.click();
    await pressed(true, false);
    await simulate(page, '連線失敗');
    await page.getByRole('button', { name: '重新連線', exact: true }).click();
    await expect(pill).toHaveText('已連線');
    await expect(offer.locator('p')).toHaveText('剛才重新連線，你的攝影機關掉了，對方看不到你。要重新開啟嗎？');
    await offer.getByRole('button', { name: '不用', exact: true }).click();
    await expect(offer).toHaveCount(0);
    await page.waitForTimeout(500);
    await pressed(false, false);

    // 3. A press of the person's own answers the offer for that device.
    await camera.click();
    await microphone.click();
    await simulate(page, '連線失敗');
    await expect(pill).toHaveText('已連線', { timeout: 10_000 });
    await expect(offer).toHaveAttribute('data-rejoin-devices', 'microphone camera');
    await microphone.click();
    await expect(offer).toHaveAttribute('data-rejoin-devices', 'camera');
    await expect(offer.locator('p')).toHaveText('剛才重新連線，你的攝影機關掉了，對方看不到你。要重新開啟嗎？');
    // Turned off again by the person: the offer does not come back for it.
    await microphone.click();
    await pressed(false, false);
    await page.waitForTimeout(300);
    await expect(offer).toHaveAttribute('data-rejoin-devices', 'camera');
    await camera.click();
    await expect(offer).toHaveCount(0);
    await microphone.click();
    await pressed(true, true);

    // 4. Zoom's own short reconnect keeps the devices on: nothing to offer.
    await simulate(page, '網路中斷');
    await expect(pill).toHaveText('重新連線中…');
    await simulate(page, '網路恢復');
    await expect(pill).toHaveText('已連線');
    await page.waitForTimeout(500);
    await expect(offer).toHaveCount(0);
    await pressed(true, true);

    // 5. Leaving on purpose and entering again is no reconnect, and nothing pressed before counts in the new room.
    await page.getByRole('button', { name: '離開教室' }).first().click();
    await expect(page.getByText('你已離開教室。')).toBeVisible();
    await page.getByRole('button', { name: '重新進入' }).click();
    await expect(pill).toHaveText('已連線');
    await pressed(false, false);
    await expect(offer).toHaveCount(0);
    await simulate(page, '連線失敗');
    await expect(pill).toHaveText('已連線', { timeout: 10_000 });
    await page.waitForTimeout(500);
    await expect(offer).toHaveCount(0);
    await page.context().close();
  });

  // "Turn on sound" (2026-11-20): nobody heard the room before pressing the microphone, because the
  // page joined Zoom's audio only on that press. The room now says so, and one press joins the
  // sound with the microphone muted. Synthetic: this proves the page, not how real Zoom sounds.
  await check('Turn on sound: the room says it is not heard yet; one press hears it with the microphone muted; again after a reconnect; blocked sound and a missing microphone are explained', async () => {
    const own = { code: 'TEST-R2S', date: lesson.date, time: lesson.time, minutes: lesson.minutes, tutorCode: 'TEST-RT3', tutorEmail: 'room2-tutor3@example.test', studentCode: 'TEST-RS3' };
    const added = await admin.evaluate(async body => {
      const response = await fetch('/api/admin/classrooms', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      return { status: response.status, body: await response.json() };
    }, own);
    expect(added.status).toBe(201);
    const page = watch(await (await context(DEVICES.computer, [1280, 800])).newPage(), 'student-sound');
    await enter(page, new URL(added.body.studentLink, origin).href);
    const pill = page.locator('.room2-top .classroom-room-connection');
    const microphone = page.getByRole('button', { name: /^麥克風：/ });
    const sound = page.locator('[data-sound]');
    const turnOn = sound.getByRole('button', { name: '開啟聲音', exact: true });
    const offer = page.locator('[data-rejoin-devices]');
    // 1. Entered: not heard yet, and said so in full on a computer, in a short line on a phone.
    await expect(sound).toHaveAttribute('data-sound', 'off');
    await expect(sound).toHaveAttribute('role', 'status');
    await expect(sound.locator('.room2-sound-long')).toHaveText('你還聽不到教室的聲音。按「開啟聲音」就能聽到；你的麥克風會保持靜音，對方聽不到你。瀏覽器可能會詢問是否允許使用麥克風。');
    await expect(sound.locator('.room2-sound-short')).toBeHidden();
    await layout(page, 'student-1280-sound');
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(sound.locator('.room2-sound-short')).toHaveText('還聽不到聲音？（麥克風會保持靜音）');
    await expect(sound.locator('.room2-sound-long')).toBeHidden();
    const row = await sound.boundingBox();
    expect(row.height).toBeLessThan(70);
    await layout(page, 'student-390-sound');
    // On a phone it waits while the chat sheet is open, and comes back when the sheet closes.
    await page.getByRole('button', { name: /^聊天/ }).click();
    await expect(sound).toBeHidden();
    await page.getByRole('button', { name: '關閉聊天', exact: true }).click();
    await expect(sound).toBeVisible();
    await page.setViewportSize({ width: 1280, height: 800 });
    // 2. One press: heard, and the microphone stays off.
    await turnOn.click();
    await expect(sound).toHaveCount(0);
    await expect(microphone).toHaveAttribute('aria-pressed', 'false');
    // 3. A reconnect starts silent again: offered again (nothing was on, so no other offer).
    await simulate(page, '連線失敗');
    await expect(pill).toHaveText('已連線', { timeout: 10_000 });
    await expect(sound).toHaveAttribute('data-sound', 'off');
    await expect(offer).toHaveCount(0);
    // 4. The microphone brings the sound too.
    await microphone.click();
    await expect(microphone).toHaveAttribute('aria-pressed', 'true');
    await expect(sound).toHaveCount(0);
    // 5. After a reconnect with the microphone on, the offer to turn it on again brings the sound:
    // "Turn on sound" waits until that offer is declined.
    await simulate(page, '連線失敗');
    await expect(pill).toHaveText('已連線', { timeout: 10_000 });
    await expect(offer).toHaveAttribute('data-rejoin-devices', 'microphone');
    await expect(sound).toHaveCount(0);
    await offer.getByRole('button', { name: '不用', exact: true }).click();
    await expect(sound).toHaveAttribute('data-sound', 'off');
    // 6. The browser blocking the sound: said, and pressed again once it plays.
    await simulate(page, '瀏覽器擋住聲音');
    await turnOn.click();
    await expect(sound).toHaveAttribute('data-sound', 'failed');
    await expect(sound).toHaveAttribute('data-sound-problem', 'autoplay');
    await expect(sound.locator('p')).toHaveText('瀏覽器擋住了教室的聲音。請再按一次「開啟聲音」。');
    await simulate(page, '裝置恢復');
    await turnOn.click();
    await expect(sound).toHaveCount(0);
    await expect(microphone).toHaveAttribute('aria-pressed', 'false');
    // 7. No microphone: Zoom's muted join needs one, and the page says what to do.
    await page.getByRole('button', { name: '離開教室' }).first().click();
    await page.getByRole('button', { name: '重新進入' }).click();
    await expect(pill).toHaveText('已連線');
    await simulate(page, '找不到麥克風');
    await turnOn.click();
    await expect(sound).toHaveAttribute('data-sound-problem', 'capture');
    await expect(sound.locator('p')).toHaveText('聲音沒有開啟：瀏覽器沒有允許使用麥克風，或找不到麥克風。即使只是聽，Zoom 也需要麥克風（會保持靜音）。請在瀏覽器的網站設定允許麥克風，或接上麥克風後，再按一次「開啟聲音」。');
    await layout(page, 'student-1280-sound-capture');
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
    // Zoom opens no whiteboard during a screen share (its error 8002). The tutor's own share is
    // stopped first, so one press opens the board (2026-11-19; before, the press was refused).
    const board = page.locator('[data-tool="whiteboard"]');
    const shareConflict = page.getByRole('alert').filter({ hasText: '分享畫面時不能開啟白板，請先停止分享。' });
    await expect(board).toHaveAccessibleName('開啟白板');
    await board.click();
    await expect(page.locator('.room2')).toHaveAttribute('data-mode', 'board');
    await expect(board).toHaveAccessibleName('關閉白板');
    await expect(share).toHaveAttribute('aria-pressed', 'false');
    await expect(shareConflict).toHaveCount(0);
    // The material alone, full screen, works for the whiteboard too.
    await expect(page.locator('[data-stage-fullscreen]')).toBeVisible();
    await layout(page, 'tutor-1440-whiteboard', { material: true });
    // The other way round (real Zoom, 2026-11-19: with the whiteboard open a press on "share" did
    // nothing and the page blamed a cancelled choice): this page's own board is closed first, so one
    // press shares; then one press on the whiteboard brings the board back.
    await share.click();
    await expect(share).toHaveAttribute('aria-pressed', 'true');
    await expect(board).toHaveAccessibleName('開啟白板');
    await expect(page.locator('.room2-stage-label')).toHaveText('你正在分享畫面');
    await expect(page.getByRole('alert').filter({ hasText: '畫面沒有開始分享' })).toHaveCount(0);
    await board.click();
    await expect(page.locator('.room2')).toHaveAttribute('data-mode', 'board');
    await expect(share).toHaveAttribute('aria-pressed', 'false');
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
