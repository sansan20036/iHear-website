(function () {
  "use strict";

  const labelsByLocale = {
    en: {
      signIn: "Sign in", signInFull: "Sign in as an administrator with Google", signOut: "Sign out",
      signedIn: "Administrator signed in", loading: "Checking access…", unavailable: "Could not check sign-in status.",
      retry: "Retry", account: "Administrator account", dashboard: "Admin dashboard", dashboardHint: "Manage website content, Team, and Impact", failedOut: "Sign out failed. You are still signed in.",
      failedIn: "Sign in could not start. Please try again.",
    },
    zhHant: {
      signIn: "登入", signInFull: "使用 Google 登入管理員帳號", signOut: "登出",
      signedIn: "管理員已登入", loading: "正在確認權限…", unavailable: "暫時無法確認登入狀態。",
      retry: "重試", account: "管理員帳號", dashboard: "管理後台", dashboardHint: "管理網站內容、團隊與成果資料", failedOut: "登出失敗，您目前仍保持登入。",
      failedIn: "無法開始登入，請再試一次。",
    },
    zhHans: {
      signIn: "登录", signInFull: "使用 Google 登录管理员账号", signOut: "登出",
      signedIn: "管理员已登录", loading: "正在确认权限…", unavailable: "暂时无法确认登录状态。",
      retry: "重试", account: "管理员账号", dashboard: "管理后台", dashboardHint: "管理网站内容、团队与成果数据", failedOut: "登出失败，您目前仍保持登录。",
      failedIn: "无法开始登录，请重试。",
    },
  };

  let currentSession = null;
  let loadFailed = false;
  let busy = false;

  function locale() {
    const language = (document.documentElement.lang || "en").toLowerCase();
    if (language.includes("hans")) return "zhHans";
    if (language.startsWith("zh")) return "zhHant";
    return "en";
  }

  function labels() {
    return labelsByLocale[locale()] || labelsByLocale.en;
  }

  function escapeHtml(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function initials(name, email) {
    return String(name || email || "?").trim().slice(0, 1).toUpperCase();
  }

  function authUrl(path) {
    return `/api/auth/${path}`;
  }

  async function responseJson(response) {
    const data = await response.json().catch(() => null);
    if (!response.ok) throw new Error(data?.error || `HTTP ${response.status}`);
    return data;
  }

  async function getCsrfToken() {
    const response = await fetch(authUrl("csrf"), { credentials: "same-origin", cache: "no-store" });
    const data = await responseJson(response);
    if (!data?.csrfToken) throw new Error("Missing CSRF token");
    return data.csrfToken;
  }

  async function clearStaleAuthCookies() {
    await fetch(authUrl("clear-stale"), { method: "POST", credentials: "same-origin", cache: "no-store" }).catch(() => null);
  }

  function createMounts() {
    const navInner = document.querySelector(".nav-inner");
    const navLinks = document.getElementById("navLinks");
    const cta = navInner?.querySelector(":scope > .btn-cta");
    let desktop = document.querySelector("[data-auth-desktop]");
    let mobile = document.querySelector("[data-auth-mobile]");

    if (navInner && !desktop) {
      desktop = document.createElement("div");
      desktop.className = "auth-widget";
      desktop.setAttribute("data-auth-desktop", "");
      desktop.setAttribute("aria-live", "polite");
      if (cta) navInner.insertBefore(desktop, cta);
      else navInner.appendChild(desktop);
    }
    if (navLinks && !mobile) {
      mobile = document.createElement("li");
      mobile.className = "auth-mobile-item";
      mobile.setAttribute("data-auth-mobile", "");
      navLinks.appendChild(mobile);
    }
    return { desktop, mobile };
  }

  function avatarHtml(user) {
    if (user.image) return `<img class="auth-avatar" src="${escapeHtml(user.image)}" alt="" referrerpolicy="no-referrer">`;
    return `<span class="auth-fallback" aria-hidden="true">${escapeHtml(initials(user.name, user.email))}</span>`;
  }

  function loadingHtml() {
    return `<span class="auth-loading" aria-busy="true">${escapeHtml(labels().loading)}</span>`;
  }

  function errorHtml() {
    const copy = labels();
    return `<div class="auth-error"><span>${escapeHtml(copy.unavailable)}</span><button class="auth-retry" type="button" data-auth-retry>${escapeHtml(copy.retry)}</button></div>`;
  }

  function loggedOutHtml() {
    const copy = labels();
    return `<button class="auth-google" type="button" data-auth-signin aria-label="${escapeHtml(copy.signInFull)}"><span class="auth-gmark" aria-hidden="true">G</span><span>${escapeHtml(copy.signIn)}</span></button>`;
  }

  function loggedInHtml(session, mode) {
    const copy = labels();
    const user = session.user || {};
    const name = escapeHtml(user.name || user.email || copy.signedIn);
    const email = escapeHtml(user.email || "");
    const avatar = avatarHtml(user);
    const dashboard = `<a class="auth-admin-link" href="/admin"${mode === "desktop" ? ' role="menuitem"' : ""}><span>${escapeHtml(copy.dashboard)}</span><small>${escapeHtml(copy.dashboardHint)}</small></a>`;
    if (mode === "mobile") {
      return `<div class="auth-mobile-panel"><div class="auth-mobile-identity" title="${email}">${avatar}<span class="auth-name">${name}</span></div>${dashboard}<button class="auth-signout" type="button" data-auth-signout>${escapeHtml(copy.signOut)}</button></div>`;
    }
    return `<div class="auth-menu"><button class="auth-profile" type="button" title="${email}" aria-haspopup="menu" aria-expanded="false" aria-controls="authPopover">${avatar}<span class="auth-name">${name}</span></button><div class="auth-popover" id="authPopover" role="menu" hidden><strong>${name}</strong><span class="auth-email">${email}</span>${dashboard}<div class="auth-menu-separator" aria-hidden="true"></div><button class="auth-signout" role="menuitem" type="button" data-auth-signout>${escapeHtml(copy.signOut)}</button></div></div>`;
  }

  function bindPopover() {
    const menu = document.querySelector(".auth-menu");
    const trigger = menu?.querySelector(".auth-profile");
    const popover = menu?.querySelector(".auth-popover");
    if (!menu || !trigger || !popover) return;
    function close(options) {
      popover.hidden = true;
      trigger.setAttribute("aria-expanded", "false");
      if (options?.restoreFocus) trigger.focus();
    }
    function open() {
      popover.hidden = false;
      trigger.setAttribute("aria-expanded", "true");
      popover.querySelector("a,button")?.focus();
    }
    trigger.addEventListener("click", () => popover.hidden ? open() : close());
    document.addEventListener("pointerdown", (event) => { if (!menu.contains(event.target)) close(); });
    menu.addEventListener("keydown", (event) => { if (event.key === "Escape") { event.preventDefault(); close({ restoreFocus: true }); } });
  }

  function render(options) {
    const mounts = createMounts();
    const settings = options || {};
    const htmlFor = (mode) => {
      if (settings.loading) return loadingHtml();
      if (loadFailed) return errorHtml();
      return currentSession?.user ? loggedInHtml(currentSession, mode) : loggedOutHtml();
    };
    if (mounts.desktop) mounts.desktop.innerHTML = htmlFor("desktop");
    if (mounts.mobile) mounts.mobile.innerHTML = htmlFor("mobile");
    document.querySelectorAll("[data-auth-signout]").forEach((button) => button.addEventListener("click", signOut));
    document.querySelectorAll("[data-auth-signin]").forEach((button) => button.addEventListener("click", signIn));
    document.querySelectorAll("[data-auth-retry]").forEach((button) => button.addEventListener("click", refresh));
    bindPopover();
    window.dispatchEvent(new CustomEvent("ihear:auth", { detail: { session: currentSession, error: loadFailed } }));
  }

  async function fetchSession() {
    const response = await fetch("/api/auth/session", { credentials: "same-origin", cache: "no-store" });
    const session = await responseJson(response);
    return session?.user ? session : null;
  }

  async function refresh() {
    if (busy) return;
    busy = true;
    loadFailed = false;
    render({ loading: true });
    try {
      currentSession = await fetchSession();
    } catch {
      loadFailed = true;
    } finally {
      busy = false;
      render();
    }
  }

  async function signOut(event) {
    event.preventDefault();
    if (busy) return;
    busy = true;
    const previousSession = currentSession;
    event.currentTarget.disabled = true;
    try {
      await clearStaleAuthCookies();
      const csrfToken = await getCsrfToken();
      const response = await fetch(authUrl("signout"), {
        method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Auth-Return-Redirect": "1" },
        body: new URLSearchParams({ csrfToken, callbackUrl: window.location.href }),
      });
      const data = await responseJson(response);
      currentSession = null;
      render();
      const redirectUrl = data?.url || window.location.href;
      if (redirectUrl === window.location.href) window.location.reload();
      else window.location.href = redirectUrl;
    } catch {
      currentSession = previousSession;
      render();
      window.iHearToast?.(labels().failedOut, { error: true });
    } finally {
      busy = false;
    }
  }

  async function signIn(event) {
    event.preventDefault();
    if (busy) return;
    busy = true;
    event.currentTarget.disabled = true;
    try {
      await clearStaleAuthCookies();
      const csrfToken = await getCsrfToken();
      const response = await fetch(authUrl("signin/google"), {
        method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Auth-Return-Redirect": "1" },
        body: new URLSearchParams({ csrfToken, callbackUrl: window.location.href }),
      });
      const data = await responseJson(response);
      window.location.replace(data?.url || authUrl("signin"));
    } catch {
      busy = false;
      render();
      window.iHearToast?.(labels().failedIn, { error: true });
    }
  }

  window.iHearAuth = {
    getSession: () => currentSession,
    isSignedIn: () => Boolean(currentSession?.user),
    refresh,
  };

  function boot() {
    createMounts();
    render({ loading: true });
    refresh();
    window.addEventListener("ihear:language", () => render({ loading: busy && !loadFailed }));
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot, { once: true });
  else boot();
})();
