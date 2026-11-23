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
const expectedRefusal = text => /Failed to load resource: the server responded with a status of (403|409|410)/.test(text)
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
    await expect(kyle.getByLabel(/Please enter your first name \(in English\)/)).toBeVisible();
    expect(new URL(kyle.url()).hash).toBe('');
    await kyle.getByLabel(/Please enter your first name/).fill('  Kyle ');
    await kyle.getByRole('button', { name: '進入教室' }).click();
    await expect(kyle.locator('[data-room-waiting]')).toBeVisible();
    await shot(kyle, 'r2-waiting');
    await expect(roomCard().locator('[data-waiting-person="Kyle"]')).toBeVisible();
    // A reload keeps waiting with the same request, never a second one.
    await kyle.reload();
    await expect(kyle.locator('[data-room-waiting]')).toBeVisible();
    await expect(roomCard().locator('[data-waiting-person]')).toHaveCount(1);
  });

  await check('R3', '老師讓他進入：學生自動到教室頁並進入；按「開啟聲音」聽得到；沒有聊天和舉手（沒有主持人，D-14）', async () => {
    await roomCard().locator('[data-waiting-person="Kyle"]').getByRole('button', { name: '讓他進入', exact: true }).click();
    await expect(roomCard().locator('[data-in-room-person="Kyle"]')).toBeVisible();
    await expect(kyle).toHaveURL(new RegExp(`${origin}/classroom/L-[0-9a-f]{32}$`));
    await kyle.getByRole('button', { name: '進入教室' }).click();
    await expect(kyle.locator('.room2-top .classroom-room-connection')).toHaveText('已連線');
    const sound = kyle.locator('[data-sound]');
    await expect(sound).toHaveAttribute('data-sound', 'off');
    await sound.getByRole('button', { name: '開啟聲音', exact: true }).click();
    await expect(sound).toHaveCount(0);
    await expect(kyle.getByRole('tab', { name: /聊天/ })).toHaveCount(0);
    await expect(kyle.getByRole('button', { name: /舉手/ })).toHaveCount(0);
    await shot(kyle, 'r3-in-room');
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
    await play('Zoom 讓所有人開白板');
    await expect(boardButton).toBeEnabled();
    await play('對方開啟白板');
    await expect(boardButton).toBeDisabled();
    await play('對方關閉白板');
    await boardButton.click();
    await expect(boardButton).toHaveAttribute('aria-pressed', 'true');
    await shot(kyle, 'r3b-whiteboard');
    await play('Zoom 只讓主持人開白板');
    await expect(boardButton).toHaveAttribute('aria-pressed', 'true');
    await boardButton.click();
    await expect(boardButton).toHaveCount(0);
    // Management stays on the owner's admin page: nothing here lowers hands, takes anyone out or ends
    // the lesson (the simulation panel, which names such cases, is closed first).
    await panel.locator('summary').click();
    await expect(kyle.getByRole('button', { name: /放下|請出|結束|移除/ })).toHaveCount(0);
  });

  await check('R4', '另一個人輸入同一個名字：只是另一位等待中的人（老師看到 kyle B），被婉拒後看到說明，進不了教室', async () => {
    const other = watch(await (await context({})).newPage(), 'student-impostor');
    await other.goto(link);
    await other.getByLabel(/Please enter your first name/).fill('kyle');
    await other.getByRole('button', { name: '進入教室' }).click();
    await expect(other.locator('[data-room-waiting]')).toBeVisible();
    const waiting = roomCard().locator('[data-waiting-person="kyle B"]');
    await expect(waiting).toBeVisible();
    await waiting.getByRole('button', { name: '不讓他進入' }).click();
    await expect(other.locator('[data-room-final]')).toHaveText('老師沒有讓你進入這間教室。如果有問題，請聯絡老師。');
    await expect(roomCard().locator('[data-in-room-person]')).toHaveCount(1);
  });

  await check('R5', '更換連結：舊連結輸入名字後看到「連結已經更換」；已經在教室裡的人不受影響；新連結可以用', async () => {
    oldLink = link;
    await roomCard().getByRole('button', { name: '更換連結' }).click();
    const shown = admin.locator('[data-room-link] code');
    await expect(shown).toContainText('/classroom/r/FR-');
    link = (await shown.innerText()).trim();
    expect(link).not.toBe(oldLink);
    await admin.getByRole('button', { name: '我已經記下連結' }).click();
    const late = watch(await (await context({})).newPage(), 'student-old-link');
    await late.goto(oldLink);
    await late.getByLabel(/Please enter your first name/).fill('Ann');
    await late.getByRole('button', { name: '進入教室' }).click();
    await expect(late.locator('[data-room-final]')).toHaveText('這個教室連結已經更換。請向老師要新的連結。');
    await expect(kyle.locator('.room2-top .classroom-room-connection')).toHaveText('已連線');
    ann = watch(await (await context({})).newPage(), 'student-new-link');
    await ann.goto(link);
    await ann.getByLabel(/Please enter your first name/).fill('Ann');
    await ann.getByRole('button', { name: '進入教室' }).click();
    await expect(ann.locator('[data-room-waiting]')).toBeVisible();
  });

  // P2 (2026-11-23): the fixed room's own words, not the one-to-one lesson's ("this personal link no
  // longer works, ask iHear for a new one"): the room's shared link keeps working.
  await check('R6', '請出教室：老師按請出，學生的頁面離開教室，說「老師已請你離開這間教室」（不是一對一的「個人連結已失效」）；他的入場憑證進不來', async () => {
    await roomCard().locator('[data-in-room-person="Kyle"]').getByRole('button', { name: '請出教室' }).click();
    await expect(roomCard().locator('[data-in-room-person="Kyle"]')).toHaveCount(0);
    await expect(kyle.getByText('老師已請你離開這間教室。如有問題，請聯絡老師。')).toBeVisible({ timeout: 45_000 });
    await expect(kyle.getByText(/個人連結已失效|索取新的連結/)).toHaveCount(0);
    await shot(kyle, 'r6-taken-out');
  });

  await check('R6a', '老師讓 Ann 進入：她進到同一次上課（請出別人之後，教室換到新的 Zoom Session）；另一位 Cy 用連結申請、在等待', async () => {
    await roomCard().locator('[data-waiting-person="Ann"]').getByRole('button', { name: '讓他進入', exact: true }).click();
    await expect(roomCard().locator('[data-in-room-person="Ann"]')).toBeVisible();
    await expect(ann).toHaveURL(new RegExp(`${origin}/classroom/L-[0-9a-f]{32}$`));
    await ann.getByRole('button', { name: '進入教室' }).click();
    await expect(ann.locator('.room2-top .classroom-room-connection')).toHaveText('已連線');
    const cy = watch(await (await context({})).newPage(), 'student-cy');
    await cy.goto(link);
    await cy.getByLabel(/Please enter your first name/).fill('Cy');
    await cy.getByRole('button', { name: '進入教室' }).click();
    await expect(cy.locator('[data-room-waiting]')).toBeVisible();
    await expect(roomCard().locator('[data-waiting-person="Cy"]')).toBeVisible();
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
    await bea.getByLabel(/Please enter your first name/).fill('Bea');
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
