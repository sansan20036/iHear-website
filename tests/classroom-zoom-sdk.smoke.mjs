// The official Zoom Video SDK package in the real room page (2026-10-30): the built application
// behind the checked-in classroom headers (CSP, Permissions-Policy), a lesson added through the
// owner's API, and the tutor entering in Chromium with a fake camera and microphone. The page
// loads @zoom/videosdk from its own bundle; Zoom's public file server (source.zoom.us) is the
// only outside address the browser can reach, so the join, signed with a local stand-in key,
// cannot reach any Zoom session server. Passing proves the package loads and runs in our page
// under our headers. It does NOT prove a Zoom session works: that needs a trial account.
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';
import { setSession, startAcademyServer } from './helpers/academy-smoke.mjs';

const secret = 'classroom-zoom-sdk-local-only-not-production';
const owner = 'zoom-owner@example.test', tutor = 'zoom-tutor@example.test';
const ZOOM_FILES = 'https://source.zoom.us/';
Object.assign(process.env, {
  CLASSROOM_PROVIDER: 'zoom-video-sdk', CLASSROOM_DRIVE: 'local', VERCEL_ENV: '',
  // Local stand-ins, not Zoom keys: no real session can be joined with them.
  ZOOM_VIDEO_SDK_KEY: 'TEST-local-sdk-key', ZOOM_VIDEO_SDK_SECRET: 'TEST-local-sdk-secret-not-real',
  ZOOM_VIDEO_SDK_API_KEY: 'TEST-local-api-key', ZOOM_VIDEO_SDK_API_SECRET: 'TEST-local-api-secret-not-real',
  ZOOM_VIDEO_SDK_WEBHOOK_SECRET: 'TEST-local-webhook-not-real',
});
const server = await startAcademyServer({ port: 3246, secret, owners: [owner], name: 'classroom-zoom-sdk' });
const { origin, directory } = server;
const report = { startedAt: new Date().toISOString(), origin, zoomSessionTested: false, checks: [], zoomFiles: [], blocked: [], pageProblems: [], status: 'running' };
let browser, failure;

async function check(name, action) {
  try { await action(); report.checks.push({ name, status: 'passed' }); console.log(`PASS ${name}`); }
  catch (error) { report.checks.push({ name, status: 'failed', error: error.message }); throw error; }
}
// Only this computer and Zoom's public file server; every other request is refused and listed.
async function context(email, options = {}) {
  const created = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'zh-TW', permissions: ['camera', 'microphone'], ...options });
  created.setDefaultTimeout(30000);
  await created.route('**/*', route => {
    const url = route.request().url();
    if (url.startsWith(origin) || url.startsWith('data:') || url.startsWith('blob:')) return route.continue();
    if (url.startsWith(ZOOM_FILES)) { report.zoomFiles.push(url); return route.continue(); }
    report.blocked.push(url);
    return route.abort();
  });
  if (email) await setSession(created, origin, secret, email);
  return created;
}

try {
  // Name resolution fails for every outside host except Zoom's file server, so nothing the page
  // starts (requests, WebSockets, workers) can reach a Zoom session server.
  browser = await chromium.launch({
    headless: process.env.IHEAR_HEADED !== '1',
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE source.zoom.us'],
  });
  const start = new Date(Date.now() + 8 * 3600_000 + 5 * 60_000);
  const lesson = { code: 'TEST-Z1', date: start.toISOString().slice(0, 10), time: start.toISOString().slice(11, 16), minutes: 60, tutorCode: 'TEST-ZT1', tutorEmail: tutor, studentCode: 'TEST-ZS1' };
  const admin = await (await context(owner)).newPage();

  await check('the classroom page alone gets camera, microphone and the Zoom and Tencent domains', async () => {
    const home = await fetch(`${origin}/`);
    expect(home.headers.get('permissions-policy')).toBe('camera=(), microphone=(), geolocation=(), payment=()');
    const room = await fetch(`${origin}/classroom/L-00000000000000000000000000000000`);
    expect(room.headers.get('permissions-policy')).toContain('camera=(self "https://www.tencentclass.com")');
    expect(room.headers.get('content-security-policy')).toContain("script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' blob: https://source.zoom.us");
    expect(room.headers.get('content-security-policy')).toContain('frame-src \'self\' https://www.tencentclass.com');
  });

  let lessonId = '';
  await check('the owner adds a one-to-one test lesson through the admin API', async () => {
    await admin.goto(`${origin}/admin/classrooms`);
    const added = await admin.evaluate(async body => {
      const response = await fetch('/api/admin/classrooms', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      return { status: response.status, body: await response.json() };
    }, lesson);
    expect(added.status).toBe(201);
    lessonId = added.body.lesson.lessonId;
    expect(lessonId).toMatch(/^L-[0-9a-f]{32}$/);
  });

  const tutorPage = await (await context(tutor)).newPage();
  tutorPage.on('pageerror', error => report.pageProblems.push(error.message));
  tutorPage.on('console', message => { if (message.type() === 'error') report.pageProblems.push(message.text()); });

  await check('the tutor enters: the room loads the official package and Zoom\'s own browser check answers', async () => {
    await tutorPage.goto(`${origin}/classroom/${lessonId}`);
    await tutorPage.getByRole('button', { name: '進入教室' }).click();
    await expect(tutorPage.locator('.classroom-vendor-stage.zoom-video-sdk')).toBeAttached();
    // Classroom 2.0: the device notes are in the "Lesson info" panel, opened from "More".
    await tutorPage.getByRole('button', { name: '更多', exact: true }).click();
    await tutorPage.getByRole('menuitem', { name: '課堂資訊' }).click();
    await tutorPage.locator('.classroom-room-limits summary').click();
    const sdkLine = tutorPage.locator('[data-sdk-version]');
    await expect(sdkLine).toHaveAttribute('data-sdk-version', '2.6.0');
    await expect(sdkLine).toHaveText('Zoom 視訊 2.6.0：音訊可用、視訊可用、分享畫面可用');
    // The room gives Zoom its own container elements for video and for a shared screen.
    await expect(tutorPage.locator('video-player-container.classroom-zoom-videos')).toHaveCount(1);
    await expect(tutorPage.locator('video-player-container.classroom-zoom-share')).toHaveCount(1);
    // Classroom 2.0: placed once, the shared screen on the stage and the videos in the people's column.
    await expect(tutorPage.locator('.room2-stage .classroom-vendor-stage > video-player-container.classroom-zoom-share')).toHaveCount(1);
    await expect(tutorPage.locator('.room2-videos .room2-videos-host > video-player-container.classroom-zoom-videos')).toHaveCount(1);
  });

  await check('init loads Zoom\'s 2.6.0 media files under the classroom CSP; without a real key the join fails safely', async () => {
    await expect(tutorPage.locator('.classroom-room-connection')).toHaveText('連線失敗', { timeout: 90_000 });
    await expect(tutorPage.getByRole('button', { name: '重新連線' })).toBeVisible();
    expect(report.zoomFiles.some(url => url.startsWith(`${ZOOM_FILES}videosdk/2.6.0/lib/`))).toBe(true);
    // Only Zoom addresses were tried (the join's, refused by the test), never a third party; a CSP
    // block would show in the page's console.
    expect(report.blocked.every(url => /^https:\/\/([a-z0-9-]+\.)*zoom\.us\//.test(url))).toBe(true);
    expect(report.pageProblems.filter(text => /Content Security Policy|Refused to/i.test(text))).toEqual([]);
    report.zoomElementsDefinedAfterJoinAttempt = await tutorPage.evaluate(() => Boolean(customElements.get('video-player-container')));
  });

  await check('the tutor sees the materials and whiteboard buttons, held back until connected', async () => {
    // Classroom 2.0: a short word under each icon; the button's name keeps the whole words.
    await expect(tutorPage.locator('[data-tool="share"]')).toHaveAccessibleName('分享畫面（教材）');
    await expect(tutorPage.locator('[data-tool="share"]')).toBeDisabled();
    await expect(tutorPage.locator('[data-tool="whiteboard"]')).toHaveAccessibleName('開啟白板');
    await expect(tutorPage.locator('[data-tool="whiteboard"]')).toBeDisabled();
    await expect(tutorPage.locator('.classroom-room-tools')).toContainText('先在這台電腦打開檔案');
    await tutorPage.screenshot({ path: path.join(directory, 'zoom-sdk-tutor-room.png'), fullPage: true });
  });

  report.status = 'passed';
} catch (error) {
  failure = error;
  report.status = 'failed';
  report.error = error.message;
} finally {
  await browser?.close();
  server.child.kill();
  report.finishedAt = new Date().toISOString();
  await writeFile(path.join(directory, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Zoom files requested from ${ZOOM_FILES}: ${report.zoomFiles.length}; outside requests refused: ${report.blocked.length}`);
  for (const url of [...new Set(report.blocked.map(url => new URL(url).origin))]) console.log(`  refused: ${url}`);
  console.log(`Report: ${path.join(directory, 'report.json')}`);
}
if (failure) { console.error(failure); process.exit(1); }
