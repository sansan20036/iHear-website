// W1 (Classroom 3.0 round 9, 2026-11-22): a fixed room on real Zoom, and its offline rehearsal. The
// fixed-room variant of local-join-check.mjs, with the same safeguards (every join answer read
// before the page may use it, nothing printed or written that holds a key, a secret, a token or a
// link, the checkout checked unchanged), on the trial server's --fixed-rooms mode.
//
// Three test people (TestA and TestB on desktop Chromium, TestC on an emulated tablet) ask at a
// room's door; the owner lets them in from the admin page; each enters. Then, on real Zoom only:
// who gets the whiteboard (Zoom's own canStartWhiteboard: the button), whether it opens and the
// others see it; sharing one at a time; a dropped connection coming back; leaving and entering
// again; taking a person out (the room moves to a new Zoom session); no chat; the owner ending the
// lesson. Nobody's camera, microphone or sound is ever pressed, and nothing can record: the trial
// server never sets the fixed rooms' recording switch, every token is a participant's (role 0,
// no recording claim), and the real run needs the W0 review of the account's recording settings.
//
// Usage (from the repository root, after `next build`):
//   node tools/classroom-trial/fixed-room-check.mjs --rehearsal
//     (stand-in keys and no route to Zoom's session servers: the joins must fail safely; checks
//      the doors, the admin page, the cleanup and the leak scans without using the account)
//   node tools/classroom-trial/fixed-room-check.mjs --env <zoom.env outside the repository> \
//     --w0 <W0 review file> --go "<the user's order, in their words, with the date>" [--headed]
//     The real run refuses to start unless the W0 review file exists and says "W0: PASS", and the
//     order contains 「開始 W1 真實測試」 (the user's own words). It stops by itself at 18 minutes
//     after the first person connects or at 55 participant-minutes, and always ends the lesson.
//     The limits are checked every second, also in the middle of a step (round 13): at a limit the
//     owner ends the lesson and the test people's browsers close, whatever step is running.
//   node tools/classroom-trial/fixed-room-check.mjs --rehearsal --hard-stop-after <seconds>
//     (rehearsal only: TestA counts as connected once the joins have failed, the time limit is those
//      seconds, and a step that would wait 120 s must be cut short by that stop; the run then fails)
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, devices, expect } from '@playwright/test';
import { readVendorEnv, SECRET_KEYS } from './env-file.mjs';
import { makeRedactor, TOKEN } from './redact.mjs';
/* global document -- read inside the pages, through page.evaluate */

const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, all) => (value.startsWith('--') ? [...pairs, [value.slice(2), all[index + 1]?.startsWith('--') ? 'true' : all[index + 1] ?? 'true']] : pairs), []));
const root = process.cwd();
const rehearsal = args.rehearsal === 'true';
const pub = 3330, loc = 3331;
const origin = `http://localhost:${pub}`;
const ownerOrigin = `http://127.0.0.1:${loc}`;
const startedAt = Date.now();
const stamp = new Date(startedAt).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
const runDir = path.join(process.env.LOCALAPPDATA ?? tmpdir(), 'iHear-classroom-trial', `fixed-room-check-${stamp}`);
// Rehearsal only: --hard-stop-after <seconds> rehearses the watchdog's stop (see the usage above).
const hardStopAfter = rehearsal && args['hard-stop-after'] !== undefined ? Number(args['hard-stop-after']) : null;
if (hardStopAfter !== null && !(hardStopAfter > 0 && hardStopAfter <= 60)) throw new Error('--hard-stop-after takes 1 to 60 seconds');
const LIMIT_MS = hardStopAfter ? hardStopAfter * 1000 : 18 * 60_000;
const LIMIT_TEXT = LIMIT_MS % 60_000 === 0 ? `${LIMIT_MS / 60_000} minutes` : `${LIMIT_MS / 1000} seconds`;
const LIMIT_PARTICIPANT_MINUTES = 55;
const ROOM_LABEL = 'Trial W1 Room';

// The real run's interlocks: the W0 review and the user's own order, both required, both recorded.
if (!rehearsal) {
  const refuse = reason => { console.error(`fixed-room-check: WAITING FOR AUTHORIZATION: ${reason}. Nothing was started.`); process.exit(2); };
  if (args['hard-stop-after'] !== undefined) refuse('--hard-stop-after is for --rehearsal only');
  if (!args.env || args.env === 'true') refuse('give --env <zoom.env outside the repository>, or --rehearsal');
  if (!args.w0 || !existsSync(args.w0) || !/W0: PASS/.test(readFileSync(args.w0, 'utf8'))) refuse('the W0 review file (--w0) must exist and say "W0: PASS" (the account holder\'s portal check: automatic recording and participants\' recording OFF)');
  if (!args.go || !String(args.go).includes('開始 W1 真實測試')) refuse('the user\'s order (--go) must contain 「開始 W1 真實測試」');
}
mkdirSync(runDir, { recursive: true });

const ZOOM_KEYS = ['ZOOM_VIDEO_SDK_KEY', 'ZOOM_VIDEO_SDK_SECRET', 'ZOOM_VIDEO_SDK_API_KEY', 'ZOOM_VIDEO_SDK_API_SECRET', 'ZOOM_VIDEO_SDK_WEBHOOK_SECRET'];
const envFile = rehearsal ? path.join(runDir, 'rehearsal.env') : args.env;
if (rehearsal) writeFileSync(envFile, ['CLASSROOM_PROVIDER=zoom-video-sdk', ...ZOOM_KEYS.map(name => `${name}=REHEARSAL${randomBytes(16).toString('hex')}`)].join('\n'));
const settings = readVendorEnv(envFile, root);
if (settings.CLASSROOM_PROVIDER !== 'zoom-video-sdk') throw new Error('This check is for CLASSROOM_PROVIDER=zoom-video-sdk');

// What must not leak (as local-join-check.mjs): the secrets, the SDK key, the room's key and access
// token, each person's ticket. One rule for both tools since the W1 review (2026-11-23): see
// redact.mjs (a socket address in a browser error no longer keeps its query, and the report itself
// is checked before it is written).
const secrets = SECRET_KEYS.map(name => settings[name]).filter(Boolean);
const sdkKey = settings.ZOOM_VIDEO_SDK_KEY;
const hidden = new Set([...secrets, sdkKey]);
const { holds, leaks, redact, residue } = makeRedactor({ secrets, hidden });

const report = {
  mode: rehearsal ? 'rehearsal: stand-in keys, no route to Zoom session servers' : 'real: the Zoom Video SDK account', startedAt: new Date(startedAt).toISOString(),
  authorization: rehearsal ? null : { w0: path.basename(String(args.w0)), go: redact(String(args.go)).slice(0, 200) },
  limits: { minutes: LIMIT_MS / 60_000, participantMinutes: LIMIT_PARTICIPANT_MINUTES, checked: 'every second, also in the middle of a step' },
  checks: [], findings: {}, participantMinutes: 0, consoleProblems: [], alerts: [], status: 'running',
};
const pages = [];
const found = { browserResponses: 0, requestsToOutside: 0, pageAndStorage: 0, joinAnswersStopped: 0, serverOutput: 0, runFiles: 0, filesWrittenDuringRun: 0, filesGitCouldCommit: 0, reportFile: 0 };
let failure;
// Set by the watchdog when a limit is reached (the promise of its lesson end and browser closes).
let hardStop = null;
const elapsed = () => `${Math.round((Date.now() - startedAt) / 1000)}s`;
// Connected time per person, for the participant-minute limit (from "connected" to leaving).
const connectedSince = new Map();
let firstConnectAt = null, spentMs = 0;
const minutesSpent = () => (spentMs + [...connectedSince.values()].reduce((sum, since) => sum + (Date.now() - since), 0)) / 60_000;
const markConnected = who => { if (!connectedSince.has(who)) connectedSince.set(who, Date.now()); firstConnectAt ??= Date.now(); };
const markGone = who => { const since = connectedSince.get(who); if (since != null) { spentMs += Date.now() - since; connectedSince.delete(who); } };
const withinLimits = () => {
  if (firstConnectAt != null && Date.now() - firstConnectAt > LIMIT_MS) throw new Error(`time limit: ${LIMIT_TEXT} since the first person connected`);
  if (minutesSpent() > LIMIT_PARTICIPANT_MINUTES) throw new Error(`participant-minute limit: ${LIMIT_PARTICIPANT_MINUTES}`);
};
async function check(name, action, { fatal = true } = {}) {
  withinLimits();
  console.log(`[${elapsed()}] ${name} …`);
  try { await action(); report.checks.push({ name, status: 'passed' }); console.log(`[${elapsed()}] PASS ${name}`); }
  catch (error) {
    const message = hardStop ? `cut short by the hard stop (${report.hardStop}): ${redact(error.message)}` : redact(error.message);
    report.checks.push({ name, status: 'failed', error: message });
    console.log(`[${elapsed()}] FAIL ${name}: ${message.split('\n')[0]}`);
    const slug = name.replace(/[^A-Za-z0-9]+/g, '-').slice(0, 40);
    for (const { who, page } of pages) {
      await page.screenshot({ path: path.join(runDir, `failed-${slug}-${who}.png`), fullPage: true, mask: [page.locator('[data-room-link] code')] }).catch(() => undefined);
      const alerts = await page.locator('[role="alert"]').allInnerTexts().catch(() => []);
      for (const text of alerts) report.alerts.push(`${who}, ${name}: ${redact(text).slice(0, 300)}`);
    }
    if (fatal || hardStop || /limit:/.test(error.message)) throw error;
    failure ??= error;
  }
}
const pause = ms => new Promise(resolve => { setTimeout(resolve, ms); });
const within = (promise, ms) => Promise.race([promise, pause(ms)]);
const git = (...command) => spawnSync('git', command, { cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 2 ** 20 }).stdout;
const gitBefore = git('status', '--porcelain');

let server, serverOutput = '', browser, owner, roomId = null, lessonEnded = false;
const people = {};
const pending = [], hosts = new Set();
// The owner ends the lesson through the admin API (the server then ends its Zoom session). Counts
// as ended only on a 2xx answer, so the final cleanup tries once more after a failed attempt.
const endLesson = async () => {
  if (!roomId || !owner || lessonEnded) return;
  const answer = await within(owner.page.evaluate(room => fetch('/api/admin/classrooms/rooms', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'end_lesson', room }) }).then(response => response.status), roomId)
    .then(status => ({ status }), error => ({ error: redact(error.message) })), 20_000);
  report.cleanup = answer?.status ? `end_lesson answered ${answer.status}` : `end_lesson failed: ${answer?.error ?? 'no answer within 20 s'}`;
  if (answer?.status >= 200 && answer.status < 300) lessonEnded = true;
};
// The watchdog (round 13): the limits hold at any moment, not only when a step starts. At a limit
// the owner ends the lesson and the test people's browsers close, whatever step is running; that
// step then fails, and the run goes straight to the cleanup below.
const watchdog = setInterval(() => {
  if (hardStop) return;
  try { withinLimits(); } catch (error) {
    failure ??= error;
    report.hardStop = `${error.message}, at ${elapsed()}`;
    console.log(`[${elapsed()}] HARD STOP: ${error.message}: the owner ends the lesson and the test browsers close`);
    hardStop = (async () => {
      await endLesson();
      for (const who of Object.keys(people)) {
        markGone(who);
        await within(people[who].context.close().catch(() => undefined), 10_000);
      }
    })();
  }
}, 1000);
try {
  server = spawn(process.execPath, ['tools/classroom-trial/trial-server.mjs', '--env', envFile, '--fixed-rooms', '--public-port', String(pub), '--local-port', String(loc), '--data', path.join(runDir, 'server-data')],
    { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  for (const stream of [server.stdout, server.stderr]) stream.on('data', chunk => { serverOutput += chunk; });
  await check('the trial server starts with fixed rooms on and their recording off', async () => {
    const until = Date.now() + 120_000;
    while (!serverOutput.includes('Fixed rooms on')) {
      if (server.exitCode !== null || Date.now() > until) throw new Error(`The trial server did not start: ${redact(serverOutput.trim().split('\n').at(-1) ?? '')}`);
      await pause(250);
    }
  });

  let roomLink;
  await check('a trial room is made and its link is given once', async () => {
    const made = await fetch(`${ownerOrigin}/trial/rooms`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ publicOrigin: origin, label: ROOM_LABEL }) });
    expect(made.status).toBe(201);
    const body = await made.json();
    roomId = body.room.id;
    roomLink = body.roomLink;
    const url = new URL(roomLink);
    hidden.add(url.searchParams.get('a'));
    hidden.add(new URLSearchParams(url.hash.slice(1)).get('k'));
  });
  await check('the public port lets nobody in without the room\'s access token, and has no admin', async () => {
    const statusOf = async pathname => (await fetch(`${origin}${pathname}`, { redirect: 'manual' })).status;
    expect(await statusOf(`/classroom/r/${roomId}`)).toBe(404);
    expect(await statusOf(`/classroom/r/${roomId}?a=not-the-token`)).toBe(404);
    expect(await statusOf('/admin/classrooms/rooms')).toBe(404);
    expect((await fetch(`${origin}/trial/rooms`, { method: 'POST', body: '{}' })).status).toBe(404);
  });

  browser = await chromium.launch({
    channel: 'chromium', headless: args.headed !== 'true',
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--auto-select-desktop-capture-source=Entire screen',
      ...(rehearsal ? ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1, EXCLUDE source.zoom.us'] : [])],
  });
  const context = async (who, profile = {}) => {
    const made = await browser.newContext({ viewport: { width: 1280, height: 900 }, ...profile, locale: 'zh-TW', permissions: ['camera', 'microphone'] });
    made.setDefaultTimeout(60_000);
    await made.route(`${origin}/api/classroom/*/join`, async route => {
      const response = await route.fetch();
      const text = await response.text();
      if (leaks(text)) { found.joinAnswersStopped += 1; return route.abort(); }
      for (const [token] of text.matchAll(TOKEN)) hidden.add(token);
      return route.fulfill({ response, body: text });
    });
    made.on('request', request => {
      const url = request.url();
      if (!/^(https?|wss?):/.test(url)) return;
      hosts.add(new URL(url).host);
      let body = '';
      try { body = request.postData() ?? ''; } catch { body = ''; }
      if (!url.startsWith(origin) && !url.startsWith(ownerOrigin) && leaks(`${url}\n${body}`)) found.requestsToOutside += 1;
    });
    made.on('response', response => {
      if (!response.url().startsWith(origin)) return;
      pending.push(response.body().then(body => { if (leaks(body.toString('latin1'))) found.browserResponses += 1; }, () => undefined));
    });
    const page = await made.newPage();
    page.on('websocket', socket => hosts.add(new URL(socket.url()).host));
    page.on('console', message => {
      if (['error', 'warning'].includes(message.type()) && report.consoleProblems.length < 80) report.consoleProblems.push(`${who}: ${message.type()}: ${redact(message.text()).slice(0, 300)}`);
    });
    page.on('pageerror', error => { if (report.consoleProblems.length < 80) report.consoleProblems.push(`${who}: page error: ${redact(error.message).slice(0, 300)}`); });
    page.on('dialog', dialog => dialog.accept());
    pages.push({ who, page });
    return { context: made, page };
  };

  owner = await context('owner');
  const card = () => owner.page.locator(`[data-room="${ROOM_LABEL}"]`);
  await check('the owner opens the fixed rooms on this computer\'s port', async () => {
    await owner.page.goto(`${ownerOrigin}/trial/owner`);
    await owner.page.goto(`${ownerOrigin}/admin/classrooms/rooms`);
    await expect(card()).toBeVisible();
  });

  // TestC on an emulated tablet (Chromium with the iPad's screen, touch and user agent): Zoom's
  // whiteboard looks at the user agent. Emulated, not a real tablet.
  for (const [who, profile] of [['TestA', {}], ['TestB', {}], ['TestC', { ...devices['iPad (gen 7)'] }]]) {
    const { userAgent, viewport, deviceScaleFactor, isMobile, hasTouch } = profile;
    people[who] = await context(who, profile.userAgent ? { userAgent, viewport, deviceScaleFactor, isMobile, hasTouch } : {});
  }
  const connection = who => people[who].page.locator('.classroom-room-connection').first();
  await check('the three ask at the door, wait, are let in by the owner and enter', async () => {
    for (const who of ['TestA', 'TestB', 'TestC']) {
      const { page } = people[who];
      await page.goto(roomLink);
      await page.getByLabel(/Please enter your first name/).fill(who);
      await page.getByRole('button', { name: '進入教室' }).click();
      await expect(page.locator('[data-room-waiting]')).toBeVisible();
      await card().locator(`[data-waiting-person="${who}"]`).getByRole('button', { name: '讓他進入', exact: true }).click();
      // W1 review (2026-11-23): on real Zoom a person's minutes count from the moment they are let in,
      // a little before the page reads 已連線, so the limits never run behind Zoom's own count. (The
      // rehearsal joins nothing, so it keeps counting from "connected", as its hard-stop step needs.)
      if (!rehearsal) markConnected(who);
      await expect(page).toHaveURL(new RegExp(`^${origin}/classroom/L-[0-9a-f]{32}$`));
      await page.getByRole('button', { name: '進入教室' }).click();
      await expect(page.locator('.classroom-vendor-stage.zoom-video-sdk')).toBeAttached();
    }
  });
  await check('nobody\'s camera, microphone or sound is on, and nobody has chat', async () => {
    for (const who of ['TestA', 'TestB', 'TestC']) {
      const { page } = people[who];
      for (const kind of ['camera', 'microphone']) await expect(page.locator(`[data-control="${kind}"]`)).toHaveAttribute('aria-pressed', 'false');
      await expect(page.locator('[data-control="chat"]')).toHaveCount(0);
    }
  });

  if (rehearsal) {
    await check('rehearsal: with stand-in keys and no route to Zoom, every join fails safely', async () => {
      for (const who of ['TestA', 'TestB', 'TestC']) await expect(connection(who)).toHaveText('連線失敗', { timeout: 120_000 });
    });
    if (hardStopAfter) {
      // The watchdog's stop, rehearsed: TestA counts as connected from here, and this step would
      // wait 120 s for something that never comes. The stop must cut it short at the limit.
      markConnected('TestA');
      await check(`rehearsal: a step that would wait 120 s is cut short at the ${LIMIT_TEXT} limit`, async () => {
        await expect(people.TestA.page.locator('[data-hard-stop-rehearsal]')).toBeAttached({ timeout: 120_000 });
      });
    }
  } else {
    await check('the three connect to the real Zoom session', async () => {
      for (const who of ['TestA', 'TestB', 'TestC']) {
        // Someone who never connects stops counting here (they were counted from being let in).
        await expect(connection(who)).toHaveText('已連線', { timeout: 90_000 }).then(() => markConnected(who), error => { markGone(who); report.findings[`${who}Connect`] = 'did not connect'; if (who !== 'TestC') throw error; });
      }
    });
    await check('Zoom\'s version in the page', async () => {
      report.findings.sdkVersion = await people.TestA.page.locator('[data-sdk-version]').first().getAttribute('data-sdk-version').catch(() => 'not shown');
    }, { fatal: false });
    // W1 matrix, whiteboard: the button is Zoom's canStartWhiteboard() for that person.
    await check('whiteboard: who has the button, and whether it opens for the others', async () => {
      const shows = {};
      for (const who of ['TestA', 'TestB', 'TestC']) shows[who] = await people[who].page.locator('[data-tool="whiteboard"]').count() > 0;
      report.findings.whiteboardButton = shows;
      if (!shows.TestA) { report.findings.whiteboard = 'no whiteboard button for an ordinary participant (Zoom\'s canStartWhiteboard said no)'; return; }
      const board = people.TestA.page.locator('[data-tool="whiteboard"]');
      await board.click();
      const problem = people.TestA.page.locator('.classroom-room-problem[data-board-code]');
      await expect(board.and(people.TestA.page.locator('[aria-pressed="true"]')).or(problem)).toBeVisible({ timeout: 45_000 });
      if (await problem.isVisible()) { report.findings.whiteboard = `refused, Zoom code ${await problem.getAttribute('data-board-code')}`; return; }
      const seen = {};
      for (const who of ['TestB', 'TestC']) seen[who] = await expect(people[who].page.locator('[data-mode="board"]')).toBeAttached({ timeout: 30_000 }).then(() => true, () => false);
      // Zoom's whiteboard guide: where the interactive whiteboard is not supported, its content
      // arrives as a share stream instead. Say so when the emulated tablet shows a share.
      const asShare = !seen.TestC && await people.TestC.page.locator('[data-mode="share"]').count() > 0;
      report.findings.whiteboard = `opened by TestA; seen by TestB: ${seen.TestB}, TestC (emulated tablet): ${seen.TestC}${asShare ? ' (TestC shows a share instead)' : ''}`;
      await people.TestB.page.screenshot({ path: path.join(runDir, 'testb-whiteboard.png'), fullPage: true });
      await people.TestC.page.screenshot({ path: path.join(runDir, 'testc-whiteboard.png'), fullPage: true }).catch(() => undefined);
      await board.click();
      await expect(board).toHaveAttribute('aria-pressed', 'false', { timeout: 30_000 });
    }, { fatal: false });
    // Sharing, one at a time: in automated Chromium the picker is chosen by the browser itself.
    await check('sharing: TestA shares, TestB\'s share waits, TestA stops', async () => {
      const share = people.TestA.page.locator('[data-tool="share"]');
      if (!(await share.count())) { report.findings.share = 'no share button for TestA'; return; }
      await share.click();
      const sending = await expect(share).toHaveAttribute('aria-pressed', 'true', { timeout: 30_000 }).then(() => true, () => false);
      if (!sending) { report.findings.share = 'TestA\'s share did not start in automated Chromium (check by hand on a real computer)'; return; }
      const waits = await expect(people.TestB.page.locator('[data-tool="share"]')).toBeDisabled({ timeout: 30_000 }).then(() => true, () => false);
      const seen = await expect(people.TestB.page.locator('[data-mode="share"]')).toBeAttached({ timeout: 30_000 }).then(() => true, () => false);
      report.findings.share = `TestA shared; TestB saw it: ${seen}; TestB's share button waited: ${waits}`;
      await share.click();
      await expect(share).toHaveAttribute('aria-pressed', 'false', { timeout: 30_000 });
    }, { fatal: false });
    await check('a dropped connection comes back (TestA offline 10 seconds)', async () => {
      const from = Date.now();
      await people.TestA.context.setOffline(true);
      await pause(10_000);
      await people.TestA.context.setOffline(false);
      await expect(connection('TestA')).toHaveText('已連線', { timeout: 90_000 });
      report.findings.reconnectSeconds = Math.round((Date.now() - from) / 1000);
    }, { fatal: false });
    await check('TestB leaves and enters again without being let in again', async () => {
      await people.TestB.page.locator('[data-control="leave"]').click();
      markGone('TestB');
      await people.TestB.page.getByRole('button', { name: '重新進入', exact: true }).click();
      await expect(connection('TestB')).toHaveText('已連線', { timeout: 90_000 });
      markConnected('TestB');
    }, { fatal: false });
    await check('TestC is taken out: their page leaves; the others move to a new session and come back', async () => {
      const from = Date.now();
      await card().locator('[data-in-room-person="TestC"]').getByRole('button', { name: '請出教室' }).click();
      await expect(people.TestC.page.getByText('這個個人連結已失效（已撤銷或已更換），所以已離開教室。請向 iHear 索取新的連結。')).toBeVisible({ timeout: 60_000 });
      markGone('TestC');
      for (const who of ['TestA', 'TestB']) await expect(connection(who)).toHaveText('已連線', { timeout: 90_000 });
      report.findings.removalSeconds = Math.round((Date.now() - from) / 1000);
    }, { fatal: false });
  }

  await check('the owner ends the lesson: everyone leaves', async () => {
    await card().getByRole('button', { name: '結束這次上課' }).click();
    lessonEnded = true;
    for (const who of ['TestA', 'TestB']) {
      const gone = await expect(people[who].page.locator('.classroom-room-connection')).toHaveCount(0, { timeout: 60_000 }).then(() => true, () => false);
      report.findings[`${who}AfterEnd`] = gone ? 'left the room' : 'still showed the room after 60 s';
      markGone(who);
    }
  }, { fatal: false });
  await check('no secret in any page, its storage or its cookies', async () => {
    for (const { page } of pages) {
      const state = await page.evaluate(() => JSON.stringify({ html: document.documentElement.outerHTML, local: { ...localStorage }, session: { ...sessionStorage } }));
      if (leaks(state) || leaks(JSON.stringify(await page.context().cookies()))) found.pageAndStorage += 1;
    }
    expect(found.pageAndStorage).toBe(0);
  }, { fatal: false });
} catch (error) {
  failure ??= error;
} finally {
  // Cleanup, whatever happened: the watchdog stopped (and its stop finished, if it made one), the
  // lesson ended (the server ends its Zoom session), every browser closed and the server stopped.
  // A leftover live session is said with the command to end it.
  clearInterval(watchdog);
  if (hardStop) await hardStop;
  await endLesson();
  for (const who of Object.keys(people)) markGone(who);
  report.participantMinutes = Math.round(minutesSpent() * 10) / 10;
  await within(Promise.all(pending), 15_000);
  await within(browser?.close().catch(() => undefined), 15_000);
  if (server && server.exitCode === null) {
    server.kill();
    await new Promise(resolve => { server.once('exit', resolve); setTimeout(resolve, 5000); });
  }
  if (!rehearsal) report.leftoverCheck = 'run: node tools/classroom-preflight/emergency-stop-live.mjs --env <zoom.env> (lists live sessions; sends nothing)';
  if (leaks(serverOutput)) found.serverOutput += 1;
  const serverLog = redact(serverOutput);
  // W1 review (2026-11-23): what is written is checked too, after redaction.
  if (residue(serverLog)) found.serverOutput += 1;
  writeFileSync(path.join(runDir, 'server-output.log'), serverLog);
  const walk = (dir, skip) => readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    if (skip(full)) return [];
    return entry.isDirectory() ? walk(full, skip) : entry.isFile() ? [full] : [];
  });
  const count = (files, test) => files.filter(file => { try { return statSync(file).size < 256 * 2 ** 20 && test(readFileSync(file).toString('latin1')); } catch { return false; } }).length;
  found.runFiles = count(walk(runDir, full => full === envFile), leaks);
  found.filesWrittenDuringRun = count(walk(root, full => /[\\/](node_modules|\.git)$/.test(full)).filter(file => statSync(file).mtimeMs >= startedAt), leaks);
  found.filesGitCouldCommit = count(git('ls-files', '-z', '-co', '--exclude-standard').split('\0').filter(Boolean).map(file => path.join(root, file)), holds);
  report.gitStatusUnchanged = git('status', '--porcelain') === gitBefore;
  report.hosts = [...hosts].sort();
  report.secretsFound = found;
  report.finishedAt = new Date().toISOString();
  if (failure) report.error = redact(failure.message);
  // W1 review (2026-11-23): the report itself, as it is about to be written (browser errors, alerts,
  // findings, the error): anything still shaped like a credential after redaction counts as found.
  if (residue(JSON.stringify(report))) found.reportFile += 1;
  const clean = Object.values(found).every(value => value === 0) && report.gitStatusUnchanged;
  report.status = failure || !clean ? 'failed' : 'passed';
  writeFileSync(path.join(runDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`\nFixed-room check (${report.mode}): ${report.status.toUpperCase()}`);
  for (const [name, value] of Object.entries(report.findings)) console.log(`  ${name}: ${typeof value === 'string' ? value : JSON.stringify(value)}`);
  console.log(`  participant-minutes: ${report.participantMinutes} (limit ${LIMIT_PARTICIPANT_MINUTES}); cleanup: ${report.cleanup ?? 'the lesson was ended in the run'}`);
  console.log(`  hosts the browsers contacted: ${report.hosts.join(', ')}`);
  console.log(`  secrets found: ${Object.entries(found).map(([name, value]) => `${name} ${value}`).join(', ')}`);
  console.log(`  checkout unchanged by the run (git status): ${report.gitStatusUnchanged ? 'yes' : 'NO'}`);
  if (report.leftoverCheck) console.log(`  afterwards: ${report.leftoverCheck}`);
  if (report.hardStop) console.log(`  hard stop: ${report.hardStop}`);
  if (report.error) console.log(`  stopped at: ${report.error.split('\n')[0]}`);
  console.log(`  report and screenshots: ${runDir}`);
}
if (report.status !== 'passed') process.exit(1);
