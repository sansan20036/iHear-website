// How long the room channel keeps anything, in one place (local integration only, 2026-11-23).
//
// The user's rules of 2026-11-23 (technical working figures; to be confirmed again before the rooms
// are opened to anyone):
//   a lesson that ended in the ordinary way   whiteboard: deleted within 24 hours after the end
//                                             chat: deleted when the lesson ends
//   a lesson that did not end in that way     whiteboard: at most 48 hours after its last activity
//                                             chat: at most 6 hours after its last activity
//
// What the words mean here:
//   "the end"        the moment the lesson was over by the server's own facts: the iHear teacher
//                    ended it, it was cancelled, or its planned end passed, whichever came first.
//                    It is not the moment somebody noticed: a board first seen as ended an hour
//                    late has an hour less left, never an hour more.
//   "last activity"  the last request the server accepted for that part (a stroke, an erase, a
//                    clear, an undo; a message; a change of the share turn). Reading is not activity.
//   "did not end"    nothing ever told this channel that the lesson was over: nobody came back
//                    after the end and the scheduled sweep could not read the lesson (or does not
//                    run). The planned end still counts, because it is written beside every part
//                    each time the part changes; the "last activity" limits are the net under that.
//
// Every part therefore carries one moment, deleteAfter, set again on every accepted change:
//   whiteboard  ended:  the end + 24 hours
//               open:   the EARLIER of (planned end + 24 hours) and (last activity + 48 hours)
//   chat, turn  ended:  the end itself (the chat's messages are deleted in the same step that
//                       records the end; what is left is deleted by the sweep)
//               open:   the EARLIER of (planned end) and (last activity + 6 hours)
// A part is deleted by whichever comes first: a request that touches it at or after deleteAfter
// (it is deleted before it is read), or the scheduled sweep (service.mjs: sweep), which is meant to
// run every few minutes. If the sweep does not run, nothing overdue is ever handed to anyone, but
// it stays on disk until the next touch: the sweep's own count of what is overdue is the alarm.
//
// A cleared whiteboard: the lines a clear took are kept only so that the clear can be undone, for
// 10 minutes (BOARD_LIMITS.undoWindowMs) and only for the latest clear. They are deleted by the
// next accepted request after that, by the sweep, by a newer clear, or when the lesson ends,
// whichever comes first; an undo after the end is not possible.
import { BOARD_LIMITS } from './board.mjs';
import { CHAT_LIMITS } from './chat.mjs';

export const RETENTION = Object.freeze({
  boardAfterEndMs: BOARD_LIMITS.retentionAfterEndMs,   // 24 hours
  boardIdleMs: BOARD_LIMITS.idleMs,                    // 48 hours
  chatIdleMs: CHAT_LIMITS.idleMs,                      // 6 hours
  turnIdleMs: CHAT_LIMITS.idleMs,                      // the share turn holds no content; it goes with the chat's rule
  undoMs: BOARD_LIMITS.undoWindowMs,                   // 10 minutes
  sweepEveryMs: 5 * 60_000,                            // how often the sweep is meant to run (a proposal, scheduled by nobody yet)
});

// The moment after which a part must be gone. endedAt: the lesson's end as this part knows it
// (null while open). lastAt: the part's last accepted change. scheduledEnd: the lesson's planned
// end as the server read it at that change (a lesson without one counts as having none).
export function deleteAfter(part, { endedAt, lastAt, scheduledEnd }) {
  const planned = Number.isFinite(scheduledEnd) ? scheduledEnd : Infinity;
  if (part === 'board') return endedAt !== null ? endedAt + RETENTION.boardAfterEndMs : Math.min(planned + RETENTION.boardAfterEndMs, lastAt + RETENTION.boardIdleMs);
  const idle = part === 'chat' ? RETENTION.chatIdleMs : RETENTION.turnIdleMs;
  return endedAt !== null ? endedAt : Math.min(planned, lastAt + idle);
}

// The lesson's end as the channel takes it from the lesson's facts: an end the server recorded
// (ended early by the iHear teacher, or cancelled), else the planned end once it has passed, else
// null (still open). Never later than the planned end.
export function lessonEnd({ recordedEnd, scheduledEnd, now }) {
  const planned = Number.isFinite(scheduledEnd) ? scheduledEnd : Infinity;
  if (Number.isFinite(recordedEnd) && recordedEnd !== null) return Math.min(recordedEnd, planned);
  return now >= planned ? planned : null;
}
