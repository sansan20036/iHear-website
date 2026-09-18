"use client";

import { useEffect, useRef, useState } from "react";
import type { ResourceInput, ResourceLink } from "../../../lib/resource-types";
import { isResourceUrl } from "../../../lib/resource-types";
import type { LocalizedTranslationField } from "../../../lib/translation-types";
import { useAdmin } from "../admin-context";
import { adminFetch, displayError } from "../admin-api";
import { LanguageGuardNotice } from "../language-guard";

const copy = {
  en: { category: "Category", form: "Forms / useful links", article: "Articles", heading: "Resources", intro: "Manage forms and external articles. Names here do not change the original content.", add: "Add resource", title: "Name", description: "Description (optional)", url: "HTTPS link", order: "Display order", edit: "Edit", hide: "Hide", publish: "Publish", trash: "Move to trash", confirm: "Remove this website link? The original content will remain available.", empty: "No resources yet.", retry: "Reload saved resources", draft: "Draft", published: "Published", cancel: "Cancel", save: "Save draft", savePublish: "Save and publish", auto: "Automatically update Chinese translations", force: "Also replace manually edited Chinese", preview: "Generate translation preview", ready: "Preview ready. Review the text, then save.", pending: "Working…", view: "View Resources", nameRequired: "Enter an English name.", conflict: "This resource changed elsewhere. Your draft is kept; close it and reload before saving." },
  zhHant: { category: "分類", form: "表單／常用連結", article: "文章", heading: "資源管理", intro: "管理資源頁上的表單與外部文章。在此改名不會修改原始內容。", add: "新增資源", title: "名稱", description: "用途說明（選填）", url: "HTTPS 連結", order: "顯示順序", edit: "編輯", hide: "隱藏", publish: "發布", trash: "移至回收區", confirm: "移除此網站連結？來源內容仍會保留。", empty: "目前沒有資源。", retry: "重新讀取已儲存資料", draft: "草稿", published: "已發布", cancel: "取消", save: "儲存草稿", savePublish: "儲存並發布", auto: "自動更新中文翻譯", force: "同時覆蓋人工修改的中文", preview: "產生翻譯預覽", ready: "預覽已完成，請檢查文字後再儲存。", pending: "處理中…", view: "查看資源頁", nameRequired: "請填寫英文名稱。", conflict: "此資料已被其他管理員更新。您的草稿已保留，請關閉並重新讀取後再儲存。" },
  zhHans: { category: "分类", form: "表单／常用链接", article: "文章", heading: "资源管理", intro: "管理资源页上的表单与外部文章。在此改名不会修改原始内容。", add: "新增资源", title: "名称", description: "用途说明（选填）", url: "HTTPS 链接", order: "显示顺序", edit: "编辑", hide: "隐藏", publish: "发布", trash: "移至回收区", confirm: "移除此网站链接？来源内容仍会保留。", empty: "目前没有资源。", retry: "重新读取已保存数据", draft: "草稿", published: "已发布", cancel: "取消", save: "保存草稿", savePublish: "保存并发布", auto: "自动更新中文翻译", force: "同时覆盖人工修改的中文", preview: "生成翻译预览", ready: "预览已完成，请检查文字后再保存。", pending: "处理中…", view: "查看资源页", nameRequired: "请填写英文名称。", conflict: "此数据已被其他管理员更新。您的草稿已保留，请关闭并重新读取后再保存。" },
};
const blank = (): ResourceInput => ({ category: "form", title: { en: "", zhHant: "", zhHans: "" }, description: { en: "", zhHant: "", zhHans: "" }, url: "", sortOrder: 100, status: "draft" });
const workflowCopy = {
  en: { next: "Next: preview translations", step: "Step 1: preview translations. Step 2: confirm saving or publishing. Nothing is saved yet.", confirmDraft: "Confirm save draft", confirmPublish: "Confirm publish", keepPublished: "Save changes (keep published)", unpublish: "Save as draft and unpublish", confirmUnpublish: "This resource will be removed from the public list and saved as a draft. Continue?", previewAgain: "The translation preview is no longer valid. Your input is kept. Generate a new preview to continue.", urlError: "Enter a complete HTTPS link without a username or password.", translationError: "Could not generate the translation preview. Your input is kept. Try again or enter Chinese manually.", saveError: "Could not save. Your input is kept. Please try again." },
  zhHant: { next: "下一步：預覽翻譯", step: "第 1 步：預覽翻譯；第 2 步：確認儲存或發布。目前尚未儲存。", confirmDraft: "確認儲存草稿", confirmPublish: "確認發布", keepPublished: "儲存變更（維持發布）", unpublish: "改為草稿並下架", confirmUnpublish: "這筆資源將從公開清單下架，並保留為草稿。確定繼續？", previewAgain: "翻譯預覽已過期或失效，輸入內容已保留。請重新產生預覽後再儲存。", urlError: "請輸入完整的 HTTPS 網址，且網址不可包含帳號或密碼。", translationError: "無法產生翻譯預覽，輸入內容已保留。請重試，或手動填寫中文後再預覽。", saveError: "儲存失敗，輸入內容已保留，請再試一次。" },
  zhHans: { next: "下一步：预览翻译", step: "第 1 步：预览翻译；第 2 步：确认保存或发布。目前尚未保存。", confirmDraft: "确认保存草稿", confirmPublish: "确认发布", keepPublished: "保存更改（保持发布）", unpublish: "改为草稿并下架", confirmUnpublish: "这条资源将从公开列表下架，并保留为草稿。确定继续？", previewAgain: "翻译预览已过期或失效，输入内容已保留。请重新生成预览后再保存。", urlError: "请输入完整的 HTTPS 网址，且网址不可包含账号或密码。", translationError: "无法生成翻译预览，输入内容已保留。请重试，或手动填写中文后再预览。", saveError: "保存失败，输入内容已保留，请再试一次。" },
};
const languageLabels = { en: "English", zhHant: "繁體中文", zhHans: "简体中文" };

export default function ResourcesAdminPage() {
  const { locale, dirty, setDirty, submitting, setSubmitting } = useAdmin();
  const text = copy[locale];
  const workflow = workflowCopy[locale];
  const [items, setItems] = useState<ResourceLink[]>([]), [loading, setLoading] = useState(true), [error, setError] = useState("");
  const [editing, setEditing] = useState<ResourceLink | "new" | null>(null), [form, setForm] = useState<ResourceInput>(blank);
  const [auto, setAuto] = useState(true), [force, setForce] = useState(false), [receipt, setReceipt] = useState(""), [notice, setNotice] = useState("");
  const [englishAccepted, setEnglishAccepted] = useState(false), [conflict, setConflict] = useState(false);
  const [urlError, setUrlError] = useState(false);
  const errorNotice = useRef<HTMLParagraphElement>(null);
  const published = editing !== null && editing !== "new" && editing.status === "published";
  const manualEdits = useRef<Record<string, ("zhHant" | "zhHans")[]>>({});
  const dialog = useRef<HTMLDialogElement>(null), editorForm = useRef<HTMLFormElement>(null), busy = useRef(false);
  async function load() {
    setLoading(true); setError("");
    try { const data = await adminFetch<{ items: ResourceLink[] }>("/api/resources?admin=1"); setItems(data.items); }
    catch (e) { setError(displayError(e, locale)); }
    finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, []);
  useEffect(() => { if (editing) dialog.current?.showModal(); }, [editing]);
  useEffect(() => () => setDirty("resource", false), [setDirty]);
  useEffect(() => {
    if (editing && error) { errorNotice.current?.focus(); errorNotice.current?.scrollIntoView({ block: "nearest" }); }
  }, [editing, error]);
  function notify() { if ("BroadcastChannel" in window) { const channel = new BroadcastChannel("ihear-resources"); channel.postMessage("updated"); channel.close(); } }
  function open(item?: ResourceLink) {
    setEditing(item || "new");
    setForm(item ? { category: item.category || "form", title: structuredClone(item.title), description: structuredClone(item.description), url: item.url, sortOrder: item.sortOrder, status: item.status === "published" ? "published" : "draft" } : blank());
    setReceipt(""); setNotice(""); setError(""); setUrlError(false); setConflict(false); setAuto(true); setForce(false); setEnglishAccepted(false); manualEdits.current = {};
  }
  function close() { if (busy.current) return; if (dirty && !confirm(locale === "en" ? "Discard unsaved changes?" : locale === "zhHans" ? "放弃尚未保存的更改？" : "放棄尚未儲存的變更？")) return; setDirty("resource", false); dialog.current?.close(); setEditing(null); setError(""); }
  function change(field: "title" | "description", language: keyof LocalizedTranslationField, value: string) {
    setForm(current => ({ ...current, [field]: { ...current[field], [language]: value } }));
    if (language !== "en") manualEdits.current[field] = [...new Set([...(manualEdits.current[field] || []), language])];
    else setEnglishAccepted(false);
    setReceipt(""); setNotice(""); setDirty("resource", true);
  }
  function report(e: unknown, fallback?: string) {
    const details = e as { status?: number; code?: string };
    setNotice("");
    if (details.code === "TRANSLATION_PREVIEW_REQUIRED") {
      setReceipt(""); setConflict(false); setError(workflow.previewAgain); return;
    }
    if (details.code === "INVALID_RESOURCE_URL") {
      setUrlError(true); setError(workflow.urlError); return;
    }
    if (details.status === 409) { setConflict(true); setError(text.conflict); return; }
    setError(fallback && details.status !== 403 && details.status !== 429 ? fallback : displayError(e, locale));
  }
  function validate() {
    if (!isResourceUrl(form.url)) {
      setUrlError(true); setNotice(""); setError(workflow.urlError); return false;
    }
    setUrlError(false);
    return !!editorForm.current?.reportValidity();
  }
  async function preview() {
    if (!form.title.en.trim()) throw new Error(text.nameRequired);
    const fields = Object.fromEntries(Object.entries({ title: form.title, description: form.description }).filter(([, value]) => value.en.trim()));
    const result = await adminFetch<{ fields: Record<string, { value: LocalizedTranslationField }>; receipt: string }>("/api/admin/translations/preview", {
      method: "POST", body: JSON.stringify({ resource: { type: "resource", scope: "", id: editing === "new" ? "__new__" : editing?.id, version: editing === "new" ? undefined : editing?.version }, fields, autoTranslate: auto, allowCjkEnglish: englishAccepted, manualEdits: Object.fromEntries(Object.entries(manualEdits.current).filter(([key]) => key in fields)), force: force ? Object.fromEntries(Object.keys(fields).map(key => [key, ["zhHant", "zhHans"]])) : {} }),
    });
    setForm(current => ({ ...current, ...Object.fromEntries(Object.entries(result.fields).map(([key, field]) => [key, field.value])) })); setReceipt(result.receipt); setNotice(text.ready); setDirty("resource", true);
  }
  async function run(action: () => Promise<void>, fallback?: string) {
    if (busy.current) return;
    busy.current = true; setSubmitting(true); setError("");
    try { await action(); } catch (e) { report(e, fallback); } finally { busy.current = false; setSubmitting(false); }
  }
  async function previewStep() {
    if (conflict || !validate()) return;
    setReceipt(""); setNotice("");
    await run(preview, workflow.translationError);
  }
  async function save(status: ResourceInput["status"]) {
    if (conflict || !validate()) return;
    if (!receipt) { await previewStep(); return; }
    if (status === "draft" && published && !confirm(workflow.confirmUnpublish)) return;
    await run(async () => {
      const id = editing === "new" ? "" : editing?.id;
      await adminFetch(`/api/resources${id ? `/${id}` : ""}`, { method: id ? "PATCH" : "POST", body: JSON.stringify({ ...form, status, version: editing === "new" ? undefined : editing?.version, translationReceipt: receipt }) });
      setDirty("resource", false); dialog.current?.close(); setEditing(null); notify(); await load();
    }, workflow.saveError);
  }
  async function mutate(item: ResourceLink, trash: boolean) {
    if (trash && !confirm(text.confirm)) return;
    if (!trash && item.status === "published" && !confirm(workflow.confirmUnpublish)) return;
    await run(async () => {
      await adminFetch(`/api/resources/${item.id}`, { method: trash ? "DELETE" : "PATCH", body: JSON.stringify(trash ? { version: item.version } : { ...item, status: item.status === "published" ? "draft" : "published" }) });
      notify(); await load();
    });
  }
  return <section className="admin-page">
    <header className="admin-page-head"><div><h1>{text.heading}</h1><p>{text.intro}</p></div><button className="admin-button primary" disabled={submitting || loading} onClick={() => open()}>{text.add}</button></header>
    <div className="admin-toolbar"><a className="admin-button secondary" href="/resources#resource-links" target="_blank" rel="noopener noreferrer">{text.view}</a><button className="admin-button secondary" disabled={submitting || loading} onClick={() => void load()}>{text.retry}</button></div>
    {error && !editing && <p role="alert" className="admin-alert">{error}</p>}
    {loading ? <p role="status">{text.pending}</p> : items.length ? <div className="admin-resource-list">{items.map(item => <article className="admin-card" key={item.id}>
      <h2>{item.title[locale] || item.title.en}</h2><p>{item.description[locale] || item.description.en}</p><a href={item.url} target="_blank" rel="noopener noreferrer">{item.url}</a><p>{item.category === "article" ? text.article : text.form} · {text.order}: {item.sortOrder} · {item.status === "published" ? text.published : text.draft}</p>
      <div className="admin-card-actions"><button className="admin-button secondary" disabled={submitting} onClick={() => open(item)}>{text.edit}</button><button className="admin-button secondary" disabled={submitting} onClick={() => void mutate(item, false)}>{item.status === "published" ? text.hide : text.publish}</button><button className="admin-button danger" disabled={submitting} onClick={() => void mutate(item, true)}>{text.trash}</button></div>
    </article>)}</div> : !error && <p>{text.empty}</p>}
    {editing && <dialog className="admin-resource-dialog" ref={dialog} onCancel={event => { event.preventDefault(); close(); }} aria-labelledby="resource-form-heading">
      <form ref={editorForm} onSubmit={event => { event.preventDefault(); void save(form.status); }}>
        <h2 id="resource-form-heading">{editing === "new" ? text.add : text.edit}</h2>
        <p>{workflow.step}</p>
        <fieldset disabled={submitting}>
          <label>{text.category}<select className="admin-select" aria-label={text.category} value={form.category} onChange={event => { setForm(current => ({ ...current, category: event.target.value as ResourceInput["category"] })); setDirty("resource", true); }}><option value="form">{text.form}</option><option value="article">{text.article}</option></select></label>
          {(["en", "zhHant", "zhHans"] as const).map(language => <div className="admin-resource-language" key={language}><h3>{languageLabels[language]}</h3>
            <label>{languageLabels[language]} · {text.title}<input value={form.title[language]} maxLength={200} required={language === "en"} onChange={event => change("title", language, event.target.value)} /></label>
            <LanguageGuardNotice locale={locale} language={language} value={form.title[language]} disabled={submitting} englishAccepted={englishAccepted} onAcceptEnglish={() => setEnglishAccepted(true)} onChange={value => change("title", language, value)} />
            <label>{languageLabels[language]} · {text.description}<textarea value={form.description[language]} maxLength={2000} rows={3} onChange={event => change("description", language, event.target.value)} /></label>
            <LanguageGuardNotice locale={locale} language={language} value={form.description[language]} disabled={submitting} englishAccepted={englishAccepted} onAcceptEnglish={() => setEnglishAccepted(true)} onChange={value => change("description", language, value)} />
          </div>)}
          <label>{text.url}<input type="url" required maxLength={2048} aria-invalid={urlError || undefined} aria-describedby={urlError ? "resource-url-error" : undefined} value={form.url} onChange={event => { setForm(current => ({ ...current, url: event.target.value })); if (urlError) { setUrlError(false); setError(""); } setDirty("resource", true); }} /></label>
          {urlError && <p id="resource-url-error" className="admin-alert">{workflow.urlError}</p>}
          <label>{text.order}<input type="number" required min={0} max={1000000} step={1} value={form.sortOrder} onChange={event => { setForm(current => ({ ...current, sortOrder: Number(event.target.value) })); setDirty("resource", true); }} /></label>
          <label className="admin-resource-check"><input type="checkbox" checked={auto} onChange={event => { setAuto(event.target.checked); setReceipt(""); setNotice(""); }} />{text.auto}</label>
          <label className="admin-resource-check"><input type="checkbox" checked={force} onChange={event => { setForce(event.target.checked); setReceipt(""); setNotice(""); }} />{text.force}</label>
        </fieldset>
        {error && <p ref={errorNotice} tabIndex={-1} role="alert" className="admin-alert">{error}</p>}
        {!error && notice && <p role="status" className="admin-alert admin-success">{notice}</p>}
        <div className="admin-actions">
          <button type="button" className="admin-button secondary" disabled={submitting} onClick={close}>{text.cancel}</button>
          {!receipt ? <button type="button" className="admin-button primary" disabled={submitting || conflict} onClick={() => void previewStep()}>{submitting ? text.pending : workflow.next}</button> : <>
            <button type="button" className="admin-button secondary" disabled={submitting || conflict} onClick={() => void save("draft")}>{published ? workflow.unpublish : workflow.confirmDraft}</button>
            <button type="button" className="admin-button primary" disabled={submitting || conflict} onClick={() => void save("published")}>{submitting ? text.pending : published ? workflow.keepPublished : workflow.confirmPublish}</button>
          </>}
        </div>
      </form>
    </dialog>}
  </section>;
}
