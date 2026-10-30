// The classroom trial server (tools/classroom-trial/trial-server.mjs) on this computer, before any
// tunnel: the public port shows only the classroom and only to holders of a personal link, the
// owner's admin stays on the local port, the tutor's trial sign-in link works also behind HTTPS
// tunnel headers, the env file is checked, logs carry paths only, and stopping ends access. The
// synthetic provider stands in for the vendor here; no account, key or outside address is used.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';

const pub = 3312, loc = 3313;
// Browsers use "localhost", the name Next gives this computer in a request's address.
const publicOrigin = `http://localhost:${pub}`, localOrigin = `http://localhost:${loc}`;
const work = await mkdtemp(path.join(tmpdir(), 'ihear-trial-test-'));
const report = { startedAt: new Date().toISOString(), checks: [], status: 'running' };
let browser, failure, child;

async function check(name, action) {
  try { await action(); report.checks.push({ name, status: 'passed' }); console.log(`PASS ${name}`); }
  catch (error) { report.checks.push({ name, status: 'failed', error: error.message }); throw error; }
}
// A raw request, so Host and the tunnel's forwarding headers can be set exactly.
function raw(port, method, pathname, headers = {}, body) {
  return new Promise((resolve, reject) => {
    const sent = httpRequest({ host: '127.0.0.1', port, method, path: pathname, headers }, response => {
      let text = '';
      response.on('data', chunk => { text += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, text }));
    });
    sent.on('error', reject);
    if (body) sent.write(body);
    sent.end();
  });
}
const refused = (args) => spawnSync(process.execPath, ['tools/classroom-trial/trial-server.mjs', ...args], { encoding: 'utf8', windowsHide: true, timeout: 60_000 });

try {
  await check('the env file may hold only the vendor settings, from outside the repository', async () => {
    const outside = path.join(work, 'trial.env');
    await writeFile(outside, 'CLASSROOM_PROVIDER=zoom-video-sdk\nCLASSROOM_TRIAL_CONSENT=1\n');
    expect(refused(['--env', outside]).stderr).toContain('not CLASSROOM_TRIAL_CONSENT');
    await writeFile(outside, 'CLASSROOM_PROVIDER=zoom-video-sdk\nPOSTGRES_URL=postgres://example.invalid/db\n');
    expect(refused(['--env', outside]).stderr).toContain('not POSTGRES_URL');
    expect(refused(['--env', 'package.json']).stderr).toContain('outside the repository');
    expect(refused([]).stderr).toContain('Give --env');
  });

  await check('the tunnel command points only at the public port and always names the testers (dry run, nothing opened)', async () => {
    const tunnel = args => spawnSync(process.execPath, ['tools/classroom-trial/start-tunnel.mjs', ...args, '--dry-run'], { encoding: 'utf8', windowsHide: true });
    expect(tunnel(['--allowed-mail', 'tester.one@example.org', '--allowed-mail', 'tester.two@example.org']).stdout.trim())
      .toBe('cloudflared tunnel --no-autoupdate --url http://127.0.0.1:3310 --allowed-mail tester.one@example.org --allowed-mail tester.two@example.org');
    expect(tunnel([]).stderr).toContain('Name every tester');
    expect(tunnel(['--allowed-mail', '*@example.org']).stderr).toContain('one full address');
    expect(tunnel(['--allowed-mail', 'tester.one@example.org', '--public-port', '3311']).stderr).toContain('never at the local admin port');
  });

  child = spawn(process.execPath, ['tools/classroom-trial/trial-server.mjs', '--provider', 'synthetic', '--public-port', String(pub), '--local-port', String(loc), '--data', path.join(work, 'data')], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = '';
  child.stdout.on('data', data => { logs += data; });
  child.stderr.on('data', data => { logs += data; });
  for (let attempt = 0; !logs.includes('trial server') && attempt < 240; attempt++) {
    if (child.exitCode !== null) throw new Error(`The trial server exited: ${logs}`);
    await new Promise(resolve => { setTimeout(resolve, 500); });
  }

  await check('the public port shows nothing but the classroom', async () => {
    for (const pathname of ['/', '/admin', '/admin/classrooms', '/api/admin/classrooms', '/api/auth/signin', '/api/auth/session', '/academy/courses', '/api/academy-content', '/trial/owner', '/events', '/classroom/L-unknown']) {
      expect([pathname, (await raw(pub, 'GET', pathname)).status]).toEqual([pathname, 404]);
    }
    expect((await raw(pub, 'POST', '/trial/lessons', { 'content-type': 'application/json' }, '{}')).status).toBe(404);
    expect((await raw(loc, 'GET', '/api/academy-content')).status).toBe(200);
  });

  const start = new Date(Date.now() + 8 * 3600_000 + 5 * 60_000);
  const lesson = { publicOrigin, date: start.toISOString().slice(0, 10), time: start.toISOString().slice(11, 16), minutes: 60, code: 'TEST-G1', tutorCode: 'TEST-GT1', studentCode: 'TEST-GS1' };
  let links;
  await check('the local port adds a TEST- lesson and returns the two links once; other codes are refused', async () => {
    const wrong = await raw(loc, 'POST', '/trial/lessons', { 'content-type': 'application/json' }, JSON.stringify({ ...lesson, studentCode: 'S-REAL1' }));
    expect([wrong.status, JSON.parse(wrong.text).error]).toEqual([400, 'Trial lessons use TEST- codes only (lesson, tutor and student)']);
    const added = await raw(loc, 'POST', '/trial/lessons', { 'content-type': 'application/json' }, JSON.stringify(lesson));
    expect(added.status).toBe(201);
    links = JSON.parse(added.text);
    expect(links.tutorLink).toMatch(new RegExp(`^${publicOrigin}/trial/tutor/L-[0-9a-f]{32}\\?t=[A-Za-z0-9_-]{43}$`));
    expect(links.studentLink).toMatch(new RegExp(`^${publicOrigin}/classroom/L-[0-9a-f]{32}\\?k=[A-Za-z0-9_-]{43}$`));
    const stored = await readFile(path.join(work, 'data', 'trial-invites.json'), 'utf8');
    expect(stored).not.toContain(new URL(links.tutorLink).searchParams.get('t'));
    expect(stored).not.toContain(new URL(links.studentLink).searchParams.get('k'));
  });

  const lessonPath = new URL(links.studentLink).pathname;
  const lessonId = lessonPath.split('/').pop();
  await check('without the right personal link the lesson reveals nothing', async () => {
    expect((await raw(pub, 'GET', lessonPath)).status).toBe(404);
    expect((await raw(pub, 'GET', `${lessonPath}?k=wrong`)).status).toBe(404);
    expect((await raw(pub, 'GET', `/trial/tutor/${lessonId}?t=wrong`)).status).toBe(404);
    expect((await raw(pub, 'POST', `/api/classroom/${lessonId}/join`, { 'content-type': 'application/json' }, '{}')).status).toBe(404);
  });

  browser = await chromium.launch({ headless: process.env.IHEAR_HEADED !== '1' });
  const outside = [];
  const context = async () => {
    const created = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'zh-TW' });
    created.setDefaultTimeout(20000);
    await created.route('**/*', route => {
      const url = route.request().url();
      if (url.startsWith(publicOrigin) || url.startsWith(localOrigin) || url.startsWith('data:') || url.startsWith('blob:')) return route.continue();
      outside.push(url);
      return route.abort();
    });
    return created;
  };

  await check('the student enters with the personal link; the page and its files load through the public port', async () => {
    const page = await (await context()).newPage();
    await page.goto(links.studentLink);
    await page.getByRole('button', { name: '進入教室' }).click();
    await expect(page.locator('.classroom-room-facts')).toContainText('學生 TEST-GS1');
    const accessCookie = (await page.context().cookies()).find(entry => entry.name === 'ihear_trial_access');
    expect(accessCookie?.httpOnly).toBe(true);
  });

  await check('the tutor enters with the trial sign-in link and reports to iHear (the recording card answers)', async () => {
    const page = await (await context()).newPage();
    await page.goto(links.tutorLink);
    await expect(page).toHaveURL(`${publicOrigin}${lessonPath}`);
    await page.getByRole('button', { name: '進入教室' }).click();
    await expect(page.locator('.classroom-room-facts')).toContainText('小老師 TEST-GT1');
    // Round 1 records nothing: no consent exists, so the server decides "not recorded".
    await expect(page.locator('.classroom-room-recording')).toContainText('不錄影（同意條件不符）');
  });

  await check('the owner\'s overview opens on the local port and shows the lesson', async () => {
    const page = await (await context()).newPage();
    await page.goto(`${localOrigin}/trial/owner`);
    await expect(page).toHaveURL(`${localOrigin}/admin/classrooms`);
    await expect(page.locator('.classroom-card', { hasText: 'TEST-G1' })).toBeVisible();
  });

  await check('behind a tunnel\'s HTTPS headers the tutor link gives secure cookies and entry works', async () => {
    const host = 'trial-check.example';
    const tunnel = { host, 'x-forwarded-proto': 'https' };
    const signIn = await raw(pub, 'GET', new URL(links.tutorLink).pathname + new URL(links.tutorLink).search, tunnel);
    expect(signIn.status).toBe(303);
    const cookies = signIn.headers['set-cookie'];
    expect(cookies.some(value => value.startsWith('__Secure-authjs.session-token=') && /; Secure/.test(value) && /HttpOnly/.test(value))).toBe(true);
    expect(cookies.some(value => value.startsWith('ihear_trial_access=') && /; Secure/.test(value))).toBe(true);
    const sent = cookies.map(value => value.split(';')[0]).join('; ');
    const join = await raw(pub, 'POST', `/api/classroom/${lessonId}/join`, { ...tunnel, origin: `https://${host}`, cookie: sent, 'content-type': 'application/json' }, '{}');
    expect([join.status, JSON.parse(join.text).role]).toEqual([200, 'tutor']);
    const foreign = await raw(pub, 'POST', `/api/classroom/${lessonId}/join`, { ...tunnel, origin: 'https://elsewhere.example', cookie: sent, 'content-type': 'application/json' }, '{}');
    expect(foreign.status).toBe(404);
    // Cloudflare's own signal for HTTPS works the same way.
    const cloudflare = { host, 'cf-visitor': '{"scheme":"https"}' };
    const again = await raw(pub, 'GET', new URL(links.tutorLink).pathname + new URL(links.tutorLink).search, cloudflare);
    const cfCookies = again.headers['set-cookie'].map(value => value.split(';')[0]).join('; ');
    const cfJoin = await raw(pub, 'POST', `/api/classroom/${lessonId}/join`, { ...cloudflare, origin: `https://${host}`, cookie: cfCookies, 'content-type': 'application/json' }, '{}');
    expect([again.headers['set-cookie'].some(value => value.startsWith('__Secure-authjs.session-token=')), cfJoin.status]).toEqual([true, 200]);
  });

  await check('the logs keep paths and statuses only, never a link\'s secret; nothing outside was requested', async () => {
    const publicLog = await readFile(path.join(work, 'data', 'public-requests.log'), 'utf8');
    for (const secret of [new URL(links.tutorLink).searchParams.get('t'), new URL(links.studentLink).searchParams.get('k')]) expect(publicLog).not.toContain(secret);
    expect(publicLog).not.toMatch(/[?&](k|t)=/);
    // Every file the room page needed was served (no 404 except the probes above).
    const missing = publicLog.split('\n').filter(line => / 404$/.test(line) && /\/_next\//.test(line));
    expect(missing).toEqual([]);
    expect(outside).toEqual([]);
  });

  await check('stopping the server ends every link at once', async () => {
    child.kill();
    await new Promise(resolve => { child.once('exit', resolve); setTimeout(resolve, 5000); });
    const after = await fetch(links.studentLink).then(() => 'answered', () => 'refused');
    expect(after).toBe('refused');
  });
  report.status = 'passed';
} catch (error) {
  failure = error;
  report.status = 'failed';
  report.error = error.message;
} finally {
  await browser?.close();
  if (child && child.exitCode === null) child.kill();
  report.finishedAt = new Date().toISOString();
  await writeFile(path.join(work, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Report: ${path.join(work, 'report.json')}`);
}
if (failure) { console.error(failure); process.exit(1); }
