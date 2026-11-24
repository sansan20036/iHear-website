// The room channel's pieces in a real page and a real browser (2026-11-24): the built application,
// disposable local storage and test-only sessions; the synthetic provider stands in for Zoom, and
// the room channel keeps its things in the server's memory. Four people in one fixed room: they
// draw, erase, clear and bring back, write to each other, take the share turn in turns, one loses
// the connection and comes back, one is taken out, one is on a phone. Then the user's standard for
// a demonstration (2026-11-24): the share is handed over, pages are reloaded, the one who shares
// drops off the network, someone leaves and comes back, there is one whiteboard and no other, and
// with the three switches off the room is as it was before any of this.
//
// It needs a build in which the classroom page mounts the pieces (the page's own mount, round 16:
// the board on the stage, the chat and the share turn in the side panel, the page's share button
// through the turn). Without a mount this file says so and fails at its first check.
//   node tests/room-channel/room-channel.smoke.mjs
// It proves our pages, our route and our checks. It says nothing about Zoom: no real session, no
// real share, no real recording; and nothing about the production site or its database.
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, expect as playwrightExpect } from '@playwright/test';
import { redactLinks, withoutLinkKeys, screenshotSafely, localContext, noHorizontalOverflow, startAcademyServer } from '../helpers/academy-smoke.mjs';

const expect = playwrightExpect.configure({ timeout: 15_000 });
const secret = 'room-channel-local-acceptance-only';
const owner = 'rooms-owner@example.test';
Object.assign(process.env, {
  CLASSROOM_PROVIDER: 'synthetic', CLASSROOM_DRIVE: 'local', CLASSROOM_WEBHOOK_SECRET: 'room-channel-webhook-local-only', CLASSROOM_SYNTHETIC_SECRET: 'room-channel-token-local-only',
  VERCEL_ENV: '', CLASSROOM_MULTI_RECORDING: '', CLASSROOM_FIXED_ROOMS: 'on', CLASSROOM_FIXED_ROOM_RECORDING: '',
  CLASSROOM_ROOM_BOARD: 'on', CLASSROOM_ROOM_CHAT: 'on', CLASSROOM_ROOM_SHARE_TURN: 'on',
});
const server = await startAcademyServer({ port: Number(process.env.ROOM_CHANNEL_SMOKE_PORT ?? 3350), secret, owners: [owner], name: 'room-channel' });
const { origin, directory } = server;
const report = { startedAt: new Date().toISOString(), origin, synthetic: true, zoomVerified: false, checks: [], timings: {}, notes: {}, externalRequests: [], pageProblems: [], status: 'running' };
let browser, failure, serverOff = null;
// The classroom page's own places (the page is not this folder's): one list, to follow its mount.
const PAGE = {
  shareButton: '[data-room-turn-button]',        // the page's share button, wired to the turn
  zoomBoardTool: '[data-tool="whiteboard"]',     // Zoom's own whiteboard tool: not offered while the room's board is on
  leave: '[data-control="leave"]',               // the page's own "leave the room"
  connected: '.room2-top .classroom-room-connection',
  boardToggle: '[data-room-board-toggle]',       // shows or hides the room's board on this page's stage
  boardStage: '[data-room-board-stage]',         // where the board is while shown
  panelControl: name => `[data-control="${name}"]`,   // the toolbar button of a side-panel tab: "chat", "people" (the share turn is there)
  doorBack: '[data-room-door-back]',             // "back to the classroom": shown when the page does not go back to the room's door by itself
};

async function check(id, name, action) {
  try { await action(); report.checks.push({ id, name, status: 'PASS' }); console.log(`PASS ${id} ${name}`); }
  catch (error) { report.checks.push({ id, name, status: 'FAIL', error: error.message }); throw error; }
}
const context = options => localContext(browser, origin, { external: report.externalRequests, secret, locale: 'zh-TW', ...options });
// What the checks provoke on purpose is not a page problem: a refused request after a removal, and
// requests that fail while a connection is cut or the route is made to answer 503.
let cutting = false;
const expected = text => /Failed to load resource: the server responded with a status of (403|404|409|410)/.test(text)
  || (cutting && /net::ERR_|Failed to load resource|status of 503|Failed to fetch/.test(text));
function watch(page, who) {
  page.on('console', message => { if (message.type() === 'error' && !expected(message.text())) report.pageProblems.push(`${who}: ${message.text()}`); });
  page.on('pageerror', error => report.pageProblems.push(`${who}: ${error.message}`));
  page.on('dialog', dialog => dialog.accept());
  return page;
}
const shot = (page, name) => screenshotSafely(page, { path: path.join(directory, `${name}.png`), fullPage: true });
const board = page => page.locator('[data-room-board]');
const canvas = page => page.locator('.room-channel-canvas');
// The side panel: a press on a tab's toolbar button opens it, a second press closes it.
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
// The room's board on this page's stage. A share that comes in puts the share first (the page's
// own choice); the board is then one press away, and the checks press it.
async function showBoard(page) {
  if ((await page.locator('[data-room-channel]').getAttribute('data-room-board-shown')) === 'false') await page.locator(PAGE.boardToggle).click();
  await expect(board(page)).toBeVisible();
}
const lines = async (page, count) => { await showBoard(page); await expect(board(page)).toHaveAttribute('data-lines', String(count)); };
// A stroke with the mouse, between two places given as shares of the board's width and height.
async function draw(page, from, to) {
  await showBoard(page);
  await canvas(page).scrollIntoViewIfNeeded();
  const box = await canvas(page).boundingBox();
  const at = (share, index) => (index === 0 ? box.x + box.width * share : box.y + box.height * share);
  await page.mouse.move(at(from[0], 0), at(from[1], 1));
  await page.mouse.down();
  for (let step = 1; step <= 10; step += 1) await page.mouse.move(at(from[0] + ((to[0] - from[0]) * step) / 10, 0), at(from[1] + ((to[1] - from[1]) * step) / 10, 1));
  await page.mouse.up();
}
const mount = page => page.locator('[data-room-channel]');
const turn = page => page.locator('[data-room-turn]');
const shareButton = page => page.locator(PAGE.shareButton);
const chat = page => page.locator('[data-room-chat]');
// Past the page's own door: in the room, connected, known to the channel.
async function intoRoom(page) {
  await page.getByRole('button', { name: '進入教室' }).click();
  await expect(page.locator(PAGE.connected)).toHaveText('已連線');
  await expect(mount(page)).toHaveAttribute('data-you', /^P-[0-9a-f]{32}$/);
}
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
// Back into the room after leaving it on purpose: by the room link the person was given. The
// room's door remembers this tab's request and takes the person on to the lesson; then the page's
// own door.
async function comeBack(page, roomLink) {
  await page.goto(roomLink);
  await expect(page).toHaveURL(new RegExp(`${origin}/classroom/L-[0-9a-f]{32}$`));
  await intoRoom(page);
}
const wordsOn = async page => (await page.locator('body').innerText()).replace(/\s+/g, ' ').trim().slice(0, 240);
// What a page shows of the board and the chat, to compare before and after.
const shownOn = async page => { await showBoard(page); return { lines: await board(page).getAttribute('data-lines'), messages: await chat(page).getAttribute('data-messages'), you: await mount(page).getAttribute('data-you') }; };
async function startShare(person) { await shareButton(person.page).click(); await expect(turn(person.page)).toHaveAttribute('data-sharing', 'true'); }
async function stopShare(person, everyone) {
  await shareButton(person.page).click();
  await expect(turn(person.page)).toHaveAttribute('data-sharing', 'false');
  for (const other of everyone) await expect(turn(other.page)).toHaveAttribute('data-holder', '');
}
// How many of the board's pixels are painted.
const painted = page => page.evaluate(() => {
  const element = document.querySelector('.room-channel-canvas');
  const data = element.getContext('2d').getImageData(0, 0, element.width, element.height).data;
  let count = 0;
  for (let index = 3; index < data.length; index += 4) if (data[index] !== 0) count += 1;
  return count;
});

try {
  browser = await chromium.launch({ headless: process.env.IHEAR_HEADED !== '1' });
  const admin = watch(await (await context({ email: owner })).newPage(), 'owner');
  const roomCard = () => admin.locator('[data-room="Room 1"]');
  const people = {};
  let link;

  await check('C1', '老師建立教室，四個人（三台電腦、一支手機）用同一個連結申請、被讓進入、進到教室頁；頁面上有教室自己的白板、聊天和分享權', async () => {
    await admin.goto(`${origin}/admin/classrooms/rooms`);
    await admin.getByLabel('教室名稱（例如 Room 1）').fill('Room 1');
    await admin.getByRole('button', { name: '建立教室' }).click();
    const shown = admin.locator('[data-room-link] code');
    await expect(shown).toContainText('/classroom/r/FR-');
    link = (await shown.innerText()).trim();
    await admin.getByRole('button', { name: '我已經記下連結' }).click();
    for (const [name, options] of [['Kyle', {}], ['Ann', {}], ['Bo', {}], ['Dee', { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true }]]) {
      const own = await context(options);
      const page = watch(await own.newPage(), name);
      await page.goto(link);
      await page.getByLabel(/Please enter your first name/).fill(name);
      await page.getByRole('button', { name: '進入教室' }).click();
      await expect(page.locator('[data-room-waiting]')).toBeVisible();
      await roomCard().locator(`[data-waiting-person="${name}"]`).getByRole('button', { name: '讓他進入', exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`${origin}/classroom/L-[0-9a-f]{32}$`));
      await page.getByRole('button', { name: '進入教室' }).click();
      await expect(page.locator('.room2-top .classroom-room-connection')).toHaveText('已連線');
      people[name] = { page, context: own };
    }
    const mount = people.Kyle.page.locator('[data-room-channel]');
    await expect(mount, 'the classroom page of this build mounts the room channel (a private mount stands in until the real one exists)').toBeVisible();
    for (const { page } of Object.values(people)) {
      await expect(page.locator('[data-room-channel]')).toHaveAttribute('data-you', /^P-[0-9a-f]{32}$/);
      await expect(board(page)).toBeVisible();
      await expect(page.locator(PAGE.boardStage)).toHaveCount(1);
      await openPanel(page, 'chat');
      await expect(page.locator('[data-room-chat]')).toBeVisible();
      await openPanel(page, 'people');
      await expect(page.locator('[data-room-turn]')).toBeVisible();
      await closePanels(page);
    }
    // Four people, four different ids; nobody's ticket or the room's link key is anywhere in the page.
    const ids = await Promise.all(Object.values(people).map(({ page }) => page.locator('[data-room-channel]').getAttribute('data-you')));
    expect(new Set(ids).size).toBe(4);
    const key = new URL(link).hash.slice(3);
    for (const { page } of Object.values(people)) expect(await page.content()).not.toContain(key);
  });
  const { Kyle, Ann, Bo, Dee } = people;

  await check('C2', '白板：一個人畫，自己立刻看到，其他三個人也看到同一條線', async () => {
    await draw(Kyle.page, [0.2, 0.2], [0.6, 0.5]);
    await lines(Kyle.page, 1);
    for (const person of [Ann, Bo, Dee]) await lines(person.page, 1);
    await canvas(Ann.page).scrollIntoViewIfNeeded();
    expect(await painted(Ann.page)).toBeGreaterThan(200);
    expect(await painted(Kyle.page)).toBeGreaterThan(200);
    await shot(Ann.page, 'c2-line-seen');
  });

  await check('C3', '白板：兩個人同時畫，四個人都看到兩條新的線；換顏色和粗細', async () => {
    await Ann.page.getByRole('button', { name: '紅色', exact: true }).click();
    await Ann.page.getByRole('button', { name: '很粗', exact: true }).click();
    await Promise.all([draw(Ann.page, [0.1, 0.8], [0.5, 0.7]), draw(Bo.page, [0.7, 0.2], [0.9, 0.6])]);
    for (const person of [Kyle, Ann, Bo, Dee]) await lines(person.page, 3);
  });

  await check('C4', '白板：用橡皮擦點一條線，所有人的那條線都不見', async () => {
    await Bo.page.getByRole('button', { name: '橡皮擦', exact: true }).click();
    await canvas(Bo.page).scrollIntoViewIfNeeded();
    const box = await canvas(Bo.page).boundingBox();
    await Bo.page.mouse.click(box.x + box.width * 0.4, box.y + box.height * 0.35);     // on Kyle's first line
    for (const person of [Kyle, Ann, Bo, Dee]) await lines(person.page, 2);
    await Bo.page.getByRole('button', { name: '畫筆', exact: true }).click();
  });

  await check('C5', '白板：全部清除要先確認；清除後所有人都空了；另一個人按復原，線都回來', async () => {
    await Kyle.page.locator('[data-board-clear]').click();
    await expect(Kyle.page.getByText('要清除整塊白板嗎？所有人的白板都會被清除。')).toBeVisible();
    await Kyle.page.getByRole('button', { name: '保留', exact: true }).click();
    await lines(Kyle.page, 2);
    await Kyle.page.locator('[data-board-clear]').click();
    await Kyle.page.locator('[data-board-clear-yes]').click();
    for (const person of [Kyle, Ann, Bo, Dee]) await lines(person.page, 0);
    expect(await painted(Ann.page)).toBe(0);
    await Ann.page.locator('[data-board-undo]').click();
    for (const person of [Kyle, Ann, Bo, Dee]) await lines(person.page, 2);
    await expect(Ann.page.locator('[data-board-undo]')).toHaveCount(0);
  });

  await check('C6', '手機：用手指點一下白板就是一個點，其他人看得到；頁面不會左右捲動', async () => {
    await canvas(Dee.page).scrollIntoViewIfNeeded();
    await canvas(Dee.page).tap({ position: { x: 60, y: 60 } });
    for (const person of [Kyle, Ann, Bo, Dee]) await lines(person.page, 3);
    expect(await noHorizontalOverflow(Dee.page)).toBe(true);
    await shot(Dee.page, 'c6-phone');
  });

  await check('C7', '公開聊天：訊息傳給所有人；自己的顯示「你」；沒有任何選擇收件人的地方；最多 500 個字', async () => {
    const input = page => page.locator('#room-channel-chat-input');
    for (const person of [Kyle, Ann, Bo]) await openPanel(person.page, 'chat');
    await input(Ann.page).fill('大家好');
    await Ann.page.locator('[data-room-chat]').getByRole('button', { name: '送出' }).click();
    for (const person of [Kyle, Bo, Dee]) {
      const message = person.page.locator('[data-room-chat] .room-channel-message').last();
      await expect(message.locator('.room-channel-text')).toHaveText('大家好');
      await expect(message).toHaveAttribute('data-own', 'false');
      await expect(message.locator('.room-channel-name')).not.toHaveText('你');
    }
    await expect(Ann.page.locator('[data-room-chat] .room-channel-message').last().locator('.room-channel-name')).toHaveText('你');
    // One box to type in and one button to send; nothing to pick a person with.
    for (const person of [Kyle, Ann]) {
      const chat = person.page.locator('[data-room-chat]');
      await expect(chat.locator('input, select, textarea')).toHaveCount(1);
      await expect(chat.locator('select, [role="combobox"], [role="listbox"], input[type="radio"], input[type="checkbox"]')).toHaveCount(0);
      await expect(chat.locator('.room-channel-message button, .room-channel-message a')).toHaveCount(0);
      await expect(chat).toContainText('訊息會傳給教室裡的所有人，沒有私人訊息。');
    }
    await input(Kyle.page).fill('字'.repeat(600));
    expect((await input(Kyle.page).inputValue()).length).toBe(500);
    await input(Kyle.page).press('Enter');
    await expect(Bo.page.locator('[data-room-chat]')).toHaveAttribute('data-messages', '2');
    await shot(Bo.page, 'c7-chat');
  });

  await check('C8', '分享權：一個人拿到後，其他人的按鈕不能按；他停止後別人才拿得到', async () => {
    const turn = page => page.locator('[data-room-turn]');
    const button = page => page.locator('[data-room-turn-button]');
    await button(Kyle.page).click();
    await expect(turn(Kyle.page)).toHaveAttribute('data-mine', 'true');
    const kyleId = await Kyle.page.locator('[data-room-channel]').getAttribute('data-you');
    for (const person of [Ann, Bo]) {
      await expect(turn(person.page)).toHaveAttribute('data-holder', kyleId);
      await expect(button(person.page)).toBeDisabled();
    }
    await button(Kyle.page).click();
    for (const person of [Kyle, Ann, Bo]) await expect(turn(person.page)).toHaveAttribute('data-holder', '');
    await button(Ann.page).click();
    await expect(turn(Ann.page)).toHaveAttribute('data-mine', 'true');
    await expect(button(Kyle.page)).toBeDisabled();
    await button(Ann.page).click();
    await expect(turn(Kyle.page)).toHaveAttribute('data-holder', '');
    for (const person of [Kyle, Ann, Bo, Dee]) await showBoard(person.page);
  });

  await check('C9', '斷線重連：一個人斷線時頁面會說；期間別人畫的線和說的話，他回來後都補上；他斷線時畫的線也會送出', async () => {
    cutting = true;
    await Bo.context.setOffline(true);
    await draw(Bo.page, [0.3, 0.9], [0.6, 0.9]);                       // drawn while away: kept on Bo's page
    await expect(Bo.page.locator('[data-room-channel]')).toHaveAttribute('data-online', 'false');
    await expect(board(Bo.page)).toContainText('重新連線中…');
    await draw(Kyle.page, [0.8, 0.8], [0.9, 0.9]);
    await openPanel(Ann.page, 'chat');
    await Ann.page.locator('#room-channel-chat-input').fill('Bo 還在嗎');
    await Ann.page.locator('#room-channel-chat-input').press('Enter');
    for (const person of [Kyle, Ann, Dee]) await lines(person.page, 4);
    await Bo.context.setOffline(false);
    // Back: Bo has Kyle's line and Ann's message, and everyone has the line Bo drew while away.
    for (const person of [Kyle, Ann, Bo, Dee]) await expect(board(person.page)).toHaveAttribute('data-lines', '5', { timeout: 25_000 });
    await expect(Bo.page.locator('[data-room-chat]')).toHaveAttribute('data-messages', '3');
    await expect(Bo.page.locator('[data-room-channel]')).toHaveAttribute('data-online', 'true');
    cutting = false;
  });

  await check('C10', '伺服器暫時無法回應（503）：頁面說重新連線中，不丟掉畫好的線；恢復後補送', async () => {
    cutting = true;
    const route = '**/api/classroom/*/room-channel';
    await Ann.page.route(route, answer => answer.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'temporarily unavailable' }) }));
    await draw(Ann.page, [0.15, 0.15], [0.3, 0.1]);
    await expect(board(Ann.page)).toContainText('重新連線中…');
    await lines(Kyle.page, 5);
    await Ann.page.unroute(route);
    for (const person of [Kyle, Ann, Bo, Dee]) await expect(board(person.page)).toHaveAttribute('data-lines', '6', { timeout: 25_000 });
    await expect(board(Ann.page)).toHaveAttribute('data-waiting', '0');
    cutting = false;
  });

  await check('C11', '請出教室：老師請出一個人後，他的頁面不能再用白板和聊天；其他人照常，他畫過的線還在', async () => {
    await roomCard().locator('[data-in-room-person="Bo"]').getByRole('button', { name: '請出教室' }).click();
    await expect(roomCard().locator('[data-in-room-person="Bo"]')).toHaveCount(0);
    // Bo's page: the channel is told on its very next request (well before the page's own check every 15 seconds takes it out of the room).
    await expect.poll(async () => {
      const mount = Bo.page.locator('[data-room-channel]');
      return (await mount.count()) === 0 ? 'left the room' : await mount.getAttribute('data-stopped');
    }, { timeout: 20_000 }).toMatch(/^(NOT_IN_ROOM|left the room)$/);
    await draw(Kyle.page, [0.5, 0.15], [0.6, 0.2]);
    for (const person of [Kyle, Ann, Dee]) await lines(person.page, 7);
    await openPanel(Kyle.page, 'chat');
    await Kyle.page.locator('#room-channel-chat-input').fill('繼續上課');
    await Kyle.page.locator('#room-channel-chat-input').press('Enter');
    await expect(Ann.page.locator('[data-room-chat]')).toHaveAttribute('data-messages', '4');
    await shot(Kyle.page, 'c11-after-removal');
  });

  // ---- The demonstration standard (the user, 2026-11-24). Kyle, Ann and Dee (on the phone) are in the room. ----
  const here = [Kyle, Ann, Dee];
  const ids = { Kyle: await mount(Kyle.page).getAttribute('data-you'), Ann: await mount(Ann.page).getAttribute('data-you'), Dee: await mount(Dee.page).getAttribute('data-you') };

  await check('D1', '轉交分享權：持有人把分享權交給指定的人，對方按「開始分享」就接手；這段時間其他人拿不到；沒有人接手的話，10 秒後任何人都可以分享', async () => {
    await startShare(Kyle);
    await openPanel(Kyle.page, 'people');
    await Kyle.page.locator('[data-room-turn-to]').selectOption(ids.Ann);
    await Kyle.page.locator('[data-room-turn-give]').click();
    await expect(turn(Kyle.page)).toHaveAttribute('data-sharing', 'false');
    await expect(turn(Ann.page)).toHaveAttribute('data-offered-to-me', 'true');
    await expect(turn(Dee.page)).toHaveAttribute('data-offered-to', ids.Ann);
    await expect(shareButton(Kyle.page), 'while it waits for Ann, nobody else can take it').toBeDisabled();
    await Ann.page.locator('[data-room-turn-take]').click();
    await expect(turn(Ann.page)).toHaveAttribute('data-sharing', 'true');
    for (const person of here) await expect(turn(person.page)).toHaveAttribute('data-holder', ids.Ann);
    await shot(Kyle.page, 'd1-handed-over');
    // Handed on and not taken: after ten seconds the turn is anyone's again.
    await openPanel(Ann.page, 'people');
    await Ann.page.locator('[data-room-turn-to]').selectOption(ids.Kyle);
    await Ann.page.locator('[data-room-turn-give]').click();
    await expect(turn(Kyle.page)).toHaveAttribute('data-offered-to-me', 'true');
    for (const person of here) await expect(turn(person.page)).toHaveAttribute('data-offered-to', '', { timeout: 20_000 });
    await startShare(Ann);
    await stopShare(Ann, here);
  });

  await check('D2', '重新整理：頁面自己把人帶回教室，白板的線和聊天訊息都在，自己還是同一個人；正在分享的人重新整理，分享權馬上空出來（不用等 15 秒），回來後可以再分享；被請出的人重新整理不會回到教室', async () => {
    const before = await shownOn(Ann.page);
    const reloadedAt = Date.now();
    await Ann.page.reload();
    await backByItself(Ann.page);
    report.timings.reloadBackInRoomMs = Date.now() - reloadedAt;
    expect(await shownOn(Ann.page)).toEqual(before);
    // The one who shares reloads.
    await startShare(Kyle);
    await expect(turn(Ann.page)).toHaveAttribute('data-holder', ids.Kyle);
    const kyleBefore = await shownOn(Kyle.page);
    const at = Date.now();
    await Kyle.page.reload();
    await expect(turn(Ann.page), 'the turn is given back as the page goes, not when its 15 seconds run out').toHaveAttribute('data-holder', '', { timeout: 6_000 });
    report.timings.reloadFreesTurnMs = Date.now() - at;
    await backByItself(Kyle.page);
    expect(await shownOn(Kyle.page)).toEqual(kyleBefore);
    await expect(turn(Kyle.page)).toHaveAttribute('data-mine', 'false');
    await startShare(Kyle);
    await stopShare(Kyle, here);
    // Bo was taken out of the room (C11). A reload does not bring Bo back: who is in the room is the room's to say.
    await Bo.page.reload();
    await Bo.page.waitForTimeout(8000);
    await expect(mount(Bo.page)).toHaveCount(0);
    await expect(Bo.page.locator(PAGE.connected).filter({ hasText: '已連線' })).toHaveCount(0);
    report.notes.removedPersonAfterReload = await wordsOn(Bo.page);
    await shot(Bo.page, 'd2-removed-person-after-reload');
  });

  await check('D3', '分享的人斷線：沒有回報超過 15 秒，分享權自動空出來，別人可以分享；他回來後自己的分享已經停止，頁面會說原因', async () => {
    cutting = true;
    await startShare(Kyle);
    await expect(turn(Ann.page)).toHaveAttribute('data-holder', ids.Kyle);
    const at = Date.now();
    await Kyle.context.setOffline(true);
    await expect(turn(Ann.page)).toHaveAttribute('data-holder', '', { timeout: 30_000 });
    report.timings.dropFreesTurnMs = Date.now() - at;
    expect(report.timings.dropFreesTurnMs, 'not before the holder had a fair chance to say "still sharing"').toBeGreaterThan(8_000);
    await startShare(Ann);
    await Kyle.context.setOffline(false);
    await expect(turn(Kyle.page)).toHaveAttribute('data-sharing', 'false', { timeout: 30_000 });
    await expect(turn(Kyle.page)).toHaveAttribute('data-holder', ids.Ann);
    await expect(Kyle.page.locator('[data-room-turn-note]')).toContainText('連線中斷太久');
    await stopShare(Ann, here);
    cutting = false;
  });

  await check('D4', '離開教室：正在分享的人按「離開」，分享權馬上空出來，他畫的線還在；他用教室連結再進來還是同一個人，白板和聊天都在', async () => {
    const before = await shownOn(Ann.page);
    await startShare(Ann);
    await expect(turn(Kyle.page)).toHaveAttribute('data-holder', ids.Ann);
    const at = Date.now();
    await Ann.page.locator(PAGE.leave).first().click();
    await expect(turn(Kyle.page)).toHaveAttribute('data-holder', '', { timeout: 6_000 });
    report.timings.leaveFreesTurnMs = Date.now() - at;
    await lines(Kyle.page, before.lines);
    await draw(Kyle.page, [0.2, 0.5], [0.3, 0.6]);                     // drawn while Ann is out
    await lines(Kyle.page, Number(before.lines) + 1);
    report.notes.lessonPageAfterLeaving = await wordsOn(Ann.page);
    await comeBack(Ann.page, link);
    expect(await shownOn(Ann.page)).toEqual({ ...before, lines: String(Number(before.lines) + 1) });
    await startShare(Ann);
    await stopShare(Ann, here);
  });

  await check('D5', '一間教室只有一套白板：頁面上只有教室自己的白板，沒有 Zoom 白板的按鈕', async () => {
    for (const person of here) {
      await showBoard(person.page);
      await expect(board(person.page)).toHaveCount(1);
      await expect(person.page.locator(PAGE.boardStage)).toHaveCount(1);
      await expect(person.page.locator(PAGE.zoomBoardTool)).toHaveCount(0);
      await expect(person.page.locator('[data-tool="export"]')).toHaveCount(0);
    }
  });

  await check('D7', '連續重新整理：回到教室後馬上再重新整理，一共四次，每一次都回得到教室（頁面自己帶回，或畫面出現「回到教室」按鈕、按了就回來）；白板和聊天都在，自己還是同一個人', async () => {
    // Dee has not reloaded before. Found on 2026-11-24 with four browsers: a second reload within
    // about 15 seconds of the first left the person on a refusal screen for good.
    const before = await shownOn(Dee.page);
    report.notes.quickReloads = [];
    for (let time = 1; time <= 4; time += 1) {
      const at = Date.now();
      await Dee.page.reload();
      const how = await backByItself(Dee.page);
      report.notes.quickReloads.push({ time, how, ms: Date.now() - at });
      expect(await shownOn(Dee.page), `after quick reload ${time}`).toEqual(before);
    }
    for (const person of [Kyle, Ann]) await expect(person.page.locator(PAGE.connected)).toHaveText('已連線');
  });

  await check('C12', '整個過程沒有連到網站以外的地方，頁面沒有非預期的錯誤', async () => {
    expect(report.externalRequests).toEqual([]);
    expect(report.pageProblems).toEqual([]);
  });

  await check('D6', '三個開關都關閉時：教室頁面沒有白板、聊天和分享權的任何東西，不向這條路徑發任何請求，路徑回 404；教室照原來的方式進得去', async () => {
    await browser.close();
    server.child.kill();
    Object.assign(process.env, { CLASSROOM_ROOM_BOARD: '', CLASSROOM_ROOM_CHAT: '', CLASSROOM_ROOM_SHARE_TURN: '' });
    serverOff = await startAcademyServer({ port: Number(process.env.ROOM_CHANNEL_SMOKE_PORT ?? 3350) + 1, secret, owners: [owner], name: 'room-channel-off' });
    const offOrigin = serverOff.origin;
    browser = await chromium.launch({ headless: process.env.IHEAR_HEADED !== '1' });
    const offContext = options => localContext(browser, offOrigin, { external: report.externalRequests, secret, locale: 'zh-TW', ...options });
    const teacher = watch(await (await offContext({ email: owner })).newPage(), 'owner (switches off)');
    await teacher.goto(`${offOrigin}/admin/classrooms/rooms`);
    await teacher.getByLabel('教室名稱（例如 Room 1）').fill('Room 1');
    await teacher.getByRole('button', { name: '建立教室' }).click();
    const shown = teacher.locator('[data-room-link] code');
    await expect(shown).toContainText('/classroom/r/FR-');
    const offLink = (await shown.innerText()).trim();
    await teacher.getByRole('button', { name: '我已經記下連結' }).click();
    const page = watch(await (await offContext({})).newPage(), 'Kyle (switches off)');
    const asked = [];
    page.on('request', request => { if (request.url().includes('/room-channel')) asked.push(request.url()); });
    await page.goto(offLink);
    await page.getByLabel(/Please enter your first name/).fill('Kyle');
    await page.getByRole('button', { name: '進入教室' }).click();
    await expect(page.locator('[data-room-waiting]')).toBeVisible();
    await teacher.locator('[data-room="Room 1"]').locator('[data-waiting-person="Kyle"]').getByRole('button', { name: '讓他進入', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`${offOrigin}/classroom/L-[0-9a-f]{32}$`));
    await page.getByRole('button', { name: '進入教室' }).click();
    await expect(page.locator(PAGE.connected)).toHaveText('已連線');
    // Long enough for a page that asked the channel to have asked several times.
    await page.waitForTimeout(3000);
    for (const piece of ['[data-room-channel]', '[data-room-board]', '[data-room-chat]', '[data-room-turn]']) await expect(page.locator(piece)).toHaveCount(0);
    expect(asked, 'with the switches off the page never asks the room channel').toEqual([]);
    const lessonId = new URL(page.url()).pathname.split('/').pop();
    const status = await page.evaluate(async id => (await fetch(`/api/classroom/${id}/room-channel`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, lessonId);
    expect(status).toBe(404);
    await shot(page, 'd6-switches-off');
    expect(report.pageProblems).toEqual([]);
  });

  report.status = 'passed';
} catch (error) {
  failure = withoutLinkKeys(error);
  report.status = 'failed';
  report.error = failure.message;
} finally {
  await browser?.close().catch(() => undefined);
  await writeFile(path.join(directory, 'report.json'), `${redactLinks(JSON.stringify(report, null, 2))}\n`);
  console.log(`report: ${path.join(directory, 'report.json')}`);
  server.child.kill();
  serverOff?.child.kill();
}
if (failure) { console.error(redactLinks(failure.stack ?? failure.message)); process.exit(1); }
console.log(`room channel smoke: ${report.checks.length} checks passed (synthetic provider; nothing about Zoom)`);
