// The classroom trial server (2026-10-30): the built site for a real Zoom or LCIC trial with adult
// testers, reachable from outside only through a closable HTTPS tunnel, and then only for the
// classroom. Two listeners in one process, both on 127.0.0.1:
//
//   public (default 3310): the ONLY port a tunnel may point at. It serves just the classroom page,
//     its three APIs and their static files, to people holding a personal link (the student's
//     link, or the tutor's trial sign-in link). Everything else, the admin included, answers 404.
//   local (default 3311): this computer only, never tunneled. The owner's admin and overview, and
//     /trial/lessons, which adds a TEST- lesson and returns the two personal links.
//
// No production credential is read: the vendor keys come from an env file outside the repository
// that may hold only the classroom's own settings (anything else is refused). Data is a fresh local
// folder (file store, no database server). Sessions are signed with a secret made at start-up, so
// stopping the server ends every link and sign-in. Round 1 records nothing: the consent and
// mid-class-stop switches are refused, so no lesson can be allowed to record.
//
// Usage (from the repository root, after `next build`):
//   node tools/classroom-trial/trial-server.mjs --env <file outside the repo>
//   node tools/classroom-trial/trial-server.mjs --provider synthetic        (local rehearsal only)
//   node tools/classroom-trial/trial-server.mjs --env <file> --check        (is the file ready? names only; starts nothing)
// Options: --data <folder> --public-port 3310 --local-port 3311
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import path from 'node:path';
import { checkSiteFolder, describeVendorEnv, hideInOutput, readVendorEnv } from './env-file.mjs';

const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, all) => (value.startsWith('--') ? [...pairs, [value.slice(2), all[index + 1]?.startsWith('--') ? 'true' : all[index + 1] ?? 'true']] : pairs), []));
const root = process.cwd();
const publicPort = Number(args['public-port'] ?? 3310);
const localPort = Number(args['local-port'] ?? 3311);
if (![publicPort, localPort].every(port => Number.isInteger(port) && port >= 1024) || publicPort === localPort) throw new Error('Use two different ports from 1024 up');

function vendorSettings() {
  // No .env.local or the like in the site folder: Next.js would load it after the shell is cleared.
  checkSiteFolder(root);
  if (args.provider === 'synthetic') return { CLASSROOM_PROVIDER: 'synthetic' };
  if (!args.env) throw new Error('Give --env <file outside the repository> with the trial keys (or --provider synthetic for a local rehearsal)');
  return readVendorEnv(args.env, root);
}
let vendor;
try {
  vendor = vendorSettings();
} catch (error) {
  // The message alone: these name a setting or a line number, and nothing else is shown.
  console.error(error.message);
  process.exit(1);
}
hideInOutput(vendor);
// --check: whether the env file is ready, by setting name only.
if (args.check) {
  const summary = vendor.CLASSROOM_PROVIDER === 'synthetic' ? { lines: ['CLASSROOM_PROVIDER: synthetic'], ok: true } : describeVendorEnv(vendor);
  for (const line of summary.lines) console.log(line);
  console.log(summary.ok ? 'The env file is ready. Nothing was started.' : 'Fix the settings above in the env file. Nothing was started.');
  process.exit(summary.ok ? 0 : 1);
}

// Nothing from the shell reaches the site except what is set here.
for (const name of Object.keys(process.env)) {
  if (/^(POSTGRES|DATABASE|SUPABASE|AUTH_|NEXTAUTH|GOOGLE|RESEND|SENDGRID|VERCEL|NETLIFY|CONTEXT|TRANSLATION|RATE_LIMIT|CLASSROOM|ZOOM|LCIC|TENCENT|IHEAR)/.test(name)) delete process.env[name];
}
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
const dataDir = path.resolve(args.data ?? path.join(process.env.LOCALAPPDATA ?? root, 'iHear-classroom-trial', `run-${stamp}`));
if (!path.relative(root, dataDir).startsWith('..')) throw new Error('The data folder must be outside the repository');
mkdirSync(dataDir, { recursive: true });
const secret = randomBytes(32).toString('base64url');
const OWNER = 'trial-owner@trial.invalid';
Object.assign(process.env, vendor, {
  NODE_ENV: 'production', IHEAR_FORCE_FILE_STORE: '1', IHEAR_TEST_DATA_DIR: dataDir,
  AUTH_SECRET: secret, AUTH_TRUST_HOST: 'true', AUTH_OWNER_EMAILS: OWNER, AUTH_ADMIN_EMAILS: '',
  CLASSROOM_DRIVE: 'local', ...(vendor.CLASSROOM_PROVIDER === 'synthetic' ? { CLASSROOM_SYNTHETIC_SECRET: randomBytes(32).toString('base64url') } : {}),
});

const { default: next } = await import('next');
const { encode } = await import('next-auth/jwt');
// Next builds every request's address from this hostname and port, whatever the Host header
// says; the gateway checks each browser's Origin itself and then hands Next this one origin.
const app = next({ dev: false, dir: root, hostname: 'localhost', port: publicPort });
const NEXT_ORIGIN = `http://localhost:${publicPort}`;
await app.prepare();
const handle = app.getRequestHandler();

// The checked-in hosting headers, applied as Vercel does (a later rule replaces an earlier one).
const rules = JSON.parse(readFileSync(path.join(root, 'vercel.json'), 'utf8')).headers.map(rule => {
  const pattern = new RegExp(`^${rule.source === '/(.*)' ? '.*' : rule.source.replace(/:[A-Za-z]+$/, '[^/]+')}$`);
  return { test: pathname => pattern.test(pathname), headers: rule.headers };
});
const applyHeaders = (pathname, response) => {
  for (const rule of rules) if (rule.test(pathname)) for (const header of rule.headers) response.setHeader(header.key, header.value);
};

const hash = value => createHash('sha256').update(String(value)).digest('hex');
const sameHash = (value, expected) => {
  const given = Buffer.from(hash(value)), wanted = Buffer.from(String(expected ?? ''));
  return given.length === wanted.length && timingSafeEqual(given, wanted);
};
// Personal links issued by /trial/lessons, kept as hashes only.
const invites = new Map();
const saveInvites = () => writeFileSync(path.join(dataDir, 'trial-invites.json'), `${JSON.stringify(Object.fromEntries(invites), null, 2)}\n`);
// Access to the public port: a random id per browser, set when a personal link is opened.
const ACCESS_COOKIE = 'ihear_trial_access';
const ACCESS_HOURS = 12;
const access = new Map();
const accessId = () => {
  const id = randomBytes(24).toString('base64url');
  access.set(createHmac('sha256', secret).update(id).digest('hex'), Date.now() + ACCESS_HOURS * 3600_000);
  return id;
};
const hasAccess = request => {
  const id = /(?:^|;\s*)ihear_trial_access=([A-Za-z0-9_-]+)/.exec(request.headers.cookie ?? '')?.[1];
  const until = id && access.get(createHmac('sha256', secret).update(id).digest('hex'));
  return Boolean(until && until > Date.now());
};
// HTTPS as the tunnel reports it (Cloudflare also sends Cf-Visitor).
const secure = request => request.headers['x-forwarded-proto'] === 'https' || /"scheme":"https"/.test(String(request.headers['cf-visitor'] ?? ''));
const publicHost = request => String(request.headers['x-forwarded-host'] ?? request.headers.host ?? '');
const cookie = (request, name, value, maxAge) => `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure(request) ? '; Secure' : ''}`;
const sessionCookie = async (request, email, maxAge) => {
  const name = secure(request) ? '__Secure-authjs.session-token' : 'authjs.session-token';
  const value = await encode({ secret, salt: name, token: { name: 'Trial', email, sub: email }, maxAge });
  return cookie(request, name, value, maxAge);
};

const log = (port, request, status) => appendFileSync(path.join(dataDir, `${port === publicPort ? 'public' : 'local'}-requests.log`),
  `${new Date().toISOString()} ${request.method} ${new URL(request.url, 'http://x').pathname} ${status}\n`);
// Every answer says which port gave it, so start-tunnel.mjs can tell the classroom-only public port
// from anything else, and an answer that reached this computer from one Cloudflare stopped.
const marker = port => (port === publicPort ? 'public' : 'local');
const notFound = (port, request, response) => {
  response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex, nofollow', 'x-ihear-trial': marker(port) });
  response.end('Not found');
  log(port, request, 404);
};
const forward = (port, request, response, pathname) => {
  applyHeaders(pathname, response);
  response.setHeader('X-Robots-Tag', 'noindex, nofollow');
  response.setHeader('X-iHear-Trial', marker(port));
  response.on('finish', () => log(port, request, response.statusCode));
  void handle(request, response).catch(error => {
    console.error(error);
    if (!response.headersSent) response.writeHead(500);
    response.end();
  });
};

// Public port: the classroom only.
const LESSON = '[A-Za-z0-9-]{1,60}';
const PUBLIC_ROUTES = [
  { methods: ['GET', 'HEAD'], pattern: new RegExp(`^/classroom/${LESSON}$`) },
  { methods: ['POST'], pattern: new RegExp(`^/api/classroom/${LESSON}/(join|status|host-events)$`) },
  { methods: ['GET', 'HEAD'], pattern: /^\/_next\/static\/[A-Za-z0-9_./~-]+$/ },
  { methods: ['GET', 'HEAD'], pattern: /^\/favicon\.ico$/ },
  // The site's own static styles, scripts and images, and its theme start-up script (all public).
  { methods: ['GET', 'HEAD'], pattern: /^\/assets\/[A-Za-z0-9_./-]+\.(css|js|json|png|svg|webp|jpe?g|woff2?|ico)$/ },
  { methods: ['GET', 'HEAD'], pattern: /^\/api\/site-theme\/bootstrap$/ },
];
const publicServer = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://trial.invalid');
  const { pathname } = url;
  try {
    // The tutor's trial sign-in link: a staff session for this lesson's tutor, then the room.
    const tutor = new RegExp(`^/trial/tutor/(${LESSON})$`).exec(pathname);
    if (tutor && request.method === 'GET') {
      const invite = invites.get(tutor[1]);
      if (!invite || invite.expiresAt < Date.now() || !sameHash(url.searchParams.get('t'), invite.tutorTokenHash)) return notFound(publicPort, request, response);
      response.writeHead(303, {
        location: `/classroom/${tutor[1]}`, 'cache-control': 'no-store', 'x-robots-tag': 'noindex, nofollow', 'referrer-policy': 'no-referrer', 'x-ihear-trial': 'public',
        'set-cookie': [cookie(request, ACCESS_COOKIE, accessId(), ACCESS_HOURS * 3600), await sessionCookie(request, invite.tutorEmail, ACCESS_HOURS * 3600)],
      });
      response.end();
      return log(publicPort, request, 303);
    }
    const route = PUBLIC_ROUTES.find(entry => entry.pattern.test(pathname));
    if (!route || !route.methods.includes(request.method)) return notFound(publicPort, request, response);
    // The student's personal link opens access for this browser; every other request needs it.
    const lessonId = /^\/classroom\/([^/]+)$/.exec(pathname)?.[1];
    const invite = lessonId ? invites.get(lessonId) : null;
    if (!hasAccess(request)) {
      if (!invite || invite.expiresAt < Date.now() || !sameHash(url.searchParams.get('k'), invite.studentKeyHash)) return notFound(publicPort, request, response);
      response.setHeader('set-cookie', cookie(request, ACCESS_COOKIE, accessId(), ACCESS_HOURS * 3600));
    }
    // A browser's Origin must be this tunnel's own address; Next is then given its own origin.
    const origin = request.headers.origin;
    if (origin && origin !== `${secure(request) ? 'https' : 'http'}://${publicHost(request)}`) return notFound(publicPort, request, response);
    // Next takes the scheme from X-Forwarded-Proto, so behind the tunnel its origin is https.
    if (secure(request)) request.headers['x-forwarded-proto'] = 'https';
    if (origin) request.headers.origin = secure(request) ? NEXT_ORIGIN.replace(/^http:/, 'https:') : NEXT_ORIGIN;
    response.setHeader('Referrer-Policy', 'no-referrer');
    forward(publicPort, request, response, pathname);
  } catch (error) {
    console.error(error);
    if (!response.headersSent) response.writeHead(500);
    response.end();
  }
});

// A request to the local port, as "localhost", from inside this process.
const localRequest = (method, pathname, headers, body) => new Promise((resolve, reject) => {
  const sent = httpRequest({ host: '127.0.0.1', port: localPort, method, path: pathname, headers: { ...headers, host: `localhost:${localPort}` } }, answer => {
    let text = '';
    answer.on('data', chunk => { text += chunk; });
    answer.on('end', () => resolve({ status: answer.statusCode, text }));
  });
  sent.on('error', reject);
  if (body) sent.write(body);
  sent.end();
});

// Local port: the owner, on this computer only.
const localServer = createServer(async (request, response) => {
  const url = new URL(request.url, `http://127.0.0.1:${localPort}`);
  try {
    if (url.pathname === '/trial/owner' && request.method === 'GET') {
      response.writeHead(303, { location: '/admin/classrooms', 'set-cookie': await sessionCookie(request, OWNER, ACCESS_HOURS * 3600), 'cache-control': 'no-store' });
      response.end();
      return log(localPort, request, 303);
    }
    if (url.pathname === '/trial/lessons' && request.method === 'POST') {
      const body = JSON.parse(await new Promise((resolve, reject) => {
        let text = '';
        request.on('data', chunk => { text += chunk; if (text.length > 4096) reject(new Error('too large')); });
        request.on('end', () => resolve(text || '{}'));
        request.on('error', reject);
      }));
      const publicOrigin = new URL(String(body.publicOrigin ?? '')).origin;
      const codes = [body.code, body.tutorCode, body.studentCode].map(String);
      if (!codes.every(code => /^TEST-[A-Za-z0-9-]{1,30}$/.test(code))) throw new Error('Trial lessons use TEST- codes only (lesson, tutor and student)');
      const tutorEmail = `${String(body.tutorCode).toLowerCase()}@trial.invalid`;
      const ownerCookie = (await sessionCookie({ headers: {} }, OWNER, 300)).split(';')[0];
      const created = await localRequest('POST', '/api/admin/classrooms', { 'content-type': 'application/json', origin: `http://localhost:${localPort}`, cookie: ownerCookie },
        JSON.stringify({ code: body.code, date: body.date, time: body.time, minutes: body.minutes, tutorCode: body.tutorCode, tutorEmail, studentCode: body.studentCode }));
      const result = JSON.parse(created.text);
      if (created.status !== 201) {
        response.writeHead(created.status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(result));
        return log(localPort, request, created.status);
      }
      const lessonId = result.lesson.lessonId;
      const studentKey = new URL(result.studentLink, publicOrigin).searchParams.get('k');
      const tutorToken = randomBytes(32).toString('base64url');
      invites.set(lessonId, {
        studentKeyHash: hash(studentKey), tutorTokenHash: hash(tutorToken), tutorEmail,
        expiresAt: Date.parse(result.lesson.endsAt) + 3600_000,
      });
      saveInvites();
      response.writeHead(201, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      // The two personal links are shown once, here; only their hashes are kept.
      response.end(JSON.stringify({
        lesson: result.lesson,
        tutorLink: `${publicOrigin}/trial/tutor/${lessonId}?t=${tutorToken}`,
        studentLink: new URL(result.studentLink, publicOrigin).toString(),
      }));
      return log(localPort, request, 201);
    }
    // Same-origin requests from the owner's page on this port; Next is then given its own origin.
    const origin = request.headers.origin;
    if (origin && ![`http://localhost:${localPort}`, `http://127.0.0.1:${localPort}`].includes(origin)) return notFound(localPort, request, response);
    if (origin) request.headers.origin = NEXT_ORIGIN;
    forward(localPort, request, response, url.pathname);
  } catch (error) {
    response.writeHead(400, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: String(error.message ?? error) }));
    log(localPort, request, 400);
  }
});

await Promise.all([
  new Promise((resolve, reject) => { publicServer.once('error', reject); publicServer.listen(publicPort, '127.0.0.1', resolve); }),
  new Promise((resolve, reject) => { localServer.once('error', reject); localServer.listen(localPort, '127.0.0.1', resolve); }),
]);
console.log(`iHear classroom trial server (${vendor.CLASSROOM_PROVIDER}); round 1: no recording.`);
console.log(`  public, for the tunnel only: http://127.0.0.1:${publicPort} (classroom pages and their APIs only)`);
console.log(`  local, this computer only:   http://127.0.0.1:${localPort}/trial/owner (overview) and POST /trial/lessons`);
console.log(`  data: ${dataDir}`);
const stop = () => { publicServer.close(); localServer.close(); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
