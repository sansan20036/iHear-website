// Whose turn it is to share the screen in a room, server side (design and local tests only,
// 2026-11-23; not wired to any route or page, nothing deployed).
//
// The user's decision of 2026-11-23: our server manages the share turn, and the normal interface
// lets one person share at a time. Zoom itself lets several people of these rooms share at once
// (real test of 2026-11-23: the session's share privilege read as 3, "multiple"), and only a host
// or manager could change that; the rooms have none. So the turn is ours to keep: a page asks for
// it before it starts a share, holds it by saying "still sharing" every few seconds, and gives it
// back when it stops. Every page shows only the share of the person who holds the turn.
//
// What this does NOT do, and must be said plainly: it cannot stop a changed program from starting
// a second share stream on Zoom. Such a stream is carried by Zoom; the other people's pages do not
// show it.
//
// Pure logic: the state goes in with one request and comes out with the answer; the caller says
// who is asking (from the person's own classroom ticket) and whether they are in the room now.

export const TURN_LIMITS = Object.freeze({
  leaseMs: 15_000,     // a holder who has not said "still sharing" for this long has lost the turn (a dropped connection, a closed page)
  beatEveryMs: 5_000,  // how often a page says so
  offerMs: 10_000,     // how long a turn handed over waits for the person it was handed to
});
const PERSON = /^[A-Za-z0-9_-]{1,64}$/;
const refuse = (state, error, more = {}) => ({ state, answer: { ok: false, error, ...more } });
const known = (by, member) => typeof by === 'string' && PERSON.test(by) && member === true;

export function newTurn({ roomId, lessonId, now }) {
  return { version: 1, roomId: String(roomId), lessonId: String(lessonId), changes: 0, holder: null, offer: null, lastAt: now };
}

// What time alone has done: a holder who fell silent has lost the turn, an offer not taken is over.
function settled(before, now) {
  const lapsedHolder = before.holder && now >= before.holder.leaseUntil;
  const lapsedOffer = before.offer && now >= before.offer.until;
  if (!lapsedHolder && !lapsedOffer) return before;
  return { ...before, holder: lapsedHolder ? null : before.holder, offer: lapsedOffer ? null : before.offer, changes: before.changes + 1, lastAt: now };
}
const changed = (state, now, fields) => ({ ...state, ...fields, changes: state.changes + 1, lastAt: now });

// What everyone in the room is told: who holds the turn, and to whom it is on offer.
export function view(before, now) {
  const state = settled(before, now);
  return { holder: state.holder?.by ?? null, since: state.holder?.since ?? null, leaseUntil: state.holder?.leaseUntil ?? null, offeredTo: state.offer?.to ?? null, offerUntil: state.offer?.until ?? null, changes: state.changes };
}

// Asking for the turn, before a share is started.
export function claim(before, { by, member, now }) {
  if (!known(by, member)) return refuse(before, 'NOT_IN_ROOM');
  const state = settled(before, now);
  if (state.holder && state.holder.by !== by) return refuse(state, 'BUSY', { holder: state.holder.by, leaseUntil: state.holder.leaseUntil });
  // A turn handed over waits for the person it was handed to, and for nobody else.
  if (!state.holder && state.offer && state.offer.to !== by) return refuse(state, 'OFFERED_TO_ANOTHER', { offeredTo: state.offer.to, until: state.offer.until });
  const holder = { by, since: state.holder?.since ?? now, leaseUntil: now + TURN_LIMITS.leaseMs };
  const next = changed(state, now, { holder, offer: null });
  return { state: next, answer: { ok: true, turn: view(next, now) } };
}

// "Still sharing", every few seconds. A page told NOT_HOLDER must stop its share at once.
export function beat(before, { by, member, now }) {
  if (!known(by, member)) return refuse(before, 'NOT_IN_ROOM');
  const state = settled(before, now);
  if (!state.holder || state.holder.by !== by) return refuse(state, 'NOT_HOLDER', { holder: state.holder?.by ?? null });
  const next = { ...state, holder: { ...state.holder, leaseUntil: now + TURN_LIMITS.leaseMs }, lastAt: now };
  return { state: next, answer: { ok: true, turn: view(next, now) } };
}

// The share was stopped.
export function release(before, { by, now }) {
  const state = settled(before, now);
  if (!state.holder || state.holder.by !== by) return { state, answer: { ok: true, turn: view(state, now), wasHolder: false } };
  const next = changed(state, now, { holder: null });
  return { state: next, answer: { ok: true, turn: view(next, now), wasHolder: true } };
}

// The person left the room or was taken out of it: their turn is free, and an offer to or from them is over.
export function leave(before, { by, now }) {
  const state = settled(before, now);
  const holds = state.holder?.by === by, offered = state.offer && (state.offer.to === by || state.offer.from === by);
  if (!holds && !offered) return { state, answer: { ok: true, turn: view(state, now) } };
  const next = changed(state, now, { holder: holds ? null : state.holder, offer: offered ? null : state.offer });
  return { state: next, answer: { ok: true, turn: view(next, now) } };
}

// The holder hands the turn to one named person in the room. The holder's own share must stop; the
// turn then waits offerMs for that person and for nobody else, and is free for all after that.
export function handOver(before, { by, member, to, toMember, now }) {
  if (!known(by, member)) return refuse(before, 'NOT_IN_ROOM');
  const state = settled(before, now);
  if (!state.holder || state.holder.by !== by) return refuse(state, 'NOT_HOLDER', { holder: state.holder?.by ?? null });
  if (!known(to, toMember) || to === by) return refuse(state, 'NO_SUCH_PERSON');
  const next = changed(state, now, { holder: null, offer: { to, from: by, until: now + TURN_LIMITS.offerMs } });
  return { state: next, answer: { ok: true, turn: view(next, now) } };
}

// Whether a page shows a share it receives from this person: only the holder's.
export const showsShareOf = (turn, person) => turn.holder !== null && turn.holder === person;
