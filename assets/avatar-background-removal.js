(function () {
  "use strict";

  const ASSET_BASE = "/assets/vendor/avatar-segmentation/";
  const SCRIPT_URL = `${ASSET_BASE}selfie_segmentation.js`;
  const PROCESSING_TIMEOUT_MS = 45_000;
  let scriptPromise = null;
  let segmenterPromise = null;
  let processingQueue = Promise.resolve();

  function loadScript() {
    if (window.SelfieSegmentation) return Promise.resolve();
    if (scriptPromise) return scriptPromise;
    scriptPromise = new Promise((resolve, reject) => {
      const existing = document.querySelector(`script[src="${SCRIPT_URL}"]`);
      const script = existing || document.createElement("script");
      const finish = () => window.SelfieSegmentation
        ? resolve()
        : reject(new Error("Background removal did not initialize"));
      script.addEventListener("load", finish, { once: true });
      script.addEventListener("error", () => reject(new Error("Background removal could not be loaded")), { once: true });
      if (!existing) {
        script.src = SCRIPT_URL;
        script.async = true;
        document.head.appendChild(script);
      }
    }).catch((error) => {
      scriptPromise = null;
      throw error;
    });
    return scriptPromise;
  }

  async function segmenter() {
    if (segmenterPromise) return segmenterPromise;
    segmenterPromise = (async () => {
      await loadScript();
      const instance = new window.SelfieSegmentation({
        locateFile: (file) => `${ASSET_BASE}${file}`,
      });
      instance.setOptions({ modelSelection: 0, selfieMode: false });
      await instance.initialize();
      return instance;
    })().catch((error) => {
      segmenterPromise = null;
      throw error;
    });
    return segmenterPromise;
  }

  function whiteBackgroundResult(source, mask) {
    if (!source?.width || !source?.height || !mask) {
      throw new Error("Background removal returned no usable result");
    }
    const output = document.createElement("canvas");
    const maskCanvas = document.createElement("canvas");
    output.width = maskCanvas.width = source.width;
    output.height = maskCanvas.height = source.height;
    const context = output.getContext("2d", { alpha: false, willReadFrequently: true });
    const maskContext = maskCanvas.getContext("2d", { willReadFrequently: true });
    context.drawImage(source, 0, 0, output.width, output.height);
    maskContext.filter = "blur(1.25px)";
    maskContext.drawImage(mask, 0, 0, output.width, output.height);
    const pixels = context.getImageData(0, 0, output.width, output.height);
    const maskPixels = maskContext.getImageData(0, 0, output.width, output.height).data;
    for (let index = 0; index < pixels.data.length; index += 4) {
      const confidence = Math.max(maskPixels[index], maskPixels[index + 1], maskPixels[index + 2]) / 255;
      const normalized = Math.max(0, Math.min(1, (confidence - 0.12) / 0.76));
      const foreground = normalized * normalized * (3 - 2 * normalized);
      pixels.data[index] = Math.round(pixels.data[index] * foreground + 255 * (1 - foreground));
      pixels.data[index + 1] = Math.round(pixels.data[index + 1] * foreground + 255 * (1 - foreground));
      pixels.data[index + 2] = Math.round(pixels.data[index + 2] * foreground + 255 * (1 - foreground));
      pixels.data[index + 3] = 255;
    }
    context.putImageData(pixels, 0, 0);
    return output;
  }

  async function removeNow(source, options) {
    options?.onProgress?.("loading");
    const instance = await segmenter();
    options?.onProgress?.("processing");
    return new Promise((resolve, reject) => {
      let settled = false;
      const timeout = window.setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error("Background removal timed out"));
      }, PROCESSING_TIMEOUT_MS);
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeout);
        callback(value);
      };
      instance.onResults((results) => {
        try {
          finish(resolve, whiteBackgroundResult(source, results?.segmentationMask));
        } catch (error) {
          finish(reject, error);
        }
      });
      instance.send({ image: source }).catch((error) => finish(reject, error));
    });
  }

  function remove(source, options) {
    const operation = processingQueue.catch(() => undefined).then(() => removeNow(source, options));
    processingQueue = operation;
    return operation;
  }

  window.iHearAvatarBackgroundRemoval = { remove };
})();
