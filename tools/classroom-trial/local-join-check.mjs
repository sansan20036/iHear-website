// The local join check (2026-10-30): the trial server on this computer with the Zoom Video SDK
// trial keys, and two browsers here, the tutor and the student with Chromium's fake camera and
// microphone, joining one real Zoom session through the personal links and pages a tester uses.
// Nothing is tunneled: the browsers reach only this computer and Zoom. Run it before any tunnel.
//
// It checks that both connect, each sees the other's camera and microphone, the tutor's whiteboard
// opens and the student sees it, the tutor's page says "not recorded", and leaving really closes the
// room for each person (the student first, so the tutor can see them go). It also checks that no
// vendor secret reaches a browser, Zoom, the server's output or a file: each join answer is read
// before the page may use it, so a key and a secret entered the wrong way round never leave here.
//
// Nothing it prints or writes holds a key, a secret, a join token or a personal link: only names,
// yes/no answers, counts and host names, in a new folder under %LOCALAPPDATA%\iHear-classroom-trial.
//
// Usage (from the repository root, after `next build`):
//   node tools/classroom-trial/local-join-check.mjs --env <zoom.env outside the repository> [--headed]
//   node tools/classroom-trial/local-join-check.mjs --rehearsal
//     (stand-in keys and no route to Zoom's session servers, so the join must fail safely: this
//     checks the script itself without using the account)
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';
import { readVendorEnv, SECRET_KEYS } from './env-file.mjs';
/* global document -- read inside the two pages, through page.evaluate */

const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, all) => (value.startsWith('--') ? [...pairs, [value.slice(2), all[index + 1]?.startsWith('--') ? 'true' : all[index + 1] ?? 'true']] : pairs), []));
const root = process.cwd();
const rehearsal = args.rehearsal === 'true';
const pub = 3320, loc = 3321;
const origin = `http://localhost:${pub}`;
const startedAt = Date.now();
const stamp = new Date(startedAt).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
const runDir = path.join(process.env.LOCALAPPDATA ?? tmpdir(), 'iHear-classroom-trial', `join-check-${stamp}`);
mkdirSync(runDir, { recursive: true });

// Stand-in keys for a rehearsal; otherwise the file the account holder filled in.
const ZOOM_KEYS = ['ZOOM_VIDEO_SDK_KEY', 'ZOOM_VIDEO_SDK_SECRET', 'ZOOM_VIDEO_SDK_API_KEY', 'ZOOM_VIDEO_SDK_API_SECRET', 'ZOOM_VIDEO_SDK_WEBHOOK_SECRET'];
const envFile = rehearsal ? path.join(runDir, 'rehearsal.env') : args.env;
if (rehearsal) writeFileSync(envFile, ['CLASSROOM_PROVIDER=zoom-video-sdk', ...ZOOM_KEYS.map(name => `${name}=REHEARSAL${randomBytes(16).toString('hex')}`)].join('\n'));
if (!envFile || envFile === 'true') throw new Error('Give --env <zoom.env outside the repository>, or --rehearsal');
const settings = readVendorEnv(envFile, root);
if (settings.CLASSROOM_PROVIDER !== 'zoom-video-sdk') throw new Error('This check is for CLASSROOM_PROVIDER=zoom-video-sdk');

// What must not leak, and what is never printed: the secrets, the SDK key, each personal link's token.
const secrets = SECRET_KEYS.map(name => settings[name]).filter(Boolean);
const sdkKey = settings.ZOOM_VIDEO_SDK_KEY;
const hidden = new Set([...secrets, sdkKey]);
const TOKEN = /[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g;
const holds = text => secrets.some(value => text.includes(value));
// A secret inside a token counts too: a token's header and claims are base64url.
const leaks = text => holds(text) || [...text.matchAll(TOKEN)].some(([token]) => token.split('.').slice(0, 2).some(part => holds(Buffer.from(part, 'base64url').toString('latin1'))));
// Everything this script prints or writes passes through here.
const redact = text => {
  let out = String(text);
  for (const value of hidden) out = out.split(value).join('[hidden]');
  return out.replace(TOKEN, '[token]').replace(/(https?:\/\/[^\s"'<>?]+)\?[^\s"'<>]*/g, '$1?[hidden]');
};

const report = { mode: rehearsal ? 'rehearsal: stand-in keys, no route to Zoom session servers' : 'real: the Zoom Video SDK trial keys', startedAt: new Date(startedAt).toISOString(), checks: [], findings: {}, cspProblems: [], consoleProblems: [], alerts: [], status: 'running' };
// The two pages, for screenshots and the room's own alerts when a check fails.
const pages = [];
const found = { browserResponses: 0, requestsToOutside: 0, pageAndStorage: 0, joinAnswersStopped: 0, serverOutput: 0, runFiles: 0, filesWrittenDuringRun: 0, filesGitCouldCommit: 0 };
const key = { tokensChecked: 0, tokensNamingTheKey: 0, plainInResponses: 0, plainInServerOutput: 0 };
let failure;
// A check that fails stops the run unless it is marked { fatal: false }; the leak scans always run.
const elapsed = () => `${Math.round((Date.now() - startedAt) / 1000)}s`;
async function check(name, action, { fatal = true } = {}) {
  console.log(`[${elapsed()}] ${name} …`);
  try { await action(); report.checks.push({ name, status: 'passed' }); console.log(`[${elapsed()}] PASS ${name}`); }
  catch (error) {
    report.checks.push({ name, status: 'failed', error: redact(error.message) });
    console.log(`[${elapsed()}] FAIL ${name}: ${redact(error.message).split('\n')[0]}`);
    const slug = name.replace(/[^A-Za-z0-9]+/g, '-').slice(0, 40);
    for (const { who, page } of pages) {
      await page.screenshot({ path: path.join(runDir, `failed-${slug}-${who}.png`), fullPage: true }).catch(() => undefined);
      const alerts = await page.locator('[role="alert"]').allInnerTexts().catch(() => []);
      for (const text of alerts) report.alerts.push(`${who}, ${name}: ${redact(text).slice(0, 300)}`);
    }
    if (fatal) throw error;
    failure ??= error;
  }
}
const pause = ms => new Promise(resolve => { setTimeout(resolve, ms); });
// A wait that gives up after a while instead of holding the run open.
const within = (promise, ms) => Promise.race([promise, pause(ms)]);
const git = (...command) => spawnSync('git', command, { cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 2 ** 20 }).stdout;
const gitBefore = git('status', '--porcelain');

let server, serverOutput = '', browser;
const pending = [], bodies = [], hosts = new Set();
try {
  server = spawn(process.execPath, ['tools/classroom-trial/trial-server.mjs', '--env', envFile, '--public-port', String(pub), '--local-port', String(loc), '--data', path.join(runDir, 'server-data')],
    { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  for (const stream of [server.stdout, server.stderr]) stream.on('data', chunk => { serverOutput += chunk; });
  await check('the trial server starts with the env file', async () => {
    const until = Date.now() + 120_000;
    while (!serverOutput.includes('iHear classroom trial server')) {
      if (server.exitCode !== null || Date.now() > until) throw new Error(`The trial server did not start: ${redact(serverOutput.trim().split('\n').at(-1) ?? '')}`);
      await pause(250);
    }
  });

  let links;
  await check('a TEST- lesson starting in a minute gets its two personal links', async () => {
    // Taipei time, as the admin enters it; the room opens 15 minutes before the start.
    const start = new Date(Date.now() + 8 * 3600_000 + 60_000);
    const created = await fetch(`http://127.0.0.1:${loc}/trial/lessons`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ publicOrigin: origin, code: 'TEST-LJ1', tutorCode: 'TEST-LJT1', studentCode: 'TEST-LJS1', date: start.toISOString().slice(0, 10), time: start.toISOString().slice(11, 16), minutes: 15 }),
    });
    expect(created.status).toBe(201);
    links = await created.json();
    for (const link of [links.tutorLink, links.studentLink]) for (const value of new URL(link).searchParams.values()) hidden.add(value);
  });
  const lessonId = links.lesson.lessonId;

  browser = await chromium.launch({
    // The full Chromium build (also when headless), closer to the Chrome testers use than the
    // stripped-down headless shell.
    channel: 'chromium',
    headless: args.headed !== 'true',
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
      // A rehearsal cannot reach Zoom's session servers: only this computer and Zoom's file server resolve.
      ...(rehearsal ? ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE source.zoom.us'] : [])],
  });
  const person = async who => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'zh-TW', permissions: ['camera', 'microphone'] });
    context.setDefaultTimeout(60_000);
    // Each join answer is read here first; one carrying a secret never reaches the page, or Zoom.
    await context.route(`${origin}/api/classroom/*/join`, async route => {
      const response = await route.fetch();
      const text = await response.text();
      if (leaks(text)) { found.joinAnswersStopped += 1; return route.abort(); }
      for (const [token] of text.matchAll(TOKEN)) {
        key.tokensChecked += 1;
        if (Buffer.from(token.split('.')[1], 'base64url').toString('utf8').includes(sdkKey)) key.tokensNamingTheKey += 1;
      }
      return route.fulfill({ response, body: text });
    });
    context.on('request', request => {
      const url = request.url();
      if (!/^(https?|wss?):/.test(url)) return;
      hosts.add(new URL(url).host);
      let body = '';
      try { body = request.postData() ?? ''; } catch { body = ''; }
      if (!url.startsWith(origin) && leaks(`${url}\n${body}`)) found.requestsToOutside += 1;
    });
    context.on('response', response => {
      if (!response.url().startsWith(origin)) return;
      // Redirects have no body; any other answer whose body never arrives is listed by path.
      const entry = { path: `${response.request().method()} ${new URL(response.url()).pathname} ${response.status()}`, done: response.status() >= 300 && response.status() < 400 };
      bodies.push(entry);
      pending.push(response.body().then(body => {
        const text = body.toString('latin1');
        if (leaks(text)) found.browserResponses += 1;
        if (text.includes(sdkKey)) key.plainInResponses += 1;
        entry.done = true;
      }, () => undefined));
    });
    const page = await context.newPage();
    page.on('websocket', socket => hosts.add(new URL(socket.url()).host));
    // The page's own errors and warnings (Zoom's included), redacted, for working out a failure.
    page.on('console', message => {
      const text = redact(message.text()).slice(0, 300);
      if (/Content Security Policy|Refused to/i.test(text)) report.cspProblems.push(text);
      else if (['error', 'warning'].includes(message.type()) && report.consoleProblems.length < 60) report.consoleProblems.push(`${who}: ${message.type()}: ${text}`);
    });
    page.on('pageerror', error => { if (report.consoleProblems.length < 60) report.consoleProblems.push(`${who}: page error: ${redact(error.message).slice(0, 300)}`); });
    pages.push({ who, page });
    return { context, page };
  };
  const tutor = await person('tutor'), student = await person('student');
  const enter = async (who, link) => {
    await who.page.goto(link);
    await expect(who.page).toHaveURL(new RegExp(`^${origin}/classroom/${lessonId}(\\?|$)`));
    await who.page.getByRole('button', { name: '進入教室' }).click();
    await expect(who.page.locator('.classroom-vendor-stage.zoom-video-sdk')).toBeAttached();
  };
  await check('the tutor\'s trial sign-in link and the student\'s personal link open the room', async () => {
    await enter(tutor, links.tutorLink);
    await enter(student, links.studentLink);
  });

  if (rehearsal) {
    await check('rehearsal: with stand-in keys and no route to Zoom, the join fails safely', async () => {
      for (const who of [tutor, student]) await expect(who.page.locator('.classroom-room-connection')).toHaveText('連線失敗', { timeout: 120_000 });
    });
  } else {
    await check('both join the real Zoom session and connect', async () => {
      for (const who of [tutor, student]) await expect(who.page.locator('.classroom-room-connection')).toHaveText('已連線', { timeout: 90_000 });
    });
    // Pressed the moment both have connected, both people at once: before the room waited for
    // Zoom's own reports and offered "Try again", the tutor's first device never started this way.
    // A press that shows the room's message gets "Try again", as a person would, up to twice.
    report.findings.devicePresses = 'both people at once, the moment both had connected; up to 2 retries each';
    const turnOn = async (kind, finding) => {
      const outcomes = await Promise.all([['tutor', tutor], ['student', student]].map(async ([label, who]) => {
        const button = who.page.getByRole('button', { name: new RegExp(`^${kind}：`) });
        const problem = who.page.locator(`[data-device-problem^="${finding}:"]`);
        const problems = [];
        await button.click();
        for (let tries = 0; tries <= 2; tries += 1) {
          // Exactly "on": while starting the button reads 開啟中…, which also begins with 開.
          await expect(button.filter({ hasText: new RegExp(`^${kind}：開$`) }).or(problem)).toBeVisible({ timeout: 20_000 }).catch(() => undefined);
          if ((await button.textContent()) === `${kind}：開`) return `${label} on ${problems.length ? `after ${problems.length} retry(ies): ${problems.join(', ')}` : 'at the first press'}`;
          if (!(await problem.isVisible())) break;
          problems.push(String(await problem.getAttribute('data-device-problem')).split(':')[1]);
          await problem.getByRole('button').click();
        }
        return `${label} NOT on (${problems.join(', ') || 'no answer'})`;
      }));
      report.findings[finding] = outcomes.join('; ');
      if (outcomes.some(outcome => outcome.includes('NOT on'))) throw new Error(`${kind} did not turn on for everyone: ${outcomes.join('; ')}`);
    };
    await check('both turn on the camera, and each sees the other\'s video', async () => {
      await turnOn('攝影機', 'camera');
      for (const [label, who] of [['tutor', tutor], ['student', student]]) {
        await expect(who.page.locator('.classroom-room-tile.remote')).toContainText('攝影機開啟', { timeout: 45_000 });
        // Zoom draws both videos, this person's own and the other's, in the room's video container
        // (in the real trial it also kept an element of its own there, so: at least two).
        const videos = who.page.locator('video-player-container.classroom-zoom-videos > *');
        await expect.poll(() => videos.count(), { timeout: 45_000 }).toBeGreaterThanOrEqual(2);
        report.findings[`videoElements_${label}`] = (await videos.evaluateAll(nodes => nodes.map(node => node.tagName.toLowerCase()))).join(' ');
      }
      await pause(3000);
      await tutor.page.screenshot({ path: path.join(runDir, 'tutor-room.png'), fullPage: true });
      await student.page.screenshot({ path: path.join(runDir, 'student-room.png'), fullPage: true });
    }, { fatal: false });
    await check('both turn on the microphone, and each sees the other\'s as on', async () => {
      await turnOn('麥克風', 'microphone');
      for (const who of [tutor, student]) await expect(who.page.locator('.classroom-room-tile.remote')).toContainText('麥克風開啟', { timeout: 45_000 });
    }, { fatal: false });
    await check('whiteboard: the tutor opens it and the student sees it', async () => {
      const button = tutor.page.locator('[data-tool="whiteboard"]');
      await button.click();
      const presenting = tutor.page.getByText('你正在主持白板，對方會同時看到。');
      const refused = tutor.page.getByText(/^白板無法開啟/);
      await expect(presenting.or(refused)).toBeVisible({ timeout: 45_000 });
      if (await refused.isVisible()) {
        report.findings.whiteboard = 'refused: Zoom did not open the whiteboard (the account may not have it enabled)';
        throw new Error('Zoom refused to open the whiteboard: check that whiteboard is enabled for the Video SDK account');
      }
      await expect(student.page.getByText('正在顯示小老師的白板。')).toBeVisible({ timeout: 45_000 });
      report.findings.whiteboard = 'opened by the tutor and shown to the student';
      await pause(2000);
      await student.page.screenshot({ path: path.join(runDir, 'student-whiteboard.png'), fullPage: true });
      await button.click();
      await expect(button).toHaveText('開啟白板', { timeout: 30_000 });
    }, { fatal: false });
  }

  await check('the tutor\'s page says this lesson is not recorded', async () => {
    await expect(tutor.page.locator('.classroom-room-recording')).toContainText('不錄影', { timeout: 45_000 });
    await expect(tutor.page.getByText('這堂課不錄影。')).toBeVisible();
  }, { fatal: false });
  await check('no secret in either page, its storage or its cookies', async () => {
    for (const who of [tutor, student]) {
      const state = await who.page.evaluate(() => JSON.stringify({ html: document.documentElement.outerHTML, local: { ...localStorage }, session: { ...sessionStorage } }));
      if (leaks(state) || leaks(JSON.stringify(await who.context.cookies()))) found.pageAndStorage += 1;
    }
    expect(found.pageAndStorage).toBe(0);
  }, { fatal: false });
  // Leaving must close the room for that person, not only take the click: it says so, offers to
  // re-enter, and the room's connection, video stage and leave button are gone.
  const leaves = async who => {
    await who.page.getByRole('button', { name: '離開教室' }).click();
    await expect(who.page.getByText('你已離開教室。')).toBeVisible({ timeout: 30_000 });
    await expect(who.page.getByRole('button', { name: '重新進入' })).toBeVisible();
    for (const gone of ['.classroom-room-connection', '.classroom-vendor-stage']) await expect(who.page.locator(gone)).toHaveCount(0);
    await expect(who.page.getByRole('button', { name: '離開教室' })).toHaveCount(0);
  };
  await check('the student leaves: the room closes and offers to re-enter', () => leaves(student), { fatal: false });
  // A rehearsal has no session, so nobody there can see the other person go.
  if (!rehearsal) {
    await check('the tutor sees that the student left, and stays connected', async () => {
      await expect(tutor.page.locator('.classroom-room-tile.remote')).toContainText('對方已離開教室。', { timeout: 45_000 });
      await expect(tutor.page.locator('.classroom-room-connection')).toHaveText('已連線');
    }, { fatal: false });
  }
  await check('the tutor leaves: the room closes and offers to re-enter', () => leaves(tutor), { fatal: false });
  await pause(3000);
} catch (error) {
  failure ??= error;
} finally {
  await within(Promise.all(pending), 15_000);
  await within(browser?.close().catch(() => undefined), 15_000);
  if (server && server.exitCode === null) {
    server.kill();
    await new Promise(resolve => { server.once('exit', resolve); setTimeout(resolve, 5000); });
  }
  // The server's own output, every file of this run, and the checkout.
  if (leaks(serverOutput)) found.serverOutput += 1;
  if (serverOutput.includes(sdkKey)) key.plainInServerOutput += 1;
  writeFileSync(path.join(runDir, 'server-output.log'), redact(serverOutput));
  const walk = (dir, skip) => readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    if (skip(full)) return [];
    return entry.isDirectory() ? walk(full, skip) : entry.isFile() ? [full] : [];
  });
  const count = (files, test) => files.filter(file => { try { return statSync(file).size < 256 * 2 ** 20 && test(readFileSync(file).toString('latin1')); } catch { return false; } }).length;
  found.runFiles = count(walk(runDir, full => full === envFile), leaks);
  // Anything written in the checkout during the run, ignored folders such as .next included.
  found.filesWrittenDuringRun = count(walk(root, full => /[\\/](node_modules|\.git)$/.test(full)).filter(file => statSync(file).mtimeMs >= startedAt), leaks);
  // Every file Git could commit here: tracked, or new and not ignored.
  found.filesGitCouldCommit = count(git('ls-files', '-z', '-co', '--exclude-standard').split('\0').filter(Boolean).map(file => path.join(root, file)), holds);
  report.gitStatusUnchanged = git('status', '--porcelain') === gitBefore;
  report.responsesScanned = { scanned: bodies.filter(entry => entry.done).length, total: bodies.length, notScanned: bodies.filter(entry => !entry.done).map(entry => redact(entry.path)) };
  report.hosts = [...hosts].sort();
  report.secretsFound = found;
  report.sdkKey = key;
  report.finishedAt = new Date().toISOString();
  const clean = Object.values(found).every(value => value === 0) && report.gitStatusUnchanged;
  report.status = failure || !clean ? 'failed' : 'passed';
  if (failure) report.error = redact(failure.message);
  writeFileSync(path.join(runDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`\nLocal join check (${report.mode}): ${report.status.toUpperCase()}`);
  for (const [name, value] of Object.entries(report.findings)) console.log(`  ${name}: ${value}`);
  console.log(`  hosts the browsers contacted: ${report.hosts.join(', ')}`);
  if (report.cspProblems.length) console.log(`  blocked by the page's content security policy: ${report.cspProblems.length} (see the report)`);
  if (report.consoleProblems.length || report.alerts.length) console.log(`  page errors and warnings: ${report.consoleProblems.length}; room alerts: ${report.alerts.length} (see the report)`);
  console.log(`  secrets found: ${Object.entries(found).map(([name, value]) => `${name} ${value}`).join(', ')}`);
  const { scanned, total, notScanned } = report.responsesScanned;
  console.log(`  responses from this computer scanned: ${scanned} of ${total}${notScanned.length ? `; body never arrived: ${[...new Set(notScanned)].join(', ')}` : ''}`);
  console.log(`  SDK key: inside ${key.tokensNamingTheKey} of ${key.tokensChecked} join tokens (as Zoom requires); in plain text in ${key.plainInResponses} responses and ${key.plainInServerOutput ? 'the' : 'not the'} server output`);
  console.log(`  checkout unchanged by the run (git status): ${report.gitStatusUnchanged ? 'yes' : 'NO'}`);
  if (report.error) console.log(`  stopped at: ${report.error.split('\n')[0]}`);
  console.log(`  report and screenshots: ${runDir}`);
}
if (report.status !== 'passed') process.exit(1);
