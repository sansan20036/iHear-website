// The share turn as the page's own share button uses it (local integration only, 2026-11-24).
// It sits between the room channel's client (who holds the turn, by the server's word) and the
// page's media adapter (the actual share), and keeps one rule: THIS PAGE NEVER SHARES WITHOUT THE
// TURN.
//   start     ask the server for the turn; only with it start the share; if the share does not
//             start (the person closed the browser's own window), the turn goes back at once
//   stop      stop the share, give the turn back
//   lost      the server says the turn is no longer this page's (the connection was away longer
//             than the lease, or the person was taken out): the share is stopped at once
//   others    every page shows only the stream of the person who holds the turn
//   holding   whether THIS page holds the turn for a share of its own (sharing, or the browser's
//             window is open with the turn already got): what a page that goes away gives back
//
// What it cannot do, and must be said plainly: it cannot stop a changed program from starting a
// share on Zoom without the turn. Such a stream is carried by Zoom; pages do not show it.
//
// No browser thing is named here: media is five functions the page gives (startShare, stopShare,
// sharers, onSharersChange, showShareOf), client is lib/room-channel/client.mjs's.

// In a browser the timer functions must be called as the window's own: handed over bare inside an
// object they are refused ("Illegal invocation"; found by the browser check of 2026-11-24).
const BROWSER_TIMER = { set: (work, ms) => setTimeout(work, ms), clear: handle => clearTimeout(handle) };

export function createShareControl({ client, media, timer = BROWSER_TIMER, claimMs = 6000, notify = () => {} }) {
  let sharing = false, claim = null, closed = false, choosing = false;
  const say = more => { notify({ sharing, ...more }); };
  const stopOwn = async why => {
    if (!sharing) return;
    sharing = false;
    say(why ? { notice: why } : {});
    await Promise.resolve(media.stopShare()).catch(() => undefined);
  };
  // The person stopped the share with the browser's own button: Zoom no longer lists them, and the
  // turn goes back at once.
  const unlisten = media.onSharersChange(() => {
    const you = client.view().you;
    if (closed || !sharing || !you || media.sharers().includes(you)) return;
    sharing = false;
    say({});
    client.releaseTurn();
  });

  return {
    get sharing() { return sharing; },
    get holding() { return sharing || choosing; },
    // To be called with every change the client reports (its "changed").
    changed(what) {
      if (closed) return;
      const view = client.view();
      if (claim && (view.turn.mine || what.refused?.some(item => item.part === 'turn'))) { const settle = claim; claim = null; settle(view.turn.mine); }
      if (what.turn === 'lost') void stopOwn('LOST');
      if (what.turn) media.showShareOf(view.turn.holder);
      if (what.stopped) { void stopOwn(null); media.showShareOf(null); }
    },
    // True: the share has started, with the turn. False: it has not (the turn is someone else's,
    // nothing came back in time, the share itself did not start, or the turn was lost meanwhile).
    async start() {
      if (closed || sharing || claim) return false;
      const got = client.view().turn.mine || await new Promise(resolve => {
        const handle = timer.set(() => {
          if (!claim) return;
          claim = null;
          // Nothing came back in time. If the turn arrives after all, it is given back: a turn is never held without a share.
          client.releaseTurn();
          resolve(false);
        }, claimMs);
        claim = value => { timer.clear(handle); resolve(value); };
        client.claimTurn();
      });
      if (closed) return false;
      if (!got) return false;
      choosing = true;
      const started = await Promise.resolve(media.startShare()).catch(() => false);
      choosing = false;
      if (closed) { if (started) await Promise.resolve(media.stopShare()).catch(() => undefined); return false; }
      if (!started) { client.releaseTurn(); say({ notice: 'NOT_STARTED' }); return false; }
      // The browser's own window may have stayed open for long: the turn must still be this page's.
      if (!client.view().turn.mine) { await Promise.resolve(media.stopShare()).catch(() => undefined); say({ notice: 'LOST' }); return false; }
      sharing = true;
      say({});
      return true;
    },
    async stop() {
      const was = sharing;
      sharing = false;
      if (was) say({});
      await Promise.resolve(media.stopShare()).catch(() => undefined);
      client.releaseTurn();
    },
    // Give the turn to one named person; this page's own share stops first.
    async handOver(to) {
      if (sharing) { sharing = false; say({}); await Promise.resolve(media.stopShare()).catch(() => undefined); }
      client.handOver(to);
    },
    // The room is left: nothing is listened to any more, and a turn held is given back.
    close() {
      if (closed) return;
      closed = true;
      unlisten?.();
      if (claim) { const settle = claim; claim = null; settle(false); }
      if (sharing) { sharing = false; client.releaseTurn(); }
    },
  };
}
