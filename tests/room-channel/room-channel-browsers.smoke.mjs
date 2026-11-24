// The room channel's pieces in the other browsers (2026-11-24): one fixed room, four people, each
// in a different browser on this computer: Chromium, Edge, Firefox and WebKit (Playwright's build
// of the engine Safari uses). They draw, write to each other, take the share turn in turns, hand it
// over, reload, and reload while sharing. What differs between browsers is what is checked here:
// the canvas and the pointer, the requests, the page's last request as it goes away (a beacon, or
// a fetch that outlives the page), and the way back in after a reload (the tab's own storage).
//
// It needs a build in which the classroom page mounts the pieces, as room-channel.smoke.mjs does.
//   node tests/room-channel/room-channel-browsers.smoke.mjs
// What it is not: these are desktop builds of the engines, not a real iPhone, iPad or Mac and not
// Safari itself; the synthetic provider stands in for Zoom (no real session, share or recording);
// nothing about the production site or its database.
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, expect as playwrightExpect, firefox, webkit } from '@playwright/test';
import { redactLinks, withoutLinkKeys, screenshotSafely, localContext, startAcademyServer } from '../helpers/academy-smoke.mjs';

const expect = playwrightExpect.configure({ timeout: 20_000 });
const secret = 'room-channel-browsers-local-only';
const owner = 'rooms-owner@example.test';
Object.assign(process.env, {
  CLASSROOM_PROVIDER: 'synthetic', CLASSROOM_DRIVE: 'local', CLASSROOM_WEBHOOK_SECRET: 'room-channel-browsers-webhook-local-only', CLASSROOM_SYNTHETIC_SECRET: 'room-channel-browsers-token-local-only',
  VERCEL_ENV: '', CLASSROOM_MULTI_RECORDING: '', CLASSROOM_FIXED_ROOMS: 'on', CLASSROOM_FIXED_ROOM_RECORDING: '',
  CLASSROOM_ROOM_BOARD: 'on', CLASSROOM_ROOM_CHAT: 'on', CLASSROOM_ROOM_SHARE_TURN: 'on',
});
const server = await startAcademyServer({ port: Number(process.env.ROOM_CHANNEL_BROWSERS_PORT ?? 3352), secret, owners: [owner], name: 'room-channel-browsers' });
const { origin, directory } = server;
const report = { startedAt: new Date().toISOString(), origin, synthetic: true, zoomVerified: false, realDevices: false, engines: [], checks: [], timings: {}, notes: {}, externalRequests: [], pageProblems: [], status: 'running' };
const ENGINES = [
  { name: 'Chromium', person: 'Cara', type: chromium, launch: {} },
  { name: 'Edge', person: 'Edgar', type: chromium, launch: { channel: 'msedge' } },
  { name: 'Firefox', person: 'Fay', type: firefox, launch: {} },
  { name: 'WebKit', person: 'Wei', type: webkit, launch: {} },
];
const browsers = [];
const people = [];
let failure;
// The classroom page's own places (the page is not this folder's), as in room-channel.smoke.mjs.
const PAGE = {
  shareButton: '[data-room-turn-button]',
  connected: '.room2-top .classroom-room-connection',
  boardToggle: '[data-room-board-toggle]',
  panelControl: name => `[data-control="${name}"]`,
  doorBack: '[data-room-door-back]',
};

// The lesson's door counts entries by network address: for a fixed room's lesson, ten a minute
// from one address for everyone together (lib/classroom-rate-limit.ts, the "single" branch; found
// 2026-11-25 when a quick run had the eleventh entry within the minute refused: "too many
// attempts"). Here four people share one address and each enters three times (E1, E7, E8): twelve.
// So the third round (E8) waits until the minute in which the first entries were made is over;
// no minute then holds more than eight. The wait is written in the report. It is this harness's
// doing (one address for four people), and says nothing about the browsers.
const DOOR_MINUTE_MS = 62_000;
let firstEntriesAt = 0;
async function newDoorMinute(round) {
  const wait = firstEntriesAt + DOOR_MINUTE_MS - Date.now();
  if (wait > 0) { (report.notes.waitedForDoorMinuteMs ??= {})[round] = wait; await new Promise(resolve => { setTimeout(resolve, wait); }); }
}

async function check(id, name, action) {
  try { await action(); report.checks.push({ id, name, status: 'PASS' }); console.log(`PASS ${id} ${name}`); }
  catch (error) { report.checks.push({ id, name, status: 'FAIL', error: redactLinks(error.message) }); throw error; }
}
// A page that is reloaded on purpose drops the requests it had open; each browser says so in its
// own words. Only then are those words not a page problem.
// WebKit's words for a request the reload cut off are "Fetch API cannot load <address> due to
// access control checks." (seen 2026-11-25 for the channel's own request, in one run of three).
// What is let through this way is counted in the report, by browser, never dropped unseen.
// Those words of WebKit's can come late: in a run of 2026-11-25 (04:29, another heavy run beside
// it) they came after the reloaded page was back in the room, and counted as a page problem. So
// for those words alone, and only for the channel's own request, the window stays open TAIL_MS
// after the page is back; each one that comes in that tail is written down with how late it was.
// At no other time are they let through.
const TAIL_MS = 10_000;
const CUT_WORDS = '/room-channel due to access control checks';
let leaving = false, backAt = 0;
const left = () => { leaving = true; };
const cameBack = () => { leaving = false; backAt = Date.now(); };
const whileLeaving = text => leaving && /Failed to load resource|NetworkError|Load failed|net::ERR_|Failed to fetch|cancelled|aborted|NS_BINDING_ABORTED|due to access control checks/i.test(text);
const justAfter = text => !leaving && backAt > 0 && Date.now() - backAt <= TAIL_MS && text.includes(CUT_WORDS);
const expected = text => /Failed to load resource: the server responded with a status of (403|404|409|410)/.test(text) || whileLeaving(text) || justAfter(text);
function watch(page, who) {
  page.on('console', message => {
    if (message.type() !== 'error') return;
    if (whileLeaving(message.text())) { const said = (report.notes.saidWhileReloading ??= {}); said[who] = (said[who] ?? 0) + 1; }
    else if (justAfter(message.text())) (report.notes.saidAfterReload ??= []).push({ who, msAfterBack: Date.now() - backAt });
    if (!expected(message.text())) report.pageProblems.push(`${who}: ${message.text()}`);
  });
  page.on('pageerror', error => report.pageProblems.push(`${who}: ${error.message}`));
  page.on('dialog', dialog => dialog.accept());
  return page;
}
// As in the classroom's own browsers check: over http://localhost WebKit applies the production
// CSP's upgrade-insecure-requests and asks for every asset by https, which this local server does
// not serve. Only that directive is dropped; served by https it changes nothing.
async function withoutUpgrade(context, who) {
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin && !url.protocol.startsWith('data') && !url.protocol.startsWith('blob')) { report.externalRequests.push(`${who}: ${url.origin}`); return route.abort(); }
    if (route.request().resourceType() !== 'document') return route.continue();
    const response = await route.fetch();
    const headers = { ...response.headers() };
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === 'content-security-policy') headers[key] = headers[key].split(';').map(part => part.trim()).filter(part => part && part.toLowerCase() !== 'upgrade-insecure-requests').join('; ');
    }
    return route.fulfill({ response, headers });
  });
}
const shot = (page, name) => screenshotSafely(page, { path: path.join(directory, `${name}.png`), fullPage: true });
const mount = page => page.locator('[data-room-channel]');
const board = page => page.locator('[data-room-board]');
const canvas = page => page.locator('.room-channel-canvas');
const chat = page => page.locator('[data-room-chat]');
const turn = page => page.locator('[data-room-turn]');
const shareButton = page => page.locator(PAGE.shareButton);
async function openPanel(page, name) {
  const control = page.locator(PAGE.panelControl(name)).first();
  if ((await control.getAttribute('aria-expanded')) !== 'true') await control.click();
}
async function closePanels(page) {
  for (const name of ['chat', 'people']) {
    const control = page.locator(PAGE.panelControl(name)).first();
    if ((await control.count()) > 0 && (await control.getAttribute('aria-expanded')) === 'true') await control.click();
  }
}
async function showBoard(page) {
  if ((await mount(page).getAttribute('data-room-board-shown')) === 'false') await page.locator(PAGE.boardToggle).click();
  await expect(board(page)).toBeVisible();
}
const lines = async (page, count) => { await showBoard(page); await expect(board(page)).toHaveAttribute('data-lines', String(count)); };
// A stroke with the mouse, between two places given as shares of the board's width and height.
async function draw(page, from, to) {
  await closePanels(page);
  await showBoard(page);
  await canvas(page).scrollIntoViewIfNeeded();
  const box = await canvas(page).boundingBox();
  const at = (share, index) => (index === 0 ? box.x + box.width * share : box.y + box.height * share);
  await page.mouse.move(at(from[0], 0), at(from[1], 1));
  await page.mouse.down();
  for (let step = 1; step <= 10; step += 1) await page.mouse.move(at(from[0] + ((to[0] - from[0]) * step) / 10, 0), at(from[1] + ((to[1] - from[1]) * step) / 10, 1));
  await page.mouse.up();
}
// How many of the board's pixels are painted.
const painted = page => page.evaluate(() => {
  const element = document.querySelector('.room-channel-canvas');
  const data = element.getContext('2d').getImageData(0, 0, element.width, element.height).data;
  let count = 0;
  for (let index = 3; index < data.length; index += 4) if (data[index] !== 0) count += 1;
  return count;
});
// What a page shows of the board and the chat, to compare before and after.
const shownOn = async page => { await showBoard(page); return { lines: await board(page).getAttribute('data-lines'), messages: await chat(page).getAttribute('data-messages'), you: await mount(page).getAttribute('data-you') }; };
// After a reload the page brings a fixed-room person back by itself (the user's decision of
// 2026-11-24: 「選 B，自動帶回教室」): through the room's door, which remembers this tab, and on to
// the lesson, where the page's own door (「進入教室」) is pressed. On the way the page passes through
// pages whose own buttons are not ready (the lesson page before it knows the person, the room's
// door): the way in is ready when the button with exactly those words can be pressed. A page that
// has made its automatic trips for now (the reload fix, round 16: a few within two minutes, so that
// a real loop stops) shows a "back to the classroom" button to the room's door instead: pressed
// when it is there. Says which of the two it was.
async function backByItself(page) {
  const door = page.getByRole('button', { name: '進入教室', exact: true });
  const connected = page.locator(PAGE.connected).filter({ hasText: '已連線' });
  const back = page.locator(PAGE.doorBack);
  let how = 'by itself';
  await expect(async () => {
    if ((await back.count()) > 0 && await back.first().isVisible()) { how = 'by the button'; await back.first().click({ timeout: 2000 }); }
    expect(new RegExp(`${origin}/classroom/L-[0-9a-f]{32}$`).test(page.url())).toBe(true);
    expect((await connected.count()) > 0 || (await door.isEnabled({ timeout: 1000 }))).toBe(true);
  }).toPass({ timeout: 30_000 });
  if ((await connected.count()) === 0) await door.click();
  await expect(page.locator(PAGE.connected)).toHaveText('已連線');
  await expect(mount(page)).toHaveAttribute('data-you', /^P-[0-9a-f]{32}$/);
  return how;
}
async function startShare(person) { await shareButton(person.page).click(); await expect(turn(person.page)).toHaveAttribute('data-sharing', 'true'); }
async function stopShare(person, everyone) {
  await shareButton(person.page).click();
  await expect(turn(person.page)).toHaveAttribute('data-sharing', 'false');
  for (const other of everyone) await expect(turn(other.page)).toHaveAttribute('data-holder', '');
}

try {
  const desk = await chromium.launch({ headless: true });
  browsers.push(desk);
  const admin = await (await localContext(desk, origin, { external: report.externalRequests, secret, locale: 'zh-TW', email: owner })).newPage();
  admin.on('dialog', dialog => dialog.accept());
  await admin.goto(`${origin}/admin/classrooms/rooms`);
  await admin.getByLabel('教室名稱（例如 Room 1）').fill('Browser Room');
  await admin.getByRole('button', { name: '建立教室' }).click();
  const link = (await admin.locator('[data-room-link] code').innerText()).trim();
  await admin.getByRole('button', { name: '我已經記下連結' }).click();
  const card = admin.locator('[data-room="Browser Room"]');

  await check('E1', '四種瀏覽器（Chromium、Edge、Firefox、WebKit；都是這台電腦上的版本）各一個人進同一間固定教室；每個頁面都有教室自己的白板、聊天和分享權，四個人的身分各不相同', async () => {
    firstEntriesAt = Date.now();
    for (const engine of ENGINES) {
      const browser = await engine.type.launch({ headless: process.env.IHEAR_HEADED !== '1', ...engine.launch });
      browsers.push(browser);
      report.engines.push({ engine: engine.name, version: browser.version() });
      const context = await localContext(browser, origin, { external: report.externalRequests, locale: 'zh-TW' });
      if (engine.type === webkit) await withoutUpgrade(context, engine.name);
      const page = watch(await context.newPage(), engine.name);
      await page.goto(link);
      await page.getByLabel(/Please enter your first name/).fill(engine.person);
      await page.getByRole('button', { name: '進入教室' }).click();
      await expect(page.locator('[data-room-waiting]')).toBeVisible();
      await card.locator(`[data-waiting-person="${engine.person}"]`).getByRole('button', { name: '讓他進入', exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`${origin}/classroom/L-[0-9a-f]{32}$`), { timeout: 30_000 });
      await page.getByRole('button', { name: '進入教室' }).click();
      await expect(page.locator(PAGE.connected)).toHaveText('已連線');
      await expect(mount(page), `${engine.name}: the classroom page of this build mounts the room channel`).toHaveAttribute('data-you', /^P-[0-9a-f]{32}$/);
      await expect(board(page)).toBeVisible();
      await openPanel(page, 'chat');
      await expect(chat(page)).toBeVisible();
      await openPanel(page, 'people');
      await expect(turn(page)).toBeVisible();
      await closePanels(page);
      people.push({ engine: engine.name, name: engine.person, page, context, id: await mount(page).getAttribute('data-you') });
    }
    expect(new Set(people.map(person => person.id)).size).toBe(ENGINES.length);
  });
  const count = people.length;
  // The order in which the pages are reloaded (E7, E8): as they came in, or the other way round
  // (ROOM_CHANNEL_BROWSERS_RELOAD=reverse), to tell a slow browser from a slow turn in the queue.
  const reloading = process.env.ROOM_CHANNEL_BROWSERS_RELOAD === 'reverse' ? [...people].reverse() : people;
  report.reloadOrder = reloading.map(person => person.engine);

  await check('E2', '白板：每一種瀏覽器各畫一條線，四個頁面都看到四條線，而且每個頁面的畫布上真的有畫出來', async () => {
    for (const [index, person] of people.entries()) {
      await draw(person.page, [0.15, 0.15 + index * 0.2], [0.75, 0.2 + index * 0.2]);
      for (const other of people) await lines(other.page, index + 1);
    }
    // Read until it is there: a browser may paint a moment after the count of lines changed (WebKit did).
    for (const person of people) await expect.poll(() => painted(person.page), { message: `${person.engine}: the lines are on the canvas` }).toBeGreaterThan(200);
    await shot(people.at(-1).page, 'e2-board-webkit');
    await shot(people[2].page, 'e2-board-firefox');
  });

  await check('E3', '白板：橡皮擦、全部清除與復原，換一種瀏覽器做，四個頁面都一樣', async () => {
    const [, , fay, wei] = people;
    await wei.page.getByRole('button', { name: '橡皮擦', exact: true }).click();
    const box = await canvas(wei.page).boundingBox();
    await wei.page.mouse.click(box.x + box.width * 0.45, box.y + box.height * 0.175);     // on the first line
    for (const person of people) await lines(person.page, count - 1);
    await wei.page.getByRole('button', { name: '畫筆', exact: true }).click();
    await fay.page.locator('[data-board-clear]').click();
    await fay.page.locator('[data-board-clear-yes]').click();
    for (const person of people) await lines(person.page, 0);
    await expect.poll(() => painted(wei.page), { message: 'WebKit: the canvas is empty after the clear' }).toBe(0);
    await wei.page.locator('[data-board-undo]').click();
    for (const person of people) await lines(person.page, count - 1);
  });

  await check('E4', '公開聊天：每一種瀏覽器各送一則訊息（中文），四個頁面都收到四則；自己的顯示「你」', async () => {
    for (const person of people) await openPanel(person.page, 'chat');
    for (const [index, person] of people.entries()) {
      await person.page.locator('#room-channel-chat-input').fill(`${person.name} 說：大家好`);
      await person.page.locator('#room-channel-chat-input').press('Enter');
      for (const other of people) {
        await expect(chat(other.page)).toHaveAttribute('data-messages', String(index + 1));
        const message = chat(other.page).locator('.room-channel-message').last();
        await expect(message.locator('.room-channel-text')).toHaveText(`${person.name} 說：大家好`);
        await expect(message).toHaveAttribute('data-own', String(other === person));
      }
      await expect(chat(person.page).locator('.room-channel-message').last().locator('.room-channel-name')).toHaveText('你');
    }
    await shot(people.at(-1).page, 'e4-chat-webkit');
  });

  await check('E5', '分享權：每一種瀏覽器輪流拿到；一個人拿到時其他人的按鈕不能按；停止後空出來', async () => {
    for (const person of people) {
      await startShare(person);
      for (const other of people.filter(one => one !== person)) {
        await expect(turn(other.page)).toHaveAttribute('data-holder', person.id);
        await expect(shareButton(other.page)).toBeDisabled();
      }
      await stopShare(person, people);
    }
  });

  await check('E6', '轉交分享權：Chromium 交給 Firefox，Firefox 交給 WebKit，WebKit 交給 Edge；每一次對方按一下就接手', async () => {
    const [cara, edgar, fay, wei] = people;
    await startShare(cara);
    for (const [from, to] of [[cara, fay], [fay, wei], [wei, edgar]]) {
      await openPanel(from.page, 'people');
      await from.page.locator('[data-room-turn-to]').selectOption(to.id);
      await from.page.locator('[data-room-turn-give]').click();
      await expect(turn(from.page)).toHaveAttribute('data-sharing', 'false');
      await expect(turn(to.page)).toHaveAttribute('data-offered-to-me', 'true');
      await to.page.locator('[data-room-turn-take]').click();
      await expect(turn(to.page)).toHaveAttribute('data-sharing', 'true');
      for (const person of people) await expect(turn(person.page)).toHaveAttribute('data-holder', to.id);
    }
    await stopShare(edgar, people);
  });

  await check('E7', '重新整理：每一種瀏覽器重新整理後，頁面都自己回到教室；白板的線和聊天訊息都在，自己還是同一個人', async () => {
    for (const person of reloading) {
      const before = await shownOn(person.page);
      const at = Date.now();
      left();
      await person.page.reload();
      await backByItself(person.page);
      cameBack();
      report.timings[`reloadBackInRoomMs${person.engine}`] = Date.now() - at;
      expect(await shownOn(person.page), `${person.engine}: the same person, lines and messages`).toEqual(before);
    }
  });

  await check('E8', '正在分享的人重新整理：分享權在離開頁面時交還（6 秒內空出來，不用等 15 秒）；最後一個請求沒有送到時，15 秒的保底仍然把它空出來（只在 WebKit 允許，並記下來）；回來後可以再分享', async () => {
    // The page's last request is the fast road; the 15-second lease is the rule that always holds.
    // Chromium, Edge and Firefox must take the fast road. WebKit under this harness lost that
    // request once (2026-11-25, while another heavy program ran beside it): whether Safari itself
    // does is not known, so there the lease is accepted and written down, never silently.
    report.notes.freedByLease = [];
    await newDoorMinute('E8');
    for (const person of reloading) {
      const watcher = people.find(one => one !== person);
      await startShare(person);
      await expect(turn(watcher.page)).toHaveAttribute('data-holder', person.id);
      const at = Date.now();
      left();
      await person.page.reload();
      const free = () => turn(watcher.page).getAttribute('data-holder').then(holder => holder === '');
      const fast = await expect.poll(free, { timeout: 6_000 }).toBe(true).then(() => true, () => false);
      if (!fast) {
        await expect.poll(free, { timeout: 25_000, message: `${person.engine}: not even the 15-second lease gave the turn back` }).toBe(true);
        report.notes.freedByLease.push(person.engine);
      }
      report.timings[`reloadFreesTurnMs${person.engine}`] = Date.now() - at;
      expect(fast || person.engine === 'WebKit', `${person.engine}: the turn is given back as the page goes`).toBe(true);
      await backByItself(person.page);
      cameBack();
      await expect(turn(person.page)).toHaveAttribute('data-mine', 'false');
      await startShare(person);
      await stopShare(person, people);
    }
  });

  await check('E9', '整個過程沒有連到網站以外的地方，頁面沒有非預期的錯誤', async () => {
    // What a page still has to say about its last reload is heard out first.
    const tail = backAt + TAIL_MS - Date.now();
    if (tail > 0) await new Promise(resolve => { setTimeout(resolve, tail); });
    expect(report.externalRequests).toEqual([]);
    expect(report.pageProblems).toEqual([]);
  });

  report.status = 'passed';
} catch (error) {
  failure = withoutLinkKeys(error);
  report.status = 'failed';
  report.error = failure.message;
  // What every page showed at that moment (the classroom page's own markers), to tell a page that
  // is stuck from a check that pressed too early.
  report.atFailure = [];
  for (const person of people) {
    const shown = await Promise.race([
      person.page.evaluate(() => {
        const main = document.querySelector('main');
        const button = document.querySelector('.prejoin-enter');
        return { path: location.pathname.replace(/[0-9a-f]{32}/g, '…'), hash: location.hash ? 'yes' : 'no', door: main?.getAttribute('data-door') ?? null, phase: main?.getAttribute('data-phase') ?? null,
          button: button ? { disabled: button.disabled, words: button.textContent.trim() } : null, note: document.querySelector('#prejoin-join-note')?.textContent.trim().slice(0, 100) ?? null,
          problem: document.querySelector('.classroom-room-problem, [role="alert"]')?.textContent.trim().slice(0, 140) ?? null, connected: document.querySelector('.room2-top .classroom-room-connection')?.textContent ?? null };
      }).catch(problem => ({ error: String(problem.message).slice(0, 120) })),
      new Promise(resolve => { setTimeout(() => resolve({ error: 'the page did not answer in 3 s' }), 3000); }),
    ]);
    report.atFailure.push({ engine: person.engine, ...shown });
    await shot(person.page, `failed-${person.engine.toLowerCase()}`).catch(() => undefined);
  }
  console.log(`at the failure: ${JSON.stringify(report.atFailure)}`);
} finally {
  report.finishedAt = new Date().toISOString();
  for (const browser of browsers) await browser.close().catch(() => undefined);
  await writeFile(path.join(directory, 'report.json'), `${redactLinks(JSON.stringify(report, null, 2))}\n`);
  console.log(`report: ${path.join(directory, 'report.json')}`);
  server.child.kill();
}
if (failure) { console.error(redactLinks(failure.stack ?? failure.message)); process.exit(1); }
console.log(`room channel browsers smoke: ${report.checks.length} checks passed (${report.engines.map(engine => `${engine.engine} ${engine.version}`).join(', ')}; desktop builds, synthetic provider; nothing about Zoom or real devices)`);
if (report.notes.freedByLease?.length) console.log(`NOTE: in ${report.notes.freedByLease.join(', ')} a sharer's reload did not give the turn back at once; the 15-second lease did (${JSON.stringify(report.timings)})`);
