// Browser check of R-8 (2026-11-08): the open classroom overview asks for a tick every 15
// seconds and after each change. Its tick now has an allowance of its own, apart from the owner's
// admin changes. With the overview open and its tick spent for the minute (as several open tabs
// or a stuck page could do), the owner still revokes, reissues and cancels with the overview's
// own buttons; the overview says honestly that it may lag, and recovers by itself once the minute
// is over. The built site with local storage and the synthetic provider; synthetic data only.
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';
import { localContext, startAcademyServer } from './helpers/academy-smoke.mjs';

const secret = 'classroom-ratelimit-smoke-key-never-use-in-production';
const owner = 'ratelimit-owner@example.test', tutor = 'ratelimit-tutor@example.test';
Object.assign(process.env, {
  CLASSROOM_PROVIDER: 'synthetic', CLASSROOM_DRIVE: 'local', CLASSROOM_WEBHOOK_SECRET: 'classroom-ratelimit-webhook-local-only',
  CLASSROOM_SYNTHETIC_SECRET: 'classroom-ratelimit-token-local-only', VERCEL_ENV: '',
});
const server = await startAcademyServer({ port: 3247, secret, owners: [owner], name: 'classroom-ratelimit' });
const { origin, directory } = server;
const report = { startedAt: new Date().toISOString(), synthetic: true, checks: [], externalRequests: [], pageProblems: [], limited: [], timings: {} };
const TICK = '/api/admin/classrooms/tick';

async function check(name, action) {
  try { await action(); report.checks.push({ name, status: 'passed' }); console.log(`PASS ${name}`); }
  catch (error) { report.checks.push({ name, status: 'failed', error: error.message }); throw error; }
}
const taipei = minutes => { const at = new Date(Date.now() + 8 * 3600_000 + minutes * 60_000); return { date: at.toISOString().slice(0, 10), time: at.toISOString().slice(11, 16) }; };

let browser;
let limitedConsole = 0;
try {
  browser = await chromium.launch({ headless: process.env.IHEAR_HEADED !== '1', slowMo: Number(process.env.IHEAR_E2E_SLOWMO || 0) });
  const context = await localContext(browser, origin, { email: owner, secret, external: report.externalRequests });
  const admin = await context.newPage();
  admin.on('pageerror', error => report.pageProblems.push(error.message));
  admin.on('response', item => { if (item.status() === 429) report.limited.push(new URL(item.url()).pathname); });
  admin.on('console', message => {
    if (message.type() !== 'error') return;
    if (/Failed to load resource: the server responded with a status of 429/.test(message.text())) limitedConsole += 1;
    else report.pageProblems.push(message.text());
  });
  const post = (url, body = {}) => admin.evaluate(async ([address, data]) => {
    const response = await fetch(address, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) });
    return response.status;
  }, [url, body]);
  const lagging = admin.locator('.admin-alert[role="status"]', { hasText: '總覽可能落後' });
  const code = 'TEST-RL1';
  const row = () => admin.locator('.classroom-lessons tr', { hasText: code });
  // An overview button, its confirmation accepted; the change's own answer.
  const press = async name => {
    admin.once('dialog', dialog => dialog.accept());
    const [response] = await Promise.all([
      admin.waitForResponse(item => item.request().method() === 'PATCH' && item.url().includes('/api/admin/classrooms/')),
      row().getByRole('button', { name, exact: true }).click(),
    ]);
    return response.status();
  };

  let burstAt;
  await check('the overview\'s tick has its own limit: a burst of 70 ticks from the open overview is refused (429) once the minute\'s 60 are spent', async () => {
    await admin.goto(`${origin}/admin/classrooms`);
    await expect(admin.getByRole('heading', { name: '教室總覽', level: 1 })).toBeVisible();
    const { date, time } = taipei(30);
    expect(await post('/api/admin/classrooms', { code, date, time, minutes: 60, tutorCode: 'TEST-RLT1', tutorEmail: tutor, studentCode: 'TEST-RLS1' })).toBe(201);
    expect(await post('/api/admin/classrooms/consents', { personCode: 'TEST-RLS1', role: 'student', status: 'granted' })).toBe(200);
    await admin.reload();
    await expect(row()).toBeVisible();
    burstAt = Date.now();
    const answers = [];
    for (let n = 0; n < 70; n += 1) answers.push(await post(TICK));
    const refused = answers.filter(status => status === 429).length;
    report.timings.burst = { ok: answers.filter(status => status === 200).length, refused };
    expect(answers.every(status => status === 200 || status === 429)).toBe(true);
    // The page's own ticks came out of the same 60, so at least the last ten were refused.
    expect(refused).toBeGreaterThanOrEqual(10);
    expect(answers.at(-1)).toBe(429);
  });

  await check('with the tick spent, the owner revokes, reissues and cancels from the overview\'s buttons: each change is done (200), and the overview says it may lag', async () => {
    expect(await press('撤銷學生連結')).toBe(200);
    await expect(admin.locator('.classroom-notice')).toContainText('學生連結已撤銷');
    // The refresh after the change asked for a tick and was refused: the page says so.
    await expect(lagging).toBeVisible();
    expect(await press('重發學生連結')).toBe(200);
    await expect(admin.locator('.classroom-link code')).toContainText('#k=');
    expect(await press('取消課程')).toBe(200);
    await expect(row()).toContainText('已取消');
    expect(Date.now() - burstAt).toBeLessThan(45_000); // all inside the minute the tick was spent
    await admin.screenshot({ path: path.join(directory, 'ratelimit-1-changes-while-limited.png'), fullPage: true });
  });

  await check('once the minute is over, the overview\'s own refresh runs again and the lag notice goes by itself', async () => {
    await expect(lagging).toBeHidden({ timeout: 100_000 });
    report.timings.recoveredAfterSeconds = Math.round((Date.now() - burstAt) / 1000);
    await admin.screenshot({ path: path.join(directory, 'ratelimit-2-recovered.png'), fullPage: true });
  });

  await check('only the tick was ever refused; nothing left this computer, and the page reported no other errors', async () => {
    expect(report.limited.length).toBeGreaterThan(0);
    expect(report.limited.filter(pathname => pathname !== TICK)).toEqual([]);
    expect(limitedConsole).toBeLessThanOrEqual(report.limited.length);
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
