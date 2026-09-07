"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import catalogData from "../../../data/content-slots.json";
import { inspectEnglishSource } from "../../../assets/text-language-guard";
import { adminFetch, displayError } from "../admin-api";
import { useAdmin, type AdminLocale } from "../admin-context";
import { LanguageGuardNotice } from "../language-guard";

type Values = Record<AdminLocale, string>;
type TranslationPreview = {
  receipt: string;
  fields: Record<string, { value: Values; zhHantStatus: string; zhHansStatus: string }>;
};
type Slot = {
  page: string;
  key: string;
  mode: "singleline" | "multiline";
  maxLength: number;
  values: Values;
  occurrences?: unknown[];
};
type ContentStore = {
  locales: Record<AdminLocale, {
    pages: Record<string, Record<string, string>>;
    itemUpdatedAt: Record<string, Record<string, string>>;
  }>;
};

const slots = catalogData.slots as Slot[];
const pageNames: Record<string, Values> = {
  "/": { en: "Home", zhHant: "首頁", zhHans: "首页" },
  "/__global__": { en: "Shared site content", zhHant: "全站共用內容", zhHans: "全站共用内容" },
  "/about": { en: "About", zhHant: "關於我們", zhHans: "关于我们" },
  "/academy": { en: "Academy", zhHant: "線上學院", zhHans: "在线学院" },
  "/contact": { en: "Contact", zhHant: "聯絡我們", zhHans: "联系我们" },
  "/donate": { en: "Donate", zhHant: "捐款支持", zhHans: "捐款支持" },
  "/faq": { en: "FAQ", zhHant: "常見問題", zhHans: "常见问题" },
  "/get-involved": { en: "Get involved", zhHant: "參與我們", zhHans: "参与我们" },
  "/impact": { en: "Impact", zhHant: "成果與影響力", zhHans: "成果与影响力" },
  "/programs": { en: "Programs", zhHant: "服務項目", zhHans: "服务项目" },
  "/resources": { en: "Resources", zhHant: "學習資源", zhHans: "学习资源" },
  "/stories": { en: "Stories", zhHant: "生命故事", zhHans: "生命故事" },
  "/submit-bio": { en: "Submit a tutor bio", zhHant: "提交小老師資料", zhHans: "提交小老师资料" },
  "/team": { en: "Team", zhHant: "團隊介紹", zhHans: "团队介绍" },
  "/_system/not-found": { en: "Page not found", zhHant: "找不到頁面", zhHans: "找不到页面" },
  "/auth-error": { en: "Sign-in error", zhHant: "登入錯誤", zhHans: "登录错误" },
};

const copy = {
  en: {
    title: "Website content", intro: "Edit every public heading, paragraph, button label and form instruction in all three languages.",
    search: "Search visible text", allPages: "All pages", shared: "Shared across the site", location: "Used in {count} location(s)",
    edit: "Edit", preview: "View page", empty: "No matching content.", loading: "Loading website content…",
    dialog: "Edit website text", hint: "All three languages are published together.", english: "English", hant: "Traditional Chinese", hans: "Simplified Chinese",
    cancel: "Cancel", save: "Publish text", saving: "Publishing…", saved: "Text published.", required: "Complete all three languages before publishing.",
    conflict: "Another administrator changed this text. Your draft is still here; reload the latest version before publishing.", singleline: "Short text", multiline: "Paragraph text",
    autoTranslate: "Automatically update Chinese translations", replaceExisting: "Also overwrite existing or manually edited Chinese", translations: "Chinese translation preview", prepare: "Generate translation preview", preparing: "Translating…", review: "Translation preview is ready. Review it, then publish all three languages.", protected: "Existing human translation kept", translated: "Automatically translated", manualHelp: "You can edit either Chinese field; your correction will be protected from future automatic replacement.", manualMode: "Enter all three languages manually",
  },
  zhHant: {
    title: "網站內容", intro: "集中修改全站公開標題、段落、按鈕名稱與表單說明，並一次發布完整三語內容。",
    search: "搜尋畫面上的文字", allPages: "全部頁面", shared: "全站共用", location: "使用於 {count} 個位置",
    edit: "編輯", preview: "查看頁面", empty: "沒有符合條件的內容。", loading: "正在載入網站內容…",
    dialog: "編輯網站文字", hint: "英文、繁中與簡中會一起發布。", english: "英文", hant: "繁體中文", hans: "簡體中文",
    cancel: "取消", save: "發布文字", saving: "發布中…", saved: "文字已發布。", required: "發布前請完成三種語言。",
    conflict: "另一位管理員已修改這段文字。你的草稿仍保留，請重新載入最新內容後再發布。", singleline: "短文字", multiline: "段落文字",
    autoTranslate: "自動更新中文翻譯", replaceExisting: "同時覆蓋既有或人工修改過的中文", translations: "中文翻譯預覽", prepare: "產生翻譯預覽", preparing: "翻譯中…", review: "翻譯預覽已完成；請檢查後再發布完整三語。", protected: "沿用既有人工中文", translated: "已自動翻譯", manualHelp: "你可以修改任一中文欄位；人工修正後，未來不會被自動覆蓋。", manualMode: "自行輸入完整三語",
  },
  zhHans: {
    title: "网站内容", intro: "集中修改全站公开标题、段落、按钮名称与表单说明，并一次发布完整三语内容。",
    search: "搜索画面上的文字", allPages: "全部页面", shared: "全站共用", location: "使用于 {count} 个位置",
    edit: "编辑", preview: "查看页面", empty: "没有符合条件的内容。", loading: "正在加载网站内容…",
    dialog: "编辑网站文字", hint: "英文、繁中与简中会一起发布。", english: "英文", hant: "繁体中文", hans: "简体中文",
    cancel: "取消", save: "发布文字", saving: "发布中…", saved: "文字已发布。", required: "发布前请完成三种语言。",
    conflict: "另一位管理员已修改这段文字。你的草稿仍保留，请重新加载最新内容后再发布。", singleline: "短文字", multiline: "段落文字",
    autoTranslate: "自动更新中文翻译", replaceExisting: "同时覆盖现有或人工修改过的中文", translations: "中文翻译预览", prepare: "生成翻译预览", preparing: "翻译中…", review: "翻译预览已完成；请检查后再发布完整三语。", protected: "沿用现有人工中文", translated: "已自动翻译", manualHelp: "你可以修改任一中文字段；人工修正后，未来不会被自动覆盖。", manualMode: "自行输入完整三语",
  },
};

function identity(slot: Slot) { return `${slot.page}\u0000${slot.key}`; }
function pageName(page: string, locale: AdminLocale) { return pageNames[page]?.[locale] || pageNames[page]?.en || page; }
function previewPath(page: string) {
  if (page === "/__global__") return "/";
  if (page === "/_system/not-found") return "/this-page-does-not-exist";
  return page;
}
function effectiveValue(store: ContentStore | null, slot: Slot, locale: AdminLocale) {
  return store?.locales?.[locale]?.pages?.[slot.page]?.[slot.key] ?? slot.values[locale];
}

export default function AdminContentPage() {
  const { locale, setDirty, setSubmitting, submitting, confirmAction } = useAdmin();
  const text = copy[locale];
  const [store, setStore] = useState<ContentStore | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState("all");
  const [editing, setEditing] = useState<Slot | null>(null);
  const [draft, setDraft] = useState<Values>({ en: "", zhHant: "", zhHans: "" });
  const [autoTranslate, setAutoTranslate] = useState(true);
  const [replaceExisting, setReplaceExisting] = useState(false);
  const [translationReceipt, setTranslationReceipt] = useState("");
  const [translationStatus, setTranslationStatus] = useState<{ zhHant?: string; zhHans?: string }>({});
  const [translating, setTranslating] = useState(false);
  const [englishGuardAccepted, setEnglishGuardAccepted] = useState(false);
  const original = useRef("");
  const externalChange = useRef(false);
  const translationRequestActive = useRef(false);

  const load = async () => {
    const next = await adminFetch<ContentStore>("/api/content/get");
    setStore(next);
    setLoading(false);
    return next;
  };

  useEffect(() => { load().catch((reason) => { setError(displayError(reason, locale)); setLoading(false); }); }, []);
  useEffect(() => {
    const dirty = Boolean(editing) && JSON.stringify(draft) !== original.current;
    setDirty("content-form", dirty);
    return () => setDirty("content-form", false);
  }, [draft, editing, setDirty]);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      window.iHearLiveContent?.register?.("content", {
        refresh: async () => {
          if (editing) { externalChange.current = true; return; }
          await load();
        },
      });
    }, 200);
    return () => window.clearTimeout(timer);
  }, [editing]);
  const pages = useMemo(() => Array.from(new Set(slots.map((slot) => slot.page))).sort((left, right) => pageName(left, locale).localeCompare(pageName(right, locale))), [locale]);
  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return slots.filter((slot) => {
      if (page !== "all" && slot.page !== page) return false;
      if (!needle) return true;
      return (["en", "zhHant", "zhHans"] as AdminLocale[]).some((language) => effectiveValue(store, slot, language).toLocaleLowerCase().includes(needle));
    }).sort((left, right) => pageName(left.page, locale).localeCompare(pageName(right.page, locale)) || effectiveValue(store, left, locale).localeCompare(effectiveValue(store, right, locale)));
  }, [locale, page, query, store]);

  function beginEdit(slot: Slot) {
    const action = () => {
      const values = {
        en: effectiveValue(store, slot, "en"),
        zhHant: effectiveValue(store, slot, "zhHant"),
        zhHans: effectiveValue(store, slot, "zhHans"),
      };
      setEditing(slot); setDraft(values); setError(""); setNotice("");
      setAutoTranslate(true); setReplaceExisting(false); setTranslationReceipt(""); setTranslationStatus({}); setEnglishGuardAccepted(false);
      original.current = JSON.stringify(values); externalChange.current = false;
    };
    if (editing && JSON.stringify(draft) !== original.current) confirmAction(action); else action();
  }

  function close() {
    if (submitting) return;
    const action = () => { setEditing(null); setError(""); setTranslationReceipt(""); setTranslationStatus({}); externalChange.current = false; };
    if (JSON.stringify(draft) !== original.current) confirmAction(action); else action();
  }

  function updateDraft(language: AdminLocale, value: string) {
    setDraft((current) => ({ ...current, [language]: value }));
    if (language === "en") { setTranslationReceipt(""); setTranslationStatus({}); setEnglishGuardAccepted(false); }
  }

  async function prepareTranslation() {
    if (!editing || submitting || translating || translationRequestActive.current || !draft.en.trim() || (inspectEnglishSource(draft.en).warning && !englishGuardAccepted)) return;
    translationRequestActive.current = true;
    setTranslating(true); setError("");
    try {
      const expectedEn = store?.locales?.en?.itemUpdatedAt?.[editing.page]?.[editing.key] || null;
      const result = await adminFetch<TranslationPreview>("/api/admin/translations/preview", {
        method: "POST",
        body: JSON.stringify({
          resource: { type: "content", scope: editing.page, id: editing.key, version: expectedEn },
          fields: { value: draft },
          autoTranslate: true,
          allowCjkEnglish: englishGuardAccepted,
          force: replaceExisting ? { value: ["zhHant", "zhHans"] } : {},
        }),
      });
      setDraft(result.fields.value.value);
      setTranslationReceipt(result.receipt);
      setTranslationStatus({ zhHant: result.fields.value.zhHantStatus, zhHans: result.fields.value.zhHansStatus });
      setNotice(text.review);
    } catch (reason) { setError(displayError(reason, locale)); }
    finally { translationRequestActive.current = false; setTranslating(false); }
  }

  async function save() {
    if (!editing || submitting) return;
    if (autoTranslate && !translationReceipt) { await prepareTranslation(); return; }
    if ((["en", "zhHant", "zhHans"] as AdminLocale[]).some((language) => !draft[language].trim() || draft[language].length > editing.maxLength || (editing.mode === "singleline" && /[\r\n]/.test(draft[language])))) {
      setError(text.required); return;
    }
    if (externalChange.current) { setError(text.conflict); return; }
    setSubmitting(true); setError(""); setNotice("");
    try {
      const expectedUpdatedAtByLocale = Object.fromEntries((["en", "zhHant", "zhHans"] as AdminLocale[]).map((language) => [language, store?.locales?.[language]?.itemUpdatedAt?.[editing.page]?.[editing.key] || null]));
      const result = await adminFetch<{ content: ContentStore; revision: unknown }>("/api/content/update", {
        method: "POST",
        body: JSON.stringify({ page: editing.page, key: editing.key, values: draft, expectedUpdatedAtByLocale, translationReceipt: autoTranslate ? translationReceipt : undefined }),
      });
      setStore(result.content); original.current = JSON.stringify(draft); setEditing(null); setTranslationReceipt(""); setTranslationStatus({}); setNotice(text.saved);
      window.iHearLiveContent?.announce?.("content", result.revision);
    } catch (reason: any) {
      setError(reason?.status === 409 ? text.conflict : displayError(reason, locale));
    } finally { setSubmitting(false); }
  }

  return <section className="admin-page">
    <header className="admin-page-head"><div><h1>{text.title}</h1><p>{text.intro}</p></div></header>
    {error && !editing && <p className="admin-alert" role="alert">{error}</p>}
    {notice && <p className="admin-alert admin-success" role="status">{notice}</p>}
    <div className="admin-toolbar">
      <input className="admin-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={text.search} />
      <select className="admin-select" value={page} onChange={(event) => setPage(event.target.value)} aria-label={text.allPages}>
        <option value="all">{text.allPages}</option>
        {pages.map((item) => <option value={item} key={item}>{pageName(item, locale)}</option>)}
      </select>
    </div>
    {loading ? <p>{text.loading}</p> : filtered.length ? <div className="admin-content-grid">
      {filtered.map((slot) => <article className="admin-content-card" key={identity(slot)}>
        <div className="admin-content-meta"><span>{pageName(slot.page, locale)}</span>{slot.page === "/__global__" && <span className="admin-status published">{text.shared}</span>}</div>
        <h2>{effectiveValue(store, slot, locale)}</h2>
        {locale !== "en" && <p lang="en">{effectiveValue(store, slot, "en")}</p>}
        <small>{slot.mode === "singleline" ? text.singleline : text.multiline} · {text.location.replace("{count}", String(slot.occurrences?.length || 1))}</small>
        <div className="admin-card-actions">
          <a className="admin-button secondary" href={previewPath(slot.page)} target="_blank" rel="noreferrer">{text.preview}</a>
          <button className="admin-button primary" onClick={() => beginEdit(slot)}>{text.edit}</button>
        </div>
      </article>)}
    </div> : <div className="admin-empty">{text.empty}</div>}
    {editing && <><button className="admin-drawer-backdrop" aria-label={text.cancel} onClick={close} /><aside className="admin-drawer" role="dialog" aria-modal="true" aria-labelledby="content-form-title" aria-busy={submitting || translating}>
      <div className="admin-drawer-head"><div><h2 id="content-form-title">{text.dialog}</h2><p className="admin-muted">{pageName(editing.page, locale)} · {text.hint}</p></div><button className="admin-icon-button" disabled={submitting} onClick={close} aria-label={text.cancel}>×</button></div>
      {error && <p className="admin-alert" role="alert">{error}</p>}
      <div className="admin-form">
        <label className="admin-field"><span>{text.english} <small>{draft.en.length}/{editing.maxLength}</small></span>{editing.mode === "multiline" ? <textarea value={draft.en} maxLength={editing.maxLength} disabled={submitting || translating} onChange={(event) => updateDraft("en", event.target.value)} /> : <input value={draft.en} maxLength={editing.maxLength} disabled={submitting || translating} onChange={(event) => updateDraft("en", event.target.value)} />}</label>
        <LanguageGuardNotice locale={locale} language="en" value={draft.en} disabled={submitting || translating} englishAccepted={englishGuardAccepted} onAcceptEnglish={() => setEnglishGuardAccepted(true)} />
        <label className="admin-checkbox"><input type="checkbox" checked={autoTranslate} disabled={submitting || translating} onChange={(event) => { setAutoTranslate(event.target.checked); setTranslationReceipt(""); setTranslationStatus({}); }} />{text.autoTranslate}</label>
        {autoTranslate && <label className="admin-checkbox"><input type="checkbox" checked={replaceExisting} disabled={submitting || translating} onChange={(event) => { setReplaceExisting(event.target.checked); setTranslationReceipt(""); setTranslationStatus({}); }} />{text.replaceExisting}</label>}
        <details className="admin-translation-preview" open={Boolean(translationReceipt) || !autoTranslate}>
          <summary>{text.translations}</summary>
          <p className="admin-muted">{text.manualHelp}</p>
          {(["zhHant", "zhHans"] as const).map((language) => <div key={language}><label className="admin-field"><span>{language === "zhHant" ? text.hant : text.hans} {translationStatus[language] && <small className={`admin-translation-status ${translationStatus[language]}`}>{translationStatus[language] === "translated" ? text.translated : text.protected}</small>} <small>{draft[language].length}/{editing.maxLength}</small></span>{editing.mode === "multiline" ? <textarea value={draft[language]} maxLength={editing.maxLength} disabled={submitting || translating} onChange={(event) => updateDraft(language, event.target.value)} /> : <input value={draft[language]} maxLength={editing.maxLength} disabled={submitting || translating} onChange={(event) => updateDraft(language, event.target.value)} />}</label><LanguageGuardNotice locale={locale} language={language} value={draft[language]} disabled={submitting || translating} onChange={(value) => updateDraft(language, value)} /></div>)}
        </details>
        <div className="admin-form-footer"><button className="admin-button secondary" disabled={submitting || translating} onClick={close}>{text.cancel}</button><button className="admin-button primary" disabled={submitting || translating} onClick={save}>{submitting ? text.saving : translating ? text.preparing : autoTranslate && !translationReceipt ? text.prepare : text.save}</button></div>
      </div>
    </aside></>}
  </section>;
}

declare global { interface Window { iHearLiveContent?: { register?: (scope: string, handler: unknown) => void; announce?: (scope: string, revision: unknown) => void }; } }
