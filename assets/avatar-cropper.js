(function () {
  "use strict";

  const OUTPUT_SIZE = 800;
  const MAX_OUTPUT_BYTES = 500 * 1024;
  const MAX_SOURCE_BYTES = 20 * 1024 * 1024;
  const ALLOWED_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
  const MIN_CROP_FRACTION = 0.08;
  const imageIntakePromise = import("/assets/image-intake.js").catch(() => null);
  const copy = {
    en: {
      title: "Crop one person",
      intro: "Move and resize the circle around the person you want to show.",
      stage: "Full photo crop area",
      preview: "Profile photo preview",
      help: "Drag the circle to move it. Drag a corner or use the zoom slider to change its size.",
      zoom: "Zoom person",
      less: "Show more",
      more: "Zoom in",
      reset: "Reset",
      choose: "Choose another photo",
      replaceHint: "You can also paste or drop a different photo here.",
      cancel: "Cancel",
      confirm: "Confirm crop",
      processing: "Preparing the cropped photo…",
      warning: "This crop uses fewer than 480 source pixels and may look blurry.",
      quality: "Crop source: {pixels} × {pixels}px",
      move: "Crop circle. Use arrow keys to move; hold Shift for larger steps.",
      handle: "Resize crop from the {corner} corner",
      corners: { nw: "top-left", ne: "top-right", sw: "bottom-left", se: "bottom-right" },
      invalidType: "Choose a PNG, JPEG, or WebP image.",
      tooLarge: "The original image must be 20MB or smaller.",
      loadFailed: "The photo could not be opened.",
      clipboardEmpty: "The clipboard does not contain an image.",
      multipleImages: "Please add one image at a time.",
      outputFailed: "The cropped photo could not be prepared under 500KB.",
      moved: "Crop moved. Center {x}% horizontally and {y}% vertically. Zoom {zoom}%.",
    },
    zhHant: {
      title: "裁切單一人物",
      intro: "移動並縮放圓框，圈選要顯示的小老師。",
      stage: "完整照片裁切區",
      preview: "頭像即時預覽",
      help: "拖曳圓框可移動位置；拖曳四角或使用滑桿可調整範圍。",
      zoom: "放大人物",
      less: "顯示更多",
      more: "放大",
      reset: "重設",
      choose: "選擇其他照片",
      replaceHint: "也可以直接在這裡貼上或拖入另一張照片。",
      cancel: "取消",
      confirm: "確認裁切",
      processing: "正在準備裁切後的照片…",
      warning: "此範圍少於 480 個原始像素，公開頭像可能較模糊。",
      quality: "裁切來源：{pixels} × {pixels}px",
      move: "圓形裁切框。使用方向鍵移動，按住 Shift 可加大移動幅度。",
      handle: "從{corner}調整裁切範圍",
      corners: { nw: "左上角", ne: "右上角", sw: "左下角", se: "右下角" },
      invalidType: "請選擇 PNG、JPEG 或 WebP 圖片。",
      tooLarge: "原始圖片不可超過 20MB。",
      loadFailed: "無法開啟這張照片。",
      clipboardEmpty: "剪貼簿中沒有可使用的圖片。",
      multipleImages: "一次只能加入一張圖片。",
      outputFailed: "無法將裁切照片處理至 500KB 以下。",
      moved: "裁切位置已更新，水平中心 {x}%，垂直中心 {y}%，放大 {zoom}%。",
    },
    zhHans: {
      title: "裁切单一人物",
      intro: "移动并缩放圆框，圈选要显示的小老师。",
      stage: "完整照片裁切区",
      preview: "头像即时预览",
      help: "拖动圆框可移动位置；拖动四角或使用滑块可调整范围。",
      zoom: "放大人物",
      less: "显示更多",
      more: "放大",
      reset: "重设",
      choose: "选择其他照片",
      replaceHint: "也可以直接在这里粘贴或拖入另一张照片。",
      cancel: "取消",
      confirm: "确认裁切",
      processing: "正在准备裁切后的照片…",
      warning: "此范围少于 480 个原始像素，公开头像可能较模糊。",
      quality: "裁切来源：{pixels} × {pixels}px",
      move: "圆形裁切框。使用方向键移动，按住 Shift 可加大移动幅度。",
      handle: "从{corner}调整裁切范围",
      corners: { nw: "左上角", ne: "右上角", sw: "左下角", se: "右下角" },
      invalidType: "请选择 PNG、JPEG 或 WebP 图片。",
      tooLarge: "原始图片不可超过 20MB。",
      loadFailed: "无法打开这张照片。",
      clipboardEmpty: "剪贴板中没有可使用的图片。",
      multipleImages: "一次只能添加一张图片。",
      outputFailed: "无法将裁切照片处理至 500KB 以下。",
      moved: "裁切位置已更新，水平中心 {x}%，垂直中心 {y}%，放大 {zoom}%。",
    },
  };

  let active = null;
  let dialog = null;
  let image = null;
  let stage = null;
  let overlay = null;
  let preview = null;
  let zoomInput = null;
  let status = null;
  let live = null;
  let fileInput = null;
  let objectUrl = "";
  let naturalWidth = 0;
  let naturalHeight = 0;
  let crop = { x: 0, y: 0, size: 0 };
  let pointer = null;
  let renderFrame = 0;
  let busy = false;

  function locale(value) {
    if (value === "zhHans" || value === "zhHant" || value === "en") return value;
    const language = (document.documentElement.lang || "en").toLowerCase();
    if (language.includes("hans")) return "zhHans";
    if (language.startsWith("zh")) return "zhHant";
    return "en";
  }

  function labels() {
    return copy[active?.locale || "en"] || copy.en;
  }

  function interpolate(value, replacements) {
    return Object.entries(replacements).reduce(
      (result, [key, replacement]) => result.split(`{${key}}`).join(String(replacement)),
      value,
    );
  }

  function createDialog() {
    const node = document.createElement("dialog");
    node.className = "ihear-avatar-crop-dialog";
    node.innerHTML = `
      <form method="dialog" class="ihear-avatar-crop-form">
        <header class="ihear-avatar-crop-header">
          <div><h2 data-avatar-crop-title></h2><p data-avatar-crop-intro></p></div>
          <button type="button" class="ihear-avatar-crop-close" data-avatar-crop-cancel aria-label="Close">×</button>
        </header>
        <div class="ihear-avatar-crop-layout">
          <section class="ihear-avatar-crop-workspace" aria-labelledby="ihear-avatar-crop-stage-label">
            <h3 id="ihear-avatar-crop-stage-label" data-avatar-crop-stage-label></h3>
            <div class="ihear-avatar-crop-stage" data-avatar-crop-stage>
              <img data-avatar-crop-image alt="">
              <div class="ihear-avatar-crop-selection" data-avatar-crop-selection tabindex="0">
                <span class="ihear-avatar-crop-grid" aria-hidden="true"></span>
                <button type="button" data-crop-handle="nw"></button>
                <button type="button" data-crop-handle="ne"></button>
                <button type="button" data-crop-handle="sw"></button>
                <button type="button" data-crop-handle="se"></button>
              </div>
            </div>
            <p class="ihear-avatar-crop-help" data-avatar-crop-help></p>
            <label class="ihear-avatar-crop-zoom">
              <span><strong data-avatar-crop-zoom-label></strong><output data-avatar-crop-zoom-output></output></span>
              <span class="ihear-avatar-crop-range"><small data-avatar-crop-less></small><input type="range" min="100" max="1250" step="5" value="200" data-avatar-crop-zoom><small data-avatar-crop-more></small></span>
            </label>
          </section>
          <aside class="ihear-avatar-crop-preview-panel">
            <h3 data-avatar-crop-preview-label></h3>
            <canvas width="320" height="320" data-avatar-crop-preview></canvas>
            <p class="ihear-avatar-crop-quality" data-avatar-crop-quality></p>
            <p class="ihear-avatar-crop-warning" data-avatar-crop-warning role="status" hidden></p>
            <div class="ihear-avatar-crop-secondary-actions">
              <button type="button" data-avatar-crop-reset></button>
              <label class="ihear-avatar-crop-choose"><span data-avatar-crop-choose-label></span><input type="file" accept="image/png,image/jpeg,image/webp" data-avatar-crop-file></label>
              <p class="ihear-avatar-crop-intake-hint" data-avatar-crop-intake-hint></p>
            </div>
          </aside>
        </div>
        <p class="ihear-avatar-crop-status" data-avatar-crop-status role="alert"></p>
        <p class="ihear-avatar-crop-live" data-avatar-crop-live aria-live="polite"></p>
        <footer class="ihear-avatar-crop-actions">
          <button type="button" data-avatar-crop-cancel></button>
          <button type="button" class="ihear-avatar-crop-confirm" data-avatar-crop-confirm></button>
        </footer>
      </form>`;
    document.body.appendChild(node);
    dialog = node;
    image = node.querySelector("[data-avatar-crop-image]");
    stage = node.querySelector("[data-avatar-crop-stage]");
    overlay = node.querySelector("[data-avatar-crop-selection]");
    preview = node.querySelector("[data-avatar-crop-preview]");
    zoomInput = node.querySelector("[data-avatar-crop-zoom]");
    status = node.querySelector("[data-avatar-crop-status]");
    live = node.querySelector("[data-avatar-crop-live]");
    fileInput = node.querySelector("[data-avatar-crop-file]");
    node.querySelectorAll("[data-avatar-crop-cancel]").forEach((button) => button.addEventListener("click", cancel));
    node.querySelector("[data-avatar-crop-confirm]").addEventListener("click", confirm);
    node.querySelector("[data-avatar-crop-reset]").addEventListener("click", resetCrop);
    fileInput.addEventListener("change", (event) => {
      const selected = event.target.files?.[0];
      event.target.value = "";
      if (selected) loadSource(selected);
    });
    ["dragenter", "dragover"].forEach((name) => stage.addEventListener(name, (event) => {
      event.preventDefault();
      if (!busy) stage.classList.add("is-dragging");
    }));
    ["dragleave", "drop"].forEach((name) => stage.addEventListener(name, (event) => {
      event.preventDefault();
      stage.classList.remove("is-dragging");
    }));
    stage.addEventListener("drop", (event) => {
      if (!busy) void receiveTransferredImage(event.dataTransfer, false);
    });
    node.addEventListener("paste", (event) => {
      if (busy) return;
      const hasFiles = Boolean(event.clipboardData?.files?.length)
        || Array.from(event.clipboardData?.items || []).some((item) => item.kind === "file");
      if (!hasFiles) return;
      event.preventDefault();
      void receiveTransferredImage(event.clipboardData, true);
    });
    zoomInput.addEventListener("input", resizeFromZoom);
    overlay.addEventListener("pointerdown", pointerDown);
    overlay.addEventListener("pointermove", pointerMove);
    overlay.addEventListener("pointerup", pointerEnd);
    overlay.addEventListener("pointercancel", pointerEnd);
    overlay.addEventListener("keydown", keyMove);
    node.addEventListener("cancel", (event) => {
      event.preventDefault();
      if (!busy) cancel();
    });
    new ResizeObserver(scheduleRender).observe(stage);
  }

  function localizeDialog() {
    const text = labels();
    const values = {
      "[data-avatar-crop-title]": text.title,
      "[data-avatar-crop-intro]": text.intro,
      "[data-avatar-crop-stage-label]": text.stage,
      "[data-avatar-crop-preview-label]": text.preview,
      "[data-avatar-crop-help]": text.help,
      "[data-avatar-crop-zoom-label]": text.zoom,
      "[data-avatar-crop-less]": text.less,
      "[data-avatar-crop-more]": text.more,
      "[data-avatar-crop-reset]": text.reset,
      "[data-avatar-crop-choose-label]": text.choose,
      "[data-avatar-crop-intake-hint]": text.replaceHint,
      "[data-avatar-crop-confirm]": text.confirm,
    };
    Object.entries(values).forEach(([selector, value]) => {
      dialog.querySelector(selector).textContent = value;
    });
    dialog.querySelectorAll("[data-avatar-crop-cancel]").forEach((button) => {
      if (!button.classList.contains("ihear-avatar-crop-close")) button.textContent = text.cancel;
      button.setAttribute("aria-label", text.cancel);
    });
    overlay.setAttribute("aria-label", text.move);
    dialog.querySelectorAll("[data-crop-handle]").forEach((handle) => {
      const corner = text.corners[handle.dataset.cropHandle];
      handle.setAttribute("aria-label", interpolate(text.handle, { corner }));
    });
  }

  function setBusy(value) {
    busy = value;
    dialog.toggleAttribute("data-busy", value);
    dialog.querySelectorAll("button,input").forEach((control) => { control.disabled = value; });
    if (!value) fileInput.disabled = false;
  }

  function setError(message) {
    status.textContent = message || "";
  }

  async function receiveTransferredImage(transfer, fromClipboard) {
    const intake = await imageIntakePromise;
    if (!intake) return setError(labels().loadFailed);
    const result = intake.singleImageFromTransfer(transfer);
    if (result.status === "empty") return setError(fromClipboard ? labels().clipboardEmpty : labels().invalidType);
    if (result.status === "multiple") return setError(labels().multipleImages);
    await loadSource(result.file);
  }

  function revokeObjectUrl() {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = "";
  }

  function sourceUrl(source) {
    revokeObjectUrl();
    if (source instanceof File || source instanceof Blob) {
      objectUrl = URL.createObjectURL(source);
      return objectUrl;
    }
    return String(source || "");
  }

  function validateFile(file) {
    if (!ALLOWED_TYPES.has(file.type)) throw new Error(labels().invalidType);
    if (file.size < 1 || file.size > MAX_SOURCE_BYTES) throw new Error(labels().tooLarge);
  }

  async function loadSource(source) {
    setError("");
    try {
      if (source instanceof File) validateFile(source);
      const url = sourceUrl(source);
      if (!url) throw new Error(labels().loadFailed);
      await new Promise((resolve, reject) => {
        image.onload = resolve;
        image.onerror = reject;
        image.crossOrigin = url.startsWith("blob:") ? "" : "anonymous";
        image.src = url;
      });
      naturalWidth = image.naturalWidth;
      naturalHeight = image.naturalHeight;
      if (!naturalWidth || !naturalHeight) throw new Error(labels().loadFailed);
      active.source = source;
      resetCrop();
      overlay.focus();
    } catch (error) {
      setError(error?.message || labels().loadFailed);
    }
  }

  function resetCrop() {
    if (!naturalWidth || !naturalHeight) return;
    const minimum = Math.min(naturalWidth, naturalHeight);
    const size = minimum * 0.5;
    crop = { x: (naturalWidth - size) / 2, y: (naturalHeight - size) / 2, size };
    syncZoom();
    scheduleRender();
  }

  function imageDisplayRect() {
    const width = stage.clientWidth;
    const height = stage.clientHeight;
    const scale = Math.min(width / naturalWidth, height / naturalHeight);
    const displayWidth = naturalWidth * scale;
    const displayHeight = naturalHeight * scale;
    return {
      x: (width - displayWidth) / 2,
      y: (height - displayHeight) / 2,
      width: displayWidth,
      height: displayHeight,
      scale,
    };
  }

  function clampCrop(next) {
    const minimum = Math.max(1, Math.min(naturalWidth, naturalHeight) * MIN_CROP_FRACTION);
    const size = Math.max(minimum, Math.min(Math.min(naturalWidth, naturalHeight), next.size));
    return {
      size,
      x: Math.max(0, Math.min(naturalWidth - size, next.x)),
      y: Math.max(0, Math.min(naturalHeight - size, next.y)),
    };
  }

  function scheduleRender() {
    cancelAnimationFrame(renderFrame);
    renderFrame = requestAnimationFrame(render);
  }

  function render() {
    if (!naturalWidth || !naturalHeight || !stage.clientWidth || !stage.clientHeight) return;
    const rect = imageDisplayRect();
    overlay.style.left = `${rect.x + crop.x * rect.scale}px`;
    overlay.style.top = `${rect.y + crop.y * rect.scale}px`;
    overlay.style.width = `${crop.size * rect.scale}px`;
    overlay.style.height = `${crop.size * rect.scale}px`;
    const context = preview.getContext("2d");
    context.clearRect(0, 0, preview.width, preview.height);
    context.drawImage(image, crop.x, crop.y, crop.size, crop.size, 0, 0, preview.width, preview.height);
    const pixels = Math.round(crop.size);
    const warning = pixels < 480;
    dialog.querySelector("[data-avatar-crop-quality]").textContent = interpolate(labels().quality, { pixels });
    const warningNode = dialog.querySelector("[data-avatar-crop-warning]");
    warningNode.hidden = !warning;
    warningNode.textContent = warning ? labels().warning : "";
    const zoom = Math.round((Math.min(naturalWidth, naturalHeight) / crop.size) * 100);
    dialog.querySelector("[data-avatar-crop-zoom-output]").textContent = `${zoom}%`;
    const centerX = Math.round(((crop.x + crop.size / 2) / naturalWidth) * 100);
    const centerY = Math.round(((crop.y + crop.size / 2) / naturalHeight) * 100);
    live.textContent = interpolate(labels().moved, { x: centerX, y: centerY, zoom });
  }

  function syncZoom() {
    zoomInput.value = String(Math.max(100, Math.min(1250, Math.round((Math.min(naturalWidth, naturalHeight) / crop.size) * 100))));
  }

  function resizeFromZoom() {
    if (!naturalWidth || !naturalHeight) return;
    const centerX = crop.x + crop.size / 2;
    const centerY = crop.y + crop.size / 2;
    const size = Math.min(naturalWidth, naturalHeight) * 100 / Number(zoomInput.value);
    crop = clampCrop({ x: centerX - size / 2, y: centerY - size / 2, size });
    scheduleRender();
  }

  function pointerDown(event) {
    if (busy || !naturalWidth) return;
    const handle = event.target.closest("[data-crop-handle]")?.dataset.cropHandle || "move";
    pointer = { id: event.pointerId, x: event.clientX, y: event.clientY, crop: { ...crop }, handle };
    overlay.setPointerCapture(event.pointerId);
    event.preventDefault();
  }

  function pointerMove(event) {
    if (!pointer || pointer.id !== event.pointerId) return;
    const rect = imageDisplayRect();
    const dx = (event.clientX - pointer.x) / rect.scale;
    const dy = (event.clientY - pointer.y) / rect.scale;
    const start = pointer.crop;
    if (pointer.handle === "move") {
      crop = clampCrop({ x: start.x + dx, y: start.y + dy, size: start.size });
    } else {
      const right = start.x + start.size;
      const bottom = start.y + start.size;
      let size;
      let x = start.x;
      let y = start.y;
      if (pointer.handle === "nw") {
        size = start.size - Math.max(dx, dy); x = right - size; y = bottom - size;
      } else if (pointer.handle === "ne") {
        size = start.size + Math.min(dx, -dy); y = bottom - size;
      } else if (pointer.handle === "sw") {
        size = start.size + Math.min(-dx, dy); x = right - size;
      } else {
        size = start.size + Math.min(dx, dy);
      }
      crop = clampCrop({ x, y, size });
    }
    syncZoom();
    scheduleRender();
  }

  function pointerEnd(event) {
    if (pointer?.id === event.pointerId) pointer = null;
  }

  function keyMove(event) {
    if (!naturalWidth || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
    const step = Math.min(naturalWidth, naturalHeight) * (event.shiftKey ? 0.05 : 0.01);
    const dx = event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0;
    const dy = event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0;
    crop = clampCrop({ x: crop.x + dx, y: crop.y + dy, size: crop.size });
    event.preventDefault();
    scheduleRender();
  }

  function canvasBlob(canvas, quality) {
    return new Promise((resolve) => {
      canvas.toBlob(resolve, "image/webp", quality);
    });
  }

  async function createOutput() {
    const canvas = document.createElement("canvas");
    canvas.width = OUTPUT_SIZE;
    canvas.height = OUTPUT_SIZE;
    const context = canvas.getContext("2d", { alpha: false });
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, OUTPUT_SIZE, OUTPUT_SIZE);
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(image, crop.x, crop.y, crop.size, crop.size, 0, 0, OUTPUT_SIZE, OUTPUT_SIZE);
    for (const quality of [0.9, 0.84, 0.78, 0.72, 0.66, 0.6, 0.54, 0.48]) {
      const blob = await canvasBlob(canvas, quality);
      if (blob?.type === "image/webp" && blob.size > 0 && blob.size <= MAX_OUTPUT_BYTES) {
        return new File([blob], "avatar.webp", { type: "image/webp", lastModified: Date.now() });
      }
    }
    throw new Error(labels().outputFailed);
  }

  async function confirm() {
    if (busy || !naturalWidth) return;
    setBusy(true);
    setError(labels().processing);
    try {
      const file = await createOutput();
      const result = {
        file,
        sourceWidth: naturalWidth,
        sourceHeight: naturalHeight,
        cropPixels: Math.round(crop.size),
        warning: crop.size < 480,
      };
      finish(result);
    } catch (error) {
      setError(error?.message || labels().outputFailed);
      setBusy(false);
    }
  }

  function cancel() {
    if (!busy) finish(null);
  }

  function finish(result) {
    const resolver = active?.resolve;
    active = null;
    pointer = null;
    setBusy(false);
    setError("");
    image.removeAttribute("src");
    revokeObjectUrl();
    dialog.close();
    resolver?.(result);
  }

  async function open(options) {
    if (active) throw new Error("The avatar cropper is already open");
    if (!dialog) createDialog();
    return new Promise((resolve) => {
      active = { resolve, locale: locale(options?.locale), source: options?.source || null };
      localizeDialog();
      naturalWidth = 0;
      naturalHeight = 0;
      preview.getContext("2d").clearRect(0, 0, preview.width, preview.height);
      setError("");
      dialog.showModal();
      loadSource(options?.source);
    });
  }

  window.iHearAvatarCropper = { open };
})();
