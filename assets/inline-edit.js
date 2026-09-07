(function () {
  "use strict";

  const LOCALES = ["en", "zhHant", "zhHans"];
  const localeLabels = { en: "English", zhHant: "繁體中文", zhHans: "简体中文" };
  const ui = {
    en: { edit: "Edit content", title: "Edit website text", save: "Publish", cancel: "Cancel", empty: "All languages are required.", conflict: "This content changed elsewhere. Reload and try again.", failed: "Could not save this content.", saved: "Content published.", rateLimited: "Too many requests. Try again in {seconds} seconds.", auto: "Automatically update Chinese translations", replace: "Also overwrite existing or manually edited Chinese", prepare: "Generate translation preview", preparing: "Translating…", waiting: "Confirm English source", ready: "Chinese preview ready. Review it, then publish.", englishWarning: "⚠️ Chinese content was detected. English is the source for automatic translation; enter English here for the most accurate result.", translateAnyway: "Translate this content anyway", missingHan: "⚠️ This Chinese field contains no Chinese characters. Check whether English was pasted here by mistake.", simplified: "Simplified Chinese may be present in the Traditional Chinese field.", convert: "Convert to Taiwan Traditional Chinese", conversionPreview: "Conversion preview", apply: "Apply conversion" },
    zhHant: { edit: "編輯內容", title: "編輯網站文字", save: "發布", cancel: "取消", empty: "三種語言都必須填寫。", conflict: "內容已由其他管理員更新，請重新載入後再試。", failed: "無法儲存內容。", saved: "內容已發布。", rateLimited: "操作較頻繁，請等待 {seconds} 秒後再試。", auto: "自動更新中文翻譯", replace: "同時覆蓋既有或人工修改過的中文", prepare: "產生翻譯預覽", preparing: "翻譯中…", waiting: "請先確認英文來源", ready: "中文預覽已完成，請檢查後再發布。", englishWarning: "⚠️ 偵測到中文內容：系統以英文為自動翻譯來源，建議在此輸入英文以確保翻譯準確。", translateAnyway: "仍以此內容翻譯", missingHan: "⚠️ 此欄位未包含中文字元，請確認是否誤貼英文。", simplified: "偵測到繁中欄位可能含有簡體字或中國大陸用語。", convert: "一鍵轉為台灣繁中", conversionPreview: "轉換預覽", apply: "套用轉換" },
    zhHans: { edit: "编辑内容", title: "编辑网站文字", save: "发布", cancel: "取消", empty: "三种语言都必须填写。", conflict: "内容已由其他管理员更新，请重新加载后重试。", failed: "无法保存内容。", saved: "内容已发布。", rateLimited: "操作较频繁，请等待 {seconds} 秒后再试。", auto: "自动更新中文翻译", replace: "同时覆盖现有或人工修改过的中文", prepare: "生成翻译预览", preparing: "翻译中…", waiting: "请先确认英文来源", ready: "中文预览已完成，请检查后再发布。", englishWarning: "⚠️ 检测到中文内容：系统以英文为自动翻译来源，建议在此输入英文以确保翻译准确。", translateAnyway: "仍以此内容翻译", missingHan: "⚠️ 此字段未包含中文字符，请确认是否误贴英文。", simplified: "检测到繁体中文字段可能含有简体字或中国大陆用语。", convert: "一键转为台湾繁体中文", conversionPreview: "转换预览", apply: "应用转换" },
  };

  const pageKey = normalizePage(location.pathname);
  let store = emptyStore();
  let catalog = new Map();
  let session = null;
  let active = null;
  let hoverTarget = null;
  let pencil = null;
  let notice = null;
  let textGuard = null;
  let prefetchedContent = null;
  const textGuardPromise = import("/assets/text-language-guard.js").then((module) => { textGuard = module; return module; }).catch(() => null);

  function emptyStore() {
    const locale = () => ({ pages: {}, itemUpdatedAt: {} });
    return { version: 3, updatedAt: "", locales: { en: locale(), zhHant: locale(), zhHans: locale() } };
  }
  function normalizePage(path) {
    let value = path || "/";
    if (value.endsWith(".html")) value = value.slice(0, -5);
    if (value === "/index" || value === "") return "/";
    return value.length > 1 && value.endsWith("/") ? value.slice(0, -1) : value;
  }
  function locale() { return window.iHearLanguage?.locale?.() || (/hans/i.test(document.documentElement.lang) ? "zhHans" : /^zh/i.test(document.documentElement.lang) ? "zhHant" : "en"); }
  function labels() { return ui[locale()] || ui.en; }
  function responseError(response, data, fallback) {
    if (response.status === 429) {
      const raw = Number(data?.retryAfter || response.headers.get("Retry-After"));
      const seconds = Number.isFinite(raw) && raw > 0 ? Math.ceil(raw) : 60;
      return new Error(labels().rateLimited.replace("{seconds}", String(seconds)));
    }
    return new Error(data?.error || fallback);
  }
  function slots() { return Array.from(document.querySelectorAll("[data-editable-content]")); }
  function identity(element) { return `${targetPage(element)}\u0000${element.dataset.editableContent}`; }
  function targetPage(element) { return element.dataset.editablePage || pageKey; }
  function definition(element) { return catalog.get(identity(element)); }
  function localePage(sourceLocale, page) { return store.locales?.[sourceLocale]?.pages?.[page] || {}; }
  function localeMetadata(sourceLocale, page) { return store.locales?.[sourceLocale]?.itemUpdatedAt?.[page] || {}; }
  function editableText(element) {
    if (!element.children.length) return element.textContent || "";
    return Array.from(element.childNodes).filter((node) => node.nodeType === Node.TEXT_NODE).map((node) => node.nodeValue || "").join("").trim();
  }
  function valueFor(element, sourceLocale) {
    const page = targetPage(element), key = element.dataset.editableContent;
    return localePage(sourceLocale, page)[key] ?? definition(element)?.values?.[sourceLocale] ?? editableText(element).trim();
  }
  function setValue(element, value) {
    if (!element.children.length) { if (element.textContent !== value) element.textContent = value; return; }
    const textNodes = Array.from(element.childNodes).filter((node) => node.nodeType === Node.TEXT_NODE);
    const target = textNodes.find((node) => node.nodeValue.trim()) || textNodes[0];
    if (target) { target.nodeValue = value; textNodes.filter((node) => node !== target).forEach((node) => { node.nodeValue = ""; }); return; }
    element.appendChild(document.createTextNode(value));
  }

  function installStyles() {
    if (document.getElementById("ihear-inline-edit-styles")) return;
    const style = document.createElement("style");
    style.id = "ihear-inline-edit-styles";
    style.textContent = `.ihear-editable-target{outline:2px dashed transparent;outline-offset:4px;border-radius:6px}.ihear-editable-target:hover,.ihear-editable-target:focus{outline-color:rgba(166,83,19,.55)}.ihear-inline-edit-button{position:fixed;z-index:9998;width:44px;height:44px;border:2px solid var(--navy);border-radius:999px;background:#fff;color:var(--navy);font:900 18px/1 sans-serif;box-shadow:0 5px 18px rgba(38,57,116,.22);cursor:pointer}.ihear-content-dialog{width:min(720px,calc(100vw - 24px));max-height:min(760px,calc(100vh - 24px));border:0;border-radius:18px;padding:0;color:var(--navy);background:#fff;box-shadow:0 22px 70px rgba(27,42,87,.3)}.ihear-content-dialog::backdrop{background:rgba(27,42,87,.56)}.ihear-content-form{padding:22px}.ihear-content-heading{display:flex;justify-content:space-between;gap:16px;align-items:center}.ihear-content-heading h2{margin:0;font-size:1.35rem}.ihear-content-translation{display:grid;gap:8px;margin:16px 0;padding:14px;border-radius:12px;background:#f5f7ff}.ihear-content-translation label{display:flex;gap:9px;align-items:center;font-weight:750}.ihear-content-tabs{display:flex;gap:8px;flex-wrap:wrap;margin:18px 0}.ihear-content-tabs button,.ihear-content-actions button{min-height:44px;border:2px solid var(--navy);border-radius:999px;padding:8px 16px;background:#fff;color:var(--navy);font-weight:800;cursor:pointer}.ihear-content-tabs button[aria-selected=true],.ihear-content-actions button[type=submit]{background:var(--navy);color:#fff}.ihear-content-panel label{display:block;font-weight:800;margin-bottom:7px}.ihear-content-panel input,.ihear-content-panel textarea{box-sizing:border-box;width:100%;border:2px solid var(--navy);border-radius:12px;padding:12px;font:inherit;color:inherit}.ihear-content-panel textarea{min-height:190px;resize:vertical;line-height:1.55}.ihear-content-guard{display:grid;gap:8px;margin:10px 0;padding:11px 12px;border:1px solid #e3b45e;border-radius:10px;background:#fff8e7;color:#6d4700;font-weight:700}.ihear-content-guard p{margin:0}.ihear-content-guard button{min-height:44px;justify-self:start;border:1px solid currentColor;border-radius:9px;padding:7px 12px;background:#fff;color:inherit;font-weight:800}.ihear-content-guard del,.ihear-content-guard ins{display:block;padding:8px;border-radius:8px;text-decoration:none;white-space:pre-wrap}.ihear-content-guard del{background:#fff0f2}.ihear-content-guard ins{background:#eaf8ef}.ihear-content-actions{display:flex;justify-content:flex-end;gap:10px;margin-top:18px}.ihear-content-error{color:#8b1e2d;font-weight:800}.ihear-inline-live-notice{position:fixed;right:18px;bottom:18px;z-index:10000;max-width:min(26rem,calc(100vw - 36px));padding:12px 16px;border:2px solid var(--orange-text);border-radius:12px;background:#fff;color:var(--navy);box-shadow:0 10px 30px rgba(38,57,116,.18);font-weight:700}`;
    document.head.appendChild(style);
  }

  function applyContent() {
    const current = locale();
    slots().forEach((element) => {
      if (active?.element === element) return;
      setValue(element, valueFor(element, current));
    });
    positionPencil();
  }

  function showNotice(message) {
    if (!notice) { notice = document.createElement("div"); notice.className = "ihear-inline-live-notice"; notice.setAttribute("role", "status"); notice.setAttribute("aria-live", "polite"); document.body.appendChild(notice); }
    notice.textContent = message; notice.hidden = false;
  }

  function positionPencil() {
    if (!pencil || !hoverTarget || pencil.hidden) return;
    const rect = hoverTarget.getBoundingClientRect();
    pencil.style.left = `${Math.max(4, Math.min(innerWidth - 48, rect.right + 5))}px`;
    pencil.style.top = `${Math.max(4, Math.min(innerHeight - 48, rect.top - 4))}px`;
  }

  function focusTarget(target) { hoverTarget = target; if (pencil) { pencil.hidden = false; pencil.setAttribute("aria-label", labels().edit); pencil.title = labels().edit; positionPencil(); } }

  function renderAdminControls() {
    const admin = Boolean(session?.user?.isAdmin);
    slots().forEach((element) => {
      element.classList.toggle("ihear-editable-target", admin);
      if (admin && !element.dataset.editableBound) {
        element.dataset.editableBound = "true";
        element.addEventListener("mouseenter", () => focusTarget(element));
        element.addEventListener("focus", () => focusTarget(element));
        if (!element.closest("a,button")) element.addEventListener("click", () => openEditor(element));
      }
    });
    if (!admin) { if (pencil) pencil.hidden = true; return; }
    if (!pencil) {
      pencil = document.createElement("button"); pencil.type = "button"; pencil.className = "ihear-inline-edit-button"; pencil.textContent = "✎";
      pencil.addEventListener("click", (event) => { event.preventDefault(); event.stopPropagation(); if (hoverTarget) openEditor(hoverTarget); });
      document.body.appendChild(pencil);
      window.addEventListener("scroll", positionPencil, { passive: true }); window.addEventListener("resize", positionPencil);
    }
    focusTarget(hoverTarget || slots()[0]);
  }

  function createEditor(element) {
    const dialog = document.createElement("dialog"), form = document.createElement("form"), heading = document.createElement("div"), title = document.createElement("h2"), translation = document.createElement("div"), autoLabel = document.createElement("label"), auto = document.createElement("input"), replaceLabel = document.createElement("label"), replace = document.createElement("input"), tabs = document.createElement("div"), panel = document.createElement("div"), guard = document.createElement("div"), error = document.createElement("p"), actions = document.createElement("div"), cancel = document.createElement("button"), save = document.createElement("button");
    dialog.className = "ihear-content-dialog"; dialog.setAttribute("aria-labelledby", "ihear-content-dialog-title"); form.className = "ihear-content-form"; heading.className = "ihear-content-heading"; title.id = "ihear-content-dialog-title"; tabs.className = "ihear-content-tabs"; tabs.setAttribute("role", "tablist"); panel.className = "ihear-content-panel"; guard.className = "ihear-content-guard"; guard.hidden = true; guard.setAttribute("role", "status"); guard.setAttribute("aria-live", "polite"); error.className = "ihear-content-error"; error.hidden = true; error.setAttribute("role", "alert"); actions.className = "ihear-content-actions";
    title.textContent = labels().title; heading.appendChild(title); translation.className = "ihear-content-translation"; auto.type = "checkbox"; auto.checked = true; replace.type = "checkbox"; autoLabel.append(auto, document.createTextNode(labels().auto)); replaceLabel.append(replace, document.createTextNode(labels().replace)); translation.append(autoLabel, replaceLabel); cancel.type = "button"; cancel.textContent = labels().cancel; save.type = "submit"; save.textContent = labels().prepare; actions.append(cancel, save); form.append(heading, translation, tabs, panel, guard, error, actions); dialog.appendChild(form); document.body.appendChild(dialog);
    const values = Object.fromEntries(LOCALES.map((key) => [key, valueFor(element, key)]));
    const baseUpdatedAtByLocale = Object.fromEntries(LOCALES.map((sourceLocale) => [sourceLocale, localeMetadata(sourceLocale, targetPage(element))[element.dataset.editableContent] || null]));
    const originalVisible = editableText(element);
    let activeLocale = "en", translationReceipt = "", translating = false, translationSequence = 0, englishGuardAccepted = false, conversionProposal = "";
    let englishEdited = false;
    const manuallyEditedChinese = { zhHant: false, zhHans: false };
    const fields = {};
    for (const key of LOCALES) {
      const tab = document.createElement("button"); tab.type = "button"; tab.textContent = localeLabels[key]; tab.setAttribute("role", "tab"); tab.dataset.locale = key; tabs.appendChild(tab);
      const label = document.createElement("label"), input = document.createElement(element.dataset.editableMode === "multiline" ? "textarea" : "input"); label.textContent = localeLabels[key]; input.maxLength = Number(element.dataset.editableMaxlength || definition(element)?.maxLength || 5000); input.value = values[key]; input.dataset.locale = key; label.appendChild(input); fields[key] = { label, input };
      input.addEventListener("input", () => { values[key] = input.value; error.hidden = true; conversionProposal = ""; if (key === "en") { englishEdited = true; englishGuardAccepted = false; translationReceipt = ""; translationSequence += 1; } else { manuallyEditedChinese[key] = true; } renderLanguageGuard(); refreshPrimaryAction(); if (activeLocale === key) setValue(element, input.value); });
      tab.addEventListener("click", () => select(key));
    }
    function select(key) { activeLocale = key; conversionProposal = ""; for (const tab of tabs.children) tab.setAttribute("aria-selected", String(tab.dataset.locale === key)); panel.replaceChildren(fields[key].label); setValue(element, values[key]); renderLanguageGuard(); fields[key].input.focus(); }
    function addGuardText(message) { const paragraph = document.createElement("p"); paragraph.textContent = message; guard.appendChild(paragraph); }
    function addGuardButton(message, action) { const button = document.createElement("button"); button.type = "button"; button.textContent = message; button.addEventListener("click", action); guard.appendChild(button); }
    function renderLanguageGuard() {
      guard.replaceChildren(); guard.hidden = true;
      if (!textGuard) return;
      const value = values[activeLocale] || "", text = labels();
      if (activeLocale === "en" && textGuard.inspectEnglishSource(value).warning && !englishGuardAccepted) {
        addGuardText(text.englishWarning); addGuardButton(text.translateAnyway, () => { englishGuardAccepted = true; renderLanguageGuard(); refreshPrimaryAction(); });
      } else if (activeLocale !== "en") {
        const result = textGuard.inspectChineseField(value);
        if (result.missingHan) addGuardText(text.missingHan);
        if (activeLocale === "zhHant" && result.likelySimplified) {
          addGuardText(text.simplified);
          if (!conversionProposal) addGuardButton(text.convert, previewTraditionalConversion);
        }
      }
      if (conversionProposal && conversionProposal !== value) {
        addGuardText(labels().conversionPreview);
        const before = document.createElement("del"), after = document.createElement("ins"); before.textContent = value; after.textContent = conversionProposal; guard.append(before, after);
        addGuardButton(labels().apply, () => { values.zhHant = conversionProposal; manuallyEditedChinese.zhHant = true; fields.zhHant.input.value = conversionProposal; conversionProposal = ""; setValue(element, values.zhHant); renderLanguageGuard(); });
        addGuardButton(labels().cancel, () => { conversionProposal = ""; renderLanguageGuard(); });
      }
      guard.hidden = !guard.childNodes.length;
    }
    async function previewTraditionalConversion() {
      try {
        const response = await fetch("/api/admin/translations/traditionalize", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ value: values.zhHant }) });
        const data = await response.json().catch(() => null); if (!response.ok) throw responseError(response, data, labels().failed); conversionProposal = data.value; renderLanguageGuard();
      } catch (reason) { error.textContent = reason?.message || labels().failed; error.hidden = false; }
    }
    select(activeLocale);
    function dirty() { return LOCALES.some((key) => values[key] !== valueFor(element, key)); }
    function refreshPrimaryAction() {
      const blocked = Boolean(textGuard?.inspectEnglishSource(values.en).warning && !englishGuardAccepted);
      save.textContent = translating ? labels().preparing : (!auto.checked || translationReceipt ? labels().save : blocked ? labels().waiting : labels().prepare);
    }
    function close(restore) { translationSequence += 1; if (restore) setValue(element, originalVisible); active = null; dialog.close(); dialog.remove(); renderAdminControls(); }
    cancel.addEventListener("click", () => close(true));
    dialog.addEventListener("cancel", (event) => { event.preventDefault(); close(true); });
    async function prepareTranslation(selectPreview) {
      if (!textGuard) textGuard = await textGuardPromise;
      if (translating || !auto.checked || !values.en.trim() || (textGuard?.inspectEnglishSource(values.en).warning && !englishGuardAccepted)) { renderLanguageGuard(); refreshPrimaryAction(); return false; }
      const requestId = ++translationSequence, requestedEnglish = values.en;
      translating = true; save.disabled = cancel.disabled = true; save.textContent = labels().preparing;
      try {
        const normalized = Object.fromEntries(LOCALES.map((key) => [key, values[key].trim()]));
        const page = targetPage(element), key = element.dataset.editableContent;
        const refreshLegacyLocales = englishEdited ? ["zhHant", "zhHans"].filter((language) => !manuallyEditedChinese[language]) : [];
        const preview = await fetch("/api/admin/translations/preview", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ resource: { type: "content", scope: page, id: key, version: baseUpdatedAtByLocale.en }, fields: { value: normalized }, allowCjkEnglish: englishGuardAccepted, force: replace.checked ? { value: ["zhHant", "zhHans"] } : {}, refreshLegacy: refreshLegacyLocales.length ? { value: refreshLegacyLocales } : {} }) });
        const data = await preview.json().catch(() => null); if (!preview.ok) throw responseError(preview, data, labels().failed);
        if (requestId !== translationSequence || values.en !== requestedEnglish) return false;
        Object.assign(values, data.fields.value.value); LOCALES.forEach((language) => { fields[language].input.value = values[language]; });
        englishEdited = false;
        if (data.fields.value.zhHantStatus === "translated") manuallyEditedChinese.zhHant = false;
        if (data.fields.value.zhHansStatus === "translated") manuallyEditedChinese.zhHans = false;
        translationReceipt = data.receipt;
        if (selectPreview) select("zhHant"); else if (activeLocale !== "en") setValue(element, values[activeLocale]);
        error.textContent = labels().ready; error.hidden = false; save.textContent = labels().save; return true;
      } catch (reason) {
        if (requestId === translationSequence) { error.textContent = reason?.message || labels().failed; error.hidden = false; save.textContent = labels().prepare; }
        return false;
      } finally {
        translating = false; save.disabled = cancel.disabled = false; refreshPrimaryAction();
      }
    }
    auto.addEventListener("change", () => { translationReceipt = ""; translationSequence += 1; refreshPrimaryAction(); });
    replace.addEventListener("change", () => { translationReceipt = ""; translationSequence += 1; refreshPrimaryAction(); });
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const normalized = Object.fromEntries(LOCALES.map((key) => [key, values[key].trim()]));
      if (!normalized.en) { error.textContent = labels().empty; error.hidden = false; return; }
      const page = targetPage(element), key = element.dataset.editableContent;
      if (auto.checked && !translationReceipt) {
        await prepareTranslation(true);
        return;
      }
      if (LOCALES.some((language) => !normalized[language])) { error.textContent = labels().empty; error.hidden = false; return; }
      save.disabled = cancel.disabled = true;
      const expectedUpdatedAtByLocale = { ...baseUpdatedAtByLocale };
      try {
        const response = await fetch("/api/content/update", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ page, key, values: normalized, expectedUpdatedAtByLocale, translationReceipt: auto.checked ? translationReceipt : undefined }) });
        const data = await response.json().catch(() => null);
        if (response.status === 409 || response.status === 428) throw new Error(labels().conflict);
        if (!response.ok) throw new Error(data?.error || labels().failed);
        store = data.content || store; close(false); await loadContent().catch(() => applyContent()); window.iHearToast?.(labels().saved); window.iHearLiveContent?.announce("content", data.revision);
      } catch (reason) { save.disabled = cancel.disabled = false; error.textContent = reason?.message || labels().failed; error.hidden = false; }
    });
    active = { dialog, element, baseUpdatedAtByLocale, dirty, close: () => close(true) }; dialog.showModal();
  }

  function openEditor(element) { if (!session?.user?.isAdmin || active) return; createEditor(element); }
  function isDirty() { return Boolean(active?.dirty()); }

  async function fetchContentStore(context) {
    const requestedPage = slots().map(targetPage).find((scope) => scope !== "/__global__") || pageKey;
    const query = new URLSearchParams({ page: requestedPage }); if (context?.revision) query.set("live", String(context.revision));
    const response = await fetch(`/api/content/get?${query}`, { credentials: "same-origin", cache: "no-store" });
    if (!response.ok) { if (context) throw new Error("content load failed"); return; }
    return response.json();
  }

  async function shouldBlockContent(context) {
    if (!active?.dirty()) return false;
    const latest = await fetchContentStore(context);
    if (!latest) return true;
    const page = targetPage(active.element), key = active.element.dataset.editableContent;
    const changed = LOCALES.some((sourceLocale) => {
      const latestVersion = latest.locales?.[sourceLocale]?.itemUpdatedAt?.[page]?.[key] || null;
      return latestVersion !== active.baseUpdatedAtByLocale[sourceLocale];
    });
    if (changed) return true;
    prefetchedContent = { revision: String(context?.revision || ""), data: latest };
    return false;
  }

  async function loadContent(context) {
    const revision = String(context?.revision || "");
    const prefetched = prefetchedContent && prefetchedContent.revision === revision ? prefetchedContent.data : null;
    prefetchedContent = null;
    const latest = prefetched || await fetchContentStore(context);
    if (!latest) return;
    store = latest; applyContent(); renderAdminControls(); if (notice) notice.hidden = true;
  }

  async function boot() {
    installStyles();
    try { const data = await fetch("/assets/content-slots.json", { cache: "force-cache" }).then((response) => response.json()); catalog = new Map(data.slots.map((slot) => [`${slot.page}\u0000${slot.key}`, slot])); } catch {}
    await loadContent().catch(() => undefined); applyContent(); renderAdminControls();
  }

  window.addEventListener("ihear:auth", (event) => { session = event.detail?.session || null; renderAdminControls(); });
  window.addEventListener("ihear:before-language", (event) => { if (isDirty() && !confirm(labels().cancel + "?")) event.preventDefault(); else if (active) active.close(); });
  window.addEventListener("ihear:language", () => { applyContent(); renderAdminControls(); });
  window.addEventListener("beforeunload", (event) => { if (isDirty()) { event.preventDefault(); event.returnValue = ""; } });
  window.iHearInlineEdit = { refresh: loadContent, getContent: () => store, isDirty };
  window.iHearLiveContent?.register("content", { refresh: loadContent, isDirty, shouldBlock: shouldBlockContent, onBlocked: () => showNotice(labels().conflict) });
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot, { once: true }); else boot();
})();
