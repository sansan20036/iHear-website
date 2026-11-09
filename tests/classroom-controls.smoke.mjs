// Browser check of the recording controls on the administrators' overview (2026-11-08): the
// emergency stop button, and the list of filed recordings with their Drive folder. The built site
// with local storage, the synthetic provider (this script plays Zoom's signed webhooks) and the
// local Drive stand-in. Synthetic data only: it says nothing about real Zoom or Google Drive.
import { createHmac } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';
import { localContext, startAcademyServer } from './helpers/academy-smoke.mjs';

const secret = 'classroom-controls-smoke-key-never-use-in-production';
const webhookSecret = 'classroom-controls-webhook-local-only';
const owner = 'controls-owner@example.test', tutor = 'controls-tutor@example.test';
Object.assign(process.env, {
  CLASSROOM_PROVIDER: 'synthetic', CLASSROOM_DRIVE: 'local', CLASSROOM_WEBHOOK_SECRET: webhookSecret,
  CLASSROOM_SYNTHETIC_SECRET: 'classroom-controls-token-local-only', VERCEL_ENV: '',
});
const server = await startAcademyServer({ port: 3243, secret, owners: [owner], name: 'classroom-controls' });
const { origin, directory } = server;
const report = { startedAt: new Date().toISOString(), synthetic: true, checks: [], externalRequests: [], pageProblems: [] };

async function check(name, action) {
  try { await action(); report.checks.push({ name, status: 'passed' }); console.log(`PASS ${name}`); }
  catch (error) { report.checks.push({ name, status: 'failed', error: error.message }); throw error; }
}
// A Taipei date and time this many minutes from now (lessons are entered in Taipei time).
const taipei = minutes => { const at = new Date(Date.now() + 8 * 3600_000 + minutes * 60_000); return { date: at.toISOString().slice(0, 10), time: at.toISOString().slice(11, 16), at }; };
// The server rewrites the synthetic provider's file in place; a half-written read counts as "not yet".
const calls = async lessonId => {
  const text = await readFile(path.join(directory, 'synthetic-zoom.json'), 'utf8').catch(() => '{"calls":[]}');
  try { return JSON.parse(text).calls.filter(call => call.lessonId === lessonId).map(call => call.type); } catch { return null; }
};
const saved = async () => JSON.parse(await readFile(path.join(directory, 'classroom.json'), 'utf8'));
async function zoom(type, lesson, object = {}) {
  const body = JSON.stringify({ event: type, event_ts: Date.now(), payload: { account_id: 'synthetic-account', object: { id: lesson.sessionId, session_id: lesson.sessionId, session_key: lesson.id, ...object } } });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = `v0=${createHmac('sha256', webhookSecret).update(`v0:${timestamp}:${body}`).digest('hex')}`;
  const response = await fetch(`${origin}/api/recordings/zoom/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-zm-request-timestamp': timestamp, 'x-zm-signature': signature }, body });
  expect(response.status).toBe(200);
}
const zoomUser = (userKey, uuid, times = {}) => ({ user: { id: '16778240', name: 'Synthetic Display Name', user_key: userKey, participant_uuid: uuid, join_time: new Date().toISOString(), ...times } });

let browser;
try {
  browser = await chromium.launch({ headless: process.env.IHEAR_HEADED !== '1', slowMo: Number(process.env.IHEAR_E2E_SLOWMO || 0) });
  const context = await localContext(browser, origin, { email: owner, secret, external: report.externalRequests });
  const admin = await context.newPage();
  admin.on('pageerror', error => report.pageProblems.push(error.message));
  admin.on('console', message => { if (message.type() === 'error') report.pageProblems.push(message.text()); });
  await admin.goto(`${origin}/admin/classrooms`);
  await expect(admin.getByRole('heading', { name: '教室總覽', level: 1 })).toBeVisible();
  const post = (url, body = {}) => admin.evaluate(async ([address, data]) => {
    const response = await fetch(address, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) });
    return response.status;
  }, [url, body]);
  const card = code => admin.locator('.classroom-card', { hasText: code });
  const refresh = async () => { await admin.reload(); await expect(admin.getByRole('heading', { name: '教室總覽', level: 1 })).toBeVisible(); };
  // A TEST- lesson starting this many minutes from now, with consent for both people.
  async function lessonFrom(code, minutes, n) {
    const { date, time } = taipei(minutes);
    expect(await post('/api/admin/classrooms', { code, date, time, minutes: 60, tutorCode: `TEST-CT${n}`, tutorEmail: tutor, studentCode: `TEST-CS${n}` })).toBe(201);
    expect(await post('/api/admin/classrooms/consents', { personCode: `TEST-CS${n}`, role: 'student', status: 'granted' })).toBe(200);
    expect(await post('/api/admin/classrooms/consents', { personCode: `TEST-CT${n}`, role: 'tutor' })).toBe(200);
    const lesson = (await saved()).lessons.find(entry => entry.code === code);
    return {
      id: lesson.id, code, date, sessionId: `SYN-SESSION-${lesson.id}`, startsAt: lesson.startsAt, endsAt: lesson.endsAt,
      tutorId: lesson.participants.find(entry => entry.role === 'tutor').id, studentId: lesson.participants.find(entry => entry.role === 'student').id,
    };
  }
  async function bothIn(lesson) {
    await zoom('session.started', lesson, { start_time: new Date().toISOString() });
    await zoom('session.user_joined', lesson, zoomUser(lesson.tutorId, `U-T-${lesson.code}`));
    await zoom('session.user_joined', lesson, zoomUser(lesson.studentId, `U-S-${lesson.code}`));
  }

  const live = await lessonFrom('TEST-UC1', -5, 1);
  await check('a lesson being recorded offers the emergency stop on its card', async () => {
    await bothIn(live);
    for (let i = 0; i < 2; i++) expect(await post('/api/admin/classrooms/tick')).toBe(200);
    await expect.poll(() => calls(live.id)).toEqual(['recording.start']);
    await zoom('session.recording_started', live, { recording_file: { recording_start: new Date().toISOString() } });
    await refresh();
    await expect(card(live.code)).toContainText('錄影中');
    await expect(card(live.code).getByRole('button', { name: '緊急停止錄影' })).toBeVisible();
    await admin.screenshot({ path: path.join(directory, 'controls-1-recording.png'), fullPage: true });
  });

  await check('one press and a confirmation stop it at once; the card says so and the button goes', async () => {
    let asked = null;
    admin.once('dialog', dialog => { asked = dialog.message(); dialog.accept(); });
    const [response] = await Promise.all([
      admin.waitForResponse(item => item.url().endsWith('/stop-recording')),
      card(live.code).getByRole('button', { name: '緊急停止錄影' }).click(),
    ]);
    expect(response.status()).toBe(200);
    expect(asked).toContain('確定要立即停止這堂課的錄影嗎');
    expect(await calls(live.id)).toEqual(['recording.start', 'recording.stop']);
    await expect(card(live.code)).toContainText('已按下緊急停止');
    // Asked, not confirmed: never shown as stopped before the video service says so.
    await expect(card(live.code)).toContainText('等待視訊服務確認（尚未確認停止）');
    await expect(card(live.code)).not.toContainText('視訊服務已確認錄影停止');
    await expect(card(live.code).getByRole('button', { name: '緊急停止錄影' })).toHaveCount(0);
    await zoom('session.recording_stopped', live, { recording_file: { recording_end: new Date().toISOString() } });
    await refresh();
    await expect(card(live.code)).toContainText('視訊服務已確認錄影停止');
    await admin.screenshot({ path: path.join(directory, 'controls-2-emergency.png'), fullPage: true });
  });

  const waiting = await lessonFrom('TEST-UC3', 30, 3);
  await check('a dismissed confirmation sends nothing', async () => {
    await refresh();
    admin.once('dialog', dialog => dialog.dismiss());
    let sent = false;
    admin.on('request', request => { if (request.url().endsWith('/stop-recording')) sent = true; });
    await card(waiting.code).getByRole('button', { name: '緊急停止錄影' }).click();
    await admin.waitForTimeout(500);
    expect(sent).toBe(false);
    await expect(card(waiting.code)).not.toContainText('已按下緊急停止');
  });

  const ended = await lessonFrom('TEST-UC2', -70, 2);
  await check('a finished lesson lists its recording, filed into its own folder inside the month folder', async () => {
    await bothIn(ended);
    // The tick decides recording for the lesson; it is past its end, so nothing is started.
    expect(await post('/api/admin/classrooms/tick')).toBe(200);
    expect(await calls(ended.id)).toEqual([]);
    await zoom('session.user_left', ended, zoomUser(ended.studentId, `U-S-${ended.code}`, { leave_time: new Date().toISOString(), leave_reason: 'left the session' }));
    await zoom('session.user_left', ended, zoomUser(ended.tutorId, `U-T-${ended.code}`, { leave_time: new Date().toISOString(), leave_reason: 'left the session' }));
    await zoom('session.ended', ended, { end_time: new Date().toISOString() });
    // The recording runs after the server's decision for this lesson (made by the tick above), as
    // a real one does: consent never covers a recording that began before it (2026-11-08), and
    // this lesson's consent is only entered by this test.
    const video = {
      id: `SYN-FILE-${ended.id}`, recording_type: 'shared_screen_with_speaker_view', file_extension: 'MP4', file_type: 'MP4', file_size: 3 * 1024 * 1024, status: 'completed',
      recording_start: new Date().toISOString(), recording_end: new Date(Date.now() + 60_000).toISOString(),
    };
    await zoom('session.recording_completed', ended, { recording_files: [video] });
    const [year, month] = ended.date.split('-');
    const folder = `[iHear] ${month}.${year}.Zoom Recordings / ${ended.date}_TEST-UC2`;
    // Synthetic: the local stand-in, and it says so; never "Google Drive".
    await expect.poll(async () => { await refresh(); return card(ended.code).textContent(); }, { timeout: 30000 }).toContain('已存入本機模擬 Drive（合成測試，不是 Google Drive）');
    await expect(card(ended.code).locator('.classroom-files')).not.toContainText('已存入 Google Drive');
    await expect(card(ended.code).locator('.classroom-files')).toContainText(`${folder} / ${ended.date}_TEST-CS2_TEST-CT2_P01.mp4`);
    await expect(card(ended.code).locator('.classroom-files')).toContainText('3.0 MB');
    // The local stand-in has no page to open.
    await expect(card(ended.code).getByRole('link', { name: '在 Google 雲端硬碟開啟' })).toHaveCount(0);
    await expect(card(ended.code).getByRole('button', { name: '緊急停止錄影' })).toHaveCount(0);
    await admin.screenshot({ path: path.join(directory, 'controls-3-filed.png'), fullPage: true });
  });

  // 2026-11-08: a link reissued while recording moves the lesson to a new room. Nothing records
  // there on its own; the owner's button appears only once the old room is confirmed stopped,
  // and pressing it has the server check again before it starts, in the new room only.
  const moved = await lessonFrom('TEST-UC4', -5, 4);
  const newRoom = `SYN-SESSION-${moved.id}-G1`;
  const inRoom = async (type, sessionId, object = {}) => zoom(type, { ...moved, sessionId }, object);
  const sentTo = async () => JSON.parse(await readFile(path.join(directory, 'synthetic-zoom.json'), 'utf8').catch(() => '{"calls":[]}')).calls
    .filter(call => call.lessonId === moved.id).map(call => [call.type, call.detail ?? null]);
  await check('after a reissue during a recording, the new room records only once the old room is confirmed stopped and an owner authorizes it; the server checks again first and starts in the new room only', async () => {
    await bothIn(moved);
    for (let i = 0; i < 2; i++) expect(await post('/api/admin/classrooms/tick')).toBe(200);
    await expect.poll(() => calls(moved.id)).toEqual(['recording.start']);
    await zoom('session.recording_started', moved, { recording_file: { recording_start: new Date().toISOString() } });
    const reissued = await admin.evaluate(async address => (await fetch(address, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'reissue_link' }) })).status, `/api/admin/classrooms/${moved.id}`);
    expect(reissued).toBe(200);
    const newStudent = (await saved()).lessons.find(entry => entry.id === moved.id).participants.find(entry => entry.role === 'student').id;
    expect(newStudent).not.toBe(moved.studentId);
    await inRoom('session.started', newRoom, { session_name: `ihear-${moved.id.toLowerCase()}-g1`, start_time: new Date().toISOString() });
    await inRoom('session.user_joined', newRoom, zoomUser(moved.tutorId, `U-T2-${moved.code}`));
    await inRoom('session.user_joined', newRoom, zoomUser(newStudent, `U-S2-${moved.code}`));
    expect(await post('/api/admin/classrooms/tick')).toBe(200);
    await refresh();
    // The old room's recording is asked to stop, not confirmed: no button yet, and no start anywhere.
    await expect(card(moved.code)).toContainText('新教室不會自動錄影，需要擁有者授權並重新確認同意');
    await expect(card(moved.code).getByRole('button', { name: '授權在新教室錄影' })).toHaveCount(0);
    expect((await sentTo()).filter(([type]) => type === 'recording.start')).toEqual([['recording.start', moved.sessionId]]);
    await zoom('session.recording_stopped', moved, { recording_file: { recording_end: new Date().toISOString() } });
    await refresh();
    const button = card(moved.code).getByRole('button', { name: '授權在新教室錄影' });
    await expect(button).toBeVisible();
    await admin.screenshot({ path: path.join(directory, 'controls-4-room-moved.png'), fullPage: true });
    let asked = null;
    admin.once('dialog', dialog => { asked = dialog.message(); dialog.accept(); });
    const [response] = await Promise.all([admin.waitForResponse(item => item.url().endsWith('/resume-recording')), button.click()]);
    expect(response.status()).toBe(200);
    expect(asked).toContain('伺服器會先重新確認課程、名單和每一份同意');
    expect((await sentTo()).filter(([type]) => type === 'recording.start')).toEqual([['recording.start', moved.sessionId], ['recording.start', newRoom]]);
    await refresh();
    await expect(card(moved.code)).toContainText('重新確認通過，可以在新教室錄影');
    await expect(card(moved.code).getByRole('button', { name: '授權在新教室錄影' })).toHaveCount(0);
    await admin.screenshot({ path: path.join(directory, 'controls-5-authorized.png'), fullPage: true });
  });

  await check('nothing left this computer, and the page reported no errors', async () => {
    expect(report.externalRequests).toEqual([]);
    expect(report.pageProblems).toEqual([]);
  });
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.error = error.message;
  process.exitCode = 1;
} finally {
  await browser?.close();
  server.child.kill();
  report.finishedAt = new Date().toISOString();
  await writeFile(path.join(directory, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`${report.status.toUpperCase()}: ${report.checks.filter(item => item.status === 'passed').length}/${report.checks.length} checks. Screenshots and report: ${directory}`);
}
