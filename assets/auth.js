(function () {
  const labelsByLang = {
    en: {
      signIn: "Sign in",
      signInFull: "Sign in with Google",
      signOut: "Sign out",
      signedIn: "Signed in",
      loading: "Checking...",
      unavailable: "Sign in unavailable",
    },
    "zh-Hant": {
      signIn: "登入",
      signInFull: "使用 Google 登入",
      signOut: "登出",
      signedIn: "已登入",
      loading: "確認中...",
      unavailable: "暫時無法登入",
    },
    "zh-Hans": {
      signIn: "登录",
      signInFull: "使用 Google 登录",
      signOut: "登出",
      signedIn: "已登录",
      loading: "确认中...",
      unavailable: "暂时无法登录",
    },
  };

  let currentSession = null;

  function getLabels() {
    const lang = document.documentElement.lang || "en";
    if (lang.toLowerCase().includes("hans")) return labelsByLang["zh-Hans"];
    if (lang.toLowerCase().startsWith("zh")) return labelsByLang["zh-Hant"];
    return labelsByLang.en;
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
    const source = (name || email || "?").trim();
    return source.slice(0, 1).toUpperCase();
  }

  function authUrl(path) {
    return `/api/auth/${path}`;
  }

  async function getCsrfToken() {
    const response = await fetch(authUrl("csrf"), {
      credentials: "same-origin",
      cache: "no-store",
    });
    const csrf = await response.json();
    return csrf.csrfToken;
  }

  async function clearStaleAuthCookies() {
    await fetch(authUrl("clear-stale"), {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
    }).catch(() => null);
  }

  function installStyles() {
    if (document.getElementById("ihear-auth-styles")) return;

    const style = document.createElement("style");
    style.id = "ihear-auth-styles";
    style.textContent = `
      .auth-widget{ position:relative; flex:none; display:flex; align-items:center; z-index:130; }
      .auth-google,.auth-profile,.auth-signout{
        font-family:var(--font-b); font-weight:800; border-radius:999px; border:2px solid var(--navy);
        background:#fff; color:var(--navy); cursor:pointer; text-decoration:none;
        transition:transform var(--speed-1), box-shadow var(--speed-1), background var(--speed-1);
      }
      .auth-google{ min-height:44px; display:inline-flex; align-items:center; gap:8px; padding:9px 14px; font-size:.88rem; box-shadow:var(--shadow); }
      .auth-google:hover,.auth-profile:hover,.auth-signout:hover{ transform:translateY(-1px); box-shadow:var(--shadow-lg); }
      .auth-google:disabled,.auth-signout:disabled{ opacity:.64; cursor:wait; transform:none; box-shadow:var(--shadow); }
      .auth-gmark{
        width:22px; height:22px; border-radius:50%; display:grid; place-items:center; flex:none;
        color:#fff; background:linear-gradient(135deg,#4285f4,#34a853 45%,#fbbc05 72%,#ea4335);
        font-family:Arial,sans-serif; font-size:.78rem; font-weight:800;
      }
      .auth-profile{ min-height:44px; display:inline-flex; align-items:center; gap:8px; padding:5px 11px 5px 5px; max-width:180px; }
      .auth-avatar,.auth-fallback{
        width:32px; height:32px; border-radius:50%; flex:none; border:1px solid rgba(38,57,116,.16);
      }
      .auth-avatar{ object-fit:cover; background:#fff; }
      .auth-fallback{ display:grid; place-items:center; background:var(--navy); color:#fff; font-size:.9rem; }
      .auth-name{ overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:112px; }
      .auth-menu{ position:relative; }
      .auth-popover{
        position:absolute; top:calc(100% + 10px); right:0; width:min(260px, calc(100vw - 32px));
        display:none; background:#fff; border:1.5px solid var(--line); border-radius:16px;
        padding:14px; box-shadow:var(--shadow-lg); color:var(--ink); z-index:200;
      }
      .auth-menu:hover .auth-popover,.auth-menu:focus-within .auth-popover,.auth-menu[data-open="true"] .auth-popover{ display:block; }
      .auth-popover strong{ display:block; color:var(--navy); font-family:var(--font-h); font-size:1rem; line-height:1.2; }
      .auth-email{ display:block; color:var(--ink-soft); font-size:.86rem; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; margin:3px 0 12px; }
      .auth-signout{ min-height:38px; padding:8px 13px; width:100%; }
      .auth-mobile-item{ display:none; }
      .auth-mobile-panel{ display:grid; gap:10px; padding:8px 4px; }
      .auth-mobile-panel .auth-google,.auth-mobile-panel .auth-profile,.auth-mobile-panel .auth-signout{ width:100%; justify-content:center; }
      .auth-mobile-panel .auth-profile{ max-width:none; }
      .auth-mobile-panel .auth-name{ max-width:190px; }
      @media (max-width:1024px){
        .auth-widget{ display:none; }
        .auth-mobile-item{ display:block; }
      }
    `;
    document.head.appendChild(style);
  }

  function createMounts() {
    const navInner = document.querySelector(".nav-inner");
    const navLinks = document.getElementById("navLinks");
    const cta = navInner ? navInner.querySelector(".btn-cta") : null;
    let desktop = document.querySelector("[data-auth-desktop]");
    let mobile = document.querySelector("[data-auth-mobile]");

    if (navInner && !desktop) {
      desktop = document.createElement("div");
      desktop.className = "auth-widget";
      desktop.setAttribute("data-auth-desktop", "");
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

  function loggedOutHtml(mode) {
    const labels = getLabels();
    const text = mode === "mobile" ? labels.signInFull : labels.signIn;
    return `
      <button class="auth-google" type="button" data-auth-signin aria-label="${labels.signInFull}">
        <span class="auth-gmark" aria-hidden="true">G</span>
        <span>${text}</span>
      </button>
    `;
  }

  function loggedInHtml(session, mode) {
    const labels = getLabels();
    const user = session.user || {};
    const name = escapeHtml(user.name || user.email || labels.signedIn);
    const email = escapeHtml(user.email || "");
    const image = user.image ? escapeHtml(user.image) : "";
    const avatar = image
      ? `<img class="auth-avatar" src="${image}" alt="" referrerpolicy="no-referrer">`
      : `<span class="auth-fallback" aria-hidden="true">${escapeHtml(initials(user.name, user.email))}</span>`;

    if (mode === "mobile") {
      return `
        <div class="auth-mobile-panel">
          <button class="auth-profile" type="button" title="${email}">
            ${avatar}
            <span class="auth-name">${name}</span>
          </button>
          <button class="auth-signout" type="button" data-auth-signout>${labels.signOut}</button>
        </div>
      `;
    }

    return `
      <div class="auth-menu">
        <button class="auth-profile" type="button" title="${email}" aria-haspopup="true">
          ${avatar}
          <span class="auth-name">${name}</span>
        </button>
        <div class="auth-popover" role="menu">
          <strong>${name}</strong>
          <span class="auth-email">${email}</span>
          <button class="auth-signout" type="button" data-auth-signout>${labels.signOut}</button>
        </div>
      </div>
    `;
  }

  function render(session) {
    const mounts = createMounts();
    const html = session && session.user;

    if (mounts.desktop) {
      mounts.desktop.innerHTML = html ? loggedInHtml(session, "desktop") : loggedOutHtml("desktop");
    }

    if (mounts.mobile) {
      mounts.mobile.innerHTML = html ? loggedInHtml(session, "mobile") : loggedOutHtml("mobile");
    }

    document.querySelectorAll("[data-auth-signout]").forEach((button) => {
      button.addEventListener("click", signOut);
    });

    document.querySelectorAll("[data-auth-signin]").forEach((button) => {
      button.addEventListener("click", signIn);
    });

    window.dispatchEvent(new CustomEvent("ihear:auth", { detail: { session: currentSession } }));
  }

  async function fetchSession() {
    const response = await fetch("/api/auth/session", {
      credentials: "same-origin",
      cache: "no-store",
    });

    if (!response.ok) return null;
    const session = await response.json();
    return session && session.user ? session : null;
  }

  async function signOut(event) {
    event.preventDefault();

    const button = event.currentTarget;
    button.disabled = true;

    try {
      await clearStaleAuthCookies();
      const csrfToken = await getCsrfToken();
      const body = new URLSearchParams({
        csrfToken,
        callbackUrl: window.location.href,
      });

      const response = await fetch(authUrl("signout"), {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "X-Auth-Return-Redirect": "1",
        },
        body,
      });
      const data = await response.json().catch(() => null);
      const redirectUrl = data?.url || window.location.href;

      currentSession = null;
      render(null);

      if (redirectUrl === window.location.href) {
        window.location.reload();
      } else {
        window.location.href = redirectUrl;
      }
    } catch {
      button.disabled = false;
      currentSession = null;
      render(null);
    }
  }

  async function signIn(event) {
    event.preventDefault();

    const button = event.currentTarget;
    button.disabled = true;

    try {
      await clearStaleAuthCookies();
      const csrfToken = await getCsrfToken();
      const body = new URLSearchParams({
        csrfToken,
        callbackUrl: window.location.href,
      });
      const response = await fetch(authUrl("signin/google"), {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "X-Auth-Return-Redirect": "1",
        },
        body,
      });
      const data = await response.json().catch(() => null);
      window.location.href = data?.url || authUrl("signin");
    } catch {
      button.disabled = false;
      window.location.href = authUrl("signin");
    }
  }

  async function boot() {
    installStyles();
    createMounts();

    try {
      currentSession = await fetchSession();
    } catch {
      currentSession = null;
    }

    render(currentSession);
  }

  window.iHearAuth = {
    getSession: function () {
      return currentSession;
    },
    isSignedIn: function () {
      return Boolean(currentSession && currentSession.user);
    },
    refresh: boot,
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
