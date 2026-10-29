"use client";

import { useEffect, useMemo, useState } from "react";

import {
  HOME_CALENDAR_LIMITS,
  HOME_CALENDAR_MAX_EVENTS,
  HomeCalendarValidationError,
  parseHomeCalendarConfig,
  type HomeCalendarConfig,
  type HomeCalendarEvent,
} from "../../../lib/home-calendar-types";
import { adminFetch, displayError } from "../admin-api";
import { useAdmin, type AdminLocale } from "../admin-context";

type Published = { config: HomeCalendarConfig; recordVersion: number };
type Draft = { id: string; title: string; date: string; allDay: boolean; startTime: string; endTime: string; description: string; linkUrl: string; linkLabel: string };

const copy = {
  zhHant: {
    title: "首頁行事曆", intro: "新增、修改或刪除的活動，儲存後會立即顯示在首頁；訪客只能查看。",
    zone: "所有時間請以台北時間（UTC+8）填寫。首頁會顯示台北時間，訪客在其他時區時再附上當地時間。",
    viewHome: "查看首頁", add: "新增活動", upcoming: "即將到來的活動", past: "已過去的活動", noEvents: "目前沒有活動。按「新增活動」開始建立。",
    noUpcoming: "沒有即將到來的活動。", edit: "修改", remove: "刪除", confirmRemove: (name: string) => `確定要刪除「${name}」嗎？刪除後首頁會立即移除。`,
    confirmDelete: "確定刪除", cancel: "取消", newTitle: "新增活動", editTitle: "修改活動", name: "活動名稱", date: "日期", allDay: "全天活動（不設定時間）",
    start: "開始時間", end: "結束時間（可不填）", description: "說明（可不填）", linkUrl: "相關連結（可不填）", linkUrlHelp: "完整網址，例如 https://…",
    linkLabel: "連結文字（可不填）", linkLabelHelp: "不填時顯示「相關連結」", save: "儲存", saving: "儲存中…", saved: "已儲存，首頁已更新。", deleted: "已刪除，首頁已更新。",
    loading: "正在載入行事曆…", unavailable: "行事曆暫時無法載入，請稍後重新整理。", conflict: "其他管理員剛更新了行事曆。你的草稿仍在畫面上；請按「重新載入」後再儲存。",
    reload: "重新載入", signin: "登入已過期，請在新分頁重新登入後再儲存。", forbidden: "這個帳號目前沒有管理權限。", allDayLabel: "全天", taipei: "台北時間",
    counter: (count: number, max: number) => `${count}/${max} 字`, full: `行事曆最多 ${HOME_CALENDAR_MAX_EVENTS} 個活動，請先刪除已過去的活動。`,
    problems: { required: "此欄位不能空白。", too_long: "內容太長。", single_line: "請保持一行，不要換行。", unsupported: "含有無法儲存的字元。",
      invalid_date: "請選擇日期。", invalid_time: "請輸入時間。", end_before_start: "結束時間要晚於開始時間。", invalid_link: "請輸入以 https:// 開頭的完整網址。", other: "請檢查這個欄位。" },
  },
  zhHans: {
    title: "首页行事历", intro: "新增、修改或删除的活动，保存后会立即显示在首页；访客只能查看。",
    zone: "所有时间请以台北时间（UTC+8）填写。首页会显示台北时间，访客在其他时区时再附上当地时间。",
    viewHome: "查看首页", add: "新增活动", upcoming: "即将到来的活动", past: "已过去的活动", noEvents: "目前没有活动。按“新增活动”开始建立。",
    noUpcoming: "没有即将到来的活动。", edit: "修改", remove: "删除", confirmRemove: (name: string) => `确定要删除“${name}”吗？删除后首页会立即移除。`,
    confirmDelete: "确定删除", cancel: "取消", newTitle: "新增活动", editTitle: "修改活动", name: "活动名称", date: "日期", allDay: "全天活动（不设定时间）",
    start: "开始时间", end: "结束时间（可不填）", description: "说明（可不填）", linkUrl: "相关链接（可不填）", linkUrlHelp: "完整网址，例如 https://…",
    linkLabel: "链接文字（可不填）", linkLabelHelp: "不填时显示“相关链接”", save: "保存", saving: "保存中…", saved: "已保存，首页已更新。", deleted: "已删除，首页已更新。",
    loading: "正在加载行事历…", unavailable: "行事历暂时无法加载，请稍后刷新。", conflict: "其他管理员刚更新了行事历。你的草稿仍在画面上；请按“重新加载”后再保存。",
    reload: "重新加载", signin: "登录已过期，请在新标签页重新登录后再保存。", forbidden: "这个账号目前没有管理权限。", allDayLabel: "全天", taipei: "台北时间",
    counter: (count: number, max: number) => `${count}/${max} 字`, full: `行事历最多 ${HOME_CALENDAR_MAX_EVENTS} 个活动，请先删除已过去的活动。`,
    problems: { required: "此栏位不能空白。", too_long: "内容太长。", single_line: "请保持一行，不要换行。", unsupported: "含有无法保存的字符。",
      invalid_date: "请选择日期。", invalid_time: "请输入时间。", end_before_start: "结束时间要晚于开始时间。", invalid_link: "请输入以 https:// 开头的完整网址。", other: "请检查这个栏位。" },
  },
  en: {
    title: "Homepage calendar", intro: "Events you add, change or delete appear on the homepage as soon as you save. Visitors can only view them.",
    zone: "Enter every time in Taipei time (UTC+8). The homepage shows Taipei time and, for visitors in another time zone, their local time too.",
    viewHome: "View homepage", add: "Add event", upcoming: "Upcoming events", past: "Past events", noEvents: "No events yet. Choose “Add event” to create one.",
    noUpcoming: "No upcoming events.", edit: "Edit", remove: "Delete", confirmRemove: (name: string) => `Delete “${name}”? It disappears from the homepage at once.`,
    confirmDelete: "Delete", cancel: "Cancel", newTitle: "Add event", editTitle: "Edit event", name: "Event name", date: "Date", allDay: "All-day event (no time)",
    start: "Start time", end: "End time (optional)", description: "Description (optional)", linkUrl: "Link (optional)", linkUrlHelp: "A full address, such as https://…",
    linkLabel: "Link text (optional)", linkLabelHelp: "Shown as “Related link” when empty", save: "Save", saving: "Saving…", saved: "Saved. The homepage is updated.", deleted: "Deleted. The homepage is updated.",
    loading: "Loading the calendar…", unavailable: "The calendar is temporarily unavailable. Refresh later.", conflict: "Another administrator just updated the calendar. Your draft is still here; choose “Reload” and save again.",
    reload: "Reload", signin: "Your sign-in expired. Sign in again in a new tab, then save.", forbidden: "This account has no administrator access.", allDayLabel: "All day", taipei: "Taipei time",
    counter: (count: number, max: number) => `${count}/${max} characters`, full: `The calendar holds at most ${HOME_CALENDAR_MAX_EVENTS} events. Delete past events first.`,
    problems: { required: "This field is required.", too_long: "This is too long.", single_line: "Keep this on one line.", unsupported: "Remove unsupported characters.",
      invalid_date: "Choose a date.", invalid_time: "Enter a time.", end_before_start: "The end time must be after the start time.", invalid_link: "Enter a full address starting with https://.", other: "Check this field." },
  },
};

function taipeiToday() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

function dateLabel(date: string, locale: AdminLocale) {
  const [year, month, day] = date.split("-").map(Number);
  return new Intl.DateTimeFormat(locale === "en" ? "en-US" : locale === "zhHans" ? "zh-CN" : "zh-TW", {
    timeZone: "UTC", year: "numeric", month: "long", day: "numeric", weekday: "short",
  }).format(new Date(Date.UTC(year, month - 1, day)));
}

const emptyDraft = (): Draft => ({ id: crypto.randomUUID(), title: "", date: taipeiToday(), allDay: false, startTime: "", endTime: "", description: "", linkUrl: "", linkLabel: "" });
const toDraft = (item: HomeCalendarEvent): Draft => ({
  id: item.id, title: item.title, date: item.date, allDay: !item.startTime, startTime: item.startTime ?? "", endTime: item.endTime ?? "",
  description: item.description, linkUrl: item.link?.url ?? "", linkLabel: item.link?.label ?? "",
});
const fromDraft = (draft: Draft): HomeCalendarEvent => ({
  id: draft.id, title: draft.title, date: draft.date, startTime: draft.allDay ? null : draft.startTime || null,
  endTime: draft.allDay ? null : draft.endTime || null, description: draft.description,
  link: draft.linkUrl.trim() || draft.linkLabel.trim() ? { url: draft.linkUrl, label: draft.linkLabel } : null,
});
// Validation errors name the field as events.<index>.<name>; the form shows them by name.
const fieldOf = (field: string) => field.split(".").slice(2).join(".");

export default function HomeCalendarAdminPage() {
  const { locale, setDirty, setSubmitting } = useAdmin();
  const text = copy[locale];
  const [published, setPublished] = useState<Published | null>(null);
  const [loadError, setLoadError] = useState("");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [original, setOriginal] = useState("");
  const [problem, setProblem] = useState<{ field: string; code: string } | null>(null);
  const [message, setMessage] = useState<{ kind: "success" | "error"; text: string; reload?: boolean } | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    setLoadError("");
    try { setPublished(await adminFetch<Published>("/api/home-calendar")); }
    catch { setLoadError(text.unavailable); }
  }
  useEffect(() => { void load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const dirty = Boolean(draft && JSON.stringify(draft) !== original);
  useEffect(() => { setDirty("home-calendar-form", dirty); return () => setDirty("home-calendar-form", false); }, [dirty, setDirty]);

  const today = taipeiToday();
  const events = published?.config.events ?? [];
  const upcoming = useMemo(() => events.filter(item => item.date >= today), [events, today]);
  const past = useMemo(() => events.filter(item => item.date < today).reverse(), [events, today]);

  function open(next: Draft) { setDraft(next); setOriginal(JSON.stringify(next)); setProblem(null); setMessage(null); setConfirming(null); }

  async function save(nextEvents: HomeCalendarEvent[], done: string) {
    if (!published || busy) return false;
    let config: HomeCalendarConfig;
    try { config = parseHomeCalendarConfig({ ...published.config, events: nextEvents }); }
    catch (error) {
      if (error instanceof HomeCalendarValidationError) {
        setProblem({ field: fieldOf(error.field), code: error.code });
        setMessage({ kind: "error", text: error.code === "too_many" ? text.full : text.problems.other });
      }
      return false;
    }
    setBusy(true); setSubmitting(true); setMessage(null);
    try {
      const saved = await adminFetch<Published>("/api/home-calendar", { method: "POST", body: JSON.stringify({ config, expectedVersion: published.recordVersion }) });
      setPublished({ config: saved.config, recordVersion: saved.recordVersion });
      setMessage({ kind: "success", text: done });
      return true;
    } catch (error) {
      const status = (error as { status?: number }).status;
      setMessage({
        kind: "error", reload: status === 409,
        text: status === 409 ? text.conflict : status === 401 ? text.signin : status === 403 ? text.forbidden : displayError(error, locale),
      });
      return false;
    } finally { setBusy(false); setSubmitting(false); }
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!draft || !published) return;
    setProblem(null);
    const item = fromDraft(draft);
    const nextEvents = published.config.events.some(existing => existing.id === item.id)
      ? published.config.events.map(existing => existing.id === item.id ? item : existing)
      : [...published.config.events, item];
    if (await save(nextEvents, text.saved)) { setDraft(null); setOriginal(""); }
  }

  async function remove(id: string) {
    if (!published) return;
    if (await save(published.config.events.filter(item => item.id !== id), text.deleted)) {
      setConfirming(null);
      if (draft?.id === id) { setDraft(null); setOriginal(""); }
    }
  }

  // Editing a field clears the previous problem; the next save checks again.
  const edit = (patch: Partial<Draft>) => { if (draft) setDraft({ ...draft, ...patch }); setProblem(null); };
  const invalid = (name: string) => problem?.field === name || problem?.field.startsWith(`${name}.`) ? "true" : undefined;
  const problemText = (name: string) => invalid(name) && problem ? (text.problems as Record<string, string>)[problem.code] ?? text.problems.other : "";
  const timeLabel = (item: HomeCalendarEvent) => item.startTime ? `${item.startTime}${item.endTime ? `–${item.endTime}` : ""} ${text.taipei}` : text.allDayLabel;

  const card = (item: HomeCalendarEvent) => (
    <article className="admin-card admin-calendar-event" key={item.id} data-calendar-event={item.id}>
      <div className="admin-calendar-when"><strong>{dateLabel(item.date, locale)}</strong><span>{timeLabel(item)}</span></div>
      <h3>{item.title}</h3>
      {item.description && <p className="admin-calendar-description">{item.description}</p>}
      {item.link && <p><a href={item.link.url} target="_blank" rel="noopener noreferrer">{item.link.label || item.link.url}</a></p>}
      {confirming === item.id ? (
        <div className="admin-calendar-confirm" role="group" aria-label={text.remove}>
          <p>{text.confirmRemove(item.title)}</p>
          <div className="admin-actions">
            <button type="button" className="admin-button danger" disabled={busy} onClick={() => void remove(item.id)}>{busy ? text.saving : text.confirmDelete}</button>
            <button type="button" className="admin-button secondary" disabled={busy} onClick={() => setConfirming(null)}>{text.cancel}</button>
          </div>
        </div>
      ) : (
        <div className="admin-actions">
          <button type="button" className="admin-button secondary" disabled={busy} onClick={() => open(toDraft(item))}>{text.edit}</button>
          <button type="button" className="admin-button secondary" disabled={busy} onClick={() => { setConfirming(item.id); setMessage(null); }}>{text.remove}</button>
        </div>
      )}
    </article>
  );

  return (
    <section className="admin-page admin-calendar">
      <header className="admin-page-head">
        <div><h1>{text.title}</h1><p>{text.intro}</p><p className="admin-calendar-zone">{text.zone}</p></div>
        <div className="admin-actions">
          <a className="admin-button secondary" href="/" target="_blank" rel="noopener noreferrer">{text.viewHome}</a>
          <button type="button" className="admin-button primary" disabled={!published || busy || Boolean(draft)} onClick={() => open(emptyDraft())}>{text.add}</button>
        </div>
      </header>
      {message && (
        <div className={`admin-alert${message.kind === "success" ? " success" : ""}`} role={message.kind === "success" ? "status" : "alert"}>
          {message.text}
          {message.reload && <> <button type="button" className="admin-button secondary" onClick={() => void load().then(() => setMessage(null))}>{text.reload}</button></>}
        </div>
      )}
      {loadError && <p className="admin-alert" role="alert">{loadError}</p>}
      {!published && !loadError && <p className="admin-muted">{text.loading}</p>}

      {draft && (
        <form className="admin-panel admin-calendar-form" onSubmit={event => void submit(event)} noValidate>
          <h2>{events.some(item => item.id === draft.id) ? text.editTitle : text.newTitle}</h2>
          <div className="admin-form-grid">
            <label className="admin-field admin-calendar-wide">
              <span>{text.name} <small>{text.counter([...draft.title].length, HOME_CALENDAR_LIMITS.title)}</small></span>
              <input name="title" value={draft.title} maxLength={HOME_CALENDAR_LIMITS.title} required aria-invalid={invalid("title")} onChange={event => edit({ title: event.target.value })} />
              {problemText("title") && <small className="admin-calendar-problem">{problemText("title")}</small>}
            </label>
            <label className="admin-field">
              <span>{text.date}</span>
              <input type="date" name="date" value={draft.date} required min="2000-01-01" max="2100-12-31" aria-invalid={invalid("date")} onChange={event => edit({ date: event.target.value })} />
              {problemText("date") && <small className="admin-calendar-problem">{problemText("date")}</small>}
            </label>
            <label className="admin-checkbox admin-calendar-allday">
              <input type="checkbox" name="allDay" checked={draft.allDay} onChange={event => edit({ allDay: event.target.checked })} />
              <span>{text.allDay}</span>
            </label>
            {!draft.allDay && <>
              <label className="admin-field">
                <span>{text.start} <small>{text.taipei}</small></span>
                <input type="time" name="startTime" value={draft.startTime} aria-invalid={invalid("startTime")} onChange={event => edit({ startTime: event.target.value })} />
                {problemText("startTime") && <small className="admin-calendar-problem">{problemText("startTime")}</small>}
              </label>
              <label className="admin-field">
                <span>{text.end} <small>{text.taipei}</small></span>
                <input type="time" name="endTime" value={draft.endTime} aria-invalid={invalid("endTime")} onChange={event => edit({ endTime: event.target.value })} />
                {problemText("endTime") && <small className="admin-calendar-problem">{problemText("endTime")}</small>}
              </label>
            </>}
            <label className="admin-field admin-calendar-wide">
              <span>{text.description} <small>{text.counter([...draft.description].length, HOME_CALENDAR_LIMITS.description)}</small></span>
              <textarea name="description" rows={4} value={draft.description} maxLength={HOME_CALENDAR_LIMITS.description} aria-invalid={invalid("description")} onChange={event => edit({ description: event.target.value })} />
              {problemText("description") && <small className="admin-calendar-problem">{problemText("description")}</small>}
            </label>
            <label className="admin-field">
              <span>{text.linkUrl} <small>{text.linkUrlHelp}</small></span>
              <input type="url" name="linkUrl" inputMode="url" value={draft.linkUrl} maxLength={HOME_CALENDAR_LIMITS.linkUrl} aria-invalid={invalid("link.url")} onChange={event => edit({ linkUrl: event.target.value })} />
              {problemText("link.url") && <small className="admin-calendar-problem">{problemText("link.url")}</small>}
            </label>
            <label className="admin-field">
              <span>{text.linkLabel} <small>{text.linkLabelHelp}</small></span>
              <input name="linkLabel" value={draft.linkLabel} maxLength={HOME_CALENDAR_LIMITS.linkLabel} aria-invalid={invalid("link.label")} onChange={event => edit({ linkLabel: event.target.value })} />
              {problemText("link.label") && <small className="admin-calendar-problem">{problemText("link.label")}</small>}
            </label>
          </div>
          <div className="admin-actions">
            <button type="submit" className="admin-button primary" disabled={busy}>{busy ? text.saving : text.save}</button>
            <button type="button" className="admin-button secondary" disabled={busy} onClick={() => { setDraft(null); setOriginal(""); setProblem(null); }}>{text.cancel}</button>
          </div>
        </form>
      )}

      {published && (events.length === 0 ? <p className="admin-empty">{text.noEvents}</p> : <>
        <div className="admin-panel admin-calendar-group">
          <h2>{text.upcoming}</h2>
          {upcoming.length ? <div className="admin-calendar-list">{upcoming.map(card)}</div> : <p className="admin-muted">{text.noUpcoming}</p>}
        </div>
        {past.length > 0 && <details className="admin-panel admin-calendar-group">
          <summary><h2>{text.past}（{past.length}）</h2></summary>
          <div className="admin-calendar-list">{past.map(card)}</div>
        </details>}
      </>)}
    </section>
  );
}
