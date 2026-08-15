(function () {
  "use strict";

  const VENDOR_URL = "/assets/vendor/browser-image-compression.js";
  const MAX_ORIGINAL_BYTES = 20 * 1024 * 1024;
  const MAX_COMPRESSED_BYTES = Math.floor(0.95 * 1024 * 1024);
  const ALLOWED_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
  const FOCAL_VALUES = [0, 50, 100];
  const copy = {
    en: {
      edit: "Change image", title: "Change image", intro: "Upload a photo, preview the crop, and describe it for each language.",
      drop: "Drop an image here or choose a file", formats: "PNG, JPEG, or WebP · up to 20MB", choose: "Choose image",
      altEn: "English image description", altZhHant: "Traditional Chinese image description", altZhHans: "Simplified Chinese image description",
      focal: "Choose the crop focus", cancel: "Cancel", save: "Save image", restore: "Restore default image",
      restoring: "Restoring…", optimizing: "Optimizing image…", uploading: "Uploading…", processing: "Server is preparing responsive images…",
      ready: "Image ready to upload", saved: "Image updated", restored: "Default image restored",
      invalidType: "Choose a PNG, JPEG, or WebP image.", tooLarge: "The original image must be 20MB or smaller.",
      compressionFailed: "The image could not be optimized. No file was uploaded.", invalidOutput: "The optimized image is invalid or larger than 0.95MB.",
      altRequired: "Complete all three image descriptions using 2–300 characters.", failed: "The image could not be updated.",
      forbidden: "Your administrator session has expired.", conflict: "Another administrator changed this image. Reload and try again.",
      confirmRestore: "Restore the original image? The current custom image will be removed.", liveBlocked: "A newer image is available. Finish or cancel this edit to refresh.",
      positions: ["Top left", "Top center", "Top right", "Center left", "Center", "Center right", "Bottom left", "Bottom center", "Bottom right"],
    },
    zhHant: {
      edit: "更換圖片", title: "更換圖片", intro: "上傳照片、預覽裁切位置，並填寫三種語言的圖片描述。",
      drop: "拖曳圖片到這裡，或點擊選擇檔案", formats: "PNG、JPEG 或 WebP · 最大 20MB", choose: "選擇圖片",
      altEn: "英文圖片描述", altZhHant: "繁體中文圖片描述", altZhHans: "簡體中文圖片描述",
      focal: "選擇裁切焦點", cancel: "取消", save: "確認儲存", restore: "恢復預設圖片",
      restoring: "正在恢復…", optimizing: "正在最佳化圖片…", uploading: "正在上傳…", processing: "伺服器正在產生響應式圖片…",
      ready: "圖片已準備好上傳", saved: "圖片已更新", restored: "已恢復預設圖片",
      invalidType: "請選擇 PNG、JPEG 或 WebP 圖片。", tooLarge: "原始圖片不可超過 20MB。",
      compressionFailed: "無法最佳化圖片，未送出任何檔案。", invalidOutput: "最佳化結果無效或超過 0.95MB。",
      altRequired: "三種語言的圖片描述都必須填寫 2–300 個字元。", failed: "無法更新圖片。",
      forbidden: "管理員登入已失效。", conflict: "另一位管理員已更改圖片，請重新整理後再試。",
      confirmRestore: "確定恢復原始圖片？目前的自訂圖片將被移除。", liveBlocked: "已有較新的圖片，請先完成或取消目前編輯。",
      positions: ["左上", "中上", "右上", "左中", "正中", "右中", "左下", "中下", "右下"],
    },
    zhHans: {
      edit: "更换图片", title: "更换图片", intro: "上传照片、预览裁切位置，并填写三种语言的图片描述。",
      drop: "拖曳图片到这里，或点击选择文件", formats: "PNG、JPEG 或 WebP · 最大 20MB", choose: "选择图片",
      altEn: "英文图片描述", altZhHant: "繁体中文图片描述", altZhHans: "简体中文图片描述",
      focal: "选择裁切焦点", cancel: "取消", save: "确认保存", restore: "恢复默认图片",
      restoring: "正在恢复…", optimizing: "正在优化图片…", uploading: "正在上传…", processing: "服务器正在生成响应式图片…",
      ready: "图片已准备好上传", saved: "图片已更新", restored: "已恢复默认图片",
      invalidType: "请选择 PNG、JPEG 或 WebP 图片。", tooLarge: "原始图片不可超过 20MB。",
      compressionFailed: "无法优化图片，未发送任何文件。", invalidOutput: "优化结果无效或超过 0.95MB。",
      altRequired: "三种语言的图片描述都必须填写 2–300 个字符。", failed: "无法更新图片。",
      forbidden: "管理员登录已失效。", conflict: "另一位管理员已更改图片，请刷新后重试。",
      confirmRestore: "确定恢复原始图片？当前的自定义图片将被删除。", liveBlocked: "已有较新的图片，请先完成或取消当前编辑。",
      positions: ["左上", "中上", "右上", "左中", "正中", "右中", "左下", "中下", "右下"],
    },
  };

  const hosts = Array.from(document.querySelectorAll("[data-site-media-slot]"));
  if (!hosts.length) return;
  let currentSession = window.iHearAuth?.getSession?.() || null;

  function createController(host) {
  const slot = host.getAttribute("data-site-media-slot") || "";
  if (!slot) return null;
  const API_URL = `/api/site-media/${encodeURIComponent(slot)}`;
  const picture = host?.querySelector("picture");
  const image = picture?.querySelector("img");
  if (!picture || !image) return null;

  const defaults = {
    sources: Array.from(picture.querySelectorAll("source")).map((source) => ({
      node: source,
      srcset: source.getAttribute("srcset") || "",
      sizes: source.getAttribute("sizes") || "",
      type: source.getAttribute("type") || "",
    })),
    src: image.getAttribute("src") || "",
    alt: {
      en: host.dataset.siteMediaAltEn || image.alt || "Site image",
      zhHant: host.dataset.siteMediaAltZhHant || host.dataset.siteMediaAltEn || image.alt || "網站圖片",
      zhHans: host.dataset.siteMediaAltZhHans || host.dataset.siteMediaAltEn || image.alt || "网站图片",
    },
    objectPosition: image.style.objectPosition || "50% 50%",
  };

  let currentItem = null;
  let dialog = null;
  let editButton = null;
  let compressedFile = null;
  let previewUrl = "";
  let compressionController = null;
  let activeRequest = null;
  let dirty = false;
  let applyToken = 0;

  function locale() {
    const language = (document.documentElement.lang || "en").toLowerCase();
    if (language.includes("hans")) return "zhHans";
    if (language.startsWith("zh")) return "zhHant";
    return "en";
  }

  function labels() { return copy[locale()] || copy.en; }
  function isAdmin() { return Boolean(currentSession?.user?.isAdmin); }

  function restoreDefault() {
    applyToken += 1;
    defaults.sources.forEach(({ node, srcset, sizes, type }) => {
      node.setAttribute("srcset", srcset);
      node.setAttribute("sizes", sizes);
      node.setAttribute("type", type);
    });
    image.src = defaults.src;
    image.alt = defaults.alt[locale()] || defaults.alt.en;
    image.style.objectPosition = defaults.objectPosition;
    host.removeAttribute("data-site-media-custom");
  }

  function commitItem(item) {
    const variants = Array.isArray(item?.variants) ? item.variants : [];
    if (!item?.src || !item?.srcSet || !variants.length) {
      restoreDefault();
      return;
    }
    defaults.sources.forEach(({ node }) => {
      node.setAttribute("srcset", item.srcSet);
      node.setAttribute("type", "image/webp");
    });
    image.src = item.src;
    image.alt = item.alt?.[locale()] || item.alt?.en || defaults.alt.en;
    image.style.objectPosition = `${item.focalX}% ${item.focalY}%`;
    host.setAttribute("data-site-media-custom", "true");
  }

  function applyItem(item) {
    if (!item) {
      restoreDefault();
      return;
    }
    const token = ++applyToken;
    const urls = [...new Set([
      item.src,
      ...(Array.isArray(item.variants) ? item.variants.map((variant) => variant.url) : []),
    ].filter(Boolean))];
    Promise.all(urls.map((url) => new Promise((resolve, reject) => {
      const preload = new Image();
      preload.onload = resolve;
      preload.onerror = reject;
      preload.src = url;
    }))).then(
      () => { if (token === applyToken) commitItem(item); },
      () => { if (token === applyToken) restoreDefault(); },
    );
  }

  function refresh(data) {
    currentItem = data?.items?.[slot] || null;
    applyItem(currentItem);
    renderAdminControl();
    if (dialog?.open && !dirty) populateDialog();
  }

  function renderAdminControl() {
    if (!isAdmin()) {
      editButton?.remove();
      editButton = null;
      return;
    }
    if (!editButton) {
      editButton = document.createElement("button");
      editButton.type = "button";
      editButton.className = "site-media-edit";
      editButton.innerHTML = '<span aria-hidden="true">📷</span><span data-site-media-edit-label></span>';
      editButton.addEventListener("click", openDialog);
      host.appendChild(editButton);
    }
    const text = labels().edit;
    editButton.title = text;
    editButton.setAttribute("aria-label", text);
    editButton.querySelector("[data-site-media-edit-label]").textContent = text;
  }

  function releasePreview() {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = "";
  }

  function setPreviewFile(file) {
    releasePreview();
    previewUrl = URL.createObjectURL(file);
    dialog.querySelector("[data-media-preview]").src = previewUrl;
  }

  function setStatus(message, options) {
    const status = dialog.querySelector("[data-media-status]");
    const progress = dialog.querySelector("[data-media-progress]");
    status.textContent = message || "";
    status.classList.toggle("is-error", Boolean(options?.error));
    progress.hidden = !options?.progress;
    if (options?.progress) {
      if (typeof options.value === "number") progress.value = options.value;
      else progress.removeAttribute("value");
    }
  }

  function setBusy(busy) {
    dialog.toggleAttribute("data-busy", busy);
    dialog.querySelectorAll("button,input").forEach((control) => {
      if (control.matches("[data-media-save]")) control.disabled = busy || !compressedFile;
      else control.disabled = busy;
    });
  }

  function createDialog() {
    const node = document.createElement("dialog");
    node.className = "site-media-dialog";
    node.style.setProperty("--site-media-preview-aspect", host.dataset.siteMediaAspect || "4 / 3.4");
    node.innerHTML = `
      <form method="dialog" class="site-media-form" data-media-form>
        <div class="site-media-dialog-head">
          <div><h2 data-media-title></h2><p data-media-intro></p></div>
          <button type="button" class="site-media-close" data-media-cancel aria-label="Close">×</button>
        </div>
        <label class="site-media-drop" data-media-drop>
          <input type="file" accept="image/png,image/jpeg,image/webp" data-media-file>
          <span class="site-media-camera" aria-hidden="true">📷</span>
          <strong data-media-drop-title></strong><small data-media-formats></small>
          <span class="btn btn-ghost" data-media-choose></span>
          <span class="site-media-file-name" data-media-file-name></span>
        </label>
        <div class="site-media-preview-wrap">
          <div class="site-media-preview-frame"><img data-media-preview alt=""></div>
          <fieldset class="site-media-focal"><legend data-media-focal-title></legend><div class="site-media-focal-grid" data-media-focal-grid></div></fieldset>
        </div>
        <div class="site-media-alt-grid">
          <label><span data-media-alt-en-label></span><input type="text" minlength="2" maxlength="300" data-media-alt-en></label>
          <label><span data-media-alt-zht-label></span><input type="text" minlength="2" maxlength="300" data-media-alt-zht></label>
          <label><span data-media-alt-zhs-label></span><input type="text" minlength="2" maxlength="300" data-media-alt-zhs></label>
        </div>
        <div class="site-media-progress-wrap" aria-live="polite">
          <progress max="100" data-media-progress hidden></progress><p data-media-status></p>
        </div>
        <div class="site-media-actions">
          <button type="button" class="ihear-inline-action site-media-restore" data-media-restore></button>
          <span class="site-media-action-spacer"></span>
          <button type="button" class="ihear-inline-action" data-media-cancel></button>
          <button type="button" class="ihear-inline-action" data-action="save" data-media-save disabled></button>
        </div>
      </form>`;
    document.body.appendChild(node);
    node.querySelectorAll("[data-media-cancel]").forEach((button) => button.addEventListener("click", closeDialog));
    node.querySelector("[data-media-file]").addEventListener("change", (event) => selectFile(event.target.files?.[0]));
    node.querySelector("[data-media-save]").addEventListener("click", saveImage);
    node.querySelector("[data-media-restore]").addEventListener("click", restoreImage);
    const drop = node.querySelector("[data-media-drop]");
    ["dragenter", "dragover"].forEach((name) => drop.addEventListener(name, (event) => {
      event.preventDefault();
      if (!node.hasAttribute("data-busy")) drop.classList.add("is-dragging");
    }));
    ["dragleave", "drop"].forEach((name) => drop.addEventListener(name, (event) => {
      event.preventDefault();
      drop.classList.remove("is-dragging");
    }));
    drop.addEventListener("drop", (event) => {
      if (!node.hasAttribute("data-busy")) selectFile(event.dataTransfer?.files?.[0]);
    });
    node.addEventListener("cancel", (event) => {
      if (node.hasAttribute("data-busy")) event.preventDefault();
      else { event.preventDefault(); closeDialog(); }
    });
    node.querySelectorAll("input[type=text]").forEach((input) => input.addEventListener("input", () => { dirty = true; }));
    return node;
  }

  function renderFocalGrid() {
    const grid = dialog.querySelector("[data-media-focal-grid]");
    if (!grid.children.length) {
      let index = 0;
      FOCAL_VALUES.forEach((y) => FOCAL_VALUES.forEach((x) => {
        const button = document.createElement("button");
        button.type = "button";
        button.dataset.x = String(x);
        button.dataset.y = String(y);
        button.addEventListener("click", () => selectFocal(x, y));
        button.dataset.positionIndex = String(index++);
        grid.appendChild(button);
      }));
    }
    Array.from(grid.children).forEach((button) => {
      const position = labels().positions[Number(button.dataset.positionIndex)];
      button.setAttribute("aria-label", position);
      button.title = position;
    });
  }

  function selectFocal(x, y) {
    const preview = dialog.querySelector("[data-media-preview]");
    preview.style.objectPosition = `${x}% ${y}%`;
    dialog.dataset.focalX = String(x);
    dialog.dataset.focalY = String(y);
    dialog.querySelectorAll("[data-media-focal-grid] button").forEach((button) => {
      button.setAttribute("aria-pressed", String(Number(button.dataset.x) === x && Number(button.dataset.y) === y));
    });
    dirty = true;
  }

  function localizeDialog() {
    if (!dialog) return;
    const text = labels();
    const values = {
      "[data-media-title]": text.title, "[data-media-intro]": text.intro, "[data-media-drop-title]": text.drop,
      "[data-media-formats]": text.formats, "[data-media-choose]": text.choose, "[data-media-alt-en-label]": text.altEn,
      "[data-media-alt-zht-label]": text.altZhHant, "[data-media-alt-zhs-label]": text.altZhHans,
      "[data-media-focal-title]": text.focal, "[data-media-save]": text.save, "[data-media-restore]": text.restore,
    };
    Object.entries(values).forEach(([selector, value]) => { dialog.querySelector(selector).textContent = value; });
    dialog.querySelectorAll("[data-media-cancel]").forEach((button) => {
      if (!button.classList.contains("site-media-close")) button.textContent = text.cancel;
      button.setAttribute("aria-label", text.cancel);
    });
    renderFocalGrid();
  }

  function populateDialog() {
    const alt = currentItem?.alt || defaults.alt;
    dialog.querySelector("[data-media-alt-en]").value = alt.en;
    dialog.querySelector("[data-media-alt-zht]").value = alt.zhHant;
    dialog.querySelector("[data-media-alt-zhs]").value = alt.zhHans;
    dialog.querySelector("[data-media-preview]").src = currentItem?.src || defaults.src;
    selectFocal(currentItem?.focalX ?? 50, currentItem?.focalY ?? 50);
    dialog.querySelector("[data-media-restore]").hidden = !currentItem;
    dialog.querySelector("[data-media-file-name]").textContent = "";
    compressedFile = null;
    setStatus("");
    dirty = false;
    setBusy(false);
  }

  function openDialog() {
    if (!dialog) dialog = createDialog();
    localizeDialog();
    populateDialog();
    dialog.showModal();
    dialog.querySelector("[data-media-file]").focus();
  }

  function closeDialog() {
    compressionController?.abort();
    compressionController = null;
    if (activeRequest) activeRequest.abort();
    activeRequest = null;
    releasePreview();
    compressedFile = null;
    dirty = false;
    dialog?.close();
    editButton?.focus();
  }

  async function selectFile(file) {
    if (!file) return;
    compressedFile = null;
    dirty = true;
    dialog.querySelector("[data-media-save]").disabled = true;
    if (!ALLOWED_TYPES.has(file.type)) {
      setStatus(labels().invalidType, { error: true });
      window.iHearToast?.(labels().invalidType, { error: true });
      return;
    }
    if (file.size > MAX_ORIGINAL_BYTES) {
      setStatus(labels().tooLarge, { error: true });
      window.iHearToast?.(labels().tooLarge, { error: true });
      return;
    }
    if (typeof window.imageCompression !== "function") {
      setStatus(labels().compressionFailed, { error: true });
      return;
    }
    setPreviewFile(file);
    dialog.querySelector("[data-media-file-name]").textContent = file.name;
    compressionController?.abort();
    compressionController = new AbortController();
    setStatus(labels().optimizing, { progress: true, value: 0 });
    try {
      const result = await window.imageCompression(file, {
        maxSizeMB: 0.95,
        maxWidthOrHeight: 1600,
        useWebWorker: true,
        fileType: "image/webp",
        preserveExif: false,
        libURL: VENDOR_URL,
        signal: compressionController.signal,
        onProgress(value) { setStatus(labels().optimizing, { progress: true, value }); },
      });
      const safeFile = new File([result], "site-media.webp", { type: "image/webp", lastModified: Date.now() });
      if (safeFile === file || safeFile.type !== "image/webp" || safeFile.size < 1 || safeFile.size > MAX_COMPRESSED_BYTES) {
        throw new Error("invalid compressed output");
      }
      compressedFile = safeFile;
      setPreviewFile(safeFile);
      setStatus(labels().ready);
      dialog.querySelector("[data-media-save]").disabled = false;
    } catch (error) {
      if (error?.name === "AbortError") return;
      compressedFile = null;
      const message = String(error?.message || "").includes("invalid compressed") ? labels().invalidOutput : labels().compressionFailed;
      setStatus(message, { error: true });
      window.iHearToast?.(message, { error: true });
    } finally {
      compressionController = null;
    }
  }

  function altValues() {
    return {
      en: dialog.querySelector("[data-media-alt-en]").value.trim(),
      zhHant: dialog.querySelector("[data-media-alt-zht]").value.trim(),
      zhHans: dialog.querySelector("[data-media-alt-zhs]").value.trim(),
    };
  }

  function requestError(status, data) {
    if (status === 403) return labels().forbidden;
    if (status === 409 || status === 428) return labels().conflict;
    return data?.error || labels().failed;
  }

  function saveImage() {
    if (!compressedFile || compressedFile.type !== "image/webp" || compressedFile.size < 1 || compressedFile.size > MAX_COMPRESSED_BYTES) {
      setStatus(labels().invalidOutput, { error: true });
      return;
    }
    const alt = altValues();
    if (!Object.values(alt).every((value) => value.length >= 2 && value.length <= 300)) {
      setStatus(labels().altRequired, { error: true });
      return;
    }
    const form = new FormData();
    form.append("file", compressedFile, "site-media.webp");
    form.append("altEn", alt.en);
    form.append("altZhHant", alt.zhHant);
    form.append("altZhHans", alt.zhHans);
    form.append("focalX", dialog.dataset.focalX || "50");
    form.append("focalY", dialog.dataset.focalY || "50");
    form.append("expectedVersion", String(currentItem?.recordVersion || 0));

    setBusy(true);
    setStatus(labels().uploading, { progress: true, value: 0 });
    const xhr = new XMLHttpRequest();
    activeRequest = xhr;
    xhr.open("POST", API_URL);
    xhr.withCredentials = true;
    xhr.upload.addEventListener("progress", (event) => {
      if (!event.lengthComputable) return setStatus(labels().uploading, { progress: true });
      const value = Math.round((event.loaded / event.total) * 100);
      setStatus(value >= 100 ? labels().processing : labels().uploading, { progress: true, value: value >= 100 ? undefined : value });
    });
    xhr.addEventListener("load", () => {
      activeRequest = null;
      let data = null;
      try { data = JSON.parse(xhr.responseText || "null"); } catch { data = null; }
      if (xhr.status < 200 || xhr.status >= 300) {
        const message = requestError(xhr.status, data);
        setStatus(message, { error: true });
        window.iHearToast?.(message, { error: true });
        setBusy(false);
        return;
      }
      syncSlot(slot, data.item);
      window.iHearLiveContent?.announce("content", data.revision);
      window.iHearToast?.(labels().saved);
      closeDialog();
    });
    xhr.addEventListener("error", () => {
      activeRequest = null;
      setStatus(labels().failed, { error: true });
      window.iHearToast?.(labels().failed, { error: true });
      setBusy(false);
    });
    xhr.addEventListener("abort", () => { activeRequest = null; });
    xhr.send(form);
  }

  async function restoreImage() {
    if (!currentItem || !window.confirm(labels().confirmRestore)) return;
    setBusy(true);
    setStatus(labels().restoring, { progress: true });
    try {
      const response = await fetch(API_URL, {
        method: "DELETE",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expectedVersion: currentItem.recordVersion }),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) throw new Error(requestError(response.status, data));
      syncSlot(slot, null);
      window.iHearLiveContent?.announce("content", data.revision);
      window.iHearToast?.(labels().restored);
      closeDialog();
    } catch (error) {
      const message = error?.message || labels().failed;
      setStatus(message, { error: true });
      window.iHearToast?.(message, { error: true });
      setBusy(false);
    }
  }

  function languageChanged() {
    renderAdminControl();
    localizeDialog();
    if (currentItem) image.alt = currentItem.alt?.[locale()] || currentItem.alt?.en || defaults.alt.en;
    else image.alt = defaults.alt[locale()] || defaults.alt.en;
  }

  return {
    slot,
    refresh,
    restoreDefault,
    renderAdminControl,
    languageChanged,
    isDirty: () => Boolean(dialog?.open && dirty),
    onBlocked: () => window.iHearToast?.(labels().liveBlocked, { error: true }),
    applyRemoteItem(item) {
      currentItem = item || null;
      applyItem(currentItem);
      if (dialog?.open && !dirty) populateDialog();
    },
  };
  }

  const controllers = hosts.map(createController).filter(Boolean);
  if (!controllers.length) return;

  function syncSlot(slot, item) {
    controllers.filter((controller) => controller.slot === slot).forEach((controller) => controller.applyRemoteItem(item));
  }

  async function refreshAll() {
    const response = await fetch("/api/site-media", { credentials: "same-origin", cache: "no-store" });
    if (!response.ok) throw new Error("site media unavailable");
    const data = await response.json();
    controllers.forEach((controller) => controller.refresh(data));
  }

  window.addEventListener("ihear:auth", (event) => {
    currentSession = event.detail?.session || null;
    controllers.forEach((controller) => controller.renderAdminControl());
  });
  window.addEventListener("ihear:language", () => {
    controllers.forEach((controller) => controller.languageChanged());
  });

  window.iHearLiveContent?.register("content", {
    refresh: refreshAll,
    isDirty: () => controllers.some((controller) => controller.isDirty()),
    onBlocked: () => controllers.find((controller) => controller.isDirty())?.onBlocked(),
  });

  refreshAll().catch(() => controllers.forEach((controller) => controller.restoreDefault()));
  controllers.forEach((controller) => controller.renderAdminControl());
})();
