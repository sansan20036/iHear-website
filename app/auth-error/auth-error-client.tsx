"use client";

import { useEffect, useState } from "react";

import styles from "./auth-error.module.css";

type Language = "en" | "zhHant" | "zhHans";
type ErrorKind = "configuration" | "accessDenied" | "verification" | "generic";

type ErrorCopy = {
  eyebrow: string;
  title: string;
  description: string;
  home: string;
  contact: string;
  reference: string;
  documentTitle: string;
};

const htmlLanguage: Record<Language, string> = {
  en: "en",
  zhHant: "zh-Hant",
  zhHans: "zh-Hans",
};

const storedLanguage: Record<string, Language> = {
  en: "en",
  zhTW: "zhHant",
  zhCN: "zhHans",
  zhHant: "zhHant",
  zhHans: "zhHans",
};

const copy: Record<Language, Record<ErrorKind, ErrorCopy>> = {
  en: {
    configuration: {
      eyebrow: "Sign-in incomplete",
      title: "Please start sign-in again",
      description: "The sign-in link may have expired, or the sign-in service may be temporarily unavailable. Return home and start a new sign-in. If this keeps happening, contact us.",
      home: "Return home and sign in again",
      contact: "Contact us",
      reference: "Reference",
      documentTitle: "Sign-in incomplete | iHear Initiative",
    },
    accessDenied: {
      eyebrow: "Access denied",
      title: "This account cannot sign in",
      description: "This Google account is not authorized to use the iHear administrator tools. Return home and try an approved account, or contact us if access should be available.",
      home: "Return home",
      contact: "Contact us",
      reference: "Reference",
      documentTitle: "Access denied | iHear Initiative",
    },
    verification: {
      eyebrow: "Verification link unavailable",
      title: "Please request a new link",
      description: "This verification link has expired or has already been used. Return home and begin the sign-in process again.",
      home: "Return home and try again",
      contact: "Contact us",
      reference: "Reference",
      documentTitle: "Verification link unavailable | iHear Initiative",
    },
    generic: {
      eyebrow: "Sign-in problem",
      title: "We could not complete sign-in",
      description: "Return home and try signing in again. If the problem continues, contact us and include the reference shown below.",
      home: "Return home and try again",
      contact: "Contact us",
      reference: "Reference",
      documentTitle: "Sign-in problem | iHear Initiative",
    },
  },
  zhHant: {
    configuration: {
      eyebrow: "登入尚未完成",
      title: "請重新開始登入",
      description: "登入連結可能已失效，或登入服務暫時無法使用。請回到首頁重新登入；若持續發生，請聯絡我們。",
      home: "回首頁重新登入",
      contact: "聯絡我們",
      reference: "參考代碼",
      documentTitle: "登入尚未完成 | iHear Initiative",
    },
    accessDenied: {
      eyebrow: "無法存取",
      title: "此帳號無法登入",
      description: "此 Google 帳號未獲授權使用 iHear 管理工具。請回首頁改用已核准的帳號；若您應有權限，請聯絡我們。",
      home: "回到首頁",
      contact: "聯絡我們",
      reference: "參考代碼",
      documentTitle: "無法存取 | iHear Initiative",
    },
    verification: {
      eyebrow: "驗證連結無法使用",
      title: "請取得新的驗證連結",
      description: "此驗證連結已過期或已經使用。請回到首頁並重新開始登入。",
      home: "回首頁再試一次",
      contact: "聯絡我們",
      reference: "參考代碼",
      documentTitle: "驗證連結無法使用 | iHear Initiative",
    },
    generic: {
      eyebrow: "登入發生問題",
      title: "目前無法完成登入",
      description: "請回首頁重新登入。若問題持續發生，聯絡我們時請附上下方參考代碼。",
      home: "回首頁再試一次",
      contact: "聯絡我們",
      reference: "參考代碼",
      documentTitle: "登入發生問題 | iHear Initiative",
    },
  },
  zhHans: {
    configuration: {
      eyebrow: "登录尚未完成",
      title: "请重新开始登录",
      description: "登录链接可能已失效，或登录服务暂时无法使用。请返回首页重新登录；如果持续发生，请联系我们。",
      home: "返回首页重新登录",
      contact: "联系我们",
      reference: "参考代码",
      documentTitle: "登录尚未完成 | iHear Initiative",
    },
    accessDenied: {
      eyebrow: "无法访问",
      title: "此账号无法登录",
      description: "此 Google 账号未获授权使用 iHear 管理工具。请返回首页改用已批准的账号；如果您应该有权限，请联系我们。",
      home: "返回首页",
      contact: "联系我们",
      reference: "参考代码",
      documentTitle: "无法访问 | iHear Initiative",
    },
    verification: {
      eyebrow: "验证链接无法使用",
      title: "请获取新的验证链接",
      description: "此验证链接已过期或已被使用。请返回首页并重新开始登录。",
      home: "返回首页重试",
      contact: "联系我们",
      reference: "参考代码",
      documentTitle: "验证链接无法使用 | iHear Initiative",
    },
    generic: {
      eyebrow: "登录出现问题",
      title: "目前无法完成登录",
      description: "请返回首页重新登录。如果问题持续发生，联系我们时请附上下方参考代码。",
      home: "返回首页重试",
      contact: "联系我们",
      reference: "参考代码",
      documentTitle: "登录出现问题 | iHear Initiative",
    },
  },
};

function errorKind(error: string): ErrorKind {
  if (error === "AccessDenied") return "accessDenied";
  if (error === "Verification") return "verification";
  if (error === "Configuration") return "configuration";
  return "generic";
}

function clientLanguage(fallback: Language): Language {
  try {
    const saved = localStorage.getItem("ihear-lang") || "";
    if (storedLanguage[saved]) return storedLanguage[saved];
  } catch {
    // Storage may be unavailable in privacy modes.
  }

  const browserLanguage = navigator.language.toLowerCase();
  if (!browserLanguage) return fallback;
  if (!browserLanguage.startsWith("zh")) return "en";
  return /tw|hk|mo|hant/.test(browserLanguage) ? "zhHant" : "zhHans";
}

function persistLanguage(language: Language) {
  const storageValue = language === "zhHant" ? "zhTW" : language === "zhHans" ? "zhCN" : "en";
  try {
    localStorage.setItem("ihear-lang", storageValue);
  } catch {
    // The page remains fully usable without persistent storage.
  }
  const secure = location.protocol === "https:" ? "; Secure" : "";
  document.cookie = `ihear-lang=${storageValue}; Path=/; Max-Age=31536000; SameSite=Lax${secure}`;
}

export default function AuthErrorClient({ error, initialLanguage }: { error: string; initialLanguage: Language }) {
  const [language, setLanguage] = useState<Language>(initialLanguage);
  const kind = errorKind(error);
  const contentKind = kind === "accessDenied" ? "access_denied" : kind;
  const activeCopy = copy[language][kind];
  const safeReference = kind === "generic" ? "SignInError" : error;

  useEffect(() => {
    const preferred = clientLanguage(initialLanguage);
    if (preferred !== initialLanguage) setLanguage(preferred);
    persistLanguage(preferred);
  }, [initialLanguage]);

  useEffect(() => {
    document.documentElement.lang = htmlLanguage[language];
    document.title = activeCopy.documentTitle;
    window.dispatchEvent(new CustomEvent("ihear:language", { detail: { locale: language } }));
  }, [activeCopy.documentTitle, language]);

  function selectLanguage(nextLanguage: Language) {
    const before = new CustomEvent("ihear:before-language", {
      cancelable: true,
      detail: { from: language, to: nextLanguage, locale: nextLanguage },
    });
    if (!window.dispatchEvent(before)) return;
    setLanguage(nextLanguage);
    persistLanguage(nextLanguage);
  }

  return (
    <main className={styles.main} lang={htmlLanguage[language]}>
      <section className={styles.card} aria-labelledby="auth-error-title">
        <img className={styles.logo} src="/assets/logo.png" alt="iHear Initiative" width={154} height={58} />

        <div className={styles.languageSwitch} role="group" aria-label="Language / 語言 / 语言">
          <button type="button" lang="en" aria-pressed={language === "en"} onClick={() => selectLanguage("en")}>EN</button>
          <button type="button" lang="zh-Hant" aria-pressed={language === "zhHant"} onClick={() => selectLanguage("zhHant")}>繁</button>
          <button type="button" lang="zh-Hans" aria-pressed={language === "zhHans"} onClick={() => selectLanguage("zhHans")}>简</button>
        </div>

        <p className={styles.eyebrow} data-editable-content={`errors.auth.${contentKind}.eyebrow`} data-editable-page="/auth-error" data-editable-mode="singleline" data-editable-maxlength="200">{activeCopy.eyebrow}</p>
        <h1 id="auth-error-title" data-editable-content={`errors.auth.${contentKind}.title`} data-editable-page="/auth-error" data-editable-mode="singleline" data-editable-maxlength="200">{activeCopy.title}</h1>
        <p className={styles.description} data-editable-content={`errors.auth.${contentKind}.description`} data-editable-page="/auth-error" data-editable-mode="multiline" data-editable-maxlength="5000">{activeCopy.description}</p>

        <div className={styles.actions}>
          <a className={styles.primaryAction} href="/" data-editable-content={`errors.auth.${contentKind}.home`} data-editable-page="/auth-error" data-editable-mode="singleline" data-editable-maxlength="200">{activeCopy.home}</a>
          <a className={styles.secondaryAction} href="/contact" data-editable-content={`errors.auth.${contentKind}.contact`} data-editable-page="/auth-error" data-editable-mode="singleline" data-editable-maxlength="200">{activeCopy.contact}</a>
        </div>

        <p className={styles.reference}><span data-editable-content={`errors.auth.${contentKind}.reference`} data-editable-page="/auth-error" data-editable-mode="singleline" data-editable-maxlength="200">{activeCopy.reference}</span>: <code>{safeReference}</code></p>
      </section>
    </main>
  );
}
