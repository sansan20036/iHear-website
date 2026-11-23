// Whose turn it is to share, server logic (lib/room-channel/share-turn.mjs): local tests only.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { beat, claim, handOver, leave, newTurn, release, showsShareOf, TURN_LIMITS, view } from '../../lib/room-channel/share-turn.mjs';

const T0 = 1_800_000_000_000;
const fresh = () => newTurn({ roomId: 'FR-1', lessonId: 'L-1', now: T0 });
const ask = (state, by, now) => claim(state, { by, member: true, now });
const still = (state, by, now) => beat(state, { by, member: true, now });

test('RS-1: one person at a time: the first to ask holds the turn, the second is told who has it', () => {
  const one = ask(fresh(), 'P-1', T0 + 100);
  assert.equal(one.answer.ok, true);
  assert.equal(one.answer.turn.holder, 'P-1');
  const two = ask(one.state, 'P-2', T0 + 200);
  assert.equal(two.answer.error, 'BUSY');
  assert.equal(two.answer.holder, 'P-1');
  assert.equal(view(two.state, T0 + 300).holder, 'P-1');
  // Asking again while holding is not a second turn; it keeps the first.
  const again = ask(two.state, 'P-1', T0 + 400);
  assert.equal(again.answer.ok, true);
  assert.equal(again.answer.turn.since, T0 + 100);
});

test('RS-2: only a person in the room', () => {
  assert.equal(claim(fresh(), { by: 'P-1', member: false, now: T0 }).answer.error, 'NOT_IN_ROOM');
  assert.equal(claim(fresh(), { by: 'not a name!', member: true, now: T0 }).answer.error, 'NOT_IN_ROOM');
  assert.equal(beat(fresh(), { by: 'P-1', member: false, now: T0 }).answer.error, 'NOT_IN_ROOM');
});

test('RS-3: "still sharing" keeps the turn; a holder who falls silent loses it (a dropped connection, a closed page)', () => {
  let { state } = ask(fresh(), 'P-1', T0);
  for (let n = 1; n <= 6; n += 1) {
    const out = still(state, 'P-1', T0 + n * TURN_LIMITS.beatEveryMs);
    assert.equal(out.answer.ok, true);
    state = out.state;
  }
  const lastBeat = T0 + 6 * TURN_LIMITS.beatEveryMs;
  assert.equal(view(state, lastBeat + TURN_LIMITS.leaseMs - 1).holder, 'P-1');
  assert.equal(view(state, lastBeat + TURN_LIMITS.leaseMs).holder, null);
  // The silent holder's page comes back: it is told it no longer holds the turn and must stop its share.
  const taken = ask(state, 'P-2', lastBeat + TURN_LIMITS.leaseMs + 10);
  assert.equal(taken.answer.turn.holder, 'P-2');
  const back = still(taken.state, 'P-1', lastBeat + TURN_LIMITS.leaseMs + 20);
  assert.equal(back.answer.error, 'NOT_HOLDER');
  assert.equal(back.answer.holder, 'P-2');
  // A beat from someone who never held it.
  assert.equal(still(fresh(), 'P-3', T0 + 5).answer.error, 'NOT_HOLDER');
});

test('RS-4: stopping the share gives the turn back; releasing what one does not hold changes nothing', () => {
  const held = ask(fresh(), 'P-1', T0).state;
  const stranger = release(held, { by: 'P-2', now: T0 + 10 });
  assert.equal(stranger.answer.wasHolder, false);
  assert.equal(view(stranger.state, T0 + 20).holder, 'P-1');
  const freed = release(held, { by: 'P-1', now: T0 + 30 });
  assert.equal(freed.answer.wasHolder, true);
  assert.equal(view(freed.state, T0 + 40).holder, null);
  assert.equal(ask(freed.state, 'P-2', T0 + 50).answer.turn.holder, 'P-2');
});

test('RS-5: leaving the room, or being taken out of it, frees the turn at once', () => {
  const held = ask(fresh(), 'P-1', T0).state;
  const gone = leave(held, { by: 'P-1', now: T0 + 100 });
  assert.equal(view(gone.state, T0 + 110).holder, null);
  assert.equal(ask(gone.state, 'P-2', T0 + 120).answer.ok, true);
  // Someone else leaving changes nothing.
  const other = leave(held, { by: 'P-3', now: T0 + 100 });
  assert.equal(view(other.state, T0 + 110).holder, 'P-1');
  assert.equal(other.state.changes, held.changes);
});

test('RS-6: handing the turn over: it waits for the person named, for nobody else, and not for ever', () => {
  const held = ask(fresh(), 'P-1', T0).state;
  assert.equal(handOver(held, { by: 'P-2', member: true, to: 'P-3', toMember: true, now: T0 + 10 }).answer.error, 'NOT_HOLDER');
  assert.equal(handOver(held, { by: 'P-1', member: true, to: 'P-9', toMember: false, now: T0 + 10 }).answer.error, 'NO_SUCH_PERSON');
  assert.equal(handOver(held, { by: 'P-1', member: true, to: 'P-1', toMember: true, now: T0 + 10 }).answer.error, 'NO_SUCH_PERSON');
  const offered = handOver(held, { by: 'P-1', member: true, to: 'P-2', toMember: true, now: T0 + 100 });
  assert.equal(offered.answer.ok, true);
  assert.deepEqual([offered.answer.turn.holder, offered.answer.turn.offeredTo], [null, 'P-2']);
  // The one who handed it over is no longer the holder: their page must stop.
  assert.equal(still(offered.state, 'P-1', T0 + 150).answer.error, 'NOT_HOLDER');
  const third = ask(offered.state, 'P-3', T0 + 200);
  assert.equal(third.answer.error, 'OFFERED_TO_ANOTHER');
  assert.equal(third.answer.offeredTo, 'P-2');
  const taken = ask(offered.state, 'P-2', T0 + 300);
  assert.deepEqual([taken.answer.turn.holder, taken.answer.turn.offeredTo], ['P-2', null]);
  // Not taken in time: free for anyone.
  const late = ask(offered.state, 'P-3', T0 + 100 + TURN_LIMITS.offerMs);
  assert.equal(late.answer.turn.holder, 'P-3');
  // The person it was offered to leaves: the offer is over.
  const left = leave(offered.state, { by: 'P-2', now: T0 + 200 });
  assert.equal(view(left.state, T0 + 210).offeredTo, null);
  assert.equal(ask(left.state, 'P-3', T0 + 220).answer.ok, true);
});

test('RS-7: a page shows only the share of the person who holds the turn', () => {
  const turn = view(ask(fresh(), 'P-1', T0).state, T0 + 10);
  assert.equal(showsShareOf(turn, 'P-1'), true);
  assert.equal(showsShareOf(turn, 'P-2'), false);                      // a second stream on Zoom from a changed program is not shown
  assert.equal(showsShareOf(view(fresh(), T0), 'P-1'), false);         // nobody holds it: nothing is shown
  assert.equal(showsShareOf(view(fresh(), T0), null), false);
});

test('RS-8: whatever people do in whatever order, there is never more than one holder, and every change is counted', () => {
  let value = 7;
  const random = () => { value = (value + 0x6d2b79f5) >>> 0; let t = value; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const people = ['P-1', 'P-2', 'P-3', 'P-4'];
  let state = fresh(), now = T0, lastChanges = 0, lastHolder = null;
  const sharing = new Set();                                            // pages that believe they are sharing
  for (let step = 0; step < 4_000; step += 1) {
    now += Math.floor(random() * 6_000);
    const by = people[Math.floor(random() * people.length)];
    const roll = random();
    let out;
    if (roll < 0.35) { out = claim(state, { by, member: true, now }); if (out.answer.ok) sharing.add(by); }
    else if (roll < 0.70) { out = beat(state, { by, member: true, now }); if (!out.answer.ok) sharing.delete(by); }
    else if (roll < 0.82) { out = release(state, { by, now }); sharing.delete(by); }
    else if (roll < 0.90) { out = leave(state, { by, now }); sharing.delete(by); }
    else { const to = people[Math.floor(random() * people.length)]; out = handOver(state, { by, member: true, to, toMember: true, now }); if (out.answer.ok) sharing.delete(by); }
    state = out.state;
    const turn = view(state, now);
    // A page that was just told it holds the turn is the holder the room is told of.
    if (out.answer.ok && out.answer.turn && roll < 0.70) assert.equal(turn.holder, by);
    assert.ok(turn.holder === null || people.includes(turn.holder));
    assert.ok(!(turn.holder !== null && turn.offeredTo !== null), 'a holder and an offer at once');
    assert.ok(turn.changes >= lastChanges);
    if (turn.holder !== lastHolder) assert.ok(turn.changes > lastChanges, 'the holder changed and the count did not');
    lastChanges = turn.changes;
    lastHolder = turn.holder;
  }
});
