// Classroom 3.0 round 3 (2026-11-21): a fixed room's link in a browser, end to end with synthetic
// data: the built application, disposable local storage and test-only sessions; the synthetic
// provider stands in for Zoom. The iHear teacher (an owner) makes a room and gets its link once; a
// student opens it, types a first name and waits; the teacher lets them in and the student enters
// the room's lesson; the same name again is just another person waiting; a replaced link lets
// nobody new in; a person taken out leaves. Proves our pages and checks, not Zoom.
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, expect as playwrightExpect } from '@playwright/test';
import { redactLinks, withoutLinkKeys, screenshotSafely, localContext, startAcademyServer } from './helpers/academy-smoke.mjs';

const expect = playwrightExpect.configure({ timeout: 15_000 });
const secret = 'classroom-rooms-local-acceptance-only';
const owner = 'rooms-owner@example.test';
// Round 16: the room channel's three switches as this run was started with them (they are not set
// here): off is the site today; on, the room's own chat is in the panel and its own board replaces
// Zoom's (one board per room), and everything else (entry, room management, video) is the same.
const ROOM_CHAT_ON = process.env.CLASSROOM_ROOM_CHAT === 'on';
const ROOM_BOARD_ON = process.env.CLASSROOM_ROOM_BOARD === 'on';
console.log(`room channel switches: board ${ROOM_BOARD_ON ? 'on' : 'off'}, chat ${ROOM_CHAT_ON ? 'on' : 'off'}, turn ${process.env.CLASSROOM_ROOM_SHARE_TURN === 'on' ? 'on' : 'off'}`);
Object.assign(process.env, {
  CLASSROOM_PROVIDER: 'synthetic', CLASSROOM_DRIVE: 'local', CLASSROOM_WEBHOOK_SECRET: 'classroom-rooms-webhook-local-only',
  CLASSROOM_SYNTHETIC_SECRET: 'classroom-rooms-token-local-only', VERCEL_ENV: '', CLASSROOM_MULTI_RECORDING: '', CLASSROOM_FIXED_ROOMS: 'on', CLASSROOM_FIXED_ROOM_RECORDING: '',
});
const server = await startAcademyServer({ port: 3266, secret, owners: [owner], name: 'classroom-rooms' });
const { origin, directory } = server;
const report = { startedAt: new Date().toISOString(), origin, synthetic: true, zoomVerified: false, checks: [], externalRequests: [], pageProblems: [], status: 'running' };
let browser, failure;

async function check(id, name, action) {
  try { await action(); report.checks.push({ id, name, status: 'PASS' }); console.log(`PASS ${id} ${name}`); }
  catch (error) { report.checks.push({ id, name, status: 'FAIL', error: error.message }); throw error; }
}
const context = options => localContext(browser, origin, { external: report.externalRequests, secret, locale: 'zh-TW', ...options });
// Refusals the checks provoke on purpose (a replaced link, a revoked key) are not page problems, and
// neither is the connection R1b cuts on purpose, while it does.
let cuttingAnswers = false;
// Round 18l: R2 types a Chinese name on purpose, which the door refuses (400) while it is tried.
let refusingName = false;
const expectedRefusal = text => /Failed to load resource: the server responded with a status of (403|409|410)/.test(text)
  || (refusingName && /Failed to load resource: the server responded with a status of 400/.test(text))
  || (cuttingAnswers && /net::ERR_CONNECTION_FAILED/.test(text));
function watch(page, who) {
  page.on('console', message => { if (message.type() === 'error' && !expectedRefusal(message.text())) report.pageProblems.push(`${who}: ${message.text()}`); });
  page.on('pageerror', error => report.pageProblems.push(`${who}: ${error.message}`));
  page.on('dialog', dialog => dialog.accept());
  return page;
}
const shot = (page, name) => screenshotSafely(page, { path: path.join(directory, `${name}.png`), fullPage: true });

try {
  browser = await chromium.launch({ headless: process.env.IHEAR_HEADED !== '1' });
  const admin = watch(await (await context({ email: owner })).newPage(), 'owner');
  const roomCard = () => admin.locator('[data-room="Room 1"]');
  let link, oldLink, ann;

  await check('R1', '老師在後台建立固定教室：連結只顯示這一次', async () => {
    await admin.goto(`${origin}/admin/classrooms/rooms`);
    await admin.getByLabel('教室名稱（例如 Room 1）').fill('Room 1');
    // Round 18: rooms made on the page are direct by default; this check is about the owner letting people in.
    await admin.locator('[data-room-direct-choice] input[type="checkbox"]').uncheck();
    await admin.getByRole('button', { name: '建立教室' }).click();
    const shown = admin.locator('[data-room-link] code');
    await expect(shown).toContainText('/classroom/r/FR-');
    link = (await shown.innerText()).trim();
    expect(new URL(link).hash).toMatch(/^#k=[A-Za-z0-9_-]{43}$/);
    await shot(admin, 'r1-created');
    await admin.getByRole('button', { name: '我已經記下連結' }).click();
    await expect(admin.locator('[data-room-link]')).toHaveCount(0);
    await admin.reload();
    await expect(roomCard()).toBeVisible();
    await expect(admin.locator('[data-room-link]')).toHaveCount(0);
  });

  // Round 7 (2026-11-21): one room's change whose answer never arrives (the server made it).
  await check('R1b', '建立教室時連線中斷（伺服器已經建立，頁面沒收到結果）：頁面說教室已經建立、連結沒有送到，請按「更換連結」；名稱保留、不會自己再送一次；更換後拿到新連結', async () => {
    const api = '**/api/admin/classrooms/rooms';
    const posts = [];
    await admin.route(api, async route => {
      if (route.request().method() !== 'POST') return route.continue();
      posts.push(route.request().postDataJSON()?.action);
      await route.fetch();
      return route.abort('connectionfailed');
    });
    cuttingAnswers = true;
    try {
      await admin.getByLabel('教室名稱（例如 Room 1）').fill('Room 2');
      // Round 18: rooms made on the page are direct by default; this check is about the owner letting people in.
      await admin.locator('[data-room-direct-choice] input[type="checkbox"]').uncheck();
      await admin.getByRole('button', { name: '建立教室' }).click();
      await expect(admin.getByText('教室「Room 2」已經建立，但它的連結沒有送到這個頁面（沒有人看過這個連結）。請在這間教室按「更換連結」，取得新的連結。')).toBeVisible();
      await expect(admin.getByLabel('教室名稱（例如 Room 1）')).toHaveValue('Room 2');
      await expect(admin.locator('[data-room="Room 2"]')).toHaveCount(1);
      await expect(admin.locator('[data-room-link]')).toHaveCount(0);
      expect(posts).toEqual(['create']);
    } finally {
      cuttingAnswers = false;
      await admin.unroute(api);
    }
    await admin.locator('[data-room="Room 2"]').getByRole('button', { name: '更換連結' }).click();
    await expect(admin.locator('[data-room-link] code')).toContainText('/classroom/r/FR-');
    await admin.getByRole('button', { name: '我已經記下連結' }).click();
    await admin.getByLabel('教室名稱（例如 Room 1）').fill('');
  });

  const kyle = watch(await (await context({})).newPage(), 'student-kyle');
  await check('R2', '學生打開連結：網址裡的金鑰立刻拿掉；輸入英文名字後等待，還沒有進教室', async () => {
    await kyle.goto(link);
    await expect(kyle.getByLabel(/Your English Name/)).toBeVisible();
    expect(new URL(kyle.url()).hash).toBe('');
    // Round 18l (the user, 2026-11-28, the entry page's concept image): a welcome, the classroom's name,
    // no tick box; the recording notice only where the room's lessons are recorded (not here).
    await expect(kyle.locator('.classroom-join-welcome')).toHaveText('歡迎來到你的教室');
    await expect(kyle.locator('[data-room-label] strong')).not.toBeEmpty();
    await expect(kyle.locator('[data-room-recorded]')).toHaveCount(0);
    await expect(kyle.locator('input[type="checkbox"]')).toHaveCount(0);
    await shot(kyle, 'r2-door');
    // A Chinese name is refused at the door now, with the reason (the 400 it gets is expected here).
    refusingName = true;
    await kyle.getByLabel(/Your English Name/).fill('小明');
    await kyle.getByRole('button', { name: '進入教室' }).click();
    await expect(kyle.locator('[data-room-problem]')).toContainText('請用英文字母輸入名字');
    refusingName = false;
    await kyle.getByLabel(/Your English Name/).fill('  Kyle ');
    await kyle.getByRole('button', { name: '進入教室' }).click();
    await expect(kyle.locator('[data-room-waiting]')).toBeVisible();
    await shot(kyle, 'r2-waiting');
    await expect(roomCard().locator('[data-waiting-person="Kyle"]')).toBeVisible();
    // A reload keeps waiting with the same request, never a second one.
    await kyle.reload();
    await expect(kyle.locator('[data-room-waiting]')).toBeVisible();
    await expect(roomCard().locator('[data-waiting-person]')).toHaveCount(1);
  });

  await check('R3', '老師讓他進入：學生自動到教室頁並進入；按「開啟聲音」聽得到；沒有聊天（沒有主持人，D-14）；可以舉手、自己放下（使用者 11/24 開放）', async () => {
    await roomCard().locator('[data-waiting-person="Kyle"]').getByRole('button', { name: '讓他進入', exact: true }).click();
    await expect(roomCard().locator('[data-in-room-person="Kyle"]')).toBeVisible();
    await expect(kyle).toHaveURL(new RegExp(`${origin}/classroom/L-[0-9a-f]{32}$`));
    await kyle.getByRole('button', { name: '進入教室' }).click();
    await expect(kyle.locator('.room2-top .classroom-room-connection')).toHaveText('已連線');
    const sound = kyle.locator('[data-sound]');
    await expect(sound).toHaveAttribute('data-sound', 'off');
    await sound.getByRole('button', { name: '開啟聲音', exact: true }).click();
    await expect(sound).toHaveCount(0);
    // Zoom's chat stays off in a fixed room; with the room channel's chat on, the room's own chat is
    // offered (the toolbar's chat button; the panel's tab is hidden until the panel opens).
    await expect(kyle.getByRole('tab', { name: /聊天/ })).toHaveCount(0);
    await expect(kyle.locator('[data-control="chat"]')).toHaveCount(ROOM_CHAT_ON ? 1 : 0);
    // The user, 2026-11-24: raised hands are on in a fixed room (Zoom's command channel needs no
    // host; W1 on real Zoom). The person raises and lowers their own hand.
    const hand = kyle.locator('[data-control="hand"]');
    await expect(hand).toHaveAttribute('aria-pressed', 'false');
    await hand.click();
    await expect(hand).toHaveAttribute('aria-pressed', 'true');
    await shot(kyle, 'r3-in-room');
    await hand.click();
    await expect(hand).toHaveAttribute('aria-pressed', 'false');
  });

  // D-14 (2026-11-21): the teacher's rule, "the same teaching tools for everyone, management kept
  // apart". The test classroom plays Zoom's answers; real Zoom's own answers without a host are
  // still to be seen in a real session.
  await check('R3b', 'D-14：教學功能大家一樣：電腦上每個人都有「分享畫面」，別人分享時不能搶；白板只在 Zoom 允許時出現，自己開的白板一定能關；教室頁沒有任何管理按鈕', async () => {
    const shareButton = kyle.locator('[data-tool="share"]');
    const boardButton = kyle.locator('[data-tool="whiteboard"]');
    await expect(shareButton).toBeEnabled();
    await expect(boardButton).toHaveCount(0);
    const panel = kyle.locator('details.classroom-room-simulator');
    await panel.locator('summary').click();
    const play = name => panel.getByRole('button', { name, exact: true }).click();
    await play('對方分享畫面');
    await expect(shareButton).toBeDisabled();
    await expect(shareButton).toHaveAttribute('aria-label', '其他人正在分享畫面；等對方停止分享後，才能分享你的畫面。');
    await play('對方停止分享');
    await expect(shareButton).toBeEnabled();
    await shareButton.click();
    await expect(shareButton).toHaveAttribute('aria-pressed', 'true');
    await shareButton.click();
    await expect(shareButton).toHaveAttribute('aria-pressed', 'false');
    if (ROOM_BOARD_ON) {
      // Round 18c (load check 2026-11-27): with the room channel on, the lesson's status comes in the
      // channel's answers, so the page sends no status request of its own (it did every 15 s).
      const statusAsked = [];
      const onRequest = request => { if (request.method() === 'POST' && /^\/api\/classroom\/L-[0-9a-f]{32}\/status$/.test(new URL(request.url()).pathname)) statusAsked.push(request.url()); };
      kyle.on('request', onRequest);
      await kyle.waitForTimeout(17_000);
      kyle.off('request', onRequest);
      expect(statusAsked).toEqual([]);
      // One board per room: Zoom's whiteboard is never offered, whatever Zoom allows; the room's own is.
      await play('Zoom 讓所有人開白板');
      await expect(boardButton).toHaveCount(0);
      await expect(kyle.locator('[data-room-board-toggle]')).toHaveCount(1);
      await expect(kyle.locator('[data-room-board-stage]')).toHaveCount(1);
      await shot(kyle, 'r3b-room-board');
    } else {
    await play('Zoom 讓所有人開白板');
    await expect(boardButton).toBeEnabled();
    await play('對方開啟白板');
    await expect(boardButton).toBeDisabled();
    await play('對方關閉白板');
    await boardButton.click();
    await expect(boardButton).toHaveAttribute('aria-pressed', 'true');
    // Round 18: the press that opens Zoom's board takes the stage full screen (its menus are not cut
    // off); the stage's button leaves it, which the test panel below needs.
    await expect.poll(() => kyle.evaluate(() => document.fullscreenElement?.classList.contains('room2-stage') ?? false)).toBe(true);
    await kyle.locator('[data-stage-fullscreen]').click();
    await expect.poll(() => kyle.evaluate(() => document.fullscreenElement === null)).toBe(true);
    await shot(kyle, 'r3b-whiteboard');
    await play('Zoom 只讓主持人開白板');
    await expect(boardButton).toHaveAttribute('aria-pressed', 'true');
    await boardButton.click();
    await expect(boardButton).toHaveCount(0);
    }
    // Management stays on the owner's admin page: nothing here lowers hands, takes anyone out or ends
    // the lesson (the simulation panel, which names such cases, is closed first).
    await panel.locator('summary').click();
    await expect(kyle.getByRole('button', { name: /放下|請出|結束|移除/ })).toHaveCount(0);
  });

  await check('R4', '另一個人輸入同一個名字：只是另一位等待中的人（老師看到 kyle B），被婉拒後看到說明，進不了教室', async () => {
    const other = watch(await (await context({})).newPage(), 'student-impostor');
    await other.goto(link);
    await other.getByLabel(/Your English Name/).fill('kyle');
    await other.getByRole('button', { name: '進入教室' }).click();
    await expect(other.locator('[data-room-waiting]')).toBeVisible();
    const waiting = roomCard().locator('[data-waiting-person="kyle B"]');
    await expect(waiting).toBeVisible();
    await waiting.getByRole('button', { name: '不讓他進入' }).click();
    await expect(other.locator('[data-room-final]')).toHaveText('老師沒有讓你進入這間教室。如果有問題，請聯絡老師。');
    await expect(roomCard().locator('[data-in-room-person]')).toHaveCount(1);
  });

  await check('R5', '更換連結：舊連結一打開就看到「連結已經更換」；已經在教室裡的人不受影響；新連結可以用', async () => {
    oldLink = link;
    await roomCard().getByRole('button', { name: '更換連結' }).click();
    // Round 18d (the user, 2026-11-27): a link made from a room's card is shown in that card.
    await expect(roomCard().locator('[data-room-link][data-room-link-in="card"] code')).toContainText('/classroom/r/FR-');
    const shown = admin.locator('[data-room-link] code');
    await expect(shown).toContainText('/classroom/r/FR-');
    link = (await shown.innerText()).trim();
    expect(link).not.toBe(oldLink);
    await admin.getByRole('button', { name: '我已經記下連結' }).click();
    const late = watch(await (await context({})).newPage(), 'student-old-link');
    await late.goto(oldLink);
    // Round 18l: the door asks with the link first, so an old link says so before any name is typed.
    await expect(late.locator('[data-room-final]')).toHaveText('這個教室連結已經更換。請向老師要新的連結。');
    await expect(late.getByLabel(/Your English Name/)).toHaveCount(0);
    await expect(kyle.locator('.room2-top .classroom-room-connection')).toHaveText('已連線');
    ann = watch(await (await context({})).newPage(), 'student-new-link');
    await ann.goto(link);
    await ann.getByLabel(/Your English Name/).fill('Ann');
    await ann.getByRole('button', { name: '進入教室' }).click();
    await expect(ann.locator('[data-room-waiting]')).toBeVisible();
  });

  await check('R5b', '老師讓 Ann 進入：她和 Kyle 在同一次上課；另一位 Cy 用連結申請、在等待', async () => {
    await roomCard().locator('[data-waiting-person="Ann"]').getByRole('button', { name: '讓他進入', exact: true }).click();
    await expect(roomCard().locator('[data-in-room-person="Ann"]')).toBeVisible();
    await expect(ann).toHaveURL(new RegExp(`${origin}/classroom/L-[0-9a-f]{32}$`));
    await ann.getByRole('button', { name: '進入教室' }).click();
    await expect(ann.locator('.room2-top .classroom-room-connection')).toHaveText('已連線');
    await expect(ann.locator('.room2-top .classroom-room-connection')).toHaveAttribute('data-room-moves', '0');
    const cy = watch(await (await context({})).newPage(), 'student-cy');
    await cy.goto(link);
    await cy.getByLabel(/Your English Name/).fill('Cy');
    await cy.getByRole('button', { name: '進入教室' }).click();
    await expect(cy.locator('[data-room-waiting]')).toBeVisible();
    await expect(roomCard().locator('[data-waiting-person="Cy"]')).toBeVisible();
  });

  // The user's decisions of 2026-11-24 (items 5 and 6): a room's settings and its lesson's extension,
  // from the owner's page.
  await check('R5c', '教室設定與延長：老師在「教室設定」改成一對一、2 人，卡片的說明跟著改；按「延長 30 分鐘」後，「最晚到」的時間往後 30 分鐘', async () => {
    const settings = roomCard().locator('[data-room-settings]');
    await settings.locator('summary').click();
    await settings.locator('select[name="form"]').selectOption('one_to_one');
    await settings.locator('input[name="capacity"]').fill('2');
    await settings.getByRole('button', { name: '儲存設定' }).click();
    // Round 18: the mark ends with the room's entry; this room was made for the owner's admission and
    // saving the form above keeps that entry.
    await expect(roomCard().locator('[data-room-settings-now]')).toHaveAttribute('data-room-settings-now', 'one_to_one:2:120:approval');
    await expect(roomCard().locator('[data-room-settings-now]')).toContainText('老師讓他進入・一對一・最多 2 人・每次上課 120 分鐘');
    // The page shows the time the zh-TW way (上午/下午 and a 12-hour clock, or 24 hours).
    const until = async () => {
      const text = await roomCard().getByText(/上課中，最晚到 /).innerText();
      const [, half, hours, minutes] = text.match(/最晚到 (上午|下午)?\s*(\d{1,2}):(\d{2})/);
      const h = Number(hours) % 12 + (half === "下午" ? 12 : half === "上午" ? 0 : Number(hours) >= 12 ? 12 : 0);
      return h * 60 + Number(minutes);
    };
    const before = await until();
    await roomCard().locator('[data-room-extend]').click();
    await expect.poll(async () => ((await until()) - before + 1440) % 1440).toBe(30);
    await shot(admin, 'r5c-settings-extended');
  });

  // P2 (2026-11-23): the fixed room's own words, not the one-to-one lesson's ("this personal link no
  // longer works, ask iHear for a new one"): the room's shared link keeps working. And the one who
  // stays moves to the room's new session (D-4) and is connected there: data-room-moves says the
  // page really moved, so 已連線 is the new session's, not the old one's (W1 on real Zoom, 11/23).
  await check('R6', '請出教室：老師按請出 Kyle，他的頁面離開教室，說「老師已請你離開這間教室」（不是一對一的「個人連結已失效」）；留下的 Ann 換到新的 Session 並重新連上', async () => {
    await roomCard().locator('[data-in-room-person="Kyle"]').getByRole('button', { name: '請出教室' }).click();
    await expect(roomCard().locator('[data-in-room-person="Kyle"]')).toHaveCount(0);
    await expect(kyle.getByText('老師已請你離開這間教室。如有問題，請聯絡老師。')).toBeVisible({ timeout: 45_000 });
    await expect(kyle.getByText(/個人連結已失效|索取新的連結/)).toHaveCount(0);
    await shot(kyle, 'r6-taken-out');
    const annState = ann.locator('.room2-top .classroom-room-connection');
    await expect(annState).toHaveAttribute('data-room-moves', '1', { timeout: 45_000 });
    await expect(annState).toHaveText('已連線');
    await expect(roomCard().locator('[data-in-room-person="Ann"]')).toBeVisible();
  });

  // Round 7 (2026-11-21): a room taken out of use and back (lib/classroom-fixed-rooms.ts setInUse).
  await check('R6b', '停用與重新啟用：上課中不能停用（先結束這次上課）；結束時教室裡的 Ann 看到「老師已結束這次上課」（不是「這堂課已經取消」）；停用後拿連結的人看到「這間教室目前停用」，等待中的申請結束；重新啟用後同一個連結可以申請，舊的申請不會回來', async () => {
    await roomCard().getByRole('button', { name: '停用這間教室' }).click();
    await expect(admin.getByText('這間教室正在上課：請先結束這次上課，再停用。')).toBeVisible();
    await expect(roomCard()).toHaveAttribute('data-room-in-use', 'yes');
    await roomCard().getByRole('button', { name: '結束這次上課' }).click();
    await expect(roomCard().getByRole('button', { name: '結束這次上課' })).toHaveCount(0);
    // P2 (2026-11-23): the lesson's end in the fixed room's own words.
    await expect(ann.getByText('老師已結束這次上課。下次上課時，請再打開同一個教室連結。')).toBeVisible({ timeout: 45_000 });
    await expect(ann.getByText('這堂課已經取消。')).toHaveCount(0);
    await shot(ann, 'r6b-lesson-ended');
    await roomCard().getByRole('button', { name: '停用這間教室' }).click();
    await expect(roomCard()).toHaveAttribute('data-room-in-use', 'no');
    await expect(roomCard().locator('[data-room-disabled]')).toBeVisible();
    await expect(roomCard().locator('[data-waiting-person]')).toHaveCount(0);
    const bea = watch(await (await context({})).newPage(), 'student-room-disabled');
    await bea.goto(link);
    await bea.getByLabel(/Your English Name/).fill('Bea');
    await bea.getByRole('button', { name: '進入教室' }).click();
    await expect(bea.locator('[data-room-problem]')).toHaveText('這間教室目前停用。請向老師確認。');
    await shot(admin, 'r6b-disabled');
    await roomCard().getByRole('button', { name: '重新啟用' }).click();
    await expect(roomCard()).toHaveAttribute('data-room-in-use', 'yes');
    await bea.getByRole('button', { name: '進入教室' }).click();
    await expect(bea.locator('[data-room-waiting]')).toBeVisible();
    // Only the new request waits: Cy's, closed by the disabling, does not come back (Ann was let in,
    // and her lesson ended).
    await expect(roomCard().locator('[data-waiting-person]')).toHaveCount(1);
    await expect(roomCard().locator('[data-waiting-person="Bea"]')).toBeVisible();
  });

  // Round 18 (the user's plan, 2026-11-26, points 2 and 3): a name and Join, and you are in.
  await check('R8', '直接進入的教室：輸入名字按「進入教室」就到教室頁並進入，老師不用讓他進入；同一個瀏覽器重開連結（新分頁）回到同一個人，不會變成 Dana B', async () => {
    await admin.goto(`${origin}/admin/classrooms/rooms`);
    await admin.locator('[data-room-direct-choice] input[type="checkbox"]').check();
    await admin.getByLabel('教室名稱（例如 Room 1）').fill('Room D');
    await admin.getByRole('button', { name: '建立教室' }).click();
    const shown = admin.locator('[data-room-link] code');
    await expect(shown).toContainText('/classroom/r/FR-');
    const direct = (await shown.innerText()).trim();
    await admin.getByRole('button', { name: '我已經記下連結' }).click();
    const card = admin.locator('[data-room="Room D"]');
    await expect(card.locator('[data-room-settings-now]')).toHaveAttribute('data-room-settings-now', /:direct$/);
    const dana = await context({});
    const first = watch(await dana.newPage(), 'student-dana');
    await first.goto(direct);
    await first.getByLabel(/Your English Name/).fill('Dana');
    await first.getByRole('button', { name: '進入教室' }).click();
    await expect(first).toHaveURL(new RegExp(`${origin}/classroom/L-[0-9a-f]{32}$`));
    await first.getByRole('button', { name: '進入教室' }).click();
    await expect(first.locator('.room2-top .classroom-room-connection')).toHaveText('已連線');
    // Shown by her name alone (no "Student" in a fixed room).
    await expect(first.locator('.room2-tile-name').filter({ hasText: 'Dana' }).locator('.room2-tile-role')).toHaveCount(0);
    await admin.reload();
    await expect(card.locator('[data-in-room-person]')).toHaveCount(1);
    await expect(card.locator('[data-waiting-person]')).toHaveCount(0);
    await shot(first, 'r8-direct-in');
    // The tab closed; the link opened again in the same browser: the same person, the same place.
    await first.close();
    const again = watch(await dana.newPage(), 'student-dana-again');
    await again.goto(direct);
    await expect(again).toHaveURL(new RegExp(`${origin}/classroom/L-[0-9a-f]{32}$`));
    await again.getByRole('button', { name: '進入教室' }).click();
    await expect(again.locator('.room2-top .classroom-room-connection')).toHaveText('已連線');
    await admin.reload();
    await expect(card.locator('[data-in-room-person]')).toHaveCount(1);
    await expect(card.locator('[data-in-room-person="Dana"]')).toBeVisible();
    // Round 18c (the user's point 17): the owner asks Zoom who is in the room now. This local site has the
    // synthetic stand-in, which cannot ask Zoom: the card says so (real Zoom: the online test site).
    await card.getByRole('button', { name: '問 Zoom：現在誰在教室裡' }).click();
    await expect(card.locator('[data-room-live]')).toHaveAttribute('data-room-live', 'unavailable');
    await expect(card.locator('[data-room-live]')).toContainText('這個網站的教室沒有連到 Zoom，無法查詢。');
    await again.close();
  });

  await check('R7', '沒有對外請求，頁面沒有非預期的錯誤', async () => {
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
  await browser?.close();
  server.child.kill();
  console.log(`Report and screenshots: ${directory}`);
}
if (failure) throw withoutLinkKeys(failure);
