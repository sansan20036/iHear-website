// The room whiteboard's server logic (lib/room-channel/board.mjs): local tests only, no network.
//   node --test tests/room-channel/
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { apply, BOARD_LIMITS, end, expired, invalidRequest, moveOn, newBoard, pictureFrom, shown, since, snapshot } from '../../lib/room-channel/board.mjs';

const T0 = 1_800_000_000_000;
const fresh = () => newBoard({ roomId: 'FR-1', lessonId: 'L-1', now: T0 });
let counter = 0;
const opName = () => `o${(counter += 1)}`;
const stroke = (line, part, points, more = {}) => ({ kind: 'stroke', op: opName(), line, part, points, color: 0, width: 2, done: false, ...more });
// Applies requests one after another, each a little later; fails the test if one is refused unless told to expect it.
function run(state, steps, start = T0) {
  let now = start;
  const answers = [];
  for (const [by, input, expectError] of steps) {
    now += 250;
    const out = apply(state, { by, member: true, input, now });
    if (expectError) assert.equal(out.answer.error, expectError, `${input.kind} should be refused with ${expectError}`);
    else assert.equal(out.answer.ok, true, `${input.kind} refused: ${out.answer.error}`);
    state = out.state;
    answers.push(out.answer);
  }
  return { state, answers, now };
}
const visibleLines = (state, now) => snapshot(state, now).lines.map(line => line.line);

test('RB-1: only a person in the room, and only while the lesson runs', () => {
  const state = fresh();
  const input = stroke('a', 0, [[1, 1]]);
  assert.equal(apply(state, { by: 'P-1', member: false, input, now: T0 }).answer.error, 'NOT_IN_ROOM');
  assert.equal(apply(state, { by: null, member: true, input, now: T0 }).answer.error, 'NOT_IN_ROOM');
  assert.equal(apply(state, { by: 'bad name!', member: true, input, now: T0 }).answer.error, 'NOT_IN_ROOM');
  const ended = end(state, T0 + 1000);
  assert.equal(apply(ended, { by: 'P-1', member: true, input, now: T0 + 2000 }).answer.error, 'LESSON_ENDED');
  assert.equal(since(state, { by: 'P-1', member: false, cursor: 0, now: T0 }).error, 'NOT_IN_ROOM');
});

test('RB-2: the shape of a request is checked strictly, and a client has no clock to give', () => {
  const good = stroke('a', 0, [[0, 0], [10_000, 10_000]]);
  assert.equal(invalidRequest(good), null);
  assert.equal(invalidRequest({ ...good, lamport: 2 ** 31 - 1 }), 'FIELDS');           // no client time is taken at all
  assert.equal(invalidRequest({ ...good, by: 'P-9' }), 'FIELDS');                      // nor a sender
  assert.equal(invalidRequest({ ...good, points: [[10_001, 0]] }), 'POINTS');
  assert.equal(invalidRequest({ ...good, points: [[1.5, 0]] }), 'POINTS');
  assert.equal(invalidRequest({ ...good, points: [] }), 'POINTS');
  assert.equal(invalidRequest({ ...good, points: Array.from({ length: BOARD_LIMITS.pointsPerPart + 1 }, () => [1, 1]) }), 'POINTS');
  assert.equal(invalidRequest({ ...good, color: 8 }), 'COLOR');
  assert.equal(invalidRequest({ ...good, width: 3 }), 'WIDTH');
  assert.equal(invalidRequest({ ...good, done: 'yes' }), 'DONE');
  assert.equal(invalidRequest({ ...good, line: 'has space' }), 'LINE');
  assert.equal(invalidRequest({ ...good, part: BOARD_LIMITS.partsPerLine }), 'PART');
  assert.equal(invalidRequest({ ...good, op: '' }), 'OP_NAME');
  assert.equal(invalidRequest({ kind: 'erase', op: 'x', line: 'no-maker' }), 'LINE');
  assert.equal(invalidRequest({ kind: 'undo', op: 'x', clear: 0 }), 'CLEAR');
  assert.equal(invalidRequest({ kind: 'wipe', op: 'x' }), 'UNKNOWN_KIND');
  assert.equal(invalidRequest([good]), 'NOT_AN_OBJECT');
  assert.equal(invalidRequest(null), 'NOT_AN_OBJECT');
});

test('RB-3: a line is its maker\'s: the server puts the maker in front of its name', () => {
  const { state } = run(fresh(), [
    ['P-1', stroke('a', 0, [[1, 1]])],
    ['P-2', stroke('a', 0, [[9, 9]])],            // the same name from another person is another line
    ['P-2', stroke('a', 1, [[8, 8]], { done: true })],
  ]);
  const lines = snapshot(state, T0 + 5000).lines;
  assert.deepEqual(lines.map(line => [line.line, line.by, line.points.length]), [['P-1:a', 'P-1', 1], ['P-2:a', 'P-2', 2]]);
  // Nobody can add to another person's line: there is no way to name it in a stroke.
  assert.equal(invalidRequest(stroke('P-1:a', 1, [[5, 5]])), 'LINE');
});

test('RB-4: the server\'s order is the order; a page that follows it shows what the server holds', () => {
  const { state } = run(fresh(), [
    ['P-1', stroke('a', 0, [[1, 1], [2, 2]])],
    ['P-2', stroke('b', 0, [[5, 5]], { color: 3, width: 4 })],
    ['P-1', stroke('a', 1, [[3, 3]], { done: true, color: 7, width: 8 })],   // a later part cannot change the line's colour
    ['P-3', { kind: 'erase', op: opName(), line: 'P-2:b' }],
  ]);
  const page = pictureFrom(snapshot(fresh(), T0));
  const entries = since(state, { by: 'P-3', member: true, cursor: 0, now: T0 + 9000 }).entries;
  for (const entry of entries) moveOn(page, entry);
  for (const entry of entries) moveOn(page, entry);          // handed the same entries again: nothing is drawn twice
  assert.deepEqual(shown(page), snapshot(state, T0 + 9000).lines.map(({ parts, ...line }) => line));
  assert.deepEqual(shown(page), [{ line: 'P-1:a', by: 'P-1', color: 0, width: 2, points: [[1, 1], [2, 2], [3, 3]], done: true }]);
  assert.deepEqual(state.recent.map(entry => entry.seq), [1, 2, 3, 4]);
});

test('RB-5: the same request twice counts once', () => {
  const first = stroke('a', 0, [[1, 1]]);
  const one = apply(fresh(), { by: 'P-1', member: true, input: first, now: T0 + 100 });
  const again = apply(one.state, { by: 'P-1', member: true, input: first, now: T0 + 200 });
  assert.deepEqual(again.answer, { ok: true, seq: 1, duplicate: true });
  assert.equal(again.state, one.state);
  assert.equal(snapshot(again.state, T0 + 300).lines[0].points.length, 1);
  // Another person using the same name for their own request is not a repeat.
  assert.equal(apply(one.state, { by: 'P-2', member: true, input: { ...first }, now: T0 + 300 }).answer.duplicate, undefined);
});

test('RB-6: parts come in order; a part of a line that is gone or finished is refused', () => {
  const { state } = run(fresh(), [
    ['P-1', stroke('a', 0, [[1, 1]])],
    ['P-1', stroke('a', 2, [[3, 3]]), 'OUT_OF_ORDER'],
    ['P-1', stroke('a', 0, [[1, 1]]), 'OUT_OF_ORDER'],
    ['P-1', stroke('b', 1, [[1, 1]]), 'LINE_GONE'],          // never begun
    ['P-2', { kind: 'erase', op: opName(), line: 'P-1:a' }],
    ['P-1', stroke('a', 1, [[2, 2]]), 'LINE_GONE'],          // erased while its maker was still drawing
    ['P-1', stroke('c', 0, [[1, 1]], { done: true })],
    ['P-1', stroke('c', 1, [[2, 2]]), 'LINE_DONE'],
    ['P-2', { kind: 'erase', op: opName(), line: 'P-1:zzz' }, 'NO_SUCH_LINE'],
  ]);
  assert.deepEqual(visibleLines(state, T0 + 9000), ['P-1:c']);
});

test('RB-7: clear takes what was drawn before it and leaves what comes after; undo brings it back', () => {
  let { state, answers, now } = run(fresh(), [
    ['P-1', stroke('a', 0, [[1, 1]])],
    ['P-2', stroke('b', 0, [[2, 2]], { done: true })],
    ['P-3', { kind: 'clear', op: opName() }],
    ['P-1', stroke('a', 1, [[3, 3]], { done: true })],       // the rest of a line the clear took stays with it
    ['P-2', stroke('d', 0, [[4, 4]], { done: true })],
  ]);
  const clearSeq = answers[2].seq;
  assert.deepEqual(visibleLines(state, now), ['P-2:d']);
  assert.equal(snapshot(state, now).undo.clear, clearSeq);
  assert.deepEqual(snapshot(state, now).undo.lines.map(line => [line.line, line.points.length]), [['P-1:a', 2], ['P-2:b', 1]]);
  // A line the clear took cannot be erased: it is not on the board.
  assert.equal(apply(state, { by: 'P-2', member: true, input: { kind: 'erase', op: opName(), line: 'P-1:a' }, now: now + 10 }).answer.error, 'NO_SUCH_LINE');
  ({ state, now } = run(state, [['P-2', { kind: 'undo', op: opName(), clear: clearSeq }]], now));
  assert.deepEqual(visibleLines(state, now), ['P-1:a', 'P-2:b', 'P-2:d']);                // in the order they were begun
  assert.equal(snapshot(state, now).undo, null);
  assert.equal(apply(state, { by: 'P-1', member: true, input: { kind: 'undo', op: opName(), clear: clearSeq }, now: now + 10 }).answer.error, 'NOTHING_TO_UNDO');
});

test('RB-8: only the latest clear can be undone, and only for a while', () => {
  let { state, answers, now } = run(fresh(), [
    ['P-1', stroke('a', 0, [[1, 1]], { done: true })],
    ['P-1', { kind: 'clear', op: opName() }],
    ['P-1', stroke('b', 0, [[2, 2]], { done: true })],
  ]);
  const first = answers[1].seq;
  now += BOARD_LIMITS.clearWindowMs;
  let out = apply(state, { by: 'P-2', member: true, input: { kind: 'clear', op: opName() }, now });
  assert.equal(out.answer.ok, true);
  state = out.state;
  // What the first clear took is gone for good once there is a second.
  assert.equal(apply(state, { by: 'P-1', member: true, input: { kind: 'undo', op: opName(), clear: first }, now: now + 10 }).answer.error, 'NOTHING_TO_UNDO');
  assert.deepEqual(Object.keys(state.lines), ['P-1:b']);
  const second = out.answer.seq;
  const late = now + BOARD_LIMITS.undoWindowMs + 1;
  assert.equal(apply(state, { by: 'P-1', member: true, input: { kind: 'undo', op: opName(), clear: second }, now: late }).answer.error, 'NOTHING_TO_UNDO');
  // Past the time, the next request of any kind drops what the clear held.
  out = apply(state, { by: 'P-1', member: true, input: stroke('c', 0, [[3, 3]]), now: late });
  assert.deepEqual(Object.keys(out.state.lines), ['P-1:c']);
  assert.equal(out.state.points, 1);
});

test('RB-9: clears cannot come in a burst, and nobody can clear "the future"', () => {
  const { state, now } = run(fresh(), [
    ['P-1', { kind: 'clear', op: opName() }],
    ['P-2', { kind: 'clear', op: opName() }],
    ['P-3', { kind: 'clear', op: opName() }, 'CLEAR_TOO_OFTEN'],
  ]);
  // A line drawn after the clears stands: a clear only ever takes what the server had before it.
  const out = apply(state, { by: 'P-1', member: true, input: stroke('after', 0, [[1, 1]]), now: now + 10 });
  assert.deepEqual(visibleLines(out.state, now + 20), ['P-1:after']);
  const later = apply(out.state, { by: 'P-3', member: true, input: { kind: 'clear', op: opName() }, now: now + BOARD_LIMITS.clearWindowMs });
  assert.equal(later.answer.ok, true);
});

test('RB-10: one person cannot flood the room, and the board has a size it cannot pass', () => {
  let state = fresh();
  let refusedAt = null;
  for (let n = 0; n < BOARD_LIMITS.perSender + 5 && refusedAt === null; n += 1) {
    const out = apply(state, { by: 'P-1', member: true, input: stroke(`f${n}`, 0, [[1, 1]], { done: true }), now: T0 + n });
    if (!out.answer.ok) { refusedAt = n; assert.equal(out.answer.error, 'TOO_FAST'); assert.ok(out.answer.retryAfterMs > 0); }
    state = out.state;
  }
  assert.equal(refusedAt, BOARD_LIMITS.perSender);
  // Another person is not held back by the first one's flood.
  assert.equal(apply(state, { by: 'P-2', member: true, input: stroke('x', 0, [[1, 1]]), now: T0 + 100 }).answer.ok, true);
  // After the window the first person may draw again.
  assert.equal(apply(state, { by: 'P-1', member: true, input: stroke('y', 0, [[1, 1]]), now: T0 + BOARD_LIMITS.rateWindowMs + 100 }).answer.ok, true);

  // The cap on lines: many people, each within their own rate.
  let full = fresh();
  let made = 0, error = null;
  for (let n = 0; error === null && n < BOARD_LIMITS.liveLines + 10; n += 1) {
    const out = apply(full, { by: `P-${n % 500}`, member: true, input: stroke(`l${n}`, 0, [[1, 1]], { done: true }), now: T0 + n * 40 });
    if (out.answer.ok) made += 1; else error = out.answer.error;
    full = out.state;
  }
  assert.equal(error, 'BOARD_FULL');
  assert.equal(made, BOARD_LIMITS.liveLines);
});

test('RB-11: history does not grow without end; someone away too long is given the picture afresh', () => {
  let state = fresh();
  let now = T0;
  const people = ['P-1', 'P-2', 'P-3', 'P-4'];
  let largest = 0;
  for (let n = 0; n < 6_000; n += 1) {
    now += 400;
    const by = people[n % people.length];
    const input = n % 600 === 599 ? { kind: 'clear', op: opName() } : stroke(`h${n}`, 0, Array.from({ length: 40 }, (_, index) => [(n * 7 + index) % 10_000, (n * 13 + index) % 10_000]), { done: true });
    const out = apply(state, { by, member: true, input, now });
    assert.equal(out.answer.ok, true, out.answer.error);
    state = out.state;
    if (n % 150 === 149) largest = Math.max(largest, JSON.stringify(state).length);
  }
  assert.equal(state.seq, 6_000);
  assert.equal(state.recent.length, BOARD_LIMITS.recentKept);
  assert.equal(state.base, 6_000 - BOARD_LIMITS.recentKept);
  // At most the lines since the clear before last are held: about 1,200 lines of 40 points here.
  assert.ok(Object.keys(state.lines).length <= 1_200, `${Object.keys(state.lines).length} lines held`);
  assert.ok(largest < 3_000_000, `the state reached ${largest} bytes`);
  // A page that was away past what is kept gets the whole picture; one that was away a little gets the rest.
  const far = since(state, { by: 'P-1', member: true, cursor: 10, now });
  assert.equal(far.fresh, true);
  assert.equal(far.picture.seq, 6_000);
  const near = since(state, { by: 'P-1', member: true, cursor: 5_990, now });
  assert.equal(near.fresh, false);
  assert.deepEqual(near.entries.map(entry => entry.seq), [5_991, 5_992, 5_993, 5_994, 5_995, 5_996, 5_997, 5_998, 5_999, 6_000]);
  assert.equal(since(state, { by: 'P-1', member: true, cursor: 7_000, now }).fresh, true);      // a place the server never reached
  assert.equal(since(state, { by: 'P-1', member: true, cursor: -1, now }).error, 'CURSOR');
});

test('RB-12: kept for 24 hours after the lesson ends, then to be deleted', () => {
  const { state, now } = run(fresh(), [['P-1', stroke('a', 0, [[1, 1]], { done: true })]]);
  assert.equal(expired(state, now + BOARD_LIMITS.retentionAfterEndMs * 3 / 2), false);          // not ended: the idle rule, not the 24 hours
  assert.equal(expired(state, now + BOARD_LIMITS.idleMs), true);
  const ended = end(state, now + 1000);
  assert.equal(end(ended, now + 5000), ended);
  assert.equal(snapshot(ended, now + 2000).ended, true);
  assert.equal(snapshot(ended, now + 2000).lines.length, 1);                                    // still readable until it is deleted
  assert.equal(expired(ended, now + 1000 + BOARD_LIMITS.retentionAfterEndMs - 1), false);
  assert.equal(expired(ended, now + 1000 + BOARD_LIMITS.retentionAfterEndMs), true);
});

// A small seeded random, so a failing run can be repeated exactly.
function seeded(seed) {
  let value = seed >>> 0;
  return () => { value = (value + 0x6d2b79f5) >>> 0; let t = value; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

test('RB-13: six pages, random drawing, erasing, clearing and undoing, lost answers and dropped connections: everyone ends with the server\'s picture', () => {
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
    const random = seeded(seed);
    const pick = list => list[Math.floor(random() * list.length)];
    let state = fresh();
    let now = T0;
    const people = ['P-1', 'P-2', 'P-3', 'P-4', 'P-5', 'P-6'];
    const pages = new Map(people.map(by => [by, { picture: pictureFrom(snapshot(state, now)), online: true, drawing: null, n: 0 }]));
    const catchUp = by => {
      const page = pages.get(by);
      const answer = since(state, { by, member: true, cursor: page.picture.seq, now });
      if (answer.fresh) page.picture = pictureFrom(answer.picture);
      else for (const entry of answer.entries) moveOn(page.picture, entry);
    };
    for (let step = 0; step < 1_500; step += 1) {
      now += 300 + Math.floor(random() * 400);
      const by = pick(people), page = pages.get(by);
      const roll = random();
      if (roll < 0.04) { page.online = !page.online; if (page.online) catchUp(by); continue; }
      if (!page.online) continue;
      let input;
      if (roll < 0.70) {
        if (!page.drawing) { page.n += 1; page.drawing = { line: `s${page.n}`, part: 0 }; }
        const done = random() < 0.35;
        input = stroke(page.drawing.line, page.drawing.part, Array.from({ length: 1 + Math.floor(random() * 5) }, () => [Math.floor(random() * 10_001), Math.floor(random() * 10_001)]), { done, color: Math.floor(random() * 8) });
      } else if (roll < 0.86) {
        const lines = snapshot(state, now).lines;
        if (!lines.length) continue;
        input = { kind: 'erase', op: opName(), line: pick(lines).line };
      } else if (roll < 0.93) input = { kind: 'clear', op: opName() };
      else {
        if (!page.picture.undo) continue;
        input = { kind: 'undo', op: opName(), clear: page.picture.undo.clear };
      }
      const out = apply(state, { by, member: true, input, now });
      state = out.state;
      // A lost answer: the page sends the very same request again and must be told it counted once.
      if (out.answer.ok && random() < 0.15) {
        const again = apply(state, { by, member: true, input, now: now + 5 });
        assert.equal(again.answer.duplicate, true);
        assert.equal(again.answer.seq, out.answer.seq);
        state = again.state;
      }
      if (input.kind === 'stroke') {
        if (out.answer.ok) { page.drawing.part += 1; if (input.done) page.drawing = null; }
        else page.drawing = null;                             // refused (line gone, too fast, full): the page gives the line up
      }
      // Each page that is connected hears of it sooner or later; here, one in two at once.
      for (const other of people) if (pages.get(other).online && random() < 0.5) catchUp(other);
    }
    for (const by of people) { pages.get(by).online = true; catchUp(by); }
    const held = snapshot(state, now).lines.map(({ parts, ...line }) => line);
    for (const by of people) assert.deepEqual(shown(pages.get(by).picture), held, `seed ${seed}: ${by} does not show the server's picture`);
    assert.equal(Object.values(state.lines).reduce((sum, line) => sum + line.points.length, 0), state.points, `seed ${seed}: the count of points drifted`);
  }
});
