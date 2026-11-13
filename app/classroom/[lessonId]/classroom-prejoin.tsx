"use client";

import { useEffect, useRef, useState } from "react";

import { doorAt, sameWallClock, viewerTimeZone, waitParts, zonedTimes, type PreviewView } from "../../../lib/classroom-lobby";
import { intlLocaleOf, type ClassroomLocale } from "../../../lib/classroom-locale";
import { lobbyCopy } from "../classroom-lobby-copy";
import { DeviceCheck, LobbyIcon, LobbyNav } from "../classroom-lobby-parts";
import { roomCopy } from "./classroom-copy";

// The pre-class screen of a one-to-one lesson (Classroom 2.0 lobby, 2026-11-13): what the personal
// link (or a tutor's "Enter the classroom" from My lessons) opens. It says which lesson this is,
// when (in the visitor's time and Taipei's), as whom, and whether the door is open; it offers a
// device check, and enters only when the person presses the button. Nothing here starts the
// camera, the microphone or a session by itself: entering is still the protected join check
// (ClassroomEntry.enter), and the device check releases what it opened first.

type Phase = "ready" | "joining" | "blocked" | "left";

export default function ClassroomPrejoin({ locale, onLocale, phase, reason, synthetic, preview, onRecheck, onEnter, showSignIn, signInUrl }: {
  locale: ClassroomLocale; onLocale: (locale: ClassroomLocale) => void; phase: Phase; reason: string; synthetic: boolean;
  preview: PreviewView; onRecheck: () => void; onEnter: () => void; showSignIn: boolean; signInUrl: string;
}) {
  const text = roomCopy[locale];
  const words = lobbyCopy[locale];
  const release = useRef<(() => void) | null>(null);
  const page = useRef<HTMLElement | null>(null);
  const bar = useRef<HTMLDivElement | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [zone, setZone] = useState("Asia/Taipei");
  const data = preview.kind === "ready" ? preview.data : null;

  useEffect(() => {
    setZone(viewerTimeZone());
    const tick = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(tick);
  }, []);
  // The door opens on time without a reload: one more look at the clock the moment it does.
  useEffect(() => {
    if (!data) return;
    setNow(Date.now());
    const wait = Date.parse(data.lesson.opensAt) - Date.now();
    if (wait <= 0 || wait > 2 ** 31 - 1) return;
    const timer = setTimeout(() => setNow(Date.now()), wait + 250);
    return () => clearTimeout(timer);
  }, [data]);

  const door = data ? doorAt(data.lesson, data.state, now) : null;
  // The first press: what the server said about this link decides what is offered. After a press
  // (refused, or left the room) the way back in is always offered, as before.
  const firstTry = phase === "ready" || phase === "joining";
  const refusal = firstTry && preview.kind === "refused" ? preview.code : "";
  const showJoin = !firstTry || (!refusal && (!door || door.state === "open" || door.state === "before"));
  const waiting = firstTry && door?.state === "before";
  // Not pressed before the screen knows the door (a moment; an answer that never comes counts as unknown).
  const checking = firstTry && preview.kind === "loading";
  const label = phase === "joining" ? text.entering : phase === "blocked" ? text.retry : phase === "left" ? text.rejoin : text.enter;

  const clock = (iso: string) => new Intl.DateTimeFormat("en-GB", { timeZone: zone, hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso));
  const local = data ? zonedTimes(intlLocaleOf(locale), zone, data.lesson.startsAt, data.lesson.endsAt) : null;
  const taipei = data ? zonedTimes(intlLocaleOf(locale), "Asia/Taipei", data.lesson.startsAt, data.lesson.endsAt) : null;
  const oneZone = data ? sameWallClock(zone, data.lesson.startsAt, data.lesson.endsAt) : true;
  const wait = door ? waitParts(door.msToOpen) : null;
  const description = !door || !data ? ""
    : door.state === "before" ? words.before(clock(data.lesson.opensAt), words.waitText(wait!.days, wait!.hours, wait!.minutes))
      : door.state === "open" ? (door.stage === "early" ? words.early(clock(data.lesson.startsAt)) : door.stage === "live" ? words.live(clock(data.lesson.endsAt)) : words.overtime(clock(data.lesson.closesAt)))
        : door.state === "ended" ? words.ended : words.cancelled;
  const pill = !door ? "" : door.state === "open" ? (door.stage === "live" ? words.state.live : door.stage === "overtime" ? words.state.overtime : words.state.open) : words.state[door.state];

  // On a phone the way in is a bar fixed to the bottom of the screen: the page ends that much lower,
  // so nothing stays under it, whatever the bar holds (a reason, the time the door opens).
  useEffect(() => {
    const element = bar.current, shell = page.current;
    if (!element || !shell || typeof ResizeObserver === "undefined") return;
    const update = () => shell.style.setProperty("--prejoin-bar", `${Math.ceil(element.getBoundingClientRect().height)}px`);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [showJoin, phase]);

  function enter() {
    // The camera and microphone the check opened go back first, for the video service.
    release.current?.();
    onEnter();
  }

  return (
    <main ref={page} className="classroom-room lobby prejoin" data-door={door?.state ?? preview.kind} data-phase={phase} data-bar={showJoin ? "on" : "off"}>
      <LobbyNav locale={locale} onLocale={onLocale} text={words}>
        <a className="lobby-nav-link" href="/classroom">{words.toLobby}</a>
      </LobbyNav>
      {synthetic && <p className="classroom-room-note" role="note">{text.synthetic}</p>}
      <div className="prejoin-grid">
        <section className="lobby-card prejoin-lesson" aria-labelledby="prejoin-title" aria-busy={preview.kind === "loading"}>
          <div className="prejoin-head">
            <span className="lobby-eyebrow">{words.eyebrow}</span>
            <h1 id="prejoin-title">{words.title}</h1>
            <p className="lobby-muted">{words.intro}</p>
          </div>
          {firstTry && preview.kind === "loading" && (
            <p className="prejoin-checking" role="status"><span className="lobby-spinner" aria-hidden="true" />{words.checking}</p>
          )}
          {firstTry && door && (
            <div className={`prejoin-door is-${door.state}`} data-stage={door.stage ?? ""}>
              <span className={`lobby-pill is-${door.state}`}>{pill}</span>
              <p>{description}</p>
            </div>
          )}
          {data && local && taipei && (
            <dl className="prejoin-facts">
              <div><dt>{words.lesson}</dt><dd>{data.lesson.code}</dd></div>
              <div><dt>{words.you}</dt><dd>{data.role === "tutor" ? words.tutor : words.student} {data.participantCode}</dd></div>
              {data.with && data.with.codes.length > 0 && (
                <div className="is-wide"><dt>{data.with.role === "tutor" ? words.tutor : words.student}</dt><dd>{data.with.codes.join(words.separator)}</dd></div>
              )}
              <div className="is-wide">
                <dt>{oneZone ? words.time : words.yourTime(local.zone)}</dt>
                <dd><span className="prejoin-date">{local.date}</span><span className="prejoin-range">{local.range}{oneZone && <span className="prejoin-zone"> {local.zone}</span>}</span></dd>
              </div>
              {!oneZone && (
                <div className="is-wide is-second">
                  <dt>{words.taipeiTime(taipei.zone)}</dt>
                  <dd><span className="prejoin-date">{taipei.date}</span><span className="prejoin-range">{taipei.range}</span></dd>
                </div>
              )}
            </dl>
          )}
          {refusal && (
            <div className="prejoin-refusal">
              <p className="classroom-room-problem" role="alert">{text.reasons[refusal] ?? text.reasons.UNAVAILABLE}</p>
              {refusal === "NOT_ON_ROSTER" && <p className="lobby-muted">{words.reloadHint}</p>}
              {refusal === "NOT_ON_ROSTER" && <div className="classroom-room-actions"><a className="classroom-room-secondary" href={signInUrl}>{text.signIn}</a></div>}
              {refusal === "PROVIDER_UNAVAILABLE" && <div className="classroom-room-actions"><button type="button" className="lobby-button is-quiet" onClick={onRecheck}>{words.recheck}</button></div>}
            </div>
          )}
          {firstTry && preview.kind === "unknown" && !preview.quiet && (
            <div className="prejoin-unknown">
              <p className="lobby-muted">{words.unknown}</p>
              <button type="button" className="lobby-button is-quiet is-small" onClick={onRecheck}>{words.recheck}</button>
            </div>
          )}
        </section>

        {showJoin && (
          <div ref={bar} className="lobby-card prejoin-join" aria-live="polite">
            {phase === "left" && <p className="prejoin-left">{text.left}</p>}
            {phase === "blocked" && <p className="classroom-room-problem" role="alert">{text.reasons[reason] ?? text.reasons.UNAVAILABLE}</p>}
            <div className="prejoin-join-row">
              <button type="button" className="classroom-room-primary prejoin-enter" disabled={phase === "joining" || waiting || checking} aria-describedby="prejoin-join-note" onClick={enter}>
                <LobbyIcon name="enter" />{label}
              </button>
              {showSignIn && <a className="classroom-room-secondary" href={signInUrl}>{text.signIn}</a>}
            </div>
            <p id="prejoin-join-note" className="lobby-muted prejoin-note">
              {waiting && data ? words.opensAt(clock(data.lesson.opensAt)) : <><span className="prejoin-note-full">{words.enterNote}</span><span className="prejoin-note-short">{words.enterNoteShort}</span></>}
            </p>
            {!waiting && <p className="lobby-muted prejoin-recording">{words.recordingNote}</p>}
          </div>
        )}

        <DeviceCheck text={words} releaseRef={release} />
      </div>
      <a className="lobby-phone-link" href="/classroom">{words.toLobby}</a>
    </main>
  );
}
