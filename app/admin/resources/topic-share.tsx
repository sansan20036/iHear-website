"use client";

import { useState } from "react";

const copy = {
  en: { button: "Copy topic URL", url: "Topic URL", copied: "URL copied.", manual: "Select and copy this URL manually.", unavailable: "Visitors cannot currently view this topic. Publish the topic and at least one resource before sharing.", pending: "Copying…" },
  zhHant: { button: "複製主題網址", url: "主題網址", copied: "已複製網址。", manual: "請選取下方網址並手動複製。", unavailable: "訪客目前無法查看此主題。請先發布主題及至少一筆項目，再分享網址。", pending: "複製中…" },
  zhHans: { button: "复制主题网址", url: "主题网址", copied: "已复制网址。", manual: "请选取下方网址并手动复制。", unavailable: "访客当前无法查看此主题。请先发布主题及至少一条项目，再分享网址。", pending: "复制中…" },
};

export function TopicShare({ slug, locale, available }: { slug: string; locale: keyof typeof copy; available: boolean }) {
  const text = copy[locale];
  const [url, setUrl] = useState("");
  const [result, setResult] = useState<"copied" | "manual" | "pending">("manual");
  async function share() {
    const value = `${window.location.origin}/resources#${slug}`;
    setUrl(value); setResult("pending");
    try { await navigator.clipboard.writeText(value); setResult("copied"); }
    catch { setResult("manual"); }
  }
  return <div className="admin-topic-share">
    {!available && <p>{text.unavailable}</p>}
    <button type="button" className="admin-button secondary" disabled={result === "pending"} onClick={() => void share()}>{text.button}</button>
    {url && <div>
      <p role="status">{text[result]}</p>
      <label className="admin-field">{text.url}<input type="text" readOnly value={url} onFocus={event => event.currentTarget.select()} onClick={event => event.currentTarget.select()} /></label>
    </div>}
  </div>;
}
