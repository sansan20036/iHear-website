"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { classroomDeviceOf } from "../../../../lib/classroom-capabilities";
import ClassroomEntry from "../../[lessonId]/classroom-entry";

// P3-Multi (2026-11-09): a member's page for a block. It asks the server where this person belongs
// (the Lobby, their room, a visit) and shows the classroom for exactly that place; when the answer
// changes (a move, the breakout, a recall), it shows the next one, entering it at once once the
// person has entered before. The page never chooses a room: the server's answer and its checks at
// every door decide, so nothing in the address or the page leads elsewhere. A student has no Zoom
// meeting id or password to type; staff sign in as usual.
//
// Asking (B4): as often as the server suggests (sooner while moving), with a cheap "anything
// changed since version N?" between full answers and a full answer at least every 30 s; not while
// the tab is hidden (once it shows again, at once); with a random delay at the start and a growing
// pause after errors, so a whole class reconnecting does not ask in the same second. One tab per
// person and block (the browser's Web Locks): a second tab with the same link waits and says so,
// and takes over when the first closes or when the person chooses to continue there (the first then
// leaves the classroom). A tab whose link was revoked, or whose block ended, stops asking.

type Target = { kind: "wait" | "lobby" | "room" | "ended" | "cancelled"; lessonId: string | null; label: string | null; heldBack?: string };
type Where =
  | { ok: true; version: number; pollMs: number; roomSize?: number; block: { code: string; startsAt: string; endsAt: string; phase: string }; member: { code: string; role: string }; target: Target; state: string }
  | { ok: false; code: string; status: number };
type Devices = { camera: boolean; microphone: boolean };

const ROLE: Record<string, string> = { manager: "管理老師", lead_tutor: "主要小老師", co_tutor: "協同小老師", observer: "觀察員", student: "學生" };
const STATE: Record<string, string> = {
  ASSIGNED: "已完成分房", WAITING: "在主會議室等待", MOVING: "正在換房", JOINING: "正在進入教室", JOINED: "已進入教室",
  RETURNING: "正在返回主會議室", FAILED: "進入失敗", DISCONNECTED: "已離線", REVOKED: "入場資格已撤銷",
};
const REFUSED: Record<string, string> = {
  IDENTITY_UNVERIFIED: "請先登入。", NOT_ON_ROSTER: "這個連結無法使用（可能已撤銷），請向老師索取新連結。",
  BLOCK_ENDED: "本班次已結束。", BLOCK_CANCELLED: "本班次已取消。", OUTSIDE_JOIN_WINDOW: "現在不是本班次的上課時間。",
  BLOCK_NOT_FOUND: "找不到這個班次。", UNAVAILABLE: "暫時無法連線，稍後會自動重試。",
};
const HELD_BACK: Record<string, string> = {
  CONSENT_REQUIRED_FOR_RECORDING_ROOM: "你的教室正在錄影，而你的錄影同意目前無效，所以先在主會議室等待。請聯絡老師。",
  STAFF_NOTICE_REQUIRED_FOR_RECORDING_ROOM: "該教室正在錄影，而你尚未確認錄影告知，所以先在主會議室等待。",
};
// Codes that mean "ask where to go now" rather than a failure of this page.
const ROUTING = new Set(["NOT_ASSIGNED_HERE", "BLOCK_ENDED", "BLOCK_CANCELLED", "LOBBY_NOT_OPEN", "CONSENT_REQUIRED_FOR_RECORDING_ROOM", "STAFF_NOTICE_REQUIRED_FOR_RECORDING_ROOM"]);
const FULL_EVERY_MS = 30_000;
const HIDDEN_MS = 15_000;
const MOBILE_VIDEOS = 9;
// Answers after which asking again changes nothing for this link.
const TERMINAL = new Set(["NOT_ON_ROSTER", "BLOCK_ENDED", "BLOCK_CANCELLED", "BLOCK_NOT_FOUND"]);
const STOP = -1;

// A short tag for the lock's name, so the key itself is not in it.
function tagOf(key: string | null): string {
  if (!key) return "staff";
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i += 1) hash = Math.imul(hash ^ key.charCodeAt(i), 0x01000193) >>> 0;
  return hash.toString(16);
}

// The personal key from the address (#k=…), taken out of the address bar at once (as the
// one-to-one page does); it lives in this page's memory only.
function takeKey(): string | null {
  const url = new URL(window.location.href);
  const fragment = new URLSearchParams(url.hash.replace(/^#/, ""));
  const key = fragment.get("k");
  if (!key) return null;
  fragment.delete("k");
  const rest = fragment.toString();
  window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${rest ? `#${rest}` : ""}`);
  return key;
}

export default function BlockEntry({ blockId, synthetic }: { blockId: string; synthetic: boolean }) {
  // undefined until the address was read; null for staff (who sign in).
  const [key, setKey] = useState<string | null | undefined>(undefined);
  const [where, setWhere] = useState<Where | null>(null);
  const [entered, setEntered] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [mobile, setMobile] = useState(false);
  // What this person last turned on themselves, offered again after a move (never turned on silently).
  const [wanted, setWanted] = useState<Devices | null>(null);
  const [moved, setMoved] = useState(false);
  const shownLesson = useRef<string | null>(null);
  // Whether this tab is the one that asks and shows the classroom ("checking" until the browser says).
  const [tab, setTab] = useState<"checking" | "this" | "other">("checking");
  const [round, setRound] = useState(0);
  const stealNext = useRef(false);
  const last = useRef<{ version: number | null; fullAt: number; pollMs: number }>({ version: null, fullAt: 0, pollMs: 4_000 });

  useEffect(() => {
    setKey(takeKey());
    setMobile(classroomDeviceOf(navigator.userAgent, navigator.maxTouchPoints) !== "desktop");
  }, []);

  // One question; the answer says how long to wait before the next.
  const ask = useCallback(async (options: { report?: { state: "failed"; lessonId: string }; full?: boolean } = {}): Promise<number | null> => {
    const cheap = !options.full && !options.report && last.current.version != null && Date.now() - last.current.fullAt < FULL_EVERY_MS;
    try {
      const response = await fetch(`/api/classroom/blocks/${encodeURIComponent(blockId)}/where`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...(key ? { key } : {}), ...(options.report ? { report: options.report } : {}), ...(cheap ? { since: last.current.version } : {}) }),
      });
      const data = await response.json().catch(() => ({}));
      if (response.ok && data?.ok && data.unchanged) return last.current.pollMs;
      if (response.ok && data?.ok) {
        last.current = { version: data.version, fullAt: Date.now(), pollMs: Number(data.pollMs) || 4_000 };
        setWhere(data as Where);
        return last.current.pollMs;
      }
      if (response.status !== 429 && response.status < 500) {
        last.current.version = null;
        const code = typeof data?.code === "string" ? data.code : "UNAVAILABLE";
        setWhere({ ok: false, code, status: response.status });
        return TERMINAL.has(code) ? STOP : 30_000;
      }
      return null;
    } catch {
      return null;
    }
  }, [blockId, key]);

  // Done for good (a revoked link, an ended block): this tab lets go of the lock.
  const finished = Boolean(where && !where.ok && TERMINAL.has(where.code));
  useEffect(() => {
    if (key === undefined || finished) return;
    const locks = (navigator as Navigator & { locks?: LockManager }).locks;
    if (!locks?.request) { setTab("this"); return; }
    let active = true;
    let release = () => {};
    const held = new Promise<void>((resolve) => { release = resolve; });
    const controller = new AbortController();
    const steal = stealNext.current;
    stealNext.current = false;
    const waiting = window.setTimeout(() => { if (active) setTab((value) => (value === "this" ? value : "other")); }, 400);
    locks.request(`ihear-block:${blockId}:${tagOf(key)}`, steal ? { steal: true } : { signal: controller.signal }, () => {
      if (!active) return undefined;
      window.clearTimeout(waiting);
      setTab("this");
      return held;
    }).catch(() => {
      // Taken over by another tab: leave the classroom here, and wait to take it back.
      if (!active) return;
      setTab("other");
      setRound((value) => value + 1);
    });
    return () => { active = false; window.clearTimeout(waiting); controller.abort(); release(); };
  }, [blockId, key, round, finished]);

  function continueHere() {
    stealNext.current = true;
    setRound((value) => value + 1);
  }

  useEffect(() => {
    if (key === undefined || tab !== "this") return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    const schedule = (ms: number) => { if (!stopped) timer = setTimeout(run, ms + Math.floor(Math.random() * 500)); };
    const run = async () => {
      if (document.hidden) { schedule(HIDDEN_MS); return; }
      const next = await ask();
      if (next === STOP) return;
      failures = next == null ? failures + 1 : 0;
      schedule(next ?? Math.min(30_000, 2_000 * 2 ** failures));
    };
    // Back on screen: a full answer at once.
    const onVisible = () => { if (!document.hidden) { clearTimeout(timer); last.current.fullAt = 0; void run(); } };
    document.addEventListener("visibilitychange", onVisible);
    schedule(Math.floor(Math.random() * 1_000));
    return () => { stopped = true; clearTimeout(timer); document.removeEventListener("visibilitychange", onVisible); };
  }, [key, ask, tab]);

  // A new place to be: remember that it is a move (for offering the devices again).
  const lessonId = where?.ok ? where.target.lessonId : null;
  useEffect(() => {
    if (lessonId && shownLesson.current && shownLesson.current !== lessonId) setMoved(true);
    if (lessonId) shownLesson.current = lessonId;
  }, [lessonId]);

  async function choose(choice: "lobby" | "room") {
    setChoosing(true);
    try {
      await fetch(`/api/classroom/blocks/${encodeURIComponent(blockId)}/choice`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...(key ? { key } : {}), choice }),
      });
    } finally {
      setChoosing(false);
      await ask({ full: true });
    }
  }

  // Joining failed: ask again, then show the room afresh (the same protected request as entering).
  async function retry() {
    await ask({ full: true });
    setAttempt((value) => value + 1);
  }

  const signIn = `/api/auth/signin?callbackUrl=${encodeURIComponent(`/classroom/b/${blockId}`)}`;
  if (tab === "other" && !finished) {
    return (
      <main className="classroom-room block-entry" data-other-tab>
        <section className="classroom-room-card">
          <p role="status">這個班次已在本瀏覽器的另一個分頁開啟。請使用那個分頁；關閉它後，這裡會自動接手。</p>
          <button type="button" className="classroom-room-secondary" onClick={continueHere}>在這個分頁繼續</button>
        </section>
      </main>
    );
  }
  if (!where) return <main className="classroom-room block-entry"><p role="status">載入中…</p></main>;
  if (!where.ok) {
    return (
      <main className="classroom-room block-entry" data-block-refused={where.code}>
        <section className="classroom-room-card">
          <p className="classroom-room-problem" role="alert">{REFUSED[where.code] ?? REFUSED.UNAVAILABLE}</p>
          {where.code === "IDENTITY_UNVERIFIED" && <a className="classroom-room-primary" href={signIn}>登入</a>}
        </section>
      </main>
    );
  }
  const { block, member, target, state } = where;
  const place = target.kind === "room" ? `教學房間 ${target.label}` : target.kind === "lobby" ? "主會議室" : "等待中";
  const breakout = block.phase === "BREAKOUT";
  return (
    <main className="classroom-room block-entry" data-block-state={state} data-target={target.kind === "room" ? target.label ?? "" : target.kind}>
      <section className="block-entry-head" aria-label="班次">
        <dl className="classroom-room-facts">
          <div><dt>班次</dt><dd>{block.code}</dd></div>
          <div><dt>你</dt><dd>{ROLE[member.role] ?? member.role} {member.code}</dd></div>
          <div><dt>目前位置</dt><dd data-place>{place}</dd></div>
          <div><dt>狀態</dt><dd data-state>{STATE[state] ?? state}</dd></div>
        </dl>
        {target.heldBack && <p className="classroom-room-problem" role="alert">{HELD_BACK[target.heldBack] ?? target.heldBack}</p>}
        {state === "FAILED" && (
          <div className="classroom-room-problem" role="alert" data-join-failed>
            <p>進入教室失敗。系統會繼續重試，你也可以按「重試」；仍然不行時，請先回到主會議室。</p>
            <button type="button" className="classroom-room-secondary" onClick={() => void retry()}>重試</button>
          </div>
        )}
        {mobile && (where.roomSize ?? 0) > MOBILE_VIDEOS && (
          <p className="classroom-room-note" role="note" data-mobile-limit>手機和平板最多同時顯示 {MOBILE_VIDEOS} 個視訊畫面；其他人的畫面會在有空位時出現。</p>
        )}
        {breakout && member.role !== "manager" && (
          <div className="classroom-room-actions">
            {target.kind === "room" && <button type="button" className="classroom-room-secondary" disabled={choosing} onClick={() => void choose("lobby")}>回到主會議室</button>}
            {target.kind === "lobby" && !target.heldBack && <button type="button" className="classroom-room-secondary" disabled={choosing} onClick={() => void choose("room")}>回到我的教室</button>}
          </div>
        )}
      </section>
      {target.kind === "wait" && <section className="classroom-room-card"><p role="status">請稍候，管理老師開放主會議室後就能進入。</p></section>}
      {target.lessonId && (
        <ClassroomEntry
          key={`${target.lessonId}:${attempt}`}
          lessonId={target.lessonId}
          synthetic={synthetic}
          joinKey={key ?? null}
          autoEnter={entered}
          roomLabel={target.kind === "lobby" ? "Lobby" : target.label}
          signInPath={`/classroom/b/${blockId}`}
          restoreDevices={moved ? wanted : null}
          onDevicesChange={setWanted}
          onEntered={() => setEntered(true)}
          onEntryEnded={(code) => { void ask(ROUTING.has(code) || !target.lessonId ? { full: true } : { report: { state: "failed", lessonId: target.lessonId } }); }}
        />
      )}
    </main>
  );
}
