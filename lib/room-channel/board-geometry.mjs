// The whiteboard's geometry, apart from any canvas (local integration only, 2026-11-24): the
// board's fixed shape in a box of the page, how far a place is from a line, and which line a tap
// of the eraser means. Pure functions, so that they run under node --test.
import { BOARD_LIMITS } from './board.mjs';

export const BOARD_SPACE = BOARD_LIMITS.coord;   // the board's own space on both axes
export const BOARD_SHAPE = 4 / 3;                // its width over its height, the same for everyone

// The largest board of that shape that fits a box, in whole pixels.
export function fitBoard(boxWidth, boxHeight) {
  const width = Math.max(0, Math.floor(Math.min(boxWidth, boxHeight * BOARD_SHAPE)));
  return { width, height: Math.floor(width / BOARD_SHAPE) };
}

// How far a place is from a line, in the board's space. A line of one point is a dot.
export function distanceToLine(points, x, y) {
  let best = Infinity;
  for (let index = 0; index < points.length; index += 1) {
    const [ax, ay] = points[index], [bx, by] = points[Math.min(index + 1, points.length - 1)];
    const dx = bx - ax, dy = by - ay;
    const along = dx === 0 && dy === 0 ? 0 : Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)));
    best = Math.min(best, Math.hypot(x - (ax + along * dx), y - (ay + along * dy)));
  }
  return best;
}

// The line a tap of the eraser means: the one drawn last among those near enough (it lies on top).
// A thicker line is easier to hit. Lines the server has not confirmed yet, and lines already asked
// to be erased (skip), are not offered. Null: the tap is on nothing.
export function lineUnder(lines, x, y, { near = 140, skip = null } = {}) {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (line.unconfirmed || skip?.has(line.line) || !line.points.length) continue;
    if (distanceToLine(line.points, x, y) <= near + line.width * 10) return line.line;
  }
  return null;
}

// Whether the pen has moved far enough from its last point for a new one (in the board's space).
export const farEnough = (last, x, y, step = 18) => Math.hypot(x - last[0], y - last[1]) >= step;
