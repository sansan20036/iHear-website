(function () {
  "use strict";

  const VENDOR_URL = "/assets/vendor/browser-image-compression.js";
  const MAX_ORIGINAL_BYTES = 20 * 1024 * 1024;
  const MAX_COMPRESSED_BYTES = Math.floor(0.95 * 1024 * 1024);
  const MAX_AVATAR_BYTES = 500 * 1024;
  const ALLOWED_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
  const FOCAL_VALUES = [0, 50, 100];
  const languageGuardPromise = import("/assets/text-language-guard.js").catch(() => null);
  const imageIntakePromise = import("/assets/image-intake.js").catch(() => null);
  const copy = {
    en: {
      edit: "Change image", title: "Change image", intro: "Upload a photo, preview the crop, and describe it for each language.",
      drop: "Drop an image here, paste with Ctrl+V / Cmd+V, or choose a file", formats: "PNG, JPEG, or WebP · up to 20MB", choose: "Choose image",
      clipboardEmpty: "The clipboard does not contain an image. Copy one image and try again.", multipleImages: "Please add one image at a time.",
      altEn: "English image description", altZhHant: "Traditional Chinese image description", altZhHans: "Simplified Chinese image description",
      focal: "Choose the crop focus", cancel: "Cancel", save: "Save image", restore: "Restore default image",
      restoring: "Restoring…", deleting: "Deleting…", optimizing: "Optimizing image…", uploading: "Uploading…", processing: "Server is preparing responsive images…",
      ready: "Image ready to upload", saved: "Image updated", restored: "Default image restored",
      savingPreview: "The new image is visible now. Saving in the background…", removingPreview: "The image is hidden now. Removing it in the background…",
      savedPending: "The image was saved. Its final copy is still being prepared, so this preview will remain visible.",
      saveRollback: "The previous image has been restored.", removeRollback: "The deleted image has been restored.",
      invalidType: "Choose a PNG, JPEG, or WebP image.", tooLarge: "The original image must be 20MB or smaller.",
      compressionFailed: "The image could not be optimized. No file was uploaded.", invalidOutput: "The optimized image is invalid or larger than 0.95MB.",
      altRequired: "Complete all three image descriptions using 2–300 characters.", failed: "The image could not be updated.",
      forbidden: "Your administrator session has expired.", conflict: "Another administrator changed this image. Reload and try again.",
      confirmRestore: "Restore the original image? The current custom image will be removed.", liveBlocked: "A newer image is available. Finish or cancel this edit to refresh.",
      editAvatar: "Change avatar", titleAvatar: "Change avatar", introAvatar: "Upload or paste a portrait, then crop the person you want to show.",
      editChart: "Upload chart image", titleChart: "Upload chart image", introChart: "Upload a finished chart. The whole image will be shown without cropping. Use large labels for mobile screens; text inside the image is shared across languages and is not automatically translated.",
      restoreChart: "Restore original chart", restoredChart: "Original chart restored", confirmRestoreChart: "Remove the uploaded image and show the original chart and figures again?",
      restoreAvatar: "Delete photo", restoredAvatar: "Photo deleted", confirmRestoreAvatar: "Delete this profile photo? The name initials will be shown instead.",
      cropCurrent: "Crop current photo", cropReady: "Square crop ready. Save when it looks right.", cropUnavailable: "The crop editor is still loading. Please try again.",
      autoTranslate: "Automatically update Chinese descriptions", replaceTranslation: "Also overwrite existing or manually edited Chinese descriptions", preparingTranslation: "Translating…", translationReady: "Chinese descriptions are ready. Review them, then save.",
      positions: ["Top left", "Top center", "Top right", "Center left", "Center", "Center right", "Bottom left", "Bottom center", "Bottom right"],
    },
    zhHant: {
      edit: "更換圖片", title: "更換圖片", intro: "上傳照片、預覽裁切位置，並填寫三種語言的圖片描述。",
      drop: "拖曳圖片到這裡、按 Ctrl+V／Cmd+V 貼上，或選擇檔案", formats: "PNG、JPEG 或 WebP · 最大 20MB", choose: "選擇圖片",
      clipboardEmpty: "剪貼簿中沒有可使用的圖片，請先複製一張圖片再試一次。", multipleImages: "一次只能加入一張圖片。",
      altEn: "英文圖片描述", altZhHant: "繁體中文圖片描述", altZhHans: "簡體中文圖片描述",
      focal: "選擇裁切焦點", cancel: "取消", save: "確認儲存", restore: "恢復預設圖片",
      restoring: "正在恢復…", deleting: "正在刪除…", optimizing: "正在最佳化圖片…", uploading: "正在上傳…", processing: "伺服器正在產生響應式圖片…",
      ready: "圖片已準備好上傳", saved: "圖片已更新", restored: "已恢復預設圖片",
      savingPreview: "新圖片已立即顯示，正在背景儲存…", removingPreview: "圖片已立即隱藏，正在背景刪除…",
      savedPending: "圖片已儲存，正式圖片仍在完成處理；目前會繼續顯示這張預覽。",
      saveRollback: "已恢復原本的圖片。", removeRollback: "已恢復剛才刪除的圖片。",
      invalidType: "請選擇 PNG、JPEG 或 WebP 圖片。", tooLarge: "原始圖片不可超過 20MB。",
      compressionFailed: "無法最佳化圖片，未送出任何檔案。", invalidOutput: "最佳化結果無效或超過 0.95MB。",
      altRequired: "三種語言的圖片描述都必須填寫 2–300 個字元。", failed: "無法更新圖片。",
      forbidden: "管理員登入已失效。", conflict: "另一位管理員已更改圖片，請重新整理後再試。",
      confirmRestore: "確定恢復原始圖片？目前的自訂圖片將被移除。", liveBlocked: "已有較新的圖片，請先完成或取消目前編輯。",
      editAvatar: "更換頭像", titleAvatar: "更換頭像", introAvatar: "上傳或貼上人物照片，再裁切要顯示的單一人物。",
      editChart: "上傳圖表圖片", titleChart: "上傳圖表圖片", introChart: "上傳製作好的統計圖表，圖片會完整顯示、不裁切。建議使用大字，方便手機閱讀；圖片內的文字會在各語言共用，不會自動翻譯。",
      restoreChart: "恢復原本圖表", restoredChart: "已恢復原本圖表", confirmRestoreChart: "移除上傳圖片，重新顯示原本的圖表與數字？",
      restoreAvatar: "刪除照片", restoredAvatar: "照片已刪除", confirmRestoreAvatar: "確定要刪除這張頭像照片嗎？刪除後將改為顯示姓名縮寫。",
      cropCurrent: "裁切目前照片", cropReady: "方形裁切已準備好，確認效果後即可儲存。", cropUnavailable: "裁切工具仍在載入，請稍後再試。",
      autoTranslate: "自動更新中文圖片描述", replaceTranslation: "同時覆蓋既有或人工修改過的中文圖片描述", preparingTranslation: "翻譯中…", translationReady: "中文圖片描述已完成，請檢查後再儲存。",
      positions: ["左上", "中上", "右上", "左中", "正中", "右中", "左下", "中下", "右下"],
    },
    zhHans: {
      edit: "更换图片", title: "更换图片", intro: "上传照片、预览裁切位置，并填写三种语言的图片描述。",
      drop: "拖曳图片到这里、按 Ctrl+V／Cmd+V 粘贴，或选择文件", formats: "PNG、JPEG 或 WebP · 最大 20MB", choose: "选择图片",
      clipboardEmpty: "剪贴板中没有可使用的图片，请先复制一张图片再试一次。", multipleImages: "一次只能添加一张图片。",
      altEn: "英文图片描述", altZhHant: "繁体中文图片描述", altZhHans: "简体中文图片描述",
      focal: "选择裁切焦点", cancel: "取消", save: "确认保存", restore: "恢复默认图片",
      restoring: "正在恢复…", deleting: "正在删除…", optimizing: "正在优化图片…", uploading: "正在上传…", processing: "服务器正在生成响应式图片…",
      ready: "图片已准备好上传", saved: "图片已更新", restored: "已恢复默认图片",
      savingPreview: "新图片已立即显示，正在后台保存…", removingPreview: "图片已立即隐藏，正在后台删除…",
      savedPending: "图片已保存，正式图片仍在完成处理；目前会继续显示这张预览。",
      saveRollback: "已恢复原来的图片。", removeRollback: "已恢复刚才删除的图片。",
      invalidType: "请选择 PNG、JPEG 或 WebP 图片。", tooLarge: "原始图片不可超过 20MB。",
      compressionFailed: "无法优化图片，未发送任何文件。", invalidOutput: "优化结果无效或超过 0.95MB。",
      altRequired: "三种语言的图片描述都必须填写 2–300 个字符。", failed: "无法更新图片。",
      forbidden: "管理员登录已失效。", conflict: "另一位管理员已更改图片，请刷新后重试。",
      confirmRestore: "确定恢复原始图片？当前的自定义图片将被删除。", liveBlocked: "已有较新的图片，请先完成或取消当前编辑。",
      editAvatar: "更换头像", titleAvatar: "更换头像", introAvatar: "上传或粘贴人物照片，再裁切要显示的单一人物。",
      editChart: "上传图表图片", titleChart: "上传图表图片", introChart: "上传制作好的统计图表，图片会完整显示、不裁切。建议使用大字，方便手机阅读；图片内的文字会在各语言共用，不会自动翻译。",
      restoreChart: "恢复原本图表", restoredChart: "已恢复原本图表", confirmRestoreChart: "移除上传图片，重新显示原本的图表与数字？",
      restoreAvatar: "删除照片", restoredAvatar: "照片已删除", confirmRestoreAvatar: "确定要删除这张头像照片吗？删除后将改为显示姓名缩写。",
      cropCurrent: "裁切目前照片", cropReady: "方形裁切已准备好，确认效果后即可保存。", cropUnavailable: "裁切工具仍在加载，请稍后再试。",
      autoTranslate: "自动更新中文图片描述", replaceTranslation: "同时覆盖现有或人工修改过的中文图片描述", preparingTranslation: "翻译中…", translationReady: "中文图片描述已完成，请检查后再保存。",
      positions: ["左上", "中上", "右上", "左中", "正中", "右中", "左下", "中下", "右下"],
    },
  };

  let currentSession = window.iHearAuth?.getSession?.() || null;

  function initialsPreviewDataUrl(value) {
    const initials = String(value || "•").trim().slice(0, 4);
    const escaped = initials.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400"><circle cx="200" cy="200" r="200" fill="#263974"/><text x="200" y="216" fill="white" font-family="Arial,sans-serif" font-size="116" font-weight="700" text-anchor="middle">${escaped}</text></svg>`;
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  }

  function mediaProbeUrl(url, cacheBust) {
    if (!cacheBust || !url || url.startsWith("blob:") || url.startsWith("data:")) return url;
    return `${url}${url.includes("?") ? "&" : "?"}ihear_media=${encodeURIComponent(cacheBust)}`;
  }

  function probeMediaItem(item, cacheBust = "") {
    const urls = [...new Set([
      item?.src,
      ...(Array.isArray(item?.variants) ? item.variants.map((variant) => variant.url) : []),
    ].filter(Boolean))];
    if (!item?.src || !item?.srcSet || !urls.length) return Promise.resolve(false);
    return Promise.all(urls.map((url) => preloadMediaImage(url, cacheBust))).then(() => true, () => false);
  }

  function preloadMediaImage(url, cacheBust) {
    return new Promise((resolve, reject) => {
      const preload = new Image();
      preload.onload = () => {
        if (typeof preload.decode === "function") preload.decode().then(resolve, reject);
        else resolve();
      };
      preload.onerror = reject;
      preload.src = mediaProbeUrl(url, cacheBust);
    });
  }

  function createController(host) {
  const slot = host.getAttribute("data-site-media-slot") || "";
  if (!slot) return null;
  const API_URL = `/api/site-media/${encodeURIComponent(slot)}`;
  const picture = host?.querySelector("picture");
  const image = picture?.querySelector("img");
  if (!picture || !image) return null;
  const fallbackInitials = host.querySelector(".avatar-initials");
  const isAvatar = host.dataset.siteMediaKind === "avatar" && Boolean(fallbackInitials);
  const chartFallback = host.querySelector("[data-site-media-fallback]");
  const isChart = host.dataset.siteMediaKind === "chart" && Boolean(chartFallback);
  const controlHost = (host.closest("summary") ? host.closest(".team-profile-tutor-shell") : host) || host;

  const defaults = {
    sources: Array.from(picture.querySelectorAll("source")).map((source) => ({
      node: source,
      srcset: source.getAttribute("srcset") || "",
      sizes: source.getAttribute("sizes") || "",
      type: source.getAttribute("type") || "",
    })),
    src: image.getAttribute("src") || "",
    previewSrc: isAvatar ? initialsPreviewDataUrl(fallbackInitials.textContent) : (image.getAttribute("src") || ""),
    alt: {
      en: host.dataset.siteMediaAltEn || image.alt || "Site image",
      zhHant: host.dataset.siteMediaAltZhHant || host.dataset.siteMediaAltEn || image.alt || "網站圖片",
      zhHans: host.dataset.siteMediaAltZhHans || host.dataset.siteMediaAltEn || image.alt || "网站图片",
    },
    objectPosition: image.style.objectPosition || "50% 50%",
    objectFit: image.style.objectFit,
    transform: image.style.transform,
    transformOrigin: image.style.transformOrigin,
  };

  let currentItem = null;
  let dialog = null;
  let editButton = null;
  let compressedFile = null;
  let previewUrl = "";
  let compressionController = null;
  let activeRequest = null;
  let dirty = false;
  let translationReceipt = "";
  let altTranslationEdits = { en: false, zhHant: false, zhHans: false };
  let englishGuardAccepted = false;
  let applyToken = 0;
  let pending = false;
  let pendingAction = "";

  function locale() {
    const language = (document.documentElement.lang || "en").toLowerCase();
    if (language.includes("hans")) return "zhHans";
    if (language.startsWith("zh")) return "zhHant";
    return "en";
  }

  function labels() {
    const text = copy[locale()] || copy.en;
    if (isChart) return { ...text, edit: text.editChart, title: text.titleChart, intro: text.introChart,
      restore: text.restoreChart, restored: text.restoredChart, confirmRestore: text.confirmRestoreChart };
    if (!isAvatar) return text;
    return {
      ...text,
      edit: text.editAvatar,
      title: text.titleAvatar,
      intro: text.introAvatar,
      restore: text.restoreAvatar,
      restored: text.restoredAvatar,
      confirmRestore: text.confirmRestoreAvatar,
    };
  }
  function isAdmin() { return Boolean(currentSession?.user?.isAdmin); }

  function restoreDefault() {
    applyToken += 1;
    defaults.sources.forEach(({ node, srcset, sizes, type }) => {
      node.setAttribute("srcset", srcset);
      node.setAttribute("sizes", sizes);
      node.setAttribute("type", type);
    });
    if (isAvatar || isChart) {
      picture.hidden = true;
      image.removeAttribute("src");
      image.alt = "";
      if (isAvatar) fallbackInitials.hidden = false;
      if (isChart) chartFallback.hidden = false;
    } else {
      image.src = defaults.src;
      image.alt = defaults.alt[locale()] || defaults.alt.en;
    }
    image.style.objectPosition = defaults.objectPosition;
    image.style.objectFit = defaults.objectFit;
    image.style.transform = defaults.transform;
    image.style.transformOrigin = defaults.transformOrigin;
    host.removeAttribute("data-site-media-custom");
    host.setAttribute("data-site-media-ready", "true");
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
    image.alt = isAvatar ? "" : (item.alt?.[locale()] || item.alt?.en || defaults.alt.en);
    if (isChart) {
      picture.hidden = false;
      chartFallback.hidden = true;
    }
    if (isAvatar) {
      image.style.objectPosition = "50% 50%";
      const square = variants.every((variant) => Number(variant.pixelWidth) === Number(variant.pixelHeight));
      image.style.objectFit = square ? "cover" : "contain";
      image.style.transform = square ? "none" : `scale(${Math.max(100, Math.min(250, Number(item.zoom) || 100)) / 100})`;
      image.style.transformOrigin = square ? "50% 50%" : `${item.focalX}% ${item.focalY}%`;
      picture.hidden = false;
      fallbackInitials.hidden = true;
    } else {
      image.style.objectPosition = `${item.focalX}% ${item.focalY}%`;
      image.style.objectFit = defaults.objectFit;
      image.style.transform = defaults.transform;
      image.style.transformOrigin = defaults.transformOrigin;
    }
    host.setAttribute("data-site-media-custom", "true");
    host.setAttribute("data-site-media-ready", "true");
  }

  function applyItem(item, options = {}) {
    if (!item) {
      restoreDefault();
      return Promise.resolve(true);
    }
    const token = ++applyToken;
    const urls = [...new Set([
      item.src,
      ...(Array.isArray(item.variants) ? item.variants.map((variant) => variant.url) : []),
    ].filter(Boolean))];
    return Promise.all(urls.map((url) => preloadMediaImage(url, options.cacheBust))).then(
      () => {
        if (token !== applyToken) return false;
        commitItem(item);
        return true;
      },
      () => {
        // Keep the current photo or initial placeholder. A failed custom image
        // must not briefly reveal the obsolete repository fallback.
        return false;
      },
    );
  }

  function refresh(data) {
    currentItem = data?.items?.[slot] || null;
    const recentCommit = recentCommittedSlots.get(slot);
    applyItem(currentItem, { keepCurrentOnFailure: Boolean(recentCommit?.item) });
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
      if (isAvatar) editButton.classList.add("site-media-avatar-edit");
      if (controlHost !== host) editButton.classList.add("site-media-external-edit");
      editButton.innerHTML = '<span class="site-media-edit-icon" aria-hidden="true">📷</span><span class="site-media-edit-spinner" aria-hidden="true"></span><span data-site-media-edit-label></span>';
      editButton.addEventListener("click", openDialog);
      controlHost.appendChild(editButton);
    }
    if (controlHost !== host) {
      editButton.style.left = `${host.offsetLeft + host.offsetWidth - 14}px`;
      editButton.style.top = `${host.offsetTop + host.offsetHeight - 14}px`;
    }
    const text = pending ? (pendingAction === "delete" ? labels().deleting : labels().uploading) : labels().edit;
    editButton.title = text;
    editButton.setAttribute("aria-label", text);
    editButton.querySelector("[data-site-media-edit-label]").textContent = text;
    editButton.classList.toggle("is-pending", pending);
    editButton.disabled = pending;
  }

  function setPending(value, action = "") {
    pending = Boolean(value);
    pendingAction = pending ? action : "";
    host.toggleAttribute("data-site-media-pending", pending);
    if (pending) {
      host.setAttribute("aria-busy", "true");
      host.setAttribute("data-site-media-operation", pendingAction);
    } else {
      host.removeAttribute("aria-busy");
      host.removeAttribute("data-site-media-operation");
    }
    renderAdminControl();
  }

  function previewItem(item) {
    applyItem(item);
  }

  function releasePreview() {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = "";
  }

  function setPreviewFile(file) {
    releasePreview();
    previewUrl = URL.createObjectURL(file);
    dialog.querySelector("[data-media-preview]").src = previewUrl;
    dialog.querySelector(".site-media-preview-wrap").hidden = false;
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
    if (isAvatar) node.dataset.mediaKind = "avatar";
    if (isChart) node.dataset.mediaKind = "chart";
    node.style.setProperty("--site-media-preview-aspect", host.dataset.siteMediaAspect || "4 / 3.4");
    node.innerHTML = `
      <form method="dialog" class="site-media-form" data-media-form>
        <div class="site-media-dialog-head">
          <div><h2 data-media-title></h2><p data-media-intro></p></div>
          <button type="button" class="site-media-close" data-media-cancel aria-label="Close">×</button>
        </div>
        <label class="site-media-drop" data-media-drop tabindex="0">
          <input type="file" accept="image/png,image/jpeg,image/webp" data-media-file>
          <span class="site-media-camera" aria-hidden="true">📷</span>
          <strong data-media-drop-title></strong><small data-media-formats></small>
          <span class="btn btn-ghost" data-media-choose></span>
          <span class="site-media-file-name" data-media-file-name></span>
        </label>
        <div class="site-media-preview-wrap">
          <div class="site-media-preview-frame"><img data-media-preview alt=""></div>
          <fieldset class="site-media-focal" data-media-focal><legend data-media-focal-title></legend><div class="site-media-focal-grid" data-media-focal-grid></div></fieldset>
        </div>
        <div class="site-media-alt-grid">
          <label><span data-media-alt-en-label></span><input type="text" minlength="2" maxlength="300" data-media-alt-en></label><div class="language-guard-warning" data-media-guard="en" hidden></div>
          <label><span data-media-alt-zht-label></span><input type="text" minlength="2" maxlength="300" data-media-alt-zht></label><div class="language-guard-warning" data-media-guard="zhHant" hidden></div>
          <label><span data-media-alt-zhs-label></span><input type="text" minlength="2" maxlength="300" data-media-alt-zhs></label><div class="language-guard-warning" data-media-guard="zhHans" hidden></div>
        </div>
        <div class="site-media-translation-options">
          <label><input type="checkbox" data-media-auto-translate checked><span data-media-auto-translate-label></span></label>
          <label><input type="checkbox" data-media-replace-translation><span data-media-replace-translation-label></span></label>
        </div>
        <div class="site-media-progress-wrap" aria-live="polite">
          <progress max="100" data-media-progress hidden></progress><p data-media-status></p>
        </div>
        <div class="site-media-actions">
          <button type="button" class="ihear-inline-action site-media-recrop" data-media-recrop></button>
          <button type="button" class="ihear-inline-action site-media-restore" data-media-restore></button>
          <span class="site-media-action-spacer"></span>
          <button type="button" class="ihear-inline-action" data-media-cancel></button>
          <button type="button" class="ihear-inline-action" data-action="save" data-media-save disabled></button>
        </div>
      </form>`;
    document.body.appendChild(node);
    node.querySelectorAll("[data-media-cancel]").forEach((button) => button.addEventListener("click", closeDialog));
    node.querySelector("[data-media-file]").addEventListener("change", (event) => {
      selectFile(event.target.files?.[0]);
      event.target.value = "";
    });
    node.querySelector("[data-media-save]").addEventListener("click", saveImage);
    node.querySelector("[data-media-restore]").addEventListener("click", restoreImage);
    node.querySelector("[data-media-recrop]").addEventListener("click", cropCurrentAvatar);
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
      if (!node.hasAttribute("data-busy")) void receiveTransferredImage(event.dataTransfer, false);
    });
    drop.addEventListener("paste", (event) => {
      if (node.hasAttribute("data-busy")) return;
      event.preventDefault();
      void receiveTransferredImage(event.clipboardData, true);
    });
    node.addEventListener("paste", (event) => {
      if (event.defaultPrevented || node.hasAttribute("data-busy")) return;
      const hasFiles = Boolean(event.clipboardData?.files?.length)
        || Array.from(event.clipboardData?.items || []).some((item) => item.kind === "file");
      if (!hasFiles) return;
      event.preventDefault();
      void receiveTransferredImage(event.clipboardData, true);
    });
    node.addEventListener("cancel", (event) => {
      if (node.hasAttribute("data-busy")) event.preventDefault();
      else { event.preventDefault(); closeDialog(); }
    });
    node.querySelectorAll("input[type=text]").forEach((input) => input.addEventListener("input", () => { const language = input.matches("[data-media-alt-en]") ? "en" : input.matches("[data-media-alt-zht]") ? "zhHant" : "zhHans"; altTranslationEdits[language] = true; dirty = true; if (language === "en") { translationReceipt = ""; englishGuardAccepted = false; } void renderLanguageGuards(); }));
    node.querySelectorAll("[data-media-auto-translate],[data-media-replace-translation]").forEach((input) => input.addEventListener("change", () => { translationReceipt = ""; dirty = true; }));
    return node;
  }

  async function receiveTransferredImage(transfer, fromClipboard) {
    const intake = await imageIntakePromise;
    if (!intake) {
      setStatus(labels().failed, { error: true });
      return;
    }
    const result = intake.singleImageFromTransfer(transfer);
    if (result.status === "empty") {
      if (fromClipboard) setStatus(labels().clipboardEmpty, { error: true });
      else setStatus(labels().invalidType, { error: true });
      return;
    }
    if (result.status === "multiple") {
      setStatus(labels().multipleImages, { error: true });
      return;
    }
    await selectFile(result.file);
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
      "[data-media-recrop]": text.cropCurrent || "",
      "[data-media-auto-translate-label]": text.autoTranslate, "[data-media-replace-translation-label]": text.replaceTranslation,
    };
    Object.entries(values).forEach(([selector, value]) => { dialog.querySelector(selector).textContent = value; });
    dialog.querySelector("[data-media-drop]").setAttribute("aria-label", text.drop);
    dialog.querySelectorAll("[data-media-cancel]").forEach((button) => {
      if (!button.classList.contains("site-media-close")) button.textContent = text.cancel;
      button.setAttribute("aria-label", text.cancel);
    });
    if (!isAvatar && !isChart) renderFocalGrid();
  }

  function populateDialog() {
    const alt = currentItem?.alt || defaults.alt;
    altTranslationEdits = { en: false, zhHant: false, zhHans: false };
    dialog.querySelector("[data-media-alt-en]").value = alt.en;
    dialog.querySelector("[data-media-alt-zht]").value = alt.zhHant;
    dialog.querySelector("[data-media-alt-zhs]").value = alt.zhHans;
    const previewSrc = currentItem?.src || defaults.previewSrc;
    const preview = dialog.querySelector("[data-media-preview]");
    if (previewSrc) preview.src = previewSrc;
    else preview.removeAttribute("src");
    dialog.querySelector(".site-media-preview-wrap").hidden = isChart && !previewSrc;
    selectFocal(currentItem?.focalX ?? 50, currentItem?.focalY ?? 50);
    dialog.querySelector("[data-media-focal]").hidden = isAvatar || isChart;
    dialog.querySelector(".site-media-alt-grid").hidden = isAvatar;
    dialog.querySelector(".site-media-translation-options").hidden = isAvatar;
    dialog.querySelector("[data-media-recrop]").hidden = !isAvatar || !currentItem;
    dialog.querySelector("[data-media-restore]").hidden = !currentItem;
    dialog.querySelector("[data-media-file-name]").textContent = "";
    compressedFile = null;
    translationReceipt = "";
    englishGuardAccepted = false;
    setStatus("");
    dirty = false;
    setBusy(false);
    void renderLanguageGuards();
  }

  async function renderLanguageGuards() {
    if (!dialog) return;
    if (isAvatar) {
      dialog.querySelectorAll("[data-media-guard]").forEach((element) => { element.hidden = true; });
      return;
    }
    const guard = await languageGuardPromise;
    if (!guard) return;
    const values = altValues();
    const inputs = { en: "[data-media-alt-en]", zhHant: "[data-media-alt-zht]", zhHans: "[data-media-alt-zhs]" };
    Object.keys(inputs).forEach((language) => {
      guard.renderLanguageGuard(dialog.querySelector(`[data-media-guard="${language}"]`), {
        language, value: values[language], uiLocale: locale(), englishAccepted: englishGuardAccepted, disabled: dialog.hasAttribute("data-busy"),
        onAcceptEnglish: () => { englishGuardAccepted = true; void renderLanguageGuards(); },
        onChange: (value) => { dialog.querySelector(inputs[language]).value = value; altTranslationEdits[language] = true; dirty = true; translationReceipt = ""; void renderLanguageGuards(); },
      });
    });
  }

  function openDialog() {
    if (!dialog) dialog = createDialog();
    localizeDialog();
    populateDialog();
    dialog.showModal();
    dialog.querySelector("[data-media-drop]").focus();
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

  function hideDialogForPending() {
    dirty = false;
    dialog?.close();
    editButton?.focus();
  }

  function finishPendingDialog() {
    releasePreview();
    compressedFile = null;
    translationReceipt = "";
    englishGuardAccepted = false;
    dirty = false;
    setBusy(false);
    dialog?.close();
    editButton?.focus();
  }

  function reopenPendingDialog(message) {
    dirty = true;
    setBusy(false);
    setStatus(message, { error: true });
    if (!dialog?.open) dialog?.showModal();
    dialog?.querySelector("[data-media-save]")?.focus();
  }

  function createOptimisticItem(file, alt) {
    const url = URL.createObjectURL(file);
    const preview = dialog.querySelector("[data-media-preview]");
    const width = preview.naturalWidth || (isAvatar ? 800 : 1600);
    const height = preview.naturalHeight || (isAvatar ? 800 : Math.max(1, Math.round(width * 0.75)));
    return {
      url,
      item: {
        slot,
        alt,
        focalX: Number(dialog.dataset.focalX || 50),
        focalY: Number(dialog.dataset.focalY || 50),
        zoom: 100,
        recordVersion: currentItem?.recordVersion || 0,
        src: url,
        srcSet: url,
        variants: [{
          width,
          pixelWidth: width,
          pixelHeight: height,
          byteSize: file.size,
          mimeType: "image/webp",
          url,
        }],
      },
    };
  }

  async function selectFile(file) {
    if (!file) return;
    if (isAvatar) {
      await cropAvatarSource(file, file.name);
      return;
    }
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
      const targetBytes = isAvatar ? MAX_AVATAR_BYTES : MAX_COMPRESSED_BYTES;
      const result = await window.imageCompression(file, {
        maxSizeMB: isAvatar ? 500 / 1024 : 0.95,
        maxWidthOrHeight: isAvatar ? 800 : 1600,
        useWebWorker: true,
        fileType: "image/webp",
        preserveExif: false,
        libURL: VENDOR_URL,
        signal: compressionController.signal,
        onProgress(value) { setStatus(labels().optimizing, { progress: true, value }); },
      });
      const safeFile = new File([result], "site-media.webp", { type: "image/webp", lastModified: Date.now() });
      if (safeFile === file || safeFile.type !== "image/webp" || safeFile.size < 1 || safeFile.size > targetBytes) {
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

  async function cropAvatarSource(source, fileName) {
    if (!window.iHearAvatarCropper) {
      setStatus(labels().cropUnavailable, { error: true });
      return;
    }
    setBusy(true);
    setStatus("");
    try {
      const result = await window.iHearAvatarCropper.open({ source, locale: locale() });
      if (!result) return;
      compressedFile = result.file;
      setPreviewFile(result.file);
      dialog.querySelector("[data-media-file-name]").textContent = fileName || "avatar.webp";
      selectFocal(50, 50);
      dirty = true;
      setStatus(labels().cropReady);
    } catch (error) {
      const message = error?.message || labels().compressionFailed;
      setStatus(message, { error: true });
      window.iHearToast?.(message, { error: true });
    } finally {
      setBusy(false);
    }
  }

  async function cropCurrentAvatar() {
    if (!isAvatar || !currentItem) return;
    const source = `${API_URL}/source?expectedVersion=${encodeURIComponent(currentItem.recordVersion)}`;
    await cropAvatarSource(source, "avatar.webp");
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

  async function saveImage() {
    const targetBytes = isAvatar ? MAX_AVATAR_BYTES : MAX_COMPRESSED_BYTES;
    if (!compressedFile || compressedFile.type !== "image/webp" || compressedFile.size < 1 || compressedFile.size > targetBytes) {
      setStatus(labels().invalidOutput, { error: true });
      return;
    }
    const alt = altValues();
    const autoTranslate = !isAvatar && dialog.querySelector("[data-media-auto-translate]").checked;
    const guard = await languageGuardPromise;
    if (autoTranslate && guard?.inspectEnglishSource(alt.en).warning && !englishGuardAccepted) { await renderLanguageGuards(); dialog.querySelector("[data-media-alt-en]").focus(); return; }
    if (autoTranslate && !translationReceipt) {
      if (alt.en.length < 2 || alt.en.length > 300) { setStatus(labels().altRequired, { error: true }); return; }
      setBusy(true); setStatus(labels().preparingTranslation);
      try {
        const refreshLegacyLocales = altTranslationEdits.en ? ["zhHant", "zhHans"].filter((language) => !altTranslationEdits[language]) : [];
        const response = await fetch("/api/admin/translations/preview", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ resource: { type: "media", scope: "", id: slot, version: currentItem?.recordVersion || 0 }, fields: { alt }, allowCjkEnglish: englishGuardAccepted, force: dialog.querySelector("[data-media-replace-translation]").checked ? { alt: ["zhHant", "zhHans"] } : {}, refreshLegacy: refreshLegacyLocales.length ? { alt: refreshLegacyLocales } : {} }) });
        const data = await response.json().catch(() => null); if (!response.ok) throw new Error(data?.error || labels().failed);
        dialog.querySelector("[data-media-alt-zht]").value = data.fields.alt.value.zhHant; dialog.querySelector("[data-media-alt-zhs]").value = data.fields.alt.value.zhHans; altTranslationEdits.en = false; if (data.fields.alt.zhHantStatus === "translated") altTranslationEdits.zhHant = false; if (data.fields.alt.zhHansStatus === "translated") altTranslationEdits.zhHans = false; translationReceipt = data.receipt; dirty = true; setStatus(labels().translationReady);
      } catch (error) { setStatus(error?.message || labels().failed, { error: true }); }
      finally { setBusy(false); }
      return;
    }
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
    form.append("zoom", "100");
    form.append("expectedVersion", String(currentItem?.recordVersion || 0));
    if (autoTranslate && translationReceipt) form.append("translationReceipt", translationReceipt);

    setBusy(true);
    setStatus(labels().uploading, { progress: true, value: 0 });
    const xhr = new XMLHttpRequest();
    activeRequest = xhr;
    xhr.open("POST", API_URL);
    xhr.withCredentials = true;
    const previousItem = currentItem;
    const optimistic = createOptimisticItem(compressedFile, alt);
    const operation = beginOptimisticSlot(slot, optimistic.item, optimistic.url);
    hideDialogForPending();
    window.iHearToast?.(labels().savingPreview);
    const acceptSavedUpload = async (item, revision) => {
      const ready = await completeOptimisticSlot(slot, operation, item);
      finishPendingDialog();
      if (revision) window.iHearLiveContent?.announce("content", revision);
      window.iHearToast?.(ready ? labels().saved : labels().savedPending);
    };
    const handleUploadFailure = async (message) => {
      const committed = await findCommittedUpload(slot, previousItem);
      if (committed) {
        await acceptSavedUpload(committed, null);
        return;
      }
      if (!rollbackOptimisticSlot(slot, operation, previousItem)) return;
      const rollbackMessage = `${message} ${labels().saveRollback}`;
      reopenPendingDialog(rollbackMessage);
      window.iHearToast?.(rollbackMessage, { error: true });
    };
    xhr.upload.addEventListener("progress", (event) => {
      if (!event.lengthComputable) return setStatus(labels().uploading, { progress: true });
      const value = Math.round((event.loaded / event.total) * 100);
      setStatus(value >= 100 ? labels().processing : labels().uploading, { progress: true, value: value >= 100 ? undefined : value });
    });
    xhr.addEventListener("load", async () => {
      activeRequest = null;
      let data = null;
      try { data = JSON.parse(xhr.responseText || "null"); } catch { data = null; }
      if (xhr.status < 200 || xhr.status >= 300) {
        await handleUploadFailure(requestError(xhr.status, data));
        return;
      }
      await acceptSavedUpload(data.item, data.revision);
    });
    xhr.addEventListener("error", async () => {
      activeRequest = null;
      await handleUploadFailure(labels().failed);
    });
    xhr.addEventListener("abort", () => {
      activeRequest = null;
      rollbackOptimisticSlot(slot, operation, previousItem);
    });
    try {
      xhr.send(form);
    } catch {
      activeRequest = null;
      void handleUploadFailure(labels().failed);
    }
  }

  async function restoreImage() {
    if (!currentItem || !window.confirm(labels().confirmRestore)) return;
    const previousItem = currentItem;
    setBusy(true);
    setStatus(labels().restoring, { progress: true });
    const operation = beginOptimisticSlot(slot, null, "", previousItem);
    hideDialogForPending();
    window.iHearToast?.(labels().removingPreview);
    try {
      const response = await fetch(API_URL, {
        method: "DELETE",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expectedVersion: currentItem.recordVersion }),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) throw new Error(requestError(response.status, data));
      completeOptimisticSlot(slot, operation, null);
      finishPendingDialog();
      window.iHearLiveContent?.announce("content", data.revision);
      window.iHearToast?.(labels().restored);
    } catch (error) {
      rollbackOptimisticSlot(slot, operation, previousItem);
      const message = `${error?.message || labels().failed} ${labels().removeRollback}`;
      reopenPendingDialog(message);
      window.iHearToast?.(message, { error: true });
    }
  }

  function languageChanged() {
    renderAdminControl();
    localizeDialog();
    if (currentItem) image.alt = isAvatar ? "" : (currentItem.alt?.[locale()] || currentItem.alt?.en || defaults.alt.en);
    else image.alt = isAvatar ? "" : (defaults.alt[locale()] || defaults.alt.en);
  }

  function destroy() {
    applyToken += 1;
    compressionController?.abort();
    if (activeRequest) activeRequest.abort();
    releasePreview();
    dialog?.remove();
    editButton?.remove();
  }

  return {
    host,
    slot,
    refresh,
    restoreDefault,
    previewItem,
    setPending,
    renderAdminControl,
    languageChanged,
    isDirty: () => pending || Boolean(dialog?.open && dirty),
    onBlocked: () => window.iHearToast?.(labels().liveBlocked, { error: true }),
    destroy,
    applyRemoteItem(item, options) {
      currentItem = item || null;
      const result = applyItem(currentItem, options);
      if (dialog?.open && !dirty) populateDialog();
      return result;
    },
  };
  }

  let controllers = [];
  let lastMediaData = null;
  let mediaRefreshSequence = 0;
  let optimisticSequence = 0;
  const pendingSlots = new Map();
  const recentCommittedSlots = new Map();
  const RECENT_COMMIT_TTL = 60_000;

  function releaseOptimisticUrl(url, delay = 15_000) {
    if (!url) return;
    window.setTimeout(() => URL.revokeObjectURL(url), delay);
  }

  function wait(delay) {
    return new Promise((resolve) => { window.setTimeout(resolve, delay); });
  }

  function beginOptimisticSlot(slot, item, url, previousItem = null) {
    const operation = {
      id: ++optimisticSequence,
      item,
      url,
      action: item ? "upload" : "delete",
      previousVersion: Number(previousItem?.recordVersion || 0),
    };
    pendingSlots.set(slot, operation);
    controllers.filter((controller) => controller.slot === slot).forEach((controller) => {
      controller.setPending(true, operation.action);
      controller.previewItem(item);
    });
    return operation;
  }

  async function settleCommittedMedia(slot, operation, item, initialSwaps) {
    let ready = initialSwaps.length > 0 && (await Promise.all(initialSwaps)).every(Boolean);
    const delays = [250, 750, 1_500, 3_000];
    for (let attempt = 0; attempt < delays.length && !ready; attempt += 1) {
      await wait(delays[attempt]);
      const activeCommit = recentCommittedSlots.get(slot);
      const newerOperation = pendingSlots.get(slot);
      if (activeCommit?.operationId !== operation.id || (newerOperation && newerOperation.id !== operation.id)) {
        releaseOptimisticUrl(operation.url, 5 * 60_000);
        return;
      }
      const marker = `${item.recordVersion || "new"}-${attempt}-${Date.now()}`;
      if (!(await probeMediaItem(item, marker))) continue;
      ready = (await Promise.all(syncSlot(slot, item, {
        cacheBust: marker,
        keepCurrentOnFailure: true,
      }))).every(Boolean);
    }
    // Keep the local Blob alive until every visible copy has switched to the
    // persisted URL. A slow CDN must never make the photo disappear again.
    releaseOptimisticUrl(operation.url, ready ? 15_000 : 5 * 60_000);
  }

  async function completeOptimisticSlot(slot, operation, item) {
    if (pendingSlots.get(slot)?.id !== operation.id) return false;
    if (item) {
      recentCommittedSlots.set(slot, {
        item,
        operationId: operation.id,
        expiresAt: Date.now() + RECENT_COMMIT_TTL,
      });
    } else {
      recentCommittedSlots.set(slot, {
        item: null,
        operationId: operation.id,
        deletedVersion: operation.previousVersion,
        committedAt: Date.now(),
        expiresAt: Date.now() + RECENT_COMMIT_TTL,
      });
    }
    pendingSlots.delete(slot);
    const swaps = syncSlot(slot, item, item ? { keepCurrentOnFailure: true } : {});
    controllers.filter((controller) => controller.slot === slot).forEach((controller) => controller.setPending(false));
    if (item) void settleCommittedMedia(slot, operation, item, swaps);
    else releaseOptimisticUrl(operation.url);
    return true;
  }

  async function findCommittedUpload(slot, previousItem) {
    const previousVersion = Number(previousItem?.recordVersion || 0);
    for (const delay of [0, 400, 1_000]) {
      if (delay) await wait(delay);
      try {
        const response = await fetch(`/api/site-media?verify=${Date.now()}`, {
          credentials: "same-origin",
          cache: "no-store",
        });
        if (!response.ok) continue;
        const data = await response.json();
        const item = data?.items?.[slot];
        if (item && Number(item.recordVersion || 0) > previousVersion) {
          lastMediaData = data;
          return item;
        }
      } catch {
        // A failed verification is treated as an ordinary failed upload below.
      }
    }
    return null;
  }

  function rollbackOptimisticSlot(slot, operation, previousItem) {
    if (pendingSlots.get(slot)?.id !== operation.id) return false;
    pendingSlots.delete(slot);
    syncSlot(slot, previousItem);
    controllers.filter((controller) => controller.slot === slot).forEach((controller) => controller.setPending(false));
    releaseOptimisticUrl(operation.url);
    return true;
  }

  function reconcileControllers() {
    const activeHosts = new Set(document.querySelectorAll("[data-site-media-slot]"));
    controllers = controllers.filter((controller) => {
      if (activeHosts.has(controller.host) && controller.host.isConnected) return true;
      controller.destroy();
      return false;
    });
    const knownHosts = new Set(controllers.map((controller) => controller.host));
    activeHosts.forEach((host) => {
      if (knownHosts.has(host)) return;
      const controller = createController(host);
      if (!controller) return;
      controllers.push(controller);
      controller.renderAdminControl();
      const pendingOperation = pendingSlots.get(controller.slot);
      if (pendingOperation) {
        controller.setPending(true, pendingOperation.action);
        controller.previewItem(pendingOperation.item);
      } else if (lastMediaData) controller.refresh(lastMediaData);
    });
  }

  function syncSlot(slot, item, options = {}) {
    if (lastMediaData) {
      if (item) lastMediaData.items[slot] = item;
      else delete lastMediaData.items[slot];
    }
    return controllers
      .filter((controller) => controller.slot === slot)
      .map((controller) => controller.applyRemoteItem(item, options));
  }

  function preserveRecentCommits(data) {
    if (!data?.items || !recentCommittedSlots.size) return data;
    const now = Date.now();
    recentCommittedSlots.forEach((commit, slot) => {
      if (commit.expiresAt <= now) {
        recentCommittedSlots.delete(slot);
        return;
      }
      const fetched = data.items[slot];
      const fetchedVersion = Number(fetched?.recordVersion || 0);
      if (!commit.item) {
        if (!fetched) return;
        const fetchedUpdatedAt = Date.parse(String(fetched.updatedAt || ""));
        const isNewerUpload = fetchedVersion > Number(commit.deletedVersion || 0)
          || (Number.isFinite(fetchedUpdatedAt) && fetchedUpdatedAt > commit.committedAt);
        if (isNewerUpload) {
          recentCommittedSlots.delete(slot);
          return;
        }
        delete data.items[slot];
        return;
      }
      const committedVersion = Number(commit.item?.recordVersion || 0);
      const fetchedUpdatedAt = Date.parse(String(fetched?.updatedAt || ""));
      const committedUpdatedAt = Date.parse(String(commit.item?.updatedAt || ""));
      const exactCommit = fetched
        && fetchedVersion === committedVersion
        && String(fetched.updatedAt || "") === String(commit.item.updatedAt || "");
      const newerCommit = fetchedVersion > committedVersion
        || (Number.isFinite(fetchedUpdatedAt) && Number.isFinite(committedUpdatedAt) && fetchedUpdatedAt > committedUpdatedAt);
      if (newerCommit) {
        recentCommittedSlots.delete(slot);
        return;
      }
      if (exactCommit) return;
      data.items[slot] = commit.item;
    });
    return data;
  }

  async function refreshAll() {
    const sequence = ++mediaRefreshSequence;
    const response = await fetch("/api/site-media", { credentials: "same-origin", cache: "no-store" });
    if (sequence !== mediaRefreshSequence) return;
    if (!response.ok) throw new Error("site media unavailable");
    const payload = await response.json();
    if (sequence !== mediaRefreshSequence) return;
    const data = preserveRecentCommits(payload);
    lastMediaData = data;
    reconcileControllers();
    controllers.forEach((controller) => {
      const pendingOperation = pendingSlots.get(controller.slot);
      if (pendingOperation) {
        controller.setPending(true, pendingOperation.action);
        controller.previewItem(pendingOperation.item);
      } else controller.refresh(data);
    });
  }

  window.addEventListener("ihear:auth", (event) => {
    currentSession = event.detail?.session || null;
    controllers.forEach((controller) => controller.renderAdminControl());
  });
  window.addEventListener("ihear:language", () => {
    controllers.forEach((controller) => controller.languageChanged());
  });
  window.addEventListener("ihear:media-slots-changed", reconcileControllers);
  window.addEventListener("beforeunload", (event) => {
    if (!pendingSlots.size) return;
    event.preventDefault();
    event.returnValue = "";
  });

  window.iHearLiveContent?.register("content", {
    refresh: refreshAll,
    isDirty: () => controllers.some((controller) => controller.isDirty()),
    shouldBlock: ({ external }) => external,
    onBlocked: () => controllers.find((controller) => controller.isDirty())?.onBlocked(),
  });

  reconcileControllers();
  refreshAll().catch(() => {
    // Leave the initial placeholder until a later successful metadata refresh.
    // An unavailable API does not confirm that a custom photo was deleted.
  });
  controllers.forEach((controller) => controller.renderAdminControl());
})();
