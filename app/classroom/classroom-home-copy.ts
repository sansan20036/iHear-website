import type { ClassroomLocale } from "../../lib/classroom-locale";

// The words on /classroom, in English, Traditional and Simplified Chinese (D2, 2026-11-07).
const en = {
  title: "iHear Online Classroom", language: "Language", loading: "Loading…",
  closed: "The online classroom is not open yet.", unavailable: "Your lessons could not be loaded. Please try again later.",
  staffSignIn: "Staff sign-in",
  preview: "Staff preview: the classroom entry is not public yet. Only staff confirmed by the server can see this page.",
  tutorTitle: "Tutors", tutorIntro: "Sign in with the Google account registered with iHear to see your lessons.", tutorSignIn: "Tutors: sign in with Google",
  studentTitle: "Students and families", studentPath: "Please enter with the personal lesson link iHear sent you. If it is lost, ask iHear for a new one.",
  pasteLabel: "Paste your personal lesson link", pasteGo: "Go to the classroom",
  pasteNote: "The link is used only in this browser and is never sent to another site.",
  pasteInvalid: "This is not a valid iHear personal lesson link. Paste the whole link iHear sent you.",
  mine: "My lessons", empty: "You have no lessons right now.", student: "Student", enter: "Enter the classroom", admin: "Manage all lessons",
  state: { before: "Not open yet", open: "Open now", ended: "Ended", cancelled: "Cancelled" },
  opensAt: "Opens",
};

type HomeCopy = typeof en;

const zhHant: HomeCopy = {
  title: "iHear 線上教室", language: "語言", loading: "載入中…",
  closed: "線上教室尚未開放。", unavailable: "暫時無法載入課程，請稍後再試。",
  staffSignIn: "工作人員登入",
  preview: "工作人員預覽：線上教室的入口尚未公開，這個頁面只有經伺服器確認的工作人員看得到。",
  tutorTitle: "小老師", tutorIntro: "用你在 iHear 登記的 Google 帳號登入，就會看到你的課程。", tutorSignIn: "小老師：使用 Google 登入",
  studentTitle: "學生和家長", studentPath: "請使用 iHear 寄給你的個人課程連結進入教室。連結遺失時，請聯絡 iHear 重新發送。",
  pasteLabel: "貼上個人課程連結", pasteGo: "前往教室",
  pasteNote: "連結只在你的瀏覽器裡使用，不會傳送到其他網站。",
  pasteInvalid: "這不是有效的 iHear 個人課程連結。請貼上 iHear 寄給你的完整連結。",
  mine: "我的課程", empty: "目前沒有你的課程。", student: "學生", enter: "進入教室", admin: "管理全部課程",
  state: { before: "尚未開放", open: "可以進入", ended: "已結束", cancelled: "已取消" },
  opensAt: "開放時間",
};

const zhHans: HomeCopy = {
  title: "iHear 线上教室", language: "语言", loading: "加载中…",
  closed: "线上教室尚未开放。", unavailable: "暂时无法加载课程，请稍后再试。",
  staffSignIn: "工作人员登录",
  preview: "工作人员预览：线上教室的入口尚未公开，这个页面只有经服务器确认的工作人员看得到。",
  tutorTitle: "小老师", tutorIntro: "用你在 iHear 登记的 Google 账号登录，就会看到你的课程。", tutorSignIn: "小老师：使用 Google 登录",
  studentTitle: "学生和家长", studentPath: "请使用 iHear 发给你的个人课程链接进入教室。链接遗失时，请联系 iHear 重新发送。",
  pasteLabel: "粘贴个人课程链接", pasteGo: "前往教室",
  pasteNote: "链接只在你的浏览器里使用，不会发送到其他网站。",
  pasteInvalid: "这不是有效的 iHear 个人课程链接。请粘贴 iHear 发给你的完整链接。",
  mine: "我的课程", empty: "目前没有你的课程。", student: "学生", enter: "进入教室", admin: "管理全部课程",
  state: { before: "尚未开放", open: "可以进入", ended: "已结束", cancelled: "已取消" },
  opensAt: "开放时间",
};

export const homeCopy: Record<ClassroomLocale, HomeCopy> = { en, zhHant, zhHans };
