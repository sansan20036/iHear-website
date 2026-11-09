// The admin sidebar's menu scrolls on its own, so the brand, the language switch, the account, the
// public-site link and Sign out stay on screen however many menu entries there are.
// Real application (next start, or next dev with --dev), isolated local file storage and a test-only
// Auth.js key, like resources-admin.smoke.mjs. No production credentials or production writes.
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';
import { encode } from 'next-auth/jwt';

const dev = process.argv.includes('--dev');
const port = 3217;
const origin = `http://localhost:${port}`;
const secret = 'isolated-admin-sidebar-smoke-test-key-never-use-in-production';
const owner = 'sidebar-test@example.com';
// The owner's menu in Traditional Chinese (app/admin/admin-shell.tsx), in order.
const OWNER_MENU = ['總覽', '網站內容', 'Academy 課程頁', '首頁行事曆', '團隊名冊', '成果資料', '媒體展示', '資源管理', '回收區', '線上教室', '管理員'];
await mkdir('output/playwright', { recursive: true });
const directory = await mkdtemp(path.resolve('output/playwright/admin-sidebar-'));
const child = spawn(process.execPath, ['node_modules/next/dist/bin/next', dev ? 'dev' : 'start', '--hostname', 'localhost', '--port', String(port)], {
  env: { ...process.env, NODE_ENV: dev ? 'development' : 'production', VERCEL: '', NETLIFY: '', CONTEXT: '', IHEAR_FORCE_FILE_STORE: '1', IHEAR_TEST_DATA_DIR: directory, AUTH_SECRET: secret, AUTH_OWNER_EMAILS: owner, AUTH_URL: origin, AUTH_TRUST_HOST: 'true' },
  windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
});
let logs = ''; child.stdout.on('data', chunk => { logs += chunk; }); child.stderr.on('data', chunk => { logs += chunk; });
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`); };
let browser;
try {
  let started = false;
  for (let i = 0; i < 240; i++) {
    if (child.exitCode !== null) throw new Error(`Test server exited: ${logs}`);
    try { if ((await fetch(`${origin}/api/media-galleries`)).ok) { started = true; break; } } catch { /* server starting */ }
    await new Promise(resolve => { setTimeout(resolve, 500); });
  }
  if (!started) throw new Error(`Test server did not start: ${logs}`);
  browser = await chromium.launch({ headless: true, args: process.platform === 'win32' ? ['--force-device-scale-factor=1'] : [] });
  const token = await encode({ secret, salt: 'authjs.session-token', token: { name: 'Sidebar test', email: owner, sub: 'sidebar-test' } });

  const open = async (width, height, pathname = '/admin') => {
    const context = await browser.newContext({ viewport: { width, height }, locale: 'zh-TW' });
    await context.addCookies([{ name: 'authjs.session-token', value: token, url: origin, httpOnly: true, sameSite: 'Lax' }]);
    const page = await context.newPage();
    await page.goto(origin + pathname);
    // Every entry an owner should see, each once, with Administrators last (the checks below scroll
    // to it). Not a fixed total: a new owner entry (such as the classroom overview) does not break this.
    for (const label of OWNER_MENU) await expect(page.locator('.admin-sidebar nav button', { hasText: label }), label).toHaveCount(1, { timeout: 60_000 });
    await expect(page.locator('.admin-sidebar nav button').last()).toContainText('管理員');
    return { context, page };
  };
  // Fully inside the window, top to bottom.
  const onScreen = async (page, locator) => {
    const box = await locator.boundingBox();
    const { height } = page.viewportSize();
    return Boolean(box) && box.y >= 0 && box.y + box.height <= height + 0.5;
  };
  // Fully inside the menu's visible area, and on screen.
  const insideMenu = async (page, locator) => (await locator.evaluate(element => {
    const nav = element.closest('nav').getBoundingClientRect(), item = element.getBoundingClientRect();
    return item.top >= nav.top - 0.5 && item.bottom <= nav.bottom + 0.5;
  })) && onScreen(page, locator);
  const menuScroll = page => page.locator('.admin-sidebar nav').evaluate(nav => ({ scrollable: nav.scrollHeight > nav.clientHeight + 1, top: nav.scrollTop }));
  const bottomParts = page => [
    ['the brand', page.locator('.admin-brand')],
    ['the language switch', page.locator('.admin-languages')],
    ['the account', page.locator('.admin-identity')],
    ['the public-site link', page.locator('.admin-sidebar-bottom .admin-sidebar-link').first()],
    ['Sign out', page.locator('.admin-sidebar-bottom .admin-sidebar-link').last()],
  ];

  // 1. A laptop window too short for the whole sidebar: only the menu scrolls.
  {
    const { context, page } = await open(1280, 640);
    for (const [name, locator] of bottomParts(page)) check(`1280x640: ${name} is on screen without scrolling`, await onScreen(page, locator));
    check('1280x640: the menu scrolls on its own', (await menuScroll(page)).scrollable);
    const admins = page.locator('.admin-sidebar nav button').last();
    await admins.scrollIntoViewIfNeeded();
    check('1280x640: the last menu entry (Admins) can be scrolled into the menu', await insideMenu(page, admins));
    for (const [name, locator] of bottomParts(page)) check(`1280x640: ${name} stays on screen after the menu scrolls`, await onScreen(page, locator));
    await admins.click();
    await page.waitForURL(`${origin}/admin/admins`);
    check('1280x640: clicking the scrolled-to entry opens it', page.url() === `${origin}/admin/admins`);
    check('1280x640: the main area keeps its 250px offset', await page.locator('.admin-main').evaluate(main => getComputedStyle(main).marginLeft === '250px'));
    await context.close();
  }
  // 2. Opening a page whose entry is far down the menu shows that entry.
  {
    const { context, page } = await open(1280, 640, '/admin/admins');
    const active = page.locator('.admin-sidebar nav button.active');
    await expect(active).toHaveCount(1);
    await page.waitForTimeout(300);
    check('1280x640 opened on /admin/admins: its menu entry is in view', await insideMenu(page, active));
    await context.close();
  }
  // 3. A tall window looks as before: no menu scrolling, every entry and Sign out visible.
  {
    const { context, page } = await open(1280, 1000);
    check('1280x1000: the menu does not need to scroll', !(await menuScroll(page)).scrollable);
    let all = true;
    for (const button of await page.locator('.admin-sidebar nav button').all()) all &&= await onScreen(page, button);
    check('1280x1000: every menu entry is on screen', all);
    for (const [name, locator] of bottomParts(page)) check(`1280x1000: ${name} is on screen`, await onScreen(page, locator));
    await context.close();
  }
  // 4. A very short window: the whole sidebar scrolls, so nothing is out of reach.
  {
    const { context, page } = await open(1280, 420);
    const signOut = page.locator('.admin-sidebar-bottom .admin-sidebar-link').last();
    await signOut.scrollIntoViewIfNeeded();
    check('1280x420: Sign out can be scrolled onto the screen', await onScreen(page, signOut));
    const admins = page.locator('.admin-sidebar nav button').last();
    await admins.scrollIntoViewIfNeeded();
    check('1280x420: the last menu entry can be scrolled onto the screen', await onScreen(page, admins));
    await context.close();
  }
  // 5. A phone: the drawer behaves like the desktop sidebar.
  {
    const { context, page } = await open(390, 640);
    await page.locator('.admin-mobile-header .admin-icon-button').click();
    await expect(page.locator('.admin-sidebar.is-open')).toHaveCount(1);
    await page.waitForTimeout(400);
    for (const [name, locator] of bottomParts(page)) check(`390x640 drawer: ${name} is on screen`, await onScreen(page, locator));
    check('390x640 drawer: the menu scrolls on its own', (await menuScroll(page)).scrollable);
    const admins = page.locator('.admin-sidebar nav button').last();
    await admins.scrollIntoViewIfNeeded();
    check('390x640 drawer: the last menu entry can be scrolled into the menu', await insideMenu(page, admins));
    await mkdir(directory, { recursive: true });
    await page.screenshot({ path: path.join(directory, 'drawer-390x640.png') });
    await context.close();
  }
  // Screenshots for a person to look at: the short laptop window, at the top and scrolled.
  {
    const { context, page } = await open(1280, 640);
    await page.locator('.admin-sidebar').screenshot({ path: path.join(directory, 'sidebar-1280x640-top.png') });
    await page.locator('.admin-sidebar nav').evaluate(nav => { nav.scrollTop = nav.scrollHeight; });
    await page.locator('.admin-sidebar').screenshot({ path: path.join(directory, 'sidebar-1280x640-scrolled.png') });
    await context.close();
  }
} finally {
  await browser?.close();
  child.kill();
}
const failed = results.filter(result => !result.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed. Screenshots and data: ${directory}`);
if (failed) process.exitCode = 1;
