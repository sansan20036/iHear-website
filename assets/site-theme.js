(function () {
  "use strict";

  const API_URL = "/api/site-theme";
  const STORAGE_KEY = "ihear:site-theme";
  const THEMES = [
    ["warm", "#FAF7F2", "#FFFFFF"],
    ["ocean", "#F2F6FA", "#FFFFFF"],
    ["sage", "#F1F5F2", "#FFFFFF"],
    ["lavender", "#F6F3F8", "#FFFFFF"],
    ["slate", "#F4F5F7", "#FFFFFF"],
  ];
  const ALLOWED = new Set(THEMES.map(([id]) => id));
  const copy = {
    en: {
      trigger: "Change theme", title: "Site background theme", intro: "Preview an accessible palette, then publish it for everyone.",
      names: { warm: "Warm Ivory", ocean: "Ocean Blue", sage: "Sage Green", lavender: "Lavender Mist", slate: "Slate Gray" },
      cancel: "Cancel", restore: "Preview default", save: "Apply theme", saving: "Publishing…", saved: "Theme published",
      failed: "The theme could not be published.", conflict: "Another administrator published a theme. Review the latest version and try again.",
      expired: "Your administrator session has expired.", newer: "A newer theme was published in another tab. Your preview is unchanged until you finish or cancel.", selected: "Selected",
    },
    zhHant: {
      trigger: "更換主題色", title: "全站背景主題", intro: "先即時預覽無障礙色票，確認後再發布給所有訪客。",
      names: { warm: "象牙暖白", ocean: "沉靜冰藍", sage: "柔和綠意", lavender: "典雅淺紫", slate: "現代極簡" },
      cancel: "取消", restore: "預覽預設色", save: "確認套用", saving: "正在發布…", saved: "主題色已發布",
      failed: "無法發布主題色。", conflict: "另一位管理員已發布新主題，請確認最新版本後再試。",
      expired: "管理員登入已失效。", newer: "其他分頁已發布新主題；目前預覽會保留到你完成或取消。", selected: "已選取",
    },
    zhHans: {
      trigger: "更换主题色", title: "全站背景主题", intro: "先即时预览无障碍色票，确认后再发布给所有访客。",
      names: { warm: "象牙暖白", ocean: "沉静冰蓝", sage: "柔和绿意", lavender: "典雅浅紫", slate: "现代极简" },
      cancel: "取消", restore: "预览默认色", save: "确认应用", saving: "正在发布…", saved: "主题色已发布",
      failed: "无法发布主题色。", conflict: "另一位管理员已发布新主题，请确认最新版本后重试。",
      expired: "管理员登录已失效。", newer: "其他页面已发布新主题；当前预览会保留到你完成或取消。", selected: "已选择",
    },
  };

  let session = window.iHearAuth?.getSession?.() || null;
  let published = validSetting(window.__IHEAR_SITE_THEME__) || { theme: "warm", recordVersion: 1, updatedAt: "" };
  let preview = published.theme;
  let dirty = false;
  let busy = false;
  let trigger = null;
  let dialog = null;
  let returnFocus = null;

  function locale() {
    const language = (document.documentElement.lang || "en").toLowerCase();
    if (language.includes("hans")) return "zhHans";
    if (language.startsWith("zh")) return "zhHant";
    return "en";
  }
  function labels() { return copy[locale()] || copy.en; }
  function isAdmin() { return Boolean(session?.user?.isAdmin); }
  function validSetting(value) {
    if (!value || !ALLOWED.has(value.theme)) return null;
    const recordVersion = Number(value.recordVersion);
    if (!Number.isSafeInteger(recordVersion) || recordVersion < 1) return null;
    return { theme: value.theme, recordVersion, updatedAt: String(value.updatedAt || "") };
  }
  function apply(theme, persist) {
    if (!ALLOWED.has(theme)) theme = "warm";
    document.documentElement.dataset.theme = theme;
    if (persist) {
      try { localStorage.setItem(STORAGE_KEY, theme); } catch { /* Storage can be unavailable. */ }
    }
  }
  function toast(message, error) { window.iHearToast?.(message, { error: Boolean(error) }); }
  async function json(response) {
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(data.error || labels().failed);
      error.status = response.status;
      throw error;
    }
    return data;
  }
  async function load() {
    const response = await fetch(API_URL, { credentials: "same-origin", cache: "no-store" });
    const data = validSetting(await json(response));
    if (!data) throw new Error(labels().failed);
    published = data;
    window.__IHEAR_SITE_THEME__ = data;
    if (!dialog?.open || !dirty) {
      preview = data.theme;
      apply(data.theme, true);
      if (dialog?.open) renderSelection();
    }
  }

  function renderTrigger() {
    if (!isAdmin()) {
      trigger?.remove();
      trigger = null;
      return;
    }
    if (!trigger) {
      trigger = document.createElement("button");
      trigger.type = "button";
      trigger.className = "site-theme-trigger";
      trigger.innerHTML = '<span aria-hidden="true">🎨</span><span data-site-theme-trigger-label></span>';
      trigger.addEventListener("click", openDialog);
      document.body.appendChild(trigger);
    }
    trigger.querySelector("[data-site-theme-trigger-label]").textContent = labels().trigger;
    trigger.setAttribute("aria-label", labels().trigger);
    trigger.title = labels().trigger;
  }

  function ensureDialog() {
    if (dialog) return;
    dialog = document.createElement("dialog");
    dialog.className = "site-theme-dialog";
    dialog.setAttribute("aria-labelledby", "site-theme-title");
    document.body.appendChild(dialog);
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog && !busy) dialog.close("cancel");
    });
    dialog.addEventListener("cancel", (event) => {
      if (busy) event.preventDefault();
    });
    dialog.addEventListener("close", () => {
      if (dialog.returnValue !== "saved") apply(published.theme, false);
      preview = published.theme;
      dirty = false;
      busy = false;
      returnFocus?.focus();
      window.iHearLiveContent?.checkNow({ force: true });
    });
  }

  function dialogMarkup() {
    const l = labels();
    return `<form method="dialog" class="site-theme-panel" data-site-theme-form>
      <div class="site-theme-heading"><div><h2 id="site-theme-title">${l.title}</h2><p>${l.intro}</p></div><button type="button" class="site-theme-close" data-site-theme-close aria-label="${l.cancel}">×</button></div>
      <fieldset class="site-theme-grid"><legend class="sr-only">${l.title}</legend>${THEMES.map(([id, page, surface]) => `<label class="site-theme-option" data-theme-option="${id}"><input type="radio" name="site-theme" value="${id}"><span class="site-theme-swatch" style="--swatch-page:${page};--swatch-surface:${surface}" aria-hidden="true"><span></span><b>✓</b></span><span>${l.names[id]}</span><small>${id === preview ? l.selected : ""}</small></label>`).join("")}</fieldset>
      <p class="site-theme-status" role="status" aria-live="polite" data-site-theme-status></p>
      <div class="site-theme-actions"><button type="button" class="site-theme-restore" data-site-theme-restore>${l.restore}</button><span></span><button type="button" data-site-theme-cancel>${l.cancel}</button><button type="submit" class="site-theme-save" data-site-theme-save>${l.save}</button></div>
    </form>`;
  }

  function renderSelection() {
    if (!dialog) return;
    dialog.querySelectorAll("[data-theme-option]").forEach((option) => {
      const selected = option.dataset.themeOption === preview;
      option.classList.toggle("is-selected", selected);
      const input = option.querySelector("input");
      input.checked = selected;
      option.querySelector("small").textContent = selected ? labels().selected : "";
    });
  }
  function setBusy(next) {
    busy = next;
    dialog?.querySelectorAll("button,input").forEach((control) => { control.disabled = next; });
    const save = dialog?.querySelector("[data-site-theme-save]");
    if (save) save.textContent = next ? labels().saving : labels().save;
  }
  function setStatus(message, error) {
    const status = dialog?.querySelector("[data-site-theme-status]");
    if (!status) return;
    status.textContent = message || "";
    status.dataset.error = String(Boolean(error));
  }
  async function save(event) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setStatus(labels().saving, false);
    try {
      const data = await json(await fetch(API_URL, {
        method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ theme: preview, expectedVersion: published.recordVersion }),
      }));
      const next = validSetting(data);
      if (!next) throw new Error(labels().failed);
      published = next;
      preview = next.theme;
      dirty = false;
      window.__IHEAR_SITE_THEME__ = next;
      apply(next.theme, true);
      window.iHearLiveContent?.announce("theme", data.revision);
      toast(labels().saved, false);
      dialog.close("saved");
    } catch (error) {
      setBusy(false);
      const message = error.status === 409 ? labels().conflict : error.status === 403 ? labels().expired : error.message || labels().failed;
      setStatus(message, true);
      toast(message, true);
      if (error.status === 403) closeForAuthExpiry();
    }
  }
  function bindDialog() {
    dialog.querySelector("[data-site-theme-form]").addEventListener("submit", save);
    dialog.querySelector("[data-site-theme-close]").addEventListener("click", () => dialog.close("cancel"));
    dialog.querySelector("[data-site-theme-cancel]").addEventListener("click", () => dialog.close("cancel"));
    dialog.querySelectorAll('input[name="site-theme"]').forEach((input) => input.addEventListener("change", () => {
      preview = input.value;
      dirty = preview !== published.theme;
      apply(preview, false);
      setStatus("", false);
      renderSelection();
    }));
    dialog.querySelector("[data-site-theme-restore]").addEventListener("click", () => {
      preview = "warm";
      dirty = preview !== published.theme;
      apply(preview, false);
      setStatus("", false);
      renderSelection();
    });
  }
  function openDialog() {
    ensureDialog();
    returnFocus = trigger;
    preview = published.theme;
    dirty = false;
    dialog.innerHTML = dialogMarkup();
    bindDialog();
    renderSelection();
    dialog.showModal();
  }
  function closeForAuthExpiry() {
    if (dialog?.open) {
      apply(published.theme, false);
      dialog.close("cancel");
    }
    renderTrigger();
  }
  function refreshFromLive() {
    return load();
  }
  function boot() {
    apply(published.theme, true);
    renderTrigger();
    load().catch(() => { /* Bootstrap or warm remains the safe fallback. */ });
    window.addEventListener("ihear:auth", (event) => {
      session = event.detail?.session || null;
      if (!isAdmin()) closeForAuthExpiry();
      else renderTrigger();
    });
    window.addEventListener("ihear:language", () => {
      renderTrigger();
      if (dialog?.open && !busy) {
        dialog.innerHTML = dialogMarkup();
        bindDialog();
        renderSelection();
      }
    });
    window.iHearLiveContent?.register("theme", {
      refresh: refreshFromLive,
      isDirty: () => Boolean(dialog?.open && dirty),
      onBlocked: () => { setStatus(labels().newer, false); toast(labels().newer, false); },
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot, { once: true });
  else boot();
})();
