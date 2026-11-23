// The whiteboard's geometry (2026-11-24): pure functions, no canvas, no browser.
//   node --test "tests/room-channel/*.test.mjs"
import assert from 'node:assert/strict';
import test from 'node:test';

import { BOARD_SHAPE, BOARD_SPACE, distanceToLine, farEnough, fitBoard, lineUnder } from '../../lib/room-channel/board-geometry.mjs';

test('GM-1: the board keeps its shape in any box, so a line sits in the same place for everyone', () => {
  assert.equal(BOARD_SHAPE, 4 / 3);
  assert.equal(BOARD_SPACE, 10_000);
  assert.deepEqual(fitBoard(800, 600), { width: 800, height: 600 });
  assert.deepEqual(fitBoard(1200, 600), { width: 800, height: 600 });          // a wide box: the height decides
  assert.deepEqual(fitBoard(358, 560), { width: 358, height: 268 });           // a phone: the width decides
  assert.deepEqual(fitBoard(0, 500), { width: 0, height: 0 });
  assert.deepEqual(fitBoard(-5, 500), { width: 0, height: 0 });
});

test('GM-2: how far a place is from a line', () => {
  const line = [[1000, 1000], [3000, 1000], [3000, 3000]];
  assert.equal(distanceToLine(line, 2000, 1000), 0);
  assert.equal(distanceToLine(line, 2000, 1300), 300);
  assert.equal(distanceToLine(line, 3400, 2000), 400);
  assert.equal(distanceToLine(line, 0, 1000), 1000);                            // before its beginning: to the end point
  assert.equal(Math.round(distanceToLine(line, 3300, 3400)), 500);              // past its end
  assert.equal(distanceToLine([[500, 500]], 500, 800), 300);                    // a dot
  assert.equal(distanceToLine([], 1, 1), Infinity);
});

test('GM-3: the eraser takes the line on top, only when the tap is near it, never a line not yet confirmed or already asked for', () => {
  const lines = [
    { line: 'P-1:a', width: 2, points: [[1000, 1000], [5000, 1000]] },
    { line: 'P-2:b', width: 2, points: [[3000, 0], [3000, 2000]] },               // drawn later: on top where they cross
    { line: 'me:c', width: 2, points: [[3000, 1000], [3100, 1000]], unconfirmed: true },
  ];
  assert.equal(lineUnder(lines, 3000, 1000), 'P-2:b');
  assert.equal(lineUnder(lines, 1500, 1050), 'P-1:a');
  assert.equal(lineUnder(lines, 1500, 1160), 'P-1:a');                          // within 140 + the line's own width
  assert.equal(lineUnder(lines, 1500, 1200), null);
  assert.equal(lineUnder(lines, 8000, 8000), null);
  assert.equal(lineUnder(lines, 3000, 1000, { skip: new Set(['P-2:b']) }), 'P-1:a');
  // A thick line is easier to hit.
  assert.equal(lineUnder([{ line: 'P-1:t', width: 8, points: [[1000, 1000], [5000, 1000]] }], 1500, 1200), 'P-1:t');
});

test('GM-4: a new point only when the pen has moved', () => {
  assert.equal(farEnough([100, 100], 100, 100), false);
  assert.equal(farEnough([100, 100], 110, 110), false);
  assert.equal(farEnough([100, 100], 118, 100), true);
  assert.equal(farEnough([100, 100], 100, 300), true);
});
