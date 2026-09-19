// Exercise the actual built Next routes; only local, read-only HTTP requests.
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
const origin = 'http://127.0.0.1:3214';
const pages = ['/', '/about', '/programs', '/impact', '/team', '/submit-bio', '/stories', '/get-involved', '/academy', '/donate', '/resources', '/faq', '/contact'];
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
  }
  assert.equal((await fetch(origin + '/unknown-page')).status, 404);
  console.log('Built public routes passed: 13 pages, current content/metrics, no-store responses, legacy URLs and unknown-route protection.');
} catch (error) { console.error(logs.slice(-3000)); throw error; }
finally { child.kill(); }
