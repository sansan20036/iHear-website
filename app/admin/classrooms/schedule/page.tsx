"use client";

import { useCallback, useEffect, useState } from "react";
import { useAdmin } from "../../admin-context";

// P3-Multi (draft 030, §10): owners keep programs (教學計畫) and courses (課程), and import a
// course's schedule from CSV together with iHear's people directory. The preview changes nothing;
// the blocks are made only when the owner confirms the time zone and the previewed plan. Nothing
// here opens a Zoom session or records. Synthetic data only until the policies are approved.

type Course = { id: string; code: string; name: string; timeZone: string; cancelled: boolean; blocks: number; upcoming: number };
type Program = { id: string; code: string; name: string; archived: boolean; courses: Course[] };
type Issue = { code: string; detail: string; blocking: boolean };
type PlanBlock = {
  code: string; sourceKey: string; status: string; source: { date: string; start: string; end: string; timeZone: string }; taipei: { date: string; time: string };
  rooms: string[]; members: { code: string; role: string }[]; assignments: { member: string; room: string }[]; differences: string[]; issues: Issue[];
};
type Plan = { ready: boolean; planHash: string; issues: Issue[]; ignoredColumns: string[]; blocks: PlanBlock[]; counts: Record<string, number> };
type Applied = { created: { code: string; blockId: string; studentLinks: { code: string; link: string }[] }[]; unchanged: string[]; changed: { code: string; differences: string[] }[] };

const ZONES = ["America/New_York", "America/Chicago", "America/Los_Angeles", "Asia/Taipei", "Asia/Shanghai", "Europe/London"];
const STATUS: Record<string, string> = { new: "新增", unchanged: "已存在（相同）", changed: "已存在（有差異，需人工處理）", blocked: "有問題，不會建立" };

async function post(url: string, body: unknown) {
  const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { response, data: await response.json().catch(() => ({})) };
}

export default function ClassroomSchedulePage() {
  const { principal } = useAdmin();
  const owner = principal.role === "owner";
  const [programs, setPrograms] = useState<Program[]>([]);
  const [note, setNote] = useState("");
  const [programForm, setProgramForm] = useState({ code: "", name: "" });
  const [courseForm, setCourseForm] = useState({ program: "", code: "", name: "", timeZone: "America/New_York" });
  const [importForm, setImportForm] = useState({ course: "", manager: "", schedule: "", directory: "", zoneConfirmed: false });
  const [plan, setPlan] = useState<Plan | null>(null);
  const [applied, setApplied] = useState<Applied | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const response = await fetch("/api/admin/classrooms/programs", { cache: "no-store" });
    const data = await response.json().catch(() => ({}));
    if (response.ok && Array.isArray(data?.programs)) setPrograms(data.programs);
  }, []);
  useEffect(() => { if (owner) void load(); }, [owner, load]);

  const courses = programs.flatMap((program) => program.courses.map((course) => ({ ...course, program })));
  const chosen = courses.find((course) => course.id === importForm.course) ?? null;
  const explain = (data: { issues?: Record<string, string>; error?: string; code?: string }) => (data.issues ? Object.entries(data.issues).map(([field, text]) => `${field}: ${text}`).join("；") : data.error ?? data.code ?? "失敗");

  async function change(action: string, input: Record<string, unknown>, id?: string) {
    const { response, data } = await post("/api/admin/classrooms/programs", { action, input, ...(id ? { id } : {}) });
    setNote(response.ok ? "已儲存。" : explain(data));
    await load();
  }

  async function readFile(event: React.ChangeEvent<HTMLInputElement>, key: "schedule" | "directory") {
    const file = event.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    setImportForm((form) => ({ ...form, [key]: text }));
    setPlan(null);
  }

  const importBody = () => ({ course: importForm.course, timeZone: chosen?.timeZone, manager: importForm.manager, schedule: importForm.schedule, directory: importForm.directory });
  async function preview() {
    setBusy(true); setApplied(null); setNote("");
    try {
      const { response, data } = await post("/api/admin/classrooms/import", { action: "preview", ...importBody() });
      if (response.ok) setPlan(data.plan as Plan); else { setPlan(null); setNote(explain(data)); }
    } finally { setBusy(false); }
  }
  async function apply() {
    if (!plan || !importForm.zoneConfirmed) return;
    if (!window.confirm(`建立 ${plan.counts.new} 個新班次？已存在的班次不會被修改。`)) return;
    setBusy(true);
    try {
      const { response, data } = await post("/api/admin/classrooms/import", { action: "apply", planHash: plan.planHash, ...importBody() });
      if (response.ok) { setApplied(data as Applied); setPlan(null); await load(); } else { setNote(explain(data)); if (data.plan) setPlan(data.plan as Plan); }
    } finally { setBusy(false); }
  }

  if (!owner) return <section className="admin-panel"><h1>課程與課表匯入</h1><p>需要擁有者權限。</p></section>;
  return (
    <section className="admin-panel">
      <h1>課程與課表匯入</h1>
      <p role="note">教學計畫 → 課程 → 班次。課表依課程的時區讀取；預覽不會改變任何資料，確認後才建立班次。匯入不會開啟 Zoom，也不會錄影。合成資料測試用。</p>
      {note && <p role="alert">{note}</p>}

      <h2>教學計畫與課程</h2>
      <table aria-label="教學計畫與課程">
        <thead><tr><th>計畫</th><th>課程</th><th>時區</th><th>班次（未結束）</th><th>狀態</th><th>操作</th></tr></thead>
        <tbody>
          {courses.map((course) => (
            <tr key={course.id} data-course={course.code}>
              <td>{course.program.code} {course.program.name}</td><td>{course.code} {course.name}</td><td>{course.timeZone}</td>
              <td>{course.blocks}（{course.upcoming}）</td><td>{course.cancelled ? "已取消" : "進行中"}</td>
              <td>
                <button type="button" onClick={() => { const name = window.prompt("新的課程名稱", course.name); if (name) void change("update_course", { name }, course.id); }}>改名</button>
                {!course.cancelled && <button type="button" onClick={() => { if (window.confirm(`取消課程 ${course.code}？之後不能再建立或匯入班次；已建立的 ${course.upcoming} 個班次維持原狀，需各自取消。`)) void change("update_course", { cancelled: true }, course.id); }}>取消課程</button>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <form aria-label="新增教學計畫" onSubmit={(event) => { event.preventDefault(); void change("create_program", programForm); }}>
        <label className="admin-field"><span>計畫代碼</span><input value={programForm.code} onChange={(event) => setProgramForm({ ...programForm, code: event.target.value })} /></label>
        <label className="admin-field"><span>計畫名稱</span><input value={programForm.name} onChange={(event) => setProgramForm({ ...programForm, name: event.target.value })} /></label>
        <button type="submit">新增教學計畫</button>
      </form>
      <form aria-label="新增課程" onSubmit={(event) => { event.preventDefault(); void change("create_course", courseForm); }}>
        <label className="admin-field"><span>所屬計畫</span>
          <select value={courseForm.program} onChange={(event) => setCourseForm({ ...courseForm, program: event.target.value })}>
            <option value="">請選擇</option>{programs.filter((program) => !program.archived).map((program) => <option key={program.id} value={program.id}>{program.code}</option>)}
          </select></label>
        <label className="admin-field"><span>課程代碼</span><input value={courseForm.code} onChange={(event) => setCourseForm({ ...courseForm, code: event.target.value })} /></label>
        <label className="admin-field"><span>課程名稱</span><input value={courseForm.name} onChange={(event) => setCourseForm({ ...courseForm, name: event.target.value })} /></label>
        <label className="admin-field"><span>課表的時區（之後不能改）</span>
          <select value={courseForm.timeZone} onChange={(event) => setCourseForm({ ...courseForm, timeZone: event.target.value })}>{ZONES.map((zone) => <option key={zone}>{zone}</option>)}</select></label>
        <button type="submit">新增課程</button>
      </form>

      <h2>課表匯入（CSV）</h2>
      <p>課表欄位：Tutee, Date, Start, End, Lead Tutor, Co-Tutor, Observer, Pre-assign Room Name, Email Address。人員名冊欄位：Code, Role（student／tutor／observer／manager）, English Name, Sign-in Email, Schedule Names（課表上使用的名字，以分號分隔）。名字只做完全相符的比對；找不到或對到兩個人時，會標示「待人工確認」。</p>
      <label className="admin-field"><span>課程</span>
        <select value={importForm.course} onChange={(event) => { setImportForm({ ...importForm, course: event.target.value, zoneConfirmed: false }); setPlan(null); }}>
          <option value="">請選擇</option>{courses.filter((course) => !course.cancelled).map((course) => <option key={course.id} value={course.id}>{course.code}（{course.timeZone}）</option>)}
        </select></label>
      <label className="admin-field"><span>管理老師（名冊代碼）</span><input value={importForm.manager} onChange={(event) => { setImportForm({ ...importForm, manager: event.target.value }); setPlan(null); }} /></label>
      <label className="admin-field"><span>課表 CSV</span><input type="file" accept=".csv,text/csv" onChange={(event) => void readFile(event, "schedule")} />
        <textarea rows={6} value={importForm.schedule} onChange={(event) => { setImportForm({ ...importForm, schedule: event.target.value }); setPlan(null); }} /></label>
      <label className="admin-field"><span>人員名冊 CSV</span><input type="file" accept=".csv,text/csv" onChange={(event) => void readFile(event, "directory")} />
        <textarea rows={6} value={importForm.directory} onChange={(event) => { setImportForm({ ...importForm, directory: event.target.value }); setPlan(null); }} /></label>
      <button type="button" disabled={busy || !importForm.course} onClick={() => void preview()}>預覽</button>

      {plan && (
        <div data-plan={plan.planHash.slice(0, 12)} data-ready={plan.ready}>
          <p role="status">新增 {plan.counts.new}、已存在 {plan.counts.unchanged}、有差異 {plan.counts.changed}、有問題 {plan.counts.blocked}（共 {plan.counts.rows} 列）。{plan.ignoredColumns.length ? `未使用的欄位：${plan.ignoredColumns.join("、")}` : ""}</p>
          {plan.issues.length > 0 && <ul aria-label="整份課表的問題">{plan.issues.map((issue, index) => <li key={index} data-issue={issue.code}>{issue.blocking ? "【需處理】" : "【提醒】"}{issue.detail}</li>)}</ul>}
          <table aria-label="匯入預覽">
            <thead><tr><th>班次</th><th>來源時間（{chosen?.timeZone}）</th><th>台北時間</th><th>教室與人員</th><th>結果</th><th>問題或差異</th></tr></thead>
            <tbody>
              {plan.blocks.map((block) => (
                <tr key={block.sourceKey} data-plan-block={block.code} data-status={block.status}>
                  <td>{block.code}</td><td>{block.source.date} {block.source.start}–{block.source.end}</td><td>{block.taipei.date} {block.taipei.time}</td>
                  <td>{block.rooms.map((room) => `${room}: ${block.assignments.filter((seat) => seat.room === room).map((seat) => seat.member).join(", ")}`).join("；")}</td>
                  <td>{STATUS[block.status] ?? block.status}</td>
                  <td>{[...block.issues.map((issue) => `${issue.blocking ? "【需處理】" : "【提醒】"}${issue.detail}`), ...block.differences].join("；")}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <label><input type="checkbox" checked={importForm.zoneConfirmed} onChange={(event) => setImportForm({ ...importForm, zoneConfirmed: event.target.checked })} /> 我確認課表上的時間是 {chosen?.timeZone} 的時間</label>
          <button type="button" disabled={busy || !plan.ready || !importForm.zoneConfirmed} onClick={() => void apply()}>確認並建立 {plan.counts.new} 個班次</button>
        </div>
      )}
      {applied && (
        <div role="status" data-applied={applied.created.length}>
          <p>已建立 {applied.created.length} 個班次；相同而略過 {applied.unchanged.length} 個；有差異未處理 {applied.changed.length} 個。</p>
          {applied.created.map((block) => (
            <div key={block.blockId}>
              <p><a href={`/classroom/b/${block.blockId}/manage`}>{block.code}</a> 學生個人連結（只顯示這一次，請交給家長）：</p>
              <ul>{block.studentLinks.map((entry) => <li key={entry.code} data-student-link={entry.code}>{entry.code}：<code>{`${window.location.origin}${entry.link}`}</code></li>)}</ul>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
