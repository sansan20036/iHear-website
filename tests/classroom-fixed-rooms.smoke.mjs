// Classroom 3.0 round 3 (2026-11-21): a fixed room's link in a browser, end to end with synthetic
// data: the built application, disposable local storage and test-only sessions; the synthetic
// provider stands in for Zoom. The iHear teacher (an owner) makes a room and gets its link once; a
// student opens it, types a first name and waits; the teacher lets them in and the student enters
// the room's lesson; the same name again is just another person waiting; a replaced link lets
// nobody new in; a person taken out leaves. Proves our pages and checks, not Zoom.
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, expect as playwrightExpect } from '@playwright/test';
import { localContext, startAcademyServer } from './helpers/academy-smoke.mjs';

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
// Refusals the checks provoke on purpose (a replaced link, a revoked key) are not page problems.
const expectedRefusal = text => /Failed to load resource: the server responded with a status of (403|409|410)/.test(text);
function watch(page, who) {
  page.on('console', message => { if (message.type() === 'error' && !expectedRefusal(message.text())) report.pageProblems.push(`${who}: ${message.text()}`); });
  page.on('pageerror', error => report.pageProblems.push(`${who}: ${error.message}`));
  page.on('dialog', dialog => dialog.accept());
  return page;
}
const shot = (page, name) => page.screenshot({ path: path.join(directory, `${name}.png`), fullPage: true });

try {
  browser = await chromium.launch({ headless: process.env.IHEAR_HEADED !== '1' });
  const admin = watch(await (await context({ email: owner })).newPage(), 'owner');
  const roomCard = () => admin.locator('[data-room="Room 1"]');
  let link, oldLink;

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
    const fresh = watch(await (await context({})).newPage(), 'student-new-link');
    await fresh.goto(link);
    await fresh.getByLabel(/Please enter your first name/).fill('Ann');
    await fresh.getByRole('button', { name: '進入教室' }).click();
    await expect(fresh.locator('[data-room-waiting]')).toBeVisible();
  });

  await check('R6', '請出教室：老師按請出，學生的頁面離開教室並說明；他的連結進不來', async () => {
    await roomCard().locator('[data-in-room-person="Kyle"]').getByRole('button', { name: '請出教室' }).click();
    await expect(roomCard().locator('[data-in-room-person="Kyle"]')).toHaveCount(0);
    await expect(kyle.getByText('這個個人連結已失效（已撤銷或已更換），所以已離開教室。請向 iHear 索取新的連結。')).toBeVisible({ timeout: 45_000 });
    await shot(kyle, 'r6-taken-out');
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
  await writeFile(path.join(directory, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  await browser?.close();
  server.child.kill();
  console.log(`Report and screenshots: ${directory}`);
}
if (failure) throw failure;
