"use client";

import { useEffect, useState } from "react";

// /classroom: what a visitor, a tutor and an administrator see. The lessons come from
// /api/classroom/my-lessons (the signed-in tutor's own, codes and times only); entering a room
// still goes through the room's own entry check.

type Locale = "zh" | "en";
type MyLesson = {
  lessonId: string; code: string; startsAt: string; endsAt: string; opensAt: string; closesAt: string;
  state: "before" | "open" | "ended" | "cancelled"; participantCode: string | null; studentCodes: string[];
};
type View =
  | { kind: "loading" } | { kind: "closed" } | { kind: "signedOut" } | { kind: "unavailable" }
  | { kind: "mine"; admin: boolean; lessons: MyLesson[] };

const SIGN_IN = `/api/auth/signin?callbackUrl=${encodeURIComponent("/classroom")}`;

const copy = {
  zh: {
    title: "iHear 線上教室", other: "English", loading: "載入中…",
    closed: "線上教室尚未開放。", unavailable: "暫時無法載入課程，請稍後再試。",
    tutorTitle: "小老師", tutorIntro: "用你在 iHear 登記的 Google 帳號登入，就會看到你的課程。", tutorSignIn: "小老師：使用 Google 登入",
    studentTitle: "學生和家長", studentPath: "請使用 iHear 寄給你的個人課程連結進入教室。連結遺失時，請聯絡 iHear 重新發送。",
    mine: "我的課程", empty: "目前沒有你的課程。", student: "學生", enter: "進入教室", admin: "管理全部課程",
    state: { before: "尚未開放", open: "可以進入", ended: "已結束", cancelled: "已取消" },
    opensAt: "開放時間",
  },
  en: {
    title: "iHear Online Classroom", other: "中文", loading: "Loading…",
    closed: "The online classroom is not open yet.", unavailable: "Your lessons could not be loaded. Please try again later.",
    tutorTitle: "Tutors", tutorIntro: "Sign in with the Google account registered with iHear to see your lessons.", tutorSignIn: "Tutors: sign in with Google",
    studentTitle: "Students and families", studentPath: "Please enter with the personal lesson link iHear sent you. If it is lost, ask iHear for a new one.",
    mine: "My lessons", empty: "You have no lessons right now.", student: "Student", enter: "Enter the classroom", admin: "Manage all lessons",
    state: { before: "Not open yet", open: "Open now", ended: "Ended", cancelled: "Cancelled" },
    opensAt: "Opens",
  },
};

function initialLocale(): Locale {
  try {
    const stored = localStorage.getItem("ihear-lang");
    if (stored === "en") return "en";
    if (stored === "zhTW" || stored === "zhCN") return "zh";
  } catch {
    // Storage can be blocked; fall back to the browser's language.
  }
  return navigator.language.toLowerCase().startsWith("zh") ? "zh" : "en";
}

export default function ClassroomHome() {
  const [locale, setLocale] = useState<Locale>("zh");
  const [view, setView] = useState<View>({ kind: "loading" });
  const text = copy[locale];

  useEffect(() => {
    setLocale(initialLocale());
  }, []);
  useEffect(() => {
    document.documentElement.lang = locale === "en" ? "en" : "zh-Hant";
  }, [locale]);
  useEffect(() => {
    let stopped = false;
    (async () => {
      try {
        const response = await fetch("/api/classroom/my-lessons", { credentials: "same-origin", cache: "no-store" });
        const data = await response.json().catch(() => ({}));
        if (stopped) return;
        if (response.status === 503 && data?.code === "PROVIDER_UNAVAILABLE") setView({ kind: "closed" });
        else if (response.status === 401) setView({ kind: "signedOut" });
        else if (response.ok && data?.ok) setView({ kind: "mine", admin: data.admin === true, lessons: Array.isArray(data.lessons) ? data.lessons : [] });
        else setView({ kind: "unavailable" });
      } catch {
        if (!stopped) setView({ kind: "unavailable" });
      }
    })();
    return () => { stopped = true; };
  }, []);

  const when = (iso: string) => new Intl.DateTimeFormat(locale === "en" ? "en-GB" : "zh-TW", {
    timeZone: "Asia/Taipei", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(new Date(iso));
  const until = (iso: string) => new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Taipei", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso));

  return (
    <main className="classroom-room classroom-home">
      <header className="classroom-room-head">
        <h1>{text.title}</h1>
        <button type="button" className="classroom-lang" onClick={() => setLocale(locale === "en" ? "zh" : "en")}>{text.other}</button>
      </header>

      {view.kind === "loading" && <p className="classroom-room-muted" role="status">{text.loading}</p>}
      {view.kind === "closed" && <section className="classroom-room-card"><p>{text.closed}</p></section>}
      {view.kind === "unavailable" && <section className="classroom-room-card"><p className="classroom-room-problem" role="alert">{text.unavailable}</p></section>}

      {view.kind === "signedOut" && (
        <section className="classroom-room-card classroom-paths">
          <div>
            <h2>{text.tutorTitle}</h2>
            <p>{text.tutorIntro}</p>
            <a className="classroom-room-primary" href={SIGN_IN}>{text.tutorSignIn}</a>
          </div>
          <div>
            <h2>{text.studentTitle}</h2>
            <p>{text.studentPath}</p>
          </div>
        </section>
      )}

      {view.kind === "mine" && (
        <section className="classroom-room-card classroom-mine" aria-label={text.mine}>
          <h2>{text.mine}</h2>
          {view.lessons.length === 0 ? <p>{text.empty}</p> : (
            <ul>
              {view.lessons.map((lesson) => (
                <li key={lesson.lessonId} className={`is-${lesson.state}`}>
                  <strong>{lesson.code}</strong>
                  <span>{when(lesson.startsAt)}–{until(lesson.endsAt)}</span>
                  <span>{text.student} {lesson.studentCodes.join("、")}</span>
                  <span className="classroom-mine-state">
                    {text.state[lesson.state]}{lesson.state === "before" ? `（${text.opensAt} ${when(lesson.opensAt)}）` : ""}
                  </span>
                  {lesson.state === "open" && <a className="classroom-room-primary" href={`/classroom/${encodeURIComponent(lesson.lessonId)}`}>{text.enter}</a>}
                </li>
              ))}
            </ul>
          )}
          {view.admin && <a className="classroom-room-secondary" href="/admin/classrooms">{text.admin}</a>}
        </section>
      )}
    </main>
  );
}
