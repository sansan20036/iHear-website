"use client";

import { useEffect, useState, type FormEvent } from "react";

import { doorAt, nextLessonOf, sameWallClock, viewerTimeZone, zonedTimes, type DoorState } from "../../lib/classroom-lobby";
import { parseStudentLink, studentRoomPath } from "../../lib/classroom-link";
import { browserClassroomLocale, htmlLangOf, intlLocaleOf, type ClassroomLocale } from "../../lib/classroom-locale";
import { homeCopy } from "./classroom-home-copy";
import { lobbyCopy } from "./classroom-lobby-copy";
import { LobbyIcon, LobbyNav } from "./classroom-lobby-parts";

// /classroom: what a visitor, a tutor and an administrator see. Until the classroom opens to
// everyone (data/classroom-entry.json), only staff the server confirms through
// /api/classroom/entry see more than "not open yet"; nothing in the address changes that. The
// lessons come from /api/classroom/my-lessons (the signed-in tutor's own, codes and times only);
// entering a room still goes through the room's own entry check. A student either opens the
// personal link from iHear or pastes it here: it is read in this page and never followed.
//
// Classroom 2.1 lobby (2026-11-13): the same answers, laid out as a welcome, the two ways in
// (students with their link, tutors with Google), the three steps to class, a device check (its own
// page: this one may not use the camera or microphone) and where to get help. A signed-in tutor
// sees their lessons first, the next one marked, each in their own time and Taipei's.

type MyLesson = {
  lessonId: string; code: string; startsAt: string; endsAt: string; opensAt: string; closesAt: string;
  state: DoorState; participantCode: string | null; studentCodes: string[];
};
type View =
  | { kind: "loading" } | { kind: "closed"; staffSignIn: boolean } | { kind: "signedOut" } | { kind: "unavailable" }
  | { kind: "mine"; admin: boolean; lessons: MyLesson[] };

const SIGN_IN = `/api/auth/signin?callbackUrl=${encodeURIComponent("/classroom")}`;
const DEVICE_CHECK = "/classroom/device-check";
// The order of a tutor's list: lessons one can enter or will, by time; then the past and cancelled.
const LIST_ORDER: Record<DoorState, number> = { open: 0, before: 1, ended: 2, cancelled: 3 };

export default function ClassroomHome() {
  const [locale, setLocale] = useState<ClassroomLocale>("zhHant");
  const [view, setView] = useState<View>({ kind: "loading" });
  const [preview, setPreview] = useState(false);
  const [pasted, setPasted] = useState("");
  const [pasteProblem, setPasteProblem] = useState(false);
  const [round, setRound] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [zone, setZone] = useState("Asia/Taipei");
  const text = homeCopy[locale];
  const words = lobbyCopy[locale];

  useEffect(() => {
    setLocale(browserClassroomLocale());
    setZone(viewerTimeZone());
    // A lesson's door opens while the list is on screen: the list follows the clock.
    const tick = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(tick);
  }, []);
  useEffect(() => {
    document.documentElement.lang = htmlLangOf(locale);
  }, [locale]);
  useEffect(() => {
    let stopped = false;
    setView({ kind: "loading" });
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
        setNow(Date.now());
      } catch {
        if (!stopped) setView({ kind: "unavailable" });
      }
    })();
    return () => { stopped = true; };
  }, [round]);

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

  const intl = intlLocaleOf(locale);
  const opensAt = (iso: string) => new Intl.DateTimeFormat(intl, { timeZone: zone, month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso));

  const studentPath = (
    <section className="lobby-card lobby-path classroom-student-path" aria-labelledby="lobby-students">
      <div className="lobby-path-head">
        <span className="lobby-path-icon"><LobbyIcon name="link" /></span>
        <h2 id="lobby-students">{text.studentTitle}</h2>
      </div>
      <p>{text.studentPath}</p>
      <form className="classroom-paste" onSubmit={openPasted} noValidate>
        <label htmlFor="classroom-paste-link">{text.pasteLabel}</label>
        <div className="classroom-paste-row">
          <input
            id="classroom-paste-link" type="text" inputMode="url" autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false}
            value={pasted} aria-describedby="classroom-paste-note" placeholder="https://www.ihearus.org/classroom/…"
            onChange={(event) => { setPasted(event.target.value); setPasteProblem(false); }}
          />
          <button type="submit" className="classroom-room-primary">{text.pasteGo}</button>
        </div>
        <p id="classroom-paste-note" className="lobby-muted lobby-with-icon"><LobbyIcon name="shield" />{text.pasteNote}</p>
        {pasteProblem && <p className="classroom-room-problem" role="alert">{text.pasteInvalid}</p>}
      </form>
    </section>
  );

  const tutorPath = (
    <section className="lobby-card lobby-path" aria-labelledby="lobby-tutors">
      <div className="lobby-path-head">
        <span className="lobby-path-icon"><LobbyIcon name="tutor" /></span>
        <h2 id="lobby-tutors">{text.tutorTitle}</h2>
      </div>
      <p>{text.tutorIntro}</p>
      <a className="classroom-room-primary lobby-signin" href={SIGN_IN}>{text.tutorSignIn}</a>
    </section>
  );

  const checkCard = (
    <section className="lobby-card lobby-path lobby-check-card" aria-labelledby="lobby-check">
      <div className="lobby-path-head">
        <span className="lobby-path-icon"><LobbyIcon name="camera" /></span>
        <h2 id="lobby-check">{text.checkCardTitle}</h2>
      </div>
      <p>{text.checkCardText}</p>
      <a className="lobby-button lobby-check-link" href={DEVICE_CHECK}>{text.checkCardLink}<LobbyIcon name="arrow" /></a>
    </section>
  );

  const steps = (
    <section className="lobby-steps-wrap" aria-labelledby="lobby-steps">
      <h2 id="lobby-steps" className="lobby-section-title">{text.stepsTitle}</h2>
      <ol className="lobby-steps">
        <li><span className="lobby-step-icon"><LobbyIcon name="link" /></span><h3>{text.step1Title}</h3><p>{text.step1Text}</p></li>
        <li><span className="lobby-step-icon"><LobbyIcon name="microphone" /></span><h3>{text.step2Title}</h3><p>{text.step2Text}</p></li>
        <li><span className="lobby-step-icon"><LobbyIcon name="enter" /></span><h3>{text.step3Title}</h3><p>{text.step3Text}</p></li>
      </ol>
    </section>
  );

  const lessonRow = (lesson: MyLesson, next: boolean) => {
    const door = doorAt(lesson, lesson.state, now);
    const local = zonedTimes(intl, zone, lesson.startsAt, lesson.endsAt);
    const taipei = sameWallClock(zone, lesson.startsAt, lesson.endsAt) ? null : zonedTimes(intl, "Asia/Taipei", lesson.startsAt, lesson.endsAt);
    return (
      <li key={lesson.lessonId} className={`is-${door.state}${next ? " is-next" : ""}`}>
        <div className="mine-when">
          <span className="mine-date">{local.date}</span>
          <span className="mine-time">{local.range} <small>{local.zone}</small></span>
          {taipei && <span className="mine-taipei">{words.taipeiTime(taipei.zone)} {taipei.range}</span>}
        </div>
        <div className="mine-what">
          {next && <span className="mine-next">{text.next}</span>}
          <strong>{lesson.code}</strong>
          <span>{text.student} {lesson.studentCodes.join("、")}</span>
        </div>
        <span className={`classroom-mine-state lobby-pill is-${door.state}`}>
          {text.state[door.state]}{door.state === "before" ? `（${text.opensAt} ${opensAt(lesson.opensAt)}）` : ""}
        </span>
        {door.state === "open" && <a className="classroom-room-primary mine-enter" href={`/classroom/${encodeURIComponent(lesson.lessonId)}`}>{text.prepare}</a>}
      </li>
    );
  };

  const mine = view.kind === "mine" ? view : null;
  const next = mine ? nextLessonOf(mine.lessons, now) : null;
  const ordered = mine ? [...mine.lessons].sort((a, b) => {
    const left = doorAt(a, a.state, now).state, right = doorAt(b, b.state, now).state;
    return LIST_ORDER[left] - LIST_ORDER[right] || Date.parse(a.startsAt) - Date.parse(b.startsAt);
  }) : [];

  return (
    <main className="classroom-room lobby classroom-home" data-view={view.kind}>
      <LobbyNav locale={locale} onLocale={setLocale} text={words} />
      {preview && view.kind !== "loading" && <p className="classroom-preview-banner" role="note">{text.preview}</p>}

      <section className="lobby-hero" aria-labelledby="lobby-title">
        <div className="lobby-hero-copy">
          <span className="lobby-eyebrow is-light">{text.eyebrow}</span>
          <h1 id="lobby-title">{mine ? text.welcomeBack : text.welcome}</h1>
          <p>{mine ? text.mineIntro : text.welcomeIntro}</p>
        </div>
        <div className="lobby-hero-art" aria-hidden="true">
          <span className="lobby-hero-tile is-main"><LobbyIcon name="tutor" /></span>
          <span className="lobby-hero-tile"><LobbyIcon name="tutor" /></span>
          <span className="lobby-hero-tile is-board" />
          <span className="lobby-hero-bar"><i /><i /><i className="is-leave" /></span>
        </div>
      </section>

      {view.kind === "loading" && <p className="lobby-loading" role="status"><span className="lobby-spinner" aria-hidden="true" />{text.loading}</p>}
      {view.kind === "closed" && (
        <section className="lobby-card lobby-closed">
          <p>{text.closed}</p>
          {view.staffSignIn && <a className="classroom-room-secondary" href={SIGN_IN}>{text.staffSignIn}</a>}
        </section>
      )}
      {view.kind === "unavailable" && (
        <section className="lobby-card lobby-closed">
          <p className="classroom-room-problem" role="alert">{text.unavailable}</p>
          <button type="button" className="lobby-button is-quiet" onClick={() => setRound((value) => value + 1)}>{text.retry}</button>
        </section>
      )}

      {view.kind === "signedOut" && (
        <>
          <div className="lobby-paths">
            {studentPath}
            {tutorPath}
          </div>
          {steps}
          <div className="lobby-check-wide">{checkCard}</div>
        </>
      )}

      {mine && (
        <>
          <section className="lobby-card classroom-mine" aria-labelledby="lobby-mine">
            <div className="lobby-card-head">
              <h2 id="lobby-mine">{text.mine}</h2>
              {mine.admin && <a className="lobby-button is-quiet is-small" href="/admin/classrooms">{text.admin}</a>}
            </div>
            {mine.lessons.length === 0 ? <p className="lobby-muted">{text.empty}</p> : (
              <ul>{ordered.map((lesson) => lessonRow(lesson, next?.lessonId === lesson.lessonId))}</ul>
            )}
          </section>
          <div className="lobby-paths">
            {checkCard}
            {studentPath}
          </div>
        </>
      )}

      <footer className="lobby-foot">
        <p className="lobby-with-icon"><LobbyIcon name="help" />{text.help}</p>
        <a className="lobby-foot-link" href="/">{text.backHome}</a>
      </footer>
    </main>
  );
}
