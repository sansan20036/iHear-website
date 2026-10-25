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

function webpContainer(chunkType, payload = Buffer.alloc(4)) {
  const buffer = Buffer.alloc(20 + payload.byteLength + (payload.byteLength % 2));
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(buffer.byteLength - 8, 4);
  buffer.write("WEBP", 8);
  buffer.write(chunkType, 12);
  buffer.writeUInt32LE(payload.byteLength, 16);
  payload.copy(buffer, 20);
  return buffer;
}

// A 26-byte, 1x1 lossless WebP with valid RIFF/chunk lengths and the full
// five-byte VP8L image header, but no entropy-coded pixel data. This separates
// header-only metadata success from an ordinary full-decode failure.
const headerOnlyLosslessWebP = () => webpContainer("VP8L", Buffer.from([0x2f, 0, 0, 0, 0]));

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

  test.each([
    { name: "lossless", lossless: true },
    { name: "extended with transparency", lossless: false },
  ])("accepts real $name WebP containers", async ({ lossless }) => {
    const source = await sharp({
      create: { width: 640, height: 480, channels: 4, background: { r: 40, g: 65, b: 127, alpha: 0.5 } },
    }).webp({ lossless }).toBuffer();
    const processed = await processSiteMediaImage(new File([source], "valid.webp", { type: "image/webp" }));
    expect(processed.map((variant) => variant.width)).toEqual([480, 800, 1200]);
    for (const variant of processed) {
      expect((await sharp(variant.buffer).metadata()).format).toBe("webp");
    }
  });

  test.each([
    ["SVG declared as WebP", Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>')],
    ["AVIF declared as WebP", Buffer.from("0000002066747970617669660000000061766966617669666d6966316d696166", "hex")],
    ["a truncated RIFF signature", Buffer.from("RIFF")],
    ["a non-ASCII RIFF signature", (() => { const file = webpContainer("VP8 "); file[0] |= 0x80; return file; })()],
    ["a different RIFF format", (() => { const file = webpContainer("VP8 "); file.write("WAVE", 8); return file; })()],
    ["an unsupported first chunk", webpContainer("JUNK")],
    ["a truncated file", webpContainer("VP8 ").subarray(0, 22)],
    ["bytes after the declared container", Buffer.concat([webpContainer("VP8 "), Buffer.from("extra")])],
    ["a chunk extending past the container", (() => { const file = webpContainer("VP8 "); file.writeUInt32LE(100, 16); return file; })()],
    ["a missing odd-chunk padding byte", (() => {
      const file = webpContainer("VP8L", Buffer.from([1])).subarray(0, 21);
      file.writeUInt32LE(file.byteLength - 8, 4);
      return file;
    })()],
    ["an incomplete trailing chunk header", (() => {
      const file = Buffer.concat([webpContainer("VP8 "), Buffer.from("tail")]);
      file.writeUInt32LE(file.byteLength - 8, 4);
      return file;
    })()],
  ])("rejects %s before invoking Sharp", async (_label, input) => {
    const decode = vi.fn();
    vi.doMock("sharp", () => ({ default: decode }));
    try {
      vi.resetModules();
      const { processSiteMediaImage: guardedProcess } = await import("../lib/site-media-image");
      await expect(guardedProcess(new File([input], "disguised.webp", { type: "image/webp" })))
        .rejects.toMatchObject({ name: "SiteMediaImageError", message: "The file contents are not a valid WebP image" });
      expect(decode).not.toHaveBeenCalled();
    } finally {
      vi.doUnmock("sharp");
      vi.resetModules();
    }
  });

  test("reports a corrupt WebP bitstream as a decode error", async () => {
    await expect(processSiteMediaImage(new File([webpContainer("VP8 ")], "corrupt.webp", { type: "image/webp" })))
      .rejects.toMatchObject({ name: "SiteMediaImageError", message: "The uploaded image could not be decoded" });
  });

  test("rejects missing WebP pixel data even when its small header is readable", async () => {
    const source = headerOnlyLosslessWebP();
    expect(source.byteLength).toBe(26);
    await expect(sharp(source, { limitInputPixels: 40_000_000, failOn: "error" }).metadata())
      .resolves.toMatchObject({ format: "webp", width: 1, height: 1 });
    await expect(sharp(source, { limitInputPixels: 40_000_000, failOn: "error" }).webp().toBuffer())
      .rejects.toThrow();
    await expect(processSiteMediaImage(new File([source], "header-only.webp", { type: "image/webp" })))
      .rejects.toThrow();
  });

  test("late WebP decode failure returns the generic route error before upload or persistence", async () => {
    const source = headerOnlyLosslessWebP();
    await expect(sharp(source, { limitInputPixels: 40_000_000, failOn: "error" }).metadata())
      .resolves.toMatchObject({ format: "webp", width: 1, height: 1 });
    const upload = vi.fn();
    const remove = vi.fn();
    const replace = vi.fn();
    const revalidate = vi.fn();
    const revision = vi.fn();
    const processImage = vi.fn(processSiteMediaImage);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const mockedModules = [
      "../auth.js", "../lib/admins", "next/cache", "../lib/live-revisions",
      "../lib/site-media-image", "../lib/site-media-store", "../lib/site-media-storage",
      "../lib/rate-limit", "../lib/translation-core",
    ];
    vi.doMock("../auth.js", () => ({ auth: vi.fn(async () => ({ user: { email: "image-test@example.invalid" } })) }));
    vi.doMock("../lib/admins", () => ({ normalizeEmail: value => String(value || "").toLowerCase(), isAllowedAdmin: vi.fn(async () => true) }));
    vi.doMock("next/cache", () => ({ revalidatePath: revalidate }));
    vi.doMock("../lib/live-revisions", () => ({ revisionAfterMutation: revision }));
    // Preserve the real decoder and actual route/error mapper. Only external
    // boundaries are mocked, so this exercises the failure before persistence.
    vi.doMock("../lib/site-media-image", () => ({ processSiteMediaImage: processImage, MULTIPART_MAX_BYTES: Math.floor(1.25 * 1024 * 1024) }));
    vi.doMock("../lib/site-media-store", () => ({
      replaceSiteMediaAsset: replace, deleteSiteMediaAsset: vi.fn(), updateSiteMediaAssetMetadata: vi.fn(),
      SiteMediaConfigurationError: class extends Error {}, SiteMediaConflictError: class extends Error {},
    }));
    vi.doMock("../lib/site-media-storage", () => ({
      uploadSiteMediaVariants: upload, removeSiteMediaObjects: remove,
      SiteMediaStorageConfigurationError: class extends Error {}, SiteMediaStorageError: class extends Error {},
    }));
    vi.doMock("../lib/rate-limit", () => ({
      RATE_LIMIT_POLICIES: { adminMutation: {}, mediaUpload: {} },
      enforceRateLimit: vi.fn(async () => ({ limited: false })), withRateLimitHeaders: response => response,
    }));
    vi.doMock("../lib/translation-core", () => ({
      manualTranslationWrites: vi.fn(), verifyTranslationReceipt: vi.fn(), TranslationReceiptError: class extends Error {},
    }));
    try {
      vi.resetModules();
      const { POST } = await import("../app/api/site-media/[slot]/route");
      const form = new FormData();
      form.set("file", new File([source], "header-only.webp", { type: "image/webp" }));
      form.set("expectedVersion", "0");
      form.set("altEn", "Test image"); form.set("altZhHant", "測試圖片"); form.set("altZhHans", "测试图片");
      form.set("focalX", "50"); form.set("focalY", "50"); form.set("zoom", "100");
      const response = await POST(new Request("https://image-test.invalid/api/site-media/home.hero", {
        method: "POST", headers: { origin: "https://image-test.invalid" }, body: form,
      }), { params: Promise.resolve({ slot: "home.hero" }) });
      expect(processImage).toHaveBeenCalledOnce();
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: "Could not update the image" });
      expect(upload).not.toHaveBeenCalled();
      expect(replace).not.toHaveBeenCalled();
      expect(remove).not.toHaveBeenCalled();
      expect(revalidate).not.toHaveBeenCalled();
      expect(revision).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalledWith("Site media API error", expect.any(Error));
    } finally {
      for (const name of mockedModules) vi.doUnmock(name);
      vi.resetModules();
      log.mockRestore();
    }
  });

  test.each([
    ["animated images", { format: "webp", width: 640, height: 480, pages: 2 }, "Animated images are not supported"],
    ["non-WebP decoded formats", { format: "png", width: 640, height: 480 }, "The file contents are not a valid WebP image"],
    ["invalid decoded dimensions", { format: "webp", width: 0, height: 480 }, "The file contents are not a valid WebP image"],
  ])("rejects %s after metadata and before encoding", async (_label, metadata, message) => {
    const decode = vi.fn(() => ({ metadata: vi.fn().mockResolvedValue(metadata) }));
    vi.doMock("sharp", () => ({ default: decode }));
    try {
      vi.resetModules();
      const { processSiteMediaImage: guardedProcess } = await import("../lib/site-media-image");
      await expect(guardedProcess(new File([webpContainer("VP8 ")], "metadata.webp", { type: "image/webp" })))
        .rejects.toMatchObject({ name: "SiteMediaImageError", message });
      expect(decode).toHaveBeenCalledTimes(1);
    } finally {
      vi.doUnmock("sharp");
      vi.resetModules();
    }
  });

  test("passes the pixel cap to Sharp and fails closed on oversized dimensions", async () => {
    const decode = vi.fn(() => ({
      metadata: vi.fn().mockRejectedValue(new Error("Input image exceeds pixel limit")),
    }));
    vi.doMock("sharp", () => ({ default: decode }));
    try {
      vi.resetModules();
      const { processSiteMediaImage: guardedProcess } = await import("../lib/site-media-image");
      await expect(guardedProcess(new File([webpContainer("VP8 ")], "oversized-dimensions.webp", { type: "image/webp" })))
        .rejects.toMatchObject({ name: "SiteMediaImageError", message: "The uploaded image could not be decoded" });
      expect(decode).toHaveBeenCalledTimes(1);
      expect(decode).toHaveBeenCalledWith(expect.any(Buffer), { limitInputPixels: 40_000_000, failOn: "error" });
    } finally {
      vi.doUnmock("sharp");
      vi.resetModules();
    }
  });

  test("rejects a real animated WebP made from only two pixels", async () => {
    const source = await sharp(Buffer.from([255, 0, 0, 255, 0, 255, 0, 255]), {
      raw: { width: 1, height: 2, channels: 4, pageHeight: 1 },
    }).webp({ lossless: true, delay: [100, 100], loop: 0 }).toBuffer();
    expect((await sharp(source).metadata()).pages).toBe(2);
    await expect(processSiteMediaImage(new File([source], "animated.webp", { type: "image/webp" })))
      .rejects.toMatchObject({ name: "SiteMediaImageError", message: "Animated images are not supported" });
  });

  test("rejects oversized WebP dimensions using a tiny lossless header fixture", async () => {
    const source = await sharp({
      create: { width: 1, height: 1, channels: 3, background: "#28417f" },
    }).webp({ lossless: true }).toBuffer();
    expect(source.byteLength).toBeLessThan(256);
    expect(source.toString("latin1", 12, 16)).toBe("VP8L");
    expect(source[20]).toBe(0x2f);
    // VP8L stores width - 1 and height - 1 in two 14-bit fields after its signature.
    // Change only the header; no large pixel buffer is created or decoded.
    source.writeUInt32LE(((10_000 - 1) | ((10_000 - 1) << 14)) >>> 0, 21);
    await expect(sharp(source, { limitInputPixels: 40_000_000, failOn: "error" }).metadata())
      .rejects.toThrow(/pixel limit/i);
    await expect(processSiteMediaImage(new File([source], "oversized-dimensions.webp", { type: "image/webp" })))
      .rejects.toMatchObject({ name: "SiteMediaImageError", message: "The uploaded image could not be decoded" });
  });

  test("rejects MIME mismatches and client blobs above the compression ceiling", async () => {
    await expect(processSiteMediaImage(new File([new Uint8Array([1])], "hero.jpg", {
      type: "image/jpeg",
    }))).rejects.toBeInstanceOf(SiteMediaImageError);

    await expect(processSiteMediaImage(new File([
      new Uint8Array(CLIENT_IMAGE_MAX_BYTES + 1),
    ], "hero.webp", { type: "image/webp" }))).rejects.toMatchObject({ status: 413 });
  });

  test.each([
    ["empty uploads", 0, {}],
    ["avatars above 500KB", 500 * 1024 + 1, { avatar: true }],
  ])("rejects %s with 413 before invoking Sharp", async (_label, byteLength, options) => {
    const decode = vi.fn();
    vi.doMock("sharp", () => ({ default: decode }));
    try {
      vi.resetModules();
      const { processSiteMediaImage: guardedProcess } = await import("../lib/site-media-image");
      await expect(guardedProcess(new File([new Uint8Array(byteLength)], "size.webp", { type: "image/webp" }), options))
        .rejects.toMatchObject({ name: "SiteMediaImageError", status: 413 });
      expect(decode).not.toHaveBeenCalled();
    } finally {
      vi.doUnmock("sharp");
      vi.resetModules();
    }
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
