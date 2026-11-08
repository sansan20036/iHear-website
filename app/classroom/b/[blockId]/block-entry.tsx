"use client";

import { useCallback, useEffect, useState } from "react";

import ClassroomEntry from "../../[lessonId]/classroom-entry";

// P3-Multi (2026-11-09): a member's page for a block. It asks the server every few seconds where
// this person belongs (the Lobby, their room, a visit) and shows the classroom for exactly that
// place; when the answer changes (a move, the breakout, a recall), it shows the next one, entering
// it at once once the person has entered before. The page never chooses a room: the server's
// answer and its checks at every door decide, so nothing in the address or the page leads
// elsewhere. A student has no Zoom meeting id or password to type; staff sign in as usual.

type Target = { kind: "wait" | "lobby" | "room" | "ended" | "cancelled"; lessonId: string | null; label: string | null; heldBack?: string };
type Where =
  | { ok: true; block: { code: string; startsAt: string; endsAt: string; phase: string }; member: { code: string; role: string }; target: Target; state: string }
  | { ok: false; code: string; status: number };

const ROLE: Record<string, string> = { manager: "管理老師", lead_tutor: "主要小老師", co_tutor: "協同小老師", observer: "觀察員", student: "學生" };
const STATE: Record<string, string> = {
  ASSIGNED: "已完成分房", WAITING: "在主會議室等待", MOVING: "正在換房", JOINING: "正在進入教室", JOINED: "已進入教室",
  RETURNING: "正在返回主會議室", FAILED: "進入失敗，正在重試", DISCONNECTED: "已離線", REVOKED: "入場資格已撤銷",
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

  useEffect(() => { setKey(takeKey()); }, []);

  const ask = useCallback(async (report?: { state: "failed"; lessonId: string }) => {
    try {
      const response = await fetch(`/api/classroom/blocks/${encodeURIComponent(blockId)}/where`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...(key ? { key } : {}), ...(report ? { report } : {}) }),
      });
      const data = await response.json().catch(() => ({}));
      if (response.ok && data?.ok) setWhere(data as Where);
      else if (response.status !== 429 && response.status < 500) setWhere({ ok: false, code: typeof data?.code === "string" ? data.code : "UNAVAILABLE", status: response.status });
    } catch {
      // A slow network: the next question tries again.
    }
  }, [blockId, key]);

  useEffect(() => {
    if (key === undefined) return;
    void ask();
    const timer = setInterval(() => { void ask(); }, 4000);
    return () => clearInterval(timer);
  }, [key, ask]);

  async function choose(choice: "lobby" | "room") {
    setChoosing(true);
    try {
      await fetch(`/api/classroom/blocks/${encodeURIComponent(blockId)}/choice`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...(key ? { key } : {}), choice }),
      });
    } finally {
      setChoosing(false);
      await ask();
    }
  }

  const signIn = `/api/auth/signin?callbackUrl=${encodeURIComponent(`/classroom/b/${blockId}`)}`;
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
          key={target.lessonId}
          lessonId={target.lessonId}
          synthetic={synthetic}
          joinKey={key ?? null}
          autoEnter={entered}
          roomLabel={target.kind === "lobby" ? "Lobby" : target.label}
          signInPath={`/classroom/b/${blockId}`}
          onEntered={() => setEntered(true)}
          onEntryEnded={(code) => { void ask(ROUTING.has(code) || !target.lessonId ? undefined : { state: "failed", lessonId: target.lessonId }); }}
        />
      )}
    </main>
  );
}
