"use client";

import { useCallback, useEffect, useState } from "react";

// P3-Multi (2026-11-09): the manager's page for a block. Everything here asks the server, which
// checks again who is asking, the block's phase and version, the rooms' seats and recording: the
// page only shows the server's answer. A change made on an older version is refused (another
// manager changed the block meanwhile); the page then shows the block as it is now.

type Person = { code: string; role: string; englishName: string; seat: string | null; visit: string | null; target: string | null; heldBack: string | null; state: string; devices?: number; staleIn?: string[] };
type Operation = { action: string; state: string; attempts: number; sessions: string[] };
type Room = {
  label: string; kind: string; lessonId: string; capacity: number | null; occupied: number;
  people: { code: string; role: string; seat: string | null }[]; sessions: { id: string; live: boolean | null; generation: number | null; capture: string | null }[];
  recording: { status: string; label: string; basis: string; allowed: boolean }; operations: Operation[]; advice: string | null;
  files: { name: string | null; status: string; hold: string | null }[]; anomalies: { code: string; severity: string }[];
};
type View = {
  block: { id: string; code: string; startsAt: string; endsAt: string; cancelled: boolean; phase: string; version: number; recordingMode: string; recordingAvailable: boolean; capacity: number };
  members: Person[]; lobby: Room | null; rooms: Room[];
};

const PHASE: Record<string, string> = { SETUP: "尚未開放主會議室", LOBBY_OPEN: "主會議室已開放", BREAKOUT: "分房中", RECALLED: "已召回主會議室", ENDED: "已結束" };
const ROLE: Record<string, string> = { manager: "管理老師", lead_tutor: "主要小老師", co_tutor: "協同小老師", observer: "觀察員", student: "學生" };
const STATE: Record<string, string> = {
  ASSIGNED: "ASSIGNED 已分房", WAITING: "WAITING 主會議室等待", MOVING: "MOVING 換房中", JOINING: "JOINING 進入中", JOINED: "JOINED 已進入",
  RETURNING: "RETURNING 返回中", FAILED: "FAILED 失敗", DISCONNECTED: "DISCONNECTED 離線", REVOKED: "REVOKED 已撤銷",
};
const ERRORS: Record<string, string> = {
  STALE_VERSION: "其他管理員剛更改了班次，已重新載入目前狀態，請再確認一次。",
  ROOM_FULL: "該教室已滿（每間最多 10 人）。",
  MANAGER_NOT_IN_LOBBY: "管理老師要先進入主會議室，才能開放。",
  CONSENT_REQUIRED_FOR_RECORDING_ROOM: "該教室可能正在錄影，此學生的錄影同意目前無效，不能移入。",
  STAFF_NOTICE_REQUIRED_FOR_RECORDING_ROOM: "該教室可能正在錄影，此人員尚未確認錄影告知，不能進入。",
  RECORDING_MAY_BE_ON: "仍有教室可能在錄影，請先停止錄影。",
  UNKNOWN_RECORDING_STATE: "有錄影操作的結果未確認（UNKNOWN），請先唯讀查核或停止。",
  RECORDING_NOT_AVAILABLE: "本網站尚未開放班次錄影。",
  OWNER_REQUIRED: "只有擁有者可以變更錄影模式。",
  NOT_BLOCK_MANAGER: "你不是這個班次的管理老師。",
  WRONG_PHASE: "目前的班次階段不能這樣做。",
  NO_ASSIGNMENTS: "請先分配教室。",
  SIGN_IN_REQUIRED: "請先登入。",
};

export default function BlockManage({ blockId }: { blockId: string }) {
  const [view, setView] = useState<View | null>(null);
  const [problem, setProblem] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const base = `/api/classroom/blocks/${encodeURIComponent(blockId)}/manage`;

  const load = useCallback(async () => {
    try {
      const response = await fetch(base, { cache: "no-store" });
      const data = await response.json().catch(() => ({}));
      if (response.ok && data?.ok) { setView(data.view as View); return; }
      if (response.status !== 429) setProblem(ERRORS[data?.code] ?? "暫時無法載入班次。");
    } catch {
      // A slow network: the next refresh tries again.
    }
  }, [base]);

  // Every 4 s while the console is on screen, never two refreshes at once; a hidden tab does not ask
  // (B4), and on coming back it refreshes at once.
  useEffect(() => {
    let running = false;
    const refresh = async () => {
      if (running || document.hidden) return;
      running = true;
      try { await load(); } finally { running = false; }
    };
    void refresh();
    const timer = setInterval(() => { void refresh(); }, 4000);
    const onVisible = () => { if (!document.hidden) void refresh(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { clearInterval(timer); document.removeEventListener("visibilitychange", onVisible); };
  }, [load]);

  async function act(action: string, input: Record<string, unknown> = {}, confirmText?: string) {
    if (!view) return;
    if (confirmText && !window.confirm(confirmText)) return;
    setBusy(true);
    setProblem("");
    setNotice("");
    try {
      const response = await fetch(base, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, version: view.block.version, ...input }),
      });
      const data = await response.json().catch(() => ({}));
      if (data?.view) setView(data.view as View);
      if (!response.ok) {
        setProblem(ERRORS[data?.code] ?? data?.error ?? "操作失敗。");
        if (data?.code === "STALE_VERSION") await load();
        return;
      }
      if (data?.studentLink) setNotice(`新的學生連結（只顯示這一次）：${window.location.origin}${data.studentLink}`);
      if (Array.isArray(data?.observed)) setNotice(`唯讀查核完成：${data.observed.length} 個 Session，未送出任何指令。`);
    } finally {
      setBusy(false);
    }
  }

  if (!view) return <main className="block-manage"><h1>班次管理</h1>{problem ? <p className="block-manage-alert" role="alert">{problem}</p> : <p role="status">載入中…</p>}</main>;
  const { block } = view;
  const roomLabels = view.rooms.map((room) => room.label);
  const ended = block.phase === "ENDED" || block.cancelled;
  const roomCard = (room: Room) => (
    <article key={room.lessonId} className="block-manage-room" data-room={room.label} aria-label={room.kind === "lobby" ? "主會議室" : `教學房間 ${room.label}`}>
      <h3>{room.kind === "lobby" ? "主會議室（永不錄影）" : `教學房間 ${room.label}`}</h3>
      {room.capacity != null && <p data-occupied={room.occupied}>人數：{room.occupied} / {room.capacity}</p>}
      <p>成員：{room.people.map((person) => `${person.code}（${person.role === "tutor" ? "主持" : person.role === "observer" ? "觀察" : "學生"}${person.seat === "visit" ? "・巡視" : ""}）`).join("、") || "無"}</p>
      <p>Session：{room.sessions.map((entry) => `${entry.id}${entry.live ? "（進行中）" : ""}`).join("、") || "尚無"}</p>
      <p>錄影：<span data-recording={room.recording.status}>{room.recording.label}</span></p>
      {room.operations.filter((entry) => ["UNKNOWN", "UNCERTAIN", "IN_FLIGHT"].includes(entry.state)).map((entry, index) => (
        <p key={index} className="block-manage-alert" data-operation={entry.state}>錄影操作 {entry.action}：{entry.state}（嘗試 {entry.attempts} 次；Session {entry.sessions.join("、") || "未知"}）</p>
      ))}
      {room.advice && <p className="block-manage-note" role="note">{room.advice}</p>}
      {room.files.length > 0 && <ul>{room.files.map((file, index) => <li key={index}>{file.name ?? "（未命名）"}：{file.status === "STORED" ? "ARCHIVED 歸檔完成" : file.status}{file.hold ? `（${file.hold}）` : ""}</li>)}</ul>}
      {room.anomalies.length > 0 && <p className="block-manage-alert">異常：{room.anomalies.map((entry) => entry.code).join("、")}</p>}
      {room.kind === "room" && (
        <div className="block-manage-bar">
          {block.phase === "BREAKOUT" && <button type="button" disabled={busy} onClick={() => void act("visit", { room: room.label })}>巡視此房</button>}
          <button type="button" disabled={busy} onClick={() => void act("check_recording", { room: room.label })}>唯讀查核錄影</button>
          <button type="button" disabled={busy} onClick={() => void act("stop_room_recording", { room: room.label }, `停止 ${room.label} 的錄影？Zoom 沒有確認時，伺服器會結束該 Session。`)}>停止錄影並結束 Session</button>
        </div>
      )}
    </article>
  );

  return (
    <main className="block-manage" data-phase={block.phase} data-version={block.version}>
      <h1>班次管理 {block.code}</h1>
      <p role="status" data-phase-label>{PHASE[block.phase] ?? block.phase}{block.cancelled ? "（已取消）" : ""}・版本 {block.version}</p>
      <p className="block-manage-note" role="note" data-recording-mode={block.recordingMode}>
        {block.recordingMode === "classroom_only" ? "Classroom Only：本班次不會產生錄影。" : "Classroom + Recording：各教學房間依同意狀態各自錄影。"}
      </p>
      {problem && <p className="block-manage-alert" role="alert">{problem}</p>}
      {notice && <p className="block-manage-note" role="status" data-notice>{notice}</p>}
      {!ended && (
        <div className="block-manage-bar" role="toolbar" aria-label="班次操作">
          <a href={`/classroom/b/${encodeURIComponent(blockId)}`} target="_blank" rel="noopener">進入主會議室</a>
          {block.phase === "SETUP" && <button type="button" disabled={busy} onClick={() => void act("open_lobby")}>開放主會議室</button>}
          {(block.phase === "LOBBY_OPEN" || block.phase === "RECALLED") && <button type="button" disabled={busy} onClick={() => void act("start_breakout", { confirm: true }, "確認分房並開始？學生會依目前的分配進入各教學房間。")}>確認並開始分房</button>}
          {block.phase === "BREAKOUT" && <button type="button" disabled={busy} onClick={() => void act("recall")}>召回主會議室</button>}
          {block.phase === "BREAKOUT" && <button type="button" disabled={busy} onClick={() => void act("end_visit")}>結束巡視</button>}
          <button type="button" disabled={busy} onClick={() => void act("end_block", {}, "結束全部教學房間？之後不再發放入場權杖，伺服器會結束所有 Session。")}>結束全部教學房間</button>
          <button type="button" disabled={busy} onClick={() => void act("cancel_block", {}, "取消整個班次？所有連結將無法再使用。")}>取消班次</button>
          {block.recordingMode === "classroom_only"
            ? block.recordingAvailable && <button type="button" disabled={busy} onClick={() => void act("set_recording_mode", { mode: "classroom_recording" }, "切換為 Classroom + Recording？伺服器會先重新檢查所有條件。")}>切換為 Classroom + Recording</button>
            : <button type="button" disabled={busy} onClick={() => void act("set_recording_mode", { mode: "classroom_only" })}>切換為 Classroom Only</button>}
        </div>
      )}

      <h2>參與者</h2>
      <div className="block-manage-scroll">
        <table>
          <thead><tr><th>代碼</th><th>角色</th><th>英文姓名</th><th>狀態</th><th>目前位置</th><th>分配教室</th><th>操作</th></tr></thead>
          <tbody>
            {view.members.map((person) => (
              <tr key={person.code} data-member={person.code} data-state={person.state}>
                <td>{person.code}</td>
                <td>{ROLE[person.role] ?? person.role}</td>
                <td>{person.englishName}</td>
                <td>{STATE[person.state] ?? person.state}</td>
                <td>{person.target === "Lobby" ? "主會議室" : person.target ?? "—"}{person.visit ? `（巡視 ${person.visit}）` : ""}{person.heldBack ? "（錄影中，暫留主會議室）" : ""}{(person.devices ?? 0) > 1 ? <span className="block-manage-alert" data-multi-device>（同一連結 {person.devices} 個裝置）</span> : null}{person.staleIn?.length ? <span className="block-manage-alert" data-stale-in>（仍在 {person.staleIn.join("、")}）</span> : null}</td>
                <td>
                  {person.role === "manager" ? "—" : (
                    <select aria-label={`${person.code} 的教室`} value={person.seat ?? ""} disabled={busy || ended} onChange={(event) => void act("assign", { member: person.code, room: event.target.value || null })}>
                      <option value="">主會議室（未分配）</option>
                      {roomLabels.map((label) => <option key={label} value={label}>{label}</option>)}
                    </select>
                  )}
                </td>
                <td>
                  {person.role === "student" && !ended && (
                    <>
                      <button type="button" disabled={busy} onClick={() => void act("revoke_link", { member: person.code }, `撤銷 ${person.code} 的連結？舊連結立即無法再取得入場權杖。`)}>撤銷連結</button>
                      <button type="button" disabled={busy} onClick={() => void act("reissue_link", { member: person.code })}>重發連結</button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2>教室狀態</h2>
      <div className="block-manage-rooms">
        {view.lobby && roomCard(view.lobby)}
        {view.rooms.map(roomCard)}
      </div>
    </main>
  );
}
