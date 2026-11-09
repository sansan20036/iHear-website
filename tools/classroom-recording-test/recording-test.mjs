// The local P1 recording test (2026-10-31): the built site on this computer only, set up to record
// one TEST- lesson and file its recording, to Google Drive with a test account's drive.file grant
// or to the site's local stand-in. Separate from the P3 trial server (tools/classroom-trial),
// which records nothing and is not changed by this.
//
// No tunnel and no webhook: everything listens on 127.0.0.1 only, every answer is marked
// "X-iHear-Recording-Test: local" (start-tunnel.mjs points a tunnel only at the trial's public
// port, so it refuses this one), the tutor's page reports Zoom's session id and the server
// confirms it with Zoom before using it (CLASSROOM_SESSION_REPORTS=verify), and the scheduled tick
// runs from here every minute. Deleting the vendor's copy stays off. Nothing is recorded until the
// operator types the confirmation for the lesson (runner.mjs), and Zoom is used only with
// --real-recording, which needs the account owner's approval first (cloud recording, API keys,
// the Google test grant): see planning/2026-10-31-p1-phase3-precheck.md.
//
// Usage (from the repository root, after `next build`):
//   node tools/classroom-recording-test/recording-test.mjs --provider synthetic --drive local --date 2026-11-05 --time 10:00
//   node tools/classroom-recording-test/recording-test.mjs --env <file outside the repo> --real-recording \
//        --drive google --google-client <file> --google-token <file> --date 2026-11-05 --time 10:00
//   add --check to see whether the settings are ready (names only); it starts nothing.
// Options: --port 3320 --data <folder> --minutes 30 --code TEST-R1 --tutor TEST-T01 --student TEST-S01
//          --drive-root "[測試] iHear P1 錄影測試"
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { checkSiteFolder, hideInOutput, readVendorEnv } from '../classroom-trial/env-file.mjs';
import { allowRecording, createTestLesson, driveSettings, lessonSummary, runTick } from './runner.mjs';

const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, all) => (value.startsWith('--') ? [...pairs, [value.slice(2), all[index + 1]?.startsWith('--') ? 'true' : all[index + 1] ?? 'true']] : pairs), []));
const root = process.cwd();
const port = Number(args.port ?? 3320);
const fail = message => { console.error(message); process.exit(1); };
if (!Number.isInteger(port) || port < 1024) fail('Use a --port from 1024 up');

let vendor;
let drive;
try {
  checkSiteFolder(root);
  if (args.provider === 'synthetic') vendor = { CLASSROOM_PROVIDER: 'synthetic' };
  else if (args.env) vendor = readVendorEnv(args.env, root);
  else throw new Error('Give --env <file outside the repository> (Zoom), or --provider synthetic for a rehearsal');
  // LCIC's filing and deletion stay off: this test records through Zoom (or the stand-in) only.
  if (!['synthetic', 'zoom-video-sdk'].includes(vendor.CLASSROOM_PROVIDER)) throw new Error('The recording test runs with zoom-video-sdk or synthetic only');
  if (vendor.CLASSROOM_PROVIDER === 'zoom-video-sdk' && args['real-recording'] !== 'true') {
    throw new Error('This records a real Zoom session. Add --real-recording only once the account owner has approved the test.');
  }
  drive = driveSettings({ drive: args.drive ?? 'local', clientFile: args['google-client'], tokenFile: args['google-token'], rootName: args['drive-root'] }, root);
} catch (error) {
  // The message alone: these name a setting or a flag, never a value.
  fail(error.message);
}
hideInOutput(vendor);
if (args.check) {
  for (const name of Object.keys(vendor)) console.log(`${name}: ${name === 'CLASSROOM_PROVIDER' ? vendor[name] : 'filled'}`);
  console.log(`CLASSROOM_DRIVE: ${drive.CLASSROOM_DRIVE}${drive.CLASSROOM_DRIVE === 'google' ? ` (folder "${drive.CLASSROOM_DRIVE_ROOT_NAME}"; grant files outside the repository)` : ''}`);
  console.log('The settings are ready. Nothing was started.');
  process.exit(0);
}

// Nothing from the shell reaches the site except what is set here (as the trial server does).
for (const name of Object.keys(process.env)) {
  if (/^(POSTGRES|DATABASE|SUPABASE|AUTH_|NEXTAUTH|GOOGLE|RESEND|SENDGRID|VERCEL|NETLIFY|CONTEXT|TRANSLATION|RATE_LIMIT|CLASSROOM|ZOOM|LCIC|TENCENT|IHEAR|CRON)/.test(name)) delete process.env[name];
}
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
const dataDir = path.resolve(args.data ?? path.join(process.env.LOCALAPPDATA ?? root, 'iHear-recording-test', `run-${stamp}`));
if (!path.relative(root, dataDir).startsWith('..')) fail('The data folder must be outside the repository');
mkdirSync(dataDir, { recursive: true });
const secret = randomBytes(32).toString('base64url');
const cronSecret = randomBytes(32).toString('base64url');
const OWNER = 'recording-test-owner@test.invalid';
const tutorCode = args.tutor ?? 'TEST-T01';
const tutorEmail = `${tutorCode.toLowerCase()}@test.invalid`;
Object.assign(process.env, vendor, drive, {
  NODE_ENV: 'production', IHEAR_FORCE_FILE_STORE: '1', IHEAR_TEST_DATA_DIR: dataDir,
  AUTH_SECRET: secret, AUTH_TRUST_HOST: 'true', AUTH_OWNER_EMAILS: OWNER, AUTH_ADMIN_EMAILS: '',
  CRON_SECRET: cronSecret, CLASSROOM_SESSION_REPORTS: 'verify',
  ...(vendor.CLASSROOM_PROVIDER === 'synthetic' ? { CLASSROOM_SYNTHETIC_SECRET: randomBytes(32).toString('base64url') } : {}),
});

const { default: next } = await import('next');
const { encode } = await import('next-auth/jwt');
const app = next({ dev: false, dir: root, hostname: 'localhost', port });
const ORIGIN = `http://localhost:${port}`;
await app.prepare();
const handle = app.getRequestHandler();

const hash = value => createHash('sha256').update(String(value)).digest('hex');
const sameHash = (value, expected) => {
  const given = Buffer.from(hash(value)), wanted = Buffer.from(String(expected ?? ''));
  return given.length === wanted.length && timingSafeEqual(given, wanted);
};
const HOURS = 12;
const sessionCookie = async email => {
  const value = await encode({ secret, salt: 'authjs.session-token', token: { name: 'Recording test', email, sub: email }, maxAge: HOURS * 3600 });
  return `authjs.session-token=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${HOURS * 3600}`;
};
const log = (request, status) => appendFileSync(path.join(dataDir, 'requests.log'), `${new Date().toISOString()} ${request.method} ${new URL(request.url, 'http://x').pathname} ${status}\n`);
let tutorInvite = null;

const server = createServer(async (request, response) => {
  const url = new URL(request.url, ORIGIN);
  response.setHeader('X-iHear-Recording-Test', 'local');
  try {
    if (url.pathname === '/rt/owner' && request.method === 'GET') {
      response.writeHead(303, { location: '/admin/classrooms', 'set-cookie': await sessionCookie(OWNER), 'cache-control': 'no-store' }).end();
      return log(request, 303);
    }
    const tutor = /^\/rt\/tutor\/([A-Za-z0-9-]{1,60})$/.exec(url.pathname);
    if (tutor && request.method === 'GET') {
      if (!tutorInvite || tutorInvite.lessonId !== tutor[1] || !sameHash(url.searchParams.get('t'), tutorInvite.tokenHash)) {
        response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Not found');
        return log(request, 404);
      }
      response.writeHead(303, { location: `/classroom/${tutor[1]}`, 'set-cookie': await sessionCookie(tutorEmail), 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' }).end();
      return log(request, 303);
    }
    // This computer's own pages only.
    const origin = request.headers.origin;
    if (origin && ![ORIGIN, `http://127.0.0.1:${port}`].includes(origin)) {
      response.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' }).end('Forbidden');
      return log(request, 403);
    }
    if (origin) request.headers.origin = ORIGIN;
    response.on('finish', () => log(request, response.statusCode));
    await handle(request, response);
  } catch (error) {
    console.error(error);
    if (!response.headersSent) response.writeHead(500);
    response.end();
  }
});
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });

// The site, as the steps reach it: from inside this process, with the owner's sign-in when asked.
const ownerCookie = (await sessionCookie(OWNER)).split(';')[0];
const call = (method, pathname, { as = null, body = null, headers = {} } = {}) => new Promise((resolve, reject) => {
  const text = body ? JSON.stringify(body) : null;
  const sent = httpRequest({
    host: '127.0.0.1', port, method, path: pathname,
    headers: { host: `localhost:${port}`, ...(text ? { 'content-type': 'application/json', origin: ORIGIN } : {}), ...(as === 'owner' ? { cookie: ownerCookie } : {}), ...headers },
  }, answer => {
    let received = '';
    answer.on('data', chunk => { received += chunk; });
    answer.on('end', () => { let json = null; try { json = JSON.parse(received); } catch { /* not JSON */ } resolve({ status: answer.statusCode, json }); });
  });
  sent.on('error', reject);
  if (text) sent.write(text);
  sent.end();
});

console.log(`iHear P1 recording test (${vendor.CLASSROOM_PROVIDER}, Drive: ${drive.CLASSROOM_DRIVE}); this computer only: ${ORIGIN}`);
console.log(`  data: ${dataDir}`);
const lesson = await createTestLesson({ call, date: args.date, time: args.time, minutes: Number(args.minutes ?? 30), code: args.code ?? 'TEST-R1', tutorCode, studentCode: args.student ?? 'TEST-S01', tutorEmail })
  .catch(error => fail(error.message));
const prompt = createInterface({ input: process.stdin, output: process.stdout });
const allowed = await allowRecording({
  call, lesson, tutorCode, studentCode: args.student ?? 'TEST-S01',
  ask: question => prompt.question(question),
  // Trial consent is switched on only now, after the operator's confirmation.
  enableTrialConsent: () => { process.env.CLASSROOM_TRIAL_CONSENT = '1'; },
}).catch(error => fail(error.message));
prompt.close();
console.log(allowed.allowed ? `Lesson ${lesson.code} may be recorded.` : `Lesson ${lesson.code} will NOT be recorded (the confirmation was not typed).`);
const tutorToken = randomBytes(32).toString('base64url');
tutorInvite = { lessonId: lesson.lessonId, tokenHash: hash(tutorToken) };
console.log(`Lesson ${lesson.code}: ${lesson.startsAt} – ${lesson.endsAt} (UTC); the room opens 15 minutes before.`);
console.log(`  tutor (open first):  ${ORIGIN}/rt/tutor/${lesson.lessonId}?t=${tutorToken}`);
console.log(`  student:             ${new URL(lesson.studentLink, ORIGIN)}`);
console.log(`  overview:            ${ORIGIN}/rt/owner`);
console.log('The tick runs every minute. Ctrl+C stops the test; then follow the clean-up steps in the plan.');
// Stopping this process stops nothing at Zoom. The independent stop needs only the env file and
// this data folder (the env file's path is printed, never its contents).
const recovery = args.env
  ? `node tools/classroom-recording-test/emergency-stop.mjs --env "${path.resolve(args.env)}" --data "${dataDir}" --yes --end`
  : null;
if (recovery) console.log(`If this window closes or crashes while Zoom may be recording, run:\n  ${recovery}`);

const timer = setInterval(async () => {
  const ticked = await runTick({ call, cronSecret }).catch(() => ({ status: 0 }));
  const lines = await lessonSummary({ call, lessonCode: lesson.code }).catch(() => ['overview: not reachable']);
  console.log(`[${new Date().toISOString()}] tick ${ticked.status}`);
  for (const line of lines) console.log(line);
}, 60_000);
const stop = () => {
  clearInterval(timer);
  server.close();
  if (recovery) console.log(`Stopped locally. A Zoom recording, if one is running, is NOT stopped by this. To stop it:\n  ${recovery}`);
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
