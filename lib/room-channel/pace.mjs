// The pace of the room channel (2026-11-27): how long a page waits before it asks again, and how
// far apart a pen's points are sent.
//
// Why: the load check on the test site (2026-11-27, 87 people in 10 rooms) counted 193 requests a
// second, 2.2 from every page, because every page asked twice to four times a second whether or
// not anything was happening. The user's decisions of that night: a room with no news for 20
// seconds is asked every 5 seconds (a chat line into a quiet room may take about that long to
// show); while there is news, every second; a pen's points go in batches half a second apart.
//
// The server says the pace in every answer, so it can be changed for the whole site without a new
// page (CLASSROOM_ROOM_CHANNEL_PACE), and each page applies it to what it knows itself: when it
// last heard news, whether it is being looked at, and when it next has to say "still sharing".
// Nothing here reads a clock or a browser: it runs under node --test.

export const ROOM_PACE = Object.freeze({
  activeMs: 1_000,       // between an answer and the next request, while there was news in the last quietAfterMs
  idleMs: 5_000,         // the same, after that
  quietAfterMs: 20_000,  // how long after the last news a room still counts as active
  flushMs: 500,          // a pen's points are sent in batches at least this far apart
  hiddenMs: 15_000,      // a page nobody is looking at (a hidden tab) asks no more often than this
});
// What a figure may be, wherever it comes from: a server's answer or a site's setting can slow a
// page down or speed it up only this far.
const BOUNDS = Object.freeze({ activeMs: [250, 10_000], idleMs: [1_000, 60_000], quietAfterMs: [1_000, 600_000], flushMs: [100, 5_000], hiddenMs: [2_000, 120_000] });
const SHORT = Object.freeze({ active: 'activeMs', idle: 'idleMs', quiet: 'quietAfterMs', flush: 'flushMs', hidden: 'hiddenMs' });

// A pace from whatever is given (a server's answer, a site's setting): each figure that is a whole
// number inside its bounds is taken, every other one stays as it was. A quiet room is never asked
// more often than a busy one.
export function paceFrom(given, before = ROOM_PACE) {
  const pace = { ...before };
  if (given && typeof given === 'object') {
    for (const [name, [least, most]] of Object.entries(BOUNDS)) {
      const value = given[name];
      if (Number.isInteger(value) && value >= least && value <= most) pace[name] = value;
    }
  }
  if (pace.idleMs < pace.activeMs) pace.idleMs = pace.activeMs;
  return Object.freeze(pace);
}

// The site's pace, for the server: the defaults, with whatever CLASSROOM_ROOM_CHANNEL_PACE changes
// ("active=1000,idle=5000,quiet=20000,flush=500,hidden=15000", any of them, in milliseconds).
let read = { text: null, pace: ROOM_PACE };
export function paceOfSite(env = process.env) {
  const text = String(env.CLASSROOM_ROOM_CHANNEL_PACE ?? '');
  if (text === read.text) return read.pace;
  const given = {};
  for (const piece of text.split(',')) {
    const [name, value] = piece.split('=').map(part => part.trim());
    if (SHORT[name] && /^\d{1,7}$/.test(value ?? '')) given[SHORT[name]] = Number(value);
  }
  read = { text, pace: paceFrom(given) };
  return read.pace;
}

// How long a page waits after an answer before it asks again.
//   sinceNewsMs  how long ago this page last heard news (Infinity: never)
//   hidden       nobody is looking at the page
//   beatInMs     when this page next has to say "still sharing" (null: it holds no turn). The
//                turn is lost when that is not said in time, so it is never waited past: not by
//                a quiet room and not by a hidden page (a person who shares another window has
//                the classroom's own page hidden).
export function waitFor(pace, { sinceNewsMs = Infinity, hidden = false, beatInMs = null } = {}) {
  let wait = sinceNewsMs < pace.quietAfterMs ? pace.activeMs : pace.idleMs;
  if (hidden) wait = Math.max(wait, pace.hiddenMs);
  if (beatInMs !== null) wait = Math.min(wait, Math.max(0, beatInMs));
  return wait;
}
