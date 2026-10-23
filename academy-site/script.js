// Prices, tutor names and every price sentence come from the published Academy
// content in one server-rendered snapshot (#academy-pricing-data). NT$ and US$
// prices are set separately by the Academy team and never converted here.
(() => {
  "use strict";

  let data = null;
  try { data = JSON.parse(document.getElementById("academy-pricing-data")?.textContent || "null"); } catch { data = null; }

  function selected(name) {
    return document.querySelector(`input[name="${name}"]:checked`)?.value;
  }

  function updatePrice() {
    if (!data) return;
    const currency = selected("currency"), duration = selected("duration");
    const view = data.views[`${currency}|${duration}|${selected("tutor")}|${selected("plan")}`];
    const options = data.options[`${currency}|${duration}`];
    if (!view || !options) return;
    const symbol = document.createElement("span");
    symbol.className = "price-currency";
    symbol.textContent = view.symbol;
    document.getElementById("price")?.replaceChildren(symbol, view.amount);
    const unit = document.getElementById("price-unit");
    if (unit) unit.textContent = view.unit;
    const detail = document.getElementById("price-detail");
    if (detail) detail.textContent = view.detail;
    document.querySelectorAll("[data-tutor-price]").forEach(node => { node.textContent = options[node.dataset.tutorPrice] || ""; });
  }
  document.querySelectorAll('input[name="currency"], input[name="duration"], input[name="tutor"], input[name="plan"]').forEach(input => input.addEventListener("change", updatePrice));
  updatePrice();

  // Administrator editing. The server marks the page only for a signed-in
  // administrator, so visitors never request admin access or receive controls.
  // The mark and the access check below only show controls; the server checks
  // access again on every save.
  if (document.documentElement.hasAttribute("data-academy-preview") || !/^https?:$/.test(location.protocol)
    || document.body.dataset.academyAdmin !== "available") return;

  const locale = document.documentElement.lang === "zh-Hant" ? "zhHant" : "en";
  const text = locale === "zhHant" ? {
    edit: "編輯", editBlock: "編輯此區塊", editorTitle: "編輯 Academy 課程頁", close: "關閉編輯視窗", full: "在後台開啟",
    loading: "正在載入編輯視窗…", loadError: "暫時無法開啟編輯視窗。請重試，或在後台開啟。", retry: "重試",
    toolbar: "管理員模式：點選 ✎ 即可編輯該區塊。", admin: "開啟 Academy 後台", hide: "隱藏編輯按鈕", show: "顯示編輯按鈕",
    authError: "暫時無法確認管理員權限，請稍後重試。", checkAgain: "重新確認權限",
    signedOut: "登入已過期，請重新登入後再編輯。", forbidden: "此帳號目前沒有管理員權限，無法編輯課程頁。", signIn: "重新登入",
    accessLost: "目前無法確認你的管理員權限。草稿仍保留，請在編輯視窗中重新確認權限。",
    saving: "正在發布，請稍候。", saved: "內容已發布，正在更新頁面…",
  } : {
    edit: "Edit", editBlock: "Edit this section", editorTitle: "Edit the Academy course page", close: "Close editor", full: "Open in admin",
    loading: "Loading editor…", loadError: "The editor could not be opened. Try again or open it in admin.", retry: "Try again",
    toolbar: "Administrator mode: select ✎ to edit that section.", admin: "Open Academy admin", hide: "Hide edit buttons", show: "Show edit buttons",
    authError: "Administrator access could not be checked. Please try again.", checkAgain: "Check access again",
    signedOut: "Your sign-in has expired. Sign in again to edit.", forbidden: "This account does not have administrator access, so it cannot edit the course page.", signIn: "Sign in again",
    accessLost: "Your administrator access could not be confirmed. Your draft is kept; check access again inside the editor.",
    saving: "Publishing. Please wait.", saved: "Content published. Refreshing the page…",
  };
  const triggers = new Map();
  let principal = null;
  let accessRequest = null;
  let opening = false;
  let editor = null;
  let toolbar = null;
  let hidden = false;

  function element(tag, className, value) {
    const result = document.createElement(tag);
    if (className) result.className = className;
    if (value) result.textContent = value;
    return result;
  }

  function blockOf(node) {
    return node.closest("[data-academy-block]");
  }

  // The button sits after the block's own heading (inside a FAQ question), in
  // the normal text flow, so it never covers text or images. A block without a
  // heading (the ribbon, the footer) gets it at its end to keep its item order.
  function placeTrigger(block, button) {
    const own = [...block.querySelectorAll("[data-academy-field]")].filter(field => blockOf(field) === block);
    if (!own.length) return false;
    const heading = own.map(field => field.closest("h1, h2, h3, summary")).find(node => node && blockOf(node) === block);
    if (heading?.tagName === "SUMMARY") heading.append(button);
    else if (heading) heading.after(button);
    else block.append(button);
    return true;
  }

  function createTriggers() {
    document.querySelectorAll("[data-academy-block]").forEach(block => {
      const id = block.dataset.academyBlock;
      if (triggers.has(id)) return;
      const button = element("button", "academy-edit-trigger");
      button.type = "button";
      button.dataset.academyEditBlock = id;
      button.setAttribute("aria-label", text.editBlock);
      button.setAttribute("aria-haspopup", "dialog");
      button.title = text.editBlock;
      const icon = element("span", "academy-edit-icon", "✎");
      icon.setAttribute("aria-hidden", "true");
      button.append(icon, element("span", "academy-edit-label", text.edit));
      button.addEventListener("click", event => {
        // Inside a FAQ question the button must not also open or close the answer.
        event.preventDefault();
        event.stopPropagation();
        void openEditor(id, button);
      });
      if (placeTrigger(block, button)) triggers.set(id, button);
    });
  }

  function createToolbar() {
    if (toolbar) return;
    toolbar = element("div", "academy-admin-toolbar");
    toolbar.setAttribute("role", "region");
    toolbar.setAttribute("aria-label", text.admin);
    const note = element("p", "", text.toolbar);
    note.dataset.academyAdminNote = "";
    note.dataset.academyAdminDefault = "";
    const link = element("a", "", text.admin);
    link.href = `/admin/academy?locale=${locale}`;
    const toggle = element("button", "", text.hide);
    toggle.type = "button";
    toggle.dataset.academyAdminToggle = "";
    toggle.addEventListener("click", () => {
      hidden = !hidden;
      triggers.forEach(button => { button.hidden = hidden; });
      toggle.textContent = hidden ? text.show : text.hide;
      toggle.setAttribute("aria-pressed", String(hidden));
    });
    const signIn = element("a", "", text.signIn);
    // Auth.js accepts only a same-origin callback, which returns to this page.
    signIn.href = `/api/auth/signin?callbackUrl=${encodeURIComponent(location.pathname + location.search)}`;
    signIn.hidden = true;
    signIn.dataset.academyAdminSignin = "";
    const retry = element("button", "", text.checkAgain);
    retry.type = "button";
    retry.hidden = true;
    retry.dataset.academyAdminRetry = "";
    retry.addEventListener("click", () => { void checkAccess(); });
    toolbar.append(note, link, toggle, signIn, retry);
    document.body.append(toolbar);
  }

  function removeTriggers() {
    triggers.forEach(button => button.remove());
    triggers.clear();
  }

  // action: null, "retry" (access could not be checked) or "signin" (access was refused).
  function showStatus(message, action) {
    if (!toolbar) return;
    const note = toolbar.querySelector("[data-academy-admin-note]");
    note.textContent = message || text.toolbar;
    note.toggleAttribute("data-academy-admin-default", !message);
    toolbar.querySelector("[data-academy-admin-retry]").hidden = !action;
    toolbar.querySelector("[data-academy-admin-signin]").hidden = action !== "signin";
    toolbar.querySelector("[data-academy-admin-toggle]").hidden = !triggers.size;
  }

  function accessUnavailable() {
    if (!editor) return;
    editor.accessLost = true;
    editor.status.textContent = text.accessLost;
    editor.status.hidden = false;
    editor.authNoticePending = !editor.ready;
    if (editor.ready) editor.frame.contentWindow?.postMessage({ type: "ihear:academy-editor-auth-unavailable" }, location.origin);
  }

  async function checkAccess() {
    if (accessRequest) return accessRequest;
    accessRequest = (async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      let failed = false, status = 0;
      try {
        const response = await fetch("/api/admin/me", { credentials: "same-origin", cache: "no-store", signal: controller.signal });
        const body = await response.json().catch(() => null);
        principal = response.ok && body?.ok === true && ["owner", "editor"].includes(body.principal?.role)
          && typeof body.principal.email === "string" && body.principal.email.trim()
          ? { email: body.principal.email.trim().toLowerCase(), role: body.principal.role } : null;
        status = response.status;
        failed = !principal && status !== 401 && status !== 403;
      } catch {
        principal = null;
        failed = true;
      } finally {
        clearTimeout(timeout);
      }
      const sameAccount = !editor || principal?.email === editor.email;
      if (editor && (!principal || !sameAccount)) accessUnavailable();
      else if (editor) {
        editor.accessLost = false;
        editor.authNoticePending = false;
        if (editor.ready) editor.status.hidden = true;
      }
      const allowed = Boolean(principal) && sameAccount;
      createToolbar();
      if (allowed) {
        createTriggers();
        triggers.forEach(button => { button.hidden = hidden; });
        showStatus("", null);
      } else if (failed) {
        // A transient failure keeps the controls of a confirmed administrator.
        showStatus(text.authError, "retry");
      } else {
        // Signed out, expired (401) or no longer an administrator (403): no edit
        // control remains, except the open editor, which keeps its unsaved draft.
        if (!editor) removeTriggers();
        // A different account than the open editor's is reported like lost access.
        showStatus(status === 401 ? text.signedOut : principal ? text.accessLost : text.forbidden, "signin");
      }
      return allowed;
    })().finally(() => { accessRequest = null; });
    return accessRequest;
  }

  function createEditor(block, trigger) {
    const dialog = element("dialog", "academy-editor-dialog");
    dialog.id = "academy-content-editor";
    dialog.dataset.ready = "false";
    dialog.dataset.busy = "false";
    dialog.setAttribute("aria-labelledby", "academy-editor-title");
    const bar = element("div", "academy-editor-toolbar");
    const title = element("h2", "", text.editorTitle);
    title.id = "academy-editor-title";
    const editorUrl = new URL("/admin/academy", location.origin);
    editorUrl.searchParams.set("locale", locale);
    editorUrl.searchParams.set("block", block);
    const full = element("a", "academy-editor-full", text.full);
    full.href = editorUrl.pathname + editorUrl.search;
    full.target = "_blank";
    full.rel = "noopener noreferrer";
    const close = element("button", "academy-editor-close", text.close);
    close.type = "button";
    close.dataset.academyEditorClose = "";
    const status = element("p", "academy-editor-status", text.loading);
    status.dataset.academyEditorStatus = "";
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    const retry = element("button", "academy-editor-retry", text.retry);
    retry.type = "button";
    retry.hidden = true;
    retry.dataset.academyEditorRetry = "";
    const frame = element("iframe", "academy-editor-frame");
    frame.title = text.editorTitle;
    frame.hidden = true;
    editorUrl.searchParams.set("embed", "1");
    frame.src = editorUrl.pathname + editorUrl.search;
    bar.append(title, full, close);
    dialog.append(bar, status, retry, frame);
    const state = { dialog, frame, status, email: principal.email, dirty: false, busy: false, ready: false, accessLost: false, authNoticePending: false };
    const priorOverflow = document.body.style.overflow;
    let loadTimeout;

    function dispose(restoreFocus = true) {
      clearTimeout(loadTimeout);
      window.removeEventListener("message", receive);
      dialog.close();
      dialog.remove();
      document.body.style.overflow = priorOverflow;
      if (editor === state) editor = null;
      if (restoreFocus && trigger.isConnected && !trigger.hidden) trigger.focus();
    }

    function requestClose() {
      if (state.busy) { status.textContent = text.saving; status.hidden = false; return; }
      // Until the editor reports that it is ready the frame stays hidden and cannot be edited.
      if (!state.ready) { dispose(); return; }
      frame.contentWindow?.postMessage({ type: "ihear:academy-editor-close-request" }, location.origin);
    }

    function startLoading() {
      clearTimeout(loadTimeout);
      retry.hidden = true;
      status.textContent = text.loading;
      status.hidden = false;
      loadTimeout = setTimeout(() => {
        if (state.ready) return;
        status.textContent = text.loadError;
        retry.hidden = false;
      }, 20000);
    }

    function receive(event) {
      if (editor !== state || event.origin !== location.origin || event.source !== frame.contentWindow) return;
      const message = event.data;
      if (!message || typeof message !== "object") return;
      if (message.type === "ihear:academy-editor-state") {
        if (typeof message.dirty !== "boolean" || typeof message.busy !== "boolean") return;
        const firstState = !state.ready;
        state.ready = true;
        state.dirty = message.dirty;
        state.busy = message.busy;
        dialog.dataset.ready = "true";
        dialog.dataset.busy = String(state.busy);
        close.disabled = state.busy;
        clearTimeout(loadTimeout);
        retry.hidden = true;
        frame.hidden = false;
        if (firstState) frame.contentWindow?.postMessage({ type: "ihear:academy-editor-visible" }, location.origin);
        if (!state.accessLost) status.hidden = true;
        if (state.authNoticePending) {
          state.authNoticePending = false;
          frame.contentWindow?.postMessage({ type: "ihear:academy-editor-auth-unavailable" }, location.origin);
        }
      } else if (message.type === "ihear:academy-editor-close") {
        if (state.ready && !state.dirty && !state.busy) dispose();
      } else if (message.type === "ihear:academy-editor-saved") {
        if (!state.ready || state.dirty || state.busy || !Number.isSafeInteger(message.recordVersion) || message.recordVersion < 1) return;
        const displayed = Number(document.body.dataset.academyVersion);
        if (Number.isSafeInteger(displayed) && message.recordVersion <= displayed) return;
        dispose(false);
        showStatus(text.saved, false);
        // A full reload updates every server-rendered text and price together.
        location.reload();
      }
    }

    retry.addEventListener("click", () => {
      if (state.ready) return;
      startLoading();
      frame.src = editorUrl.pathname + editorUrl.search;
    });
    frame.addEventListener("error", () => {
      if (state.ready) return;
      clearTimeout(loadTimeout);
      status.textContent = text.loadError;
      retry.hidden = false;
    });
    close.addEventListener("click", requestClose);
    dialog.addEventListener("cancel", event => { event.preventDefault(); requestClose(); });
    dialog.addEventListener("click", event => { if (event.target === dialog) requestClose(); });
    editor = state;
    window.addEventListener("message", receive);
    document.body.append(dialog);
    document.body.style.overflow = "hidden";
    dialog.showModal();
    close.focus();
    startLoading();
  }

  async function openEditor(block, trigger) {
    if (editor || opening) return;
    opening = true;
    trigger.disabled = true;
    try {
      // An expired sign-in is reported here instead of loading a sign-in page into the editor frame.
      if (await checkAccess()) createEditor(block, trigger);
    } finally {
      opening = false;
      trigger.disabled = false;
    }
  }

  window.addEventListener("focus", () => { void checkAccess(); });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void checkAccess();
  });
  window.addEventListener("pageshow", event => { if (event.persisted) void checkAccess(); });
  window.addEventListener("beforeunload", event => {
    if (!editor?.dirty && !editor?.busy) return;
    event.preventDefault();
    event.returnValue = "";
  });
  void checkAccess();
})();
