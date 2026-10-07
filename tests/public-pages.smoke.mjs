// Public GET may initialize local stores. Keep even read-only HTTP assertions
// in a disposable data directory, never the developer's existing local data.
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
const origin = 'http://127.0.0.1:3214';
const directory = await mkdtemp(path.join(tmpdir(), 'ihear-public-pages-'));
const pages = ['/', '/about', '/programs', '/impact', '/team', '/submit-bio', '/stories', '/get-involved', '/academy', '/donate', '/resources', '/faq', '/contact'];
const child = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '--hostname', '127.0.0.1', '--port', '3214'], {
  env: { ...process.env, NODE_ENV: 'production', VERCEL: '', NETLIFY: '', CONTEXT: '', IHEAR_FORCE_FILE_STORE: '1', IHEAR_TEST_DATA_DIR: directory, DATABASE_URL: '', POSTGRES_URL: '', SUPABASE_URL: '', SUPABASE_SERVICE_ROLE_KEY: '' },
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
  }
  assert.equal((await fetch(origin + '/unknown-page')).status, 404);
  console.log('Built public routes passed: 13 pages, current content/metrics, no-store responses, legacy URLs and unknown-route protection.');
} catch (error) { console.error(logs.slice(-3000)); throw error; }
finally { child.kill(); }
