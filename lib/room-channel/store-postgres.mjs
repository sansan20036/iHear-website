// The room channel's store on PostgreSQL (local integration only, 2026-11-23; the tables are a
// draft outside db/migrations: db/room-channel/031_classroom_room_channel.sql). The same contract
// as store-memory.mjs, so the service is one code over both.
//
// A change to one part of one lesson runs in one transaction that first takes a lock of its own
// for that lesson and part (pg_advisory_xact_lock: it lasts as long as the transaction, so it
// works through a pooler in transaction mode). The lock and the read are sent together and run one
// after the other, so the read sees what the previous holder of the lock committed. The writes are
// sent together too. One change is about four round trips: BEGIN, lock + read, writes, COMMIT.
// Reads for people catching up take no lock: each is ONE statement, so each sees one moment.
import { BOARD_LIMITS } from './board.mjs';
import { CHAT_LIMITS } from './chat.mjs';

const PARTS = ['board', 'chat', 'turn'];
const num = value => (value === null || value === undefined ? null : Number(value));

// What is new for a person who has reached these places, as three pieces of SQL (each one value,
// NULL when its part is not asked for) that a statement can carry beside other things: the store's
// own read below, and the read that also says who is asking (caller-postgres.mjs).
export function newsFragments(sql, lessonId, cursors) {
  const board = cursors.board === undefined ? sql`NULL::jsonb` : sql`(
    SELECT jsonb_build_object('seq', c.seq, 'base', (c.state->>'base')::bigint, 'endedAt', c.state->'endedAt', 'deleteAfter', round(extract(epoch FROM c.delete_after) * 1000),
      'entries', CASE WHEN ${cursors.board}::bigint > c.seq OR ${cursors.board}::bigint < (c.state->>'base')::bigint OR c.seq - ${cursors.board}::bigint > ${BOARD_LIMITS.catchUpEntries} THEN NULL
        ELSE (SELECT coalesce(jsonb_agg(o.entry ORDER BY o.seq), '[]'::jsonb) FROM public.classroom_room_board_ops o WHERE o.lesson_id = c.lesson_id AND o.seq > ${cursors.board}::bigint) END)
    FROM public.classroom_room_channel c WHERE c.lesson_id = ${lessonId} AND c.part = 'board')`;
  const chat = cursors.chat === undefined ? sql`NULL::jsonb` : sql`(
    SELECT jsonb_build_object('seq', c.seq, 'base', (c.state->>'base')::bigint, 'endedAt', c.state->'endedAt', 'deleteAfter', round(extract(epoch FROM c.delete_after) * 1000), 'from', f.reached,
      'messages', CASE WHEN c.seq > f.reached THEN jsonb_path_query_array(c.state->'messages', '$[*] ? (@.seq > $reached)', jsonb_build_object('reached', f.reached)) ELSE '[]'::jsonb END)
    FROM public.classroom_room_channel c, LATERAL (SELECT CASE WHEN ${cursors.chat}::bigint > c.seq THEN 0::bigint ELSE ${cursors.chat}::bigint END AS reached) f
    WHERE c.lesson_id = ${lessonId} AND c.part = 'chat')`;
  const turn = cursors.turn === undefined ? sql`NULL::jsonb` : sql`(
    SELECT jsonb_build_object('state', c.state, 'deleteAfter', round(extract(epoch FROM c.delete_after) * 1000)) FROM public.classroom_room_channel c WHERE c.lesson_id = ${lessonId} AND c.part = 'turn')`;
  return { board, chat, turn };
}
// The three values as the service takes them.
export function newsFrom(found, cursors) {
  const out = {};
  if (cursors.board !== undefined) out.board = found.board ? { ...found.board, endedAt: found.board.endedAt ?? null } : null;
  if (cursors.chat !== undefined) {
    out.chat = found.chat
      ? { seq: found.chat.seq, base: found.chat.base, endedAt: found.chat.endedAt ?? null, deleteAfter: found.chat.deleteAfter, from: found.chat.from, messages: found.chat.messages.slice(0, CHAT_LIMITS.page), more: found.chat.messages.length > CHAT_LIMITS.page }
      : null;
  }
  if (cursors.turn !== undefined) out.turn = found.turn ?? null;
  return out;
}

export function createPostgresStore(sql) {
  // How often the database was asked, by kind (a "write" is one sending of all a change's writes).
  const calls = { read: 0, write: 0, news: 0, picture: 0, statements: 0 };
  const stamp = (tag, ms) => tag`to_timestamp(${ms}::double precision / 1000)`;

  async function withPart(lessonId, part, work) {
    if (!PARTS.includes(part)) throw new Error(`unknown part: ${part}`);
    return sql.begin(async tx => {
      const pending = [];
      let locked = false;
      // The lock, and with it (in the same sending) the first read.
      const read = async ({ line = null, op = null } = {}) => {
        calls.read += 1;
        const queries = [];
        if (!locked) { locked = true; queries.push(tx`SELECT pg_advisory_xact_lock(hashtextextended(${`ihear-room-channel:${lessonId}:${part}`}, 0))`); }
        queries.push(tx`
          SELECT c.state, round(extract(epoch FROM c.delete_after) * 1000) AS delete_after,
            ${line === null ? tx`NULL::jsonb` : tx`(SELECT jsonb_build_object('by', l.sender, 'color', l.color, 'width', l.width, 'n', l.points, 'parts', l.parts, 'done', l.done, 'beganSeq', l.began_seq, 'clearedBy', l.cleared_by)
                FROM public.classroom_room_board_lines l WHERE l.lesson_id = ${lessonId} AND l.line = ${line})`} AS line,
            ${op === null ? tx`NULL::bigint` : tx`(SELECT o.seq FROM public.classroom_room_board_ops o WHERE o.lesson_id = ${lessonId} AND o.sender = ${op.by} AND o.op = ${op.name})`} AS known
          FROM (SELECT 1) one
          LEFT JOIN public.classroom_room_channel c ON c.lesson_id = ${lessonId} AND c.part = ${part}`);
        calls.statements += queries.length;
        const results = await Promise.all(queries);
        const [found] = results.at(-1);
        return {
          row: found.state === null ? null : { state: found.state, deleteAfter: num(found.delete_after) },
          line: found.state === null ? null : found.line ?? null,
          known: found.state === null ? null : num(found.known),
        };
      };
      const api = {
        async read() { return (await read()).row; },
        // The row, the one line a request names (as kept beside its points) and the place of the
        // operation the person named, in one asking.
        readFor: read,
        write(state, deleteAfter) {
          const seq = part === 'turn' ? state.changes : state.seq;
          pending.push(() => tx`
            INSERT INTO public.classroom_room_channel (lesson_id, part, seq, state, ended_at, last_at, delete_after)
            VALUES (${lessonId}, ${part}, ${seq}, ${tx.json(state)}, ${state.endedAt === null || state.endedAt === undefined ? null : stamp(tx, state.endedAt)}, ${stamp(tx, state.lastAt)}, ${stamp(tx, deleteAfter)})
            ON CONFLICT (lesson_id, part) DO UPDATE SET seq = EXCLUDED.seq, state = EXCLUDED.state, ended_at = EXCLUDED.ended_at, last_at = EXCLUDED.last_at, delete_after = EXCLUDED.delete_after, updated_at = NOW()`);
        },
        effects(list) {
          for (const effect of list) {
            if (effect.type === 'part') {
              const row = effect.line;
              pending.push(() => tx`
                INSERT INTO public.classroom_room_board_lines (lesson_id, line, sender, color, width, parts, points, done, began_seq, cleared_by)
                VALUES (${lessonId}, ${effect.key}, ${row.by}, ${row.color}, ${row.width}, ${row.parts}, ${row.n}, ${row.done}, ${row.beganSeq}, ${row.clearedBy})
                ON CONFLICT (lesson_id, line) DO UPDATE SET parts = EXCLUDED.parts, points = EXCLUDED.points, done = EXCLUDED.done`);
              pending.push(() => tx`INSERT INTO public.classroom_room_board_parts (lesson_id, line, part, points) VALUES (${lessonId}, ${effect.key}, ${effect.part}, ${tx.json(effect.points)})`);
            } else if (effect.type === 'remove') pending.push(() => tx`DELETE FROM public.classroom_room_board_lines WHERE lesson_id = ${lessonId} AND line = ${effect.key}`);
            else if (effect.type === 'hold') pending.push(() => tx`UPDATE public.classroom_room_board_lines SET cleared_by = ${effect.seq} WHERE lesson_id = ${lessonId} AND cleared_by IS NULL`);
            else if (effect.type === 'restore') pending.push(() => tx`UPDATE public.classroom_room_board_lines SET cleared_by = NULL WHERE lesson_id = ${lessonId} AND cleared_by = ${effect.seq}`);
            else if (effect.type === 'drop') pending.push(() => tx`DELETE FROM public.classroom_room_board_lines WHERE lesson_id = ${lessonId} AND cleared_by = ${effect.seq}`);
            else if (effect.type === 'op') pending.push(() => tx`INSERT INTO public.classroom_room_board_ops (lesson_id, seq, sender, op, entry) VALUES (${lessonId}, ${effect.entry.seq}, ${effect.entry.by}, ${effect.op}, ${tx.json(effect.entry)})`);
            else if (effect.type === 'trim') pending.push(() => tx`DELETE FROM public.classroom_room_board_ops WHERE lesson_id = ${lessonId} AND seq <= ${effect.base}`);
            else throw new Error(`unknown effect: ${effect.type}`);
          }
        },
        remove() {
          pending.push(() => tx`DELETE FROM public.classroom_room_channel WHERE lesson_id = ${lessonId} AND part = ${part}`);
          if (part === 'board') {
            pending.push(() => tx`DELETE FROM public.classroom_room_board_lines WHERE lesson_id = ${lessonId}`);
            pending.push(() => tx`DELETE FROM public.classroom_room_board_ops WHERE lesson_id = ${lessonId}`);
          }
        },
      };
      const result = await work(api);
      if (pending.length) {
        calls.write += 1;
        calls.statements += pending.length;
        // Sent together, run in this order on the transaction's one connection.
        await Promise.all(pending.map(step => step()));
      }
      return result;
    });
  }

  // What is new for a person who has reached these places: one statement, one moment.
  async function news(lessonId, cursors) {
    calls.news += 1;
    calls.statements += 1;
    const { board, chat, turn } = newsFragments(sql, lessonId, cursors);
    const [found] = await sql`SELECT ${board} AS board, ${chat} AS chat, ${turn} AS turn`;
    return newsFrom(found, cursors);
  }

  // A board whole: its header and every line with its points, in one statement.
  async function picture(lessonId) {
    calls.picture += 1;
    calls.statements += 1;
    const [found] = await sql`
      SELECT c.state, round(extract(epoch FROM c.delete_after) * 1000) AS delete_after,
        (SELECT coalesce(jsonb_object_agg(l.line, jsonb_build_object('by', l.sender, 'color', l.color, 'width', l.width, 'n', l.points, 'parts', l.parts, 'done', l.done, 'beganSeq', l.began_seq, 'clearedBy', l.cleared_by,
            'points', (SELECT coalesce(jsonb_agg(e.point ORDER BY p.part, e.place), '[]'::jsonb)
                       FROM public.classroom_room_board_parts p, jsonb_array_elements(p.points) WITH ORDINALITY AS e(point, place)
                       WHERE p.lesson_id = l.lesson_id AND p.line = l.line))), '{}'::jsonb)
         FROM public.classroom_room_board_lines l WHERE l.lesson_id = c.lesson_id) AS lines
      FROM public.classroom_room_channel c WHERE c.lesson_id = ${lessonId} AND c.part = 'board'`;
    return found ? { state: found.state, deleteAfter: num(found.delete_after), lines: found.lines } : null;
  }

  async function due(now, limit) {
    calls.statements += 1;
    const rows = await sql`SELECT lesson_id, part FROM public.classroom_room_channel WHERE delete_after <= ${stamp(sql, now)} ORDER BY delete_after LIMIT ${limit}`;
    return rows.map(row => ({ lessonId: row.lesson_id, part: row.part }));
  }
  async function clearsBefore(moment, limit) {
    calls.statements += 1;
    const rows = await sql`
      SELECT lesson_id FROM public.classroom_room_channel
      WHERE part = 'board' AND ended_at IS NULL AND jsonb_typeof(state->'clear') = 'object'
        AND (state->'clear'->>'undone')::boolean IS NOT TRUE AND (state->'clear'->>'at')::bigint < ${moment}
      LIMIT ${limit}`;
    return rows.map(row => row.lesson_id);
  }
  async function open(limit) {
    calls.statements += 1;
    const rows = await sql`SELECT DISTINCT lesson_id FROM public.classroom_room_channel WHERE ended_at IS NULL LIMIT ${limit}`;
    return rows.map(row => row.lesson_id);
  }
  async function stats(now) {
    calls.statements += 1;
    const [found] = await sql`
      SELECT
        (SELECT count(*) FROM public.classroom_room_channel WHERE part = 'board') AS board,
        (SELECT count(*) FROM public.classroom_room_channel WHERE part = 'chat') AS chat,
        (SELECT count(*) FROM public.classroom_room_channel WHERE part = 'turn') AS turn,
        (SELECT count(*) FROM public.classroom_room_channel WHERE delete_after <= ${stamp(sql, now)}) AS overdue,
        (SELECT coalesce(round(extract(epoch FROM (${stamp(sql, now)} - min(delete_after))) * 1000), 0) FROM public.classroom_room_channel WHERE delete_after <= ${stamp(sql, now)}) AS oldest,
        (SELECT count(*) FROM public.classroom_room_board_lines) AS lines,
        (SELECT count(*) FROM public.classroom_room_board_ops) AS operations`;
    return { parts: { board: num(found.board), chat: num(found.chat), turn: num(found.turn) }, overdue: num(found.overdue), oldestOverdueMs: num(found.oldest), lines: num(found.lines), operations: num(found.operations) };
  }

  return { withPart, news, picture, due, clearsBefore, open, stats, calls };
}
