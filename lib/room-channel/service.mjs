// The room channel as one service over a store (local integration only, 2026-11-23; every part
// behind its own switch, all off; nothing deployed).
//
// A route (app/api/classroom/[lessonId]/room-channel) decides who is asking and what the lesson's
// facts are, and hands them in; nothing here trusts the request body for either:
//   who     { id, name, member }   the person as the lesson knows them (id and name are what the
//                                  room shows for them; member: in this lesson now)
//   lesson  { id, roomId, scheduledEnd, endedAt, people }
//                                  scheduledEnd: the planned end (ms); endedAt: the end by the
//                                  server's facts, or null while open (retention.mjs: lessonEnd);
//                                  people: the ids of everyone in the lesson now
//   on      { board, chat, turn }  the three switches, as the route read them
//
// One call does a person's whole exchange: what they send (in order), then what is new for them
// after the places they have reached. The store keeps a board's lines apart from its small header
// (board.mjs, "split"), so a stroke costs one line's worth and not the board's.
//
// Whatever is past its time is deleted before it is read (retention.mjs), and a lesson that is
// over is closed on the first request that says so: the whiteboard takes nothing more and starts
// its 24 hours from the lesson's own end, the chat and the share turn are deleted.
import { apply as boardApply, ending as boardEnding, invalidRequest, needsFresh, newBoard, settle, snapshot } from './board.mjs';
import { newChat, post as chatPost } from './chat.mjs';
import { deleteAfter, RETENTION } from './retention.mjs';
import { beat, claim, handOver, leave, newTurn, release, view } from './share-turn.mjs';

export const PARTS = Object.freeze(['board', 'chat', 'turn']);
export const SEND_MAX = 16;   // what one request may carry
const TURN_ACTIONS = { claim, beat, release };
const NOBODY = Object.freeze({ holder: null, since: null, leaseUntil: null, offeredTo: null, offerUntil: null, changes: 0 });
const NOTHING = Object.freeze({ lines: [], undo: null });
const headerOf = state => ({ ...state, lines: {}, names: {} });
const isCursor = value => Number.isInteger(value) && value >= 0;

export function createRoomChannel(store) {
  // Lessons this process has already closed: closing again changes nothing, it only costs.
  const closed = new Map();
  const remember = lessonId => { closed.set(lessonId, true); if (closed.size > 500) closed.delete(closed.keys().next().value); };

  // A row past its time is deleted before anything is done with it.
  const current = async (tx, now) => {
    const row = await tx.read();
    if (row && row.deleteAfter <= now) { tx.remove(); return null; }
    return row;
  };

  async function boardWrite(lesson, who, input, now) {
    return store.withPart(lesson.id, 'board', async tx => {
      // Only what this request touches is fetched, in one asking: the header, the line the request
      // names, and whether the request's own name is known already.
      const inForm = invalidRequest(input) === null;
      const key = !inForm ? null : input.kind === 'stroke' ? `${who.id}:${input.line}` : input.kind === 'erase' ? input.line : null;
      let { row, line, known } = await tx.readFor({ line: key, op: inForm ? { by: who.id, name: input.op } : null });
      // A board past its time is deleted first; the request then begins a new one.
      if (row && row.deleteAfter <= now) { tx.remove(); row = null; line = null; known = null; }
      const header = row?.state ?? newBoard({ roomId: lesson.roomId, lessonId: lesson.id, now, split: true });
      const before = { ...header, lines: line ? { [key]: line } : {}, names: known === null ? {} : { [who.id]: { [input.op]: known } } };
      const { state, answer, effects } = boardApply(before, { by: who.id, member: true, input, now });
      if (state !== before) {
        tx.effects(effects);
        tx.write(headerOf(state), deleteAfter('board', { endedAt: state.endedAt, lastAt: state.lastAt, scheduledEnd: lesson.scheduledEnd }));
      }
      return answer;
    });
  }

  async function chatWrite(lesson, who, input, now) {
    return store.withPart(lesson.id, 'chat', async tx => {
      const row = await current(tx, now);
      const before = row?.state ?? newChat({ roomId: lesson.roomId, lessonId: lesson.id, now });
      const { state, answer } = chatPost(before, { by: who.id, name: who.name, member: true, input, now });
      if (state !== before) tx.write(state, deleteAfter('chat', { endedAt: null, lastAt: state.lastAt, scheduledEnd: lesson.scheduledEnd }));
      return answer;
    });
  }

  async function turnWrite(lesson, who, item, now) {
    const action = item?.action;
    if (action !== 'handOver' && !Object.hasOwn(TURN_ACTIONS, action)) return { ok: false, error: 'UNKNOWN_ACTION' };
    return store.withPart(lesson.id, 'turn', async tx => {
      const row = await current(tx, now);
      const before = row?.state ?? newTurn({ roomId: lesson.roomId, lessonId: lesson.id, now });
      const result = action === 'handOver'
        ? handOver(before, { by: who.id, member: true, to: item.to, toMember: typeof item.to === 'string' && Array.isArray(lesson.people) && lesson.people.includes(item.to), now })
        : TURN_ACTIONS[action](before, { by: who.id, member: true, now });
      if (result.state !== before) tx.write(result.state, deleteAfter('turn', { endedAt: null, lastAt: result.state.lastAt, scheduledEnd: lesson.scheduledEnd }));
      return result.answer;
    });
  }

  // Someone who holds the turn, or to whom it is on offer, is no longer in the lesson (they left,
  // or were taken out): their turn is free at once, without waiting for the lease to run out.
  async function turnUpkeep(lesson, state, now) {
    if (!Array.isArray(lesson.people)) return state;
    const gone = [state.holder?.by, state.offer?.to, state.offer?.from].filter(id => id && !lesson.people.includes(id));
    if (!gone.length) return state;
    return store.withPart(lesson.id, 'turn', async tx => {
      const row = await current(tx, now);
      if (!row) return null;
      let next = row.state;
      for (const id of new Set(gone)) next = leave(next, { by: id, now }).state;
      if (next !== row.state) tx.write(next, deleteAfter('turn', { endedAt: null, lastAt: next.lastAt, scheduledEnd: lesson.scheduledEnd }));
      return next;
    });
  }

  // The lesson is over (lesson.endedAt: when, by the server's facts). The whiteboard takes nothing
  // more, gives up what its latest clear took and keeps the rest for 24 hours from that moment;
  // the chat's messages and the share turn are deleted now.
  async function close(lesson) {
    await store.withPart(lesson.id, 'board', async tx => {
      const row = await tx.read();
      if (!row || row.state.endedAt !== null) return;
      const { state, effects } = boardEnding(row.state, lesson.endedAt);
      tx.effects(effects);
      tx.write(headerOf(state), deleteAfter('board', { endedAt: state.endedAt, lastAt: state.lastAt, scheduledEnd: lesson.scheduledEnd }));
    });
    for (const part of ['chat', 'turn']) await store.withPart(lesson.id, part, async tx => { if (await tx.read()) tx.remove(); });
    remember(lesson.id);
  }

  async function removeIfDue(lessonId, part, now) {
    await store.withPart(lessonId, part, async tx => { await current(tx, now); });
  }

  // One person's exchange: send (in order), then what is new after the places they have reached.
  // cursors: { board, chat, turn }, each the last seq the page has (0 at first); a part left out is
  // not read. send: [{ part: 'board' | 'chat', input } | { part: 'turn', action, to }].
  async function exchange({ lesson, who, on, cursors = {}, send = [], now }) {
    if (!who || who.member !== true || typeof who.id !== 'string') return { ok: false, error: 'NOT_IN_ROOM' };
    if (!Array.isArray(send) || send.length > SEND_MAX) return { ok: false, error: 'TOO_MANY' };
    const ended = lesson.endedAt !== null && lesson.endedAt !== undefined;
    if (ended && !closed.has(lesson.id)) await close(lesson);

    const sent = [];
    for (const item of send) {
      const part = item?.part;
      if (!PARTS.includes(part)) sent.push({ ok: false, error: 'UNKNOWN_PART' });
      else if (!on?.[part]) sent.push({ ok: false, error: 'NOT_OFFERED' });
      else if (ended) sent.push({ ok: false, error: 'LESSON_ENDED' });
      else if (part === 'board') sent.push(await boardWrite(lesson, who, item.input, now));
      else if (part === 'chat') sent.push(await chatWrite(lesson, who, item.input, now));
      else sent.push(await turnWrite(lesson, who, item, now));
    }

    const out = { ok: true, sent };
    const asked = {};
    for (const part of PARTS) {
      if (!on?.[part] || cursors[part] === undefined) continue;
      if (isCursor(cursors[part])) asked[part] = cursors[part];
      else out[part] = { ok: false, error: 'CURSOR' };
    }
    if (!Object.keys(asked).length) return out;
    const seen = await store.news(lesson.id, asked);
    for (const part of Object.keys(asked)) {
      if (seen[part] && seen[part].deleteAfter <= now) { await removeIfDue(lesson.id, part, now); seen[part] = null; }
    }

    if (asked.board !== undefined) {
      const board = seen.board;
      if (!board) out.board = asked.board === 0 ? { ok: true, fresh: false, seq: 0, ended, entries: [] } : { ok: true, fresh: true, picture: { seq: 0, ended, ...NOTHING } };
      else if (board.entries === null) {
        // Away past what is kept (or ahead of a board that began anew): the picture afresh.
        const whole = await store.picture(lesson.id);
        out.board = { ok: true, fresh: true, picture: whole ? snapshot({ ...whole.state, lines: whole.lines }, now) : { seq: 0, ended, ...NOTHING } };
      } else out.board = { ok: true, fresh: false, seq: board.seq, ended: board.endedAt !== null, entries: board.entries };
    }
    if (asked.chat !== undefined) {
      const chat = seen.chat;
      out.chat = chat
        ? { ok: true, seq: chat.seq, ended: chat.endedAt !== null, missed: chat.from < chat.base, messages: chat.messages, more: chat.more }
        : { ok: true, seq: 0, ended, missed: false, messages: [], more: false };
    }
    if (asked.turn !== undefined) {
      const state = seen.turn ? await turnUpkeep(lesson, seen.turn.state, now) : null;
      out.turn = { ok: true, ...(state ? view(state, now) : NOBODY), ended };
    }
    return out;
  }

  // The scheduled sweep (meant to run every RETENTION.sweepEveryMs; scheduled by nobody yet):
  //   1. every part past its time is deleted;
  //   2. a board whose latest clear can no longer be undone gives up what that clear took;
  //   3. lessons that still have something open are looked up (lessonFacts, given by the caller:
  //      it answers { endedAt, scheduledEnd } for a lesson, { gone: true } for one whose record no
  //      longer exists, or null when it cannot say now); those that are over are closed.
  // It answers with what it did and what is still held; overdue should be 0 after every run.
  async function sweep({ now, limit = 200, lessonFacts = null }) {
    const done = { deleted: 0, clearsSettled: 0, lessonsClosed: 0, lessonsNotRead: 0 };
    for (const { lessonId, part } of await store.due(now, limit)) {
      await store.withPart(lessonId, part, async tx => { const row = await tx.read(); if (row && row.deleteAfter <= now) { tx.remove(); done.deleted += 1; } });
    }
    for (const lessonId of await store.clearsBefore(now - RETENTION.undoMs, limit)) {
      await store.withPart(lessonId, 'board', async tx => {
        const row = await tx.read();
        if (!row) return;
        const { state, effects, changed } = settle(row.state, now);
        if (!changed) return;
        tx.effects(effects);
        tx.write(headerOf(state), row.deleteAfter);
        done.clearsSettled += 1;
      });
    }
    if (lessonFacts) {
      for (const lessonId of await store.open(limit)) {
        let facts = null;
        try { facts = await lessonFacts(lessonId); } catch { facts = null; }
        if (!facts) { done.lessonsNotRead += 1; continue; }
        // A lesson whose record is gone cannot be read by anyone: it is closed as of now.
        const endedAt = facts.gone ? now : facts.endedAt ?? null;
        if (endedAt === null) continue;
        await close({ id: lessonId, endedAt, scheduledEnd: facts.gone ? now : facts.scheduledEnd });
        done.lessonsClosed += 1;
      }
    }
    return { ...done, held: await store.stats(now) };
  }

  return { exchange, close, sweep };
}

// Re-exported for the callers that shape requests the same way the service reads them.
export { needsFresh };
