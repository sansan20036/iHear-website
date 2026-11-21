// Shared setup for the Academy browser checks: the built application behind the
// checked-in hosting headers, disposable local storage and test-only sessions.
// No production credentials, data or requests are used.
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import path from 'node:path';
import { encode } from 'next-auth/jwt';

export const SESSION_COOKIE = 'authjs.session-token';

// Round 4 (2026-11-21): every whole link an admin page shows once (one-to-one lessons, blocks and
// the schedule import, fixed rooms) is masked in every picture a check takes, so no screenshot left
// behind holds a link. Every classroom check takes its pictures through screenshotSafely.
export const LINK_ON_SCREEN = '.classroom-link code, [data-student-link] code, [data-room-link] code';
export const screenshotSafely = (page, options = {}) => page.screenshot({ ...options, mask: [...(options.mask ?? []), page.locator(LINK_ON_SCREEN)] });

// Round 4 (2026-11-21): a check that fails while a link is in an error message (Playwright prints the
// address it was going to) never leaves the link's key in its report or on the console: keys behind
// #k=, ?k=, &k= or ticket= become [redacted]. withoutLinkKeys gives a plain error with the message and
// the stack redacted and nothing else (a Playwright error also carries its call log).
export const redactLinks = text => String(text).replace(/([#?&]k=|\bticket=)[A-Za-z0-9_-]{8,}/g, '$1[redacted]');
export function withoutLinkKeys(error) {
  const clean = new Error(redactLinks(error?.message ?? error));
  clean.stack = redactLinks(error?.stack ?? clean.stack);
  return clean;
}

export async function startAcademyServer({ port, secret, owners, name }) {
  const origin = `http://localhost:${port}`;
  await mkdir('output/playwright', { recursive: true });
  const directory = await mkdtemp(path.resolve(`output/playwright/${name}-`));
  const child = spawn(process.execPath, ['tests/helpers/academy-header-server.mjs'], {
    env: { ...process.env, NODE_ENV: 'production', ACADEMY_TEST_PORT: String(port),
      POSTGRES_URL: '', DATABASE_URL: '', VERCEL: '', NETLIFY: '', CONTEXT: '',
      SUPABASE_URL: '', SUPABASE_SERVICE_ROLE_KEY: '', SENDGRID_API_KEY: '', SENDGRID_FROM_EMAIL: '',
      IHEAR_FORCE_FILE_STORE: '1', IHEAR_TEST_DATA_DIR: directory, AUTH_SECRET: secret,
      AUTH_OWNER_EMAILS: owners.join(','), AUTH_ADMIN_EMAILS: '', AUTH_URL: origin, AUTH_TRUST_HOST: 'true' },
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout.on('data', data => { logs += data; });
  child.stderr.on('data', data => { logs += data; });
  for (let attempt = 0; attempt < 120; attempt++) {
    if (child.exitCode !== null) throw new Error(`Test server exited: ${logs}`);
    try { if ((await fetch(`${origin}/api/academy-content`)).ok) return { origin, directory, child, logs: () => logs }; } catch { /* starting */ }
    await new Promise(resolve => { setTimeout(resolve, 500); });
  }
  child.kill();
  throw new Error(`Test server did not start: ${logs}`);
}

export function sessionToken(secret, email, maxAge) {
  return encode({ secret, salt: SESSION_COOKIE, token: { name: 'Local acceptance', email, sub: email }, ...(maxAge === undefined ? {} : { maxAge }) });
}

/** A browser context that can reach only the local test origin. */
export async function localContext(browser, origin, options = {}) {
  const { email, secret, maxAge, external, ...contextOptions } = options;
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, ...contextOptions });
  context.setDefaultTimeout(15000);
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin === origin || url.protocol === 'data:' || url.protocol === 'blob:') return route.continue();
    external?.push(url.href);
    return route.abort();
  });
  if (email) await setSession(context, origin, secret, email, maxAge);
  return context;
}

export async function setSession(context, origin, secret, email, maxAge) {
  await context.addCookies([{ name: SESSION_COOKIE, value: await sessionToken(secret, email, maxAge), url: origin, httpOnly: true, sameSite: 'Lax' }]);
}

export async function localDocument(directory) {
  return JSON.parse(await readFile(path.join(directory, 'academy-content.json'), 'utf8'));
}

export function noHorizontalOverflow(page) {
  return page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
}
