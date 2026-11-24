// Classroom 3.0 round 7 (2026-11-21): a fixed room in four desktop browser engines, OFFLINE and
// EMULATED: Chromium, Microsoft Edge (the installed Edge through Playwright's msedge channel),
// Firefox and WebKit (Safari's engine, not Safari), in Traditional Chinese, English and Simplified
// Chinese, against the built application with synthetic data. Each person types a name and waits;
// the connection drops while waiting (the browser goes offline) and comes back; the iHear teacher
// (an owner) lets them in; they enter, turn on the sound, meet a blocked camera and a network drop
// (both played by the test classroom), leave and enter again. Basic accessibility: labelled fields,
// named buttons, status messages announced, the page's language, the keyboard. This is not a real
// device, not real Safari and not real Zoom: it proves our pages on these engines, nothing about
// cameras, microphones or networks.
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, expect as playwrightExpect, firefox, webkit } from '@playwright/test';
import { redactLinks, withoutLinkKeys, screenshotSafely, localContext, startAcademyServer } from './helpers/academy-smoke.mjs';

const expect = playwrightExpect.configure({ timeout: 20_000 });
const secret = 'classroom-browsers-local-acceptance-only';
const owner = 'browsers-owner@example.test';
Object.assign(process.env, {
  CLASSROOM_PROVIDER: 'synthetic', CLASSROOM_DRIVE: 'local', CLASSROOM_WEBHOOK_SECRET: 'classroom-browsers-webhook-local-only',
  CLASSROOM_SYNTHETIC_SECRET: 'classroom-browsers-token-local-only', VERCEL_ENV: '', CLASSROOM_FIXED_ROOMS: 'on', CLASSROOM_FIXED_ROOM_RECORDING: '',
});
const server = await startAcademyServer({ port: 3269, secret, owners: [owner], name: 'classroom-browsers' });
const { origin, directory } = server;
const report = { startedAt: new Date().toISOString(), origin, synthetic: true, emulated: true, realDevices: false, zoomVerified: false, engines: [], checks: [], externalRequests: [], pageProblems: [], status: 'running' };

// The words each check looks for, as the pages say them (room-copy.ts, classroom-copy.ts).
const WORDS = {
  'zh-TW': {
    lang: 'zh-Hant', join: '進入教室', enter: '進入教室', connected: '已連線', reconnecting: '重新連線中…', rejoin: '重新進入', sound: '開啟聲音',
    offline: '暫時連不上教室，稍後會自動再試。', drop: '網路中斷', restore: '網路恢復', cameraBlocked: '攝影機被封鎖', devicesBack: '裝置恢復',
  },
  'en-US': {
    lang: 'en', join: 'Join Classroom', enter: 'Enter the classroom', connected: 'Connected', reconnecting: 'Reconnecting…', rejoin: 'Enter again', sound: 'Turn on sound',
    offline: 'The classroom cannot be reached right now; trying again shortly.', drop: 'Network drops', restore: 'Network back', cameraBlocked: 'Camera blocked', devicesBack: 'Devices back',
  },
  'zh-CN': {
    lang: 'zh-Hans', join: '进入教室', enter: '进入教室', connected: '已连接', reconnecting: '重新连接中…', rejoin: '重新进入', sound: '开启声音',
    offline: '暂时连不上教室，稍后会自动再试。', drop: '网络中断', restore: '网络恢复', cameraBlocked: '摄像头被阻止', devicesBack: '设备恢复',
  },
};
const ENGINES = [
  { name: 'Chromium', type: chromium, launch: {}, locale: 'zh-TW' },
  { name: 'Edge', type: chromium, launch: { channel: 'msedge' }, locale: 'en-US' },
  { name: 'Firefox', type: firefox, launch: {}, locale: 'zh-CN' },
  { name: 'WebKit', type: webkit, launch: {}, locale: 'zh-TW' },
];
const browsers = [];
let failure;

async function check(id, name, action) {
  try { await action(); report.checks.push({ id, name, status: 'PASS' }); console.log(`PASS ${id} ${name}`); }
  catch (error) { report.checks.push({ id, name, status: 'FAIL', error: redactLinks(error.message) }); throw error; }
}
// Every button the person can see has a name a screen reader reads out.
const unnamedButtons = page => page.evaluate(() => [...document.querySelectorAll('button')]
  .filter(button => button.offsetParent !== null)
  .filter(button => !(button.getAttribute('aria-label') || button.textContent || '').trim())
  .map(button => button.outerHTML.slice(0, 80)));

try {
  const desk = await chromium.launch({ headless: true });
  browsers.push(desk);
  const admin = await (await localContext(desk, origin, { external: report.externalRequests, secret, locale: 'zh-TW', email: owner })).newPage();
  admin.on('dialog', dialog => dialog.accept());
  await admin.goto(`${origin}/admin/classrooms/rooms`);
  await admin.getByLabel('教室名稱（例如 Room 1）').fill('Browser Room');
  await admin.getByRole('button', { name: '建立教室' }).click();
  const link = (await admin.locator('[data-room-link] code').innerText()).trim();
  await admin.getByRole('button', { name: '我已經記下連結' }).click();
  const card = admin.locator('[data-room="Browser Room"]');

  let n = 0;
  for (const engine of ENGINES) {
    n += 1;
    const words = WORDS[engine.locale];
    const name = `Web${String.fromCharCode(64 + n)}`;
    await check(`B${n}`, `${engine.name}（${engine.locale}，模擬）：輸入名字並等待；等待時斷網再恢復；被讓進入、進教室、開啟聲音；攝影機被封鎖與網路中斷的提示；離開後重新進入；按鈕都有名稱、狀態會被讀出、頁面語言正確`, async () => {
      const browser = await engine.type.launch({ headless: true, ...engine.launch });
      browsers.push(browser);
      report.engines.push({ engine: engine.name, version: browser.version(), locale: engine.locale });
      const context = await localContext(browser, origin, { external: report.externalRequests, locale: engine.locale });
      if (engine.type === webkit) {
        // As in the devices check: over http://localhost WebKit applies the production CSP's
        // upgrade-insecure-requests and asks for every asset by https, which this local server does
        // not serve. Only that directive is dropped; served by https it changes nothing.
        await context.route('**/*', async route => {
          const url = new URL(route.request().url());
          if (url.origin !== origin && !url.protocol.startsWith('data') && !url.protocol.startsWith('blob')) { report.externalRequests.push(`${engine.name}: ${url.origin}`); return route.abort(); }
          if (route.request().resourceType() !== 'document') return route.continue();
          const response = await route.fetch();
          const headers = { ...response.headers() };
          for (const key of Object.keys(headers)) {
            if (key.toLowerCase() === 'content-security-policy') headers[key] = headers[key].split(';').map(part => part.trim()).filter(part => part && part.toLowerCase() !== 'upgrade-insecure-requests').join('; ');
          }
          return route.fulfill({ response, headers });
        });
      }
      const page = await context.newPage();
      page.on('pageerror', error => report.pageProblems.push(`${engine.name}: ${error.message}`));
      page.on('console', message => {
        // While offline on purpose the status checks fail; that is the case being tested.
        if (message.type() === 'error' && !/Failed to load resource|NetworkError|net::ERR_INTERNET_DISCONNECTED|Failed to fetch|Load failed|The Internet connection appears to be offline|NS_ERROR_OFFLINE/i.test(message.text())) report.pageProblems.push(`${engine.name}: ${message.text()}`);
      });

      // The door: in the browser's language, the key leaves the address at once, typed and sent by keyboard.
      await page.goto(link);
      const field = page.getByLabel(/Please enter your first name/);
      await expect(field).toBeVisible();
      expect(new URL(page.url()).hash).toBe('');
      await expect(page.locator('html')).toHaveAttribute('lang', words.lang);
      await field.focus();
      await page.keyboard.type(name);
      await page.keyboard.press('Enter');
      await expect(page.locator('[data-room-waiting]')).toBeVisible();
      await expect(page.locator('[data-room-waiting] [role="status"]')).toHaveCount(1);
      expect(await unnamedButtons(page), 'every button on the door has a name').toEqual([]);

      // The connection drops while waiting: said, then the page keeps asking and carries on.
      await context.setOffline(true);
      await expect(page.locator('[data-room-waiting] [role="alert"]')).toHaveText(words.offline, { timeout: 15_000 });
      await card.locator(`[data-waiting-person="${name}"]`).getByRole('button', { name: '讓他進入', exact: true }).click();
      await context.setOffline(false);
      await expect(page).toHaveURL(/\/classroom\/L-[0-9a-f]{32}$/, { timeout: 30_000 });

      // The room, in the same language.
      await page.getByRole('button', { name: words.enter, exact: true }).click();
      const connection = page.locator('.room2-top .classroom-room-connection');
      await expect(connection).toHaveText(words.connected);
      await expect(page.locator('html')).toHaveAttribute('lang', words.lang);
      // The page's own toolbar, once; round 16: with the room's own board on (CLASSROOM_ROOM_BOARD), its
      // drawing tools are a second toolbar with a name of its own.
      await expect(page.locator('.room2-bar[role="toolbar"]')).toHaveCount(1);
      await expect(page.getByRole('toolbar')).toHaveCount(process.env.CLASSROOM_ROOM_BOARD === 'on' ? 2 : 1);
      const sound = page.locator('[data-sound]');
      await sound.getByRole('button', { name: words.sound, exact: true }).click();
      await expect(sound).toHaveCount(0);
      expect(await unnamedButtons(page), 'every button in the room has a name').toEqual([]);

      // A blocked camera and a network drop, played by the test classroom.
      const panel = page.locator('details.classroom-room-simulator');
      await panel.locator('summary').click();
      const play = scenario => panel.getByRole('button', { name: scenario, exact: true }).click();
      const camera = page.locator('[data-control="camera"]');
      await play(words.cameraBlocked);
      await expect(camera).toBeDisabled();
      await play(words.devicesBack);
      await expect(camera).toBeEnabled();
      await play(words.drop);
      await expect(connection).toHaveText(words.reconnecting);
      await play(words.restore);
      await expect(connection).toHaveText(words.connected);
      await panel.locator('summary').click();
      await screenshotSafely(page, { path: path.join(directory, `b${n}-${engine.name}-${engine.locale}.png`) });

      // Leave, then enter again with the same link (no second admission).
      await page.locator('[data-control="leave"]').click();
      await page.getByRole('button', { name: words.rejoin, exact: true }).click();
      await expect(connection).toHaveText(words.connected);
      await expect(card.locator(`[data-in-room-person="${name}"]`)).toBeVisible();
      await context.close();
    });
  }

  await check(`B${n + 1}`, '沒有對外請求，頁面沒有非預期的錯誤', async () => {
    if (report.externalRequests.length) throw new Error(`external requests: ${report.externalRequests.join(', ')}`);
    if (report.pageProblems.length) throw new Error(`page problems: ${report.pageProblems.join(' | ')}`);
  });
  report.status = 'passed';
} catch (error) {
  failure = error;
  report.status = 'failed';
  report.error = redactLinks(error.message);
} finally {
  report.finishedAt = new Date().toISOString();
  await writeFile(path.join(directory, 'report.json'), `${redactLinks(JSON.stringify(report, null, 2))}\n`);
  for (const browser of browsers) await browser.close().catch(() => {});
  server.child.kill();
  console.log(`Report and screenshots: ${directory}`);
}
if (failure) throw withoutLinkKeys(failure);
