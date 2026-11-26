// Classroom 3.0 round 3 (2026-11-21): the fixed room's pages on phone, tablet and Safari, OFFLINE:
// Playwright's device profiles (screen size, touch, user agent) with the WebKit engine for the iPhone,
// iPad and desktop Safari and Chromium for an Android phone, against the built application with
// synthetic data. This is not a real device, not real Safari and not real Zoom: it shows that our
// pages lay out, take input and enter on these engines and sizes, nothing about cameras,
// microphones or networks. The iHear teacher (an owner) lets each person in from a desktop browser.
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, devices, expect as playwrightExpect, webkit } from '@playwright/test';
import { redactLinks, withoutLinkKeys, screenshotSafely, localContext, startAcademyServer } from './helpers/academy-smoke.mjs';

const expect = playwrightExpect.configure({ timeout: 20_000 });
const secret = 'classroom-devices-local-acceptance-only';
const owner = 'devices-owner@example.test';
Object.assign(process.env, {
  CLASSROOM_PROVIDER: 'synthetic', CLASSROOM_DRIVE: 'local', CLASSROOM_WEBHOOK_SECRET: 'classroom-devices-webhook-local-only',
  CLASSROOM_SYNTHETIC_SECRET: 'classroom-devices-token-local-only', VERCEL_ENV: '', CLASSROOM_FIXED_ROOMS: 'on', CLASSROOM_FIXED_ROOM_RECORDING: '',
});
const server = await startAcademyServer({ port: 3268, secret, owners: [owner], name: 'classroom-devices' });
const { origin, directory } = server;
const report = { startedAt: new Date().toISOString(), origin, synthetic: true, emulated: true, realDevices: false, zoomVerified: false, checks: [], externalRequests: [], pageProblems: [], status: 'running' };
const PROFILES = [
  ['iPhone 13', webkit], ['iPad (gen 7)', webkit], ['Pixel 5', chromium], ['Desktop Safari', webkit],
];
const browsers = [];
let failure;

async function check(id, name, action) {
  try { await action(); report.checks.push({ id, name, status: 'PASS' }); console.log(`PASS ${id} ${name}`); }
  catch (error) { report.checks.push({ id, name, status: 'FAIL', error: error.message }); throw error; }
}
const noSideways = page => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
const tall = locator => locator.evaluate(node => node.getBoundingClientRect().height);

try {
  const desk = await chromium.launch({ headless: true });
  browsers.push(desk);
  const admin = await (await localContext(desk, origin, { external: report.externalRequests, secret, locale: 'zh-TW', email: owner })).newPage();
  await admin.goto(`${origin}/admin/classrooms/rooms`);
  await admin.getByLabel('教室名稱（例如 Room 1）').fill('Device Room');
  // Round 18: rooms made on the page are direct by default; this check is about the owner letting people in.
  await admin.getByLabel(/直接進入/).uncheck();
  await admin.getByRole('button', { name: '建立教室' }).click();
  const link = (await admin.locator('[data-room-link] code').innerText()).trim();
  await admin.getByRole('button', { name: '我已經記下連結' }).click();
  const card = admin.locator('[data-room="Device Room"]');

  let n = 0;
  for (const [profile, engine] of PROFILES) {
    n += 1;
    const name = `Dev${String.fromCharCode(64 + n)}`;
    await check(`V${n}`, `${profile}（${engine === webkit ? 'WebKit' : 'Chromium'}，模擬）：輸入名字、等待、被讓進入、進教室；不橫向捲動；按鈕夠大`, async () => {
      const browser = await engine.launch({ headless: true });
      browsers.push(browser);
      const context = await browser.newContext({ ...devices[profile], locale: 'zh-TW' });
      await context.route('**/*', async route => {
        const url = new URL(route.request().url());
        if (url.origin !== origin && !url.protocol.startsWith('data') && !url.protocol.startsWith('blob')) { report.externalRequests.push(`${profile}: ${url.origin}`); return route.abort(); }
        if (route.request().resourceType() !== 'document') return route.continue();
        // Over http://localhost WebKit applies the production CSP's upgrade-insecure-requests
        // (Chromium exempts localhost) and asks for every asset by https, which this local server
        // does not serve. Only that directive is dropped: on the real site, served by https, it
        // changes nothing. The rest of the policy stays.
        const response = await route.fetch();
        const headers = { ...response.headers() };
        for (const name of Object.keys(headers)) {
          if (name.toLowerCase() === 'content-security-policy') headers[name] = headers[name].split(';').map(part => part.trim()).filter(part => part && part.toLowerCase() !== 'upgrade-insecure-requests').join('; ');
        }
        return route.fulfill({ response, headers });
      });
      const page = await context.newPage();
      page.on('pageerror', error => report.pageProblems.push(`${profile}: ${error.message}`));
      await page.goto(link);
      const field = page.getByLabel(/Please enter your first name/);
      await expect(field).toBeVisible();
      expect(await noSideways(page), 'no sideways scrolling on the name screen').toBe(true);
      const enter = page.getByRole('button', { name: '進入教室' });
      await field.fill(name);
      expect(await tall(field), 'the name field is large enough to touch').toBeGreaterThanOrEqual(40);
      expect(await tall(enter), 'the button is large enough to touch').toBeGreaterThanOrEqual(40);
      await enter.click();
      await expect(page.locator('[data-room-waiting]')).toBeVisible();
      await card.locator(`[data-waiting-person="${name}"]`).getByRole('button', { name: '讓他進入', exact: true }).click();
      await expect(page).toHaveURL(/\/classroom\/L-[0-9a-f]{32}$/);
      await page.getByRole('button', { name: '進入教室' }).click();
      await expect(page.locator('.room2-top .classroom-room-connection')).toHaveText('已連線');
      expect(await noSideways(page), 'no sideways scrolling in the room').toBe(true);
      await expect(page.getByRole('button', { name: /^麥克風：/ })).toBeVisible();
      await screenshotSafely(page, { path: path.join(directory, `v${n}-${profile.replace(/[^A-Za-z0-9]+/g, '-')}.png`) });
      await context.close();
    });
  }

  await check(`V${n + 1}`, '沒有對外請求，頁面沒有錯誤', async () => {
    if (report.externalRequests.length) throw new Error(`external requests: ${report.externalRequests.join(', ')}`);
    if (report.pageProblems.length) throw new Error(`page problems: ${report.pageProblems.join(' | ')}`);
  });
  report.status = 'passed';
} catch (error) {
  failure = error;
  report.status = 'failed';
  report.error = error.message;
} finally {
  report.finishedAt = new Date().toISOString();
  await writeFile(path.join(directory, 'report.json'), `${redactLinks(JSON.stringify(report, null, 2))}\n`);
  for (const browser of browsers) await browser.close().catch(() => {});
  server.child.kill();
  console.log(`Report and screenshots: ${directory}`);
}
if (failure) throw withoutLinkKeys(failure);
