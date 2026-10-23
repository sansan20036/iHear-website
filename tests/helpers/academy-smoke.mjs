// Shared setup for the Academy browser checks: the built application behind the
// checked-in hosting headers, disposable local storage and test-only sessions.
// No production credentials, data or requests are used.
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import path from 'node:path';
import { encode } from 'next-auth/jwt';

export const SESSION_COOKIE = 'authjs.session-token';

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
