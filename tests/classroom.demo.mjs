// A local demonstration of the one-to-one classroom, with synthetic data only. It starts the
// built site (run the build first) with disposable local storage and test-only sessions, sets up
// four lessons in different states, and opens three browser windows: the owners' overview, the
// tutor's classroom and the student's classroom on a phone-sized window.
//
//   node tests/classroom.demo.mjs              windows stay open until Ctrl+C
//   IHEAR_DEMO_SECONDS=20 IHEAR_HEADED=0 node tests/classroom.demo.mjs   short headless run
//
// There is no real video service: the synthetic adapter shows states, not pictures, and this
// script plays the provider's side (signed webhooks shaped like the first design's Zoom events).
// No production credentials, data or requests are used, and no real camera or microphone.
import { createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { localContext, startAcademyServer } from './helpers/academy-smoke.mjs';

const secret = 'classroom-demo-local-only-not-production';
const webhookSecret = 'classroom-demo-webhook-local-only';
const owner = 'demo-owner@example.test';
const tutor = 'demo-tutor@example.test';
Object.assign(process.env, {
  CLASSROOM_PROVIDER: 'synthetic', CLASSROOM_DRIVE: 'local', CLASSROOM_WEBHOOK_SECRET: webhookSecret,
  CLASSROOM_SYNTHETIC_SECRET: 'classroom-demo-token-local-only', VERCEL_ENV: '',
});
const headed = process.env.IHEAR_HEADED !== '0';
const seconds = Number(process.env.IHEAR_DEMO_SECONDS || 0);

const server = await startAcademyServer({ port: 3243, secret, owners: [owner], name: 'classroom-demo' });
const { origin, directory } = server;
const external = [];
let browser;

const taipei = offsetMinutes => {
  const start = new Date(Date.now() + 8 * 3600_000 + offsetMinutes * 60_000);
  return { date: start.toISOString().slice(0, 10), time: start.toISOString().slice(11, 16) };
};
const claimsOf = token => JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
// The server rewrites the synthetic provider's file in place, so a read can catch it half
// written; such a read counts as nothing requested yet.
const calls = async lessonId => {
  const text = await readFile(path.join(directory, 'synthetic-zoom.json'), 'utf8').catch(() => '{"calls":[]}');
  let state;
  try { state = JSON.parse(text); } catch { return []; }
  return state.calls.filter(call => call.lessonId === lessonId).map(call => call.type);
};
const api = (page, url, body) => page.evaluate(async ([target, payload]) => {
  const response = await fetch(target, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload ?? {}) });
  return { status: response.status, body: await response.json().catch(() => null) };
}, [url, body]);

// The provider's side of a lesson, signed with the demo-only secret.
async function provider(type, lesson, object = {}) {
  const body = JSON.stringify({ event: type, event_ts: Date.now(), payload: { account_id: 'synthetic-account', object: { id: lesson.sessionId, session_id: lesson.sessionId, session_key: lesson.id, ...object } } });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = `v0=${createHmac('sha256', webhookSecret).update(`v0:${timestamp}:${body}`).digest('hex')}`;
  const response = await fetch(`${origin}/api/recordings/zoom/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-zm-request-timestamp': timestamp, 'x-zm-signature': signature }, body });
  if (response.status !== 200) throw new Error(`${type} was answered ${response.status}`);
}
const userObject = key => ({ user: { id: '0', user_key: key, participant_uuid: `UUID-${key.slice(-6)}`, join_time: new Date().toISOString() } });

async function untilCalled(admin, lesson, type) {
  for (let attempt = 0; attempt < 40; attempt++) {
    await api(admin, '/api/admin/classrooms/tick');
    if ((await calls(lesson.id)).includes(type)) return;
    await new Promise(resolve => { setTimeout(resolve, 1000); });
  }
  throw new Error(`${lesson.code}: ${type} was never requested`);
}

try {
  browser = await chromium.launch({ headless: !headed });
  const ownerContext = await localContext(browser, origin, { email: owner, secret, external });
  const admin = await ownerContext.newPage();
  await admin.goto(`${origin}/admin/classrooms`);
  const tutorContext = await localContext(browser, origin, { email: tutor, secret, external, locale: 'zh-TW' });
  const helper = await tutorContext.newPage();
  await helper.goto(`${origin}/admin/classrooms`);

  // Four lessons: recording, not recorded (no consent), waiting to start, and a withdrawal.
  const plan = [
    { code: 'TEST-D1', offset: -5, tutorCode: 'TEST-DT1', studentCode: 'TEST-DS1', consent: true, live: true, note: '錄影中（雙方同意）' },
    { code: 'TEST-D2', offset: -6, tutorCode: 'TEST-DT2', studentCode: 'TEST-DS2', consent: false, live: true, note: '上課中，不錄影（學生未同意）' },
    { code: 'TEST-D3', offset: 40, tutorCode: 'TEST-DT3', studentCode: 'TEST-DS3', consent: true, live: false, note: '等待開始' },
    { code: 'TEST-D4', offset: -8, tutorCode: 'TEST-DT4', studentCode: 'TEST-DS4', consent: true, live: true, withdraw: true, note: '課中撤回同意（異常）' },
  ];
  const lessons = [];
  for (const item of plan) {
    const created = await api(admin, '/api/admin/classrooms', { code: item.code, ...taipei(item.offset), minutes: 60, tutorCode: item.tutorCode, tutorEmail: tutor, studentCode: item.studentCode });
    if (created.status !== 201) throw new Error(`${item.code}: lesson not created (${created.status})`);
    const link = new URL(created.body.studentLink, origin);
    // The key is behind # (2026-11-06).
    lessons.push({ ...item, id: created.body.lesson.lessonId, link: link.href, key: new URLSearchParams(link.hash.slice(1)).get('k'), sessionId: `SYN-DEMO-${item.code}` });
    await api(admin, '/api/admin/classrooms/consents', { personCode: item.tutorCode, role: 'tutor', status: 'granted' });
    if (item.consent) await api(admin, '/api/admin/classrooms/consents', { personCode: item.studentCode, role: 'student', status: 'granted' });
  }

  for (const lesson of lessons.filter(item => item.live)) {
    const student = await api(helper, `/api/classroom/${lesson.id}/join`, { key: lesson.key });
    const tutorJoin = await api(helper, `/api/classroom/${lesson.id}/join`, {});
    if (student.status !== 200 || tutorJoin.status !== 200) throw new Error(`${lesson.code}: entry refused`);
    await provider('session.started', lesson, { start_time: new Date().toISOString() });
    await provider('session.user_joined', lesson, userObject(claimsOf(tutorJoin.body.session.token).user_key));
    await provider('session.user_joined', lesson, userObject(claimsOf(student.body.session.token).user_key));
  }
  for (const lesson of lessons.filter(item => item.live && item.consent)) {
    await untilCalled(admin, lesson, 'recording.start');
    await provider('session.recording_started', lesson, { recording_file: { recording_start: new Date().toISOString() } });
  }
  for (const lesson of lessons.filter(item => item.withdraw)) {
    await api(admin, '/api/admin/classrooms/consents', { personCode: lesson.studentCode, role: 'student', status: 'withdrawn' });
    await untilCalled(admin, lesson, 'recording.stop');
    await provider('session.recording_stopped', lesson, { recording_file: { recording_end: new Date().toISOString() } });
  }
  await helper.close();

  // The windows to show: the overview, the tutor's and the student's classroom for TEST-D1.
  const main = lessons[0];
  await admin.reload();
  const tutorPage = await tutorContext.newPage();
  await tutorPage.goto(`${origin}/classroom/${main.id}`);
  await tutorPage.getByRole('button', { name: '進入教室' }).click();
  const studentContext = await localContext(browser, origin, { external, locale: 'zh-TW', viewport: { width: 390, height: 844 } });
  const studentPage = await studentContext.newPage();
  await studentPage.goto(main.link);
  await studentPage.getByRole('button', { name: '進入教室' }).click();

  console.log('\niHear 線上教室 Demo（合成資料，沒有真實視訊或錄影）');
  console.log(`  教室總覽（擁有者）：${origin}/admin/classrooms`);
  console.log(`  小老師教室：${origin}/classroom/${main.id}（${main.code}）`);
  console.log(`  學生教室：手機尺寸視窗，用個人專屬連結進入（連結不顯示）`);
  for (const lesson of lessons) console.log(`  ${lesson.code}：${lesson.note}`);
  console.log('  教室頁下方的「模擬控制」可以試：對方進出、網路中斷、連線失敗、攝影機被封鎖。');
  console.log(`  本機資料（用完可刪）：${directory}`);
  if (external.length) console.log(`  被擋下的外部請求：${external.length}`);
  if (seconds > 0) {
    await new Promise(resolve => { setTimeout(resolve, seconds * 1000); });
    // A short run leaves pictures of the three windows behind.
    await admin.reload();
    await admin.locator('.classroom-card').nth(lessons.length - 1).waitFor();
    await admin.screenshot({ path: path.join(directory, 'demo-overview.png'), fullPage: true });
    await tutorPage.screenshot({ path: path.join(directory, 'demo-tutor.png'), fullPage: true });
    await studentPage.screenshot({ path: path.join(directory, 'demo-student.png'), fullPage: true });
  } else {
    console.log('\n按 Ctrl+C 結束 Demo。');
    await new Promise(resolve => { process.once('SIGINT', resolve); });
  }
} catch (error) {
  console.error(error);
  console.error(server.logs().slice(-3000));
  process.exitCode = 1;
} finally {
  await browser?.close();
  server.child.kill();
}
