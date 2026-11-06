// The classroom MVP in a browser, end to end with synthetic data: the built application behind
// the checked-in hosting headers, disposable local storage and test-only sessions. The
// synthetic provider stands in for Zoom (this script plays Zoom's signed webhooks) and a local
// folder for Google Drive. Passing proves our pages and logic, not real Zoom behaviour, which
// is accepted separately. No production credentials, data or requests are used.
import { createHmac } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';
import { localContext, noHorizontalOverflow, startAcademyServer } from './helpers/academy-smoke.mjs';

const secret = 'classroom-local-acceptance-only-not-production';
const webhookSecret = 'classroom-webhook-local-acceptance-only';
const owner = 'classroom-owner@example.test', editor = 'classroom-editor@example.test', tutor = 'classroom-tutor@example.test';
Object.assign(process.env, {
  CLASSROOM_PROVIDER: 'synthetic', CLASSROOM_DRIVE: 'local', CLASSROOM_WEBHOOK_SECRET: webhookSecret,
  CLASSROOM_SYNTHETIC_SECRET: 'classroom-token-local-acceptance-only', VERCEL_ENV: '',
});
const server = await startAcademyServer({ port: 3242, secret, owners: [owner], name: 'classroom' });
const { origin, directory } = server;
const report = { startedAt: new Date().toISOString(), origin, synthetic: true, zoomVerified: false, checks: [], externalRequests: [], status: 'running' };
const consoleProblems = [];
let browser, failure;

async function check(name, action) {
  try { await action(); report.checks.push({ name, status: 'passed' }); console.log(`PASS ${name}`); }
  catch (error) { report.checks.push({ name, status: 'failed', error: error.message }); throw error; }
}
const shot = (page, name) => page.screenshot({ path: path.join(directory, `${name}.png`), fullPage: true });
const context = options => localContext(browser, origin, { external: report.externalRequests, secret, ...options });
const expectedRefusal = text => /Failed to load resource: the server responded with a status of (401|403)/.test(text);
function watch(page) {
  page.on('console', message => { if (message.type() === 'error' && !expectedRefusal(message.text())) consoleProblems.push(message.text()); });
  page.on('pageerror', error => consoleProblems.push(error.message));
  return page;
}
const claimsOf = token => JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
// A personal link carries its key behind #, so the browser never sends it to a server.
const keyOf = link => new URLSearchParams(new URL(link).hash.slice(1)).get('k');
// The server rewrites the synthetic provider's file in place, so a read can catch it half
// written; that read counts as "not yet" and the poll reads again.
const calls = async lessonId => {
  const text = await readFile(path.join(directory, 'synthetic-zoom.json'), 'utf8').catch(() => '{"calls":[]}');
  let state;
  try { state = JSON.parse(text); } catch { return null; }
  return state.calls.filter(call => call.lessonId === lessonId).map(call => call.type);
};

// Zoom's side, signed with the test-only secret, with personal data planted that must never show.
async function zoom(type, lesson, object = {}) {
  const body = JSON.stringify({
    event: type, event_ts: Date.now(),
    payload: { account_id: 'synthetic-account', object: { id: 'SYN-SESSION-B', session_id: 'SYN-SESSION-B', session_key: lesson.id, ...object } },
  });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = `v0=${createHmac('sha256', webhookSecret).update(`v0:${timestamp}:${body}`).digest('hex')}`;
  const response = await fetch(`${origin}/api/recordings/zoom/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-zm-request-timestamp': timestamp, 'x-zm-signature': signature }, body });
  expect(response.status).toBe(200);
}
const zoomUser = (userKey, uuid) => ({ user: { id: '16778240', name: 'Synthetic Display Name', ip_address: '203.0.113.7', user_key: userKey, participant_uuid: uuid, join_time: new Date().toISOString() } });

async function enter(page) {
  const [response] = await Promise.all([
    page.waitForResponse(item => item.url().endsWith('/join') && item.request().method() === 'POST'),
    page.getByRole('button', { name: '進入教室' }).click(),
  ]);
  return { status: response.status(), body: await response.json() };
}

try {
  browser = await chromium.launch({ headless: process.env.IHEAR_HEADED !== '1', slowMo: Number(process.env.IHEAR_E2E_SLOWMO || 0) });
  const start = new Date(Date.now() + 8 * 3600_000 + 5 * 60_000);
  const lesson = { code: 'TEST-B1', date: start.toISOString().slice(0, 10), time: start.toISOString().slice(11, 16), tutorCode: 'TEST-BT1', studentCode: 'TEST-BS1' };
  const ownerContext = await context({ email: owner });
  const admin = watch(await ownerContext.newPage());
  const card = () => admin.locator('.classroom-card', { hasText: lesson.code });
  const refresh = async () => { await admin.reload(); await expect(admin.getByRole('heading', { name: '教室總覽', level: 1 })).toBeVisible(); };

  await check('owners see the classroom overview in synthetic mode; editors are kept out', async () => {
    await admin.goto(`${origin}/admin/classrooms`);
    await expect(admin.getByRole('heading', { name: '教室總覽', level: 1 })).toBeVisible();
    await expect(admin.getByRole('note')).toContainText('合成模式');
    await expect(admin.locator('.admin-sidebar nav button', { hasText: '線上教室' })).toHaveCount(1);
    await expect(admin.locator('.admin-sidebar nav button', { hasText: '總覽' })).toHaveCount(1);
    const added = await admin.evaluate(async email => (await fetch('/api/admin/accounts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email }) })).status, editor);
    expect(added).toBe(201);
    const editorContext = await context({ email: editor });
    const editorPage = watch(await editorContext.newPage());
    await editorPage.goto(`${origin}/admin/classrooms`);
    await expect(editorPage.getByText('需要擁有者權限。')).toBeVisible();
    await expect(editorPage.locator('.admin-sidebar')).not.toContainText('線上教室');
    const overview = await editorPage.evaluate(async () => (await fetch('/api/admin/classrooms')).status);
    expect(overview).toBe(403);
    await editorContext.close();
  });

  await check('an owner adds a one-to-one lesson; the personal link is shown once', async () => {
    await admin.getByLabel('課程代碼').fill(lesson.code);
    await admin.getByLabel('日期').fill(lesson.date);
    await admin.getByLabel('開始時間（台北）').fill(lesson.time);
    await admin.getByLabel('分鐘').fill('60');
    await admin.getByLabel('小老師代碼').fill(lesson.tutorCode);
    await admin.getByLabel('小老師登入 Email').fill(tutor);
    await admin.getByLabel('學生代碼').fill(lesson.studentCode);
    await admin.getByRole('button', { name: '新增一對一課程' }).click();
    const link = admin.locator('.classroom-link code');
    await expect(link).toBeVisible();
    lesson.link = await link.textContent();
    lesson.id = new URL(lesson.link).pathname.split('/').pop();
    lesson.key = keyOf(lesson.link);
    expect(lesson.link).toMatch(/\/classroom\/L-[0-9a-f]{32}#k=[A-Za-z0-9_-]{43}$/);
    expect(lesson.id).toMatch(/^L-[0-9a-f]{32}$/);
    await shot(admin, '01-lesson-added');
    await refresh();
    await expect(admin.locator('.classroom-link')).toHaveCount(0);
    expect(await admin.content()).not.toContain(lesson.key);
    await expect(admin.locator('section[aria-label="等待開始"] .classroom-card', { hasText: lesson.code })).toBeVisible();
  });

  await check('synthetic consent for the student and the tutor notice are entered on the overview', async () => {
    for (const [code, role] of [[lesson.studentCode, 'student'], [lesson.tutorCode, 'tutor']]) {
      await admin.getByPlaceholder('人員代碼').fill(code);
      await admin.getByLabel('角色').selectOption(role);
      const [response] = await Promise.all([
        admin.waitForResponse(item => item.url().endsWith('/api/admin/classrooms/consents')),
        admin.getByRole('button', { name: '儲存' }).click(),
      ]);
      expect(response.status()).toBe(200);
    }
  });

  const studentContext = await context({ locale: 'zh-TW', viewport: { width: 390, height: 844 } });
  const student = watch(await studentContext.newPage());
  const tutorContext = await context({ email: tutor, locale: 'zh-TW' });
  const countDeviceRequests = () => {
    window.__deviceRequests = 0;
    if (navigator.mediaDevices) navigator.mediaDevices.getUserMedia = async () => { window.__deviceRequests += 1; throw new Error('blocked in the test'); };
  };
  await studentContext.addInitScript(countDeviceRequests);
  await tutorContext.addInitScript(countDeviceRequests);
  const tutorPage = watch(await tutorContext.newPage());

  await check('without the personal link or the tutor sign-in nobody gets in', async () => {
    const anonymousContext = await context({ locale: 'zh-TW' });
    const anonymous = watch(await anonymousContext.newPage());
    await anonymous.goto(`${origin}/classroom/${lesson.id}`);
    const refused = await enter(anonymous);
    expect(refused).toMatchObject({ status: 403, body: { code: 'NOT_ON_ROSTER' } });
    await expect(anonymous.locator('.classroom-room-problem')).toContainText('學生請使用 iHear 提供的個人專屬連結');
    await expect(anonymous.getByRole('link', { name: '小老師登入' })).toBeVisible();
    expect(refused.body.session).toBeUndefined();
    await anonymousContext.close();
  });

  await check('the student enters with the personal link on a phone, without signing in', async () => {
    await student.goto(lesson.link);
    await expect(student.getByRole('note')).toContainText('測試教室');
    const joined = await enter(student);
    expect(joined).toMatchObject({ status: 200, body: { role: 'student', participantCode: lesson.studentCode } });
    lesson.studentKey = claimsOf(joined.body.session.token).user_key;
    await expect(student.locator('.classroom-room-facts')).toContainText(`學生 ${lesson.studentCode}`);
    await expect(student.getByText('錄影會自動開始和停止')).toHaveCount(0);
    // The student is told about recording too, and the stage says there is no real video.
    await expect(student.locator('.classroom-room-badge')).toHaveText('未錄影');
    await expect(student.locator('.classroom-room-notice')).toContainText('這堂課目前沒有錄影。');
    await expect(student.locator('.classroom-room-connection')).toHaveText('已連線');
    await expect(student.locator('.classroom-room-stage')).toContainText('測試教室沒有真實視訊。');
    expect(await noHorizontalOverflow(student)).toBe(true);
    await shot(student, '02-student-phone');
  });

  await check('the signed-in tutor enters and sees that this lesson may be recorded', async () => {
    await tutorPage.goto(`${origin}/classroom/${lesson.id}`);
    const joined = await enter(tutorPage);
    expect(joined).toMatchObject({ status: 200, body: { role: 'tutor', participantCode: lesson.tutorCode } });
    lesson.tutorKey = claimsOf(joined.body.session.token).user_key;
    lesson.tutorSession = joined.body.session;
    await expect(tutorPage.locator('.classroom-room-recording')).toContainText('未開始');
    await expect(tutorPage.getByText('這堂課可以錄影。')).toBeVisible();
  });

  await check('recording is requested only after the provider confirms the session and both people', async () => {
    expect(await calls(lesson.id)).toEqual([]);
    await zoom('session.started', lesson, { start_time: new Date().toISOString() });
    await zoom('session.user_joined', lesson, zoomUser(lesson.tutorKey, 'UUID-BT1'));
    await zoom('session.user_joined', lesson, zoomUser(lesson.studentKey, 'UUID-BS1'));
    await expect.poll(async () => { await refresh(); return calls(lesson.id); }, { timeout: 20000 }).toEqual(['recording.start']);
    await expect(card()).toContainText('已送出錄影啟動請求');
  });

  await check("only the provider's confirmation turns it into 錄影中, on the overview and both classroom pages", async () => {
    await zoom('session.recording_started', lesson, { recording_file: { recording_start: new Date().toISOString() } });
    await refresh();
    await expect(card()).toContainText('錄影中');
    await expect(card()).toContainText('（視訊服務確認）');
    // Before recording the tutor's page reports every 30 seconds; it learns of the start then.
    await expect(tutorPage.locator('.classroom-room-recording')).toContainText('錄影中', { timeout: 45000 });
    await expect(tutorPage.locator('.classroom-room-recording')).toContainText('已確認');
    await expect(tutorPage.locator('.classroom-room-badge')).toHaveText('錄影中');
    // The student's page reads the same state every 15 seconds.
    await expect(student.locator('.classroom-room-notice')).toContainText('這堂課正在錄影。', { timeout: 30000 });
    await expect(student.locator('.classroom-room-badge')).toHaveText('錄影中');
    await shot(admin, '03-overview-recording');
    await shot(tutorPage, '04-tutor-recording');
    await shot(student, '04-student-recording');
  });

  await check('a withdrawal in class stops recording at once and shows on both pages', async () => {
    await admin.getByPlaceholder('人員代碼').fill(lesson.studentCode);
    await admin.getByLabel('角色').selectOption('student');
    await admin.getByLabel('狀態').selectOption('withdrawn');
    await admin.getByRole('button', { name: '儲存' }).click();
    await expect.poll(async () => { await refresh(); return calls(lesson.id); }, { timeout: 20000 }).toEqual(['recording.start', 'recording.stop']);
    await expect(card()).toContainText('課中撤回錄影同意');
    await expect(tutorPage.getByText('這堂課不錄影。')).toBeVisible({ timeout: 20000 });
    // Until the provider confirms the stop the student is still told it may be recording; after
    // the confirmation, that it is not.
    await zoom('session.recording_stopped', lesson, { recording_file: { recording_end: new Date().toISOString() } });
    await expect(student.locator('.classroom-room-badge')).toHaveText('未錄影', { timeout: 30000 });
    await expect(student.locator('.classroom-room-notice')).toContainText('這堂課目前沒有錄影。');
  });

  await check('the problem is handled on the overview and recorded with who and what', async () => {
    const row = admin.locator('.admin-table tr', { hasText: '課中撤回錄影同意' });
    await expect(row).toContainText('待處置');
    await row.getByPlaceholder('處置說明').fill('TEST: 已和小老師確認錄影停止');
    await row.getByRole('button', { name: '記錄處置' }).click();
    await expect(row).toContainText(`已處置：TEST: 已和小老師確認錄影停止（${owner}`);
    await expect(row).not.toContainText('待處置');
    await shot(admin, '05-overview-handled');
  });

  await check('camera and microphone controls and the simulated video service, with no real device used', async () => {
    const tiles = tutorPage.locator('.classroom-room-stage');
    await expect(tutorPage.locator('.classroom-room-connection')).toHaveText('已連線');
    const mic = tutorPage.getByRole('button', { name: /^麥克風：/ });
    const camera = tutorPage.getByRole('button', { name: /^攝影機：/ });
    await expect(mic).toHaveAttribute('aria-pressed', 'false');
    await mic.click();
    await camera.click();
    await expect(mic).toHaveAttribute('aria-pressed', 'true');
    await expect(camera).toHaveText('攝影機：開');
    await expect(tiles.locator('.self')).toContainText('攝影機開啟（模擬：沒有真實畫面）');
    await expect(tiles.locator('.self')).toContainText('麥克風開啟');
    await tutorPage.getByText('模擬控制（只在測試教室）').click();
    await expect(tiles.locator('.remote')).toContainText('等待對方進入教室。');
    await tutorPage.getByRole('button', { name: '對方進入', exact: true }).click();
    await expect(tiles.locator('.remote')).toContainText('攝影機開啟（模擬：沒有真實畫面）');
    await tutorPage.getByRole('button', { name: '攝影機被封鎖', exact: true }).click();
    await expect(tutorPage.getByRole('alert').filter({ hasText: '攝影機被封鎖。請在瀏覽器的網站設定允許使用攝影機' })).toBeVisible();
    await expect(camera).toBeDisabled();
    await tutorPage.getByRole('button', { name: '裝置恢復', exact: true }).click();
    await expect(camera).toBeEnabled();
    await expect(camera).toHaveText('攝影機：關');

    // A dropped connection is reported at once and shows on the overview; so does the recovery.
    await tutorPage.getByRole('button', { name: '網路中斷', exact: true }).click();
    await expect(tutorPage.locator('.classroom-room-problem', { hasText: '視訊連線中斷，正在重新連線…' })).toBeVisible();
    await expect(mic).toBeDisabled();
    await expect.poll(async () => { await refresh(); return card().textContent(); }, { timeout: 20000 }).toContain('重新連線中');
    await shot(tutorPage, '07-tutor-reconnecting');
    await tutorPage.getByRole('button', { name: '網路恢復', exact: true }).click();
    await expect(tutorPage.locator('.classroom-room-connection')).toHaveText('已連線');
    await expect.poll(async () => { await refresh(); return card().textContent(); }, { timeout: 20000 }).not.toContain('重新連線中');

    for (const page of [tutorPage, student]) expect(await page.evaluate(() => window.__deviceRequests)).toBe(0);
  });

  // R-1 and R-2 (2026-11-06): "Connect again" used to rejoin with the token given on entry (Zoom's
  // lasts 30 minutes). It now asks the protected join check for a new one each time.
  await check('RC-5: after a failed connection, "Connect again" asks the join check again (once, even on a double click) and reconnects', async () => {
    const joinRequests = [];
    tutorPage.on('request', item => { if (item.method() === 'POST' && item.url().endsWith(`/api/classroom/${lesson.id}/join`)) joinRequests.push(item); });
    lesson.joinRequests = joinRequests;
    const failed = tutorPage.getByRole('alert').filter({ hasText: '視訊無法連線' });
    await tutorPage.getByRole('button', { name: '連線失敗', exact: true }).click();
    await expect(failed).toBeVisible();
    await tutorPage.getByRole('button', { name: '重新連線', exact: true }).dblclick();
    await expect(tutorPage.locator('.classroom-room-connection')).toHaveText('已連線');
    expect(joinRequests.length).toBe(1);
    const fresh = await (await joinRequests[0].response()).json();
    expect(fresh).toMatchObject({ ok: true, role: 'tutor', participantCode: lesson.tutorCode });
    // A new token from the server, issued now: never the one from entry.
    expect(fresh.session.token).not.toBe(lesson.tutorSession.token);
    expect(Date.parse(fresh.session.expiresAt)).toBeGreaterThan(Date.parse(lesson.tutorSession.expiresAt));
    expect(claimsOf(fresh.session.token).user_key).toBe(lesson.tutorKey);
  });

  await check('RC-6: the room joins only with the new answer\'s token; without one it stays failed, and a refusal shows its reason', async () => {
    const failed = tutorPage.getByRole('alert').filter({ hasText: '視訊無法連線' });
    const pill = tutorPage.locator('.classroom-room-connection');
    const again = tutorPage.getByRole('button', { name: '重新連線', exact: true });
    await tutorPage.getByRole('button', { name: '連線失敗', exact: true }).click();
    await expect(failed).toBeVisible();
    // The server's real answer with its token taken out: falling back on an older token would connect.
    await tutorPage.route('**/join', async route => {
      const response = await route.fetch();
      const body = await response.json();
      await route.fulfill({ response, json: { ...body, session: { ...body.session, token: '' } } });
    }, { times: 1 });
    await again.click();
    await expect(failed).toContainText('暫時連不上教室，請稍後再試。');
    await tutorPage.waitForTimeout(1500);
    await expect(pill).not.toHaveText('已連線');
    // The join check refusing (here: the lesson's time window has closed) is shown, and nothing connects.
    await tutorPage.route('**/join', route => route.fulfill({ status: 403, json: { error: 'You cannot enter this classroom', code: 'OUTSIDE_JOIN_WINDOW' } }), { times: 1 });
    await again.click();
    await expect(failed).toContainText('教室在上課前 15 分鐘開放，下課後 15 分鐘關閉。');
    await expect(pill).not.toHaveText('已連線');
    await again.click();
    await expect(pill).toHaveText('已連線');
    await expect(failed).toHaveCount(0);
    expect(lesson.joinRequests.length).toBe(4);
    await shot(tutorPage, '08-tutor-controls');
  });

  await check('the tutor leaves; phone-sized pages never scroll sideways', async () => {
    await tutorPage.getByRole('button', { name: '離開教室' }).click();
    await expect(tutorPage.getByText('你已離開教室。')).toBeVisible();
    await admin.setViewportSize({ width: 390, height: 844 });
    await refresh();
    expect(await noHorizontalOverflow(admin)).toBe(true);
    await shot(admin, '06-overview-phone');
  });

  // Phase 2 (2026-11-06): the page takes the key out of the address bar at once; owners revoke,
  // reissue and cancel, and a link that no longer counts gets no session token.
  const linkLesson = { code: 'TEST-B2', tutorCode: 'TEST-BT2', studentCode: 'TEST-BS2' };
  const linkRow = () => admin.locator('.classroom-lessons tr', { hasText: linkLesson.code });
  const ownerAction = async name => {
    admin.once('dialog', dialog => dialog.accept());
    await linkRow().getByRole('button', { name, exact: true }).click();
  };
  const enterAgain = async page => {
    const [response] = await Promise.all([
      page.waitForResponse(item => item.url().endsWith('/join') && item.request().method() === 'POST'),
      page.getByRole('button', { name: /^(進入教室|重新進入|再試一次)$/ }).click(),
    ]);
    return { status: response.status(), body: await response.json() };
  };
  let kid;

  await check('a personal link is given behind #; the page reads the key and takes it out of the address bar (the older ?k= form too)', async () => {
    await admin.setViewportSize({ width: 1280, height: 900 });
    await refresh();
    await admin.getByLabel('課程代碼').fill(linkLesson.code);
    await admin.getByLabel('日期').fill(lesson.date);
    await admin.getByLabel('開始時間（台北）').fill(lesson.time);
    await admin.getByLabel('分鐘').fill('60');
    await admin.getByLabel('小老師代碼').fill(linkLesson.tutorCode);
    await admin.getByLabel('小老師登入 Email').fill(tutor);
    await admin.getByLabel('學生代碼').fill(linkLesson.studentCode);
    await admin.getByRole('button', { name: '新增一對一課程' }).click();
    const box = admin.locator('.classroom-link code');
    await expect(box).toBeVisible();
    linkLesson.link = await box.textContent();
    expect(linkLesson.link).toMatch(/\/classroom\/L-[0-9a-f]{32}#k=[A-Za-z0-9_-]{43}$/);
    linkLesson.id = new URL(linkLesson.link).pathname.split('/').pop();
    linkLesson.key = keyOf(linkLesson.link);
    const roomAddress = `${origin}/classroom/${linkLesson.id}`;

    const kidContext = await context({ locale: 'zh-TW' });
    kid = watch(await kidContext.newPage());
    const pageRequests = [];
    kid.on('request', item => pageRequests.push(item.url()));
    await kid.goto(linkLesson.link);
    await expect.poll(() => kid.evaluate(() => window.location.href)).toBe(roomAddress);
    const entered = await enterAgain(kid);
    expect(entered).toMatchObject({ status: 200, body: { role: 'student', participantCode: linkLesson.studentCode } });
    // The key was never in a request address, and is not in the page or its storage.
    expect(pageRequests.filter(url => url.includes(linkLesson.key))).toEqual([]);
    expect(await kid.content()).not.toContain(linkLesson.key);
    expect(await kid.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }))).not.toContain(linkLesson.key);

    const legacyContext = await context({ locale: 'zh-TW' });
    const legacy = watch(await legacyContext.newPage());
    await legacy.goto(`${roomAddress}?k=${linkLesson.key}`);
    await expect.poll(() => legacy.evaluate(() => window.location.href)).toBe(roomAddress);
    expect((await enterAgain(legacy)).status).toBe(200);
    await legacyContext.close();
  });

  await check('revoking the link: "Connect again" gets no new token, and neither does entering again', async () => {
    await ownerAction('撤銷學生連結');
    await expect(admin.locator('.classroom-notice')).toContainText('學生連結已撤銷');
    await kid.getByText('模擬控制（只在測試教室）').click();
    await kid.getByRole('button', { name: '連線失敗', exact: true }).click();
    const failed = kid.getByRole('alert').filter({ hasText: '視訊無法連線' });
    await expect(failed).toBeVisible();
    const [refusedRejoin] = await Promise.all([
      kid.waitForResponse(item => item.url().endsWith('/join') && item.request().method() === 'POST'),
      kid.getByRole('button', { name: '重新連線', exact: true }).click(),
    ]);
    expect(refusedRejoin.status()).toBe(403);
    expect((await refusedRejoin.json()).session).toBeUndefined();
    await expect(failed).toContainText('這個連結無法進入這堂課。請向 iHear 索取新的連結。');
    await expect(kid.locator('.classroom-room-connection')).not.toHaveText('已連線');
    await kid.getByRole('button', { name: '離開教室' }).click();
    const again = await enterAgain(kid);
    expect(again).toMatchObject({ status: 403, body: { code: 'NOT_ON_ROSTER' } });
    expect(again.body.session).toBeUndefined();
    await expect(kid.locator('.classroom-room-problem')).toContainText('這個連結無法進入這堂課');
  });

  await check('reissuing: the new link is shown once; the old link stays refused and the new one enters', async () => {
    await ownerAction('重發學生連結');
    const box = admin.locator('.classroom-link code');
    await expect(box).toContainText(`/classroom/${linkLesson.id}#k=`);
    linkLesson.newLink = await box.textContent();
    linkLesson.newKey = keyOf(linkLesson.newLink);
    expect(linkLesson.newKey).not.toBe(linkLesson.key);
    await refresh();
    await expect(admin.locator('.classroom-link')).toHaveCount(0);
    expect(await admin.content()).not.toContain(linkLesson.newKey);
    const oldContext = await context({ locale: 'zh-TW' });
    const old = watch(await oldContext.newPage());
    await old.goto(linkLesson.link);
    expect(await enterAgain(old)).toMatchObject({ status: 403, body: { code: 'NOT_ON_ROSTER' } });
    await oldContext.close();
    // Opened in the tab that still shows the room: only the part after # changes, so the page is
    // not reloaded; it must still take the new key (and out of the address bar).
    await kid.goto(linkLesson.newLink);
    await expect.poll(() => kid.evaluate(() => window.location.href)).toBe(`${origin}/classroom/${linkLesson.id}`);
    expect(await enterAgain(kid)).toMatchObject({ status: 200, body: { role: 'student', participantCode: linkLesson.studentCode } });
  });

  await check('cancelling the lesson: the current link gets no token either', async () => {
    await ownerAction('取消課程');
    await expect(linkRow()).toContainText('已取消');
    await expect(linkRow().getByRole('button', { name: '重發學生連結', exact: true })).toBeDisabled();
    await kid.getByRole('button', { name: '離開教室' }).click();
    const refused = await enterAgain(kid);
    expect(refused).toMatchObject({ status: 403, body: { code: 'LESSON_CANCELLED' } });
    expect(refused.body.session).toBeUndefined();
    await expect(kid.locator('.classroom-room-problem')).toContainText('這堂課已經取消。');
    await shot(admin, '09-overview-link-actions');
  });

  // /classroom (2026-11-06): the entry page the home page will link to, only at the end of S3.
  await check('/classroom signed out: the tutor sign-in and the personal-link path, and no lesson at all', async () => {
    const visitorContext = await context({ locale: 'zh-TW', viewport: { width: 390, height: 844 } });
    const visitor = watch(await visitorContext.newPage());
    await visitor.goto(`${origin}/classroom`);
    await expect(visitor.getByRole('link', { name: '小老師：使用 Google 登入' })).toHaveAttribute('href', '/api/auth/signin?callbackUrl=%2Fclassroom');
    await expect(visitor.getByText('請使用 iHear 寄給你的個人課程連結進入教室')).toBeVisible();
    const html = await visitor.content();
    for (const value of [lesson.code, lesson.id, linkLesson.code, linkLesson.id]) expect(html).not.toContain(value);
    expect(await noHorizontalOverflow(visitor)).toBe(true);
    await shot(visitor, '10-classroom-entry-signed-out');
    await visitorContext.close();
  });

  await check('/classroom for the signed-in tutor: only their lessons; an open one is entered from 我的課程, a cancelled one cannot be', async () => {
    const mine = watch(await tutorContext.newPage());
    await mine.goto(`${origin}/classroom`);
    const open = mine.locator('.classroom-mine li', { hasText: lesson.code });
    const cancelled = mine.locator('.classroom-mine li', { hasText: linkLesson.code });
    await expect(open).toContainText('可以進入');
    await expect(cancelled).toContainText('已取消');
    await expect(cancelled.getByRole('link')).toHaveCount(0);
    const answer = await mine.evaluate(async () => JSON.stringify(await (await fetch('/api/classroom/my-lessons')).json()));
    for (const value of [lesson.key, linkLesson.key, linkLesson.newKey, tutor, 'token', 'sessionName']) expect(answer).not.toContain(value);
    await shot(mine, '11-classroom-my-lessons');
    await open.getByRole('link', { name: '進入教室' }).click();
    await expect(mine).toHaveURL(`${origin}/classroom/${lesson.id}`);
    await expect(mine.getByRole('button', { name: '進入教室' })).toBeVisible();
    await mine.close();
  });

  await check('/classroom for an owner who teaches nothing here: no lessons, and the way to the overview', async () => {
    const page = watch(await ownerContext.newPage());
    await page.goto(`${origin}/classroom`);
    await expect(page.getByText('目前沒有你的課程。')).toBeVisible();
    await expect(page.getByRole('link', { name: '管理全部課程' })).toHaveAttribute('href', '/admin/classrooms');
    await page.close();
  });

  await check('codes only, nothing sent to another site, no unexpected browser errors', async () => {
    const shown = await admin.evaluate(async () => JSON.stringify(await (await fetch('/api/admin/classrooms')).json()));
    for (const value of [tutor, lesson.key, linkLesson.key, linkLesson.newKey, 'Synthetic Display Name', '203.0.113.7']) expect(shown).not.toContain(value);
    expect(report.externalRequests).toEqual([]);
    expect(consoleProblems).toEqual([]);
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
  console.log(`Classroom evidence (synthetic): ${directory}`);
}
if (failure) throw failure;
