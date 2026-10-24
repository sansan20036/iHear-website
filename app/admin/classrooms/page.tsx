"use client";

import { useCallback, useEffect, useState } from "react";
import { useAdmin } from "../admin-context";
import { adminFetch, displayError } from "../admin-api";
import "./classrooms.css";

// The live classroom overview for owners. It polls every 15 seconds while the tab is visible:
// first the server's periodic work (the same tick the tutor's heartbeat runs), then the
// overview. Cards come from the server already reduced to codes and labels.

const copy = {
  en: {
    title: "Classrooms", intro: "Live state of today's one-to-one lessons. Recording and filing only count as done when Zoom or P1 confirmed them.",
    synthetic: "Synthetic mode: test data only, not connected to Zoom or Google Drive.", ownerOnly: "Owner access is required.",
    refreshed: "Updated", tickFailed: "The server's periodic work did not run on the last refresh; the overview may lag.",
    groups: { ANOMALY: "Problems", LIVE: "In progress", WAITING: "Waiting to start", ENDED: "Ended" } as Record<string, string>,
    empty: "No lessons today.", tutor: "Tutor", student: "Student", recording: "Recording", filing: "Filing", data: "Data", scheduled: "Scheduled", started: "Started",
    check: "Check now", checking: "Checking…",
    anomalies: "Problem records", anomaliesIntro: "Every problem the overview found stays here, with who handled it and how. Write codes and actions, never names.",
    noAnomalies: "No problems recorded.", open: "Open", resolved: "Cleared", handled: "Handled", unhandled: "Needs handling", earlier: "Handled before it came back", note: "What was done", save: "Record handling", firstSeen: "First seen", lastSeen: "Last seen",
    lessons: "Lessons", add: "Add a one-to-one lesson", code: "Lesson code", date: "Date", time: "Start (Taipei)", minutes: "Minutes", tutorCode: "Tutor code", tutorEmail: "Tutor sign-in email", studentCode: "Student code",
    adding: "Adding…", linkOnce: "Student's personal link (shown only now; send it to the family):", copyLink: "Copy link", copied: "Copied",
    consent: "Synthetic consent (local testing only)", consentIntro: "The consent policy is still to be approved; these records are synthetic.", personCode: "Person code", role: "Role", status: "Status",
    granted: "Consented", withdrawn: "Withdrawn", staffNotice: "Tutor notice acknowledged", setConsent: "Save",
  },
  zhHant: {
    title: "教室總覽", intro: "今天各堂一對一課程的即時狀態。錄影與歸檔要有 Zoom 或 P1 的確認才算完成。",
    synthetic: "合成模式：只有測試資料，沒有連到 Zoom 或 Google Drive。", ownerOnly: "需要擁有者權限。",
    refreshed: "更新時間", tickFailed: "上一次更新時，伺服器排程沒有執行，總覽可能落後。",
    groups: { ANOMALY: "異常", LIVE: "進行中", WAITING: "等待開始", ENDED: "已結束" } as Record<string, string>,
    empty: "今天沒有課程。", tutor: "小老師", student: "學生", recording: "錄影", filing: "歸檔", data: "資料", scheduled: "表定", started: "實際",
    check: "重新核對", checking: "核對中…",
    anomalies: "異常紀錄", anomaliesIntro: "總覽發現的每個問題都會留在這裡，並記下誰處理、怎麼處理。請寫代碼與處置，不要寫姓名。",
    noAnomalies: "目前沒有異常紀錄。", open: "未解除", resolved: "已解除", handled: "已處置", unhandled: "待處置", earlier: "先前處置（之後又再發生）", note: "處置說明", save: "記錄處置", firstSeen: "首次發現", lastSeen: "最後出現",
    lessons: "課程", add: "新增一對一課程", code: "課程代碼", date: "日期", time: "開始時間（台北）", minutes: "分鐘", tutorCode: "小老師代碼", tutorEmail: "小老師登入 Email", studentCode: "學生代碼",
    adding: "新增中…", linkOnce: "學生專屬連結（只顯示這一次，請交給家長）：", copyLink: "複製連結", copied: "已複製",
    consent: "合成同意資料（僅限本機測試）", consentIntro: "錄影同意政策尚待確認；這裡的紀錄都是合成資料。", personCode: "人員代碼", role: "角色", status: "狀態",
    granted: "已同意", withdrawn: "已撤回", staffNotice: "小老師已確認告知", setConsent: "儲存",
  },
};

type Person = { code: string; status: string; basis: string; label: string };
type Card = {
  lessonCode: string; scheduledStart: string | null; actualStart: string | null;
  phase: { value: string; basis: string; label: string };
  tutor: Person | null; students: Person[];
  recording: { status: string; basis: string; basisLabel: string; source: string | null; label: string };
  filing: { status: string; label: string };
  anomalies: { code: string; severity: string; label: string }[];
  dataState: { value: string; label: string; lastConfirmedAt: string | null; ageSeconds: number | null };
};
type Anomaly = { lessonId: string; lessonCode: string | null; code: string; label: string; severity: string; firstSeenAt: string | null; openedAt: string | null; lastSeenAt: string | null; resolvedAt: string | null; handled: boolean; acknowledgedBy: string | null; acknowledgedAt: string | null; note: string | null };
type Lesson = { lessonId: string; code: string; startsAt: string; endsAt: string; tutorCode: string | null; studentCodes: string[] };
type Overview = { mode: string | null; dashboard: { generatedAt: string; groups: Record<string, Card[]>; counts: Record<string, number> }; anomalies: Anomaly[]; lessons: Lesson[] };

const GROUPS = ["ANOMALY", "LIVE", "WAITING", "ENDED"];
const taipei = (iso: string | null) => (iso ? new Date(new Date(iso).getTime() + 8 * 3600_000).toISOString().slice(5, 16).replace("T", " ") : "—");
const SOURCE = { zoom_webhook: "Zoom", host_sdk: "小老師端", zoom_api: "Zoom 查詢", zoom: "Zoom" } as Record<string, string>;
const emptyLesson = { code: "", date: "", time: "", minutes: "60", tutorCode: "", tutorEmail: "", studentCode: "" };

export default function ClassroomsPage() {
  const { locale, principal, setSubmitting } = useAdmin();
  const text = locale === "en" ? copy.en : copy.zhHant;
  const [overview, setOverview] = useState<Overview | null>(null);
  const [error, setError] = useState("");
  const [tickFailed, setTickFailed] = useState(false);
  const [refreshedAt, setRefreshedAt] = useState<string | null>(null);
  const [checking, setChecking] = useState("");
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [lesson, setLesson] = useState(emptyLesson);
  const [busy, setBusy] = useState(false);
  const [studentLink, setStudentLink] = useState("");
  const [copied, setCopied] = useState(false);
  const [consent, setConsent] = useState({ personCode: "", role: "student", status: "granted" });

  const refresh = useCallback(async () => {
    try {
      await adminFetch("/api/admin/classrooms/tick", { method: "POST", body: "{}" }).then(() => setTickFailed(false), () => setTickFailed(true));
      setOverview(await adminFetch<Overview>("/api/admin/classrooms"));
      setRefreshedAt(new Date().toISOString());
      setError("");
    } catch (failure) {
      setError(displayError(failure, locale));
    }
  }, [locale]);

  useEffect(() => {
    if (principal.role !== "owner") return;
    refresh();
    const timer = setInterval(() => { if (document.visibilityState === "visible") refresh(); }, 15_000);
    return () => clearInterval(timer);
  }, [principal.role, refresh]);

  if (principal.role !== "owner") return <section className="admin-page"><p className="admin-alert">{text.ownerOnly}</p></section>;

  const lessonIdOf = (code: string) => overview?.lessons.find((item) => item.code === code)?.lessonId ?? "";
  async function mutate(run: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setSubmitting(true);
    setError("");
    try {
      await run();
    } catch (failure) {
      setError(displayError(failure, locale));
    } finally {
      setBusy(false);
      setSubmitting(false);
    }
  }
  const checkNow = (code: string) => mutate(async () => {
    setChecking(code);
    try {
      await adminFetch(`/api/admin/classrooms/${encodeURIComponent(lessonIdOf(code))}/reconcile`, { method: "POST", body: "{}" });
      await refresh();
    } finally {
      setChecking("");
    }
  });
  const handle = (item: Anomaly) => mutate(async () => {
    const id = `${item.lessonId}:${item.code}`;
    await adminFetch("/api/admin/classrooms/anomalies", { method: "POST", body: JSON.stringify({ lessonId: item.lessonId, code: item.code, note: notes[id] ?? "" }) });
    setNotes((current) => ({ ...current, [id]: "" }));
    await refresh();
  });
  const addLesson = () => mutate(async () => {
    const data = await adminFetch<{ studentLink: string }>("/api/admin/classrooms", { method: "POST", body: JSON.stringify({ ...lesson, minutes: Number(lesson.minutes) }) });
    setStudentLink(`${window.location.origin}${data.studentLink}`);
    setCopied(false);
    setLesson(emptyLesson);
    await refresh();
  });
  const saveConsent = () => mutate(async () => {
    await adminFetch("/api/admin/classrooms/consents", { method: "POST", body: JSON.stringify(consent) });
    setConsent((current) => ({ ...current, personCode: "" }));
    await refresh();
  });

  const counts = overview?.dashboard.counts ?? {};
  // Open and not yet handled first, then open, then cleared; most recent first within each.
  const rank = (item: Anomaly) => (item.resolvedAt ? 2 : item.handled ? 1 : 0);
  const anomalies = [...(overview?.anomalies ?? [])].sort((a, b) => rank(a) - rank(b) || String(b.lastSeenAt).localeCompare(String(a.lastSeenAt)));
  return (
    <section className="admin-page classroom-overview">
      <header className="admin-page-head">
        <div><h1>{text.title}</h1><p>{text.intro}</p></div>
        <p className="admin-muted">{text.refreshed}: {refreshedAt ? taipei(refreshedAt) : "—"}</p>
      </header>
      {overview?.mode === "synthetic" && <p className="classroom-synthetic" role="note">{text.synthetic}</p>}
      {tickFailed && <p className="admin-alert" role="status">{text.tickFailed}</p>}
      {error && <p className="admin-alert" role="alert">{error}</p>}

      <div className="classroom-counts">
        {GROUPS.map((group) => <div key={group} className={`classroom-count classroom-${group.toLowerCase()}`}><span>{text.groups[group]}</span><strong>{counts[group] ?? 0}</strong></div>)}
      </div>

      {overview && !GROUPS.some((group) => overview.dashboard.groups[group]?.length) && <p className="admin-muted">{text.empty}</p>}
      {GROUPS.filter((group) => overview?.dashboard.groups[group]?.length).map((group) => (
        <section key={group} className="classroom-group" aria-label={text.groups[group]}>
          <h2>{text.groups[group]}（{overview!.dashboard.groups[group].length}）</h2>
          <div className="classroom-cards">
            {overview!.dashboard.groups[group].map((card) => (
              <article key={card.lessonCode} className={`classroom-card${group === "ANOMALY" ? " is-problem" : ""}`}>
                <div className="classroom-card-head">
                  <strong>{card.lessonCode}</strong>
                  <span className={`classroom-data ${card.dataState.value}`}>{card.dataState.label}</span>
                </div>
                <dl>
                  <div><dt>{text.scheduled}</dt><dd>{taipei(card.scheduledStart)}　{text.started} {taipei(card.actualStart)}　{card.phase.label}</dd></div>
                  {card.tutor && <div><dt>{text.tutor}</dt><dd>{card.tutor.code}　{card.tutor.label}</dd></div>}
                  {card.students.map((student) => <div key={student.code}><dt>{text.student}</dt><dd>{student.code}　{student.label}</dd></div>)}
                  <div><dt>{text.recording}</dt><dd>{card.recording.label}{card.recording.basis === "confirmed" && card.recording.source ? <span className="classroom-basis">（{SOURCE[card.recording.source] ?? card.recording.source}確認）</span> : null}</dd></div>
                  {card.filing.label && <div><dt>{text.filing}</dt><dd>{card.filing.label}</dd></div>}
                  <div><dt>{text.data}</dt><dd>{card.dataState.lastConfirmedAt ? taipei(card.dataState.lastConfirmedAt) : "—"}</dd></div>
                </dl>
                {card.anomalies.length > 0 && <ul className="classroom-alerts">{card.anomalies.map((item) => <li key={item.code} className={item.severity}>{item.label}</li>)}</ul>}
                <div className="admin-card-actions">
                  <button type="button" className="admin-button secondary" disabled={busy || !lessonIdOf(card.lessonCode)} onClick={() => checkNow(card.lessonCode)}>{checking === card.lessonCode ? text.checking : text.check}</button>
                </div>
              </article>
            ))}
          </div>
        </section>
      ))}

      <div className="admin-panel classroom-panel">
        <h2>{text.anomalies}</h2>
        <p className="admin-muted">{text.anomaliesIntro}</p>
        {anomalies.length ? (
          <div className="admin-table-wrap">
            <table className="admin-table">
              <tbody>
                {anomalies.map((item) => {
                  const id = `${item.lessonId}:${item.code}`;
                  return (
                    <tr key={id}>
                      <td><strong>{item.lessonCode}</strong><div className="admin-muted">{item.label}</div></td>
                      <td>
                        <span className={`admin-status ${item.resolvedAt ? "published" : "archived"}`}>{item.resolvedAt ? text.resolved : text.open}</span>{" "}
                        <span className={`classroom-severity ${item.severity}`}>{item.severity}</span>
                        {!item.resolvedAt && !item.handled && <div className="classroom-unhandled">{text.unhandled}</div>}
                      </td>
                      <td className="admin-muted">{text.firstSeen} {taipei(item.firstSeenAt)}<br />{text.lastSeen} {taipei(item.resolvedAt ?? item.lastSeenAt)}</td>
                      <td>
                        {item.acknowledgedBy && <p className={`classroom-handled${item.handled ? "" : " is-earlier"}`}>{item.handled ? text.handled : text.earlier}：{item.note}（{item.acknowledgedBy}，{taipei(item.acknowledgedAt)}）</p>}
                        <div className="admin-toolbar">
                          <input className="admin-search" value={notes[id] ?? ""} maxLength={500} placeholder={text.note} onChange={(event) => setNotes((current) => ({ ...current, [id]: event.target.value }))} />
                          <button type="button" className="admin-button secondary" disabled={busy || !(notes[id] ?? "").trim()} onClick={() => handle(item)}>{text.save}</button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : <p className="admin-muted">{text.noAnomalies}</p>}
      </div>

      <div className="admin-panel classroom-panel">
        <h2>{text.add}</h2>
        <div className="classroom-form">
          {(["code", "date", "time", "minutes", "tutorCode", "tutorEmail", "studentCode"] as const).map((field) => (
            <label key={field} className="admin-field">
              <span>{text[field]}</span>
              <input
                className="admin-search"
                type={field === "date" ? "date" : field === "time" ? "time" : field === "minutes" ? "number" : field === "tutorEmail" ? "email" : "text"}
                value={lesson[field]}
                onChange={(event) => setLesson((current) => ({ ...current, [field]: event.target.value }))}
              />
            </label>
          ))}
        </div>
        <button type="button" className="admin-button primary" disabled={busy} onClick={addLesson}>{busy ? text.adding : text.add}</button>
        {studentLink && (
          <div className="classroom-link" role="status">
            <p>{text.linkOnce}</p>
            <code>{studentLink}</code>
            <button type="button" className="admin-button secondary" onClick={() => navigator.clipboard?.writeText(studentLink).then(() => setCopied(true), () => setCopied(false))}>{copied ? text.copied : text.copyLink}</button>
          </div>
        )}
        {overview?.lessons.length ? (
          <div className="admin-table-wrap">
            <table className="admin-table">
              <tbody>
                {overview.lessons.map((item) => <tr key={item.lessonId}><td><strong>{item.code}</strong></td><td>{taipei(item.startsAt)}–{taipei(item.endsAt).slice(-5)}</td><td>{text.tutor} {item.tutorCode}</td><td>{text.student} {item.studentCodes.join("、")}</td></tr>)}
              </tbody>
            </table>
          </div>
        ) : null}
      </div>

      {overview?.mode === "synthetic" && (
        <div className="admin-panel classroom-panel">
          <h2>{text.consent}</h2>
          <p className="admin-muted">{text.consentIntro}</p>
          <div className="admin-toolbar">
            <input className="admin-search" value={consent.personCode} placeholder={text.personCode} onChange={(event) => setConsent((current) => ({ ...current, personCode: event.target.value }))} />
            <select className="admin-select" value={consent.role} aria-label={text.role} onChange={(event) => setConsent((current) => ({ ...current, role: event.target.value }))}>
              <option value="student">{text.student}</option>
              <option value="tutor">{text.tutor}</option>
            </select>
            {consent.role === "student" ? (
              <select className="admin-select" value={consent.status} aria-label={text.status} onChange={(event) => setConsent((current) => ({ ...current, status: event.target.value }))}>
                <option value="granted">{text.granted}</option>
                <option value="withdrawn">{text.withdrawn}</option>
              </select>
            ) : <span className="admin-muted">{text.staffNotice}</span>}
            <button type="button" className="admin-button secondary" disabled={busy || !consent.personCode.trim()} onClick={saveConsent}>{text.setConsent}</button>
          </div>
        </div>
      )}
    </section>
  );
}
