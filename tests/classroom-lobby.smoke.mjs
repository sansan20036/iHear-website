// The Classroom 2.0 lobby in a browser (2026-11-13): /classroom, the pre-class screen a personal
// link opens and the device check, against the built application behind the checked-in hosting
// headers, with the synthetic provider, disposable local storage, test-only sessions and the
// browser's own fake camera and microphone. Nothing reaches Zoom, Google or production; passing
// proves our pages, not real devices or real Zoom.
import { writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';
import { localContext, noHorizontalOverflow, startAcademyServer } from './helpers/academy-smoke.mjs';

const secret = 'classroom-lobby-browser-acceptance-only';
const owner = 'lobby-owner@example.test', tutor = 'lobby-tutor@example.test';
Object.assign(process.env, {
  CLASSROOM_PROVIDER: 'synthetic', CLASSROOM_DRIVE: 'local', CLASSROOM_WEBHOOK_SECRET: 'classroom-lobby-webhook-local-only',
  CLASSROOM_SYNTHETIC_SECRET: 'classroom-lobby-token-local-only', VERCEL_ENV: '',
});
const server = await startAcademyServer({ port: 3276, secret, owners: [owner], name: 'classroom-lobby' });
const { origin, directory } = server;
const report = { startedAt: new Date().toISOString(), origin, synthetic: true, zoomVerified: false, fakeDevices: true, checks: [], externalRequests: [], deviceDiagnostics: [], status: 'running' };
const consoleProblems = [];
let browser, failure;

async function check(name, action) {
  try { await action(); report.checks.push({ name, status: 'passed' }); console.log(`PASS ${name}`); }
  catch (error) { report.checks.push({ name, status: 'failed', error: error.message }); throw error; }
}
const shot = (page, name) => page.screenshot({ path: path.join(directory, `${name}.png`), fullPage: true });
// Refusals this test causes on purpose (a link that no longer works, a visitor without one).
const expectedRefusal = text => /Failed to load resource: the server responded with a status of (401|403)/.test(text);
const context = options => localContext(browser, origin, { external: report.externalRequests, secret, locale: 'zh-TW', ...options });
function watch(page) {
  page.on('console', message => { if (message.type() === 'error' && !expectedRefusal(message.text())) consoleProblems.push(message.text()); });
  page.on('pageerror', error => consoleProblems.push(error.message));
  return page;
}
// Counts every request for the camera or microphone, and keeps what was handed out, so the test can
// say that nothing was asked for before a press and everything was given back before entering.
const deviceProbe = () => {
  window.__deviceRequests = 0;
  window.__deviceTracks = [];
  window.__deviceErrors = [];
  const devices = navigator.mediaDevices;
  if (!devices?.getUserMedia) return;
  const original = devices.getUserMedia.bind(devices);
  devices.getUserMedia = async constraints => {
    window.__deviceRequests += 1;
    try {
      const stream = await original(constraints);
      window.__deviceTracks.push(...stream.getTracks());
      return stream;
    } catch (error) {
      // The browser's own reason, kept for the report (the page shows only the kind of problem).
      window.__deviceErrors.push({ name: String(error?.name || ''), message: String(error?.message || error), constraints: JSON.stringify(constraints), at: new Date().toISOString() });
      throw error;
    }
  };
};
// A device test has finished starting, whatever its outcome (a busy machine may take a while), and
// what the row then says: its state and its words (why, when a device did not start).
const settled = row => expect(row.locator('.lobby-status')).not.toHaveText(/尚未檢查|檢查中/, { timeout: 20_000 });
const outcome = async row => [await row.locator('.lobby-status').textContent(), await row.locator('.device-row-detail').textContent()];
// When a fake device did not start, what the browser said and how the machine stood, kept in the
// report and printed, before the check fails. The cause is not assumed (2026-11-13: seen once under load).
async function deviceOutcome(page, row, label) {
  await settled(row);
  const shown = await outcome(row);
  if (shown[0] !== '正常') {
    const diagnostics = {
      label, at: new Date().toISOString(), shown, freeMemoryMB: Math.round(os.freemem() / 1048576), totalMemoryMB: Math.round(os.totalmem() / 1048576),
      errors: await page.evaluate(() => window.__deviceErrors || []).catch(() => 'unreadable'),
      devices: await page.evaluate(async () => (await navigator.mediaDevices.enumerateDevices()).map(device => device.kind)).catch(() => 'unreadable'),
    };
    report.deviceDiagnostics.push(diagnostics);
    console.log(`DEVICE DIAGNOSTICS ${JSON.stringify(diagnostics)}`);
  }
  return shown;
}
const taipei = ms => { const text = new Date(ms + 8 * 3600_000).toISOString(); return { date: text.slice(0, 10), time: text.slice(11, 16) }; };
const keyOf = link => new URLSearchParams(new URL(link).hash.slice(1)).get('k');

try {
  browser = await chromium.launch({
    headless: process.env.IHEAR_HEADED !== '1',
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
  });
  const ownerContext = await context({ email: owner });
  const admin = watch(await ownerContext.newPage());
  await admin.goto(`${origin}/admin/classrooms`);
  const create = async (code, startMs, tutorCode, studentCode) => {
    const { date, time } = taipei(startMs);
    const answer = await admin.evaluate(async body => {
      const response = await fetch('/api/admin/classrooms', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      return { status: response.status, body: await response.json() };
    }, { code, date, time, minutes: 60, tutorCode, tutorEmail: tutor, studentCode });
    expect(answer.status).toBe(201);
    const link = `${origin}${answer.body.studentLink}`;
    return { code, link, id: answer.body.lesson.lessonId, key: keyOf(link), tutorCode, studentCode };
  };
  const access = async (lessonId, action) => admin.evaluate(async ({ lessonId, action }) => (await fetch(`/api/admin/classrooms/${lessonId}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action }),
  })).status, { lessonId, action });
  const now = Date.now();
  const open = await create('TEST-LOBBY-OPEN', now + 5 * 60_000, 'TEST-LOT1', 'TEST-LOS1');
  const early = await create('TEST-LOBBY-EARLY', now + 3 * 3600_000, 'TEST-LOT1', 'TEST-LOS2');
  const off = await create('TEST-LOBBY-OFF', now + 4 * 3600_000, 'TEST-LOT1', 'TEST-LOS3');
  expect(await access(off.id, 'cancel')).toBe(200);
  const revoked = await create('TEST-LOBBY-REV', now + 6 * 60_000, 'TEST-LOT1', 'TEST-LOS4');
  expect(await access(revoked.id, 'revoke_link')).toBe(200);

  await check('the personal link opens the pre-class screen: the lesson, who and when, the door open; nothing is asked of the camera, microphone or the door before a press', async () => {
    const studentContext = await context({ viewport: { width: 1440, height: 900 } });
    await studentContext.addInitScript(deviceProbe);
    const page = watch(await studentContext.newPage());
    const requests = [];
    page.on('request', item => requests.push({ url: item.url(), method: item.method() }));
    await page.goto(open.link);
    await expect.poll(() => page.evaluate(() => window.location.href)).toBe(`${origin}/classroom/${open.id}`);
    await expect(page.getByRole('heading', { level: 1, name: '準備上課' })).toBeVisible();
    const facts = page.locator('.prejoin-facts');
    await expect(facts).toContainText(open.code);
    await expect(facts).toContainText(`學生 ${open.studentCode}`);
    await expect(facts.locator('div', { hasText: '小老師' })).toContainText(open.tutorCode);
    await expect(page.locator('.prejoin-door .lobby-pill')).toHaveText('可以進入');
    const enter = page.getByRole('button', { name: '進入教室' });
    await expect(enter).toBeEnabled();
    await expect(page.getByRole('note')).toContainText('測試教室');
    // Only the read-only look at the lesson went out: no entry, no device, and never the key in an address.
    expect(requests.filter(item => item.url.includes(`/api/classroom/${open.id}/`)).map(item => new URL(item.url).pathname)).toEqual([`/api/classroom/${open.id}/preview`]);
    expect(requests.filter(item => item.url.includes(open.key))).toEqual([]);
    expect(await page.evaluate(() => window.__deviceRequests)).toBe(0);
    expect(await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }))).not.toContain(open.key);
    expect(await page.content()).not.toContain(open.key);
    expect(await noHorizontalOverflow(page)).toBe(true);
    await shot(page, '01-prejoin-open');

    // The device check: each test by its own press, with the browser's fake camera and microphone.
    const camera = page.locator('[data-device="camera"]');
    await camera.getByRole('button', { name: '測試攝影機' }).click();
    expect(await deviceOutcome(page, camera, 'pre-class camera')).toEqual(['正常', expect.stringContaining('攝影機正常')]);
    await expect.poll(() => page.locator('.device-preview video').evaluate(video => video.videoWidth > 0 && !video.paused)).toBe(true);
    const microphone = page.locator('[data-device="microphone"]');
    await microphone.getByRole('button', { name: '測試麥克風' }).click();
    expect(await deviceOutcome(page, microphone, 'pre-class microphone')).toEqual(['正常', '麥克風收得到聲音。']);
    await expect(microphone.getByRole('meter', { name: '麥克風音量' })).toBeVisible();
    await expect(microphone.locator('.device-row-detail')).toHaveText('麥克風收得到聲音。', { timeout: 10_000 });
    const speaker = page.locator('[data-device="speaker"]');
    await speaker.getByRole('button', { name: '播放測試音' }).click();
    await speaker.getByRole('button', { name: '有，聽得到' }).click();
    await expect(speaker.locator('.lobby-status')).toHaveText('正常');
    await expect(page.locator('[data-device="browser"] .lobby-status')).toHaveText('正常');
    expect(await page.evaluate(() => window.__deviceRequests)).toBe(2);
    expect(await page.evaluate(() => window.__deviceTracks.every(track => track.readyState === 'live'))).toBe(true);
    await shot(page, '02-prejoin-device-check');

    // Entering: what the check opened is given back first; then the door, then the room.
    const [joined] = await Promise.all([
      page.waitForResponse(item => item.url().endsWith(`/api/classroom/${open.id}/join`) && item.request().method() === 'POST'),
      enter.click(),
    ]);
    expect(joined.status()).toBe(200);
    expect(await page.evaluate(() => window.__deviceTracks.length && window.__deviceTracks.every(track => track.readyState === 'ended'))).toBe(true);
    await expect(page.locator('.room2-top .classroom-room-connection')).toHaveText('已連線');
    await page.getByRole('button', { name: '離開教室' }).click();
    await expect(page.getByRole('button', { name: '重新進入' })).toBeVisible();
    await expect(page.locator('.prejoin-left')).toHaveText('你已離開教室。');
    await studentContext.close();
  });

  await check('a student who is early sees when the door opens, cannot press yet, and the button opens on time without a reload', async () => {
    const earlyContext = await context({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const page = watch(await earlyContext.newPage());
    await page.clock.install();
    await page.goto(early.link);
    await expect(page.locator('.prejoin-door .lobby-pill')).toHaveText('尚未開放');
    await expect(page.locator('.prejoin-door')).toContainText('教室在上課前 15 分鐘開放');
    await expect(page.locator('.prejoin-door')).toContainText('還有 2 小時 4');
    const enter = page.getByRole('button', { name: '進入教室' });
    await expect(enter).toBeDisabled();
    await expect(page.locator('#prejoin-join-note')).toContainText('開放');
    // On a phone the way in stays at the bottom of the screen.
    const bar = await page.locator('.prejoin-join').boundingBox();
    expect(Math.round(bar.y + bar.height)).toBe(844);
    expect(await noHorizontalOverflow(page)).toBe(true);
    await shot(page, '03-prejoin-early-phone');
    // Three hours later (the page's clock only): the door is open and the button can be pressed.
    await page.clock.fastForward('03:00:00');
    await expect(page.locator('.prejoin-door .lobby-pill')).toHaveText(/可以進入|上課中/);
    await expect(enter).toBeEnabled();
    await earlyContext.close();
  });

  await check('a cancelled lesson, a revoked link and a visitor without a link are told at once and offered no way in; the door still refuses each', async () => {
    const page = watch(await (await context()).newPage());
    await page.goto(off.link);
    await expect(page.locator('.prejoin-door .lobby-pill')).toHaveText('已取消');
    await expect(page.locator('.prejoin-door')).toContainText('這堂課已取消');
    await expect(page.getByRole('button', { name: '進入教室' })).toHaveCount(0);
    await page.goto(revoked.link);
    await expect(page.locator('.classroom-room-problem[role="alert"]')).toContainText('這個連結無法進入這堂課');
    await expect(page.getByRole('button', { name: '進入教室' })).toHaveCount(0);
    expect(await page.content()).not.toContain(revoked.code);
    const refused = await page.evaluate(async ({ id, key }) => (await fetch(`/api/classroom/${id}/join`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key }) })).status, { id: revoked.id, key: revoked.key });
    expect(refused).toBe(403);
    await page.goto(`${origin}/classroom/${open.id}`);
    await expect(page.locator('.classroom-room-problem[role="alert"]')).toContainText('學生請使用 iHear 提供的個人專屬連結');
    await expect(page.getByRole('link', { name: '小老師登入' })).toBeVisible();
    await expect(page.getByText('頁面重新整理後，需要再打開一次 iHear 寄給你的個人連結。', { exact: false })).toBeVisible();
    await page.context().close();
  });

  await check('the tutor signed in: their lessons, the open one marked next and entered through the pre-class screen as the tutor', async () => {
    const tutorContext = await context({ email: tutor });
    const page = watch(await tutorContext.newPage());
    await page.goto(`${origin}/classroom`);
    await expect(page.getByRole('heading', { level: 1, name: '歡迎回來' })).toBeVisible();
    const rows = page.locator('.classroom-mine li');
    await expect(rows).toHaveCount(4);
    await expect(rows.first()).toContainText(open.code);
    await expect(rows.first()).toHaveClass(/is-next/);
    await expect(rows.first().locator('.mine-next')).toHaveText('下一堂');
    await expect(rows.last()).toContainText('已取消');
    await expect(page.locator('.classroom-mine li', { hasText: early.code })).toContainText('尚未開放');
    await shot(page, '04-lobby-tutor');
    await rows.first().getByRole('link', { name: '準備上課' }).click();
    await expect(page).toHaveURL(`${origin}/classroom/${open.id}`);
    await expect(page.locator('.prejoin-facts')).toContainText(`小老師 ${open.tutorCode}`);
    await expect(page.locator('.prejoin-facts div', { hasText: '學生' })).toContainText(open.studentCode);
    await expect(page.getByRole('button', { name: '進入教室' })).toBeEnabled();
    await tutorContext.close();
  });

  await check('a visitor: the welcome, both ways in, the steps and the device check on its own page (the only one of the two allowed the camera)', async () => {
    const visitorContext = await context({ viewport: { width: 1440, height: 900 } });
    await visitorContext.addInitScript(deviceProbe);
    const page = watch(await visitorContext.newPage());
    const lobby = await page.goto(`${origin}/classroom`);
    expect(lobby.headers()['permissions-policy']).toContain('camera=()');
    await expect(page.getByRole('heading', { level: 1, name: '歡迎來到 iHear 線上教室' })).toBeVisible();
    await expect(page.getByLabel('貼上個人課程連結')).toBeVisible();
    await expect(page.getByRole('link', { name: '小老師：使用 Google 登入' })).toHaveAttribute('href', '/api/auth/signin?callbackUrl=%2Fclassroom');
    await expect(page.locator('.lobby-steps li')).toHaveCount(3);
    expect(await page.evaluate(() => window.__deviceRequests)).toBe(0);
    await shot(page, '05-lobby-visitor');
    const [checkPage] = await Promise.all([
      page.waitForResponse(item => new URL(item.url()).pathname === '/classroom/device-check' && item.request().resourceType() === 'document'),
      page.getByRole('link', { name: '開始裝置檢查' }).click(),
    ]);
    expect(checkPage.headers()['permissions-policy']).toMatch(/camera=\(self/);
    await expect(page.getByRole('heading', { level: 1, name: '測試攝影機、麥克風和聲音' })).toBeVisible();
    await page.locator('[data-device="camera"]').getByRole('button', { name: '測試攝影機' }).click();
    expect(await deviceOutcome(page, page.locator('[data-device="camera"]'), 'device-check page camera')).toEqual(['正常', expect.stringContaining('攝影機正常')]);
    await page.getByRole('link', { name: '回到線上教室入口' }).click();
    await expect(page).toHaveURL(`${origin}/classroom`);
    // Leaving the check page let go of the camera.
    await visitorContext.close();
  });

  await check('three languages: the lobby and the pre-class screen switch with one press, and say which language is on', async () => {
    const page = watch(await (await context({ locale: 'en-US' })).newPage());
    await page.goto(open.link);
    await expect(page.getByRole('heading', { level: 1, name: 'Get ready for class' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'English' })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('button', { name: 'Enter the classroom' })).toBeEnabled();
    await page.getByRole('button', { name: '简体中文' }).click();
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh-Hans');
    await expect(page.getByRole('heading', { level: 1, name: '准备上课' })).toBeVisible();
    await expect(page.getByRole('button', { name: '进入教室' })).toBeEnabled();
    await page.getByRole('button', { name: '繁體中文' }).click();
    await expect(page.getByRole('button', { name: '繁體中文' })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('heading', { level: 1, name: '準備上課' })).toBeVisible();
    await page.goto(`${origin}/classroom`);
    await page.getByRole('button', { name: 'English' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Welcome to the iHear Online Classroom' })).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await page.context().close();
  });

  await check('keyboard: the way in is reached in order, every control shows where the focus is, and each page has one main heading', async () => {
    const page = watch(await (await context({ viewport: { width: 1280, height: 900 } })).newPage());
    await page.goto(open.link);
    await expect(page.getByRole('button', { name: '進入教室' })).toBeEnabled();
    const order = [];
    for (let step = 0; step < 12; step++) {
      await page.keyboard.press('Tab');
      const focused = await page.evaluate(() => {
        const element = document.activeElement;
        const style = getComputedStyle(element);
        const name = element.getAttribute('aria-label') || element.textContent.trim() || element.querySelector('img')?.getAttribute('alt') || '';
        return { name: name.trim(), tag: element.tagName, outline: style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) >= 2 };
      });
      order.push(focused);
      if (focused.name === '進入教室') break;
    }
    expect(order.map(item => item.name)).toEqual(['iHear 首頁', '線上教室入口', 'English', '繁體中文', '简体中文', '進入教室']);
    expect(order.every(item => item.outline)).toBe(true);
    // Enter starts the entry from the keyboard too.
    const [response] = await Promise.all([page.waitForResponse(item => item.url().endsWith('/join')), page.keyboard.press('Enter')]);
    expect(response.status()).toBe(200);
    for (const address of [`${origin}/classroom`, `${origin}/classroom/device-check`]) {
      await page.goto(address);
      await expect(page.locator('h1')).toHaveCount(1);
      expect(await page.locator('img:not([alt])').count()).toBe(0);
      expect(await page.locator('button').evaluateAll(buttons => buttons.filter(button => !(button.getAttribute('aria-label') || button.textContent.trim())).length)).toBe(0);
    }
    await page.context().close();
  });

  await check('phones, tablets and computers: nothing scrolls sideways, and on a phone the device check ends above the bar that holds the way in', async () => {
    for (const viewport of [{ width: 1440, height: 900 }, { width: 1024, height: 768 }, { width: 768, height: 1024 }, { width: 390, height: 844 }, { width: 320, height: 640 }]) {
      const small = viewport.width <= 640;
      const sized = await context({ viewport, ...(small ? { isMobile: true, hasTouch: true } : {}) });
      const page = watch(await sized.newPage());
      for (const address of [`${origin}/classroom`, open.link, `${origin}/classroom/device-check`]) {
        await page.goto(address);
        await page.waitForLoadState('networkidle');
        expect([address, viewport.width, await noHorizontalOverflow(page)]).toEqual([address, viewport.width, true]);
      }
      if (small) {
        await page.goto(open.link);
        await expect(page.getByRole('button', { name: '進入教室' })).toBeEnabled();
        // The site scrolls smoothly; the end of the page is measured once the scroll has landed.
        await page.evaluate(() => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' }));
        await page.waitForTimeout(200);
        const bar = await page.locator('.prejoin-join').boundingBox();
        for (const last of [page.locator('[data-device="speaker"] button').last(), page.locator('.lobby-phone-link')]) {
          const box = await last.boundingBox();
          expect(box.y + box.height).toBeLessThanOrEqual(bar.y);
        }
        // The top bar is one row on a phone of 360 pixels or more.
        if (viewport.width >= 360) expect((await page.locator('.lobby-nav').boundingBox()).height).toBeLessThanOrEqual(76);
      }
      await sized.close();
    }
  });

  await check("an administrator's floating site tools (theme, layout, editing) stay off the classroom pages", async () => {
    const page = watch(await ownerContext.newPage());
    await page.goto(`${origin}/classroom`);
    await expect(page.locator('.site-theme-trigger')).toHaveCount(1);
    await expect(page.locator('.site-theme-trigger')).toBeHidden();
    await expect(page.locator('.ihear-inline-edit-button')).toBeHidden();
    await page.goto(`${origin}/classroom/device-check`);
    await expect(page.locator('.site-theme-trigger')).toBeHidden();
    await shot(page, '06-owner-no-floating-tools');
    await page.close();
  });

  await check('nothing was sent to another site and no unexpected browser errors', async () => {
    expect(report.externalRequests).toEqual([]);
    expect(consoleProblems).toEqual([]);
  });
  report.status = 'passed';
} catch (error) {
  failure = error;
  report.status = 'failed';
  report.error = error.message;
} finally {
  report.finishedAt = new Date().toISOString();
  await writeFile(path.join(directory, 'classroom-lobby-browser-report.json'), `${JSON.stringify(report, null, 2)}\n`);
  await browser?.close();
  server.child.kill();
  console.log(`Report: ${path.join(directory, 'classroom-lobby-browser-report.json')}`);
}
if (failure) {
  console.error(server.logs().slice(-4000));
  throw failure;
}
