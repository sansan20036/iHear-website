(function () {
  "use strict";

  const mount = document.querySelector("[data-impact-milestones]");
  if (!mount) return;

  const labelsByLocale = {
    en: {
      manager: "Journey timeline manager",
      managerHint: "Edit every date, title, description, and impact metric.",
      editMode: "Edit mode",
      done: "Done editing",
      add: "Add timeline item",
      edit: "Edit",
      draft: "Draft",
      published: "Published",
      archived: "Archived",
      empty: "No published milestones yet.",
      newTitle: "Add a timeline item",
      editTitle: "Edit timeline item",
      editorHint: "Dates, titles, descriptions, and metrics are stored in the database.",
      basicData: "Basic data",
      basicDataHint: "Choose the date and enter structured impact numbers.",
      localizedContent: "Multilingual content",
      localizedContentHint: "Edit one language and optionally translate it into the others.",
      kind: "Item type",
      eventKind: "Journey event",
      metricsKind: "Impact metrics",
      title: "Title",
      period: "Month",
      volunteers: "Volunteers",
      students: "Students",
      sessions: "Sessions",
      showPlus: "Show + after number",
      description: "Description",
      preview: "Live preview",
      previewLanguage: "Preview language",
      previewEmpty: "Not entered yet",
      filled: "Filled",
      missing: "Missing",
      translatingShort: "Translating",
      saveDraft: "Save draft",
      publish: "Publish",
      cancel: "Cancel",
      deleteItem: "Delete timeline item",
      close: "Close editor",
      saved: "Milestone saved.",
      deletedNotice: "Timeline item permanently deleted.",
      loadFailed: "Could not load the latest impact data.",
      saveFailed: "Could not save this milestone.",
      conflict: "Someone else updated this milestone. Your draft is still here; reload before saving again.",
      validation: "Please review the highlighted fields.",
      requiredTranslations: "All three descriptions are required before publishing.",
      draftDescription: "Add at least one description before saving a draft.",
      unsaved: "Discard your unsaved changes?",
      deleteConfirm: "Permanently delete this timeline item? This cannot be undone.",
      autoTranslate: "Automatically translate into the other languages",
      translationHint: "Translation starts 0.8 seconds after you stop typing. Manually edited languages are preserved.",
      translateNow: "Translate now",
      translating: "Translating…",
      translated: "Other languages updated.",
      translationUnavailable: "Add OPENAI_API_KEY on the server to enable automatic translation.",
      translationFailed: "Automatic translation failed. Your text is safe; you can keep editing manually.",
      noTranslationTargets: "The other languages were manually edited, so they were not overwritten.",
      zhHant: "繁體中文",
      zhHans: "简体中文",
      english: "English",
      sessionsLabel: "sessions",
      studentsLabel: "students",
      volunteersLabel: "volunteers",
    },
    zhHant: {
      manager: "歷程資料管理",
      managerHint: "日期、標題、說明與成果數字都可以編輯。",
      editMode: "進入編輯模式",
      done: "完成編輯",
      add: "新增歷程",
      edit: "編輯",
      draft: "草稿",
      published: "已發布",
      archived: "已封存",
      empty: "目前沒有已發布的成果。",
      newTitle: "新增時間軸項目",
      editTitle: "編輯時間軸項目",
      editorHint: "日期、標題、說明與成果數字都會儲存在資料庫。",
      basicData: "基本資料",
      basicDataHint: "設定年月，並輸入可獨立管理的成果數字。",
      localizedContent: "多語文案",
      localizedContentHint: "編輯其中一種語言，並視需要自動翻譯至其他語言。",
      kind: "項目類型",
      eventKind: "一般歷程",
      metricsKind: "成果數據",
      title: "標題",
      period: "年月",
      volunteers: "志工人數",
      students: "學生人數",
      sessions: "堂數",
      showPlus: "數字後顯示 +",
      description: "說明文案",
      preview: "即時預覽",
      previewLanguage: "預覽語言",
      previewEmpty: "尚未填寫",
      filled: "已填寫",
      missing: "未填寫",
      translatingShort: "翻譯中",
      saveDraft: "儲存草稿",
      publish: "發布",
      cancel: "取消",
      deleteItem: "刪除本歷程",
      close: "關閉編輯器",
      saved: "成果資料已儲存。",
      deletedNotice: "本歷程已永久刪除。",
      loadFailed: "暫時無法載入最新成果資料。",
      saveFailed: "無法儲存這筆成果資料。",
      conflict: "另一位管理員已更新這筆資料。你的草稿仍保留，請重新載入後再儲存。",
      validation: "請檢查標示的欄位。",
      requiredTranslations: "發布前必須完成三種語言的說明文案。",
      draftDescription: "儲存草稿前至少填寫一種語言的說明。",
      unsaved: "要放棄尚未儲存的修改嗎？",
      deleteConfirm: "確定要永久刪除本歷程嗎？刪除後無法復原。",
      autoTranslate: "自動翻譯成其他語言",
      translationHint: "停止輸入 0.8 秒後自動翻譯；手動改過的語言不會被覆蓋。",
      translateNow: "立即翻譯",
      translating: "翻譯中…",
      translated: "其他語言已更新。",
      translationUnavailable: "請先在伺服器設定 OPENAI_API_KEY，才能使用自動翻譯。",
      translationFailed: "自動翻譯失敗，原文仍完整保留，可繼續手動編輯。",
      noTranslationTargets: "其他語言已手動修改，因此沒有覆蓋。",
      zhHant: "繁體中文",
      zhHans: "简体中文",
      english: "English",
      sessionsLabel: "堂課",
      studentsLabel: "位學生",
      volunteersLabel: "位志工",
    },
    zhHans: {
      manager: "历程数据管理",
      managerHint: "日期、标题、说明与成果数字都可以编辑。",
      editMode: "进入编辑模式",
      done: "完成编辑",
      add: "新增历程",
      edit: "编辑",
      draft: "草稿",
      published: "已发布",
      archived: "已归档",
      empty: "目前没有已发布的成果。",
      newTitle: "新增时间轴项目",
      editTitle: "编辑时间轴项目",
      editorHint: "日期、标题、说明与成果数字都会储存在数据库。",
      basicData: "基本数据",
      basicDataHint: "设置年月，并输入可独立管理的成果数字。",
      localizedContent: "多语言文案",
      localizedContentHint: "编辑其中一种语言，并按需自动翻译至其他语言。",
      kind: "项目类型",
      eventKind: "一般历程",
      metricsKind: "成果数据",
      title: "标题",
      period: "年月",
      volunteers: "志愿者人数",
      students: "学生人数",
      sessions: "课数",
      showPlus: "数字后显示 +",
      description: "说明文案",
      preview: "即时预览",
      previewLanguage: "预览语言",
      previewEmpty: "尚未填写",
      filled: "已填写",
      missing: "未填写",
      translatingShort: "翻译中",
      saveDraft: "保存草稿",
      publish: "发布",
      cancel: "取消",
      deleteItem: "删除本历程",
      close: "关闭编辑器",
      saved: "成果数据已保存。",
      deletedNotice: "本历程已永久删除。",
      loadFailed: "暂时无法加载最新成果数据。",
      saveFailed: "无法保存这笔成果数据。",
      conflict: "另一位管理员已更新这笔数据。你的草稿仍保留，请重新加载后再保存。",
      validation: "请检查标示的字段。",
      requiredTranslations: "发布前必须完成三种语言的说明文案。",
      draftDescription: "保存草稿前至少填写一种语言的说明。",
      unsaved: "要放弃尚未保存的修改吗？",
      deleteConfirm: "确定要永久删除本历程吗？删除后无法恢复。",
      autoTranslate: "自动翻译成其他语言",
      translationHint: "停止输入 0.8 秒后自动翻译；手动修改过的语言不会被覆盖。",
      translateNow: "立即翻译",
      translating: "翻译中…",
      translated: "其他语言已更新。",
      translationUnavailable: "请先在服务器设置 OPENAI_API_KEY，才能使用自动翻译。",
      translationFailed: "自动翻译失败，原文仍完整保留，可继续手动编辑。",
      noTranslationTargets: "其他语言已手动修改，因此没有覆盖。",
      zhHant: "繁體中文",
      zhHans: "简体中文",
      english: "English",
      sessionsLabel: "节课",
      studentsLabel: "位学生",
      volunteersLabel: "位志愿者",
    },
  };

  const state = {
    milestones: [],
    isAdmin: false,
    editMode: false,
    loadingAdmin: false,
    draft: null,
    originalDraft: "",
    activeLocale: "zhHant",
    previewLocale: "zhHant",
    busy: false,
    autoTranslate: true,
    translationStatus: "",
    manualLocales: new Set(),
    translationTimer: null,
    translationAbort: null,
    translationRequestId: 0,
    translatingLocales: new Set(),
  };

  const fallbackHtml = mount.innerHTML;
  const adminBar = document.createElement("div");
  const dialog = document.createElement("dialog");
  const toast = document.createElement("div");
  let toastTimer = null;

  adminBar.className = "impact-milestones-admin";
  adminBar.hidden = true;
  adminBar.setAttribute("data-no-inline-edit", "");
  mount.parentElement.insertBefore(adminBar, mount);

  dialog.className = "impact-milestone-editor";
  dialog.setAttribute("aria-modal", "true");
  dialog.setAttribute("data-no-inline-edit", "");
  document.body.appendChild(dialog);

  toast.className = "impact-toast";
  toast.hidden = true;
  toast.setAttribute("role", "status");
  toast.setAttribute("aria-live", "polite");
  document.body.appendChild(toast);

  function locale() {
    const lang = (document.documentElement.lang || "en").toLowerCase();
    if (lang.includes("hans")) return "zhHans";
    if (lang.startsWith("zh")) return "zhHant";
    return "en";
  }

  function labels() {
    return labelsByLocale[locale()] || labelsByLocale.en;
  }

  function labelsFor(requestedLocale) {
    return labelsByLocale[requestedLocale || locale()] || labelsByLocale.en;
  }

  function formatMetric(value, plus, requestedLocale) {
    const key = requestedLocale || locale();
    const numberLocale = key === "en" ? "en-US" : key === "zhHans" ? "zh-CN" : "zh-TW";
    return `${Number(value || 0).toLocaleString(numberLocale)}${plus ? "+" : ""}`;
  }

  function formatPeriod(period, requestedLocale) {
    const key = requestedLocale || locale();
    const parts = String(period || "").split("-");
    const year = Number(parts[0]);
    const month = Number(parts[1]);
    if (!year || !month) return period || "—";
    if (key === "en") {
      return new Intl.DateTimeFormat("en-US", { year: "numeric", month: "long", timeZone: "UTC" })
        .format(new Date(Date.UTC(year, month - 1, 1)));
    }
    return `${year} 年 ${String(month).padStart(2, "0")} 月`;
  }

  function metricHeadline(item, requestedLocale) {
    const key = requestedLocale || locale();
    const l = labelsFor(key);
    const volunteers = formatMetric(item.volunteers, item.volunteersPlus, key);
    const students = formatMetric(item.students, item.studentsPlus, key);
    const sessions = formatMetric(item.sessions, item.sessionsPlus, key);
    return `${volunteers} ${l.volunteersLabel} · ${students} ${l.studentsLabel} · ${sessions} ${l.sessionsLabel}`;
  }

  function descriptionFor(item, requestedLocale) {
    const key = requestedLocale || locale();
    const description = item.description || {};
    return description[key] || description.zhHant || description.en || description.zhHans || "";
  }

  function titleFor(item, requestedLocale) {
    const key = requestedLocale || locale();
    const title = item.title || {};
    return title[key] || title.zhHant || title.en || title.zhHans || "";
  }

  function sorted(items) {
    return [...items].sort((a, b) => Number(a.sortOrder) - Number(b.sortOrder) || a.period.localeCompare(b.period));
  }

  function button(text, className, handler) {
    const element = document.createElement("button");
    element.type = "button";
    element.className = `impact-button ${className || ""}`.trim();
    element.textContent = text;
    element.addEventListener("click", handler);
    return element;
  }

  function showToast(message, isError) {
    if (toastTimer) window.clearTimeout(toastTimer);
    toast.textContent = message;
    toast.classList.toggle("is-error", Boolean(isError));
    toast.hidden = false;
    toastTimer = window.setTimeout(() => {
      toast.hidden = true;
    }, isError ? 6000 : 3500);
  }

  function renderAdminBar() {
    if (!state.isAdmin) {
      adminBar.hidden = true;
      adminBar.innerHTML = "";
      return;
    }

    const l = labels();
    adminBar.hidden = false;
    adminBar.innerHTML = "";

    const copy = document.createElement("div");
    copy.className = "impact-admin-copy";
    const strong = document.createElement("strong");
    const hint = document.createElement("span");
    strong.textContent = l.manager;
    hint.textContent = l.managerHint;
    copy.append(strong, hint);

    const actions = document.createElement("div");
    actions.className = "impact-admin-actions";
    actions.append(
      button(state.editMode ? l.done : l.editMode, "", () => {
        state.editMode = !state.editMode;
        render();
      }),
      button(l.add, "impact-button-accent", () => openEditor()),
    );

    adminBar.append(copy, actions);
  }

  function render() {
    renderAdminBar();
    const l = labels();
    const visible = sorted(state.milestones).filter((item) => {
      if (state.isAdmin && state.editMode) return true;
      return item.status === "published";
    });

    if (!visible.length) {
      mount.innerHTML = "";
      const empty = document.createElement("div");
      empty.className = "impact-empty";
      empty.textContent = l.empty;
      mount.appendChild(empty);
      return;
    }

    const published = visible.filter((item) => item.status === "published");
    const latestPublished = published.length ? published[published.length - 1].id : "";
    mount.innerHTML = "";

    visible.forEach((item) => {
      const article = document.createElement("div");
      article.className = "tl-item";
      article.classList.toggle("hl", item.id === latestPublished);
      article.classList.toggle("is-draft", item.status === "draft");
      article.classList.toggle("is-archived", item.status === "archived");
      article.dataset.impactId = item.id;
      article.setAttribute("data-no-inline-edit", "");

      const when = document.createElement("div");
      const title = document.createElement("h3");
      const description = document.createElement("p");
      when.className = "when";
      when.textContent = formatPeriod(item.period);
      title.textContent = item.kind === "event" ? titleFor(item) : metricHeadline(item);
      description.textContent = descriptionFor(item);

      if (state.isAdmin && state.editMode) {
        const badge = document.createElement("span");
        badge.className = "impact-status-badge";
        badge.textContent = l[item.status] || item.status;
        when.appendChild(badge);
      }

      article.append(when, title, description);

      if (state.isAdmin && state.editMode) {
        const actions = document.createElement("div");
        actions.className = "impact-item-actions";
        actions.append(button(l.edit, "", () => openEditor(item)));
        article.appendChild(actions);
      }

      mount.appendChild(article);
    });
  }

  function newDraft() {
    const now = new Date();
    const period = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    return {
      id: null,
      kind: "event",
      period,
      volunteers: 0,
      volunteersPlus: true,
      students: 0,
      studentsPlus: true,
      sessions: 0,
      sessionsPlus: true,
      title: { zhHant: "", zhHans: "", en: "" },
      description: { zhHant: "", zhHans: "", en: "" },
      status: "draft",
      sortOrder: Number(period.replace("-", "")),
      version: 1,
    };
  }

  function copyDraft(item) {
    return JSON.parse(JSON.stringify(item || newDraft()));
  }

  function openEditor(item) {
    state.draft = copyDraft(item);
    state.originalDraft = JSON.stringify(state.draft);
    state.activeLocale = locale() === "en" ? "en" : locale();
    state.previewLocale = state.activeLocale;
    state.autoTranslate = true;
    state.translationStatus = "";
    state.manualLocales = new Set();
    state.translatingLocales = new Set();
    state.translationRequestId += 1;
    buildEditor();
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
    const first = dialog.querySelector("input");
    if (first) first.focus();
  }

  function isDirty() {
    return Boolean(state.draft) && JSON.stringify(state.draft) !== state.originalDraft;
  }

  function closeEditor(force) {
    if (!force && isDirty() && !window.confirm(labels().unsaved)) return;
    cancelPendingTranslation();
    state.busy = false;
    state.draft = null;
    state.originalDraft = "";
    if (typeof dialog.close === "function" && dialog.open) dialog.close();
    else dialog.removeAttribute("open");
  }

  function editorMarkup() {
    const l = labels();
    const isEdit = Boolean(state.draft && state.draft.id);
    return `
      <div class="impact-editor-shell">
        <header class="impact-editor-header">
          <div>
            <h3 id="impact-editor-title">${isEdit ? l.editTitle : l.newTitle}</h3>
            <p>${l.editorHint}</p>
          </div>
          <button class="impact-editor-close" type="button" data-impact-close aria-label="${l.close}">×</button>
        </header>
        <form class="impact-editor-body" data-impact-form novalidate>
          <section class="impact-form-section" aria-labelledby="impact-basic-heading">
            <header class="impact-section-heading">
              <span class="impact-section-index" aria-hidden="true">01</span>
              <div>
                <h4 id="impact-basic-heading">${l.basicData}</h4>
                <p>${l.basicDataHint}</p>
              </div>
            </header>
            <div class="impact-basic-grid">
              <div class="impact-field impact-field-kind">
                <label for="impact-kind">${l.kind}</label>
                <select id="impact-kind" name="kind">
                  <option value="event">${l.eventKind}</option>
                  <option value="metrics">${l.metricsKind}</option>
                </select>
                <span class="impact-field-error" data-error="kind"></span>
              </div>
              <div class="impact-field impact-field-period">
                <label for="impact-period">${l.period}</label>
                <input id="impact-period" name="period" type="month" required>
                <span class="impact-field-error" data-error="period"></span>
              </div>
              ${numberFieldMarkup("volunteers", l.volunteers)}
              ${numberFieldMarkup("students", l.students)}
              ${numberFieldMarkup("sessions", l.sessions)}
            </div>
          </section>

          <section class="impact-form-section" aria-labelledby="impact-content-heading">
            <header class="impact-section-heading">
              <span class="impact-section-index" aria-hidden="true">02</span>
              <div>
                <h4 id="impact-content-heading">${l.localizedContent}</h4>
                <p>${l.localizedContentHint}</p>
              </div>
            </header>
            <div class="impact-field impact-field-wide impact-localized-editor">
              <div class="impact-tabs" role="tablist" aria-label="${l.description}">
                ${tabMarkup("zhHant", l.zhHant)}
                ${tabMarkup("zhHans", l.zhHans)}
                ${tabMarkup("en", l.english)}
              </div>
              <div class="impact-translation-tools">
                <label class="impact-auto-translate">
                  <input type="checkbox" data-auto-translate ${state.autoTranslate ? "checked" : ""}>
                  <span>${l.autoTranslate}</span>
                </label>
                <button class="impact-button impact-translate-now" type="button" data-translate-now>${l.translateNow}</button>
              </div>
              <p class="impact-translation-hint">${l.translationHint}</p>
              <p class="impact-translation-status" data-translation-status aria-live="polite"></p>
              ${descriptionPanelMarkup("zhHant", l.zhHant)}
              ${descriptionPanelMarkup("zhHans", l.zhHans)}
              ${descriptionPanelMarkup("en", l.english)}
              <span class="impact-field-error" data-error="title"></span>
              <span class="impact-field-error" data-error="description"></span>
            </div>
          </section>
          <div class="impact-form-error" data-impact-form-error hidden></div>
          <section class="impact-preview">
            <header class="impact-preview-header">
              <span class="impact-preview-label">${l.preview}</span>
              <div class="impact-preview-language">
                <span>${l.previewLanguage}</span>
                <div class="impact-preview-tabs" aria-label="${l.previewLanguage}">
                  ${previewTabMarkup("zhHant", l.zhHant)}
                  ${previewTabMarkup("zhHans", l.zhHans)}
                  ${previewTabMarkup("en", l.english)}
                </div>
              </div>
            </header>
            <div class="impact-preview-content" aria-live="polite">
              <div class="when" data-preview-period></div>
              <h4 data-preview-title></h4>
              <p data-preview-description></p>
            </div>
          </section>
          <footer class="impact-editor-footer">
            <div data-impact-destructive></div>
            <div class="impact-editor-actions">
              <button class="impact-button" type="button" data-impact-cancel>${l.cancel}</button>
              <button class="impact-button impact-button-primary" type="button" data-impact-save-draft>${l.saveDraft}</button>
              <button class="impact-button impact-button-accent" type="submit">${l.publish}</button>
            </div>
          </footer>
        </form>
      </div>
    `;
  }

  function numberFieldMarkup(name, label) {
    const l = labels();
    return `
      <div class="impact-field impact-number-field" data-metrics-field>
        <label for="impact-${name}">${label}</label>
        <input id="impact-${name}" name="${name}" type="number" min="0" max="10000000" step="1" required>
        <label class="impact-plus-toggle"><input name="${name}Plus" type="checkbox"> ${l.showPlus}</label>
        <span class="impact-field-error" data-error="${name}"></span>
      </div>
    `;
  }

  function tabMarkup(key, label) {
    return `<button class="impact-tab" type="button" role="tab" data-locale-tab="${key}" aria-controls="impact-panel-${key}"><span>${label}</span><span class="impact-tab-state-text" data-tab-state-text></span><span class="impact-tab-status" aria-hidden="true"></span></button>`;
  }

  function previewTabMarkup(key, label) {
    return `<button type="button" data-preview-locale="${key}" aria-pressed="false">${label}</button>`;
  }

  function descriptionPanelMarkup(key, label) {
    const l = labels();
    return `<div role="tabpanel" id="impact-panel-${key}" data-locale-panel="${key}">
      <div class="impact-localized-title" data-title-field>
        <label for="impact-title-${key}">${l.title} — ${label}</label>
        <input id="impact-title-${key}" name="title.${key}" type="text" maxlength="200">
        <span class="impact-field-error" data-error="title.${key}"></span>
      </div>
      <label class="impact-localized-description" for="impact-description-${key}">${l.description} — ${label}</label>
      <textarea id="impact-description-${key}" name="description.${key}" maxlength="2000"></textarea>
      <span class="impact-field-error" data-error="description.${key}"></span>
    </div>`;
  }

  function buildEditor() {
    dialog.setAttribute("aria-labelledby", "impact-editor-title");
    dialog.innerHTML = editorMarkup();

    const form = dialog.querySelector("[data-impact-form]");
    form.elements.kind.value = state.draft.kind || "metrics";
    form.elements.period.value = state.draft.period || "";
    ["volunteers", "students", "sessions"].forEach((name) => {
      form.elements[name].value = state.draft[name];
      form.elements[`${name}Plus`].checked = Boolean(state.draft[`${name}Plus`]);
    });
    ["zhHant", "zhHans", "en"].forEach((key) => {
      form.elements[`title.${key}`].value = (state.draft.title && state.draft.title[key]) || "";
      form.elements[`description.${key}`].value = state.draft.description[key] || "";
    });

    const destructive = dialog.querySelector("[data-impact-destructive]");
    if (state.draft.id) {
      destructive.appendChild(button(labels().deleteItem, "impact-button-danger", deleteCurrent));
    }

    dialog.querySelector("[data-impact-close]").addEventListener("click", () => closeEditor(false));
    dialog.querySelector("[data-impact-cancel]").addEventListener("click", () => closeEditor(false));
    dialog.querySelector("[data-impact-save-draft]").addEventListener("click", () => saveCurrent("draft"));
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      saveCurrent("published");
    });
    form.addEventListener("input", handleEditorInput);
    form.addEventListener("change", handleEditorInput);
    dialog.querySelector("[data-auto-translate]").addEventListener("change", (event) => {
      state.autoTranslate = event.currentTarget.checked;
      if (!state.autoTranslate) cancelPendingTranslation();
      state.translationStatus = "";
      updateEditor();
      updateTranslationStatus();
    });
    dialog.querySelector("[data-translate-now]").addEventListener("click", () => {
      translateFrom(state.activeLocale, true);
    });
    dialog.querySelectorAll("[data-locale-tab]").forEach((tab) => {
      tab.addEventListener("click", () => setActiveLocale(tab.dataset.localeTab));
      tab.addEventListener("keydown", handleTabKeydown);
    });
    dialog.querySelectorAll("[data-preview-locale]").forEach((tab) => {
      tab.addEventListener("click", () => {
        state.previewLocale = tab.dataset.previewLocale;
        updateEditor();
      });
    });

    updateEditor();
  }

  function handleEditorInput(event) {
    const target = event.target;
    if (!target.name || !state.draft) return;
    let sourceLocale = "";
    if (target.name.startsWith("title.")) {
      sourceLocale = target.name.split(".")[1];
      state.draft.title[sourceLocale] = target.value;
    } else if (target.name.startsWith("description.")) {
      sourceLocale = target.name.split(".")[1];
      state.draft.description[sourceLocale] = target.value;
    } else if (target.type === "checkbox") {
      state.draft[target.name] = target.checked;
    } else if (["volunteers", "students", "sessions"].includes(target.name)) {
      state.draft[target.name] = target.value === "" ? "" : Number(target.value);
    } else {
      state.draft[target.name] = target.value;
      if (target.name === "period" && /^\d{4}-\d{2}$/.test(target.value)) {
        state.draft.sortOrder = Number(target.value.replace("-", ""));
      }
    }
    if (sourceLocale) {
      state.activeLocale = sourceLocale;
      state.manualLocales.add(sourceLocale);
      scheduleAutoTranslation(sourceLocale);
    }
    clearEditorErrors();
    updateEditor();
  }

  function cancelPendingTranslation() {
    if (state.translationTimer) window.clearTimeout(state.translationTimer);
    state.translationTimer = null;
    if (state.translationAbort) state.translationAbort.abort();
    state.translationAbort = null;
    state.translatingLocales = new Set();
  }

  function scheduleAutoTranslation(sourceLocale) {
    state.translationRequestId += 1;
    cancelPendingTranslation();
    state.translationStatus = "";
    if (!state.autoTranslate || !state.draft) return;
    const requestId = state.translationRequestId;
    state.translationTimer = window.setTimeout(() => {
      state.translationTimer = null;
      translateFrom(sourceLocale, false, requestId);
    }, 800);
  }

  async function translateFrom(sourceLocale, force, scheduledRequestId) {
    if (!state.draft || state.busy) return;
    const title = (state.draft.title[sourceLocale] || "").trim();
    const description = (state.draft.description[sourceLocale] || "").trim();
    if (!title && !description) return;

    cancelPendingTranslation();
    const targetLocales = ["zhHant", "zhHans", "en"].filter(
      (key) => key !== sourceLocale && !state.manualLocales.has(key),
    );
    if (!targetLocales.length) {
      state.translationStatus = labels().noTranslationTargets;
      updateTranslationStatus();
      return;
    }

    const requestId = scheduledRequestId || ++state.translationRequestId;
    if (!force && requestId !== state.translationRequestId) return;
    const controller = new AbortController();
    state.translationAbort = controller;
    state.translatingLocales = new Set(targetLocales);
    state.translationStatus = labels().translating;
    updateEditor();
    updateTranslationStatus(true);

    try {
      const response = await fetch("/api/impact-milestones/translate", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({ sourceLocale, targetLocales, title, description }),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        const error = new Error((data && data.error) || labels().translationFailed);
        error.status = response.status;
        error.code = data && data.code;
        throw error;
      }
      if (!state.draft || requestId !== state.translationRequestId) return;

      Object.entries(data.translations || {}).forEach(([key, translation]) => {
        if (!targetLocales.includes(key) || state.manualLocales.has(key) || !translation) return;
        state.draft.title[key] = translation.title || "";
        state.draft.description[key] = translation.description || "";
        const titleInput = dialog.querySelector(`[name="title.${key}"]`);
        const descriptionInput = dialog.querySelector(`[name="description.${key}"]`);
        if (titleInput) titleInput.value = state.draft.title[key];
        if (descriptionInput) descriptionInput.value = state.draft.description[key];
      });
      state.translatingLocales = new Set();
      state.translationStatus = labels().translated;
      clearEditorErrors();
      updateEditor();
    } catch (error) {
      if (error.name === "AbortError") return;
      state.translatingLocales = new Set();
      if (error.code === "TRANSLATION_NOT_CONFIGURED" || error.status === 503) {
        state.autoTranslate = false;
        const toggle = dialog.querySelector("[data-auto-translate]");
        if (toggle) toggle.checked = false;
        state.translationStatus = labels().translationUnavailable;
      } else {
        state.translationStatus = labels().translationFailed;
      }
      updateEditor();
      updateTranslationStatus(false, true);
    } finally {
      if (state.translationAbort === controller) state.translationAbort = null;
    }
  }

  function updateTranslationStatus(isLoading, isError) {
    const node = dialog.querySelector("[data-translation-status]");
    if (!node) return;
    node.textContent = state.translationStatus;
    node.classList.toggle("is-loading", Boolean(isLoading));
    node.classList.toggle("is-error", Boolean(isError));
  }

  function setActiveLocale(key) {
    state.activeLocale = key;
    updateEditor();
    const textarea = dialog.querySelector(`[name="description.${key}"]`);
    if (textarea) textarea.focus();
  }

  function handleTabKeydown(event) {
    if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
    event.preventDefault();
    const keys = ["zhHant", "zhHans", "en"];
    const current = keys.indexOf(event.currentTarget.dataset.localeTab);
    const next = event.key === "ArrowRight" ? (current + 1) % keys.length : (current + keys.length - 1) % keys.length;
    setActiveLocale(keys[next]);
  }

  function updateEditor() {
    if (!state.draft) return;
    dialog.querySelectorAll("[data-locale-tab]").forEach((tab) => {
      const key = tab.dataset.localeTab;
      const selected = key === state.activeLocale;
      tab.setAttribute("aria-selected", String(selected));
      tab.tabIndex = selected ? 0 : -1;
      const hasDescription = Boolean((state.draft.description[key] || "").trim());
      const hasTitle = state.draft.kind !== "event" || Boolean((state.draft.title[key] || "").trim());
      const status = state.translatingLocales.has(key)
        ? "translating"
        : hasDescription && hasTitle
          ? "complete"
          : "empty";
      tab.dataset.state = status;
      tab.dataset.complete = String(status === "complete");
      const statusText = tab.querySelector("[data-tab-state-text]");
      if (statusText) {
        statusText.textContent = `(${status === "translating" ? labels().translatingShort : status === "complete" ? labels().filled : labels().missing})`;
      }
    });
    dialog.querySelectorAll("[data-locale-panel]").forEach((panel) => {
      panel.hidden = panel.dataset.localePanel !== state.activeLocale;
    });
    dialog.querySelectorAll("[data-metrics-field]").forEach((field) => {
      field.hidden = state.draft.kind !== "metrics";
    });
    dialog.querySelectorAll("[data-title-field]").forEach((field) => {
      field.hidden = state.draft.kind !== "event";
    });

    dialog.querySelectorAll("[data-preview-locale]").forEach((tab) => {
      tab.setAttribute("aria-pressed", String(tab.dataset.previewLocale === state.previewLocale));
    });

    const previewTitle = state.draft.kind === "event"
      ? (state.draft.title[state.previewLocale] || "").trim()
      : metricHeadline(state.draft, state.previewLocale);
    const previewDescription = (state.draft.description[state.previewLocale] || "").trim();
    dialog.querySelector("[data-preview-period]").textContent = formatPeriod(state.draft.period, state.previewLocale);
    dialog.querySelector("[data-preview-title]").textContent = state.draft.kind === "event"
      ? previewTitle || labels().previewEmpty
      : previewTitle;
    dialog.querySelector("[data-preview-description]").textContent = previewDescription || labels().previewEmpty;
    updateTranslationStatus(state.translationStatus === labels().translating, false);
  }

  function clearEditorErrors() {
    dialog.querySelectorAll("[data-error]").forEach((node) => {
      node.textContent = "";
    });
    const formError = dialog.querySelector("[data-impact-form-error]");
    formError.hidden = true;
    formError.textContent = "";
  }

  function validateDraft(status) {
    const errors = {};
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(state.draft.period || "")) errors.period = labels().validation;
    ["volunteers", "students", "sessions"].forEach((name) => {
      const value = state.draft[name];
      if (!Number.isInteger(value) || value < 0 || value > 10000000) errors[name] = labels().validation;
    });
    const completed = ["zhHant", "zhHans", "en"].filter((key) => (state.draft.description[key] || "").trim());
    const completedTitles = ["zhHant", "zhHans", "en"].filter((key) => (state.draft.title[key] || "").trim());
    if (status === "published" && completed.length !== 3) errors.description = labels().requiredTranslations;
    if (status === "draft" && completed.length === 0) errors.description = labels().draftDescription;
    if (state.draft.kind === "event" && status === "published" && completedTitles.length !== 3) {
      errors.title = labels().requiredTranslations;
    }
    if (state.draft.kind === "event" && status === "draft" && completedTitles.length === 0) {
      errors.title = labels().draftDescription;
    }
    return errors;
  }

  function showValidation(errors) {
    clearEditorErrors();
    Object.entries(errors).forEach(([key, message]) => {
      const target = dialog.querySelector(`[data-error="${key}"]`);
      if (target) target.textContent = message;
    });
    const formError = dialog.querySelector("[data-impact-form-error]");
    formError.textContent = labels().validation;
    formError.hidden = false;
  }

  function payloadFor(item, status) {
    return {
      kind: item.kind || "metrics",
      period: item.period,
      volunteers: Number(item.volunteers),
      volunteersPlus: Boolean(item.volunteersPlus),
      students: Number(item.students),
      studentsPlus: Boolean(item.studentsPlus),
      sessions: Number(item.sessions),
      sessionsPlus: Boolean(item.sessionsPlus),
      title: {
        zhHant: ((item.title && item.title.zhHant) || "").trim(),
        zhHans: ((item.title && item.title.zhHans) || "").trim(),
        en: ((item.title && item.title.en) || "").trim(),
      },
      description: {
        zhHant: (item.description.zhHant || "").trim(),
        zhHans: (item.description.zhHans || "").trim(),
        en: (item.description.en || "").trim(),
      },
      status,
      sortOrder: Number(item.sortOrder || String(item.period).replace("-", "")),
      ...(item.id ? { version: Number(item.version) } : {}),
    };
  }

  function setBusy(busy) {
    state.busy = busy;
    dialog.querySelectorAll("button,input,textarea,select").forEach((element) => {
      element.disabled = busy;
    });
  }

  async function saveCurrent(status) {
    if (!state.draft || state.busy) return;
    const errors = validateDraft(status);
    if (Object.keys(errors).length) {
      showValidation(errors);
      return;
    }

    state.draft.status = status;
    setBusy(true);
    try {
      const isEdit = Boolean(state.draft.id);
      const response = await fetch(
        isEdit ? `/api/impact-milestones/${encodeURIComponent(state.draft.id)}` : "/api/impact-milestones",
        {
          method: isEdit ? "PATCH" : "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payloadFor(state.draft, status)),
        },
      );
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        const error = new Error((data && data.error) || labels().saveFailed);
        error.status = response.status;
        error.issues = data && data.issues;
        throw error;
      }
      upsertMilestone(data.milestone);
      closeEditor(true);
      render();
      showToast(labels().saved, false);
    } catch (error) {
      setBusy(false);
      if (error.status === 409) {
        const formError = dialog.querySelector("[data-impact-form-error]");
        formError.textContent = labels().conflict;
        formError.hidden = false;
      } else if (error.issues) {
        showValidation(error.issues);
      } else {
        showToast(error.message || labels().saveFailed, true);
      }
    }
  }

  async function deleteCurrent() {
    if (!state.draft || !state.draft.id || state.busy) return;
    if (!window.confirm(labels().deleteConfirm)) return;
    setBusy(true);
    try {
      const response = await fetch(`/api/impact-milestones/${encodeURIComponent(state.draft.id)}`, {
        method: "DELETE",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ version: state.draft.version }),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        const error = new Error((data && data.error) || labels().saveFailed);
        error.status = response.status;
        throw error;
      }
      state.milestones = state.milestones.filter((item) => item.id !== data.deletedId);
      closeEditor(true);
      render();
      showToast(labels().deletedNotice, false);
    } catch (error) {
      setBusy(false);
      showToast(error.status === 409 ? labels().conflict : error.message || labels().saveFailed, true);
    }
  }

  function upsertMilestone(milestone) {
    const index = state.milestones.findIndex((item) => item.id === milestone.id);
    if (index >= 0) state.milestones[index] = milestone;
    else state.milestones.push(milestone);
  }

  async function loadMilestones(includeDrafts) {
    const url = includeDrafts ? "/api/impact-milestones?includeDrafts=true" : "/api/impact-milestones";
    const response = await fetch(url, { credentials: "same-origin", cache: "no-store" });
    if (!response.ok) {
      const error = new Error(labels().loadFailed);
      error.status = response.status;
      throw error;
    }
    const data = await response.json();
    state.milestones = Array.isArray(data.milestones) ? data.milestones : [];
    state.isAdmin = Boolean(data.admin);
    render();
  }

  async function handleSession(session) {
    if (!session || !session.user) {
      state.isAdmin = false;
      state.editMode = false;
      try {
        await loadMilestones(false);
      } catch {
        renderAdminBar();
      }
      return;
    }

    if (state.loadingAdmin) return;
    state.loadingAdmin = true;
    try {
      await loadMilestones(true);
    } catch (error) {
      state.isAdmin = false;
      if (error.status !== 403) showToast(labels().loadFailed, true);
    } finally {
      state.loadingAdmin = false;
      renderAdminBar();
    }
  }

  async function boot() {
    try {
      await loadMilestones(false);
    } catch {
      mount.innerHTML = fallbackHtml;
    }
    const session = window.iHearAuth && window.iHearAuth.getSession();
    if (session) handleSession(session);
  }

  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    closeEditor(false);
  });

  window.addEventListener("beforeunload", (event) => {
    if (!isDirty()) return;
    event.preventDefault();
    event.returnValue = "";
  });

  window.addEventListener("ihear:auth", (event) => {
    handleSession(event.detail && event.detail.session);
  });

  window.addEventListener("ihear:language", () => {
    render();
    if (state.draft) buildEditor();
  });

  new MutationObserver(() => {
    render();
    if (state.draft) updateEditor();
  }).observe(document.documentElement, { attributes: true, attributeFilter: ["lang"] });

  window.iHearImpactMilestones = {
    refresh: () => loadMilestones(state.isAdmin),
    getState: () => ({ ...state, draft: state.draft ? copyDraft(state.draft) : null }),
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
