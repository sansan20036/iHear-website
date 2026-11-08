"use client";

import { useCallback, useEffect, useState } from "react";
import { useAdmin } from "../../admin-context";

// P3-Multi (2026-11-09): owners add a block (班次): a Lobby, teaching rooms, the people (with the
// confirmed English name each one uses in Drive's file names) and their first rooms. The
// students' personal links are shown once, right after adding. The block is then run from its own
// manage page by its manager. Synthetic data only until the policies are approved.

type BlockRow = { blockId: string; code: string; startsAt: string; endsAt: string; cancelled: boolean; rooms: number; members: number };
type Created = { block: { blockId: string; code: string }; studentLinks: { code: string; link: string }[] };

const ROLES = ["manager", "lead_tutor", "co_tutor", "observer", "student"];

// One person per line: role, code, English name, e-mail (staff only). One seat per line: code, room.
function parseMembers(text: string) {
  return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
    const [role, code, englishName, email] = line.split(",").map((part) => part.trim());
    return { role, code, englishName, ...(email ? { email } : {}) };
  });
}
function parseSeats(text: string) {
  return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
    const [member, room] = line.split(",").map((part) => part.trim());
    return { member, room };
  });
}

export default function ClassroomBlocksPage() {
  const { principal } = useAdmin();
  const [blocks, setBlocks] = useState<BlockRow[]>([]);
  const [form, setForm] = useState({ code: "", date: "", time: "", minutes: "60", rooms: "R1,R2", members: "", seats: "" });
  const [created, setCreated] = useState<Created | null>(null);
  const [problem, setProblem] = useState("");
  const [busy, setBusy] = useState(false);
  const owner = principal.role === "owner";

  const load = useCallback(async () => {
    const response = await fetch("/api/admin/classrooms/blocks", { cache: "no-store" });
    const data = await response.json().catch(() => ({}));
    if (response.ok && Array.isArray(data?.blocks)) setBlocks(data.blocks);
  }, []);
  useEffect(() => { if (owner) void load(); }, [owner, load]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setProblem("");
    setCreated(null);
    try {
      const response = await fetch("/api/admin/classrooms/blocks", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code: form.code, date: form.date, time: form.time, minutes: Number(form.minutes),
          rooms: form.rooms.split(",").map((label) => label.trim()).filter(Boolean),
          members: parseMembers(form.members), assignments: parseSeats(form.seats),
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        setProblem(data?.issues ? Object.entries(data.issues).map(([field, text]) => `${field}: ${text}`).join("；") : data?.error ?? "無法建立班次。");
        return;
      }
      setCreated(data as Created);
      await load();
    } finally {
      setBusy(false);
    }
  }

  if (!owner) return <section className="admin-panel"><h1>多人班次</h1><p>需要擁有者權限。</p></section>;
  const field = (name: keyof typeof form, label: string, type = "text") => (
    <label className="admin-field"><span>{label}</span><input type={type} value={form[name]} onChange={(event) => setForm({ ...form, [name]: event.target.value })} /></label>
  );
  return (
    <section className="admin-panel">
      <h1>多人班次</h1>
      <p role="note">合成模式測試用。每個班次有一個主會議室（永不錄影）和多間教學房間，每間最多 10 人。預設 Classroom Only（不錄影）。</p>
      <form onSubmit={submit} aria-label="建立班次">
        {field("code", "班次代碼")}
        {field("date", "日期", "date")}
        {field("time", "開始時間（台北）", "time")}
        {field("minutes", "分鐘", "number")}
        {field("rooms", "教學房間（以逗號分隔）")}
        <label className="admin-field"><span>人員（每行：角色,代碼,英文姓名,Email；角色：{ROLES.join(" / ")}；學生不填 Email）</span>
          <textarea rows={8} value={form.members} onChange={(event) => setForm({ ...form, members: event.target.value })} /></label>
        <label className="admin-field"><span>分房（每行：代碼,教室）</span>
          <textarea rows={6} value={form.seats} onChange={(event) => setForm({ ...form, seats: event.target.value })} /></label>
        <button type="submit" disabled={busy}>{busy ? "建立中…" : "建立班次"}</button>
      </form>
      {problem && <p role="alert">{problem}</p>}
      {created && (
        <div role="status" data-created={created.block.blockId}>
          <p>已建立班次 {created.block.code}。<a href={`/classroom/b/${created.block.blockId}/manage`}>開啟班次管理</a></p>
          <p>學生個人連結（只顯示這一次，請交給家長）：</p>
          <ul>{created.studentLinks.map((entry) => <li key={entry.code} data-student-link={entry.code}>{entry.code}：<code>{`${window.location.origin}${entry.link}`}</code></li>)}</ul>
        </div>
      )}
      <h2>班次</h2>
      <ul>{blocks.map((block) => <li key={block.blockId}><a href={`/classroom/b/${block.blockId}/manage`}>{block.code}</a>（{block.rooms} 間教室，{block.members} 人{block.cancelled ? "，已取消" : ""}）</li>)}</ul>
    </section>
  );
}
