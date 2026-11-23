// The room whiteboard, server side (local integration only, 2026-11-23; behind a switch that is
// off, nothing deployed).
//
// The user's decision of 2026-11-23: every whiteboard operation goes through our server, which
// checks who sent it, that they are in the room, its shape and the limits, gives it its place in
// one order, keeps it for a short time and hands it on. So there is no clock of a client's to
// trust: the order is the server's own count (seq), and a client can neither jump ahead of it nor
// speak in another person's name.
//
// Pure logic: a board's state goes in with one request and comes out with the answer; the caller
// (lib/room-channel/service.mjs) reads and writes the state in one transaction and says who is
// asking (taken from the person's own classroom ticket, never from the request body) and whether
// that person is in the room now. Nothing here reads a clock, a database, a switch or the network.
//
// What a person may send (every field is checked; an unknown field is refused):
//   stroke  { kind, op, line, part, points, color, width, done }   one part of a line of their own
//   erase   { kind, op, line }                                     a whole line, anyone's
//   clear   { kind, op }                                           everything drawn so far
//   undo    { kind, op, clear }                                    brings back what the latest clear took
// "op" is the sender's own name for the request: sent twice, it counts once (for as long as the
// operation is among the recent ones kept).
//
// What is kept: the lines that stand, the lines the latest clear took (until it can no longer be
// undone), and the recent operations for people who were away for a moment. Older history is
// dropped as it stops being needed, so a long lesson does not grow without end.
//
// Two ways of holding a board, one set of rules:
//   whole   everything in one object (the tests' reference, and a store in memory);
//   split   (state.split === true) the state is only the small header; the lines, their points and
//           the recent operations live in the store, and the caller hands in just what a request
//           touches (the one line it names, without its points, and whether its "op" is known).
// The header counts lines and points itself, and every answer lists the changes to make in the
// store ("effects"), so that a request costs what it touches and not what the board holds.

export const BOARD_LIMITS = Object.freeze({
  coord: 10_000,              // the board's own space: whole points 0..10000 on both axes
  pointsPerPart: 256,
  partsPerLine: 400,
  colors: 8,
  widths: Object.freeze([1, 2, 4, 8]),
  requestBytes: 8_192,        // one request as JSON, at most
  liveLines: 2_000,           // lines standing or held for an undo, at most
  livePoints: 400_000,
  perSender: 60,              // requests one person may make in rateWindowMs
  rateWindowMs: 10_000,
  clearsPerRoom: 2,           // clears a room may see in clearWindowMs
  clearWindowMs: 30_000,
  undoWindowMs: 10 * 60_000,  // how long the latest clear can be undone
  recentKept: 2_000,          // operations kept for catching up; older ones need a fresh picture
  retentionAfterEndMs: 24 * 60 * 60_000,
  idleMs: 48 * 60 * 60_000,   // a board nobody ended and nobody touched for this long is deleted too
});
const NAME = /^[A-Za-z0-9_-]{1,32}$/;
const PERSON = /^[A-Za-z0-9_-]{1,64}$/;
const KEYS = {
  stroke: ['kind', 'op', 'line', 'part', 'points', 'color', 'width', 'done'],
  erase: ['kind', 'op', 'line'],
  clear: ['kind', 'op'],
  undo: ['kind', 'op', 'clear'],
};
const isInt = (value, low, high) => Number.isInteger(value) && value >= low && value <= high;
const refuse = (state, error, more = {}) => ({ state, answer: { ok: false, error, ...more }, effects: [] });
const NONE = Object.freeze({ lines: 0, points: 0 });

export function newBoard({ roomId, lessonId, now, split = false }) {
  return {
    version: 2, roomId: String(roomId), lessonId: String(lessonId), createdAt: now, lastAt: now, endedAt: null, seq: 0, base: 0,
    // shown: the lines that stand. held: the lines the latest clear took. points: both together.
    shown: NONE, held: NONE, points: 0, clear: null, rate: {}, clearTimes: [], lines: {}, names: {},
    ...(split ? { split: true } : { recent: [] }),
  };
}

// Null when the request may be looked at further; otherwise why not.
export function invalidRequest(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return 'NOT_AN_OBJECT';
  const keys = Object.hasOwn(KEYS, input.kind) ? KEYS[input.kind] : null;
  if (!keys) return 'UNKNOWN_KIND';
  if (Object.keys(input).length !== keys.length || !keys.every(key => Object.hasOwn(input, key))) return 'FIELDS';
  if (typeof input.op !== 'string' || !NAME.test(input.op)) return 'OP_NAME';
  if (input.kind === 'stroke') {
    if (typeof input.line !== 'string' || !NAME.test(input.line)) return 'LINE';
    if (!isInt(input.part, 0, BOARD_LIMITS.partsPerLine - 1)) return 'PART';
    if (!Array.isArray(input.points) || input.points.length < 1 || input.points.length > BOARD_LIMITS.pointsPerPart) return 'POINTS';
    if (!input.points.every(point => Array.isArray(point) && point.length === 2 && isInt(point[0], 0, BOARD_LIMITS.coord) && isInt(point[1], 0, BOARD_LIMITS.coord))) return 'POINTS';
    if (!isInt(input.color, 0, BOARD_LIMITS.colors - 1)) return 'COLOR';
    if (!BOARD_LIMITS.widths.includes(input.width)) return 'WIDTH';
    if (typeof input.done !== 'boolean') return 'DONE';
  }
  // A whole line is named with its maker in front ("maker:line"), as the server hands it out.
  if (input.kind === 'erase' && (typeof input.line !== 'string' || !/^[A-Za-z0-9_-]{1,64}:[A-Za-z0-9_-]{1,32}$/.test(input.line))) return 'LINE';
  if (input.kind === 'undo' && !isInt(input.clear, 1, Number.MAX_SAFE_INTEGER)) return 'CLEAR';
  if (JSON.stringify(input).length > BOARD_LIMITS.requestBytes) return 'TOO_LARGE';
  return null;
}

// The line a request names, as the caller of a split board must fetch it: a stroke's own line
// under its maker, an erase's line as given; null for a clear or an undo, or a request not in form.
export function lineNamed(by, input) {
  if (invalidRequest(input)) return null;
  if (input.kind === 'stroke') return `${by}:${input.line}`;
  return input.kind === 'erase' ? input.line : null;
}

const visible = line => line.clearedBy === null;
// What the latest clear took is given up for good: an undo is no longer possible, or a newer clear
// takes its place, or the lesson is over.
function dropHeld(state, effects) {
  const clear = state.clear;
  if (!clear || clear.undone) return;
  for (const [key, line] of Object.entries(state.lines)) if (line.clearedBy === clear.seq) delete state.lines[key];
  state.points -= state.held.points;
  state.held = NONE;
  effects.push({ type: 'drop', seq: clear.seq });
}
// What is no longer needed is dropped: lines taken by a clear that can no longer be undone, and
// operations older than the last recentKept (with them, the names of the requests that made them).
function tidy(state, now, effects) {
  if (state.clear && (state.clear.undone || now - state.clear.at > BOARD_LIMITS.undoWindowMs)) {
    dropHeld(state, effects);
    state.clear = null;
  }
  const base = Math.max(state.base, state.seq - BOARD_LIMITS.recentKept);
  if (base > state.base) {
    if (!state.split) {
      const names = { ...state.names };
      for (const entry of state.recent) {
        if (entry.seq > base) break;
        if (names[entry.by]?.[entry.op] === entry.seq) { names[entry.by] = { ...names[entry.by] }; delete names[entry.by][entry.op]; }
      }
      state.names = names;
      state.recent = state.recent.filter(entry => entry.seq > base);
    }
    state.base = base;
    effects.push({ type: 'trim', base });
  }
}
function record(state, by, now, op, entry, effects) {
  state.seq += 1;
  const kept = { seq: state.seq, at: now, by, ...entry };
  if (!state.split) {
    // Kept with the request's own name, so that the name is forgotten when the operation is.
    state.recent = [...state.recent, { ...kept, op }];
    state.names = { ...state.names, [by]: { ...(state.names[by] ?? {}), [op]: kept.seq } };
  }
  state.lastAt = now;
  effects.push({ type: 'op', entry: kept, op });
  return kept;
}
// A copy to work on that shares with the state given everything it does not change: the table of
// lines is its own, each line is copied only when it is changed. The state given is never changed.
const workingCopy = before => ({ ...before, lines: { ...before.lines }, clear: before.clear ? { ...before.clear } : null });
// A line as a store keeps it beside its points.
const lineRow = line => ({ by: line.by, color: line.color, width: line.width, n: line.n, parts: line.parts, done: line.done, beganSeq: line.beganSeq, clearedBy: line.clearedBy });
const copyOf = points => points.map(point => [point[0], point[1]]);

// One request from one person. by: who is asking, as our server knows them. member: whether they
// are in this room's lesson now. The state given is not changed; the state to keep is in the
// answer, with the changes to make in a store that keeps the lines apart (effects, in order).
export function apply(before, { by, member, input, now }) {
  if (typeof by !== 'string' || !PERSON.test(by) || member !== true) return refuse(before, 'NOT_IN_ROOM');
  if (before.endedAt !== null) return refuse(before, 'LESSON_ENDED');
  const problem = invalidRequest(input);
  if (problem) return refuse(before, problem);
  // The same request again (a retry after a lost answer): it counted once, and says so.
  const known = before.names[by]?.[input.op];
  if (known !== undefined) return { state: before, answer: { ok: true, seq: known, duplicate: true }, effects: [] };

  const state = workingCopy(before);
  const effects = [];
  tidy(state, now, effects);
  const times = (state.rate[by] ?? []).filter(at => now - at < BOARD_LIMITS.rateWindowMs);
  if (times.length >= BOARD_LIMITS.perSender) return refuse(before, 'TOO_FAST', { retryAfterMs: BOARD_LIMITS.rateWindowMs - (now - times[0]) });
  state.rate = { ...state.rate, [by]: [...times, now] };

  let entry;
  if (input.kind === 'stroke') {
    const key = `${by}:${input.line}`;
    const line = state.lines[key];
    const count = input.points.length;
    if (!line) {
      // Only a first part begins a line. A later part of a line that is gone (erased, or dropped
      // after a clear) is refused, so the page stops sending it.
      if (input.part !== 0) return refuse(before, 'LINE_GONE');
      if (state.shown.lines + state.held.lines >= BOARD_LIMITS.liveLines || state.points + count > BOARD_LIMITS.livePoints) return refuse(before, 'BOARD_FULL');
      state.lines[key] = { by, color: input.color, width: input.width, n: count, parts: 1, done: input.done, beganSeq: state.seq + 1, clearedBy: null, ...(state.split ? {} : { points: copyOf(input.points) }) };
      state.shown = { lines: state.shown.lines + 1, points: state.shown.points + count };
    } else {
      if (line.done) return refuse(before, 'LINE_DONE');
      if (input.part !== line.parts) return refuse(before, 'OUT_OF_ORDER', { expected: line.parts });
      if (state.points + count > BOARD_LIMITS.livePoints) return refuse(before, 'BOARD_FULL');
      state.lines[key] = { ...line, n: line.n + count, parts: line.parts + 1, done: input.done, ...(line.points ? { points: line.points.concat(copyOf(input.points)) } : {}) };
      // A line the latest clear took may still be finished by its maker: it grows where it is held.
      if (visible(line)) state.shown = { lines: state.shown.lines, points: state.shown.points + count };
      else state.held = { lines: state.held.lines, points: state.held.points + count };
    }
    state.points += count;
    // The colour and width of a line are those of its first part, whatever a later part says.
    const kept = state.lines[key];
    entry = record(state, by, now, input.op, { kind: 'stroke', line: key, part: input.part, points: copyOf(input.points), color: kept.color, width: kept.width, done: input.done }, effects);
    effects.push({ type: 'part', key, line: lineRow(kept), part: input.part, points: copyOf(input.points) });
  } else if (input.kind === 'erase') {
    const line = state.lines[input.line];
    if (!line || !visible(line)) return refuse(before, 'NO_SUCH_LINE');
    state.points -= line.n;
    state.shown = { lines: state.shown.lines - 1, points: state.shown.points - line.n };
    delete state.lines[input.line];
    entry = record(state, by, now, input.op, { kind: 'erase', line: input.line }, effects);
    effects.push({ type: 'remove', key: input.line });
  } else if (input.kind === 'clear') {
    const recentClears = state.clearTimes.filter(at => now - at < BOARD_LIMITS.clearWindowMs);
    if (recentClears.length >= BOARD_LIMITS.clearsPerRoom) return refuse(before, 'CLEAR_TOO_OFTEN', { retryAfterMs: BOARD_LIMITS.clearWindowMs - (now - recentClears[0]) });
    state.clearTimes = [...recentClears, now];
    // Only the latest clear can be undone: what an earlier one took is dropped now.
    dropHeld(state, effects);
    const seq = state.seq + 1;
    const taken = state.shown.lines;
    for (const [key, line] of Object.entries(state.lines)) if (visible(line)) state.lines[key] = { ...line, clearedBy: seq };
    state.held = state.shown;
    state.shown = NONE;
    state.clear = { seq, by, at: now, undone: false, lines: taken };
    entry = record(state, by, now, input.op, { kind: 'clear', lines: taken, undoUntil: now + BOARD_LIMITS.undoWindowMs }, effects);
    effects.push({ type: 'hold', seq });
  } else {
    const clear = state.clear;
    if (!clear || clear.seq !== input.clear || clear.undone) return refuse(before, 'NOTHING_TO_UNDO');
    const back = state.held.lines;
    for (const [key, line] of Object.entries(state.lines)) if (line.clearedBy === clear.seq) state.lines[key] = { ...line, clearedBy: null };
    state.shown = { lines: state.shown.lines + state.held.lines, points: state.shown.points + state.held.points };
    state.held = NONE;
    clear.undone = true;
    entry = record(state, by, now, input.op, { kind: 'undo', clear: clear.seq, lines: back }, effects);
    effects.push({ type: 'restore', seq: clear.seq });
  }
  tidy(state, now, effects);
  return { state, answer: { ok: true, seq: entry.seq, entry }, effects };
}

// What time alone has done to a board nobody is writing on: a clear that can no longer be undone
// gives up what it took. For the scheduled sweep; changed says whether there is anything to keep.
export function settle(before, now) {
  if (before.endedAt !== null || !before.clear) return { state: before, effects: [], changed: false };
  const state = workingCopy(before);
  const effects = [];
  tidy(state, now, effects);
  return state.clear === null ? { state, effects, changed: true } : { state: before, effects: [], changed: false };
}

// The picture as it stands, for someone who comes in or was away too long: the lines to show, in
// the order they were begun, and the lines the latest clear took while it can still be undone
// (so that an undo needs no second fetch). The state given must hold every line with its points
// (a split store puts them back first).
export function snapshot(state, now) {
  const lines = Object.entries(state.lines).sort(([, a], [, b]) => a.beganSeq - b.beganSeq);
  const shape = ([key, line]) => ({ line: key, by: line.by, color: line.color, width: line.width, points: line.points, done: line.done, parts: line.parts });
  const undoable = state.clear && !state.clear.undone && now - state.clear.at <= BOARD_LIMITS.undoWindowMs ? state.clear : null;
  return {
    seq: state.seq, ended: state.endedAt !== null,
    lines: lines.filter(([, line]) => visible(line)).map(shape),
    undo: undoable ? { clear: undoable.seq, until: undoable.at + BOARD_LIMITS.undoWindowMs, lines: lines.filter(([, line]) => line.clearedBy === undoable.seq).map(shape) } : null,
  };
}
// Whether the place a person has reached can be caught up from the recent operations; if not, they
// need the picture afresh. The same rule for a whole board and for a split one.
export const needsFresh = (state, cursor) => cursor > state.seq || cursor < state.base;
// What happened after the place the asker has reached. Someone who was away past what is kept is
// given the picture afresh. (A whole board; a split one is answered by its store with the same rule.)
export function since(state, { by, member, cursor, now }) {
  if (typeof by !== 'string' || member !== true) return { ok: false, error: 'NOT_IN_ROOM' };
  if (!isInt(cursor, 0, Number.MAX_SAFE_INTEGER)) return { ok: false, error: 'CURSOR' };
  if (needsFresh(state, cursor)) return { ok: true, fresh: true, picture: snapshot(state, now) };
  return { ok: true, fresh: false, seq: state.seq, ended: state.endedAt !== null, entries: state.recent.filter(entry => entry.seq > cursor).map(({ op: _op, ...entry }) => entry) };
}

// The lesson is over (at: the moment it ended, by the server's own facts): nothing more is taken.
// What the latest clear took can no longer be brought back, so it is given up now; the rest is
// kept for retentionAfterEndMs and then deleted.
export function ending(before, at) {
  if (before.endedAt !== null) return { state: before, effects: [] };
  const state = workingCopy(before);
  const effects = [];
  dropHeld(state, effects);
  return { state: { ...state, clear: null, endedAt: at, lastAt: Math.max(state.lastAt, at), rate: {}, clearTimes: [] }, effects };
}
export const end = (before, at) => ending(before, at).state;
// Whether the caller must delete this board now.
export const expired = (state, now) => (state.endedAt !== null ? now - state.endedAt >= BOARD_LIMITS.retentionAfterEndMs : now - state.lastAt >= BOARD_LIMITS.idleMs);

// A page's own copy: begun from a picture, then moved on by each entry in order. The same code is
// what the tests use to say that everyone sees what the server holds.
export function pictureFrom(snap) {
  const picture = { seq: snap.seq, lines: new Map(), held: new Map(), undo: snap.undo ? { clear: snap.undo.clear, until: snap.undo.until } : null };
  for (const line of snap.lines) picture.lines.set(line.line, { ...line, points: [...line.points] });
  for (const line of snap.undo?.lines ?? []) picture.held.set(line.line, { ...line, points: [...line.points] });
  return picture;
}
export function moveOn(picture, entry) {
  if (entry.seq <= picture.seq) return picture;          // already had it
  if (entry.kind === 'stroke') {
    const where = picture.lines.has(entry.line) ? picture.lines : picture.held.has(entry.line) ? picture.held : null;
    if (!where) picture.lines.set(entry.line, { line: entry.line, by: entry.by, color: entry.color, width: entry.width, points: [...entry.points], done: entry.done, parts: 1 });
    else { const line = where.get(entry.line); line.points.push(...entry.points); line.done = entry.done; line.parts += 1; }
  } else if (entry.kind === 'erase') picture.lines.delete(entry.line);
  else if (entry.kind === 'clear') {
    picture.held = picture.lines;                          // what an earlier clear held is gone for good
    picture.lines = new Map();
    picture.undo = { clear: entry.seq, until: entry.undoUntil };
  } else if (entry.kind === 'undo') {
    // Brought back in front of what was drawn since, in the order they were begun.
    picture.lines = new Map([...picture.held, ...picture.lines]);
    picture.held = new Map();
    picture.undo = null;
  }
  picture.seq = entry.seq;
  return picture;
}
export const shown = picture => [...picture.lines.values()].map(line => ({ line: line.line, by: line.by, color: line.color, width: line.width, points: line.points, done: line.done }));
