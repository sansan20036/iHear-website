// P3-Multi (2026-11-09, 18.8) in a browser, end to end with synthetic data: the built application
// behind the checked-in hosting headers, disposable local storage and test-only sessions. Every
// person has their own isolated browser context (the manager, a second owner, two tutors, three
// students); the synthetic provider stands in for Zoom (this script plays Zoom's signed webhooks).
// Passing proves our pages, routing and checks, not real Zoom audio and video, which is accepted
// separately with real test sessions. No production credentials, data or requests are used.
import { createHmac } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';
import { localContext, setSession, startAcademyServer } from './helpers/academy-smoke.mjs';

const secret = 'classroom-multi-local-acceptance-only';
const webhookSecret = 'classroom-multi-webhook-local-only';
const owner = 'multi-manager@example.test', owner2 = 'multi-owner2@example.test';
const tutor1 = 'multi-tutor1@example.test', tutor2 = 'multi-tutor2@example.test';
Object.assign(process.env, {
  CLASSROOM_PROVIDER: 'synthetic', CLASSROOM_DRIVE: 'local', CLASSROOM_WEBHOOK_SECRET: webhookSecret,
  CLASSROOM_SYNTHETIC_SECRET: 'classroom-multi-token-local-only', VERCEL_ENV: '', CLASSROOM_MULTI_RECORDING: '',
});
const server = await startAcademyServer({ port: 3251, secret, owners: [owner, owner2], name: 'classroom-multi' });
const { origin, directory } = server;
const report = { startedAt: new Date().toISOString(), timeZone: 'Asia/Taipei', origin, synthetic: true, zoomVerified: false, checks: [], externalRequests: [], status: 'running' };
const consoleProblems = [];
const limited = [];
let browser, failure;

async function check(id, name, action) {
  const started = Date.now();
  try { await action(); report.checks.push({ id, name, status: 'PASS', ms: Date.now() - started }); console.log(`PASS ${id} ${name}`); }
  catch (error) { report.checks.push({ id, name, status: 'FAIL', error: error.message }); throw error; }
}
const shot = (page, name) => page.screenshot({ path: path.join(directory, `${name}.png`), fullPage: true });
// Refusals the checks provoke on purpose, and the requests made while E9 has the network off.
const expectedRefusal = text => /Failed to load resource: (the server responded with a status of (401|403|409)|net::ERR_INTERNET_DISCONNECTED)/.test(text);
const claimsOf = token => JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
const keyOf = link => new URLSearchParams(new URL(link).hash.slice(1)).get('k');
const context = options => localContext(browser, origin, { external: report.externalRequests, secret, locale: 'zh-TW', ...options });
// Every page: its join answers (by lesson), refusals counted as expected, 429s and errors kept.
function watch(page, joins = new Map()) {
  page.on('response', async item => {
    if (item.status() === 429) limited.push(new URL(item.url()).pathname);
    const match = new URL(item.url()).pathname.match(/^\/api\/classroom\/([^/]+)\/join$/);
    if (match && item.request().method() === 'POST' && item.status() === 200) {
      const body = await item.json().catch(() => null);
      if (body?.session?.token) joins.set(match[1], claimsOf(body.session.token));
    }
  });
  page.on('console', message => { if (message.type() === 'error' && !expectedRefusal(message.text())) consoleProblems.push(message.text()); });
  page.on('pageerror', error => consoleProblems.push(error.message));
  page.on('dialog', dialog => dialog.accept());
  page.joins = joins;
  return page;
}
// Zoom's side: a user in a session, signed with the test-only secret.
async function zoom(type, lessonId, sessionId, userKey) {
  const body = JSON.stringify({
    event: type, event_ts: Date.now(),
    payload: { account_id: 'synthetic-account', object: { id: sessionId, session_id: sessionId, session_key: lessonId, ...(userKey ? { user: { id: '16778240', name: 'Synthetic Display Name', user_key: userKey, participant_uuid: `${userKey}-uuid`, join_time: new Date().toISOString() } } : {}) } },
  });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = `v0=${createHmac('sha256', webhookSecret).update(`v0:${timestamp}:${body}`).digest('hex')}`;
  const response = await fetch(`${origin}/api/recordings/zoom/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-zm-request-timestamp': timestamp, 'x-zm-signature': signature }, body });
  if (response.status !== 200) throw new Error(`webhook ${type}: ${response.status}`);
}
const target = page => page.locator('main.block-entry');
async function enterOnce(page) {
  await page.getByRole('button', { name: '進入教室' }).click();
  await expect(page.locator('[data-room-label]')).toBeVisible();
}

try {
  browser = await chromium.launch({ headless: process.env.IHEAR_HEADED !== '1', slowMo: Number(process.env.IHEAR_E2E_SLOWMO || 0) });
  const start = new Date(Date.now() + 8 * 3600_000 + 5 * 60_000);
  const code = 'TEST-MULTI1';
  const managerContext = await context({ email: owner });
  const admin = watch(await managerContext.newPage());
  let blockId, links = {};

  await check('E1', '管理老師登入並建立班次；學生連結只顯示一次', async () => {
    await admin.goto(`${origin}/admin/classrooms/blocks`);
    await admin.getByLabel('班次代碼').fill(code);
    await admin.getByLabel('日期').fill(start.toISOString().slice(0, 10));
    await admin.getByLabel('開始時間（台北）').fill(start.toISOString().slice(11, 16));
    await admin.getByLabel('分鐘').fill('60');
    await admin.getByLabel('教學房間').fill('R1,R2');
    await admin.getByLabel('人員').fill([
      `manager,${code}-M,Mia Manager,${owner}`, `lead_tutor,${code}-T1,Carol Chen,${tutor1}`, `lead_tutor,${code}-T2,Dan Wu,${tutor2}`,
      `student,${code}-S1,Alice Wang`, `student,${code}-S2,Bob Lee`, `student,${code}-S3,Cara Lin`,
    ].join('\n'));
    await admin.getByLabel('分房').fill([`${code}-T1,R1`, `${code}-T2,R2`, `${code}-S1,R1`].join('\n'));
    await admin.getByRole('button', { name: '建立班次' }).click();
    const created = admin.locator('[data-created]');
    await expect(created).toBeVisible();
    blockId = await created.getAttribute('data-created');
    for (const n of [1, 2, 3]) links[n] = (await admin.locator(`[data-student-link="${code}-S${n}"] code`).innerText()).trim();
    await shot(admin, 'm01-created');
    await admin.reload();
    await expect(admin.locator('[data-student-link]')).toHaveCount(0);
  });

  const manage = watch(await managerContext.newPage());
  const lobbyPage = watch(await managerContext.newPage());
  const tutorPages = {}, studentPages = {}, studentContexts = {};
  let view;
  const refreshView = async () => { view = await manage.evaluate(async id => (await (await fetch(`/api/classroom/blocks/${id}/manage`)).json()).view, blockId); return view; };
  const roomId = label => (label === 'LOBBY' ? view.lobby.lessonId : view.rooms.find(room => room.label === label).lessonId);

  await check('E2', '管理老師先進主會議室：開放前學生只能等待，管理老師未進入時不能開放', async () => {
    for (const n of [1, 2, 3]) {
      studentContexts[n] = await context({});
      studentPages[n] = watch(await studentContexts[n].newPage());
      await studentPages[n].goto(links[n]);
      await expect(studentPages[n].getByText('管理老師開放主會議室後就能進入')).toBeVisible();
      expect(new URL(studentPages[n].url()).hash).not.toContain('k=');
    }
    await manage.goto(`${origin}/classroom/b/${blockId}/manage`);
    await manage.getByRole('button', { name: '開放主會議室' }).click();
    await expect(manage.locator('.block-manage-alert[role="alert"]')).toContainText('管理老師要先進入主會議室');
    await lobbyPage.goto(`${origin}/classroom/b/${blockId}`);
    await enterOnce(lobbyPage);
    await refreshView();
    expect(lobbyPage.joins.get(roomId('LOBBY'))).toMatchObject({ role_type: 1, session_key: roomId('LOBBY') });
    await manage.getByRole('button', { name: '開放主會議室' }).click();
    await expect(manage.locator('[data-phase-label]')).toContainText('主會議室已開放');
    await shot(manage, 'm02-lobby-open');
  });

  await check('E3', '小老師與學生進入主會議室；管理老師確認到場名單', async () => {
    for (const [n, email] of [[1, tutor1], [2, tutor2]]) {
      const ctx = await context({ email });
      tutorPages[n] = watch(await ctx.newPage());
      await tutorPages[n].goto(`${origin}/classroom/b/${blockId}`);
      await enterOnce(tutorPages[n]);
      expect(tutorPages[n].joins.get(roomId('LOBBY')).role_type).toBe(0);
    }
    for (const n of [1, 2, 3]) {
      await expect(studentPages[n].getByRole('button', { name: '進入教室' })).toBeVisible();
      await enterOnce(studentPages[n]);
    }
    // Zoom says who is in the Lobby; the manager sees them there.
    await zoom('session.started', roomId('LOBBY'), 'SYN-LOBBY');
    for (const page of [lobbyPage, tutorPages[1], tutorPages[2], studentPages[1], studentPages[2], studentPages[3]]) {
      await zoom('session.user_joined', roomId('LOBBY'), 'SYN-LOBBY', page.joins.get(roomId('LOBBY')).user_key);
    }
    for (const member of ['T1', 'T2', 'S1', 'S2', 'S3']) await expect(manage.locator(`[data-member="${code}-${member}"]`)).toHaveAttribute('data-state', 'WAITING');
    await shot(manage, 'm03-present');
  });

  await check('E4', '建立兩間教學房間並分配小老師與學生（多對一、一對一）', async () => {
    await manage.getByLabel(`${code}-S2 的教室`).selectOption('R2');
    await expect(manage.locator('[data-room="R2"] [data-occupied]')).toHaveAttribute('data-occupied', '2');
    await manage.getByLabel(`${code}-S3 的教室`).selectOption('R1');
    await expect(manage.locator('[data-room="R1"] [data-occupied]')).toHaveAttribute('data-occupied', '3');
  });

  await check('E5', '開始分房：每個人被系統切換到正確的教學房間（不用輸入會議號碼或自己選房）', async () => {
    await manage.getByRole('button', { name: '確認並開始分房' }).click();
    await expect(manage.locator('[data-phase-label]')).toContainText('分房中');
    await refreshView();
    const where = { 1: 'R1', 2: 'R2', 3: 'R1' };
    for (const n of [1, 2, 3]) {
      await expect(target(studentPages[n])).toHaveAttribute('data-target', where[n]);
      await expect(studentPages[n].locator(`[data-room-label="${where[n]}"]`)).toBeVisible();
      await expect.poll(() => studentPages[n].joins.get(roomId(where[n]))?.tpc).toBe(`ihear-${roomId(where[n]).toLowerCase()}`);
      expect(studentPages[n].joins.get(roomId(where[n])).role_type).toBe(0);
    }
    for (const [n, label] of [[1, 'R1'], [2, 'R2']]) {
      await expect(target(tutorPages[n])).toHaveAttribute('data-target', label);
      await expect.poll(() => tutorPages[n].joins.get(roomId(label))?.role_type).toBe(1);
    }
    await expect(target(lobbyPage)).toHaveAttribute('data-target', 'lobby');
    await shot(studentPages[1], 'm05-student-in-r1');
    await shot(manage, 'm05-breakout');
  });

  await check('E6', '未授權者不能加入其他房間：改網址或直接呼叫 API 都被伺服器拒絕', async () => {
    const tried = await studentPages[1].evaluate(async ({ lesson, key }) => {
      const response = await fetch(`/api/classroom/${lesson}/join`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key }) });
      return [response.status, (await response.json()).code];
    }, { lesson: roomId('R2'), key: keyOf(links[1]) });
    expect(tried).toEqual([403, 'NOT_ASSIGNED_HERE']);
    const tutorTried = await tutorPages[2].evaluate(async lesson => (await fetch(`/api/classroom/${lesson}/join`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, roomId('R1'));
    expect(tutorTried).toBe(403);
    // The same link opened on another room's address: refused at the door.
    const stray = watch(await studentContexts[1].newPage());
    await stray.goto(`${origin}/classroom/${roomId('R2')}#k=${keyOf(links[1])}`);
    await stray.getByRole('button', { name: '進入教室' }).click();
    await expect(stray.locator('.classroom-room-problem[role="alert"]')).toBeVisible();
    expect(stray.joins.has(roomId('R2'))).toBe(false);
    await stray.close();
  });

  await check('E7', '管理老師巡視 R2（觀察者身分，計入人數），調整分房：S1 從 R1 換到 R2', async () => {
    await manage.locator('[data-room="R2"]').getByRole('button', { name: '巡視此房' }).click();
    await expect(target(lobbyPage)).toHaveAttribute('data-target', 'R2');
    await expect.poll(() => lobbyPage.joins.get(roomId('R2'))?.role_type).toBe(0);
    await expect(manage.locator('[data-room="R2"] [data-occupied]')).toHaveAttribute('data-occupied', '3');
    await manage.getByRole('button', { name: '結束巡視' }).click();
    await expect(target(lobbyPage)).toHaveAttribute('data-target', 'lobby');
    // S1 has the camera on in R1; after the move it starts off in R2 and the page offers, never
    // does by itself, to turn it on again (B3).
    const cameraOf = page => page.getByRole('button', { name: /^攝影機：/ });
    await cameraOf(studentPages[1]).click();
    await expect(cameraOf(studentPages[1])).toHaveText('攝影機：開');
    await manage.getByLabel(`${code}-S1 的教室`).selectOption('R2');
    await expect(target(studentPages[1])).toHaveAttribute('data-target', 'R2');
    await expect.poll(() => studentPages[1].joins.get(roomId('R2'))?.tpc).toBe(`ihear-${roomId('R2').toLowerCase()}`);
    await expect(studentPages[1].locator('[data-restore-devices]')).toBeVisible();
    await expect(cameraOf(studentPages[1])).toHaveText('攝影機：關');
    await shot(studentPages[1], 'm07-moved-to-r2');
    await studentPages[1].locator('[data-restore-devices]').getByRole('button', { name: '重新開啟' }).click();
    await expect(cameraOf(studentPages[1])).toHaveText('攝影機：開');
    await expect(studentPages[1].locator('[data-restore-devices]')).toHaveCount(0);
  });

  await check('E8', '學生按權限回到主會議室，再回到自己的教室', async () => {
    await studentPages[2].getByRole('button', { name: '回到主會議室' }).click();
    await expect(target(studentPages[2])).toHaveAttribute('data-target', 'lobby');
    await studentPages[2].getByRole('button', { name: '回到我的教室' }).click();
    await expect(target(studentPages[2])).toHaveAttribute('data-target', 'R2');
  });

  await check('E9', '斷線後安全重新加入：離線再上線仍在原房間；同一連結開第二個分頁時只有一個分頁在教室（可選擇接手），關閉後原分頁自動接回', async () => {
    await studentContexts[2].setOffline(true);
    await studentPages[2].waitForTimeout(6000);
    await studentContexts[2].setOffline(false);
    await expect(target(studentPages[2])).toHaveAttribute('data-target', 'R2');
    const again = watch(await studentContexts[2].newPage());
    await again.goto(links[2]);
    // The second tab waits (it does not ask the server or enter Zoom) until the person chooses it.
    await expect(again.locator('[data-other-tab]')).toBeVisible();
    await shot(again, 'm09-second-tab-waits');
    await again.getByRole('button', { name: '在這個分頁繼續' }).click();
    await expect(target(again)).toHaveAttribute('data-target', 'R2');
    await expect(studentPages[2].locator('[data-other-tab]')).toBeVisible();
    await enterOnce(again);
    await expect(again.locator('[data-room-label="R2"]')).toBeVisible();
    await again.close();
    // The first tab takes over again by itself and goes back into its room.
    await expect(target(studentPages[2])).toHaveAttribute('data-target', 'R2');
    await expect(studentPages[2].locator('[data-room-label="R2"]')).toBeVisible();
  });

  await check('E10', '撤銷連結後不能再取得有效授權', async () => {
    await manage.locator(`[data-member="${code}-S3"]`).getByRole('button', { name: '撤銷連結' }).click();
    await expect(manage.locator(`[data-member="${code}-S3"]`)).toHaveAttribute('data-state', 'REVOKED');
    await expect(studentPages[3].locator('[data-block-refused="NOT_ON_ROSTER"]')).toBeVisible();
    const reopened = watch(await studentContexts[3].newPage());
    await reopened.goto(links[3]);
    await expect(reopened.locator('[data-block-refused="NOT_ON_ROSTER"]')).toBeVisible();
    const token = await reopened.evaluate(async ({ lesson, key }) => (await fetch(`/api/classroom/${lesson}/join`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key }) })).status, { lesson: roomId('R1'), key: keyOf(links[3]) });
    expect(token).toBe(403);
    await reopened.close();
  });

  await check('E11', '管理老師登入逾時與兩位管理員同時操作：逾時不能操作、重新登入後恢復；同版本的衝突只接受一個', async () => {
    // A sign-in that lasts one second (Auth.js allows 15 seconds of clock difference on top, and
    // renews the sign-in whenever a page uses it, so nothing uses it while it runs out).
    const shortContext = await context({ email: owner, maxAge: 1 });
    await admin.waitForTimeout(17000);
    const expired = await shortContext.request.post(`${origin}/api/classroom/blocks/${blockId}/manage`, { data: { action: "recall", version: 0 } });
    expect(expired.status()).toBe(401);
    // Rooms carry on meanwhile: a student still reads where to be.
    await expect(target(studentPages[1])).toHaveAttribute("data-target", "R2");
    await setSession(shortContext, origin, secret, owner);
    expect((await shortContext.request.get(`${origin}/api/classroom/blocks/${blockId}/manage`)).status()).toBe(200);
    await shortContext.close();
    const otherOwner = watch(await (await context({ email: owner2 })).newPage());
    await otherOwner.goto(`${origin}/classroom/b/${blockId}/manage`);
    const version = (await refreshView()).block.version;
    const move = (page, room) => page.evaluate(async ({ id, version: seen, room: to }) => (await fetch(`/api/classroom/blocks/${id}/manage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'assign', member: 'TEST-MULTI1-S2', room: to, version: seen }) })).status, { id: blockId, version, room });
    const answers = await Promise.all([move(manage, 'R1'), move(otherOwner, 'R2')]);
    expect(answers.sort()).toEqual([200, 409]);
  });

  await check('E12', '召回主會議室：所有人回到正確狀態', async () => {
    // E11 changed the block from other pages: this page shows the version it knows; a change made
    // on an older one is refused as stale, so the page is looked at again first.
    await manage.reload();
    await manage.getByRole('button', { name: '召回主會議室' }).click();
    await expect(manage.locator('[data-phase-label]')).toContainText('已召回主會議室');
    for (const page of [studentPages[1], studentPages[2], tutorPages[1], tutorPages[2], lobbyPage]) await expect(target(page)).toHaveAttribute('data-target', 'lobby');
    await shot(manage, 'm12-recalled');
  });

  await check('E13', '結束班次後停止簽發新入場權杖', async () => {
    await manage.getByRole('button', { name: '結束全部教學房間' }).click();
    await expect(manage.locator('[data-phase-label]')).toContainText('已結束');
    for (const page of [studentPages[1], studentPages[2], tutorPages[1]]) await expect(page.locator('[data-block-refused="BLOCK_ENDED"]')).toBeVisible();
    await refreshView();
    for (const label of ['LOBBY', 'R1', 'R2']) {
      const status = await studentPages[1].evaluate(async ({ lesson, key }) => (await fetch(`/api/classroom/${lesson}/join`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key }) })).status, { lesson: roomId(label), key: keyOf(links[1]) });
      expect(status).toBe(403);
    }
    await shot(manage, 'm13-ended');
  });

  await check('E15', '課程與課表匯入：建立計畫與課程、預覽（不改資料）、確認時區後建立班次；同一份課表再匯入不會重複', async () => {
    await admin.goto(`${origin}/admin/classrooms/schedule`);
    await admin.getByLabel('計畫代碼').fill('TEST-MP');
    await admin.getByLabel('計畫名稱').fill('Synthetic Program');
    await admin.getByRole('button', { name: '新增教學計畫' }).click();
    await expect(admin.locator('form[aria-label="新增課程"] select').first().locator('option', { hasText: 'TEST-MP' })).toHaveCount(1);
    await admin.locator('form[aria-label="新增課程"] select').first().selectOption({ label: 'TEST-MP' });
    await admin.getByLabel('課程代碼').fill('TEST-MC');
    await admin.getByLabel('課程名稱').fill('Synthetic Course');
    await admin.getByRole('button', { name: '新增課程' }).click();
    await expect(admin.locator('[data-course="TEST-MC"]')).toBeVisible();
    const day = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
    await admin.locator('label:has-text("課程") select').last().selectOption({ label: 'TEST-MC（America/New_York）' });
    await admin.getByLabel('管理老師（名冊代碼）').fill('TEST-IM');
    await admin.locator('label:has-text("課表 CSV") textarea').fill(`Tutee,Date,Start,End,Lead Tutor,Co-Tutor,Observer,Pre-assign Room Name,Email Address\nAmy,${day},4:00 PM,5:00 PM,Carol,,,R1,\n`);
    await admin.locator('label:has-text("人員名冊 CSV") textarea').fill(`Code,Role,English Name,Sign-in Email,Schedule Names\nTEST-IM,manager,Mia Manager,import-m@example.test,\nTEST-IT,tutor,Carol Chen,import-t@example.test,Carol\nTEST-IS,student,Amy Wang,,Amy\n`);
    await admin.getByRole('button', { name: '預覽' }).click();
    await expect(admin.locator('[data-plan-block]')).toHaveAttribute('data-status', 'new');
    const confirm = admin.getByRole('button', { name: /確認並建立 1 個班次/ });
    await expect(confirm).toBeDisabled();
    await admin.getByLabel(/我確認課表上的時間是 America\/New_York 的時間/).check();
    await shot(admin, 'm15-import-preview');
    await confirm.click();
    await expect(admin.locator('[data-applied="1"]')).toBeVisible();
    await expect(admin.locator('[data-student-link="TEST-IS"]')).toBeVisible();
    await admin.getByRole('button', { name: '預覽' }).click();
    await expect(admin.locator('[data-plan-block]')).toHaveAttribute('data-status', 'unchanged');
  });

  await check('E14', '沒有對外請求、沒有被限流、沒有非預期的瀏覽器錯誤；Classroom Only 不顯示錄影中', async () => {
    expect(report.externalRequests).toEqual([]);
    expect(limited).toEqual([]);
    expect(consoleProblems).toEqual([]);
    expect(view.block.recordingMode).toBe('classroom_only');
    expect(view.rooms.every(room => !['RECORDING', 'START_REQUESTED'].includes(room.recording.status))).toBe(true);
  });
  report.status = 'passed';
} catch (error) {
  failure = error;
  report.status = 'failed';
  console.error(server.logs().slice(-4000));
} finally {
  report.finishedAt = new Date().toISOString();
  await writeFile(path.join(directory, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  await browser?.close();
  server.child.kill();
  console.log(`Classroom multi evidence (synthetic): ${directory}`);
}
if (failure) throw failure;
