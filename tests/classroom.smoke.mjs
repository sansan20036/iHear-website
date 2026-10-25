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
const calls = async lessonId => {
  const state = JSON.parse(await readFile(path.join(directory, 'synthetic-zoom.json'), 'utf8').catch(() => '{"calls":[]}'));
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
    lesson.key = new URL(lesson.link).searchParams.get('k');
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
    expect(await noHorizontalOverflow(student)).toBe(true);
    await shot(student, '02-student-phone');
  });

  await check('the signed-in tutor enters and sees that this lesson may be recorded', async () => {
    await tutorPage.goto(`${origin}/classroom/${lesson.id}`);
    const joined = await enter(tutorPage);
    expect(joined).toMatchObject({ status: 200, body: { role: 'tutor', participantCode: lesson.tutorCode } });
    lesson.tutorKey = claimsOf(joined.body.session.token).user_key;
    await expect(tutorPage.locator('.classroom-room-recording')).toContainText('未開始');
    await expect(tutorPage.getByText('這堂課可以錄影。')).toBeVisible();
  });

  await check('recording is requested only after Zoom confirms the session and both people', async () => {
    expect(await calls(lesson.id)).toEqual([]);
    await zoom('session.started', lesson, { start_time: new Date().toISOString() });
    await zoom('session.user_joined', lesson, zoomUser(lesson.tutorKey, 'UUID-BT1'));
    await zoom('session.user_joined', lesson, zoomUser(lesson.studentKey, 'UUID-BS1'));
    await expect.poll(async () => { await refresh(); return calls(lesson.id); }, { timeout: 20000 }).toEqual(['recording.start']);
    await expect(card()).toContainText('已送出錄影啟動請求');
  });

  await check("only Zoom's confirmation turns it into 錄影中, on the overview and the tutor's page", async () => {
    await zoom('session.recording_started', lesson, { recording_file: { recording_start: new Date().toISOString() } });
    await refresh();
    await expect(card()).toContainText('錄影中');
    await expect(card()).toContainText('（Zoom確認）');
    // Before recording the tutor's page reports every 30 seconds; it learns of the start then.
    await expect(tutorPage.locator('.classroom-room-recording')).toContainText('錄影中', { timeout: 45000 });
    await expect(tutorPage.locator('.classroom-room-recording')).toContainText('已確認');
    await shot(admin, '03-overview-recording');
    await shot(tutorPage, '04-tutor-recording');
  });

  await check('a withdrawal in class stops recording at once and shows on both pages', async () => {
    await admin.getByPlaceholder('人員代碼').fill(lesson.studentCode);
    await admin.getByLabel('角色').selectOption('student');
    await admin.getByLabel('狀態').selectOption('withdrawn');
    await admin.getByRole('button', { name: '儲存' }).click();
    await expect.poll(async () => { await refresh(); return calls(lesson.id); }, { timeout: 20000 }).toEqual(['recording.start', 'recording.stop']);
    await expect(card()).toContainText('課中撤回錄影同意');
    await expect(tutorPage.getByText('這堂課不錄影。')).toBeVisible({ timeout: 20000 });
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

  await check('the tutor leaves; phone-sized pages never scroll sideways', async () => {
    await tutorPage.getByRole('button', { name: '離開教室' }).click();
    await expect(tutorPage.getByText('你已離開教室。')).toBeVisible();
    await admin.setViewportSize({ width: 390, height: 844 });
    await refresh();
    expect(await noHorizontalOverflow(admin)).toBe(true);
    await shot(admin, '06-overview-phone');
  });

  await check('codes only, nothing sent to another site, no unexpected browser errors', async () => {
    const shown = await admin.evaluate(async () => JSON.stringify(await (await fetch('/api/admin/classrooms')).json()));
    for (const value of [tutor, lesson.key, 'Synthetic Display Name', '203.0.113.7']) expect(shown).not.toContain(value);
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
