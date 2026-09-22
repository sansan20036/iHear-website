"use client";

import { useEffect, useRef, useState } from "react";
import type { ResourceItem, ResourceItemType, ResourceTopic, ResourcePublicationStatus, ResourceStatus } from "../../../lib/resource-topic-model";
import { isResourceUrl } from "../../../lib/resource-types";
import type { LocalizedTranslationField } from "../../../lib/translation-types";
import { useAdmin } from "../admin-context";
import { adminFetch, displayError } from "../admin-api";
import { LanguageGuardNotice } from "../language-guard";
import { copy, workflowCopy, languageLabels } from "./resource-copy";
import { topicCopy } from "./topic-copy";
import { TopicShare } from "./topic-share";

type Kind = "topic" | "item";
type RecordValue = ResourceTopic | ResourceItem;
type Editor = { kind: Kind; record: RecordValue | null };
type Form = { title: LocalizedTranslationField; description: LocalizedTranslationField; sortOrder: number; status: ResourcePublicationStatus; topicId: string; type: ResourceItemType; url: string };
type Snapshot = { topics: ResourceTopic[]; items: ResourceItem[] };
const blank = (): Form => ({ title: { en: "", zhHant: "", zhHans: "" }, description: { en: "", zhHant: "", zhHans: "" }, sortOrder: 100, status: "draft", topicId: "", type: "external_link", url: "" });
const endpoint = (kind: Kind) => kind === "topic" ? "/api/resource-topics" : "/api/resources";
const ordered = <T extends RecordValue,>(records: T[]): T[] => records.slice().sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id));
// The two reads can straddle another admin's save. Keep the newest version of duplicate IDs.
const merge = <T extends RecordValue,>(active: T[], archived: T[]): T[] => {
  const records = new Map<string, T>();
  for (const record of [...active, ...archived]) if ((records.get(record.id)?.version || 0) < record.version) records.set(record.id, record);
  return ordered([...records.values()]);
};
const toForm = (record: RecordValue): Form => ({ ...blank(), title: structuredClone(record.title), description: structuredClone(record.description), sortOrder: record.sortOrder, status: record.status === "published" ? "published" : "draft", ...("topicId" in record ? { topicId: record.topicId, type: record.type, url: record.url } : {}) });

export default function ResourcesAdminPage() {
  const { locale, dirty, setDirty, submitting, setSubmitting } = useAdmin();
  const text = copy[locale], workflow = workflowCopy[locale], words = topicCopy[locale];
  const [topics, setTopics] = useState<ResourceTopic[]>([]), [items, setItems] = useState<ResourceItem[]>([]);
  const [kind, setKind] = useState<Kind>("item"), [filter, setFilter] = useState<"active" | ResourceStatus>("active"), [topicFilter, setTopicFilter] = useState("");
  const [loading, setLoading] = useState(true), [loadError, setLoadError] = useState(""), [error, setError] = useState(""), [success, setSuccess] = useState("");
  const [editing, setEditing] = useState<Editor | null>(null), [form, setForm] = useState<Form>(blank);
  const [auto, setAuto] = useState(true), [force, setForce] = useState(false), [receipt, setReceipt] = useState(""), [notice, setNotice] = useState("");
  const [englishAccepted, setEnglishAccepted] = useState(false), [conflict, setConflict] = useState(false), [urlError, setUrlError] = useState(false);
  const errorNotice = useRef<HTMLParagraphElement>(null), dialog = useRef<HTMLDialogElement>(null), editorForm = useRef<HTMLFormElement>(null);
  const manualEdits = useRef<Record<string, ("zhHant" | "zhHans")[]>>({}), busy = useRef(false), loadSequence = useRef(0);
  const opener = useRef<HTMLElement | null>(null), addButton = useRef<HTMLButtonElement>(null);
  const published = editing?.record?.status === "published";
  const activeTopics = topics.filter(topic => topic.status !== "archived");
  const label = (record: RecordValue) => record.title[locale] || record.title.en;
  function readableError(e: unknown, fallback: string) {
    const details = e as { status?: number; code?: string };
    if (details.status === 403 || details.status === 429) return displayError(e, locale);
    if (details.code === "RESOURCE_SCHEMA_NOT_READY") return words.schema;
    if (details.code === "RESOURCE_TOPIC_NOT_EMPTY") return words.notEmpty;
    if (details.code === "RESOURCE_TOPIC_ARCHIVED" || details.code === "RESOURCE_TOPIC_NOT_FOUND") return words.topicUnavailable;
    if (details.code === "RESOURCE_ARCHIVED") return words.archivedRecord;
    if (details.status === 404) return words.missing;
    if (details.status === 400) return words.invalid;
    return fallback;
  }
  async function load() {
    const sequence = ++loadSequence.current;
    setLoading(true); setLoadError("");
    try {
      const [active, archived] = await Promise.all([
        adminFetch<Snapshot>("/api/resources?admin=1"), adminFetch<Snapshot>("/api/resources?includeArchived=true"),
      ]);
      if (sequence !== loadSequence.current) return;
      setTopics(merge(active.topics, archived.topics)); setItems(merge(active.items, archived.items));
    } catch (e) { if (sequence === loadSequence.current) setLoadError(readableError(e, words.failed)); }
    finally { if (sequence === loadSequence.current) setLoading(false); }
  }
  useEffect(() => {
    const requestedTopic = new URLSearchParams(window.location.search).get("topicId");
    if (requestedTopic && /^[a-zA-Z0-9-]{1,80}$/.test(requestedTopic)) setTopicFilter(requestedTopic);
    void load();
    return () => { ++loadSequence.current; };
  }, []);
  useEffect(() => {
    if (!("BroadcastChannel" in window)) return;
    const channel = new BroadcastChannel("ihear-resources");
    channel.onmessage = () => { if (!busy.current) void load(); };
    return () => channel.close();
  }, [locale]);
  useEffect(() => { if (editing && !dialog.current?.open) dialog.current?.showModal(); }, [editing]);
  useEffect(() => () => setDirty("resource", false), [setDirty]);
  useEffect(() => {
    if (editing && error) { errorNotice.current?.focus(); errorNotice.current?.scrollIntoView({ block: "nearest" }); }
  }, [editing, error]);
  function notify() { if ("BroadcastChannel" in window) { const channel = new BroadcastChannel("ihear-resources"); channel.postMessage("updated"); channel.close(); } }
  function resetPreview() { setReceipt(""); setNotice(""); }
  function resetEditor() { resetPreview(); setError(""); setUrlError(false); setConflict(false); setAuto(true); setForce(false); setEnglishAccepted(false); manualEdits.current = {}; }
  function open(nextKind: Kind, record?: RecordValue) {
    if (busy.current) return;
    opener.current = document.activeElement as HTMLElement;
    setEditing({ kind: nextKind, record: record || null });
    setForm(record ? toForm(record) : { ...blank(), topicId: activeTopics.some(topic => topic.id === topicFilter) ? topicFilter : activeTopics[0]?.id || "" });
    resetEditor(); setSuccess("");
  }
  function dismiss() {
    setDirty("resource", false); dialog.current?.close(); setEditing(null); setError("");
    requestAnimationFrame(() => { (opener.current?.isConnected ? opener.current : addButton.current)?.focus(); });
  }
  function close() {
    if (busy.current) return;
    if (dirty && !confirm(locale === "en" ? "Discard unsaved changes?" : locale === "zhHans" ? "放弃尚未保存的更改？" : "放棄尚未儲存的變更？")) return;
    dismiss();
  }
  function change(field: "title" | "description", language: keyof LocalizedTranslationField, value: string) {
    setForm(current => ({ ...current, [field]: { ...current[field], [language]: value } }));
    if (language !== "en") manualEdits.current[field] = [...new Set([...(manualEdits.current[field] || []), language])];
    else setEnglishAccepted(false);
    resetPreview(); setDirty("resource", true);
  }
  function report(e: unknown, fallback = words.mutationFailed) {
    const details = e as { status?: number; code?: string }; setNotice("");
    if (details.code === "TRANSLATION_PREVIEW_REQUIRED") { setReceipt(""); setError(workflow.previewAgain); return; }
    if (details.code === "INVALID_RESOURCE_URL") { setUrlError(true); setError(workflow.urlError); return; }
    if (details.status === 409 && !["RESOURCE_TOPIC_NOT_EMPTY", "RESOURCE_TOPIC_ARCHIVED", "RESOURCE_ARCHIVED"].includes(details.code || "")) {
      setConflict(true); setError(editing ? words.conflict : words.listConflict); return;
    }
    setError(readableError(e, fallback));
  }
  function validate() {
    if (editing?.kind === "item" && form.type === "external_link" && (!isResourceUrl(form.url) || !/^https:\/\/[^/?#@\s\\]+([/?#][^\s\\]*)?$/.test(form.url.trim()))) {
      setUrlError(true); setNotice(""); setError(workflow.urlError); return false;
    }
    setUrlError(false);
    if (editing?.kind === "item" && !activeTopics.some(topic => topic.id === form.topicId)) { setError(words.topicUnavailable); return false; }
    return !!editorForm.current?.reportValidity();
  }
  async function preview() {
    const fields = Object.fromEntries(Object.entries({ title: form.title, description: form.description }).filter(([, value]) => value.en.trim()));
    const result = await adminFetch<{ fields: Record<string, { value: LocalizedTranslationField }>; receipt: string }>("/api/admin/translations/preview", {
      method: "POST", body: JSON.stringify({ resource: { type: "resource", scope: editing?.kind === "topic" ? "topic" : "", id: editing?.record?.id || "__new__", version: editing?.record?.version }, fields, autoTranslate: auto, allowCjkEnglish: englishAccepted, manualEdits: Object.fromEntries(Object.entries(manualEdits.current).filter(([key]) => key in fields)), force: force ? Object.fromEntries(Object.keys(fields).map(key => [key, ["zhHant", "zhHans"]])) : {} }),
    });
    setForm(current => ({ ...current, ...Object.fromEntries(Object.entries(result.fields).map(([key, field]) => [key, field.value])) }));
    setReceipt(result.receipt); setNotice(text.ready); setDirty("resource", true);
  }
  async function run(action: () => Promise<void>, fallback?: string) {
    if (busy.current) return;
    busy.current = true; ++loadSequence.current; setLoading(false); setSubmitting(true); setError(""); setSuccess("");
    try { await action(); } catch (e) { report(e, fallback); } finally { busy.current = false; setSubmitting(false); }
  }
  async function previewStep() {
    if (busy.current || conflict || !validate()) return;
    resetPreview(); await run(preview, workflow.translationError);
  }
  async function save(status: ResourcePublicationStatus) {
    if (busy.current || conflict || !editing || !validate()) return;
    if (!receipt) { await previewStep(); return; }
    if (status === "draft" && published && !confirm(editing.kind === "topic" ? words.topicHide : workflow.confirmUnpublish)) return;
    await run(async () => {
      const id = editing.record?.id;
      const fields = { title: form.title, description: form.description, sortOrder: form.sortOrder, status };
      // Keep the two legacy categories coherent while public rendering is still gated to Checkpoint 4.
      const category = form.topicId === "articles" ? "article" : form.topicId === "forms" ? "form" : undefined;
      const extra = editing.kind === "item" ? { topicId: form.topicId, type: form.type, url: form.type === "external_link" ? form.url : "", ...(category ? { category } : {}) } : {};
      await adminFetch(`${endpoint(editing.kind)}${id ? `/${id}` : ""}`, { method: id ? "PATCH" : "POST", body: JSON.stringify({ ...fields, ...extra, version: editing.record?.version, translationReceipt: receipt }) });
      dismiss(); setSuccess(words.saved); notify(); await load();
    }, workflow.saveError);
  }
  async function latest() {
    if (!editing?.record || busy.current || !confirm(words.discard)) return;
    await run(async () => {
      const data = await adminFetch<{ topic?: ResourceTopic; item?: ResourceItem }>(`${endpoint(editing.kind)}/${editing.record!.id}?admin=1`);
      const record = data[editing.kind]!;
      if (record.status === "archived") { setError(words.archivedRecord); await load(); return; }
      setEditing({ ...editing, record }); setForm(toForm(record)); resetEditor(); setDirty("resource", false); setNotice(words.loaded); await load();
    });
  }
  async function mutate(record: RecordValue, action: "status" | "archive" | "restore") {
    if (busy.current) return;
    if (action === "archive" && !confirm(words.archive)) return;
    if (action === "status" && record.status === "published" && !confirm(kind === "topic" ? words.topicHide : workflow.confirmUnpublish)) return;
    await run(async () => {
      await adminFetch(`${endpoint(kind)}/${record.id}${action === "restore" ? "/restore" : ""}`, {
        method: action === "archive" ? "DELETE" : action === "restore" ? "POST" : "PATCH",
        body: JSON.stringify({ version: record.version, ...(action === "status" ? { status: record.status === "published" ? "draft" : "published" } : {}) }),
      });
      setSuccess(action === "restore" ? words.restored : action === "archive" ? words.archivedDone : record.status === "published" ? words.hidden : words.saved);
      notify(); await load();
    });
  }
  const visible = (kind === "topic" ? topics : items).filter(record => (filter === "active" ? record.status !== "archived" : record.status === filter) && (kind === "topic" || !topicFilter || (record as ResourceItem).topicId === topicFilter));
  const controlsDisabled = submitting || loading;
  return <section className="admin-page admin-resources">
    <header className="admin-page-head"><div><h1>{text.heading}</h1><p>{words.intro}</p></div><button ref={addButton} className="admin-button primary" disabled={controlsDisabled || !!loadError || (kind === "item" && !activeTopics.length)} onClick={() => open(kind)}>{kind === "topic" ? words.addTopic : words.addItem}</button></header>
    <div className="admin-toolbar"><a className="admin-button secondary" href="/resources" target="_blank" rel="noopener noreferrer">{text.view}</a><button className="admin-button secondary" disabled={controlsDisabled} onClick={() => { setError(""); setConflict(false); void load(); }}>{text.retry}</button></div>
    <div className="admin-toolbar" role="group" aria-label={text.heading}>
      {(["topic", "item"] as const).map(value => <button key={value} aria-pressed={kind === value} className={`admin-button ${kind === value ? "primary" : "secondary"}`} disabled={submitting} onClick={() => { setKind(value); setFilter("active"); setError(""); setConflict(false); setSuccess(""); }}>{value === "topic" ? words.topics : words.items}</button>)}
    </div>
    <div className="admin-toolbar admin-resource-filters">
      <label>{words.filter}<select aria-label={words.filter} className="admin-select" value={filter} disabled={submitting} onChange={event => { setFilter(event.target.value as typeof filter); setError(""); setConflict(false); setSuccess(""); }}>
        <option value="active">{words.all}</option>{(["published", "draft", "archived"] as const).map(value => <option key={value} value={value}>{words[value]}</option>)}
      </select></label>
      {kind === "item" && <label>{words.topic}<select aria-label={words.topic} className="admin-select" value={topicFilter} disabled={submitting} onChange={event => setTopicFilter(event.target.value)}><option value="">{words.allTopics}</option>{topics.map(topic => <option key={topic.id} value={topic.id}>{label(topic)}{topic.status === "archived" ? ` (${words.archived})` : ""}</option>)}</select></label>}
    </div>
    {loadError && <p role="alert" className="admin-alert">{loadError}</p>}
    {error && !editing && <p role="alert" className="admin-alert">{error}</p>}
    {success && <p role="status" className="admin-alert admin-success">{success}</p>}
    {kind === "item" && !loading && !loadError && !activeTopics.length && <p>{words.activeTopicRequired}</p>}
    {loading ? <p role="status">{words.loading}</p> : !loadError && <div className="admin-resource-list" aria-busy={submitting}>{visible.length ? visible.map(record => {
      const item = "topicId" in record ? record : null, parent = item ? topics.find(topic => topic.id === item.topicId) : null;
      return <article className="admin-card" key={record.id} data-resource-id={record.id}>
        <h2>{label(record)}</h2><p>{record.description[locale] || record.description.en}</p>
        {item?.type === "external_link" && <a href={item.url} target="_blank" rel="noopener noreferrer">{item.url}</a>}
        <p>{item ? `${parent ? label(parent) : words.chooseTopic} · ${words[item.type]} · ` : ""}{text.order}: {record.sortOrder} · <span className={`admin-status ${record.status}`}>{words[record.status]}</span></p>
        {!item && <p>{words.count}: {items.filter(value => value.topicId === record.id).length}</p>}
        {!item && <TopicShare slug={(record as ResourceTopic).slug} locale={locale} available={record.status === "published" && items.some(value => value.topicId === record.id && value.status === "published")} />}
        {item && parent?.status !== "published" && record.status !== "archived" && <p>{words.hiddenParent}</p>}
        <div className="admin-card-actions">
          {record.status === "archived" ? <button className="admin-button secondary" disabled={controlsDisabled || conflict} onClick={() => void mutate(record, "restore")}>{words.restore}</button> : <>
            <button className="admin-button secondary" disabled={controlsDisabled} onClick={() => open(kind, record)}>{text.edit}</button>
            <button className="admin-button secondary" disabled={controlsDisabled || conflict} onClick={() => void mutate(record, "status")}>{record.status === "published" ? text.hide : text.publish}</button>
            <button className="admin-button danger" disabled={controlsDisabled || conflict} onClick={() => void mutate(record, "archive")}>{text.trash}</button>
          </>}
          {!item && <button className="admin-button secondary" disabled={controlsDisabled} onClick={() => { setKind("item"); setTopicFilter(record.id); setFilter("active"); setError(""); setConflict(false); }}>{words.viewItems}</button>}
        </div>
      </article>;
    }) : <p>{words.empty}</p>}</div>}
    {editing && <dialog className="admin-resource-dialog" ref={dialog} onCancel={event => { event.preventDefault(); close(); }} aria-labelledby="resource-form-heading">
      <form ref={editorForm} onSubmit={event => { event.preventDefault(); void save(form.status); }}>
        <h2 id="resource-form-heading">{editing.kind === "topic" ? editing.record ? words.editTopic : words.addTopic : editing.record ? words.editItem : words.addItem}</h2>
        <p>{workflow.step}</p>
        <fieldset disabled={submitting}>
          {editing.kind === "item" && <>
            <label>{words.topic}<select aria-label={words.topic} className="admin-select" required value={form.topicId} onChange={event => { setForm(current => ({ ...current, topicId: event.target.value })); setDirty("resource", true); }}><option value="">{words.chooseTopic}</option>{activeTopics.map(topic => <option key={topic.id} value={topic.id}>{label(topic)} ({words[topic.status]})</option>)}</select></label>
            {topics.find(topic => topic.id === form.topicId)?.status !== "published" && <p>{words.hiddenParent}</p>}
            <label>{words.type}<select aria-label={words.type} className="admin-select" value={form.type} onChange={event => { const type = event.target.value as ResourceItemType; setForm(current => ({ ...current, type, url: type === "external_link" ? current.url : "" })); setUrlError(false); setError(""); setDirty("resource", true); }}>{(["external_link", "email_request", "text"] as const).map(type => <option value={type} key={type}>{words[type]}</option>)}</select></label><p>{words.typeHelp}</p>
          </>}
          {(["en", "zhHant", "zhHans"] as const).map(language => <div className="admin-resource-language" key={language}><h3>{languageLabels[language]}</h3>
            <label>{languageLabels[language]} · {text.title}<input value={form.title[language]} maxLength={200} required={language === "en"} onChange={event => change("title", language, event.target.value)} /></label>
            <LanguageGuardNotice locale={locale} language={language} value={form.title[language]} disabled={submitting} englishAccepted={englishAccepted} onAcceptEnglish={() => { setEnglishAccepted(true); resetPreview(); }} onChange={value => change("title", language, value)} />
            <label>{languageLabels[language]} · {text.description}<textarea value={form.description[language]} maxLength={2000} rows={3} onChange={event => change("description", language, event.target.value)} /></label>
            <LanguageGuardNotice locale={locale} language={language} value={form.description[language]} disabled={submitting} englishAccepted={englishAccepted} onAcceptEnglish={() => { setEnglishAccepted(true); resetPreview(); }} onChange={value => change("description", language, value)} />
          </div>)}
          {editing.kind === "item" && form.type === "external_link" && <><label>{text.url}<input type="url" required maxLength={2048} aria-invalid={urlError || undefined} aria-describedby={urlError ? "resource-url-error" : undefined} value={form.url} onChange={event => { setForm(current => ({ ...current, url: event.target.value })); if (urlError) { setUrlError(false); setError(""); } setDirty("resource", true); }} /></label>{urlError && <p id="resource-url-error" className="admin-alert">{workflow.urlError}</p>}</>}
          <label>{text.order}<input type="number" required min={0} max={1000000} step={1} value={Number.isNaN(form.sortOrder) ? "" : form.sortOrder} onChange={event => { setForm(current => ({ ...current, sortOrder: event.target.value === "" ? NaN : Number(event.target.value) })); setDirty("resource", true); }} /></label>
          <label className="admin-resource-check"><input type="checkbox" checked={auto} onChange={event => { setAuto(event.target.checked); resetPreview(); setDirty("resource", true); }} />{text.auto}</label>
          <label className="admin-resource-check"><input type="checkbox" checked={force} onChange={event => { setForce(event.target.checked); resetPreview(); setDirty("resource", true); }} />{text.force}</label>
        </fieldset>
        {error && <p ref={errorNotice} tabIndex={-1} role="alert" className="admin-alert">{error}</p>}
        {!error && notice && <p role="status" className="admin-alert admin-success">{notice}</p>}
        <div className="admin-actions">
          <button type="button" className="admin-button secondary" disabled={submitting} onClick={close}>{text.cancel}</button>
          {conflict && editing.record && <button type="button" className="admin-button secondary" disabled={submitting} onClick={() => void latest()}>{words.latest}</button>}
          {!receipt ? <button type="button" className="admin-button primary" disabled={submitting || conflict} onClick={() => void previewStep()}>{submitting ? text.pending : workflow.next}</button> : <>
            <button type="button" className="admin-button secondary" disabled={submitting || conflict} onClick={() => void save("draft")}>{published ? workflow.unpublish : workflow.confirmDraft}</button>
            <button type="button" className="admin-button primary" disabled={submitting || conflict} onClick={() => void save("published")}>{submitting ? text.pending : published ? workflow.keepPublished : workflow.confirmPublish}</button>
          </>}
        </div>
      </form>
    </dialog>}
  </section>;
}
