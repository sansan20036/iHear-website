// The room whiteboard, server side (design and local tests only, 2026-11-23; not wired to any route
// or page, behind no switch yet, nothing deployed).
//
// The user's decision of 2026-11-23: every whiteboard operation goes through our server, which
// checks who sent it, that they are in the room, its shape and the limits, gives it its place in
// one order, keeps it for a short time and hands it on. So there is no clock of a client's to
// trust: the order is the server's own count (seq), and a client can neither jump ahead of it nor
// speak in another person's name.
//
// Pure logic: a board's state goes in with one request and comes out with the answer; the caller
// (a route, later) reads and writes the state in one transaction and says who is asking (taken
// from the person's own classroom ticket, never from the request body) and whether that person is
// in the room now. Nothing here reads a clock, a database, a switch or the network.
//
// What a person may send (every field is checked; an unknown field is refused):
//   stroke  { kind, op, line, part, points, color, width, done }   one part of a line of their own
//   erase   { kind, op, line }                                     a whole line, anyone's
//   clear   { kind, op }                                           everything drawn so far
//   undo    { kind, op, clear }                                    brings back what the latest clear took
// "op" is the sender's own name for the request: sent twice, it counts once.
//
// What is kept: the lines that stand, the lines the latest clear took (until it can no longer be
// undone), and the recent operations for people who were away for a moment. Older history is
// dropped as it stops being needed, so a long lesson does not grow without end. A board is deleted
// within 24 hours after its lesson ended (the caller deletes what expired() names).

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
  opNamesKept: 300,           // per person: names of their latest requests, to count a repeat once
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
const refuse = (state, error, more = {}) => ({ state, answer: { ok: false, error, ...more } });

export function newBoard({ roomId, lessonId, now }) {
  return { version: 1, roomId: String(roomId), lessonId: String(lessonId), createdAt: now, lastAt: now, endedAt: null, seq: 0, base: 0, lines: {}, points: 0, clear: null, recent: [], names: {}, rate: {}, clearTimes: [] };
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

const visible = line => line.clearedBy === null;
// What is no longer needed is dropped: lines taken by a clear that can no longer be undone, and
// operations older than the last recentKept.
function tidy(state, now) {
  if (state.clear && (state.clear.undone || now - state.clear.at > BOARD_LIMITS.undoWindowMs)) {
    if (!state.clear.undone) for (const [key, line] of Object.entries(state.lines)) if (line.clearedBy === state.clear.seq) { state.points -= line.points.length; delete state.lines[key]; }
    state.clear = null;
  }
  if (state.recent.length > BOARD_LIMITS.recentKept) {
    state.recent = state.recent.slice(-BOARD_LIMITS.recentKept);
    state.base = state.recent[0].seq - 1;
  }
}
function record(state, by, now, entry) {
  state.seq += 1;
  const kept = { seq: state.seq, at: now, by, ...entry };
  state.recent = [...state.recent, kept];
  state.lastAt = now;
  return kept;
}
// A copy to work on that shares with the state given everything it does not change: the table of
// lines is its own, each line is copied only when it is changed. The state given is never changed.
const workingCopy = before => ({ ...before, lines: { ...before.lines }, clear: before.clear ? { ...before.clear } : null });

// One request from one person. by: who is asking, as our server knows them. member: whether they
// are in this room's lesson now. The state given is not changed; the state to keep is in the answer.
export function apply(before, { by, member, input, now }) {
  if (typeof by !== 'string' || !PERSON.test(by) || member !== true) return refuse(before, 'NOT_IN_ROOM');
  if (before.endedAt !== null) return refuse(before, 'LESSON_ENDED');
  const problem = invalidRequest(input);
  if (problem) return refuse(before, problem);
  // The same request again (a retry after a lost answer): it counted once, and says so.
  const known = before.names[by]?.[input.op];
  if (known !== undefined) return { state: before, answer: { ok: true, seq: known, duplicate: true } };

  const state = workingCopy(before);
  tidy(state, now);
  const times = (state.rate[by] ?? []).filter(at => now - at < BOARD_LIMITS.rateWindowMs);
  if (times.length >= BOARD_LIMITS.perSender) return refuse(before, 'TOO_FAST', { retryAfterMs: BOARD_LIMITS.rateWindowMs - (now - times[0]) });
  state.rate = { ...state.rate, [by]: [...times, now] };

  let entry;
  if (input.kind === 'stroke') {
    const key = `${by}:${input.line}`;
    const line = state.lines[key];
    if (!line) {
      // Only a first part begins a line. A later part of a line that is gone (erased, or dropped
      // after a clear) is refused, so the page stops sending it.
      if (input.part !== 0) return refuse(before, 'LINE_GONE');
      if (Object.keys(state.lines).length >= BOARD_LIMITS.liveLines || state.points + input.points.length > BOARD_LIMITS.livePoints) return refuse(before, 'BOARD_FULL');
      state.lines[key] = { by, color: input.color, width: input.width, points: input.points.map(point => [point[0], point[1]]), parts: 1, done: input.done, beganSeq: state.seq + 1, clearedBy: null };
    } else {
      if (line.done) return refuse(before, 'LINE_DONE');
      if (input.part !== line.parts) return refuse(before, 'OUT_OF_ORDER', { expected: line.parts });
      if (state.points + input.points.length > BOARD_LIMITS.livePoints) return refuse(before, 'BOARD_FULL');
      state.lines[key] = { ...line, points: line.points.concat(input.points.map(point => [point[0], point[1]])), parts: line.parts + 1, done: input.done };
    }
    state.points += input.points.length;
    // The colour and width of a line are those of its first part, whatever a later part says.
    const kept = state.lines[key];
    entry = record(state, by, now, { kind: 'stroke', line: key, part: input.part, points: input.points.map(point => [point[0], point[1]]), color: kept.color, width: kept.width, done: input.done });
  } else if (input.kind === 'erase') {
    const line = state.lines[input.line];
    if (!line || !visible(line)) return refuse(before, 'NO_SUCH_LINE');
    state.points -= line.points.length;
    delete state.lines[input.line];
    entry = record(state, by, now, { kind: 'erase', line: input.line });
  } else if (input.kind === 'clear') {
    const recentClears = state.clearTimes.filter(at => now - at < BOARD_LIMITS.clearWindowMs);
    if (recentClears.length >= BOARD_LIMITS.clearsPerRoom) return refuse(before, 'CLEAR_TOO_OFTEN', { retryAfterMs: BOARD_LIMITS.clearWindowMs - (now - recentClears[0]) });
    state.clearTimes = [...recentClears, now];
    // Only the latest clear can be undone: what an earlier one took is dropped now.
    if (state.clear && !state.clear.undone) for (const [key, line] of Object.entries(state.lines)) if (line.clearedBy === state.clear.seq) { state.points -= line.points.length; delete state.lines[key]; }
    const seq = state.seq + 1;
    let taken = 0;
    for (const [key, line] of Object.entries(state.lines)) if (visible(line)) { state.lines[key] = { ...line, clearedBy: seq }; taken += 1; }
    state.clear = { seq, by, at: now, undone: false, lines: taken };
    entry = record(state, by, now, { kind: 'clear', lines: taken, undoUntil: now + BOARD_LIMITS.undoWindowMs });
  } else {
    const clear = state.clear;
    if (!clear || clear.seq !== input.clear || clear.undone) return refuse(before, 'NOTHING_TO_UNDO');
    let back = 0;
    for (const [key, line] of Object.entries(state.lines)) if (line.clearedBy === clear.seq) { state.lines[key] = { ...line, clearedBy: null }; back += 1; }
    clear.undone = true;
    entry = record(state, by, now, { kind: 'undo', clear: clear.seq, lines: back });
  }
  const names = { ...(state.names[by] ?? {}), [input.op]: entry.seq };
  const kept = Object.keys(names);
  if (kept.length > BOARD_LIMITS.opNamesKept) for (const name of kept.slice(0, kept.length - BOARD_LIMITS.opNamesKept)) delete names[name];
  state.names = { ...state.names, [by]: names };
  tidy(state, now);
  return { state, answer: { ok: true, seq: entry.seq, entry } };
}

// The picture as it stands, for someone who comes in or was away too long: the lines to show, in
// the order they were begun, and the lines the latest clear took while it can still be undone
// (so that an undo needs no second fetch).
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
// What happened after the place the asker has reached. Someone who was away past what is kept is
// given the picture afresh.
export function since(state, { by, member, cursor, now }) {
  if (typeof by !== 'string' || member !== true) return { ok: false, error: 'NOT_IN_ROOM' };
  if (!isInt(cursor, 0, Number.MAX_SAFE_INTEGER)) return { ok: false, error: 'CURSOR' };
  if (cursor > state.seq || cursor < state.base) return { ok: true, fresh: true, picture: snapshot(state, now) };
  return { ok: true, fresh: false, seq: state.seq, ended: state.endedAt !== null, entries: state.recent.filter(entry => entry.seq > cursor) };
}

// The lesson is over: nothing more is taken; the board is kept for retentionAfterEndMs and then deleted.
export function end(before, now) {
  if (before.endedAt !== null) return before;
  return { ...before, endedAt: now, lastAt: now };
}
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
