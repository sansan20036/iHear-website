import { describe, expect, test } from "vitest";
import sharp from "sharp";

import {
  CLIENT_IMAGE_MAX_BYTES,
  processSiteMediaImage,
  SiteMediaImageError,
} from "../lib/site-media-image";

describe("site media image processing", () => {
  test("decodes a real WebP and generates the three bounded responsive variants", async () => {
    const source = await sharp({
      create: { width: 1800, height: 1200, channels: 3, background: "#28417f" },
    }).webp({ quality: 90 }).toBuffer();
    const file = new File([source], "hero.webp", { type: "image/webp" });
    const processed = await processSiteMediaImage(file);

    expect(processed.map((variant) => variant.width)).toEqual([480, 800, 1200]);
    for (const variant of processed) {
      expect(variant.buffer.byteLength).toBeGreaterThan(0);
      expect(variant.buffer.byteLength).toBeLessThanOrEqual(1024 * 1024);
      const metadata = await sharp(variant.buffer).metadata();
      expect(metadata.format).toBe("webp");
      expect(metadata.width).toBe(variant.pixelWidth);
      expect(metadata.height).toBe(variant.pixelHeight);
    }
  });

  test("rejects MIME mismatches and client blobs above the compression ceiling", async () => {
    await expect(processSiteMediaImage(new File([new Uint8Array([1])], "hero.jpg", {
      type: "image/jpeg",
    }))).rejects.toBeInstanceOf(SiteMediaImageError);

    await expect(processSiteMediaImage(new File([
      new Uint8Array(CLIENT_IMAGE_MAX_BYTES + 1),
    ], "hero.webp", { type: "image/webp" }))).rejects.toMatchObject({ status: 413 });
  });
});
