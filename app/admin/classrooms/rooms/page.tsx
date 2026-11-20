"use client";

import { useCallback, useEffect, useState } from "react";
import { useAdmin } from "../../admin-context";

// Classroom 3.0 round 3 (2026-11-21): the fixed rooms, for owners (the iHear teacher). Each room has
// one link, shown once when the room is made or its link replaced. People who open it type a first
// name and wait here; the teacher lets each one in, or not, and may take a person out or end the
// room's lesson. A typed name is not an identity: recognize the person first.

type Person = { request: string; name: string; at: string; code?: string | null; presence?: "in" | "out" | null };
type Room = { id: string; label: string; linkGeneration: number; capacity: number; lesson: { lessonId: string; endsAt: string } | null; waiting: Person[]; inRoom: Person[] };
type Shown = { room: string; link: string } | null;

const ERRORS: Record<string, string> = {
  NOT_FOUND: "固定教室目前沒有開啟（CLASSROOM_FIXED_ROOMS）。",
  INVALID_LABEL: "教室名稱請用英文字母和數字（可以有空格、. 和 '），最多 40 個字，不能有 - 或 _。",
  LABEL_TAKEN: "已經有同名的教室。",
  ROOM_FULL: "教室已經滿了（最多 10 人）。",
  NOT_WAITING: "這位已經不在等待中，畫面已重新整理。",
  NOT_IN_ROOM: "這位已經不在教室裡，畫面已重新整理。",
  NO_LESSON: "這間教室現在沒有在上課。",
  TRY_AGAIN: "同時有很多變動，請再按一次。",
  OWNER_REQUIRED: "需要擁有者權限。",
};
const PRESENCE: Record<string, string> = { in: "在教室裡（Zoom 回報）", out: "已離開（Zoom 回報）" };
const time = (value: string) => new Date(value).toLocaleTimeString("zh-TW", { hour: "2-digit", minute: "2-digit" });

export default function FixedRoomsPage() {
  const { principal } = useAdmin();
  const owner = principal.role === "owner";
  const [rooms, setRooms] = useState<Room[] | null>(null);
  const [off, setOff] = useState(false);
  const [label, setLabel] = useState("");
  const [shown, setShown] = useState<Shown>(null);
  const [problem, setProblem] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const response = await fetch("/api/admin/classrooms/rooms", { cache: "no-store" });
    if (response.status === 404) { setOff(true); return; }
    const data = await response.json().catch(() => ({}));
    if (response.ok && Array.isArray(data?.rooms)) setRooms(data.rooms);
  }, []);
  useEffect(() => {
    if (!owner) return;
    void load();
    const timer = setInterval(() => { void load(); }, 4000);
    return () => clearInterval(timer);
  }, [owner, load]);

  async function act(action: string, input: Record<string, unknown>, confirmText?: string) {
    if (confirmText && !window.confirm(confirmText)) return;
    setBusy(true);
    setProblem("");
    try {
      const response = await fetch("/api/admin/classrooms/rooms", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, ...input }) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) setProblem(ERRORS[data?.code] ?? data?.error ?? "操作失敗。");
      if (response.ok && typeof data?.link === "string") setShown({ room: data.room?.label ?? String(input.room ?? ""), link: data.link });
      await load();
    } finally {
      setBusy(false);
    }
  }

  if (!owner) return <section className="admin-panel"><h1>固定教室</h1><p>需要擁有者權限。</p></section>;
  if (off) return <section className="admin-panel"><h1>固定教室</h1><p role="status" data-rooms-off>{ERRORS.NOT_FOUND}</p></section>;
  return (
    <section className="admin-panel" data-fixed-rooms>
      <h1>固定教室</h1>
      <p role="note">每間教室一個固定連結，每間最多 10 人。打開連結的人輸入英文名字後會在這裡等待，由您讓他進入。名字是自己填的，不是身分：請先用畫面、聲音或詢問認出本人。Zoom 裡顯示的是代碼，不會拿到名字。</p>
      <form onSubmit={(event) => { event.preventDefault(); void act("create", { label }).then(() => setLabel("")); }} aria-label="建立固定教室">
        <label className="admin-field"><span>教室名稱（例如 Room 1）</span><input value={label} onChange={(event) => setLabel(event.target.value)} maxLength={40} /></label>
        <button type="submit" disabled={busy || !label.trim()}>建立教室</button>
      </form>
      {problem && <p role="alert" className="admin-error">{problem}</p>}
      {shown && (
        <div role="status" data-room-link>
          <p>「{shown.room}」的教室連結（只顯示這一次，請直接交給這間教室的人；遺失時請更換連結）：</p>
          <p><code>{`${window.location.origin}${shown.link}`}</code></p>
          <button type="button" onClick={() => setShown(null)}>我已經記下連結</button>
        </div>
      )}
      {rooms === null ? <p>載入中…</p> : rooms.length === 0 ? <p>還沒有固定教室。</p> : rooms.map((room) => (
        <article key={room.id} className="admin-card" data-room={room.label}>
          <h2>{room.label}</h2>
          <p>{room.lesson ? `上課中，最晚到 ${time(room.lesson.endsAt)}` : "目前沒有在上課"}・教室裡 {room.inRoom.length}/{room.capacity} 人・連結第 {room.linkGeneration} 版</p>
          <p>
            <button type="button" disabled={busy} onClick={() => void act("replace_link", { room: room.id }, `更換「${room.label}」的連結？舊連結立刻不能再用來進教室；已經在教室裡的人不受影響。新連結只顯示一次。`)}>更換連結</button>
            {room.lesson && <button type="button" disabled={busy} onClick={() => void act("end_lesson", { room: room.id }, `結束「${room.label}」這次上課？所有人會離開，Session 會結束。`)}>結束這次上課</button>}
          </p>
          <h3>等待中</h3>
          {room.waiting.length === 0 ? <p>沒有人在等待。</p> : (
            <ul data-waiting>
              {room.waiting.map((person) => (
                <li key={person.request} data-waiting-person={person.name}>
                  {person.name}（{time(person.at)}）
                  <button type="button" disabled={busy} onClick={() => void act("admit", { room: room.id, request: person.request })}>讓他進入</button>
                  <button type="button" disabled={busy} onClick={() => void act("decline", { room: room.id, request: person.request }, `不讓「${person.name}」進入？`)}>不讓他進入</button>
                </li>
              ))}
            </ul>
          )}
          <h3>已讓進入</h3>
          {room.inRoom.length === 0 ? <p>還沒有人。</p> : (
            <ul data-in-room>
              {room.inRoom.map((person) => (
                <li key={person.request} data-in-room-person={person.name}>
                  {person.name}（代碼 {person.code}）・{person.presence ? PRESENCE[person.presence] : "是否在線：Zoom 還沒有回報"}
                  <button type="button" disabled={busy} onClick={() => void act("remove", { room: room.id, request: person.request }, `請「${person.name}」離開這間教室？教室會換到新的 Zoom Session，其他人會自動重新連線；他手上的連結不能再進來。`)}>請出教室</button>
                </li>
              ))}
            </ul>
          )}
        </article>
      ))}
    </section>
  );
}
