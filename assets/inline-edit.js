(function () {
  "use strict";

  const EDITABLE_SELECTOR = [
    "main h1", "main h2", "main h3", "main h4", "main p", "main li", "main .eyebrow",
    "main .hero-tagline", "main .stat .lbl", "main .card-title",
  ].join(",");

  const labelsByLocale = {
    en: {
      edit: "Edit", save: "Save", cancel: "Cancel", saving: "Saving…", forbidden: "You do not have permission to edit this content.",
      failed: "Could not save this change.", conflict: "This content changed elsewhere. Reload the latest version before saving.",
      empty: "Content cannot be blank.", unsaved: "Discard your unsaved change?", saved: "Content saved.",
    },
    zhHant: {
      edit: "編輯", save: "儲存", cancel: "取消", saving: "儲存中…", forbidden: "你沒有權限修改這段內容。",
      failed: "無法儲存這次修改。", conflict: "這段內容已由其他管理員更新，請先重新載入最新內容。",
      empty: "內容不可空白。", unsaved: "要放棄尚未儲存的修改嗎？", saved: "內容已儲存。",
    },
    zhHans: {
      edit: "编辑", save: "保存", cancel: "取消", saving: "保存中…", forbidden: "你没有权限修改这段内容。",
      failed: "无法保存这次修改。", conflict: "这段内容已由其他管理员更新，请先重新加载最新内容。",
      empty: "内容不能为空。", unsaved: "要放弃尚未保存的修改吗？", saved: "内容已保存。",
    },
  };

  let contentStore = emptyStore();
  const pageKey = normalizePage(window.location.pathname);
  const originalValues = new Map();
  let activeEditor = null;
  let liveNotice = null;
  let currentSession = null;

  function emptyStore() {
    const locale = () => ({ pages: {}, itemUpdatedAt: {} });
    return { version: 3, updatedAt: "", locales: { en: locale(), zhHant: locale(), zhHans: locale() } };
  }

  function locale() {
    const language = (document.documentElement.lang || "en").toLowerCase();
    if (language.includes("hans")) return "zhHans";
    if (language.startsWith("zh")) return "zhHant";
    return "en";
  }

  function labels() {
    return labelsByLocale[locale()] || labelsByLocale.en;
  }

  function normalizePage(pathname) {
    let path = pathname || "/";
    if (path.endsWith(".html")) path = path.slice(0, -5);
    if (path === "/index" || path === "") return "/";
    return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
  }

  function normalizeStore(store) {
    if (store?.version === 3 && store.locales) return store;
    const migrated = emptyStore();
    migrated.updatedAt = store?.updatedAt || "";
    migrated.locales.zhHant.pages = store?.pages || {};
    migrated.locales.zhHant.itemUpdatedAt = store?.itemUpdatedAt || {};
    return migrated;
  }

  function isAdminSession(session) {
    return Boolean(session?.user?.isAdmin);
  }

  function installStyles() {
    if (document.getElementById("ihear-inline-edit-styles")) return;
    const style = document.createElement("style");
    style.id = "ihear-inline-edit-styles";
    style.textContent = `
      .ihear-inline-host{position:relative}.ihear-inline-edit-button{width:44px;height:44px;margin-left:7px;border-radius:999px;border:1.5px solid var(--navy);display:inline-flex;align-items:center;justify-content:center;vertical-align:middle;background:#fff;color:var(--navy);font:800 16px/1 var(--font-b);cursor:pointer;box-shadow:0 4px 14px rgba(38,57,116,.12);opacity:.82}.ihear-inline-edit-button:hover{opacity:1;transform:translateY(-1px)}.ihear-inline-form{display:inline-flex;align-items:center;gap:8px;flex-wrap:wrap;max-width:100%}.ihear-inline-form[data-multiline="true"]{display:flex;align-items:flex-start;width:100%}.ihear-inline-input{width:min(100%,42rem);min-width:min(100%,16rem);border:2px solid var(--orange-text);border-radius:12px;padding:.45em .65em;background:#fff;color:inherit;font:inherit;line-height:1.25;box-shadow:0 5px 18px rgba(38,57,116,.10)}textarea.ihear-inline-input{width:100%;min-height:9rem;padding:.72em .8em;line-height:1.55;resize:vertical}.ihear-inline-action{min-height:44px;border:2px solid var(--navy);border-radius:999px;padding:7px 14px;background:#fff;color:var(--navy);font:800 .86rem/1 var(--font-b);cursor:pointer}.ihear-inline-action[data-action="save"]{background:var(--navy);color:#fff}.ihear-inline-action:disabled{opacity:.62;cursor:wait}.ihear-inline-editing{outline:2px dashed rgba(166,83,19,.55);outline-offset:6px;border-radius:10px}.ihear-inline-error{flex-basis:100%;color:#8B1E2D;font:700 .86rem/1.4 var(--font-b)}.ihear-inline-live-notice{position:fixed;right:18px;bottom:18px;z-index:10000;max-width:min(26rem,calc(100vw - 36px));padding:12px 16px;border:2px solid var(--orange-text);border-radius:12px;background:#fff;color:var(--navy);box-shadow:0 10px 30px rgba(38,57,116,.18);font:700 .9rem/1.45 var(--font-b)}
    `;
    document.head.appendChild(style);
  }

  function localeStore() {
    return contentStore.locales?.[locale()] || emptyStore().locales[locale()];
  }

  function pageContent() {
    return localeStore().pages?.[pageKey] || {};
  }

  function pageMetadata() {
    return localeStore().itemUpdatedAt?.[pageKey] || {};
  }

  function getText(element) {
    const clone = element.cloneNode(true);
    clone.querySelectorAll(".ihear-inline-edit-button,.ihear-inline-form").forEach((node) => node.remove());
    return clone.textContent.trim();
  }

  function setText(element, value) {
    element.classList.remove("ihear-inline-editing");
    element.removeAttribute("data-inline-editing");
    element.textContent = value;
  }

  function selectorKey(element) {
    const parts = [];
    let node = element;
    const root = document.querySelector("main") || document.body;
    while (node && node !== root && node.nodeType === Node.ELEMENT_NODE) {
      const tag = node.tagName.toLowerCase();
      let index = 1;
      let sibling = node.previousElementSibling;
      while (sibling) {
        if (sibling.tagName === node.tagName) index += 1;
        sibling = sibling.previousElementSibling;
      }
      parts.unshift(`${tag}:nth-of-type(${index})`);
      node = node.parentElement;
    }
    return parts.join(">");
  }

  function stableKey(element) {
    if (element.dataset.inlineKey) return element.dataset.inlineKey;
    if (element.dataset.i18n) return `i18n:${element.dataset.i18n}`;
    const key = selectorKey(element);
    element.dataset.inlineKey = key;
    return key;
  }

  function legacyKeys(element) {
    const selector = selectorKey(element);
    const keys = [selector];
    if (element.tagName === "H1") keys.push(selector.replace(/h1:nth-of-type/g, "h2:nth-of-type"));
    return [...new Set(keys)];
  }

  function storageKey(element) {
    const overrides = pageContent();
    const primary = stableKey(element);
    if (Object.prototype.hasOwnProperty.call(overrides, primary)) return primary;
    return legacyKeys(element).find((key) => Object.prototype.hasOwnProperty.call(overrides, key)) || primary;
  }

  function isEditableElement(element) {
    if (element.closest("[data-no-inline-edit],.auth-widget,.auth-mobile-item")) return false;
    const clone = element.cloneNode(true);
    clone.querySelectorAll(".ihear-inline-edit-button,.ihear-inline-form").forEach((node) => node.remove());
    if (clone.querySelector("input,textarea,select,button,script,style,svg") || clone.childElementCount > 0) return false;
    const text = clone.textContent.trim();
    return text.length >= 2 && text.length <= 5000;
  }

  function editableElements() {
    return Array.from(document.querySelectorAll(EDITABLE_SELECTOR)).filter(isEditableElement);
  }

  function applyContent() {
    const overrides = pageContent();
    editableElements().forEach((element) => {
      const key = storageKey(element);
      const originalKey = `${locale()}:${stableKey(element)}`;
      if (!originalValues.has(originalKey)) originalValues.set(originalKey, getText(element));
      if (Object.prototype.hasOwnProperty.call(overrides, key)) setText(element, overrides[key]);
      else setText(element, originalValues.get(originalKey));
    });
  }

  function removeControls() {
    document.querySelectorAll(".ihear-inline-edit-button").forEach((button) => button.remove());
    document.querySelectorAll(".ihear-inline-host").forEach((element) => element.classList.remove("ihear-inline-host"));
  }

  function addEditButton(element) {
    if (element.querySelector(":scope > .ihear-inline-edit-button")) return;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "ihear-inline-edit-button";
    button.setAttribute("aria-label", labels().edit);
    button.title = labels().edit;
    button.textContent = "✎";
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      startEditing(element);
    });
    element.classList.add("ihear-inline-host");
    element.appendChild(button);
  }

  function renderAdminControls() {
    removeControls();
    if (!isAdminSession(currentSession) || activeEditor) return;
    editableElements().forEach(addEditButton);
  }

  function isDirty() {
    return Boolean(activeEditor && activeEditor.input.value !== activeEditor.original);
  }

  function discardActive(options) {
    if (!activeEditor) return true;
    if (isDirty() && !options?.force && !window.confirm(labels().unsaved)) return false;
    const { element, original } = activeEditor;
    activeEditor = null;
    setText(element, original);
    renderAdminControls();
    window.iHearLiveContent?.checkNow({ force: true });
    return true;
  }

  function startEditing(element) {
    if (activeEditor && !discardActive()) return;
    const original = getText(element);
    const form = document.createElement("span");
    const multiline = original.length > 160;
    const input = document.createElement(multiline ? "textarea" : "input");
    const save = document.createElement("button");
    const cancel = document.createElement("button");
    const error = document.createElement("span");

    form.className = "ihear-inline-form";
    form.dataset.multiline = String(multiline);
    input.className = "ihear-inline-input";
    if (!multiline) input.type = "text";
    else input.rows = Math.min(14, Math.max(6, Math.ceil(original.length / 90)));
    input.maxLength = 5000;
    input.value = original;
    input.setAttribute("aria-label", labels().edit);
    save.type = cancel.type = "button";
    save.className = cancel.className = "ihear-inline-action";
    save.dataset.action = "save";
    cancel.dataset.action = "cancel";
    save.textContent = labels().save;
    cancel.textContent = labels().cancel;
    error.className = "ihear-inline-error";
    error.setAttribute("role", "alert");
    error.hidden = true;
    form.append(input, save, cancel, error);
    element.classList.add("ihear-inline-editing");
    element.dataset.inlineEditing = "true";
    element.textContent = "";
    element.appendChild(form);
    activeEditor = { element, input, save, cancel, error, original };

    async function saveChange() {
      const value = input.value.trim();
      if (!value) {
        input.setAttribute("aria-invalid", "true");
        error.textContent = labels().empty;
        error.hidden = false;
        input.focus();
        return;
      }
      input.removeAttribute("aria-invalid");
      error.hidden = true;
      save.disabled = cancel.disabled = true;
      save.textContent = labels().saving;
      try {
        await handleSave(element, value);
        activeEditor = null;
        window.iHearToast?.(labels().saved);
        renderAdminControls();
      } catch (reason) {
        save.disabled = cancel.disabled = false;
        save.textContent = labels().save;
        error.textContent = reason?.message || labels().failed;
        error.hidden = false;
        window.iHearToast?.(error.textContent, { error: true });
      }
    }

    save.addEventListener("click", saveChange);
    cancel.addEventListener("click", () => discardActive());
    input.addEventListener("input", () => { input.removeAttribute("aria-invalid"); error.hidden = true; });
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && (!multiline || event.ctrlKey || event.metaKey)) { event.preventDefault(); saveChange(); }
      if (event.key === "Escape") { event.preventDefault(); discardActive(); }
    });
    input.focus();
    input.select();
  }

  async function handleSave(element, value) {
    const key = storageKey(element);
    const response = await fetch("/api/content/update", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        page: pageKey,
        key,
        locale: locale(),
        value,
        expectedUpdatedAt: pageMetadata()[key] || null,
      }),
    });
    const data = await response.json().catch(() => null);
    if (response.status === 403) throw new Error(labels().forbidden);
    if (response.status === 409 || response.status === 428) {
      showLiveNotice();
      throw new Error(labels().conflict);
    }
    if (!response.ok) throw new Error(data?.error || labels().failed);
    contentStore = normalizeStore(data.content || contentStore);
    setText(element, value);
    window.iHearLiveContent?.announce("content", data.revision);
  }

  function showLiveNotice() {
    if (!liveNotice) {
      liveNotice = document.createElement("div");
      liveNotice.className = "ihear-inline-live-notice";
      liveNotice.setAttribute("role", "status");
      liveNotice.setAttribute("aria-live", "polite");
      document.body.appendChild(liveNotice);
    }
    liveNotice.textContent = labels().conflict;
    liveNotice.hidden = false;
  }

  async function loadContent(context) {
    try {
      const revision = context?.revision ? `?live=${encodeURIComponent(context.revision)}` : "";
      const response = await fetch(`/api/content/get${revision}`, { credentials: "same-origin", cache: "no-store" });
      if (!response.ok) throw new Error("content load failed");
      contentStore = normalizeStore(await response.json());
    } catch (error) {
      if (context) throw error;
      contentStore = emptyStore();
    }
    applyContent();
    renderAdminControls();
    if (liveNotice) liveNotice.hidden = true;
  }

  async function boot() {
    installStyles();
    await loadContent();
  }

  window.addEventListener("ihear:auth", (event) => {
    currentSession = event.detail?.session || null;
    renderAdminControls();
  });
  window.addEventListener("ihear:before-language", (event) => {
    if (activeEditor && !discardActive()) event.preventDefault();
  });
  window.addEventListener("ihear:language", () => {
    applyContent();
    renderAdminControls();
  });
  window.addEventListener("beforeunload", (event) => {
    if (!isDirty()) return;
    event.preventDefault();
    event.returnValue = "";
  });

  window.iHearInlineEdit = { refresh: loadContent, getContent: () => contentStore, isDirty };
  window.iHearLiveContent?.register("content", { refresh: loadContent, isDirty, onBlocked: showLiveNotice });

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot, { once: true });
  else boot();
})();
