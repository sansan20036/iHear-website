"use client";

import { useEffect, useState, type FormEvent } from "react";

import { parseStudentLink, studentRoomPath } from "../../lib/classroom-link";
import { browserClassroomLocale, CLASSROOM_LOCALES, htmlLangOf, intlLocaleOf, LOCALE_NAMES, type ClassroomLocale } from "../../lib/classroom-locale";
import { homeCopy } from "./classroom-home-copy";

// /classroom: what a visitor, a tutor and an administrator see. Until the classroom opens to
// everyone (data/classroom-entry.json), only staff the server confirms through
// /api/classroom/entry see more than "not open yet"; nothing in the address changes that. The
// lessons come from /api/classroom/my-lessons (the signed-in tutor's own, codes and times only);
// entering a room still goes through the room's own entry check. A student either opens the
// personal link from iHear or pastes it here: it is read in this page and never followed.

type MyLesson = {
  lessonId: string; code: string; startsAt: string; endsAt: string; opensAt: string; closesAt: string;
  state: "before" | "open" | "ended" | "cancelled"; participantCode: string | null; studentCodes: string[];
};
type View =
  | { kind: "loading" } | { kind: "closed"; staffSignIn: boolean } | { kind: "signedOut" } | { kind: "unavailable" }
  | { kind: "mine"; admin: boolean; lessons: MyLesson[] };

const SIGN_IN = `/api/auth/signin?callbackUrl=${encodeURIComponent("/classroom")}`;

export default function ClassroomHome() {
  const [locale, setLocale] = useState<ClassroomLocale>("zhHant");
  const [view, setView] = useState<View>({ kind: "loading" });
  const [preview, setPreview] = useState(false);
  const [pasted, setPasted] = useState("");
  const [pasteProblem, setPasteProblem] = useState(false);
  const text = homeCopy[locale];

  useEffect(() => {
    setLocale(browserClassroomLocale());
  }, []);
  useEffect(() => {
    document.documentElement.lang = htmlLangOf(locale);
  }, [locale]);
  useEffect(() => {
    let stopped = false;
    (async () => {
      try {
        const entryResponse = await fetch("/api/classroom/entry", { credentials: "same-origin", cache: "no-store" });
        const entry = await entryResponse.json().catch(() => null);
        if (stopped) return;
        if (!entryResponse.ok || !entry) {
          setView({ kind: "unavailable" });
          return;
        }
        // Not open yet, and the server did not confirm this person as staff: nothing more to show.
        if (entry.released !== true && entry.preview !== true) {
          setView({ kind: "closed", staffSignIn: entry.signedIn !== true });
          return;
        }
        setPreview(entry.released !== true);
        const response = await fetch("/api/classroom/my-lessons", { credentials: "same-origin", cache: "no-store" });
        const data = await response.json().catch(() => ({}));
        if (stopped) return;
        if (response.status === 503 && data?.code === "PROVIDER_UNAVAILABLE") setView({ kind: "closed", staffSignIn: false });
        else if (response.status === 401) setView({ kind: "signedOut" });
        else if (response.ok && data?.ok) setView({ kind: "mine", admin: data.admin === true, lessons: Array.isArray(data.lessons) ? data.lessons : [] });
        else setView({ kind: "unavailable" });
      } catch {
        if (!stopped) setView({ kind: "unavailable" });
      }
    })();
    return () => { stopped = true; };
  }, []);

  // A pasted link leads only to this site's room, at an address built from its checked parts.
  // The field is cleared either way, so the key is not left on the page.
  function openPasted(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const link = parseStudentLink(pasted, window.location.origin);
    setPasted("");
    if (!link) {
      setPasteProblem(true);
      return;
    }
    setPasteProblem(false);
    window.location.assign(studentRoomPath(link));
  }

  const when = (iso: string) => new Intl.DateTimeFormat(intlLocaleOf(locale), {
    timeZone: "Asia/Taipei", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(new Date(iso));
  const until = (iso: string) => new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Taipei", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso));

  const studentPath = (
    <div className="classroom-student-path">
      <h2>{text.studentTitle}</h2>
      <p>{text.studentPath}</p>
      <form className="classroom-paste" onSubmit={openPasted} noValidate>
        <label htmlFor="classroom-paste-link">{text.pasteLabel}</label>
        <div className="classroom-paste-row">
          <input
            id="classroom-paste-link" type="text" inputMode="url" autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false}
            value={pasted} aria-describedby="classroom-paste-note"
            onChange={(event) => { setPasted(event.target.value); setPasteProblem(false); }}
          />
          <button type="submit" className="classroom-room-primary">{text.pasteGo}</button>
        </div>
        <p id="classroom-paste-note" className="classroom-room-muted">{text.pasteNote}</p>
        {pasteProblem && <p className="classroom-room-problem" role="alert">{text.pasteInvalid}</p>}
      </form>
    </div>
  );

  return (
    <main className="classroom-room classroom-home">
      <header className="classroom-room-head">
        <h1>{text.title}</h1>
        <div className="classroom-langs" role="group" aria-label={text.language}>
          {CLASSROOM_LOCALES.filter((item) => item !== locale).map((item) => (
            <button key={item} type="button" className="classroom-lang" lang={htmlLangOf(item)} onClick={() => setLocale(item)}>{LOCALE_NAMES[item]}</button>
          ))}
        </div>
      </header>

      {preview && view.kind !== "loading" && <p className="classroom-preview-banner" role="note">{text.preview}</p>}
      {view.kind === "loading" && <p className="classroom-room-muted" role="status">{text.loading}</p>}
      {view.kind === "closed" && (
        <section className="classroom-room-card">
          <p>{text.closed}</p>
          {view.staffSignIn && <a className="classroom-room-secondary" href={SIGN_IN}>{text.staffSignIn}</a>}
        </section>
      )}
      {view.kind === "unavailable" && <section className="classroom-room-card"><p className="classroom-room-problem" role="alert">{text.unavailable}</p></section>}

      {view.kind === "signedOut" && (
        <section className="classroom-room-card classroom-paths">
          <div>
            <h2>{text.tutorTitle}</h2>
            <p>{text.tutorIntro}</p>
            <a className="classroom-room-primary" href={SIGN_IN}>{text.tutorSignIn}</a>
          </div>
          {studentPath}
        </section>
      )}

      {view.kind === "mine" && (
        <>
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
          <section className="classroom-room-card">{studentPath}</section>
        </>
      )}
    </main>
  );
}
