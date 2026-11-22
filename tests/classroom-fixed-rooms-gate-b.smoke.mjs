// Gate B round 10 (2026-11-22): a fixed room's list of students in a browser, end to end with
// synthetic data. Fixed-room recording is switched on for this local server only (on the site it stays
// off: Gate B is not approved); nothing records here, and the synthetic provider stands in for Zoom.
// The iHear teacher puts a student on a room's list and gets the student's own link once; the student
// opens it, types nothing and waits; the teacher lets them in as that student. Someone asking with the
// room's link is said by the teacher to be a student on the list. People without a consent are shown
// as such. A reissued link asks nobody in. The page's words in three languages. Proves our pages and
// checks, not Zoom, and decides nothing of the Gate B policy.
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, expect as playwrightExpect } from '@playwright/test';
import { redactLinks, withoutLinkKeys, screenshotSafely, localContext, startAcademyServer } from './helpers/academy-smoke.mjs';

const expect = playwrightExpect.configure({ timeout: 15_000 });
const secret = 'classroom-rooms-gate-b-local-acceptance-only';
const owner = 'rooms-gate-b-owner@example.test';
Object.assign(process.env, {
  CLASSROOM_PROVIDER: 'synthetic', CLASSROOM_DRIVE: 'local', CLASSROOM_WEBHOOK_SECRET: 'classroom-rooms-gate-b-webhook-local-only',
  CLASSROOM_SYNTHETIC_SECRET: 'classroom-rooms-gate-b-token-local-only', VERCEL_ENV: '', CLASSROOM_MULTI_RECORDING: '', CLASSROOM_FIXED_ROOMS: 'on', CLASSROOM_FIXED_ROOM_RECORDING: 'on',
});
const server = await startAcademyServer({ port: 3277, secret, owners: [owner], name: 'classroom-rooms-gate-b' });
const { origin, directory } = server;
const report = { startedAt: new Date().toISOString(), origin, synthetic: true, zoomVerified: false, gateBPolicyDecided: false, checks: [], externalRequests: [], pageProblems: [], status: 'running' };
let browser, failure;

async function check(id, name, action) {
  try { await action(); report.checks.push({ id, name, status: 'PASS' }); console.log(`PASS ${id} ${name}`); }
  catch (error) { report.checks.push({ id, name, status: 'FAIL', error: error.message }); throw error; }
}
const context = options => localContext(browser, origin, { external: report.externalRequests, secret, locale: 'zh-TW', ...options });
// Refusals the checks provoke on purpose (a reissued pass is the same as no room) are not page problems.
const expectedRefusal = text => /Failed to load resource: the server responded with a status of (403|404|409|410)/.test(text);
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
  const roomCard = () => admin.locator('[data-room="Room G"]');
  const roster = () => roomCard().locator('[data-room-roster]');
  let link, annPass, oldAnnPass, student;

  async function addMember(code, name) {
    await roster().getByLabel('學生代碼').fill(code);
    await roster().getByLabel('英文名字').fill(name);
    await roster().getByRole('button', { name: '加入名單並產生個人連結' }).click();
    const shown = admin.locator('[data-room-link] code');
    await expect(admin.locator('[data-pass-link]')).toContainText(`代碼 ${code}`);
    const pass = (await shown.innerText()).trim();
    expect(new URL(pass).hash).toMatch(/^#p=[A-Za-z0-9_-]{43}$/);
    await admin.getByRole('button', { name: '我已經記下連結' }).click();
    return pass;
  }

  await check('G1', '老師建立教室並把學生加入名單：每位學生的個人連結只顯示這一次；名單上有代碼和名字', async () => {
    await admin.goto(`${origin}/admin/classrooms/rooms`);
    await admin.getByLabel('教室名稱（例如 Room 1）').fill('Room G');
    await admin.getByRole('button', { name: '建立教室' }).click();
    const shown = admin.locator('[data-room-link] code');
    await expect(shown).toContainText('/classroom/r/FR-');
    link = (await shown.innerText()).trim();
    await admin.getByRole('button', { name: '我已經記下連結' }).click();
    await roster().locator('summary').click();
    annPass = await addMember('ST-G1', 'Ann');
    await addMember('ST-G2', 'Bo');
    await expect(roster().locator('[data-roster-member]')).toHaveCount(2);
    await expect(roster().locator('[data-roster-member="ST-G1"]')).toContainText('Ann（代碼 ST-G1）');
    await roster().getByLabel('學生代碼').fill('ST-G1');
    await roster().getByLabel('英文名字').fill('Ann');
    await roster().getByRole('button', { name: '加入名單並產生個人連結' }).click();
    await expect(admin.getByText('這位學生已經在這間教室的名單上。')).toBeVisible();
    await shot(admin, 'g1-roster');
  });

  await check('G2', '學生用自己的個人連結：不用輸入名字，按下按鈕後等待；老師看到「個人連結：代碼 ST-G1」，讓他進入後他進到教室，教室裡顯示他的代碼和「沒有錄影同意」', async () => {
    student = watch(await (await context({})).newPage(), 'student-pass');
    await student.goto(annPass);
    await expect(student.getByRole('textbox')).toHaveCount(0);
    await expect(student.getByText('這是你自己的上課連結，請不要給別人。按下按鈕後，老師會讓你進入。')).toBeVisible();
    expect(new URL(student.url()).hash).toBe('');
    await student.getByRole('button', { name: '請老師讓我進入' }).click();
    await expect(student.locator('[data-room-waiting]')).toBeVisible();
    const waiting = roomCard().locator('[data-waiting-person="Ann"]');
    await expect(waiting).toContainText('個人連結：代碼 ST-G1');
    await waiting.getByRole('button', { name: '讓他進入', exact: true }).click();
    await expect(student).toHaveURL(/\/classroom\/L-[0-9a-f]+$/, { timeout: 30_000 });
    // The pre-class screen first, as for anyone let in (tests/classroom-fixed-rooms.smoke.mjs R3).
    await student.getByRole('button', { name: '進入教室' }).click();
    await expect(student.locator('.room2-top .classroom-room-connection')).toHaveText('已連線', { timeout: 30_000 });
    // In the room (and so in Zoom) the student shows by a name of this lesson only, never their code.
    await expect(student.locator('body')).not.toContainText('ST-G1');
    // Let in, the tab no longer keeps the student's own pass.
    const passValue = new URL(annPass).hash.slice(3);
    expect(await student.evaluate(() => Object.values(sessionStorage).join('\n'))).not.toContain(passValue);
    const inRoom = roomCard().locator('[data-in-room-person="Ann"]');
    await expect(inRoom).toContainText('代碼 ST-G1・個人連結');
    await expect(inRoom.locator('[data-consent]')).toHaveAttribute('data-consent', 'CONSENT_MISSING');
    await expect(roomCard().locator('[data-room-consent-missing]')).toContainText('這次上課有人沒有有效的錄影同意：教室裡 1 位。');
    await shot(admin, 'g2-admitted-by-pass');
  });

  await check('G3', '用教室連結申請的人：老師指定他是名單上的 Bo（ST-G2），確認後讓他進入；教室裡顯示「您指定的名單學生」', async () => {
    const bo = watch(await (await context({})).newPage(), 'student-room-link');
    await bo.goto(link);
    await bo.getByLabel(/Please enter your first name/).fill('Bo');
    await bo.getByRole('button', { name: '進入教室' }).click();
    await expect(bo.locator('[data-room-waiting]')).toBeVisible();
    const waiting = roomCard().locator('[data-waiting-person="Bo"]');
    await waiting.locator('[data-bind-to] select').selectOption('ST-G2');
    await waiting.getByRole('button', { name: '讓他進入', exact: true }).click();
    const inRoom = roomCard().locator('[data-in-room-person="Bo"]');
    await expect(inRoom).toContainText('代碼 ST-G2・您指定的名單學生');
    await expect(bo).toHaveURL(/\/classroom\/L-[0-9a-f]+$/, { timeout: 30_000 });
  });

  await check('G4', '重發個人連結：舊的個人連結申請時看到「找不到這間教室」；新的連結可以用', async () => {
    oldAnnPass = annPass;
    await roster().locator('[data-roster-member="ST-G1"]').getByRole('button', { name: '重發個人連結' }).click();
    const shown = admin.locator('[data-room-link] code');
    await expect(admin.locator('[data-pass-link]')).toContainText('代碼 ST-G1');
    annPass = (await shown.innerText()).trim();
    expect(annPass).not.toBe(oldAnnPass);
    await admin.getByRole('button', { name: '我已經記下連結' }).click();
    const stale = watch(await (await context({})).newPage(), 'student-old-pass');
    await stale.goto(oldAnnPass);
    await stale.getByRole('button', { name: '請老師讓我進入' }).click();
    await expect(stale.locator('[data-room-problem]')).toHaveText('找不到這間教室。請確認你用的是老師給你的完整連結。');
  });

  await check('G5', '個人連結頁面的三種語言', async () => {
    for (const [locale, note, button] of [
      ['en-US', 'This is your own link for class; please do not share it. Press the button and your teacher will let you in.', 'Ask to come in'],
      ['zh-CN', '这是你自己的上课链接，请不要给别人。按下按钮后，老师会让你进入。', '请老师让我进入'],
      ['zh-TW', '這是你自己的上課連結，請不要給別人。按下按鈕後，老師會讓你進入。', '請老師讓我進入'],
    ]) {
      const page = watch(await (await context({ locale })).newPage(), `student-${locale}`);
      await page.goto(annPass);
      await expect(page.getByText(note)).toBeVisible();
      await expect(page.getByRole('button', { name: button })).toBeVisible();
      await page.close();
    }
  });

  await check('G6', '沒有對外請求，頁面沒有非預期的錯誤', async () => {
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
