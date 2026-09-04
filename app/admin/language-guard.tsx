"use client";

import { useEffect, useState } from "react";

import { inspectChineseField, inspectEnglishSource } from "../../assets/text-language-guard";
import { adminFetch, displayError } from "./admin-api";
import type { AdminLocale } from "./admin-context";

type Language = "en" | "zhHant" | "zhHans";

const messages = {
  en: {
    english: "⚠️ Chinese content was detected. English is the source for automatic translation; enter English here for the most accurate result.",
    accept: "Translate this content anyway",
    missing: "⚠️ This Chinese field contains no Chinese characters. Check whether English was pasted here by mistake.",
    simplified: "Simplified Chinese may be present in the Traditional Chinese field.",
    convert: "Convert to Taiwan Traditional Chinese",
    preview: "Conversion preview",
    apply: "Apply conversion",
    cancel: "Cancel",
  },
  zhHant: {
    english: "⚠️ 偵測到中文內容：系統以英文為自動翻譯來源，建議在此輸入英文以確保翻譯準確。",
    accept: "仍以此內容翻譯",
    missing: "⚠️ 此欄位未包含中文字元，請確認是否誤貼英文。",
    simplified: "偵測到繁中欄位可能含有簡體字或中國大陸用語。",
    convert: "一鍵轉為台灣繁中",
    preview: "轉換預覽",
    apply: "套用轉換",
    cancel: "取消",
  },
  zhHans: {
    english: "⚠️ 检测到中文内容：系统以英文为自动翻译来源，建议在此输入英文以确保翻译准确。",
    accept: "仍以此内容翻译",
    missing: "⚠️ 此字段未包含中文字符，请确认是否误贴英文。",
    simplified: "检测到繁体中文字段可能含有简体字或中国大陆用语。",
    convert: "一键转为台湾繁体中文",
    preview: "转换预览",
    apply: "应用转换",
    cancel: "取消",
  },
};

export function LanguageGuardNotice({ locale, language, value, disabled = false, englishAccepted = false, onAcceptEnglish, onChange }: {
  locale: AdminLocale;
  language: Language;
  value: string;
  disabled?: boolean;
  englishAccepted?: boolean;
  onAcceptEnglish?: () => void;
  onChange?: (value: string) => void;
}) {
  const text = messages[locale];
  const englishWarning = language === "en" && inspectEnglishSource(value).warning && !englishAccepted;
  const chinese = language === "en" ? null : inspectChineseField(value);
  const [proposal, setProposal] = useState("");
  const [error, setError] = useState("");
  const [converting, setConverting] = useState(false);

  useEffect(() => { setProposal(""); setError(""); }, [value, language]);

  async function previewConversion() {
    if (disabled || converting) return;
    setConverting(true); setError("");
    try {
      const result = await adminFetch<{ value: string }>("/api/admin/translations/traditionalize", { method: "POST", body: JSON.stringify({ value }) });
      setProposal(result.value);
    } catch (reason) { setError(displayError(reason, locale)); }
    finally { setConverting(false); }
  }

  if (!englishWarning && !chinese?.missingHan && !(language === "zhHant" && chinese?.likelySimplified) && !proposal && !error) return null;
  return <div className="admin-language-warning" role="status" aria-live="polite">
    {englishWarning && <><p>{text.english}</p><button type="button" disabled={disabled} onClick={onAcceptEnglish}>{text.accept}</button></>}
    {chinese?.missingHan && <p>{text.missing}</p>}
    {language === "zhHant" && chinese?.likelySimplified && !proposal && <><p>{text.simplified}</p><button type="button" disabled={disabled || converting} onClick={previewConversion}>{converting ? "…" : text.convert}</button></>}
    {proposal && proposal !== value && <div className="admin-language-conversion"><strong>{text.preview}</strong><del>{value}</del><ins>{proposal}</ins><div><button type="button" disabled={disabled} onClick={() => { onChange?.(proposal); setProposal(""); }}>{text.apply}</button><button type="button" disabled={disabled} onClick={() => setProposal("")}>{text.cancel}</button></div></div>}
    {error && <p role="alert">{error}</p>}
  </div>;
}
