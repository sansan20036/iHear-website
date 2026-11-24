"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";

import { browserClassroomLocale, htmlLangOf, type ClassroomLocale } from "../../../../lib/classroom-locale";
import { ROOM_COPY as COPY } from "./room-copy";

// Classroom 3.0 round 3 (2026-11-21): a fixed room's page. The room's key comes from behind # in the
// teacher's link; this tab keeps it and takes it out of the address at once. A first name asks to
// come in; the page then waits, asking every few seconds; once the iHear teacher lets the person in,
// it opens the room's lesson with the person's own ticket as its key. Nothing here decides who
// comes in: the server and the teacher do.

// pass (Gate B, round 10): a student's own link (#p=) instead of the room's (#k=): no name is typed
// (the room's list gives it); the server answers it only where the site may record fixed rooms.
// lessonId (round 16, the user's choice B): the lesson this tab was taken to, so that lesson's page,
// reloaded without its key, can come back through this door (backAt: when it last did).
type Saved = { key: string | null; pass?: string | null; requestId?: string; ticket?: string; at?: number; lessonId?: string; backAt?: number };
type Phase = "loading" | "form" | "waiting" | "admitted" | "done" | "nolink";
const SAVED = (roomId: string) => `ihear-fixed-room:${roomId}`;
const KEEP_MS = 4 * 60 * 60_000;
const POLL_MS = 3_000;
// Final answers after which the person may enter a name again (a new request).
const ASK_AGAIN = new Set(["expired", "ended"]);

function load(roomId: string): Saved | null {
  try {
    const kept = JSON.parse(sessionStorage.getItem(SAVED(roomId)) ?? "null") as Saved | null;
    return kept && (!kept.at || Date.now() - kept.at < KEEP_MS) ? kept : null;
  } catch {
    return null;
  }
}
function keep(roomId: string, value: Saved) {
  try { sessionStorage.setItem(SAVED(roomId), JSON.stringify(value)); } catch { /* a private window: this page only */ }
}

export default function RoomDoor({ roomId }: { roomId: string }) {
  const [locale, setLocale] = useState<ClassroomLocale>("zhHant");
  const [phase, setPhase] = useState<Phase>("loading");
  const [name, setName] = useState("");
  const [sending, setSending] = useState(false);
  const [problem, setProblem] = useState("");
  const [final, setFinal] = useState("");
  const saved = useRef<Saved>({ key: null });
  const text = COPY[locale];

  useEffect(() => {
    setLocale(browserClassroomLocale());
    const hash = new URLSearchParams(window.location.hash.slice(1));
    const fromHash = hash.get("k");
    const passFromHash = fromHash ? null : hash.get("p");
    if (window.location.hash) history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
    const kept = load(roomId);
    // A link opened again is the same request; a different link (a new one) starts afresh.
    if (passFromHash) saved.current = kept?.pass === passFromHash ? kept : { key: null, pass: passFromHash };
    else saved.current = fromHash && kept?.key !== fromHash ? { key: fromHash } : { ...(kept ?? { key: null }), key: fromHash ?? kept?.key ?? null };
    keep(roomId, saved.current);
    setPhase(saved.current.requestId && saved.current.ticket ? "waiting" : saved.current.key || saved.current.pass ? "form" : "nolink");
  }, [roomId]);
  useEffect(() => { document.documentElement.lang = htmlLangOf(locale); }, [locale]);

  // While waiting: where the request stands, every few seconds (not while the tab is hidden).
  useEffect(() => {
    if (phase !== "waiting") return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // A student's own pass is kept only while it may be needed to ask again (expired, ended); after
    // being let in or a final answer this tab forgets it (round 10 review).
    const forget = (dropPass = false) => { saved.current = { key: saved.current.key, pass: dropPass ? null : saved.current.pass ?? null }; keep(roomId, saved.current); };
    const ask = async () => {
      if (document.hidden) { timer = setTimeout(ask, POLL_MS); return; }
      const { requestId, ticket } = saved.current;
      try {
        const response = await fetch(`/api/classroom/rooms/${encodeURIComponent(roomId)}/door/status`, {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ requestId, ticket }),
        });
        const data = await response.json().catch(() => null);
        if (stopped) return;
        if (response.ok && data?.ok && data.state === "admitted" && typeof data.lessonId === "string" && ticket) {
          saved.current = saved.current.pass ? { key: saved.current.key, requestId, ticket, at: saved.current.at, lessonId: data.lessonId } : { ...saved.current, lessonId: data.lessonId };
          keep(roomId, saved.current);
          setPhase("admitted");
          window.location.assign(`/classroom/${encodeURIComponent(data.lessonId)}#k=${ticket}`);
          return;
        }
        if (response.ok && data?.ok && data.state !== "waiting") {
          const withPass = Boolean(saved.current.pass);
          const again = ASK_AGAIN.has(data.state);
          forget(!again);
          if (again) { setProblem(text.states[data.state] ?? text.error); setPhase("form"); }
          else { setFinal((withPass && data.state === "replaced" ? text.passReplaced : text.states[data.state]) ?? text.error); setPhase("done"); }
          return;
        }
        if (response.status === 404) { forget(); setProblem(text.reasons.NOT_FOUND); setPhase("form"); return; }
        setProblem(response.ok ? "" : text.error);
      } catch {
        if (!stopped) setProblem(text.error);
      }
      if (!stopped) timer = setTimeout(ask, POLL_MS);
    };
    void ask();
    return () => { stopped = true; clearTimeout(timer); };
  }, [phase, roomId, text]);

  async function requestEntry(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const { key, pass } = saved.current;
    if (!key && !pass) { setPhase("nolink"); return; }
    setSending(true);
    setProblem("");
    try {
      const response = await fetch(`/api/classroom/rooms/${encodeURIComponent(roomId)}/door`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(pass ? { pass } : { key, name }),
      });
      const data = await response.json().catch(() => null);
      if (response.ok && data?.ok && typeof data.requestId === "string" && typeof data.ticket === "string") {
        saved.current = { key, pass: pass ?? null, requestId: data.requestId, ticket: data.ticket, at: Date.now() };
        keep(roomId, saved.current);
        setPhase("waiting");
      } else if (data?.code === "LINK_REPLACED") {
        setFinal(text.reasons.LINK_REPLACED);
        setPhase("done");
      } else {
        setProblem((pass && data?.code === "NAME_TAKEN" ? text.passNameTaken : text.reasons[String(data?.code ?? "")]) ?? text.error);
      }
    } catch {
      setProblem(text.error);
    }
    setSending(false);
  }

  return (
    <main className="classroom-room classroom-join" data-room-door={phase}>
      <section className="classroom-room-card classroom-join-card">
        <h1>{text.title}</h1>
        {phase === "nolink" && <p className="classroom-room-problem" role="alert" data-room-problem="nolink">{text.noLink}</p>}
        {phase === "form" && saved.current.pass && (
          <form className="classroom-join-form" onSubmit={requestEntry} data-room-form="pass">
            <p className="classroom-join-note">{text.passNote}</p>
            {problem && <p className="classroom-room-problem" role="alert" data-room-problem>{problem}</p>}
            <button type="submit" className="classroom-room-primary" disabled={sending}>{sending ? text.entering : text.passEnter}</button>
          </form>
        )}
        {phase === "form" && !saved.current.pass && (
          <form className="classroom-join-form" onSubmit={requestEntry} data-room-form>
            <label htmlFor="classroom-room-name">
              <span lang="en">{text.prompt}</span>
              {text.promptLocal && <span>{text.promptLocal}</span>}
            </label>
            <input id="classroom-room-name" name="name" autoComplete="name" autoCapitalize="words" spellCheck={false} maxLength={40} required
              value={name} onChange={(event) => setName(event.target.value)} />
            <p className="classroom-join-note">{text.note}</p>
            {problem && <p className="classroom-room-problem" role="alert" data-room-problem>{problem}</p>}
            <button type="submit" className="classroom-room-primary" disabled={sending || !name.trim()}>{sending ? text.entering : text.enter}</button>
          </form>
        )}
        {phase === "waiting" && (
          <div data-room-waiting>
            <p className="classroom-room-note" role="status">{text.waiting}</p>
            {problem && <p className="classroom-room-problem" role="alert">{problem}</p>}
          </div>
        )}
        {phase === "admitted" && <p className="classroom-room-note" role="status" data-room-admitted>{text.admitted}</p>}
        {phase === "done" && <p className="classroom-room-problem" role="alert" data-room-final>{final}</p>}
      </section>
    </main>
  );
}
