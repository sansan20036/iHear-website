(function () {
  "use strict";

  const page = (() => {
    let value = location.pathname || "/";
    if (value.endsWith(".html")) value = value.slice(0, -5);
    return value === "/index" ? "/" : value.replace(/\/$/, "") || "/";
  })();
  const emptyConfig = () => ({ hiddenSections: [], orders: {}, links: {} });
  const clone = (value) => typeof structuredClone === "function" ? structuredClone(value) : JSON.parse(JSON.stringify(value));
  const safe = (value) => CSS.escape(String(value));
  const linkDefaults = new WeakMap();
  const groupDefaults = new WeakMap();
  let payload = window.__IHEAR_SITE_LAYOUT__ || { version: 1, page, records: [] };
  let metadata = null;
  let metadataError = false;
  let metadataPromise = null;
  let session = null;
  let dialog = null;
  let trigger = null;
  let previewBar = null;
  let drafts = null;
  let originals = null;
  let baseOrders = new Map();
  let activeTab = "sections";
  let view = "settings";
  let selectedKey = "";
  let submitting = false;
  let submitError = "";
  let remoteConflict = false;
  let lastPublished = null;
  let dragged = null;

  const ui = {
    en: {
      trigger: "Adjust this page layout", title: "Adjust this page layout", close: "Close", loading: "Loading page settings…",
      metadataError: "Page settings could not be loaded. Please refresh and try again.", sections: "Section visibility", groups: "Card order", links: "Button links",
      shared: "Shared across the site", shown: "Shown", hidden: "Hidden", viewPage: "View on page", hide: "Hide", configure: "Settings", reorder: "Adjust order",
      noSettings: "There are no settings of this type on this page.", up: "Move up", down: "Move down", testLink: "Test this link", validUrl: "The link format is valid.",
      invalidUrl: "Enter a page path, an HTTPS address, or an email link.", usedAt: "Used at", affects: (count) => `This shared link appears in ${count} places. Publishing updates every location.`,
      dirty: (count) => `${count} unpublished ${count === 1 ? "change" : "changes"}`, discard: "Discard changes", preview: "Preview", review: "Review and publish",
      previewMode: "Previewing unpublished layout changes", returnSettings: "Return to settings", reviewTitle: "Review your changes", pageChanges: "This page", globalChanges: "Across the site",
      showChange: (label) => `Show “${label}”`, hideChange: (label) => `Hide “${label}”`, orderChange: (label) => `Change the order of “${label}”`, linkChange: (label) => `Update “${label}”`,
      back: "Back to editing", publish: "Confirm publish", publishing: "Publishing…", published: "Page layout published.", failed: "We could not publish these changes. Your draft is still here.",
      undo: "Undo this publish", undoing: "Undoing…", undone: "The previous layout was restored.", remote: "This layout changed in another tab. Your draft is safe, but publishing is paused.", reload: "Discard draft and load latest",
      moved: (label, position, total) => `${label} moved to position ${position} of ${total}.`, pageName: "Current page", drag: "Drag to reorder", linkLabel: "Link address",
    },
    zhHant: {
      trigger: "調整本頁版面", title: "調整本頁版面", close: "關閉", loading: "正在載入頁面設定…",
      metadataError: "無法載入頁面設定，請重新整理後再試一次。", sections: "區塊顯示", groups: "卡片順序", links: "按鈕連結",
      shared: "全站共用", shown: "顯示中", hidden: "已隱藏", viewPage: "在頁面中查看", hide: "隱藏", configure: "設定", reorder: "調整順序",
      noSettings: "本頁沒有這一類設定。", up: "上移", down: "下移", testLink: "測試開啟連結", validUrl: "網址格式正確。",
      invalidUrl: "請輸入站內網址、HTTPS 網址或 Email 連結。", usedAt: "使用位置", affects: (count) => `此共用連結使用於全站 ${count} 個位置，發布後會同步更新。`,
      dirty: (count) => `尚有 ${count} 項未發布變更`, discard: "放棄變更", preview: "預覽", review: "檢查並發布",
      previewMode: "正在預覽尚未發布的版面變更", returnSettings: "返回設定", reviewTitle: "確認發布內容", pageChanges: "本頁", globalChanges: "全站",
      showChange: (label) => `顯示「${label}」`, hideChange: (label) => `隱藏「${label}」`, orderChange: (label) => `調整「${label}」的順序`, linkChange: (label) => `更新「${label}」`,
      back: "返回修改", publish: "確認發布", publishing: "發布中…", published: "本頁版面已發布。", failed: "發布失敗，您的草稿仍保留在這裡。",
      undo: "復原剛才發布", undoing: "正在復原…", undone: "已恢復先前的版面設定。", remote: "其他分頁已更新版面。您的草稿仍在，但目前暫停發布。", reload: "放棄草稿並載入最新設定",
      moved: (label, position, total) => `${label} 已移至第 ${position} 個位置，共 ${total} 個。`, pageName: "目前頁面", drag: "拖曳以調整順序", linkLabel: "連結網址",
    },
    zhHans: {
      trigger: "调整本页版面", title: "调整本页版面", close: "关闭", loading: "正在加载页面设置…",
      metadataError: "无法加载页面设置，请刷新后再试一次。", sections: "区块显示", groups: "卡片顺序", links: "按钮链接",
      shared: "全站共用", shown: "显示中", hidden: "已隐藏", viewPage: "在页面中查看", hide: "隐藏", configure: "设置", reorder: "调整顺序",
      noSettings: "本页没有这一类设置。", up: "上移", down: "下移", testLink: "测试打开链接", validUrl: "网址格式正确。",
      invalidUrl: "请输入站内网址、HTTPS 网址或 Email 链接。", usedAt: "使用位置", affects: (count) => `此共用链接用于全站 ${count} 个位置，发布后会同步更新。`,
      dirty: (count) => `还有 ${count} 项未发布更改`, discard: "放弃更改", preview: "预览", review: "检查并发布",
      previewMode: "正在预览尚未发布的版面更改", returnSettings: "返回设置", reviewTitle: "确认发布内容", pageChanges: "本页", globalChanges: "全站",
      showChange: (label) => `显示“${label}”`, hideChange: (label) => `隐藏“${label}”`, orderChange: (label) => `调整“${label}”的顺序`, linkChange: (label) => `更新“${label}”`,
      back: "返回修改", publish: "确认发布", publishing: "发布中…", published: "本页版面已发布。", failed: "发布失败，您的草稿仍保留在这里。",
      undo: "撤销刚才发布", undoing: "正在撤销…", undone: "已恢复之前的版面设置。", remote: "其他标签页已更新版面。您的草稿仍在，但目前暂停发布。", reload: "放弃草稿并加载最新设置",
      moved: (label, position, total) => `${label} 已移至第 ${position} 个位置，共 ${total} 个。`, pageName: "当前页面", drag: "拖动以调整顺序", linkLabel: "链接网址",
    },
  };

  function locale() {
    const value = window.iHearLanguage?.locale?.() || document.documentElement.lang || "en";
    if (/hans|zh-cn/i.test(value)) return "zhHans";
    if (/hant|zh-tw/i.test(value)) return "zhHant";
    return "en";
  }
  function words() { return ui[locale()]; }
  function local(value) { return value?.[locale()] || value?.en || ""; }
  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function button(text, className = "") {
    const node = element("button", className, text);
    node.type = "button";
    return node;
  }
  function currentRecord(scope) {
    return payload.records.find((item) => item.page === scope) || { page: scope, config: emptyConfig(), recordVersion: 1, updatedAt: "" };
  }
  function combine(records) {
    const config = emptyConfig();
    for (const item of records) {
      config.hiddenSections.push(...(item.config.hiddenSections || []));
      Object.assign(config.orders, item.config.orders || {});
      Object.assign(config.links, item.config.links || {});
    }
    config.hiddenSections = [...new Set(config.hiddenSections)];
    return config;
  }
  function merged() { return combine(payload.records || []); }
  function mergedDrafts() { return drafts ? combine([...drafts.values()]) : merged(); }
  function styleConfig(config) {
    let style = document.getElementById("ihear-layout-bootstrap-style");
    if (!style) { style = document.createElement("style"); style.id = "ihear-layout-bootstrap-style"; document.head.appendChild(style); }
    let css = config.hiddenSections.map((key) => `[data-layout-section="${safe(key)}"]{display:none!important}`).join("");
    for (const [group, order] of Object.entries(config.orders)) {
      order.forEach((id, index) => { css += `[data-layout-group="${safe(group)}"]>[data-layout-item="${safe(id)}"]{order:${index}}`; });
    }
    style.textContent = css;
  }
  function moveExisting(container, order) {
    const active = document.activeElement;
    const nodes = new Map(Array.from(container.querySelectorAll(":scope > [data-layout-item]"), (node) => [node.dataset.layoutItem, node]));
    for (const id of order) {
      const node = nodes.get(id);
      if (node) container.appendChild(node);
    }
    if (active instanceof HTMLElement && document.contains(active)) active.focus({ preventScroll: true });
  }
  function applyConfig(config) {
    styleConfig(config);
    document.querySelectorAll("[data-layout-group]").forEach((container) => {
      const order = config.orders[container.dataset.layoutGroup] || groupDefaults.get(container);
      if (order) moveExisting(container, order);
    });
    document.querySelectorAll("[data-layout-link]").forEach((link) => {
      const defaults = linkDefaults.get(link) || { href: link.getAttribute("href") || "", target: link.getAttribute("target"), rel: link.getAttribute("rel") };
      const configured = config.links[link.dataset.layoutLink];
      const href = configured || defaults.href;
      link.setAttribute("href", href);
      if (/^https:/i.test(href)) { link.target = "_blank"; link.rel = "noopener noreferrer"; }
      else {
        if (defaults.target) link.setAttribute("target", defaults.target); else link.removeAttribute("target");
        if (defaults.rel) link.setAttribute("rel", defaults.rel); else link.removeAttribute("rel");
      }
    });
  }
  function apply() { applyConfig(merged()); }
  function applyDrafts() { applyConfig(mergedDrafts()); }

  async function loadMetadata() {
    if (metadata) return metadata;
    if (!metadataPromise) metadataPromise = fetch("/assets/layout-slots.json", { cache: "no-store", credentials: "same-origin" })
      .then(async (response) => {
        if (!response.ok) throw new Error("metadata");
        const result = await response.json();
        if (result.version !== 2 || !Array.isArray(result.pages) || !Array.isArray(result.sections) || !Array.isArray(result.groups) || !Array.isArray(result.links)) throw new Error("metadata");
        metadata = result; metadataError = false; return result;
      })
      .catch((error) => { metadataError = true; throw error; });
    return metadataPromise;
  }
  function scopeFor(node) { return node?.dataset.layoutPage || page; }
  function matchingNode(entry, kind) {
    const attribute = kind === "sections" ? "layoutSection" : kind === "groups" ? "layoutGroup" : "layoutLink";
    return Array.from(document.querySelectorAll(entry.previewSelector)).find((node) => scopeFor(node) === entry.page && node.dataset[attribute] === entry.key) || null;
  }
  function entries(kind) {
    if (!metadata) return [];
    return metadata[kind].filter((entry) => matchingNode(entry, kind));
  }
  function pageLabel() {
    return local(metadata?.pages.find((item) => item.page === page)?.label) || words().pageName;
  }
  function validHref(value) { return /^\/(?!\/)[^\s]*$/.test(value) || /^https:\/\/[^\s]+$/i.test(value) || /^mailto:[^\s]+$/i.test(value); }
  function same(left, right) { return JSON.stringify(left) === JSON.stringify(right); }
  function changedScopes() {
    if (!drafts || !originals) return [];
    return [...drafts.keys()].filter((scope) => !same(drafts.get(scope).config, originals.get(scope).config));
  }
  function isDirty() { return changedScopes().length > 0; }
  function effectiveOrder(source, entry) {
    return source.config.orders[entry.key] || baseOrders.get(`${entry.page}\0${entry.key}`) || entry.items.map((item) => item.id);
  }
  function effectiveLink(source, entry) {
    return source.config.links[entry.key] || entry.defaultHref || matchingNode(entry, "links")?.getAttribute("href") || "";
  }
  function changes() {
    if (!drafts || !originals || !metadata) return [];
    const result = [];
    for (const entry of entries("sections")) {
      const before = originals.get(entry.page).config.hiddenSections.includes(entry.key);
      const after = drafts.get(entry.page).config.hiddenSections.includes(entry.key);
      if (before !== after) result.push({ scope: entry.page, text: after ? words().hideChange(local(entry.label)) : words().showChange(local(entry.label)) });
    }
    for (const entry of entries("groups")) {
      if (!same(effectiveOrder(originals.get(entry.page), entry), effectiveOrder(drafts.get(entry.page), entry))) result.push({ scope: entry.page, text: words().orderChange(local(entry.label)) });
    }
    for (const entry of entries("links")) {
      if (effectiveLink(originals.get(entry.page), entry) !== effectiveLink(drafts.get(entry.page), entry)) result.push({ scope: entry.page, text: words().linkChange(local(entry.label)) });
    }
    return result;
  }
  function hasInvalidLinks() {
    return entries("links").some((entry) => {
      const value = effectiveLink(drafts.get(entry.page), entry);
      return !validHref(value);
    });
  }

  async function refresh(context) {
    const updateOpenDraft = Boolean(dialog && !isDirty() && !submitting);
    const suffix = context?.revision ? `&live=${encodeURIComponent(context.revision)}` : "";
    const response = await fetch(`/api/site-layout?page=${encodeURIComponent(page)}${suffix}`, { cache: "no-store", credentials: "same-origin" });
    if (!response.ok) throw new Error("layout load failed");
    payload = await response.json(); apply(); if (updateOpenDraft) { initDrafts(); renderDrawer(); }
  }

  function initDrafts() {
    const scopes = new Set([page]);
    for (const kind of ["sections", "groups", "links"]) entries(kind).forEach((entry) => scopes.add(entry.page));
    originals = new Map(); drafts = new Map(); baseOrders = new Map();
    for (const scope of scopes) {
      const source = currentRecord(scope);
      originals.set(scope, { ...source, config: clone(source.config) });
      drafts.set(scope, { ...source, config: clone(source.config) });
    }
    for (const entry of entries("groups")) {
      const container = matchingNode(entry, "groups");
      baseOrders.set(`${entry.page}\0${entry.key}`, [...(groupDefaults.get(container) || Array.from(container.querySelectorAll(":scope > [data-layout-item]"), (node) => node.dataset.layoutItem))]);
    }
    submitError = ""; remoteConflict = false; view = "settings";
  }

  function setSection(entry, shown) {
    const draft = drafts.get(entry.page), hidden = draft.config.hiddenSections;
    draft.config.hiddenSections = shown ? hidden.filter((key) => key !== entry.key) : [...new Set([...hidden, entry.key])];
    applyDrafts(); renderDrawer();
  }
  function setOrder(entry, order) {
    const draft = drafts.get(entry.page), original = originals.get(entry.page);
    if (!Object.prototype.hasOwnProperty.call(original.config.orders, entry.key) && same(order, effectiveOrder(original, entry))) delete draft.config.orders[entry.key];
    else draft.config.orders[entry.key] = [...order];
    const container = matchingNode(entry, "groups");
    if (container) moveExisting(container, order);
    styleConfig(mergedDrafts());
  }
  function reorder(entry, from, to, focusId) {
    const order = [...effectiveOrder(drafts.get(entry.page), entry)];
    if (from < 0 || to < 0 || from >= order.length || to >= order.length || from === to) return;
    const [moved] = order.splice(from, 1); order.splice(to, 0, moved); setOrder(entry, order);
    renderDrawer();
    const focusTarget = dialog?.querySelector(`[data-layout-sort-item="${safe(focusId || moved)}"]`);
    focusTarget?.focus({ preventScroll: true });
    const live = dialog?.querySelector(".ihear-layout-live");
    if (live) live.textContent = words().moved(local(entry.items.find((item) => item.id === moved)?.label), to + 1, order.length);
  }
  function setLink(entry, value) {
    const draft = drafts.get(entry.page), original = originals.get(entry.page), normalized = value.trim();
    if (!Object.prototype.hasOwnProperty.call(original.config.links, entry.key) && normalized === effectiveLink(original, entry)) delete draft.config.links[entry.key];
    else draft.config.links[entry.key] = normalized;
    applyDrafts(); updateFooter();
  }

  function highlight(entry, kind, scroll) {
    const target = matchingNode(entry, kind);
    if (!target) return;
    const visible = target.getBoundingClientRect().bottom > 0 && target.getBoundingClientRect().top < innerHeight;
    if (scroll) {
      if (kind === "sections" && drafts.get(entry.page).config.hiddenSections.includes(entry.key)) target.classList.add("ihear-layout-peek");
      target.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "center" });
    }
    if (scroll || visible) target.classList.add("ihear-layout-highlight");
    clearTimeout(target.__ihearHighlightTimer);
    target.__ihearHighlightTimer = setTimeout(() => target.classList.remove("ihear-layout-highlight", "ihear-layout-peek"), scroll ? 2400 : 400);
  }
  function bindHighlight(row, entry, kind) {
    row.addEventListener("mouseenter", () => highlight(entry, kind, false));
    row.addEventListener("mouseleave", () => matchingNode(entry, kind)?.classList.remove("ihear-layout-highlight"));
  }

  function renderHeader(form) {
    const header = element("header", "ihear-layout-header");
    const heading = element("div");
    const title = element("h2", "", words().title); title.id = "ihear-layout-title";
    heading.append(title, element("p", "", pageLabel()));
    const languages = element("div", "ihear-layout-languages");
    for (const [code, label, targetLocale] of [["en", "EN", "en"], ["zhTW", "繁", "zhHant"], ["zhCN", "简", "zhHans"]]) {
      const language = button(label); language.disabled = submitting; language.setAttribute("aria-pressed", String(locale() === targetLocale));
      language.addEventListener("click", () => window.iHearSetLanguage?.(code)); languages.appendChild(language);
    }
    heading.appendChild(languages);
    const close = button("×", "ihear-layout-close"); close.setAttribute("aria-label", words().close); close.disabled = submitting; close.addEventListener("click", () => closeDrawer(true));
    header.append(heading, close); form.appendChild(header);
  }
  function renderTabs(form) {
    const available = ["sections", "groups", "links"].filter((kind) => entries(kind).length);
    if (!available.includes(activeTab)) activeTab = available[0] || "sections";
    const tabs = element("div", "ihear-layout-tabs"); tabs.setAttribute("role", "tablist"); tabs.setAttribute("aria-label", words().title);
    for (const kind of ["sections", "groups", "links"]) {
      const tab = button(words()[kind], "ihear-layout-tab");
      tab.id = `ihear-layout-tab-${kind}`; tab.setAttribute("role", "tab"); tab.setAttribute("aria-selected", String(activeTab === kind));
      tab.setAttribute("aria-controls", `ihear-layout-panel-${kind}`); tab.disabled = !entries(kind).length || submitting;
      tab.addEventListener("click", () => { activeTab = kind; selectedKey = ""; renderDrawer(); }); tabs.appendChild(tab);
    }
    form.appendChild(tabs);
  }
  function sharedBadge(entry) { return entry.page === "/__global__" ? element("span", "ihear-layout-badge", words().shared) : null; }
  function viewButton(entry, kind) {
    const node = button(words().viewPage, "ihear-layout-view"); node.addEventListener("click", () => highlight(entry, kind, true)); return node;
  }
  function renderSections(panel) {
    const list = element("div", "ihear-layout-list");
    for (const entry of entries("sections")) {
      const row = element("article", `ihear-layout-card${selectedKey === entry.key ? " is-selected" : ""}`); bindHighlight(row, entry, "sections");
      const copy = element("div", "ihear-layout-card-copy");
      const line = element("div", "ihear-layout-card-title"); line.append(element("h3", "", local(entry.label))); const badge = sharedBadge(entry); if (badge) line.append(badge);
      copy.append(line, element("p", "", local(entry.description)), viewButton(entry, "sections"));
      const label = element("label", "ihear-layout-switch");
      const input = document.createElement("input"); input.type = "checkbox"; input.role = "switch"; input.checked = !drafts.get(entry.page).config.hiddenSections.includes(entry.key); input.disabled = submitting;
      const state = element("span", "", input.checked ? words().shown : words().hidden);
      input.setAttribute("aria-label", `${local(entry.label)}: ${state.textContent}`);
      input.addEventListener("change", () => setSection(entry, input.checked)); label.append(input, state); row.append(copy, label); list.appendChild(row);
    }
    panel.appendChild(list);
  }
  function itemThumbnail(entry, item) {
    const container = matchingNode(entry, "groups"), source = container?.querySelector(`:scope > [data-layout-item="${safe(item.id)}"] img`);
    if (source?.currentSrc || source?.getAttribute("src")) {
      const image = document.createElement("img"); image.className = "ihear-layout-thumb"; image.src = source.currentSrc || source.getAttribute("src"); image.alt = ""; return image;
    }
    const icon = element("span", "ihear-layout-thumb ihear-layout-thumb-icon", entry.icon === "quote" ? "❝" : entry.icon === "book" ? "▤" : "◆"); icon.setAttribute("aria-hidden", "true"); return icon;
  }
  function renderGroups(panel) {
    for (const entry of entries("groups")) {
      const section = element("section", `ihear-layout-group-card${selectedKey === entry.key ? " is-selected" : ""}`); bindHighlight(section, entry, "groups");
      const heading = element("div", "ihear-layout-group-heading"); const copy = element("div");
      const title = element("div", "ihear-layout-card-title"); title.append(element("h3", "", local(entry.label))); const badge = sharedBadge(entry); if (badge) title.append(badge);
      copy.append(title, element("p", "", local(entry.description))); heading.append(copy, viewButton(entry, "groups")); section.appendChild(heading);
      const list = element("div", "ihear-layout-sort-list"); const order = effectiveOrder(drafts.get(entry.page), entry);
      order.forEach((id, index) => {
        const item = entry.items.find((candidate) => candidate.id === id); if (!item) return;
        const row = element("div", "ihear-layout-sort-item"); row.tabIndex = 0; row.draggable = !submitting; row.dataset.layoutSortItem = id; row.setAttribute("aria-label", `${local(item.label)}, ${index + 1}/${order.length}. ${words().drag}`);
        row.append(itemThumbnail(entry, item));
        const copyNode = element("div", "ihear-layout-sort-copy"); copyNode.append(element("strong", "", local(item.label)), element("small", "", local(item.description))); row.appendChild(copyNode);
        const actions = element("div", "ihear-layout-sort-actions"); const up = button("↑", ""), down = button("↓", "");
        up.setAttribute("aria-label", `${words().up}: ${local(item.label)}`); down.setAttribute("aria-label", `${words().down}: ${local(item.label)}`);
        up.disabled = submitting || index === 0; down.disabled = submitting || index === order.length - 1;
        up.addEventListener("click", () => reorder(entry, index, index - 1, id)); down.addEventListener("click", () => reorder(entry, index, index + 1, id)); actions.append(up, down); row.appendChild(actions);
        row.addEventListener("keydown", (event) => { if (!(event.altKey || event.ctrlKey) || !["ArrowUp", "ArrowDown"].includes(event.key)) return; event.preventDefault(); reorder(entry, index, index + (event.key === "ArrowUp" ? -1 : 1), id); });
        row.addEventListener("dragstart", (event) => { dragged = { entry, id }; event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", id); row.classList.add("is-dragging"); });
        row.addEventListener("dragend", () => { dragged = null; row.classList.remove("is-dragging"); });
        row.addEventListener("dragover", (event) => { if (dragged?.entry.key === entry.key) event.preventDefault(); });
        row.addEventListener("drop", (event) => { event.preventDefault(); if (dragged?.entry.key !== entry.key) return; reorder(entry, order.indexOf(dragged.id), index, dragged.id); });
        list.appendChild(row);
      });
      section.appendChild(list); panel.appendChild(section);
    }
  }
  function renderLinks(panel) {
    const list = element("div", "ihear-layout-list");
    for (const entry of entries("links")) {
      const card = element("article", `ihear-layout-card ihear-layout-link-card${selectedKey === entry.key ? " is-selected" : ""}`); bindHighlight(card, entry, "links");
      const title = element("div", "ihear-layout-card-title"); title.append(element("h3", "", local(entry.label))); const badge = sharedBadge(entry); if (badge) title.append(badge);
      card.append(title, element("p", "", local(entry.description)));
      const position = element("p", "ihear-layout-location", `${words().usedAt}: ${local(entry.locations)}`); card.appendChild(position);
      if (entry.shared) card.appendChild(element("p", "ihear-layout-impact", words().affects(entry.usageCount || 1)));
      const label = element("label", "ihear-layout-url-label", words().linkLabel); const input = document.createElement("input");
      input.type = "text"; input.inputMode = "url"; input.autocomplete = "url"; input.disabled = submitting; input.value = effectiveLink(drafts.get(entry.page), entry); input.dataset.layoutLinkInput = "";
      const validation = element("span", "ihear-layout-validation"); validation.setAttribute("aria-live", "polite");
      const test = element("a", "ihear-layout-test-link", words().testLink); test.target = "_blank"; test.rel = "noopener noreferrer";
      const updateValidation = () => { const valid = validHref(input.value.trim()); validation.textContent = valid ? words().validUrl : words().invalidUrl; validation.dataset.valid = String(valid); test.href = valid ? input.value.trim() : "#"; test.setAttribute("aria-disabled", String(!valid)); };
      input.addEventListener("input", () => { setLink(entry, input.value); updateValidation(); }); test.addEventListener("click", (event) => { if (!validHref(input.value.trim())) event.preventDefault(); });
      label.appendChild(input); card.append(label, validation, test, viewButton(entry, "links")); updateValidation(); list.appendChild(card);
    }
    panel.appendChild(list);
  }
  function renderSettings(form) {
    renderTabs(form);
    const panel = element("div", "ihear-layout-panel"); panel.id = `ihear-layout-panel-${activeTab}`; panel.setAttribute("role", "tabpanel"); panel.setAttribute("aria-labelledby", `ihear-layout-tab-${activeTab}`);
    if (!entries(activeTab).length) panel.appendChild(element("p", "ihear-layout-empty", words().noSettings));
    else if (activeTab === "sections") renderSections(panel); else if (activeTab === "groups") renderGroups(panel); else renderLinks(panel);
    form.appendChild(panel); renderFooter(form);
  }
  function renderConflict(form) {
    if (!remoteConflict) return;
    const alert = element("div", "ihear-layout-conflict"); alert.setAttribute("role", "alert"); alert.append(element("p", "", words().remote));
    const reload = button(words().reload); reload.disabled = submitting; reload.addEventListener("click", async () => { closeDrawer(true, false); await refresh(); await openDrawer(activeTab); }); alert.appendChild(reload); form.appendChild(alert);
  }
  function renderFooter(form) {
    renderConflict(form);
    const footer = element("footer", "ihear-layout-footer"); footer.dataset.layoutFooter = "";
    const count = changes().length; const status = element("p", "ihear-layout-dirty", count ? words().dirty(count) : ""); status.dataset.layoutDirty = ""; footer.appendChild(status);
    if (submitError) { const error = element("p", "ihear-layout-error", submitError); error.setAttribute("role", "alert"); footer.appendChild(error); }
    const actions = element("div", "ihear-layout-actions");
    const discard = button(words().discard, "ihear-layout-secondary"); discard.disabled = submitting || !count; discard.addEventListener("click", () => closeDrawer(true));
    const preview = button(words().preview, "ihear-layout-secondary"); preview.disabled = submitting || !count || hasInvalidLinks(); preview.addEventListener("click", startPreview);
    const review = button(words().review, "ihear-layout-primary"); review.disabled = submitting || !count || hasInvalidLinks() || remoteConflict; review.addEventListener("click", () => { view = "review"; renderDrawer(); });
    actions.append(discard, preview, review); footer.appendChild(actions); form.appendChild(footer);
  }
  function updateFooter() {
    const footer = dialog?.querySelector("[data-layout-footer]"); if (!footer) return;
    const form = footer.parentElement; footer.remove(); renderFooter(form);
  }
  function renderReview(form) {
    const body = element("div", "ihear-layout-review"); body.appendChild(element("h3", "", words().reviewTitle));
    for (const [scope, heading] of [[page, words().pageChanges], ["/__global__", words().globalChanges]]) {
      const scoped = changes().filter((item) => item.scope === scope); if (!scoped.length) continue;
      body.appendChild(element("h4", "", heading)); const list = element("ul"); scoped.forEach((item) => list.appendChild(element("li", "", item.text))); body.appendChild(list);
    }
    form.appendChild(body); renderConflict(form);
    const footer = element("footer", "ihear-layout-footer");
    if (submitError) { const error = element("p", "ihear-layout-error", submitError); error.setAttribute("role", "alert"); footer.appendChild(error); }
    const actions = element("div", "ihear-layout-actions"); const back = button(words().back, "ihear-layout-secondary"); back.disabled = submitting; back.addEventListener("click", () => { view = "settings"; submitError = ""; renderDrawer(); });
    const publish = button(submitting ? words().publishing : words().publish, "ihear-layout-primary ihear-layout-publish"); publish.disabled = submitting || remoteConflict; publish.setAttribute("aria-busy", String(submitting));
    if (submitting) { const spinner = element("span", "ihear-layout-spinner"); spinner.setAttribute("aria-hidden", "true"); publish.prepend(spinner); }
    publish.addEventListener("click", publishDrafts); actions.append(back, publish); footer.appendChild(actions); form.appendChild(footer);
  }
  function renderDrawer() {
    if (!dialog) return;
    const form = element("form", "ihear-layout-form"); form.setAttribute("aria-busy", String(submitting)); form.addEventListener("submit", (event) => event.preventDefault());
    renderHeader(form); if (view === "review") renderReview(form); else renderSettings(form);
    const live = element("p", "ihear-layout-live"); live.setAttribute("aria-live", "polite"); live.setAttribute("aria-atomic", "true"); form.appendChild(live);
    dialog.replaceChildren(form);
    if (submitting) dialog.querySelectorAll("input,button").forEach((control) => { control.disabled = true; });
  }

  function startPreview() {
    if (submitting || !isDirty()) return;
    dialog.close();
    previewBar = element("div", "ihear-layout-preview-bar"); previewBar.setAttribute("role", "region"); previewBar.setAttribute("aria-label", words().previewMode);
    previewBar.append(element("strong", "", words().previewMode));
    const actions = element("div"); const back = button(words().returnSettings), discard = button(words().discard), review = button(words().review, "ihear-layout-primary");
    back.addEventListener("click", endPreview); discard.addEventListener("click", () => closeDrawer(true)); review.addEventListener("click", () => { endPreview(); view = "review"; renderDrawer(); });
    actions.append(back, discard, review); previewBar.appendChild(actions); document.body.appendChild(previewBar); back.focus();
  }
  function endPreview() { previewBar?.remove(); previewBar = null; if (dialog && !dialog.open) dialog.showModal(); }

  async function publishDrafts() {
    if (submitting || remoteConflict) return;
    const scopes = changedScopes(); if (!scopes.length || hasInvalidLinks()) return;
    submitting = true; submitError = ""; renderDrawer();
    const previous = scopes.map((scope) => ({ page: scope, config: clone(originals.get(scope).config) }));
    const updates = scopes.map((scope) => ({ page: scope, config: clone(drafts.get(scope).config), expectedVersion: originals.get(scope).recordVersion }));
    try {
      const response = await fetch("/api/site-layout", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ updates }) });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) { if (response.status === 409) remoteConflict = true; throw new Error(response.status === 409 ? words().remote : words().failed); }
      for (const record of result.records || []) { const index = payload.records.findIndex((item) => item.page === record.page); if (index >= 0) payload.records[index] = record; else payload.records.push(record); }
      lastPublished = { previous, records: clone(result.records || []) }; window.iHearLiveContent?.announce("layout", result.revision); submitting = false; closeDrawer(false); apply(); showUndo(words().published);
    } catch (error) {
      submitting = false; submitError = error instanceof Error && error.message ? error.message : words().failed; renderDrawer();
    }
  }
  function showUndo(message) {
    document.querySelector(".ihear-layout-undo")?.remove(); const toast = element("div", "ihear-layout-undo"); toast.setAttribute("role", "status"); toast.append(element("span", "", message));
    const undo = button(words().undo); undo.addEventListener("click", async () => {
      if (!lastPublished || undo.disabled) return; undo.disabled = true; undo.textContent = words().undoing;
      const updates = lastPublished.previous.map((item) => ({ page: item.page, config: item.config, expectedVersion: lastPublished.records.find((record) => record.page === item.page)?.recordVersion }));
      try {
        const response = await fetch("/api/site-layout", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ updates }) });
        const result = await response.json().catch(() => ({})); if (!response.ok) throw new Error(words().failed);
        for (const record of result.records || []) { const index = payload.records.findIndex((item) => item.page === record.page); if (index >= 0) payload.records[index] = record; else payload.records.push(record); }
        window.iHearLiveContent?.announce("layout", result.revision); lastPublished = null; apply(); toast.firstChild.textContent = words().undone; undo.remove(); setTimeout(() => toast.remove(), 5000);
      } catch (error) { undo.disabled = false; undo.textContent = words().undo; toast.firstChild.textContent = error instanceof Error ? error.message : words().failed; }
    });
    toast.appendChild(undo); document.body.appendChild(toast); setTimeout(() => { if (!lastPublished) toast.remove(); }, 8000);
  }

  function openErrorDialog() {
    if (dialog) return; dialog = document.createElement("dialog"); dialog.className = "ihear-layout-dialog ihear-layout-drawer"; dialog.setAttribute("aria-labelledby", "ihear-layout-title");
    const form = element("form", "ihear-layout-form"); renderHeader(form); const alert = element("p", "ihear-layout-error", words().metadataError); alert.setAttribute("role", "alert"); form.appendChild(alert); dialog.appendChild(form); document.body.appendChild(dialog);
    dialog.addEventListener("cancel", (event) => { event.preventDefault(); closeDrawer(false); }); dialog.showModal();
  }
  async function openDrawer(tab = activeTab, key = "") {
    if (dialog || submitting) return;
    activeTab = tab; selectedKey = key;
    try { await loadMetadata(); } catch { openErrorDialog(); return; }
    initDrafts(); dialog = document.createElement("dialog"); dialog.className = "ihear-layout-dialog ihear-layout-drawer"; dialog.setAttribute("aria-labelledby", "ihear-layout-title"); document.body.appendChild(dialog);
    dialog.addEventListener("cancel", (event) => { event.preventDefault(); if (!submitting) closeDrawer(true); }); renderDrawer(); dialog.showModal();
  }
  function closeDrawer(restore, returnFocus = true) {
    if (submitting) return;
    previewBar?.remove(); previewBar = null;
    if (restore) apply();
    if (dialog?.open) dialog.close(); dialog?.remove(); dialog = null; drafts = null; originals = null; baseOrders = new Map(); remoteConflict = false; submitError = ""; view = "settings";
    if (returnFocus) trigger?.focus();
  }

  function removeControls() { trigger?.remove(); trigger = null; }
  function controls() {
    removeControls();
    if (!session?.user?.isAdmin || !document.querySelector("[data-layout-section],[data-layout-group],[data-layout-link]")) return;
    trigger = button("", "ihear-layout-trigger");
    const triggerIcon = element("span", "ihear-layout-trigger-icon", "⚙"); triggerIcon.setAttribute("aria-hidden", "true");
    const triggerLabel = element("span", "", words().trigger); triggerLabel.dataset.layoutTriggerLabel = ""; trigger.append(triggerIcon, triggerLabel);
    trigger.setAttribute("aria-label", words().trigger); trigger.addEventListener("click", () => openDrawer()); document.body.appendChild(trigger);
    loadMetadata().catch(() => {});
  }

  document.querySelectorAll("[data-layout-link]").forEach((link) => linkDefaults.set(link, { href: link.getAttribute("href") || "", target: link.getAttribute("target"), rel: link.getAttribute("rel") }));
  document.querySelectorAll("[data-layout-group]").forEach((container) => groupDefaults.set(container, Array.from(container.querySelectorAll(":scope > [data-layout-item]"), (node) => node.dataset.layoutItem)));
  window.addEventListener("ihear:auth", (event) => { session = event.detail?.session || null; controls(); });
  window.addEventListener("ihear:language", () => { if (trigger) { const label = trigger.querySelector("[data-layout-trigger-label]"); if (label) label.textContent = words().trigger; trigger.setAttribute("aria-label", words().trigger); } if (dialog && !metadataError) renderDrawer(); });
  window.addEventListener("beforeunload", (event) => { if (!isDirty()) return; event.preventDefault(); event.returnValue = ""; });
  window.iHearLiveContent?.register("layout", {
    refresh,
    isDirty: () => isDirty() || submitting,
    onBlocked: () => { remoteConflict = true; if (dialog) renderDrawer(); },
  });
  window.iHearSiteLayout = { apply, refresh, moveExisting, open: openDrawer };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => { apply(); controls(); }, { once: true }); else { apply(); controls(); }
})();
