"use client";

import imageCompression from "browser-image-compression";

export const ORIGINAL_IMAGE_MAX_BYTES = 20 * 1024 * 1024;
export const AVATAR_OUTPUT_MAX_BYTES = 500 * 1024;
export const SITE_IMAGE_OUTPUT_MAX_BYTES = Math.floor(0.95 * 1024 * 1024);
export const ALLOWED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

export class ClientImageValidationError extends Error {}

export async function compressAdminImage(
  file: File,
  options: { kind: "avatar" | "site"; signal?: AbortSignal },
) {
  if (!ALLOWED_IMAGE_TYPES.has(file.type)) {
    throw new ClientImageValidationError("Choose a PNG, JPEG, or WebP image.");
  }
  if (file.size < 1 || file.size > ORIGINAL_IMAGE_MAX_BYTES) {
    throw new ClientImageValidationError("The original image must be 20MB or smaller.");
  }
  const avatar = options.kind === "avatar";
  const maximum = avatar ? AVATAR_OUTPUT_MAX_BYTES : SITE_IMAGE_OUTPUT_MAX_BYTES;
  const result = await imageCompression(file, {
    maxSizeMB: avatar ? 500 / 1024 : 0.95,
    maxWidthOrHeight: avatar ? 800 : 1600,
    useWebWorker: true,
    fileType: "image/webp",
    preserveExif: false,
    initialQuality: 0.86,
    signal: options.signal,
  });
  if (result === file || result.type !== "image/webp" || result.size < 1 || result.size > maximum) {
    throw new ClientImageValidationError(
      avatar ? "The optimized avatar must be 500KB or smaller." : "The optimized image is too large.",
    );
  }
  return new File([result], "ihear-image.webp", { type: "image/webp", lastModified: Date.now() });
}
