(function () {
  const EDITABLE_SELECTOR = [
    "main h1",
    "main h2",
    "main h3",
    "main h4",
    "main p",
    "main li",
    "main .eyebrow",
    "main .hero-tagline",
    "main .stat .lbl",
    "main .card-title",
  ].join(",");

  const labelsByLang = {
    en: {
      edit: "Edit",
      save: "Save",
      cancel: "Cancel",
      forbidden: "You do not have permission to edit this content.",
      failed: "Could not save this change.",
    },
    "zh-Hant": {
      edit: "編輯",
      save: "儲存",
      cancel: "取消",
      forbidden: "你沒有權限修改這段內容。",
      failed: "無法儲存這次修改。",
    },
    "zh-Hans": {
      edit: "编辑",
      save: "保存",
      cancel: "取消",
      forbidden: "你没有权限修改这段内容。",
      failed: "无法保存这次修改。",
    },
  };

  let contentStore = { version: 1, updatedAt: "", pages: {} };
  const pageKey = normalizePage(window.location.pathname);

  function getLabels() {
    const lang = document.documentElement.lang || "en";
    if (lang.toLowerCase().includes("hans")) return labelsByLang["zh-Hans"];
    if (lang.toLowerCase().startsWith("zh")) return labelsByLang["zh-Hant"];
    return labelsByLang.en;
  }

  function normalizePage(pathname) {
    let path = pathname || "/";
    if (path.endsWith(".html")) path = path.slice(0, -5);
    if (path === "/index" || path === "") return "/";
    if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
    return path;
  }

  function isAdminSession(session) {
    return Boolean(session && session.user && session.user.isAdmin);
  }

  function installStyles() {
    if (document.getElementById("ihear-inline-edit-styles")) return;

    const style = document.createElement("style");
    style.id = "ihear-inline-edit-styles";
    style.textContent = `
      .ihear-inline-host{ position:relative; }
      .ihear-inline-edit-button{
        width:24px; height:24px; margin-left:7px; border-radius:999px; border:1.5px solid var(--navy);
        display:inline-flex; align-items:center; justify-content:center; vertical-align:middle;
        background:#fff; color:var(--navy); font:800 13px/1 var(--font-b); cursor:pointer;
        box-shadow:0 4px 14px rgba(38,57,116,.12); opacity:.78;
      }
      .ihear-inline-edit-button:hover{ opacity:1; transform:translateY(-1px); }
      .ihear-inline-form{ display:inline-flex; align-items:center; gap:8px; flex-wrap:wrap; max-width:100%; }
      .ihear-inline-form[data-multiline="true"]{ display:flex; align-items:flex-start; width:100%; }
      .ihear-inline-input{
        width:min(100%, 42rem); min-width:min(100%, 16rem); border:2px solid var(--orange);
        border-radius:12px; padding:.32em .58em; background:#fff; color:inherit; font:inherit;
        line-height:1.25; box-shadow:0 5px 18px rgba(38,57,116,.10);
      }
      textarea.ihear-inline-input{
        width:100%; min-height:9rem; padding:.72em .8em; line-height:1.55; resize:vertical;
      }
      .ihear-inline-action{
        border:2px solid var(--navy); border-radius:999px; padding:7px 12px;
        background:#fff; color:var(--navy); font:800 .86rem/1 var(--font-b); cursor:pointer;
      }
      .ihear-inline-action[data-action="save"]{ background:var(--navy); color:#fff; }
      .ihear-inline-action:disabled{ opacity:.62; cursor:wait; }
      .ihear-inline-editing{ outline:2px dashed rgba(232,150,79,.42); outline-offset:6px; border-radius:10px; }
    `;
    document.head.appendChild(style);
  }

  function pageContent() {
    return (contentStore.pages && contentStore.pages[pageKey]) || {};
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

  function elementKey(element) {
    if (element.dataset.inlineKey) return element.dataset.inlineKey;

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

    const key = parts.join(">");
    element.dataset.inlineKey = key;
    return key;
  }

  function isEditableElement(element) {
    if (element.closest("[data-no-inline-edit], .auth-widget, .auth-mobile-item")) return false;
    if (element.querySelector("input,textarea,select,button,script,style,svg")) return false;
    if (element.childElementCount > 0) return false;

    const text = getText(element);
    return text.length >= 2 && text.length <= 5000;
  }

  function editableElements() {
    return Array.from(document.querySelectorAll(EDITABLE_SELECTOR)).filter(isEditableElement);
  }

  function applyContent() {
    const overrides = pageContent();

    editableElements().forEach((element) => {
      const key = elementKey(element);
      if (Object.prototype.hasOwnProperty.call(overrides, key)) {
        setText(element, overrides[key]);
      }
    });
  }

  function removeControls() {
    document.querySelectorAll(".ihear-inline-edit-button").forEach((button) => button.remove());
    document.querySelectorAll(".ihear-inline-host").forEach((element) => {
      element.classList.remove("ihear-inline-host");
    });
  }

  function addEditButton(element) {
    const labels = getLabels();
    const button = document.createElement("button");
    button.type = "button";
    button.className = "ihear-inline-edit-button";
    button.setAttribute("aria-label", labels.edit);
    button.title = labels.edit;
    button.textContent = "✎";
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      startEditing(element);
    });

    element.classList.add("ihear-inline-host");
    element.appendChild(button);
  }

  function renderAdminControls(session) {
    removeControls();
    if (!isAdminSession(session)) return;

    editableElements().forEach(addEditButton);
  }

  function startEditing(element) {
    const labels = getLabels();
    const original = getText(element);
    const form = document.createElement("span");
    const isMultiline = original.length > 160;
    const input = document.createElement(isMultiline ? "textarea" : "input");
    const save = document.createElement("button");
    const cancel = document.createElement("button");

    form.className = "ihear-inline-form";
    form.dataset.multiline = String(isMultiline);
    input.className = "ihear-inline-input";
    if (!isMultiline) input.type = "text";
    else input.rows = Math.min(14, Math.max(6, Math.ceil(original.length / 90)));
    input.maxLength = 5000;
    input.value = original;
    input.setAttribute("aria-label", labels.edit);

    save.type = "button";
    save.className = "ihear-inline-action";
    save.dataset.action = "save";
    save.textContent = labels.save;

    cancel.type = "button";
    cancel.className = "ihear-inline-action";
    cancel.dataset.action = "cancel";
    cancel.textContent = labels.cancel;

    form.append(input, save, cancel);
    element.classList.add("ihear-inline-editing");
    element.dataset.inlineEditing = "true";
    element.textContent = "";
    element.appendChild(form);

    function restore() {
      setText(element, original);
      addEditButton(element);
    }

    async function saveChange() {
      save.disabled = true;
      cancel.disabled = true;

      try {
        await handleSave(element, input.value);
      } catch (error) {
        save.disabled = false;
        cancel.disabled = false;
        alert(error && error.message ? error.message : labels.failed);
      }
    }

    save.addEventListener("click", saveChange);
    cancel.addEventListener("click", restore);
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && (!isMultiline || event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        saveChange();
      }
      if (event.key === "Escape") restore();
    });

    input.focus();
    input.select();
  }

  async function handleSave(element, value) {
    const labels = getLabels();
    const key = elementKey(element);
    const response = await fetch("/api/content/update", {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        page: pageKey,
        key,
        value,
      }),
    });

    const data = await response.json().catch(() => null);

    if (response.status === 403) throw new Error(labels.forbidden);
    if (!response.ok) throw new Error((data && data.error) || labels.failed);

    contentStore = data.content || contentStore;
    setText(element, value);
    addEditButton(element);
  }

  async function loadContent() {
    try {
      const response = await fetch("/api/content/get", {
        credentials: "same-origin",
        cache: "no-store",
      });
      if (response.ok) contentStore = await response.json();
    } catch {
      contentStore = { version: 1, updatedAt: "", pages: {} };
    }

    applyContent();
  }

  async function boot() {
    installStyles();
    await loadContent();
    renderAdminControls(window.iHearAuth && window.iHearAuth.getSession());
  }

  window.addEventListener("ihear:auth", (event) => {
    renderAdminControls(event.detail && event.detail.session);
  });

  window.iHearInlineEdit = {
    refresh: boot,
    getContent: function () {
      return contentStore;
    },
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
