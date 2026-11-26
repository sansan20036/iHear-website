// A local demonstration for a person to operate (2026-11-24): the built application on this
// computer, disposable local storage, the synthetic stand-in for Zoom, and the room channel's
// three switches on. It creates one fixed room, lets the people in, each in a browser window of
// their own, and leaves the windows open; the iHear teacher's rooms page is in one more window (to
// take someone out, or to end the lesson).
//
//   npm run build        once, in a tree whose classroom page mounts the room channel's pieces
//   node tests/room-channel/room-channel.demo.mjs [--people 2] [--minutes 30] [--off]
//
//   --people n    how many people are let in (2 to 4; default 2: "Teacher" and "Student")
//   --minutes n   after this long the demonstration ends by itself (default 30)
//   --off         the three switches off: the room as it is without any of this
//
// It ends when every window has been closed, after the minutes given, or on Ctrl+C; the server it
// started is stopped then. Its data is a new folder under output/playwright/.
//
// What it is not: no real Zoom session, no real camera or screen (the stand-in shows a made-up
// picture), no recording, not the production site and not its database. What works here is our
// pages, our route and our rules; it says nothing about Zoom.
import { chromium } from '@playwright/test';
import { localContext, startAcademyServer } from '../helpers/academy-smoke.mjs';

const argv = process.argv.slice(2);
const valueOf = (name, otherwise) => (argv.includes(name) ? Number(argv[argv.indexOf(name) + 1]) : otherwise);
const count = Math.min(4, Math.max(2, Math.trunc(valueOf('--people', 2)) || 2));
const minutes = Math.min(180, Math.max(1, valueOf('--minutes', 30) || 30));
const off = argv.includes('--off');
const NAMES = ['Teacher', 'Student', 'Student Two', 'Student Three'].slice(0, count);
const secret = 'room-channel-local-demonstration-only';
const owner = 'rooms-owner@example.test';
const on = off ? '' : 'on';
Object.assign(process.env, {
  CLASSROOM_PROVIDER: 'synthetic', CLASSROOM_DRIVE: 'local', CLASSROOM_WEBHOOK_SECRET: 'room-channel-demo-webhook-local-only', CLASSROOM_SYNTHETIC_SECRET: 'room-channel-demo-token-local-only',
  VERCEL_ENV: '', CLASSROOM_MULTI_RECORDING: '', CLASSROOM_FIXED_ROOMS: 'on', CLASSROOM_FIXED_ROOM_RECORDING: '',
  CLASSROOM_ROOM_BOARD: on, CLASSROOM_ROOM_CHAT: on, CLASSROOM_ROOM_SHARE_TURN: on,
});

const say = line => console.log(line);
let server = null, browser = null, over = false;
async function finish(why) {
  if (over) return;
  over = true;
  say(`\n結束：${why}`);
  await browser?.close().catch(() => undefined);
  server?.child.kill();
}
process.on('SIGINT', () => { void finish('按了 Ctrl+C').then(() => process.exit(0)); });
// The people's windows side by side across the screen, so what one does is seen in the other at
// once. Asked of the browser itself; if it will not say, the window stays where it opened.
async function place(page, index, of) {
  try {
    const session = await page.context().newCDPSession(page);
    const { windowId } = await session.send('Browser.getWindowForTarget');
    const screen = await page.evaluate(() => ({ left: window.screen.availLeft ?? 0, top: window.screen.availTop ?? 0, width: window.screen.availWidth, height: window.screen.availHeight }));
    const width = Math.floor(screen.width / of);
    await session.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
    await session.send('Browser.setWindowBounds', { windowId, bounds: { left: screen.left + index * width, top: screen.top, width, height: screen.height } });
  } catch { /* stays where it opened */ }
}

try {
  server = await startAcademyServer({ port: Number(process.env.ROOM_CHANNEL_DEMO_PORT ?? 3360), secret, owners: [owner], name: 'room-channel-demo' });
  const { origin } = server;
  // Windows for a person to operate; ROOM_CHANNEL_DEMO_HEADLESS=1 opens none (to prove this script
  // itself after a change, with --minutes 1).
  browser = await chromium.launch({ headless: process.env.ROOM_CHANNEL_DEMO_HEADLESS === '1' });
  browser.on('disconnected', () => { void finish('瀏覽器已關閉').then(() => process.exit(0)); });
  // Every window has its own people: nothing is shared between them but the server.
  const windowFor = options => localContext(browser, origin, { secret, locale: 'zh-TW', viewport: null, ...options });

  const admin = await (await windowFor({ email: owner })).newPage();
  await admin.goto(`${origin}/admin/classrooms/rooms`);
  await admin.getByLabel('教室名稱（例如 Room 1）').fill('Demo Room');
  // Round 18: rooms made on the page let people in directly unless this is unticked. The demo keeps
  // the way it was shown (the owner's window lets each person in). By the form's own mark: every
  // room's settings also have a label with 直接進入.
  await admin.locator('[data-room-direct-choice] input[type="checkbox"]').uncheck();
  await admin.getByRole('button', { name: '建立教室' }).click();
  const shown = admin.locator('[data-room-link] code');
  await shown.waitFor();
  const link = (await shown.innerText()).trim();
  await admin.getByRole('button', { name: '我已經記下連結' }).click();
  const card = admin.locator('[data-room="Demo Room"]');

  const pages = [];
  for (const [index, name] of NAMES.entries()) {
    const page = await (await windowFor({})).newPage();
    await place(page, index, NAMES.length);
    await page.goto(link);
    await page.getByLabel(/Please enter your first name/).fill(name);
    await page.getByRole('button', { name: '進入教室' }).click();
    await page.locator('[data-room-waiting]').waitFor();
    await card.locator(`[data-waiting-person="${name}"]`).getByRole('button', { name: '讓他進入', exact: true }).click();
    await page.waitForURL(/\/classroom\/L-[0-9a-f]{32}$/);
    await page.getByRole('button', { name: '進入教室' }).click();
    await page.locator('.room2-top .classroom-room-connection').filter({ hasText: '已連線' }).waitFor();
    pages.push(page);
    say(`已進入教室：${name}`);
  }
  const mounted = off ? 0 : await pages[0].locator('[data-room-channel]').count();

  say('');
  say(`本機展示已就緒（${NAMES.length} 個人在同一間固定教室，視窗左右並排：${NAMES.join('、')}；iHear 老師的教室管理頁在它們後面的另一個視窗，從工作列切換）。`);
  if (off) say('這次三個開關都是關閉的：教室應該和原來一樣，沒有教室自己的白板、聊天和分享權。');
  else if (!mounted) say('注意：這個建置的教室頁面還沒有接上白板、聊天和分享權（找不到接點），所以看不到它們。');
  else {
    say('可以試的事：');
    say('  1. 在任何一個視窗的白板上畫，另一個視窗會同時出現；換顏色、粗細、橡皮擦、全部清除與復原。');
    say('  2. 在聊天輸入訊息，所有人都收得到；沒有私人訊息。');
    say('  3. 按分享：一個人分享時，其他人不能分享；停止後別人才可以。分享中可以把分享權轉交給指定的人。');
    say('  4. 重新整理其中一個視窗：頁面會自己回到教室（可能要再按一次「進入教室」），白板和聊天都還在。');
    say('     如果沒有自己回來，把下面的教室連結貼到同一個視窗的網址列也可以回到教室。');
    say('  5. 在老師的管理頁把一個人請出教室：他不能再用白板和聊天，其他人照常。');
  }
  say(`這間展示教室的連結（只在這台電腦、這次展示有效）：${link}`);
  say('這是本機展示：視訊和分享畫面用的是 Zoom 替身，不是真實 Zoom；沒有錄影；不是正式站。');
  say(`把所有視窗關掉、或在這裡按 Ctrl+C 就會結束（最久 ${minutes} 分鐘）。`);

  const started = Date.now();
  while (!over) {
    await new Promise(resolve => { setTimeout(resolve, 1000); });
    if ([admin, ...pages].every(page => page.isClosed())) { await finish('所有視窗都關了'); break; }
    if (Date.now() - started > minutes * 60_000) { await finish(`已經過了 ${minutes} 分鐘`); break; }
  }
} catch (error) {
  console.error(`展示沒有開始成功：${error.message}`);
  await finish('發生錯誤');
  process.exitCode = 1;
}
