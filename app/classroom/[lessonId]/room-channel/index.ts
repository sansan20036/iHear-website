// The room's own whiteboard, public chat and share turn for the classroom page (local integration
// only, 2026-11-24). The page mounts these for a fixed room's lesson when the join answer says the
// channel is offered; nothing here is used anywhere yet.
//
//   const channel = useRoomChannel({ lessonId, ticket, media });   // once, while the person is in the room
//   <RoomBoard channel={channel} locale={locale} />                 // where the whiteboard goes, when channel.parts?.board
//   <RoomChat channel={channel} locale={locale} />                  // where the chat goes, when channel.parts?.chat
//   channel.share.start() / .stop() / .busy / .mine                 // the page's own share button, when channel.parts?.turn
import type { ClassroomLocale } from "../../../../lib/classroom-locale";
import { roomChannelCopy } from "./room-channel-copy";
import type { RoomChannelNotice } from "./use-room-channel";

export { default as RoomBoard, BOARD_COLOURS, BOARD_WIDTHS } from "./room-board";
export { default as RoomChat } from "./room-chat";
export { roomChannelCopy } from "./room-channel-copy";
export { useRoomChannel, type RoomChannel, type RoomChannelMedia, type RoomChannelNotice, type RoomChannelParts } from "./use-room-channel";

// The words for the latest refusal, for the page's own places (its share button's line of words).
export function roomChannelNoticeText(locale: ClassroomLocale, notice: RoomChannelNotice | null): string | null {
  if (!notice) return null;
  const text = roomChannelCopy[locale];
  if (notice.code === "LOST") return text.shareLost;
  if (notice.code === "NOT_STARTED") return text.shareNotStarted;
  return text.refused[notice.code] ?? text.refusedOther(notice.code);
}
