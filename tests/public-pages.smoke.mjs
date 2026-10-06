// Exercise the actual built Next routes; only local, read-only HTTP requests.
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
const origin = 'http://127.0.0.1:3214';
const pages = ['/', '/about', '/programs', '/impact', '/team', '/submit-bio', '/stories', '/get-involved', '/academy', '/donate', '/resources', '/faq', '/contact'];
const academyPath = '/academy/courses';
const academyCanonical = `https://www.ihearus.org${academyPath}`;

function tags(html, name) {
  return [...html.matchAll(new RegExp(`<${name}\\b[^>]*>`, 'gi'))].map(([tag]) =>
    Object.fromEntries([...tag.matchAll(/([\w:-]+)\s*=\s*(["'])(.*?)\2/g)].map(([, key, , value]) =>
      [key.toLowerCase(), value.replace(/&amp;/g, '&')])));
}

const checkedAssets = new Set();
async function checkAcademyAsset(value, base) {
  const url = new URL(value, base);
  if (url.origin !== origin) return;
  assert.ok(url.pathname.startsWith(`${academyPath}/`), `Academy asset stays within its directory: ${url.pathname}`);
  if (checkedAssets.has(url.href)) return;
  checkedAssets.add(url.href);
  const response = await fetch(url);
  assert.equal(response.status, 200, `Academy asset: ${url.pathname}`);
  const contentType = response.headers.get('content-type') || '';
  assert.doesNotMatch(contentType, /html/i, `Asset must not fall back to HTML: ${url.pathname}`);
  const bytes = await response.arrayBuffer();
  assert.ok(bytes.byteLength > 0, `Academy asset is not empty: ${url.pathname}`);
  const text = new TextDecoder().decode(bytes);
  assert.doesNotMatch(text.slice(0, 200), /^\s*(?:<!doctype\s+html|<html\b)/i, `Asset body must not be HTML: ${url.pathname}`);
  if (/\.css$/i.test(url.pathname)) {
    assert.match(contentType, /text\/css/i, `CSS content type: ${url.pathname}`);
    const references = [
      ...[...text.matchAll(/url\(\s*(["']?)(.*?)\1\s*\)/gi)].map(match => match[2]),
      ...[...text.matchAll(/@import\s+(["'])(.*?)\1/gi)].map(match => match[2]),
    ];
    for (const reference of references) await checkAcademyAsset(reference, url);
  }
}

async function checkAcademyPage(page, lang) {
  const url = origin + page;
  const response = await fetch(url);
  assert.equal(response.status, 200, page);
  assert.equal(response.url, url, `Clean Academy URL has no redirect: ${page}`);
  assert.match(response.headers.get('content-type') || '', /text\/html/i, page);
  const html = await response.text();
  assert.equal(tags(html, 'html')[0]?.lang, lang, `Academy language: ${page}`);
  assert.doesNotMatch(html, /chatgpt\.(?:site|com)|openai-sidetron|hide-editor\.js/i, `Academy is independent of GPT hosting: ${page}`);
  const scripts = tags(html, 'script');
  assert.doesNotMatch(scripts.map(script => script.src || '').join('\n'), /(?:\/api\/auth(?:\/|\b)|\/auth\.js(?:\?|$))/i, `Academy has no authentication scripts: ${page}`);

  const links = tags(html, 'link');
  const canonical = links.filter(link => link.rel === 'canonical');
  assert.deepEqual(canonical.map(link => link.href), [`https://www.ihearus.org${page}`], `Academy canonical: ${page}`);
  const alternates = links.filter(link => link.rel === 'alternate' && link.hreflang);
  assert.equal(alternates.length, 3, `Three Academy language alternates: ${page}`);
  assert.deepEqual(Object.fromEntries(alternates.map(link => [link.hreflang, link.href])), {
    en: academyCanonical,
    'zh-Hant': `${academyCanonical}/zh`,
    'x-default': academyCanonical,
  }, `Academy hreflang URLs: ${page}`);

  for (const [language, destination] of [['en', academyPath], ['zh-Hant', `${academyPath}/zh`]]) {
    const switches = tags(html, 'a').filter(link => link.lang === language);
    assert.equal(switches.length, 2, `Header and footer ${language} language links: ${page}`);
    for (const link of switches) assert.equal(link.href, destination, `Clean language destination: ${page}`);
  }

  const head = await fetch(url, { method: 'HEAD' });
  assert.equal(head.status, 200, `HEAD ${page}`);
  assert.match(head.headers.get('content-type') || '', /text\/html/i, `HEAD content type: ${page}`);
  assert.equal(await head.text(), '', `HEAD has no response body: ${page}`);
  for (const alias of [`${page}/`, `${page}/index.html`]) {
    const redirect = await fetch(origin + alias, { redirect: 'manual' });
    assert.ok([301, 308].includes(redirect.status), `Permanent redirect: ${alias}`);
    assert.equal(new URL(redirect.headers.get('location'), origin).href, url, `Redirect destination: ${alias}`);
    const final = await fetch(origin + alias);
    assert.equal(final.status, 200, `Redirect resolves successfully: ${alias}`);
    assert.equal(final.url, url, `Redirect resolves to clean URL: ${alias}`);
    assert.equal(tags(await final.text(), 'html')[0]?.lang, lang, `Redirect retains language: ${alias}`);
  }

  const resources = [
    ...tags(html, 'img').map(img => img.src),
    ...scripts.map(script => script.src),
    ...links.filter(link => !['canonical', 'alternate'].includes(link.rel)).map(link => link.href),
  ].filter(Boolean);
  assert.ok(resources.length > 0, `Academy has linked resources: ${page}`);
  for (const resource of resources) await checkAcademyAsset(resource, url);
}

const child = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '--hostname', '127.0.0.1', '--port', '3214'], {
  env: { ...process.env, NODE_ENV: 'production', VERCEL: '', NETLIFY: '', CONTEXT: '', IHEAR_FORCE_FILE_STORE: '1' },
  windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
});
let logs = '';
child.stdout.on('data', chunk => { logs += chunk; });
child.stderr.on('data', chunk => { logs += chunk; });
try {
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    if (child.exitCode !== null) throw new Error(`Server exited: ${logs}`);
    try { if ((await fetch(origin + '/api/content/get?page=%2F')).ok) { ready = true; break; } } catch {}
    await new Promise(resolve => { setTimeout(resolve, 500); });
  }
  assert.ok(ready, 'Built server starts');
  for (const page of pages) {
    const response = await fetch(origin + page);
    assert.equal(response.status, 200, page);
    assert.match(response.headers.get('cache-control'), /no-store/);
    const html = await response.text();
    const seed = JSON.parse(html.match(/id="ihear-published-content" type="application\/json">([\s\S]*?)<\/script>/)[1]);
    assert.equal(seed.page, page);
    const content = await (await fetch(origin + '/api/content/get?page=' + encodeURIComponent(page))).json();
    assert.deepEqual(seed.store.locales, content.locales);
    const legacy = await fetch(origin + (page === '/' ? '/index' : page) + '.html');
    assert.equal(legacy.status, 200, page + '.html');
    assert.match(await legacy.text(), /id="ihear-published-content"/);
    if (page === '/') {
      assert.deepEqual(seed.metrics, (await (await fetch(origin + '/api/site-metrics')).json()).metrics);
    }
    if (page === '/academy') {
      const links = tags(html, 'a');
      const primary = links.find(link => link['data-layout-link'] === 'academy.acad.cta1.href');
      const secondary = links.find(link => link['data-layout-link'] === 'academy.acad.cta2.href');
      assert.equal(primary?.href, `${academyPath}/zh`, 'Official Academy CTA links to the hosted Chinese course page');
      assert.equal(secondary?.href, 'mailto:ihearprogram@gmail.com?subject=iHear%20Academy%20pricing', 'Official Academy secondary inquiry is retained');
    }
  }
  await checkAcademyPage(academyPath, 'en');
  await checkAcademyPage(`${academyPath}/zh`, 'zh-Hant');
  assert.equal((await fetch(origin + '/unknown-page')).status, 404);
  console.log(`Built public routes passed: 13 current-data pages and two Academy locales; canonical/language URLs, HEAD, redirects, ${checkedAssets.size} Academy resources, official Academy links and unknown-route protection.`);
} catch (error) { console.error(logs.slice(-3000)); throw error; }
finally { child.kill(); }
