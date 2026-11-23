import type { ClassroomLocale } from "../../../../lib/classroom-locale";

// The words of the room's own whiteboard, public chat and share turn (local integration only,
// 2026-11-24), in the page's three languages. Kept beside the pieces that use them.
type Copy = {
  board: string; boardHint: string; pen: string; eraser: string; eraserHint: string; colour: string; colours: string[]; width: string; widths: string[];
  clear: string; clearAsk: string; clearYes: string; clearNo: string; undoClear: string; undoClearUntil: (seconds: number) => string; sending: (count: number) => string;
  chat: string; chatPublic: string; chatDeleted: string; chatEmpty: string; chatLabel: string; chatPlaceholder: string; chatSend: string; chatYou: string; chatEnded: string;
  chatLeft: (count: number) => string;
  shareBusy: string; shareOffered: string; shareLost: string; shareNotStarted: string;
  reconnecting: string; ended: string; stopped: string; notOffered: string;
  refused: Record<string, string>; refusedOther: (code: string) => string;
};

export const roomChannelCopy: Record<ClassroomLocale, Copy> = {
  en: {
    board: "Whiteboard", boardHint: "Everyone in the classroom can draw here.", pen: "Pen", eraser: "Eraser", eraserHint: "Tap a line to erase it.", colour: "Colour",
    colours: ["Black", "Red", "Orange", "Green", "Blue", "Purple", "Pink", "Grey"], width: "Line width", widths: ["Fine", "Medium", "Thick", "Very thick"],
    clear: "Clear all", clearAsk: "Clear the whole whiteboard for everyone?", clearYes: "Clear", clearNo: "Keep", undoClear: "Bring back what was cleared",
    undoClearUntil: (seconds) => `Can be brought back for ${Math.max(1, Math.ceil(seconds / 60))} more min`, sending: (count) => `Sending… (${count})`,
    chat: "Chat", chatPublic: "Messages go to everyone in the classroom. There are no private messages.", chatDeleted: "Messages are deleted when the lesson ends.",
    chatEmpty: "No messages yet.", chatLabel: "Message", chatPlaceholder: "Type a message to everyone", chatSend: "Send", chatYou: "You", chatEnded: "The lesson has ended. The messages were deleted.",
    chatLeft: (count) => `${count} left`,
    shareBusy: "Someone else is sharing now. Please wait until they stop.", shareOffered: "The share was handed to someone else. Please wait a moment.",
    shareLost: "Your share was stopped: the connection was lost for too long.", shareNotStarted: "The share did not start.",
    reconnecting: "Reconnecting…", ended: "The lesson has ended. The whiteboard can still be looked at, but not changed.", stopped: "You are no longer in this classroom.", notOffered: "This is not available in this classroom.",
    refused: {
      TOO_FAST: "Too fast. The rest will be sent in a moment.", BOARD_FULL: "The whiteboard is full. Clear it to go on drawing.", CLEAR_TOO_OFTEN: "The whiteboard was cleared a moment ago. Please wait a little.",
      NOTHING_TO_UNDO: "There is nothing to bring back any more.", NO_SUCH_LINE: "That line is already gone.", LESSON_ENDED: "The lesson has ended.", TEXT: "The message could not be sent as written.",
      BUSY: "Someone else is sharing now. Please wait until they stop.", OFFERED_TO_ANOTHER: "The share was handed to someone else. Please wait a moment.", NOT_HOLDER: "You are not the one sharing now.",
      NO_SUCH_PERSON: "That person is not in the classroom.", NOT_OFFERED: "This is not available in this classroom.",
    },
    refusedOther: (code) => `That did not work (${code}).`,
  },
  zhHant: {
    board: "白板", boardHint: "教室裡的每個人都可以在這裡畫。", pen: "畫筆", eraser: "橡皮擦", eraserHint: "點一條線就會擦掉它。", colour: "顏色",
    colours: ["黑色", "紅色", "橘色", "綠色", "藍色", "紫色", "粉紅色", "灰色"], width: "粗細", widths: ["細", "中", "粗", "很粗"],
    clear: "全部清除", clearAsk: "要清除整塊白板嗎？所有人的白板都會被清除。", clearYes: "清除", clearNo: "保留", undoClear: "復原剛才清除的內容",
    undoClearUntil: (seconds) => `還可以復原 ${Math.max(1, Math.ceil(seconds / 60))} 分鐘`, sending: (count) => `傳送中…（${count}）`,
    chat: "聊天", chatPublic: "訊息會傳給教室裡的所有人，沒有私人訊息。", chatDeleted: "課程結束時訊息會刪除。",
    chatEmpty: "還沒有訊息。", chatLabel: "訊息", chatPlaceholder: "輸入要給所有人的訊息", chatSend: "送出", chatYou: "你", chatEnded: "課程已結束，訊息已刪除。",
    chatLeft: (count) => `還可以輸入 ${count} 個字`,
    shareBusy: "現在有其他人在分享，請等對方停止後再試。", shareOffered: "分享權已交給另一位，請稍等一下。",
    shareLost: "你的分享已停止：連線中斷太久了。", shareNotStarted: "分享沒有開始。",
    reconnecting: "重新連線中…", ended: "課程已結束。白板還可以看，但不能再修改。", stopped: "你已經不在這間教室裡。", notOffered: "這間教室沒有提供這個功能。",
    refused: {
      TOO_FAST: "太快了，剩下的稍後會自動送出。", BOARD_FULL: "白板已經滿了，清除後才能繼續畫。", CLEAR_TOO_OFTEN: "白板剛剛才被清除過，請稍等一下。",
      NOTHING_TO_UNDO: "已經沒有可以復原的內容。", NO_SUCH_LINE: "那條線已經不在了。", LESSON_ENDED: "課程已結束。", TEXT: "這則訊息無法照原樣送出。",
      BUSY: "現在有其他人在分享，請等對方停止後再試。", OFFERED_TO_ANOTHER: "分享權已交給另一位，請稍等一下。", NOT_HOLDER: "現在不是你在分享。",
      NO_SUCH_PERSON: "那位不在教室裡。", NOT_OFFERED: "這間教室沒有提供這個功能。",
    },
    refusedOther: (code) => `沒有成功（${code}）。`,
  },
  zhHans: {
    board: "白板", boardHint: "教室里的每个人都可以在这里画。", pen: "画笔", eraser: "橡皮擦", eraserHint: "点一条线就会擦掉它。", colour: "颜色",
    colours: ["黑色", "红色", "橙色", "绿色", "蓝色", "紫色", "粉红色", "灰色"], width: "粗细", widths: ["细", "中", "粗", "很粗"],
    clear: "全部清除", clearAsk: "要清除整块白板吗？所有人的白板都会被清除。", clearYes: "清除", clearNo: "保留", undoClear: "恢复刚才清除的内容",
    undoClearUntil: (seconds) => `还可以恢复 ${Math.max(1, Math.ceil(seconds / 60))} 分钟`, sending: (count) => `发送中…（${count}）`,
    chat: "聊天", chatPublic: "消息会发给教室里的所有人，没有私人消息。", chatDeleted: "课程结束时消息会删除。",
    chatEmpty: "还没有消息。", chatLabel: "消息", chatPlaceholder: "输入要给所有人的消息", chatSend: "发送", chatYou: "你", chatEnded: "课程已结束，消息已删除。",
    chatLeft: (count) => `还可以输入 ${count} 个字`,
    shareBusy: "现在有其他人在分享，请等对方停止后再试。", shareOffered: "分享权已交给另一位，请稍等一下。",
    shareLost: "你的分享已停止：连接中断太久了。", shareNotStarted: "分享没有开始。",
    reconnecting: "重新连接中…", ended: "课程已结束。白板还可以看，但不能再修改。", stopped: "你已经不在这间教室里。", notOffered: "这间教室没有提供这个功能。",
    refused: {
      TOO_FAST: "太快了，剩下的稍后会自动发出。", BOARD_FULL: "白板已经满了，清除后才能继续画。", CLEAR_TOO_OFTEN: "白板刚刚才被清除过，请稍等一下。",
      NOTHING_TO_UNDO: "已经没有可以恢复的内容。", NO_SUCH_LINE: "那条线已经不在了。", LESSON_ENDED: "课程已结束。", TEXT: "这条消息无法照原样发出。",
      BUSY: "现在有其他人在分享，请等对方停止后再试。", OFFERED_TO_ANOTHER: "分享权已交给另一位，请稍等一下。", NOT_HOLDER: "现在不是你在分享。",
      NO_SUCH_PERSON: "那位不在教室里。", NOT_OFFERED: "这间教室没有提供这个功能。",
    },
    refusedOther: (code) => `没有成功（${code}）。`,
  },
};
