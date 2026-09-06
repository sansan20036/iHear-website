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

  test("uploads exact binary ArrayBuffers and rejects a corrupted storage readback", async () => {
    const stored = new Map();
    const uploadedBodies = [];
    let corruptUploads = false;
    const remove = vi.fn(async (paths) => {
      paths.forEach((storagePath) => stored.delete(storagePath));
      return { data: null, error: null };
    });
    const bucket = {
      upload: vi.fn(async (storagePath, body) => {
        uploadedBodies.push(body);
        const bytes = Buffer.from(body);
        if (corruptUploads) bytes[4] = bytes[4] ^ 0xff;
        stored.set(storagePath, bytes);
        return { data: { path: storagePath }, error: null };
      }),
      download: vi.fn(async (storagePath) => ({
        data: new Blob([stored.get(storagePath)], { type: "image/webp" }),
        error: null,
      })),
      getPublicUrl: vi.fn((storagePath) => ({
        data: { publicUrl: `https://project.supabase.co/${storagePath}` },
      })),
      remove,
    };

    vi.stubEnv("IHEAR_FORCE_FILE_STORE", "0");
    vi.stubEnv("SUPABASE_URL", "https://project.supabase.co");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "test-service-role-key");
    vi.doMock("@supabase/supabase-js", () => ({
      createClient: () => ({ storage: { from: () => bucket } }),
    }));

    try {
      vi.resetModules();
      const storage = await import("../lib/site-media-storage");
      const sourceBytes = Buffer.from([
        0x52, 0x49, 0x46, 0x46, 0xa7, 0x2a, 0x00, 0x00,
        0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20,
      ]);
      const processed = [480, 800].map((width) => ({
        width,
        pixelWidth: width,
        pixelHeight: width,
        byteSize: sourceBytes.byteLength,
        mimeType: "image/webp",
        buffer: sourceBytes,
      }));

      const variants = await storage.uploadSiteMediaVariants("team.binary-test.avatar", processed);
      expect(variants).toHaveLength(2);
      expect(uploadedBodies.every((body) => body instanceof ArrayBuffer)).toBe(true);
      expect(Buffer.from(uploadedBodies[0])).toEqual(sourceBytes);
      expect(Buffer.from(uploadedBodies[0])).not.toContain(0xef);

      corruptUploads = true;
      await expect(storage.uploadSiteMediaVariants("team.corrupt-test.avatar", processed))
        .rejects.toMatchObject({
          name: "SiteMediaStorageError",
          message: "The stored image bytes did not match the generated image",
        });
      expect(remove).toHaveBeenCalled();
    } finally {
      vi.doUnmock("@supabase/supabase-js");
      vi.resetModules();
      vi.unstubAllEnvs();
    }
  });
});
