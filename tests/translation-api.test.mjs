import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/admin-auth", () => ({ authorizeAdminRequest: vi.fn() }));
vi.mock("../lib/translation-state", () => ({ readTranslationStates: vi.fn() }));
vi.mock("../lib/translation-core", () => ({
  buildTranslationPreview: vi.fn(),
  personNameContextTerms: vi.fn((name) => [String(name).trim(), ...String(name).trim().split(/\s+/)]),
  TranslationConfigurationError: class TranslationConfigurationError extends Error { code = "TRANSLATION_NOT_CONFIGURED"; },
  TranslationIntegrityError: class TranslationIntegrityError extends Error { code = "TRANSLATION_INTEGRITY_FAILED"; },
}));
vi.mock("../lib/rate-limit", () => ({ withRateLimitHeaders: vi.fn((response) => response) }));

import { authorizeAdminRequest } from "../lib/admin-auth";
import { buildTranslationPreview, TranslationConfigurationError } from "../lib/translation-core";
import { readTranslationStates } from "../lib/translation-state";
import { POST as previewTranslation } from "../app/api/admin/translations/preview/route";
import { POST as traditionalize } from "../app/api/admin/translations/traditionalize/route";

const request = (body, origin = "http://localhost") => new Request("http://localhost/api/admin/translations/preview", {
  method: "POST", headers: { "content-type": "application/json", origin }, body: JSON.stringify(body),
});

beforeEach(() => {
  vi.clearAllMocks();
  authorizeAdminRequest.mockResolvedValue({ principal: { email: "admin@example.org", role: "editor" }, decision: {} });
  readTranslationStates.mockResolvedValue([]);
  buildTranslationPreview.mockResolvedValue({ receipt: "signed", fields: { bio: { value: { en: "Tutor", zhHant: "小老師", zhHans: "小老师" } } } });
});

describe("translation preview API", () => {
  it("passes validated draft manual edits to the preview builder", async () => {
    const manualEdits = { bio: ["zhHant", "zhHans"] };
    const response = await previewTranslation(request({ resource: { type: "team", id: "profile-1", version: 2 },
      fields: { bio: { en: "Hello", zhHant: "您好", zhHans: "您好" } }, manualEdits,
    }));
    expect(response.status).toBe(200);
    expect(buildTranslationPreview).toHaveBeenCalledWith(expect.objectContaining({ manualEdits }));
  });

  it.each([{ unknown: ["zhHant"] }, { bio: ["en"] }, { bio: "zhHant" }])("rejects invalid manual edits: %j", async manualEdits => {
    const response = await previewTranslation(request({ resource: { type: "team", id: "profile-1" },
      fields: { bio: { en: "Hello" } }, manualEdits,
    }));
    expect(response.status).toBe(400);
    expect(buildTranslationPreview).not.toHaveBeenCalled();
  });

  it("returns the authorization response for unauthenticated or cross-origin requests", async () => {
    authorizeAdminRequest.mockResolvedValue({ response: new Response(JSON.stringify({ error: "Forbidden" }), { status: 403 }) });
    expect((await previewTranslation(request({}))).status).toBe(403);
  });

  it("validates resource, field names, English and length limits", async () => {
    expect((await previewTranslation(request({ resource: { type: "team", id: "x" }, fields: { unknown: { en: "x" } } }))).status).toBe(400);
    expect((await previewTranslation(request({ resource: { type: "media", id: "x" }, fields: { alt: { en: "" } } }))).status).toBe(400);
    expect((await previewTranslation(request({ resource: { type: "media", id: "x" }, fields: { alt: { en: "x".repeat(301) } } }))).status).toBe(400);
  });

  it("loads provenance and returns a private signed preview", async () => {
    const response = await previewTranslation(request({ resource: { type: "team", scope: "", id: "profile-1", version: 2 }, fields: { bio: { en: "Tutor", zhHant: "人工中文", zhHans: "人工中文" } }, refreshLegacy: { bio: ["zhHant", "zhHans"] }, personNames: ["Yi Yi"], contextTerms: ["Taipei School"] }));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(readTranslationStates).toHaveBeenCalledWith({ type: "team", scope: "", id: "profile-1", version: 2 });
    expect(buildTranslationPreview).toHaveBeenCalledWith(expect.objectContaining({ email: "admin@example.org", states: [], refreshLegacy: { bio: ["zhHant", "zhHans"] }, contextTerms: ["Taipei School", "Yi Yi", "Yi"] }));
  });

  it("rejects invalid legacy-refresh fields", async () => {
    const body = { resource: { type: "media", scope: "", id: "slot", version: 1 }, fields: { alt: { en: "A photo" } }, refreshLegacy: { unknown: ["zhHant"] } };
    expect((await previewTranslation(request(body))).status).toBe(400);
    expect(buildTranslationPreview).not.toHaveBeenCalled();
  });

  it("rejects protected person names outside Team or with invalid values", async () => {
    const media = { resource: { type: "media", scope: "", id: "slot", version: 1 }, fields: { alt: { en: "A photo" } }, personNames: ["Yi Yi"] };
    expect((await previewTranslation(request(media))).status).toBe(400);
    const team = { resource: { type: "team", scope: "", id: "profile-1", version: 1 }, fields: { bio: { en: "A bio" } }, personNames: [7] };
    expect((await previewTranslation(request(team))).status).toBe(400);
  });

  it("returns 503 when Google credentials are unavailable", async () => {
    buildTranslationPreview.mockRejectedValue(new TranslationConfigurationError("Automatic translation is not configured"));
    const response = await previewTranslation(request({ resource: { type: "media", scope: "", id: "slot", version: 1 }, fields: { alt: { en: "A photo" } } }));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "TRANSLATION_NOT_CONFIGURED" });
  });

  it("maps Google quota exhaustion to 429 without retrying", async () => {
    const quota = Object.assign(new Error("quota"), { code: 8 });
    buildTranslationPreview.mockRejectedValue(quota);
    const response = await previewTranslation(request({ resource: { type: "media", scope: "", id: "slot", version: 1 }, fields: { alt: { en: "A photo" } } }));
    expect(response.status).toBe(429);
    expect(buildTranslationPreview).toHaveBeenCalledTimes(1);
  });

  it("pauses Chinese-dominant English sources until the administrator confirms", async () => {
    const body = { resource: { type: "media", scope: "", id: "slot", version: 1 }, fields: { alt: { en: "這是一整段中文內容" } } };
    const blocked = await previewTranslation(request(body));
    expect(blocked.status).toBe(422);
    expect(await blocked.json()).toMatchObject({ code: "ENGLISH_SOURCE_CONTAINS_CJK" });
    expect(buildTranslationPreview).not.toHaveBeenCalled();
    expect((await previewTranslation(request({ ...body, allowCjkEnglish: true }))).status).toBe(200);
  });

  it("converts simplified Chinese to Taiwan Traditional Chinese without Google", async () => {
    const response = await traditionalize(new Request("http://localhost/api/admin/translations/traditionalize", { method: "POST", headers: { "content-type": "application/json", origin: "http://localhost" }, body: JSON.stringify({ value: "开发服务器和软件" }) }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ value: "開發伺服器和軟體" });
    expect(buildTranslationPreview).not.toHaveBeenCalled();
  });
});
