// The room's own whiteboard, public chat and share turn for the classroom page (local integration
// only, 2026-11-24). The page mounts these for a fixed room's lesson when the join answer says the
// channel is offered; nothing here is used anywhere yet.
//
//   const channel = useRoomChannel({ lessonId, ticket, media });   // once, while the person is in the room
//   <RoomBoard channel={channel} locale={locale} />                 // where the whiteboard goes, when channel.parts?.board
//   <RoomChat channel={channel} locale={locale} />                  // where the chat goes, when channel.parts?.chat
//   channel.share.start() / .stop() / .busy / .mine                 // the page's own share button, when channel.parts?.turn
//   <RoomTurn channel={channel} people={people} locale={locale} />  // who shares now, and handing the share to one person
//                                                                   // (button={false} when the page keeps a share button of its own)
export { default as RoomBoard, BOARD_COLOURS, BOARD_WIDTHS } from "./room-board";
export { default as RoomChat } from "./room-chat";
export { default as RoomTurn, type RoomTurnPerson } from "./room-turn";
export { roomChannelCopy, roomChannelNoticeText } from "./room-channel-copy";
export { useRoomChannel, type RoomChannel, type RoomChannelMedia, type RoomChannelNotice, type RoomChannelParts } from "./use-room-channel";
