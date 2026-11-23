// The room channel as a service over a store that keeps a board's lines apart (2026-11-23): the
// tests themselves, run over each store by its own file (service.test.mjs: in memory;
// postgres.test.mjs: a disposable local PostgreSQL). No browser, no network, no Zoom.
import assert from 'node:assert/strict';
import nodeTest from 'node:test';

import { apply, BOARD_LIMITS, newBoard, since, snapshot } from '../../lib/room-channel/board.mjs';
import { CHAT_LIMITS } from '../../lib/room-channel/chat.mjs';
import { deleteAfter, lessonEnd, RETENTION } from '../../lib/room-channel/retention.mjs';
import { createRoomChannel, SEND_MAX } from '../../lib/room-channel/service.mjs';
import { TURN_LIMITS } from '../../lib/room-channel/share-turn.mjs';

const T0 = 1_800_000_000_000;
const HOUR = 60 * 60_000, MIN = 60_000;
const ON = { board: true, chat: true, turn: true };
const PEOPLE = ['P-1', 'P-2', 'P-3', 'P-4', 'P-5', 'P-6'];
const lessonOf = (more = {}) => ({ id: 'L-1', roomId: 'FR-1', scheduledEnd: T0 + 3 * HOUR, endedAt: null, people: PEOPLE, ...more });
const who = id => ({ id, name: `Name ${id}`, member: true });
const stroke = (line, part, points, more = {}) => ({ kind: 'stroke', op: `${line}-${part}`, line, part, points, color: 1, width: 2, done: false, ...more });
// A small generator with a seed, so that a failing run can be run again.
const seeded = seed => () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };

// make(): a store with nothing in it (and, where the store needs them, the lessons these tests name).
export const LESSONS = ['L-1', 'L-2', 'L-early', 'L-running', 'L-gone', 'L-unread', 'L-short'];
// quick: a short run of the long comparison and a small board, for the deliberate-break runner.
export function serviceSuite({ label = '', make, seeds = [11, 12, 13], quick = false }) {
const test = (name, work) => nodeTest(`${label}${name}`, work);
const setup = async () => { const store = await make(); return { store, channel: createRoomChannel(store) }; };

test('SV-1: over a store that keeps lines apart, every answer and every picture is what the whole board gives', async () => {
  for (const seed of seeds) {
    const { store, channel } = await setup();
    const random = seeded(seed), pick = list => list[Math.floor(random() * list.length)];
    const lesson = lessonOf({ scheduledEnd: T0 + 1000 * HOUR });
    let whole = newBoard({ roomId: 'FR-1', lessonId: 'L-1', now: T0 });
    let now = T0, serial = 0, lastClear = null;
    const open = new Map(PEOPLE.map(id => [id, []])), sentBefore = [];
    for (let step = 0; step < (quick ? 700 : 4_500); step += 1) {
      now += random() < 0.01 ? 11 * MIN : random() < 0.03 ? 11_000 : 5 + Math.floor(random() * 300);
      const by = pick(PEOPLE), roll = random();
      let input = null;
      if (roll < 0.30) { const line = `l${serial += 1}`; input = stroke(line, 0, [[step % 9000, 5], [7, step % 9000]], { done: random() < 0.3 }); if (!input.done) open.get(by).push({ line, parts: 1 }); }
      else if (roll < 0.58 && open.get(by).length) { const mine = pick(open.get(by)); input = stroke(mine.line, mine.parts, [[mine.parts, mine.parts]], { done: random() < 0.4 }); mine.parts += 1; if (input.done) open.set(by, open.get(by).filter(item => item !== mine)); }
      else if (roll < 0.68) { const lines = snapshot(whole, now).lines; input = { kind: 'erase', op: `e${serial += 1}`, line: lines.length ? pick(lines).line : 'P-9:none' }; }
      else if (roll < 0.72) input = { kind: 'clear', op: `c${serial += 1}` };
      else if (roll < 0.76) input = { kind: 'undo', op: `u${serial += 1}`, clear: lastClear ?? 1 };
      else if (roll < 0.84 && sentBefore.length) { const again = pick(sentBefore); const answer = (await channel.exchange({ lesson, who: who(again.by), on: ON, send: [{ part: 'board', input: again.input }], now })).sent[0]; const model = apply(whole, { by: again.by, member: true, input: again.input, now }); whole = model.state; assert.deepEqual(answer, model.answer, `seed ${seed} step ${step}: a request sent again`); continue; }
      else if (roll < 0.89) input = pick([stroke('zz', 3, [[1, 1]]), { kind: 'erase', op: 'x', line: 'nobody' }, { kind: 'stroke', op: 'bad', line: 'q', part: 0, points: [], color: 1, width: 2, done: true }, { kind: 'clear', op: 'c', extra: 1 }]);
      if (input) {
        const answer = (await channel.exchange({ lesson, who: who(by), on: ON, send: [{ part: 'board', input }], now })).sent[0];
        const model = apply(whole, { by, member: true, input, now });
        whole = model.state;
        assert.deepEqual(answer, model.answer, `seed ${seed} step ${step}: ${input.kind}`);
        if (answer.ok && input.kind === 'clear') lastClear = answer.seq;
        if (answer.ok && sentBefore.length < 400) sentBefore.push({ by, input });
        else if (answer.ok && random() < 0.2) sentBefore[Math.floor(random() * sentBefore.length)] = { by, input };
      } else {
        // Someone reads from a place of their own: caught up from the recent operations, or handed the picture afresh.
        const cursor = pick([0, whole.seq, Math.max(0, whole.seq - Math.floor(random() * 50)), Math.max(0, whole.base - 1), whole.base, whole.seq + 5, Math.floor(random() * (whole.seq + 1))]);
        const got = (await channel.exchange({ lesson, who: who(by), on: ON, cursors: { board: cursor }, now })).board;
        assert.deepEqual(got, since(whole, { by, member: true, cursor, now }), `seed ${seed} step ${step}: reading from ${cursor} (seq ${whole.seq}, base ${whole.base})`);
      }
    }
    if (!quick) assert.ok(whole.base > 0, `seed ${seed}: the run was long enough to drop old operations (base ${whole.base})`);
    const picture = (await channel.exchange({ lesson, who: who('P-1'), on: ON, cursors: { board: whole.seq + 1 }, now })).board.picture;
    assert.deepEqual(picture, snapshot(whole, now), `seed ${seed}: the last picture`);
    // The store keeps no more operations than the board says it keeps, however long the lesson.
    if (!quick) assert.equal((await store.stats(now)).operations, BOARD_LIMITS.recentKept, `seed ${seed}: operations kept in the store`);
  }
});

test('SV-2: a stroke costs what it touches, not what the board holds', async () => {
  const { store, channel } = await setup();
  const lesson = lessonOf();
  let now = T0;
  const many = quick ? 80 : 1_200;
  for (let n = 0; n < many; n += 1) { now += 200; await channel.exchange({ lesson, who: who(PEOPLE[n % 6]), on: ON, send: [{ part: 'board', input: stroke(`a${n}`, 0, [[n, n], [n + 1, n]], { done: true }) }], now }); }
  const held = await store.stats(now);
  assert.equal(held.lines, many);
  const before = { ...store.calls };
  const answer = (await channel.exchange({ lesson, who: who('P-1'), on: ON, send: [{ part: 'board', input: stroke('last', 0, [[1, 1]]) }], cursors: { board: many }, now: now + 200 }));
  assert.equal(answer.sent[0].ok, true);
  assert.equal(answer.board.entries.length, 1);
  // One read of the header, one write, one look at what is new; the picture (every line) is never read.
  assert.deepEqual({ read: store.calls.read - before.read, write: store.calls.write - before.write, news: store.calls.news - before.news, picture: store.calls.picture - before.picture }, { read: 1, write: 1, news: 1, picture: 0 });
  // The header that is read and written for every stroke holds no line and no operation.
  const row = await store.withPart('L-1', 'board', tx => tx.read());
  assert.deepEqual(row.state.lines, {});
  assert.equal(row.state.recent, undefined);
  assert.ok(JSON.stringify(row.state).length < 2_000, `the header is ${JSON.stringify(row.state).length} bytes`);
  assert.deepEqual(row.state.shown, { lines: many + 1, points: 2 * many + 1 });
});

test('SV-3: one exchange sends and reads; a part that is switched off is neither written nor read', async () => {
  const { channel } = await setup();
  const lesson = lessonOf();
  const first = await channel.exchange({ lesson, who: who('P-1'), on: ON, now: T0, cursors: { board: 0, chat: 0, turn: 0 }, send: [
    { part: 'board', input: stroke('a', 0, [[1, 1]]) }, { part: 'chat', input: { op: 'm1', text: 'hello' } }, { part: 'turn', action: 'claim' },
  ] });
  assert.deepEqual(first.sent.map(answer => answer.ok), [true, true, true]);
  assert.equal(first.board.entries.length, 1);
  assert.deepEqual(first.chat.messages.map(message => [message.by, message.name, message.text]), [['P-1', 'Name P-1', 'hello']]);
  assert.equal(first.turn.holder, 'P-1');
  // Another person sees the same from the beginning, and nothing twice from where they have reached.
  const other = await channel.exchange({ lesson, who: who('P-2'), on: ON, now: T0 + 500, cursors: { board: 0, chat: 0, turn: 0 } });
  assert.deepEqual([other.board.entries.length, other.chat.messages.length, other.turn.holder], [1, 1, 'P-1']);
  const again = await channel.exchange({ lesson, who: who('P-2'), on: ON, now: T0 + 900, cursors: { board: other.board.seq, chat: other.chat.seq, turn: 0 } });
  assert.deepEqual([again.board.entries.length, again.chat.messages.length], [0, 0]);
  // Part of the way behind: only what came after the place reached, nothing already read.
  await channel.exchange({ lesson, who: who('P-1'), on: ON, now: T0 + 950, send: [{ part: 'chat', input: { op: 'm1b', text: 'second' } }, { part: 'chat', input: { op: 'm1c', text: 'third' } }] });
  const partly = await channel.exchange({ lesson, who: who('P-2'), on: ON, now: T0 + 990, cursors: { chat: 2 } });
  assert.deepEqual(partly.chat.messages.map(message => [message.seq, message.text]), [[3, 'third']]);
  // Switched off: refused as not offered, and nothing is read for it.
  const off = await channel.exchange({ lesson, who: who('P-2'), on: { board: true, chat: false, turn: false }, now: T0 + 1000, cursors: { board: 0, chat: 0, turn: 0 }, send: [{ part: 'chat', input: { op: 'm2', text: 'x' } }, { part: 'turn', action: 'claim' }] });
  assert.deepEqual(off.sent, [{ ok: false, error: 'NOT_OFFERED' }, { ok: false, error: 'NOT_OFFERED' }]);
  assert.equal(off.chat, undefined);
  assert.equal(off.turn, undefined);
  assert.equal(off.board.entries.length, 1);
  // Not in the room, too much at once, a part that does not exist, a place that is no number.
  assert.deepEqual(await channel.exchange({ lesson, who: { id: 'P-9', name: 'x', member: false }, on: ON, now: T0, cursors: { board: 0 } }), { ok: false, error: 'NOT_IN_ROOM' });
  assert.deepEqual(await channel.exchange({ lesson, who: who('P-1'), on: ON, now: T0, send: Array.from({ length: SEND_MAX + 1 }, () => ({ part: 'turn', action: 'beat' })) }), { ok: false, error: 'TOO_MANY' });
  const odd = await channel.exchange({ lesson, who: who('P-1'), on: ON, now: T0 + 2000, cursors: { board: '0', chat: -1 }, send: [{ part: 'files', input: {} }, { part: 'turn', action: 'seize' }] });
  assert.deepEqual(odd.sent, [{ ok: false, error: 'UNKNOWN_PART' }, { ok: false, error: 'UNKNOWN_ACTION' }]);
  assert.deepEqual([odd.board, odd.chat], [{ ok: false, error: 'CURSOR' }, { ok: false, error: 'CURSOR' }]);
  // A private receiver is refused through the service as it is in the chat's own rules.
  const priv = await channel.exchange({ lesson, who: who('P-1'), on: ON, now: T0 + 3000, send: [{ part: 'chat', input: { op: 'm3', text: 'psst', to: 'P-2' } }] });
  assert.deepEqual(priv.sent, [{ ok: false, error: 'PRIVATE_NOT_OFFERED' }]);
});

test('SV-4: the first request after the lesson ended closes it: the board from the lesson\'s own end, chat and turn deleted', async () => {
  const { store, channel } = await setup();
  const lesson = lessonOf();
  let now = T0;
  await channel.exchange({ lesson, who: who('P-1'), on: ON, now, send: [{ part: 'board', input: stroke('a', 0, [[1, 1]], { done: true }) }, { part: 'board', input: stroke('b', 0, [[2, 2]], { done: true }) }, { part: 'chat', input: { op: 'm1', text: 'see you' } }, { part: 'turn', action: 'claim' }] });
  await channel.exchange({ lesson, who: who('P-2'), on: ON, now: now += 1000, send: [{ part: 'board', input: { kind: 'clear', op: 'c1' } }, { part: 'board', input: stroke('c', 0, [[3, 3]], { done: true }) }] });
  assert.equal((await store.stats(now)).lines, 3);                       // two held for an undo, one standing
  // The iHear teacher ended the lesson at T0 + 20 minutes; the next request comes 50 minutes after that.
  const endedAt = T0 + 20 * MIN;
  now = endedAt + 50 * MIN;
  const over = lessonOf({ endedAt });
  const after = await channel.exchange({ lesson: over, who: who('P-2'), on: ON, now, cursors: { board: 0, chat: 0, turn: 0 }, send: [{ part: 'board', input: stroke('d', 0, [[4, 4]]) }, { part: 'chat', input: { op: 'm2', text: 'late' } }, { part: 'turn', action: 'claim' }] });
  assert.deepEqual(after.sent, [{ ok: false, error: 'LESSON_ENDED' }, { ok: false, error: 'LESSON_ENDED' }, { ok: false, error: 'LESSON_ENDED' }]);
  assert.equal(after.board.ended, true);
  assert.deepEqual(after.chat, { ok: true, seq: 0, ended: true, missed: false, messages: [], more: false });
  assert.deepEqual([after.turn.holder, after.turn.ended], [null, true]);
  const held = await store.stats(now);
  assert.deepEqual(held.parts, { board: 1, chat: 0, turn: 0 });
  assert.equal(held.lines, 1, 'what the clear took is given up at the end: it can no longer be brought back');
  const row = await store.withPart('L-1', 'board', tx => tx.read());
  assert.equal(row.state.endedAt, endedAt);
  assert.equal(row.deleteAfter, endedAt + 24 * HOUR, 'the 24 hours run from the lesson\'s end, not from the moment somebody noticed');
  // The board can still be looked at by the people of that lesson until then, and not after.
  const look = await channel.exchange({ lesson: over, who: who('P-1'), on: ON, now: endedAt + 24 * HOUR - 1, cursors: { board: 99 } });
  assert.deepEqual(look.board.picture.lines.map(line => line.line), ['P-2:c']);
  assert.equal(look.board.picture.undo, null);
  const gone = await channel.exchange({ lesson: over, who: who('P-1'), on: ON, now: endedAt + 24 * HOUR, cursors: { board: 99 } });
  assert.deepEqual(gone.board.picture, { seq: 0, ended: true, lines: [], undo: null });
  assert.deepEqual((await store.stats(endedAt + 24 * HOUR)).parts, { board: 0, chat: 0, turn: 0 });
  assert.equal((await store.stats(endedAt + 24 * HOUR)).lines, 0);
});

test('SV-5: every part carries the moment it must be gone, from the planned end and from its last accepted change', async () => {
  // The rule itself.
  assert.equal(deleteAfter('board', { endedAt: null, lastAt: T0, scheduledEnd: T0 + 3 * HOUR }), T0 + 27 * HOUR);
  assert.equal(deleteAfter('board', { endedAt: null, lastAt: T0, scheduledEnd: undefined }), T0 + 48 * HOUR);
  assert.equal(deleteAfter('board', { endedAt: null, lastAt: T0, scheduledEnd: T0 + 100 * HOUR }), T0 + 48 * HOUR);
  assert.equal(deleteAfter('board', { endedAt: T0 + HOUR, lastAt: T0, scheduledEnd: T0 + 3 * HOUR }), T0 + 25 * HOUR);
  assert.equal(deleteAfter('chat', { endedAt: null, lastAt: T0, scheduledEnd: T0 + 3 * HOUR }), T0 + 3 * HOUR);
  assert.equal(deleteAfter('chat', { endedAt: null, lastAt: T0, scheduledEnd: undefined }), T0 + 6 * HOUR);
  assert.equal(deleteAfter('chat', { endedAt: null, lastAt: T0, scheduledEnd: T0 + 10 * HOUR }), T0 + 6 * HOUR);
  assert.equal(deleteAfter('chat', { endedAt: T0 + HOUR, lastAt: T0, scheduledEnd: T0 + 3 * HOUR }), T0 + HOUR);
  assert.equal(deleteAfter('turn', { endedAt: null, lastAt: T0, scheduledEnd: T0 + 10 * HOUR }), T0 + 6 * HOUR);
  assert.deepEqual([RETENTION.boardAfterEndMs, RETENTION.boardIdleMs, RETENTION.chatIdleMs, RETENTION.undoMs], [24 * HOUR, 48 * HOUR, 6 * HOUR, 10 * MIN]);
  // The lesson's end, from its facts: a recorded end, else the planned end once it has passed.
  assert.equal(lessonEnd({ recordedEnd: null, scheduledEnd: T0 + HOUR, now: T0 }), null);
  assert.equal(lessonEnd({ recordedEnd: null, scheduledEnd: T0 + HOUR, now: T0 + HOUR }), T0 + HOUR);
  assert.equal(lessonEnd({ recordedEnd: T0 + 10 * MIN, scheduledEnd: T0 + HOUR, now: T0 + 2 * HOUR }), T0 + 10 * MIN);
  assert.equal(lessonEnd({ recordedEnd: T0 + 2 * HOUR, scheduledEnd: T0 + HOUR, now: T0 + 3 * HOUR }), T0 + HOUR, 'never later than the planned end');

  // In the store: set at every accepted change; a refused request and a read change nothing.
  const { store, channel } = await setup();
  const lesson = lessonOf();
  const row = part => store.withPart('L-1', part, tx => tx.read());
  await channel.exchange({ lesson, who: who('P-1'), on: ON, now: T0, send: [{ part: 'board', input: stroke('a', 0, [[1, 1]]) }, { part: 'chat', input: { op: 'm1', text: 'hi' } }, { part: 'turn', action: 'claim' }] });
  assert.deepEqual([(await row('board')).deleteAfter, (await row('chat')).deleteAfter, (await row('turn')).deleteAfter], [T0 + 27 * HOUR, T0 + 3 * HOUR, T0 + 3 * HOUR]);
  // A lesson whose planned end is not known (or far away): the net under it is the last accepted change.
  const loose = lessonOf({ id: 'L-2', scheduledEnd: undefined });
  const rowOf = (id, part) => store.withPart(id, part, tx => tx.read());
  await channel.exchange({ lesson: loose, who: who('P-1'), on: ON, now: T0, send: [{ part: 'board', input: stroke('a', 0, [[1, 1]]) }, { part: 'chat', input: { op: 'm1', text: 'hi' } }] });
  assert.deepEqual([(await rowOf('L-2', 'board')).deleteAfter, (await rowOf('L-2', 'chat')).deleteAfter], [T0 + 48 * HOUR, T0 + 6 * HOUR]);
  await channel.exchange({ lesson: loose, who: who('P-2'), on: ON, now: T0 + HOUR, cursors: { board: 0, chat: 0 }, send: [{ part: 'board', input: stroke('zz', 5, [[1, 1]]) }, { part: 'chat', input: { op: 'm9', text: '' } }] });
  assert.deepEqual([(await rowOf('L-2', 'board')).deleteAfter, (await rowOf('L-2', 'chat')).deleteAfter], [T0 + 48 * HOUR, T0 + 6 * HOUR], 'reading, and a request that was refused, are not activity');
  await channel.exchange({ lesson: loose, who: who('P-2'), on: ON, now: T0 + HOUR, send: [{ part: 'board', input: stroke('b', 0, [[1, 1]]) }, { part: 'chat', input: { op: 'm2', text: 'yo' } }] });
  assert.deepEqual([(await rowOf('L-2', 'board')).deleteAfter, (await rowOf('L-2', 'chat')).deleteAfter], [T0 + 49 * HOUR, T0 + 7 * HOUR]);
});

test('SV-6: what is past its time is deleted before it is read, and a part written again starts afresh', async () => {
  const { store, channel } = await setup();
  const loose = lessonOf({ scheduledEnd: undefined });
  await channel.exchange({ lesson: loose, who: who('P-1'), on: ON, now: T0, send: [{ part: 'board', input: stroke('a', 0, [[1, 1]]) }, { part: 'chat', input: { op: 'm1', text: 'old words' } }, { part: 'chat', input: { op: 'm2', text: 'more' } }] });
  // Six hours with no message: the chat is gone for a reader, and from the store. The board is not (48 hours).
  const later = await channel.exchange({ lesson: loose, who: who('P-2'), on: ON, now: T0 + 6 * HOUR, cursors: { board: 0, chat: 0 } });
  assert.deepEqual(later.chat, { ok: true, seq: 0, ended: false, missed: false, messages: [], more: false });
  assert.equal(later.board.entries.length, 1);
  assert.deepEqual((await store.stats(T0 + 6 * HOUR)).parts, { board: 1, chat: 0, turn: 0 });
  // A message after that begins a new chat: its count starts again, and a page that had reached 2 is handed the new one.
  const anew = await channel.exchange({ lesson: loose, who: who('P-1'), on: ON, now: T0 + 6 * HOUR + 1, cursors: { chat: 2 }, send: [{ part: 'chat', input: { op: 'm1', text: 'new words' } }] });
  assert.deepEqual([anew.sent[0].seq, anew.chat.messages.map(message => message.text)], [1, ['new words']]);
  // 48 hours after the last stroke: a stroke then starts a new board, and the old line is not in it.
  const at = T0 + 48 * HOUR;
  const begun = await channel.exchange({ lesson: loose, who: who('P-2'), on: ON, now: at, cursors: { board: 1 }, send: [{ part: 'board', input: stroke('a', 1, [[2, 2]]) }, { part: 'board', input: stroke('n', 0, [[3, 3]]) }] });
  assert.deepEqual(begun.sent.map(answer => answer.ok ? answer.seq : answer.error), ['LINE_GONE', 1]);
  const fresh = await channel.exchange({ lesson: loose, who: who('P-1'), on: ON, now: at + 1, cursors: { board: 7 } });
  assert.deepEqual(fresh.board.picture.lines.map(line => line.line), ['P-2:n']);
  assert.equal((await store.stats(at + 1)).lines, 1);
});

test('SV-7: the sweep deletes what is due, settles old clears, and closes lessons that are over', async () => {
  const { store, channel } = await setup();
  const begin = async (id, more = {}) => {
    const lesson = lessonOf({ id, ...more });
    await channel.exchange({ lesson, who: who('P-1'), on: ON, now: T0, send: [{ part: 'board', input: stroke('a', 0, [[1, 1]], { done: true }) }, { part: 'chat', input: { op: 'm1', text: 'hi' } }, { part: 'turn', action: 'claim' }] });
    return lesson;
  };
  await begin('L-early');                                    // ended early by the iHear teacher, nobody came back
  await begin('L-running');                                  // still running
  await begin('L-gone');                                     // its record no longer exists
  await begin('L-unread');                                   // the lesson cannot be read just now
  await begin('L-short', { scheduledEnd: T0 + 30 * MIN });   // its planned end passes, nobody comes back
  // A clear on the running lesson, never undone.
  await channel.exchange({ lesson: lessonOf({ id: 'L-running' }), who: who('P-2'), on: ON, now: T0 + MIN, send: [{ part: 'board', input: { kind: 'clear', op: 'c1' } }] });
  const facts = async id => {
    if (id === 'L-early') return { endedAt: T0 + 20 * MIN, scheduledEnd: T0 + 3 * HOUR };
    if (id === 'L-gone') return { gone: true };
    if (id === 'L-unread') throw new Error('the lessons cannot be read');
    return { endedAt: null, scheduledEnd: id === 'L-short' ? T0 + 30 * MIN : T0 + 3 * HOUR };
  };
  const now = T0 + 40 * MIN;
  const first = await channel.sweep({ now, lessonFacts: facts });
  // L-short: its chat and turn were due at its planned end (deleted as due). L-early and L-gone: closed.
  assert.deepEqual({ deleted: first.deleted, clearsSettled: first.clearsSettled, lessonsClosed: first.lessonsClosed, lessonsNotRead: first.lessonsNotRead }, { deleted: 2, clearsSettled: 1, lessonsClosed: 2, lessonsNotRead: 1 });
  assert.equal(first.held.overdue, 0);
  const parts = async id => Object.fromEntries(await Promise.all(['board', 'chat', 'turn'].map(async part => [part, Boolean(await store.withPart(id, part, tx => tx.read()))])));
  assert.deepEqual(await parts('L-early'), { board: true, chat: false, turn: false });
  assert.deepEqual(await parts('L-gone'), { board: true, chat: false, turn: false });
  assert.deepEqual(await parts('L-short'), { board: true, chat: false, turn: false });
  assert.deepEqual(await parts('L-running'), { board: true, chat: true, turn: true });
  assert.deepEqual(await parts('L-unread'), { board: true, chat: true, turn: true }, 'a lesson that cannot be read is left as it is');
  const board = async id => (await store.withPart(id, 'board', tx => tx.read()));
  assert.equal((await board('L-early')).deleteAfter, T0 + 20 * MIN + 24 * HOUR);
  assert.equal((await board('L-gone')).deleteAfter, now + 24 * HOUR);
  assert.equal((await board('L-short')).deleteAfter, T0 + 30 * MIN + 24 * HOUR);
  // The old clear's lines are gone from the running lesson's store (the line it took), and its header says so.
  assert.equal((await board('L-running')).state.clear, null);
  assert.deepEqual((await board('L-running')).state.held, { lines: 0, points: 0 });
  assert.equal(first.held.lines, 4, 'five boards began with one line each; the cleared one was given up');
  // A second run at once finds nothing to do. A day later the three ended boards are due; the others go by their own rules.
  const second = await channel.sweep({ now: now + 1, lessonFacts: facts });
  assert.deepEqual({ deleted: second.deleted, clearsSettled: second.clearsSettled, lessonsClosed: second.lessonsClosed }, { deleted: 0, clearsSettled: 0, lessonsClosed: 0 });
  const nextDay = await channel.sweep({ now: now + 24 * HOUR, lessonFacts: facts });
  assert.equal(nextDay.held.overdue, 0);
  assert.deepEqual(nextDay.held.parts, { board: 2, chat: 0, turn: 0 }, 'L-running and L-unread keep their boards until planned end + 24 hours');
  const last = await channel.sweep({ now: T0 + 27 * HOUR, lessonFacts: facts });
  assert.deepEqual(last.held.parts, { board: 0, chat: 0, turn: 0 });
  assert.deepEqual([last.held.lines, last.held.operations], [0, 0]);
});

test('SV-8: a clear can be brought back for ten minutes, by the latest clear only, and never after the end', async () => {
  const { store, channel } = await setup();
  const lesson = lessonOf();
  const send = (id, input, now) => channel.exchange({ lesson, who: who(id), on: ON, now, send: [{ part: 'board', input }] }).then(answer => answer.sent[0]);
  await send('P-1', stroke('a', 0, [[1, 1], [2, 2]], { done: true }), T0);
  await send('P-2', stroke('b', 0, [[3, 3]], { done: true }), T0 + 100);
  const clear = await send('P-3', { kind: 'clear', op: 'c1' }, T0 + 1000);
  assert.equal(clear.entry.undoUntil, T0 + 1000 + 10 * MIN);
  await send('P-1', stroke('c', 0, [[4, 4]], { done: true }), T0 + 2000);
  // Anyone in the room may bring it back, at the last moment too; what was drawn since stays.
  const undo = await send('P-2', { kind: 'undo', op: 'u1', clear: clear.seq }, T0 + 1000 + 10 * MIN);
  assert.deepEqual([undo.ok, undo.entry.lines], [true, 2]);
  const picture = (await channel.exchange({ lesson, who: who('P-4'), on: ON, now: T0 + 1000 + 10 * MIN, cursors: { board: 99 } })).board.picture;
  assert.deepEqual(picture.lines.map(line => line.line), ['P-1:a', 'P-2:b', 'P-1:c']);
  assert.equal(picture.undo, null);
  // The same clear cannot be brought back twice.
  assert.equal((await send('P-2', { kind: 'undo', op: 'u2', clear: clear.seq }, T0 + 1000 + 10 * MIN + 1)).error, 'NOTHING_TO_UNDO');
  // A second clear, not undone in time: after ten minutes it cannot be, and the next request drops what it took.
  const second = await send('P-3', { kind: 'clear', op: 'c2' }, T0 + 20 * MIN);
  assert.equal((await store.stats(T0 + 20 * MIN)).lines, 3);
  assert.equal((await send('P-1', { kind: 'undo', op: 'u3', clear: second.seq }, T0 + 30 * MIN + 1)).error, 'NOTHING_TO_UNDO');
  await send('P-1', stroke('d', 0, [[5, 5]], { done: true }), T0 + 30 * MIN + 2);
  assert.equal((await store.stats(T0 + 31 * MIN)).lines, 1, 'the three lines the clear took are deleted from the store');
  // Of two clears, only the latest can be undone: the earlier one's lines go when the later one is made.
  const third = await send('P-3', { kind: 'clear', op: 'c3' }, T0 + 40 * MIN);
  await send('P-1', stroke('e', 0, [[6, 6]], { done: true }), T0 + 40 * MIN + 100);
  const fourth = await send('P-2', { kind: 'clear', op: 'c4' }, T0 + 41 * MIN);
  assert.equal((await send('P-1', { kind: 'undo', op: 'u4', clear: third.seq }, T0 + 41 * MIN + 1)).error, 'NOTHING_TO_UNDO');
  assert.equal((await store.stats(T0 + 42 * MIN)).lines, 1);
  // The lesson ends two minutes after the fourth clear: it can no longer be undone, and its line is deleted.
  const over = lessonOf({ endedAt: T0 + 43 * MIN });
  const late = await channel.exchange({ lesson: over, who: who('P-2'), on: ON, now: T0 + 44 * MIN, cursors: { board: 0 }, send: [{ part: 'board', input: { kind: 'undo', op: 'u5', clear: fourth.seq } }] });
  assert.deepEqual(late.sent, [{ ok: false, error: 'LESSON_ENDED' }]);
  assert.equal((await store.stats(T0 + 44 * MIN)).lines, 0);
  assert.equal(BOARD_LIMITS.undoWindowMs, RETENTION.undoMs);
});

test('SV-9: the share turn through the service: one holder, freed when the holder is out of the lesson, handed only to someone in it', async () => {
  const { channel } = await setup();
  const lesson = lessonOf();
  const turn = (id, action, now, more = {}, people = PEOPLE) => channel.exchange({ lesson: lessonOf({ people }), who: who(id), on: ON, now, cursors: { turn: 0 }, send: action ? [{ part: 'turn', action, ...more }] : [] });
  assert.equal((await turn('P-1', 'claim', T0)).turn.holder, 'P-1');
  const busy = await turn('P-2', 'claim', T0 + 1000);
  assert.deepEqual([busy.sent[0].error, busy.sent[0].holder, busy.turn.holder], ['BUSY', 'P-1', 'P-1']);
  // P-1 is taken out of the lesson: on the next request of anyone the turn is free, without waiting for the lease.
  const without = PEOPLE.filter(id => id !== 'P-1');
  const freed = await turn('P-3', null, T0 + 2000, {}, without);
  assert.equal(freed.turn.holder, null);
  assert.ok(T0 + 2000 < T0 + TURN_LIMITS.leaseMs);
  assert.equal((await turn('P-2', 'claim', T0 + 2100, {}, without)).turn.holder, 'P-2');
  // Handing over: only to someone in the lesson now; then it waits for that person alone.
  assert.equal((await turn('P-2', 'handOver', T0 + 3000, { to: 'P-1' }, without)).sent[0].error, 'NO_SUCH_PERSON');
  assert.equal((await turn('P-2', 'handOver', T0 + 3000, { to: 'P-9' }, without)).sent[0].error, 'NO_SUCH_PERSON');
  const handed = await turn('P-2', 'handOver', T0 + 3100, { to: 'P-4' }, without);
  assert.deepEqual([handed.turn.holder, handed.turn.offeredTo], [null, 'P-4']);
  assert.equal((await turn('P-5', 'claim', T0 + 3200, {}, without)).sent[0].error, 'OFFERED_TO_ANOTHER');
  // The person it was handed to leaves before taking it: the offer is over at once.
  const afterLeaving = await turn('P-5', 'claim', T0 + 3300, {}, without.filter(id => id !== 'P-4'));
  assert.equal(afterLeaving.sent[0].error, 'OFFERED_TO_ANOTHER', 'the claim came first; the look after it frees the offer');
  assert.equal(afterLeaving.turn.offeredTo, null);
  assert.equal((await turn('P-5', 'claim', T0 + 3400, {}, without.filter(id => id !== 'P-4'))).turn.holder, 'P-5');
  // A dropped connection: no "still sharing" for the lease's length, and the turn is free.
  assert.equal((await turn('P-6', null, T0 + 3400 + TURN_LIMITS.leaseMs, {}, without)).turn.holder, null);
  assert.equal(lesson.people.length, 6);
});

test('SV-10: many people at the same moment: every request takes its own place, none is lost', async () => {
  const { store, channel } = await setup();
  const lesson = lessonOf();
  const jobs = [];
  for (let round = 0; round < 40; round += 1) for (const id of PEOPLE) jobs.push(channel.exchange({ lesson, who: who(id), on: ON, now: T0 + round * 200, send: [{ part: 'board', input: stroke(`r${round}`, 0, [[round, round]], { done: true }) }, { part: 'chat', input: { op: `m${round}`, text: `${id} ${round}` } }] }));
  const answers = await Promise.all(jobs);
  const boardSeqs = answers.map(answer => answer.sent[0].seq).sort((a, b) => a - b);
  assert.deepEqual(boardSeqs, Array.from({ length: 240 }, (_, index) => index + 1));
  const said = answers.map(answer => answer.sent[1]).filter(answer => answer.ok).map(answer => answer.seq).sort((a, b) => a - b);
  assert.deepEqual(said, Array.from({ length: said.length }, (_, index) => index + 1));
  assert.ok(said.length >= 6 * CHAT_LIMITS.perSender, `${said.length} messages were taken`);
  const row = await store.withPart('L-1', 'board', tx => tx.read());
  assert.deepEqual([row.state.seq, row.state.shown], [240, { lines: 240, points: 240 }]);
  assert.equal((await store.stats(T0)).lines, 240);
});

test('SV-11: a change that fails half-way leaves nothing behind', async () => {
  const { store, channel } = await setup();
  const lesson = lessonOf();
  await channel.exchange({ lesson, who: who('P-1'), on: ON, now: T0, send: [{ part: 'board', input: stroke('a', 0, [[1, 1]]) }] });
  await assert.rejects(store.withPart('L-1', 'board', async tx => {
    const row = await tx.read();
    tx.effects([{ type: 'remove', key: 'P-1:a' }]);
    tx.write({ ...row.state, seq: 99 }, row.deleteAfter);
    throw new Error('the connection dropped');
  }), /dropped/);
  const row = await store.withPart('L-1', 'board', tx => tx.read());
  assert.equal(row.state.seq, 1);
  assert.equal((await store.stats(T0)).lines, 1);
  // And the store goes on taking requests for that lesson after the failure.
  assert.equal((await channel.exchange({ lesson, who: who('P-1'), on: ON, now: T0 + 500, send: [{ part: 'board', input: stroke('a', 1, [[2, 2]]) }] })).sent[0].seq, 2);
});

test('SV-12: a little behind: what was missed; far behind: the picture, never a long list', async () => {
  const { channel } = await setup();
  const lesson = lessonOf();
  const total = BOARD_LIMITS.catchUpEntries + 20;
  let now = T0;
  for (let n = 0; n < total; n += 8) {
    now += 2000;
    const send = Array.from({ length: Math.min(8, total - n) }, (_unused, index) => ({ part: 'board', input: stroke(`far${n + index}`, 0, [[n + index, 1]], { done: true }) }));
    const answer = await channel.exchange({ lesson, who: who(PEOPLE[(n / 8) % 6]), on: ON, now, send });
    assert.ok(answer.sent.every(item => item.ok), JSON.stringify(answer.sent.find(item => !item.ok)));
  }
  const near = (await channel.exchange({ lesson, who: who('P-1'), on: ON, now, cursors: { board: total - BOARD_LIMITS.catchUpEntries } })).board;
  assert.deepEqual([near.fresh, near.entries.length, near.entries[0].seq, near.seq], [false, BOARD_LIMITS.catchUpEntries, total - BOARD_LIMITS.catchUpEntries + 1, total]);
  const far = (await channel.exchange({ lesson, who: who('P-1'), on: ON, now, cursors: { board: total - BOARD_LIMITS.catchUpEntries - 1 } })).board;
  assert.deepEqual([far.fresh, far.picture.seq, far.picture.lines.length], [true, total, total]);
  const first = (await channel.exchange({ lesson, who: who('P-2'), on: ON, now, cursors: { board: 0 } })).board;
  assert.deepEqual([first.fresh, first.picture.lines.length], [true, total]);
});
}
