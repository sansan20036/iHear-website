// The room's public chat, server side (design and local tests only, 2026-11-23; not wired to any
// route or page, nothing deployed).
//
// The user's decision of 2026-11-23: the room's chat is relayed by our own server and is public
// only. A message has no receiver: the request has no field for one, and a request that carries
// one is refused, so a private message cannot be sent on this path at all. Messages are kept only
// to reach the people in the room and those who come back after a dropped connection, and are
// deleted when the lesson ends.
//
// What this does NOT do, and must never be said to do: it does not stop two people who both run a
// changed program from using Zoom's own chat channel between themselves. Zoom lets only a host or
// manager switch private messages off, and these rooms have none. The room's page shows nothing
// that arrives on Zoom's chat channel; that is all that can be done about it from here.
//
// Pure logic: the state goes in with one request and comes out with the answer. The caller says who
// is asking and what name the room shows for them (from the person's own classroom ticket, never
// from the request body), and whether they are in the room now.

export const CHAT_LIMITS = Object.freeze({
  textLength: 500,
  perSender: 8,               // messages one person may send in rateWindowMs
  rateWindowMs: 10_000,
  kept: 300,                  // the latest messages kept for people who reconnect
  page: 100,                  // messages handed out at once
  opNamesKept: 100,
  idleMs: 6 * 60 * 60_000,    // a chat nobody ended and nobody used for this long is deleted too
});
const NAME = /^[A-Za-z0-9_-]{1,32}$/;
const PERSON = /^[A-Za-z0-9_-]{1,64}$/;
// Fields a private message would need. Named, so that the refusal says what was asked for.
const RECEIVER_FIELDS = ['to', 'recipient', 'receiver', 'userId', 'user', 'private', 'dm', 'target'];
const refuse = (state, error, more = {}) => ({ state, answer: { ok: false, error, ...more } });

export function newChat({ roomId, lessonId, now }) {
  return { version: 1, roomId: String(roomId), lessonId: String(lessonId), createdAt: now, lastAt: now, endedAt: null, seq: 0, base: 0, messages: [], names: {}, rate: {} };
}

export function invalidMessage(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return 'NOT_AN_OBJECT';
  if (RECEIVER_FIELDS.some(field => Object.hasOwn(input, field))) return 'PRIVATE_NOT_OFFERED';
  const keys = Object.keys(input);
  if (keys.length !== 2 || !Object.hasOwn(input, 'op') || !Object.hasOwn(input, 'text')) return 'FIELDS';
  if (typeof input.op !== 'string' || !NAME.test(input.op)) return 'OP_NAME';
  if (typeof input.text !== 'string') return 'TEXT';
  const text = input.text.trim();
  // Line breaks are kept; other control characters are not text.
  if (text.length < 1 || [...text].length > CHAT_LIMITS.textLength || /[\u0000-\u0009\u000B-\u001F\u007F]/.test(text)) return 'TEXT';
  return null;
}

// One message from one person, to the whole room.
export function post(before, { by, name, member, input, now }) {
  if (typeof by !== 'string' || !PERSON.test(by) || member !== true) return refuse(before, 'NOT_IN_ROOM');
  if (before.endedAt !== null) return refuse(before, 'LESSON_ENDED');
  const problem = invalidMessage(input);
  if (problem) return refuse(before, problem);
  const known = before.names[by]?.[input.op];
  if (known !== undefined) return { state: before, answer: { ok: true, seq: known, duplicate: true } };
  const times = (before.rate[by] ?? []).filter(at => now - at < CHAT_LIMITS.rateWindowMs);
  if (times.length >= CHAT_LIMITS.perSender) return refuse(before, 'TOO_FAST', { retryAfterMs: CHAT_LIMITS.rateWindowMs - (now - times[0]) });

  const state = structuredClone(before);
  state.rate[by] = [...times, now];
  state.seq += 1;
  const message = { seq: state.seq, at: now, by, name: String(name ?? '').slice(0, 60), text: input.text.trim() };
  state.messages.push(message);
  if (state.messages.length > CHAT_LIMITS.kept) state.messages = state.messages.slice(-CHAT_LIMITS.kept);
  state.base = state.messages[0].seq - 1;
  state.lastAt = now;
  const names = { ...(state.names[by] ?? {}), [input.op]: message.seq };
  const kept = Object.keys(names);
  if (kept.length > CHAT_LIMITS.opNamesKept) for (const old of kept.slice(0, kept.length - CHAT_LIMITS.opNamesKept)) delete names[old];
  state.names[by] = names;
  return { state, answer: { ok: true, seq: message.seq, message } };
}

// The messages after the place the asker has reached, for everyone in the room alike. missed says
// that some older ones are no longer kept.
export function since(state, { by, member, cursor }) {
  if (typeof by !== 'string' || member !== true) return { ok: false, error: 'NOT_IN_ROOM' };
  if (!Number.isInteger(cursor) || cursor < 0) return { ok: false, error: 'CURSOR' };
  const from = cursor > state.seq ? 0 : cursor;
  const messages = state.messages.filter(message => message.seq > from).slice(0, CHAT_LIMITS.page);
  return { ok: true, seq: state.seq, ended: state.endedAt !== null, missed: from < state.base, messages, more: state.messages.filter(message => message.seq > from).length > messages.length };
}

// The lesson is over: every message is deleted now, and nothing more is taken.
export function end(before, now) {
  if (before.endedAt !== null) return before;
  return { ...before, endedAt: now, lastAt: now, messages: [], names: {}, rate: {}, base: before.seq };
}
// Whether the caller must delete what is left of this chat now (its count and times only, once ended).
export const expired = (state, now) => state.endedAt !== null || now - state.lastAt >= CHAT_LIMITS.idleMs;
