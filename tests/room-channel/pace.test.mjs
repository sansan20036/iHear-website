// The room channel's pace (2026-11-27): the figures, what a server or a site may change of them,
// and how long a page waits. No browser, no network.
//   node --test "tests/room-channel/*.test.mjs"
import assert from 'node:assert/strict';
import test from 'node:test';

import { paceFrom, paceOfSite, ROOM_PACE, waitFor } from '../../lib/room-channel/pace.mjs';

test('PA-1: the figures the user decided (2026-11-27): a second while there is news, five seconds after twenty quiet ones, batches half a second apart', () => {
  assert.deepEqual({ ...ROOM_PACE }, { activeMs: 1_000, idleMs: 5_000, quietAfterMs: 20_000, flushMs: 500, hiddenMs: 15_000 });
  assert.ok(Object.isFrozen(ROOM_PACE));
});

test('PA-2: how long a page waits: by the news, by whether it is looked at, and never past the next "still sharing"', () => {
  assert.equal(waitFor(ROOM_PACE, { sinceNewsMs: 0 }), 1_000);
  assert.equal(waitFor(ROOM_PACE, { sinceNewsMs: 19_999 }), 1_000);
  assert.equal(waitFor(ROOM_PACE, { sinceNewsMs: 20_000 }), 5_000);
  assert.equal(waitFor(ROOM_PACE, { sinceNewsMs: Infinity }), 5_000);
  assert.equal(waitFor(ROOM_PACE), 5_000, 'a page that has heard nothing yet is in a quiet room');
  // Hidden: no more often than every 15 seconds, news or not.
  assert.equal(waitFor(ROOM_PACE, { sinceNewsMs: 0, hidden: true }), 15_000);
  assert.equal(waitFor(ROOM_PACE, { sinceNewsMs: Infinity, hidden: true }), 15_000);
  // Holding the share turn: the next "still sharing" is the latest, quiet or hidden; one that is overdue goes now.
  assert.equal(waitFor(ROOM_PACE, { sinceNewsMs: Infinity, beatInMs: 3_200 }), 3_200);
  assert.equal(waitFor(ROOM_PACE, { sinceNewsMs: Infinity, hidden: true, beatInMs: 4_000 }), 4_000);
  assert.equal(waitFor(ROOM_PACE, { sinceNewsMs: 0, beatInMs: 4_000 }), 1_000);
  assert.equal(waitFor(ROOM_PACE, { sinceNewsMs: Infinity, hidden: true, beatInMs: -300 }), 0);
});

test('PA-3: a pace from a server\'s answer: whole numbers inside the bounds are taken, everything else stays as it was, and a quiet room is never asked more often than a busy one', () => {
  assert.deepEqual(paceFrom(null), ROOM_PACE);
  assert.deepEqual(paceFrom('fast'), ROOM_PACE);
  assert.deepEqual(paceFrom({ activeMs: 700, flushMs: 300 }), { ...ROOM_PACE, activeMs: 700, flushMs: 300 });
  // The least and the most each figure may be.
  assert.deepEqual(paceFrom({ activeMs: 250, idleMs: 1_000, quietAfterMs: 1_000, flushMs: 100, hiddenMs: 2_000 }), { activeMs: 250, idleMs: 1_000, quietAfterMs: 1_000, flushMs: 100, hiddenMs: 2_000 });
  assert.deepEqual(paceFrom({ activeMs: 10_000, idleMs: 60_000, quietAfterMs: 600_000, flushMs: 5_000, hiddenMs: 120_000 }), { activeMs: 10_000, idleMs: 60_000, quietAfterMs: 600_000, flushMs: 5_000, hiddenMs: 120_000 });
  for (const bad of [{ activeMs: 249 }, { activeMs: 10_001 }, { idleMs: 999 }, { idleMs: 60_001 }, { flushMs: 99 }, { flushMs: 5_001 }, { hiddenMs: 1_999 }, { quietAfterMs: 999 }, { activeMs: 0 }, { activeMs: -1 }, { activeMs: 1.5 }, { activeMs: '1000' }, { activeMs: null }, { activeMs: NaN }, { unknown: 1 }]) {
    assert.deepEqual(paceFrom(bad), ROOM_PACE, JSON.stringify(bad));
  }
  // Onto what a page already follows, figure by figure.
  const before = paceFrom({ idleMs: 8_000 });
  assert.deepEqual(paceFrom({ activeMs: 2_000 }, before), { ...ROOM_PACE, activeMs: 2_000, idleMs: 8_000 });
  // Busy slower than quiet makes no sense: quiet is then as slow as busy.
  assert.deepEqual(paceFrom({ activeMs: 8_000 }), { ...ROOM_PACE, activeMs: 8_000, idleMs: 8_000 });
  assert.ok(Object.isFrozen(paceFrom({ activeMs: 700 })));
});

test('PA-4: the site\'s own setting: any of the five figures by their short names; anything else is the default', () => {
  assert.deepEqual(paceOfSite({}), ROOM_PACE);
  assert.deepEqual(paceOfSite({ CLASSROOM_ROOM_CHANNEL_PACE: '' }), ROOM_PACE);
  assert.deepEqual(paceOfSite({ CLASSROOM_ROOM_CHANNEL_PACE: 'active=700, idle=3000,quiet=10000,flush=300,hidden=20000' }), { activeMs: 700, idleMs: 3_000, quietAfterMs: 10_000, flushMs: 300, hiddenMs: 20_000 });
  assert.deepEqual(paceOfSite({ CLASSROOM_ROOM_CHANNEL_PACE: 'idle=8000' }), { ...ROOM_PACE, idleMs: 8_000 });
  for (const text of ['idle=5', 'idle=fast', 'idle', '=3000', 'pause=3000', 'idle=3000ms', 'idle=-3000', 'idle=3e3', ',,,', 'idle=99999999']) {
    assert.deepEqual(paceOfSite({ CLASSROOM_ROOM_CHANNEL_PACE: text }), ROOM_PACE, text);
  }
  // A figure that is right is taken beside one that is not.
  assert.deepEqual(paceOfSite({ CLASSROOM_ROOM_CHANNEL_PACE: 'idle=fast,flush=250' }), { ...ROOM_PACE, flushMs: 250 });
});
