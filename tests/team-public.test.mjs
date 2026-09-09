import { beforeEach, expect, test, vi } from "vitest";
vi.mock("node:fs/promises", () => ({ readFile: vi.fn() }));
vi.mock("../lib/site-media-store", () => ({ listSiteMediaAssets: vi.fn(), findSiteMediaImagePath: vi.fn() }));
vi.mock("../lib/site-media-storage", () => ({ readSiteMediaObject: vi.fn() }));
vi.mock("../lib/content-store", () => ({ readContentStore: vi.fn(), publicContentStore: value => value }));
import { readFile } from "node:fs/promises";
import { GET as page } from "../app/team/route";
import { POST as legacySubmit } from "../app/api/team-access/route";
import { GET as media } from "../app/api/site-media/route";
import { GET as photo } from "../app/api/site-media/[slot]/image/route";
import { GET as content } from "../app/api/content/get/route";
import { listSiteMediaAssets, findSiteMediaImagePath } from "../lib/site-media-store";
import { readSiteMediaObject } from "../lib/site-media-storage";
import { readContentStore } from "../lib/content-store";
import { publicSiteMediaAsset } from "../lib/site-media-types";
beforeEach(() => vi.resetAllMocks());
test("anonymous page entries render the roster and clear obsolete cookies", async () => {
  const html = '<html><body data-team-tutors>Current team</body></html>';
  readFile.mockResolvedValue(html);
  for (const cookie of ["", "ihear-team-access=old-pass"]) {
    const response = await page(new Request("https://www.ihearus.org/team", { headers: { cookie } }));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(html);
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(response.headers.get("x-robots-tag")).toBeNull();
  }
});
test("old form submissions redirect without password verification", async () => {
  const response = await legacySubmit(new Request("https://www.ihearus.org/api/team-access", { method: "POST" }));
  expect(response.status).toBe(303);
  expect(response.headers.get("location")).toBe("https://www.ihearus.org/team");
});
test("anonymous visitors receive team media metadata and photo bytes", async () => {
  listSiteMediaAssets.mockResolvedValue([{ slot: "team.test.avatar", recordVersion: 1, variants: [{ width: 480, pixelWidth: 480, storagePath: "team-photo" }], alt: {} }]);
  const response = await media();
  expect((await response.json()).items["team.test.avatar"].src).toContain("/api/site-media/");
  findSiteMediaImagePath.mockResolvedValue("team-photo");
  readSiteMediaObject.mockResolvedValue(Buffer.from("photo-bytes"));
  const image = await photo(new Request("https://www.ihearus.org/api/site-media/team.test.avatar/image?width=480"), { params: Promise.resolve({ slot: "team.test.avatar" }) });
  expect(image.status).toBe(200);
  expect(await image.text()).toBe("photo-bytes");
});
test("anonymous content includes current team translations", async () => {
  const current = { locales: { en: { pages: { "/team": { name: "Current name" } }, itemUpdatedAt: { "/team": { name: "timestamp" } } } } };
  readContentStore.mockResolvedValue(current);
  expect(await (await content()).json()).toEqual(current);
});

test("exact image URLs cache in the browser and CDN; legacy URLs stay fresh", async () => {
  findSiteMediaImagePath.mockResolvedValue("team-test/upload-a/480.webp");
  readSiteMediaObject.mockResolvedValue(Buffer.from("same-image"));
  const context = { params: Promise.resolve({ slot: "team.test.avatar" }) };
  const url = "https://www.ihearus.org/api/site-media/team.test.avatar/image?width=480&v=1";
  const cached = await photo(new Request(url + "&asset=team-test%2Fupload-a%2F480.webp"), context);
  expect(cached.status).toBe(200);
  expect(cached.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
  expect(cached.headers.get("vercel-cdn-cache-control")).toBe("public, s-maxage=31536000");
  expect(await cached.text()).toBe("same-image");
  const legacy = await photo(new Request(url), context);
  expect(legacy.headers.get("cache-control")).toContain("no-store");
});

test("replaced or missing images never cache wrong bytes at an old URL", async () => {
  findSiteMediaImagePath.mockResolvedValue("team-test/upload-b/480.webp");
  const request = new Request("https://www.ihearus.org/api/site-media/team.test.avatar/image?width=480&v=1&asset=team-test%2Fupload-a%2F480.webp");
  const context = { params: Promise.resolve({ slot: "team.test.avatar" }) };
  const replaced = await photo(request, context);
  expect(replaced.status).toBe(404);
  expect(replaced.headers.get("cache-control")).toContain("no-store");
  expect(readSiteMediaObject).not.toHaveBeenCalled();
  findSiteMediaImagePath.mockResolvedValue(null);
  const deleted = await photo(request, context);
  expect(deleted.status).toBe(404);
  expect(deleted.headers.get("vercel-cdn-cache-control")).toBe("no-store");
});

test("recreating a slot with the same record version gets a different cache URL", () => {
  const asset = { slot: "team.test.avatar", recordVersion: 1, variants: [{ width: 480, pixelWidth: 480, storagePath: "team-test/upload-a/480.webp" }] };
  const first = publicSiteMediaAsset(asset);
  const replacement = publicSiteMediaAsset({ ...asset, variants: [{ ...asset.variants[0], storagePath: "team-test/upload-b/480.webp" }] });
  expect(first.src).not.toBe(replacement.src);
  expect(new URL(replacement.src, "https://www.ihearus.org").searchParams.get("asset")).toBe("team-test/upload-b/480.webp");
  expect(replacement.variants[0]).not.toHaveProperty("storagePath");
});
