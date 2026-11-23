// The room channel's three switches (local integration only, 2026-11-23). Each part has its own;
// all are OFF unless set to exactly "on", so a site that sets none of them answers as it does
// today: the route says "not found", nothing is stored, nothing is read.
//
// They are for fixed rooms only (CLASSROOM_FIXED_ROOMS=on is needed as well; the route checks the
// lesson itself too). On the production site they stay unset until the user approves each one;
// the release checks are to refuse them in production until then (tools/classroom-preflight, the
// integrator's list).
export const ROOM_CHANNEL_SWITCHES = Object.freeze({ board: 'CLASSROOM_ROOM_BOARD', chat: 'CLASSROOM_ROOM_CHAT', turn: 'CLASSROOM_ROOM_SHARE_TURN' });

export function roomChannelSwitches(env = process.env) {
  return { board: env[ROOM_CHANNEL_SWITCHES.board] === 'on', chat: env[ROOM_CHANNEL_SWITCHES.chat] === 'on', turn: env[ROOM_CHANNEL_SWITCHES.turn] === 'on' };
}
export const anyOn = on => on.board === true || on.chat === true || on.turn === true;
