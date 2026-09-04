import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("../auth.js", () => ({ auth: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("../lib/admins", () => ({
  normalizeEmail: vi.fn((value) => String(value || "").trim().toLowerCase()),
  isAllowedAdmin: vi.fn((email) => email === "admin@example.com"),
}));
vi.mock("../lib/live-revisions", () => ({ revisionAfterMutation: vi.fn() }));
vi.mock("../lib/rate-limit", () => ({
  RATE_LIMIT_POLICIES: {
    adminMutation: { scope: "admin-mutation", limit: 30, windowSeconds: 60 },
    mediaUpload: { scope: "media-upload", limit: 10, windowSeconds: 600 },
  },
  enforceRateLimit: vi.fn(),
  withRateLimitHeaders: vi.fn((response) => response),
}));
vi.mock("../lib/site-media-image", () => {
  class SiteMediaImageError extends Error {
    constructor(message, status = 400) {
      super(message);
      this.status = status;
    }
  }
  return {
    MULTIPART_MAX_BYTES: Math.floor(1.25 * 1024 * 1024),
    SiteMediaImageError,
    processSiteMediaImage: vi.fn(),
  };
});
vi.mock("../lib/site-media-store", () => {
  class SiteMediaConfigurationError extends Error {}
  class SiteMediaConflictError extends Error {
    constructor() {
      super("This image was changed by another administrator");
    }
  }
  return {
    SiteMediaConfigurationError,
    SiteMediaConflictError,
    listSiteMediaAssets: vi.fn(),
    replaceSiteMediaAsset: vi.fn(),
    updateSiteMediaAssetMetadata: vi.fn(),
    deleteSiteMediaAsset: vi.fn(),
  };
});
vi.mock("../lib/site-media-storage", () => {
  class SiteMediaStorageConfigurationError extends Error {}
  class SiteMediaStorageError extends Error {}
  return {
    SiteMediaStorageConfigurationError,
    SiteMediaStorageError,
    uploadSiteMediaVariants: vi.fn(),
    removeSiteMediaObjects: vi.fn(),
    readSiteMediaObject: vi.fn(),
  };
});

import { revalidatePath } from "next/cache";
import { auth } from "../auth.js";
import { GET as getSiteMedia } from "../app/api/site-media/route";
import { DELETE as deleteSiteMedia, PATCH as patchSiteMedia, POST as postSiteMedia } from "../app/api/site-media/[slot]/route";
import { GET as getSiteMediaSource } from "../app/api/site-media/[slot]/source/route";
import * as liveRevisions from "../lib/live-revisions";
import { enforceRateLimit } from "../lib/rate-limit";
import * as image from "../lib/site-media-image";
import * as store from "../lib/site-media-store";
import * as storage from "../lib/site-media-storage";

const variants = [480, 800, 1200].map((width) => ({
  width,
  pixelWidth: width,
  pixelHeight: Math.round(width * 0.75),
  byteSize: 1000,
  mimeType: "image/webp",
  url: `https://project.supabase.co/storage/v1/object/public/site-media/home-hero/id/${width}.webp`,
  storagePath: `home-hero/id/${width}.webp`,
}));

const asset = {
  slot: "home.hero",
  alt: { en: "Students learning", zhHant: "學生學習溝通", zhHans: "学生学习沟通" },
  focalX: 50,
  focalY: 50,
  zoom: 100,
  recordVersion: 1,
  updatedAt: "2026-08-16T00:00:00.000Z",
  updatedBy: "admin@example.com",
  variants,
};

const context = (slot = "home.hero") => ({ params: Promise.resolve({ slot }) });

function uploadRequest({ version = "0", contentLength, origin = "https://example.com" } = {}) {
  const form = new FormData();
  form.set("expectedVersion", version);
  form.set("altEn", asset.alt.en);
  form.set("altZhHant", asset.alt.zhHant);
  form.set("altZhHans", asset.alt.zhHans);
  form.set("focalX", "50");
  form.set("focalY", "50");
  form.set("zoom", "100");
  form.set("file", new File([new Uint8Array([1, 2, 3])], "hero.webp", { type: "image/webp" }));
  const headers = new Headers({ Origin: origin });
  if (contentLength) headers.set("Content-Length", String(contentLength));
  return new Request("https://example.com/api/site-media/home.hero", {
    method: "POST",
    headers,
    body: form,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  auth.mockResolvedValue({ user: { email: "admin@example.com" } });
  enforceRateLimit.mockResolvedValue({
    limited: false,
    result: { limit: 10, remaining: 9, resetAt: Date.now() + 60_000 },
  });
  image.processSiteMediaImage.mockResolvedValue([]);
  storage.uploadSiteMediaVariants.mockResolvedValue(variants);
  storage.removeSiteMediaObjects.mockResolvedValue(undefined);
  storage.readSiteMediaObject.mockResolvedValue(Buffer.from([1, 2, 3, 4]));
  store.listSiteMediaAssets.mockResolvedValue([asset]);
  store.replaceSiteMediaAsset.mockResolvedValue({ asset, previousStoragePaths: [] });
  store.updateSiteMediaAssetMetadata.mockResolvedValue({ ...asset, recordVersion: 2, zoom: 175 });
  store.deleteSiteMediaAsset.mockResolvedValue(variants.map((variant) => variant.storagePath));
  liveRevisions.revisionAfterMutation.mockResolvedValue("2");
});

describe("site media API", () => {
  test("GET is public, briefly cached, and never exposes storage paths or administrators", async () => {
    auth.mockResolvedValue(null);
    const response = await getSiteMedia();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("Vercel-CDN-Cache-Control")).toContain("s-maxage=1");
    expect(body.items["home.hero"].updatedBy).toBeUndefined();
    expect(body.items["home.hero"].variants[0].storagePath).toBeUndefined();
    expect(body.items["home.hero"].srcSet).toContain("480w");
  });

  test("POST rejects non-admin, cross-origin, unknown slots, and oversized bodies before parsing", async () => {
    auth.mockResolvedValue(null);
    expect((await postSiteMedia(uploadRequest(), context())).status).toBe(403);

    auth.mockResolvedValue({ user: { email: "admin@example.com" } });
    expect((await postSiteMedia(uploadRequest({ origin: "https://evil.example" }), context())).status).toBe(403);
    expect((await postSiteMedia(uploadRequest(), context("unknown"))).status).toBe(400);
    const tooLarge = await postSiteMedia(uploadRequest({ contentLength: 2 * 1024 * 1024 }), context());
    expect(tooLarge.status).toBe(413);
    expect(image.processSiteMediaImage).not.toHaveBeenCalled();
  });

  test("POST stores only the processed image, commits metadata, and revalidates all readers", async () => {
    const response = await postSiteMedia(uploadRequest(), context());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(image.processSiteMediaImage).toHaveBeenCalledTimes(1);
    expect(storage.uploadSiteMediaVariants).toHaveBeenCalledWith("home.hero", []);
    expect(store.replaceSiteMediaAsset).toHaveBeenCalledWith(expect.objectContaining({
      slot: "home.hero",
      expectedVersion: 0,
      updatedBy: "admin@example.com",
    }));
    expect(body.item.updatedBy).toBeUndefined();
    expect(revalidatePath).toHaveBeenCalledWith("/");
    expect(revalidatePath).toHaveBeenCalledWith("/api/site-media");
    expect(revalidatePath).toHaveBeenCalledWith("/api/live-revisions");
  });

  test("POST normalizes a cropped avatar to centered square rendering metadata", async () => {
    const response = await postSiteMedia(uploadRequest(), context("team.zoe-lu.avatar"));

    expect(response.status).toBe(200);
    expect(image.processSiteMediaImage).toHaveBeenCalledWith(expect.any(File), { avatar: true });
    expect(store.replaceSiteMediaAsset).toHaveBeenCalledWith(expect.objectContaining({
      slot: "team.zoe-lu.avatar",
      focalX: 50,
      focalY: 50,
      zoom: 100,
    }));
  });

  test.each([
    "services.tutoring",
    "services.outreach",
    "global.volunteers",
    "team.zoe-lu.avatar",
    "team.daniel-hollis.avatar",
    "team.howard-ren.avatar",
    "team.amber-lin.avatar",
    "team.4f41e052-e313-4c1e-9b46-b213484e0bcd.avatar",
  ])(
    "POST accepts the declared sitewide slot %s",
    async (slot) => {
      const response = await postSiteMedia(uploadRequest(), context(slot));
      expect(response.status).toBe(200);
      expect(storage.uploadSiteMediaVariants).toHaveBeenCalledWith(slot, []);
      expect(store.replaceSiteMediaAsset).toHaveBeenCalledWith(expect.objectContaining({ slot }));
    },
  );

  test("POST cleans newly uploaded objects when optimistic locking rejects the transaction", async () => {
    store.replaceSiteMediaAsset.mockRejectedValue(new store.SiteMediaConflictError());
    const response = await postSiteMedia(uploadRequest(), context());

    expect(response.status).toBe(409);
    expect(storage.removeSiteMediaObjects).toHaveBeenCalledWith(
      variants.map((variant) => variant.storagePath),
    );
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  test("POST requires expectedVersion and DELETE restores the default with optimistic locking", async () => {
    const form = new FormData();
    form.set("file", new File([new Uint8Array([1])], "hero.webp", { type: "image/webp" }));
    const missing = await postSiteMedia(new Request("https://example.com/api/site-media/home.hero", {
      method: "POST",
      headers: { Origin: "https://example.com" },
      body: form,
    }), context());
    expect(missing.status).toBe(428);

    const response = await deleteSiteMedia(new Request("https://example.com/api/site-media/home.hero", {
      method: "DELETE",
      headers: { Origin: "https://example.com", "Content-Type": "application/json" },
      body: JSON.stringify({ expectedVersion: 1 }),
    }), context());
    expect(response.status).toBe(200);
    expect(store.deleteSiteMediaAsset).toHaveBeenCalledWith("home.hero", 1);
    expect(storage.removeSiteMediaObjects).toHaveBeenCalledWith(
      variants.map((variant) => variant.storagePath),
    );
    expect(revalidatePath).toHaveBeenCalledWith("/");
  });

  test("PATCH normalizes legacy avatar crop settings without re-uploading or replacing image variants", async () => {
    store.updateSiteMediaAssetMetadata.mockResolvedValueOnce({
      ...asset,
      focalX: 50,
      focalY: 50,
      zoom: 100,
      recordVersion: 2,
    });
    const response = await patchSiteMedia(new Request("https://example.com/api/site-media/team.zoe-lu.avatar", {
      method: "PATCH",
      headers: { Origin: "https://example.com", "Content-Type": "application/json" },
      body: JSON.stringify({
        expectedVersion: 1,
        alt: asset.alt,
        focalX: 37,
        focalY: 64,
        zoom: 175,
      }),
    }), context("team.zoe-lu.avatar"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(store.updateSiteMediaAssetMetadata).toHaveBeenCalledWith(expect.objectContaining({
      slot: "team.zoe-lu.avatar",
      focalX: 50,
      focalY: 50,
      zoom: 100,
      expectedVersion: 1,
    }));
    expect(image.processSiteMediaImage).not.toHaveBeenCalled();
    expect(storage.uploadSiteMediaVariants).not.toHaveBeenCalled();
    expect(body.item.zoom).toBe(100);
    expect(revalidatePath).toHaveBeenCalledWith("/api/site-media");
  });

  test("PATCH validates continuous focal coordinates, zoom range, and optimistic version", async () => {
    const invalid = await patchSiteMedia(new Request("https://example.com/api/site-media/team.zoe-lu.avatar", {
      method: "PATCH",
      headers: { Origin: "https://example.com", "Content-Type": "application/json" },
      body: JSON.stringify({ expectedVersion: 1, alt: asset.alt, focalX: 101, focalY: 50, zoom: 99 }),
    }), context("team.zoe-lu.avatar"));
    expect(invalid.status).toBe(400);
    expect(store.updateSiteMediaAssetMetadata).not.toHaveBeenCalled();

    const missingVersion = await patchSiteMedia(new Request("https://example.com/api/site-media/team.zoe-lu.avatar", {
      method: "PATCH",
      headers: { Origin: "https://example.com", "Content-Type": "application/json" },
      body: JSON.stringify({ alt: asset.alt, focalX: 50, focalY: 50, zoom: 100 }),
    }), context("team.zoe-lu.avatar"));
    expect(missingVersion.status).toBe(428);
  });

  test("avatar source is admin-only, version-locked, same-origin, and never exposes a storage path", async () => {
    const sourceAsset = {
      ...asset,
      slot: "team.zoe-lu.avatar",
      variants: variants.slice(0, 2),
    };
    store.listSiteMediaAssets.mockResolvedValue([sourceAsset]);
    const request = (query = "?expectedVersion=1", origin = "https://example.com") => new Request(
      `https://example.com/api/site-media/team.zoe-lu.avatar/source${query}`,
      { headers: { Origin: origin } },
    );

    auth.mockResolvedValue(null);
    expect((await getSiteMediaSource(request(), context("team.zoe-lu.avatar"))).status).toBe(403);
    auth.mockResolvedValue({ user: { email: "admin@example.com" } });
    expect((await getSiteMediaSource(request("?expectedVersion=1", "https://evil.example"), context("team.zoe-lu.avatar"))).status).toBe(403);
    expect((await getSiteMediaSource(request(""), context("team.zoe-lu.avatar"))).status).toBe(428);
    expect((await getSiteMediaSource(request("?expectedVersion=2"), context("team.zoe-lu.avatar"))).status).toBe(409);

    const response = await getSiteMediaSource(request(), context("team.zoe-lu.avatar"));
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect(response.headers.get("Content-Type")).toBe("image/webp");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(storage.readSiteMediaObject).toHaveBeenCalledWith(variants[1].storagePath);
  });

  test("rate limiting returns 429 without touching image processing", async () => {
    enforceRateLimit.mockResolvedValue({ limited: true, response: new Response("limited", { status: 429 }) });
    const response = await postSiteMedia(uploadRequest(), context());
    expect(response.status).toBe(429);
    expect(image.processSiteMediaImage).not.toHaveBeenCalled();
  });
});
