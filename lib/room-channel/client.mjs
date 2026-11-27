// The room channel as a page keeps it (local integration only, 2026-11-23; no page uses it yet).
// No browser thing is named here: the page hands in how to send one request and how to wait, so
// the whole of it runs under node --test against the real service.
//
// One request is in flight at a time. Each carries what the page still has to send (in order,
// every item under a name of its own, so that a request sent again counts once on the server) and
// the places the page has reached; the answer brings what is new. So:
//   a lost request or a lost answer   the same items go again with the same names; nothing doubles
//   a dropped connection              the page asks again from where it had reached, a little later
//                                     each time; away past what the server keeps, it is handed the
//                                     picture afresh
//   a refusal                         the item is dropped (and the rest of that line with it), or
//                                     kept and sent later when the server says "too fast"
//   taken out of the room             the channel stops; the page is told why
//
// What the person draws shows on their own page at once (drawn lines not yet confirmed are kept
// beside the confirmed picture); everyone else sees it when the server has taken it.
import { BOARD_LIMITS, moveOn, pictureFrom, shown } from './board.mjs';
import { CHAT_LIMITS } from './chat.mjs';
import { paceFrom, ROOM_PACE, waitFor } from './pace.mjs';
import { TURN_LIMITS } from './share-turn.mjs';

// In a browser the timer functions must be called as the window's own: handed over bare inside an
// object they are refused ("Illegal invocation"; found by the browser check of 2026-11-24).
const BROWSER_TIMER = { set: (work, ms) => setTimeout(work, ms), clear: handle => clearTimeout(handle) };

const SEND_MAX = 16;
// The list of people a page keeps: no more entries, and no longer names, than a room can have.
const PEOPLE_MAX = 200, NAME_MAX = 100;
// What "stopped" says when the page itself stopped asking (the room was left), not the server.
const STOPPED_BY_PAGE = 'stopped by the page';
// Refusals after which an item is not sent again. Anything else that is refused is dropped too,
// except "too fast", which waits.
const LINE_OVER = new Set(['LINE_GONE', 'LINE_DONE', 'OUT_OF_ORDER', 'BOARD_FULL', 'LESSON_ENDED', 'NOT_OFFERED', 'NOT_IN_ROOM']);

// How often a page asks is not here any more (2026-11-27): it is the room's pace, which the
// server says in every answer (./pace.mjs).
export const ROOM_CLIENT = Object.freeze({ retryMs: [500, 1000, 2000, 4000, 8000], chatShown: CHAT_LIMITS.kept });

// A place on the page (in pixels of a box width by height) as a point of the board's own space.
export function toBoard(x, y, width, height) {
  const fit = (value, size) => Math.min(BOARD_LIMITS.coord, Math.max(0, Math.round((value / Math.max(1, size)) * BOARD_LIMITS.coord)));
  return [fit(x, width), fit(y, height)];
}

// post(body) → { status, body } (rejects when nothing came back). key: the person's own ticket.
// timer: { set(fn, ms) → handle, clear(handle) }. now(): the clock. changed(what): the page is
// told that something to show has changed ({ board, chat, turn, people, refused, stopped,
// lessonStatus }).
// pace: figures of the room's pace that this page keeps whatever the server says (the tests' own
// clocks; a page gives none). pollMs and flushMs are the older names for the same: one interval
// for a busy and a quiet room alike, and the gap between a pen's batches.
// lessonStatusEveryMs: when given, the page also asks for the lesson's status this often, in the
// same request (the server answers it as its status route would: { status, body }); 0: never.
export function createRoomClient({ post, key, on = { board: true, chat: true, turn: true }, now = Date.now, timer = BROWSER_TIMER, changed = () => {}, pace: kept = null, pollMs, flushMs, lessonStatusEveryMs = 0 }) {
  let picture = pictureFrom({ seq: 0, lines: [], undo: null });
  let chat = { seq: 0, messages: [], ended: false };
  let turn = { holder: null, offeredTo: null, changes: 0 };
  // Who is in the lesson now, as the server names them (sent with the share turn): [{ id, name }].
  let people = [];
  let you = null, stopped = null, boardEnded = false, inFlight = false, handle = null, dueAt = Infinity, notBefore = 0, failures = 0, waitUntil = 0, lastNews = null, serial = 0, lastBeat = 0, wantsTurn = false, idle = false;
  // The pace: the defaults until the server says its own; what this page was told to keep stays.
  const own = { ...(kept ?? {}), ...(pollMs === undefined ? {} : { activeMs: pollMs, idleMs: pollMs }), ...(flushMs === undefined ? {} : { flushMs }) };
  let pace = Object.freeze({ ...ROOM_PACE, ...own });
  // When this page last sent something of the board (a pen's batches are kept apart), and the
  // lesson's status as the server last answered it, with when it was asked.
  let boardSentAt = -Infinity, lessonStatus = null, statusAt = -Infinity;
  const boardGap = () => Math.max(0, boardSentAt + pace.flushMs - now());
  const session = Math.random().toString(36).slice(2, 8);
  const name = prefix => `${prefix}${session}${(serial += 1).toString(36)}`;
  // Lines this page is drawing: what the pen did and has not been cut into parts yet, the parts cut
  // and waiting in the outbox, and the points to show meanwhile.
  const mine = new Map();     // line name → { color, width, buffer: [points], parts: next part number, done, points: [all points, to show], gone }
  const outbox = [];          // { part, input | action, to, line? }

  const queue = item => { outbox.push(item); kick(0); };
  function cut(line, lineName, done) {
    for (;;) {
      // While the line is open its last point is held back, so that the part that closes the line
      // always has a point of its own to carry (a part must hold at least one) and no point is
      // ever said twice.
      const available = done ? line.buffer.length : line.buffer.length - 1;
      if (available < 1) break;
      const points = line.buffer.splice(0, Math.min(BOARD_LIMITS.pointsPerPart, available));
      // A line may have only so many parts: the last one allowed closes it, and the page begins a new line.
      const last = line.parts === BOARD_LIMITS.partsPerLine - 1;
      const closing = last || (done && line.buffer.length === 0);
      outbox.push({ part: 'board', line: lineName, input: { kind: 'stroke', op: name('s'), line: lineName, part: line.parts, points, color: line.color, width: line.width, done: closing } });
      line.parts += 1;
      if (closing) { line.buffer.length = 0; line.done = true; break; }
    }
  }
  const flush = () => { for (const [lineName, line] of mine) if (!line.done && !line.gone && line.buffer.length) cut(line, lineName, false); };
  const dropLine = lineName => {
    const line = mine.get(lineName);
    if (line) line.gone = true;
    for (let index = outbox.length - 1; index >= 0; index -= 1) if (outbox[index].line === lineName) outbox.splice(index, 1);
    mine.delete(lineName);
  };

  function takeNews(body) {
    const what = {};
    // Who this page is, as the server knows them: told once, so that the page can show it before anything else happens.
    if (typeof body.you === 'string' && body.you !== you) { you = body.you; what.you = true; }
    // The room's pace as the server says it now (inside its bounds; what this page keeps stays).
    if (body.pace && typeof body.pace === 'object') pace = Object.freeze({ ...paceFrom(body.pace, pace), ...own });
    // The lesson's status, when this page asked for it with this request.
    if (body.lessonStatus && Number.isInteger(body.lessonStatus.status)) { lessonStatus = { status: body.lessonStatus.status, body: body.lessonStatus.body ?? null, at: now() }; what.lessonStatus = true; }
    if (Array.isArray(body.people)) {
      const next = body.people.filter(person => typeof person?.id === 'string' && typeof person.name === 'string').slice(0, PEOPLE_MAX).map(person => ({ id: person.id, name: person.name.slice(0, NAME_MAX) }));
      if (next.length !== people.length || next.some((person, index) => person.id !== people[index].id || person.name !== people[index].name)) { people = next; what.people = true; }
    }
    const board = body.board;
    if (board?.ok) {
      const ended = (board.fresh ? board.picture.ended : board.ended) === true;
      if (ended !== boardEnded) { boardEnded = ended; what.board = true; }
      if (board.fresh) { picture = pictureFrom(board.picture); what.board = true; }
      else if (board.entries.length) {
        for (const entry of board.entries) {
          moveOn(picture, entry);
          // A part of this page's own line has come back confirmed: it is in the picture now, and no longer shown from the page's own copy.
          if (entry.kind === 'stroke' && entry.by === you) {
            const line = mine.get(entry.line.slice(entry.line.indexOf(':') + 1));
            if (line) { line.confirmed = (line.confirmed ?? 0) + entry.points.length; if (entry.done) mine.delete(entry.line.slice(entry.line.indexOf(':') + 1)); }
          }
        }
        what.board = true;
      }
    }
    if (body.chat?.ok) {
      if (body.chat.ended && !chat.ended) { chat = { seq: 0, messages: [], ended: true }; what.chat = true; }
      else if (body.chat.seq < chat.seq) { chat = { seq: body.chat.seq, messages: [...body.chat.messages], ended: body.chat.ended }; what.chat = true; }
      else if (body.chat.messages.length) {
        const known = new Set(chat.messages.map(message => message.seq));
        chat = { seq: body.chat.messages.at(-1).seq, ended: body.chat.ended, messages: [...chat.messages, ...body.chat.messages.filter(message => !known.has(message.seq))].slice(-ROOM_CLIENT.chatShown) };
        what.chat = true;
      }
    }
    if (body.turn?.ok && (body.turn.holder !== turn.holder || body.turn.offeredTo !== turn.offeredTo || body.turn.changes !== turn.changes)) {
      // The turn was lost (a dropped connection outlasted the lease, or the person was told so): the page must stop its share.
      const lost = turn.holder === you && you !== null && body.turn.holder !== you;
      turn = { holder: body.turn.holder, offeredTo: body.turn.offeredTo, changes: body.turn.changes, leaseUntil: body.turn.leaseUntil ?? null };
      if (lost) wantsTurn = false;
      what.turn = lost ? 'lost' : true;
    }
    // News of any kind (a line, a message, the turn, who is here): the room counts as active from now.
    if (what.board || what.chat || what.turn || what.people) lastNews = now();
    return what;
  }

  function takeAnswers(sentItems, answers, what) {
    for (const [index, item] of sentItems.entries()) {
      const answer = answers[index];
      const at = outbox.indexOf(item);
      if (!answer) continue;                                      // not answered: it stays, and goes again
      if (answer.ok) { if (at >= 0) outbox.splice(at, 1); continue; }
      if (answer.error === 'TOO_FAST' || answer.error === 'CLEAR_TOO_OFTEN') { waitUntil = Math.max(waitUntil, now() + Math.min(10_000, answer.retryAfterMs ?? 1000)); if (answer.error === 'TOO_FAST') continue; }
      if (at >= 0) outbox.splice(at, 1);
      if (item.line && LINE_OVER.has(answer.error)) dropLine(item.line);
      if (item.part === 'turn' && (answer.error === 'BUSY' || answer.error === 'OFFERED_TO_ANOTHER' || answer.error === 'NOT_HOLDER')) wantsTurn = false;
      (what.refused ??= []).push({ part: item.part, error: answer.error, ...(item.line ? { line: item.line } : {}) });
    }
  }

  async function tick() {
    handle = null;
    dueAt = Infinity;
    if (stopped || inFlight) return;
    flush();
    // The holder says "still sharing" every few seconds, in the same request as everything else.
    if (on.turn && wantsTurn && turn.holder === you && you !== null && now() - lastBeat >= TURN_LIMITS.beatEveryMs && !outbox.some(item => item.part === 'turn')) { outbox.push({ part: 'turn', action: 'beat' }); lastBeat = now(); }
    const sending = now() >= waitUntil ? outbox.slice(0, SEND_MAX) : outbox.filter(item => item.part !== 'board' && item.part !== 'chat').slice(0, SEND_MAX);
    const asksStatus = lessonStatusEveryMs > 0 && now() - statusAt >= lessonStatusEveryMs;
    const body = { key, cursors: { ...(on.board ? { board: picture.seq } : {}), ...(on.chat ? { chat: chat.seq } : {}), ...(on.turn ? { turn: turn.changes } : {}) }, send: sending.map(({ part, input, action, to }) => (part === 'turn' ? { part, action, ...(to ? { to } : {}) } : { part, input })), ...(asksStatus ? { status: true } : {}) };
    if (sending.some(item => item.part === 'board')) boardSentAt = now();
    inFlight = true;
    let answer = null;
    try { answer = await post(body); } catch { answer = null; }
    inFlight = false;
    if (stopped) return;
    const what = {};
    if (!answer || answer.status >= 500 || answer.status === 429) {
      // Nothing came back, or the server could not answer now: the same again, a little later each time.
      failures += 1;
      const wait = ROOM_CLIENT.retryMs[Math.min(failures - 1, ROOM_CLIENT.retryMs.length - 1)];
      notBefore = now() + wait;
      kick(wait);
      return;
    }
    failures = 0;
    notBefore = 0;
    if (answer.status === 403 || answer.status === 404) { stopped = answer.body?.code ?? (answer.status === 404 ? 'NOT_FOUND' : 'NOT_IN_ROOM'); outbox.length = 0; mine.clear(); changed({ stopped }); return; }
    if (answer.status !== 200 || !answer.body?.ok) { for (const item of sending) { const at = outbox.indexOf(item); if (at >= 0) outbox.splice(at, 1); } changed({ refused: [{ part: 'request', error: answer.body?.error ?? `HTTP ${answer.status}` }] }); kick(pace.activeMs); return; }
    if (asksStatus) statusAt = now();
    takeAnswers(sending, answer.body.sent ?? [], what);
    Object.assign(what, takeNews(answer.body));
    if (Object.keys(what).length) changed(what);
    // What is still waiting goes next: at once, or (a pen's parts only) when the batches' gap is over.
    // With nothing waiting, the room's pace says when: a second while there is news, five when it
    // is quiet, longer on a page nobody looks at; never past the next "still sharing".
    const waiting = outbox.length > 0 && now() >= waitUntil;
    const holds = on.turn && wantsTurn && turn.holder === you && you !== null;
    kick(waiting
      ? (outbox.every(item => item.part === 'board') ? boardGap() : 0)
      : waitFor(pace, { sinceNewsMs: lastNews === null ? Infinity : now() - lastNews, hidden: idle, beatInMs: holds ? lastBeat + TURN_LIMITS.beatEveryMs - now() : null }));
  }
  // The next request, ms from now at the latest: an earlier time already set stays; a later one
  // gives way. While the server is not answering, nothing the person does brings it forward.
  function kick(ms) {
    if (stopped) return;
    const at = Math.max(now() + ms, notBefore);
    if (handle !== null) { if (at >= dueAt) return; timer.clear(handle); }
    dueAt = at;
    handle = timer.set(() => { tick(); }, Math.max(0, at - now()));
  }

  return {
    start() { kick(0); },
    stop() { stopped = STOPPED_BY_PAGE; if (handle !== null) timer.clear(handle); handle = null; },
    // The page is not being looked at (hidden tab): it asks less often.
    setIdle(value) { idle = value === true; },
    // --- the whiteboard ---
    beginLine({ color = 0, width = 2 } = {}) { const lineName = name('l'); mine.set(lineName, { color, width, buffer: [], parts: 0, done: false, gone: false, points: [] }); return lineName; },
    addPoints(lineName, points) {
      const line = mine.get(lineName);
      if (!line || line.done || line.gone) return false;
      for (const point of points) { line.buffer.push(point); line.points.push(point); }
      if (line.buffer.length >= BOARD_LIMITS.pointsPerPart) { cut(line, lineName, false); kick(0); } else kick(pace.flushMs);
      return true;
    },
    // The end of a line goes at once, unless a batch of the board went less than the batches' gap
    // ago: quick strokes one after the other are sent together, not one request each.
    endLine(lineName) { const line = mine.get(lineName); if (!line || line.done || line.gone) return; if (!line.points.length) { mine.delete(lineName); return; } cut(line, lineName, true); kick(boardGap()); },
    erase(line) { queue({ part: 'board', input: { kind: 'erase', op: name('e'), line } }); },
    clear() { queue({ part: 'board', input: { kind: 'clear', op: name('c') } }); },
    undoClear() { if (picture.undo) queue({ part: 'board', input: { kind: 'undo', op: name('u'), clear: picture.undo.clear } }); },
    // Round 18m: the board open or closed for everyone in the room (each page may still hide it for itself).
    openBoard(open) { queue({ part: 'board', input: { kind: 'view', op: name('v'), open: open === true } }); },
    // --- the chat (to the whole room; there is no way to name a receiver) ---
    say(text) { if (typeof text === 'string' && text.trim()) queue({ part: 'chat', input: { op: name('m'), text: [...text.trim()].slice(0, CHAT_LIMITS.textLength).join('') } }); },
    // --- the share turn: ask before starting a share; give it back when the share stops ---
    claimTurn() { wantsTurn = true; lastBeat = now(); queue({ part: 'turn', action: 'claim' }); },
    releaseTurn() { wantsTurn = false; queue({ part: 'turn', action: 'release' }); },
    handOver(to) { wantsTurn = false; queue({ part: 'turn', action: 'handOver', to }); },
    // The page is going away (closed, reloaded, the room left): the one request still worth
    // sending, for the page to hand to the browser as it goes, or null when there is none. Only a
    // turn THIS page holds is given back: the turn must be this person's by the server's word, and
    // the caller must say that this page is the one that holds it (the share control knows; "this
    // person's" alone is not enough, their other window may be the one sharing).
    // It reads nothing (no cursors) and is not sent through the queue, which stops with the page.
    parting({ turn: holdsTurn = false } = {}) {
      if (!on.turn || holdsTurn !== true || you === null || turn.holder !== you || (stopped !== null && stopped !== STOPPED_BY_PAGE)) return null;
      wantsTurn = false;
      return { key, cursors: {}, send: [{ part: 'turn', action: 'release' }] };
    },
    // --- what to show ---
    view() {
      // The confirmed lines, then this page's own lines as far as they are not confirmed yet.
      const lines = shown(picture);
      const drawing = [...mine.entries()].filter(([, line]) => !line.gone && line.points.length > (line.confirmed ?? 0)).map(([lineName, line]) => ({ line: `${you ?? 'me'}:${lineName}`, by: you, color: line.color, width: line.width, points: line.points, done: line.done, unconfirmed: true }));
      const confirmedOwn = new Set(drawing.map(line => line.line));
      return {
        you, stopped,
        board: { seq: picture.seq, ended: boardEnded, open: picture.open !== false, lines: [...lines.filter(line => !confirmedOwn.has(line.line)), ...drawing], undo: picture.undo && picture.undo.until > now() ? { clear: picture.undo.clear, until: picture.undo.until } : null },
        chat: { messages: chat.messages, ended: chat.ended },
        turn: { holder: turn.holder, offeredTo: turn.offeredTo, mine: you !== null && turn.holder === you, offeredToMe: you !== null && turn.offeredTo === you },
        people,
        waiting: outbox.length,
      };
    },
    // Whether a share stream coming from this person is to be shown: only the holder's.
    showsShareOf(person) { return turn.holder !== null && turn.holder === person; },
    // The room's pace as this page follows it now, and the lesson's status as the server last
    // answered it ({ status, body, at }; null: never asked, or never answered).
    pace() { return pace; },
    lessonStatus() { return lessonStatus; },
  };
}
