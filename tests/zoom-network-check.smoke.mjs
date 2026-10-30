// The offline network check (tools/network-check/zoom-network-check.html) in Chromium, opened from
// disk as a tester would open it (2026-10-31). Nothing may leave the page before "開始測試"; once
// started it may reach only its listed addresses. On this computer's ordinary network every Zoom
// file must check out against the official package. Then each kind of trouble is staged with
// Playwright routes on chosen addresses, and the page must name it rightly: a browser rule (CORS)
// is not a connection failure, a failure or a timeout is never called a block, altered content is
// not a success, and a network with nothing reachable cannot be judged at all.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium, expect } from '@playwright/test';

const page = path.resolve('tools/network-check/zoom-network-check.html');
const directory = path.resolve('output/playwright', `zoom-network-check-${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}`);
await mkdir(directory, { recursive: true });
// The page's own DNS reference lookups; everything else it reaches must be on its list exactly.
const DNS_LOOKUP = /^https:\/\/dns\.alidns\.com\/resolve\?name=[a-z0-9.-]+&type=1$/;
const report = { startedAt: new Date().toISOString(), checks: [], status: 'running' };
let browser, failure;

async function check(name, action) {
  try { await action(); report.checks.push({ name, status: 'passed' }); console.log(`PASS ${name}`); }
  catch (error) { report.checks.push({ name, status: 'failed', error: error.message }); throw error; }
}
// One fresh browser profile per scenario; every request the page makes is kept.
async function open({ timeout, routes = [] } = {}) {
  const context = await browser.newContext({ locale: 'zh-TW', viewport: { width: 1100, height: 900 } });
  const requests = [];
  context.on('request', request => requests.push(request.url()));
  for (const [pattern, handler] of routes) await context.route(pattern, handler);
  const tab = await context.newPage();
  const problems = [];
  tab.on('pageerror', error => problems.push(error.message));
  await tab.goto(`${pathToFileURL(page).href}${timeout ? `?timeout=${timeout}` : ''}`);
  return { context, tab, requests, problems };
}
const start = async ({ tab }, limit = 240_000) => {
  await tab.getByRole('button', { name: '開始測試' }).click();
  await expect(tab.locator('body')).toHaveAttribute('data-state', 'done', { timeout: limit });
};
const status = (tab, id) => tab.locator(`tr[data-item="${id}"]`).getAttribute('data-status');
const verdict = (tab, group) => tab.locator(`#summary li[data-group="${group}"]`).getAttribute('data-verdict');
const row = (tab, id) => tab.locator(`tr[data-item="${id}"]`).innerText();

try {
  browser = await chromium.launch({ channel: 'chromium', headless: process.env.IHEAR_HEADED !== '1' });

  await check('opened from disk, the page sends nothing until "開始測試" is pressed, and lists where it will go', async () => {
    const view = await open();
    await expect(view.tab.locator('body')).toHaveAttribute('data-state', 'ready');
    await view.tab.waitForTimeout(1500);
    expect(view.requests.filter(url => !url.startsWith('file:'))).toEqual([]);
    await expect(view.tab.locator('#destinations li')).toHaveCount(18);
    await expect(view.tab.getByText('不收集姓名、Email 或 IP')).toBeVisible();
    await view.context.close();
  });

  let normal;
  await check('on this computer\'s network every Zoom file matches the official 2.6.0 package and every address answers', async () => {
    normal = await open();
    await start(normal);
    for (const id of ['global-manifest', 'global-media', 'china-manifest', 'china-media']) {
      expect([id, await status(normal.tab, id)]).toEqual([id, 'success']);
      expect(await row(normal.tab, id)).toContain('SHA-256 相符');
    }
    expect(await status(normal.tab, 'join')).toBe('success');
    expect(await status(normal.tab, 'whiteboard')).toBe('success');
    expect(await status(normal.tab, 'cloudflare')).toBe('success');
    for (const group of ['global', 'china', 'join']) expect([group, await verdict(normal.tab, group)]).toEqual([group, 'ok']);
    expect(await verdict(normal.tab, 'dc')).toBe('8/8');
    expect(await verdict(normal.tab, 'signaling')).toBe('2/2');
    expect(normal.problems).toEqual([]);
    await normal.tab.screenshot({ path: path.join(directory, 'normal.png'), fullPage: true });
  });

  await check('once started, only the addresses on the page\'s own list were reached', async () => {
    // Text content: the list sits in a closed <details>, which Chromium does not render.
    const listed = (await normal.tab.locator('#destinations li').allTextContents()).filter(text => /^https:\/\/\S+$/.test(text));
    expect(listed).toHaveLength(17);
    const outside = normal.requests.filter(url => !url.startsWith('file:') && !listed.includes(url) && !DNS_LOOKUP.test(url));
    expect(outside).toEqual([]);
    expect(normal.requests.filter(url => DNS_LOOKUP.test(url))).toHaveLength(15);
  });

  await check('the copyable text is Traditional Chinese, says what was tested, and holds no personal data', async () => {
    const text = await normal.tab.locator('#text').inputValue();
    report.normalText = text;
    for (const part of ['Zoom 視訊連線診斷（第一階段）結果', '【判讀】', '【明細】', '測試時間：', '瀏覽器：', '不代表 Zoom 視訊一定能正常通話', 'jssdk.zoomus.cn', 'source.zoom.us']) expect(text).toContain(part);
    expect(text).not.toMatch(/@|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
    // Only server addresses from the DNS reference may appear, never a private or local one.
    expect(text).not.toMatch(/\b(10|127|192\.168|172\.(1[6-9]|2\d|3[01]))\.\d+\.\d+/);
    expect(text).not.toContain(await normal.tab.evaluate(() => navigator.userAgent));
    await writeFile(path.join(directory, 'normal.txt'), `${text}\n`);
    await normal.tab.getByRole('button', { name: '複製結果' }).click();
    await expect(normal.tab.locator('#copied')).toHaveText(/已複製|無法自動複製/);
    await normal.context.close();
  });

  await check('staged trouble is named for what it is: altered content, a missing file, a browser rule (CORS), a timeout, an unstable line, a blocking extension', async () => {
    let cloudflareTries = 0;
    const view = await open({ timeout: 2, routes: [
      // Altered content is not a success.
      ['https://source.zoom.us/videosdk/2.6.0/lib/manifest.json', route => route.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' }, body: '{"altered":true}' })],
      // The server answers, but without the file.
      ['https://jssdk.zoomus.cn/videosdk/2.6.0/lib/manifest.json', route => route.fulfill({ status: 404, headers: { 'access-control-allow-origin': '*' }, body: 'Not found' })],
      // The real file, but readable only by another site: a browser rule (CORS), not a block.
      // (Playwright adds a permissive header when none is given, so another origin is named.)
      ['https://jssdk.zoomus.cn/videosdk/2.6.0/lib/js_media.min.js', async route => {
        const response = await route.fetch();
        await route.fulfill({ response, headers: { ...response.headers(), 'access-control-allow-origin': 'https://another-site.example' } });
      }],
      // No answer at all, until the page's own deadline.
      ['https://zoom.us/wc/lsdk', () => new Promise(() => {})],
      // Fails once, then works.
      ['https://trycloudflare.com/', route => { cloudflareTries += 1; return cloudflareTries === 1 ? route.abort('connectionreset') : route.continue(); }],
      // A browser extension (an ad blocker, say) stopping a request.
      ['https://dcsznginx-prod-colo-sin.sin.zoom.us/', route => route.abort('blockedbyclient')],
    ] });
    await start(view, 120_000);
    const expected = { 'global-manifest': 'mismatch', 'global-media': 'success', 'china-manifest': 'http-error', 'china-media': 'cors', join: 'timeout', cloudflare: 'unstable', 'dc-dcsznginx-prod-colo-sin.sin.zoom.us': 'fail' };
    for (const [id, state] of Object.entries(expected)) expect([id, await status(view.tab, id)]).toEqual([id, state]);
    expect(await row(view.tab, 'china-media')).toContain('不代表被封鎖');
    expect(await row(view.tab, 'china-manifest')).toContain('伺服器回應 HTTP 404');
    // A server that answered was reached: no DNS hint there, only where the connection failed.
    for (const id of ['global-manifest', 'china-manifest', 'china-media']) expect([id, await row(view.tab, id)]).not.toEqual([id, expect.stringContaining('公共 DNS')]);
    expect(await row(view.tab, 'join')).toContain('公共 DNS');
    expect(await row(view.tab, 'join')).toContain('等太久沒有回應');
    expect(await row(view.tab, 'cloudflare')).toContain('3 次中 2 次成功');
    expect(await row(view.tab, 'dc-dcsznginx-prod-colo-sin.sin.zoom.us')).toContain('瀏覽器擴充套件');
    expect(await verdict(view.tab, 'global')).toBe('mismatch');
    expect(await verdict(view.tab, 'china')).toBe('indeterminate');
    expect(await verdict(view.tab, 'join')).toBe('unreachable');
    expect(await verdict(view.tab, 'dc')).toBe('7/8');
    expect(await view.tab.locator('main').innerText()).not.toMatch(/已被封鎖|確定被封鎖|遭到封鎖/);
    await view.tab.screenshot({ path: path.join(directory, 'staged-trouble.png'), fullPage: true });
    await view.context.close();
  });

  await check('a name the browser cannot resolve fails as a connection, with the public-DNS reference beside it, and is not called a block', async () => {
    const view = await open({ timeout: 2, routes: [['https://jssdk.zoomus.cn/**', route => route.abort('namenotresolved')]] });
    await start(view, 120_000);
    for (const id of ['china-manifest', 'china-media']) expect([id, await status(view.tab, id)]).toEqual([id, 'fail']);
    for (const id of ['global-manifest', 'global-media']) expect([id, await status(view.tab, id)]).toEqual([id, 'success']);
    expect(await verdict(view.tab, 'china')).toBe('unreachable');
    expect(await view.tab.locator('#summary li[data-group="china"]').innerText()).toContain('本工具不判定是否被封鎖');
    expect(await row(view.tab, 'china-manifest')).toContain('本工具無法分辨');
    expect(await row(view.tab, 'china-manifest')).toContain('（參考）中國大陸公共 DNS（阿里雲）查得到這個網址');
    await view.context.close();
  });

  await check('with nothing reachable at all, the page says it cannot judge rather than blaming any service', async () => {
    const view = await open({ timeout: 2, routes: [[url => url.protocol === 'https:', route => route.abort('internetdisconnected')]] });
    await start(view, 120_000);
    const states = await view.tab.locator('tr[data-item]').evaluateAll(rows => rows.map(row => `${row.dataset.item}=${row.dataset.status}`));
    expect(states.filter(state => !state.endsWith('=fail'))).toEqual([]);
    await expect(view.tab.locator('#summary li')).toHaveCount(1);
    expect(await verdict(view.tab, 'overall')).toBe('offline');
    expect(await view.tab.locator('#summary').innerText()).toContain('無法判讀');
    await view.context.close();
  });

  report.status = 'passed';
} catch (error) {
  failure = error;
  report.status = 'failed';
  report.error = error.message;
} finally {
  await browser?.close();
  report.finishedAt = new Date().toISOString();
  await writeFile(path.join(directory, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Report: ${path.join(directory, 'report.json')}`);
}
if (failure) { console.error(failure); process.exit(1); }
