"use client";

import { useCallback, useEffect, useState } from "react";
import { useAdmin } from "../../admin-context";
import { bulkRange, exportInParts, linksCsv, roomsToShow, type LinkRow } from "./room-links";

// Classroom 3.0 round 3 (2026-11-21): the fixed rooms, for owners (the iHear teacher). Each room has
// one link, shown once when the room is made or its link replaced. People who open it type a first
// name and wait here; the teacher lets each one in, or not, and may take a person out or end the
// room's lesson. A typed name is not an identity: recognize the person first.
//
// Many rooms (the teacher asked for 100, named Room1, Room2, …): rooms are made in bulk, their links
// come once as a list to download (made in this browser; never sent back, stored or logged), the
// list can be narrowed to the rooms with somebody, and every room's recording switch can be set at
// once where the site allows fixed rooms to record at all.

type Person = { request: string; name: string; at: string; code?: string | null; presence?: "in" | "out" | null };
type Room = { id: string; label: string; linkGeneration: number; capacity: number; recording?: { on: boolean; available: boolean }; lesson: { lessonId: string; endsAt: string } | null; waiting: Person[]; inRoom: Person[] };
type Shown = { room: string; link: string } | null;
type LinkList = { title: string; rows: LinkRow[]; failed: string[] } | null;

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
  INVALID_BULK: "請填名稱開頭，以及從幾號到幾號（從 1 開始的整數）。",
  TOO_MANY: "一次最多 100 間。",
  DUPLICATE_LABEL: "名稱重複了。",
  NO_ROOMS: "還沒有固定教室。",
  NO_SUCH_ROOM: "找不到這間教室，畫面已重新整理。",
  CHANGED_CONCURRENTLY: "連結剛剛被別人更換了，請再看一次。",
  INVALID_SWITCH: "請選擇開啟或關閉。",
  RECORDING_NOT_AVAILABLE: "這個網站目前沒有開啟固定教室的錄影。",
  RECORDING_MAY_BE_ON: "這間教室可能正在錄影：請先結束這次上課，再關閉錄影。",
  CONNECTION_LOST: "連線中斷，沒有收到結果。請再看一次教室清單；已經建立或更換、但沒有拿到連結的教室，請用「重新產生全部連結並下載」。",
};
const PRESENCE: Record<string, string> = { in: "在教室裡（Zoom 回報）", out: "已離開（Zoom 回報）" };
const time = (value: string) => new Date(value).toLocaleTimeString("zh-TW", { hour: "2-digit", minute: "2-digit" });
const problemOf = (data: { code?: string; error?: string; labels?: unknown }) => {
  const names = Array.isArray(data?.labels) ? data.labels.filter((label): label is string => typeof label === "string") : [];
  return `${ERRORS[data?.code ?? ""] ?? data?.error ?? "操作失敗。"}${names.length ? `（${names.slice(0, 10).join("、")}${names.length > 10 ? ` 等 ${names.length} 個` : ""}）` : ""}`;
};

export default function FixedRoomsPage() {
  const { principal } = useAdmin();
  const owner = principal.role === "owner";
  const [rooms, setRooms] = useState<Room[] | null>(null);
  const [off, setOff] = useState(false);
  const [label, setLabel] = useState("");
  const [shown, setShown] = useState<Shown>(null);
  const [problem, setProblem] = useState("");
  const [busy, setBusy] = useState(false);
  const [prefix, setPrefix] = useState("Room");
  const [from, setFrom] = useState("1");
  const [to, setTo] = useState("10");
  const [list, setList] = useState<LinkList>(null);
  const [note, setNote] = useState("");
  const [onlyOccupied, setOnlyOccupied] = useState(false);
  const [search, setSearch] = useState("");

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

  // Many rooms at once: the answer is used here and nowhere else (the links stay in this page's
  // memory until the list is downloaded and put away).
  async function send(action: string, input: Record<string, unknown>) {
    const response = await fetch("/api/admin/classrooms/rooms", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, ...input }) });
    const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    return { ok: response.ok, data };
  }
  async function actOnMany(action: string, input: Record<string, unknown>, confirmText?: string) {
    if (confirmText && !window.confirm(confirmText)) return null;
    setBusy(true);
    setProblem("");
    setNote("");
    try {
      // No answer at all (the connection dropped): what the server did is not known.
      const answer = await send(action, input).catch(() => null);
      if (!answer) { setProblem(ERRORS.CONNECTION_LOST); return null; }
      if (!answer.ok) { setProblem(problemOf(answer.data)); return null; }
      return answer.data;
    } finally {
      await load().catch(() => undefined);
      setBusy(false);
    }
  }

  async function makeMany() {
    const range = bulkRange(prefix, from, to);
    if (!range) { setProblem(ERRORS.INVALID_BULK); return; }
    const data = await actOnMany("create_many", range);
    if (!data) return;
    const made = (data.rooms as { label: string; link: string }[] | undefined) ?? [];
    const failed = ((data.failed as { label: string }[] | undefined) ?? []).map((entry) => entry.label);
    setList({ title: `已建立 ${made.length} 間教室`, rows: made.map((room) => ({ label: room.label, link: room.link })), failed });
  }

  // Every room's link anew. The server takes at most 100 rooms at a time, so the rooms go in parts
  // (exportInParts). The links of the parts that were done are shown first, before anything else
  // can go wrong, even when a later part is refused or the connection drops: those rooms already
  // have their new links, which exist nowhere else.
  async function exportAll() {
    const all = rooms ?? [];
    if (!all.length) return;
    if (!window.confirm(`這會更換全部 ${all.length} 間教室的連結：已經發出去的舊連結都不能再用來進教室（已經在教室裡的人不受影響）。正在等待進入的人，要用新連結重新輸入名字。新連結只顯示這一次。確定要重新產生嗎？`)) return;
    setBusy(true);
    setProblem("");
    setNote("");
    try {
      const result = await exportInParts(all, (ids) => send("export_links", { rooms: ids }));
      if (result.rows.length || result.failed.length) setList({ title: `已重新產生 ${result.rows.length} 間教室的連結`, rows: result.rows, failed: result.failed });
      if (result.problem) setProblem(result.problem.kind === "connection" ? ERRORS.CONNECTION_LOST : problemOf(result.problem.data));
      await load().catch(() => undefined);
    } finally {
      setBusy(false);
    }
  }

  async function recordAll(on: boolean) {
    const data = await actOnMany("set_recording_all", { on }, on ? "開啟全部教室的錄影開關？之後每間教室是否真的錄影，仍然要看錄影的其他條件。" : "關閉全部教室的錄影開關？可能正在錄影的教室不會被關閉，會另外列出。");
    if (!data) return;
    const changed = (data.changed as unknown[] | undefined)?.length ?? 0;
    const unchanged = (data.unchanged as unknown[] | undefined)?.length ?? 0;
    const refused = ((data.refused as { label: string }[] | undefined) ?? []).map((entry) => entry.label);
    setNote(`錄影開關已${on ? "開啟" : "關閉"} ${changed} 間；${unchanged} 間原本就是這個設定。${refused.length ? `沒有變更的教室（可能正在錄影，請先結束那間的上課）：${refused.join("、")}。` : ""}`);
  }

  function download() {
    if (!list) return;
    const url = URL.createObjectURL(new Blob([linksCsv(window.location.origin, list.rows)], { type: "text/csv;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `ihear-room-links-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  }

  if (!owner) return <section className="admin-panel"><h1>固定教室</h1><p>需要擁有者權限。</p></section>;
  if (off) return <section className="admin-panel"><h1>固定教室</h1><p role="status" data-rooms-off>{ERRORS.NOT_FOUND}</p></section>;
  const visible = rooms ? roomsToShow(rooms, { onlyOccupied, search }) : [];
  const recordingAvailable = Boolean(rooms?.some((room) => room.recording?.available));
  return (
    <section className="admin-panel" data-fixed-rooms>
      <h1>固定教室</h1>
      <p role="note">每間教室一個固定連結，每間最多 10 人。打開連結的人輸入英文名字後會在這裡等待，由您讓他進入。名字是自己填的，不是身分：請先用畫面、聲音或詢問認出本人。Zoom 裡顯示的是代碼，不會拿到名字。</p>
      <form onSubmit={(event) => { event.preventDefault(); void act("create", { label }).then(() => setLabel("")); }} aria-label="建立固定教室">
        <label className="admin-field"><span>教室名稱（例如 Room 1）</span><input value={label} onChange={(event) => setLabel(event.target.value)} maxLength={40} /></label>
        <button type="submit" disabled={busy || !label.trim()}>建立教室</button>
      </form>
      <details data-rooms-bulk>
        <summary>一次建立多間</summary>
        <form onSubmit={(event) => { event.preventDefault(); void makeMany(); }} aria-label="一次建立多間">
          <p>名稱會是「開頭＋號碼」，例如開頭 Room、從 1 到 100，就是 Room1 到 Room100。一次最多 100 間。</p>
          <label className="admin-field"><span>名稱開頭</span><input value={prefix} onChange={(event) => setPrefix(event.target.value)} maxLength={36} /></label>
          <label className="admin-field"><span>從幾號</span><input value={from} onChange={(event) => setFrom(event.target.value)} inputMode="numeric" maxLength={4} /></label>
          <label className="admin-field"><span>到幾號</span><input value={to} onChange={(event) => setTo(event.target.value)} inputMode="numeric" maxLength={4} /></label>
          <button type="submit" disabled={busy || !bulkRange(prefix, from, to)}>一次建立多間</button>
        </form>
        <p>
          <button type="button" disabled={busy || !rooms?.length} onClick={() => void exportAll()}>重新產生全部連結並下載</button>
          <span>　連結只在建立或更換時出現一次，系統不保存。清單遺失時用這個按鈕：每間教室都會換成新連結，舊連結不能再用來進教室。</span>
        </p>
      </details>
      {problem && <p role="alert" className="admin-error">{problem}</p>}
      {note && <p role="status" data-rooms-note>{note}</p>}
      {shown && (
        <div role="status" data-room-link>
          <p>「{shown.room}」的教室連結（只顯示這一次，請直接交給這間教室的人；遺失時請更換連結）：</p>
          <p><code>{`${window.location.origin}${shown.link}`}</code></p>
          <button type="button" onClick={() => setShown(null)}>我已經記下連結</button>
        </div>
      )}
      {list && (
        <div role="status" data-room-links-list>
          <p>{list.title}。連結清單只在這裡出現這一次：請下載後交給各間教室的人；關閉這個訊息或重新整理頁面之後，就要重新產生才拿得到。</p>
          {list.failed.length > 0 && <p role="alert">這幾間沒有完成，請再看一次：{list.failed.join("、")}。</p>}
          <button type="button" disabled={list.rows.length === 0} onClick={download}>下載清單（CSV，{list.rows.length} 間）</button>
          <button type="button" onClick={() => setList(null)}>我已經下載這份清單</button>
        </div>
      )}
      {recordingAvailable && (
        <p data-rooms-recording-all>
          錄影開關（全部教室）：
          <button type="button" disabled={busy} onClick={() => void recordAll(true)}>全部開啟</button>
          <button type="button" disabled={busy} onClick={() => void recordAll(false)}>全部關閉</button>
        </p>
      )}
      {rooms !== null && rooms.length > 0 && (
        <p data-rooms-filter>
          <label><input type="checkbox" checked={onlyOccupied} onChange={(event) => setOnlyOccupied(event.target.checked)} /> 只顯示有人的教室（在教室裡或等待中）</label>
          <label className="admin-field"><span>找教室</span><input value={search} onChange={(event) => setSearch(event.target.value)} maxLength={40} placeholder="例如 Room12" /></label>
          <span data-rooms-count>顯示 {visible.length}／共 {rooms.length} 間</span>
        </p>
      )}
      {rooms === null ? <p>載入中…</p> : rooms.length === 0 ? <p>還沒有固定教室。</p> : visible.length === 0 ? <p data-rooms-none>沒有符合的教室。</p> : visible.map((room) => (
        <article key={room.id} className="admin-card" data-room={room.label}>
          <h2>{room.label}</h2>
          <p>{room.lesson ? `上課中，最晚到 ${time(room.lesson.endsAt)}` : "目前沒有在上課"}・教室裡 {room.inRoom.length}/{room.capacity} 人・連結第 {room.linkGeneration} 版</p>
          <p>
            <button type="button" disabled={busy} onClick={() => void act("replace_link", { room: room.id }, `更換「${room.label}」的連結？舊連結立刻不能再用來進教室；已經在教室裡的人不受影響。新連結只顯示一次。`)}>更換連結</button>
            {room.lesson && <button type="button" disabled={busy} onClick={() => void act("end_lesson", { room: room.id }, `結束「${room.label}」這次上課？所有人會離開，Session 會結束。`)}>結束這次上課</button>}
          </p>
          {room.recording?.available && (
            <p data-room-recording={room.recording.on ? "on" : "off"}>
              錄影開關：{room.recording.on ? "開啟" : "關閉"}
              <button type="button" disabled={busy} onClick={() => void act("set_recording", { room: room.id, on: !room.recording!.on })}>{room.recording.on ? "關閉這間的錄影開關" : "開啟這間的錄影開關"}</button>
            </p>
          )}
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
