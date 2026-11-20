// Classroom 3.0 round 3 (2026-11-21): many fixed rooms in a browser, end to end with synthetic data:
// the built application, disposable local storage and test-only sessions; the synthetic provider
// stands in for Zoom. The iHear teacher (an owner) makes Room1 to Room12 at once and downloads their
// links as one file, once; the rooms are listed in their natural order, can be narrowed to those
// with somebody or by name; every link can be made anew (the old ones then let nobody new in).
// Round 4 (2026-11-21): changes cut off on the way (before the server, or after it with the answer
// lost, or with the rooms unreadable afterwards) are said room by room and never retried by
// themselves; no link key handed out is left in any log, record, report or file.
// Proves our pages and checks, not Zoom.
import { existsSync } from 'node:fs';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, expect as playwrightExpect } from '@playwright/test';
import { localContext, startAcademyServer } from './helpers/academy-smoke.mjs';

const expect = playwrightExpect.configure({ timeout: 15_000 });
const secret = 'classroom-rooms-bulk-local-acceptance-only';
const owner = 'rooms-owner@example.test';
Object.assign(process.env, {
  CLASSROOM_PROVIDER: 'synthetic', CLASSROOM_DRIVE: 'local', CLASSROOM_WEBHOOK_SECRET: 'classroom-rooms-bulk-webhook-local-only',
  CLASSROOM_SYNTHETIC_SECRET: 'classroom-rooms-bulk-token-local-only', VERCEL_ENV: '', CLASSROOM_MULTI_RECORDING: '', CLASSROOM_FIXED_ROOMS: 'on', CLASSROOM_FIXED_ROOM_RECORDING: '',
});
const server = await startAcademyServer({ port: 3267, secret, owners: [owner], name: 'classroom-rooms-bulk' });
const { origin, directory } = server;
const report = { startedAt: new Date().toISOString(), origin, synthetic: true, zoomVerified: false, checks: [], externalRequests: [], pageProblems: [], status: 'running' };
let browser, failure;

async function check(id, name, action) {
  try { await action(); report.checks.push({ id, name, status: 'PASS' }); console.log(`PASS ${id} ${name}`); }
  catch (error) { report.checks.push({ id, name, status: 'FAIL', error: error.message }); throw error; }
}
const context = options => localContext(browser, origin, { external: report.externalRequests, secret, locale: 'zh-TW', ...options });
// Refusals the checks provoke on purpose (too many rooms, a name taken, a replaced link) are not page problems.
const expectedRefusal = text => /Failed to load resource: the server responded with a status of (400|409|410)/.test(text);
// What each confirm asked, as the owner read it before agreeing.
const asked = [];
// While a check cuts a request on purpose, the browser's own "failed to load" line is expected.
let cutting = false;
function watch(page, who) {
  page.on('console', message => { if (message.type() === 'error' && !expectedRefusal(message.text()) && !(cutting && /net::ERR_/.test(message.text()))) report.pageProblems.push(`${who}: ${message.text()}`); });
  page.on('pageerror', error => report.pageProblems.push(`${who}: ${error.message}`));
  page.on('dialog', dialog => { asked.push(dialog.message()); return dialog.accept(); });
  return page;
}
const shot = (page, name) => page.screenshot({ path: path.join(directory, `${name}.png`), fullPage: true });
const LINE = new RegExp(`^"((?:Room|Hall)\\d+)","(${origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/classroom/r/FR-[0-9a-f]{32}#k=[A-Za-z0-9_-]{43})"$`);
// Every link key handed out in a file during the run (round 4: none may be found anywhere after).
const handedOut = new Set();
// The downloaded list: its heading, then one line per room; as [name, address] pairs. The file is
// read once and deleted at once: no list of links is left on this computer.
async function listOf(download) {
  expect(download.suggestedFilename()).toMatch(/^ihear-room-links-\d{4}-\d{2}-\d{2}\.csv$/);
  const where = await download.path();
  const text = await readFile(where, 'utf8');
  await download.delete();
  if (existsSync(where)) throw new Error('a downloaded list of links was left on disk');
  const lines = text.split('\r\n');
  expect(lines[0]).toBe('Room,Link');
  expect(lines.at(-1)).toBe('');
  const rows = lines.slice(1, -1).map(line => { const found = LINE.exec(line); if (!found) throw new Error(`not a room line: ${line.slice(0, 40)}`); return [found[1], found[2]]; });
  for (const [, address] of rows) handedOut.add(address.split('#k=')[1]);
  return rows;
}
// Every file under a folder, however deep.
const filesUnder = async folder => (await readdir(folder, { recursive: true, withFileTypes: true })).filter(entry => entry.isFile()).map(entry => path.join(entry.parentPath ?? entry.path, entry.name));
const names = Array.from({ length: 12 }, (_, index) => `Room${index + 1}`);

try {
  browser = await chromium.launch({ headless: process.env.IHEAR_HEADED !== '1' });
  const admin = watch(await (await context({ email: owner, acceptDownloads: true })).newPage(), 'owner');
  const cards = () => admin.locator('[data-room]');
  const shownRooms = () => cards().evaluateAll(nodes => nodes.map(node => node.getAttribute('data-room')));
  const bulkForm = () => admin.getByRole('form', { name: '一次建立多間' });
  // The bulk tools sit in a section that is closed again after each reload.
  const openBulk = async () => { if (!(await admin.locator('[data-rooms-bulk]').evaluate(node => node.open))) await admin.locator('[data-rooms-bulk] summary').click(); };
  let first, second, third;

  await check('B1', '老師一次建立 Room1 到 Room12：連結清單只出現這一次，可以下載成一個檔案', async () => {
    await admin.goto(`${origin}/admin/classrooms/rooms`);
    await expect(admin.getByText('還沒有固定教室。')).toBeVisible();
    await openBulk();
    await bulkForm().getByLabel('名稱開頭').fill('Room');
    await bulkForm().getByLabel('從幾號').fill('1');
    await bulkForm().getByLabel('到幾號').fill('12');
    await bulkForm().getByRole('button', { name: '一次建立多間' }).click();
    const list = admin.locator('[data-room-links-list]');
    await expect(list).toContainText('已建立 12 間教室');
    const [download] = await Promise.all([admin.waitForEvent('download'), list.getByRole('button', { name: '下載清單（CSV，12 間）' }).click()]);
    first = await listOf(download);
    expect(first.map(([name]) => name)).toEqual(names);
    expect(new Set(first.map(([, address]) => address)).size).toBe(12);
    await shot(admin, 'b1-made');
    await list.getByRole('button', { name: '我已經下載這份清單' }).click();
    await expect(admin.locator('[data-room-links-list]')).toHaveCount(0);
    await admin.reload();
    await expect(cards()).toHaveCount(12);
    await expect(admin.locator('[data-room-links-list]')).toHaveCount(0);
    // No link's key is anywhere in the page.
    expect(await admin.content()).not.toContain('#k=');
  });

  await check('B2', '教室依自然順序排列（Room2 在 Room10 前面）；沒有開啟錄影的網站不顯示錄影開關', async () => {
    expect(await shownRooms()).toEqual(names);
    await expect(admin.locator('[data-rooms-count]')).toHaveText('顯示 12／共 12 間');
    await expect(admin.locator('[data-rooms-recording-all]')).toHaveCount(0);
    await expect(admin.locator('[data-room-recording]')).toHaveCount(0);
  });

  const kyle = watch(await (await context({})).newPage(), 'student-kyle');
  await check('B3', '清單裡 Room3 的連結能用；「只顯示有人的教室」只留下 Room3；用名稱找教室', async () => {
    await kyle.goto(first[2][1]);
    await kyle.getByLabel(/Please enter your first name/).fill('Kyle');
    await kyle.getByRole('button', { name: '進入教室' }).click();
    await expect(kyle.locator('[data-room-waiting]')).toBeVisible();
    await expect(admin.locator('[data-room="Room3"] [data-waiting-person="Kyle"]')).toBeVisible();
    await admin.getByLabel('只顯示有人的教室（在教室裡或等待中）').check();
    await expect(cards()).toHaveCount(1);
    expect(await shownRooms()).toEqual(['Room3']);
    await expect(admin.locator('[data-rooms-count]')).toHaveText('顯示 1／共 12 間');
    await shot(admin, 'b3-occupied-only');
    await admin.getByLabel('只顯示有人的教室（在教室裡或等待中）').uncheck();
    await admin.getByLabel('找教室').fill('room1');
    expect(await shownRooms()).toEqual(['Room1', 'Room10', 'Room11', 'Room12']);
    await admin.getByLabel('找教室').fill('Room99');
    await expect(admin.locator('[data-rooms-none]')).toBeVisible();
    await admin.getByLabel('找教室').fill('');
    await expect(cards()).toHaveCount(12);
  });

  await check('B4', '一次建立被整批拒絕時什麼都不會建立：超過 100 間、名稱已經存在；號碼順序不對時不能送出', async () => {
    await openBulk();
    await bulkForm().getByLabel('從幾號').fill('1');
    await bulkForm().getByLabel('到幾號').fill('101');
    await bulkForm().getByRole('button', { name: '一次建立多間' }).click();
    await expect(admin.locator('p.admin-error')).toHaveText('一次最多 100 間。');
    await bulkForm().getByLabel('從幾號').fill('12');
    await bulkForm().getByLabel('到幾號').fill('13');
    await bulkForm().getByRole('button', { name: '一次建立多間' }).click();
    await expect(admin.locator('p.admin-error')).toHaveText('已經有同名的教室。（Room12）');
    await expect(admin.locator('[data-room-links-list]')).toHaveCount(0);
    await bulkForm().getByLabel('從幾號').fill('5');
    await bulkForm().getByLabel('到幾號').fill('3');
    await expect(bulkForm().getByRole('button', { name: '一次建立多間' })).toBeDisabled();
    await admin.reload();
    await expect(cards()).toHaveCount(12);
    await expect(admin.locator('[data-room="Room13"]')).toHaveCount(0);
  });

  await check('B5', '重新產生全部連結：每間都是新連結；舊連結輸入名字後看到「連結已經更換」，新連結可以用；已經在等待的人要用新連結重來', async () => {
    await openBulk();
    const [download] = await Promise.all([
      admin.waitForEvent('download'),
      (async () => {
        await admin.getByRole('button', { name: '重新產生全部連結並下載' }).click();
        const list = admin.locator('[data-room-links-list]');
        await expect(list).toContainText('已重新產生 12 間教室的連結');
        await list.getByRole('button', { name: '下載清單（CSV，12 間）' }).click();
      })(),
    ]);
    second = await listOf(download);
    expect(second.map(([name]) => name)).toEqual(names);
    for (let index = 0; index < 12; index += 1) expect(second[index][1]).not.toBe(first[index][1]);
    // The confirm said what happens, to the links handed out and to the people waiting.
    expect(asked.at(-1)).toContain('這會更換全部 12 間教室的連結');
    expect(asked.at(-1)).toContain('正在等待進入的人，要用新連結重新輸入名字。');
    await admin.locator('[data-room-links-list]').getByRole('button', { name: '我已經下載這份清單' }).click();
    await expect(admin.locator('[data-room="Room1"]')).toContainText('連結第 2 版');
    const late = watch(await (await context({})).newPage(), 'student-old-link');
    await late.goto(first[0][1]);
    await late.getByLabel(/Please enter your first name/).fill('Ann');
    await late.getByRole('button', { name: '進入教室' }).click();
    await expect(late.locator('[data-room-final]')).toHaveText('這個教室連結已經更換。請向老師要新的連結。');
    const fresh = watch(await (await context({})).newPage(), 'student-new-link');
    await fresh.goto(second[0][1]);
    await fresh.getByLabel(/Please enter your first name/).fill('Ann');
    await fresh.getByRole('button', { name: '進入教室' }).click();
    await expect(fresh.locator('[data-room-waiting]')).toBeVisible();
    await expect(admin.locator('[data-room="Room1"] [data-waiting-person="Ann"]')).toBeVisible();
    // Kyle asked with Room3's old link: that request is no longer valid.
    await expect(admin.locator('[data-room="Room3"] [data-waiting-person]')).toHaveCount(0);
    await shot(admin, 'b5-links-made-anew');
  });

  await check('B6', '超過 100 間教室時，「重新產生全部連結」分批送出，清單仍然是一份、每間一個新連結', async () => {
    await openBulk();
    await bulkForm().getByLabel('名稱開頭').fill('Hall');
    await bulkForm().getByLabel('從幾號').fill('1');
    await bulkForm().getByLabel('到幾號').fill('100');
    await bulkForm().getByRole('button', { name: '一次建立多間' }).click();
    const list = admin.locator('[data-room-links-list]');
    await expect(list).toContainText('已建立 100 間教室', { timeout: 60_000 });
    await list.getByRole('button', { name: '我已經下載這份清單' }).click();
    await expect(admin.locator('[data-rooms-count]')).toHaveText('顯示 112／共 112 間');
    // What the page sends for "every link": the rooms in parts of at most 100.
    const parts = [];
    admin.on('request', request => {
      if (request.method() !== 'POST' || !request.url().endsWith('/api/admin/classrooms/rooms')) return;
      const body = request.postDataJSON();
      if (body?.action === 'export_links') parts.push(body.rooms.length);
    });
    const [download] = await Promise.all([
      admin.waitForEvent('download', { timeout: 60_000 }),
      (async () => {
        await admin.getByRole('button', { name: '重新產生全部連結並下載' }).click();
        await expect(list).toContainText('已重新產生 112 間教室的連結', { timeout: 60_000 });
        await list.getByRole('button', { name: '下載清單（CSV，112 間）' }).click();
      })(),
    ]);
    expect(asked.at(-1)).toContain('這會更換全部 112 間教室的連結');
    expect(parts).toEqual([100, 12]);
    third = await listOf(download);
    expect(third).toHaveLength(112);
    expect(new Set(third.map(([name]) => name)).size).toBe(112);
    expect(new Set(third.map(([, address]) => address)).size).toBe(112);
    // Natural order through both parts: Hall1 … Hall100, then Room1 … Room12.
    expect(third.map(([name]) => name)).toEqual([...Array.from({ length: 100 }, (_, index) => `Hall${index + 1}`), ...names]);
    const before = Object.fromEntries(second);
    for (const name of names) expect(Object.fromEntries(third)[name]).not.toBe(before[name]);
    await expect(admin.locator('p.admin-error')).toHaveCount(0);
    await list.getByRole('button', { name: '我已經下載這份清單' }).click();
    await expect(admin.locator('[data-room="Room1"]')).toContainText('連結第 3 版');
    await expect(admin.locator('[data-room="Hall100"]')).toContainText('連結第 2 版');
  });

  // Round 4 (2026-11-21): a change cut off. What each export request named, and a way to cut one.
  const exports = [];
  admin.on('request', request => {
    if (request.method() !== 'POST' || !request.url().endsWith('/api/admin/classrooms/rooms')) return;
    const body = request.postDataJSON();
    if (body?.action === 'export_links') exports.push(body.rooms.length);
  });
  const ROOMS_API = '**/api/admin/classrooms/rooms';
  // how: 'before' (never reaches the server), 'after' (the server does it, the answer is lost).
  const cutNth = async (action, nth, how, { thenOffline = false } = {}) => {
    let seen = 0;
    let offline = false;
    cutting = true;
    await admin.route(ROOMS_API, async route => {
      const request = route.request();
      if (request.method() === 'GET' && offline) return route.abort('internetdisconnected');
      if (request.method() === 'POST' && request.postDataJSON()?.action === action) {
        seen += 1;
        if (seen === nth) {
          if (how === 'after') await route.fetch();
          if (thenOffline) offline = true;
          return route.abort('connectionfailed');
        }
      }
      return route.fallback();
    });
  };
  const uncut = async () => { await admin.unroute(ROOMS_API); cutting = false; };
  const list = () => admin.locator('[data-room-links-list]');
  const namesIn = async selector => (await list().locator(selector).innerText()).replace(/^[^：]*：/, '').replace(/。.*$/s, '').split('、');
  const leaving = () => admin.evaluate(() => { const event = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented; });
  const halls = Array.from({ length: 100 }, (_, index) => `Hall${index + 1}`);
  const tryLink = async (address, name) => {
    const page = watch(await (await context({})).newPage(), `student-${name}`);
    await page.goto(address);
    await page.getByLabel(/Please enter your first name/).fill(name);
    await page.getByRole('button', { name: '進入教室' }).click();
    const result = await Promise.race([
      page.locator('[data-room-waiting]').waitFor().then(() => 'waiting'),
      page.locator('[data-room-final]').waitFor().then(async () => (await page.locator('[data-room-final]').innerText()).trim()),
    ]);
    await page.context().close();
    return result;
  };
  let partial;

  await check('B7', '重新產生途中連線中斷、請求沒有到伺服器：已經換好的那一批連結仍然顯示、可以下載；沒送到的教室說明「連結沒有更換，原本的連結仍然可以用」，而且真的還能用；不會自己再送一次', async () => {
    await openBulk();
    exports.length = 0;
    await cutNth('export_links', 2, 'before');
    const [download] = await Promise.all([
      admin.waitForEvent('download', { timeout: 60_000 }),
      (async () => {
        await admin.getByRole('button', { name: '重新產生全部連結並下載' }).click();
        await expect(list().locator('[data-links-unchanged]')).toBeVisible({ timeout: 60_000 });
        await list().getByRole('button', { name: '下載清單（CSV，100 間）' }).click();
      })(),
    ]);
    await expect(list().locator('[data-links-title]')).toHaveText('已拿到 100 間教室的新連結；12 間沒有完成，請看下面。');
    await expect(admin.locator('p.admin-error')).toContainText('沒有收到伺服器的結果');
    expect(await namesIn('[data-links-unchanged]')).toEqual(names);
    await expect(list().locator('[data-links-lost], [data-links-unknown], [data-links-unchecked]')).toHaveCount(0);
    await expect(list().locator('[data-links-fill-unchanged]')).toHaveText('也為連結沒有更換的 12 間產生新連結');
    expect(exports).toEqual([100, 12]);
    const kept = await listOf(download);
    expect(kept.map(([name]) => name)).toEqual(halls);
    await uncut();
    // "Still works" is true: Room2's link from the list before this run lets a person ask to come in.
    expect(await tryLink(Object.fromEntries(third).Room2, 'Bea')).toBe('waiting');
    await list().getByRole('button', { name: '我已經下載這份清單' }).click();
    await admin.reload();
    await expect(admin.locator('[data-room="Hall1"]')).toContainText('連結第 3 版');
    await expect(admin.locator('[data-room="Room1"]')).toContainText('連結第 3 版');
    await expect(admin.locator('[data-room="Room12"]')).toContainText('連結第 3 版');
  });

  await check('B8', '伺服器已經換了連結、但回覆在路上遺失：那 12 間標成「連結已經更換，但新連結沒有收到」，檔案裡沒有它們；不會自己重試；離開頁面前會先問；老師按下補產生之後才再送一次，最後的清單完整、一致', async () => {
    await openBulk();
    exports.length = 0;
    await cutNth('export_links', 2, 'after');
    await admin.getByRole('button', { name: '重新產生全部連結並下載' }).click();
    await expect(list().locator('[data-links-lost]')).toBeVisible({ timeout: 60_000 });
    await expect(list().locator('[data-links-title]')).toHaveText('已拿到 100 間教室的新連結；12 間沒有完成，請看下面。');
    expect(await namesIn('[data-links-lost]')).toEqual(names);
    await expect(list().locator('[data-links-unchanged], [data-links-unknown], [data-links-unchecked]')).toHaveCount(0);
    expect(exports).toEqual([100, 12]);
    await uncut();
    // Nothing was sent again by itself.
    await admin.waitForTimeout(1500);
    expect(exports).toEqual([100, 12]);
    // The page asks before it is left while the links are not downloaded.
    expect(await leaving()).toBe(true);
    const [first100] = await Promise.all([admin.waitForEvent('download'), list().getByRole('button', { name: '下載清單（CSV，100 間）' }).click()]);
    partial = await listOf(first100);
    expect(partial.map(([name]) => name)).toEqual(halls);
    await expect.poll(() => leaving()).toBe(false);
    // The links handed out before for those 12 no longer work: the server did change them.
    expect(await tryLink(Object.fromEntries(third).Room3, 'Cy')).toBe('這個教室連結已經更換。請向老師要新的連結。');
    // A person chooses to fill in the 12: asked first, one request for exactly those rooms.
    await list().locator('[data-links-fill]').click();
    expect(asked.at(-1)).toContain('為這 12 間教室重新產生連結');
    await expect(list().locator('[data-links-title]')).toHaveText('已重新產生 112 間教室的連結，全部完成。', { timeout: 60_000 });
    expect(exports).toEqual([100, 12, 12]);
    const [whole] = await Promise.all([admin.waitForEvent('download'), list().getByRole('button', { name: '下載清單（CSV，112 間）' }).click()]);
    const all = await listOf(whole);
    expect(all.map(([name]) => name)).toEqual([...halls, ...names]);
    // The same links for the 100 rooms in both files: the fill changed only the 12.
    expect(Object.fromEntries(all.slice(0, 100))).toEqual(Object.fromEntries(partial));
    expect(new Set(all.map(([, address]) => address)).size).toBe(112);
    expect(await tryLink(Object.fromEntries(all).Room3, 'Cy')).toBe('waiting');
    expect(await tryLink(Object.fromEntries(all).Hall7, 'Di')).toBe('waiting');
    await list().getByRole('button', { name: '我已經下載這份清單' }).click();
    await admin.reload();
    await expect(admin.locator('[data-room="Room1"]')).toContainText('連結第 5 版');
    await expect(admin.locator('[data-room="Hall1"]')).toContainText('連結第 4 版');
  });

  await check('B9', '中斷之後連查詢也連不上：沒拿到的教室標成「狀態還不知道」，不提供補產生，只能「重新確認狀態」；已拿到的仍可下載；連線恢復後按「重新確認狀態」才說出實際狀態', async () => {
    await openBulk();
    exports.length = 0;
    await cutNth('export_links', 2, 'before', { thenOffline: true });
    await admin.getByRole('button', { name: '重新產生全部連結並下載' }).click();
    await expect(list().locator('[data-links-unknown]')).toBeVisible({ timeout: 60_000 });
    await expect(list().locator('[data-links-unchecked]')).toBeVisible();
    expect(await namesIn('[data-links-unknown]')).toEqual(names);
    await expect(list().locator('[data-links-fill], [data-links-fill-unchanged], [data-links-make-missing]')).toHaveCount(0);
    await expect(list().locator('[data-links-recheck]')).toBeVisible();
    expect(exports).toEqual([100, 12]);
    // Still offline: the links received can be downloaded.
    const [offlineFile] = await Promise.all([admin.waitForEvent('download'), list().getByRole('button', { name: '下載清單（CSV，100 間）' }).click()]);
    expect((await listOf(offlineFile)).map(([name]) => name)).toEqual(halls);
    await list().locator('[data-links-recheck]').click();
    await expect(admin.locator('p.admin-error')).toContainText('還不能確認每間教室的狀態');
    await expect(list().locator('[data-links-unknown]')).toBeVisible();
    await uncut();
    await list().locator('[data-links-recheck]').click();
    await expect(list().locator('[data-links-unchanged]')).toBeVisible();
    expect(await namesIn('[data-links-unchanged]')).toEqual(names);
    await expect(list().locator('[data-links-unknown], [data-links-unchecked]')).toHaveCount(0);
    expect(exports).toEqual([100, 12]);
    await list().getByRole('button', { name: '我已經下載這份清單' }).click();
  });

  await check('B10', '一次建立時回覆遺失：已經建立、沒拿到連結的教室說「已經建立，但沒有收到連結」，請求沒到的說「沒有建立」；老師按下之後才補產生連結、補建立，最後一份完整清單', async () => {
    await openBulk();
    // Desk1 to Desk3: made on the server, the answer lost.
    await cutNth('create_many', 1, 'after');
    await bulkForm().getByLabel('名稱開頭').fill('Desk');
    await bulkForm().getByLabel('從幾號').fill('1');
    await bulkForm().getByLabel('到幾號').fill('3');
    await bulkForm().getByRole('button', { name: '一次建立多間' }).click();
    await expect(list().locator('[data-links-lost]')).toBeVisible({ timeout: 60_000 });
    await uncut();
    await expect(list().locator('[data-links-title]')).toHaveText('已建立並拿到 0 間教室的連結；3 間沒有完成，請看下面。');
    expect(await namesIn('[data-links-lost]')).toEqual(['Desk1', 'Desk2', 'Desk3']);
    await expect(list().getByRole('button', { name: '下載清單（CSV，0 間）' })).toBeDisabled();
    await list().locator('[data-links-fill]').click();
    expect(asked.at(-1)).toContain('為這 3 間教室重新產生連結：Desk1、Desk2、Desk3');
    await expect(list().locator('[data-links-title]')).toHaveText('已建立 3 間教室，全部完成。');
    const [desks] = await Promise.all([admin.waitForEvent('download'), list().getByRole('button', { name: '下載清單（CSV，3 間）' }).click()]);
    const deskLinks = await listOf(desks);
    expect(deskLinks.map(([name]) => name)).toEqual(['Desk1', 'Desk2', 'Desk3']);
    expect(await tryLink(deskLinks[1][1], 'Eve')).toBe('waiting');
    await list().getByRole('button', { name: '我已經下載這份清單' }).click();
    // Seat1 to Seat2: the request never reaches the server.
    await openBulk();
    await cutNth('create_many', 1, 'before');
    await bulkForm().getByLabel('名稱開頭').fill('Seat');
    await bulkForm().getByLabel('從幾號').fill('1');
    await bulkForm().getByLabel('到幾號').fill('2');
    await bulkForm().getByRole('button', { name: '一次建立多間' }).click();
    await expect(list().locator('[data-links-not-created]')).toBeVisible({ timeout: 60_000 });
    await uncut();
    expect(await namesIn('[data-links-not-created]')).toEqual(['Seat1', 'Seat2']);
    await list().locator('[data-links-make-missing]').click();
    expect(asked.at(-1)).toContain('建立這 2 間教室：Seat1、Seat2');
    await expect(list().locator('[data-links-title]')).toHaveText('已建立 2 間教室，全部完成。');
    const [seats] = await Promise.all([admin.waitForEvent('download'), list().getByRole('button', { name: '下載清單（CSV，2 間）' }).click()]);
    expect((await listOf(seats)).map(([name]) => name)).toEqual(['Seat1', 'Seat2']);
    await list().getByRole('button', { name: '我已經下載這份清單' }).click();
  });

  await check('B11', '沒有對外請求，頁面沒有非預期的錯誤；發出去的每一個連結金鑰都不在伺服器紀錄、測試資料（含操作紀錄）、報告或任何輸出檔案裡', async () => {
    if (report.externalRequests.length) throw new Error(`external requests: ${report.externalRequests.join(', ')}`);
    if (report.pageProblems.length) throw new Error(`page problems: ${report.pageProblems.join(' | ')}`);
    expect(handedOut.size).toBeGreaterThan(300);
    const places = [['the server log', server.logs()], ['the report so far', JSON.stringify(report)]];
    for (const file of await filesUnder(directory)) places.push([path.relative(directory, file), (await readFile(file)).toString('latin1')]);
    expect(places.length).toBeGreaterThan(3);
    for (const [where, text] of places) {
      expect(text, where).not.toMatch(/#k=[A-Za-z0-9_-]{43}/);
      for (const key of handedOut) if (text.includes(key)) throw new Error(`a link's key is in ${where}`);
    }
  });
  report.status = 'passed';
} catch (error) {
  failure = error;
  report.status = 'failed';
  report.error = error.message;
} finally {
  report.finishedAt = new Date().toISOString();
  await writeFile(path.join(directory, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  await browser?.close();
  server.child.kill();
  console.log(`Report and screenshots: ${directory}`);
}
if (failure) throw failure;
