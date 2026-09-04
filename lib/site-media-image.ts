import sharp, { type Metadata } from "sharp";

export const CLIENT_IMAGE_MAX_BYTES = Math.floor(0.95 * 1024 * 1024);
export const AVATAR_IMAGE_MAX_BYTES = 500 * 1024;
export const MULTIPART_MAX_BYTES = Math.floor(1.25 * 1024 * 1024);
export const SITE_MEDIA_WIDTHS = [480, 800, 1200] as const;

export class SiteMediaImageError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "SiteMediaImageError";
    this.status = status;
  }
}

export type ProcessedSiteMediaVariant = {
  width: number;
  pixelWidth: number;
  pixelHeight: number;
  byteSize: number;
  mimeType: "image/webp";
  buffer: Buffer;
};

async function encodeVariant(input: Buffer, width: number) {
  for (const quality of [82, 76, 70, 64]) {
    const result = await sharp(input, { limitInputPixels: 40_000_000, failOn: "error" })
      .rotate()
      .resize({ width, withoutEnlargement: true })
      .webp({ quality, effort: 5, smartSubsample: true })
      .toBuffer({ resolveWithObject: true });
    if (result.data.byteLength <= 1024 * 1024) return result;
  }
  throw new SiteMediaImageError("The optimized image is still larger than 1MB", 413);
}

export async function processSiteMediaImage(
  file: File,
  options: { avatar?: boolean } = {},
): Promise<ProcessedSiteMediaVariant[]> {
  if (file.type !== "image/webp") {
    throw new SiteMediaImageError("The uploaded file must be a compressed WebP image");
  }
  const maximumBytes = options.avatar ? AVATAR_IMAGE_MAX_BYTES : CLIENT_IMAGE_MAX_BYTES;
  if (file.size < 1 || file.size > maximumBytes) {
    throw new SiteMediaImageError(
      options.avatar
        ? "The compressed avatar must be 500KB or smaller"
        : "The compressed image must be smaller than 0.95MB",
      413,
    );
  }

  const input = Buffer.from(await file.arrayBuffer());
  let metadata: Metadata;
  try {
    metadata = await sharp(input, { limitInputPixels: 40_000_000, failOn: "error" }).metadata();
  } catch {
    throw new SiteMediaImageError("The uploaded image could not be decoded");
  }
  if (metadata.format !== "webp" || !metadata.width || !metadata.height) {
    throw new SiteMediaImageError("The file contents are not a valid WebP image");
  }
  if ((metadata.pages || 1) !== 1) {
    throw new SiteMediaImageError("Animated images are not supported");
  }
  if (options.avatar && metadata.width !== metadata.height) {
    throw new SiteMediaImageError("The cropped avatar must be a square image");
  }

  const widths = options.avatar ? SITE_MEDIA_WIDTHS.filter((width) => width <= 800) : SITE_MEDIA_WIDTHS;
  return Promise.all(widths.map(async (width) => {
    const result = await encodeVariant(input, width);
    return {
      width,
      pixelWidth: result.info.width,
      pixelHeight: result.info.height,
      byteSize: result.data.byteLength,
      mimeType: "image/webp" as const,
      buffer: result.data,
    };
  }));
}
