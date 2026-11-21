"use client";

import { useCallback, useEffect, useState } from "react";
import { useAdmin } from "../../admin-context";
import {
  bulkRange, exportInParts, generationsOf, labelsOfRange, linksCsv, linkStates, mergeMade, partOutcome, roomsToShow, rowsToExport, summaryOf,
  type MadeLink, type PartAnswer, type RoomLinkState,
} from "./room-links";

// Classroom 3.0 round 3 (2026-11-21): the fixed rooms, for owners (the iHear teacher). Each room has
// one link, shown once when the room is made or its link replaced. People who open it type a first
// name and wait here; the teacher lets each one in, or not, and may take a person out or end the
// room's lesson. A typed name is not an identity: recognize the person first.
//
// Many rooms (the teacher asked for 100, named Room1, Room2, …): rooms are made in bulk, their links
// come once as a list to download (made in this browser; never sent back, stored or logged), the
// list can be narrowed to the rooms with somebody, and every room's recording switch can be set at
// once where the site allows fixed rooms to record at all.
//
// Round 4 (2026-11-21): a bulk change whose answer never came (the connection dropped, a time-out, a
// server error) may still have changed rooms on the server. The links received are shown and kept
// at once; then the rooms are read again and every room asked about is said as it stands (link
// received, replaced again, replaced with no link received, unchanged, not made, not known yet).
// Nothing is sent again by itself: a person chooses what next, and the list only ever holds links
// that are the rooms' links now.

// student/boundBy/consent and members (Gate B, round 10): only where the site may record fixed rooms.
type Person = { request: string; name: string; at: string; code?: string | null; presence?: "in" | "out" | null; student?: string | null; boundBy?: string | null; consent?: string };
type Member = { code: string; name: string };
type Room = {
  id: string; label: string; linkGeneration: number; capacity: number; disabled?: boolean; lesson: { lessonId: string; endsAt: string } | null; waiting: Person[]; inRoom: Person[];
  recording?: { on: boolean; available: boolean; status?: string; label?: string; anomalies?: { code: string; severity: string }[] }; members?: Member[];
};
// A room's link, or (Gate B) one student's own link: shown once.
type Shown = { room: string; link: string; student?: string } | null;
// One list of links being gathered: the rooms it is about (asked, by name), each link's version
// before the first change (baseline), the newest link received per room (made), where each room
// stands (states), whether those states were read from the server after the last change (checked),
// and whether the list was downloaded since its last change.
type Run = { kind: "create" | "export"; asked: string[]; baseline: Record<string, number>; made: Record<string, MadeLink> };
type LinkList = (Run & { states: Record<string, RoomLinkState>; checked: boolean; downloaded: boolean }) | null;

// How long an answer is waited for before the outcome is taken as not known.
const ANSWER_WITHIN_MS = 90_000;
const READ_WITHIN_MS = 30_000;

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
  ROOM_DISABLED: "這間教室停用中，不能讓人進來。要使用請先重新啟用。",
  LESSON_IN_PROGRESS: "這間教室正在上課：請先結束這次上課，再停用。",
  NOT_SENT: "無法連線到伺服器，沒有送出任何變更。請確認網路後再試一次。",
  OUTCOME_UNKNOWN: "沒有收到伺服器的結果（連線中斷、逾時或伺服器錯誤）。伺服器可能已經改了其中一部分：請看下面每間教室的狀態。系統不會自己再送一次。",
  CHECK_FAILED: "無法連線到伺服器，還不能確認每間教室的狀態。請確認網路後再按一次「重新確認狀態」。",
  RECORDING_UNKNOWN:"沒有收到伺服器的結果：錄影開關可能已經改了一部分。下面是重新讀取的每間教室的實際狀態。",
  // Round 7 (2026-11-21): one room's change without an answer, and an activity record not written.
  SINGLE_UNKNOWN: "沒有收到伺服器的結果（連線中斷、逾時或伺服器錯誤）：這個變更可能已經完成，也可能沒有。下面是重新讀取的狀態，請確認後再決定是否重做。系統不會自己再送一次。",
  SINGLE_UNREAD: "沒有收到伺服器的結果，也還無法重新讀取教室的狀態：這個變更可能已經完成，也可能沒有。請確認網路後重新整理頁面，看過狀態再決定是否重做。",
  CREATE_UNKNOWN: "沒有收到伺服器的結果。目前的清單裡沒有這間新教室：伺服器沒有建立，或還在處理。請稍等一下再看清單，確認沒有之後再建立一次。",
  REPLACE_UNKNOWN: "沒有收到伺服器的結果。目前看來連結沒有更換（或伺服器還在處理）：請稍等一下再看一次；如果拿舊連結的人進不來，請再按一次「更換連結」。",
  REPLACED_UNSEEN: "連結已經更換，但新的連結沒有送到這個頁面；舊連結已經不能用。請再按一次「更換連結」，取得新的連結。",
  ACTIVITY_NOT_RECORDED: "變更已經完成，但這次操作沒有寫進操作紀錄。請通知 iHear 的技術人員：操作紀錄暫時無法寫入。",
  // Gate B (round 10): the room's list of students.
  INVALID_CODE: "學生代碼請用 1–20 個英文字母、數字或 -（不能用教室自動產生的代碼）。",
  INVALID_NAME: "請用英文字母輸入學生的名字（可以有空格、. 和 '）。",
  MEMBER_EXISTS: "這位學生已經在這間教室的名單上。",
  ROSTER_FULL: "一間教室的名單最多 100 位學生。",
  NO_SUCH_MEMBER: "名單上沒有這位學生，畫面已重新整理。",
  NOT_ON_ROSTER: "這位學生已經不在名單上，不能用他的個人連結進入。",
  ALREADY_BOUND: "這個申請是用另一位學生的個人連結送出的。",
  ALREADY_IN_LESSON: "這位學生這次上課已經有位子（已經在教室裡，或這次上課被請出過）。",
};
const CONSENT: Record<string, string> = {
  CONSENTED: "錄影同意有效", CONSENT_MISSING: "沒有錄影同意", CONSENT_WITHDRAWN: "錄影同意已撤回", CONSENT_EXPIRED: "錄影同意已過期", CONSENT_VERSION_MISMATCH: "錄影同意版本不符",
};
// A room's name as the server keeps it (lib/classroom-fixed-rooms.ts), to find a room just made.
const labelKey = (value: unknown) => String(value ?? "").normalize("NFC").trim().replace(/\s+/g, " ");
// What one room's change without an answer turns out to be, from the rooms read again (null: they
// could not be read). A room or link the server made but never sent is said, with what to do.
function unknownOutcome(action: string, input: Record<string, unknown>, before: Room[] | null, now: Room[] | null): string {
  if (!now) return ERRORS.SINGLE_UNREAD;
  if (action === "create" && before) {
    const known = new Set(before.map((room) => room.id));
    const made = now.find((room) => !known.has(room.id) && labelKey(room.label) === labelKey(input.label));
    return made ? `教室「${made.label}」已經建立，但它的連結沒有送到這個頁面（沒有人看過這個連結）。請在這間教室按「更換連結」，取得新的連結。` : ERRORS.CREATE_UNKNOWN;
  }
  if (action === "replace_link") {
    const was = before?.find((room) => room.id === input.room)?.linkGeneration;
    const is = now.find((room) => room.id === input.room)?.linkGeneration;
    return was != null && is != null && is > was ? ERRORS.REPLACED_UNSEEN : ERRORS.REPLACE_UNKNOWN;
  }
  return ERRORS.SINGLE_UNKNOWN;
}
const PRESENCE: Record<string, string> = { in: "在教室裡（Zoom 回報）", out: "已離開（Zoom 回報）" };
const time = (value: string) => new Date(value).toLocaleTimeString("zh-TW", { hour: "2-digit", minute: "2-digit" });
const problemOf = (data: { code?: string; error?: string; labels?: unknown }) => {
  const names = Array.isArray(data?.labels) ? data.labels.filter((label): label is string => typeof label === "string") : [];
  return `${ERRORS[data?.code ?? ""] ?? data?.error ?? "操作失敗。"}${names.length ? `（${names.slice(0, 10).join("、")}${names.length > 10 ? ` 等 ${names.length} 個` : ""}）` : ""}`;
};
const named = (labels: string[]) => labels.join("、");
// The rooms made by create_many, as links received (a new room's link is its first version).
const roomsMade = (data: Record<string, unknown>): MadeLink[] => (Array.isArray(data.rooms) ? (data.rooms as Record<string, unknown>[]) : [])
  .filter((room) => room && typeof room.id === "string" && typeof room.label === "string" && typeof room.link === "string")
  .map((room) => ({ room: String(room.id), label: String(room.label), link: String(room.link), generation: 1 }));

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
  // Gate B (round 10): which student on the list each waiting request is said to be (by request), and
  // the student to add to a room's list (by room).
  const [bindings, setBindings] = useState<Record<string, string>>({});
  const [newMember, setNewMember] = useState<Record<string, { code: string; name: string }>>({});

  // The rooms as the server lists them now; null when they could not be read. The page's only read.
  const readRooms = useCallback(async (): Promise<Room[] | null> => {
    try {
      const response = await fetch("/api/admin/classrooms/rooms", { cache: "no-store", signal: AbortSignal.timeout(READ_WITHIN_MS) });
      if (response.status === 404) { setOff(true); return null; }
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !Array.isArray(data?.rooms)) return null;
      setRooms(data.rooms);
      return data.rooms as Room[];
    } catch {
      return null;
    }
  }, []);
  const load = useCallback(async () => { await readRooms(); }, [readRooms]);
  useEffect(() => {
    if (!owner) return;
    void load();
    const timer = setInterval(() => { void load(); }, 4000);
    return () => clearInterval(timer);
  }, [owner, load]);

  // A list that holds links not yet downloaded: leaving the page asks first (the links exist nowhere else).
  useEffect(() => {
    if (!list || list.downloaded || Object.keys(list.made).length === 0) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [list]);

  // One change to one room; true when the server answered that it was made. No answer (the connection
  // dropped, the time ran out) or a server error means it may or may not have been made: the rooms are
  // read again and the page says what it finds, never sending it again by itself (round 7). A refusal
  // (4xx) changed nothing.
  async function act(action: string, input: Record<string, unknown>, confirmText?: string): Promise<boolean> {
    if (confirmText && !window.confirm(confirmText)) return false;
    setBusy(true);
    setProblem("");
    const before = rooms;
    try {
      let response: Response | null = null;
      let data: Record<string, unknown> = {};
      try {
        response = await fetch("/api/admin/classrooms/rooms", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, ...input }), signal: AbortSignal.timeout(ANSWER_WITHIN_MS) });
        data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      } catch {
        response = null;
      }
      if (!response || response.status >= 500) {
        setProblem(unknownOutcome(action, input, before, await readRooms()));
        return false;
      }
      if (!response.ok) {
        setProblem(ERRORS[String(data.code ?? "")] ?? (typeof data.error === "string" ? data.error : "操作失敗。"));
        await load();
        return false;
      }
      if (typeof data.link === "string") {
        const room = (data.room as { label?: string } | undefined)?.label ?? before?.find((entry) => entry.id === input.room)?.label ?? String(input.room ?? "");
        setShown({ room, link: data.link });
      }
      if (typeof data.passLink === "string") {
        const room = before?.find((entry) => entry.id === input.room)?.label ?? String(input.room ?? "");
        const member = data.member as Member | undefined;
        setShown({ room, link: data.passLink, student: member ? `${member.name}（代碼 ${member.code}）` : String(input.code ?? "") });
      }
      if (data.activity === "not_recorded") setProblem(ERRORS.ACTIVITY_NOT_RECORDED);
      await load();
      return true;
    } finally {
      setBusy(false);
    }
  }

  // One bulk request. Throws when no answer came at all (the connection dropped or the time ran out).
  async function send(action: string, input: Record<string, unknown>): Promise<PartAnswer> {
    const response = await fetch("/api/admin/classrooms/rooms", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, ...input }), signal: AbortSignal.timeout(ANSWER_WITHIN_MS) });
    const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    return { ok: response.ok, status: response.status, data };
  }

  // The list as it stands after a change: shown at once with what was received, before anything else
  // is asked of the server; then every room asked about is read again and said as it stands.
  async function settle(run: Run, problemNow: string) {
    setList({ ...run, states: linkStates({ ...run, current: null }), checked: false, downloaded: false });
    if (problemNow) setProblem(problemNow);
    await recheck(run);
  }
  async function recheck(run: Run, downloaded = false) {
    const now = await readRooms();
    if (!now) return null;
    const states = linkStates({ ...run, current: generationsOf(now) });
    setList({ ...run, states, checked: true, downloaded });
    return states;
  }

  // New links for the rooms named, in parts the server takes; part of an earlier list (prior) when
  // a person chose to fill in what it lacks.
  async function regenerate(labels: string[], prior: LinkList) {
    setBusy(true);
    setProblem("");
    setNote("");
    try {
      const now = await readRooms();
      if (!now) { setProblem(ERRORS.NOT_SENT); return; }
      const wanted = new Set(labels.map((entry) => entry.toLowerCase()));
      const targets = now.filter((room) => wanted.has(room.label.toLowerCase()));
      const result = await exportInParts(targets, (ids) => send("export_links", { rooms: ids }));
      await settle({
        kind: prior?.kind ?? "export",
        asked: prior?.asked ?? targets.map((room) => room.label),
        baseline: prior?.baseline ?? generationsOf(now),
        made: mergeMade(prior?.made ?? {}, result.made),
      }, result.problem ? (result.problem.kind === "unknown" ? ERRORS.OUTCOME_UNKNOWN : problemOf(result.problem.data)) : "");
    } finally {
      setBusy(false);
    }
  }

  // Rooms made in bulk: a run of numbers (the form), or the names an earlier list could not make.
  async function makeRooms(labels: string[], request: Record<string, unknown>, prior: LinkList) {
    setBusy(true);
    setProblem("");
    setNote("");
    try {
      const now = await readRooms();
      if (!now) { setProblem(ERRORS.NOT_SENT); return; }
      let answer: PartAnswer | null = null;
      try { answer = await send("create_many", request); } catch { answer = null; }
      const outcome = partOutcome(answer, "rooms");
      // Refused whole: nothing was made, and an earlier list stays as it was.
      if (outcome === "refused") { setProblem(problemOf(answer!.data)); return; }
      await settle({
        kind: "create",
        asked: prior?.asked ?? labels,
        baseline: prior?.baseline ?? generationsOf(now),
        made: mergeMade(prior?.made ?? {}, outcome === "answered" ? roomsMade(answer!.data) : []),
      }, outcome === "unknown" ? ERRORS.OUTCOME_UNKNOWN : "");
    } finally {
      setBusy(false);
    }
  }

  // A new list takes the place of the one shown: when that one holds links not downloaded, ask first.
  const mayReplaceList = () => !list || list.downloaded || Object.keys(list.made).length === 0
    || window.confirm("上一份連結清單還沒有下載。繼續之後，那份清單會被取代，裡面的連結就拿不到了。確定要繼續嗎？");

  async function makeMany() {
    const range = bulkRange(prefix, from, to);
    if (!range) { setProblem(ERRORS.INVALID_BULK); return; }
    if (!mayReplaceList()) return;
    await makeRooms(labelsOfRange(range), range, null);
  }

  // Every room's link anew (the list was lost, or every link is to change).
  async function exportAll() {
    const all = rooms ?? [];
    if (!all.length || !mayReplaceList()) return;
    if (!window.confirm(`這會更換全部 ${all.length} 間教室的連結：已經發出去的舊連結都不能再用來進教室（已經在教室裡的人不受影響）。正在等待進入的人，要用新連結重新輸入名字。新連結只顯示這一次。確定要重新產生嗎？`)) return;
    await regenerate(all.map((room) => room.label), null);
  }

  // What a person may choose after a list is not complete. Each asks first and says which rooms.
  async function fillLinks(labels: string[], stillWorking: number) {
    if (!list || !labels.length) return;
    if (!window.confirm(`為這 ${labels.length} 間教室重新產生連結：${named(labels)}。${stillWorking ? `其中 ${stillWorking} 間現在的連結還能用，也會換掉。` : ""}這幾間現在的連結都會失效，新連結會加進這份清單。確定嗎？`)) return;
    await regenerate(labels, list);
  }
  async function makeMissing(labels: string[]) {
    if (!list || !labels.length) return;
    if (!window.confirm(`建立這 ${labels.length} 間教室：${named(labels)}？`)) return;
    await makeRooms(labels, { labels }, list);
  }
  async function checkAgain() {
    if (!list) return;
    setBusy(true);
    try {
      if (!(await recheck(list, list.downloaded))) setProblem(ERRORS.CHECK_FAILED);
      else setProblem("");
    } finally {
      setBusy(false);
    }
  }

  async function recordAll(on: boolean) {
    if (!window.confirm(on ? "開啟全部教室的錄影開關？之後每間教室是否真的錄影，仍然要看錄影的其他條件。" : "關閉全部教室的錄影開關？可能正在錄影的教室不會被關閉，會另外列出。")) return;
    setBusy(true);
    setProblem("");
    setNote("");
    try {
      let answer: PartAnswer | null = null;
      try { answer = await send("set_recording_all", { on }); } catch { answer = null; }
      const outcome = partOutcome(answer, "changed");
      if (outcome === "refused") { setProblem(problemOf(answer!.data)); return; }
      if (outcome === "unknown") { setProblem(ERRORS.RECORDING_UNKNOWN); return; }
      const data = answer!.data;
      const changed = (data.changed as unknown[] | undefined)?.length ?? 0;
      const unchanged = (data.unchanged as unknown[] | undefined)?.length ?? 0;
      const refused = ((data.refused as { label: string }[] | undefined) ?? []).map((entry) => entry.label);
      setNote(`錄影開關已${on ? "開啟" : "關閉"} ${changed} 間；${unchanged} 間原本就是這個設定。${refused.length ? `沒有變更的教室（可能正在錄影，請先結束那間的上課）：${refused.join("、")}。` : ""}`);
    } finally {
      await load();
      setBusy(false);
    }
  }

  // The file: read the rooms again first, so a link replaced since (here or anywhere) is left out
  // rather than handed out. Only links that are the rooms' links now go in.
  async function download() {
    if (!list) return;
    const states = (await recheck(list, list.downloaded)) ?? list.states;
    const rows = rowsToExport(list.made, states);
    if (!rows.length) return;
    const url = URL.createObjectURL(new Blob([linksCsv(window.location.origin, rows)], { type: "text/csv;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `ihear-room-links-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
    setList((current) => (current ? { ...current, states, downloaded: true } : current));
  }
  function dismiss() {
    if (list && !list.downloaded && Object.keys(list.made).length > 0 && !window.confirm("這份清單還沒有下載。關閉之後就拿不到這些連結，只能再重新產生。確定要關閉嗎？")) return;
    setList(null);
  }

  if (!owner) return <section className="admin-panel"><h1>固定教室</h1><p>需要擁有者權限。</p></section>;
  if (off) return <section className="admin-panel"><h1>固定教室</h1><p role="status" data-rooms-off>{ERRORS.NOT_FOUND}</p></section>;
  const visible = rooms ? roomsToShow(rooms, { onlyOccupied, search }) : [];
  const recordingAvailable = Boolean(rooms?.some((room) => room.recording?.available));
  const summary = list ? summaryOf(list.asked, list.states) : null;
  const ready = list ? rowsToExport(list.made, list.states) : [];
  const creating = list?.kind === "create";
  const needLinks = summary ? [...summary.lost, ...summary.replacedAgain] : [];
  return (
    <section className="admin-panel" data-fixed-rooms>
      <h1>固定教室</h1>
      <p role="note">每間教室一個固定連結，每間最多 10 人。打開連結的人輸入英文名字後會在這裡等待，由您讓他進入。名字是自己填的，不是身分：請先用畫面、聲音或詢問認出本人。Zoom 裡顯示的是代碼，不會拿到名字。</p>
      <form onSubmit={(event) => { event.preventDefault(); void act("create", { label }).then((done) => { if (done) setLabel(""); }); }} aria-label="建立固定教室">
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
          {shown.student
            ? <p data-pass-link>「{shown.room}」裡 {shown.student} 的個人連結（只顯示這一次，請只交給這位學生；遺失或給錯人時請按「重發個人連結」）：</p>
            : <p>「{shown.room}」的教室連結（只顯示這一次，請直接交給這間教室的人；遺失時請更換連結）：</p>}
          <p><code>{`${window.location.origin}${shown.link}`}</code></p>
          <button type="button" onClick={() => setShown(null)}>我已經記下連結</button>
        </div>
      )}
      {list && summary && (
        <div role="status" data-room-links-list data-complete={summary.complete ? "yes" : "no"}>
          <p data-links-title>
            {creating
              ? (summary.complete ? `已建立 ${list.asked.length} 間教室，全部完成。` : `已建立並拿到 ${summary.done.length} 間教室的連結；${list.asked.length - summary.done.length} 間沒有完成，請看下面。`)
              : (summary.complete ? `已重新產生 ${list.asked.length} 間教室的連結，全部完成。` : `已拿到 ${summary.done.length} 間教室的新連結；${list.asked.length - summary.done.length} 間沒有完成，請看下面。`)}
          </p>
          <p>連結清單只在這裡出現這一次：請下載後交給各間教室的人；關閉這個訊息或重新整理頁面之後，就要重新產生才拿得到。</p>
          {!list.checked && <p data-links-unchecked>還沒能向伺服器確認每間教室的狀態：清單裡是已經收到的連結。請按「重新確認狀態」。</p>}
          {summary.lost.length > 0 && <p data-links-lost>{creating ? `這幾間已經建立，但沒有收到連結：${named(summary.lost)}。` : `這幾間的連結已經更換，但新連結沒有收到，原本的連結已經不能用：${named(summary.lost)}。`}</p>}
          {summary.replacedAgain.length > 0 && <p data-links-replaced-again>這幾間的連結在這之後又被更換了，這份清單裡的連結已經不能用，不會放進檔案：{named(summary.replacedAgain)}。</p>}
          {summary.unchanged.length > 0 && <p data-links-unchanged>{creating ? `這幾間原本就有，沒有更動：${named(summary.unchanged)}。` : `這幾間的連結沒有更換，原本的連結仍然可以用：${named(summary.unchanged)}。`}</p>}
          {summary.notCreated.length > 0 && <p data-links-not-created>這幾間沒有建立：{named(summary.notCreated)}。</p>}
          {summary.unknown.length > 0 && <p data-links-unknown>這幾間的狀態還不知道（沒有收到結果，也還沒能確認）：{named(summary.unknown)}。請按「重新確認狀態」，不要直接再按一次。</p>}
          <button type="button" disabled={busy || ready.length === 0} onClick={() => void download()}>下載清單（CSV，{ready.length} 間）</button>
          {list.checked && needLinks.length > 0 && <button type="button" data-links-fill disabled={busy} onClick={() => void fillLinks(needLinks, 0)}>{creating ? `為沒有收到連結的 ${needLinks.length} 間產生連結` : `為連結已失效的 ${needLinks.length} 間重新產生連結`}</button>}
          {list.checked && !creating && summary.unchanged.length > 0 && <button type="button" data-links-fill-unchanged disabled={busy} onClick={() => void fillLinks(summary.unchanged, summary.unchanged.length)}>也為連結沒有更換的 {summary.unchanged.length} 間產生新連結</button>}
          {list.checked && summary.notCreated.length > 0 && <button type="button" data-links-make-missing disabled={busy} onClick={() => void makeMissing(summary.notCreated)}>建立沒有建立的 {summary.notCreated.length} 間</button>}
          {(!list.checked || summary.unknown.length > 0) && <button type="button" data-links-recheck disabled={busy} onClick={() => void checkAgain()}>重新確認狀態</button>}
          <button type="button" onClick={dismiss}>我已經下載這份清單</button>
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
        <article key={room.id} className="admin-card" data-room={room.label} data-room-in-use={room.disabled ? "no" : "yes"}>
          <h2>{room.label}{room.disabled ? "（停用中）" : ""}</h2>
          <p>{room.lesson ? `上課中，最晚到 ${time(room.lesson.endsAt)}` : "目前沒有在上課"}・教室裡 {room.inRoom.length}/{room.capacity} 人・連結第 {room.linkGeneration} 版</p>
          {room.disabled && <p role="note" data-room-disabled>這間教室停用中：拿連結的人不能申請進入，也不能讓人進來。連結沒有改變，重新啟用後原本的連結可以再用。</p>}
          <p>
            <button type="button" disabled={busy} onClick={() => void act("replace_link", { room: room.id }, `更換「${room.label}」的連結？舊連結立刻不能再用來進教室；已經在教室裡的人不受影響。新連結只顯示一次。`)}>更換連結</button>
            {room.lesson && <button type="button" disabled={busy} onClick={() => void act("end_lesson", { room: room.id }, `結束「${room.label}」這次上課？所有人會離開，Session 會結束。`)}>結束這次上課</button>}
            {room.disabled
              ? <button type="button" disabled={busy} onClick={() => void act("enable", { room: room.id }, `重新啟用「${room.label}」？原本的連結會再次可以申請進入。`)}>重新啟用</button>
              : <button type="button" disabled={busy} onClick={() => void act("disable", { room: room.id }, `停用「${room.label}」？停用後拿連結的人不能申請進入，正在等待的申請會結束，也不能讓人進來。連結不會改變，重新啟用後原本的連結可以再用。正在上課的教室不能停用：請先結束這次上課。`)}>停用這間教室</button>}
          </p>
          {room.recording?.available && (
            <p data-room-recording={room.recording.on ? "on" : "off"}>
              錄影開關：{room.recording.on ? "開啟" : "關閉"}
              <button type="button" disabled={busy} onClick={() => void act("set_recording", { room: room.id, on: !room.recording!.on })}>{room.recording.on ? "關閉這間的錄影開關" : "開啟這間的錄影開關"}</button>
            </p>
          )}
          {room.recording?.available && room.lesson && (
            <div data-room-recording-now={room.recording.status ?? "unknown"}>
              <p>這次上課的錄影：{room.recording.label ?? "還不知道"}</p>
              {room.inRoom.some((person) => person.consent && person.consent !== "CONSENTED") && (
                <p role="note" data-room-consent-missing>教室裡有 {room.inRoom.filter((person) => person.consent && person.consent !== "CONSENTED").length} 位沒有有效的錄影同意：只要他們在教室裡，這次上課就不會錄影；錄影中時他們不能進入。</p>
              )}
              {(room.recording.anomalies ?? []).length > 0 && <p role="alert" data-room-anomalies>需要處理的異常：{room.recording.anomalies!.map((entry) => entry.code).join("、")}（請到課堂異常頁面查看）。</p>}
            </div>
          )}
          {room.recording?.available && (
            <details data-room-roster>
              <summary>學生名單（{room.members?.length ?? 0}）：錄影同意依學生代碼記錄</summary>
              <p role="note">名單上的每位學生有自己的代碼和個人連結。用個人連結申請的人，進入後在 Zoom 裡用他的學生代碼，錄影同意就是這個代碼的同意。用教室連結申請的人，您可以在讓他進入時指定他是名單上的哪一位。哪一種方式要正式使用、個人連結怎麼交給學生（或家長），要等 iHear 決定。</p>
              {(room.members ?? []).length === 0 ? <p>名單上還沒有學生。</p> : (
                <ul data-roster>
                  {(room.members ?? []).map((member) => (
                    <li key={member.code} data-roster-member={member.code}>
                      {member.name}（代碼 {member.code}）
                      <button type="button" disabled={busy} onClick={() => void act("reissue_pass", { room: room.id, code: member.code }, `重發 ${member.name}（${member.code}）的個人連結？舊的個人連結立刻不能再用來申請；用舊連結正在等待的申請會失效。已經在教室裡的人不受影響。新連結只顯示一次。`)}>重發個人連結</button>
                      <button type="button" disabled={busy} onClick={() => void act("remove_member", { room: room.id, code: member.code }, `把 ${member.name}（${member.code}）移出這間教室的名單？他的個人連結會失效。已經在教室裡的人不受影響；他的錄影同意紀錄不會改變。`)}>移出名單</button>
                    </li>
                  ))}
                </ul>
              )}
              <form aria-label="加入名單" onSubmit={(event) => { event.preventDefault(); const entry = newMember[room.id] ?? { code: "", name: "" }; void act("add_member", { room: room.id, code: entry.code, name: entry.name }).then((done) => { if (done) setNewMember((all) => ({ ...all, [room.id]: { code: "", name: "" } })); }); }}>
                <label className="admin-field"><span>學生代碼</span><input value={newMember[room.id]?.code ?? ""} onChange={(event) => setNewMember((all) => ({ ...all, [room.id]: { code: event.target.value, name: all[room.id]?.name ?? "" } }))} maxLength={20} /></label>
                <label className="admin-field"><span>英文名字</span><input value={newMember[room.id]?.name ?? ""} onChange={(event) => setNewMember((all) => ({ ...all, [room.id]: { code: all[room.id]?.code ?? "", name: event.target.value } }))} maxLength={40} /></label>
                <button type="submit" disabled={busy || !(newMember[room.id]?.code ?? "").trim() || !(newMember[room.id]?.name ?? "").trim()}>加入名單並產生個人連結</button>
              </form>
            </details>
          )}
          <h3>等待中</h3>
          {room.waiting.length === 0 ? <p>沒有人在等待。</p> : (
            <ul data-waiting>
              {room.waiting.map((person) => (
                <li key={person.request} data-waiting-person={person.name}>
                  {person.name}（{time(person.at)}）{person.student ? `・個人連結：代碼 ${person.student}` : ""}
                  {room.recording?.available && !person.student && (room.members ?? []).length > 0 && (
                    <label data-bind-to>　是名單上的：
                      <select value={bindings[person.request] ?? ""} onChange={(event) => setBindings((all) => ({ ...all, [person.request]: event.target.value }))}>
                        <option value="">不指定（用教室產生的代碼，不能錄影）</option>
                        {(room.members ?? []).map((member) => <option key={member.code} value={member.code}>{member.name}（{member.code}）</option>)}
                      </select>
                    </label>
                  )}
                  <button type="button" disabled={busy} onClick={() => void act("admit", { room: room.id, request: person.request, ...(bindings[person.request] ? { bindTo: bindings[person.request] } : {}) }, bindings[person.request] ? `讓「${person.name}」以名單上的 ${bindings[person.request]} 進入？請先確認他就是這位學生：錄影同意依這個代碼判斷。` : undefined)}>讓他進入</button>
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
                  {person.name}（代碼 {person.code}{person.student ? (person.boundBy === "pass" ? "・個人連結" : "・您指定的名單學生") : ""}）・{person.presence ? PRESENCE[person.presence] : "是否在線：Zoom 還沒有回報"}
                  {person.consent && <span data-consent={person.consent}>・{CONSENT[person.consent] ?? person.consent}</span>}
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
