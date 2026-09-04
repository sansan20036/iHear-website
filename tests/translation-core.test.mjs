import { afterEach, describe, expect, it } from "vitest";

import {
  buildTranslationPreview,
  createTranslationReceipt,
  finishProtectedTranslation,
  protectTranslationText,
  sha256,
  TERM_PATTERN,
  TranslationIntegrityError,
  TranslationReceiptError,
  verifyTranslationReceipt,
} from "../lib/translation-core.ts";

const originalSecret = process.env.TRANSLATION_RECEIPT_SECRET;
afterEach(() => {
  if (originalSecret == null) delete process.env.TRANSLATION_RECEIPT_SECRET;
  else process.env.TRANSLATION_RECEIPT_SECRET = originalSecret;
});

describe("translation glossary and placeholders", () => {
  it("matches iHear and tutor/tutee forms without touching tutorial", () => {
    const input = "iHear's tutors’ and a tutee's tutorial";
    const matches = [...input.matchAll(TERM_PATTERN)].map((match) => match[0]);
    expect(matches).toEqual(["iHear's", "tutors’", "tutee's"]);
    const protectedValue = protectTranslationText(input);
    expect(protectedValue.source).toMatch(/⟦IH_[A-Z0-9]{10}_0000⟧/);
    expect(protectedValue.source).toContain("tutorial");
  });

  it("protects dynamic names, schools, URLs, email and numbers", () => {
    const protectedValue = protectTranslationText(
      "Ryan studies at Taipei School. Email ryan@example.org for 1,200+ sessions at https://ihear.example/path.",
      ["Ryan", "Taipei School"],
    );
    expect(protectedValue.source).not.toContain("Ryan");
    expect(protectedValue.source).not.toContain("Taipei School");
    expect(protectedValue.source).not.toContain("ryan@example.org");
    expect(protectedValue.source).not.toContain("1,200+");
  });

  it("allows placeholder reordering and restores after OpenCC", () => {
    const protectedValue = protectTranslationText("iHear supports tutor Ryan", ["Ryan"]);
    const tokens = protectedValue.placeholders.map((item) => item.token);
    const result = finishProtectedTranslation(protectedValue, `${tokens[2]} 受到 ${tokens[0]} 與 ${tokens[1]} 支持，使用軟體`);
    expect(result.zhHant).toContain("Ryan");
    expect(result.zhHant).toContain("小老師");
    expect(result.zhHans).toContain("小老师");
    expect(result.zhHans).toContain("软件");
  });

  it("rejects missing, duplicated and unknown placeholders", () => {
    const protectedValue = protectTranslationText("iHear tutor");
    const [first] = protectedValue.placeholders;
    expect(() => finishProtectedTranslation(protectedValue, protectedValue.source.replace(first.token, ""))).toThrow(TranslationIntegrityError);
    expect(() => finishProtectedTranslation(protectedValue, `${protectedValue.source} ${first.token}`)).toThrow(TranslationIntegrityError);
    expect(() => finishProtectedTranslation(protectedValue, `${protectedValue.source} ⟦IH_AAAAAAAAAA_9999⟧`)).toThrow(TranslationIntegrityError);
  });
});

describe("translation preview and signed receipt", () => {
  const resource = { type: "team", scope: "", id: "profile-1", version: 3 };

  it("updates protected legacy Chinese when English changes", async () => {
    let calls = 0;
    const existing = { en: "Updated tutor bio", zhHant: "既有繁中", zhHans: "既有简中" };
    const legacyStates = [
      { resourceType: "team", resourceScope: "", resourceId: "profile-1", field: "bio", locale: "zhHant", sourceHash: sha256("Original tutor bio"), origin: "protected_legacy", glossaryVersion: "ihear-2026-08-v1", updatedBy: null, updatedAt: "" },
      { resourceType: "team", resourceScope: "", resourceId: "profile-1", field: "bio", locale: "zhHans", sourceHash: sha256("既有繁中"), origin: "protected_legacy", glossaryVersion: "ihear-2026-08-v1", updatedBy: null, updatedAt: "" },
    ];
    const result = await buildTranslationPreview({
      email: "admin@example.org", resource, fields: { bio: existing }, states: legacyStates,
      translate: async (values) => { calls += 1; return values.map((value) => `翻譯 ${value}`); },
    });
    expect(calls).toBe(1);
    expect(result.fields.bio.value.zhHant).toContain("小老師");
    expect(result.fields.bio.zhHantOrigin).toBe("machine");
    expect(result.fields.bio.zhHansOrigin).toBe("machine");
  });

  it("keeps manually corrected Chinese unless force is explicit", async () => {
    let calls = 0;
    const existing = { en: "Updated tutor bio", zhHant: "人工繁中", zhHans: "人工简中" };
    const manualStates = [
      { resourceType: "team", resourceScope: "", resourceId: "profile-1", field: "bio", locale: "zhHant", sourceHash: sha256("Original tutor bio"), origin: "manual", glossaryVersion: "ihear-2026-08-v1", updatedBy: null, updatedAt: "" },
      { resourceType: "team", resourceScope: "", resourceId: "profile-1", field: "bio", locale: "zhHans", sourceHash: sha256("人工繁中"), origin: "manual", glossaryVersion: "ihear-2026-08-v1", updatedBy: null, updatedAt: "" },
    ];
    const protectedResult = await buildTranslationPreview({
      email: "admin@example.org", resource, fields: { bio: existing }, states: manualStates,
      translate: async (values) => { calls += 1; return values; },
    });
    expect(protectedResult.fields.bio.value).toEqual(existing);
    expect(calls).toBe(0);
    const forced = await buildTranslationPreview({
      email: "admin@example.org", resource, fields: { bio: existing }, states: manualStates, force: { bio: ["zhHant", "zhHans"] },
      translate: async (values) => { calls += 1; return values.map((value) => `翻譯 ${value}`); },
    });
    expect(calls).toBe(1);
    expect(forced.fields.bio.value.zhHant).toContain("小老師");
    expect(forced.fields.bio.zhHantOrigin).toBe("machine");
  });

  it("skips Google when the English hash is already current", async () => {
    let calls = 0;
    const value = { en: "Current English", zhHant: "目前中文", zhHans: "目前中文" };
    const result = await buildTranslationPreview({
      email: "admin@example.org", resource, fields: { bio: value },
      states: [
        { resourceType: "team", resourceScope: "", resourceId: "profile-1", field: "bio", locale: "zhHant", sourceHash: sha256(value.en), origin: "machine", glossaryVersion: "ihear-2026-08-v1", updatedBy: null, updatedAt: "" },
        { resourceType: "team", resourceScope: "", resourceId: "profile-1", field: "bio", locale: "zhHans", sourceHash: sha256(value.zhHant), origin: "machine", glossaryVersion: "ihear-2026-08-v1", updatedBy: null, updatedAt: "" },
      ],
      translate: async (values) => { calls += 1; return values; },
    });
    expect(calls).toBe(0);
    expect(result.fields.bio.zhHantStatus).toBe("current");
  });

  it("binds receipts to user, record, version and English hash", () => {
    process.env.TRANSLATION_RECEIPT_SECRET = "test-secret-with-enough-randomness";
    const value = { en: "Tutor bio", zhHant: "小老師簡介", zhHans: "小老师简介" };
    const receipt = createTranslationReceipt({ email: "admin@example.org", resource, fields: { bio: { value, zhHantOrigin: "machine", zhHansOrigin: "machine" } } });
    expect(verifyTranslationReceipt({ receipt, email: "admin@example.org", resource, fields: { bio: value } })).toHaveLength(2);
    expect(() => verifyTranslationReceipt({ receipt, email: "other@example.org", resource, fields: { bio: value } })).toThrow(TranslationReceiptError);
    expect(() => verifyTranslationReceipt({ receipt, email: "admin@example.org", resource: { ...resource, version: 4 }, fields: { bio: value } })).toThrow(TranslationReceiptError);
    expect(() => verifyTranslationReceipt({ receipt, email: "admin@example.org", resource, fields: { bio: { ...value, en: "Changed" } } })).toThrow(TranslationReceiptError);
  });

  it("marks final Chinese edits as manual and rejects expired receipts", () => {
    process.env.TRANSLATION_RECEIPT_SECRET = "test-secret-with-enough-randomness";
    const value = { en: "Tutor bio", zhHant: "小老師簡介", zhHans: "小老师简介" };
    const receipt = createTranslationReceipt({ email: "admin@example.org", resource, fields: { bio: { value, zhHantOrigin: "machine", zhHansOrigin: "machine" } } });
    const writes = verifyTranslationReceipt({ receipt, email: "admin@example.org", resource, fields: { bio: { ...value, zhHant: "人工修正" } } });
    expect(writes.find((item) => item.locale === "zhHant")?.origin).toBe("manual");
    const expired = createTranslationReceipt({ email: "admin@example.org", resource, fields: { bio: { value, zhHantOrigin: "machine", zhHansOrigin: "machine" } }, now: Date.now() - 16 * 60 * 1000 });
    expect(() => verifyTranslationReceipt({ receipt: expired, email: "admin@example.org", resource, fields: { bio: value } })).toThrow(TranslationReceiptError);
  });
});
