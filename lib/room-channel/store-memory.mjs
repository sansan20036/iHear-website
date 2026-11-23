// The room channel's store, kept in memory (local integration only, 2026-11-23): for tests, the
// local measurement and a local server. It keeps things the way the PostgreSQL store does
// (store-postgres.mjs), so that the service is the same code over both:
//   one small row per lesson and part ("board": the board's header; "chat"; "turn"), each with the
//   moment after which it must be gone (deleteAfter);
//   a board's lines, each line's parts (the points), and its recent operations, apart from the row.
// A change to one part of one lesson runs alone (withPart), and nothing of it is kept unless the
// whole of it succeeded. Reads take no turn in that queue; each read call sees one moment.
import { needsFresh } from './board.mjs';
import { CHAT_LIMITS } from './chat.mjs';

const PARTS = ['board', 'chat', 'turn'];

export function createMemoryStore() {
  const rows = new Map();     // "lesson\npart" → { state, deleteAfter }
  const boards = new Map();   // lesson → { lines: Map(key → { row, parts: [points…] }), ops: [{ seq, by, op, entry }], names: Map("by\nop" → seq) }
  const queues = new Map();
  // How often the store was asked, by kind: the measurement reads these.
  const calls = { read: 0, write: 0, news: 0, picture: 0 };

  const keyOf = (lessonId, part) => `${lessonId}\n${part}`;
  const boardOf = lessonId => {
    let board = boards.get(lessonId);
    if (!board) { board = { lines: new Map(), ops: [], names: new Map() }; boards.set(lessonId, board); }
    return board;
  };

  function applyEffects(lessonId, list) {
    const board = boardOf(lessonId);
    for (const effect of list) {
      if (effect.type === 'part') {
        const line = board.lines.get(effect.key) ?? { row: null, parts: [] };
        line.row = { ...effect.line };
        line.parts[effect.part] = effect.points.map(point => [point[0], point[1]]);
        board.lines.set(effect.key, line);
      } else if (effect.type === 'remove') board.lines.delete(effect.key);
      else if (effect.type === 'hold') { for (const line of board.lines.values()) if (line.row.clearedBy === null) line.row = { ...line.row, clearedBy: effect.seq }; }
      else if (effect.type === 'restore') { for (const line of board.lines.values()) if (line.row.clearedBy === effect.seq) line.row = { ...line.row, clearedBy: null }; }
      else if (effect.type === 'drop') { for (const [key, line] of board.lines) if (line.row.clearedBy === effect.seq) board.lines.delete(key); }
      else if (effect.type === 'op') {
        board.ops.push({ seq: effect.entry.seq, by: effect.entry.by, op: effect.op, entry: structuredClone(effect.entry) });
        board.names.set(`${effect.entry.by}\n${effect.op}`, effect.entry.seq);
      } else if (effect.type === 'trim') {
        while (board.ops.length && board.ops[0].seq <= effect.base) {
          const old = board.ops.shift();
          if (board.names.get(`${old.by}\n${old.op}`) === old.seq) board.names.delete(`${old.by}\n${old.op}`);
        }
      } else throw new Error(`unknown effect: ${effect.type}`);
    }
  }

  // One change to one part of one lesson, alone. work(tx) reads, decides and names its writes; the
  // writes are made only when work has finished without an error.
  async function withPart(lessonId, part, work) {
    if (!PARTS.includes(part)) throw new Error(`unknown part: ${part}`);
    const key = keyOf(lessonId, part);
    const before = queues.get(key) ?? Promise.resolve();
    let release;
    const mine = new Promise(resolve => { release = resolve; });
    const tail = before.then(() => mine);
    queues.set(key, tail);
    await before;
    try {
      const pending = [];
      const tx = {
        async read() { calls.read += 1; const row = rows.get(key); return row ? structuredClone(row) : null; },
        // The row, the one line a request names (as kept beside its points) and the place of the
        // operation the person named ({ by, name }), in one asking.
        async readFor({ line = null, op = null } = {}) {
          calls.read += 1;
          const row = rows.get(key);
          if (!row) return { row: null, line: null, known: null };
          const board = boards.get(lessonId);
          const found = line === null ? null : board?.lines.get(line);
          return { row: structuredClone(row), line: found ? { ...found.row } : null, known: op === null ? null : board?.names.get(`${op.by}\n${op.name}`) ?? null };
        },
        write(state, deleteAfter) { pending.push(() => { rows.set(key, structuredClone({ state, deleteAfter })); }); },
        effects(list) { if (list.length) pending.push(() => applyEffects(lessonId, list)); },
        remove() { pending.push(() => { rows.delete(key); if (part === 'board') boards.delete(lessonId); }); },
      };
      const result = await work(tx);
      if (pending.length) calls.write += 1;
      for (const step of pending) step();
      return result;
    } finally {
      release();
      if (queues.get(key) === tail) queues.delete(key);
    }
  }

  // What is new for a person who has reached these places (a cursor per part asked for; a part not
  // asked for is not read). One moment for all three.
  async function news(lessonId, cursors) {
    calls.news += 1;
    const out = {};
    if (cursors.board !== undefined) {
      const row = rows.get(keyOf(lessonId, 'board'));
      if (!row) out.board = null;
      else {
        const { seq, base, endedAt } = row.state;
        const fresh = needsFresh(row.state, cursors.board);
        out.board = { seq, base, endedAt, clearAt: row.state.clear && !row.state.clear.undone ? row.state.clear.at : null, deleteAfter: row.deleteAfter, entries: fresh ? null : (boards.get(lessonId)?.ops ?? []).filter(item => item.seq > cursors.board).map(item => structuredClone(item.entry)) };
      }
    }
    if (cursors.chat !== undefined) {
      const row = rows.get(keyOf(lessonId, 'chat'));
      if (!row) out.chat = null;
      else {
        const { seq, base, endedAt, messages } = row.state;
        const from = cursors.chat > seq ? 0 : cursors.chat;
        const after = messages.filter(message => message.seq > from);
        out.chat = { seq, base, endedAt, deleteAfter: row.deleteAfter, from, messages: structuredClone(after.slice(0, CHAT_LIMITS.page)), more: after.length > CHAT_LIMITS.page };
      }
    }
    if (cursors.turn !== undefined) {
      const row = rows.get(keyOf(lessonId, 'turn'));
      out.turn = row ? { state: structuredClone(row.state), deleteAfter: row.deleteAfter } : null;
    }
    return out;
  }

  // A board whole: its header and every line with its points, at one moment.
  async function picture(lessonId) {
    calls.picture += 1;
    const row = rows.get(keyOf(lessonId, 'board'));
    if (!row) return null;
    const lines = {};
    for (const [key, line] of boards.get(lessonId)?.lines ?? []) lines[key] = { ...line.row, points: line.parts.flat().map(point => [point[0], point[1]]) };
    return { state: structuredClone(row.state), deleteAfter: row.deleteAfter, lines };
  }

  const split = key => { const at = key.indexOf('\n'); return { lessonId: key.slice(0, at), part: key.slice(at + 1) }; };
  // For the sweep: the parts that must be gone by now; the boards whose latest clear is older than
  // the moment given; the lessons that still have a part not known to be ended.
  async function due(now, limit) { return [...rows].filter(([, row]) => row.deleteAfter <= now).slice(0, limit).map(([key]) => split(key)); }
  async function clearsBefore(moment, limit) {
    return [...rows].filter(([key, row]) => key.endsWith('\nboard') && row.state.endedAt === null && row.state.clear && !row.state.clear.undone && row.state.clear.at < moment).slice(0, limit).map(([key]) => split(key).lessonId);
  }
  async function open(limit) {
    const lessons = new Set();
    for (const [key, row] of rows) if ((row.state.endedAt ?? null) === null) lessons.add(split(key).lessonId);
    return [...lessons].slice(0, limit);
  }
  // What is held, by part, and what is overdue (it should be nothing while the sweep runs).
  async function stats(now) {
    const parts = { board: 0, chat: 0, turn: 0 };
    let overdue = 0, oldestOverdueMs = 0, lines = 0, operations = 0;
    for (const [key, row] of rows) {
      parts[split(key).part] += 1;
      if (row.deleteAfter <= now) { overdue += 1; oldestOverdueMs = Math.max(oldestOverdueMs, now - row.deleteAfter); }
    }
    for (const board of boards.values()) { lines += board.lines.size; operations += board.ops.length; }
    return { parts, overdue, oldestOverdueMs, lines, operations };
  }

  return { withPart, news, picture, due, clearsBefore, open, stats, calls };
}
