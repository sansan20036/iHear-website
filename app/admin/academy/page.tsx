"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import {
  ACADEMY_CURRENCIES,
  ACADEMY_DURATIONS,
  ACADEMY_LOCALES,
  ACADEMY_PRICE_LIMITS,
  ACADEMY_TUTORS,
  academyBlocks,
  academyFields,
  academyPackagePrice,
  parseAcademyContentConfig,
  type AcademyContentConfig,
  type AcademyCurrency,
  type AcademyDuration,
  type AcademyField,
  type AcademyLocale,
  type AcademyTutor,
  type AcademyValidationCode,
} from "../../../lib/academy-content-types";
import { academyMoney } from "../../../lib/academy-pricing-text";
import { adminFetch, displayError } from "../admin-api";
import { useAdmin } from "../admin-context";
import {
  academyDraftChanges,
  academyDraftConfig,
  academyDraftProblems,
  academyPriceWarnings,
  contentKey,
  parsedPrice,
  priceKey,
  toAcademyDraft,
  type AcademyDraft,
} from "./academy-draft";
import { academyBlockLabel, academyFieldLabel, academySectionLabel, type AcademyUiLocale } from "./academy-labels";

type Published = { config: AcademyContentConfig; recordVersion: number };
type Embed = { locale: AcademyLocale; block: string };
type AccessProblem = "" | "signin" | "forbidden" | "unknown";

const copy = {
  zhHant: {
    title: "Academy 課程頁內容", embeddedTitle: "編輯：", intro: "修改英文與繁體中文課程頁的價格與文字。十堂方案（九折）與常見問題中的價格會依單堂價格自動更新。",
    inline: "也可以在課程頁直接點選 ✎ 編輯該區塊；兩種方式修改的是同一份內容。", viewZh: "查看中文課程頁", viewEn: "查看英文課程頁",
    prices: "課程價格", priceHelp: "台幣與美元分別設定，不會依匯率換算。單堂價格請輸入整數；十堂方案由系統以「單堂 × 10 × 90%」自動計算。",
    tutor: "導師", duration: "上課時間", minutes: "分鐘", single: "單堂", package: "十堂九折", twd: "新台幣", usd: "美元",
    warnDuration: "60 分鐘的價格低於 45 分鐘，請確認。", warnTutor: "大學生導師的價格低於高中生導師，請確認。", warnCurrency: "台幣與美元的比例和其他價格差很多，請確認沒有輸入錯誤。",
    pages: "頁面文字", zhPage: "繁體中文頁面", enPage: "英文頁面", tutorNameHelp: "導師名稱也會用在價格說明與常見問題中。",
    faqPriceHelp: "這一題的價格列表會依課程價格自動產生，請只修改列表前後的文字。",
    counter: (count: number, max: number) => `${count}/${max} 字`,
    required: "此欄位不能空白。", tooLong: (max: number) => `請在 ${max} 字以內。`, singleLine: "此欄位請保持一行，不要換行。",
    unsupported: "含有無法儲存的字元，請刪除後再試。", priceWhole: "請輸入整數金額，不含小數點、逗號或符號。",
    priceRange: (min: number, max: number) => `請輸入 ${min}–${max.toLocaleString("en-US")} 之間的金額。`, invalid: "請檢查標示的欄位，草稿已保留。",
    preview: "預覽頁面", previewTitle: "預覽（尚未發布）", previewLanguage: "預覽語言", closePreview: "關閉預覽", previewing: "正在產生預覽…",
    previewError: "暫時無法產生預覽，草稿已保留。", review: "檢查變更並發布", reviewTitle: "確認要發布以下變更嗎？",
    reviewBody: "發布後，所有訪客重新整理課程頁就會看到新內容。", priceChanges: "價格", textChanges: "文字", before: "變更前", after: "變更後",
    confirm: "確認發布", back: "返回編輯", publishing: "發布中…", noChanges: "目前沒有變更。",
    problems: (count: number) => `還有 ${count} 個欄位需要修正。`, unsaved: "尚有未發布的變更", unchanged: "所有內容皆已發布",
    saved: "已發布。重新整理課程頁即可看到更新。", reload: "重新載入最新內容", loading: "正在載入已發布內容…", retry: "重試",
    loadError: "無法載入已發布內容，請重試後再編輯。", reloadError: "無法載入最新內容，原有草稿仍保留。",
    reloadTitle: "要取代尚未發布的草稿嗎？", reloadBody: "重新載入會以最新發布內容取代你的草稿。如果載入失敗，草稿仍會保留。", keep: "繼續編輯", discard: "重新載入並放棄草稿",
    conflict: "另一位管理員已發布較新的版本。你的草稿仍保留，請重新載入最新內容後再修改發布。",
    saveError: "未能發布，草稿已保留；你可以稍後重試。", signIn: "登入已過期。草稿已保留；請在新分頁重新登入，再按「重新確認權限」。",
    forbidden: "這個帳號目前沒有管理權限，無法發布。草稿已保留。", accessUnknown: "暫時無法確認管理員權限。草稿已保留，確認權限前無法發布。",
    signInLink: "在新分頁重新登入", checkAccess: "重新確認權限", cancel: "取消",
    closeTitle: "要放棄尚未發布的變更嗎？", closeBody: "變更尚未發布。你可以繼續編輯，或放棄草稿並關閉編輯視窗。", closeDiscard: "放棄並關閉",
    empty: "（空白）",
  },
  en: {
    title: "Academy course pages", embeddedTitle: "Edit: ", intro: "Edit the prices and text of the English and Traditional Chinese course pages. Ten-session prices (10% off) and the prices in the FAQ follow the single-session prices automatically.",
    inline: "You can also select ✎ on a course page to edit that section; both ways edit the same content.", viewZh: "View the Chinese page", viewEn: "View the English page",
    prices: "Lesson prices", priceHelp: "NT$ and US$ prices are set separately and never converted. Enter whole numbers; ten-session prices are calculated as single × 10 × 90%.",
    tutor: "Tutor", duration: "Length", minutes: "minutes", single: "Single", package: "10 sessions, 10% off", twd: "NT$", usd: "US$",
    warnDuration: "The 60-minute price is lower than the 45-minute price. Please check.", warnTutor: "The college tutor price is lower than the high-school tutor price. Please check.", warnCurrency: "The NT$ to US$ ratio differs a lot from the other prices. Please check for a typo.",
    pages: "Page text", zhPage: "Traditional Chinese page", enPage: "English page", tutorNameHelp: "Tutor names also appear in the price sentences and the FAQ.",
    faqPriceHelp: "The price list in this answer is generated from the lesson prices; edit only the text before and after it.",
    counter: (count: number, max: number) => `${count}/${max} characters`,
    required: "This field cannot be empty.", tooLong: (max: number) => `Use at most ${max} characters.`, singleLine: "Keep this field on one line.",
    unsupported: "This text contains a character that cannot be saved. Remove it and try again.", priceWhole: "Enter a whole number without decimals, commas or symbols.",
    priceRange: (min: number, max: number) => `Enter an amount from ${min} to ${max.toLocaleString("en-US")}.`, invalid: "Check the highlighted field. Your draft has been kept.",
    preview: "Preview page", previewTitle: "Preview (not published)", previewLanguage: "Preview language", closePreview: "Close preview", previewing: "Preparing the preview…",
    previewError: "The preview is unavailable right now. Your draft has been kept.", review: "Review and publish", reviewTitle: "Publish these changes?",
    reviewBody: "After publishing, every visitor sees the new content when the course page reloads.", priceChanges: "Prices", textChanges: "Text", before: "Before", after: "After",
    confirm: "Publish", back: "Back to editing", publishing: "Publishing…", noChanges: "There are no changes.",
    problems: (count: number) => `${count} fields still need attention.`, unsaved: "Unpublished changes", unchanged: "All content is published",
    saved: "Published. Reload a course page to see the update.", reload: "Reload latest content", loading: "Loading published content…", retry: "Try again",
    loadError: "Published content could not be loaded. Try again before editing.", reloadError: "The latest content could not be loaded. Your draft is still here.",
    reloadTitle: "Replace your unpublished draft?", reloadBody: "Reloading replaces your draft with the latest published content. Your draft is kept if the request fails.", keep: "Keep editing", discard: "Reload and discard draft",
    conflict: "Another administrator published a newer version. Your draft is kept; reload the latest content before publishing again.",
    saveError: "Publishing failed. Your draft has been kept; try again later.", signIn: "Your sign-in has expired. Your draft is kept; sign in again in a new tab, then select “Check access again”.",
    forbidden: "This account has no administrator access, so it cannot publish. Your draft has been kept.", accessUnknown: "Administrator access could not be confirmed. Your draft is kept; publishing is disabled until access is checked again.",
    signInLink: "Sign in again in a new tab", checkAccess: "Check access again", cancel: "Cancel",
    closeTitle: "Discard your unpublished changes?", closeBody: "Your changes are not published. Keep editing, or discard them and close this editor.", closeDiscard: "Discard and close",
    empty: "(empty)",
  },
};

function embeddedOptions(): Embed | null {
  const params = new URLSearchParams(window.location.search);
  if (window.parent === window || params.get("embed") !== "1") return null;
  const locale: AcademyLocale = params.get("locale") === "en" ? "en" : "zhHant";
  const requested = params.get("block") || "";
  return { locale, block: academyBlocks(locale).includes(requested) ? requested : academyBlocks(locale)[0] };
}

function notifyParent(type: string, details: Record<string, unknown> = {}) {
  if (window.parent !== window) window.parent.postMessage({ type, ...details }, window.location.origin);
}

// A stalled connection must eventually release busy controls while keeping the
// draft. An aborted publication is unconfirmed; it is never retried automatically.
async function timedFetch<T>(url: string, init: RequestInit = {}, timeout = 15_000): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (init.signal?.aborted) abort();
  else init.signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, timeout);
  try { return await adminFetch<T>(url, { ...init, signal: controller.signal }); }
  finally {
    clearTimeout(timer);
    init.signal?.removeEventListener("abort", abort);
  }
}

function checkedResponse(response: Published): Published {
  if (!Number.isSafeInteger(response.recordVersion) || response.recordVersion < 1 || response.recordVersion > 2_147_483_647) throw new Error("Invalid content version");
  return { config: parseAcademyContentConfig(response.config), recordVersion: response.recordVersion };
}

const characters = (value: string) => Array.from(value).length;

function useModal(open: boolean, ref: React.RefObject<HTMLDialogElement | null>) {
  useEffect(() => {
    const dialog = ref.current;
    if (open && dialog && !dialog.open) dialog.showModal();
    else if (!open && dialog?.open) dialog.close();
  }, [open, ref]);
}

export default function AdminAcademyPage() {
  const { locale: adminLocale, principal, dirty: adminDirty, setDirty, setSubmitting, submitting } = useAdmin();
  const [embed, setEmbed] = useState<Embed | null>(null);
  const [frameVisible, setFrameVisible] = useState(false);
  const ui: AcademyUiLocale = (embed?.locale ?? adminLocale) === "en" ? "en" : "zhHant";
  const text = copy[ui];
  const [pageLocale, setPageLocale] = useState<AcademyLocale>("zhHant");
  const [published, setPublished] = useState<Published | null>(null);
  const [draft, setDraft] = useState<AcademyDraft | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [invalidField, setInvalidField] = useState("");
  const [conflict, setConflict] = useState(false);
  const [saved, setSaved] = useState(false);
  const [access, setAccess] = useState<AccessProblem>("");
  const [checkingAccess, setCheckingAccess] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [preview, setPreview] = useState<{ html: string; locale: AcademyLocale } | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [reloadConfirm, setReloadConfirm] = useState(false);
  const [closeConfirm, setCloseConfirm] = useState(false);
  const [pendingClose, setPendingClose] = useState(false);
  const [pendingSavedVersion, setPendingSavedVersion] = useState<number | null>(null);
  const requestActive = useRef(false);
  const accessRequestActive = useRef(false);
  const accessGeneration = useRef(0);
  const focusedInitialField = useRef(false);
  const reviewDialog = useRef<HTMLDialogElement>(null);
  const previewDialog = useRef<HTMLDialogElement>(null);
  const reloadDialog = useRef<HTMLDialogElement>(null);
  const closeDialog = useRef<HTMLDialogElement>(null);

  const changes = useMemo(() => (published && draft ? academyDraftChanges(published.config, draft) : []), [published, draft]);
  const problems = useMemo(() => (draft ? academyDraftProblems(draft) : new Map<string, AcademyValidationCode>()), [draft]);
  const warnings = useMemo(() => (draft ? academyPriceWarnings(draft) : []), [draft]);
  const dirty = changes.length > 0;
  const busy = loading || submitting || checkingAccess || previewing;
  const blocked = busy || conflict || Boolean(access);

  useEffect(() => {
    const options = embeddedOptions();
    setEmbed(options);
    const requested = new URLSearchParams(window.location.search).get("locale");
    setPageLocale(options?.locale ?? (requested === "en" ? "en" : "zhHant"));
  }, []);

  useEffect(() => {
    setDirty("academy-content", dirty);
    return () => setDirty("academy-content", false);
  }, [dirty, setDirty]);

  useModal(reviewOpen, reviewDialog);
  useModal(Boolean(preview), previewDialog);
  useModal(reloadConfirm, reloadDialog);
  useModal(closeConfirm, closeDialog);

  useEffect(() => {
    if (embed) notifyParent("ihear:academy-editor-state", { dirty, busy });
  }, [embed, dirty, busy]);

  useEffect(() => {
    if (!embed || dirty || adminDirty || busy || requestActive.current) return;
    if (pendingSavedVersion !== null) {
      notifyParent("ihear:academy-editor-saved", { recordVersion: pendingSavedVersion });
      setPendingSavedVersion(null);
    } else if (pendingClose) {
      notifyParent("ihear:academy-editor-close");
      setPendingClose(false);
    }
  }, [embed, dirty, adminDirty, busy, pendingSavedVersion, pendingClose]);

  useEffect(() => {
    if (!embed || !frameVisible || !draft || loading || focusedInitialField.current) return;
    const first = document.querySelector<HTMLElement>(".admin-academy-field input, .admin-academy-field textarea, .admin-academy-price input");
    if (!first) return;
    focusedInitialField.current = true;
    first.focus({ preventScroll: true });
  }, [embed, frameVisible, draft, loading]);

  function requestClose() {
    if (!embed || busy || requestActive.current || accessRequestActive.current) return;
    if (dirty) setCloseConfirm(true);
    else setPendingClose(true);
  }

  useEffect(() => {
    if (!embed) return;
    const receive = (event: MessageEvent) => {
      if (event.origin !== window.location.origin || event.source !== window.parent || !event.data || typeof event.data !== "object") return;
      if (event.data.type === "ihear:academy-editor-visible") setFrameVisible(true);
      if (event.data.type === "ihear:academy-editor-close-request") requestClose();
      if (event.data.type === "ihear:academy-editor-auth-unavailable") {
        accessGeneration.current++;
        setAccess("unknown");
      }
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || reviewDialog.current?.open || previewDialog.current?.open || reloadDialog.current?.open || closeDialog.current?.open) return;
      event.preventDefault();
      requestClose();
    };
    window.addEventListener("message", receive);
    window.addEventListener("keydown", escape);
    return () => { window.removeEventListener("message", receive); window.removeEventListener("keydown", escape); };
    // requestClose reads only embed, dirty and busy.
  }, [embed, dirty, busy]);

  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!dirty && !busy) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [dirty, busy]);

  async function checkAccess() {
    if (busy || requestActive.current || accessRequestActive.current) return;
    accessRequestActive.current = true;
    const generation = accessGeneration.current;
    setCheckingAccess(true);
    try {
      const result = await timedFetch<{ ok: boolean; principal: { email: string; role: string } }>("/api/admin/me");
      if (result.ok !== true || result.principal?.email !== principal.email || !["owner", "editor"].includes(result.principal.role)) throw new Error("Access unavailable");
      if (generation === accessGeneration.current) setAccess("");
    } catch (reason) {
      const status = (reason as { status?: number }).status;
      setAccess(status === 401 ? "signin" : status === 403 ? "forbidden" : "unknown");
    } finally { accessRequestActive.current = false; setCheckingAccess(false); }
  }

  async function loadLatest(signal?: AbortSignal) {
    if (requestActive.current || accessRequestActive.current) return;
    requestActive.current = true;
    setLoading(true);
    setSaved(false);
    try {
      const next = checkedResponse(await timedFetch<Published>("/api/academy-content", { signal }));
      if (signal?.aborted) return;
      setPublished(next);
      setDraft(toAcademyDraft(next.config));
      setError("");
      setInvalidField("");
      setConflict(false);
    } catch {
      if (!signal?.aborted) setError(published ? text.reloadError : text.loadError);
    } finally {
      if (!signal?.aborted) {
        requestActive.current = false;
        setLoading(false);
      }
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    void loadLatest(controller.signal);
    return () => { controller.abort(); requestActive.current = false; };
    // Load once on mount; later loads are explicit.
  }, []);

  function edited() {
    setInvalidField("");
    setSaved(false);
    setPendingSavedVersion(null);
  }

  function updatePrice(currency: AcademyCurrency, duration: AcademyDuration, tutor: AcademyTutor, value: string) {
    setDraft(current => current ? { ...current, prices: { ...current.prices, [currency]: { ...current.prices[currency], [duration]: { ...current.prices[currency][duration], [tutor]: value } } } } : current);
    edited();
  }

  function updateText(locale: AcademyLocale, id: string, value: string) {
    setDraft(current => current ? { ...current, content: { ...current.content, [locale]: { ...current.content[locale], [id]: value } } } : current);
    edited();
  }

  function message(code: AcademyValidationCode | undefined, key: string) {
    if (!code) return "";
    if (code === "required") return text.required;
    if (code === "single_line") return text.singleLine;
    if (code === "unsupported_character") return text.unsupported;
    if (code === "price_not_whole") return text.priceWhole;
    if (code === "price_range") {
      const currency = key.split(".")[2] as AcademyCurrency;
      return text.priceRange(ACADEMY_PRICE_LIMITS[currency].min, ACADEMY_PRICE_LIMITS[currency].max);
    }
    if (code === "too_long") {
      const [, locale, ...rest] = key.split(".");
      const field = academyFields(locale as AcademyLocale).find(item => item.id === rest.join("."));
      return text.tooLong(field?.maxLength ?? 0);
    }
    return text.invalid;
  }

  function focusProblem(key: string) {
    const target = document.getElementById(key);
    if (target) {
      target.closest("details")?.setAttribute("open", "");
      target.focus();
    }
  }

  function requestReload() {
    if (busy || requestActive.current) return;
    if (dirty) setReloadConfirm(true);
    else void loadLatest();
  }

  function openReview() {
    if (!draft || !published || blocked) return;
    const first = problems.keys().next();
    if (!first.done) {
      setInvalidField(first.value);
      setError(text.invalid);
      focusProblem(first.value);
      return;
    }
    setError("");
    setReviewOpen(true);
  }

  async function openPreview(locale: AcademyLocale) {
    if (!draft || busy || requestActive.current) return;
    const first = problems.keys().next();
    if (!first.done) { setInvalidField(first.value); setError(text.invalid); focusProblem(first.value); return; }
    requestActive.current = true;
    setPreviewing(true);
    setError("");
    try {
      const result = await timedFetch<{ ok: true; html: string }>("/api/academy-content/preview", {
        method: "POST", body: JSON.stringify({ config: academyDraftConfig(draft), locale }),
      }, 30_000);
      if (result.ok !== true || typeof result.html !== "string") throw new Error("Preview was not returned");
      setPreview({ html: result.html, locale });
    } catch (reason) {
      const status = (reason as { status?: number }).status;
      if (status === 401) setAccess("signin");
      else if (status === 403) setAccess("forbidden");
      else setError(status === 429 ? displayError(reason, ui) : text.previewError);
    } finally {
      requestActive.current = false;
      setPreviewing(false);
    }
  }

  function scrollPreview(frame: HTMLIFrameElement) {
    if (!embed) return;
    frame.contentDocument?.querySelector(`[data-academy-block="${CSS.escape(embed.block)}"]`)?.scrollIntoView({ block: "start" });
  }

  async function publish() {
    if (!draft || !published || requestActive.current || accessRequestActive.current || blocked) return;
    let config: AcademyContentConfig;
    try {
      config = parseAcademyContentConfig(academyDraftConfig(draft));
    } catch (reason) {
      const field = (reason as { field?: string }).field || "";
      setReviewOpen(false);
      setInvalidField(field);
      setError(message((reason as { code?: AcademyValidationCode }).code, field) || text.invalid);
      focusProblem(field);
      return;
    }
    requestActive.current = true;
    setSubmitting(true);
    setError("");
    setSaved(false);
    try {
      const result = await timedFetch<Published & { ok: true }>("/api/academy-content", {
        method: "POST",
        body: JSON.stringify({ config, expectedVersion: published.recordVersion }),
      }, 30_000);
      if (result.ok !== true) throw new Error("Publication was not confirmed");
      const next = checkedResponse(result);
      if (next.recordVersion !== published.recordVersion + 1) throw new Error("Publication version was not confirmed");
      setPublished(next);
      setDraft(toAcademyDraft(next.config));
      setSaved(true);
      setReviewOpen(false);
      if (embed) setPendingSavedVersion(next.recordVersion);
    } catch (reason) {
      setReviewOpen(false);
      const details = reason as { status?: number; field?: string };
      if (details.status === 409 || details.status === 428) {
        setConflict(true);
        setError(text.conflict);
      } else if (details.status === 401 || details.status === 403) {
        accessGeneration.current++;
        setAccess(details.status === 401 ? "signin" : "forbidden");
      } else if (details.status === 429) {
        setError(displayError(reason, ui));
      } else {
        setError(details.status === 400 || details.status === 413 ? text.invalid : text.saveError);
      }
    } finally {
      requestActive.current = false;
      setSubmitting(false);
    }
  }

  const tutorNames = (draft ? draft.content[ui] : published?.config.content[ui]) ?? {};
  const tutorName = (tutor: AcademyTutor) => tutorNames[`pricing.card.tutor.${tutor}`] || tutor;
  const showPrices = !embed || embed.block === "pricing.card";
  const visibleLocales: AcademyLocale[] = embed ? [embed.locale] : [pageLocale];
  const warningFor = (key: string) => warnings.filter(item => item.key === key).map(item => item.kind === "duration" ? text.warnDuration : item.kind === "tutor" ? text.warnTutor : text.warnCurrency);

  function fieldInput(locale: AcademyLocale, field: AcademyField) {
    const key = contentKey(locale, field.id);
    const value = draft!.content[locale][field.id] ?? "";
    const problem = problems.get(key);
    const describedBy = [`${key}-count`, problem || invalidField === key ? `${key}-error` : "", field.id.startsWith("pricing.card.tutor.") ? "academy-tutor-help" : ""].filter(Boolean).join(" ");
    const common = {
      id: key, name: key, value, lang: locale === "en" ? "en" : "zh-Hant",
      "aria-invalid": Boolean(problem) || invalidField === key, "aria-describedby": describedBy,
      onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => updateText(locale, field.id, event.target.value),
    };
    return <label key={key} className="admin-field admin-academy-field">
      <span>{academyFieldLabel(field, ui)}</span>
      {field.kind === "multiline"
        ? <textarea {...common} rows={Math.min(8, Math.max(2, Math.ceil(characters(value) / 60) + value.split("\n").length - 1))} />
        : <input {...common} />}
      <small id={`${key}-count`} className="admin-muted">{text.counter(characters(value), field.maxLength)}</small>
      {(problem || invalidField === key) && <small id={`${key}-error`} className="admin-academy-problem" role="alert">{message(problem, key) || error}</small>}
    </label>;
  }

  function blockEditor(locale: AcademyLocale, block: string) {
    const fields = academyFields(locale).filter(field => field.block === block);
    const heading = fields.find(field => /\.(title|question)$/.test(field.id) && field.block === block);
    const summaryText = heading ? draft!.content[locale][heading.id]?.split("\n").join(" ") : "";
    const blockProblems = fields.filter(field => problems.has(contentKey(locale, field.id))).length;
    const changed = changes.some(change => change.type === "text" && change.locale === locale && change.field.block === block);
    const body = <>
      {block === "pricing.card" && <p id="academy-tutor-help" className="admin-muted">{text.tutorNameHelp}</p>}
      {block.startsWith("faq.") && fields.some(field => field.id.endsWith(".answerLead")) && <p className="admin-muted">{text.faqPriceHelp}</p>}
      {fields.map(field => fieldInput(locale, field))}
    </>;
    if (embed) return <div key={block} className="admin-academy-block" data-academy-editor-block={block}>{body}</div>;
    return <details key={block} className="admin-academy-block" data-academy-editor-block={block} open={blockProblems > 0 || undefined}>
      <summary>
        <strong>{academyBlockLabel(block, ui)}</strong>
        {summaryText && <span className="admin-muted">{summaryText}</span>}
        {changed && <span className="admin-academy-badge">{text.unsaved}</span>}
        {blockProblems > 0 && <span className="admin-academy-badge problem">{text.problems(blockProblems)}</span>}
      </summary>
      {body}
    </details>;
  }

  function pricesEditor() {
    return <fieldset className="admin-academy-prices" disabled={busy}>
      <legend>{text.prices}</legend>
      <p className="admin-muted">{text.priceHelp}</p>
      <div className="admin-academy-price-table" role="group" aria-label={text.prices}>
        {ACADEMY_TUTORS.map(tutor => <div key={tutor} className="admin-academy-price-tutor">
          <h3>{tutorName(tutor)}</h3>
          {ACADEMY_DURATIONS.map(duration => <div key={duration} className="admin-academy-price-row">
            <strong>{duration} {text.minutes}</strong>
            {ACADEMY_CURRENCIES.map(currency => {
              const key = priceKey(currency, duration, tutor);
              const raw = draft!.prices[currency][duration][tutor];
              const amount = parsedPrice(raw);
              const problem = problems.get(key);
              const notes = warningFor(key);
              return <div key={currency} className="admin-academy-price">
                <label className="admin-field">
                  <span>{text.single}（{currency === "TWD" ? text.twd : text.usd}）</span>
                  <input id={key} name={key} type="text" inputMode="numeric" autoComplete="off" value={raw}
                    aria-invalid={Boolean(problem) || invalidField === key} aria-describedby={`${key}-package${problem ? ` ${key}-error` : ""}${notes.length ? ` ${key}-warning` : ""}`}
                    onChange={event => updatePrice(currency, duration, tutor, event.target.value)} />
                </label>
                <p id={`${key}-package`} className="admin-academy-package"><span>{text.package}</span><strong data-academy-package={key}>{problem ? "—" : academyMoney(currency, academyPackagePrice(amount))}</strong></p>
                {problem && <small id={`${key}-error`} className="admin-academy-problem" role="alert">{message(problem, key)}</small>}
                {!problem && notes.length > 0 && <small id={`${key}-warning`} className="admin-academy-warning">{notes.join(" ")}</small>}
              </div>;
            })}
          </div>)}
        </div>)}
      </div>
    </fieldset>;
  }

  function changeList() {
    const priceChanges = changes.filter(change => change.type === "price");
    const textChanges = changes.filter(change => change.type === "text");
    if (!changes.length) return <p>{text.noChanges}</p>;
    return <div className="admin-academy-changes">
      {priceChanges.length > 0 && <section><h3>{text.priceChanges}</h3><ul>
        {priceChanges.map(change => change.type === "price" && <li key={priceKey(change.currency, change.duration, change.tutor)}>
          <strong>{tutorName(change.tutor)} · {change.duration} {text.minutes} · {change.currency === "TWD" ? text.twd : text.usd}</strong>
          <span>{text.single}：{academyMoney(change.currency, change.before)} → {academyMoney(change.currency, change.after)}</span>
          <span>{text.package}：{academyMoney(change.currency, academyPackagePrice(change.before))} → {academyMoney(change.currency, academyPackagePrice(change.after))}</span>
        </li>)}
      </ul></section>}
      {textChanges.length > 0 && <section><h3>{text.textChanges}</h3><ul>
        {textChanges.map(change => change.type === "text" && <li key={contentKey(change.locale, change.field.id)}>
          <strong>{change.locale === "zhHant" ? text.zhPage : text.enPage} · {academyBlockLabel(change.field.block, ui)} · {academyFieldLabel(change.field, ui)}</strong>
          <span className="admin-academy-before">{text.before}：{change.before || text.empty}</span>
          <span className="admin-academy-after">{text.after}：{change.after || text.empty}</span>
        </li>)}
      </ul></section>}
    </div>;
  }

  const problemCount = problems.size;
  const sections = useMemo(() => {
    const grouped = new Map<string, string[]>();
    for (const block of academyBlocks(pageLocale)) {
      const section = block.split(".")[0];
      grouped.set(section, [...(grouped.get(section) || []), block]);
    }
    return [...grouped];
  }, [pageLocale]);

  return <section className={`admin-page admin-academy${embed ? " admin-academy-embedded" : ""}`}>
    <header className="admin-page-head"><div>
      <h1>{embed ? `${text.embeddedTitle}${academyBlockLabel(embed.block, ui)}` : text.title}</h1>
      {!embed && <p>{text.intro}</p>}
    </div></header>
    {!embed && <div className="admin-academy-published">
      <span>{text.inline}</span>
      <a className="admin-button secondary" href="/academy/courses/zh?entry=official" target="_blank" rel="noopener noreferrer">{text.viewZh}</a>
      <a className="admin-button secondary" href="/academy/courses?entry=official" target="_blank" rel="noopener noreferrer">{text.viewEn}</a>
    </div>}
    {access && <div className="admin-alert" role="alert" data-academy-editor-access={access}>
      <p>{access === "signin" ? text.signIn : access === "forbidden" ? text.forbidden : text.accessUnknown}</p>
      <div className="admin-actions">
        {access === "signin" && <a className="admin-button secondary" href="/api/auth/signin?callbackUrl=%2Fadmin%2Facademy" target="_blank" rel="noopener noreferrer">{text.signInLink}</a>}
        <button type="button" className="admin-button secondary" data-academy-editor-access-retry disabled={busy} onClick={() => void checkAccess()}>{text.checkAccess}</button>
      </div>
    </div>}
    {error && !invalidField && <p id="academy-content-error" className="admin-alert" role="alert">{error}</p>}
    {saved && <p className="admin-alert success" role="status" data-academy-editor-saved>{text.saved}</p>}
    {loading && <p role="status">{text.loading}</p>}
    {!draft && !loading && <button type="button" className="admin-button secondary" onClick={() => void loadLatest()}>{text.retry}</button>}
    {draft && <form className="admin-form" onSubmit={event => { event.preventDefault(); openReview(); }} noValidate aria-busy={busy}>
      {showPrices && pricesEditor()}
      <fieldset className="admin-academy-language" disabled={busy}>
        <legend>{embed ? (embed.locale === "zhHant" ? text.zhPage : text.enPage) : text.pages}</legend>
        {!embed && <div className="admin-academy-tabs" role="tablist" aria-label={text.pages}>
          {ACADEMY_LOCALES.map(locale => <button key={locale} type="button" role="tab" aria-selected={pageLocale === locale} className={pageLocale === locale ? "active" : ""} onClick={() => setPageLocale(locale)}>
            {locale === "zhHant" ? text.zhPage : text.enPage}
          </button>)}
        </div>}
        {visibleLocales.map(locale => embed
          ? blockEditor(locale, embed.block)
          : sections.map(([section, blocks]) => <div key={`${locale}-${section}`} className="admin-academy-section">
            <h2>{academySectionLabel(section, ui)}</h2>
            {blocks.map(block => blockEditor(locale, block))}
          </div>))}
      </fieldset>
      <div className="admin-academy-actions">
        <span className="admin-muted" role="status">{problemCount ? text.problems(problemCount) : dirty ? text.unsaved : text.unchanged}</span>
        {embed && <button type="button" className="admin-button secondary" data-academy-editor-cancel onClick={requestClose} disabled={busy}>{text.cancel}</button>}
        <button type="button" className="admin-button secondary" data-academy-editor-reload onClick={requestReload} disabled={busy}>{text.reload}</button>
        <button type="button" className="admin-button secondary" data-academy-editor-preview onClick={() => void openPreview(embed?.locale ?? pageLocale)} disabled={busy || Boolean(access)}>{previewing ? text.previewing : text.preview}</button>
        <button type="submit" className="admin-button primary" data-academy-editor-review disabled={blocked || !dirty}>{submitting ? text.publishing : text.review}</button>
      </div>
    </form>}
    {embed && !draft && <button type="button" className="admin-button secondary" data-academy-editor-cancel onClick={requestClose} disabled={busy}>{text.cancel}</button>}

    <dialog ref={reviewDialog} className="admin-confirm admin-academy-review" onCancel={event => { event.preventDefault(); if (!submitting) setReviewOpen(false); }} aria-labelledby="academy-review-title">
      <div className="admin-confirm-card">
        <h2 id="academy-review-title">{text.reviewTitle}</h2>
        <p>{text.reviewBody}</p>
        {changeList()}
        <div className="admin-actions">
          <button type="button" className="admin-button secondary" disabled={submitting} onClick={() => setReviewOpen(false)}>{text.back}</button>
          <button type="button" className="admin-button primary" data-academy-editor-publish disabled={blocked || !dirty} onClick={() => void publish()}>{submitting ? text.publishing : text.confirm}</button>
        </div>
      </div>
    </dialog>
    <dialog ref={previewDialog} className="admin-academy-preview" onCancel={event => { event.preventDefault(); setPreview(null); }} aria-labelledby="academy-preview-title">
      <div className="admin-academy-preview-bar">
        <h2 id="academy-preview-title">{text.previewTitle}</h2>
        {!embed && <span className="admin-academy-tabs" role="group" aria-label={text.previewLanguage}>
          {ACADEMY_LOCALES.map(locale => <button key={locale} type="button" className={preview?.locale === locale ? "active" : ""} aria-pressed={preview?.locale === locale} disabled={previewing} onClick={() => void openPreview(locale)}>
            {locale === "zhHant" ? text.zhPage : text.enPage}
          </button>)}
        </span>}
        <button type="button" className="admin-button secondary" data-academy-preview-close onClick={() => setPreview(null)}>{text.closePreview}</button>
      </div>
      {preview && <iframe key={`${preview.locale}-${preview.html.length}`} title={text.previewTitle} srcDoc={preview.html} sandbox="allow-same-origin allow-scripts" onLoad={event => scrollPreview(event.currentTarget)} />}
    </dialog>
    <dialog ref={reloadDialog} className="admin-confirm" onCancel={event => { event.preventDefault(); setReloadConfirm(false); }} aria-labelledby="academy-reload-title" aria-describedby="academy-reload-description">
      <div className="admin-confirm-card">
        <h2 id="academy-reload-title">{text.reloadTitle}</h2><p id="academy-reload-description">{text.reloadBody}</p>
        <div className="admin-actions">
          <button type="button" className="admin-button secondary" autoFocus onClick={() => setReloadConfirm(false)}>{text.keep}</button>
          <button type="button" className="admin-button danger" data-academy-editor-reload-confirm onClick={() => { setReloadConfirm(false); void loadLatest(); }}>{text.discard}</button>
        </div>
      </div>
    </dialog>
    <dialog ref={closeDialog} className="admin-confirm" onCancel={event => { event.preventDefault(); setCloseConfirm(false); }} aria-labelledby="academy-close-title" aria-describedby="academy-close-description">
      <div className="admin-confirm-card">
        <h2 id="academy-close-title">{text.closeTitle}</h2>
        <p id="academy-close-description">{text.closeBody}</p>
        <div className="admin-actions">
          <button type="button" className="admin-button secondary" data-academy-editor-keep onClick={() => setCloseConfirm(false)}>{text.keep}</button>
          <button type="button" className="admin-button danger" data-academy-editor-discard disabled={busy} onClick={() => {
            if (busy || requestActive.current || accessRequestActive.current) return;
            setCloseConfirm(false);
            if (published) setDraft(toAcademyDraft(published.config));
            setPendingClose(true);
          }}>{text.closeDiscard}</button>
        </div>
      </div>
    </dialog>
  </section>;
}
