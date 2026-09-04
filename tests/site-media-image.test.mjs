import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, test, vi } from "vitest";
import sharp from "sharp";

import {
  CLIENT_IMAGE_MAX_BYTES,
  processSiteMediaImage,
  SiteMediaImageError,
} from "../lib/site-media-image";
import { expectedSiteMediaWidths } from "../lib/site-media-storage";

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

  test("creates only non-upscaled 480/800 avatar variants and enforces 500KB", async () => {
    const source = await sharp({
      create: { width: 640, height: 640, channels: 3, background: "#3157b7" },
    }).webp({ quality: 82 }).toBuffer();
    const processed = await processSiteMediaImage(
      new File([source], "avatar.webp", { type: "image/webp" }),
      { avatar: true },
    );
    expect(processed.map((variant) => variant.width)).toEqual([480, 800]);
    expect(processed.every((variant) => variant.pixelWidth <= 640)).toBe(true);
    expect(expectedSiteMediaWidths("team.ryan.avatar")).toEqual([480, 800]);
    expect(expectedSiteMediaWidths("home.hero")).toEqual([480, 800, 1200]);
  });

  test("rejects non-square avatar uploads so uncropped group photos are never published", async () => {
    const source = await sharp({
      create: { width: 800, height: 600, channels: 3, background: "#3157b7" },
    }).webp({ quality: 82 }).toBuffer();
    await expect(processSiteMediaImage(
      new File([source], "group.webp", { type: "image/webp" }),
      { avatar: true },
    )).rejects.toMatchObject({ message: "The cropped avatar must be a square image" });
  });

  test("stores and removes avatar variants locally without contacting Supabase", async () => {
    const previousCwd = process.cwd();
    const localRoot = await mkdtemp(path.join(tmpdir(), "ihear-site-media-"));
    vi.stubEnv("IHEAR_FORCE_FILE_STORE", "1");
    process.chdir(localRoot);
    try {
      vi.resetModules();
      const storage = await import("../lib/site-media-storage");
      const source = await sharp({
        create: { width: 640, height: 640, channels: 3, background: "#3157b7" },
      }).webp({ quality: 82 }).toBuffer();
      const processed = await processSiteMediaImage(
        new File([source], "avatar.webp", { type: "image/webp" }),
        { avatar: true },
      );
      const variants = await storage.uploadSiteMediaVariants("team.local-test.avatar", processed);

      expect(variants.map((variant) => variant.width)).toEqual([480, 800]);
      expect(variants.every((variant) => variant.url.startsWith("/uploads/site-media/"))).toBe(true);
      for (const variant of variants) {
        const filePath = path.join(localRoot, "public", ...variant.url.slice(1).split("/"));
        expect((await readFile(filePath)).byteLength).toBeGreaterThan(0);
      }
      expect((await storage.readSiteMediaObject(variants[1].storagePath)).byteLength).toBeGreaterThan(0);

      await storage.removeSiteMediaObjects(variants.map((variant) => variant.storagePath));
      for (const variant of variants) {
        const filePath = path.join(localRoot, "public", ...variant.url.slice(1).split("/"));
        await expect(access(filePath)).rejects.toMatchObject({ code: "ENOENT" });
      }
    } finally {
      process.chdir(previousCwd);
      vi.unstubAllEnvs();
      await rm(localRoot, { recursive: true, force: true });
    }
  });
});
