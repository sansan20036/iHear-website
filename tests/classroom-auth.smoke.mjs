// P3-Auth in a browser (2026-11-08): what the classroom pages do when entry ends, against the
// built application with the synthetic provider, disposable local storage and test-only sessions.
// Nothing connects to Zoom, Google or production.
//
// Read every "left" below as: the page left the room by itself (it asked the server, was refused
// and closed its own media adapter). The server never ends a session or removes anyone here, and
// this test checks that it does not ask the provider to; a real Zoom session would only see the
// page's own leaving. A page that does not cooperate is not covered by any of this.
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';
import { localContext, startAcademyServer } from './helpers/academy-smoke.mjs';

const secret = 'classroom-auth-browser-acceptance-only';
const owner = 'auth-owner@example.test', tutor = 'auth-tutor@example.test';
Object.assign(process.env, {
  CLASSROOM_PROVIDER: 'synthetic', CLASSROOM_DRIVE: 'local', CLASSROOM_WEBHOOK_SECRET: 'classroom-auth-webhook-local-only',
  CLASSROOM_SYNTHETIC_SECRET: 'classroom-auth-token-local-only', VERCEL_ENV: '',
});
const server = await startAcademyServer({ port: 3243, secret, owners: [owner], name: 'classroom-auth' });
const { origin, directory } = server;
const report = { startedAt: new Date().toISOString(), origin, synthetic: true, zoomVerified: false, serverDisconnects: 'none (not available here)', checks: [], timings: {}, externalRequests: [], status: 'running' };
const consoleProblems = [];
let browser, failure;

async function check(name, action) {
  try { await action(); report.checks.push({ name, status: 'passed' }); console.log(`PASS ${name}`); }
  catch (error) { report.checks.push({ name, status: 'failed', error: error.message }); throw error; }
}
const shot = (page, name) => page.screenshot({ path: path.join(directory, `${name}.png`), fullPage: true });
const context = options => localContext(browser, origin, { external: report.externalRequests, secret, ...options });
// Refusals and failures this test causes on purpose show as resource errors in the console.
const expected = text => /Failed to load resource: (the server responded with a status of (401|403|429|500|503)|net::ERR_(INTERNET_DISCONNECTED|FAILED))/.test(text);
function watch(page, who) {
  page.on('console', message => { if (message.type() === 'error' && !expected(message.text())) consoleProblems.push(`${who}: ${message.text()}`); });
  page.on('pageerror', error => consoleProblems.push(`${who}: ${error.message}`));
  return page;
}
const keyOf = link => new URLSearchParams(new URL(link).hash.slice(1)).get('k');
const taipei = ms => { const text = new Date(ms + 8 * 3600_000).toISOString(); return { date: text.slice(0, 10), time: text.slice(11, 16) }; };
// What the server asked the synthetic provider to do for a lesson (start, stop, end, remove...).
const providerCalls = async lessonId => {
  const text = await readFile(path.join(directory, 'synthetic-zoom.json'), 'utf8').catch(() => '{"calls":[]}');
  try { return JSON.parse(text).calls.filter(call => call.lessonId === lessonId).map(call => call.type); } catch { return null; }
};
const seconds = ms => Math.round(ms / 100) / 10;

const LEAVE = '離開教室';
async function inRoom(page) {
  await expect(page.locator('.classroom-room-stage')).toBeVisible();
  await expect(page.getByRole('button', { name: LEAVE })).toBeVisible();
  await expect(page.locator('.classroom-room-problem[role="alert"]')).toHaveCount(0);
}
// Left by itself, with the reason shown and nothing of the room left on the page.
async function leftWith(page, text, timeout) {
  await expect(page.locator('.classroom-room-problem[role="alert"]')).toContainText(text, { timeout });
  await expect(page.locator('.classroom-room-stage')).toHaveCount(0);
  await expect(page.getByRole('button', { name: LEAVE })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '再試一次' })).toBeVisible();
}
async function enter(page) {
  const [response] = await Promise.all([
    page.waitForResponse(item => item.url().endsWith('/join') && item.request().method() === 'POST'),
    page.getByRole('button', { name: /^(進入教室|重新進入|再試一次)$/ }).click(),
  ]);
  return { status: response.status(), body: await response.json() };
}

try {
  browser = await chromium.launch({ headless: process.env.IHEAR_HEADED !== '1' });
  const ownerContext = await context({ email: owner, locale: 'zh-TW' });
  const admin = watch(await ownerContext.newPage(), 'admin');
  await admin.goto(`${origin}/admin/classrooms`);
  await expect(admin.getByRole('heading', { name: '教室總覽', level: 1 })).toBeVisible();
  const refresh = async () => { await admin.reload(); await expect(admin.getByRole('heading', { name: '教室總覽', level: 1 })).toBeVisible(); };
  const addLesson = async (code, startMs, minutes = 60) => {
    const result = await admin.evaluate(async body => {
      const response = await fetch('/api/admin/classrooms', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      return { status: response.status, body: await response.json() };
    }, { code, ...taipei(startMs), minutes, tutorCode: `${code}-T`, tutorEmail: tutor, studentCode: `${code}-S` });
    expect(result.status, code).toBe(201);
    return { code, id: result.body.lesson.lessonId, link: `${origin}${result.body.studentLink}`, endsAt: result.body.lesson.endsAt };
  };
  // An owner's action from the lessons table; the confirmation text is kept for the report.
  const dialogs = [];
  const ownerAction = async (lesson, name) => {
    admin.once('dialog', dialog => { dialogs.push(dialog.message()); void dialog.accept(); });
    const [response] = await Promise.all([
      admin.waitForResponse(item => item.url().endsWith(`/api/admin/classrooms/${lesson.id}`) && item.request().method() === 'PATCH'),
      admin.locator('.classroom-lessons tr', { hasText: lesson.code }).getByRole('button', { name, exact: true }).click(),
    ]);
    expect(response.status()).toBe(200);
    return { at: Date.now(), body: await response.json() };
  };
  const studentPage = async (link, who) => {
    const page = watch(await (await context({ locale: 'zh-TW', viewport: { width: 390, height: 844 } })).newPage(), who);
    await page.goto(link);
    expect((await enter(page)).status).toBe(200);
    await inRoom(page);
    return page;
  };
  const tutorPage = async lesson => {
    const page = watch(await (await context({ email: tutor, locale: 'zh-TW' })).newPage(), `tutor ${lesson.code}`);
    await page.goto(`${origin}/classroom/${lesson.id}`);
    expect((await enter(page)).status).toBe(200);
    await inRoom(page);
    return page;
  };

  // The real end of the time window: a 15-minute lesson whose door (end + 15 minutes) closes
  // 45–105 seconds from now. Both enter now; the check comes after the other scenarios.
  const closesSoonStart = Math.ceil((Date.now() - 30 * 60_000 + 45_000) / 60_000) * 60_000;
  const expiring = await addLesson('TEST-AX', closesSoonStart, 15);
  const closesAt = Date.parse(expiring.endsAt) + 15 * 60_000;
  const cancelled = await addLesson('TEST-AC', Date.now() + 5 * 60_000);
  const revoked = await addLesson('TEST-AR', Date.now() + 5 * 60_000);
  const reissued = await addLesson('TEST-AI', Date.now() + 5 * 60_000);
  const steady = await addLesson('TEST-AS', Date.now() + 5 * 60_000);
  await refresh();
  const expiringStudent = await studentPage(expiring.link, 'student TEST-AX');
  const expiringTutor = await tutorPage(expiring);

  await check('cancel: the student page (≈15 s) and the tutor page (≈30 s) show the reason and leave the room by themselves; the server asks the provider for nothing', async () => {
    const student = await studentPage(cancelled.link, 'student TEST-AC');
    const teacher = await tutorPage(cancelled);
    const callsBefore = await providerCalls(cancelled.id);
    const action = await ownerAction(cancelled, '取消課程');
    expect(action.body).toEqual({ ok: true, cancelled: true, changed: true });
    await leftWith(student, '這堂課已經取消。', 25_000);
    report.timings.cancelStudentLeftSeconds = seconds(Date.now() - action.at);
    await leftWith(teacher, '這堂課已經取消。', 45_000);
    report.timings.cancelTutorLeftSeconds = seconds(Date.now() - action.at);
    for (const page of [student, teacher]) expect((await enter(page)).body).toMatchObject({ code: 'LESSON_CANCELLED' });
    const callsAfter = await providerCalls(cancelled.id);
    expect(callsAfter).toEqual(callsBefore);
    for (const call of ['session.end', 'user.remove']) expect(callsAfter).not.toContain(call);
    await shot(student, 'cancel-student');
    await shot(teacher, 'cancel-tutor');
  });

  await check('revoke with the link open on two devices: both student pages say the link no longer works and leave; the tutor stays', async () => {
    const phone = await studentPage(revoked.link, 'student phone TEST-AR');
    const laptop = await studentPage(revoked.link, 'student laptop TEST-AR');
    const teacher = await tutorPage(revoked);
    const action = await ownerAction(revoked, '撤銷學生連結');
    expect(action.body).toMatchObject({ ok: true, revoked: true });
    await leftWith(phone, '這個個人連結已失效（已撤銷或已更換），所以已離開教室。', 25_000);
    await leftWith(laptop, '這個個人連結已失效（已撤銷或已更換），所以已離開教室。', 25_000);
    report.timings.revokeBothDevicesLeftSeconds = seconds(Date.now() - action.at);
    // The tutor's next report (every 30 seconds) is accepted: the tutor stays in the room.
    await teacher.waitForResponse(item => item.url().endsWith('/host-events') && item.status() === 200, { timeout: 40_000 });
    await inRoom(teacher);
    await expect(teacher.locator('.classroom-room-connection')).toHaveText('已連線');
    const calls = await providerCalls(revoked.id);
    for (const call of ['session.end', 'user.remove']) expect(calls).not.toContain(call);
    await shot(laptop, 'revoke-student');
  });

  await check('reissue: the page on the old link leaves; the new link enters and stays through two status checks', async () => {
    const old = await studentPage(reissued.link, 'student old TEST-AI');
    const action = await ownerAction(reissued, '重發學生連結');
    const box = admin.locator('.classroom-link code');
    await expect(box).toContainText(`/classroom/${reissued.id}#k=`);
    const newLink = await box.textContent();
    expect(keyOf(newLink)).not.toBe(keyOf(reissued.link));
    await leftWith(old, '這個個人連結已失效（已撤銷或已更換），所以已離開教室。', 25_000);
    report.timings.reissueOldLinkLeftSeconds = seconds(Date.now() - action.at);
    const fresh = await studentPage(newLink, 'student new TEST-AI');
    for (let read = 0; read < 2; read += 1) {
      const answer = await fresh.waitForResponse(item => item.url().endsWith('/status'), { timeout: 20_000 });
      expect(answer.status()).toBe(200);
    }
    await inRoom(fresh);
  });

  await check('the student page stays in the room through a lost network, 403 without an ending code, 429, 500 and 503', async () => {
    const student = await studentPage(steady.link, 'student TEST-AS');
    const answers = [
      ['lost network', route => route.abort('internetdisconnected')],
      ['403 outside the time window', route => route.fulfill({ status: 403, json: { error: 'You cannot see this classroom', code: 'OUTSIDE_JOIN_WINDOW' } })],
      ['403 cross-site refusal (no code)', route => route.fulfill({ status: 403, json: { error: 'Cross-origin request blocked' } })],
      ['403 forbidden', route => route.fulfill({ status: 403, json: { error: 'Forbidden', code: 'FORBIDDEN' } })],
      ['429', route => route.fulfill({ status: 429, json: { error: 'Too many requests', code: 'RATE_LIMITED' } })],
      ['500', route => route.fulfill({ status: 500, body: 'Internal Server Error' })],
      ['503', route => route.fulfill({ status: 503, json: { error: 'The classroom is temporarily unavailable' } })],
    ];
    const queue = [...answers];
    const served = [];
    await student.route('**/status', route => {
      const next = queue.shift();
      if (!next) return route.continue();
      served.push(next[0]);
      return next[1](route);
    });
    for (const [name] of answers) {
      await expect.poll(() => served.includes(name), { timeout: 20_000, message: name }).toBe(true);
      await student.waitForTimeout(500);
      await inRoom(student);
      await expect(student.locator('.classroom-room-badge'), name).toHaveText('錄影狀態不明');
    }
    await student.unroute('**/status');
    // The browser itself offline for one check, then back: still in the room, and the state returns.
    await student.context().setOffline(true);
    await student.waitForTimeout(16_000);
    await inRoom(student);
    await student.context().setOffline(false);
    await expect(student.locator('.classroom-room-badge')).toHaveText('未錄影', { timeout: 20_000 });
    await inRoom(student);
  });

  await check('the tutor page stays through refusals and failures; after a refusal or 429 it waits 30 seconds, after a 503 about 5', async () => {
    const teacher = await tutorPage(steady);
    const reports = [];
    teacher.on('request', item => { if (item.url().endsWith('/host-events')) reports.push(Date.now()); });
    // Reports sent on a room change (here the simulated network dropping and coming back) get each answer.
    await teacher.getByText('模擬控制（只在測試教室）').click();
    for (const [name, answer] of [
      ['403 forbidden', { status: 403, json: { error: 'Only this lesson\'s tutor can report', code: 'FORBIDDEN' } }],
      ['403 outside the window', { status: 403, json: { error: 'The classroom is not open now', code: 'OUTSIDE_JOIN_WINDOW' } }],
      ['429', { status: 429, json: { error: 'Too many requests', code: 'RATE_LIMITED' } }],
      ['500', { status: 500, body: 'Internal Server Error' }],
    ]) {
      await teacher.route('**/host-events', route => route.fulfill(answer));
      await teacher.getByRole('button', { name: '網路中斷', exact: true }).click();
      await teacher.getByRole('button', { name: '網路恢復', exact: true }).click();
      await teacher.waitForTimeout(800);
      await expect(teacher.getByRole('button', { name: LEAVE }), name).toBeVisible();
      await expect(teacher.locator('.classroom-room-problem[role="alert"]'), name).toHaveCount(0);
      await teacher.unroute('**/host-events');
    }
    // The heartbeat's own timing: after a 429 the next report comes about 30 seconds later.
    await teacher.route('**/host-events', route => route.fulfill({ status: 429, json: { error: 'Too many requests', code: 'RATE_LIMITED' } }), { times: 1 });
    const limitedAt = (await teacher.waitForRequest(item => item.url().endsWith('/host-events'), { timeout: 40_000 }), Date.now());
    await teacher.waitForRequest(item => item.url().endsWith('/host-events'), { timeout: 40_000 });
    report.timings.tutorNextReportAfter429Seconds = seconds(Date.now() - limitedAt);
    expect(Date.now() - limitedAt).toBeGreaterThan(25_000);
    await expect(teacher.getByText('和 iHear 的連線不穩定，正在重試…')).toHaveCount(0, { timeout: 5_000 });
    // After a 503 it asks again about 5 seconds later.
    await teacher.route('**/host-events', route => route.fulfill({ status: 503, json: { error: 'Not stored, please retry' } }), { times: 1 });
    const failedAt = (await teacher.waitForRequest(item => item.url().endsWith('/host-events'), { timeout: 40_000 }), Date.now());
    await expect(teacher.getByText('和 iHear 的連線不穩定，正在重試…')).toBeVisible();
    await teacher.waitForRequest(item => item.url().endsWith('/host-events'), { timeout: 15_000 });
    report.timings.tutorNextReportAfter503Seconds = seconds(Date.now() - failedAt);
    expect(Date.now() - failedAt).toBeLessThan(10_000);
    // The browser offline: the page says the connection is unstable and stays.
    await teacher.context().setOffline(true);
    await teacher.getByRole('button', { name: '網路中斷', exact: true }).click();
    await teacher.getByRole('button', { name: '網路恢復', exact: true }).click();
    await teacher.waitForTimeout(6_000);
    await expect(teacher.getByRole('button', { name: LEAVE })).toBeVisible();
    await teacher.context().setOffline(false);
    await inRoom(teacher);
    await shot(teacher, 'tutor-stays');
  });

  await check('the time window really closing: both pages stay in the room (a lesson may run over); entering again is refused', async () => {
    const wait = closesAt - Date.now() + 1_000;
    if (wait > 0) await expiringStudent.waitForTimeout(wait);
    const refused = await expiringStudent.waitForResponse(item => item.url().endsWith('/status') && item.status() === 403, { timeout: 20_000 });
    expect((await refused.json()).code).toBe('OUTSIDE_JOIN_WINDOW');
    report.timings.windowClosedAt = new Date(closesAt).toISOString();
    await expiringStudent.waitForTimeout(500);
    await inRoom(expiringStudent);
    await expect(expiringStudent.locator('.classroom-room-badge')).toHaveText('錄影狀態不明');
    // The tutor's reports are still taken for an hour after the door closes.
    await expiringTutor.waitForResponse(item => item.url().endsWith('/host-events') && item.status() === 200, { timeout: 40_000 });
    await inRoom(expiringTutor);
    // Leaving and entering again is refused once the door has closed.
    await expiringStudent.getByRole('button', { name: LEAVE }).click();
    expect((await enter(expiringStudent)).body).toMatchObject({ code: 'OUTSIDE_JOIN_WINDOW' });
    await expect(expiringStudent.locator('.classroom-room-problem')).toContainText('教室在上課前 15 分鐘開放，下課後 15 分鐘關閉。');
    await shot(expiringStudent, 'window-closed-student');
  });

  await check('the owner was told before each change that nobody is disconnected at once', async () => {
    expect(dialogs).toHaveLength(3);
    for (const text of dialogs) expect(text).toContain('不會立即斷線');
  });

  await check('nothing was sent to another site and no unexpected browser errors', async () => {
    expect(report.externalRequests).toEqual([]);
    expect(consoleProblems).toEqual([]);
  });
  report.status = 'passed';
} catch (error) {
  failure = error;
  report.status = 'failed';
  report.error = error.message;
} finally {
  report.finishedAt = new Date().toISOString();
  report.consoleProblems = consoleProblems;
  await writeFile(path.join(directory, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`timings: ${JSON.stringify(report.timings)}`);
  console.log(`report: ${path.join(directory, 'report.json')}`);
  await browser?.close();
  server.child.kill();
}
if (failure) throw failure;
