// The draft privacy policy never reaches a hosted site (2026-11-10). Prepares the pages as a Vercel
// production build would (VERCEL=1, VERCEL_ENV=production), checks what the build output holds,
// then serves the built site as production and checks every way in: /privacy, /privacy.html, HEAD,
// a query, a trailing slash, other casing, the footers of all public pages, the sitemap and the
// content API. Local only (127.0.0.1, disposable data); the local pages are prepared again at the end.
import { spawn, execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const origin = 'http://127.0.0.1:3221';
const PAGES = ['/', '/about', '/programs', '/impact', '/team', '/submit-bio', '/stories', '/get-involved', '/academy', '/donate', '/resources', '/faq', '/contact', '/events'];
// What only the draft carries (the stylesheet's class names are not content).
const DRAFT = [/class="policy-draft-notice"/, /data-decision="PD-/, /data-privacy-link/, /尚未經 iHear 核准/, /Draft — not yet approved by iHear/, /Pending iHear decision PD-/];

async function filesUnder(directory) {
  const out = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) out.push(...await filesUnder(full));
    else if (/\.(html|xml|json|js|txt)$/i.test(entry.name)) out.push(full);
  }
  return out;
}

function prepare(env) {
  return execFileSync(process.execPath, ['scripts/prepare-public.mjs'], { env: { ...process.env, ...env }, encoding: 'utf8', windowsHide: true });
}

let child;
try {
  // 0. The committed template must stay empty: a privacy.html that carries policy content fails the
  // build (restored right after, whatever happens).
  const template = await readFile('privacy.html', 'utf8');
  try {
    await writeFile('privacy.html', template.replace('<!-- privacy-policy:start -->', '<!-- privacy-policy:start --><article class="policy-body" lang="en" data-policy-lang="en">copied content</article>'));
    assert.throws(() => prepare({ VERCEL: '', VERCEL_ENV: '' }), /privacy.html must stay a template in the repository/, 'A template with content fails the build');
  } finally {
    await writeFile('privacy.html', template);
  }

  // 1. The hosted build output.
  // Texts at hand and the preview flag set: a hosted build still leaves the draft out.
  const texts = { IHEAR_PRIVACY_SOURCES: 'tests/fixtures/privacy-policy', IHEAR_PRIVACY_PREVIEW: '1' };
  // First a local preview build in the same folder, so an old privacy page is there to leave behind.
  prepare({ ...texts, VERCEL: '', VERCEL_ENV: '' });
  assert.ok(existsSync('.private/privacy.html'), 'The local preview build has a privacy page');
  const log = prepare({ ...texts, VERCEL: '1', VERCEL_ENV: 'production' });
  assert.match(log, /privacy policy draft, checked but left out of this build/, 'The build says it left the draft out');
  assert.ok(!existsSync('public/privacy.html') && !existsSync('.private/privacy.html'), 'No privacy page in the build output');
  for (const file of [...await filesUnder('public'), ...await filesUnder('.private')]) {
    if (/assets[\\/]site\.css$/.test(file)) continue;
    const text = await readFile(file, 'utf8');
    for (const pattern of DRAFT) assert.doesNotMatch(text, pattern, `${file} carries draft content (${pattern})`);
  }
  assert.doesNotMatch(await readFile('public/sitemap.xml', 'utf8'), /\/privacy</, 'The sitemap does not list the draft');
  // A Vercel preview, an unknown host, a missing flag, or no texts at all: left out every time.
  for (const [name, env] of [['Vercel preview', { ...texts, VERCEL: '1', VERCEL_ENV: 'preview' }], ['unknown host (AWS Lambda)', { ...texts, VERCEL: '', VERCEL_ENV: '', AWS_LAMBDA_FUNCTION_NAME: 'x' }], ['flag missing', { IHEAR_PRIVACY_SOURCES: texts.IHEAR_PRIVACY_SOURCES, IHEAR_PRIVACY_PREVIEW: '', VERCEL: '', VERCEL_ENV: '' }], ['flag not exactly 1', { ...texts, IHEAR_PRIVACY_PREVIEW: 'yes', VERCEL: '', VERCEL_ENV: '' }], ['no texts', { IHEAR_PRIVACY_SOURCES: '', IHEAR_PRIVACY_PREVIEW: '1', VERCEL: '', VERCEL_ENV: '' }]]) {
    assert.match(prepare(env), /left out of this build/, `${name}: the draft is left out`);
    assert.ok(!existsSync('.private/privacy.html'), `${name}: no privacy page in the output`);
  }

  // 2. The built site served as production with the preview flag set (VERCEL_ENV=production; stores stay on local files).
  prepare({ ...texts, VERCEL: '1', VERCEL_ENV: 'production' });
  await mkdir('output', { recursive: true });
  const data = await mkdtemp(path.resolve('output/privacy-gate-'));
  child = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '--hostname', '127.0.0.1', '--port', '3221'], {
    env: { ...process.env, ...texts, NODE_ENV: 'production', VERCEL: '', VERCEL_ENV: 'production', NETLIFY: '', CONTEXT: '', POSTGRES_URL: '', DATABASE_URL: '', IHEAR_FORCE_FILE_STORE: '1', IHEAR_TEST_DATA_DIR: data },
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout.on('data', chunk => { logs += chunk; });
  child.stderr.on('data', chunk => { logs += chunk; });
  let ready = false;
  for (let attempt = 0; attempt < 60 && !ready; attempt++) {
    if (child.exitCode !== null) throw new Error(`Server exited: ${logs}`);
    try { ready = (await fetch(`${origin}/api/content/get?page=%2F`)).ok; } catch {}
    if (!ready) await new Promise(resolve => { setTimeout(resolve, 500); });
  }
  assert.ok(ready, 'Built server starts');
  const ways = [['GET', '/privacy'], ['HEAD', '/privacy'], ['GET', '/privacy?lang=en'], ['GET', '/privacy/'], ['GET', '/Privacy'], ['GET', '/privacy.html'], ['GET', '/PRIVACY.html']];
  for (const [method, route] of ways) {
    const response = await fetch(origin + route, { method });
    assert.equal(response.status, 404, `${method} ${route} → ${response.status} (${response.url})`);
    const text = method === 'HEAD' ? '' : await response.text();
    for (const pattern of DRAFT) assert.doesNotMatch(text, pattern, `${method} ${route} shows draft content`);
  }
  const redirect = await fetch(`${origin}/privacy.html`, { redirect: 'manual' });
  assert.ok([301, 308].includes(redirect.status) && new URL(redirect.headers.get('location'), origin).pathname === '/privacy', '/privacy.html only redirects to /privacy');
  for (const page of PAGES) {
    const response = await fetch(origin + page);
    assert.equal(response.status, 200, page);
    const html = await response.text();
    for (const pattern of DRAFT) assert.doesNotMatch(html, pattern, `${page} shows draft content`);
    assert.doesNotMatch(html, /href="\/privacy"/, `${page} links to the draft`);
  }
  const sitemap = await (await fetch(`${origin}/sitemap.xml`)).text();
  assert.doesNotMatch(sitemap, /\/privacy</, 'The served sitemap does not list the draft');
  const content = await (await fetch(`${origin}/api/content/get?page=%2Fprivacy`)).text();
  for (const pattern of DRAFT) assert.doesNotMatch(content, pattern, 'The content API carries no draft text');
  console.log(`Privacy production gate passed: hosted build output holds no draft (page, footer links, sitemap); served as production, ${ways.length} ways to /privacy answer 404, ${PAGES.length} public pages carry no link or draft text, sitemap and content API clean.`);
} finally {
  child?.kill();
  // Back to the default (fail-closed) local pages.
  prepare({ VERCEL: '', VERCEL_ENV: '', NETLIFY: '', CONTEXT: '', IHEAR_PRIVACY_PREVIEW: '', IHEAR_PRIVACY_SOURCES: '', AWS_LAMBDA_FUNCTION_NAME: '' });
}
