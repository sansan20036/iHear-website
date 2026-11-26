// The room channel as a page keeps it, against the real service over the store in memory, with a
// clock and a network of the test's own (2026-11-23). No browser, no real network, no Zoom.
//   node --test "tests/room-channel/*.test.mjs"
import assert from 'node:assert/strict';
import test from 'node:test';

import { BOARD_LIMITS, snapshot } from '../../lib/room-channel/board.mjs';
import { createRoomClient, ROOM_CLIENT, toBoard } from '../../lib/room-channel/client.mjs';
import { createRoomChannel } from '../../lib/room-channel/service.mjs';
import { createShareControl } from '../../lib/room-channel/share-control.mjs';
import { TURN_LIMITS } from '../../lib/room-channel/share-turn.mjs';
import { createMemoryStore } from '../../lib/room-channel/store-memory.mjs';

const T0 = 1_800_000_000_000, HOUR = 3_600_000;
const ON = { board: true, chat: true, turn: true };
// The pace the pages of these tests keep unless a test says otherwise: quick, as pages asked before
// the room's pace was the server's to say (2026-11-27), so that what CL-1 to CL-10 and SC-1 to SC-8
// are about (loss, order, the turn) is seen within the times they wait. The pace itself, with the
// figures a real page follows, is CL-11 to CL-15.
const QUICK = { activeMs: 250, idleMs: 500, quietAfterMs: 2_000, flushMs: 200, hiddenMs: 2_000 };
// No figure kept by the page: the defaults, and then whatever the server says.
const AS_A_PAGE = { pace: null };
const seeded = seed => () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };

// A room with its server, a clock that moves only when the test moves it, and a network per page
// that the test can break: 'lose-request' (nothing reaches the server), 'lose-answer' (the server
// did it, the page never hears), 'fail' (the server cannot answer now).
function world(people = ['P-1', 'P-2', 'P-3']) {
  const store = createMemoryStore(), channel = createRoomChannel(store);
  const clock = { now: T0 };
  const timers = [];
  let ids = 0;
  const timer = { set(fn, ms) { ids += 1; timers.push({ id: ids, at: clock.now + ms, fn }); return ids; }, clear(id) { const at = timers.findIndex(entry => entry.id === id); if (at >= 0) timers.splice(at, 1); } };
  const lesson = { id: 'L-1', roomId: 'FR-1', scheduledEnd: T0 + 3 * HOUR, endedAt: null, people: [...people] };
  const net = new Map(), requests = new Map(), names = new Map();
  // What the server says beside the exchange itself, when a test sets it: the room's pace, and the
  // lesson's status for a page that asks for it.
  const said = { pace: null, lessonStatus: null };
  const settle = async () => { for (let turn = 0; turn < 8; turn += 1) await new Promise(resolve => { setImmediate(resolve); }); };
  const page = (id, options = {}) => {
    const told = [], hooks = {};
    const client = createRoomClient({
      key: `ticket-${id}`, now: () => clock.now, timer, changed: what => { told.push(what); hooks.changed?.(what); }, pace: QUICK, ...options,
      post: async body => {
        const list = requests.get(id) ?? [];
        list.push({ at: clock.now, sent: body.send.length, board: body.send.filter(item => item.part === 'board').length, status: body.status === true });
        requests.set(id, list);
        assert.equal(body.key, `ticket-${id}`);
        assert.deepEqual(Object.keys(body).sort(), body.status === undefined ? ['cursors', 'key', 'send'] : ['cursors', 'key', 'send', 'status'], 'a request says nothing about who is asking but the ticket');
        const mode = net.get(id)?.(list.length, body) ?? 'ok';
        if (mode === 'lose-request') throw new Error('offline');
        if (mode === 'fail') return { status: 503, body: { error: 'temporarily unavailable' } };
        if (!lesson.people.includes(id)) return { status: 403, body: { error: 'You are not in this classroom', code: 'NOT_IN_ROOM' } };
        const result = await channel.exchange({ lesson, who: { id, name: id, member: true }, on: ON, cursors: body.cursors, send: body.send, now: clock.now });
        if (mode === 'lose-answer') throw new Error('offline');
        // As the route answers: who is asking, and (with the share turn) who is in the lesson now.
        return { status: result.ok ? 200 : 400, body: { ...result, you: id, people: lesson.people.map(person => ({ id: person, name: names.get(person) ?? `Name of ${person}` })), ...(said.pace ? { pace: said.pace } : {}), ...(body.status === true && said.lessonStatus ? { lessonStatus: said.lessonStatus(id) } : {}) } };
      },
    });
    return { client, told, id, hooks };
  };
  async function advance(ms, step = 50) {
    const end = clock.now + ms;
    while (clock.now < end) {
      clock.now = Math.min(end, clock.now + step);
      // A page that asks again and again without letting time pass would never let this end: it is said instead.
      for (let asked = 0; ; asked += 1) {
        if (asked > 2000) throw new Error('a page keeps asking without a pause');
        const due = timers.filter(entry => entry.at <= clock.now).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        timers.splice(timers.indexOf(due), 1);
        due.fn();
        await settle();
      }
    }
  }
  const server = async () => { const whole = await store.picture('L-1'); return whole ? snapshot({ ...whole.state, lines: whole.lines }, clock.now).lines.map(({ parts: _parts, ...line }) => line) : []; };
  const boardOf = entry => entry.client.view().board.lines.map(({ unconfirmed: _unconfirmed, ...line }) => line);
  // A request that does not come from a page's own queue: the one a page hands to the browser as it goes away.
  const send = (id, body) => channel.exchange({ lesson, who: { id, name: id, member: lesson.people.includes(id) }, on: ON, cursors: body.cursors, send: body.send, now: clock.now });
  return { store, channel, clock, lesson, net, requests, names, said, page, advance, settle, server, boardOf, timer, send };
}
const draw = (client, points, more = {}) => { const line = client.beginLine({ color: 2, width: 4, ...more }); client.addPoints(line, points); client.endLine(line); return line; };

test('CL-1: what one person draws shows on their page at once, and on everyone else\'s when the server has taken it', async () => {
  const w = world();
  const a = w.page('P-1'), b = w.page('P-2');
  a.client.start(); b.client.start();
  await w.advance(100);
  // The first answer says who the page is and who is in the lesson, and the page is told at once (nothing else has happened yet).
  assert.deepEqual([a.client.view().you, a.told[0]], ['P-1', { you: true, people: true }]);
  const line = a.client.beginLine({ color: 3, width: 2 });
  a.client.addPoints(line, [[100, 100], [200, 200]]);
  // On the drawer's own page before any answer: there, marked as not confirmed yet.
  assert.deepEqual(a.client.view().board.lines.map(entry => [entry.points.length, entry.unconfirmed]), [[2, true]]);
  assert.deepEqual(w.boardOf(b), []);
  a.client.addPoints(line, [[300, 300]]);
  a.client.endLine(line);
  await w.advance(1500);
  const expected = [{ line: `P-1:${line}`, by: 'P-1', color: 3, width: 2, points: [[100, 100], [200, 200], [300, 300]], done: true }];
  assert.deepEqual(w.boardOf(b), expected);
  assert.deepEqual(w.boardOf(a), expected, 'the drawer sees the line once, now from the confirmed picture');
  assert.equal(a.client.view().board.lines[0].unconfirmed, undefined);
  assert.deepEqual(await w.server(), expected);
  assert.deepEqual([a.client.view().you, b.client.view().you, a.client.view().waiting], ['P-1', 'P-2', 0]);
});

test('CL-2: requests and answers get lost at random: nothing is doubled, nothing is missing, everyone ends with the server\'s picture', async () => {
  for (const seed of [5, 6]) {
    const w = world();
    const random = seeded(seed);
    const pages = ['P-1', 'P-2', 'P-3'].map(id => w.page(id));
    for (const entry of pages) { w.net.set(entry.id, () => { const roll = random(); return roll < 0.15 ? 'lose-request' : roll < 0.30 ? 'lose-answer' : roll < 0.35 ? 'fail' : 'ok'; }); entry.client.start(); }
    let drawn = 0;
    for (let round = 0; round < 60; round += 1) {
      const entry = pages[Math.floor(random() * 3)];
      const roll = random();
      if (roll < 0.7) { draw(entry.client, Array.from({ length: 1 + Math.floor(random() * 5) }, (_unused, index) => [round * 10 + index, index])); drawn += 1; }
      else if (roll < 0.8) { const lines = w.boardOf(entry); if (lines.length) entry.client.erase(lines[Math.floor(random() * lines.length)].line); }
      else if (roll < 0.85) entry.client.clear();
      else if (roll < 0.9) entry.client.undoClear();
      else entry.client.say(`round ${round}`);
      await w.advance(300 + Math.floor(random() * 400));
    }
    // The network heals; give every page time to send what it still holds and to catch up.
    for (const entry of pages) w.net.delete(entry.id);
    await w.advance(40_000, 250);
    const server = await w.server();
    for (const entry of pages) {
      assert.equal(entry.client.view().waiting, 0, `seed ${seed}: ${entry.id} still holds something to send`);
      assert.deepEqual(w.boardOf(entry), server, `seed ${seed}: ${entry.id}'s board`);
    }
    // Every line there is once, whoever sent it how many times.
    assert.equal(new Set(server.map(line => line.line)).size, server.length);
    const whole = await w.store.picture('L-1');
    assert.ok(Object.keys(whole.lines).length <= drawn, `seed ${seed}: ${Object.keys(whole.lines).length} lines on the server for ${drawn} drawn`);
    // The chat too: everyone has the same messages, each once.
    const chats = pages.map(entry => entry.client.view().chat.messages.map(message => `${message.seq}:${message.by}:${message.text}`));
    assert.deepEqual(chats[1], chats[0]);
    assert.deepEqual(chats[2], chats[0]);
    assert.equal(new Set(chats[0]).size, chats[0].length);
  }
});

test('CL-3: a page that was away past what the server keeps is handed the picture afresh and goes on from there', async () => {
  const w = world();
  const a = w.page('P-1'), b = w.page('P-2');
  a.client.start(); b.client.start();
  draw(a.client, [[1, 1], [2, 2]]);
  await w.advance(1500);
  assert.equal(w.boardOf(b).length, 1);
  // P-2's connection drops; meanwhile more operations happen than the server keeps for catching up.
  w.net.set('P-2', () => 'lose-request');
  for (let n = 0; n < BOARD_LIMITS.recentKept + 50; n += 1) {
    w.clock.now += 400;
    const made = await w.channel.exchange({ lesson: w.lesson, who: { id: 'P-3', name: 'P-3', member: true }, on: ON, now: w.clock.now, send: [{ part: 'board', input: { kind: 'stroke', op: `s${n}`, line: `x${n}`, part: 0, points: [[n % 9000, 1]], color: 1, width: 2, done: true } }] });
    assert.equal(made.sent[0].ok, true);
    if (n % 3 !== 0) await w.channel.exchange({ lesson: w.lesson, who: { id: 'P-3', name: 'P-3', member: true }, on: ON, now: w.clock.now, send: [{ part: 'board', input: { kind: 'erase', op: `e${n}`, line: `P-3:x${n}` } }] });
  }
  await w.advance(3000);
  assert.equal(w.boardOf(b).length, 1, 'still the old picture while away');
  w.net.delete('P-2');
  await w.advance(20_000, 250);
  assert.deepEqual(w.boardOf(b), await w.server());
  assert.ok(b.told.some(what => what.board === true));
  // And it goes on: a line drawn after coming back reaches the others.
  draw(b.client, [[5, 5]]);
  await w.advance(2000);
  assert.deepEqual(w.boardOf(a), await w.server());
  assert.ok((await w.server()).some(line => line.by === 'P-2'));
});

test('CL-4: while the server does not answer, the page asks again a little later each time, and the person\'s drawing does not hurry it', async () => {
  const w = world();
  const a = w.page('P-1');
  a.client.start();
  await w.advance(100);
  const before = w.requests.get('P-1').length;
  w.net.set('P-1', () => 'fail');
  const since = w.clock.now;
  const line = a.client.beginLine();
  // The person goes on drawing all through the outage.
  for (let step = 0; step < 300; step += 1) { a.client.addPoints(line, [[step, step]]); await w.advance(100); }
  const during = w.requests.get('P-1').slice(before).map(entry => entry.at - since);
  const gaps = during.slice(1).map((at, index) => at - during[index]);
  // 500 ms, 1 s, 2 s, 4 s, then every 8 s: never faster, whatever the pen does.
  assert.deepEqual(gaps.slice(0, 5).map(gap => Math.round(gap / 100) * 100), [500, 1000, 2000, 4000, 8000]);
  assert.ok(gaps.slice(5).every(gap => gap >= 7900), JSON.stringify(gaps));
  assert.ok(during.length <= 10, `${during.length} requests in 30 seconds without an answer`);
  // The server is back: everything drawn meanwhile arrives, in order, as one line.
  w.net.delete('P-1');
  a.client.endLine(line);
  await w.advance(20_000, 250);
  const server = await w.server();
  assert.equal(server.length, 1);
  assert.deepEqual(server[0].points, Array.from({ length: 300 }, (_unused, index) => [index, index]));
  assert.equal(server[0].done, true);
  assert.deepEqual(ROOM_CLIENT.retryMs, [500, 1000, 2000, 4000, 8000]);
});

test('CL-5: a page that draws faster than the server takes keeps what it has and sends it later; the line arrives whole and in order', async () => {
  const w = world();
  // A page that cuts a part every 20 ms would send far more than 60 in 10 seconds.
  const a = w.page('P-1', { flushMs: 20, pollMs: 100 });
  a.client.start();
  await w.advance(100);
  const line = a.client.beginLine();
  for (let step = 0; step < 200; step += 1) { a.client.addPoints(line, [[step, 2 * step]]); await w.advance(25, 25); }
  a.client.endLine(line);
  await w.advance(60_000, 250);
  const server = await w.server();
  assert.equal(server.length, 1);
  assert.deepEqual(server[0].points, Array.from({ length: 200 }, (_unused, index) => [index, 2 * index]));
  assert.equal(server[0].done, true);
  assert.equal(a.client.view().waiting, 0);
  // Nothing was lost to "out of order" or dropped on the way: the only refusal was "too fast", which waits.
  assert.deepEqual(a.told.flatMap(what => what.refused ?? []), []);
});

test('CL-6: taken out of the room: the page is told, stops asking, and shows nothing it had not confirmed', async () => {
  const w = world();
  const a = w.page('P-1'), b = w.page('P-2');
  a.client.start(); b.client.start();
  draw(b.client, [[1, 1]]);
  await w.advance(1500);
  w.lesson.people = ['P-1', 'P-3'];                     // P-2 is taken out
  const line = b.client.beginLine();
  b.client.addPoints(line, [[9, 9]]);
  await w.advance(2000);
  assert.deepEqual(b.told.at(-1), { stopped: 'NOT_IN_ROOM' });
  assert.equal(b.client.view().stopped, 'NOT_IN_ROOM');
  const asked = w.requests.get('P-2').length;
  b.client.addPoints(line, [[10, 10]]);
  b.client.say('still here?');
  await w.advance(10_000, 250);
  assert.equal(w.requests.get('P-2').length, asked, 'no request after being told');
  // The others keep what that person had drawn before, and nothing of what came after.
  assert.deepEqual(w.boardOf(a).map(entry => entry.points), [[[1, 1]]]);
});

test('CL-7: the chat: to the whole room, each message once, cut at its length, and gone when the lesson ends', async () => {
  const w = world();
  const a = w.page('P-1'), b = w.page('P-2');
  a.client.start(); b.client.start();
  a.client.say('  hello everyone  ');
  a.client.say('');
  a.client.say('x'.repeat(700));
  await w.advance(2000);
  const got = b.client.view().chat.messages;
  assert.deepEqual(got.map(message => [message.by, message.name, message.text.length]), [['P-1', 'P-1', 14], ['P-1', 'P-1', 500]]);
  assert.equal(got[0].text, 'hello everyone');
  // There is no way to name a receiver: say() takes the text and nothing else.
  assert.equal(a.client.say.length, 1);
  // The lesson ends: the page's own list is emptied as soon as it hears.
  w.lesson.endedAt = w.clock.now;
  await w.advance(2000);
  assert.deepEqual([b.client.view().chat.messages.length, b.client.view().chat.ended], [0, true]);
  assert.deepEqual([a.client.view().chat.messages.length, a.client.view().chat.ended], [0, true]);
  // A room where nobody had written anything: the page still learns that the chat is over.
  const quiet = world();
  const c = quiet.page('P-1');
  c.client.start();
  await quiet.advance(1000);
  assert.equal(c.client.view().chat.ended, false);
  quiet.lesson.endedAt = quiet.clock.now;
  await quiet.advance(2000);
  assert.deepEqual([c.client.view().chat.messages.length, c.client.view().chat.ended, c.client.view().board.ended], [0, true, true]);   // and that the board can no longer be drawn on
});

test('CL-8: the share turn on a page: asked for before sharing, kept by saying "still sharing", lost with the connection, handed over', async () => {
  const w = world();
  const a = w.page('P-1'), b = w.page('P-2'), c = w.page('P-3');
  for (const entry of [a, b, c]) entry.client.start();
  await w.advance(200);
  a.client.claimTurn();
  await w.advance(1500);
  assert.deepEqual([a.client.view().turn.mine, b.client.view().turn.holder, b.client.showsShareOf('P-1'), b.client.showsShareOf('P-3')], [true, 'P-1', true, false]);
  // A second person asks: refused, and told so; their page must not start a share.
  b.client.claimTurn();
  await w.advance(1500);
  assert.deepEqual(b.told.flatMap(what => what.refused ?? []).map(item => item.error), ['BUSY']);
  assert.equal(b.client.view().turn.mine, false);
  // The holder keeps the turn well past the lease by saying "still sharing" on its own.
  await w.advance(3 * TURN_LIMITS.leaseMs, 250);
  assert.equal(c.client.view().turn.holder, 'P-1');
  // The holder's connection drops for longer than the lease: the others see the turn free, and the
  // holder's page learns it has lost the turn when it is back (it must stop its share).
  w.net.set('P-1', () => 'lose-request');
  await w.advance(TURN_LIMITS.leaseMs + 2000, 250);
  assert.equal(c.client.view().turn.holder, null);
  c.client.claimTurn();
  await w.advance(1500);
  w.net.delete('P-1');
  await w.advance(12_000, 250);
  assert.ok(a.told.some(what => what.turn === 'lost'));
  assert.deepEqual([a.client.view().turn.mine, a.client.view().turn.holder, a.client.showsShareOf('P-3')], [false, 'P-3', true]);
  // Handing over: it waits for the person named.
  c.client.handOver('P-2');
  await w.advance(1500);
  assert.deepEqual([b.client.view().turn.offeredToMe, a.client.view().turn.offeredTo, c.client.view().turn.mine], [true, 'P-2', false]);
  b.client.claimTurn();
  await w.advance(1500);
  assert.equal(a.client.view().turn.holder, 'P-2');
  b.client.releaseTurn();
  await w.advance(1500);
  assert.equal(a.client.view().turn.holder, null);
});

test('CL-9: a long line goes in parts the server takes; a place on the page becomes a point of the board', async () => {
  const w = world();
  const a = w.page('P-1'), b = w.page('P-2');
  a.client.start(); b.client.start();
  await w.advance(100);
  // Exactly two full parts, then the pen stops: the line is still closed.
  const points = Array.from({ length: 2 * BOARD_LIMITS.pointsPerPart }, (_unused, index) => [index, index % 100]);
  const line = a.client.beginLine();
  a.client.addPoints(line, points);
  await w.advance(1000);
  a.client.endLine(line);
  await w.advance(3000);
  const server = await w.server();
  assert.equal(server.length, 1);
  assert.equal(server[0].done, true);
  assert.deepEqual(server[0].points, points);
  assert.deepEqual(w.boardOf(b), server);
  // A line with no point is nothing.
  a.client.endLine(a.client.beginLine());
  await w.advance(1500);
  assert.equal((await w.server()).length, 1);
  assert.deepEqual([toBoard(0, 0, 800, 600), toBoard(800, 600, 800, 600), toBoard(400, 150, 800, 600), toBoard(-5, 9999, 800, 600)], [[0, 0], [10_000, 10_000], [5_000, 2_500], [0, 10_000]]);
});

// --- The share control: this page never shares without the turn ------------------------------------
// A stand-in for the page's media adapter: it counts what it is asked, and the test says who Zoom lists as sharing.
function fakeMedia(starts = true) {
  const calls = { start: 0, stop: 0, shown: [] };
  let listed = [];
  const listeners = new Set();
  return {
    calls,
    zoomLists(ids) { listed = [...ids]; for (const listener of listeners) listener(); },
    media: {
      startShare: async () => { calls.start += 1; return typeof starts === 'function' ? starts() : starts; },
      stopShare: async () => { calls.stop += 1; },
      sharers: () => [...listed],
      onSharersChange: listener => { listeners.add(listener); return () => listeners.delete(listener); },
      showShareOf: id => { calls.shown.push(id); },
    },
  };
}
function sharer(w, id, starts = true) {
  const entry = w.page(id);
  const stand = fakeMedia(starts);
  const said = [];
  const control = createShareControl({ client: entry.client, media: stand.media, timer: w.timer, notify: what => said.push(what) });
  entry.hooks.changed = what => control.changed(what);
  entry.client.start();
  return { ...entry, control, stand, said };
}
// What a promise came to, after the room has been given time.
const after = async (w, promise, ms = 1500) => { await w.advance(ms); return promise; };

test('SC-1: a share starts only with the turn; while one person holds it, another page never starts a share at all', async () => {
  const w = world();
  const a = sharer(w, 'P-1'), b = sharer(w, 'P-2');
  await w.advance(200);
  assert.equal(await after(w, a.control.start()), true);
  assert.deepEqual([a.stand.calls.start, a.control.sharing, a.client.view().turn.mine], [1, true, true]);
  // Everyone shows the holder's stream and no other.
  assert.equal(b.stand.calls.shown.at(-1), 'P-1');
  assert.equal(b.client.showsShareOf('P-1'), true);
  assert.equal(b.client.showsShareOf('P-3'), false);
  // The second person presses share: refused by the server, and their page asks the browser for nothing.
  assert.equal(await after(w, b.control.start()), false);
  assert.deepEqual([b.stand.calls.start, b.control.sharing], [0, false]);
  assert.deepEqual(b.told.flatMap(what => what.refused ?? []).map(item => item.error), ['BUSY']);
  // The holder stops: the share is stopped, the turn is free, nobody's stream is shown.
  await after(w, a.control.stop());
  assert.deepEqual([a.stand.calls.stop, a.control.sharing], [1, false]);
  assert.equal(b.client.view().turn.holder, null);
  assert.equal(b.stand.calls.shown.at(-1), null);
  // Now the second person can.
  assert.equal(await after(w, b.control.start()), true);
  assert.equal(a.client.view().turn.holder, 'P-2');
});

test('SC-2: the share itself does not start (the person closed the browser\'s window): the turn goes back at once', async () => {
  const w = world();
  const a = sharer(w, 'P-1', false), b = sharer(w, 'P-2');
  await w.advance(200);
  assert.equal(await after(w, a.control.start()), false);
  assert.deepEqual([a.stand.calls.start, a.control.sharing], [1, false]);
  assert.ok(a.said.some(what => what.notice === 'NOT_STARTED'));
  await w.advance(1500);
  assert.equal(b.client.view().turn.holder, null);
  assert.equal(await after(w, b.control.start()), true);
});

test('SC-3: the turn is lost while the connection is away: the page stops its share when it hears, and says why', async () => {
  const w = world();
  const a = sharer(w, 'P-1'), b = sharer(w, 'P-2');
  await w.advance(200);
  assert.equal(await after(w, a.control.start()), true);
  w.net.set('P-1', () => 'lose-request');
  await w.advance(TURN_LIMITS.leaseMs + 3000, 250);
  assert.equal(b.client.view().turn.holder, null, 'the others see the turn free once the lease has run out');
  assert.equal(await after(w, b.control.start()), true);
  w.net.delete('P-1');
  await w.advance(12_000, 250);
  assert.deepEqual([a.control.sharing, a.stand.calls.stop >= 1], [false, true]);
  assert.ok(a.said.some(what => what.notice === 'LOST'));
  assert.equal(a.stand.calls.shown.at(-1), 'P-2');
});

test('SC-4: stopped with the browser\'s own button: Zoom no longer lists the person, and the turn goes back', async () => {
  const w = world();
  const a = sharer(w, 'P-1'), b = sharer(w, 'P-2');
  await w.advance(200);
  assert.equal(await after(w, a.control.start()), true);
  a.stand.zoomLists(['P-1']);                      // Zoom lists the holder: nothing changes
  await w.advance(1500);
  assert.equal(b.client.view().turn.holder, 'P-1');
  a.stand.zoomLists([]);                           // the person pressed the browser's "stop sharing"
  await w.advance(1500);
  assert.deepEqual([a.control.sharing, b.client.view().turn.holder], [false, null]);
});

test('SC-5: no answer in time: the share is not started, and a turn that arrives late is given back', async () => {
  const w = world();
  const a = sharer(w, 'P-1'), b = sharer(w, 'P-2');
  await w.advance(200);
  w.net.set('P-1', () => 'lose-request');
  assert.equal(await after(w, a.control.start(), 7000), false);
  assert.equal(a.stand.calls.start, 0);
  w.net.delete('P-1');
  await w.advance(12_000, 250);
  assert.deepEqual([a.client.view().turn.mine, b.client.view().turn.holder, a.control.sharing], [false, null, false]);
});

test('SC-6: taken out of the room while sharing: the share stops; leaving the room gives the turn back', async () => {
  const w = world();
  const a = sharer(w, 'P-1'), b = sharer(w, 'P-2'), c = sharer(w, 'P-3');
  await w.advance(200);
  assert.equal(await after(w, a.control.start()), true);
  w.lesson.people = ['P-2', 'P-3'];                // P-1 is taken out
  await w.advance(2000);
  assert.deepEqual([a.client.view().stopped, a.control.sharing, a.stand.calls.stop], ['NOT_IN_ROOM', false, 1]);
  assert.equal(a.stand.calls.shown.at(-1), null);
  assert.equal(b.client.view().turn.holder, null);
  // Another person shares and then leaves the room page: the turn is given back, and nothing is done after that.
  assert.equal(await after(w, b.control.start()), true);
  b.control.close();
  await w.advance(1500);
  assert.equal(c.client.view().turn.holder, null);
  assert.equal(await b.control.start(), false);
  assert.equal(b.stand.calls.start, 1);
});

test('SC-7: the turn is lost while the browser\'s own window is still open: when the person finally chooses, nothing is shared', async () => {
  const w = world();
  // The person leaves the browser's "choose what to share" window open; the test says when they choose.
  let choose = null;
  const a = sharer(w, 'P-1', () => new Promise(resolve => { choose = resolve; })), b = sharer(w, 'P-2');
  await w.advance(200);
  const starting = a.control.start();
  await w.advance(1500);
  assert.deepEqual([a.client.view().turn.mine, a.stand.calls.start, a.control.sharing], [true, 1, false]);
  // Meanwhile the connection is away for longer than the lease, and someone else takes the turn.
  w.net.set('P-1', () => 'lose-request');
  await w.advance(TURN_LIMITS.leaseMs + 3000, 250);
  assert.equal(await after(w, b.control.start()), true);
  w.net.delete('P-1');
  await w.advance(12_000, 250);
  assert.equal(a.client.view().turn.holder, 'P-2');
  // Now the person chooses a window: the share that the browser has just started is stopped at once.
  choose(true);
  assert.equal(await after(w, starting, 500), false);
  assert.deepEqual([a.control.sharing, a.stand.calls.stop >= 1], [false, true]);
  assert.ok(a.said.some(what => what.notice === 'LOST'));
  assert.equal(b.control.sharing, true);
});

test('SC-8: the page that shares goes away (closed, reloaded): its turn is free at once, not when the lease runs out; another window of the same person takes nothing with it', async () => {
  const w = world();
  const a = sharer(w, 'P-1'), b = sharer(w, 'P-2');
  const second = sharer(w, 'P-1');                 // the same person has the room open in a second window, which does not share
  await w.advance(200);
  assert.deepEqual([a.control.holding, a.client.parting({ turn: a.control.holding })], [false, null], 'a page that does not share has nothing to give back');
  assert.equal(a.client.parting({ turn: true }), null, 'and nobody\'s turn is given back by a page that holds none');
  assert.equal(await after(w, a.control.start()), true);
  assert.deepEqual([a.control.holding, second.control.holding, second.client.view().turn.mine], [true, false, true]);

  // The second window is closed. The turn is this person's, but not this window's: it sends nothing, and the share goes on.
  assert.equal(second.client.parting({ turn: second.control.holding }), null);
  second.control.close();
  second.client.stop();
  await w.advance(TURN_LIMITS.beatEveryMs * 2 + 500, 250);
  assert.deepEqual([a.control.sharing, b.client.view().turn.holder], [true, 'P-1']);

  // The sharing window is reloaded. Its last request gives the turn back and asks for nothing.
  const last = a.client.parting({ turn: a.control.holding });
  assert.deepEqual(last, { key: 'ticket-P-1', cursors: {}, send: [{ part: 'turn', action: 'release' }] });
  a.control.close();
  a.client.stop();
  const left = w.clock.now;
  const answer = await w.send('P-1', last);
  assert.deepEqual([Object.keys(answer).sort(), answer.sent.length, answer.sent[0].wasHolder, answer.sent[0].turn.holder], [['ok', 'sent'], 1, true, null], 'the turn is given back, and nothing is read');
  await w.advance(1000);
  assert.equal(b.client.view().turn.holder, null);
  assert.ok(w.clock.now - left < TURN_LIMITS.leaseMs / 10, 'within a second, where the lease would have taken fifteen');

  // Someone goes away while the browser's own "choose what to share" window is still open: that page holds the turn too.
  const c = sharer(w, 'P-3', () => new Promise(() => {}));
  await w.advance(300);
  void c.control.start();
  await w.advance(1500);
  assert.deepEqual([c.client.view().turn.mine, c.control.sharing, c.control.holding], [true, false, true]);
  const lastOfC = c.client.parting({ turn: c.control.holding });
  c.control.close();
  c.client.stop();
  assert.equal((await w.send('P-3', lastOfC)).sent[0].wasHolder, true);
  await w.advance(1000);
  assert.equal(b.client.view().turn.holder, null);

  // The reloaded page comes back as a new page: it holds nothing, and can share again.
  const again = sharer(w, 'P-1');
  await w.advance(600);
  assert.deepEqual([again.client.view().turn.mine, again.control.holding], [false, false]);
  assert.equal(await after(w, again.control.start()), true);
  assert.equal(b.client.view().turn.holder, 'P-1');

  // Taken out of the room: the page has nothing more to say as it goes.
  w.lesson.people = ['P-2', 'P-3'];
  await w.advance(2000);
  assert.deepEqual([again.client.view().stopped, again.client.parting({ turn: true })], ['NOT_IN_ROOM', null]);
});

test('CL-10: who is in the lesson, as the server names them: the page has the list, hears of a change once, and takes nothing that is not a person', async () => {
  const w = world();
  const a = w.page('P-1');
  a.client.start();
  await w.advance(600);
  assert.deepEqual(a.client.view().people, [{ id: 'P-1', name: 'Name of P-1' }, { id: 'P-2', name: 'Name of P-2' }, { id: 'P-3', name: 'Name of P-3' }]);
  assert.equal(a.told.filter(what => what.people).length, 1, 'said once, not with every answer');
  // Someone is taken out, and someone's name is set right: the list follows, said once each time.
  w.lesson.people = ['P-1', 'P-3'];
  await w.advance(1200);
  assert.deepEqual(a.client.view().people.map(person => person.id), ['P-1', 'P-3']);
  w.names.set('P-3', '小明');
  await w.advance(1200);
  assert.deepEqual(a.client.view().people.at(-1), { id: 'P-3', name: '小明' });
  assert.equal(a.told.filter(what => what.people).length, 3);
  // The same list again changes nothing; the list is the same object for a page that compares.
  const before = a.client.view().people;
  await w.advance(2000);
  assert.equal(a.client.view().people, before);
  assert.equal(a.told.filter(what => what.people).length, 3);
});

// ---------------------------------------------------------------------------------------------
// The room's pace (2026-11-27), with the figures a real page follows (lib/room-channel/pace.mjs).
// In these tests an answer comes back in no time, so the times between requests are the waits alone.
const askedBetween = (w, id, from, to) => (w.requests.get(id) ?? []).filter(entry => entry.at > from && entry.at <= to);

test('CL-11: a quiet room is asked every 5 seconds; a line drawn into it shows within that, then the room is asked every second, and every 5 again 20 seconds after the last news', async () => {
  const w = world();
  const a = w.page('P-1', AS_A_PAGE), b = w.page('P-2', AS_A_PAGE);
  a.client.start(); b.client.start();
  // Coming in is news (who is here): the first 20 seconds count as active. After them the room is quiet.
  await w.advance(30_000);
  let from = w.clock.now;
  await w.advance(60_000);
  assert.equal(askedBetween(w, 'P-2', from, w.clock.now).length, 12, 'one request every 5 seconds in a quiet room');
  // Someone draws between two of the other page's requests: it shows there at that page's next one.
  await w.advance(2_000);
  let seenAt = null;
  b.hooks.changed = what => { if (what.board && seenAt === null) seenAt = w.clock.now; };
  const drawnAt = w.clock.now;
  draw(a.client, [[100, 100], [200, 200]]);
  await w.advance(5_000);
  assert.equal(w.boardOf(b).length, 1);
  assert.ok(seenAt - drawnAt > 1_000 && seenAt - drawnAt <= 5_000, `seen ${seenAt - drawnAt} ms after it was drawn`);
  // From that news on: every second for 20 seconds, then every 5 seconds again.
  await w.advance(seenAt + 20_000 - w.clock.now);
  assert.equal(askedBetween(w, 'P-2', seenAt, seenAt + 20_000).length, 20, 'one request a second while the room has news');
  from = w.clock.now;
  await w.advance(60_000);
  assert.equal(askedBetween(w, 'P-2', from, w.clock.now).length, 12, 'quiet again');
});

test('CL-12: the pace is the server\'s to say: a page follows what an answer says from the next request on, inside the bounds, and a figure a page was told to keep stays', async () => {
  const w = world();
  w.said.pace = { activeMs: 2_000, idleMs: 10_000, quietAfterMs: 4_000, flushMs: 1_000, hiddenMs: 30_000 };
  const a = w.page('P-1', AS_A_PAGE), kept = w.page('P-2');
  a.client.start(); kept.client.start();
  await w.advance(100);
  assert.deepEqual(a.client.pace(), w.said.pace);
  assert.deepEqual(kept.client.pace(), QUICK, 'a page told to keep its own figures keeps them');
  await w.advance(20_000);
  let from = w.clock.now;
  await w.advance(60_000);
  assert.equal(askedBetween(w, 'P-1', from, w.clock.now).length, 6, 'every 10 seconds, as the server said');
  // The site changes one figure: the page has it with its next answer.
  w.said.pace = { idleMs: 3_000 };
  await w.advance(10_000);
  assert.deepEqual(a.client.pace(), { activeMs: 2_000, idleMs: 3_000, quietAfterMs: 4_000, flushMs: 1_000, hiddenMs: 30_000 });
  from = w.clock.now;
  await w.advance(30_000);
  assert.equal(askedBetween(w, 'P-1', from, w.clock.now).length, 10);
  // Figures outside the bounds, or that are no figures, change nothing.
  const before = a.client.pace();
  w.said.pace = { idleMs: 5, activeMs: 'fast', flushMs: 999_999, quietAfterMs: -1, hiddenMs: null, other: 1 };
  await w.advance(6_000);
  assert.deepEqual(a.client.pace(), before);
  // A page nobody looks at asks no more often than the server's figure for that.
  a.client.setIdle(true);
  await w.advance(3_000);
  from = w.clock.now;
  await w.advance(90_000);
  assert.equal(askedBetween(w, 'P-1', from, w.clock.now).length, 3, 'every 30 seconds while hidden');
});

test('CL-13: a pen\'s points go in batches half a second apart: a long stroke, quick strokes one after the other, and a single stroke after a pause', async () => {
  const w = world();
  const a = w.page('P-1', AS_A_PAGE);
  a.client.start();
  await w.advance(100);
  const boardSends = (from, to) => askedBetween(w, 'P-1', from, to).filter(entry => entry.board > 0).map(entry => entry.at);
  // A long stroke: a point every 20 ms for 5 seconds.
  let from = w.clock.now;
  const long = a.client.beginLine();
  for (let step = 0; step < 250; step += 1) { a.client.addPoints(long, [[step, step]]); await w.advance(20, 20); }
  a.client.endLine(long);
  await w.advance(3_000, 20);
  let sends = boardSends(from, w.clock.now);
  assert.ok(sends.length >= 9 && sends.length <= 11, `${sends.length} requests for 5 seconds of drawing`);
  for (let index = 1; index < sends.length; index += 1) assert.ok(sends[index] - sends[index - 1] >= 500, `batches ${sends[index] - sends[index - 1]} ms apart`);
  // Six quick strokes within a second: sent together, not one request each.
  from = w.clock.now;
  for (let stroke = 0; stroke < 6; stroke += 1) {
    const line = a.client.beginLine();
    a.client.addPoints(line, [[stroke, 1], [stroke, 2], [stroke, 3]]);
    await w.advance(60, 20);
    a.client.endLine(line);
    await w.advance(100, 20);
  }
  sends = boardSends(from, w.clock.now);
  assert.ok(sends.length <= 2, `${sends.length} requests while six strokes were drawn in a second`);
  await w.advance(3_000, 20);
  sends = boardSends(from, w.clock.now);
  assert.ok(sends.length <= 3);
  for (let index = 1; index < sends.length; index += 1) assert.ok(sends[index] - sends[index - 1] >= 500);
  // A single stroke after a pause: its end goes at once.
  from = w.clock.now;
  draw(a.client, [[7, 7], [8, 8]]);
  await w.advance(40, 20);
  assert.equal(boardSends(from, w.clock.now).length, 1, 'sent at once');
  await w.advance(1_000, 20);
  // Nothing lost on the way: the long line whole, the six, and the one.
  const server = await w.server();
  assert.equal(server.length, 8);
  assert.deepEqual(server.find(line => line.line === `P-1:${long}`).points, Array.from({ length: 250 }, (_unused, index) => [index, index]));
  assert.ok(server.every(line => line.done));
  assert.equal(a.client.view().waiting, 0);
});

test('CL-14: the person who shares keeps the turn on a hidden page in a quiet room: "still sharing" is never waited past', async () => {
  const w = world();
  const a = w.page('P-1', AS_A_PAGE), b = w.page('P-2', AS_A_PAGE);
  a.client.start(); b.client.start();
  await w.advance(100);
  a.client.claimTurn();
  await w.advance(1_000);
  assert.equal(a.client.view().turn.mine, true);
  // They share another window, so the classroom's own page is hidden; nothing else happens in the room.
  a.client.setIdle(true);
  let from = w.clock.now;
  await w.advance(6 * TURN_LIMITS.leaseMs, 250);
  assert.equal(a.client.view().turn.mine, true, 'the turn is kept for six times the lease');
  assert.equal(b.client.view().turn.holder, 'P-1');
  assert.ok(!a.told.some(what => what.turn === 'lost'));
  const times = askedBetween(w, 'P-1', from, w.clock.now).map(entry => entry.at);
  for (let index = 1; index < times.length; index += 1) assert.ok(times[index] - times[index - 1] <= TURN_LIMITS.beatEveryMs, `${times[index] - times[index - 1]} ms between two requests of the holder`);
  // Without the turn, the same hidden page asks every 15 seconds.
  a.client.releaseTurn();
  await w.advance(30_000, 250);
  assert.equal(b.client.view().turn.holder, null);
  from = w.clock.now;
  await w.advance(60_000, 250);
  assert.equal(askedBetween(w, 'P-1', from, w.clock.now).length, 4);
});

test('CL-15: the lesson\'s status rides in the channel\'s own requests: asked every 15 seconds by a page that wants it, answered as the status route would, never asked otherwise', async () => {
  const w = world();
  let answers = 0;
  w.said.lessonStatus = id => ({ status: 200, body: { ok: true, recordingAllowed: false, answer: (answers += 1), for: id } });
  const a = w.page('P-1', { ...AS_A_PAGE, lessonStatusEveryMs: 15_000 }), b = w.page('P-2', AS_A_PAGE);
  a.client.start(); b.client.start();
  await w.advance(100);
  // With the very first request.
  assert.deepEqual(a.client.lessonStatus(), { status: 200, body: { ok: true, recordingAllowed: false, answer: 1, for: 'P-1' }, at: T0 + 50 });
  assert.ok(a.told.some(what => what.lessonStatus === true));
  await w.advance(60_000);
  assert.equal(w.requests.get('P-1').filter(entry => entry.status).length, 5, 'once at first, then every 15 seconds, in requests the page makes anyway');
  assert.equal(a.client.lessonStatus().body.answer, 5);
  assert.ok(w.requests.get('P-2').every(entry => !entry.status), 'a page that does not want it never asks');
  assert.equal(b.client.lessonStatus(), null);
  // What the status route refuses comes through as it is, for the page to act on.
  w.said.lessonStatus = () => ({ status: 403, body: { error: 'You cannot enter this classroom', code: 'LESSON_CANCELLED' } });
  await w.advance(15_000);
  assert.deepEqual([a.client.lessonStatus().status, a.client.lessonStatus().body.code], [403, 'LESSON_CANCELLED']);
  // A server that says nothing about it: the page keeps what it had, and asks again in 15 seconds, not with every request.
  w.said.lessonStatus = null;
  const from = w.clock.now;
  await w.advance(30_000);
  assert.equal(askedBetween(w, 'P-1', from, w.clock.now).filter(entry => entry.status).length, 2);
  assert.equal(a.client.lessonStatus().status, 403);
});
