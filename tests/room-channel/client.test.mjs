// The room channel as a page keeps it, against the real service over the store in memory, with a
// clock and a network of the test's own (2026-11-23). No browser, no real network, no Zoom.
//   node --test "tests/room-channel/*.test.mjs"
import assert from 'node:assert/strict';
import test from 'node:test';

import { BOARD_LIMITS, snapshot } from '../../lib/room-channel/board.mjs';
import { createRoomClient, ROOM_CLIENT, toBoard } from '../../lib/room-channel/client.mjs';
import { createRoomChannel } from '../../lib/room-channel/service.mjs';
import { TURN_LIMITS } from '../../lib/room-channel/share-turn.mjs';
import { createMemoryStore } from '../../lib/room-channel/store-memory.mjs';

const T0 = 1_800_000_000_000, HOUR = 3_600_000;
const ON = { board: true, chat: true, turn: true };
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
  const net = new Map(), requests = new Map();
  const settle = async () => { for (let turn = 0; turn < 8; turn += 1) await new Promise(resolve => { setImmediate(resolve); }); };
  const page = (id, options = {}) => {
    const told = [];
    const client = createRoomClient({
      key: `ticket-${id}`, now: () => clock.now, timer, changed: what => told.push(what), ...options,
      post: async body => {
        const list = requests.get(id) ?? [];
        list.push({ at: clock.now, sent: body.send.length });
        requests.set(id, list);
        assert.equal(body.key, `ticket-${id}`);
        assert.deepEqual(Object.keys(body).sort(), ['cursors', 'key', 'send'], 'a request says nothing about who is asking but the ticket');
        const mode = net.get(id)?.(list.length, body) ?? 'ok';
        if (mode === 'lose-request') throw new Error('offline');
        if (mode === 'fail') return { status: 503, body: { error: 'temporarily unavailable' } };
        if (!lesson.people.includes(id)) return { status: 403, body: { error: 'You are not in this classroom', code: 'NOT_IN_ROOM' } };
        const result = await channel.exchange({ lesson, who: { id, name: id, member: true }, on: ON, cursors: body.cursors, send: body.send, now: clock.now });
        if (mode === 'lose-answer') throw new Error('offline');
        return { status: result.ok ? 200 : 400, body: { ...result, you: id } };
      },
    });
    return { client, told, id };
  };
  async function advance(ms, step = 50) {
    const end = clock.now + ms;
    while (clock.now < end) {
      clock.now = Math.min(end, clock.now + step);
      for (;;) {
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
  return { store, channel, clock, lesson, net, requests, page, advance, settle, server, boardOf };
}
const draw = (client, points, more = {}) => { const line = client.beginLine({ color: 2, width: 4, ...more }); client.addPoints(line, points); client.endLine(line); return line; };

test('CL-1: what one person draws shows on their page at once, and on everyone else\'s when the server has taken it', async () => {
  const w = world();
  const a = w.page('P-1'), b = w.page('P-2');
  a.client.start(); b.client.start();
  await w.advance(100);
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
